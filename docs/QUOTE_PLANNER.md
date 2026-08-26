# VILLA adaptive quote planner

## Plain-English description

The quote planner answers a narrower question than the risk governor:

> Given what VILLA thinks UP is worth, what resting YES bid and YES ask would
> be sensible, and what size is safe to propose right now?

It is for the liquidity-provider/operator, not for a consumer betting screen.
DreamDEX remains the venue and its YES book remains the execution surface.

VILLA supplies the centre of the quote from `villa-fv-v1`. It then moves that
centre away from a directional inventory imbalance, puts a configurable
half-spread around it, and reduces size when uncertainty or expiry conditions
make a large quote less appropriate. The planner can be two-sided, one-sided,
or refuse to quote.

The planner does not use the DreamDEX midpoint to calculate `pUp`. The book is
used only for comparison and post-only safety: a YES bid must remain below the
best YES ask, and a YES ask must remain above the best YES bid. A changed book
can therefore clip or disable an order without changing VILLA's fair value.

`pUp` and `pDown` are probabilities. Confidence is different: it is the
quality of the fair-value data. Low confidence widens and reduces a quote;
the governor, not this planner, decides whether confidence is low enough to
halt.

The planner refuses to produce an actionable side when the governor is
`HALT`, when data or grid parameters are malformed, when a bid would violate
collateral reserve, when an ask has no real YES inventory, when a quantity is
below the venue minimum, or when the proposed order would breach the
conservative pending-order exposure limits. It never assumes a mint, fill, or
opposing order will happen first.

## Scope and version

- Planner version: `villa-quote-v1`.
- One binary YES book: `BUY_YES` is the bid and `SELL_YES` is the ask.
- `pDown = 1 - pUp`; no second DOWN book is invented.
- Pure core: no RPC, SDK, GraphQL, wallet, environment, clock, or writes.
- This phase returns a plan only. It does not place, cancel, mint, or replace.

The official `ec-maker` was inspected as a reference. It already supplies
post-only maker plumbing, a fixed spread around book mid, inventory checks,
on-chain status gates, and lifecycle cleanup. VILLA does not copy its book-mid
pricing. The value/skew/spread/size/governor/explainability layer here is the
product edge above that plumbing.

## Inputs

The core receives normalized data:

| Input | Meaning |
| --- | --- |
| `fairValue` | `pUp`, `pDown`, confidence, quality, `realizedVolPerSqrtSec`, model version, and optional model horizon |
| `governor` | `ALLOW`, `REDUCE_ONLY`, or `HALT`; permitted actions; size multiplier; directional/gross hard limits; risk capacity; reasons and warnings |
| `inventory` | YES and NO balances, plus the YES amount actually available to sell |
| `pendingOrders` | Existing normalized binary orders. BUY and SELL orders are retained independently |
| `book` | Optional raw best YES bid and ask. Empty books are valid |
| `grid` | Decimal places and raw `one`, tick, lot, and minimum quantity values |
| `capital` | Available collateral and the collateral reserve, in human or raw units |
| `market` | Stable `marketId`, authoritative remaining seconds, and optional raw price bounds |
| `quote` | Operator base quantity in raw or human units |

The grid is read-only per market from the installed SDK's
`getBinaryBookParams`: `tickSize`, `lotSize`, and `minQuantity`. The collateral
unit is derived from the market's decimal precision. No hardcoded 6-decimal
assumption is used in the pure core.

## Centre and inventory skew

Let:

```text
D = YES - NO
C = governor directional risk capacity
r = clamp(D / C, -1, +1)
inventorySkew = -r × maxInventorySkew
effectiveCenter = clamp(pUp + inventorySkew, priceMin, priceMax)
```

`D > 0` means VILLA is long UP, so the centre moves down and makes future
YES exposure less eager. `D < 0` moves it up. The adjustment is bounded by
`maxInventorySkew` and is relative to configured risk capacity, not an
arbitrary token count. `D = 0` produces exactly zero skew.

The default v1 policy has `maxInventorySkew = 0.05`, or five probability
points at the configured capacity boundary.

## Adaptive spread

The fair probability is not changed by this step. The half-spread is:

```text
m              = realizedVolPerSqrtSec × sqrt(timeRemainingSec)
expiryFactor   = clamp((expiryReferenceSec - timeRemainingSec)
                       / expiryReferenceSec, 0, 1)
confidenceFactor = clamp((idealConfidence - confidence)
                         / (idealConfidence - confidenceFloor), 0, 1)

halfSpread = min(maxHalfSpread,
                 baseHalfSpread
                 + volatilitySpreadMultiplier × m
                 + maxExpiryHalfSpreadAdd × expiryFactor
                 + maxConfidenceHalfSpreadAdd × confidenceFactor)
```

