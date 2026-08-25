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
| Price feed types; 1m/1h/1d candles | `src/priceFeed/types.ts` |
| `LivePrice`/`PricePoint` fields, freshness metadata, `fetchPriceHistory` | `src/priceFeed/types.ts`, `src/priceFeed/query.ts`, `src/somniaMarketsClient.ts` |
| Testnet addresses + `SOMNIA_TESTNET_PRICE_FEED` | `src/addresses.ts`, `src/config.ts` |

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
