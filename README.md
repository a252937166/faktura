# Faktura — the autonomous invoice-financing desk on Flare

> Real-world receivables, underwritten by an autonomous AI agent, financed by
> an on-chain liquidity pool, priced live by **FTSOv2** (FLR/USD *and*
> XRP/USD), provenance-gated by the **Flare Data Connector (FDC)** — and every
> autonomous decision hash-anchored on-chain.

**Flare Summer Signal** submission · Bounty 1 (Interoperable Asset Products) ·
Live on **Coston2**: [`FakturaHub 0xe7Fb9d…cc58`](https://coston2-explorer.flare.network/address/0xe7Fb9db07C3a34A3Ae3a3398Cb70AA9D1e57cc58) (verified source)

**Judges: [`docs/judges.md`](docs/judges.md) is the 3-minute evaluation path.**

---

## Live deployment & on-chain evidence

Everything below is a real Coston2 transaction — no judge should have to hunt
for proof.

| | |
|---|---|
| Network | Flare **Coston2** (chainId 114) |
| FakturaHub (verified) | [`0xe7Fb9db07C3a34A3Ae3a3398Cb70AA9D1e57cc58`](https://coston2-explorer.flare.network/address/0xe7Fb9db07C3a34A3Ae3a3398Cb70AA9D1e57cc58#code) |
| DemoFXRP settlement token (verified) | [`0xDD5031f596430C0956D22B9aC724B6f119581549`](https://coston2-explorer.flare.network/address/0xDD5031f596430C0956D22B9aC724B6f119581549#code) |
| FTSOv2 feeds | FLR/USD `0x01464c522f5553…` + XRP/USD `0x015852502f5553…` via `ContractRegistry.getFtsoV2()` |
| FDC | `FdcVerification.verifyWeb2Json` via `ContractRegistry` |

| Lifecycle step (all real txs) | Explorer |
|---|---|
| **STRICT FDC path** — Web2Json attestation request to FdcHub | [tx](https://coston2-explorer.flare.network/tx/0x56798765dc617acf90493fa94bb0a5cb26c40d191df3ad0b142d96dfd1d5d822) |
| **STRICT FDC path** — `registerInvoice` with `fdcEnforced=true` (Merkle proof verified on-chain, round 1385845) | [tx](https://coston2-explorer.flare.network/tx/0xe63934cab7809e23f746882a5c14f9b7e86d4c5304dd78352605b59505813491) |
| **STRICT FDC path** — funded at live FTSOv2 rate | [tx](https://coston2-explorer.flare.network/tx/0x9ba38dc9a788ae7022da7da80b10631e0c07258ddf2895a328cea76ccf7c19ea) |
| **STRICT FDC path** — debtor settles at re-quoted rate | [tx](https://coston2-explorer.flare.network/tx/0xdbce9d38f7492774afcafb43832492d6aa044c0a7be05ce2f0f7f626dba3f202) |
| Demo-mode register + fund + attest (invoice A) | [reg](https://coston2-explorer.flare.network/tx/0x0236eef409a1126b572dd0ece178fba878b80ef121149ce512be45107fb27f66) · [fund](https://coston2-explorer.flare.network/tx/0x2bc7d26f8f952885971f54d98d609cf3c472cb00e89e14437c5342b251c01cd7) · [attest](https://coston2-explorer.flare.network/tx/0x97c66d15e8888bddf04503b2e5c20aceaca1eb25622ffd65bfb9e4ff6db4ddb8) |
| Settle in FLR (FTSOv2 re-quote at settlement) | [tx](https://coston2-explorer.flare.network/tx/0xe62f6ede47b840ab239bfc926a3fc35cbb8149138cc59d7644cfa0b927bea211) |
| **Settle in FXRP** (XRP/USD feed — interoperable leg) | [tx](https://coston2-explorer.flare.network/tx/0x3d476ad3207636d61079a050c0c8038272ef5c33e839567fa033d0bef31341aa) |
| Autonomous default write-off (collector) | [tx](https://coston2-explorer.flare.network/tx/0xd3b16fd93387285df8934f528022df8b2022cf5d6f8ec8d2be195a95ad55609d) |
| AI rejection memo anchored on-chain | [tx](https://coston2-explorer.flare.network/tx/0x1a13f521982fe03e4521a680046619c2185e986ac74d61ea21f91d960e0b36ca) |

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
| **FDC — Web2Json** | `registerInvoice` is **gated by an FDC attestation**: the invoice's facts (number, debtor, amount, due date, doc hash) must be provably read from the supplier's system of record, Merkle-verified on-chain via `FdcVerification.verifyWeb2Json`. The contract additionally **pins the source URL prefix** (`erpUrlPrefix`) — even a stolen agent key cannot attest documents from its own endpoint. |
| **FTSOv2 — FLR/USD** | The pool holds native FLR; invoices are USD. `fundInvoice` converts the USD advance → FLR at the live feed the moment it pays the supplier; `settleInvoice` re-quotes at the **current** feed so FX drift lands in the pool's share price, never in an unpriced position. |
| **FTSOv2 — XRP/USD** | The **interoperable settlement leg**: `settleInvoiceInToken` lets the debtor pay the USD face value in **FXRP** at the live XRP/USD rate; the pool's FXRP reserve is marked to market inside `poolValue()` through both feeds. |

Neither protocol is decorative: remove FTSOv2 and the pool cannot price a
single funding; remove FDC and the registry is an honor system.

## The autonomous agent — LLM proposes, code disposes (twice)

- **Underwriter agent** — deterministic pre-checks → LLM risk/price opinion →
  off-chain policy clamps → **on-chain `riskPolicy` envelope** (max risk score,
  discount band, tenor cap, per-invoice exposure cap — all admin-set and
  contract-enforced) → FDC-gated registration, FTSOv2-priced funding → the
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
price outside the envelope (`PolicyViolation`), overexpose the pool
(`ExposureCapExceeded`), or touch LP balances. See [`SECURITY.md`](SECURITY.md).

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
# 0. prerequisites: Node 20+, a funded Coston2 key (https://faucet.flare.network/coston2)
cp .env.example .env             # then create keys/{agent,investor,debtor}.key
                                 # (0x-prefixed private keys; agent = deployer/admin)

# 1. contracts — 12 Hardhat tests, then deploy hub + DemoFXRP
cd contracts && npm install && npm test
npm run deploy:coston2           # prints FAKTURA_CONTRACT + FAKTURA_FXRP → put in .env

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

**Demo mode vs strict mode.** Demo mode (`FAKTURA_FDC=demo`, default for the
interactive UI) flips the on-chain `fdcEnforced` flag off so registrations are
instant — an **interaction accelerator, not the proof path** (the flip is an
admin-only, publicly-evented action, and e2e restores enforcement when done).
The strict path above is the real thing and is what the evidence table at the
top links to.

**Testnet scaling.** Coston2 FLR ≈ $0.007, so the faucet-funded demo pool backs
deliberately small USD invoices. The contract logic is scale-independent —
mainnet FLR/FXRP liquidity handles production-size receivables unchanged.

## The system of record (Web2Json source)

Strict-mode attestations read canonical invoice JSON from
`docs/erp/*.json`, served with `Content-Type: application/json` by GitHub
Pages at `https://a252937166.github.io/faktura/erp/<number>.json` — the same
prefix pinned on-chain via `erpUrlPrefix`. The agent service also serves the
identical shape at `GET /erp/invoices/:number`, so a publicly hosted
deployment is its own attestable system of record
(`FAKTURA_ERP_URL_TEMPLATE`). Each document embeds `documentSha256` — the
sha256 of the raw invoice text — which becomes the on-chain dedupe key.

## Verify an AI decision yourself

```bash
# pick any decisionHash / attestation payloadHash from the explorer, then:
curl -s localhost:4020/api/memos/<sha256-hex> | shasum -a 256
# → equals the on-chain hash. docs/samples/ contains a committed example.
```

## Repository map

| Path | What it is |
|---|---|
| `contracts/` | `FakturaHub.sol` + mocks, 12 Hardhat tests, deploy / strict-FDC scripts |
| `agents/` | underwriter · collector · x402-inspired oracle · FDC Web2Json client · ERP facade (TypeScript, ethers v6) |
| `web/` | React operations dashboard (Vite, SSE live feed) |
| `docs/` | [`judges.md`](docs/judges.md) · [`architecture.md`](docs/architecture.md) · [`why-flare.md`](docs/why-flare.md) · `erp/` system-of-record docs |
| [`SECURITY.md`](SECURITY.md) | trust boundaries, key powers, known testnet limitations |
| `.github/workflows/ci.yml` | contracts tests · agents typecheck · web build |

## Roadmap

FXRP as LP collateral and USD₮0 settlement; treasury conversion of the FXRP
reserve under governance; supplier identity binding (advances only to attested
beneficiaries); a Confidential Compute variant (Bounty 2) that underwrites
without exposing debtor PII; ERP connectors (Xero/QuickBooks export → signed
system-of-record endpoint).

## License

MIT.
