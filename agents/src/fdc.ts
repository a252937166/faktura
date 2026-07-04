import { AbiCoder, Contract, Wallet, encodeBytes32String, formatEther } from "ethers";
import { config } from "./config.js";

const abi = AbiCoder.defaultAbiCoder();

/** InvoiceFacts tuple, order must match the Solidity struct + abiSignature. */
export interface InvoiceFacts {
  invoiceNumber: string;
  debtorTag: string;
  docHash: string;
  amountUsdCents: bigint;
  dueTs: number;
  /** Attested payout wallet — while fdcEnforced, advances go here. */
  supplierWallet: string;
}

/** jq filter shaping an ERP document into the InvoiceFacts tuple. */
export const POST_PROCESS_JQ =
  "{invoiceNumber: .invoice.number, debtorTag: .invoice.debtor.tag, docHash: .invoice.documentSha256, amountUsdCents: .invoice.amountCents, dueTs: .invoice.dueTs, supplierWallet: .invoice.supplier.paymentAddress}";

/** ABI shape of InvoiceFacts (field order = FakturaHub struct). */
export const ABI_SIGNATURE = JSON.stringify({
  components: [
    { internalType: "string", name: "invoiceNumber", type: "string" },
    { internalType: "string", name: "debtorTag", type: "string" },
    { internalType: "string", name: "docHash", type: "string" },
    { internalType: "uint256", name: "amountUsdCents", type: "uint256" },
    { internalType: "uint256", name: "dueTs", type: "uint256" },
    { internalType: "address", name: "supplierWallet", type: "address" },
  ],
  name: "invoiceFacts",
  type: "tuple",
});

/** IWeb2Json.Response as an ethers ABI type (decoding the DA-layer payload). */
const RESPONSE_ABI_TYPE =
  "tuple(bytes32 attestationType, bytes32 sourceId, uint64 votingRound, uint64 lowestUsedTimestamp," +
  " tuple(string url, string httpMethod, string headers, string queryParams, string body, string postProcessJq, string abiSignature) requestBody," +
  " tuple(bytes abiEncodedData) responseBody)";

/** ABI-encodes InvoiceFacts as the FDC Web2Json responseBody would. */
export function encodeFacts(f: InvoiceFacts): string {
  return abi.encode(
    ["tuple(string,string,string,uint256,uint256,address)"],
    [[f.invoiceNumber, f.debtorTag, f.docHash, f.amountUsdCents, BigInt(f.dueTs), f.supplierWallet]],
  );
}

/** Decodes InvoiceFacts out of a Web2Json proof's responseBody. */
export function decodeFacts(abiEncodedData: string): InvoiceFacts {
  const [t] = abi.decode(["tuple(string,string,string,uint256,uint256,address)"], abiEncodedData);
  return {
    invoiceNumber: String(t[0]),
    debtorTag: String(t[1]),
    docHash: String(t[2]),
    amountUsdCents: BigInt(t[3]),
    dueTs: Number(t[4]),
    supplierWallet: String(t[5]),
  };
}

/** The source URL an invoice's facts are read from (supplier system of record). */
export function erpUrlFor(invoiceNumber: string): string {
  return config.erp.urlTemplate.replace("{number}", encodeURIComponent(invoiceNumber));
}

/**
 * Builds a Web2Json Proof whose responseBody carries the encoded invoice
 * facts. Demo mode only (`fdcEnforced=false`): the contract decodes these
 * facts but skips Merkle verification, so an empty proof is fine. The real
 * attested proof — with a valid Merkle branch from the DA layer — comes from
 * `requestWeb2JsonProof` below (or contracts/scripts/registerViaFdc.ts) and
 * is a drop-in for this same argument.
 */
export function buildDemoProof(f: InvoiceFacts) {
  return {
    merkleProof: [] as string[],
    data: {
      attestationType: encodeBytes32String("Web2Json"),
      sourceId: encodeBytes32String("PublicWeb2"),
      votingRound: 0n,
      lowestUsedTimestamp: 0n,
      requestBody: {
        url: erpUrlFor(f.invoiceNumber),
        httpMethod: "GET",
        headers: "{}",
        queryParams: "{}",
        body: "{}",
        postProcessJq: POST_PROCESS_JQ,
        abiSignature: ABI_SIGNATURE,
      },
      responseBody: { abiEncodedData: encodeFacts(f) },
    },
  };
}

// ---------------------------------------------------------------------------
// Real FDC Web2Json attestation (strict mode)
// ---------------------------------------------------------------------------

