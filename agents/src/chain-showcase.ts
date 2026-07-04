import crypto from "node:crypto";
import fs from "node:fs";
import { AbiCoder } from "ethers";
import { config, type Persona } from "./config.js";
import type { ChainInvoice, ChainStats, TxResult } from "./chain.js";

/**
 * In-memory "chain" for the hosted public showcase. Reads come from a captured
 * snapshot of the REAL Coston2 contract (verifiable on the explorer); writes
 * are simulated so visitors can exercise the live AI underwriter without
 * secret keys or testnet gas. Seeded invoices keep their real tx hashes;
 * simulated writes get placeholder hashes and are transient demo state.
 */

interface SeedJson {
  stats: Record<string, string | number>;
  onchain: Record<string, string | number>[];
  contract: string;
  explorer: string;
  /** FLR wei that $1.00 (100 cents) buys at the captured FTSOv2 rate. */
  oneUsdFlrWei: string;
  /** FXRP smallest units that $1.00 buys at the captured XRP/USD rate. */
  oneUsdFxrpUnits?: string;
  agentAddress: string;
  records?: unknown[];
  feed?: unknown[];
}

interface SeedState {
  stats: ChainStats;
  onchain: ChainInvoice[];
  oneUsdFlrWei: bigint;
  oneUsdFxrpUnits: bigint;
  agentAddress: string;
  records: unknown[];
  feed: unknown[];
  raw: SeedJson;
}

let _seed: SeedState | null = null;
export function getSeed(): SeedState {
  if (_seed) return _seed;
  const raw = JSON.parse(fs.readFileSync(config.seedPath, "utf8")) as SeedJson;
  _seed = {
    stats: {
      liquid: BigInt(raw.stats.liquid as string),
      deployedCapital: BigInt(raw.stats.deployedCapital as string),
      totalShares: BigInt(raw.stats.totalShares as string),
      totalFundedFlr: BigInt(raw.stats.totalFundedFlr as string),
      totalSettledFlr: BigInt(raw.stats.totalSettledFlr as string),
      totalDefaultedFlr: BigInt(raw.stats.totalDefaultedFlr as string),
      invoiceCount: Number(raw.stats.invoiceCount),
      attestationCount: Number(raw.stats.attestationCount),
      settlementTokenReserve: BigInt((raw.stats.settlementTokenReserve as string) ?? "0"),
    },
    onchain: raw.onchain.map((r) => ({
      id: Number(r.id),
      supplier: String(r.supplier),
      invoiceNumber: String(r.invoiceNumber),
      debtorTag: String(r.debtorTag),
      docHash: String(r.docHash),
      faceUsdCents: BigInt(r.faceUsdCents as string),
      dueTs: Number(r.dueTs),
      riskScore: Number(r.riskScore),
      discountBps: Number(r.discountBps),
      decisionHash: String(r.decisionHash),
      state: Number(r.state),
      advanceFlrWei: BigInt(r.advanceFlrWei as string),
      settledFlrWei: BigInt(r.settledFlrWei as string),
      registeredTs: Number(r.registeredTs),
      fundedTs: Number(r.fundedTs),
      closedTs: Number(r.closedTs),
    })),
    oneUsdFlrWei: BigInt(raw.oneUsdFlrWei),
    // fallback ≈ $1.14/XRP so old seeds keep working
    oneUsdFxrpUnits: BigInt(raw.oneUsdFxrpUnits ?? "877963"),
    agentAddress: raw.agentAddress,
    records: raw.records ?? [],
    feed: raw.feed ?? [],
    raw,
  };
  return _seed;
}

const pseudoHash = () => `0x${crypto.randomBytes(32).toString("hex")}`;
const tx = (): TxResult => {
  const hash = pseudoHash();
  return { hash, explorer: `${config.explorerBase}/tx/${hash}` };
};

/** Decodes InvoiceFacts back out of a (demo) Web2Json proof. */
function factsFromProof(proof: any) {
  const encoded = proof?.data?.responseBody?.abiEncodedData as string;
  const [f] = AbiCoder.defaultAbiCoder().decode(
    ["tuple(string,string,string,uint256,uint256)"],
    encoded,
  );
  return {
    invoiceNumber: String(f[0]),
    debtorTag: String(f[1]),
    docHash: String(f[2]),
    amountUsdCents: BigInt(f[3]),
    dueTs: Number(f[4]),
  };
}

