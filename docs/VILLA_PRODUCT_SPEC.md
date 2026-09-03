# VILLA product specification

Status: final release. Account-bound wet proof verified on Somnia Shannon;
the legacy/global execution path remains disabled and account execution is
independently deployment-gated.

## Product definition

VILLA is liquidity infrastructure for DreamDEX Event Contracts. It is built
for liquidity providers and operators who want a repeatable way to price BTC
event markets, manage bounded exposure, and inspect the full lifecycle.

The product flow is:

`CONNECT WALLET -> CREATE VILLA ACCOUNT -> ADD LIQUIDITY -> AUTHORIZE VILLA -> READY -> START -> RUNNING -> STOP -> SETTLE -> WITHDRAW`

VILLA does not promise profit, yield, or positive PnL.

## Product contract

- The LP remains the capital owner and retains withdrawal and revocation authority.
- One LP must never control another LP's capital.
- Every LP receives an isolated `VillaAccount` before capital is accepted.
- The proven VILLA engine remains the pricing, quoting, risk, inventory,
  rollover, and settlement reference.
- The canonical operator is fixed by audited configuration and can act only
  through the approved account-bound path.
- The public app is explainer-first, wallet-mediated, and signer-free; account
  execution is independently deployment-gated.
- The public proof route is read-only and documents the real 10a14 proof.

## Architecture decision

The product uses `PER_USER_VILLA_ACCOUNT_REQUIRED`.

The LP account owns collateral and DreamDEX orders. A separate VILLA operator
can execute approved account actions only after owner authorization and a fresh
account-bound preflight. The control plane has no arbitrary destination,
calldata, withdrawal, or generic transaction relay input.

Start authenticates the owner wallet with a short-lived message signature, then
sends only the selected VillaAccount identity to the account control route.
The server verifies that identity before invoking an isolated owner-account
session. Stop prevents new expansion, cleans only tracked account-owned orders,
reconciles state, and never withdraws capital. The legacy/global execution
flag remains false; VILLA_ACCOUNT_EXECUTION_ENABLED separately gates the
product-facing account Start path.

## User-facing surfaces

- `/` explains the problem, product, LP value, DreamDEX benefit, and safety model.
- `/app` guides Connect, Create, Fund, Authorize, Ready, Start, Stop, and Withdraw.
- `/proof` shows the canonical proof and supporting replay scenes without control calls.

## In scope for the release

- Plain-language product explanation.
- Wallet and owner-scoped LP onboarding.
- Exact account capital actions, authorization, revocation, and owner withdrawal.
- Readiness, safe Start/Stop controls, and clear safe-mode errors.
- Fair-value, risk, quote, inventory, settlement, and rollover references.
- Judge-friendly proof and public release documentation.

## Not in scope

- Persistent unrestricted execution.
- A pooled vault or shared LP capital.
- Arbitrary user-selected transactions.
- New custody keys or browser signer handling.
- Unbounded or pooled multi-LP custody.
- Another wet trading cycle for release presentation.

## Verified release proof

The canonical 10a14 testnet proof confirms a real account-owned order,
post-order cancellation, paired burn, and final reconciliation. The exact
identities and hashes are in `docs/ACCOUNT_BOUND_WET_PROOF.md`.

## Success criteria

1. A first-time visitor understands VILLA without reading backend documentation.
2. An LP can find the product entry point and understand the capital boundary.
3. The app never implies that a disabled action succeeded.
4. Start and Stop expose only constrained account-control requests.
5. The proof page distinguishes capital/order ownership from operator execution.
6. Public release claims stay factual about testnet evidence and limitations.
