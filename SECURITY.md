# Security model & known limitations

Faktura is a **Coston2 testnet** hackathon build. This page states plainly
what is enforced, where the trust boundaries sit, and what a production
deployment would harden. No security through vagueness.

## Trust boundaries

| Actor / key | Can do | Cannot do |
|---|---|---|
| **Agent key** (underwriter) | `registerInvoice`, `fundInvoice`, `attest` | Invent receivables while FDC enforcement is on — registration requires a valid Web2Json Merkle proof, and with `erpUrlPrefix` set the attested document must come from the pinned system of record. Cannot price outside the on-chain `riskPolicy` envelope (max risk score, discount band, tenor cap), cannot fund past the per-invoice exposure cap, cannot touch LP balances or withdraw pool capital. |
| **Collector key** | `markDefault`, `attest` | Default an invoice before `dueTs + graceSeconds` (contract-enforced). |
| **Admin key** | Rotate agent/collector, set `riskPolicy`, toggle `fdcEnforced`, pin `erpUrlPrefix`, configure the settlement token | Move pool funds directly. Admin powers are visible: every toggle emits an event. |
| **LP (anyone)** | `deposit`, `withdraw` against liquid capital | Withdraw capital that is deployed in funded invoices. |
| **Debtor (anyone)** | `settleInvoice` (FLR) / `settleInvoiceInToken` (FXRP) at the live FTSOv2 quote | Underpay: settlement below the oracle quote reverts. |

**"LLM proposes, code disposes" is enforced twice.** The agent service clamps
model output off-chain (policy gate), and the contract independently enforces
`riskPolicy` + the exposure cap + FDC provenance on-chain. A compromised or
hallucinating agent is bounded by the second layer: worst case it can finance
*attestable, policy-conforming* invoices badly — bounded per invoice by
`maxAdvanceBpsOfLiquid` — not drain the pool or fabricate receivables.

## FDC demo mode — what it is and is not

- `fdcEnforced` is an **admin-only, evented** on-chain flag. Strict mode
  (`FAKTURA_FDC=strict`) is the real path: Web2Json attestation → voting-round
  finalization → DA-layer Merkle proof → on-chain `verifyWeb2Json`.
- Demo mode exists so a judge can click through the interactive demo without
  waiting ~4 minutes per registration. It skips only Merkle verification; the
  facts still travel ABI-encoded exactly as the attested response would carry
  them. **Demo mode is an interaction accelerator, not the proof path**, and
  every enforcement toggle is a public on-chain event (`FdcEnforcementSet`).
- Production posture: `fdcEnforced = true` permanently; drop the toggle or
  move it behind a timelock.

## Known limitations (testnet honesty)

1. **Admin is an EOA.** Production wants a multisig + timelock for policy
   changes, agent rotation and the FDC toggle.
2. **The FXRP reserve is held, not swapped.** Token settlements accumulate in
   `settlementTokenReserve`, valued in `poolValue()` through FTSOv2 (XRP/USD ×
   FLR/USD). LP withdrawals pay native FLR only, so heavy token settlement can
   make share value temporarily illiquid. Production adds a treasury
   conversion path (e.g. FAssets redemption or DEX swap) under governance.
3. **Oracle staleness.** Rates are read from FTSOv2 block-latest feeds;
   the contract rejects zero/absurd values but does not yet bound feed age.
4. **Supplier identity is an address parameter** supplied by the agent at
   registration; binding suppliers to verified ERP identities (and paying
   advances only to attested beneficiaries) is roadmap.
5. **x402-inspired, not x402-compliant.** The HTTP 402 oracle borrows the
   PaymentRequirements shape but settles in native FLR with a
   tx-hash-as-receipt proof, not the Coinbase EIP-3009 scheme.
6. **Demo keys in `keys/*.key`** are throwaway Coston2 faucet accounts used by
   the runbook; they hold no real value and are gitignored. Never reuse them
   for anything real.

## Reporting

This is a hackathon repository; file issues on GitHub. Do not send real funds
to any address in this repo.
