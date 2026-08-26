# Architecture notes

Based only on verified capabilities. No frontend. No invented SDK methods.

## Layers

```
Operator dashboard (not built)
  -> villa engine (our code; Phase 2B, no writer yet)
       collector | fair-value | governor | quoting | lifecycle
    -> @somnia-chain/markets-sdk 0.28.1  (installed)
         unified: loadMarkets, fetchOrderBook, fetchPrice, fetchPriceOHLCV,
                  createOrder, cancelOrder, mintSet, burnSet, redeem,
                  fetchOpenOrders, fetchMyTrades
         client:  getMarketOnchain, listBinaryMarkets, getOutcomeBalance,
                  getOpeningPrices, getErc20Balance, getOwnOpenOrdersOnchain,
                  getOrderOnchain
         trader:  raw bigint place/redeem/faucet
      -> Shannon RPC + indexer GraphQL + price-feed GraphQL
        -> BinaryMarketsModule / BinaryPool / OutcomeToken6909 / BinarySettlement / OracleHub
```

Spot HTTP API, CCXT, Bot Builder, and `@dreamdex-bot-kit/core` (spot) are **out of this diagram**.

## What the official kit already is

Cloned to `.scratch/dreamdex-bot-kit` (gitignored). Event Contract half:

| Piece | What it actually does (from source, not README slogans) |
| --- | --- |
| `packages/ec-core` | Venue scope, on-chain status gate, bigint `placeLimit`, mint seed, claim sweep, inventory, shutdown cancel |
| `ec-maker` | Two-sided post-only around **book mid or 0.5**; inventory cap skips a side; `maybeClaim` each loop |
| `ec-oracle-follow` | **Directional taker**. Strike/opening + spot → pUp; trades the tilt vs the book. Not a maker desk |
| `ec-settlement` | Watch one market or `CLAIM=1` sweep Finalized |
| `ec-passive` | One resting bid |
| `ec-laddering-bot` | Probability ladder; follows windows |
| `ec-starter` | Cross a resting quote (taker hello-world) |
| Spot `session-keys.md` | **Spot** `placeOrderFor` + vault. Not used by `ec-core` |

Reusable **ideas** (reimplement against 0.28.1, do not fork the kit into the product):

- Gate on `getMarketOnchain().status === 1`
- Scope `VENUE_ID` from a live row
- Integer tick/lot placement
- `listBinaryMarkets({ status: "Finalized" })` for claims
- `getOpeningPrices` when `strike === "0"`
- Mandatory order expiry
- Cancel tracked ids on shutdown because the indexer lags

Not reusable as VILLA:

- `fairYes = mid or 0.5`
- Directional `ec-oracle-follow` as the product
- Spot operator registry
- Kit Railway/Telegram packaging

## Where VILLA begins

Above that plumbing:

1. **Fair-value engine** — own p(Up) from verified inputs (spot, reference/strike or opening, τ, vol, maybe more). Not the book mid.
2. **Adaptive quoting** — spread/size/skew from value, inventory, vol, τ, confidence, operator limits.
3. **Risk governor** — deterministic refuse/halt with named reasons.
4. **Capital lifecycle orchestration** — mint/escrow → quotes → fills → redeem → next `marketId`, visible to the operator.
5. **Operator dashboard** — the UX the hackathon scores.

## Module sketch (jobs, not files yet)

| Module | In | Out | I/O |
| --- | --- | --- | --- |
| collector | venue config | MarketSnapshot (on-chain status, book, spot, opening/strike, τ, balances, open orders) | SDK reads |
| fair-value | current price + reference + τ + realized-vol stats + freshness | `{ pUp, pDown, confidence, dataQuality, inputsUsed }` | pure |
| governor | normalized snapshot + limits | `{ state, permissions, reasons, exposure budgets }` | pure |
| quote-planner | permission + pUp + inventory + pending orders + raw grid | adaptive YES bid/ask plan | pure |
| execution (future) | approved quote plan + fresh book | post-only orders / cancels | SDK writes |
| lifecycle | Finalized list + holdings | redeems + new marketId | SDK writes/reads |
| dashboard | all of the above | operator view | later |

