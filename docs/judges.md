# Judge's 3-minute path

Everything claimable is on-chain on **Coston2** and linked from the
[README evidence table](../README.md#live-deployment--on-chain-evidence).
This page is the shortest route through it.

**Hosted demo: [flare.axiqo.xyz](https://flare.axiqo.xyz/)** — safe to click:
it is a public showcase (real Coston2 snapshot reads, simulated writes — the
mode banner on the page says which). The transactions below are the real proof.

## 1. The strict FDC proof (60s) — the part most projects fake

Invoice **#1** on the **evidence hub** (permanently `fdcEnforced=true`) was registered with `fdcEnforced = true`: the
contract itself Merkle-verified a real **FDC Web2Json attestation** of the
supplier's system-of-record document (voting round **1385871**) and decoded
the invoice facts *from the attested response*, not from the agent.

1. Attestation request to FdcHub:
   [`0xd8ee11…7253b8`](https://coston2-explorer.flare.network/tx/0xd8ee114deb28fe8af2810b146049baef422bc11df4304c1e9dd14b74897253b8)
2. Round finalization: [round 1385871 on the systems explorer](https://coston2-systems-explorer.flare.rocks/voting-round/1385871?tab=fdc)
3. `registerInvoice` with the Merkle proof, verified on-chain:
   [`0xcdf9e0…f3da22`](https://coston2-explorer.flare.network/tx/0xcdf9e018410586baef0c2a162ca5fab0fde3babb0a8434eb081715eec3f3da22)
4. Funded at the live FTSOv2 FLR/USD rate:
   [`0x26cab9…0f5fd6`](https://coston2-explorer.flare.network/tx/0x26cab9f401835b99f8c580cd8b8d6f2a7a42a751efce271c228590f3ad0f5fd6)
5. Debtor settled at the re-quoted rate:
   [`0xa08b2d…ba27d6`](https://coston2-explorer.flare.network/tx/0xa08b2d48f3e7a41bce26c59234ad887bf82cc3f93eaff80427d892ee3aba27d6)

The advance was paid to the **attested payout wallet** from the document
(`invoice.supplier.paymentAddress`) — while enforcement is on, the agent
cannot redirect funding.

Reproduce it yourself (~4 min): `cd contracts && npm run fdc:register`
(uses the committed `docs/erp/INV-2026-0042.json` served by GitHub Pages;
note the doc's `documentSha256` is single-use per hub — duplicates revert).

## 2. The contract is honest about its bounds (30s)

Open the **verified source**:
[`FakturaHub` #code](https://coston2-explorer.flare.network/address/0x2415Ed954A18a5c232c9d40a753C77f401AaCeEb#code)

- `riskPolicy` — the on-chain envelope (max risk 65, discount 50–2500 bps,
  per-invoice exposure ≤ 60% of liquid, tenor ≤ 120d). The AI cannot exceed it.
- `erpUrlPrefix` — FDC-attested facts must come from the pinned system of
  record; a stolen agent key cannot attest its own URL (`UntrustedSource`).
- `maxFeedAgeSeconds` — every FTSOv2 read (funding, quotes, reserve
  valuation) reverts on values older than the bound (`StaleRate`).
- `InvoiceFacts.supplierWallet` — the payout beneficiary is an attested
  system-of-record fact; the agent's parameter is demo-mode fallback only.
- *Read Contract* → `quoteUsdCentsInFlrWei(100)` and
  `quoteUsdCentsInToken(100)` — both live FTSOv2 feeds (FLR/USD, XRP/USD),
  read through the hub right now.

## 3. Verify an AI decision hash (30s)

```bash
shasum -a 256 docs/samples/strict-fdc-decision-memo.sha256-3566c53a.json
# = getInvoice(1).decisionHash on the EVIDENCE hub (sha256:3566c53a…)
```

Every approval *and* rejection is anchored (`attest`), and the agent serves
the exact bytes at `GET /api/memos/:hash` — see
[`docs/samples/`](samples/README.md).

## 4. Run the demo (60s to start)

```bash
cd contracts && npm install && npm test        # 14 passing
cd ../web && npm install && npm run build
cd ../agents && npm install && npm start       # http://localhost:4020
```

Submit an invoice in the UI and watch the SSE feed: pre-checks → LLM opinion →
policy clamps → register → FTSOv2-priced funding → attestation, each line with
its explorer link. `npm run e2e` (in `agents/`) drives the same lifecycle
headlessly, including an FXRP settlement (XRP/USD feed) and an autonomous
default. No LLM key needed — the underwriter falls back to a deterministic
heuristic; with `ANTHROPIC_API_KEY`/`DEEPSEEK_API_KEY` it uses the real model.

**Demo vs strict:** the interactive demo targets the **demo hub**
(`0xFd92139994CfbD99D54ac931AF5bd59C3DBD8f15`) and may run with `fdcEnforced` off for instant registrations
(admin-only, evented, restored afterwards). The **evidence hub** in §1 is
permanently strict and the tooling refuses to demote it — judge Faktura there.

## What to look at in the code (if you have 5 more minutes)

| Claim | File |
|---|---|
| FDC proof verified on-chain + source pinning + policy envelope | `contracts/contracts/FakturaHub.sol` (`registerInvoice`, `fundInvoice`) |
| Real Web2Json flow (verifier → FdcHub → Relay → DA layer) | `contracts/scripts/registerViaFdc.ts`, `agents/src/fdc.ts` |
| FXRP settlement leg, reserve marked to market via two feeds | `FakturaHub.sol` (`settleInvoiceInToken`, `settlementReserveFlrValue`) |
| LLM proposes / code disposes | `agents/src/underwriter.ts` + on-chain `riskPolicy` |
| Tests incl. policy, pinning, supplier binding, staleness, FXRP, defaults | `contracts/test/fakturaHub.ts` (14) |
