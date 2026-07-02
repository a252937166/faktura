import { formatEther } from "ethers";
import { chain } from "./chain.js";
import { config } from "./config.js";
import { feed } from "./feed.js";
import { findByChainId, upsertInvoice } from "./store.js";

/**
 * The collector agent: watches funded invoices, reconciles settlements
 * observed on-chain, and autonomously writes off invoices past due + grace.
 */
export function startCollector() {
  let running = false;
  const graceMs = config.collector.graceSeconds * 1000;

  const tick = async () => {
    if (running || !config.contract) return;
    running = true;
    try {
      const invoices = await chain.invoices(1, 500);
      for (const inv of invoices) {
        const local = findByChainId(inv.id);

        if (inv.state === 3 && local && local.status !== "settled") {
          local.status = "settled";
          upsertInvoice(local);
          feed.publish({
            actor: "collector",
            kind: "reconcile",
            message: `Invoice #${inv.id} settled on-chain — ${Number(formatEther(inv.settledFlrWei)).toFixed(2)} FLR collected, yield realized by the pool`,
            invoiceId: inv.id,
          });
          await safeAttest("SETTLE_CONFIRM", inv.id);
        }

        if (inv.state === 2 && Date.now() > inv.dueTs * 1000 + graceMs) {
          feed.publish({
            actor: "collector",
            kind: "default",
            message: `Invoice #${inv.id} is ${Math.round((Date.now() - inv.dueTs * 1000) / 1000)}s past due (grace ${config.collector.graceSeconds}s) — marking default`,
            invoiceId: inv.id,
          });
          try {
            const res = await chain.markDefault(inv.id);
            if (local) {
              local.status = "defaulted";
              local.chain.defaultHash = res.hash;
              upsertInvoice(local);
            }
            feed.publish({
              actor: "collector",
              kind: "onchain",
              message: `Invoice #${inv.id} written off on-chain; loss absorbed by pool share price`,
              invoiceId: inv.id,
              deployHash: res.hash,
            });
            await safeAttest("DEFAULT_FLAG", inv.id);
          } catch (e) {
            feed.publish({
              actor: "system",
              kind: "warn",
              message: `markDefault(${inv.id}) failed: ${(e as Error).message.slice(0, 160)}`,
            });
          }
        }
      }
    } catch (e) {
      feed.publish({
        actor: "system",
        kind: "warn",
        message: `collector tick failed: ${(e as Error).message.slice(0, 160)}`,
      });
    } finally {
      running = false;
    }
  };

  setInterval(tick, config.collector.intervalMs);
  feed.publish({
    actor: "collector",
    kind: "boot",
    message: `Collector agent online — watching due dates every ${config.collector.intervalMs / 1000}s (grace ${config.collector.graceSeconds}s)`,
  });
}

async function safeAttest(kind: string, id: number) {
  try {
    const att = await chain.attest(kind, id, `sha256:auto-${kind}-${id}`, "collector-v1");
    const local = findByChainId(id);
    if (local) {
      local.chain.attestHashes.push(att.hash);
      upsertInvoice(local);
    }
  } catch {
    /* best effort */
  }
}