Load-bearing risky module to prove first: **collector + one real post-only round-trip**, then a **pure fair-value + governor** with fixtures (no network).

## Phase 2A fair-value boundary

`src/fair-value/model.mjs` is the load-bearing Phase 2A core. It uses the
`villa-fv-v1` zero-drift log-return digital formula and accepts no order-book
midpoint field. `src/fair-value/live.mjs` is the separate read-only collector:
it reads `client.fetchPriceFeedInfo`, `client.fetchPriceHistory`, and
`getOpeningPrices`, then passes facts into the pure function. The snapshot reads
the YES book only after pricing so the midpoint can be shown as comparison-only.

The model returns a data-quality score/status rather than treating probability
extremity as confidence. No wallet, inventory, PnL, governor, or order-control
dependency is present. A future governor may reject a high-quality fair value;
that is a separate decision layer.

## Phase 2B risk boundary

`src/risk-governor/governor.mjs` is the Phase 2B decision core. It is pure and
versioned as `villa-risk-v1`: normalized facts in, `ALLOW` / `REDUCE_ONLY` /
`HALT` plus permissions, exposure budgets, named reasons, warnings, and
authoritative chain-time facts out. It does not import the SDK, fair-value
collector, book reader, wallet, environment, or order-control code.

`src/risk-governor/exposure.mjs` owns binary YES/NO accounting. It pairs
complete sets before calculating current directional residuals, applies the
verified signed delta for all four binary order actions, and separately
stresses every pending order in the UP and DOWN directions. `src/risk-governor/live.mjs`
is the separate read-only collector: it reads the current block, market,
price/reference/history, ERC-6909 balances, collateral, gas, and reconciled
open orders, then passes a normalized snapshot to the pure core.

The Phase 2B data flow ends here:

```
Shannon / indexer / price feed
  -> read-only normalized snapshot
  -> pure villa-risk-v1 governor
  -> state + permissions + reasons + limits
```

The book midpoint is fetched after the decision in `scripts/risk-snapshot.mjs`
and is printed as comparison-only. The governor does not receive it. The
`cancelExisting` field is a recommendation only; no cancellation or other
transaction is reachable from the snapshot command.

## Phase 3 quote-planner boundary

`src/quote-planner/planner.mjs` is the pure `villa-quote-v1` planning layer.
It consumes the fair-value result, the governor's already-computed state and
permissions, normalized YES/NO inventory, verified pending orders, exact raw
tick/lot/minimum parameters, collateral, and an optional YES book. It returns
an `ACTIVE`, `ONE_SIDED`, or `NO_QUOTE` plan with raw/human prices and sizes,
skew/spread/size components, projected Phase 2B exposure, and stable reasons.

The Phase 3 data flow is:

```
read-only market/feed/account/book acquisition
  -> pure villa-fv-v1
  -> pure villa-risk-v1
  -> pure villa-quote-v1
  -> structured plan only
```

The planner has one YES book. It never invents a DOWN book, never uses the
DreamDEX midpoint as a pUp input, never assumes minting or opposing fills, and
never sends a transaction. `scripts/quote-snapshot.mjs` is the separate
read-only assembler. A future writer may consume a plan only after the
remaining lifecycle and execution gates are designed.

## On-chain vs off-chain

On-chain: orders, escrow, ERC-6909 positions, settlement, redeem.

Off-chain: model, governor, limits, reasons, UI.

Order `expireTimestampNs` is the on-chain safety net if off-chain dies.

## Data identity

Always `marketId` (and the on-chain snapshot taken for that pass). Never persist `pool` as the market.

## Failure modes the architecture must absorb

- Indexer lag (status, trades, open orders)
- `PostOnlyWouldCross`
- Empty book (still must have a value)
- Stale price feed
- Window lock between read and send
- Venue id change
- Decimal/tick grid (6dp testnet vs 18dp mainnet — even though we will not ship mainnet)
- Voided markets (redeem both sides)
- Losing redeem succeeds and pays 0
- Two processes, one key (nonce) — one writer loop only
- Missing or ambiguous drawdown accounting — explicit warning in the Phase 2B
  testnet snapshot, strict mode can fail closed
