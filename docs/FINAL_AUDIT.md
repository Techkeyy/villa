# VILLA Phase 7A final pre-submission audit

Audit date: 2026-08-27
Starting commit: `ca5c38d5824d14f90d685028603abd0d3e93422c` (`Freeze cockpit after rendered UI QA`)
Starting branch: `master`
Audit status: **PASS — GO for final deployment/demo/submission preparation**

This is an audit record, not a feature plan. The backend and UI remain feature
frozen except for the narrowly scoped, verified safety/readiness fixes recorded
below. No deployment, public hosting, final submission README rewrite, or demo
recording was performed.

## 1. Repository path

The audited repository is `C:\Users\HomePC\Desktop\villa`. It exists and is a
Git repository.

## 2. Branch and starting HEAD

The starting branch was `master`. Starting HEAD was
`ca5c38d5824d14f90d685028603abd0d3e93422c`.

## 3. Starting Git status

The starting worktree was clean (`git status --short --branch` reported only
`## master`). No reset, rebase, checkout, or destructive history operation was
used. `.env` existed and remained untouched and ignored.

## 4. Handover documentation read

The audit read the required `README.md`, `docs/HACKATHON.md`,
`docs/PROJECT_UNDERSTANDING.md`, `docs/TECHNICAL_VERIFICATION.md`,
`docs/ARCHITECTURE_NOTES.md`, `docs/DECISIONS.md`, `docs/SOURCES.md`,
`docs/BUILD_PLAN.md`, and `docs/INCOMING-BRIEF.md`. It also read the current
fair-value, risk, quote, execution, inventory, settlement, rollover,
autonomous-loop, dashboard, and backend-freeze records.

## 5. Skills inspected

The actual Desktop skills were inspected from `C:\Users\HomePC\Desktop\skill`:

- `audit-skill/SKILL.md` — used for the audit methodology and severity discipline;
- `build-process/SKILL.md` — used for read-before-edit, side-effect checks, and verification;
- `project-understanding/SKILL.md` — used to validate the product boundary and inherited claims;
- `project-edge/SKILL.md` — used to test differentiation and honesty against the stock `ec-maker` boundary.

No skill files were modified. `design-skill` was used only for the existing
UI text audit command; `perfect-readme` was not used because this is not the
final submission README pass.

## 6. Audit scope and methodology

The audit covered repository recovery, claims versus implementation, all
signer-enabled scripts, read-only collectors, fair-value/risk/quote/exposure
logic, order reconciliation, settlement and rollover identity, bounded
autonomy, dashboard server/browser boundaries, rendered UI evidence, tests,
dependencies, secrets, history, documentation, and hackathon/demo readiness.

The Audit skill's hygiene, claims, breakage, reporting, and confidence phases
were applied. Existing Phase 1 through Phase 6B.1 evidence was reused and
verified locally rather than replaying old wet writes.

## 7. Findings by severity and disposition

### HIGH — resolved

`scripts/verify-write-path.mjs` used `Math.floor(Date.now() / 1000)` for
market selection, seconds-left checks, and order expiry in a signer-enabled
write path. Shannon had previously shown a material local/chain clock offset.
The script now reads the authoritative chain block through `readChainTime()`.
The existing pure write-path tests were extended with a structural regression
check. No wet run was used to validate the fix.

### MEDIUM — resolved

The live fair-value/risk path could compare a history response against an
earlier RPC block and refuse a healthy feed as being several seconds in the
future. The live adapter now refreshes the chain head after history retrieval,
and propagates that effective chain time through execution, rollover, and
successor evaluation. On-chain expiry is also preferred over indexed expiry
for live selection. A mocked history/chain-clock regression test covers this
boundary.

### MEDIUM — resolved documentation drift

The inherited README and early project-understanding/capability text still
described Phase 5A, no UI, and no rollover even though Phase 6B.1 was complete.
Those status statements were updated without rewriting the submission README
or changing product scope.

### LOW — accepted and documented

