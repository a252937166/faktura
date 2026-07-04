import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root (faktura-flare/). */
export const ROOT = path.resolve(here, "..", "..");

dotenv.config({ path: path.join(ROOT, ".env") });

/**
 * Placeholder key for hosts that must never sign (public showcase): the
 * ethers Wallet constructor requires a well-formed key even though showcase
 * mode simulates every write in-memory.
 */
const DUMMY_KEY = `0x${"11".repeat(32)}`;

function readKey(name: string): string {
  const p = path.join(ROOT, "keys", `${name}.key`);
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return DUMMY_KEY;
  }
}

export const config = {
  port: Number(process.env.PORT ?? 4020),

  /**
   * Showcase mode: public read-only demo without secret keys. On-chain reads
   * come from a captured Coston2 snapshot (real, verifiable on the explorer);
   * writes are simulated in-memory. The AI underwriter still runs for real.
   */
  showcase: process.env.FAKTURA_SHOWCASE === "1",
  seedPath: process.env.FAKTURA_SEED ?? path.join(ROOT, "agents/data/seed.json"),

  /**
   * Two-address posture:
   *  - FAKTURA_CONTRACT — the hub the interactive service operates on (the
   *    DEMO hub; its fdcEnforced flag may be toggled for instant demos);
   *  - FAKTURA_EVIDENCE_CONTRACT — the EVIDENCE hub, permanently strict
   *    (fdcEnforced=true, never demoted). Strict-mode runs route here
   *    automatically, and demo mode refuses to touch it.
   */
  contract:
    (process.env.FAKTURA_FDC ?? "demo") === "strict"
      ? (process.env.FAKTURA_EVIDENCE_CONTRACT ?? process.env.FAKTURA_CONTRACT ?? "")
      : (process.env.FAKTURA_CONTRACT ?? ""),
  evidenceContract: process.env.FAKTURA_EVIDENCE_CONTRACT ?? "",

  /** Flare Coston2 network. */
  rpcUrl: process.env.COSTON2_RPC_URL ?? "https://coston2-api.flare.network/ext/C/rpc",
  chainId: 114,
  explorerBase: "https://coston2-explorer.flare.network",

  /** Persona private keys (0x…). */
  keys: {
    agent: readKey("agent"),
    investor: readKey("investor"),
    debtor: readKey("debtor"),
  },

  /**
   * Underwriting policy guardrails (deterministic, enforced in code).
   * minFaceUsd is low because testnet FLR ≈ $0.0066, so faucet-funded demo
   * pools can only back small USD invoices. Production raises this floor.
   */
  policy: {
    minFaceUsd: Number(process.env.FAKTURA_MIN_FACE_USD ?? 0.1),
    maxFaceUsd: 500_000,
    minDueInMs: 60_000,
    maxDueInMs: 120 * 24 * 3600_000,
    minDiscountBps: 50,
    maxDiscountBps: 2500,
    maxRiskScore: 65,
    maxPoolShareBps: 6000,
  },

  collector: {
    intervalMs: Number(process.env.COLLECTOR_INTERVAL_MS ?? 30_000),
    graceSeconds: Number(process.env.FAKTURA_GRACE_SECONDS ?? 120),
  },

  /** LLM provider: "anthropic" | "claude-cli" | "deepseek" | "mock" | "auto". */
  llmProvider: process.env.LLM_PROVIDER ?? "auto",
  llmModel: process.env.LLM_MODEL ?? "claude-sonnet-4-5",

  /** DeepSeek (OpenAI-compatible) — the underwriter brain on hosts without Claude Code. */
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY ?? "",
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
  },

  /** x402 paid oracle pricing (FLR wei). */
  x402: {
    priceWei: process.env.X402_PRICE_WEI ?? "2000000000000000000", // 2 FLR
    payTo: "", // set to agent address at boot
    ttlMs: 10 * 60_000,
  },

  /**
   * FDC gating.
   *  - "strict": every registration goes through a REAL Web2Json attestation
   *    (verifier → FdcHub → voting round → DA-layer Merkle proof) and the
   *    contract verifies it on-chain (fdcEnforced=true). Takes ~3–5 min per
   *    invoice. Same flow as contracts/scripts/registerViaFdc.ts.
   *  - "demo": the agent flips the on-chain `fdcEnforced` flag off at boot so
   *    the interactive demo registers instantly (facts still ABI-encoded
   *    exactly as the Web2Json response would deliver them). Demo mode is an
   *    interaction accelerator, not the proof path.
   */
  fdcMode: process.env.FAKTURA_FDC ?? "demo",

  /** Flare FDC endpoints (testnet defaults, same as flare-hardhat-starter). */
  fdc: {
    verifierUrl:
      process.env.VERIFIER_URL_TESTNET ?? "https://fdc-verifiers-testnet.flare.network",
    verifierApiKey:
      process.env.VERIFIER_API_KEY_TESTNET ?? "00000000-0000-0000-0000-000000000000",
    daLayerUrl:
      process.env.COSTON2_DA_LAYER_URL ?? "https://ctn2-data-availability.flare.network",
  },

  /**
   * Supplier system-of-record (ERP). Strict-mode attestations read the
   * invoice document from `urlTemplate` ({number} → invoice number). The
   * default is the repo's committed ERP export served by GitHub Pages — the
   * same prefix the contract pins via `erpUrlPrefix`. (Pages, not raw
   * githubusercontent: the FDC Web2Json verifier requires the source to
   * respond with Content-Type application/json.) A hosted deployment can
   * point this at its own public `/erp/invoices/{number}` endpoint instead.
   */
  erp: {
    urlTemplate:
      process.env.FAKTURA_ERP_URL_TEMPLATE ??
      "https://a252937166.github.io/faktura/erp/{number}.json",
    /** Local directory of bundled ERP documents (served at /erp/invoices/:number). */
    docsDir: path.join(ROOT, "docs/erp"),
  },

  /** DemoFXRP settlement token on Coston2 (canonical FXRP on mainnet). */
  fxrp: process.env.FAKTURA_FXRP ?? "",

  dataDir: process.env.FAKTURA_DATA_DIR ?? path.join(ROOT, "agents/data"),
  /** Where the exact bytes of every anchored decision memo are persisted. */
  memosDir:
    process.env.FAKTURA_MEMOS_DIR ?? path.join(ROOT, "agents/data/memos"),
};

export type Persona = keyof typeof config.keys;
