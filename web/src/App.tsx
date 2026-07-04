import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  weiToFlr,
  stateName,
  type FeedEvent,
  type InvoiceRecord,
  type PoolResponse,
} from "./api";

const ACTOR_ICON: Record<string, string> = {
  underwriter: "🧠",
  collector: "⏱",
  oracle: "🛰",
  system: "⚙️",
};

const riskColor = (r: number) => (r <= 30 ? "#2ee6a8" : r <= 55 ? "#ffcc4d" : "#ff5d73");
const fmt = (n: number, d = 2) => n.toLocaleString(undefined, { maximumFractionDigits: d });

function timeAgo(ts: number) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return `${s.toFixed(0)}s ago`;
  if (s < 3600) return `${(s / 60).toFixed(0)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
}

const EXPLORER = "https://coston2-explorer.flare.network";

export default function App() {
  const [pool, setPool] = useState<PoolResponse | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [selected, setSelected] = useState<InvoiceRecord | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [depositAmt, setDepositAmt] = useState("60");
  const [meta, setMeta] = useState<Awaited<ReturnType<typeof api.meta>> | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    try {
      const [p, inv] = await Promise.all([api.pool(), api.invoices()]);
      setPool(p);
      setInvoices(inv);
    } catch {
      /* backend booting */
    }
  };

  useEffect(() => {
    refresh();
    api.meta().then(setMeta).catch(() => {});
    const iv = setInterval(refresh, 12_000);
    const es = new EventSource("/api/activity");
    es.onmessage = (m) => {
      const data = JSON.parse(m.data);
      if (data.history) setEvents(data.history.reverse());
      else {
        setEvents((prev) => [data, ...prev].slice(0, 120));
        if (data.kind === "onchain" || data.kind === "decision") refresh();
      }
    };
    return () => {
      es.close();
      clearInterval(iv);
    };
  }, []);

  const s = pool?.stats;
  const tvl = s ? weiToFlr(s.liquid) + weiToFlr(s.deployedCapital) : 0;
  const sharePrice =
    s && BigInt(s.totalShares) > 0n
      ? Number(((BigInt(s.liquid) + BigInt(s.deployedCapital)) * 10_000n) / BigInt(s.totalShares)) / 10_000
      : 1;
  const flrPerUsd = pool ? Number(pool.flrPerUsd) : 0;

  const notify = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4200);
  };

  const contractShort = pool?.contract ? `${pool.contract.slice(0, 10)}…${pool.contract.slice(-6)}` : "not deployed";

  return (
    <div className="shell">
      <header className="header">
        <div>
          <div className="wordmark">
            FAKTU<em>RA</em>
          </div>
          <div className="tagline">The autonomous invoice-financing desk on Flare</div>
        </div>
        <div className="spacer" />
        {flrPerUsd > 0 && (
          <span className="chip" title="Live FTSOv2 FLR/USD feed read on-chain">
            <span className="dot" /> FTSO $1 = {fmt(flrPerUsd)} FLR
          </span>
        )}
        <span className="chip">Coston2</span>
        {pool?.contract && (
          <a className="chip" target="_blank" rel="noreferrer" href={`${EXPLORER}/address/${pool.contract}`}>
            ⛓ {contractShort}
          </a>
        )}
        <a className="chip" href="https://github.com/a252937166/faktura" target="_blank" rel="noreferrer">
          ⭐ GitHub
        </a>
      </header>

      {meta && (
        <div className={`mode-banner ${meta.showcase ? "mode-showcase" : "mode-live"}`}>
          {meta.showcase ? (
            <>
              <b>PUBLIC SHOWCASE</b> — real Coston2 snapshot, simulated writes. Real transaction
              evidence lives on the{" "}
              <a target="_blank" rel="noreferrer" href={`${EXPLORER}/address/${meta.contract}`}>
                Coston2 explorer
              </a>
              .
            </>
          ) : (
            <>
              <b>LIVE SIGNER</b> — state-changing actions send real Coston2 transactions.
            </>
          )}
        </div>
      )}

      <section className="hero">
        <div>
          <span className="hero-badge">
            <i /> AUTONOMOUS FINANCE ENGINE · ON FLARE
          </span>
          <h1>
            Real invoices.
            <br />
            <span className="grad">Funded by AI.</span>
          </h1>
          <p className="hero-sub">
            Faktura is an autonomous invoice-financing desk: an AI agent underwrites real-world
            receivables, FTSOv2 prices them on-chain, and the Flare Data Connector proves they are real.
          </p>
          <p className="hero-note">LLM proposes → policy disposes → registered, funded &amp; attested on Coston2.</p>
          <div className="hero-cta">
            <button
              className="btn-grad"
              onClick={() => document.getElementById("sell")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              SELL AN INVOICE →
            </button>
            <a
              className="btn-ghost"
              target="_blank"
              rel="noreferrer"
              href={pool?.contract ? `${EXPLORER}/address/${pool.contract}` : EXPLORER}
            >
              SEE IT ON-CHAIN →
            </a>
          </div>
          <div className="hero-metrics">
            <div className="hm-grad">
              <b>{fmt(tvl)} FLR</b>
              <span>pool TVL</span>
            </div>
            <div>
              <b>$1 = {fmt(flrPerUsd)} FLR</b>
              <span>live FTSOv2 oracle</span>
            </div>
            <div>
              <b>{s?.attestationCount ?? 0}</b>
              <span>AI decisions on-chain</span>
            </div>
          </div>
        </div>
        <div className="orbit-wrap" aria-hidden>
          <div className="orbit o3"><div className="rot"><i className="p" /></div></div>
          <div className="orbit o2"><div className="rot"><i className="p" /></div></div>
          <div className="orbit o1"><div className="rot"><i className="p" /></div></div>
          <div className="core" />
          <span className="star" style={{ top: "12%", left: "18%", width: 3, height: 3 }} />
          <span className="star" style={{ top: "72%", left: "8%", width: 2, height: 2, animationDelay: "1.2s" }} />
          <span className="star" style={{ top: "24%", left: "86%", width: 2, height: 2, animationDelay: ".6s" }} />
          <span className="star" style={{ top: "84%", left: "78%", width: 3, height: 3, animationDelay: "2s" }} />
        </div>
      </section>

      <section className="stats">
        <div className="stat">
          <div className="label">Pool TVL</div>
          <div className="value">{fmt(tvl)} FLR</div>
          <div className="sub">
            liquid {fmt(weiToFlr(s?.liquid))} · deployed {fmt(weiToFlr(s?.deployedCapital))}
          </div>
        </div>
        <div className="stat">
          <div className="label">LP Share Price</div>
          <div className={`value ${sharePrice > 1 ? "good" : ""}`}>{sharePrice.toFixed(4)}</div>
          <div className="sub">1.0000 at genesis — yield accrues here</div>
        </div>
        <div className="stat">
          <div className="label">Advances Funded</div>
          <div className="value accent">{fmt(weiToFlr(s?.totalFundedFlr))} FLR</div>
          <div className="sub">{s?.invoiceCount ?? 0} invoices registered</div>
        </div>
        <div className="stat">
          <div className="label">Collected</div>
          <div className="value">{fmt(weiToFlr(s?.totalSettledFlr))} FLR</div>
          <div className="sub">
            {Number(s?.settlementTokenReserve ?? 0) > 0
              ? `incl. ${(Number(s?.settlementTokenReserve) / 1e6).toFixed(4)} FXRP reserve (XRP/USD feed)`
              : "face value settled by debtors (FLR or FXRP)"}
          </div>
        </div>
        <div className="stat">
          <div className="label">Defaults</div>
          <div className={`value ${weiToFlr(s?.totalDefaultedFlr) > 0 ? "bad" : ""}`}>
            {fmt(weiToFlr(s?.totalDefaultedFlr))} FLR
          </div>
          <div className="sub">written off autonomously</div>
        </div>
        <div className="stat">
          <div className="label">AI Attestations</div>
          <div className="value">{s?.attestationCount ?? 0}</div>
          <div className="sub">decision hashes anchored on-chain</div>
        </div>
      </section>

      <div className="grid">
        <div style={{ display: "grid", gap: 16 }}>
          <div className="panel">
            <div className="head">
              Receivables pipeline
              <span className="hint">USD invoices priced to FLR at the live FTSOv2 rate</span>
              <span className="right hint">{invoices.length} intakes</span>
            </div>
            {invoices.length === 0 ? (
              <div className="empty">No invoices yet — submit one below and watch the underwriter work.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Supplier → Debtor</th>
                    <th className="num">Face</th>
                    <th className="num">Advance</th>
                    <th>Risk</th>
                    <th>Due</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((r) => {
                    const chainInv = pool?.onchain.find((o) => o.id === r.id);
                    const status = chainInv && r.id ? stateName(chainInv.state) : r.status.toUpperCase();
                    return (
                      <tr key={r.intakeId} className="row" onClick={() => setSelected(r)}>
                        <td className="mono">{r.intake.invoiceNumber}</td>
                        <td>
                          {r.intake.supplierName} <span className="muted">→</span> {r.intake.debtorName}
                        </td>
                        <td className="num mono">${fmt(r.intake.amountUsd, 0)}</td>
                        <td className="num mono">
                          {r.chain.advanceFlrWei ? `${fmt(weiToFlr(r.chain.advanceFlrWei))} FLR` : "—"}
                        </td>
                        <td>
                          {r.decision ? (
                            <span className="risk">
                              <span className="bar">
                                <i style={{ width: `${r.decision.riskScore}%`, background: riskColor(r.decision.riskScore) }} />
                              </span>
                              <span className="mono">{r.decision.riskScore}</span>
                            </span>
                          ) : (
                            <span className="muted mono">…</span>
                          )}
                        </td>
                        <td className="mono muted">{new Date(r.intake.dueTs).toISOString().slice(0, 10)}</td>
                        <td>
                          <span className={`badge ${status}`}>{status}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div className="pool-actions">
              <span className="muted" style={{ fontSize: 12 }}>
                LP demo:
              </span>
              <input value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} />
              <button
                className="btn ghost sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.deposit(Number(depositAmt));
                    notify(`Deposited ${depositAmt} FLR into the pool`);
                    refresh();
                  } catch (e) {
                    notify(`Deposit failed: ${(e as Error).message}`);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Deposit FLR
              </button>
              <span className="muted" style={{ fontSize: 11.5, fontFamily: "var(--mono)" }}>
                share price {sharePrice.toFixed(4)} · funded from real Coston2 balance
              </span>
            </div>
          </div>

          <div id="sell">
            <SubmitPanel
              flrPerUsd={flrPerUsd}
              onSubmitted={(r) => {
                notify(
                  r.status === "rejected"
                    ? `Underwriter REJECTED ${r.intake.invoiceNumber}`
                    : `Underwriter approved & funded ${r.intake.invoiceNumber}`,
                );
                refresh();
              }}
            />
          </div>
        </div>

        <div className="panel">
          <div className="head">
            Agent activity
            <span className="hint">live</span>
            <span className="right">
              <span className="dot" />
            </span>
          </div>
          <div className="feed" ref={feedRef}>
            {events.length === 0 && <div className="empty">Agents idle…</div>}
            {events.map((e, i) => (
              <div className="feed-item" key={`${e.ts}-${i}`}>
                <div className="avatar">{ACTOR_ICON[e.actor] ?? "•"}</div>
                <div className="body">
                  <div className="msg">{e.message}</div>
                  <div className="meta">
                    <span>{e.actor}</span>
                    <span>{timeAgo(e.ts)}</span>
                    {e.deployHash && (
                      <a target="_blank" rel="noreferrer" href={`${EXPLORER}/tx/${e.deployHash}`}>
                        tx {e.deployHash.slice(0, 8)}…
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {selected && (
        <Drawer
          record={selected}
          pool={pool}
          busy={busy}
          onClose={() => setSelected(null)}
          onSettle={async (id) => {
            setBusy(true);
            try {
              await api.settle(id);
              notify(`Settlement submitted for invoice #${id}`);
              refresh();
            } catch (e) {
              notify(`Settle failed: ${(e as Error).message}`);
            } finally {
              setBusy(false);
            }
          }}
          onSettleFxrp={async (id) => {
            setBusy(true);
            try {
              await api.settleFxrp(id);
              notify(`FXRP settlement submitted for invoice #${id} (XRP/USD FTSO rate)`);
              refresh();
            } catch (e) {
              notify(`FXRP settle failed: ${(e as Error).message}`);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function SubmitPanel({ flrPerUsd, onSubmitted }: { flrPerUsd: number; onSubmitted: (r: InvoiceRecord) => void }) {
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    supplierName: "Nordwind Logistics GmbH",
    debtorName: "Aurora Retail AG",
    amountUsd: "1.20",
    dueDays: "30",
    invoiceNumber: `INV-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 900) + 100)}`,
    description: "March freight services, 14 pallet shipments Hamburg → Vienna",
    history: "6 prior invoices, all paid within terms",
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.submit({
        supplierName: form.supplierName,
        debtorName: form.debtorName,
        amountUsd: Number(form.amountUsd),
        dueTs: Date.now() + Number(form.dueDays) * 86_400_000,
        invoiceNumber: form.invoiceNumber,
        description: form.description,
        history: form.history,
      });
      onSubmitted(r);
      set("invoiceNumber", `INV-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 900) + 100)}`);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const estFlr = flrPerUsd > 0 ? Number(form.amountUsd) * flrPerUsd : 0;

  return (
    <div className="panel">
      <div className="head">
        Sell a receivable
        <span className="hint">intake goes straight to the autonomous underwriter</span>
      </div>
      <div className="form">
        <div className="field">
          <label>Supplier (you)</label>
          <input value={form.supplierName} onChange={(e) => set("supplierName", e.target.value)} />
        </div>
        <div className="field">
          <label>Debtor (owes the invoice)</label>
          <input value={form.debtorName} onChange={(e) => set("debtorName", e.target.value)} />
        </div>
        <div className="field">
          <label>Face value (USD)</label>
          <input value={form.amountUsd} onChange={(e) => set("amountUsd", e.target.value)} />
        </div>
        <div className="field">
          <label>Due in (days)</label>
          <input value={form.dueDays} onChange={(e) => set("dueDays", e.target.value)} />
        </div>
        <div className="field">
          <label>Invoice number</label>
          <input value={form.invoiceNumber} onChange={(e) => set("invoiceNumber", e.target.value)} />
        </div>
        <div className="field">
          <label>Payment history</label>
          <input value={form.history} onChange={(e) => set("history", e.target.value)} />
        </div>
        <div className="field full">
          <label>Description</label>
          <textarea rows={2} value={form.description} onChange={(e) => set("description", e.target.value)} />
        </div>
        <div className="full" style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button className="btn" disabled={busy} onClick={submit}>
            {busy ? "Underwriting…" : "Submit to underwriter"}
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            {estFlr > 0 ? `≈ ${fmt(estFlr, 0)} FLR at live FTSO rate · ` : ""}LLM proposes → policy disposes → FDC-registered, FTSO-funded, attested
          </span>
        </div>
      </div>
    </div>
  );
}

function Drawer({
  record,
  pool,
  busy,
  onClose,
  onSettle,
  onSettleFxrp,
}: {
  record: InvoiceRecord;
  pool: PoolResponse | null;
  busy: boolean;
  onClose: () => void;
  onSettle: (id: number) => void;
  onSettleFxrp: (id: number) => void;
}) {
  const chainInv = pool?.onchain.find((o) => o.id === record.id);
  const status = chainInv && record.id ? stateName(chainInv.state) : record.status.toUpperCase();
  const d = record.decision;

  const txs = useMemo(
    () =>
      [
        ["FDC attestation request", record.chain.fdcRequestTx],
        ["Register (FDC-gated)", record.chain.registerHash],
        ["Fund (FTSO-priced advance)", record.chain.fundHash],
        ["Settle", record.chain.settleHash],
        ["Default write-off", record.chain.defaultHash],
        ...record.chain.attestHashes.map((h, i) => [`Attestation #${i + 1}`, h] as const),
      ].filter(([, h]) => h),
    [record],
  );

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <h2>
          {record.intake.invoiceNumber} <span className={`badge ${status}`}>{status}</span>
        </h2>
        <div className="muted" style={{ fontSize: 13 }}>
          {record.intake.supplierName} → {record.intake.debtorName} · ${fmt(record.intake.amountUsd, 0)} · due{" "}
          {new Date(record.intake.dueTs).toLocaleString()}
        </div>

        {d && (
          <div className="section">
            <h3>AI underwriting decision</h3>
            <div className="gauge">
              <div className="ring">
                <svg width="74" height="74" viewBox="0 0 74 74">
                  <circle cx="37" cy="37" r="31" fill="none" stroke="#232b40" strokeWidth="7" />
                  <circle
                    cx="37"
                    cy="37"
                    r="31"
                    fill="none"
                    stroke={riskColor(d.riskScore)}
                    strokeWidth="7"
                    strokeLinecap="round"
                    strokeDasharray={`${(d.riskScore / 100) * 195} 195`}
                  />
                </svg>
                <div className="val" style={{ color: riskColor(d.riskScore) }}>
                  {d.riskScore}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>
                  {d.approve ? "APPROVED" : "REJECTED"} · discount {(d.discountBps / 100).toFixed(2)}%
                </div>
                <div className="muted" style={{ fontSize: 12.5 }}>
                  model {d.model} · {new Date(d.decidedTs).toLocaleTimeString()}
                </div>
                <div className="note" style={{ marginTop: 4 }}>
                  memo hash {d.decisionHash.slice(0, 26)}… anchored on-chain
                </div>
              </div>
            </div>
            <div className="memo" style={{ marginTop: 12 }}>
              {d.rationale}
            </div>
            {d.redFlags.length > 0 && (
              <div className="flags" style={{ marginTop: 10 }}>
                {d.redFlags.map((f) => (
                  <span className="flag" key={f}>
                    ⚑ {f}
                  </span>
                ))}
              </div>
            )}
            {d.policyNotes.length > 0 && (
              <div style={{ marginTop: 10 }}>
                {d.policyNotes.map((n) => (
                  <div className="note" key={n}>
                    ▸ policy: {n}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="section">
          <h3>Terms</h3>
          <div className="kv">
            <span className="k">Face value</span>
            <span className="mono">${fmt(record.intake.amountUsd, 0)} USD</span>
            <span className="k">Advance</span>
            <span className="mono">
              {record.chain.advanceFlrWei ? `${fmt(weiToFlr(record.chain.advanceFlrWei))} FLR` : "—"}
            </span>
            <span className="k">Pool fee</span>
            <span className="mono">{d ? `${(d.discountBps / 100).toFixed(2)}%` : "—"}</span>
            <span className="k">Facts source</span>
            <span className="mono">
              {record.chain.fdcAttested
                ? `FDC Web2Json (attested${record.chain.fdcVotingRound ? `, round ${record.chain.fdcVotingRound}` : ""})`
                : "FDC Web2Json (demo mode)"}
            </span>
            <span className="k">Debtor tag</span>
            <span className="mono">{record.intake.debtorTag}</span>
            <span className="k">Document hash</span>
            <span className="mono" style={{ wordBreak: "break-all" }}>
              {record.intake.docHash}
            </span>
          </div>
        </div>

        <div className="section">
          <h3>On-chain trail</h3>
          {txs.length === 0 && <div className="muted">No transactions yet.</div>}
          {txs.map(([label, hash]) => (
            <div className="txlink" key={String(hash)}>
              <span>{label}</span>
              <a target="_blank" rel="noreferrer" href={`${EXPLORER}/tx/${hash}`}>
                {String(hash).slice(0, 14)}… ↗
              </a>
            </div>
          ))}
        </div>

        {status === "FUNDED" && (
          <div className="section">
            <button className="btn" disabled={busy} onClick={() => onSettle(record.id)}>
              {busy ? "Settling…" : `Simulate debtor payment ($${fmt(record.intake.amountUsd, 0)} in FLR)`}
            </button>
            <button
              className="btn"
              disabled={busy}
              style={{ marginTop: 8 }}
              onClick={() => onSettleFxrp(record.id)}
            >
              {busy ? "Settling…" : `Settle in FXRP instead (XRP/USD feed)`}
            </button>
            <div className="note" style={{ marginTop: 6 }}>
              Debtor pays the USD face value in FLR (FLR/USD feed) or FXRP (XRP/USD feed) —
              both converted at the live FTSOv2 rate at settlement time.
            </div>
          </div>
        )}
      </div>
    </>
  );
}
