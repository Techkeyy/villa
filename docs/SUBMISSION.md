# VILLA DoraHacks submission draft

Status: prepared, not submitted. Public URLs and the video link remain
placeholders until the operator completes authenticated publication and
recording.

## Project fields

| Field | Prepared value |
| --- | --- |
| Project name | VILLA |
| Tagline | Independent liquidity intelligence for DreamDEX Event Contracts |
| Public repository | `PENDING_PUBLIC_REPOSITORY_URL` |
| Working prototype / demo | `PENDING_PUBLIC_DEPLOYMENT_URL` |
| Demo video | `PENDING_2_TO_3_MINUTE_VIDEO_URL` |
| Network | Somnia Shannon testnet, chain ID 50312 |
| Team/member fields | Complete in the authenticated DoraHacks form; not exposed on the public detail page |

## Short description

VILLA is an operator-facing liquidity engine for DreamDEX binary Event
Contracts. It independently estimates UP probability from the underlying
price, reference, time remaining, and realized volatility, then combines that
view with deterministic risk limits, adaptive post-only quoting, inventory,
settlement, and successor-market lifecycle logic.

## Longer description

Event Contract books need liquidity, but a maker that simply mirrors the book
does not have an independent view of value. VILLA is built for the liquidity
provider who supplies capital and wants a repeatable desk process: discover a
live window, calculate fair value from BTC data rather than the DreamDEX
midpoint, check the Risk Governor, plan inventory-aware quotes, reconcile fills,
redeem settled value, and rediscover the next same-series window.

DreamDEX remains the venue. VILLA uses the official markets SDK on Somnia
Shannon for Event Contract reads and bounded testnet writes. The public cockpit
is observational and replay-first. It never receives a signer or private key.

## Problem

The exchange plumbing can place orders, but robust autonomous liquidity still
needs answers to six operator questions: what is the contract worth, how should
inventory change the quote, when should quoting stop, how are pending orders
stressed, what happens after expiry, and how does capital reach the next window?
Empty books and unresolved lifecycle state leave capital idle or expose it to
unbounded operational risk.

## What VILLA adds above the official maker plumbing

- independent `villa-fv-v1` fair value, not book-mid pricing;
- confidence and data-quality aware outputs;
- `villa-risk-v1` deterministic ALLOW, REDUCE_ONLY, and HALT decisions;
- worst-case pending-order exposure accounting;
- `villa-quote-v1` adaptive spread, inventory skew, and exact binary grid math;
- bounded post-only execution with reconciliation and cleanup;
- complete-set inventory, settlement redemption, and successor rollover;
- an explainable operator cockpit with honest replay and `PNL_UNAVAILABLE`.

## Verified evidence

- live Shannon post-only BUY rested and was cancelled;
- complete-set mint, post-only `SELL_YES`, exact cancel, and `burnSet` passed;
- a bounded two-sided quote checkpoint rested and reconciled both sides;
- two genuine external `SELL_YES` fills were recovered and redeemed;
- successor discovery crossed a same-series BTC window without mixing market IDs;
- final wallet hygiene reported zero active orders and zero unknown inventory;
- the final local audit passed 404/404 tests, with 30/30 dashboard tests;
- no profitability or complete realized PnL claim is made.

Detailed hashes and conditions are in `docs/TECHNICAL_VERIFICATION.md`.

## UX and ecosystem impact

The direct user is the liquidity operator. The cockpit exposes fair value,
venue comparison, quote posture, risk reasons, inventory, lifecycle events, and
settlement facts without requiring the operator to read logs. More reliable
liquidity can make DreamDEX Event Contract books more useful to ordinary
traders, while VILLA remains above and complementary to DreamDEX infrastructure.

## SDK and documentation feedback

The useful implementation findings are constructive: current SDK and bot-kit
versions can differ, live venue IDs move, recycled pools require `marketId`
identity, `strike = 0` requires an opening-price path, chain time matters for
expiry and freshness, and finalized losing token residuals need explicit
classification. The current SDK is usable, but these edges deserve first-class
examples in the Event Contract documentation.

## Honest limitations

- this is a bounded Shannon testnet proof, not an indefinite production daemon;
- full realized maker PnL and all cash-flow components are not implemented;
- restart recovery is bounded and explicit;
- Event Contract session-key authorization is not verified for VILLA's MVP;
- organic fills are market-dependent and are not manufactured;
- public hosting must remain replay-first and signer-free.

## Submission checklist

- [ ] Public repository URL inserted and opens without login.
- [ ] Public HTTPS replay URL inserted and opens without login.
- [ ] Optional live read checked; if unavailable, the page reports it honestly.
- [ ] 2 to 3 minute video recorded and uploaded by the operator.
- [ ] Team/member fields completed in DoraHacks.
- [ ] Optional SDK/docs feedback attached or pasted.
- [ ] Dora deadline timezone confirmed; until then use the documented
  `TIMEZONE_NOT_EXPLICIT` policy and submit early.
- [ ] Operator presses Submit BUIDL manually after reviewing every field.