The planner subtracts pending SELL quantity from its supplied YES availability.
On the observed Shannon venue, resting SELL escrow already removes those
tokens from the visible balance, so this combination is conservative and can
suppress an incremental ask rather than over-sell. No unsafe over-sell path
was found. It is deferred because changing planner inventory semantics would
expand the frozen feature surface; the relevant adapter contract remains
documented.

### INFO — accepted

Complete maker PnL is explicitly unavailable; the production indefinite daemon
is not implemented; the cockpit is observational; replay is bounded recorded
evidence; the audit did not deploy, record, or publish a final submission
README; and the hackathon deadline timezone still needs external confirmation.
These are disclosed limitations, not hidden claims.

## 8. Security and secrets verdict — PASS

The existing disposable wallet address was used only as public read evidence.
The private key was never printed, copied, inspected for value, added to
source/docs, or moved into `.env.example`. `.env` remains ignored by
`.gitignore`. Tracked-file secret-assignment scan found 0 matches; Git history
contained 0 `.env` paths; QA/runtime evidence scans found 0 secret-like
matches; generated browser assets contained 0 signer/private-key/write symbols.

The browser receives no environment variables, signer, private key, writer
queue, or transaction function. The dashboard server binds to localhost and
uses a server-side read-only adapter for live mode.

## 9. Transaction safety verdict — PASS

All audit commands were read-only or dry-run. Wet commands require explicit
confirmation where applicable. The bounded runner uses a serialized write
queue, exact market/order scope, post-only order type, fresh preflight, chain
time, expiry headroom, reconciliation, and exact cleanup. Dashboard routes do
not import or expose a writer. The legacy write-path clock defect was fixed.

No faucet, mint, burn, place, cancel, redeem, or arbitrary transaction command
was run by this audit.

## 10. State correctness and reconciliation verdict — PASS WITH CONDITIONS

On-chain order fields and balances are preferred; indexer reads are reconciled
and ambiguous mismatches refuse action. Restart, duplicate mint/order/redeem,
cleanup, and stranded-order cases have deterministic tests. Full PnL/cash-flow
accounting remains unavailable and is never normalized to zero.

## 11. Exposure and inventory verdict — PASS WITH CONDITIONS

YES/NO complete sets, directional balance, four signed order deltas, pending
worst-case stress, reduce-only behavior, available collateral, and mint/burn
readbacks are covered by tests and prior live evidence. The known conservative
pending-SELL availability issue is LOW and does not create an over-sell path.

## 12. Market and series identity verdict — PASS

The product keys Event Contracts by `marketId`, not pool or venue. The bounded
orchestrator is deliberately constrained to `BINARY:BTC:300`; rollover verifies
asset, interval, later expiry, distinct market ID, and fresh outcome IDs. No
natural-language question parsing or recycled-pool identity was found.

## 13. Chain-time verdict — PASS

Safety-sensitive market status, expiry, order expiry, stop timing, settlement
watching, and rollover decisions use chain time. Local wall time remains only
for process bounds, session IDs, latency, and diagnostics. The legacy
signer-enabled verifier now uses `readChainTime()`; refreshed history chain
time is propagated consistently through live decision assembly.

## 14. Settlement verdict — PASS WITH CONDITIONS

Settlement distinguishes Trading/Locked/Settling/Resolved/Voided states,
uses explicit outcome indexes and market IDs, reads payout numerators, plans
only eligible winning or void legs, reconciles exact raw payout, separates
STT gas from collateral, and leaves known zero-value losing residuals labeled.
The finalized claim sweep is bounded to the latest 200 indexed rows.

## 15. Rollover verdict — PASS WITH CONDITIONS

Rollover stops the current market, verifies zero current open orders, selects a
same-series later successor, resolves a fresh reference and token IDs, keeps
old-market history separate, and refuses unrelated fallback markets. The live
clock propagation defect found during this audit was fixed and the pure tests
continue to pass.

## 16. Autonomous-runner verdict — PASS WITH CONDITIONS

The runner is bounded by configured series, market count, session duration,
transaction budget, exposure/capital checks, one queue, and cleanup rules. It
is not represented as an indefinite production daemon. Its exact limit and
restart behavior are documented in `docs/AUTONOMOUS_LOOP.md`.

