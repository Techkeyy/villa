# Sources

Map claims to where they came from. Prefer current official implementation over older READMEs.

## Hackathon

| Claim | Source |
| --- | --- |
| Name, $5,000 USDso, virtual, repo+video required, testnet prototype, judging weights | https://dorahacks.io/hackathon/event-contracts/detail |
| Displayed deadline 2026-09-08 18:00, submission 2026-08-25 00:00 | same, plus listing https://dorahacks.io/hackathon/event-contracts |
| TZ conflict | Eventbrite https://www.eventbrite.com/e/event-contracts-hackathon-tickets-1998344868295 (secondary) |
| Telegram / STT pointer | DoraHacks Contact Us |
| STT faucet (interactive) | https://cloud.google.com/application/web3/faucet/somnia/shannon and https://testnet.somnia.network/ |
| Bot kit / docs / bot builder links | DoraHacks Developer Resources |

## DreamDEX / Somnia docs (fetched 2026-08-24)

| Claim | Source |
| --- | --- |
| SDK is the Event Contract surface; HTTP API is spot-only | https://docs.dreamdex.io/developers/event-contracts.md |
| Recipes: discover, book, mint, post-only, redeem Finalized, follow series | https://docs.dreamdex.io/developers/event-contracts/recipes.md |
| Four-contract family, mint-a-pair, recycle pools, statuses, reactivity settlement | https://docs.dreamdex.io/developers/event-contracts/market-structure.md |
| Addresses identical testnet/mainnet; tUSDC 6dp vs USDso 18dp; faucet cap 10_000 | https://docs.dreamdex.io/developers/event-contracts/contracts-and-addresses.md |
| 13 gotchas (indexer status, receipts, 0.28.0 tick grid, expiry ns, lot, venue, settled scan, …) | https://docs.dreamdex.io/developers/event-contracts/gotchas.md |
| Consumer: BTC/ETH 15m and 1h "today" | https://docs.dreamdex.io/trading/event-contracts.md — **stale vs live indexer** |
| Spot quick start / HTTP | https://docs.dreamdex.io/developers/quick-start.md — not EC |
| Docs index | https://docs.dreamdex.io/llms.txt |

## Installed SDK (authoritative for methods)

Path: `node_modules/@somnia-chain/markets-sdk/` version **0.28.1**.

| Claim | File |
| --- | --- |
| `SomniaMarkets` unified verbs | `src/unified/exchange.ts` |
| `mintSet` / `burnSet` / `redeem` | same + `src/binary/sets.ts` + `src/binary/settlement.ts` |
| Pool redeem removed in v2 | `src/tradeAbi.ts` comment |
| `placeBinaryOrder` / `placeBinaryOrderFor` | `src/tradeAbi.ts` |
| Spot operator registry is SPOT-ONLY | `src/spot/operatorGrants.ts` |
| BinaryMarket fields: strike, interval, expiry, venueId | `src/markets.ts` |
| `getOpeningPrices` | `src/createClient.ts` |
| Binary `trader.placeOrder` / `ORDER_TYPE.POST_ONLY` / default expiry = market expiry | `src/trade.ts` |
| Unified `createOrder` postOnly, no expire field | `src/unified/exchange.ts` `CreateOrderParams` |
| `getOrderOnchain` (active only; cancel → null) | `src/orders.ts` |
| tUSDC `trader.faucet()` | `src/testnet.ts` |
| Wet BUY place | Shannon tx `0x345cae9516dc96c275e8cc204e36a060916f184373d185d462526d29fe438898` |
| Wet cancel | Shannon tx `0x2f6e566147e1da78d0d81dee308bbf631444a82c2f4cf99b1f61cda7a0ee673b` |
| tUSDC faucet 100 | Shannon tx `0xe87717702926bbeabf97b8fdac68079bebcbb329f8318da6c9fa749ae8c1be9a` |
| `getBinaryBookParams` tick/lot/min | `src/orders.ts` |
| Complete-set mint / burn approval behavior | `src/binary/sets.ts`, `src/trade.ts` (`MintSetParams`, `BurnSetParams`) |
| ERC-6909 visible outcome balance semantics | `src/binary/portfolio.ts`, live Phase 4A verifier |
| Exact binary SELL order fields and active-order reads | `src/orders.ts`, `src/trade.ts` |
| Price feed types; 1m/1h/1d candles | `src/priceFeed/types.ts` |
| `LivePrice`/`PricePoint` fields, freshness metadata, `fetchPriceHistory` | `src/priceFeed/types.ts`, `src/priceFeed/query.ts`, `src/somniaMarketsClient.ts` |
| Testnet addresses + `SOMNIA_TESTNET_PRICE_FEED` | `src/addresses.ts`, `src/config.ts` |

