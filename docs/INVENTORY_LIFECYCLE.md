# VILLA complete-set inventory lifecycle

## Plain-English purpose

DreamDEX binary Event Contracts have two outcome tokens: YES and NO. A
complete set is one YES plus one NO backed by one unit of collateral. VILLA can
mint that pair when it needs sellable outcome inventory, and can burn an equal
pair back into collateral while the market is still unresolved.

This phase proves only the smallest controlled SELL path. VILLA mints one
minimum valid set, verifies both outcome balances, posts one tiny post-only
`SELL_YES` using only that YES, verifies that it rests without a fill, cancels
that exact order, then burns the paired YES+NO. It is lifecycle plumbing, not a
quote loop or a profitability claim.

`burnSet` is not settlement redemption. `burnSet` destroys equal YES and NO
before resolution and returns collateral. `redeem` is the separate
post-resolution path for a winning outcome.

## Version and boundaries

- Pure helper version: `villa-inventory-v1`.
- Pure helpers: `src/inventory-lifecycle/index.mjs`.
- Live verifier: `scripts/verify-inventory-lifecycle.mjs`.
- Dry run: `npm run verify:inventory:dry`.
- Wet verifier: `npm run verify:inventory`.
- No planner output is connected to this writer.
- No fill is intentionally taken, no broad cancellation is performed, and no
  settlement/redeem path is exercised.

The live script discovers a current BTC binary market from the SDK, reads a
chain-head timestamp, requires on-chain `Trading` status and at least ten
minutes of headroom, scans current BTC pools for active operator orders, and
refuses to continue if any are present. It then uses the selected market's
on-chain `tickSize`, `lotSize`, and `minQuantity`.

## Pure accounting contract

All amount and price decisions use integer raw units:

- `minimumMintAmount` chooses the smallest positive lot-aligned amount at or
  above the book minimum.
- `expectedBalancesAfterMint` requires YES and NO to increase by exactly the
  mint amount.
- `completeSetExposure` reports `min(YES, NO)` and `D = YES - NO` separately.
- `committedSellQuantityRaw` sums only matching `SELL_YES` commitments.
- `sellCapacityRaw` handles both observed balance semantics: whether a resting
  SELL remains visible in the token balance or is escrowed out of it.
- `selectRestingSellPrice` keeps the ask strictly above the best bid and on the
  exact tick grid; it fails closed if no safe tick exists.
- `safeOrderExpiryNs` uses chain time and caps order expiry below market expiry.
- `burnableMintedAmount` burns only the controlled mint increment, never a
  pre-existing baseline balance.

The helpers do not read RPC, GraphQL, environment variables, wallet state, or
the order book. The verifier owns all I/O and passes raw observations in.

## SDK and reference implementation findings

Installed `@somnia-chain/markets-sdk@0.28.1` is authoritative for this phase:

- `Trader.mintSet({ pool, amount })` deposits collateral and mints equal YES
  and NO to the signer. `src/binary/sets.ts` auto-approves collateral to the
  pool by default when allowance is short.
- `Trader.burnSet({ pool, amount })` burns equal YES and NO. The same source
  auto-ensures the pool's operator approval on the outcome-token singleton by
  default.
- `Trader.placeOrder` accepts `SELL_YES` and `ORDER_TYPE.POST_ONLY` with raw
  price, raw quantity, and nanosecond expiry.
- `getOrderOnchain` exposes `isBid`, `owner`, `price`, and
  `quantityRemaining`; after cancellation it returns no active order.
- `getOutcomeBalance` reads ERC-6909 balances for the market's `yesId` and
  `noId`.

The official `ec-core` reference uses `SELL_YES` for a YES ask and checks held
outcome inventory before placement. VILLA adopts the plumbing facts but keeps
the complete-set accounting, exact raw checks, bounded cancel, and burn
cleanup in its own lifecycle layer.

## Live Shannon evidence — 2026-08-26

The read-only dry run and the wet run selected the same BTC 24-hour Trading
window (`marketId` ending `9a4f`) with roughly 23 hours of chain-time
headroom. The wallet was clean at baseline: tUSDC `100000000` raw, YES `0`, NO
`0`, and zero active orders across the scanned BTC pools.

The selected grid was:

| Field | Raw value |
| --- | ---: |
| decimals | 6 |
| tick size | 1000 |
| lot size | 1000 |
| minimum quantity | 1000 |
| controlled mint / SELL quantity | 1000 (`0.001`) |

Observed sequence:

1. `mintSet`: collateral changed from `100000000` to `99999000`; YES and NO
   each became `1000`; `D = 0`; the exposure layer reported no directional
   stress and no pending orders.
2. `SELL_YES`: post-only ask at raw price `535000` (`0.535`), ten ticks above
   the observed best bid `525000` and below the observed best ask `555000`.
   The on-chain order had `isBid=false`, the operator owner, price `535000`,
   remaining quantity `1000`, and zero fills. The indexer reported the same
   order as `YES` / `SELL`.
3. Resting inventory semantics: visible YES changed from `1000` to `0` while
   the order committed `1000`. The token was escrowed out of the visible
   ERC-6909 balance, so VILLA must not subtract the committed amount a second
   time in this state. After cancellation, visible YES returned to `1000`.
4. Exact cancel: the order disappeared from the chain active read and the
   reconciled open-order read; YES and NO remained `1000`; fills stayed zero.
5. `burnSet`: the exact paired `1000` YES + `1000` NO was burned. Final YES and
   NO returned to `0`, final tUSDC returned to `100000000`, and the selected
   market had zero active orders.

Transaction evidence:

| Action | Shannon transaction |
| --- | --- |
| mint | `0x5e96147119e2b5c41305819903499fc7efc8fc75366893eae59b98360269e15d` |
| SELL_YES | `0xca0a56e53913ee4ce4a65ab65a4ec5745ec95c4e2d8f6da15a6ba3e92c30ea42` |
| exact cancel | `0x3a0016826685680538cbfe5534ce76103b5abc5dcb86416c8c0e8417438d9792` |
| burnSet | `0xf9e20539095cc5c2f2b34cdc968b1bac1ac4126715cfb5f2abe635e0135f772d` |

The observed native balance moved from `49.992880118` STT to
`49.981358486` STT across the bounded lifecycle. This is gas usage, not
collateral loss. The verifier does not claim the gas cost is fixed.

## Failure and cleanup policy

The verifier refuses to proceed on missing signer configuration, an unclean
wallet, non-Trading or near-expiry market, unsupported decimals, insufficient
STT/tUSDC, invalid tick/lot/minimum values, ambiguous open-order reads, or an
unsafe post-only price. A `PostOnlyWouldCross` is retried only three times
with a fresh book and a more conservative park.

If wet mode fails after minting, cleanup can cancel only the exact recorded
order. It burns only when the controlled YES and NO increments are both still
complete and no target order remains. If the balance is partial or directional,
it refuses a blind burn and reports the stranded state for operator review.

No transaction is sent by dry mode, the pure helpers, the fair-value snapshot,
the risk snapshot, or the quote snapshot.
