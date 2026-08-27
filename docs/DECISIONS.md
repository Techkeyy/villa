# Decisions

Only decisions that change the build. Each one has a why and a source.

## D1. VILLA is an operator LP desk, not a betting app

**Why:** Directing brief. DreamDEX already hosts the markets. UX 20% is spent on the person who funds and sets limits.

**Consequence:** No Up/Down picker as the primary screen. No Telegram bot.

## D2. Do not ship `ec-maker` plus a dashboard

**Why:** Brief forbids it. Official `ec-maker` source literally prices as "mid of the current YES book, or 0.5 when a side is empty" and says "the plumbing around it is the point." (`strategies/ec-maker/src/index.ts` in the cloned bot kit.)

**Consequence:** Fair-value, adaptive quoting, and the governor are the product. Kit plumbing may be *read* and reimplemented, not forked as the identity.

## D3. Event Contracts go through markets-sdk 0.28.1, never the HTTP API

**Why:** Official Event Contracts page: HTTP API "covers spot only and has no event-contract endpoints." Installed package is 0.28.1. Docs floor is 0.28.0 (tick-grid float bug below that). Bot-kit test report pinned `^0.22.0` — **disagreement**. We prefer the package we installed plus current docs, not the August 6 kit report.

**Consequence:** `npm` dependency is `@somnia-chain/markets-sdk@^0.28.1`. Do not copy kit comments that still describe 0.22 revert-does-not-throw behaviour without checking 0.28.

## D4. Spot operator/session keys are not VILLA's custody model for MVP

**Why:** `spot/operatorGrants.ts` in the SDK: "SPOT-ONLY: the registry gates SpotPool's operator entry points (`placeOrderFor` and friends). A BinaryPool escrows through the module and has no operator gate." Bot-kit `docs/session-keys.md` is written against spot `Pool.place` / vault deposits. `packages/ec-core` has **zero** `OWNER_ADDRESS` / `placeOrderFor` usage.

**Caveat:** Binary ABI still exposes `placeBinaryOrderFor`. Authorization path for that entry is **NOT YET VERIFIED**. Do not build split-key trading on it until a live grant+place succeeds.

**Consequence:** MVP signs with the operator's own disposable EOA. Vault/session-key is stretch.

## D5. Network is Shannon testnet 50312 only

**Why:** Hackathon requires a testnet prototype. Collateral decimals differ (tUSDC 6 vs USDso 18). Mixing them silently mis-sizes orders.

**Consequence:** Pin chain id in doctor. Derive decimals from the token. No mainnet.

## D6. VENUE_ID is read from live rows, never hardcoded from kit docs

**Why:** Bot-kit `docs/event-contracts.md` still prints testnet `VENUE_ID=0x679795a0…`. Live `listBinaryMarkets` on 2026-08-24: 186/200 recent rows sit on `0x1a1e6821…`, only 14 on `0x6797…`. Kit source itself says venue ids moved three times in a week.

**Consequence:** Discover venue from live markets. Hardcoding the README value would quote nothing.

## D7. Fair value is an independent pure layer

**Why:** VILLA must add intelligence above `ec-maker`. The model may use the underlying price, the market's reference, time remaining, and realized volatility; it must not learn its baseline probability from the DreamDEX midpoint.

**Consequence:** Data acquisition is separated from a pure `inputs → {pUp, pDown, confidence, dataQuality}` function. The order book is fetched only for an explicitly labelled comparison.

## D8. Governor is off-chain deterministic rules in MVP

**Why:** All listed tripwires are computable off-chain from feeds we already read. On-chain hard caps would need a new contract and Foundry-on-PATH work. Not required to keep the safety *promise* if the process actually stops sending orders.

