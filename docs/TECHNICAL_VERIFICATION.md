# Technical verification

Statuses used below: **VERIFIED** | **VERIFIED WITH CONDITIONS** | **NOT YET VERIFIED** | **UNSUPPORTED** | **NEEDS LIVE TESTING**.

Evidence is from this repo's installed SDK (`node_modules/@somnia-chain/markets-sdk@0.28.1` source), official docs fetched 2026-08-24, the cloned bot kit at `.scratch/dreamdex-bot-kit` (gitignored), RPC, and `npm run doctor` / `node scripts/discover.mjs`.

## Environment

| Capability | Status | Evidence | Test | Conclusion | Implementation consequence |
| --- | --- | --- | --- | --- | --- |
| Desktop path | VERIFIED | `[Environment]::GetFolderPath('Desktop')` → `C:\Users\HomePC\Desktop` | PowerShell | Create `villa` here only | Repo lives at `C:\Users\HomePC\Desktop\villa` |
| Node ≥ 20 | VERIFIED | v24.14.0 | `node --version` | OK | Use Node, not a second runtime |
| Git | VERIFIED | 2.53.0 | `git --version` | OK | Public GitHub later |
| SDK install | VERIFIED | package 0.28.1 on disk | `npm install` | Current floor 0.28.0 in docs | Pin ^0.28.1 |
| Shannon RPC | VERIFIED | `eth_chainId` `0xc488` = 50312; height ~470,015,931 then 470,016,744 | JSON-RPC | Live | Doctor must fail if chain id drifts |
| BinaryMarketsModule bytecode | VERIFIED | 130 bytes at `0x3ecC…e388` (proxy-sized) | `eth_getCode` | Address from official contracts page is occupied | Do not hardcode per-window pools |
| tUSDC bytecode | VERIFIED | 1965 bytes at `0x70a86D…5d8E` | `eth_getCode` | Faucet token exists | 6 decimals on testnet |
| Foundry | VERIFIED WITH CONDITIONS | forge 1.7.1 at `~\.foundry\bin`, **not on PATH** | `Get-Command forge` failed; direct exe worked | Optional for MVP | Do not start Solidity until PATH is explicit |
| Operator wallet | VERIFIED | Disposable Shannon EOA created locally into gitignored `.env`. Public address `0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37`. Key never committed | `git check-ignore -v .env` | Safe to use for testnet writes once funded | Never reuse a mainnet/user wallet |
| STT balance | VERIFIED | Manual faucet drip. Live `getBalance` = **50 STT**, then 49.998481172 before place, 49.992880118 after place+cancel | RPC 2026-08-24 | Enough gas for faucet + two writes | Keep a disposable key; do not drain |
| tUSDC balance | VERIFIED | `trader.faucet({ amount: 100e6 })` → **100 tUSDC** (raw 100000000). After BUY escrow+cancel, balance **unchanged** (escrow returned) | `npm run fund:tusdc` tx `0xe87717702926bbeabf97b8fdac68079bebcbb329f8318da6c9fa749ae8c1be9a` | On-chain faucet works once STT exists. Cap is 10_000; we minted 100 | Do not mint 10k unless needed |
| Event Contract **BUY** placement | VERIFIED | Wet `trader.placeOrder` POST_ONLY BUY_YES 0.001 @ 0.774 on live BTC 24h. receipt success, **0 fills** | `npm run verify:write` tx `0x345cae9516dc96c275e8cc204e36a060916f184373d185d462526d29fe438898` | A tiny non-crossing buy rests. **Does not prove SELL, mint, or other intervals** | Use explicit `expireTimestampNs` |
| Post-only / tick / lot | VERIFIED | tick=lot=min=1000 (0.001). Book 0.784/0.81; we bid 0.774 (10 ticks under). No `PostOnlyWouldCross` | same wet run | Grid math matched the pool | Bounded retry exists if the book moves |
| Order visibility | VERIFIED | `getOrderOnchain` returned the order immediately (`confirmMs: 0`): id `18446744073709718435`, owner our wallet, isBid true, remaining 1000 | same | On-chain read is the source of truth right after place | Still poll; 0ms may not generalize |
| Cancel | VERIFIED | `trader.cancelOrder` tx `0x2f6e566147e1da78d0d81dee308bbf631444a82c2f4cf99b1f61cda7a0ee673b`; `getOrderOnchain` then `null`/`gone` at 0ms | same | **This exact order** was removed. Does not prove cancel-all or fill cleanup | Cleanup only cancels the id this run created |
| Deadline timezone | NOT YET VERIFIED | DoraHacks 2026-09-08 18:00 unlabelled; Eventbrite disagrees | Docs only | Confirm in Telegram | Submit earlier than the displayed time |

