import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ethers, network } from "hardhat";

/**
 * STRICT FDC PATH — registers an invoice on FakturaHub through a real Flare
 * Data Connector Web2Json attestation, end to end:
 *
 *   1. the supplier's system-of-record document (a public HTTPS JSON URL) is
 *      submitted to the FDC Web2Json verifier (prepareRequest);
 *   2. the attestation request is paid for and submitted to FdcHub;
 *   3. the script waits for the voting round to finalize (Relay);
 *   4. the Merkle proof is fetched from the Data Availability layer;
 *   5. registerInvoice(proof, …) is called with fdcEnforced = true, so the
 *      contract itself verifies the proof via FdcVerification and decodes the
 *      invoice facts from the attested response — not from the agent.
 *
 * Run:
 *   FAKTURA_CONTRACT=0x… npx hardhat run scripts/registerViaFdc.ts --network coston2
 *
 * Optional env:
 *   FAKTURA_ERP_URL   system-of-record URL (default: the repo's docs/erp doc)
 *   FAKTURA_FUND=1    also fund the invoice at the live FTSOv2 rate
 *   VERIFIER_URL_TESTNET / VERIFIER_API_KEY_TESTNET / COSTON2_DA_LAYER_URL
 *
 * Takes ~3–5 minutes: one FDC voting round (90 s) plus finalization.
 */

const VERIFIER_URL =
  process.env.VERIFIER_URL_TESTNET ?? "https://fdc-verifiers-testnet.flare.network";
const VERIFIER_API_KEY =
  process.env.VERIFIER_API_KEY_TESTNET ?? "00000000-0000-0000-0000-000000000000";
const DA_LAYER_URL =
  process.env.COSTON2_DA_LAYER_URL ?? "https://ctn2-data-availability.flare.network";
// GitHub Pages, not raw.githubusercontent: the Web2Json verifier requires the
// source to respond with Content-Type application/json.
const ERP_URL =
  process.env.FAKTURA_ERP_URL ?? "https://a252937166.github.io/faktura/erp/INV-2026-0042.json";

const FLARE_CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
const EXPLORER = "https://coston2-explorer.flare.network";

/** jq: shape the ERP document into the InvoiceFacts tuple. */
const POST_PROCESS_JQ =
  "{invoiceNumber: .invoice.number, debtorTag: .invoice.debtor.tag, docHash: .invoice.documentSha256, amountUsdCents: .invoice.amountCents, dueTs: .invoice.dueTs}";

/** ABI shape of InvoiceFacts — must match FakturaHub's struct field order. */
const ABI_SIGNATURE = JSON.stringify({
  components: [
    { internalType: "string", name: "invoiceNumber", type: "string" },
    { internalType: "string", name: "debtorTag", type: "string" },
    { internalType: "string", name: "docHash", type: "string" },
    { internalType: "uint256", name: "amountUsdCents", type: "uint256" },
    { internalType: "uint256", name: "dueTs", type: "uint256" },
  ],
  name: "invoiceFacts",
  type: "tuple",
});

/** IWeb2Json.Response as an ethers ABI type (for decoding the DA response). */
const RESPONSE_ABI_TYPE =
  "tuple(bytes32 attestationType, bytes32 sourceId, uint64 votingRound, uint64 lowestUsedTimestamp," +
  " tuple(string url, string httpMethod, string headers, string queryParams, string body, string postProcessJq, string abiSignature) requestBody," +
  " tuple(bytes abiEncodedData) responseBody)";

const REGISTRY_ABI = ["function getContractAddressByName(string) view returns (address)"];
const FDC_HUB_ABI = ["function requestAttestation(bytes _data) payable"];
const FEE_CONFIG_ABI = ["function getRequestFee(bytes _data) view returns (uint256)"];
const FSM_ABI = [
  "function firstVotingRoundStartTs() view returns (uint64)",
  "function votingEpochDurationSeconds() view returns (uint64)",
];
const RELAY_ABI = ["function isFinalized(uint256 _protocolId, uint256 _votingRoundId) view returns (bool)"];
const FDC_VERIFICATION_ABI = ["function fdcProtocolId() view returns (uint8)"];