## Phase 3 quote-planner implementation evidence

| Claim | Source |
| --- | --- |
| Official maker is symmetric around book mid with fixed spread and maker plumbing | `.scratch/dreamdex-bot-kit/strategies/ec-maker/src/index.ts` and its README |
| Official oracle-follow separates underlying spot/reference logic from its optional book anchor | `.scratch/dreamdex-bot-kit/strategies/ec-oracle-follow/src/signal.ts` and `src/index.ts` |
| Binary pool returns exact `tickSize`, `lotSize`, and `minQuantity` | Installed SDK `node_modules/@somnia-chain/markets-sdk/src/orders.ts`, `getBinaryBookParams` |
| YES book can be expanded to NO by inversion, but VILLA's planner intentionally uses one YES book | Installed SDK `src/orders.ts`, `toBinaryBook`; `docs/QUOTE_PLANNER.md` boundary |
| Post-only bid/ask raw inequalities | Installed SDK binary order/write helpers and VILLA `src/quote-planner/planner.mjs` |
| Pending signed order stress and reduce-only caps | VILLA `src/risk-governor/exposure.mjs`, Phase 2B corrective evidence |
| Pure adaptive quote formula and limits | VILLA `src/quote-planner/config.mjs`, `planner.mjs`, and `docs/QUOTE_PLANNER.md` |
| Live read-only assembly | VILLA `scripts/quote-snapshot.mjs`; it imports no signer or write path |

## Phase 4A inventory implementation evidence

| Claim | Source |
| --- | --- |
| Pure complete-set, sell-capacity, post-only, expiry, and burn arithmetic | VILLA `src/inventory-lifecycle/index.mjs` and `index.test.mjs` |
| Bounded mint → SELL_YES rest → exact cancel → burnSet adapter | VILLA `scripts/verify-inventory-lifecycle.mjs` |
| SDK mint auto-approval and burn operator approval | Installed SDK `src/binary/sets.ts` |
| SELL_YES reference plumbing and held-outcome check | `.scratch/dreamdex-bot-kit/packages/ec-core/src/orders.ts` |
| Live Shannon receipts and final zero-state re-read | `docs/INVENTORY_LIFECYCLE.md`, Phase 4A command output |

## Phase 4B execution implementation evidence

| Claim | Source |
| --- | --- |
| One-shot execution boundary, event contract, and cleanup rules | VILLA `src/execution/policy.mjs`, `src/execution/live.mjs`, `scripts/verify-quote-cycle.mjs`, `docs/EXECUTION_ADAPTER.md` |
| Single serialized write queue | VILLA `src/execution/write-queue.mjs` and `write-queue.test.mjs` |
| Exact binary write parameters, post-only order type, order expiry, and receipt shape | Installed SDK `src/trade.ts`, `src/orders.ts`, `src/tradeAbi.ts` |
| On-chain active order and indexer reconciliation | VILLA `src/risk-governor/live.mjs`, `src/execution/policy.mjs`, `scripts/verify-quote-cycle.mjs` |
| One-lot cap and paired cleanup | VILLA `src/inventory-lifecycle/index.mjs`, `src/execution/policy.mjs` |
| Live Phase 4B transaction and final-state evidence | `docs/TECHNICAL_VERIFICATION.md`, Phase 4B command output |

Upstream: https://www.npmjs.com/package/@somnia-chain/markets-sdk

