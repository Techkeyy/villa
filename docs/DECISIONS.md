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

**Consequence:** Quote engine can start from this place/cancel path. Do **not** treat SELL, mint, fills, or other intervals as verified. `loadMarkets()` remains slow (~3 min) and the SDK process can hang after the last write — later architecture should use a bounded client lifetime, not assume clean process exit.

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
