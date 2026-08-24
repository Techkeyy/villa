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

## D7. Fair-value model is not chosen yet

**Why:** Directing brief: do not assume the exact model. Inputs that **exist** are verified (spot, ema, 1m OHLCV, strike field, `getOpeningPrices` for strike=0). The mapping from those inputs to a probability is a product choice.

**Consequence:** No closed-form in code until approved. Architecture reserves a pure function `inputs → {pUp, confidence}`.

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
