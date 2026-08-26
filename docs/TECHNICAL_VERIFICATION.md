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
| `trader.placeOrder` post-only BUY | VERIFIED | Wet rest on BTC 24h, 0 fills. Unified `createOrder` still unused (no expire field) | `npm run verify:write` | BUY escrow path works on Shannon 6dp | SELL path is separately verified in Phase 4A |
| `trader.placeOrder` post-only SELL_YES | VERIFIED WITH CONDITIONS | Wet rest on BTC 24h, 0 fills; exact `isBid=false`, owner, price, quantity matched on-chain and indexer | `npm run verify:inventory` | A held YES can rest as a post-only ask and be cancelled exactly | One minimum-size controlled sequence; no fill claim |
| Cancel | VERIFIED | Wet cancel of that order id; on-chain gone | same | Works for our resting BUY | Do not cancel unrelated orders |
| Order expiry | VERIFIED | ABI requires `expireTimestampNs`; gotcha #5: `0` reverts | ABI + docs | Dead-man switch is mandatory | Set just past requote interval, cap at market expiry |
| Mint complete set | VERIFIED WITH CONDITIONS | SDK `mintSet` → pool `mintSet(yesTo,noTo,amount)`; live 0.001 mint increased YES and NO by exactly 1000 raw and debited exactly 1000 raw tUSDC | `npm run verify:inventory` | Complete-set mint works on Shannon 6dp | One minimum-size Trading market; SDK auto-approval path is version-specific |
| Burn complete set | VERIFIED WITH CONDITIONS | Live `burnSet` of the exact paired 1000 raw YES+NO restored tUSDC and both outcome balances to baseline | `npm run verify:inventory` | Unused pre-settlement pairs can be unwound | Not settlement `redeem`; no finalized claim proven |
| Outcome balances | VERIFIED | `getOutcomeBalance({outcomeToken, account, id})`; live mint/rest/cancel/burn observed ERC-6909 balances and token escrow semantics | Source + `npm run verify:inventory` | ERC-6909 ids, not ERC-20; resting SELL escrowed YES out of visible balance | Key by marketId + ids from the same on-chain snapshot; do not double-reserve escrowed SELLs |
| Fill detection | VERIFIED | Phase 6A reconciled two organic full `SELL_YES` fills against the exact resting order ids; on-chain/indexer state was reconciled | Phase 6A and Phase 6A.1 evidence below | Do not trust a single indexer read | Poll + on-chain balances as truth |
| Settlement detection | VERIFIED WITH CONDITIONS | `getMarketOnchain` `isResolved`/`isVoided`; `listBinaryMarkets({status:"Finalized"})` returned rows | discover finalized sample | Detectable without watching 15 minutes if we scan Finalized | Dashboard can show claims without a live expiry |
| Redeem / claim | VERIFIED | Phase 6A.1 redeemed exact winning NO balances for two organic-fill markets with SDK 0.28.1; receipts and zero post-claim balances reconciled | Phase 6A.1 evidence below | Winning outcome only; known losing residuals are skipped | Keep market-specific payout vectors and serialized writes |
| Successor discovery | VERIFIED WITH CONDITIONS | `loadMarkets(true)` each cycle in kit; 12 active flags while windows roll | live active_flag=12 | Polling works. Reactivity not required | Do not cache pool address |
| HTTP Event Contract API | UNSUPPORTED | Official Event Contracts page | docs | Spot API is the wrong door | Never call `api.dreamdex.io` for EC |
| Spot session keys for EC | UNSUPPORTED for kit/registry path | SDK `operatorGrants.ts` SPOT-ONLY; ec-core has no OWNER_ADDRESS | source | Do not copy session-keys.md onto Event Contracts | EOA signs MVP |
| `placeBinaryOrderFor` | NOT YET VERIFIED | ABI exists | ABI only | Maybe a different operator model | Out of MVP until granted live |
| Organic fill during demo | VERIFIED WITH CONDITIONS | Phase 6A observed two genuine external full `SELL_YES` fills; no taker or second wallet | Phase 6A evidence below | Flow remains market-dependent | Disclose bounded evidence and do not manufacture fills |
| Full mint→quote→fill→redeem→roll | VERIFIED WITH CONDITIONS | Phase 6A quote/fill/roll plus Phase 6A.1 settlement redeem; bounded Shannon proof only | Phase 6A and Phase 6A.1 evidence below | No profitability or continuous-service claim | Keep each lifecycle bounded and auditable |

## Target product flow — classification

| Step | Status |
| --- | --- |
| Operator connects/configures | NOT YET VERIFIED (no wallet, no UI) |
| Allocates capital (tUSDC faucet; complete-set mint) | tUSDC faucet **VERIFIED**; minimum `mintSet` **VERIFIED WITH CONDITIONS** |
| Discover supported Event Contract | VERIFIED |
| Independent fair value | VERIFIED WITH CONDITIONS (pure model + live read-only snapshot) |
| Permitted quotes (governor) | NOT YET VERIFIED (rules not coded; data for rules exists) |
| Quote/order enters DreamDEX | **VERIFIED WITH CONDITIONS** for one tiny post-only BUY_YES and one controlled SELL_YES rest/cancel on BTC 24h. Not proven: fills, other cadences, inventory skew |
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

