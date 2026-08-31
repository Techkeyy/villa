# Phase 3A signer-assumption audit

Status: pre-edit map completed before the Phase 3A adapter implementation.

Scope: every existing engine, lifecycle, read adapter, writer boundary, and
control-plane path that can identify collateral, outcome inventory, orders,
positions, pending exposure, settlement, minting, burning, or redemption with
the historical VILLA signer wallet.

## Identity model for Phase 3A

The historical engine currently uses one `owner` value for two different jobs:

```text
historical signer EOA -> collateral / inventory / order owner

Phase 3A:
operator signer EOA -> calls one scoped VillaAccount
LP VillaAccount     -> collateral / inventory / order owner
LP owner wallet     -> owns the VillaAccount and retains withdrawal control
```

The canonical operator is `0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37`.
It is present in `dashboard/account-config.mjs`, is the argument in the
recorded Phase 2 `setOperator` transaction, and is the address derived from
the local ignored engine key. The private key was not recorded here.

The Phase 2 account fixture is
`0xFc9dbf0a8468aA56799b4e23B1EBe936426eE30b` and its owner is
`0xCc67779F8eDb2C80DC665775C5597657C512FE1A`. No Phase 3A write may target
that account.

## Classification

| Location | Current assumption or identity use | Classification | Phase 3A disposition |
| --- | --- | --- | --- |
| `src/fair-value/**` | Fair value consumes market/feed facts and has no signer, wallet, or account identity. | SAFE AS-IS | Preserve unchanged. |
| `src/risk-governor/governor.mjs` and `exposure.mjs` | Pure risk math accepts normalized inventory, collateral, orders, and positions but does not choose their owner. | SAFE AS-IS | Feed only one account-scoped snapshot. |
| `src/quote-planner/**` | Pure quote math consumes inventory, pending orders, capital, and market identity without a wallet dependency. | SAFE AS-IS | Preserve unchanged; adapter supplies account-scoped facts. |
| `src/inventory-lifecycle/index.mjs` | Pure paired-inventory arithmetic is identity-neutral. | SAFE AS-IS | Preserve unchanged; do not mix accounts before calling it. |
| `src/settlement/index.mjs`, `recovery.mjs`, `wallet-audit.mjs` | Pure settlement, recovery, and wallet classification are keyed by market and supplied balances. | SAFE AS-IS | Reuse with VillaAccount reads and exact market identity. |
| `src/rollover/index.mjs` | Pure successor selection preserves market and strategy scope but does not own a wallet. | SAFE AS-IS | Preserve; pass account-scoped inventory/order state. |
| `src/orchestrator/index.mjs` | Pure lifecycle state stores market-scoped orders, inventory, settlement, and accounting; no signer import. | SAFE AS-IS | Add account identity to the session envelope without changing policy math. |
| `src/execution/policy.mjs` | Pure policy carries `intent.owner`, but this is currently the same caller/portfolio value in the old writer path. | MUST CHANGE | Rename/extend the intent boundary to require `account` as order owner and keep `operator` as signer metadata. |
| `src/execution/live.mjs:87-93` | `readRawAccountState(..., owner)` reads collateral and YES/NO balances for the supplied address. Callers pass the historical signer. | MUST CHANGE | Adapter reads these values for `VillaAccount`; retain the generic pure mapping only when explicitly passed the account. |
| `src/execution/live.mjs:65-82` | `discoverCleanBtcMarket(exchange, owner)` checks open orders for the supplied owner, but the old orchestration supplies the signer wallet. | MUST CHANGE | Discover and reconcile orders for the account, not the signer. |
| `src/risk-governor/live.mjs:40-50` | Read-only exchange requires `OPERATOR_ADDRESS`, although it is actually the portfolio address for risk reads. | MUST CHANGE | Create an account-scoped read client/context; `OPERATOR_ADDRESS` remains signer configuration only. |
| `src/risk-governor/live.mjs:119-198` | `readOpenOrders` queries `getOwnOpenOrdersOnchain` and indexer orders for `owner`. | MUST CHANGE | Require explicit `account` and verify each order's owner/account scope. |
| `src/risk-governor/live.mjs:236-245` | `collectRiskSnapshot` defaults to `exchange.walletAddress` and reads account capital/inventory/orders there. | MUST CHANGE | Require VillaAccount address; no signer fallback in the LP adapter. |
| `src/rollover/live.mjs:118` | Current-market discovery reads open orders for `exchange.walletAddress`. | MUST CHANGE | Use the selected VillaAccount for open-order and cleanup reads. |
| `src/rollover/live.mjs:274-344` | Successor pipeline and historical residual scans default inventory reads to `exchange.walletAddress`. | MUST CHANGE | Carry the exact account through rollover and settlement contexts. |
| `src/settlement/live.mjs:66-90` | The live settlement exchange can create a signer and the redemption path calls the SDK trader for the signer wallet. | MUST CHANGE | Phase 3A only constructs VillaAccount redemption calls in shadow mode; no direct signer redemption. |
| `scripts/villa-bounded.mjs:161-212` | `ownerForExchange` supplies one value to all reads and the runner treats it as the portfolio owner. | MUST CHANGE | Runner/session context must hold `{ operator, account, owner }`; risk and lifecycle read the account. |
| `scripts/villa-bounded.mjs:231`, `344-401` | Partial cancel, placement, mint, and burn call the SDK trader directly. The signer wallet therefore becomes the DreamDEX order/inventory owner. | MUST CHANGE | Route every engine write through adapter-generated VillaAccount calls. Shadow mode must stop before broadcast. |
| `src/orchestrator/live.mjs:76-119` | `OPERATOR_PRIVATE_KEY` creates the signer, `walletAddress` is returned as `owner`, and `traderFor()` exposes direct SDK writes. | MUST CHANGE | Keep signer creation private, but replace direct trader writes with adapter operations targeting one account. |
| `src/orchestrator/live.mjs:264-404` | Account reads, order reconciliation, placement, cancellation, mint, and burn all use the historical `owner` and direct trader. | MUST CHANGE | Bind all reads/reconciliation to VillaAccount and all intended writes to explicit account methods. |
| `src/settlement/live.mjs:108-185` | Balance and order reads are parameterized but existing callers pass the signer wallet. | MUST CHANGE | Safe generic reader only after account is explicit; no signer default in Phase 3A. |
| `scripts/verify-write-path.mjs` | Bounded historical proof intentionally writes directly from the disposable operator wallet. | DEAD/LEGACY PATH | Preserve as historical evidence; never use for Phase 3A account execution. |
| `scripts/verify-inventory-lifecycle.mjs` | Historical mint/order/cancel/burn proof uses `exchange.trader` and signer wallet ownership. | DEAD/LEGACY PATH | Preserve for Phase 4B evidence; do not adapt silently. |
| `scripts/verify-quote-cycle.mjs` | Historical one-shot quote proof uses the direct SDK writer and signer-owned portfolio. | DEAD/LEGACY PATH | Preserve proof path; Phase 3A uses a separate adapter. |
| `scripts/verify-settlement.mjs` and `scripts/redeem-organic-fills.mjs` | Historical settlement writes use the signer wallet as redeemed-position owner. | DEAD/LEGACY PATH | Preserve historical evidence; adapter owns future account-bound redemption planning. |
| `scripts/verify-rollover.mjs` | Historical rollover is read-only, but its inventory/order reads default to the signer wallet. | DEAD/LEGACY PATH | Keep historical verifier; use account-bound rollover context in the new integration. |
| `scripts/wallet-hygiene-audit.mjs` | Historical wallet hygiene intentionally audits the operator wallet and may redeem one known claim. | DEAD/LEGACY PATH | Preserve evidence; never treat operator wallet holdings as LP capital. |
| `src/dashboard/live-adapter.mjs` | Public live dashboard reports a `walletAddress` from the read-only operator context. | SAFE AS-IS | Keep public UI disconnected/read-only in Phase 3A; no account engine control is exposed. |
| `src/dashboard/contract.mjs` and replay | Dashboard snapshot formatting can display a wallet/system identity but performs no writes. | SAFE AS-IS | Do not use it as engine portfolio identity. |
| `src/operator/auth.mjs` and `scripts/operator-api.mjs` | API authentication identifies an authorized operator/controller, not an LP account. | SAFE AS-IS | Keep auth identity separate; Phase 3A session authorization must additionally bind one account. |
| `contracts/VillaAccount.sol` | The contract already separates owner and operator and exposes only explicit operator EC methods; owner-only withdrawal and mutation are not operator methods. | SAFE AS-IS | Reuse the proven boundary. Adapter must not expose forbidden owner controls. |

## Required identity assertions

The Phase 3A adapter and tests must prove that the same account address is used
as the portfolio identity for:

- direct collateral and pool-vault reads;
- YES and NO inventory;
- open and filled orders;
- pending exposure and risk input;
- mint, place, cancel, and burn plans;
- settlement/redeem plans;
- successor rollover state; and
- realized/accounting state.

The operator EOA may appear only as signer metadata and as the expected
`VillaAccount.operator()` value. The LP owner may appear only as account owner
verification and owner-controlled lifecycle metadata. Neither may replace the
VillaAccount address in portfolio reads or order plans.

## Security boundary found before implementation

The existing contract is narrower than the old SDK writer: it has no generic
call, no operator withdrawal, no arbitrary recipient, no operator ownership
change, and no operator market approval. The new adapter must preserve this by
exposing only account-scoped trading/settlement methods and by returning
unsigned intended calls in Phase 3A shadow mode.

## Audit limits

This map covers the current tracked engine, lifecycle, dashboard, control-plane,
contract, and historical verification paths. It does not claim that a future
VPS service is safe merely because the current local code is; runtime signer
placement remains deferred and is documented separately in the Phase 3A
runtime architecture.
