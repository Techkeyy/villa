# VILLA fair-value model

## In plain English

VILLA estimates one question for a binary DreamDEX Event Contract:

> What is the probability that the underlying asset finishes at or above this market's settlement reference when the window expires?

For a BTC contract, it uses the current BTC price, the contract's reference price, the seconds remaining, and how much BTC has actually moved in recent underlying-price observations. It does not use the DreamDEX order-book midpoint to form that estimate. The midpoint is a separate comparison so the operator can see where VILLA differs from the venue.

`pUp = 0.225` means VILLA's baseline estimate is a 22.5% chance that UP wins. `pDown` is always `1 - pUp`.

Confidence is different. A 22.5% estimate can have high data quality, while a 50/50 estimate can have low data quality. VILLA's confidence score describes the freshness and coverage of the inputs: price age, history length, observation spacing, volatility stability, and how far the model must extrapolate the observed history. It is not a second prediction and is not `pUp` expressed as a percentage.

VILLA refuses to produce a tradeable result when the reference, current price, time, freshness, or volatility history cannot be established safely. It never substitutes `0.5` for broken data.

## Model version

`villa-fv-v1`

The version is part of every structured result. Future changes must use a new version or explicitly preserve the meaning of this one.

## Baseline formula

VILLA uses a zero-drift log-return digital model:

```text
r(T) ~ Normal(0, σ × sqrt(τ))

z    = ln(S / K) / (σ × sqrt(τ))
pUp  = Φ(z)
pDown = 1 - pUp
```

Where:

- `S` is the current underlying price in human price units;
- `K` is the settlement reference in the same units;
- `τ` is remaining time in seconds;
- `σ` is realized log-return volatility per square-root second;
- `Φ` is the standard normal CDF.

This is a deliberately small, explainable baseline. “Zero drift” means VILLA does not claim a directional expected return from a short BTC history. It models the remaining uncertainty around the current price instead. At exactly zero time, settlement is discrete: UP is 1 when `S >= K`, otherwise 0.

The model was selected because it is deterministic, unit-checkable, monotone in moneyness, and directly maps the three required economic inputs—distance from reference, time, and uncertainty—to a digital outcome probability. It avoids both circular book-following and a fitted parameter set that a tiny testnet sample could not justify.

## Volatility estimator

The read-only collector uses the installed `@somnia-chain/markets-sdk@0.28.1` `client.fetchPriceHistory(asset)` path. The SDK returns underlying price points newest first; VILLA reverses them into chronological order.

For each valid adjacent pair:

```text
r_i  = ln(P_i / P_(i-1))
Δt_i = t_i - t_(i-1)       (seconds)
σ    = sqrt(Σ r_i² / Σ Δt_i)
```

The estimator is realized variance per elapsed time, not annualized volatility. Its unit is `1 / sqrt(second)`. The model's remaining move `σ × sqrt(τ_seconds)` is dimensionless. This prevents the common error of passing per-minute or annualized volatility into a seconds-based formula.

The live path requires at least 12 positive-time returns and 60 seconds of elapsed history. It rejects negative or invalid timestamps, unordered points, stale history, gaps over 180 seconds, malformed prices, and a zero-volatility series. Repeated timestamps are collapsed to the newest price; repeated prices over positive time add elapsed time but zero squared return. The result also records maximum gap, maximum absolute log return, and an outlier ratio for data-quality scoring.

## Reference / opening-price resolution

The market is identified by `marketId`, never by a recycled pool address.

- A non-zero `strike` is treated as the fixed settlement reference.
- `strike = "0"` means the opening price must be read with the SDK's `getOpeningPrices([marketId])` call.
- The market question text is never parsed.

The SDK describes the raw strike/opening values as integers in the oracle price scale, while live price-feed values are human units and the row does not expose the exponent. VILLA follows the current official `ec-oracle-follow` compatibility rule: test powers of ten `10^0` through `10^18`, choose the candidate closest to current spot in log space, and refuse if the candidate is farther than a factor of two from spot. The chosen `scaleExponent10` and log distance are returned as structured facts, so the scaling decision is visible and auditable. A value that cannot be safely resolved is a refusal, not a guess.

## Data quality and confidence

The pure core requires:

- price age no more than 15 seconds;
- a valid `strike` or `opening` reference source;
- at least 12 volatility returns;
- at least 60 seconds of volatility coverage;
- no observation gap over 180 seconds;
- finite, positive volatility for a market with time remaining.

The score is a deterministic weighted combination of:

- 30% price freshness;
- 20% volatility sample count;
- 15% volatility time coverage;
- 10% observation spacing;
- 10% volatility stability from the outlier ratio;
- 15% horizon coverage, which lowers quality when the expiry is far beyond the observed history.

`HIGH` is a score of at least 0.80, `MEDIUM` is at least 0.60, and lower values are `LOW`. Warnings such as `VOLATILITY_OUTLIER`, `SHORT_VOL_COVERAGE`, and `LONG_HORIZON_EXTRAPOLATION` remain attached to the result even when the core can still calculate.

The price-feed's oracle write timestamp is used for freshness, and a source-data age over 60 seconds is refused. Shannon's chain clock was observed ahead of the workstation clock during the live check; the snapshot uses the latest chain timestamp for history/expiry math and reports the offset as a warning rather than misclassifying a fresh observation as stale.

## Structured output

The core returns:

- `modelVersion`, `pUp`, and `pDown`;
- `confidence`, `dataQualityStatus`, quality factors, and warnings;
- current underlying price and reference price/source;
- relative and log distance from reference;
- seconds remaining;
- realized volatility, observation count, and elapsed coverage;
- remaining log move and normalized distance `z`;
- an explicit `inputsUsed` list containing no book midpoint.

The fair-value core has no dependency on wallet balances, inventory, PnL, drawdown, capital limits, RPC, GraphQL, or order placement. Those belong to later collector/governor/quoting layers.

## Fail-closed states

The model refuses with a structured error for missing or invalid current price, missing/invalid/zero reference, expired time, stale price, insufficient or malformed volatility history, unusable observation gaps, unsupported reference source, non-finite calculations, and a remaining move that indicates mixed time/volatility units. `0.5` is therefore a genuine model output at neutral moneyness, not an error sentinel.

## Validation

The deterministic suite covers neutral, above/below reference, strong moneyness, high/low volatility, long/short/near-expiry behavior, bounds, complementarity, determinism, monotonicity, unit conversions, stale data, missing/zero reference, insufficient history, malformed ticks, gaps, and book-midpoint independence.

Historical Event Contract outcomes and aligned underlying snapshots were not reconstructed reliably enough in this phase to claim a Brier score, log loss, calibration, or trading edge. No historical sample size or performance metric is invented. The live check and scenario suite are correctness/sanity validation only.

## Known limitations

- The zero-drift assumption is a baseline, not a claim that BTC has no real drift.
- Realized volatility is backward-looking and can be unstable around news or feed changes.
- A long expiry relative to the observed history is explicitly warned and receives lower data-quality weight; the model is not fitted to that horizon.
- Oracle freshness and chain-clock handling depend on the verified SDK feed metadata and can refuse if that source is unavailable.
- The heuristic raw-scale resolver is required by the current market-row shape; it is guarded by a proximity bound and exposes its exponent. A future SDK field with an explicit scale should replace the inference.
- This phase calculates value only. It does not decide whether to trade, quote, skew inventory, halt, or manage capital.
