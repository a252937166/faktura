# Verifiable decision memos — committed samples

Every underwriting decision Faktura anchors on-chain is the sha256 of a memo
whose exact bytes are persisted by the agent (`agents/data/memos/`, served at
`GET /api/memos/:hash`). This directory pins one real example so the check is
reproducible without running anything:

## `strict-fdc-decision-memo.sha256-3566c53a.json`

The decision memo behind the **strict FDC registration** of invoice
`INV-2026-0042` (invoice **#1** on the permanently-strict EVIDENCE hub, voting round **1385871**) on the live
Coston2 deployment
[`0x2415Ed954A18a5c232c9d40a753C77f401AaCeEb`](https://coston2-explorer.flare.network/address/0x2415Ed954A18a5c232c9d40a753C77f401AaCeEb#code).

Verify it:

```bash
shasum -a 256 docs/samples/strict-fdc-decision-memo.sha256-3566c53a.json
# 3566c53a4f64ad1c3d345a27c2e13fef6f17146dc30dd347ba3586e09281096a
```

Compare with the on-chain record: explorer → FakturaHub → *Read Contract* →
`getInvoice(1)` → `decisionHash` =
`sha256:3566c53a4f64ad1c3d345a27c2e13fef6f17146dc30dd347ba3586e09281096a`,
set by the strict registration tx
[`0xcdf9e0…f3da22`](https://coston2-explorer.flare.network/tx/0xcdf9e018410586baef0c2a162ca5fab0fde3babb0a8434eb081715eec3f3da22).

The memo's `source` field records the exact system-of-record URL the FDC
Web2Json attestation read in round 1385871 — including the payout wallet the advance was bound to:
[`https://a252937166.github.io/faktura/erp/INV-2026-0042.json`](https://a252937166.github.io/faktura/erp/INV-2026-0042.json)
— the committed [`docs/erp/INV-2026-0042.json`](../erp/INV-2026-0042.json)
served by GitHub Pages with `Content-Type: application/json` (which the
Web2Json verifier requires), matching the `erpUrlPrefix` pinned on-chain.

Earlier strict registrations on the retired v1 hub
(`0xe7Fb9db07C3a34A3Ae3a3398Cb70AA9D1e57cc58`, rounds 1385814/1385845)
remain on-chain as additional history.
