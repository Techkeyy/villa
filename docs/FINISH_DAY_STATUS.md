# VILLA final release status

Status: final release preparation after the verified account-bound wet proof.
No new wet cycle, transaction, video recording, or DoraHacks submission is
performed by this task.

## Canonical proof

The account-bound proof passed on Somnia Shannon for BTC 24-hour market `10a14`.
The LP-funded VillaAccount owned the real post-only SELL_YES order. The
separate VILLA operator executed approved account actions. The order was
cancelled, paired inventory was burned, and final collateral reconciled to
`1,002,000` raw tUSDC with zero YES, zero NO, and zero open orders.

The exact hashes and identity split are recorded in
[`ACCOUNT_BOUND_WET_PROOF.md`](ACCOUNT_BOUND_WET_PROOF.md) and rendered on
`/proof`.

## Product track

- `/` is the explainer-first product entry for judges, LPs, and operators.
- `/app` shows Connect, Create, Fund, Authorize, Ready, Start, Running,
  Stopping, Stopped, Settlement, and Withdraw as one owner journey.
- `/proof` is a read-only canonical replay with labeled transaction evidence.
- Start and Stop call the constrained account-control client only. Start
  requires owner authentication and readiness; safe mode returns without a
  writer. Stop never withdraws capital.

## Security track

The public dashboard is signer-free. Public control requests accept no
transaction destination, selector, calldata, or withdrawal instruction. The
private signer remains outside the repository and outside Vercel. Persistent
execution remains disabled by policy.

## Quality track

The release gate includes full regression, dashboard, operator, execution,
recovery, writer, session, reconciliation, policy, Solidity compile, dashboard
build, HTTP smoke, secret scan, dependency audit, diff check, and the final
security audit.

## Remaining operator actions

1. Review the final local and public release state.
2. Record and upload the short demo using `docs/DEMO_SCRIPT.md`.
3. Paste the video URL into `docs/SUBMISSION.md` and the DoraHacks form.
4. Complete any required team fields.
5. Submit DoraHacks manually after reviewing every field.