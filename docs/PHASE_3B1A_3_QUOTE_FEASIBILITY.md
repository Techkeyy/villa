# Phase 3B1A.3 post-mint quote feasibility

This gate answers one question before any owner approval is requested: can the
bounded disposable LP account produce one policy-valid DreamDEX quote from its
current capital and inventory, including a planning-only minimal complete-set
mint if necessary?

The current `NO_QUOTE` is preserved as evidence. The feasibility probe then
projects:

```text
collateral = collateral - M
YES        = YES + M
NO         = NO + M
```

For every lot-aligned `M` from the venue minimum through
`MAX_MINT_AMOUNT`, the existing Risk Governor and quote planner are rerun on
that projected state. The projected quote is additionally checked against the
existing order, pending-exposure, open-order, venue-grid, and post-only caps.
An unsigned mint, one quote, cancel, and burn plan is then checked by the
existing account transaction policy. None of these checks can read a signer or
broadcast a transaction.

The owner-prep boundary may use a projected quote only when that complete
sequence is valid. An invalid projection remains blocked and emits zero owner
requests.

## Current disposable-account result

The authoritative account has 1.00 tUSDC and zero YES/NO inventory. The
minimum venue-compatible candidate is 1,000 raw units. The deployed
`VillaAccount.maxOrderCollateral` is also 1,000 raw units, so larger candidates
are rejected by the account boundary. The 1,000-raw candidate leaves 999,000
raw collateral, below the unchanged 1,000,000-raw Risk Governor reserve, and is
therefore `COLLATERAL_RESERVE_LOW` / `HALT`.

The result is:

```text
1.00 tUSDC IS STRUCTURALLY INSUFFICIENT
```

The lower-bound replacement capital for the minimal SELL-after-mint route is
1.001 tUSDC before any fee or operational buffer. This is an observation only;
the Phase 3B1 hard cap remains unchanged.

Run the live read-only gate with:

```text
npm run phase3b1a:feasibility
```
