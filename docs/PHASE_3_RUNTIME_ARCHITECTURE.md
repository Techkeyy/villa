# Phase 3A runtime architecture

Phase 3A and 3B0 are local, non-broadcasting integration milestones. They define
where the private engine will live later without installing or arming a signer
now.

```text
Browser / Vercel
  | public product, wallet-mediated Phase 2 account actions
  | authenticated control request (future account session)
  v
Control plane
  | account-bound session metadata and readiness facts
  v
Private VILLA engine (future owner-controlled VPS)
  | VILLA operator signer, never returned to the browser
  | account lease -> preflight -> policy -> one serialized writer
  v
One LP VillaAccount
  | explicit operatorPlaceOrder / cancel / reduce / mint / burn / redeem
  v
DreamDEX Event Contracts
```

## Identity and custody

The LP wallet is the owner of the VillaAccount and remains the only actor that
can withdraw collateral, change ownership, change the operator, set market
approval, or recover unsupported tokens. The VillaAccount is the owner of LP
capital, outcome inventory, orders, positions, pending exposure, and settlement
receipts as seen by DreamDEX.

The VILLA operator EOA is only a caller identity. The future private engine may
sign an account method call, but it must never be used as the LP portfolio
address. The adapter's call target is the VillaAccount and the contract derives
the fixed pool and recipient behavior from the approved market ID.

## Where the signer eventually lives

Only in a restricted owner-controlled VPS secret store, with a system service
that has no browser-facing secret response and no Vercel environment access.
The signer is not installed for Phase 3A/3B0. `VILLA_EXECUTION_ENABLED` remains
false, and no VPS service or public control endpoint is changed by these phases.

The browser may eventually know the HTTPS control-plane origin and hold a
short-lived wallet-authenticated account session. It must never receive the
engine private key, an LP private key, seed material, a server signer, or a raw
signing secret.

## Phase 3A mode

`src/execution/lp-adapter.mjs` reads one account through a public client and
constructs unsigned `operator*` call plans. `src/execution/lp-readiness.mjs`
evaluates the required facts. `src/execution/lp-shadow.mjs` feeds account-owned
collateral, inventory, and orders into the existing `villa-risk-v1` and
`villa-quote-v1` layers and returns a deterministic plan.

There is no call to `eth_sendTransaction`, `eth_sendRawTransaction`, an SDK
trader, or a wallet client in the Phase 3A adapter. `broadcast: false` is part
of every returned plan. The real Phase 2 account is read-only fixture data; no
authorization, deposit, order, mint, burn, redeem, or withdrawal is performed.

Phase 3B0 adds the future wet boundary without arming it: an immutable
account-bound session, one lease per account, a deterministic intent envelope,
the exact VillaAccount operator allowlist, hard first-cycle caps, a serialized
nonce-aware writer, and chain/venue reconciliation. The writer halts on
`UNKNOWN`; it does not retry uncertain broadcasts.

## Failure and recovery boundary

Chain state is authoritative. A stale market ID, mismatched account owner,
unexpected operator, unverified runtime, unresolved order read, invalid risk
limit, or second active session fails closed. The engine does not pool LP
balances and does not treat the operator wallet balance as account capital.

This architecture is not a live deployment approval. A future live milestone
must separately review VPS custody, session authentication, account-specific
authorization, transaction policy, order reconciliation, and stop recovery
before any signer is installed or execution is enabled. Phase 3B1 remains
blocked until that review and explicit owner authorization.