## 17. Fair-value verdict — PASS

`villa-fv-v1` is a pure zero-drift log-return digital model:

```text
z    = ln(S / K) / (sigma_per_sqrt_second * sqrt(time_remaining_seconds))
pUp  = Phi(z)
pDown = 1 - pUp
```

It uses current underlying price, market reference, remaining seconds, and
realized log-return volatility. It does not use the DreamDEX midpoint. The
model is deterministic, bounded, unit-checked, and refuses invalid/stale
inputs rather than returning a sentinel 0.5.

## 18. Quote-planner verdict — PASS WITH CONDITIONS

The planner is pure, market-scoped, post-only aware, adaptive to fair value,
volatility, expiry, confidence, inventory, pending stress, collateral, and
governor permissions. It returns `NO_QUOTE` or a bounded plan rather than
reviving disabled actions. It is not the fair-value engine and does not place
orders by itself.

## 19. Dashboard backend-contract verdict — PASS

`villa-dashboard-v1` preserves structured model, risk, quote, inventory,
lifecycle, activity, and accounting facts. It forces `PNL_UNAVAILABLE` with
`pnl: null`; it does not invent PnL. Secret-like fields are rejected before
presentation. Live mode is read-only and returns an explicit error response
when live reads fail.

## 20. Replay honesty verdict — PASS

Replay scenes are explicitly labeled `REPLAY` and use exact recorded facts
from prior bounded phases. They do not fabricate continuous timestamps,
fills, best levels, profitability, or settlement outcomes. The known residual
and unavailable PnL remain visible as such.

## 21. Live dashboard honesty verdict — PASS

Live mode is clearly labeled `LIVE` and `READ ONLY`. A live read failure does
not silently fall back to replay. The previously rendered QA showed the live
unavailable state with a clear error and `Use replay` control.

## 22. UI, responsive, and accessibility verdict — PASS

The existing rendered QA covered quote, rollover, settlement, reduce-only,
and live-unavailable scenes at 1440x900, 1366x768, 1024x768, and 390x844.
No horizontal overflow, console error, page error, failed request, or HTTP
error was observed for replay. Semantic headings, labels, status text,
keyboard focus styling, live regions, and responsive layout are present.
`audit_ui_text.py dashboard` reported zero long-dash errors and zero small-text
warnings.

## 23. Test-suite verdict — PASS

The final suite passed **404/404** tests across 27 suites with 0 failures,
0 cancellations, 0 skips, and 0 todos. The Phase 6B dashboard suite passed
30/30. The final count includes the two audit regression checks; the inherited
pre-audit baseline was 402/402.

## 24. Package and dependency verdict — PASS WITH INFO

Node 24.14.0 satisfies Node >=20. The installed direct versions are
`@somnia-chain/markets-sdk@0.28.1` and `viem@2.55.19`, with no duplicate SDK
version. `npm audit --omit=dev` reported 0 vulnerabilities. npm reports
optional/uninstalled peer packages from the SDK (`reactivity`, `react`, and
TypeScript); VILLA does not import them and the test/build path is healthy.

## 25. Repository hygiene and history verdict — PASS

There are 89 tracked files and no large or generated product artifacts in the
tracked tree. `dist`, `build`, `coverage`, `node_modules`, `.scratch`, and
runtime state are ignored as intended. The repository is well below a 10 MB
submission-sized source tree. No secret file was found in history.

## 26. Documentation consistency verdict — PASS WITH CONDITIONS

README status, project-understanding status, technical capability table,
architecture layer names, build-plan status, backend-freeze note, and
fair-value clock note were updated to match the frozen Phase 6B.1/Phase 7A
state. Historical sections retain their dates and original bounded claims.
The README is still an operator/developer README, not the final submission
README requested for a later step.

## 27. Hackathon readiness verdict — PASS WITH CONDITIONS

The implementation uses a real Somnia Shannon Event Contract, installed
official SDK plumbing, independent fair value, risk/exposure controls,
bounded execution, settlement, rollover, and an operator cockpit. The
remaining conditions are the documented bounded scope, no profitability
claim, no mainnet claim, no public deployment in this audit, and external
confirmation of the deadline timezone.