Each arrow has an SDK method. **BUY-side escrow → rest → cancel → collateral
returned** and **mintSet → SELL_YES rest → exact cancel → burnSet** are verified
with conditions on one Shannon BTC 24h market. Fills, redeem, and roll remain
**NEEDS LIVE TESTING**.

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

## Phase 2B risk-governor evidence (2026-08-25)

| Capability | Status | Evidence | Conclusion |
| --- | --- | --- | --- |
| Pure deterministic governor | VERIFIED | `src/risk-governor/governor.mjs`; 67 scenario tests | Same normalized input produces the same state, permissions, limits, reasons, and warnings. |
| Versioned policy | VERIFIED | `villa-risk-v1` in `src/risk-governor/config.mjs` | Thresholds are centralized and invalid versions fail closed. |
| Chain-time expiry gate | VERIFIED | `chainNowSec` and `observationAgeSec` are required inputs; local clock offset test passes | Expiry uses chain time; stale chain observations halt. |
| Feed timestamp safety | VERIFIED | stale, future, missing, non-monotonic, and source-age scenarios pass | Broken feed timing halts; no neutral fallback. |
| Reference safety | VERIFIED | valid strike/opening source plus ambiguous/unsupported scale scenarios pass | Missing or unsafe reference scaling halts. |
| Binary exposure | VERIFIED | complete-set, YES residual, NO residual, all four pending order deltas, opposing-order, threshold, and reduce-only cap scenarios pass | Worst-case directional stress includes every signed pending order delta; gross inventory and pending BUY collateral remain separate. |
| Capital / gas / drawdown boundary | VERIFIED WITH CONDITIONS | hard collateral, gas, capital, drawdown scenarios pass; live drawdown is explicit `UNAVAILABLE` | No PnL is invented; strict drawdown mode is available for a future accounting layer. |
| Live risk snapshot | VERIFIED | `npm run risk` read-only run found BTC `BTC-0-26AUG26-8BD1/tUSDC`, on-chain `Trading (1)`, opening reference `78982.93`, fair UP `26.3%`, book midpoint `28.8%` comparison-only | Governor returned `ALLOW`; warnings were `CAPITAL_ACCOUNTING_PARTIAL`, `DRAWDOWN_UNACCOUNTED`. |
| Transactions during Phase 2B | VERIFIED | `npm run risk` has no signer/private-key import and printed `Transactions sent: NO` | No Phase 2B transaction was sent. |

The live run used chain time `1787698314`, 4086 seconds of headroom, realized
volatility `3.901993e-5` per square-root second, zero YES/NO inventory, and zero
chain/indexed open orders. The midpoint was fetched after the governor decision
and is comparison-only; it did not influence `pUp`, state, permissions, or
limits.

## Phase 2B corrective patch (2026-08-26)

The original Phase 2B review identified a material flaw in the buy-only pending
stress assumption: a filled SELL can break a complete set and create the
opposite directional residual. The patch keeps `D = YES - NO` as the signed
directional balance and centralizes the verified deltas:

| Action | Delta to D |
| --- | ---: |
| `BUY_YES` | `+quantity` |
| `SELL_YES` | `-quantity` |
| `BUY_NO` | `-quantity` |
| `SELL_NO` | `+quantity` |

Worst UP adds every positive pending delta (`BUY_YES` and `SELL_NO`). Worst
DOWN subtracts every negative pending delta (`SELL_YES` and `BUY_NO`). Opposing
orders are not netted optimistically. The gross/collateral path still counts
pending BUY quantities, while SELLs do not create new collateral requirements
merely because they affect directional exposure.

`REDUCE_ONLY` now exposes the current reducing action set and a quantity cap
before neutral. A proposed order that crosses zero is rejected or safely capped
at neutral. A balanced inventory has no reduce-only action, even if pending
orders have already caused the governor to stop new risk.

The corrective patch added 17 deterministic Phase 2B tests, bringing the pure
risk-governor suite to 67 tests and the repository suite to 117 tests. The
full suite passed 117/117. The live read-only recheck found:

- current market `BTC-0-26AUG26-8BD1/tUSDC`, on-chain `Trading (1)`, opening
  reference `78982.93`, chain time `1787701048`;
- BTC `78704.95`, 1352 seconds remaining, realized volatility
  `4.931148e-5` per square-root second, fair value UP `2.6%` / DOWN `97.4%`
  with HIGH confidence (`97.5%`);
- YES `0`, NO `0`, signed directional balance `D=0`, worst-case UP `0`, DOWN
  `0`, gross `0`, and zero chain/indexed open orders;
- governor `ALLOW`, primary reason `NONE`, book midpoint `4.9%` fetched after
  the decision as comparison-only; midpoint affects state `NO`;
- an independent active-pool scan covered six current Trading pools and found
  zero active VILLA orders in all six;
