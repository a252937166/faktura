import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import { provider } from "./chain.js";
import { feed } from "./feed.js";

/**
 * x402 (HTTP 402 Payment Required) gate for the Faktura risk oracle.
 *
 * Wire format follows the x402 PaymentRequirements shape (the same
 * `accepts[]` / `PAYMENT-SIGNATURE` model as the Coinbase/EVM x402 standard),
 * settled natively on Flare Coston2: the buyer sends a plain FLR transfer to
 * the oracle whose calldata carries the issued nonce, then replays the request
 * with the transaction hash as proof. The server verifies the tx on-chain
 * (recipient, value, nonce, success) before releasing the paid content.
 */

interface PendingCharge {
  nonce: string;
  createdTs: number;
}

const pending = new Map<string, PendingCharge>();
const settledTxs = new Set<string>();

function paymentRequirements(req: Request, nonce: string) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "flare:coston2",
        maxAmountRequired: config.x402.priceWei,
        asset: "native-FLR",
        payTo: config.x402.payTo,
        resource: req.originalUrl,
        description: "Faktura verified risk report (machine-payable oracle)",
        mimeType: "application/json",
        maxTimeoutSeconds: Math.floor(config.x402.ttlMs / 1000),
        extra: {
          settlement: "native-transfer",
          nonce,
          nonceEncoding: "utf8-hex-in-calldata",
          proofHeader: "PAYMENT-SIGNATURE",
          proofFormat: "tx-hash",
        },
      },
    ],
    error: "Payment required: send FLR with the nonce in calldata, retry with PAYMENT-SIGNATURE.",
  };
}

/** Verifies a native FLR transfer: mined, to the oracle, >= price, nonce in calldata. */
async function verifyPayment(txHash: string, nonce: string): Promise<{ ok: boolean; reason?: string }> {
  if (settledTxs.has(txHash)) return { ok: false, reason: "tx already used" };
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx) return { ok: false, reason: "tx not found" };
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return { ok: false, reason: "tx not mined yet" };
    if (receipt.status !== 1) return { ok: false, reason: "tx failed" };

    if ((tx.to ?? "").toLowerCase() !== config.x402.payTo.toLowerCase())
      return { ok: false, reason: "wrong payee" };
    if (tx.value < BigInt(config.x402.priceWei))
      return { ok: false, reason: `value ${tx.value} < required ${config.x402.priceWei}` };

    const nonceHex = Buffer.from(nonce, "utf8").toString("hex");
    if (!(tx.data ?? "").toLowerCase().includes(nonceHex.toLowerCase()))
      return { ok: false, reason: "nonce not found in calldata" };

    settledTxs.add(txHash);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export function x402Gate() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const proof = req.header("PAYMENT-SIGNATURE");
    const nonceHeader = req.header("PAYMENT-NONCE");

    if (!proof || !nonceHeader) {
      const nonce = "fk" + crypto.randomBytes(6).toString("hex");
      pending.set(nonce, { nonce, createdTs: Date.now() });
      for (const [k, v] of pending) if (Date.now() - v.createdTs > config.x402.ttlMs) pending.delete(k);
      feed.publish({
        actor: "oracle",
        kind: "x402",
        message: `402 issued for ${req.originalUrl} — ${Number(config.x402.priceWei) / 1e18} FLR (nonce ${nonce})`,
      });
      res.status(402).json(paymentRequirements(req, nonce));
      return;
    }

    const charge = pending.get(nonceHeader);
    if (!charge) {
      res.status(402).json({ x402Version: 1, error: "unknown or expired nonce" });
      return;
    }
    const verdict = await verifyPayment(proof.trim(), nonceHeader);
    if (!verdict.ok) {
      feed.publish({
        actor: "oracle",
        kind: "x402",
        message: `Payment rejected for nonce ${nonceHeader}: ${verdict.reason}`,
      });
      res.status(402).json({ x402Version: 1, error: `payment verification failed: ${verdict.reason}` });
      return;
    }
    pending.delete(nonceHeader);
    feed.publish({
      actor: "oracle",
      kind: "x402",
      message: `Payment verified (tx ${proof.slice(0, 12)}…) — releasing risk report`,
      deployHash: proof.trim(),
    });
    next();
  };
}
