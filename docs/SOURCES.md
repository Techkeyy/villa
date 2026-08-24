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
| `getBinaryBookParams` tick/lot/min | `src/orders.ts` |
| Price feed types; 1m/1h/1d candles | `src/priceFeed/types.ts` |
| Testnet addresses + `SOMNIA_TESTNET_PRICE_FEED` | `src/addresses.ts`, `src/config.ts` |

Upstream: https://www.npmjs.com/package/@somnia-chain/markets-sdk

## Official bot kit (cloned `.scratch/dreamdex-bot-kit`, not vendored)

https://github.com/somnia-chain/dreamdex-bot-kit

| Claim | File |
| --- | --- |
| ec-maker fair value is book mid or 0.5 | `strategies/ec-maker/src/index.ts` |
| Kit EC plumbing | `packages/ec-core/src/*.ts` |
| Opening price + strike scale heuristic | `strategies/ec-oracle-follow/src/signal.ts` |
| Session keys are spot vault/`placeOrderFor` | `docs/session-keys.md` |
| Documented testnet VENUE_ID (stale vs live) | `docs/event-contracts.md` |
| Kit tests used sdk ^0.22.0 on 2026-08-06 | `docs/tests/ec-test-report.md` |

## Live checks this session

| Claim | How |
| --- | --- |
| Chain 50312, contracts have code | RPC `eth_chainId` / `eth_getCode` |
| Markets, intervals, venue ids, books, spot, OHLCV, opening price | `npm run doctor`, `node scripts/discover.mjs`, one-off `getOpeningPrices` |

## Local prior work (hints only, not sources of truth)

`Desktop/house-spike`, `Desktop/skill/idea-research/*`. Used to know where to look. Re-verified; some findings changed (books not empty; venue id moved).
