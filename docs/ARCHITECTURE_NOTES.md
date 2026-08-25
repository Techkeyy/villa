# Architecture notes

Based only on verified capabilities. No frontend. No invented SDK methods.

## Layers

```
Operator dashboard (not built)
  -> villa engine (our code; not started)
       collector | fair-value | governor | quoting | lifecycle
    -> @somnia-chain/markets-sdk 0.28.1  (installed)
         unified: loadMarkets, fetchOrderBook, fetchPrice, fetchPriceOHLCV,
                  createOrder, cancelOrder, mintSet, burnSet, redeem,
                  fetchOpenOrders, fetchMyTrades
         client:  getMarketOnchain, listBinaryMarkets, getOutcomeBalance,
                  getOpeningPrices, getErc20Balance
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
| governor | snapshot + pUp + limits + pnl | `{ ok, haltReasons[], quoteCaps }` | pure |
| quoting | permission + pUp + inventory | post-only orders / cancels | SDK writes |
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
