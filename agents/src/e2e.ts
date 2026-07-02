/**
 * End-to-end smoke against the LIVE Coston2 deployment:
 *   deposit → 3 intakes (approve / reject / approve) → settle one → stats.
 * Run with the agent service NOT required (talks to chain directly).
 *
 *   FAKTURA_CONTRACT=0x... npx tsx src/e2e.ts
 */
import { formatEther, parseEther } from "ethers";
import { config } from "./config.js";
import { chain } from "./chain.js";
import { processIntake } from "./underwriter.js";
import { feed } from "./feed.js";

feed.on("event", () => {}); // ensure console logging via feed

async function main() {
  console.log(`contract: ${config.contract}`);
  console.log(`agent:    ${chain.address("agent")}`);
  console.log(`investor: ${chain.address("investor")}`);
  console.log(`debtor:   ${chain.address("debtor")}`);

  const enforced = await chain.fdcEnforced();
  if (enforced) {
    console.log("disabling on-chain FDC enforcement for e2e demo…");
    await chain.setFdcEnforced(false);
  }

  const before = await chain.stats();
  console.log("\n== stats before ==");
  console.log(`liquid ${formatEther(before.liquid)} FLR, invoices ${before.invoiceCount}`);

  // Testnet FLR ≈ $0.0066, so USD invoices are intentionally small to fit the
  // faucet-funded pool. On mainnet (or with an FXRP/USD₮ feed) the same code
  // handles production-size receivables.
  if (before.liquid < parseEther("200")) {
    console.log("\nseeding pool with 300 FLR from investor…");
    await chain.deposit("investor", parseEther("300"));
  }

  const day = 86_400_000;

  console.log("\n== intake 1: clean invoice (expect APPROVE + fund + settle) ==");
  const r1 = await processIntake({
    supplierName: "Nordwind Logistics GmbH",
    debtorName: "Aurora Retail AG",
    amountUsd: 1.0,
    dueTs: Date.now() + 30 * day,
    invoiceNumber: "INV-2026-501",
    description: "Freight services, 14 pallet shipments Hamburg to Vienna",
    history: "6 prior invoices, all paid within terms",
  });
  console.log(`-> status=${r1.status} id=${r1.id} risk=${r1.decision?.riskScore} discount=${r1.decision?.discountBps}bps`);

  console.log("\n== intake 2: sketchy invoice (expect REJECT) ==");
  const r2 = await processIntake({
    supplierName: "QuickCash Trading",
    debtorName: "Unknown Shell Ltd",
    amountUsd: 0.5,
    dueTs: Date.now() + 90 * day,
    invoiceNumber: "INV-2026-502",
    description: "Consulting, lump sum, no deliverables specified",
    history: "new counterparty, one prior invoice disputed and overdue",
  });
  console.log(`-> status=${r2.status} risk=${r2.decision?.riskScore} flags=${r2.decision?.redFlags.join("|")}`);

  console.log("\n== intake 3: short-dated invoice (expect APPROVE + fund, then DEFAULT) ==");
  const r3 = await processIntake({
    supplierName: "Helios Solar Kft",
    debtorName: "Metro Utilities Zrt",
    amountUsd: 0.4,
    dueTs: Date.now() + 90_000, // 90s — exercises the collector's default path live
    invoiceNumber: "INV-2026-503",
    description: "Panel maintenance, Q1 service contract",
    history: "3 prior invoices paid on time",
  });
  console.log(`-> status=${r3.status} id=${r3.id} risk=${r3.decision?.riskScore}`);

  if (r1.status === "funded") {
    console.log(`\n== settling invoice #${r1.id} (debtor pays face value in FLR at live rate) ==`);
    const required = await chain.quoteUsdCentsInFlrWei(100);
    await chain.settle(r1.id, (required * 101n) / 100n);
    console.log(`settled with ~${formatEther(required)} FLR`);
  }

  if (r3.status === "funded") {
    console.log(`\n== waiting out the grace period, then defaulting invoice #${r3.id} ==`);
    await new Promise((r) => setTimeout(r, (90 + config.collector.graceSeconds + 5) * 1000));
    await chain.markDefault(r3.id);
    console.log(`invoice #${r3.id} written off on-chain`);
  }

  const after = await chain.stats();
  console.log("\n== stats after ==");
  console.log(`liquid       ${formatEther(after.liquid)} FLR`);
  console.log(`deployed     ${formatEther(after.deployedCapital)} FLR`);
  console.log(`totalFunded  ${formatEther(after.totalFundedFlr)} FLR`);
  console.log(`totalSettled ${formatEther(after.totalSettledFlr)} FLR`);
  console.log(`invoices     ${after.invoiceCount}, attestations ${after.attestationCount}`);
  console.log("\n✅ e2e complete — verify on https://coston2-explorer.flare.network/address/" + config.contract);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
