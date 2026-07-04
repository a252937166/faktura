# Faktura — architecture

## Lifecycle sequence

```mermaid
sequenceDiagram
    autonumber
    participant S as Supplier
    participant UI as Web UI
    participant U as Underwriter agent
    participant L as LLM (Claude)
    participant FDC as Flare Data Connector
    participant H as FakturaHub (Coston2)
    participant FTSO as FTSOv2
    participant D as Debtor
    participant C as Collector agent

    S->>UI: submit USD invoice
    UI->>U: POST /api/invoices
    U->>U: deterministic pre-checks (amount, tenor, dup)
    U->>L: score risk + price discount
    L-->>U: {approve, riskScore, discountBps, rationale}
    U->>U: policy guardrails (risk ceiling, clamp, exposure cap)
    Note over U,FDC: strict mode: prepare Web2Json attestation of invoice facts
    U->>H: registerInvoice(proof, supplier, risk, discount, memoHash)
    H->>FDC: verifyWeb2Json(proof)
    FDC-->>H: valid ✓  (facts decoded on-chain)
    U->>H: fundInvoice(id)
    H->>FTSO: getFeedById(FLR/USD)
    FTSO-->>H: live rate
    H->>S: transfer FLR advance (USD→FLR at live rate)
    U->>H: attest(UNDERWRITE_APPROVE, memoHash)

    D->>H: settleInvoice(id) + FLR
    H->>FTSO: getFeedById(FLR/USD)
    FTSO-->>H: live rate (re-quote)
    Note over H: face USD → FLR at settlement time; surplus = pool yield

    C->>H: (poll) listInvoices
    alt overdue past grace
        C->>H: markDefault(id)
        Note over H: advance written off; loss hits LP share price
    end
```

## On-chain data model (`FakturaHub.sol`)

- **Roles**: `admin`, `agent` (underwriter), `collector`. Rotatable by admin.
- **Invoice**: `{id, supplier, invoiceNumber, debtorTag, docHash, faceUsdCents,
  dueTs, riskScore, discountBps, decisionHash, state, advanceFlrWei,
  fundRate…, settledFlrWei, timestamps}`. State machine:
  `Listed → Funded → (Settled | Defaulted)`.
- **On-chain risk policy** (`riskPolicy`, admin-set, evented):
  `{maxRiskScore, minDiscountBps, maxDiscountBps, maxAdvanceBpsOfLiquid,
  maxTenorSeconds}`. `registerInvoice` reverts on any pricing outside the
  envelope (`PolicyViolation`); `fundInvoice` reverts past the per-invoice
  exposure cap (`ExposureCapExceeded`). The agent's discretion is bounded by
  the contract, not by off-chain promises.
- **Source pinning**: with FDC enforcement on, the attested request URL must
  start with `erpUrlPrefix` (the supplier system of record), else
  `UntrustedSource` — a stolen agent key cannot attest its own endpoint.
- **Liquidity pool** (native FLR): `deposit()` mints LP shares at the current
  share price; `withdraw()` burns them against liquid capital only. Yield and
  losses accrue to **share price** = `poolValue / totalShares`, so LPs who
  entered earlier capture the spread.
- **Interoperable settlement leg**: `settleInvoiceInToken` lets the debtor pay
  the USD face value in the configured ERC-20 (FXRP on the demo) at the live
  XRP/USD FTSOv2 rate; the pool accumulates `settlementTokenReserve`, marked
  to market inside `poolValue()` through both feeds.
- **Attestations**: append-only log of `{actor, kind, subjectId, payloadHash,
  model, ts}` — the hash-anchored audit trail of every AI decision. The agent
  persists every memo byte-exact (`agents/data/memos/`, served at
  `GET /api/memos/:hash`), so `sha256(file) == payloadHash` is checkable.

## USD ↔ FLR conversion

```
flrWei = usdCents · 1e16 · 10^decimals / ftsoRate
```

where `(ftsoRate, decimals)` come from `FtsoV2.getFeedById(FLR/USD)`. Applied at
**funding** (advance) and again at **settlement** (face value), so the protocol
never carries an unpriced FX position.

## Trust & safety model

- The **LLM proposes; deterministic Solidity + policy code disposes.** No agent
  output is trusted unchecked: the risk ceiling, discount band, tenor cap and
  pool-exposure cap are enforced twice — off-chain in the policy gate and
  **on-chain in `riskPolicy`** inside `registerInvoice` / `fundInvoice`.
- **Provenance** is enforced by FDC — an invoice that can't be attested from
  the pinned system of record (`erpUrlPrefix`) can't be registered while
  enforcement is on.
- **Every** autonomous decision (approve *and* reject) is hash-anchored via
  `attest(...)`, and the memo bytes behind each hash are persisted and served,
  so the audit trail is recomputable, not just visible.
- Access control on every mutating entrypoint; custom errors for every revert.

See [`SECURITY.md`](../SECURITY.md) for the full trust-boundary table and
known testnet limitations, and [`why-flare.md`](why-flare.md) for what breaks
without FDC/FTSOv2.

## Components

| Path | Role |
|---|---|
| `contracts/contracts/FakturaHub.sol` | the hub (FDC-gated registry + FLR pool + FXRP settlement leg + on-chain risk policy + attestations) |
| `contracts/scripts/deploy.ts` | resolves FTSOv2 + FdcVerification via `ContractRegistry`, deploys hub + DemoFXRP |
| `contracts/scripts/registerViaFdc.ts` | **strict path**: real Web2Json attestation → FdcHub → DA-layer Merkle proof → `registerInvoice` with `fdcEnforced=true` |
| `agents/src/underwriter.ts` | intake → LLM → policy → (strict: real FDC proof) → register/fund/attest, memos persisted byte-exact |
| `agents/src/fdc.ts` | Web2Json client: demo encoding + the full attestation flow (verifier / FdcHub / Relay / DA layer) |
| `agents/src/erp.ts` + `docs/erp/` | supplier system-of-record: canonical invoice JSON served at `/erp/invoices/:number` (the Web2Json source) |
| `agents/src/collector.ts` | settlement reconciliation + autonomous default |
| `agents/src/x402.ts` | x402-inspired HTTP-402 machine-payable risk oracle (Flare-native settlement) |
| `agents/src/chain.ts` | ethers v6 binding + per-persona nonce queues |
| `agents/src/llm.ts` | pluggable underwriting model (Anthropic / DeepSeek / CLI / deterministic fallback) |
| `agents/src/capture-seed.ts` | snapshots live chain + records into the hosted read-only showcase seed |
| `web/` | React operations dashboard (live SSE feed) |
```
