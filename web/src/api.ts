export interface FeedEvent {
  ts: number;
  actor: string;
  kind: string;
  message: string;
  invoiceId?: number;
  deployHash?: string;
  data?: Record<string, unknown>;
}

export interface Decision {
  approve: boolean;
  riskScore: number;
  discountBps: number;
  rationale: string;
  redFlags: string[];
  policyNotes: string[];
  model: string;
  decisionHash: string;
  decidedTs: number;
}

export interface InvoiceRecord {
  id: number;
  intakeId: string;
  status: string;
  intake: {
    supplierName: string;
    debtorName: string;
    debtorTag: string;
    amountUsd: number;
    dueTs: number;
    invoiceNumber: string;
    description: string;
    history?: string;
    docHash: string;
    receivedTs: number;
  };
  decision?: Decision;
  chain: {
    registerHash?: string;
    fundHash?: string;
    settleHash?: string;
    defaultHash?: string;
    attestHashes: string[];
    advanceFlrWei?: string;
    fdcAttested?: boolean;
    fdcVotingRound?: number;
    fdcRequestTx?: string;
  };
}

export interface ChainStats {
  liquid: string;
  deployedCapital: string;
  totalShares: string;
  totalFundedFlr: string;
  totalSettledFlr: string;
  totalDefaultedFlr: string;
  invoiceCount: number;
  attestationCount: number;
  /** FXRP units (6 decimals) held by the pool as an oracle-priced reserve. */
  settlementTokenReserve?: string;
}

export interface OnchainInvoice {
  id: number;
  state: number;
  faceUsdCents: string;
  advanceFlrWei: string;
  dueTs: number;
  riskScore: number;
  discountBps: number;
}

export interface PoolResponse {
  stats: ChainStats;
  onchain: OnchainInvoice[];
  contract: string;
  explorer: string;
  flrPerUsd: string;
}

const j = <T>(r: Response): Promise<T> => {
  if (!r.ok) return r.json().then((b) => Promise.reject(new Error((b as any).error ?? r.statusText)));
  return r.json() as Promise<T>;
};

export const api = {
  pool: () => fetch("/api/pool").then((r) => j<PoolResponse>(r)),
  invoices: () => fetch("/api/invoices").then((r) => j<InvoiceRecord[]>(r)),
  meta: () => fetch("/api/meta").then((r) => j<{ contract: string; explorer: string; chain: string; fdcMode: string }>(r)),
  submit: (body: unknown) =>
    fetch("/api/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<InvoiceRecord>(r)),
  deposit: (amountFlr: number) =>
    fetch("/api/demo/deposit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountFlr }),
    }).then((r) => j<{ ok: boolean }>(r)),
  settle: (id: number) =>
    fetch(`/api/demo/settle/${id}`, { method: "POST" }).then((r) => j<{ ok: boolean }>(r)),
  settleFxrp: (id: number) =>
    fetch(`/api/demo/settle-fxrp/${id}`, { method: "POST" }).then((r) => j<{ ok: boolean }>(r)),
};

/** FLR wei (1e18) → FLR number. */
export const weiToFlr = (w: string | undefined) =>
  w ? Number(BigInt(w) / 10n ** 14n) / 10_000 : 0;

/** USD cents string → USD number. */
export const centsToUsd = (c: string | undefined) => (c ? Number(c) / 100 : 0);

export const stateName = (s: number) =>
  ["NONE", "LISTED", "FUNDED", "SETTLED", "DEFAULTED"][s] ?? `#${s}`;