- `npm run verify:write:dry` passed and reported no transaction sent.

No live order was created, filled, cancelled, or otherwise changed by this
corrective patch.

## Phase 4A complete-set inventory + SELL verification (2026-08-26)

The installed SDK and official `ec-core` SELL path were re-read before adding
the verifier. `Trader.mintSet` deposits collateral and mints equal YES+NO;
the SDK's binary set helper auto-approves collateral to the pool when needed.
`Trader.burnSet` surrenders equal YES+NO and auto-ensures the pool's operator
approval on the outcome-token singleton. `SELL_YES` is the verified binary ask
side and `ORDER_TYPE.POST_ONLY` is used for the controlled rest.

`npm run verify:inventory:dry` first passed against Shannon. It scanned current
BTC Trading pools, found zero active operator orders, selected BTC 24h with
substantial headroom, read the 6-decimal `1000/1000/1000` tick/lot/min grid,
and planned the minimum `0.001` SELL_YES without a signer write.

The wet run then proved the full bounded lifecycle on one current BTC 24h
market:

- baseline: tUSDC `100000000` raw, YES `0`, NO `0`, zero open orders;
- mint: `0.001` collateral → YES `1000` + NO `1000`, exact collateral debit,
  D=0, complete-set exposure only;
- SELL_YES: raw price `535000`, raw quantity `1000`, `isBid=false`, exact owner,
  zero fills, on-chain and indexer-visible resting order;
- cancel: exact order disappeared from active chain and reconciled open-order
  reads, balances returned to the post-mint pair, zero fills;
- burnSet: exact pair destroyed, final YES/NO returned to zero, tUSDC returned
  exactly to `100000000`, and target open orders remained zero.

The live balance observation is material: while SELL_YES rested, visible YES
was `0` while the order committed `1000`; cancellation restored visible YES to
`1000`. The future writer must not double-subtract committed SELL quantity
when the venue has already escrowed it. `burnSet` here was pre-settlement pair
burn, not settlement redemption.

No intentional fill occurred. No dashboard, quote loop, settlement, or redeem
path was added.

## Phase 3 quote-planner verification (2026-08-26)

The pure `villa-quote-v1` planner was added in `src/quote-planner/`. It accepts
normalized fair value, governor permissions/limits, YES/NO inventory, pending
orders, exact raw grid parameters, collateral, and an optional YES book. It
returns only a structured plan. `scripts/quote-snapshot.mjs` assembles the
same inputs from read-only SDK/chain/indexer/feed reads and prints bid/ask
intent without creating an SDK trader or signer.

The planner was tested for neutral two-sided output, absolute HALT, both
REDUCE_ONLY directions, neutral reduce-only refusal, signed inventory skew,
bounded skew, volatility/confidence/expiry spread and size changes, real YES
inventory, collateral reserve, lot/minimum/tick rounding, impossible
post-only sides, fair-value/book independence, complementary probabilities,
invalid grid/fair/governor inputs, exact raw conversion, and all corrected
Phase 2B pending-order stress directions. The focused planner suite has 42
deterministic tests.

The first successful live `npm run quote` read on Shannon found:

- BTC `BTC-0-27AUG26/tUSDC`, marketId ending `9a4f`, on-chain `Trading (1)`;
- opening reference `78528.87` at raw scale `10^2`, BTC `78575.89`, and 85273s remaining;
- realized volatility `7.170467e-5` per square-root second;
- fair value UP `51.1%` / DOWN `48.9%`, HIGH confidence (`92.5%` data quality);
- YES book bid `49.70%`, ask `52.60%`, midpoint `51.15%` comparison-only;
- governor `ALLOW`, plan `ONE_SIDED`, bid `BUY_YES` `0.004` at `47.00%`;
- ask disabled as `NO_SELL_INVENTORY` because the wallet held zero YES;
- warnings `CAPITAL_ACCOUNTING_PARTIAL` and `DRAWDOWN_UNACCOUNTED`;
- transactions and order placement: `NO`.

An on-chain read-only scan covered 10 current Trading pools and found zero
active orders for the VILLA operator. The inherited `npm run verify:write:dry`
also completed with `PASS dry-run`, explicitly reporting that no transaction
was sent. The planner itself has no transaction capability by construction.

## Phase 4B bounded end-to-end quote execution (2026-08-26)

The final `npm run verify:quote-cycle -- --confirm` run passed on one live BTC
24-hour Trading contract (`marketId` ending `9a4f`) with approximately 16.2
hours of chain-time headroom. The adapter used the existing disposable wallet,
one minimum 6-decimal lot (`1000` raw = `0.001`), one serialized session, and at
most two simultaneous `ORDER_TYPE.POST_ONLY` orders.

The baseline read was tUSDC `100000000` raw, YES `0`, NO `0`, zero target open
orders, and zero active orders across the current BTC candidate scan. The
initial independent model pass reported BTC `78975.325`, opening reference
`78528.87`, `58320s` remaining, realized volatility
`3.208549e-5` per square-root second, fair UP `76.8%`, and HIGH data quality
(`90.0%`). The YES midpoint was `71.65%` and was recorded as comparison-only;
it was not passed to fair value, risk, or quote planning. The governor was
`ALLOW`.