v1 defaults are:

| Parameter | Value |
| --- | ---: |
| `baseHalfSpread` | `0.02` |
| `volatilitySpreadMultiplier` | `1` |
| `expiryReferenceSec` | `300` |
| `maxExpiryHalfSpreadAdd` | `0.015` |
| `idealConfidence` / `confidenceFloor` | `0.90` / `0.75` |
| `maxConfidenceHalfSpreadAdd` | `0.01` |
| `maxHalfSpread` | `0.25` |

The volatility input is already in per-square-root-second units from the
fair-value path, so `m` is a dimensionless expected log-move over the remaining
seconds. Higher ordinary volatility widens the quote; it does not by itself
halt. Near expiry widens the quote and reduces size while the governor still
permits trading. The governor's expiry rule has precedence.

The theoretical prices are:

```text
bid = effectiveCenter - halfSpread
ask = effectiveCenter + halfSpread
```

They are clamped to the binary probability grid before post-only checks.

## Size and constraints

The base quantity is scaled by the minimum of:

```text
governor size multiplier       (ALLOW only; REDUCE_ONLY keeps reducing size possible)
confidence size factor         1 - (1 - minSizeFactor) × confidenceFactor
volatility size factor         1 / (1 + volatilitySizeMultiplier × m)
expiry size factor             1 - expirySizeReduction × expiryFactor
```

The resulting raw quantity is rounded down to `lotSize`. The planner then
caps a bid by the exact collateral cost:

```text
buyCostRaw = ceil(priceRaw × quantityRaw / oneRaw)
buyCostRaw + collateralReserveRaw <= collateralAvailableRaw
```

An ask is capped by real `YES` inventory after existing `SELL_YES` orders have
reserved their remaining quantity. The planner never treats pending BUYs as
already-held inventory and never invents a mint.

For every candidate, the planner calls the Phase 2B exposure accounting with
the existing pending orders plus the candidate. For two-sided output, it also
checks the combined bid and ask without netting them. A pending BUY can fill
in an UP stress case, while a pending SELL can break a complete set in a DOWN
stress case. The plan is rejected or sized down if directional or gross hard
limits would be reached.

`REDUCE_ONLY` is absolute:

- `D > 0`: only `SELL_YES`, capped before neutral;
- `D < 0`: only `BUY_YES`, capped before neutral;
- `D = 0`: no directional quote;
- `HALT`: no quote at all.

The planner also honours the governor's explicit `allowedActions` array.

## Exact rounding and post-only safety

Raw quantities and prices are decimal strings in the JSON-shaped output so
they are not silently changed by JSON's number conversion. Prices are snapped
with integer arithmetic:

- bid: floor to `tickSize`;
- ask: ceil to `tickSize`;
- bid post-only ceiling: `bestAskRaw - tickSize`;
- ask post-only floor: `bestBidRaw + tickSize`.

If no valid grid price remains, that side is disabled with
`POST_ONLY_CONSTRAINT` or `PRICE_BOUND`. If both sides are enabled, the final
bid is strictly below the final ask. Empty books use the fair-value-driven
prices without inventing a midpoint.

## Output

`planQuotes()` returns:

- `plan`: `ACTIVE`, `ONE_SIDED`, or `NO_QUOTE`;
- `plannerVersion` and stable `marketId`;
- fair-value facts with `pUp`, `pDown`, confidence, quality, and model version;
- `center`: fair centre, signed inventory skew, effective centre, `D`, and capacity;
- `spread`: base, volatility, expiry, confidence, final half-spread, and factors;
- `size`: base raw quantity and all size factors;
- `governor`: state, allowed actions, triggered rules, and warnings;
- `bid` and `ask`: enabled flag, action, human/raw price and quantity, collateral or inventory facts, projected exposure, structured rationale, reason codes, and skip reason;
- top-level reason codes and warnings.

The core returns a structured `NO_QUOTE` for bad ordinary inputs rather than
defaulting to `pUp = 0.5`. A 50/50 value can only come from the supplied
fair-value result; it is never a broken-data fallback.

## Known limitations

`villa-quote-v1` is an explainable policy baseline, not a profitability claim.
It does not learn spread parameters, predict fills, model queue position,
estimate adverse selection, account for PnL/drawdown itself, or control an
order loop. It does not decide whether to trade; the risk governor decides
permissions. The live snapshot is intentionally one read-only pass and may
show no ask when the disposable operator has no YES inventory.
