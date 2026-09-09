# VILLA final release audit

Audit date: 2026-09-09
Repository: public VILLA repository
Branch: master
Audit status: FINAL RELEASE PASS for deployed commit 557f84bec02eea422aa659289048c9075bb51ce1. Current production behavior is authoritative for the account-bound path.

This is an evidence record for the account-bound product surface. It is not
authorization to start a strategy, access signer material, or move funds.

## 1. Release claim

VILLA is an account-bound liquidity product for DreamDEX Event Contracts on
Somnia Shannon. The LP owns the VillaAccount, its collateral, and its
DreamDEX orders. The VILLA operator is a separate constrained caller. The
public frontend remains signer-free, account execution is separately gated,
and the proof route is read-only.

## 2. Canonical proof

The canonical proof is the real BTC 24-hour market ending 10a14 on Shannon.

Owner:
0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d

VillaAccount:
0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2

VILLA operator:
0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37

The proof record shows one minimum mint, one post-only SELL_YES order at price
0.356 for 1000 raw, cancellation, paired burn, final collateral of 1002000
raw, zero YES, zero NO, zero open orders, released lease, stopped session,
no owner withdrawal. The exact transaction evidence is recorded in
docs/ACCOUNT_BOUND_WET_PROOF.md and the read-only /proof route.

Historical f920 evidence is supporting settlement/redemption evidence only.
It is not used as the canonical order proof.

## 3. Contract and custody audit

The VillaAccount contract surface remains owner-scoped for deployment, funding,
authorization, and withdrawal. Operator actions are explicit and do not expose
owner withdrawal or arbitrary destination/calldata inputs.

The account-bound adapter, typed writer, transaction policy, lease,
reconciliation, and cleanup paths bind account, owner, operator, market, and
session identity. The recovery correction in src/execution/lp-recovery.mjs is
included in the release diff.

## 4. Browser and product audit

The product starts at the public explainer route, not the cockpit. The
explainer has a plain-language hero, problem, product behavior, workflow,
operator benefits, DreamDEX benefits, safety, verified proof, and console CTA.

The /app route presents Connect, Create, Fund, Authorize, Ready, Start,
Running, Stopping, Stopped, Settlement, and Withdraw. The /proof route
presents the canonical account-bound evidence, labeled transaction hashes,
plain-language steps, and the ownership split:

CAPITAL / ORDER OWNER: VillaAccount
EXECUTION SIGNER: VILLA operator

The interface remains white, light blue, low-density, readable, responsive,
keyboard-focused, and explicit about unavailable PnL. No profitability or
yield guarantee is claimed.

## 5. Control-plane audit

The browser control client has only fixed operations for authentication, state,
Start, and Stop. Account control sends only the selected VillaAccount identity.
The browser cannot supply a destination, calldata, selector, amount, market
override, withdrawal instruction, or generic transaction payload.

The production operator entrypoint verifies the authenticated owner against the
selected VillaAccount on chain, then creates an isolated account-scoped bridge.
The legacy/global execution flag remains false. Owner authentication may
establish a short-lived control session; account Start is governed separately
by VILLA_ACCOUNT_EXECUTION_ENABLED and still requires verified owner/account
identity plus fresh preflight before any writer or runner is reached. Stop
can reach an already-running root-bound session for cleanup and never
withdraws capital. A deliberately account-enabled session remains subject to
the same account identity and preflight gates.

## 6. Signer and private runtime audit

The browser bundle, Vercel configuration, API responses, README, proof, and
submission files contain no signer material. The private runtime is the only
component that loads the operator credential. Persistent unrestricted execution remains disabled. Bounded account execution
is enabled only through the private, authenticated owner/account path. No
signer value is printed, logged, tracked, or returned.

## 7. Deployment audit

The Vercel build copies and verifies control-client.mjs together with the
existing dashboard modules. The public API handlers expose replay, scenes,
operator configuration, and authenticated account-scoped controls without a
signer. VILLA_ENGINE_API_URL is the only engine configuration intended for
Vercel. The private signer remains on the VPS.

The deployed production candidate is commit 557f84bec02eea422aa659289048c9075bb51ce1.
Vercel serves the matching dashboard assets, while the private runtime serves
the matching account-session and transient-RPC modules. The signer-free public
API and broker were health-checked after deployment; no wet session was started
as part of this documentation audit.

The public repository contains only legitimate release files. The
untracked BreakFix and phase2b_patch directories, environment files, keys,
credentials, runtime state, scratch data, and temporary logs are excluded.

## 8. Mechanical hygiene

Checked:
- tracked and untracked release scope;
- .gitignore coverage for environment files, keys, build output, runtime
  state, and scratch material;
- diff whitespace;
- JavaScript syntax;
- public text for stale outdated proof status language and exaggerated claims;
- secret-like values in tracked files and generated dashboard output;
- dependency tree and production dependency audit.

## 9. Adversarial checks

The release tests cover:
- wrong-chain and wallet-state gating;
- bounded discovery and no indefinite loading;
- owner/account identity mismatch;
- exact owner-only funding, authorization, and withdrawal paths;
- arbitrary control payload rejection;
- explicit account-selector Start and Stop requests;
- wallet signature cancellation;
- safe Start refusal while execution is disabled;
- zero runner invocation on disabled Start;
- typed writer and private-runtime boundaries;
- pending, unknown, reverted, and contradictory transaction states;
- lease and reconciliation failures;
- canonical proof identity, transaction labels, hashes, final balances, and
  no guaranteed-profit language.

## 10. Verified gates

The dated release gates below are historical evidence from the earlier rescue
pass, not current test totals. Re-run the repository commands for a fresh count:

npm test
npm run dashboard:build

The repository also retains focused worker, control, recovery, and settlement
tests for targeted verification.

Historical final values were recorded from the completed release gates:
- full regression: 665/665 passed;
- dashboard and browser runtime tests: 98/98 passed;
- operator tests: 48/48 passed;
- execution: 210/210 passed; focused recovery/writer/session/reconciliation/policy gates passed;
- Solidity account artifact compilation and runtime identity verification;
- dashboard production build;
- HTTP smoke and public route checks;
- UI text audit;
- secret scan;
- production dependency audit: 0 vulnerabilities;
- diff check.

## 11. Findings

No release-blocking security finding remains in the documented product scope.
The public frontend and API are signer-free, account execution is bounded and
owner/account-scoped, and the shared testnet operator serializes simultaneous
signer-backed execution. Market data changes, fills, and realized PnL are not
claimed. Video recording and any external submission remain human actions.

## 12. Verdict

Product, proof, control boundary, private-runtime safety, and deployed public
routes are release-ready for a bounded fresh-user acceptance test. This does
not claim profitability, mainnet readiness, or unrestricted autonomy. Do not
start a wet session from an audit task or expose signer material.