## 28. Demo readiness verdict — PASS WITH CONDITIONS

The replay dashboard is locally reproducible and the live read-only snapshots
worked after the clock fix. A fair-value snapshot produced a live BTC result;
risk and quote snapshots showed zero open orders and explicit midpoint
comparison-only behavior. The demo should present replay evidence as replay
and live reads as live; it should not promise an organic fill on demand.

## 29. Deployment readiness verdict — GO FOR PREPARATION, NOT DEPLOYED

The code/build/test/security gates are ready for the next deployment and
submission-preparation step. No hosting, domain, public URL, GitHub push,
wallet deployment, or production service was attempted in this audit.

## 30. Historical and scenario validation verdict — PASS FOR CORRECTNESS

The project does not claim a predictive edge. Reliable aligned historical
Event Contract/outcome data was not reconstructed for a defensible Brier,
log-loss, or calibration claim. Deterministic scenario tests cover the
qualitative model properties and fail-closed boundaries; this is correctly
reported as sanity validation, not profitability validation.

## 31. Live read-only examples

The patched `npm run fair-value` returned a live BTC 1-hour contract with
`villa-fv-v1` UP `65.3%`, DOWN `34.7%`, HIGH data quality, and DreamDEX
midpoint `70.6%` marked comparison-only. The patched `npm run risk` returned
UP `75.2%`, DOWN `24.8%`, Governor `ALLOW`, zero inventory, zero open orders,
and `Midpoint affects state: NO`. The patched `npm run quote` returned UP
`75.4%`, zero open orders, and a one-sided plan due to `NO_SELL_INVENTORY`.

The live inventory and quote-cycle dry runs passed with explicit zero-write
plans. Settlement dry-run scanned 200 finalized and 200 active BTC rows with
no claimable entries/read errors and created only a dry session. Wallet
hygiene dry-run reported the known `a3cf` winning balance at zero and zero
unknowns. Organic-fill dry-run safely refused one time on a single RPC
balance timeout in its 200-row sweep; no write occurred. The first rollover
run exposed the clock propagation defect; after the fix, the final read-only
run observed a current market close, a same-series successor, a
`SUCCESSOR_READY` pipeline, zero active orders, and zero transactions.

## 32. DreamDEX midpoint independence confirmation

The midpoint is fetched after the fair-value calculation in the snapshot
script and is stored as comparison-only data. It is absent from the pure
model input, fair-value `inputsUsed`, risk-state calculation, and model tests.
Changing the comparison book in planner tests leaves fair probability
unchanged. **The midpoint did not influence `pUp` in the audited path.**

## 33. Refusal and fail-closed confirmation

Missing/invalid/stale prices, missing or unusable references, expired markets,
insufficient or gapped volatility history, invalid units, non-Trading status,
stale chain time, ambiguous open orders, invalid grids, insufficient capital,
and unsafe post-only crosses have explicit refusal or HALT behavior. Broken
data is not converted to neutral 0.5.

## 34. Commands and checks run

The audit ran or verified:

- `npm test -- --test-reporter=dot` — 404/404 passed;
- `npm run dashboard:test` — 30/30 passed;
- `npm run dashboard:build` — passed;
- `python C:\Users\HomePC\Desktop\skill\design-skill\scripts\audit_ui_text.py dashboard` — passed;
- `npm audit --omit=dev --json` — 0 production vulnerabilities;
- `npm ls --all --depth=1 --json` — expected SDK/viem tree, optional peer gaps only;
- `npm run doctor` — passed against Shannon after read-only network approval;
- `npm run fair-value`, `npm run risk`, `npm run quote` — passed read-only after the clock fix;
- `npm run verify:inventory:dry` — passed;
- `npm run verify:quote-cycle:dry` — passed;
- `npm run verify:settlement:dry` — passed;
- `npm run verify:wallet-hygiene:dry` — passed;
- `npm run verify:organic-redeem:dry` — safely refused on one transient RPC timeout;
- `npm run verify:rollover` — final read-only run passed with close/successor, `SUCCESSOR_READY`, zero active orders, and zero transactions; the first run caught the now-fixed propagation issue;
- `git diff --check` — passed;
- tracked/history/ignored secret scans — no secret leakage found;
- existing rendered Phase 6B.1 QA evidence — reviewed and retained.