The live event sequence was:

1. Mint exactly `1000` raw: collateral became `99999000`, YES and NO each
   became `1000`, and the post-mint read re-ran fair value, risk, and planning.
2. Place post-only `SELL_YES` at raw price `786000`, quantity `1000`; the
   order was visible on-chain and in the indexer with zero fills.
3. Re-run the full pipeline after that resting ask. The governor stayed
   `ALLOW`, open orders were `VERIFIED`, and the second plan was re-evaluated.
4. Place post-only `BUY_YES` at raw price `725000`, quantity `1000`; it was
   visible on-chain and in the indexer with zero fills.
5. Cancel the two exact session order IDs sequentially. Both disappeared from
   active on-chain reads and reconciled open-order reads.
6. Burn the exact temporary `1000` YES + `1000` NO pair. Final tUSDC returned
   to `100000000` raw, YES/NO returned to zero, and the final BTC scan found
   zero active orders.

Final-session transaction evidence:

| Action | Shannon transaction |
| --- | --- |
| minimum complete-set mint | `0x5af3eec659addbbd095aab49dcbfad8c60ec6c4dd2d4f4fd316074a40ec617e7` |
| post-only SELL_YES | `0xf03046325a38106e3b517502bf33ffe22a33236ff60d0a61ef576552d2af2332` |
| post-only BUY_YES | `0x56866b26fb1b4a10e1cea9a168b0e1657e5113fe964db249960a85e3d0e1c34f` |
| exact SELL cancel | `0x452523e2e1f6b19601423548575429d5bdfbaf06b1f417f4ebef59016f14b642` |
| exact BUY cancel | `0x9dae86e4a5b9357ff097b4b8c4d936ade9f464d54ae7ffc2392428932b19b0b9` |
| temporary pair burn | `0x349cfb5707aa91c518a7b6c11514a76e4c3a5de1865a2012b0b5b11aac88f77e` |

No intentional or observed fill occurred. The session's structured event stream
included baseline, model/risk/plan, mint, both order submissions, both resting
reconciliations, re-plan after the first order, both exact cancels, inventory
reconciliation, burn, and `SESSION_CLEAN`. The final run's transaction count
was six. Native STT decreased only through transaction gas; the adapter does
not claim a fixed gas cost.

During implementation, a first controlled attempt found and safely cleaned up
an indexer raw-quantity double-scaling bug, and a later attempt found a final
event-field spelling bug. Both were corrected; every subsequent read-only
check showed zero orders and zero YES/NO inventory before the final successful
run. The current implementation and final live run use the corrected paths.

The execution adapter's pure test suite covers HALT/NO_QUOTE, stale/future
feed timestamps, market/expiry gates, action permissions, cap and price
invariants, exact escrow, post-only crossings, inventory/collateral gates,
session tracking, serialized writes, partial/full/unknown reconciliation,
exact cancellation, and paired-burn refusal. The repository suite passed
`212/212`.

## Phase 5A settlement lifecycle implementation

The settlement implementation is in `src/settlement/` and
`scripts/verify-settlement.mjs`. Its pure suite contains 30 deterministic
tests covering non-redeemable states, resolved YES/NO, voided markets,
complete-set mint accounting, explicit outcome indices, payout vectors,
zero/already-cleared balances, finalized rediscovery, restart state, secret
exclusion, and separate gas/payout ledgers. The full repository suite is 242
tests.

The first read-only live check ran `npm run verify:settlement:dry` against
Shannon:

- finalized sweep: 200 BTC rows scanned, zero claimable operator balances and
  zero scan errors;
- current selection: BTC 5m, on-chain `Trading (1)`, with 196 seconds of
  chain-time headroom at selection;
- reference: explicit nonzero strike resolved by the existing reference
  resolver;
- baseline: tUSDC `100000000` raw, YES `0`, NO `0`, and no operator orders;
- no order book was read and no transaction was sent.

The bounded wet proof is recorded in the Phase 5A section below after a
successful mint, expiry observation, explicit SDK redemption, finalized
rediscovery, and exact payout reconciliation. A normal `loadMarkets()`
disappearance is diagnostic; `listBinaryMarkets({ status: "Finalized" })` is
the historical source.

## Phase 5A bounded wet proof (2026-08-26)

The bounded command passed on one live BTC 5m Event Contract. The selected
market was `marketId` ending `a00b`; its chain status was `Trading (1)` before
mint, and the chain resolved it to YES (`winningOutcome: 0`) at expiry. The
session used no book read, no fill, no second wallet, and no order-control
call.

Pre-mint and mint evidence:

- baseline: tUSDC `100000000` raw, YES `0`, NO `0`, and no active orders;
- minimum complete set: `1000` raw;
- after mint: collateral debit exactly `1000`, YES `+1000`, NO `+1000`,
  directional delta `0`;
