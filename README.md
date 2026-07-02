# Faktura — the autonomous invoice-financing desk on Flare

> Real-world receivables, underwritten by an AI agent, financed by an on-chain
> liquidity pool, priced live by the **FTSOv2** oracle, and gated by the
> **Flare Data Connector (FDC)** — every autonomous decision anchored on-chain.

**Flare Summer Signal** submission · Bounty 1 (Interoperable Asset Products) ·
Deployed on **Coston2**: [`0xa24440A8995aBdff1647e06670DDdc43C9cE6B6c`](https://coston2-explorer.flare.network/address/0xa24440A8995aBdff1647e06670DDdc43C9cE6B6c)

---

## The problem

Small businesses sell on 30–90 day terms and wait months to get paid. Invoice
factoring fixes the cash-flow gap, but it is slow, opaque, manual, and gated by
human underwriters. Meanwhile ~$3T of trade receivables sit off-chain, illiquid,
priced by nobody.

Two hard sub-problems have kept receivables off-chain:

1. **Provenance** — a smart contract cannot trust that an invoice is real. Any
   agent could invent a receivable and drain a pool.
2. **Pricing & FX** — invoices are denominated in fiat (USD/EUR); an on-chain
   pool holds a volatile native token. Someone has to price the conversion at
   funding *and* at settlement, trustlessly.

Faktura solves both **using Flare's enshrined data protocols**, and puts an
autonomous AI agent in the underwriter's seat.

## How Faktura uses Flare (the integration is the point)

| Flare protocol | Where it is load-bearing in Faktura |
|---|---|
| **FDC — Web2Json** | `registerInvoice` is **gated by an FDC attestation**. The invoice's facts (number, debtor, amount, due date, doc hash) must be provably read from the supplier's system-of-record via `IWeb2Json.verifyWeb2Json(proof)`. The agent cannot invent a receivable — the chain checks its provenance. |
| **FTSOv2** | The pool holds native FLR; invoices are denominated in USD. `fundInvoice` converts the USD advance → FLR at the **live FTSOv2 FLR/USD feed** the moment it pays the supplier; `settleInvoice` re-quotes at the **current** feed so the debtor pays the correct FLR for the USD face value. FX risk is handled by the oracle, on-chain, every time. |

Neither is decorative: remove FTSO and the pool can't price a funding; remove
FDC and the registry has no provenance guarantee. Both are read through the
official `@flarenetwork/flare-periphery-contracts` `ContractRegistry`.

## The autonomous agent

Faktura is an **agentic** system, not a form with a chatbot. Three roles run
without a human in the loop:

- **Underwriter agent** — on each intake it runs deterministic pre-checks →
  asks an LLM (Claude) for a risk score + price → applies hard policy
  guardrails (risk ceiling, discount clamp, pool-exposure cap) → registers the
  invoice through FDC, funds it at the FTSO rate, and **anchors the SHA-256 of
  its full decision memo on-chain**. The LLM *proposes*; deterministic code
  *disposes*. Approvals and rejections are both attested.
- **Collector agent** — polls funded invoices, reconciles settlements observed
  on-chain, and **autonomously writes off** invoices past due + grace.
- **x402 risk oracle** — every underwriting produces a verified risk report,
  sold to other agents over **HTTP 402** with native-FLR settlement (machine-
  to-machine, pay-per-call).

Every state transition is a real Coston2 transaction. Every AI decision leaves
an on-chain, hash-anchored audit trail — you can prove *why* the autonomous
system did what it did.

## Architecture

```
                          ┌─────────────────────────────────────────────┐
   Supplier ERP  ──HTTP──▶│  FDC Web2Json verifier  (Flare Data Connector)│
   (system of record)     └───────────────────────┬─────────────────────┘
                                                   │ Merkle proof
                    intake                         ▼
  ┌──────────┐   (USD invoice)   ┌───────────────────────────────┐
  │  Web UI   │ ────────────────▶ │      Underwriter agent         │
  │ (React)   │ ◀── SSE feed ──── │  pre-checks → LLM → policy     │
  └──────────┘                    │  → register → fund → attest    │
        ▲                         └───────────┬───────────────────┘
        │ REST                                │ ethers v6
        │                                     ▼
  ┌──────────┐   FLR pool     ┌───────────────────────────────────────────┐
  │Collector │───────────────▶│           FakturaHub  (Solidity)           │
  │  agent   │  default/settle│  RWA registry · FLR pool · attestations    │
  └──────────┘                │  ├── ContractRegistry.getFtsoV2()  ────────┼─▶ FTSOv2 FLR/USD
  ┌──────────┐   HTTP 402     │  └── ContractRegistry.getFdcVerification() ┼─▶ FDC verify
  │x402 buyer│───────────────▶│                                            │
  └──────────┘  pay-per-call  └───────────────────────────────────────────┘
                                              Coston2 testnet
```

See [`docs/architecture.md`](docs/architecture.md) for the sequence diagram and
the full on-chain data model.

## What's newly built for this hackathon

Everything in this repository was built during Flare Summer Signal:

- `contracts/contracts/FakturaHub.sol` — the hub: FDC-gated RWA registry, an
  FTSO-priced FLR liquidity pool with an LP share-price yield model, an agent
  permission layer, and an on-chain AI-attestation log.
- `agents/` — the autonomous underwriter + collector + x402 oracle (TypeScript,
  ethers v6, pluggable LLM: Anthropic API / local `claude` CLI / deterministic
  fallback).
- `web/` — a live operations dashboard (React + Vite).
- 8 Hardhat tests, a live-network end-to-end script, and a real-FDC
  registration script.

## Run it

```bash
# 0. prerequisites: Node 20+, a funded Coston2 key (https://faucet.flare.network/coston2)
cp .env.example .env            # fill COSTON2 + keys, or use the bundled demo keys

# 1. contracts
cd contracts && npm install && npm test           # 8 passing
npm run deploy:coston2                             # prints FAKTURA_CONTRACT

# 2. agents + web
cd ../web && npm install && npm run build
cd ../agents && npm install && npm start           # http://localhost:4020

# 3. drive the whole lifecycle on live Coston2 (no UI needed)
npm run e2e
```

`npm run e2e` deposits into the pool, then underwrites three invoices — one
approved + funded + settled, one risk-rejected, one funded then defaulted —
all as real Coston2 transactions, and prints an explorer link.

## Live deployment

| | |
|---|---|
| Network | Flare **Coston2** (chainId 114) |
| FakturaHub | [`0xa24440…6B6c`](https://coston2-explorer.flare.network/address/0xa24440A8995aBdff1647e06670DDdc43C9cE6B6c) |
| FTSOv2 feed | FLR/USD `0x01464c522f5553440000…` |
| FDC | `FdcVerification` via `ContractRegistry` |

## Notes for judges

- **Testnet scaling.** Coston2 FLR is worth ≈ $0.0066, so faucet-funded demo
  pools can only back small USD invoices; `minFaceUsd` is lowered accordingly.
  The contract logic is scale-independent — mainnet FLR or an FXRP/USD₮ feed
  handles production-size receivables unchanged.
- **FDC demo mode.** For a fast interactive demo the agent flips the on-chain
  `fdcEnforced` flag off (invoice facts are still ABI-encoded exactly as the
  Web2Json response would deliver them). `scripts/registerViaFdc.ts` and
  `FAKTURA_FDC=strict` exercise the full attested path.
- **Roadmap.** FXRP receivables (FAssets) as collateral; a Confidential Compute
  variant (Bounty 2) that underwrites without exposing debtor PII on-chain;
  real supplier-ERP connectors for the Web2Json source.

## License

MIT.
