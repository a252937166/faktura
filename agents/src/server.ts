import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import { parseEther, formatEther } from "ethers";
import { config, ROOT } from "./config.js";
import { feed } from "./feed.js";
import { db } from "./store.js";
import { chain } from "./chain.js";
import { processIntake, type IntakeInput } from "./underwriter.js";
import { startCollector } from "./collector.js";
import { x402Gate } from "./x402.js";
import { getSeed } from "./chain-showcase.js";
import { getErpDocument, listErpDocuments } from "./erp.js";
import type { FeedEvent } from "./feed.js";
import type { InvoiceRecord } from "./store.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---- Intake / underwriting ------------------------------------------------

app.post("/api/invoices", async (req, res) => {
  try {
    const b = req.body as Partial<IntakeInput>;
    for (const k of ["supplierName", "debtorName", "amountUsd", "dueTs", "invoiceNumber"] as const) {
      if (b[k] === undefined) {
        res.status(400).json({ error: `missing field ${k}` });
        return;
      }
    }
    const record = await processIntake({
      supplierName: String(b.supplierName),
      supplierAddress: b.supplierAddress ? String(b.supplierAddress) : undefined,
      debtorName: String(b.debtorName),
      amountUsd: Number(b.amountUsd),
      dueTs: Number(b.dueTs),
      invoiceNumber: String(b.invoiceNumber),
      description: String(b.description ?? ""),
      history: b.history ? String(b.history) : undefined,
      document: b.document ? String(b.document) : undefined,
    });
    res.json(record);
  } catch (e) {
    feed.publish({ actor: "system", kind: "error", message: (e as Error).message.slice(0, 300) });
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get("/api/invoices", (_req, res) => {
  res.json(
    [...db.invoices]
      .sort((a, b) => b.intake.receivedTs - a.intake.receivedTs)
      .map(serializeRecord),
  );
});

// BigInt-safe record serialization (advanceFlrWei is a string already).
function serializeRecord(r: unknown) {
  return JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

// ---- Pool / chain state -----------------------------------------------------

let statsCache: { ts: number; data: unknown } = { ts: 0, data: null };
app.get("/api/pool", async (_req, res) => {
  try {
    if (Date.now() - statsCache.ts > 8_000) {
      const [stats, onchain, oneUsd] = await Promise.all([
        chain.stats(),
        chain.invoices(1, 200),
        chain.quoteUsdCentsInFlrWei(100).catch(() => 0n),
      ]);
      statsCache = {
        ts: Date.now(),
        data: serializeRecord({
          stats,
          onchain,
          contract: config.contract,
          explorer: config.explorerBase,
          flrPerUsd: formatEther(oneUsd),
        }),
      };
    }
    res.json(statsCache.data);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Demo actions run against funded testnet demo keys. In production these are
// ordinary user wallet transactions.
app.post("/api/demo/deposit", async (req, res) => {
  try {
    const flr = Number(req.body?.amountFlr ?? 0);
    if (!(flr > 0)) {
      res.status(400).json({ error: "amountFlr > 0 required" });
      return;
    }
    feed.publish({ actor: "system", kind: "demo", message: `LP depositing ${flr} FLR into the pool...` });
    const r = await chain.deposit("investor", parseEther(String(flr)));
    statsCache.ts = 0;
    feed.publish({ actor: "system", kind: "onchain", message: `LP deposit confirmed on-chain`, deployHash: r.hash });
    res.json({ ok: true, txHash: r.hash });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/demo/settle/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const inv = await chain.invoice(id);
    if (!inv) {
      res.status(404).json({ error: "invoice not found" });
      return;
    }
    // Quote face value in FLR at the live FTSO rate, add 1% headroom for rate drift.
    const requiredWei = await chain.quoteUsdCentsInFlrWei(Number(inv.faceUsdCents));
    const withHeadroom = (requiredWei * 101n) / 100n;
    feed.publish({
      actor: "system",
      kind: "demo",
      message: `Debtor settling invoice #${id}: $${Number(inv.faceUsdCents) / 100} = ${Number(formatEther(requiredWei)).toFixed(2)} FLR at live FTSO rate...`,
    });
    const r = await chain.settle(id, withHeadroom);
    statsCache.ts = 0;
    feed.publish({
      actor: "system",
      kind: "onchain",
      message: `Invoice #${id} settlement confirmed`,
      invoiceId: id,
      deployHash: r.hash,
    });
    res.json({ ok: true, txHash: r.hash });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Interoperable settlement leg: the debtor pays the USD face value in FXRP,
// priced by the live XRP/USD FTSOv2 feed; the pool holds the token reserve.
app.post("/api/demo/settle-fxrp/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const inv = await chain.invoice(id);
    if (!inv) {
      res.status(404).json({ error: "invoice not found" });
      return;
    }
    const tokenAmount = await chain.quoteUsdCentsInToken(Number(inv.faceUsdCents));
    feed.publish({
      actor: "system",
      kind: "demo",
      message: `Debtor settling invoice #${id} in FXRP: $${Number(inv.faceUsdCents) / 100} = ${(Number(tokenAmount) / 1e6).toFixed(4)} FXRP at live XRP/USD FTSO rate...`,
    });
    const r = await chain.settleInToken(id, tokenAmount);
    statsCache.ts = 0;
    feed.publish({
      actor: "system",
      kind: "onchain",
      message: `Invoice #${id} settled in FXRP — token reserve now held by the pool, valued via FTSOv2`,
      invoiceId: id,
      deployHash: r.hash,
    });
    res.json({ ok: true, txHash: r.hash });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---- Supplier system of record (ERP) ----------------------------------------
// The FDC Web2Json attestation reads invoice documents from a public HTTPS
// endpoint. This is that endpoint: canonical, deterministic invoice JSON —
// bundled docs/erp exports plus invoices submitted through the intake API.
// Point FAKTURA_ERP_URL_TEMPLATE at a publicly hosted instance to make the
// agent service its own attestable system of record.

app.get("/erp/invoices", (_req, res) => {
  res.json({ invoices: listErpDocuments() });
});

app.get("/erp/invoices/:number", (req, res) => {
  const doc = getErpDocument(String(req.params.number));
  if (!doc) {
    res.status(404).json({ error: "no such invoice in the system of record" });
    return;
  }
  res.json(doc);
});

// ---- Verifiable decision memos ----------------------------------------------
// Every underwriting decision's memo is persisted byte-exact; its sha256 is
// the on-chain decisionHash / attestation payloadHash. Fetch by hash, re-hash
// the body, compare with the contract — the AI's audit trail is checkable.

app.get("/api/memos/:hash", (req, res) => {
  const h = String(req.params.hash).replace(/^sha256[:-]/, "");
  if (!/^[0-9a-f]{64}$/i.test(h)) {
    res.status(400).json({ error: "expected sha256 hex hash" });
    return;
  }
  const file = path.join(config.memosDir, `sha256-${h}.json`);
  if (!fs.existsSync(file)) {
    res.status(404).json({ error: "no memo stored for this hash" });
    return;
  }
  res.type("application/json").send(fs.readFileSync(file, "utf8"));
});

// ---- x402-inspired machine-payable risk oracle -------------------------------

app.get("/api/risk/:id", x402Gate(), async (req, res) => {
  const id = Number(req.params.id);
  const record = db.invoices.find((x) => x.id === id);
  const inv = await chain.invoice(id).catch(() => null);
  if (!record?.decision || !inv) {
    res.status(404).json({ error: "no risk report for this invoice" });
    return;
  }
  res.json(
    serializeRecord({
      invoiceId: id,
      issuedAt: new Date().toISOString(),
      issuer: "faktura-risk-oracle-v1",
      riskScore: record.decision.riskScore,
      discountBps: record.decision.discountBps,
      redFlags: record.decision.redFlags,
      rationale: record.decision.rationale,
      decisionHash: record.decision.decisionHash,
      onchain: {
        state: inv.state,
        faceUsdCents: inv.faceUsdCents,
        dueTs: inv.dueTs,
        contract: config.contract,
        verify: `${config.explorerBase}/address/${config.contract}`,
      },
    }),
  );
});

// ---- Activity feed (SSE) ----------------------------------------------------

app.get("/api/activity", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ history: feed.history.slice(-100) })}\n\n`);
  const onEvent = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  feed.on("event", onEvent);
  req.on("close", () => feed.off("event", onEvent));
});

app.get("/api/meta", async (_req, res) => {
  res.json({
    contract: config.contract,
    chain: "coston2",
    rpc: config.rpcUrl,
    explorer: config.explorerBase,
    fxrp: config.fxrp,
    // x402-inspired HTTP 402 flow settled in native FLR (not the Coinbase
    // EIP-3009 stablecoin scheme) — see agents/src/x402.ts.
    x402Scheme: "x402-inspired/native-FLR",
    x402PriceWei: config.x402.priceWei,
    x402PayTo: config.x402.payTo,
    fdcMode: config.fdcMode,
    // Honest-mode flag: showcase hosts read a real Coston2 snapshot but
    // simulate writes; non-showcase hosts sign real Coston2 transactions.
    showcase: config.showcase,
    erpUrlTemplate: config.erp.urlTemplate,
  });
});

// ---- Static web app ---------------------------------------------------------

const webDist = path.join(ROOT, "web", "dist");
app.use(express.static(webDist));
app.get(/^\/(?!api).*/, (_req, res) => {
  res.sendFile(path.join(webDist, "index.html"), (err) => {
    if (err) res.status(404).send("web UI not built yet — run: cd web && npm run build");
  });
});

// ---- Boot -------------------------------------------------------------------

/** Preload the public showcase with a real captured Coston2 snapshot. */
function seedShowcase() {
  try {
    const seed = getSeed();
    if (Array.isArray(seed.records)) {
      db.invoices.length = 0;
      db.invoices.push(...(seed.records as InvoiceRecord[]));
    }
    if (Array.isArray(seed.feed)) {
      feed.history = seed.feed as FeedEvent[];
    }
    config.x402.payTo = seed.agentAddress;
    console.log(
      `showcase seed loaded: ${db.invoices.length} invoices, ${feed.history.length} activity events`,
    );
  } catch (e) {
    console.warn("showcase seed load failed:", (e as Error).message);
  }
}

async function main() {
  if (config.showcase) {
    seedShowcase();
  } else if (!config.contract) {
    console.warn("FAKTURA_CONTRACT not set — chain features disabled until deploy.");
  } else if (
    config.fdcMode === "demo" &&
    config.evidenceContract &&
    config.contract.toLowerCase() === config.evidenceContract.toLowerCase()
  ) {
    // Hard guard: the evidence hub stays strict forever. Demo mode would flip
    // its fdcEnforced flag off — refuse to start instead.
    console.error(
      `FATAL: demo mode must not target the EVIDENCE hub ${config.evidenceContract}.\n` +
        `Point FAKTURA_CONTRACT at the demo hub, or run with FAKTURA_FDC=strict.`,
    );
    process.exit(1);
  } else {
    config.x402.payTo = chain.address("agent");
    // In demo mode, make sure on-chain FDC enforcement is off so registrations
    // are instant; strict mode keeps it on (real Web2Json proofs required).
    try {
      const enforced = await chain.fdcEnforced();
      if (config.fdcMode === "demo" && enforced) {
        feed.publish({ actor: "system", kind: "boot", message: "Setting fdcEnforced=false for interactive demo…" });
        await chain.setFdcEnforced(false);
      } else if (config.fdcMode === "strict" && !enforced) {
        await chain.setFdcEnforced(true);
      }
    } catch (e) {
      console.warn("could not sync fdc mode:", (e as Error).message);
    }
  }

  app.listen(config.port, process.env.HOST ?? "0.0.0.0", () => {
    feed.publish({
      actor: "system",
      kind: "boot",
      message: config.showcase
        ? `Faktura showcase on :${config.port} — live autonomous AI underwriter, on-chain reads from real Coston2 snapshot`
        : `Faktura agent service on :${config.port} — contract ${config.contract || "(unset)"} (FDC ${config.fdcMode})`,
    });
    // The autonomous collector only runs against the real chain, never the showcase snapshot.
    if (config.contract && !config.showcase) startCollector();
  });
}

main();