- Chain/indexer mismatch while classifying open orders — fail closed rather than
  guessing whether an order is YES or NO
- Pending SELLs that break complete sets — all four signed order deltas are
  included in one-sided worst-case directional stress; opposing orders are not
  netted optimistically
- Reduce-only overshoot — the pure order assessment caps a reducing action at
  neutral and rejects a quantity that would cross into the opposite direction
- Adaptive-quote constraints — higher ordinary volatility widens rather than
  halts; lower confidence and near-expiry reduce size; HALT remains an
  absolute no-quote state
- Real YES inventory — `SELL_YES` is disabled/capped from actual outcome
  balance and existing YES asks reserve their quantity; pending BUYs do not
  create sell inventory
- Post-only price safety — raw integer tick arithmetic keeps BUY_YES at least
  one tick below best ask and SELL_YES at least one tick above best bid; an
  impossible side is disabled rather than crossed

## Phase 4A complete-set inventory boundary

`src/inventory-lifecycle/index.mjs` is pure `villa-inventory-v1` arithmetic.
`scripts/verify-inventory-lifecycle.mjs` is the separate I/O adapter that
discovers a clean Trading market, reads ERC-6909/tUSDC/STT/open-order state,
and performs one bounded mint → SELL_YES rest → exact cancel → burnSet
verification. The quote planner remains a plan-only layer; this verifier is not
a live quoting loop and does not consume planner output.

The Shannon observation showed that a resting SELL_YES escrowed its tokens out
of the visible ERC-6909 balance. The execution adapter must reconcile visible
free balance and pending commitments according to the live venue semantics,
not blindly subtract the same commitment twice. A complete set keeps
`D = YES - NO = 0`; the governor's pending SELL stress still matters because a
filled SELL_YES can break that set.

`burnSet` is a pre-settlement pair burn. Settlement `redeem` remains a
separate lifecycle phase implemented by `src/settlement/`. It never reuses
`burnSet` as a settlement substitute.

## Phase 5A settlement boundary

`src/settlement/index.mjs` is pure `villa-settlement-v1` state classification,
explicit YES/NO redemption planning, payout-vector arithmetic, idempotency, and
raw-value reconciliation. `src/settlement/live.mjs` and
`scripts/verify-settlement.mjs` are the bounded chain adapter:

```
current Trading market + one complete-set mint
  -> chain-time watch through expiry
  -> on-chain Resolved or Voided state
  -> explicit SDK redeem by marketId + outcomeIdx
  -> per-leg receipt/balance evidence
  -> payout and separate STT-gas reconciliation
```

The adapter uses `listBinaryMarkets({ status: "Finalized" })` for historical
rediscovery and claim sweeps because normal `loadMarkets()` is not a reliable
settled-market source. Resolved losers are not submitted as redeems; their
zero-value residual is labelled explicitly. Voided markets plan both outcome
legs. A bounded timeout records `SETTLEMENT_PENDING` and preserves the pair.
There is no successor-market selection or rollover in Phase 5A.

## Phase 4B bounded execution boundary

Phase 4B adds `villa-execution-v1` as a narrow I/O adapter around the existing
pure layers:

```
live chain/feed/indexer/book/account reads
  -> villa-fv-v1
  -> villa-risk-v1
  -> villa-quote-v1
  -> execution preflight
  -> one serialized writer queue
  -> exact on-chain/indexer reconciliation
  -> exact cancellation and safe pair cleanup
```

The adapter is one-shot and bounded. It chooses one current BTC Trading market,
uses the minimum complete set only when the planner needs a YES ask, caps each
target to one valid lot for the verifier, places ASK then BID with a fresh
pipeline pass before each write, and cancels only its recorded order IDs. A
HALT, `NO_QUOTE`, stale decision, unsafe expiry, invalid feed, unverified open
orders, grid error, or post-only crossing refusal stops new writes. The quote
planner and governor remain usable without the writer and have no wallet or
transaction dependency.

The midpoint is carried in session facts as comparison-only. It is not an
input to fair value, governor state, planner centre, or target price.