- mint transaction: `0x3bda1c14eeb3cc1c55989e7ad5f43ef1d9e44184c6c069153145628532cb52c1`;
- mint receipt gas: `3525630000000000` wei.

Settlement evidence:

- observed terminal chain status: `Resolved (4)`;
- authoritative payout vector: `[10000000, 0]` with denominator `10000000`;
- plan: redeem YES with explicit `outcomeIdx: 0`, skip NO as
  `LOSING_OUTCOME_ZERO_PAYOUT`;
- redemption transaction: `0x2d276be38f646e6a93ef93ba9ddca82ddf0a219dd94728e3791e32bae2812090`;
- redemption receipt gas: `2836242000000000` wei;
- actual collateral payout: `1000` raw, expected `1000` raw, difference `0`;
- winning YES balance after redeem: `0`; residual NO `1000` is the known
  zero-value losing position that the current SDK does not claim;
- final collateral: `100000000` raw; final active orders: `0`.

The current SDK had no pre-existing ERC-6909 module operator approval, so it
sent one one-time setup transaction before redemption. A read-only receipt
attribution recorded this separately as
`0x0d0fd33bb2b98d705e431cc8844b83ef841aadb9862f92f4e532544d2f0669cc`, gas
`1562514000000000` wei. The earlier mint allowance setup was also separate:
`0x644cde2d458b334da8178d14acd243cf51ce4a63eadb37e015e769d0fba6f69a`, gas
`1558470000000000` wei. Thus the complete wallet STT delta was
`-9482856000000000` wei, equal to the four measured receipt gas amounts; the
two setup approvals are not settlement payout.

The normal `loadMarkets()` check returned `found: false`. Finalized history
rediscovered the exact `marketId` before and after redemption on the first
attempt. The structured event sequence was:

`SETTLEMENT_SESSION_STARTED`, `COMPLETE_SET_MINTED`, `MARKET_RESOLVED`,
`REDEEM_PLANNED`, `REDEEM_SUBMITTED`, `REDEEM_CONFIRMED`,
`PAYOUT_RECONCILED`, `SETTLEMENT_SESSION_CLEAN`.

The final read-only claim sweep scanned 200 finalized BTC rows and reported no
claimable outcome; it identified only this known losing-side residual. No
transaction was sent by the final claim sweep or by any inherited dry-run
gate.

## Phase 5B successor-market rollover (2026-08-26)

The bounded read-only verifier ran against Shannon using the existing
disposable operator address and the installed @somnia-chain/markets-sdk
0.28.1. It selected a short BTC Market A, observed its terminal transition
with chain time, verified zero A orders, rediscovered a later same-series
Market B, rechecked B on-chain, and assembled a fresh B reference -> fair
value -> governor -> quote-plan context. No transaction function was called.

Final live identifiers and timing:

| Fact | Evidence |
| --- | --- |
| Market A | 0x000000000000000000000000000000000000000000000000000000000000a17b |
| A series / expiry | BTC binary 60s / 1787745240 |
| A YES / NO ids | 776664966871418313858016266783285107726519691425877167524175228708608 / 776664966871418313858016266783285107726519691425877167524175228708609 |
| A pool / venue | 0x1ccedff37647f3216201b5b556dc28fdf9d71eb4 / 0x1a1e6821cde7d0159c0d293177871e09677b4e42307c7db3ba94f8648a5a050f |
| A terminal observation | chain time 1787745241, status 4, isResolved true, isVoided false |
| A open orders | chain 0, indexed 0, VERIFIED |
| Market B | 0x000000000000000000000000000000000000000000000000000000000000a17d |
| B series / expiry | BTC binary 60s / 1787745300 |
| B YES / NO ids | 1794547639858194023358288879777632407713807181339744266363869969026304 / 1794547639858194023358288879777632407713807181339744266363869969026305 |
| B pool / venue | 0x42903fa9f7fe00dd26d29bdc1d826caa6dc29e62 / 0x1a1e6821cde7d0159c0d293177871e09677b4e42307c7db3ba94f8648a5a050f |
| B discovery | client.listLiveBinaryMarkets, one candidate, 593 ms |
| Stop -> successor observation | successor appeared at chain time 1787745242 |
| Observed A/B overlap | 0s; B was first observed after A left Trading |
| B reference | 78529.44, explicit strike, raw scale 10^2 |
| B underlying | 78532.35 |
| B remaining time | 57s by chain time |
| B realized volatility | 3.8973363e-5 per square-root second |
| B fair value | UP 55.0108%, DOWN 44.9892%, villa-fv-v1 |
| B data quality | HIGH, score 0.95 |
| B governor | ALLOW, primary reason NONE |
| B quote plan | NO_QUOTE (minimum-quantity / post-only constraints; retained, no fallback) |
| B inventory | YES 0, NO 0 raw; exact B ids only |
| B open orders | chain 0, indexed 0, VERIFIED |
| final active operator orders | 0 |
| known Phase 5A residual | market ...a00b, NO 1000 raw, KNOWN_ZERO_VALUE_SETTLED_RESIDUAL |
| transactions | 0 |