## 35. Transaction result

**Zero transactions were sent during Phase 7A.** No wet verification command
was run. No faucet, order, mint, burn, cancel, redeem, or compensating trade
was initiated.

## 36. Active orders and wallet-state result

Read-only checks observed zero active VILLA orders in the audited live scopes,
zero current BTC inventory in the settlement dry-run, zero claimable finalized
entries, and the known `a3cf` claim balance at zero. The existing disposable
wallet and its ignored `.env` were preserved.

## 37. Files created or modified

Created:

- `docs/FINAL_AUDIT.md`;
- `src/fair-value/live.test.mjs`.

Modified by the audit:

- `scripts/verify-write-path.mjs`;
- `scripts/lib/write-path.test.mjs`;
- `src/fair-value/live.mjs`;
- `src/risk-governor/live.mjs`;
- `src/execution/live.mjs`;
- `src/rollover/live.mjs`;
- `src/orchestrator/live.mjs`;
- `scripts/fair-value-snapshot.mjs`;
- `scripts/verify-rollover.mjs`;
- `README.md`;
- `docs/PROJECT_UNDERSTANDING.md`;
- `docs/TECHNICAL_VERIFICATION.md`;
- `docs/ARCHITECTURE_NOTES.md`;
- `docs/BUILD_PLAN.md`;
- `docs/FAIR_VALUE_MODEL.md`;
- `docs/BACKEND_FREEZE.md`.

No `.env`, skill file, generated `dist/dashboard`, `.scratch`, or runtime
state file is part of the audit change.

## 38. Documentation updates

The audit updated current-status drift, documented refreshed chain-clock
handling, recorded the 404-test final count, preserved historical evidence,
and added this complete findings/verdict record. It did not produce the final
submission README, public deployment guide, or recording.

## 39. Known limitations

- Complete maker PnL and all cash-flow components are unavailable.
- The autonomous runner is bounded, not an indefinite production daemon.
- Finalized sweeps are bounded by their documented indexer limits.
- Organic fills remain market-dependent and are not manufactured.
- The planner's pending SELL reservation is conservative under the observed escrow semantics.
- Event Contract session-key/operator authorization remains unverified for MVP.
- Public deployment, URL, GitHub push, and final video were not part of this audit.
- Hackathon deadline timezone requires external confirmation.

## 40. Unresolved finding counts

After the fixes: **0 Blockers, 0 High, 0 Medium, 1 Low accepted, and 6 Info/known limitations**. The accepted Low issue is conservative quote-capacity behavior and not an unsafe execution path.

## 41. Final audit verdict

**PASS / GO.** There are no unresolved Blocker, High, or Medium findings. The
repository is safe to enter final deployment, demo, and submission preparation
under the documented conditions.

## 42. Freeze preservation

The backend/UI feature freeze was preserved. The only implementation changes
were the chain-clock safety/readiness fixes and their regression tests; the
fair-value formula, risk policy, quote strategy, execution limits, settlement
semantics, rollover scope, dashboard contract, and UI design were not
redesigned.

## 43. Phase 7A pass condition

The Phase 7A pass condition is satisfied: no unresolved Blocker/High finding,
full tests pass, all critical claims have an evidence trail, live read-only
paths work or refuse explicitly, no secret leaked, no transaction was sent,
and the project is ready for final deployment/demo/submission preparation.

## 44. Exact next milestone

Proceed to **Phase 7B: final deployment, public submission packaging, and
demo/recording preparation**, after confirming the hackathon deadline timezone
and the intended public hosting/repository destinations. Do not begin another
strategy or backend feature phase unless a new audit finding or explicit
submission requirement authorizes it.

Final audit commit: the focused local commit that contains this report and the
listed audit fixes; see `git log -1 --format=%H` at handoff.
