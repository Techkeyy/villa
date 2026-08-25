# VILLA deterministic risk governor

## In plain language

The fair-value engine answers one question: “What probability does VILLA assign
to UP?” The risk governor answers a different question: “Given the state of the
market, data feeds, wallet, inventory, and operator limits, is VILLA allowed to
take more risk right now?”

It is a safety gate for the future quoting loop. It does not decide a price, it
does not size a quote from a probability, and it does not send a transaction.
The direct user is the liquidity-provider operator, who supplies capital and
limits. VILLA supplies a repeatable decision with named reasons.

The governor uses:

- the fair-value result and its data-quality score;
- the on-chain market status and expiry;
- a current underlying price and its chain timestamp;
- the authoritative Shannon chain clock;
- YES/NO inventory and the remaining quantities of open orders;
- collateral, gas, and capital-at-risk facts;
- drawdown facts when a future accounting layer supplies them;
- a versioned operator risk configuration.

The DreamDEX midpoint is not a governor input. A large disagreement between the
model and the book is useful for an operator to inspect, but it does not by
itself halt or permit trading. Normal changes in realized volatility are also
not a halt rule; an emergency volatility stop exists only when explicitly
enabled in configuration.

If a safety-critical fact is malformed, stale, ambiguous, or missing, the
governor fails closed to `HALT`. It never turns broken data into a neutral
50/50 decision. `cancelExisting` is only a recommendation in this phase; the
governor never cancels an order.

## Decision states

| State | Meaning | Future execution permission |
| --- | --- | --- |
| `ALLOW` | The configured hard gates pass and exposure is below the reduce-only boundary. | Risk-increasing and reducing actions may be considered by a later quote planner. |
| `REDUCE_ONLY` | A soft directional exposure boundary has been reached. | Only actions that reduce the dominant residual are permitted. No new directional risk. |
| `HALT` | A hard safety gate failed. | No actions are permitted. `cancelExisting: true` is a recommendation only. |

The output also includes `sizeMultiplier`. It is `1` for an ordinary healthy
snapshot, `0.5` when a configured warning such as moderate exposure or drawdown
is active, `0` for `REDUCE_ONLY`, and `0` for `HALT`. This is a future quote
planner input, not a quote calculation.

## Version and configuration

The initial policy is `villa-risk-v1`, exported as
`DEFAULT_RISK_CONFIG` in `src/risk-governor/config.mjs`. Policy values are
centralized and validated rather than scattered through rule branches:

| Policy | Default | Unit / purpose |
| --- | ---: | --- |
| `maxChainTimeAgeSec` | 15 | Maximum age of the chain-head observation. |
| `maxPriceAgeSec` | 15 | Maximum age of the underlying feed timestamp measured against chain time. |
| `maxSourceAgeSec` | 60 | Maximum age of the upstream source when the feed supplies it. |
| `maxFutureTimestampSec` | 5 | Tolerance before a feed timestamp is considered ahead of chain time. |
| `minModelConfidence` | 0.75 | Minimum Phase 2A data-quality score. |
| `minExpiryHeadroomSec` | 30 | Minimum remaining chain-time before a new risk decision is useful. |
| directional warning / soft / hard | 5 / 7 / 10 | Residual outcome-token units. |
| gross warning / hard | 16 / 20 | YES + NO outcome-token units, including pending risk-increasing buys. |
| capital warning / hard | 80 / 100 | Operator-supplied capital-at-risk units. |
| `minCollateralReserve` | 1 | Collateral units that must remain available. |
| `minGasReserve` | 0.1 | Native STT units reserved for future operations. |
| drawdown warning / hard | 3% / 5% | Operator-supplied drawdown ratio. |

These defaults are a testnet MVP policy, not a claim that they are optimal for
every operator or market cadence. A future operator configuration should be
versioned rather than changing the meaning of `villa-risk-v1` silently.

## Pure input and output boundary

`evaluateRisk(snapshot, config)` accepts only normalized facts. It does not
import the SDK, read RPC or GraphQL, read environment variables, read a clock,
inspect a wallet, fetch a fair value, read a book, or call an order function.

The required snapshot groups are:

```js
{
  fairValue: {
    modelVersion, pUp, pDown, confidence, dataQualityStatus,
    referenceSource, realizedVolPerSqrtSec
  },
  chainTime: {
    chainNowSec, observationAgeSec, blockNumber,
    localNowMs, observedAtLocalMs, clockOffsetSec
  },
  feed: { price, timestampSec, sourceAgeSec },
  market: {
    status, expirySec,
    reference: { status: "VALID", source, scaleExponent10 }
  },
  inventory: { yes, no },
  openOrdersStatus: "VERIFIED",
  openOrders: [{ outcome: "YES" | "NO", side: "BUY" | "SELL", remainingQty }],
  capital: { collateralAvailable, capitalAtRisk },
  gas: { nativeBalance },
  drawdown: { status: "AVAILABLE", ratio } | { status: "UNAVAILABLE" }
}
```

The structured output includes:

- `state`, `permissions`, `allowedActions`, and `cancelExisting` recommendation;
- `maxAdditionalExposure` for UP, DOWN, gross outcome, and capital-at-risk limits;
- `sizeMultiplier`, `primaryReasonCode`, `triggeredRules`, warnings, and stable explanations;
- `authoritativeTime`, including chain time and `timeRemainingSec`;
- current and worst-case binary exposure facts;
- the model summary and reference source/scale;
- `governorVersion` and `configurationVersion`.