**Trust:** operator trusts our process. Resting orders still need `expireTimestampNs` as dead-man switch (official gotcha #5; SDK ABI requires it).

## D9. Successor following is rediscovery, not a cached pool address

**Why:** Official gotcha #12 and SDK comments: pools recycle; key by `marketId`. Kit `activeMarkets()` reloads `loadMarkets(true)` each cycle. Reactivity roller is optional (`@somnia-chain/reactivity` peer) and not needed for MVP if we poll.

## D10. No LLM in the decision path

**Why:** Brief describes deterministic safety. `build-process` skill: model narrates, rules decide. An "AI predicts 15m BTC" project is the crowded, weak lane (hackathon copy names agents; originality 20% punishes the obvious one).

## D11. Controlled second wallet only if disclosed, never as fake volume

**Why:** Directing instruction. Organic testnet flow is thin (`tradeCount` 0 on most live windows this session; ETH 4h had 4). A taker wallet to prove fill-handling is legitimate **verification**, labelled as such, not a demo lie.

## D12. Do not parse question text; do not assume 15m/1h only

**Why:** Gotcha #13. Consumer docs still say BTC/ETH 15m and 1h. Live indexer 2026-08-24 also served 60s, 300s, 900s, 3600s, 14400s (plus a junk `898s` row). 1m/5m carry nonzero `strike`; 15m+ often `strike: "0"` and need `getOpeningPrices`.

**Consequence:** Filter by `asset` + `intervalSec`. MVP may pick one cadence for the demo (1m fits a video; 15m matches the marketing line). Decision of which cadence is still open; both exist.

## D13. Write-path uses `trader.placeOrder`, not unified `createOrder`

**Why:** Installed 0.28.1 `CreateOrderParams` has `postOnly` but **no** `expireTimestampNs`. Binary `PlaceOrderParams` does, and defaults to **market expiry** if omitted (`trade.ts`). A crashed test must not leave a quote until window end.

**Consequence:** `scripts/verify-write-path.mjs` sends `ORDER_TYPE.POST_ONLY` with an explicit nanosecond expiry capped below market expiry.

## D14. STT faucet is interactive; tUSDC faucet is on-chain

**Why:** Official STT sources (DoraHacks Telegram, https://testnet.somnia.network/, https://cloud.google.com/application/web3/faucet/somnia/shannon) require a browser/account. SDK `trader.faucet()` mints tUSDC but needs STT gas. Confirmed 2026-08-24: wallet 0 STT, so faucet tx cannot be sent.

**Consequence:** Wet write-path is blocked on a human STT drip. Do not invent a third-party faucet.

## D15. Confirm resting orders on-chain, not by receipt

**Why:** SDK `getOrderOnchain` is documented for "right after placeOrder" while the indexer lags (`orders.ts`). Cancelled orders read as `null`.

**Consequence:** The write-path script polls `getOrderOnchain` for presence and absence. `fetchOpenOrders` is secondary.

## D16. Wet BUY rest+cancel is proven; do not inflate it

**Why:** 2026-08-24 wet run placed BUY_YES 0.001 @ 0.774 on BTC 24h, saw it on-chain, cancelled it, escrow returned. Indexer listed the open order on the first poll (0ms) in this instance.

**Consequence:** The original quote-engine gate was BUY-only. Phase 4A now
separately verifies one minimum complete-set mint, a resting/cancelled
`SELL_YES`, and exact `burnSet`; fills, settlement, and other intervals remain
unverified. `loadMarkets()` remains slow (~3 min) and the SDK process can hang
after the last write — later architecture should use a bounded client
lifespan, not assume clean process exit.

## D17. tUSDC faucet amount is explicit and small

**Why:** SDK default is 10_000 (the cap). The write-path needs ~0.001 tUSDC of escrow. `fund-tusdc.mjs` requests **100**.

**Consequence:** Keep faucet amounts as an argument, never the silent cap.

## D18. `villa-fv-v1` uses a zero-drift log-return digital model

**Why:** `ec-maker`'s midpoint/0.5 value is circular, while `ec-oracle-follow`'s signal is a directional taker that anchors part of its decision to the book. VILLA needs a standalone, understandable baseline for a liquidity provider. A zero-drift log-return model is the smallest defensible mapping from moneyness, remaining seconds, and realized uncertainty to `P(final price >= reference)` without fitting a tiny sample or claiming a mean-reversion/momentum edge.

**Formula:** `pUp = Φ(ln(S/K) / (σ√τ))`, with `σ` in per-√second realized log-return units and `τ` in seconds. At exact expiry the result is the discrete settlement indicator.

**Consequence:** The initial model version is `villa-fv-v1`. Its confidence is a separate deterministic data-quality score; it refuses stale/malformed/insufficient inputs and has no inventory, PnL, wallet, governor, or order dependency. Details and limitations live in `docs/FAIR_VALUE_MODEL.md`.

## D19. Use SDK price history and chain time for the Phase 2A snapshot

**Why:** SDK 0.28.1 exposes `client.fetchPriceHistory` with underlying `PricePoint` timestamps and `fetchPriceFeedInfo` freshness metadata. This is more direct for realized volatility than treating the 1m candle update count as trade volume. The live check also showed Shannon's chain timestamp was about 556 seconds ahead of the workstation clock.

**Consequence:** VILLA computes volatility and expiry using the feed's latest chain timestamp, reports a bounded clock-skew warning, and refuses genuinely stale/future-invalid feed data. The user-facing snapshot exits after one read-only result.

## D20. Risk governor is `villa-risk-v1` pure policy, not a quoting loop

**Why:** Fair value says what UP may be worth; it must not decide whether VILLA
should trade. The risk boundary needs deterministic, testable permissions and
stable reasons before any model output can affect a live writer.

**Consequence:** `evaluateRisk(snapshot, config)` has no RPC, GraphQL, SDK,
environment, clock, wallet, book, fair-value collector, inventory reader, or
order-control dependency. It returns `ALLOW`, `REDUCE_ONLY`, or `HALT` plus
`cancelExisting` as a non-executing recommendation. There is no Phase 2B order
path.

## D21. Chain time is authoritative for risk expiry and feed age

**Why:** Shannon was observed roughly 556 seconds ahead of the workstation
clock during Phase 2A. Local wall-clock arithmetic could therefore either
trade an expired window or refuse a healthy one.

**Consequence:** The collector reads a current block and the pure governor
computes `expiry - chainNow`. Price age compares the feed timestamp with the
same chain timestamp. Local timestamps and the observed offset are diagnostics
only; stale chain observations halt.

## D22. Pending exposure stresses every signed binary order delta

**Why:** The earlier buy-only stress model was unsafe. A SELL can break a
complete set and create directional exposure: from YES 10 / NO 10, a filled
SELL_YES 5 leaves YES 5 / NO 10, or 5 DOWN residual. A pending SELL is not
automatically protective merely because it could reduce the current balance.

**Consequence:** The pure exposure layer uses `D = YES - NO` and the verified
mapping `BUY_YES +q`, `SELL_YES -q`, `BUY_NO -q`, `SELL_NO +q`. Worst UP adds
every positive pending delta; worst DOWN subtracts every negative pending delta.
Opposing orders are not optimistically netted. Gross inventory and pending BUY
collateral remain separate accounting dimensions. A chain/indexer mismatch or
missing YES/NO classification still halts rather than silently dropping an
order.

## D23. Reduce-only actions cannot cross neutral

**Why:** A reduce-only permission must decrease the current absolute
directional exposure, not allow an arbitrarily large opposite-side order.

**Consequence:** With `D > 0`, only SELL_YES and BUY_NO are reducing actions and
their combined quantity is capped at `D`. With `D < 0`, only BUY_YES and SELL_NO
are reducing actions and their combined quantity is capped at `-D`. A proposed
quantity that crosses zero is rejected or capped at neutral. With `D = 0`, no
reduce-only action is permitted. The future planner can use the pure
`assessReduceOnlyOrder` helper before adding a candidate to the resting-order
stress set.

## D24. Drawdown is an explicit accounting input, not an invented zero

**Why:** The repository does not yet have a reliable session equity, PnL, or
high-water-mark ledger. A governor that silently supplied `0%` would make a
false safety claim.

**Consequence:** The live Phase 2B snapshot passes `UNAVAILABLE`, emits
`DRAWDOWN_UNACCOUNTED`, and uses an explicit non-strict testnet policy. Strict
configuration fails closed until a future accounting layer supplies a ratio.

## D25. Quote around independent value, not book midpoint

**Why:** The official `ec-maker` already provides symmetric post-only plumbing
around the YES book midpoint. VILLA's differentiation is an independent
`villa-fv-v1` value plus deterministic inventory skew, adaptive spread, size,
and risk-aware permissions. Feeding the midpoint into pUp would turn VILLA
back into a wrapper around the reference maker.

**Consequence:** `villa-quote-v1` uses pUp as its centre, moves it only for
bounded signed inventory skew, and uses realized move, confidence, and expiry
to widen/reduce quotes. The book is comparison/post-only input only. No quote
planner output is an order and no live writer exists in Phase 3.

## D26. One YES book with exact raw grid arithmetic

**Why:** DreamDEX's binary representation exposes YES/NO outcomes, but the
market-maker surface can be expressed as a single YES bid/ask. The installed
SDK's `getBinaryBookParams` provides the authoritative tick, lot, and minimum
quantity. Floating-point prices can create off-grid orders or cross a moving
book by one tick.

**Consequence:** VILLA plans `BUY_YES` and `SELL_YES` only, derives DOWN as
`1 - pUp`, serializes raw price/quantity as decimal strings, floors bid/lot
quantities and ceils ask prices with integer arithmetic, and fails closed on
invalid raw grid inputs. A future execution layer must re-read the book before
submitting any post-only order.

## D27. Pending orders remain separate in quote projection

**Why:** Phase 2B corrected the exposure model after identifying that SELLs can
break complete sets and that opposing pending orders must not be treated as a
guaranteed net fill. A two-sided planner that nets its own bid and ask would
reintroduce that safety flaw.

**Consequence:** Every candidate quote is projected with existing pending
orders through `calculateBinaryExposureWithAdditionalOrder`; a two-sided plan
is checked with both proposed orders without optimistic netting. Sell
inventory is separately reserved against existing YES asks.

## D28. Complete-set mint and SELL lifecycle is a separate bounded adapter

**Why:** Phase 3 proves a pure plan, not that VILLA owns outcome inventory or
that a SELL can rest and be cancelled. The official kit already has SELL
plumbing, but VILLA needs verified complete-set accounting and cleanup before
any quote execution is allowed.

**Consequence:** `villa-inventory-v1` owns raw mint-size, complete-set,
committed-sell, post-only-ask, chain-time-expiry, and exact-burn helpers. The
live verifier performs only one minimum-size sequence and refuses an unclean
wallet, ambiguous read, unsafe price, fill, or incomplete pair. It never
connects planner output to live order control.

## D29. Use observed venue balance semantics, not a double reservation

**Why:** On Shannon, the controlled resting `SELL_YES` reduced the visible
ERC-6909 YES balance from 1000 raw to 0 while its on-chain order retained 1000
raw. Cancellation restored the balance. The token was escrowed by the venue.

**Consequence:** A future execution adapter passes the visible/free YES balance
to the planner when it already excludes committed SELL quantity. It subtracts
reconciled open SELL quantity only for a venue state where committed tokens
remain visible. The risk governor still includes the pending SELL's signed
directional stress independently.

## D30. Execution is a bounded adapter, not a quote loop

**Why:** The pure planner is valuable only if it remains independently
testable, while an always-on loop would introduce unbounded transaction and
inventory risk before settlement and restart behavior are designed.

**Consequence:** `villa-execution-v1` runs one explicit session on one current
BTC market. It reads, prices, governs, plans, preflights, places at most two
post-only targets, reconciles, cancels exact session IDs, and cleans up. A
continuous quoting loop is a later milestone.

## D31. Every signer write uses one serialized queue

**Why:** The SDK tracks the local nonce across writes, but concurrent callers
or cleanup racing placement can still create ambiguous ordering and unsafe
recovery.

**Consequence:** Mint, placement, cancellation, and burn are awaited through
one promise chain. There is no `Promise.all` around writes, no broad cancel,
and no second wallet. The queue is closed after cleanup.

## D32. Verification caps may reduce size, never change price

**Why:** A tiny live test should exercise the real planner target while
limiting capital and inventory exposure. Moving the price toward the midpoint
would make the test no longer representative of VILLA's plan.

**Consequence:** The execution cap is one minimum valid lot. It applies only as
`min(plannerQuantity, cap)`. Raw planner price, action, side, and disabled
state are preserved exactly.

## D33. Revalidate after inventory and after the first order

**Why:** Minting changes collateral and outcome inventory; a resting order
changes pending exposure and venue-visible inventory. A stale pre-mint plan is
not safe to reuse.

**Consequence:** The adapter runs the live fair-value → risk → quote pipeline
again after mint and after the first reconciled order, and again before each
possible write. A fresh HALT or NO_QUOTE skips the remaining side safely.

## D34. Chain-active state and indexer state must reconcile before cleanup

**Why:** A receipt is not proof that an order is resting or gone, while an
indexer can lag or classify a recycled pool incorrectly.

**Consequence:** Active on-chain fields are checked first; matching indexer
fields strengthen the evidence. Contradictions are `UNKNOWN`, retried only in
a bounded window, and block any burn that would require guessing. Cleanup
enumerates only this session's recorded IDs.

## D35. Settlement truth is the on-chain payout vector, not the question or indexer label

**Why:** The installed SDK 0.28.1 models on-chain `Listed → Trading → Locked →
Settling → Resolved/Voided`. `Finalized` is an indexer-derived historical label.
The deployed market stores `payoutNumerators`; a question string and an
indexer winner can be stale or unavailable.

**Consequence:** VILLA waits for `isResolved`/`isVoided` and reads the deployed
payout vector. A `Finalized` row is used for rediscovery and claim sweeps, not
as a standalone winner decision. Contradictory state fails closed.

## D36. Redeem explicit outcome indices through the current SDK

**Why:** SDK 0.28.1 exposes `trader.redeem({ marketId, market,
outcomeToken, outcomeIdx, amount })`, where outcome index `0` is YES and `1` is
NO. `burnSet` is the pre-settlement equal-pair burn and is not a settlement
claim. The official `ec-core` settlement helper also skips resolved losers and
redeems both sides of a void.

**Consequence:** VILLA submits only a held winning side for a resolved market,
both held sides for a void, and records every redeem leg independently. A
resolved loser may remain as a known zero-value ERC-6909 residual; VILLA does
not invent a losing-token payout or brute-force an unsupported redeem.

## D37. Claim sweeps are read-only first and sessions are restartable

**Why:** Settled markets can disappear from normal `loadMarkets()` while value
remains claimable. A process can also stop between mint, resolution, and claim.
Repeating a redeem without a balance read is unsafe.

**Consequence:** `verify:settlement:dry` scans `Finalized` by `marketId` and
reports nonzero claimable holdings without sending. Wet sessions persist only
non-secret state after each boundary under ignored `runtime/state/`; restart
reads the same market and skips zero/already-cleared legs. No cached pool is
used as market identity and no rollover is started in Phase 5A.

## D38. Series identity is binary asset plus exact interval

**Why:** A pool is recycled between Event Contract windows, and live venue
identifiers can change. The successor relationship must be defined by stable
market semantics, not by a pool, symbol, question text, or a stale venue
constant.

**Consequence:** villa-rollover-v1 uses BINARY:<ASSET>:<intervalSec> as the
series key. Venue is captured for evidence but is not required for a valid
same-series successor. Every candidate and every active context still has an
explicit marketId.

## D39. Rollover uses chain-time polling and earliest later expiry

**Why:** A short market can move from Trading to Resolved between reads, and
the workstation clock was previously observed out of sync with Shannon. The
next window must be discovered from the current source rather than derived
from A's id or pool.

**Consequence:** The bounded adapter gates A stop and B selection with current
chain block time, accepts either terminal observation (Resolved or Voided),
rechecks B on-chain, chooses the earliest later expiry for the exact series,
and fails closed on equal-earliest ambiguity. No candidate means an explicit
WAITING_FOR_SUCCESSOR state.

## D40. Market, wallet, strategy, history, and settlement scopes are explicit

**Why:** A rollover must not carry A's outcome ids, inventory, pending orders,
or quote decision into B, while capital/risk configuration and underlying
history may legitimately persist. A settled losing token can also remain in a
wallet without being tradeable inventory.

**Consequence:** B initialization resets market scope, preserves wallet and
strategy scope, retains only fresh/gap-safe underlying ticks, and keeps A in a
separate settlement registry. Exact B token ids are the only ids used for B
inventory; old residuals are labelled rather than hidden.

## D41. Phase 5B stops at a read-only B decision context

**Why:** Fair value, risk, and the quote planner are now available for B, but
connecting rollover directly to order control would turn a lifecycle proof
into an unbounded trading loop before restart and settlement behavior are
complete.

**Consequence:** The verifier may end in SUCCESSOR_READY or a structured
HALTED/NO_QUOTE context, but sends no transaction and does not select a
fallback market. The existing Phase 5A settlement path remains separate.

## D42. Phase 6A is a bounded orchestrator above verified layers

**Why:** Phase 5B proved fresh successor context but deliberately stopped
before order control. The product edge is the composed lifecycle, not a fork
of `ec-maker` or a giant replacement for the existing pure modules.

**Consequence:** `villa-loop-v1` coordinates fresh collection → fair value →
risk → quote → execution preflight → reconciliation → cleanup → rollover.
The orchestrator owns scheduling and state, while `villa-fv-v1`,
`villa-risk-v1`, `villa-quote-v1`, inventory, settlement, and rollover remain
separate reusable boundaries.

## D43. The bounded runner is exact-series and chain-time controlled

**Why:** A verification run must prove autonomous window changes without
silently changing the risk surface. Live discovery previously showed multiple
cadences and recycled pools, and local time is not authoritative on Shannon.

**Consequence:** The runner accepts only `BINARY:BTC:300`, requires live
Trading status/headroom, keys every context by `marketId`, and uses chain time
for stop, expiry, terminal observation, and successor selection. Missing BTC
5m enters waiting/refusal; it never falls back to 1m, 15m, ETH, or another
venue.

## D44. Minimal verification caps are hard policy

**Why:** Drawdown/P&L accounting is not yet a production-grade loss model.
Small maker actions, bounded markets, and strict exposure/collateral/transaction
limits are the honest safety envelope for a live proof.

**Consequence:** The default session permits at most three windows, 720 chain
seconds, two resting orders, 30 transactions, two replacements, one minimum
complete set per market, `0.002` tUSDC committed collateral, and `0.001`
tUSDC directional exposure. The one-lot execution cap can only reduce a quote
planner quantity. These are verification limits, not production risk claims.

## D45. Requote only on material or safety-relevant change

**Why:** Cancelling and replacing on every ten-second read would create
avoidable queue churn and gas use while making a stale quote harder to audit.

**Consequence:** `villa-loop-v1` suppresses changes below two raw ticks or 25%
size difference, but immediately responds to inventory/fill, governor or side
validity changes, order age, and expiry headroom. All writes use fresh reads
and existing post-only execution gates.

## D46. One serialized writer queue and failure cleanup

**Why:** A single EOA must not race nonce-bearing mint, place, cancel, burn, or
future redeem calls. A failed process must not silently leave its own quote or
temporary pair behind.

**Consequence:** Wet orchestration creates exactly one queue and routes every
write through it. Cleanup cancels exact tracked ids, verifies chain/indexer
state, burns only the paired controlled increment, scans for active configured
series orders, and fails closed on unknown state. Dry mode has no signer and no
write path.

## D47. Phase 6A remains a bounded proof, not a daemon

**Why:** Repeated live writes need an explicit stop boundary, fresh
reconciliation, and successor isolation before any persistent service is
considered safe.

**Consequence:** `villa-loop-v1` may initialize only the configured BTC 5m
series inside strict market, time, order, transaction, collateral, and
directional caps. It records old-market settlement residuals separately,
requires terminal cleanup before successor handoff, and exits cleanly. The
wet proof's order-book midpoint is comparison-only; it never influences
`pUp`, governor state, or quote-centre selection. SDK raw-write transport is
kept inside the existing SDK Trader and one serialized queue, with the
official Shannon HTTP fallback used for the final bounded proof.

## D48. Organic-fill recovery is exact-market and claim-only

**Why:** Phase 6A produced real NO residuals, while the older `a00b` residual
is a known losing position. A generic balance sweep could redeem the wrong
market or spend gas on a zero-value token.

**Consequence:** Phase 6A.1 uses an explicit A/B/a00b case registry keyed by
`marketId` and recorded fill order id. It requires chain-authoritative
settlement and a market-specific payout vector before writing, redeems only
the winning A/B balances through one queue, skips `a00b` with
`KNOWN_ZERO_VALUE_SETTLED_RESIDUAL`, and records `ALREADY_REDEEMED` after
winning-balance clearance. It does not mint, quote, trade, or modify strategy
logic.

## D49. Final wallet hygiene precedes the backend freeze

**Decision:** Before frontend work, audit every indexed nonzero Event Contract
outcome balance against direct chain truth and settle only an exact, verified
winning residual. Classify losing settled tokens as known zero-value residuals;
classify missing or contradictory evidence as `UNKNOWN` and fail closed.

**Why:** The Phase 6A.1 claim sweep exposed an unrelated `a3cf` YES `1000`
position outside the A/B recovery registry. Ignoring it would leave the
wallet state unexplained, while blindly redeeming any sweep result could touch
the wrong market. The complete portfolio audit proved `a3cf` was the only
unclaimed winner and `a00b` the only remaining known loser.

**Consequence:** `scripts/wallet-hygiene-audit.mjs` redeemed only `a3cf` via
the existing queue, reconciled exact payout and gas separately, and required
zero active orders and zero unknown inventory before declaring the wallet
clean. `src/dashboard/contract.mjs` is the stable frontend boundary; it uses
`PNL_UNAVAILABLE` rather than inventing realized PnL. Backend trading features
are frozen for the hackathon.

## D50. The Phase 6B cockpit is one read-only page

**Decision:** Build one desktop-first operator cockpit over
`villa-dashboard-v1`, with a server-side live read adapter and clearly labelled
replay scenes. Do not add dashboard order controls or another frontend state
machine.

**Why:** The direct VILLA user supervises one autonomous liquidity desk. The
important decision is whether the desk is allowed to quote and why, not a set of
consumer market routes. A single page keeps fair value, venue comparison,
quotes, risk, inventory, lifecycle, settlement, and activity in one scan.

**Consequence:** Browser code has no signer or write capability. `REPLAY` uses
only recorded verification facts, avoids invented book levels and timestamps,
and keeps `PNL_UNAVAILABLE` visible. The server-side live adapter uses existing
read-only collectors and closes the SDK client after each snapshot.

## D51. Public cockpit deployment is replay-first and signer-free

**Decision:** Prepare one native Node dashboard service for public hosting with
replay as the default mode. Hosted configuration may contain only non-secret
read-only settings such as `HOST` and `PORT`.

**Why:** The hackathon demo must survive RPC/indexer outages, and the browser
must never receive operator custody or a wallet writer. A public deployment is
an observational product surface, not a hosted trading process.

**Consequence:** `npm start` serves the existing replay routes. Live mode is
opt-in and must report unavailable rather than silently showing replay. Wet
commands remain local CLI paths and are not part of hosting.