The run took approximately 57s wall time including the short A stop
observation. The terminal boundary was chain-authoritative; local wall time
was used only for the bound and latency measurements. The B YES book was read
separately: best bid 541000, best ask 571000, midpoint 55.60%,
comparison-only. It did not enter fair value, governor, or quote-centre input.

The pure rollover suite added 45 deterministic tests. The repository suite
after Phase 5B is 287 tests, with the inherited 242 tests preserved.

Known limitation: the verifier tracks A in the rollover settlement history
but does not claim or alter A's terminal balances. The existing Phase 5A
settlement lifecycle remains responsible for settlement claims. A B HALT or
NO_QUOTE is a valid bounded rollover outcome, not a reason to select a third
market. This milestone is not a continuous writer.

## Phase 6A bounded autonomous market-making run (2026-08-26)

Phase 6A adds the bounded `villa-loop-v1` orchestrator. It combines fresh
`villa-fv-v1` -> `villa-risk-v1` -> `villa-quote-v1` decisions with the
verified binary execution, inventory, settlement, and rollover boundaries.
The default policy is exact `BINARY:BTC:300`, at most three initialized
markets, 720 chain seconds, two simultaneous resting orders, 30 runner-counted
transaction actions, two replacements, one minimum complete-set lot per
market, `0.002` tUSDC committed collateral, and `0.001` tUSDC directional
exposure. The final wet proof used an effective `--max-markets=2` cap.

The full dry run used:

```text
npm run villa:bounded:dry -- --max-markets=2
```

It initialized two exact BTC 5m windows, exercised virtual inventory and
orders, produced `NO_QUOTE` and lifecycle cleanup paths, completed successor
handoff, sent zero transactions, and ended with zero active orders.

The final wet invocation used the existing disposable Shannon wallet:

```text
npm run villa:bounded -- --max-markets=2
```

It returned `RESULT: PASS` with `orchestratorVersion: villa-loop-v1`,
`transactionCount: 12` runner-counted actions, `orderReplacements: 0`,
`finalActiveOrders: 0`, and a clean session. The runner's transaction budget
is a logical bounded writer-operation counter; SDK auto-approval writes, when
needed by the SDK, remain inside the same SDK trader and serialized writer
boundary. A post-run nonce check reported equal latest and pending nonce.

| Fact | Evidence |
| --- | --- |
| Exact series | `BINARY:BTC:300` only; no cadence or asset fallback |
| Market A | `0x000000000000000000000000000000000000000000000000000000000000a3dd`; expiry `1787759700`; terminal/resolved |
| Market B | `0x000000000000000000000000000000000000000000000000000000000000a3e9`; expiry `1787760000`; terminal/resolved |
| Market continuation | A stopped and cleaned before later same-series B initialization; one rollover |
| A fair-value samples | approximately `6.0%` to `48.3%` pUp during the live window |
| B fair-value samples | approximately `48.6%` to `93.4%` pUp during the live window |
| Governor | `ALLOW` throughout most cycles; one recoverable `HALT` for `MODEL_CONFIDENCE_LOW`, then resumed safely |
| Quote behavior | `NO_QUOTE` on post-only-crossing/minimum-grid conditions; no taker fallback |
| Complete-set mints | 2, `2000` raw total |
| Submitted orders | 3 `SELL_YES` asks and 2 `BUY_YES` bids; both sides rested simultaneously in each market |
| Replacements/cancellations | 0 replacements; 3 exact cancellations |
| Organic fills | 2 full `SELL_YES` fills, `1000` raw each; no intentional fill and no second wallet |
| Post-fill state | Each market retained exactly `YES 0 / NO 1000` raw as an explicit old-market settlement residual |
| Settlement/claim path | A and B were tracked through terminal resolution; redeem writes `0`; read-only finalized claim sweep found their known winning NO residuals claimable and sent no write |
| Final active state | both wet markets resolved with zero active order ids; final configured-series scan empty |
| STT | initial `49890097214000000000` raw; final `49851275504000000000` raw |
| tUSDC collateral | initial `99999310` raw; final `99997954` raw |
| Gas | `38821710000000000` wei recorded by the runner |
| Prior residual | market ending `a00b`, `NO 1000` raw, `KNOWN_ZERO_VALUE_SETTLED_RESIDUAL`, no claimable balance |
| Event stream | 573 deterministic lifecycle events observed; the journal stores the secret-free summary and reconciliation state |

The final public reconciliation independently read both market ids as status
`4` (`Resolved`), `isResolved: true`, `isVoided: false`, `YES 0`, `NO 1000`,
and zero active order ids. The read-only finalized claim sweep scanned 200
rows and reported the A and B `NO 1000` balances as claimable winning
residuals, plus a pre-existing `a3cf` `YES 1000` claim candidate. The known
prior `a00b` loser remained a zero-value non-claimable residual. The runner
sent no redeem or claim transaction. No pending transaction remained.

