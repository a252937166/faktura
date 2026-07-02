import crypto from "node:crypto";
import { formatEther } from "ethers";
import { chain } from "./chain.js";
import { config } from "./config.js";
import { buildDemoProof } from "./fdc.js";
import { feed } from "./feed.js";
import { underwrite as llmUnderwrite } from "./llm.js";
import { db, upsertInvoice, type InvoiceRecord } from "./store.js";

export interface IntakeInput {
  supplierName: string;
  /** EVM address that receives the advance. Defaults to the demo supplier. */
  supplierAddress?: string;
  debtorName: string;
  amountUsd: number;
  dueTs: number;
  invoiceNumber: string;
  description: string;
  history?: string;
  document?: string;
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * Autonomous underwriting pipeline:
 * intake → deterministic pre-checks → LLM risk opinion → policy guardrails
 * → FDC-attested on-chain register + FTSO-priced fund → on-chain attestation.
 * The LLM proposes; the deterministic policy layer disposes. Every decision is
 * hashed and anchored on-chain.
 */
export async function processIntake(input: IntakeInput): Promise<InvoiceRecord> {
  const intakeId = crypto.randomUUID();
  const docHash = sha256(input.document ?? JSON.stringify(input));
  const record: InvoiceRecord = {
    id: 0,
    intakeId,
    status: "underwriting",
    intake: {
      supplierName: input.supplierName,
      supplierAddress: input.supplierAddress,
      debtorName: input.debtorName,
      debtorTag: `debtor:${sha256(input.debtorName.toLowerCase()).slice(0, 16)}`,
      amountUsd: input.amountUsd,
      dueTs: input.dueTs,
      invoiceNumber: input.invoiceNumber,
      description: input.description,
      history: input.history,
      docHash: `sha256:${docHash}`,
      receivedTs: Date.now(),
    },
    chain: { attestHashes: [] },
  };
  upsertInvoice(record);
  feed.publish({
    actor: "underwriter",
    kind: "intake",
    message: `Intake ${input.invoiceNumber}: ${input.supplierName} → ${input.debtorName}, $${input.amountUsd.toLocaleString()} due ${new Date(input.dueTs).toISOString().slice(0, 10)}`,
    data: { intakeId },
  });

  const policyNotes: string[] = [];
  const p = config.policy;

  const hardFail = (reason: string) => {
    policyNotes.push(`HARD-REJECT: ${reason}`);
    return finalizeReject(record, {
      riskScore: 100,
      discountBps: 0,
      rationale: `Rejected by deterministic policy before model review: ${reason}`,
      redFlags: [reason],
      model: "policy-gate",
      policyNotes,
    });
  };

  if (!(input.amountUsd >= p.minFaceUsd)) return hardFail(`face value below $${p.minFaceUsd}`);
  if (!(input.amountUsd <= p.maxFaceUsd)) return hardFail(`face value above $${p.maxFaceUsd}`);
  const dueIn = input.dueTs - Date.now();
  if (dueIn < p.minDueInMs) return hardFail("due date not sufficiently in the future");
  if (dueIn > p.maxDueInMs) return hardFail("tenor exceeds policy maximum");
  const duplicate = db.invoices.find(
    (x) => x.intake.docHash === record.intake.docHash && x.intakeId !== intakeId && x.status !== "rejected",
  );
  if (duplicate) return hardFail(`duplicate document (matches ${duplicate.intake.invoiceNumber})`);

  // ---- LLM opinion --------------------------------------------------------
  feed.publish({
    actor: "underwriter",
    kind: "llm",
    message: `Scoring ${input.invoiceNumber} with ${config.llmProvider === "auto" ? "auto-selected model" : config.llmProvider}...`,
  });
  const { opinion, provider, model } = await llmUnderwrite({
    supplierName: input.supplierName,
    debtorName: input.debtorName,
    amountUsd: input.amountUsd,
    dueTs: input.dueTs,
    invoiceNumber: input.invoiceNumber,
    description: input.description,
    history: input.history,
  });

  let { approve, risk_score, discount_bps } = opinion;
  discount_bps = Math.max(p.minDiscountBps, Math.min(p.maxDiscountBps, discount_bps));
  if (discount_bps !== opinion.discount_bps)
    policyNotes.push(`discount clamped ${opinion.discount_bps} → ${discount_bps} bps`);
  if (risk_score > p.maxRiskScore && approve) {
    approve = false;
    policyNotes.push(`model approved but risk ${risk_score} > policy max ${p.maxRiskScore}`);
  }

  // Exposure cap: advance (converted to FLR at live FTSO rate) vs. liquid pool.
  if (approve) {
    const stats = await chain.stats();
    const advanceUsdCents = Math.round((input.amountUsd * 100 * (10_000 - discount_bps)) / 10_000);
    const advanceWei = await chain.quoteUsdCentsInFlrWei(advanceUsdCents);
    if (stats.liquid === 0n || advanceWei * 10_000n > stats.liquid * BigInt(p.maxPoolShareBps)) {
      approve = false;
      policyNotes.push(
        `exposure cap: advance ${Number(formatEther(advanceWei)).toFixed(1)} FLR vs liquid ${Number(formatEther(stats.liquid)).toFixed(1)} FLR (max ${p.maxPoolShareBps} bps)`,
      );
    }
  }

  const memo = {
    intakeId,
    invoiceNumber: input.invoiceNumber,
    decidedAt: new Date().toISOString(),
    provider,
    model,
    opinion,
    applied: { approve, risk_score, discount_bps },
    policyNotes,
  };
  const decisionHash = `sha256:${sha256(JSON.stringify(memo))}`;

  if (!approve) {
    return finalizeReject(record, {
      riskScore: risk_score,
      discountBps: discount_bps,
      rationale: opinion.rationale,
      redFlags: opinion.red_flags,
      model: `${provider}:${model}`,
      policyNotes,
      decisionHash,
    });
  }

  // ---- On-chain: register (FDC-gated) + fund (FTSO-priced) + attest --------
  record.decision = {
    approve: true,
    riskScore: risk_score,
    discountBps: discount_bps,
    rationale: opinion.rationale,
    redFlags: opinion.red_flags,
    policyNotes,
    model: `${provider}:${model}`,
    decisionHash,
    decidedTs: Date.now(),
  };
  record.status = "approved";
  upsertInvoice(record);
  feed.publish({
    actor: "underwriter",
    kind: "decision",
    message: `APPROVED ${input.invoiceNumber}: risk ${risk_score}/100, discount ${(discount_bps / 100).toFixed(2)}% — registering on Flare`,
    data: { decisionHash, redFlags: opinion.red_flags },
  });

  const supplier = input.supplierAddress ?? chain.address("debtor");
  const proof = buildDemoProof({
    invoiceNumber: input.invoiceNumber,
    debtorTag: record.intake.debtorTag,
    docHash: record.intake.docHash,
    amountUsdCents: BigInt(Math.round(input.amountUsd * 100)),
    dueTs: Math.floor(input.dueTs / 1000),
  });

  const reg = await chain.registerWithProof(proof, supplier, risk_score, discount_bps, decisionHash);
  record.id = reg.id;
  record.chain.registerHash = reg.hash;
  record.chain.fdcAttested = config.fdcMode === "strict";
  upsertInvoice(record);
  feed.publish({
    actor: "underwriter",
    kind: "onchain",
    message: `Invoice #${record.id} registered on Coston2 (facts ${config.fdcMode === "strict" ? "FDC-attested" : "FDC-encoded"})`,
    invoiceId: record.id,
    deployHash: reg.hash,
  });

  const funded = await chain.fund(record.id);
  record.chain.fundHash = funded.hash;
  record.status = "funded";
  const onchain = await chain.invoice(record.id);
  if (onchain) record.chain.advanceFlrWei = onchain.advanceFlrWei.toString();
  upsertInvoice(record);
  feed.publish({
    actor: "underwriter",
    kind: "onchain",
    message: `Invoice #${record.id} FUNDED — ${onchain ? Number(formatEther(onchain.advanceFlrWei)).toFixed(2) : "?"} FLR advance streamed to supplier (priced at live FTSO rate)`,
    invoiceId: record.id,
    deployHash: funded.hash,
  });

  const att = await chain.attest("UNDERWRITE_APPROVE", record.id, decisionHash, model);
  record.chain.attestHashes.push(att.hash);
  upsertInvoice(record);
  feed.publish({
    actor: "underwriter",
    kind: "attest",
    message: `Decision memo hash anchored on-chain (attestation #${att.id})`,
    invoiceId: record.id,
    deployHash: att.hash,
  });

  return record;
}

async function finalizeReject(
  record: InvoiceRecord,
  d: {
    riskScore: number;
    discountBps: number;
    rationale: string;
    redFlags: string[];
    model: string;
    policyNotes: string[];
    decisionHash?: string;
  },
): Promise<InvoiceRecord> {
  const decisionHash =
    d.decisionHash ?? `sha256:${sha256(JSON.stringify({ intakeId: record.intakeId, ...d }))}`;
  record.decision = {
    approve: false,
    riskScore: d.riskScore,
    discountBps: d.discountBps,
    rationale: d.rationale,
    redFlags: d.redFlags,
    policyNotes: d.policyNotes,
    model: d.model,
    decisionHash,
    decidedTs: Date.now(),
  };
  record.status = "rejected";
  upsertInvoice(record);
  feed.publish({
    actor: "underwriter",
    kind: "decision",
    message: `REJECTED ${record.intake.invoiceNumber}: ${d.redFlags.join("; ") || d.rationale.slice(0, 120)}`,
    data: { decisionHash },
  });

  try {
    const att = await chain.attest("UNDERWRITE_REJECT", 0, decisionHash, d.model);
    record.chain.attestHashes.push(att.hash);
    upsertInvoice(record);
    feed.publish({
      actor: "underwriter",
      kind: "attest",
      message: `Rejection memo anchored on-chain (attestation #${att.id})`,
      deployHash: att.hash,
    });
  } catch (e) {
    feed.publish({
      actor: "system",
      kind: "warn",
      message: `Rejection attestation failed: ${(e as Error).message.slice(0, 200)}`,
    });
  }
  return record;
}
