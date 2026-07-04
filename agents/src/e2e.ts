/**
 * End-to-end run against the LIVE Coston2 deployment.
 *
 * Demo mode (default, fast):
 *   deposit → 4 intakes (approve+settle-in-FLR / reject / approve+default /
 *   approve+settle-in-FXRP) — all real Coston2 transactions. On-chain FDC
 *   enforcement is turned off for speed and RESTORED at the end.
 *
 * Strict mode (FAKTURA_FDC=strict, ~4 min per invoice):
 *   the same pipeline, but every registration runs a REAL FDC Web2Json
 *   attestation of the committed system-of-record documents (docs/erp/*)
 *   and the contract verifies the Merkle proof on-chain.
 *
 *   npm run e2e                    # demo
 *   FAKTURA_FDC=strict npm run e2e # attested
 */
import { formatEther, parseEther } from "ethers";
import { config } from "./config.js";
import { chain, provider } from "./chain.js";
import { processIntake } from "./underwriter.js";
import { feed } from "./feed.js";
import { getErpDocument } from "./erp.js";
import { upsertInvoice, type InvoiceRecord } from "./store.js";

feed.on("event", () => {}); // ensure console logging via feed

const FLR = 10n ** 18n;
const strict = config.fdcMode === "strict";
const day = 86_400_000;

const evidence: { step: string; tx?: string }[] = [];
const note = (step: string, tx?: string) => {
  if (tx) evidence.push({ step, tx });
};