## Official bot kit (cloned `.scratch/dreamdex-bot-kit`, not vendored)

https://github.com/somnia-chain/dreamdex-bot-kit

| Claim | File |
| --- | --- |
| ec-maker fair value is book mid or 0.5 | `strategies/ec-maker/src/index.ts` |
| Kit EC plumbing | `packages/ec-core/src/*.ts` |
| Opening price + strike scale heuristic | `strategies/ec-oracle-follow/src/signal.ts` |
| Underlying-only oracle signal and its book-anchor boundary | `strategies/ec-oracle-follow/src/signal.ts`, `strategies/ec-oracle-follow/src/index.ts` |
| Session keys are spot vault/`placeOrderFor` | `docs/session-keys.md` |
| Documented testnet VENUE_ID (stale vs live) | `docs/event-contracts.md` |
| Kit tests used sdk ^0.22.0 on 2026-08-06 | `docs/tests/ec-test-report.md` |

## Live checks this session

| Claim | How |
| --- | --- |
| Chain 50312, contracts have code | RPC `eth_chainId` / `eth_getCode` |
| Markets, intervals, venue ids, books, spot, history, opening price, model-vs-book snapshot | `npm run doctor`, `node scripts/discover.mjs`, `npm run fair-value` |

## Local prior work (hints only, not sources of truth)

`Desktop/house-spike`, `Desktop/skill/idea-research/*`. Used to know where to look. Re-verified; some findings changed (books not empty; venue id moved).

## Phase 2B risk-governor implementation evidence

| Claim | Source |
| --- | --- |
| Chain-head block timestamp and block number | Installed SDK `src/client.ts` / `getViemClient()`; live `npm run risk` read |
| Current market status, expiry, pool, outcome-token ids | Installed SDK `src/somniaMarketsClient.ts` and `src/markets.ts` `getMarketOnchain(marketId)` |
| Chain-head account open-order ids and active order details | Installed SDK `src/orders.ts` `getOwnOpenOrdersOnchain` and `getOrderOnchain` |
| YES/NO order classification | Installed SDK `src/orders.ts` / `src/binary/portfolio.ts` indexed `OpenOrder.side`; reconciled against chain ids before use |
| ERC-6909 outcome balances | Installed SDK `src/somniaMarketsClient.ts` and `src/binary/portfolio.ts` `getOutcomeBalance` |
| Binary side semantics | Installed SDK `src/trade.ts` and `src/tradeAbi.ts`: `BUY_YES`, `SELL_YES`, `BUY_NO`, `SELL_NO` |
| Deterministic risk policy and exposure math | This repository: `src/risk-governor/config.mjs`, `exposure.mjs`, `governor.mjs`, and `governor.test.mjs` |
| Live read-only risk output | This repository: `scripts/risk-snapshot.mjs`; no signer and no write call |

## Settlement lifecycle sources

| Claim | Source |
| --- | --- |
| On-chain binary states and post-finalization fields | Installed SDK 0.28.1: `node_modules/@somnia-chain/markets-sdk/src/store.ts`, `src/markets.ts` |
| Explicit SDK redeem signature and YES/NO mapping | Installed SDK 0.28.1: `node_modules/@somnia-chain/markets-sdk/src/trade.ts` (`RedeemParams`, `Trader.redeem`) |
| Binary settlement ABI and payout vector | Installed SDK 0.28.1: `node_modules/@somnia-chain/markets-sdk/src/readsAbi.ts`, `src/tradeAbi.ts` |
| SDK payout and claimable semantics | Installed SDK 0.28.1: `node_modules/@somnia-chain/markets-sdk/src/derivedReads.ts`, `src/binary/settlement.ts` |
| Finalized rediscovery and resolved/void claim behavior | Gitignored official reference clone: `.scratch/dreamdex-bot-kit/packages/ec-core/src/settlement.ts`, `src/claim.ts`, `docs/event-contracts.md` |
| VILLA settlement decisions and live adapter | This repository: `src/settlement/index.mjs`, `src/settlement/live.mjs`, `scripts/verify-settlement.mjs` |