const FLARE_CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
const REGISTRY_ABI = ["function getContractAddressByName(string) view returns (address)"];
const FDC_HUB_ABI = ["function requestAttestation(bytes _data) payable"];
const FEE_CONFIG_ABI = ["function getRequestFee(bytes _data) view returns (uint256)"];
const FSM_ABI = [
  "function firstVotingRoundStartTs() view returns (uint64)",
  "function votingEpochDurationSeconds() view returns (uint64)",
];
const RELAY_ABI = [
  "function isFinalized(uint256 _protocolId, uint256 _votingRoundId) view returns (bool)",
];
const FDC_VERIFICATION_ABI = ["function fdcProtocolId() view returns (uint8)"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StrictProofResult {
  proof: { merkleProof: string[]; data: unknown };
  facts: InvoiceFacts;
  votingRound: number;
  attestationRequestTx: string;
  sourceUrl: string;
}

/**
 * Runs a full Web2Json attestation for one ERP document and returns a proof
 * that FakturaHub can verify on-chain with `fdcEnforced = true`:
 * verifier prepareRequest → FdcHub.requestAttestation (fee paid in FLR) →
 * voting-round finalization (Relay) → Merkle proof from the DA layer.
 * Takes ~3–5 minutes (one 90 s voting round + finalization).
 */
export async function requestWeb2JsonProof(
  sourceUrl: string,
  onProgress: (message: string) => void = () => {},
): Promise<StrictProofResult> {
  // Lazy import avoids a config→chain→config cycle at module load.
  const { provider } = await import("./chain.js");
  const agent = new Wallet(config.keys.agent, provider);

  // 1. prepareRequest — the verifier dry-runs the fetch + jq and computes the
  //    message integrity code; a document it cannot fetch cannot be attested.
  onProgress(`FDC: preparing Web2Json attestation of ${sourceUrl}`);
  const prepared = (await (
    await fetch(`${config.fdc.verifierUrl}/verifier/web2/Web2Json/prepareRequest`, {
      method: "POST",
      headers: { "X-API-KEY": config.fdc.verifierApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        attestationType: encodeBytes32String("Web2Json"),
        sourceId: encodeBytes32String("PublicWeb2"),
        requestBody: {
          url: sourceUrl,
          httpMethod: "GET",
          headers: "{}",
          queryParams: "{}",
          body: "{}",
          postProcessJq: POST_PROCESS_JQ,
          abiSignature: ABI_SIGNATURE,
        },
      }),
    })
  ).json()) as { status?: string; abiEncodedRequest?: string };
  if (prepared.status !== "VALID" || !prepared.abiEncodedRequest) {
    throw new Error(`FDC verifier rejected the request: ${JSON.stringify(prepared)}`);
  }
  const requestBytes = prepared.abiEncodedRequest;

  // 2. pay the request fee and submit to FdcHub.
  const registry = new Contract(FLARE_CONTRACT_REGISTRY, REGISTRY_ABI, agent);
  const [fdcHubAddr, feeCfgAddr, fsmAddr, relayAddr, fdcVerAddr] = await Promise.all(
    ["FdcHub", "FdcRequestFeeConfigurations", "FlareSystemsManager", "Relay", "FdcVerification"].map(
      (n) => registry.getContractAddressByName(n),
    ),
  );
  const fee: bigint = await new Contract(feeCfgAddr, FEE_CONFIG_ABI, agent).getRequestFee(requestBytes);
  const reqTx = await new Contract(fdcHubAddr, FDC_HUB_ABI, agent).requestAttestation(requestBytes, {
    value: fee,
  });
  const reqRc = await reqTx.wait();
  onProgress(`FDC: attestation request submitted (fee ${formatEther(fee)} FLR) — tx ${reqTx.hash}`);

  // 3. wait for the voting round to finalize.
  const fsm = new Contract(fsmAddr, FSM_ABI, agent);
  const block = await provider.getBlock(reqRc.blockNumber);
  const [startTs, epochSec] = await Promise.all([
    fsm.firstVotingRoundStartTs(),
    fsm.votingEpochDurationSeconds(),
  ]);
  const votingRound = Number((BigInt(block!.timestamp) - startTs) / epochSec);
  onProgress(`FDC: voting round ${votingRound} — waiting for finalization (~2–4 min)`);

  const relay = new Contract(relayAddr, RELAY_ABI, agent);
  const protocolId = await new Contract(fdcVerAddr, FDC_VERIFICATION_ABI, agent).fdcProtocolId();
  const deadline = Date.now() + 12 * 60_000;
  while (!(await relay.isFinalized(protocolId, votingRound))) {
    if (Date.now() > deadline) throw new Error(`FDC round ${votingRound} not finalized after 12 min`);
    await sleep(20_000);
  }
  onProgress(`FDC: round ${votingRound} finalized — fetching Merkle proof from the DA layer`);

  // 4. fetch the Merkle proof from the Data Availability layer.
  let proofJson: { response_hex?: string; proof?: string[] } = {};
  for (let i = 0; i < 20 && !proofJson.response_hex; i++) {
    await sleep(10_000);
    const res = await fetch(`${config.fdc.daLayerUrl}/api/v1/fdc/proof-by-request-round-raw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ votingRoundId: votingRound, requestBytes }),
    });
    proofJson = (await res.json().catch(() => ({}))) as typeof proofJson;
  }
  if (!proofJson.response_hex) {
    throw new Error("FDC DA layer returned no proof (source changed between rounds, or outage)");
  }

  const [d] = abi.decode([RESPONSE_ABI_TYPE], proofJson.response_hex);
  // Rebuild as plain mutable objects: ethers returns frozen Result arrays,
  // which its own call-argument walker cannot consume.
  const decoded = {
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
  const facts = decodeFacts(decoded.responseBody.abiEncodedData);
  onProgress(
    `FDC: proof retrieved — ${facts.invoiceNumber} attested ` +
      `($${(Number(facts.amountUsdCents) / 100).toFixed(2)}, ${proofJson.proof?.length ?? 0}-node Merkle branch)`,
  );

  return {
    proof: { merkleProof: proofJson.proof ?? [], data: decoded },
    facts,
    votingRound,
    attestationRequestTx: reqTx.hash,
    sourceUrl,
  };
}
