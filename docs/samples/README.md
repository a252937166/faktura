# Verifiable decision memos — committed samples

Every underwriting decision Faktura anchors on-chain is the sha256 of a memo
whose exact bytes are persisted by the agent (`agents/data/memos/`, served at
`GET /api/memos/:hash`). This directory pins one real example so the check is
reproducible without running anything:

## `strict-fdc-decision-memo.sha256-3cd1dfa2.json`

The decision memo behind the **strict FDC registration** of invoice
`INV-2026-0040` (on-chain invoice **#1**, voting round **1385814**) on the live
Coston2 deployment
[`0xe7Fb9db07C3a34A3Ae3a3398Cb70AA9D1e57cc58`](https://coston2-explorer.flare.network/address/0xe7Fb9db07C3a34A3Ae3a3398Cb70AA9D1e57cc58#code).

Verify it:

```bash
shasum -a 256 docs/samples/strict-fdc-decision-memo.sha256-3cd1dfa2.json
# 3cd1dfa2f23c89b28b7a19f05ef458072da4a13ab25ecf3d108165f255b214f9
```

Compare with the on-chain record: explorer → FakturaHub → *Read Contract* →
`getInvoice(1)` → `decisionHash` =
`sha256:3cd1dfa2f23c89b28b7a19f05ef458072da4a13ab25ecf3d108165f255b214f9`,
set by the strict registration tx
[`0xe38561…0650d`](https://coston2-explorer.flare.network/tx/0xe385612c2b507303a278a528ff9341ef35fb303a0c5434f749a77c38f103650d).

The memo's `source` field records the exact system-of-record URL that the FDC
Web2Json attestation read in round 1385814 (a mirror of
[`docs/erp/INV-2026-0040.json`](../erp/INV-2026-0040.json) served with
`Content-Type: application/json`, which the Web2Json verifier requires).