The two fills were natural full fills of the resting YES asks. The runner
recorded the resulting NO residuals under their exact old market ids, reran
fresh model/risk/quote logic after each fill, and never used those residuals as
successor inventory. The wet run therefore proves bounded autonomous
continuation and cleanup, not profitability, guaranteed fills, complete P&L,
or an always-on service.

During implementation, two operational edges were made explicit: nested SDK
write calls are all routed through one queue without queue self-deadlock, and
short-lived indexer lag is accepted only when chain state matches known
session order ids and expected raw prices. Unknown or contradictory orders
still fail closed. The midpoint was collected for comparison only and did not
enter fair value, governor, or quote-centre inputs.

The Phase 6A pure suite added 60 deterministic tests, bringing the suite to
347/347 at that milestone. Phase 6A.1 adds 16 recovery tests; the current
repository suite is 363/363, preserving all 347 prior tests. No frontend or
Phase 6B work was started.

## Phase 6A.1 organic fill -> settlement -> redeem (2026-08-26)

This focused recovery ran after Phase 6A and did not start the autonomous
loop or create any new market-making state. The exact cases came from the
Phase 6A fill evidence: market A `...a3dd` with fill order
`55340232221128713213`, and market B `...a3e9` with fill order
`18446744073709615271`. Both fills were `SELL_YES 1000` raw and both left
`YES 0 / NO 1000` raw after their markets resolved.

The pre-claim plan checked A and B through finalized BTC history, and checked
the aged-out `a00b` case by its exact direct on-chain market id. All three
cases then passed exact on-chain state, payout-vector, wallet-balance, and
zero-active-order checks:

| Case | Chain settlement | Payout vector | Claim balance | Plan |
| --- | --- | --- | --- | --- |
| `...a3dd` | status `4`, resolved, winner NO | `[0,10000000]` | NO `1000` raw; token `6581887522981231166894129818630694520938795290852728544886350510349313` | REDEEM, expected `1000` raw |
| `...a3e9` | status `4`, resolved, winner NO | `[0,10000000]` | NO `1000` raw; token `6468875483760989288541009934126241821734299972216764884215967483228161` | REDEEM, expected `1000` raw |
| `...a00b` | status `4`, resolved, winner YES | `[10000000,0]` | NO `1000` raw | SKIP: `KNOWN_ZERO_VALUE_SETTLED_RESIDUAL` |

The exact redemption sequence was A then B through one serialized queue:

| Market | Redeem transaction | Amount | Expected payout | Actual payout | Gas |
| --- | --- | ---: | ---: | ---: | ---: |
| `...a3dd` | `0xc365dcd77a9f66ade5ca3363812ebccbbad091eb8618167e53693b230919d134` | `1000` raw NO | `1000` raw | `1000` raw | `2836314000000000` wei |
| `...a3e9` | `0xb04fffb4f9c55248e387029a66bc1de1e5671fd5cdd59f5b6be6b815e6ca4` | `1000` raw NO | `1000` raw | `1000` raw | `2836314000000000` wei |

Both receipts were successful. Independent post-claim reads reported A and B
as status `4`, `isResolved: true`, `isVoided: false`, payout vector
`[0,10000000]`, `YES 0`, `NO 0`, and verified zero open orders. The old
`a00b` read remained `YES 0 / NO 1000`, winner YES, vector `[10000000,0]`,
and zero open orders. It was never submitted to the writer.

Recovery accounting:

- recovery baseline: STT `49851275504000000000` raw; tUSDC `99997954` raw;
- final: STT `49845602876000000000` raw; tUSDC `99999954` raw;
- collateral recovered: `2000` raw (`0.002` tUSDC);
- redeem gas total: `5672628000000000` wei, equal to the two measured receipt
  gas amounts;
- native STT gas and tUSDC payout were recorded separately;
- `REALIZED_PNL_NOT_YET_FULLY_ACCOUNTED`: the ledger lacks complete per-fill
  maker execution proceeds, protocol fees, and any other cash-flow components
  required to calculate true realized maker P&L.

The pre-claim sweep scanned 200 finalized rows and found A, B, and unrelated
`...a3cf` as claim candidates. The post-claim sweep scanned 200 rows and found
only unrelated `...a3cf` YES `1000` raw. A duplicate-prevention confirmed dry
check planned zero A/B redeems and classified both as `ALREADY_REDEEMED`; it
again skipped `a00b`. No new order, mint, or second wallet was used.

The recovery event additions were
`ORGANIC_FILL_POSITION_TRACKED`, `KNOWN_RESIDUAL_CLASSIFIED`,
`CLAIMABLE_POSITION_FOUND`, `REDEEM_PLANNED`, `REDEEM_SUBMITTED`,
`REDEEM_CONFIRMED`, `ORGANIC_FILL_PAYOUT_RECONCILED`,
`CLAIMABLE_POSITION_CLEARED`, and `SETTLEMENT_RECOVERY_CLEAN`.

The recovery journal is `runtime/state/organic-fill-recovery-v1.json`. It
contains the original fill references, exact claim receipts, structured
recovery events, residual registry, and final clean state. The original Phase
6A journal/evidence was not rewritten.

