# Judge's 3-minute path

Everything claimable is on-chain on **Coston2** and linked from the
[README evidence table](../README.md#live-deployment--on-chain-evidence).
This page is the shortest route through it.

## 1. The strict FDC proof (60s) — the part most projects fake

Invoice **#8** on the live hub was registered with `fdcEnforced = true`: the
contract itself Merkle-verified a real **FDC Web2Json attestation** of the
supplier's system-of-record document (voting round **1385845**) and decoded
the invoice facts *from the attested response*, not from the agent.

1. Attestation request to FdcHub:
   [`0x567987…d5822`](https://coston2-explorer.flare.network/tx/0x56798765dc617acf90493fa94bb0a5cb26c40d191df3ad0b142d96dfd1d5d822)
2. Round finalization: [round 1385845 on the systems explorer](https://coston2-systems-explorer.flare.rocks/voting-round/1385845?tab=fdc)
3. `registerInvoice` with the Merkle proof, verified on-chain:
   [`0xe63934…13491`](https://coston2-explorer.flare.network/tx/0xe63934cab7809e23f746882a5c14f9b7e86d4c5304dd78352605b59505813491)
4. Funded at the live FTSOv2 FLR/USD rate:
   [`0x9ba38d…7c19ea`](https://coston2-explorer.flare.network/tx/0x9ba38dc9a788ae7022da7da80b10631e0c07258ddf2895a328cea76ccf7c19ea)
5. Debtor settled at the re-quoted rate:
   [`0xdbce9d…ba3f202`](https://coston2-explorer.flare.network/tx/0xdbce9d38f7492774afcafb43832492d6aa044c0a7be05ce2f0f7f626dba3f202)

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
shasum -a 256 docs/samples/strict-fdc-decision-memo.sha256-a4d175b0.json
# = getInvoice(8).decisionHash on the explorer (sha256:a4d175b0…)
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
