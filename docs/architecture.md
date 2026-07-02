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
- **Liquidity pool** (native FLR): `deposit()` mints LP shares at the current
  share price; `withdraw()` burns them against liquid capital only. Yield and
  losses accrue to **share price** = `poolValue / totalShares`, so LPs who
  entered earlier capture the spread.
- **Attestations**: append-only log of `{actor, kind, subjectId, payloadHash,
  model, ts}` — the hash-anchored audit trail of every AI decision.

## USD ↔ FLR conversion

```
flrWei = usdCents · 1e16 · 10^decimals / ftsoRate
```

where `(ftsoRate, decimals)` come from `FtsoV2.getFeedById(FLR/USD)`. Applied at
**funding** (advance) and again at **settlement** (face value), so the protocol
never carries an unpriced FX position.

## Trust & safety model

- The **LLM proposes; deterministic Solidity + policy code disposes.** No agent
  output is trusted unchecked: risk ceiling, discount clamp and pool-exposure
  cap are enforced off-chain in policy and on-chain in `registerInvoice` /
  `fundInvoice`.
- **Provenance** is enforced by FDC — an invoice that can't be attested from a
  real Web2 source can't be registered (strict mode).
- **Every** autonomous decision (approve *and* reject) is hash-anchored via
  `attest(...)`, so the system is auditable after the fact.
- Access control on every mutating entrypoint; custom errors for every revert.

## Components

| Path | Role |
|---|---|
| `contracts/contracts/FakturaHub.sol` | the hub (registry + pool + attestations) |
| `contracts/scripts/deploy.ts` | resolves FTSOv2 + FdcVerification via `ContractRegistry`, deploys |
| `agents/src/underwriter.ts` | intake → LLM → policy → register/fund/attest |
| `agents/src/collector.ts` | settlement reconciliation + autonomous default |
| `agents/src/x402.ts` | HTTP-402 machine-payable risk oracle (native FLR settlement) |
| `agents/src/chain.ts` | ethers v6 binding + per-persona nonce queues |
| `agents/src/llm.ts` | pluggable underwriting model (Anthropic / CLI / fallback) |
| `web/` | React operations dashboard (live SSE feed) |
```
