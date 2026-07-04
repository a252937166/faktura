# Verifiable decision memos — committed samples

Every underwriting decision Faktura anchors on-chain is the sha256 of a memo
whose exact bytes are persisted by the agent (`agents/data/memos/`, served at
`GET /api/memos/:hash`). This directory pins one real example so the check is
reproducible without running anything:

## `strict-fdc-decision-memo.sha256-a4d175b0.json`

The decision memo behind the **strict FDC registration** of invoice
`INV-2026-0042` (on-chain invoice **#8**, voting round **1385845**) on the live
Coston2 deployment
[`0xe7Fb9db07C3a34A3Ae3a3398Cb70AA9D1e57cc58`](https://coston2-explorer.flare.network/address/0xe7Fb9db07C3a34A3Ae3a3398Cb70AA9D1e57cc58#code).

Verify it:

```bash
shasum -a 256 docs/samples/strict-fdc-decision-memo.sha256-a4d175b0.json
# a4d175b025707f48102ff0ed40c2b137755b1c344fb9c79094982b557bd3741f
```

Compare with the on-chain record: explorer → FakturaHub → *Read Contract* →
`getInvoice(8)` → `decisionHash` =
`sha256:a4d175b025707f48102ff0ed40c2b137755b1c344fb9c79094982b557bd3741f`,
set by the strict registration tx
[`0xe63934…13491`](https://coston2-explorer.flare.network/tx/0xe63934cab7809e23f746882a5c14f9b7e86d4c5304dd78352605b59505813491).

The memo's `source` field records the exact system-of-record URL the FDC
Web2Json attestation read in round 1385845:
[`https://a252937166.github.io/faktura/erp/INV-2026-0042.json`](https://a252937166.github.io/faktura/erp/INV-2026-0042.json)
— the committed [`docs/erp/INV-2026-0042.json`](../erp/INV-2026-0042.json)
served by GitHub Pages with `Content-Type: application/json` (which the
Web2Json verifier requires), matching the `erpUrlPrefix` pinned on-chain.

An earlier strict registration (invoice **#1**, round **1385814**, source: a
temporary JSON mirror of `docs/erp/INV-2026-0040.json` used while Pages was
being set up) remains on-chain as additional history.