## Discovery and metadata

| Capability | Status | Evidence | Test | Conclusion | Implementation consequence |
| --- | --- | --- | --- | --- | --- |
| `loadMarkets()` | VERIFIED | 557 tradables, 548 binary, 12 `active` | `scripts/discover.mjs` | Works without a signer | First-pass discovery |
| `listBinaryMarkets()` | VERIFIED | 200 rows: BTC/ETH 100 each | same | Works | Use for settled scan + interval census |
| Live assets | VERIFIED | BTC and ETH only in sample | same | Matches consumer docs | Do not invent other underlyings |
| Live intervals | VERIFIED WITH CONDITIONS | `listBinaryMarkets` 200-row sample: 60/300/900/3600/14400s. `loadMarkets` later returned a **86400s (24h)** BTC window `BTC-0-25AUG26/tUSDC` with on-chain status 1 | discover + `verify-write-path --dry-run` | Consumer docs (15m/1h) are stale. 24h exists | Do not hardcode cadences. Write-path prefers ≥5m |
| Indexed status vs live | VERIFIED | 10 `Trading`, 190 `Finalized` in 200; official gotcha #1; SDK `BinaryMarket.status` comment: timestamp transitions emit no events | discover + SDK `markets.ts` | Never write on indexer status alone | Always `getMarketOnchain` → `status === 1` |
| On-chain market status | VERIFIED | Sample future window `status: 1`, `isResolved: false` | `getMarketOnchain` | Matches Trading enum in kit `MARKET_STATUS` | Gate every write |
| Strike field | VERIFIED | 1m/5m nonzero (e.g. BTC `7845797`); 15m/1h/4h often `"0"` | discover | Two market kinds | 1m/5m can use `strike`; longer windows need opening price |
| `getOpeningPrices` | VERIFIED WITH CONDITIONS | 1h BTC strike 0 → `{ "0x…8495": "7842383" }`; 1m sample with explicit strike returned `{}` | client call | Opening price exists for up/down windows | Infer scale vs spot (kit `scaleStrike`); do not assume decimals on the string |
| Expiry / time remaining | VERIFIED | `expiry` unix seconds on row and on-chain | discover | Usable as τ | Skip windows about to lock (gotcha #9; kit scales headroom to interval) |
| Venue id | VERIFIED WITH CONDITIONS | Live majority `0x1a1e6821…`; kit README still `0x679795a0…` (14/200 rows) | discover vs kit docs | **Venue moved.** Kit source already warns. | Read `venueId` from a live row. Hardcoding kit README is a silent empty-scope bug |
| Question text | VERIFIED as unsafe | Gotcha #13; typed `asset` / `intervalSec` on rows | docs + live fields present | Do not regex the question | Filter typed fields |

## Price / oracle inputs (fair value)

| Capability | Status | Evidence | Test | Conclusion | Implementation consequence |
| --- | --- | --- | --- | --- | --- |
| Spot via `fetchPrice("BTC")` | VERIFIED | price 78434.515, ema present, `blockTimestamp` 1787574557 | doctor + discover | Needs `config.priceFeed = SOMNIA_TESTNET_PRICE_FEED` | Without that key SDK throws `NotConfiguredError` (prior local note + SDK types) |
| ETH spot | VERIFIED WITH CONDITIONS | doctor only asserted BTC; SDK is the same `fetchPrice(asset)` | BTC only this session | Call ETH once before relying | One line in doctor |
| 1m OHLCV | VERIFIED | `fetchPriceOHLCV("BTC","1m")` returned candles; last vol=18 (oracle update count, not trade volume) | discover | Vol estimator possible | SDK comment: only 1m/1h/1d. No sub-minute candles |
| Underlying price history | VERIFIED | SDK 0.28.1 `client.fetchPriceHistory("BTC", { limit })` returns newest-first `PricePoint` rows with human price + chain timestamp | Phase 2A read-only snapshot | Use chronological log returns with chain-time seconds | Reject malformed, stale, or gapped history |
| Stale-feed detection | VERIFIED WITH CONDITIONS | `LivePrice.blockTimestamp` exists; kit `SpotHistory` ages samples | types + kit `signal.ts` | Computable | Governor tripwire: halt if `now - blockTimestamp` too large |
| Independent of book mid | VERIFIED as possible | Spot 78434 vs 1m book mid ~0.272 | live numbers | Fair value **can** disagree with the book | This is the product. Do not quote 0.272 because the book said so |
| Exact fair-value formula | VERIFIED WITH CONDITIONS | `docs/FAIR_VALUE_MODEL.md`, pure `villa-fv-v1`, 50 deterministic tests | `npm test` + live snapshot | Zero-drift log-return digital baseline | No order-control dependency; confidence is data quality |

## Phase 2A read-only evidence (2026-08-25)

One successful `npm run fair-value` run read a live BTC 300s Event Contract:

| Field | Observed value |
| --- | --- |
| Market / marketId | `BTC-7893003-25AUG26-1935/tUSDC` / `0x0000000000000000000000000000000000000000000000000000000000009795` |
| On-chain status | `Trading (1)` |
| Reference | `78930.03`, explicit `strike`, selected raw scale `10^2` |
| BTC now / time left | `78895.85` / `188s` using chain time |
| Realized volatility | `4.176245e-5` per square-root second; 235 observations over 248s |
| VILLA result | `UP 22.5%`, `DOWN 77.5%`, `HIGH` data quality (`97.5%`) |
| DreamDEX midpoint | `28.7%`, comparison only |
| Difference | `-6.2 percentage points` |
| Transactions | None; the script has no signer and only performs reads |

Shannon's chain clock was about 556 seconds ahead of the workstation in this
run. The snapshot reported the offset and used the latest chain timestamp for
history/expiry math. A later successful run also exercised a fresh zero-moneyness
case and an empty-book comparison; the midpoint is therefore optional data, never
a required model input.

## Orders, inventory, lifecycle

| Capability | Status | Evidence | Test | Conclusion | Implementation consequence |
| --- | --- | --- | --- | --- | --- |
| Read order book | VERIFIED | 1m BTC YES: bids 0.259/0.249/0.239, asks 0.286/0.296/0.306, sizes 200–460 | `fetchOrderBook` | Books are not universally empty today | Inventory-aware quoting still required; empty-book fallback still needed |
| `trader.placeOrder` post-only BUY | VERIFIED | Wet rest on BTC 24h, 0 fills. Unified `createOrder` still unused (no expire field) | `npm run verify:write` | BUY escrow path works on Shannon 6dp | SELL / mint still unproven |
| Cancel | VERIFIED | Wet cancel of that order id; on-chain gone | same | Works for our resting BUY | Do not cancel unrelated orders |
| Order expiry | VERIFIED | ABI requires `expireTimestampNs`; gotcha #5: `0` reverts | ABI + docs | Dead-man switch is mandatory | Set just past requote interval, cap at market expiry |
| Mint complete set | VERIFIED WITH CONDITIONS | SDK `mintSet` → pool `mintSet(yesTo,noTo,amount)`; kit `seedInventory` | Source. No write here | Exists; kit asserts receipt | Needed for **sell** inventory. Two buy-sides can quote with zero inventory (market-structure docs) |
| Burn complete set | VERIFIED WITH CONDITIONS | SDK `burnSet` | Source only | Exists | Unwind unused pairs |
| Outcome balances | VERIFIED WITH CONDITIONS | `getOutcomeBalance({outcomeToken, account, id})`; on-chain sample returned `yesId`/`noId` | Source + on-chain shape | ERC-6909 ids, not ERC-20 | Key by marketId + ids from the **same** on-chain snapshot |
| Fill detection | VERIFIED WITH CONDITIONS | `fetchMyTrades`; order-book events ABI; kit says indexer lags seconds | Source + docs | Do not trust a single indexer read | Poll + on-chain balances as truth |
| Settlement detection | VERIFIED WITH CONDITIONS | `getMarketOnchain` `isResolved`/`isVoided`; `listBinaryMarkets({status:"Finalized"})` returned rows | discover finalized sample | Detectable without watching 15 minutes if we scan Finalized | Dashboard can show claims without a live expiry |
| Redeem / claim | VERIFIED WITH CONDITIONS | SDK `redeem` via module; kit `claim.ts`; official recipes; kit test report 2026-08-06 claimed 205 YES on BTC 60s **on older SDK 0.22** | Source + third-party kit report | Path exists. **This repo has not redeemed.** | Implement from 0.28.1 `trader.redeem`, void both sides at 0.5 |
| Successor discovery | VERIFIED WITH CONDITIONS | `loadMarkets(true)` each cycle in kit; 12 active flags while windows roll | live active_flag=12 | Polling works. Reactivity not required | Do not cache pool address |
| HTTP Event Contract API | UNSUPPORTED | Official Event Contracts page | docs | Spot API is the wrong door | Never call `api.dreamdex.io` for EC |
| Spot session keys for EC | UNSUPPORTED for kit/registry path | SDK `operatorGrants.ts` SPOT-ONLY; ec-core has no OWNER_ADDRESS | source | Do not copy session-keys.md onto Event Contracts | EOA signs MVP |
| `placeBinaryOrderFor` | NOT YET VERIFIED | ABI exists | ABI only | Maybe a different operator model | Out of MVP until granted live |
| Organic fill during demo | NEEDS LIVE TESTING | Most live `tradeCount` 0; ETH 4h had 4; 1m book had rest | discover | Flow is thin, not zero | Disclose a taker wallet if we must prove fill handling |
| Full mint→quote→fill→redeem→roll | NEEDS LIVE TESTING | Kit report did this on 0.22 / old venue id | not this repo | Do not claim it | Day-1 write script after wallet exists |

## Target product flow — classification

| Step | Status |
| --- | --- |
| Operator connects/configures | NOT YET VERIFIED (no wallet, no UI) |
| Allocates capital (tUSDC faucet; mint still untested) | tUSDC faucet **VERIFIED**; `mintSet` still **VERIFIED WITH CONDITIONS** |
| Discover supported Event Contract | VERIFIED |
| Independent fair value | VERIFIED WITH CONDITIONS (pure model + live read-only snapshot) |
| Permitted quotes (governor) | NOT YET VERIFIED (rules not coded; data for rules exists) |
| Quote enters DreamDEX | **VERIFIED** for one tiny post-only BUY_YES on one BTC 24h window. Not proven: SELL, other cadences, inventory skew |
| Fill changes inventory | VERIFIED WITH CONDITIONS (balances+trades APIs; thin organic flow) |
| Observe change | VERIFIED WITH CONDITIONS |
| Risk logic changes behaviour | NOT YET VERIFIED |
| Dashboard explains | NOT YET VERIFIED (UI later) |
| Expiry/settlement detected | VERIFIED WITH CONDITIONS |
| Claims handled | VERIFIED WITH CONDITIONS |
| Successor followed | VERIFIED WITH CONDITIONS (rediscover; not reactivity) |

## Capital lifecycle

```
capital (tUSDC)
  → mintSet and/or buy-side escrow
  → resting orders / fills
  → lock → resolve/void
  → redeem (module; not pool.redeem — removed in settlement v2)
  → wallet collateral
  → next marketId (new symbol; possibly recycled pool)
```

Each arrow has an SDK method. **BUY-side escrow → rest → cancel → collateral returned** is VERIFIED on one Shannon BTC 24h market. mintSet, fills, redeem, and roll remain **NEEDS LIVE TESTING**.

## Wet write-path evidence (2026-08-24)

| Field | Value |
| --- | --- |
| Wallet | `0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37` |
| tUSDC faucet tx | `0xe87717702926bbeabf97b8fdac68079bebcbb329f8318da6c9fa749ae8c1be9a` |
| Market | BTC 86400s `BTC-0-25AUG26/tUSDC` |
| marketId | `0x0000000000000000000000000000000000000000000000000000000000007d53` |
| venueId | `0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c` |
| expiry / status | `1787616000` / on-chain 1 |
| book | bid 0.784 / ask 0.81 |
| order | BUY_YES post-only 0.001 @ 0.774 |
| place tx | `0x345cae9516dc96c275e8cc204e36a060916f184373d185d462526d29fe438898` |
| orderId | `18446744073709718435` |
| place confirm | `getOrderOnchain` 0ms; `fetchOpenOrders` 0ms |
| cancel tx | `0x2f6e566147e1da78d0d81dee308bbf631444a82c2f4cf99b1f61cda7a0ee673b` |
| cancel confirm | `getOrderOnchain` gone at 0ms |
| STT | 49.998481172 → 49.992880118 |
| tUSDC raw | 100000000 → 100000000 (escrow returned) |
| retries | none (`PostOnlyWouldCross` did not fire) |

This proves **one BUY rest+cancel** on **one 24h BTC window**. It does not prove SELL inventory, fills, 1m/5m/15m/1h/4h writes, or settlement.

## Disagreements (not silently resolved)

1. **Intervals:** consumer docs 15m/1h vs live 1m/5m/15m/1h/4h. Prefer live indexer + on-chain expiry. Docs are stale marketing.
2. **Venue id:** kit README `0x6797…` vs live `0x1a1e…`. Prefer live rows. Kit source already says README values move.
3. **Empty books:** prior `house-spike` on this machine saw 0–5 trades and empty books. Today a 1m YES book had three levels each side. Prefer **today's** read; still design for empty.
4. **SDK version:** kit test report `^0.22.0` vs installed `0.28.1`. Prefer installed package + current Event Contracts docs. Re-verify writes; do not trust 0.22 receipt folklore without checking 0.28 (`ContractRevertError` is documented on `createOrder`).
5. **Deadline TZ:** DoraHacks vs Eventbrite. Prefer DoraHacks time, TZ still Unknown.
6. **Session keys:** spot docs vs binary ABI `placeBinaryOrderFor`. Prefer "spot registry does not apply"; binary-for is unverified.
