/**
 * Captures the LIVE Coston2 contract state + local agent records into
 * agents/data/seed.json — the snapshot served by the hosted read-only
 * showcase (FAKTURA_SHOWCASE=1). Everything captured is real and verifiable
 * on the explorer; run after e2e to refresh the public demo.
 *
 *   npm run capture:seed
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { chain } from "./chain.js";
import { db } from "./store.js";
import type { FeedEvent } from "./feed.js";

function synthesizeFeed(): FeedEvent[] {
  const events: FeedEvent[] = [];
  for (const r of [...db.invoices].sort((a, b) => a.intake.receivedTs - b.intake.receivedTs)) {
    const base = r.intake.receivedTs;
    events.push({
      ts: base,
      actor: "underwriter",
      kind: "intake",
      message: `Intake ${r.intake.invoiceNumber}: ${r.intake.supplierName} → ${r.intake.debtorName}, $${r.intake.amountUsd.toLocaleString()} due ${new Date(r.intake.dueTs).toISOString().slice(0, 10)}`,
    });
    if (r.decision) {
      events.push({
        ts: r.decision.decidedTs,
        actor: "underwriter",
        kind: "decision",
        message: r.decision.approve
          ? `APPROVED ${r.intake.invoiceNumber}: risk ${r.decision.riskScore}/100, discount ${(r.decision.discountBps / 100).toFixed(2)}%`
          : `REJECTED ${r.intake.invoiceNumber}: ${r.decision.redFlags.join("; ") || r.decision.rationale.slice(0, 120)}`,
        data: { decisionHash: r.decision.decisionHash },
      });
    }
    if (r.chain.fdcRequestTx) {
      events.push({
        ts: base + 1,
        actor: "underwriter",
        kind: "fdc",
        message: `FDC Web2Json attestation requested (round ${r.chain.fdcVotingRound})`,
        deployHash: r.chain.fdcRequestTx,
      });
    }
    if (r.chain.registerHash) {
      events.push({
        ts: base + 2,
        actor: "underwriter",
        kind: "onchain",
        message: `Invoice #${r.id} registered on Coston2 (facts ${r.chain.fdcAttested ? `FDC-attested, round ${r.chain.fdcVotingRound}` : "FDC-encoded (demo mode)"})`,
        invoiceId: r.id,
        deployHash: r.chain.registerHash,
      });
    }
    if (r.chain.fundHash) {
      events.push({
        ts: base + 3,
        actor: "underwriter",
        kind: "onchain",
        message: `Invoice #${r.id} FUNDED — advance streamed to supplier at the live FTSOv2 rate`,
        invoiceId: r.id,
        deployHash: r.chain.fundHash,
      });
    }
    for (const h of r.chain.attestHashes) {
      events.push({
        ts: base + 4,
        actor: "underwriter",
        kind: "attest",
        message: `Decision memo hash anchored on-chain`,
        invoiceId: r.id || undefined,
        deployHash: h,
      });
    }
    if (r.status === "settled") {
      events.push({
        ts: base + 5,
        actor: "collector",
        kind: "reconcile",
        message: `Invoice #${r.id} settled on-chain — yield realized by the pool`,
        invoiceId: r.id,
        deployHash: r.chain.settleHash,
      });
    }
    if (r.status === "defaulted") {
      events.push({
        ts: base + 5,
        actor: "collector",
        kind: "default",
        message: `Invoice #${r.id} written off on-chain; loss absorbed by pool share price`,
        invoiceId: r.id,
        deployHash: r.chain.defaultHash,
      });
    }
  }
  return events.sort((a, b) => a.ts - b.ts);
}

async function main() {
  if (config.showcase) throw new Error("run capture against the real chain, not showcase mode");
  const [stats, onchain, oneUsdFlrWei] = await Promise.all([
    chain.stats(),
    chain.invoices(1, 500),
    chain.quoteUsdCentsInFlrWei(100),
  ]);
  const oneUsdFxrpUnits = await chain.quoteUsdCentsInToken(100).catch(() => 0n);

  const seed = {
    capturedAt: new Date().toISOString(),
    stats: {
      liquid: stats.liquid.toString(),
      deployedCapital: stats.deployedCapital.toString(),
      totalShares: stats.totalShares.toString(),
      totalFundedFlr: stats.totalFundedFlr.toString(),
      totalSettledFlr: stats.totalSettledFlr.toString(),
      totalDefaultedFlr: stats.totalDefaultedFlr.toString(),
      invoiceCount: stats.invoiceCount,
      attestationCount: stats.attestationCount,
      settlementTokenReserve: stats.settlementTokenReserve.toString(),
    },
    onchain: onchain.map((i) => ({
      ...i,
      faceUsdCents: i.faceUsdCents.toString(),
      advanceFlrWei: i.advanceFlrWei.toString(),
      settledFlrWei: i.settledFlrWei.toString(),
    })),
    contract: config.contract,
    explorer: config.explorerBase,
    oneUsdFlrWei: oneUsdFlrWei.toString(),
    oneUsdFxrpUnits: oneUsdFxrpUnits.toString(),
    agentAddress: chain.address("agent"),
    records: db.invoices,
    feed: synthesizeFeed(),
  };

  const out = path.join(config.dataDir, "seed.json");
  fs.writeFileSync(out, JSON.stringify(seed, null, 2));
  console.log(
    `seed captured → ${out}\n` +
      `  invoices ${stats.invoiceCount}, attestations ${stats.attestationCount}, ` +
      `liquid ${stats.liquid} wei, FXRP reserve ${stats.settlementTokenReserve} units`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
