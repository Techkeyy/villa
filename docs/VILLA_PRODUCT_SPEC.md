# VILLA Product Specification

Status: Phase 0 product pivot lock

## Product definition

VILLA is an open liquidity-provider product for DreamDEX Event Contracts. It helps an LP allocate capital, authorize a narrowly scoped automation path when that path is proven, and monitor VILLA market-making activity across short-duration BTC Event Contract markets.

The intended product flow is:

`CONNECT WALLET -> ADD LIQUIDITY -> AUTHORIZE VILLA -> START -> MARKET-MAKE -> MONITOR -> STOP -> SETTLE -> WITHDRAW`

The user is a liquidity provider or operator, not a retail bettor. VILLA does not promise profit. It prices markets, quotes liquidity, manages risk, rolls between markets, and provides evidence for the LP to review.

## Product contract

- The LP remains the capital owner and retains withdrawal and revocation authority.
- A user never gives VILLA a private key.
- One LP must never control another LP's capital.
- The existing proven VILLA engine remains the pricing, quoting, risk, inventory, rollover, and settlement reference.
- The existing shared execution wallet is not an open LP product boundary.
- Capital and execution controls remain development-gated until owner-scoped authority is proven.
- Public deployment remains read-only and safe-mode only.

## Architecture decision

The Phase 0 feasibility choice is `PER_USER_VILLA_ACCOUNT_REQUIRED`.

The current DreamDEX Event Contract surface does not prove a complete owner-scoped delegation path for placing, cancelling, minting, merging, and settling on behalf of an LP. A future implementation therefore needs an isolated per-user account or equivalent owner-controlled account boundary before capital is accepted. This document does not implement that account, custody, deposit, or withdrawal path.

This choice is a product boundary, not a change to the frozen VILLA engine. Until the boundary is designed, reviewed, and proven with disposable Shannon testnet capital, the UI must label capital actions as development preview and keep them inactive.

## In scope for the product

- Plain-language explanation of the LP value proposition.
- Wallet connection and LP onboarding context.
- Capital allocation, strategy, risk, orders, activity, settlement, and withdrawal concepts.
- Clear running, paused, halted, stopped, and pending-settlement states.
- Verified Shannon proof and replay evidence on a separate surface.
- Honest status, permissions, errors, and safety controls.

## Not in scope for this phase

- Deposit, withdrawal, or capital-account implementation.
- A pooled vault.
- New custody keys.
- Arbitrary users operating through the existing shared execution wallet.
- Changes to `villa-fv-v1`, `villa-risk-v1`, `villa-quote-v1`, inventory, rollover, or settlement semantics.
- Wet production execution, real funds, video recording, or DoraHacks submission.

## Success criteria

1. A first-time visitor can explain what VILLA does without reading backend documentation.
2. An LP can find the product entry point, understand the capital boundary, and see what remains unavailable.
3. The application never implies that a disabled capital action succeeded.
4. Proof and replay evidence are available without competing with the LP's main workflow.
5. The product language stays factual about testnet evidence and avoids profitability claims.

