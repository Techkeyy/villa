# VILLA per-user account architecture

Phase 1 proves the smallest account boundary needed before VILLA can accept liquidity from more than one LP. It does not enable the public Add Liquidity surface. The account is a user-owned custody boundary on Somnia Shannon, not a shared VILLA wallet and not a replay of the historical operator wallet.

## Locked trust model

| Principal | Meaning | Contract authority |
| --- | --- | --- |
| OWNER | The LP wallet that owns one account | Deposit, withdraw to itself, ownership, operator, market approvals, limits, protocol-approval revocation, unsupported-token recovery |
| OPERATOR | The VILLA automation identity | Only the explicit approved-market EC actions below |
| ATTACKER | Any other EOA or contract | No account action |

The account holds the LP's collateral and outcome inventory. DreamDEX sees the account address as the trader because every pool and settlement call is made by the account itself. The operator never receives an LP withdrawal destination.

## Direct deployment decision

Phase 1 uses **direct deployment**, not a factory. A factory would reduce the cost of repeating deployment, but it would add a second privileged surface before the core custody and caller behavior is proven. Each account is deployed with immutable DreamDEX Shannon addresses, an owner, an optional operator, and explicit order caps. A deterministic factory can be considered only after this boundary is independently audited and the deployment salt/API is specified.

## Fixed protocol wiring

The constructor pins the Shannon collateral ERC-20, the shared ERC-6909 outcome-token singleton, `BinaryMarketsModule` for market lookup and redemption, and `BinarySettlement` for pool-wiring checks. The operator cannot replace any of these addresses.

A market ID must first be approved by the owner. For trading, minting, burning, cancellation, or current pool preparation, the account derives the pool from the module and verifies the pool's collateral, outcome token, settlement singleton, current market, and finalized state. A stale pool binding therefore fails closed after recycle.

## Explicit operator surface

The operator can call only:

1. `operatorPlaceOrder`: binary order kinds 0-3, a bounded quantity, bounded buy-side collateral, no builder, no builder fee, and fixed self-matching option 0.
2. `operatorCancelOrder` and `operatorReduceOrder` on the derived current pool.
3. `operatorMintSet` and `operatorBurnSet` on the derived current pool.
4. `operatorRedeem` through the fixed module, with a binary outcome index.
5. `operatorClaimVault` for a pool derived from an owner-approved market. The pool pays the account because the account is `msg.sender`.

There is no generic `call(address,bytes)`, arbitrary token transfer, arbitrary pool parameter, operator ownership change, operator market approval, or operator-selected withdrawal destination.

## Lifecycle and rollover

The intended lifecycle is:

```text
OWNER funds account
  -> OWNER approves Market A and its protocol operators
  -> OPERATOR prepares, mints if needed, places/cancels/reduces orders
  -> OPERATOR handles paired inventory and claims fixed pool-vault credit
  -> OPERATOR redeems after settlement; payout returns to account
  -> OWNER withdraws account collateral to OWNER
  -> OWNER revokes operator and/or protocol approvals
```

The same account can roll from Market A to successor Market B. The owner approves B before the transition; the operator then calls the same explicit methods with B. This is an allowlist update, not a generic permission to call an arbitrary contract. A market whose pool has been recycled is rejected for trading by the current-market check while its approved settlement record can still be used for redemption and vault accounting.

## Scope boundaries

Phase 1 does not add public deposits, pooled custody, production execution, smart-wallet upgrades, arbitrary protocol integrations, or strategy changes. The frozen `villa-fv-v1`, `villa-risk-v1`, and `villa-quote-v1` modules remain unchanged. The account adapter is an execution boundary below those modules.

## Protocol evidence used

The design follows the current installed `@somnia-chain/markets-sdk` 0.28.1 interfaces and current DreamDEX documentation:

- [DreamDEX Event Contracts](https://app.dreamdex.io/docs/trading/event-contracts)
- [DreamDEX market structure](https://app.dreamdex.io/docs/developers/event-contracts/market-structure)
- [DreamDEX EC recipes](https://app.dreamdex.io/docs/developers/event-contracts/recipes)
- [DreamDEX contracts and addresses](https://app.dreamdex.io/docs/developers/event-contracts/contracts-and-addresses)
- [DreamDEX bot-kit source](https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/skills/dreamdex-bot/SKILL.md)

The bot-kit session-key/operator path is documented as spot-only; Phase 1 therefore proves a contract account by calling the binary pool's direct `placeBinaryOrder`, rather than incorrectly using the spot `placeOrderFor` surface.
