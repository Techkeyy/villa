# VILLA account security specification

## Security invariants

1. Only `owner` can move collateral directly out of the account.
2. Every owner withdrawal has the owner as its hard-coded destination.
3. Operator actions cannot specify a recipient, arbitrary target, arbitrary selector, builder, builder fee, or native value.
4. Every operator market action requires an owner-approved market ID.
5. Current-pool actions require the module record and the pool's live market binding to agree, with the configured collateral, outcome token, settlement singleton, and an unfinalized pool.
6. Buy-side allowance is exact for the current call and reset to zero after the pool call. No standing unlimited collateral allowance is created by the account.
7. Outcome-token approvals are limited to the fixed DreamDEX pool, module, and settlement addresses. They are owner-revocable.
8. Reentrancy is rejected around every state-changing account method that calls an external token or DreamDEX contract.
9. Native value and unknown function selectors are rejected by the fallback.
10. `OPERATOR_PRIVATE_KEY` is not an account constructor argument and is not stored in the contract or deployment artifacts.

## Authority matrix

| Action | OWNER | OPERATOR | ATTACKER |
| --- | :---: | :---: | :---: |
| `deposit` | yes | no | no |
| `withdraw` | yes, to owner | no | no |
| ownership/operator/limits/market approval | yes | no | no |
| prepare/revoke protocol approvals | yes | no | no |
| place/cancel/reduce on approved current EC | no | yes | no |
| mint/burn paired inventory | no | yes | no |
| redeem approved market | no | yes | no |
| claim a fixed pool vault credit | yes or operator | yes, to account only | no |
| recover unsupported token | yes, to owner | no | no |
| arbitrary external call or token transfer | no | no | no |

`operatorClaimVault` is housekeeping, not an LP withdrawal. The external pool's `withdraw(token, amount)` pays `msg.sender`, which is the VILLA account. The operator EOA is never that caller and is never supplied as a destination.

## Market and selector restrictions

The account source contains only explicit interfaces for ERC-20 `allowance`, `approve`, `transferFrom`, and `transfer`; ERC-6909 `setOperator`; the module's `markets` and `redeem`; and the binary pool's parameter read, binary placement, cancel, reduce, mint, burn, and vault withdrawal.

There is no low-level arbitrary-call entry point. Low-level calls are used only for the fixed ERC-20/ERC-6909 selectors above so non-standard token return values can be checked and revert data can be preserved.

## Revocation behavior

`revokeOperator` immediately makes every operator method fail. Owner market approval can be removed independently. `revokeMarketApprovals` also clears the fixed pool collateral allowance and removes outcome-token approvals for that pool, module, and settlement. Open orders must be cancelled and inventory/vault credits reconciled before a user treats an account as fully closed; the contract does not claim that revocation magically settles open market state.

## Required adversarial checks

The Phase 1 test gate covers:

- owner success and non-owner rejection for deposit, withdraw, ownership, operator, limits, market approval, and recovery;
- operator success only for approved/current Event Contract actions;
- rejection of operator withdrawal, arbitrary transfer, ownership/operator mutation, arbitrary target/selector, wrong market, stale pool, finalized pool, wrong token, wrong outcome, zero values, invalid order kinds/types, and exceeded caps;
- attacker rejection on every state-changing selector;
- zero owner and zero protocol addresses, duplicate initialization by the absence of an initializer, reentrancy guard, failed external call rollback, exact allowance cleanup, and revoked-operator behavior.

The live Shannon proof supplements these deterministic checks with actual contract-caller order ownership, cancellation, paired inventory, settlement, owner withdrawal, and two-account isolation.
