# Judge's 3-minute path

Everything claimable is on-chain on **Coston2** and linked from the
[README evidence table](../README.md#live-deployment--on-chain-evidence).
This page is the shortest route through it.

## 1. The strict FDC proof (60s) — the part most projects fake

Invoice **#1** on the live hub was registered with `fdcEnforced = true`: the
contract itself Merkle-verified a real **FDC Web2Json attestation** of the
supplier's system-of-record document (voting round **1385814**) and decoded
the invoice facts *from the attested response*, not from the agent.

1. Attestation request to FdcHub:
   [`0xa4c10b…835cb`](https://coston2-explorer.flare.network/tx/0xa4c10b9f0af3a249c95f486342888a4a9d07d7b6f0da16d09a74306ac86835cb)
2. Round finalization: [round 1385814 on the systems explorer](https://coston2-systems-explorer.flare.rocks/voting-round/1385814?tab=fdc)
3. `registerInvoice` with the Merkle proof, verified on-chain:
   [`0xe38561…0650d`](https://coston2-explorer.flare.network/tx/0xe385612c2b507303a278a528ff9341ef35fb303a0c5434f749a77c38f103650d)
4. Funded at the live FTSOv2 FLR/USD rate:
   [`0xd29892…b9adc6`](https://coston2-explorer.flare.network/tx/0xd29892e877bd7d07961538c20169389b5562976db8449ae45ea2e9ea86b9adc6)
5. Debtor settled at the re-quoted rate:
   [`0x0218c2…bb4ea2`](https://coston2-explorer.flare.network/tx/0x0218c235ca14eb152dd79c68f6485a5adf1f35935c68f57c6028de6cf2bb4ea2)

Reproduce it yourself (~4 min): `cd contracts && npm run fdc:register`
(uses the committed `docs/erp/INV-2026-0042.json` served by GitHub Pages).

## 2. The contract is honest about its bounds (30s)

Open the **verified source**:
[`FakturaHub` #code](https://coston2-explorer.flare.network/address/0xe7Fb9db07C3a34A3Ae3a3398Cb70AA9D1e57cc58#code)

- `riskPolicy` — the on-chain envelope (max risk 65, discount 50–2500 bps,
  per-invoice exposure ≤ 60% of liquid, tenor ≤ 120d). The AI cannot exceed it.
- `erpUrlPrefix` — FDC-attested facts must come from the pinned system of
  record; a stolen agent key cannot attest its own URL (`UntrustedSource`).
- *Read Contract* → `quoteUsdCentsInFlrWei(100)` and
  `quoteUsdCentsInToken(100)` — both live FTSOv2 feeds (FLR/USD, XRP/USD),
  read through the hub right now.

## 3. Verify an AI decision hash (30s)

```bash
shasum -a 256 docs/samples/strict-fdc-decision-memo.sha256-3cd1dfa2.json
# = getInvoice(1).decisionHash on the explorer (sha256:3cd1dfa2…)
```

Every approval *and* rejection is anchored (`attest`), and the agent serves
the exact bytes at `GET /api/memos/:hash` — see
[`docs/samples/`](samples/README.md).

## 4. Run the demo (60s to start)

```bash
cd contracts && npm install && npm test        # 12 passing
cd ../web && npm install && npm run build
cd ../agents && npm install && npm start       # http://localhost:4020
```

Submit an invoice in the UI and watch the SSE feed: pre-checks → LLM opinion →
policy clamps → register → FTSOv2-priced funding → attestation, each line with
its explorer link. `npm run e2e` (in `agents/`) drives the same lifecycle
headlessly, including an FXRP settlement (XRP/USD feed) and an autonomous
default. No LLM key needed — the underwriter falls back to a deterministic
heuristic; with `ANTHROPIC_API_KEY`/`DEEPSEEK_API_KEY` it uses the real model.

**Demo vs strict:** the interactive demo runs with `fdcEnforced` off for
instant registrations (admin-only, publicly-evented toggle; restored
afterwards). The proof path is §1 — judge Faktura on that.

## What to look at in the code (if you have 5 more minutes)

| Claim | File |
|---|---|
| FDC proof verified on-chain + source pinning + policy envelope | `contracts/contracts/FakturaHub.sol` (`registerInvoice`, `fundInvoice`) |
| Real Web2Json flow (verifier → FdcHub → Relay → DA layer) | `contracts/scripts/registerViaFdc.ts`, `agents/src/fdc.ts` |
| FXRP settlement leg, reserve marked to market via two feeds | `FakturaHub.sol` (`settleInvoiceInToken`, `settlementReserveFlrValue`) |
| LLM proposes / code disposes | `agents/src/underwriter.ts` + on-chain `riskPolicy` |
| Tests incl. policy, pinning, FXRP, FX repricing, defaults | `contracts/test/fakturaHub.ts` (12) |