const toUtf8Hex32 = (s: string) => ethers.encodeBytes32String(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const contractAddr = process.env.FAKTURA_CONTRACT;
  if (!contractAddr) throw new Error("FAKTURA_CONTRACT not set");
  const signers = await ethers.getSigners();
  const agent = signers[0];
  const supplier = process.env.FAKTURA_SUPPLIER ?? (signers[2] ?? agent).address;
  console.log(`network:  ${network.name}`);
  console.log(`agent:    ${agent.address}`);
  console.log(`hub:      ${contractAddr}`);
  console.log(`ERP doc:  ${ERP_URL}\n`);

  // ---- 0. read the system-of-record document (for the memo + sanity) ------
  const erpResponse = await fetch(ERP_URL);
  if (!erpResponse.ok) throw new Error(`ERP document fetch failed: ${erpResponse.status}`);
  const erpDoc = await erpResponse.json();
  const inv = erpDoc.invoice;
  console.log(
    `invoice ${inv.number}: $${(inv.amountCents / 100).toFixed(2)} ` +
      `${inv.supplier?.name ?? "?"} → ${inv.debtor?.name ?? "?"}, due ${inv.dueAt}`,
  );
  if (inv.dueTs * 1000 <= Date.now()) {
    throw new Error("ERP document dueTs is in the past — registerInvoice would revert");
  }

  const hub = await ethers.getContractAt("FakturaHub", contractAddr, agent);

  // Strict mode is the point of this script: enforcement must be ON.
  if (!(await hub.fdcEnforced())) {
    console.log("fdcEnforced is false — enabling on-chain FDC enforcement…");
    await (await hub.setFdcEnforced(true)).wait();
  }
  const pinnedPrefix: string = await hub.erpUrlPrefix();
  if (pinnedPrefix && !ERP_URL.startsWith(pinnedPrefix)) {
    throw new Error(
      `hub pins the system of record to "${pinnedPrefix}" — ` +
        `this ERP URL would revert with UntrustedSource. ` +
        `Use a matching FAKTURA_ERP_URL or setErpUrlPrefix first.`,
    );
  }

  // ---- 1. prepareRequest at the Web2Json verifier --------------------------
  console.log("\n[1/5] verifier prepareRequest (Web2Json)…");
  const prepared = await (
    await fetch(`${VERIFIER_URL}/verifier/web2/Web2Json/prepareRequest`, {
      method: "POST",
      headers: { "X-API-KEY": VERIFIER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        attestationType: toUtf8Hex32("Web2Json"),
        sourceId: toUtf8Hex32("PublicWeb2"),
        requestBody: {
          url: ERP_URL,
          httpMethod: "GET",
          headers: "{}",
          queryParams: "{}",
          body: "{}",
          postProcessJq: POST_PROCESS_JQ,
          abiSignature: ABI_SIGNATURE,
        },
      }),
    })
  ).json();
  if (prepared.status !== "VALID" || !prepared.abiEncodedRequest) {
    throw new Error(`verifier rejected the request: ${JSON.stringify(prepared)}`);
  }
  const abiEncodedRequest: string = prepared.abiEncodedRequest;
  console.log(`abiEncodedRequest: ${abiEncodedRequest.slice(0, 66)}… (${abiEncodedRequest.length / 2 - 1} bytes)`);

  // ---- 2. pay the fee and submit to FdcHub ---------------------------------
  const registry = new ethers.Contract(FLARE_CONTRACT_REGISTRY, REGISTRY_ABI, agent);
  const [fdcHubAddr, feeCfgAddr, fsmAddr, relayAddr, fdcVerAddr] = await Promise.all(
    ["FdcHub", "FdcRequestFeeConfigurations", "FlareSystemsManager", "Relay", "FdcVerification"].map(
      (n) => registry.getContractAddressByName(n),
    ),
  );
  const feeCfg = new ethers.Contract(feeCfgAddr, FEE_CONFIG_ABI, agent);
  const fee: bigint = await feeCfg.getRequestFee(abiEncodedRequest);
  console.log(`\n[2/5] submitting to FdcHub ${fdcHubAddr} (fee ${ethers.formatEther(fee)} C2FLR)…`);
  const fdcHub = new ethers.Contract(fdcHubAddr, FDC_HUB_ABI, agent);
  const reqTx = await fdcHub.requestAttestation(abiEncodedRequest, { value: fee });
  const reqRc = await reqTx.wait();
  console.log(`attestation request tx: ${EXPLORER}/tx/${reqTx.hash}`);

  // ---- 3. wait for the voting round to finalize ----------------------------
  const fsm = new ethers.Contract(fsmAddr, FSM_ABI, agent);
  const block = await ethers.provider.getBlock(reqRc.blockNumber);
  const [startTs, epochSec] = await Promise.all([
    fsm.firstVotingRoundStartTs(),
    fsm.votingEpochDurationSeconds(),
  ]);
  const roundId = Number((BigInt(block!.timestamp) - startTs) / epochSec);
  console.log(`\n[3/5] voting round ${roundId} — waiting for finalization (~2–4 min)…`);
  console.log(`round progress: https://coston2-systems-explorer.flare.rocks/voting-round/${roundId}?tab=fdc`);

  const relay = new ethers.Contract(relayAddr, RELAY_ABI, agent);
  const protocolId = await new ethers.Contract(fdcVerAddr, FDC_VERIFICATION_ABI, agent).fdcProtocolId();
  const deadline = Date.now() + 12 * 60_000;
  while (!(await relay.isFinalized(protocolId, roundId))) {
    if (Date.now() > deadline) throw new Error(`round ${roundId} not finalized after 12 min`);
    await sleep(20_000);
    process.stdout.write(".");
  }
  console.log("\nround finalized.");

  // ---- 4. fetch the Merkle proof from the DA layer -------------------------
  console.log(`\n[4/5] fetching proof from DA layer…`);
  let proofJson: any = {};
  for (let i = 0; i < 20 && !proofJson.response_hex; i++) {
    await sleep(10_000);
    const res = await fetch(`${DA_LAYER_URL}/api/v1/fdc/proof-by-request-round-raw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ votingRoundId: roundId, requestBytes: abiEncodedRequest }),
    });
    proofJson = await res.json().catch(() => ({}));
  }
  if (!proofJson.response_hex) throw new Error("DA layer returned no proof (MIC mismatch or outage?)");
  console.log(`merkle proof: [${(proofJson.proof ?? []).length} nodes]`);

  const [d] = ethers.AbiCoder.defaultAbiCoder().decode([RESPONSE_ABI_TYPE], proofJson.response_hex);
  // Rebuild as plain mutable objects: ethers returns frozen Result arrays,
  // which its own call-argument walker cannot consume.
  const decodedResponse = {
    attestationType: d[0],
    sourceId: d[1],
    votingRound: d[2],
    lowestUsedTimestamp: d[3],
    requestBody: {
      url: d[4][0],
      httpMethod: d[4][1],
      headers: d[4][2],
      queryParams: d[4][3],
      body: d[4][4],
      postProcessJq: d[4][5],
      abiSignature: d[4][6],
    },
    responseBody: { abiEncodedData: d[5][0] },
  };

  // ---- 5. register on FakturaHub with the verified proof -------------------
  const riskScore = Number(process.env.FAKTURA_RISK ?? 28);
  const discountBps = Number(process.env.FAKTURA_DISCOUNT_BPS ?? 220);
  const memo = JSON.stringify(
    {
      kind: "STRICT_FDC_REGISTRATION",
      source: ERP_URL,
      votingRound: roundId,
      invoiceNumber: inv.number,
      amountUsdCents: inv.amountCents,
      dueTs: inv.dueTs,
      riskScore,
      discountBps,
      note: "facts decoded on-chain from the FDC Web2Json attested response",
    },
    null,
    2,
  );
  const decisionHash = `sha256:${crypto.createHash("sha256").update(memo).digest("hex")}`;
  const memoDir = path.join(__dirname, "..", "..", "agents", "data", "memos");
  fs.mkdirSync(memoDir, { recursive: true });
  fs.writeFileSync(path.join(memoDir, `${decisionHash.replace("sha256:", "sha256-")}.json`), memo);

  console.log(`\n[5/5] registerInvoice with fdcEnforced=true (decision ${decisionHash.slice(0, 18)}…)`);
  const regTx = await hub.registerInvoice(
    { merkleProof: proofJson.proof, data: decodedResponse },
    supplier,
    riskScore,
    discountBps,
    decisionHash,
  );
  const regRc = await regTx.wait();
  const registered = regRc!.logs
    .map((l: any) => {
      try {
        return hub.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p: any) => p?.name === "InvoiceRegistered");
  const invoiceId = registered ? Number(registered.args.id) : 0;

  console.log(`\n✅ STRICT FDC REGISTRATION COMPLETE`);
  console.log(`   invoice id:        #${invoiceId}`);
  console.log(`   register tx:       ${EXPLORER}/tx/${regTx.hash}`);
  console.log(`   attestation req:   ${EXPLORER}/tx/${reqTx.hash}`);
  console.log(`   voting round:      ${roundId}`);
  console.log(`   decision memo:     agents/data/memos/${decisionHash.replace("sha256:", "sha256-")}.json`);

  if (process.env.FAKTURA_FUND === "1") {
    console.log(`\nfunding invoice #${invoiceId} at the live FTSOv2 rate…`);
    const fundTx = await hub.fundInvoice(invoiceId);
    await fundTx.wait();
    console.log(`   fund tx:           ${EXPLORER}/tx/${fundTx.hash}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