## Phase 6A.2 final wallet-state hygiene

The starting backend commit was
`ccf61a6a529e9eefeed01666d1aad72d573eee46`. The Phase 6A.1 post-claim sweep
left an unrelated finalized candidate ending `a3cf` with YES `1000` raw. A
read-only exact indexer lookup identified it as:

| Field | Verified value |
| --- | --- |
| marketId | `0x000000000000000000000000000000000000000000000000000000000000a3cf` |
| asset / interval | BTC / 300 seconds (`5m`) |
| expiry | `1787759400` |
| YES token / NO token | `776664966871418313858016266783285107726519691425877167524175228726272` / `776664966871418313858016266783285107726519691425877167524175228726273` |
| indexer status / on-chain status | `Finalized` / `4` |
| resolution | resolved, not voided |
| payout vector / winner | `[10000000,0]` / YES (`0`) |
| wallet balances before | YES `1000`, NO `0` raw |
| open orders | `0`, verified against indexer and chain |

The market's direct indexer row records one filled VILLA-wallet `BUY_YES`
order, order id `147573952589676446899`, quantity `1000`, price `690000`,
placed transaction
`0x6c621c1b73a7737ac37115abd349057540ec4df5dc5f844a07aa7c273ed9b9f5`, and
fill transaction
`0xac5752a04f75ba4bfa384412664f447320ac8aa8bbbaca563533268bd5589dd2`.
No matching VILLA runtime journal or structured session event records this
market, so exact session attribution is unavailable. The audit records that
gap rather than fabricating a phase origin.

`a3cf` was conclusively `CLAIMABLE_SETTLED_INVENTORY`. The exact YES claim was
submitted through the existing serialized wallet queue in
`0xacc6c3173fd5c5ef887a93df6d1e56472ac054f5cfe7b246d8e7f4484e7af28f`.
Expected and actual payout were both `1000` raw; redeem gas was
`2836242000000000` wei. Before/after balances were STT
`49845602876000000000` / `49842766634000000000` raw, tUSDC
`99999954` / `100000954` raw, and YES `1000` / `0` raw.

The complete indexed portfolio contained only two nonzero positions before
the claim: `a3cf` YES `1000` (claimable) and `a00b` NO `1000` (known zero-value
settled residual). After the claim, only `a00b` remained. The final full audit
reported `UNKNOWN = 0`, active-order count `0`, and no claimable winners. The
finalized sweep scanned 200 rows and returned no claimable entries.

The pure audit model is `villa-wallet-hygiene-v1` in
`src/settlement/wallet-audit.mjs`; its tests cover claimable winners, known
zero-value losers, active and paired-burnable inventory, exact token/balance
agreement, and unknown fail-closed behavior. The frontend boundary is
`villa-dashboard-v1` in `src/dashboard/contract.mjs`; it maps system, market,
model, book/quotes, risk, inventory, activity, lifecycle, and accounting facts.
Accounting exposes `PNL_UNAVAILABLE` and never fabricates realized PnL.

The ignored wallet hygiene journal is `runtime/state/wallet-hygiene-v1.json`.
No private key or secret was written. The backend-freeze handoff is
`docs/BACKEND_FREEZE.md`.

## Phase 6B operator cockpit (2026-08-27)

The frontend is a single-page vanilla HTML/CSS/ESM cockpit. It consumes the
existing `villa-dashboard-v1` contract and keeps the backend trading layers
feature-frozen. `scripts/dashboard-server.mjs` exposes a server-side live
read-only adapter and a separate `REPLAY` adapter. The browser receives no
environment variables, private key, signer, writer queue, or transaction
function.

The replay scenes use exact recorded facts from the Phase 4B quote-cycle
verification, Phase 5B rollover verification, and the Phase 6A plus Phase 6A.1
fill and redemption evidence. The quote scene shows the exact recorded
DreamDEX midpoint `71.65%` as comparison-only and leaves individual best levels
unavailable because the verification record did not retain them. The rollover
scene shows exact B market facts ending `a17d`, including `55.0108%` fair UP,
`57s` remaining, book levels `541000` and `571000`, and `NO_QUOTE`. The
settlement scene shows the real A/B organic fill order ids and the exact three
redeem transaction hashes. No synthetic continuous event timestamps are added.

Focused dashboard tests pass `30/30`; the full repository suite is run after
the frontend checks. Dashboard build output is generated under ignored
`dist/dashboard`. No transaction is required by any dashboard command.

Final local checks for this handoff: `npm test` passed `402/402`,
`npm run dashboard:build` passed, `audit_ui_text.py dashboard` reported zero
long-dash errors and zero small-text warnings, and `git diff --check` passed.
The replay server returned HTTP 200 for the page, assets, scene list, and all
three recorded scenes. The in-app browser runner could not initialize its
kernel assets, and the fallback browser runner was denied VM access, so no
rendered screenshot claim is made. `npm run doctor`, `npm run fair-value`, and
the live dashboard endpoint were attempted but Shannon/indexer access returned
`fetch failed`; those read-only failures did not cause a code or backend
change.
