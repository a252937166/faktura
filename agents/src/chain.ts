import { createRequire } from "node:module";
import { Contract, JsonRpcProvider, Wallet, type InterfaceAbi } from "ethers";
import { config, type Persona } from "./config.js";

const require = createRequire(import.meta.url);
const ABI = require("./abi/FakturaHub.json") as InterfaceAbi;

export const provider = new JsonRpcProvider(config.rpcUrl, {
  chainId: config.chainId,
  name: "coston2",
});

const wallets: Record<Persona, Wallet> = {
  agent: new Wallet(config.keys.agent, provider),
  investor: new Wallet(config.keys.investor, provider),
  debtor: new Wallet(config.keys.debtor, provider),
};

export const address = (p: Persona) => wallets[p].address;

function hub(persona: Persona) {
  return new Contract(config.contract, ABI, wallets[persona]);
}

/** Read-only hub bound to the provider. */
export const hubRead = () => new Contract(config.contract, ABI, provider);

/** Serialize transactions per persona so nonces don't collide. */
const queues = new Map<Persona, Promise<unknown>>();
function enqueue<T>(persona: Persona, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(persona) ?? Promise.resolve();
  const next = prev.then(task, task);
  queues.set(persona, next as Promise<unknown>);
  return next;
}

const explorer = (hash: string) => `${config.explorerBase}/tx/${hash}`;

export interface TxResult {
  hash: string;
  explorer: string;
}

// ---- Typed views -----------------------------------------------------------

export interface ChainInvoice {
  id: number;
  supplier: string;
  invoiceNumber: string;
  debtorTag: string;
  docHash: string;
  faceUsdCents: bigint;
  dueTs: number;
  riskScore: number;
  discountBps: number;
  decisionHash: string;
  state: number;
  advanceFlrWei: bigint;
  settledFlrWei: bigint;
  registeredTs: number;
  fundedTs: number;
  closedTs: number;
}

export interface ChainStats {
  liquid: bigint;
  deployedCapital: bigint;
  totalShares: bigint;
  totalFundedFlr: bigint;
  totalSettledFlr: bigint;
  totalDefaultedFlr: bigint;
  invoiceCount: number;
  attestationCount: number;
}

function mapInvoice(r: any): ChainInvoice {
  return {
    id: Number(r.id),
    supplier: r.supplier,
    invoiceNumber: r.invoiceNumber,
    debtorTag: r.debtorTag,
    docHash: r.docHash,
    faceUsdCents: r.faceUsdCents,
    dueTs: Number(r.dueTs),
    riskScore: Number(r.riskScore),
    discountBps: Number(r.discountBps),
    decisionHash: r.decisionHash,
    state: Number(r.state),
    advanceFlrWei: r.advanceFlrWei,
    settledFlrWei: r.settledFlrWei,
    registeredTs: Number(r.registeredTs),
    fundedTs: Number(r.fundedTs),
    closedTs: Number(r.closedTs),
  };
}

export const chain = {
  provider,
  address,

  async stats(): Promise<ChainStats> {
    const s = await hubRead().stats();
    return {
      liquid: s.liquid,
      deployedCapital: s.deployedCapital,
      totalShares: s.totalShares,
      totalFundedFlr: s.totalFundedFlr,
      totalSettledFlr: s.totalSettledFlr,
      totalDefaultedFlr: s.totalDefaultedFlr,
      invoiceCount: Number(s.invoiceCount),
      attestationCount: Number(s.attestationCount),
    };
  },

  async invoices(from = 1, count = 200): Promise<ChainInvoice[]> {
    const rows = await hubRead().listInvoices(from, count);
    return rows.map(mapInvoice);
  },

  async invoice(id: number): Promise<ChainInvoice | null> {
    const r = await hubRead().getInvoice(id);
    return Number(r.state) === 0 ? null : mapInvoice(r);
  },

  async quoteUsdCentsInFlrWei(cents: number): Promise<bigint> {
    return hubRead().quoteUsdCentsInFlrWei(cents);
  },

  /** Registers via a prepared Web2Json proof (real FDC path). */
  registerWithProof(
    proof: unknown,
    supplier: string,
    risk: number,
    discountBps: number,
    decisionHash: string,
  ) {
    return enqueue("agent", async () => {
      const tx = await hub("agent").registerInvoice(proof, supplier, risk, discountBps, decisionHash);
      const rc = await tx.wait();
      const id = await extractInvoiceId(rc);
      return { id, hash: tx.hash, explorer: explorer(tx.hash) };
    });
  },

  fund(id: number): Promise<TxResult> {
    return enqueue("agent", async () => {
      const tx = await hub("agent").fundInvoice(id);
      await tx.wait();
      return { hash: tx.hash, explorer: explorer(tx.hash) };
    });
  },

  settle(id: number, valueWei: bigint): Promise<TxResult> {
    return enqueue("debtor", async () => {
      const tx = await hub("debtor").settleInvoice(id, { value: valueWei });
      await tx.wait();
      return { hash: tx.hash, explorer: explorer(tx.hash) };
    });
  },

  markDefault(id: number): Promise<TxResult> {
    return enqueue("collector" in wallets ? "agent" : "agent", async () => {
      const tx = await hub("agent").markDefault(id);
      await tx.wait();
      return { hash: tx.hash, explorer: explorer(tx.hash) };
    });
  },

  deposit(persona: Persona, valueWei: bigint): Promise<TxResult> {
    return enqueue(persona, async () => {
      const tx = await hub(persona).deposit({ value: valueWei });
      await tx.wait();
      return { hash: tx.hash, explorer: explorer(tx.hash) };
    });
  },

  attest(kind: string, subjectId: number, payloadHash: string, model: string): Promise<TxResult & { id: number }> {
    return enqueue("agent", async () => {
      const tx = await hub("agent").attest(kind, subjectId, payloadHash, model);
      const rc = await tx.wait();
      const id = await extractAttestationId(rc);
      return { id, hash: tx.hash, explorer: explorer(tx.hash) };
    });
  },

  async setFdcEnforced(enforced: boolean): Promise<TxResult> {
    const tx = await hub("agent").setFdcEnforced(enforced);
    await tx.wait();
    return { hash: tx.hash, explorer: explorer(tx.hash) };
  },

  async fdcEnforced(): Promise<boolean> {
    return hubRead().fdcEnforced();
  },
};

async function extractInvoiceId(receipt: any): Promise<number> {
  const iface = hubRead().interface;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "InvoiceRegistered") return Number(parsed.args.id);
    } catch {
      /* not our event */
    }
  }
  return 0;
}

async function extractAttestationId(receipt: any): Promise<number> {
  const iface = hubRead().interface;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "AgentAttested") return Number(parsed.args.id);
    } catch {
      /* not our event */
    }
  }
  return 0;
}
