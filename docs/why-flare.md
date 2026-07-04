# Why Flare — what breaks without it

Faktura finances real-world receivables from an on-chain pool. That takes two
things no ordinary EVM chain gives you natively, and both are enshrined
protocols on Flare:

## 1. Provenance: FDC (Web2Json)

An invoice is an off-chain claim. On a generic chain, "register an invoice"
means "trust whoever calls the function" — an agent (or its stolen key) can
fabricate a receivable and drain the pool against it. Every RWA project hits
this wall and usually answers it with a committee or a trusted API signer.

On Flare, `registerInvoice` **requires an FDC Web2Json Merkle proof**: the
invoice's number, debtor, amount, due date, document hash **and payout
wallet** must have been fetched from the supplier's system of record by
Flare's attestation providers in a finalized voting round, and
`FdcVerification.verifyWeb2Json` checks that proof **inside the contract**.
FakturaHub additionally pins the source URL prefix (`erpUrlPrefix`) and pays
advances only to the attested `supplierWallet`, so even a compromised agent
key can neither register documents the pinned ERP doesn't serve nor redirect
funding to itself.

Without FDC: Faktura's registry is an honor system. With FDC: invoice facts
are chain-verified data with provenance.

## 2. Pricing: FTSOv2 (two feeds)

Receivables are fiat-denominated; the pool holds FLR (and an FXRP reserve).
Someone must convert USD face values into token amounts at *funding* and again
at *settlement*, trustlessly, at the market rate of that block:

- `fundInvoice` converts the USD advance → FLR at the live **FLR/USD** feed
  the moment it pays the supplier;
- `settleInvoice` re-quotes the face value at settlement time, so FX drift
  between funding and settlement lands in the pool's share price instead of
  in an unpriced position;
- `settleInvoiceInToken` prices the same USD face value in **FXRP via the
  XRP/USD feed**, and `poolValue()` marks the accumulated FXRP reserve to
  market through both feeds.

FTSOv2 is enshrined and block-latency — no Chainlink subscription, no keeper
bots, no bridge oracle to trust. Remove it and the pool cannot price a single
funding.

## 3. The consequence: an autonomous desk that is *checkable*

Because provenance and pricing are protocol-level, the remaining discretion —
"should we buy this receivable, and at what discount?" — can safely be handed
to an autonomous AI agent whose output is bounded by the on-chain
`riskPolicy` envelope and whose every decision memo is hash-anchored via
`attest(...)`. The interesting part of Faktura is not "an LLM scores
invoices"; it is that Flare's data protocols shrink the trust you must place
in that LLM to approximately zero.

## Interoperable asset angle (Bounty 1)

A financed invoice becomes an on-chain asset with a USD face value, an oracle
FX layer, and a settlement leg in **FXRP** — the FAssets representation of
XRP. Debtors (or their payment processors) can discharge USD obligations in
XRP-ecosystem liquidity; the pool holds the FXRP reserve marked to market by
FTSOv2. Roadmap: FXRP as LP collateral, USD₮0 settlement, and pool shares as
transferable ERC-20 receivable-index tokens.
