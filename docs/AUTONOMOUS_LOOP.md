# VILLA bounded autonomous loop

VILLA is an operator's liquidity desk for DreamDEX Event Contracts. DreamDEX
hosts the market; VILLA repeatedly reads the market, estimates its own value,
checks deterministic safety rules, and—when all gates pass—places small
post-only quotes. It does not create a market or use the exchange midpoint as
its fair-value input.

The first autonomous runner is intentionally a bounded verification session.
It operates only on the configured `BINARY:BTC:300` series, can initialize at
most three market windows, stops after the hard session duration, and exits
after cleanup. It is not an always-on daemon and does not build the dashboard.

## What VILLA checks repeatedly

Each cycle obtains a fresh chain-time market/account/order snapshot and runs
the existing layers in order:

```text
DreamDEX reads
  -> villa-fv-v1
  -> villa-risk-v1
  -> villa-quote-v1
  -> execution preflight
  -> one serialized writer queue (wet mode only)
  -> on-chain/indexer reconciliation
```

Settlement checks for older markets run beside, but do not become inputs to,
the current market's inventory or quote plan. The current market is always
bound by `marketId`; its reference, token ids, inventory, open orders, expiry,
book, and decision are reinitialized for every successor.

VILLA may change a quote when the desired raw price moves by at least two
ticks, size changes by at least 25%, inventory changes, the governor changes,
a side becomes invalid, or an order reaches its 240-second maximum age. A
small alternating move is held by deterministic hysteresis, avoiding cancel /
replace churn. A `NO_QUOTE` plan is a valid operating state: VILLA waits and
re-evaluates the same configured series rather than selecting another market.

If the governor returns `HALT`, VILLA places nothing and cancels only its
tracked current-session orders when safe. It preserves inventory and keeps
observing recoverable conditions. Contradictory order state, an unknown fill,
or an unreconcilable cleanup is a fatal refusal. No taker fallback or
compensating trade exists.

## Market lifecycle

For each window, the runner:

1. discovers a live BTC 5-minute market with sufficient chain-time headroom;
2. verifies on-chain Trading status, reference, binary grid, book, balances,
   and an empty current-session order set;
3. runs fair value, governor, and quote planning;
4. mints one minimum complete set only if an enabled YES ask requires it,
   then re-reads and re-runs all three layers;
5. places only planner-derived, post-only targets, capped to one valid lot at
   the write boundary;
6. reconciles every tracked order, including organic partial or full fills,
   before using a later cycle's state;
7. stops new quotes at 90 seconds before expiry, cancels exact tracked orders,
   verifies removal, and burns only the safe paired increment;
8. records any unmatched YES/NO balance as a market-specific settlement
   position; and
9. observes terminal state, then uses the verified Phase 5B same-series
   rediscovery to initialize a fresh successor.

The runner may check known finalized positions during either market. A known
zero-value losing residual is labelled and skipped; the loop does not invent a
claim. Redemption remains the existing settlement lifecycle and all possible
future writes share the same queue.

## `villa-loop-v1` policy

The pure policy is in `src/orchestrator/index.mjs`. It owns lifecycle state,
caps, event facts, requote hysteresis, chain-time expiry arithmetic, market
scope, journal shape, and restart truth precedence. It does not import the
SDK, RPC, environment, wallet, clock, fair-value math, risk rules, quote
formula, or writer.

The live read/write boundary is `src/orchestrator/live.mjs`. It adapts the
verified Phase 5B binary collector and Phase 4B execution preflight. The
runner is `scripts/villa-bounded.mjs`; it is the only place that schedules
cycles and coordinates writes.

Default hard limits:

| Limit | Value |
| --- | ---: |
| Configured series | `BINARY:BTC:300` only |
| Maximum initialized windows | 3 |
| Maximum session duration | 720 chain seconds |
| Poll interval | 10 seconds |
| Discovery headroom | 120 seconds |
| Stop-quoting headroom | 90 seconds |
| Order lifetime | 75 seconds, with 2-second market-expiry safety |
| Simultaneous resting orders | 2 |
| Transaction budget | 30 |
| Order replacements | 2 |
| Complete-set mints | 3 total, at most one lot per market |
| Provisioned collateral | 0.001 tUSDC per market; 0.003 total |
| Committed collateral | 0.002 tUSDC |
| Directional exposure | 0.001 tUSDC |
| Read/discovery retries | 3 / 36 bounded attempts |

