# LP engine account adapter

The account adapter is the boundary between the existing VILLA engine and a per-user on-chain account. It does not change fair value, risk, quote, or rollover policy. It translates already-approved engine intents into explicit account methods and reconciles chain facts back into the engine's existing scopes.

## Intent mapping

| Engine intent | Account call | Required precondition |
| --- | --- | --- |
| prepare a venue | `prepareMarket(marketId)` | owner approved market |
| buy/sell a binary side | `operatorPlaceOrder(...)` | operator, approved current market, caps |
| remove quote | `operatorCancelOrder(marketId, orderId)` | order belongs to account on derived pool |
| shrink quote | `operatorReduceOrder(...)` | same ownership and pool checks |
| create complete pair | `operatorMintSet(marketId, amount)` | approved current market, collateral cap |
| burn paired inventory | `operatorBurnSet(marketId, amount)` | both outcome sides held by account |
| redeem settled position | `operatorRedeem(marketId, outcomeIdx, amount)` | owner-approved settlement record |
| recover pool credit | `operatorClaimVault(marketId, amount)` | fixed pool record, account receives credit |
| owner close | owner methods | no strategy logic involved |

The adapter never passes an arbitrary target or raw calldata. The contract derives the pool from the approved market ID and pins all recipients internally.

## Read reconciliation

The adapter reads, per account and market:

- direct collateral balance;
- the pool's withdrawable vault credit for the account;
- ERC-6909 YES and NO balances for the market's pool/nonce IDs;
- account-owned open orders from the pool;
- order owner, remaining quantity, expiry, and market binding;
- settlement resolution and payout vector;
- account/operator/market approval state.

Chain state is authoritative. The existing VILLA reconciliation rules remain in force: an indexer disagreement is ambiguous until the chain read resolves it, and an unknown order or inventory item is not silently treated as zero.

## Execution envelope

The adapter must serialize account writes per account. Before a write it checks market status, pool binding, order expiry, caps, and the Risk Governor decision. After a receipt it re-reads the exact order/account scope. On failure it keeps the account state unchanged in the local journal and reports the protocol revert without retrying a different target.

The existing hosted product remains read-only. Public Add Liquidity is outside Phase 1 and must not call this adapter until the Shannon account proof and a separate public-wallet authorization design pass.
