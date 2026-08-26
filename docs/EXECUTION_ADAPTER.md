# Phase 4B execution adapter

## What this adds

The quote planner still only produces an intention. The Phase 4B execution
adapter is the narrow boundary that can turn one approved intention into a
bounded, observable testnet action. It is deliberately a one-shot verifier,
not a market-making loop.

One session reads a live BTC Event Contract, runs the existing
`villa-fv-v1` → `villa-risk-v1` → `villa-quote-v1` pipeline, and then:

1. mints only the minimum complete set if an ask needs YES inventory;
2. re-reads and re-plans;
3. places a post-only YES ask first;
4. reconciles that exact order on-chain and through the indexer;
5. re-reads and re-plans before the second, post-only YES bid;
6. reconciles and cancels only the order IDs created by this session; and
7. burns only the temporary paired set that is still provably complete.

The normal command is read-only unless the operator explicitly opts in:

```bash
npm run verify:quote-cycle:dry
npm run verify:quote-cycle -- --confirm
```

Dry mode prints `DRY RUN — ZERO TRANSACTIONS`. The wet command is capped to one
BTC market, one minimum grid lot, one session, two simultaneous orders, and
post-only order type. It does not intentionally fill, settle, redeem, run a
loop, or send a compensating trade after an unexpected fill.

## Safety boundary

`src/execution/policy.mjs` is pure. It knows neither the SDK nor a wallet. It
checks decision age, chain-time status and expiry, feed freshness, verified
open-order state, governor permissions, exact tick/lot/minimum constraints,
post-only inequalities, visible YES inventory, and BUY collateral plus reserve.
The verification cap can only reduce the planner quantity; it cannot change a
planner price or create a disabled side.

`src/execution/write-queue.mjs` is the only writer boundary. Mint, placement,
cancellation, and burn all pass through one serialized promise chain. The
adapter never uses parallel writes, broad cancellation, or a second signer.

`src/execution/live.mjs` owns live acquisition and reuses the existing risk and
quote assemblers. The DreamDEX midpoint is retained as comparison-only data;
it is never passed to fair value, risk, or quote decisions.

## Reconciliation

An order is considered resting only when the active on-chain order has the
expected side, raw price, and positive remaining quantity. An indexer row is a
secondary consistency check; contradictory raw remainder or side yields
`UNKNOWN`. A successful placement receipt without active on-chain evidence is
not treated as success. After an exact cancel, `getOrderOnchain` must be gone
and the verified open-order read must no longer contain that ID.

The indexer is allowed a bounded retry window. The chain is authoritative for
active existence, but an unresolved chain/indexer contradiction halts further
quoting and blocks cleanup that would require guessing.

The venue-specific Shannon observation is important: a resting `SELL_YES`
escrows its YES from the visible ERC-6909 balance. Therefore the adapter passes
that visible balance to the planner and does not subtract the same SELL
commitment again. The governor still accounts for the pending SELL's worst-case
directional stress.

## Session facts and limitations

Each run has an in-memory session ID and structured events for selection,
baseline, model/risk/plan, inventory, order writes, reconciliation, and
cleanup. This makes one run explainable and auditable in terminal output. It is
not a durable restart journal: a future persistent runner must reconstruct
state from chain and indexer facts before resuming, never assume a write landed,
and never replay an unknown write.

The adapter uses explicit chain time for expiry and permits the same small
future feed timestamp tolerance already accepted by the risk governor. Local
clock offset is reported, not used as a substitute for chain time.

## Versioned components

| Component | Version | Role |
| --- | --- | --- |
| Fair value | `villa-fv-v1` | Independent UP probability |
| Risk governor | `villa-risk-v1` | ALLOW / REDUCE_ONLY / HALT |
| Quote planner | `villa-quote-v1` | Adaptive raw bid/ask intention |
| Execution adapter | `villa-execution-v1` | Bounded write, reconciliation, cleanup |

Settlement is intentionally outside this writer. Phase 5A's
`src/settlement/` module never consumes quote targets, places/cancels orders,
or treats `burnSet` as a redeem. It observes terminal chain state, redeems by
`marketId` and explicit outcome index, and reconciles payout and gas before
stopping.
