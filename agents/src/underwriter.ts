import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatEther, getAddress } from "ethers";
import { chain } from "./chain.js";
import { config } from "./config.js";
import { buildDemoProof, erpUrlFor, requestWeb2JsonProof } from "./fdc.js";
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
 * Persists the exact bytes whose sha256 is anchored on-chain, so anyone can
 * re-hash the file and compare against the contract's `decisionHash` /
 * attestation `payloadHash` (served at GET /api/memos/:hash).
 */
function persistMemo(memoJson: string, decisionHash: string): string {
  fs.mkdirSync(config.memosDir, { recursive: true });
  const file = path.join(config.memosDir, `${decisionHash.replace("sha256:", "sha256-")}.json`);
  fs.writeFileSync(file, memoJson);
  return file;
}

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

  // ---- Strict mode: underwrite the SYSTEM OF RECORD, not the intake form ---
  // Pre-fetch the ERP document the FDC attestation will read. The model then
  // scores the document's facts; the intake form is only cross-checked
  // against them. Unfetchable or mismatching documents reject before any
  // attestation fee is spent.
  interface SorFacts {
    invoiceNumber: string;
    amountUsd: number;
    dueTs: number;
    description: string;
    debtorName: string;
    supplierName: string;
    history?: string;
    docHash: string;
    debtorTag: string;
    supplierWallet: string;
  }
  let sor: SorFacts | null = null;
  if (config.fdcMode === "strict") {
    const sourceUrl = erpUrlFor(input.invoiceNumber);
    try {
      const res = await fetch(sourceUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = (await res.json()) as { invoice: Record<string, any> };
      const inv = doc.invoice;
      sor = {
        invoiceNumber: String(inv.number ?? ""),
        amountUsd: Number(inv.amountCents) / 100,
        dueTs: Number(inv.dueTs) * 1000,
        description: String(inv.description ?? ""),
        debtorName: String(inv.debtor?.name ?? ""),
        supplierName: String(inv.supplier?.name ?? ""),
        history: inv.history ? JSON.stringify(inv.history) : undefined,
        docHash: String(inv.documentSha256 ?? ""),
        debtorTag: String(inv.debtor?.tag ?? ""),
        supplierWallet: String(inv.supplier?.paymentAddress ?? ""),
      };
    } catch (e) {
      return hardFail(
        `strict mode: no attestable system-of-record document at ${sourceUrl} (${(e as Error).message.slice(0, 80)})`,
      );
    }
    // Every fact the attestation will carry is validated BEFORE the FDC fee
    // is spent: identifiers present, payout wallet well-formed, and the
    // intake form consistent with the document.
    if (sor.invoiceNumber !== input.invoiceNumber)
      return hardFail(
        `system-of-record document is for ${sor.invoiceNumber || "(no number)"}, not ${input.invoiceNumber}`,
      );
    if (!sor.docHash) return hardFail("system-of-record document has no documentSha256");
    if (!sor.debtorTag) return hardFail("system-of-record document has no debtor tag");
    try {
      sor.supplierWallet = getAddress(sor.supplierWallet);
    } catch {
      return hardFail("system-of-record document has no valid supplier payment address");
    }
    if (Math.round(sor.amountUsd * 100) !== Math.round(input.amountUsd * 100))
      return hardFail(
        `intake amount $${input.amountUsd} does not match the system of record ($${sor.amountUsd})`,
      );
    if (Math.floor(input.dueTs / 1000) !== Math.floor(sor.dueTs / 1000))
      return hardFail("intake due date does not match the system of record");
    policyNotes.push(`system-of-record document verified: ${sourceUrl}`);
    feed.publish({
      actor: "underwriter",
      kind: "fdc",
      message: `Strict mode: underwriting the system-of-record facts from ${sourceUrl}`,
    });
  }

  // ---- LLM opinion --------------------------------------------------------
  feed.publish({
    actor: "underwriter",
    kind: "llm",
    message: `Scoring ${input.invoiceNumber} with the autonomous AI underwriter...`,
  });
  const { opinion, provider, model } = await llmUnderwrite({
    supplierName: sor?.supplierName || input.supplierName,
    debtorName: sor?.debtorName || input.debtorName,
    amountUsd: sor?.amountUsd ?? input.amountUsd,
    dueTs: sor?.dueTs ?? input.dueTs,
    invoiceNumber: input.invoiceNumber,
    description: sor?.description || input.description,
    history: sor?.history ?? input.history,
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

  const memoJson = JSON.stringify(
    {
      intakeId,
      invoiceNumber: input.invoiceNumber,
      decidedAt: new Date().toISOString(),
      underwritten: sor
        ? { from: "system-of-record", source: erpUrlFor(input.invoiceNumber) }
        : { from: "intake" },
      provider,
      model,
      opinion,
      applied: { approve, risk_score, discount_bps },
      policyNotes,
    },
    null,
    2,
  );
  const decisionHash = `sha256:${sha256(memoJson)}`;
  persistMemo(memoJson, decisionHash);

  if (!approve) {
    return finalizeReject(record, {
      riskScore: risk_score,
      discountBps: discount_bps,
      rationale: opinion.rationale,
      redFlags: opinion.red_flags,
      model: "autonomous-ai-underwriter",
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
    model: "autonomous-ai-underwriter",
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

  let proof: unknown;
  if (config.fdcMode === "strict") {
    // Real Web2Json attestation: the facts registered on-chain come from the
    // supplier's system of record via the Flare Data Connector, not from the
    // intake form. ~3–5 minutes (one voting round + finalization).
    try {
      const strict = await requestWeb2JsonProof(erpUrlFor(input.invoiceNumber), (message) =>
        feed.publish({ actor: "underwriter", kind: "fdc", message }),
      );
      // Full cross-check: the ATTESTED facts must equal the reviewed
      // system-of-record document (guards the fetch→attestation window).
      const attested = strict.facts;
      const mismatch =
        attested.invoiceNumber !== input.invoiceNumber
          ? "invoiceNumber"
          : Number(attested.amountUsdCents) !== Math.round((sor?.amountUsd ?? input.amountUsd) * 100)
            ? "amountUsdCents"
            : sor && attested.dueTs !== Math.floor(sor.dueTs / 1000)
              ? "dueTs"
              : sor && attested.docHash !== sor.docHash
                ? "documentSha256"
                : sor && attested.debtorTag !== sor.debtorTag
                  ? "debtorTag"
                  : sor && getAddress(attested.supplierWallet) !== sor.supplierWallet
                    ? "supplierWallet"
                    : null;
      if (mismatch) {
        return finalizeReject(record, {
          riskScore: 100,
          discountBps: discount_bps,
          rationale: `Attested facts diverge from the reviewed system-of-record document (field: ${mismatch}). The document changed between review and attestation; not financing.`,
          redFlags: [`attested/${mismatch} mismatch`],
          model: "fdc-crosscheck",
          policyNotes,
        });
      }
      record.chain.fdcVotingRound = strict.votingRound;
      record.chain.fdcRequestTx = strict.attestationRequestTx;
      proof = strict.proof;
    } catch (e) {
      return finalizeReject(record, {
        riskScore: 100,
        discountBps: discount_bps,
        rationale: `Strict FDC mode: the invoice could not be attested from the system of record (${(e as Error).message.slice(0, 160)}). Unattestable receivables are not financed.`,
        redFlags: ["no attestable system-of-record document"],
        model: "fdc-gate",
        policyNotes,
      });
    }
  } else {
    proof = buildDemoProof({
      invoiceNumber: input.invoiceNumber,
      debtorTag: record.intake.debtorTag,
      docHash: record.intake.docHash,
      amountUsdCents: BigInt(Math.round(input.amountUsd * 100)),
      dueTs: Math.floor(input.dueTs / 1000),
      supplierWallet: supplier,
    });
  }

  const reg = await chain.registerWithProof(proof, supplier, risk_score, discount_bps, decisionHash);
  record.id = reg.id;
  record.chain.registerHash = reg.hash;
  record.chain.fdcAttested = config.fdcMode === "strict";
  upsertInvoice(record);
  feed.publish({
    actor: "underwriter",
    kind: "onchain",
    message: `Invoice #${record.id} registered on Coston2 (facts ${
      config.fdcMode === "strict"
        ? `FDC-attested, round ${record.chain.fdcVotingRound}`
        : "FDC-encoded (demo mode)"
    })`,
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

  const att = await chain.attest("UNDERWRITE_APPROVE", record.id, decisionHash, "autonomous-ai-underwriter");
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
  let decisionHash = d.decisionHash;
  if (!decisionHash) {
    const memoJson = JSON.stringify(
      {
        intakeId: record.intakeId,
        invoiceNumber: record.intake.invoiceNumber,
        kind: "UNDERWRITE_REJECT",
        decidedAt: new Date().toISOString(),
        ...d,
      },
      null,
      2,
    );
    decisionHash = `sha256:${sha256(memoJson)}`;
    persistMemo(memoJson, decisionHash);
  }
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
