# VILLA final release audit

Audit date: 2026-09-02
Repository: C:\Users\HomePC\Desktop\villa
Branch: master
Audit status: LOCAL RELEASE PASS; publication and production smoke verification remain release gates.

This is the final release audit for the account-bound product surface. It
does not authorize another wet cycle, a transaction, signer changes, or
persistent execution.

## 1. Release claim

VILLA is an account-bound liquidity product for DreamDEX Event Contracts on
Somnia Shannon. The LP owns the VillaAccount, its collateral, and its
DreamDEX orders. The VILLA operator is a separate constrained caller. The
public product remains safe-mode and the proof route is read-only.

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
disabled execution, and no owner withdrawal. The exact transaction evidence
is recorded in docs/ACCOUNT_BOUND_WET_PROOF.md and the read-only /proof route.

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
Start, and Stop. Start and Stop send an empty JSON object. The browser cannot
supply a destination, calldata, selector, amount, market override, withdrawal
instruction, or generic transaction payload.

The production operator entrypoint now wires the existing account-bound seam
from configured owner/account/operator identities. In release mode,
executionEnabled is false. Owner authentication may establish a short-lived
control session, but Start returns EXECUTION_DISABLED before any writer or
runner is reached. Stop returns a safe stopped state and never withdraws
capital. A future armed session requires a separate owner-approved gate.

## 6. Signer and private runtime audit

The browser bundle, Vercel configuration, API responses, README, proof, and
submission files contain no signer material. The private runtime is the only
component that loads the operator credential. Persistent unrestricted
execution remains disabled. No signer value is printed, logged, tracked, or
returned.

## 7. Deployment audit

The Vercel build copies and verifies control-client.mjs together with the
existing dashboard modules. The public API handlers expose only replay,
scenes, and operator configuration. VILLA_ENGINE_API_URL is the only engine
configuration intended for Vercel. The private signer remains on the VPS.

The final public repository must contain only legitimate release files. The
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
- empty-body Start and Stop requests;
- wallet signature cancellation;
- safe Start refusal while execution is disabled;
- zero runner invocation on disabled Start;
- typed writer and private-runtime boundaries;
- pending, unknown, reverted, and contradictory transaction states;
- lease and reconciliation failures;
- canonical proof identity, transaction labels, hashes, final balances, and
  no guaranteed-profit language.

## 10. Verified gates

Final values are recorded with the release report after execution:
- full regression;
- dashboard and browser runtime tests;
- operator tests;
- execution, recovery, writer, session, reconciliation, and policy tests;
- Solidity account artifact compilation and runtime verification;
- dashboard production build;
- HTTP smoke;
- UI text audit;
- secret scan;
- production dependency audit;
- diff check.

## 11. Findings

No release-blocking security finding remains in the local release scope.
The public product is safe-mode, not an always-on autonomous production daemon.
Market data changes, realized PnL is not claimed, and multi-LP or broader venue
operations remain future work.

Publication is incomplete until the release commit is pushed and the public
repository and production routes are rechecked. Video recording and DoraHacks
submission remain human actions outside this task.

## 12. Verdict

Local product, proof, control boundary, and private-runtime safety are ready
for final release gates. Do not enable execution, send transactions, record
the final video, or submit DoraHacks as part of this release task.
