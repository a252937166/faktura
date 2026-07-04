# Faktura — the autonomous invoice-financing desk on Flare

> Real-world receivables, underwritten by an autonomous AI agent, financed by
> an on-chain liquidity pool, priced live by **FTSOv2** (FLR/USD *and*
> XRP/USD), provenance-gated by the **Flare Data Connector (FDC)** — and every
> autonomous decision hash-anchored on-chain.

**Flare Summer Signal** submission · Bounty 1 (Interoperable Asset Products) ·
Live on **Coston2** — evidence hub [`0x2415Ed…CeEb`](https://coston2-explorer.flare.network/address/0x2415Ed954A18a5c232c9d40a753C77f401AaCeEb) (verified, **permanently `fdcEnforced=true`**)

**Demo video (2:39): [youtu.be/F0xH_rnV4iM](https://youtu.be/F0xH_rnV4iM)** ·
**Hosted demo: [flare.axiqo.xyz](https://flare.axiqo.xyz/)** — public showcase
(real Coston2 snapshot reads, simulated writes; the mode banner on the page and
`/api/meta.showcase` say so). Real transaction evidence is in the table below.

**Judges: [`docs/judges.md`](docs/judges.md) is the 3-minute evaluation path.**

---

## Live deployment & on-chain evidence

Everything below is a real Coston2 transaction — no judge should have to hunt
for proof.

Two hubs, one verified source (**two-address posture**): the *evidence hub*
is permanently strict — `fdcEnforced=true` from genesis, never demoted, and
the tooling hard-refuses to run demo mode against it. The *demo hub* backs
the interactive UI, where the (admin-only, evented) demo toggle may be used.

| Item | Value |
|---|---|
| Network | Flare **Coston2** (chainId 114) |
| **EVIDENCE hub** (verified, always strict) | [`0x2415Ed954A18a5c232c9d40a753C77f401AaCeEb`](https://coston2-explorer.flare.network/address/0x2415Ed954A18a5c232c9d40a753C77f401AaCeEb#code) |
| Demo hub (verified, interactive UI) | [`0xFd92139994CfbD99D54ac931AF5bd59C3DBD8f15`](https://coston2-explorer.flare.network/address/0xFd92139994CfbD99D54ac931AF5bd59C3DBD8f15#code) |
| DemoFXRP settlement token (verified) | [`0x59303814309229fc0c84Edad1e00852beB2E927F`](https://coston2-explorer.flare.network/address/0x59303814309229fc0c84Edad1e00852beB2E927F#code) |
| FTSOv2 feeds | FLR/USD `0x01464c522f5553…` + XRP/USD `0x015852502f5553…` via `ContractRegistry.getFtsoV2()`, freshness-bounded by `maxFeedAgeSeconds` |
| FDC | `FdcVerification.verifyWeb2Json` via `ContractRegistry`, source pinned to `erpUrlPrefix`, payout wallet bound to the attested `supplierWallet` |

| Lifecycle step (all real txs) | Explorer |
|---|---|
| **STRICT FDC path** — Web2Json attestation request to FdcHub | [tx](https://coston2-explorer.flare.network/tx/0xd8ee114deb28fe8af2810b146049baef422bc11df4304c1e9dd14b74897253b8) |
| **STRICT FDC path** — `registerInvoice` with `fdcEnforced=true` (Merkle proof verified on-chain, round 1385871) | [tx](https://coston2-explorer.flare.network/tx/0xcdf9e018410586baef0c2a162ca5fab0fde3babb0a8434eb081715eec3f3da22) |
| **STRICT FDC path** — funded at live FTSOv2 rate | [tx](https://coston2-explorer.flare.network/tx/0x26cab9f401835b99f8c580cd8b8d6f2a7a42a751efce271c228590f3ad0f5fd6) |
| **STRICT FDC path** — debtor settles at re-quoted rate | [tx](https://coston2-explorer.flare.network/tx/0xa08b2d48f3e7a41bce26c59234ad887bf82cc3f93eaff80427d892ee3aba27d6) |
| Demo hub: register + fund + attest (invoice A) | [reg](https://coston2-explorer.flare.network/tx/0xf4552fc2f569d3ab662accbdf27f917eaa6cb4b99a29e97571d13d2b29617f0d) · [fund](https://coston2-explorer.flare.network/tx/0x3f4d670e43b1bce3f82f5ae6dc869d456e4b457b55b2ebc3df7759387c6681e9) · [attest](https://coston2-explorer.flare.network/tx/0x4a7d10d18b6383882c7e80a34ea8379dbc3c2ba487805ab1b9e29ed48a60a8ef) |
| Settle in FLR (FTSOv2 re-quote at settlement) | [tx](https://coston2-explorer.flare.network/tx/0x3459cd05d6233e07fdafef9e9893320d88283351ba7c51553ee3f283dc7a75eb) |
| **Settle in FXRP** (XRP/USD feed — interoperable leg) | [tx](https://coston2-explorer.flare.network/tx/0x61903de99db379f3a09f3ae8439207028de03a7c7eb3031d31e5fdb6d86d9ef7) |
| **Strict FDC → FXRP combined** (demo hub, round 1385898): AI underwrote the attested system-of-record facts, Merkle-verified registration, FTSOv2 funding, FXRP settlement | [req](https://coston2-explorer.flare.network/tx/0xd5f8568fb9e2a3a13e8184457b234b18278968473fed36bbcb4926ee68905074) · [reg](https://coston2-explorer.flare.network/tx/0xbc9598753719a54471ce46128a1043eb66b338044d4846e9fa67a8ae0f20e406) · [fund](https://coston2-explorer.flare.network/tx/0x00e8bfbb8aed4a4d61d5ba6bb1c920711f09781583be4d827a4422e5d54f803e) · [settle](https://coston2-explorer.flare.network/tx/0x5df19033a42b1a129a6f027c1d6446cd9e15ff1c0b051981cc0394e6e54ba259) |
| Autonomous default write-off (collector) | [tx](https://coston2-explorer.flare.network/tx/0xf282e2abf4dcc3a3858ef7913457a62d7b90e529d5d4f977069aab25401798b2) |
| AI rejection memo anchored on-chain | [tx](https://coston2-explorer.flare.network/tx/0x5d40e49bc39c42e722f362fd5bb5a6bbcc35debb9a26692779f09e4b2b5b410f) |

The `$1.00 → FLR` and `$1.00 → FXRP` quotes are readable directly on the
verified contract: `quoteUsdCentsInFlrWei(100)` / `quoteUsdCentsInToken(100)`
under *Read Contract* on the explorer.

## The problem

Small businesses sell on 30–90 day terms and wait months to get paid. Invoice
factoring fixes the cash-flow gap, but it is slow, opaque, manual, and gated by
human underwriters. Meanwhile ~$3T of trade receivables sit off-chain, illiquid,
priced by nobody.

Two hard sub-problems have kept receivables off-chain:

1. **Provenance** — a smart contract cannot trust that an invoice is real. Any
   agent could invent a receivable and drain a pool.
2. **Pricing & FX** — invoices are denominated in fiat (USD/EUR); an on-chain
   pool holds volatile crypto. Someone has to price the conversion at funding
   *and* at settlement, trustlessly.

Faktura solves both **with Flare's enshrined data protocols**, and puts an
autonomous AI agent in the underwriter's seat — bounded by an on-chain policy
envelope. See [`docs/why-flare.md`](docs/why-flare.md) for what breaks without
FDC/FTSOv2.

## How Faktura uses Flare (the integration is the point)

| Flare protocol | Where it is load-bearing |
|---|---|
| **FDC — Web2Json** | `registerInvoice` is **gated by an FDC attestation**: the invoice's facts (number, debtor, amount, due date, doc hash) must be provably read from the supplier's system of record, Merkle-verified on-chain via `FdcVerification.verifyWeb2Json`. The contract additionally **pins the source URL prefix** (`erpUrlPrefix`) and **pays advances only to the attested `supplierWallet`** — a stolen agent key can neither attest its own endpoint nor redirect funding. |
| **FTSOv2 — FLR/USD** | The pool holds native FLR; invoices are USD. `fundInvoice` converts the USD advance → FLR at the live feed the moment it pays the supplier; `settleInvoice` re-quotes at the **current** feed so FX drift lands in the pool's share price, never in an unpriced position. |
| **FTSOv2 — XRP/USD** | The **interoperable settlement leg**: `settleInvoiceInToken` lets the debtor pay the USD face value in **FXRP** at the live XRP/USD rate; the pool's FXRP reserve is marked to market inside `poolValue()` through both feeds. (Hackathon scope: a mark-to-market reserve; production adds reserve rebalancing / LP redemption across FLR/FXRP.) |

Neither protocol is decorative: remove FTSOv2 and the pool cannot price a
single funding; remove FDC and the registry is an honor system.

## The autonomous agent — LLM proposes, code disposes (twice)

- **Underwriter agent** — deterministic pre-checks → LLM risk/price opinion →
  off-chain policy clamps → **on-chain `riskPolicy` envelope** (max risk score,
  discount band, tenor cap, per-invoice exposure cap — all admin-set and
  contract-enforced, with every FTSOv2 read bounded by `maxFeedAgeSeconds`) → FDC-gated registration, FTSOv2-priced funding → the
  **sha256 of the full decision memo anchored on-chain**. Approvals *and*
  rejections are attested; the memo bytes behind every hash are persisted and
  served (`GET /api/memos/:hash`), so the audit trail is *recomputable*.
- **Collector agent** — reconciles settlements, autonomously writes off
  invoices past due + grace (contract enforces the grace period).
- **Risk oracle** — every underwriting is sold to other agents over an
  **x402-inspired HTTP 402 flow settled in native FLR** (machine-to-machine,
  pay-per-call; the PaymentRequirements shape of x402, Flare-native
  settlement — not the Coinbase EIP-3009 scheme).

A compromised agent key **cannot** invent receivables (FDC + URL pinning),
redirect advances (attested `supplierWallet`), price outside the envelope
(`PolicyViolation`), overexpose the pool (`ExposureCapExceeded`), or touch LP
balances. See [`SECURITY.md`](SECURITY.md).

## Architecture

```
   Supplier ERP (system of record)          docs/erp/*.json · /erp/invoices/:n
        │  public HTTPS JSON
        ▼
┌─────────────────────────────┐   Merkle proof   ┌──────────────────────────┐
│ FDC Web2Json verifier set   │ ───────────────▶ │        DA layer           │
│ (attestation providers)     │   voting round   │  proof-by-request-round   │
└─────────────────────────────┘                  └────────────┬─────────────┘
                                                              │
  intake      ┌───────────────────────────────┐   proof       │
 (USD invoice)│      Underwriter agent        │◀──────────────┘
  Web UI ────▶│ pre-checks → LLM → policy     │
      ▲       │ → register → fund → attest    │ ethers v6
      │ SSE   └───────────┬───────────────────┘
      │                   ▼
┌──────────┐   ┌───────────────────────────────────────────────┐
│Collector │──▶│              FakturaHub (Solidity)             │
└──────────┘   │ FDC-gated RWA registry · on-chain riskPolicy   │
┌──────────┐   │ FLR pool + FXRP reserve · attestation log      │
│x402 buyer│──▶│ ├─ ContractRegistry.getFtsoV2() ─▶ FLR/USD +   │
└──────────┘   │ │                                  XRP/USD     │
               │ └─ getFdcVerification() ─▶ verifyWeb2Json      │
               └───────────────────────────────────────────────┘
                                Coston2 testnet
```

Details: [`docs/architecture.md`](docs/architecture.md).

## Provenance of this project (what's new here)

Faktura started life as our prototype of an autonomous factoring desk on
another chain (Casper, spring 2026) — that prototype proved the product idea
but had **no trustless answer for invoice provenance or FX**. This submission
is the **ground-up Flare port built during Flare Summer Signal**, and the
Flare parts are the point:

- `FakturaHub.sol` — new Solidity hub: FDC-gated registry with source-URL
  pinning, on-chain risk-policy envelope, FTSOv2 dual-feed pricing (FLR/USD +
  XRP/USD), native-FLR LP pool with share-price yield, FXRP settlement
  reserve, and the on-chain AI-attestation log.
- The **real FDC Web2Json pipeline**: `contracts/scripts/registerViaFdc.ts`
  and the agent's strict mode drive verifier → FdcHub → voting-round
  finalization → DA-layer Merkle proof → on-chain verification, end to end.
- Agents rewritten for Flare (ethers v6 / Coston2): underwriter + collector +
  x402-inspired oracle, byte-exact decision-memo persistence.
- React operations dashboard, hosted read-only showcase mode, e2e runbooks.

## Run it

```bash
# 0. prerequisites: Node 20+ (CI runs 22), a funded Coston2 key (https://faucet.flare.network/coston2)
cp .env.example .env             # then create keys/{agent,investor,debtor}.key
                                 # (0x-prefixed private keys; agent = deployer/admin)

# 1. contracts — 14 Hardhat tests, then deploy hub + DemoFXRP
cd contracts && npm install && npm test
npm run deploy:coston2           # run twice: evidence hub + demo hub; put the
                                 # addresses in .env (FAKTURA_EVIDENCE_CONTRACT /
                                 # FAKTURA_CONTRACT) + FAKTURA_FXRP

# 2. web + agent service
cd ../web && npm install && npm run build
cd ../agents && npm install && npm start          # http://localhost:4020

# 3. the whole lifecycle on live Coston2, no UI needed (~6 min incl. default wait)
npm run e2e                      # demo mode: 4 invoices — fund/settle-FLR/
                                 # reject/default/settle-FXRP + attestations

# 4. THE STRICT FDC PATH — a real Web2Json attestation end to end (~4 min)
cd ../contracts && npm run fdc:register
#    verifier prepareRequest → FdcHub (fee) → voting round finalized →
#    DA-layer Merkle proof → registerInvoice with fdcEnforced=true
FAKTURA_FDC=strict npm run e2e   # (from agents/) same, via the agent pipeline
```

**Demo mode vs strict mode — two-address posture.** Strict runs route to the
**evidence hub** (`FAKTURA_EVIDENCE_CONTRACT`), which is permanently
`fdcEnforced=true`; the tooling hard-refuses to run demo mode against it.
Demo mode (`FAKTURA_FDC=demo`, the interactive UI) targets the **demo hub**
and flips its `fdcEnforced` flag off for instant registrations — an
interaction accelerator, not the proof path (admin-only, publicly-evented,
restored after runs). The evidence table at the top links the strict path.

**Testnet scaling.** Coston2 FLR ≈ $0.007, so the faucet-funded demo pool backs
deliberately small USD invoices. The contract logic is scale-independent —
mainnet FLR/FXRP liquidity handles production-size receivables unchanged.

**Settlement headroom.** Demo settlements send the FTSOv2 quote plus ~1–2%
headroom so rate drift between quoting and inclusion cannot underpay;
`settleInvoice` keeps any overpayment, which accrues to LPs as yield (stated
on-chain in the `InvoiceSettled` event's yield field).

## The system of record (Web2Json source)

Strict-mode attestations read canonical invoice JSON from
`docs/erp/*.json`, served with `Content-Type: application/json` by GitHub
Pages at `https://a252937166.github.io/faktura/erp/{number}.json` — the same
prefix pinned on-chain via `erpUrlPrefix`. The agent service also serves the
identical shape at `GET /erp/invoices/:number`, so a publicly hosted
deployment is its own attestable system of record
(`FAKTURA_ERP_URL_TEMPLATE`). Each document embeds `documentSha256` — the
sha256 of the raw invoice text — which becomes the on-chain dedupe key.

## Verify an AI decision yourself

```bash
# pick any decisionHash / attestation payloadHash from the explorer, then:
curl -s localhost:4020/api/memos/{sha256-hex} | shasum -a 256
# → equals the on-chain hash. docs/samples/ contains a committed example.
```

## Repository map

| Path | What it is |
|---|---|
| `contracts/` | `FakturaHub.sol` + mocks, 14 Hardhat tests, deploy / strict-FDC scripts |
| `agents/` | underwriter · collector · x402-inspired oracle · FDC Web2Json client · ERP facade (TypeScript, ethers v6) |
| `web/` | React operations dashboard (Vite, SSE live feed) |
| `docs/` | [`judges.md`](docs/judges.md) · [`architecture.md`](docs/architecture.md) · [`why-flare.md`](docs/why-flare.md) · `erp/` system-of-record docs |
| [`SECURITY.md`](SECURITY.md) | trust boundaries, key powers, known testnet limitations |
| `.github/workflows/ci.yml` | contracts tests · agents typecheck · web build |

## Roadmap

FXRP as LP collateral and USD₮0 settlement; treasury conversion of the FXRP
reserve under governance; enterprise KYB registry binding for suppliers and
debtors (wallet-level binding to the FDC-attested `supplierWallet` already
ships — see above); a Confidential Compute variant (Bounty 2) that underwrites
without exposing debtor PII; ERP connectors (Xero/QuickBooks export → signed
system-of-record endpoint).

## License

MIT.