## Rule precedence and fail-closed behavior

Reason codes are stable machine-readable identifiers. They are sorted by a
central precedence list so the same malformed snapshot always reports the same
primary reason. Multiple triggered rules remain in `triggeredRules`.

The hard gates include:

- `FAIR_VALUE_INVALID`, `MODEL_CONFIDENCE_LOW`, and `MODEL_DATA_QUALITY_LOW`;
- `CHAIN_TIME_INVALID` or `CHAIN_TIME_STALE`;
- `PRICE_INVALID`, `PRICE_STALE`, `PRICE_TIMESTAMP_FUTURE`, or
  `PRICE_TIMESTAMP_NON_MONOTONIC`;
- `REFERENCE_INVALID`, `REFERENCE_AMBIGUOUS`, or
  `REFERENCE_SCALING_UNSUPPORTED`;
- `MARKET_STATUS_INVALID`, `MARKET_NOT_TRADING`, `EXPIRY_INVALID`,
  `MARKET_EXPIRED`, or `EXPIRY_TOO_CLOSE`;
- `OPEN_ORDER_STATE_INVALID` or `EXPOSURE_INVALID`;
- directional, gross, capital-at-risk, collateral, gas, drawdown, and any
  explicitly configured emergency-volatility hard rule.

The exact boundary is intentional: expiry uses
`market.expirySec - chainTime.chainNowSec`, never the workstation clock. A
workstation that is ten minutes ahead or behind does not alter a decision when
the chain observation is unchanged. A stale chain observation does halt.

## Binary exposure math

For inventory `(YES, NO)`:

```text
completeSets   = min(YES, NO)
directionalUp  = max(YES - NO, 0)
directionalDown = max(NO - YES, 0)
grossOutcome   = YES + NO
```

Example: 12 YES and 10 NO means 10 complete sets and 2 residual UP tokens.
It is not a 22-token directional UP position.

For open orders, the conservative stress case assumes every remaining
risk-increasing BUY fills and no SELL fills. This means a resting BUY_YES or
BUY_NO counts toward worst-case exposure even before it fills. A resting SELL
is still validated and reported, but cannot be relied on as protection. If the
chain-head order ids and the indexer’s YES/NO classification cannot be
reconciled, the live collector marks the order state ambiguous and the
governor halts.

## Capital, gas, and drawdown boundary

The governor consumes capital facts; it does not invent portfolio accounting.
`capitalAtRisk` and `drawdown.ratio` are inputs from an accounting/state layer.
The Phase 2B live snapshot can verify current collateral, native balance,
inventory, and open orders, but it does not yet calculate historical equity,
realized PnL, unrealized PnL, or a session high-water mark. It therefore passes
`drawdown: { status: "UNAVAILABLE" }`, emits `DRAWDOWN_UNACCOUNTED`, and uses the
explicit MVP policy `requireDrawdownAccounting: false`. A strict operator can
set it to `true`, which fails closed with `DRAWDOWN_INVALID` until accounting is
available.

This is a declared boundary, not a hidden zero. Phase 2C/quoting work must not
interpret an `ALLOW` with `DRAWDOWN_UNACCOUNTED` as proof that drawdown risk is
zero.

## Reference and scaling

The collector reuses the Phase 2A resolver. A non-zero market strike is the
reference source `strike`; `strike = 0` requires `getOpeningPrices(marketId)`
and becomes source `opening`. The resolver records the selected raw power of
ten from 0 through 18 and refuses a candidate more than 2x from current spot.
The risk input must carry `status: "VALID"`, source, and the selected exponent.
Missing, ambiguous, unsupported, or mismatched reference facts halt.

## Live command

```bash
npm run risk
```

The command uses `node --env-file=.env` only for public endpoint/account names.
It does not read `OPERATOR_PRIVATE_KEY`, create a signer, or send a transaction.
It discovers a live BTC market, verifies on-chain `Trading`, reads chain time,
resolves the reference, reads price/history, reads balances and reconciled open
orders, evaluates the governor, then fetches the YES book for a clearly marked
comparison-only midpoint. `cancelExisting` is printed as a recommendation and
is never executed.

## Validation and limitations

The pure suite contains 50 Phase 2B tests and covers healthy decisions, exact
thresholds, deterministic output, local clock offsets, stale/future feeds,
ambiguous references, market status/expiry, model quality, complete sets,
directional residuals, pending orders, all three decision states, capital/gas,
drawdown, volatility, configuration, and fail-closed malformed input.

The live proof is a read-only Shannon snapshot. Historical risk performance is
not claimed: there is not yet a reliable historical reconstruction of VILLA
positions, open-order states, and drawdown accounting. Scenario tests are the
appropriate validation for this phase.

Known limitations:

- The governor is off-chain; it can stop the VILLA process but cannot enforce a
  hard limit inside DreamDEX.
- The live snapshot’s drawdown accounting is intentionally unavailable.
- The indexer is needed to classify a binary open order as YES or NO; any
  chain/indexer mismatch halts rather than guessing.
- The current implementation does not quote, place, cancel, fill, redeem, or
  connect to a dashboard.
