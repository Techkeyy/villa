# VILLA finish-day status

Status: local preparation in progress. No push, wet execution, final video, or
DoraHacks submission is performed by this work.

## Read-only market track

The 15-minute owner-prep helper remains local and safe-mode only. A separate
read-only 1-hour fallback checkpoint on Somnia Shannon evaluated the
`BINARY:BTC:3600` series because it is protocol-equivalent to the existing
binary Event Contract path:

- the candidate was `Trading`, unfinalized, and bound to an exact `marketId`;
- the live pool returned the same binary YES/NO outcome model and matching
  outcome IDs;
- the venue grid and order-book reads were available;
- account capital was `1.002 tUSDC` and Risk Governor returned `ALLOW`;
- the projected bounded path passed: `mint 0.001 tUSDC`, one post-only
  `SELL_YES`, cancel, reconcile, burn when safe, then stop;
- the adapter's order path remained account-scoped and post-only;
- no owner transaction, engine write, order, or blockchain transaction was
  sent. The account-specific market mapping remains unavailable until the
  owner completes `prepareMarket` for that exact market.

This is feasibility evidence, not a claim that the 1-hour market is still fresh
at a later read. A new market must be rediscovered and rechecked before any
future owner action.

## Account control track

`src/operator/account-control.mjs` is an optional authenticated seam around the
existing `src/execution/lp-control.mjs` session controller. It is disabled by
default and requires both `publicEnabled` and `executionEnabled` plus the full
existing preflight result before delegating Start. The caller must match the
account owner. Stop delegates only scoped tracked-order cleanup, paired cleanup
where safe, reconciliation, and lease release. It has no withdraw or arbitrary
transaction relay method.

The production API exposes these account routes only when an account-control
instance is explicitly injected. A separate `accountAuth` can bind the routes
to the LP owner instead of the legacy operator-auth session. The current public
deployment injects neither, so its public surface remains read-only and
signer-free.

## Product track

- `/` explains the operator problem, VILLA's lifecycle, operator value,
  DreamDEX benefit, safety controls, and the route into the console.
- `/app` shows the LP journey from wallet connection through capital,
  authorization, readiness, staged monitoring, settlement, and withdrawal.
- `/proof` labels replay evidence and the pending account-bound wet cycle
  separately.

## Release hold

The release sequence remains: account-bound wet proof, evidence insertion,
full regression, dependency and secret audit, production build, deployment
smoke, clean-wallet review, then an owner-controlled push and demo recording.
The current finish-day work stops before wet execution, push, recording, and
submission.
