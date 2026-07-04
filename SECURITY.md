# Security model & known limitations

Faktura is a **Coston2 testnet** hackathon build. This page states plainly
what is enforced, where the trust boundaries sit, and what a production
deployment would harden. No security through vagueness.

## Trust boundaries

| Actor / key | Can do | Cannot do |
|---|---|---|
| **Agent key** (underwriter) | `registerInvoice`, `fundInvoice`, `attest` | Invent receivables while FDC enforcement is on — registration requires a valid Web2Json Merkle proof, and with `erpUrlPrefix` set the attested document must come from the pinned system of record. Cannot **redirect advances**: while enforcement is on the payout wallet is the attested `supplierWallet` fact from the system of record, not a call parameter. Cannot price outside the on-chain `riskPolicy` envelope (max risk score, discount band, tenor cap), cannot fund past the per-invoice exposure cap, cannot touch LP balances or withdraw pool capital. |
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

## Two-address posture

The deployment runs **two hubs from the same verified source**:

- the **EVIDENCE hub** is permanently strict — `fdcEnforced = true` from
  genesis and never demoted. The agent tooling hard-refuses to run demo mode
  against it (`server.ts` exits, `e2e` throws). Judge the FDC claims there.
- the **DEMO hub** backs the interactive UI, where demo mode may toggle
  enforcement for instant registrations (evented, restored after runs).

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
2. **The FXRP settlement leg is a mark-to-market reserve, not full
   multi-asset ALM.** Token settlements accumulate in
   `settlementTokenReserve`, valued in `poolValue()` through FTSOv2 (XRP/USD ×
   FLR/USD). LP withdrawals pay native FLR only, so heavy token settlement can
   make share value temporarily illiquid. Production adds reserve rebalancing
   or LP redemption across FLR/FXRP under governance.
3. **Feed freshness is bounded, not proven.** `maxFeedAgeSeconds` (default
   1 h) makes funding/settlement/valuation revert on stale FTSOv2 values; it
   does not defend against a live-but-wrong feed (that is FTSO's own
   crypto-economic security).
4. **Supplier binding covers the payout wallet, not full KYC.** Advances go
   to the attested `supplierWallet` from the system of record; verifying that
   the wallet's owner is the legal supplier entity remains an off-chain ERP
   concern.
5. **x402-inspired, not x402-compliant.** The HTTP 402 oracle borrows the
   PaymentRequirements shape but settles in native FLR with a
   tx-hash-as-receipt proof, not the Coinbase EIP-3009 scheme.
6. **Demo keys in `keys/*.key`** are throwaway Coston2 faucet accounts used by
   the runbook; they hold no real value and are gitignored. Never reuse them
   for anything real.

## Reporting

This is a hackathon repository; file issues on GitHub. Do not send real funds
to any address in this repo.