async function ensureLiquidity(target: bigint) {
  const stats = await chain.stats();
  let need = target - stats.liquid;
  if (need <= 0n) return;

  const investorBal = await provider.getBalance(chain.address("investor"));
  const investorPut = min(need, investorBal > 3n * FLR ? investorBal - 3n * FLR : 0n);
  if (investorPut > 0n) {
    console.log(`\nseeding pool: investor deposits ${formatEther(investorPut)} FLR…`);
    const r = await chain.deposit("investor", investorPut);
    note("LP deposit (investor)", r.hash);
    need -= investorPut;
  }
  if (need > 0n) {
    const debtorBal = await provider.getBalance(chain.address("debtor"));
    const keep = 320n * FLR; // debtor still has settlements to pay
    const debtorPut = min(need, debtorBal > keep ? debtorBal - keep : 0n);
    if (debtorPut > 0n) {
      console.log(`seeding pool: second LP (debtor key) deposits ${formatEther(debtorPut)} FLR…`);
      const r = await chain.deposit("debtor", debtorPut);
      note("LP deposit (second LP)", r.hash);
    }
  }
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

function recordEvidence(label: string, r: InvoiceRecord) {
  note(`${label} — register${r.chain.fdcAttested ? " (FDC-attested)" : ""}`, r.chain.registerHash);
  if (r.chain.fdcRequestTx) note(`${label} — FDC attestation request`, r.chain.fdcRequestTx);
  note(`${label} — fund (FTSOv2-priced)`, r.chain.fundHash);
  for (const h of r.chain.attestHashes) note(`${label} — decision memo anchored`, h);
}

async function main() {
  console.log(`contract: ${config.contract}`);
  console.log(`mode:     FDC ${config.fdcMode}`);
  console.log(`agent:    ${chain.address("agent")}`);
  console.log(`investor: ${chain.address("investor")}`);
  console.log(`debtor:   ${chain.address("debtor")}`);

  const enforcedAtStart = await chain.fdcEnforced();
  if (strict && !enforcedAtStart) {
    console.log("strict mode: enabling on-chain FDC enforcement…");
    await chain.setFdcEnforced(true);
  } else if (!strict && enforcedAtStart) {
    console.log("demo mode: disabling on-chain FDC enforcement for this run (restored at the end)…");
    const r = await chain.setFdcEnforced(false);
    note("fdcEnforced=false (demo speed-up)", r.hash);
  }

  const before = await chain.stats();
  console.log("\n== stats before ==");
  console.log(`liquid ${formatEther(before.liquid)} FLR, invoices ${before.invoiceCount}`);

  // Testnet FLR ≈ $0.007, so USD invoices are intentionally small to fit a
  // faucet-funded pool. On mainnet (or with production FXRP liquidity) the
  // same code handles production-size receivables — see README.
  await ensureLiquidity(250n * FLR);

  let settleTarget: InvoiceRecord;
  let fxrpTarget: InvoiceRecord | undefined;
  let rejectRecord: InvoiceRecord;
  let defaultRecord: InvoiceRecord | undefined;

  // Settle invoice A as soon as it is funded: the returned face value tops
  // the pool back up so later fundings clear the on-chain exposure cap.
  const settleA = async () => {
    if (settleTarget.status !== "funded") return;
    console.log(`\n== settling invoice #${settleTarget.id} (debtor pays face value in FLR at live FTSO rate) ==`);
    const cents = Math.round(settleTarget.intake.amountUsd * 100);
    const required = await chain.quoteUsdCentsInFlrWei(cents);
    const r = await chain.settle(settleTarget.id, (required * 101n) / 100n);
    note("invoice A — settle in FLR (FTSOv2 re-quote)", r.hash);
    settleTarget.chain.settleHash = r.hash;
    settleTarget.status = "settled";
    upsertInvoice(settleTarget);
    console.log(`settled with ~${formatEther(required)} FLR`);
  };

  if (strict) {
    // Strict mode registers only what the system of record can attest:
    // the committed docs/erp documents, provably fetched via FDC Web2Json.
    const doc42 = getErpDocument("INV-2026-0042")!;
    const doc43 = getErpDocument("INV-2026-0043")!;

    console.log("\n== intake 1: attested invoice (expect APPROVE + real FDC proof + fund + settle) ==");
    settleTarget = await processIntake({
      supplierName: String((doc42.invoice.supplier as any)?.name ?? "Nordwind Logistics GmbH"),
      debtorName: String(doc42.invoice.debtor.name ?? "Aurora Retail AG"),
      amountUsd: doc42.invoice.amountCents / 100,
      dueTs: doc42.invoice.dueTs * 1000,
      invoiceNumber: doc42.invoice.number,
      description: doc42.invoice.description ?? "",
      history: "6 prior invoices, all paid within terms",
    });
    await settleA();

    console.log("\n== intake 2: sketchy invoice (expect REJECT before any attestation spend) ==");
    rejectRecord = await processIntake({
      supplierName: "QuickCash Trading",
      debtorName: "Unknown Shell Ltd",
      amountUsd: 0.5,
      dueTs: Date.now() + 90 * day,
      invoiceNumber: "INV-2026-502",
      description: "Consulting, lump sum, no deliverables specified",
      history: "new counterparty, one prior invoice disputed and overdue",
    });

    console.log("\n== intake 3: attested invoice settled in FXRP (interoperable leg) ==");
    fxrpTarget = await processIntake({
      supplierName: String((doc43.invoice.supplier as any)?.name ?? "Helios Solar Kft"),
      debtorName: String(doc43.invoice.debtor.name ?? "Metro Utilities Zrt"),
      amountUsd: doc43.invoice.amountCents / 100,
      dueTs: doc43.invoice.dueTs * 1000,
      invoiceNumber: doc43.invoice.number,
      description: doc43.invoice.description ?? "",
      history: "3 prior invoices paid on time",
    });
  } else {
    console.log("\n== intake 1: clean invoice (expect APPROVE + fund + settle) ==");
    settleTarget = await processIntake({
      supplierName: "Nordwind Logistics GmbH",
      debtorName: "Aurora Retail AG",
      amountUsd: 1.0,
      dueTs: Date.now() + 30 * day,
      invoiceNumber: `INV-2026-5${(Date.now() % 100000).toString().padStart(5, "0")}`,
      description: "Freight services, 14 pallet shipments Hamburg to Vienna",
      history: "6 prior invoices, all paid within terms",
    });
    await settleA();

    console.log("\n== intake 2: sketchy invoice (expect REJECT) ==");
    rejectRecord = await processIntake({
      supplierName: "QuickCash Trading",
      debtorName: "Unknown Shell Ltd",
      amountUsd: 0.5,
      dueTs: Date.now() + 90 * day,
      invoiceNumber: `INV-2026-6${(Date.now() % 100000).toString().padStart(5, "0")}`,
      description: "Consulting, lump sum, no deliverables specified",
      history: "new counterparty, one prior invoice disputed and overdue",
    });

    console.log("\n== intake 3: short-dated invoice (expect APPROVE + fund, then DEFAULT) ==");
    defaultRecord = await processIntake({
      supplierName: "Helios Solar Kft",
      debtorName: "Metro Utilities Zrt",
      amountUsd: 0.4,
      dueTs: Date.now() + 90_000, // 90 s — exercises the autonomous default path live
      invoiceNumber: `INV-2026-7${(Date.now() % 100000).toString().padStart(5, "0")}`,
      description: "Panel maintenance, Q1 service contract",
      history: "3 prior invoices paid on time",
    });

    console.log("\n== intake 4: invoice to be settled in FXRP (interoperable leg) ==");
    fxrpTarget = await processIntake({
      supplierName: "Adria Marine d.o.o.",
      debtorName: "Ionian Ferries SA",
      amountUsd: 0.3,
      dueTs: Date.now() + 45 * day,
      invoiceNumber: `INV-2026-8${(Date.now() % 100000).toString().padStart(5, "0")}`,
      description: "Harbor logistics, June 2026",
      history: "2 prior invoices paid on time",
    });
  }

  console.log(
    `-> intake results: settle=${settleTarget.status} reject=${rejectRecord.status}` +
      (defaultRecord ? ` default=${defaultRecord.status}` : "") +
      (fxrpTarget ? ` fxrp=${fxrpTarget.status}` : ""),
  );
  recordEvidence("invoice A", settleTarget);
  for (const h of rejectRecord.chain.attestHashes) note("rejection memo anchored", h);
  if (defaultRecord) recordEvidence("invoice C", defaultRecord);
  if (fxrpTarget) recordEvidence("invoice D", fxrpTarget);

  if (fxrpTarget && fxrpTarget.status === "funded") {
    console.log(`\n== settling invoice #${fxrpTarget.id} in FXRP (XRP/USD FTSOv2 feed) ==`);
    const cents = Math.round(fxrpTarget.intake.amountUsd * 100);
    const tokenAmount = await chain.quoteUsdCentsInToken(cents);
    const r = await chain.settleInToken(fxrpTarget.id, tokenAmount);
    note("invoice D — settle in FXRP (XRP/USD feed)", r.hash);
    fxrpTarget.chain.settleHash = r.hash;
    fxrpTarget.status = "settled";
    upsertInvoice(fxrpTarget);
    console.log(`settled with ${(Number(tokenAmount) / 1e6).toFixed(4)} FXRP`);
  }

  if (defaultRecord && defaultRecord.status === "funded") {
    const waitS = 90 + config.collector.graceSeconds + 5;
    console.log(`\n== waiting out due + grace (${waitS}s), then defaulting invoice #${defaultRecord.id} ==`);
    await new Promise((r) => setTimeout(r, waitS * 1000));
    const r = await chain.markDefault(defaultRecord.id);
    note("invoice C — autonomous default write-off", r.hash);
    defaultRecord.chain.defaultHash = r.hash;
    defaultRecord.status = "defaulted";
    upsertInvoice(defaultRecord);
    console.log(`invoice #${defaultRecord.id} written off on-chain`);
  }

  // Leave the contract in its production posture: enforcement ON.
  if (!(await chain.fdcEnforced())) {
    console.log("\nrestoring on-chain FDC enforcement (production posture)…");
    const r = await chain.setFdcEnforced(true);
    note("fdcEnforced=true (restored)", r.hash);
  }

  const after = await chain.stats();
  console.log("\n== stats after ==");
  console.log(`liquid        ${formatEther(after.liquid)} FLR`);
  console.log(`deployed      ${formatEther(after.deployedCapital)} FLR`);
  console.log(`totalFunded   ${formatEther(after.totalFundedFlr)} FLR`);
  console.log(`totalSettled  ${formatEther(after.totalSettledFlr)} FLR`);
  console.log(`totalDefaulted${formatEther(after.totalDefaultedFlr)} FLR`);
  console.log(`FXRP reserve  ${(Number(after.settlementTokenReserve) / 1e6).toFixed(4)} FXRP`);
  console.log(`invoices      ${after.invoiceCount}, attestations ${after.attestationCount}`);

  console.log("\n== on-chain evidence (README-ready) ==");
  for (const e of evidence) {
    console.log(`| ${e.step} | ${config.explorerBase}/tx/${e.tx} |`);
  }
  console.log("\n✅ e2e complete — verify on " + `${config.explorerBase}/address/${config.contract}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