The order and provisioning caps only reduce a planner target. The writer does
not increase a planner price or revive a disabled side. The one-lot write cap
and complete-set amount are deliberately tiny; this is a bounded loss
containment measure, not production risk management. Ignoring fills and gas,
the configured collateral commitment can expose at most `0.002` tUSDC of
quote escrow plus `0.003` tUSDC of temporary provisioning accounting; the
stricter directional cap is `0.001` tUSDC. The caps do not claim a complete
P&L or slippage model.

All wet writes—mint, post-only placement, cancellation, burn, or any future
settlement write—must pass through one `createSerializedWriteQueue` instance.
There is no parallel bid/ask, mint/cancel, burn/redeem, second wallet, or
taker path.

## Expiry, fills, and cleanup

Orders carry an explicit `expireTimestampNs` computed from Shannon chain time,
never the workstation clock. The expiry is no later than the configured
order lifetime and remains before market expiry by the safety margin.

On-chain order state is authoritative for active existence. The indexer is a
secondary consistency check. A placement receipt without a reconciled active
order is not treated as resting. A partial fill records the actual filled and
remaining quantities, cancels only the remainder when the bounded policy says
so, and reruns risk and quote planning from the new account state. An unknown
classification stops the session rather than double-counting.

At cleanup, `paired = min(YES, NO)` is the only burnable amount. Directional
residuals remain attached to the old `marketId` for settlement; they are never
used as inventory for a successor. Cleanup requires zero active configured
series orders and records collateral movement separately from STT gas.

## Journal and restart

After every state boundary the runner writes a secret-free JSON journal to the
ignored path `runtime/state/villa-loop-v1.json`. It contains the session id,
version, exact series, current/visited market ids, active known order ids,
temporary mint quantities, lifecycle state, settlement records, accounting,
caps, and last safe reconciliation point. It never stores a private key or
secret-like field.

`--resume` does not trust the journal as execution truth. The resumed process
starts with current Shannon time and must rediscover the configured market,
re-read balances, and reconcile chain/indexer order state before acting. A
missing chain order beats a stale journal `RESTING` record. The deterministic
restart tests prove no duplicate mint, order, or redeem decision from stale
local state; this is basic bounded recovery, not a claim of crash-proof
production operation.

## Commands and evidence

```text
npm run villa:bounded:dry
npm run villa:bounded -- --confirm
```

Dry mode has no signer and no writer. Wet mode requires the explicit
`--confirm` acknowledgement and exits on every configured bound. Ordinary
`npm test` remains transaction-free. The terminal prints concise snapshots;
the journal and structured event stream retain machine-readable detail for a
future dashboard.

## Known limitations

This milestone does not claim profitable alpha, complete P&L/drawdown
accounting, crash-proof recovery, guaranteed fills, a settlement redemption
inside every quote session, multiple assets, multiple cadences, session-key
custody, or a frontend. It intentionally prefers `NO_QUOTE`, `HALT`, waiting
for a successor, or a bounded refusal over unsafe activity. The live evidence
for the exact run is recorded in `docs/TECHNICAL_VERIFICATION.md`.

## Phase 6A proof boundary

The 2026-08-26 bounded wet proof initialized two exact `BINARY:BTC:300`
markets under an effective two-market cap. It produced fresh fair-value,
governor, and quote decisions, observed both sides resting, recorded two
organic full YES-ask fills, tracked the resulting NO residuals by old
`marketId`, stopped before expiry, reconciled exact cancellations, observed
terminal resolution, and continued into one later same-series successor.
The run ended with zero active orders and `RESULT: PASS`; no redeem/claim write
was performed, and winning residuals remained explicitly claimable for the
existing settlement lifecycle. The full dry run used the same lifecycle with virtual writes and
sent zero transactions. Exact ids, raw accounting, event count, and final
public reconciliation are recorded in `docs/TECHNICAL_VERIFICATION.md`.

The runner's wet transaction budget counts bounded writer actions. SDK setup
approvals remain SDK Trader operations and are routed through the same single
serialized queue. The live adapter retains WebSocket reads and receipt
subscriptions but deliberately routes the SDK's standard raw-transaction
fallback through the official Shannon HTTP RPC alias. This is an operational
transport choice, not a change to Event Contract semantics. Known short-lived
indexer lag is chain-authoritative only for known session order ids with
matching expected prices; unknown contradictions still halt.
