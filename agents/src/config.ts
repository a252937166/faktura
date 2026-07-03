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

  /** Deployed FakturaHub address on Coston2. */
  contract: process.env.FAKTURA_CONTRACT ?? "",

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
   * FDC gating. When "demo", the agent flips the on-chain `fdcEnforced` flag off
   * at boot so the interactive demo registers invoices instantly. The real
   * Web2Json attestation path lives in scripts/registerViaFdc.ts. Set
   * FAKTURA_FDC=strict to keep on-chain enforcement on.
   */
  fdcMode: process.env.FAKTURA_FDC ?? "demo",

  dataDir: process.env.FAKTURA_DATA_DIR ?? path.join(ROOT, "agents/data"),
};

export type Persona = keyof typeof config.keys;