export const showcaseChain = {
  address: (_p: Persona) => getSeed().agentAddress,

  async stats(): Promise<ChainStats> {
    return { ...getSeed().stats };
  },

  async invoices(): Promise<ChainInvoice[]> {
    return getSeed().onchain;
  },

  async invoice(id: number): Promise<ChainInvoice | null> {
    return getSeed().onchain.find((i) => i.id === id) ?? null;
  },

  async quoteUsdCentsInFlrWei(cents: number | bigint): Promise<bigint> {
    return (getSeed().oneUsdFlrWei * BigInt(cents)) / 100n;
  },

  async quoteUsdCentsInToken(cents: number | bigint): Promise<bigint> {
    return (getSeed().oneUsdFxrpUnits * BigInt(cents)) / 100n;
  },

  /** Simulated FXRP settlement: reserve grows, invoice closes. */
  async settleInToken(id: number, tokenAmount: bigint): Promise<TxResult> {
    const s = getSeed();
    const inv = s.onchain.find((i) => i.id === id);
    if (inv && inv.state === 2) {
      inv.state = 3; // SETTLED
      inv.settledFlrWei = await showcaseChain.quoteUsdCentsInFlrWei(inv.faceUsdCents);
      inv.closedTs = Math.floor(Date.now() / 1000);
      s.stats.deployedCapital -= inv.advanceFlrWei;
      s.stats.totalSettledFlr += inv.settledFlrWei;
      s.stats.settlementTokenReserve += tokenAmount;
    }
    return tx();
  },

  registerWithProof(
    proof: unknown,
    supplier: string,
    risk: number,
    discountBps: number,
    decisionHash: string,
  ): Promise<TxResult & { id: number }> {
    const s = getSeed();
    const f = factsFromProof(proof);
    const id = s.onchain.reduce((m, i) => Math.max(m, i.id), 0) + 1;
    s.onchain.push({
      id,
      supplier,
      invoiceNumber: f.invoiceNumber,
      debtorTag: f.debtorTag,
      docHash: f.docHash,
      faceUsdCents: f.amountUsdCents,
      dueTs: f.dueTs,
      riskScore: risk,
      discountBps,
      decisionHash,
      state: 1, // LISTED
      advanceFlrWei: 0n,
      settledFlrWei: 0n,
      registeredTs: Math.floor(Date.now() / 1000),
      fundedTs: 0,
      closedTs: 0,
    });
    s.stats.invoiceCount += 1;
    return Promise.resolve({ id, ...tx() });
  },

  async fund(id: number): Promise<TxResult> {
    const s = getSeed();
    const inv = s.onchain.find((i) => i.id === id);
    if (inv && inv.state === 1) {
      const face = await showcaseChain.quoteUsdCentsInFlrWei(inv.faceUsdCents);
      const advance = (face * BigInt(10_000 - inv.discountBps)) / 10_000n;
      inv.state = 2; // FUNDED
      inv.advanceFlrWei = advance;
      inv.fundedTs = Math.floor(Date.now() / 1000);
      s.stats.liquid -= advance;
      s.stats.deployedCapital += advance;
      s.stats.totalFundedFlr += advance;
    }
    return tx();
  },

  async settle(id: number, valueWei: bigint): Promise<TxResult> {
    const s = getSeed();
    const inv = s.onchain.find((i) => i.id === id);
    if (inv && inv.state === 2) {
      inv.state = 3; // SETTLED
      inv.settledFlrWei = valueWei;
      inv.closedTs = Math.floor(Date.now() / 1000);
      s.stats.deployedCapital -= inv.advanceFlrWei;
      s.stats.liquid += valueWei;
      s.stats.totalSettledFlr += valueWei;
    }
    return tx();
  },

  async markDefault(id: number): Promise<TxResult> {
    const s = getSeed();
    const inv = s.onchain.find((i) => i.id === id);
    if (inv && inv.state === 2) {
      inv.state = 4; // DEFAULTED
      inv.closedTs = Math.floor(Date.now() / 1000);
      s.stats.deployedCapital -= inv.advanceFlrWei;
      s.stats.totalDefaultedFlr += inv.advanceFlrWei;
    }
    return tx();
  },

  async deposit(_persona: Persona, valueWei: bigint): Promise<TxResult> {
    const s = getSeed();
    const tvl = s.stats.liquid + s.stats.deployedCapital;
    const minted =
      tvl > 0n && s.stats.totalShares > 0n ? (valueWei * s.stats.totalShares) / tvl : valueWei;
    s.stats.liquid += valueWei;
    s.stats.totalShares += minted;
    return tx();
  },

  attest(
    _kind: string,
    _subjectId: number,
    _payloadHash: string,
    _model: string,
  ): Promise<TxResult & { id: number }> {
    const s = getSeed();
    s.stats.attestationCount += 1;
    return Promise.resolve({ id: s.stats.attestationCount, ...tx() });
  },

  async setFdcEnforced(_enforced: boolean): Promise<TxResult> {
    return tx();
  },

  async fdcEnforced(): Promise<boolean> {
    return false;
  },
};
