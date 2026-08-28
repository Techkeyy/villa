# VILLA public experience and operator cockpit

**UI STATUS: FEATURE FROZEN**

Phase 6B.1 rendered QA passed across the recorded scenes and required desktop
and narrow viewports. Future UI changes require a concrete demo usability issue
or an audit-found bug.

## What it is

The default dashboard route is a public product explainer. It gives first-time
visitors the product context, workflow, safety posture, and verified proof before
they enter the operator surface. The explicit operator route is `?mode=operator`;
the public evidence route is `?mode=replay`.

## Operator cockpit

The VILLA cockpit is a single operator screen for supervising autonomous
liquidity on DreamDEX Event Contracts. It answers five questions quickly:

1. Which market is in view?
2. What does VILLA independently think UP is worth?
3. Which quote posture is currently possible?
4. What inventory and risk permission exist?
5. What did the system just do, and why?

The direct user is the capital allocator supervising VILLA, not a consumer
placing prediction bets. The screen is observational in Phase 6B. It has no
order, cancel, mint, burn, redeem, or session-control button.

## One-page structure

The cockpit is intentionally one page because the operator scans a live desk,
not a collection of administrative routes. The hierarchy is:

- system bar: network, series, state, market lifecycle, wallet abbreviation,
  and contract version;
- market hero: underlying price, reference, time left, VILLA fair value, and
  the DreamDEX midpoint labelled comparison only;
- decision row: fair-value split, quote posture, and Risk Governor permission;
- operating row: current-market inventory, deterministic decision trace, and
  successor handoff;
- evidence row: selected structured activity, settlement history, known
  balances, and the explicit PnL limitation;
- recorded-proof strip: exact evidence that is useful for a demo but is not
  presented as live data.

## Data boundary

```text
Shannon read-only adapter or recorded evidence
        -> buildDashboardSnapshot()
        -> villa-dashboard-v1 JSON envelope
        -> pure presenter projections
        -> browser cockpit
```

`src/dashboard/contract.mjs` remains the stable backend-owned shape. The
presenter in `src/dashboard/presenter.mjs` formats and groups facts for the
operator. It does not call RPC, inspect a wallet, calculate a trading decision,
or change a backend state.

### Live mode

`npm run dashboard:live` starts the local server with the existing `.env` and
uses the verified read-only risk collector, fair-value engine, quote planner,
and SDK reads. The browser receives only the resulting dashboard snapshot. It
never receives `PRIVATE_KEY`, a signer, or any other secret-like field. Live
mode refreshes on a 15-second read interval and has no write path.

The live activity list is empty when no structured session journal is attached
to the read. The UI says that directly rather than creating an activity event.

### Replay mode

`npm run dashboard:replay` starts the same local server without environment
variables. Replay is always marked `REPLAY` and provides three scene buttons:

- **Quote proof:** exact Phase 4B values for the recorded BTC 24h quote-cycle
  checkpoint, including VILLA fair UP `76.8%`, reference `78528.87`, underlying
  `78975.325`, time remaining `58320s`, volatility
  `3.208549e-5` per square-root second, and post-only targets `78.60%` ask and
  `72.50%` bid. The verification record retained the exact DreamDEX midpoint
  `71.65%` but not its individual levels, so the scene does not invent them.
- **Rollover proof:** exact Phase 5B successor facts for markets ending `a17b`
  and `a17d`, including the `55.0108%` fair value, `57s` remaining, exact
  `541000` and `571000` raw book levels, and the valid `NO_QUOTE` result.
- **Settlement proof:** exact Phase 6A and Phase 6A.1 fill, redeem, payout,
  and wallet-hygiene facts. This includes the two genuine external
  `SELL_YES` fills, the three exact redeem transactions, and the old `a00b`
  zero-value residual.

The replay scenes are evidence views, not a synthetic continuous market. Some
facts come from the Phase 6A verification record and some from the local
secret-free Phase 6A.1 recovery journal. The UI does not assign timestamps to
facts whose original timestamp was not retained.

## Status semantics

- `ALLOW`: the Risk Governor permits new risk. This does not mean an order was
  placed.
- `REDUCE ONLY`: only actions that reduce directional exposure are permitted.
- `HALT`: the governor has stopped quoting because a named safety rule fired.
- `NO QUOTE`: the governor is healthy, but no valid quote can be constructed,
  for example because of minimum-grid or post-only constraints.
- `QUOTING`: the current snapshot contains a target or resting quote.
- `ROLLING`: the lifecycle is waiting for or initializing a successor market.

The UI derives these labels from existing backend state. It does not introduce
a second decision engine. Exact reason codes stay visible next to readable
operator copy.

## Security and accounting

The server is the trust boundary for live SDK reads. The browser only receives
public market facts, public wallet address text, structured events, and factual
balances. There is no browser signer and no wallet write control.

Current-market YES, NO, complete sets, and directional exposure come from the
dashboard contract. Historical settled residuals are displayed only in
lifecycle or settlement history and are excluded from active capacity.

The accounting card shows known tUSDC and STT balances when available. It
always shows `PNL_UNAVAILABLE` because complete per-fill proceeds, protocol
fees, and all relevant cash flows are not yet present in the backend ledger.

## Commands

```text
npm run dashboard:dev       # local explainer-first dashboard
npm run dashboard:replay    # explicit recorded-evidence mode
npm run dashboard:live      # server-side read-only Shannon mode
npm run dashboard:build     # static production asset check into dist/dashboard
npm run dashboard:test      # dashboard contract and presenter tests
```

The dashboard server listens on `http://127.0.0.1:4173` by default. A different
port can be supplied with `--port=PORT`.

Hosted deployments should set `HOST=0.0.0.0` and keep the service in replay
mode unless a read-only Shannon configuration is deliberately provided. The
browser never receives signer material. `npm start` is the deployment-safe
replay command.

## Known limitations

- Live mode currently reads one current BTC market and does not attach the
  long-running orchestrator event journal.
- Replay is a set of labelled evidence scenes rather than an unbroken original
  573-event playback, because the original Phase 6A runtime journal was not
  retained as a committed artifact.
- There is no control surface for the bounded runner in this milestone.
- Full realized PnL and ROI remain unavailable.
- No explorer URL is generated because the inherited project does not define a
  verified explorer URL pattern. Hashes can be copied for inspection.
