# LP engine account adapter

Phase 3A implementation: `src/execution/lp-adapter.mjs` and
`src/execution/lp-shadow.mjs`. Phase 3B0 adds the unarmed session, preflight,
policy, writer, control, and reconciliation boundaries in the same execution
package.

The adapter is instantiated for exactly one `VillaAccount`. Its three identity
values are explicit and distinct:

```text
signer  = configured VILLA operator EOA
account = LP VillaAccount contract
owner   = LP wallet that owns the account
```

The adapter uses `EXECUTION_MODE=SHADOW` in Phase 3A. Read methods may use a
public client; write-shaped methods return unsigned plans only. There is no
adapter broadcast method and no direct SDK trader path below this boundary.

The account adapter is the boundary between the existing VILLA engine and a per-user on-chain account. It does not change fair value, risk, quote, or rollover policy. It translates already-approved engine intents into explicit account methods and reconciles chain facts back into the engine's existing scopes. `src/execution/lp-readiness.mjs` is the pure START preflight and `src/execution/lp-shadow.mjs` overlays account-scoped reads onto the existing risk and quote pipeline.

## Intent mapping

| Engine intent | Account call | Required precondition |
| --- | --- | --- |
| prepare a venue | owner-controlled `prepareMarket(marketId)` | not exposed by the engine adapter; owner approval is a separate lifecycle action |
| buy/sell a binary side | `operatorPlaceOrder(...)` | operator, approved current market, caps |
| remove quote | `operatorCancelOrder(marketId, orderId)` | order belongs to account on derived pool |
| shrink quote | `operatorReduceOrder(...)` | same ownership and pool checks |
| create complete pair | `operatorMintSet(marketId, amount)` | approved current market, collateral cap |
| burn paired inventory | `operatorBurnSet(marketId, amount)` | both outcome sides held by account |
| redeem settled position | `operatorRedeem(marketId, outcomeIdx, amount)` | owner-approved settlement record |
| recover pool credit | `operatorClaimVault(marketId, amount)` | fixed pool record, account receives credit; this is not LP withdrawal |

The adapter never passes an arbitrary target or raw calldata. The contract derives the pool from the approved market ID and pins all recipients internally. The returned call target is always the selected VillaAccount, and its metadata records `orderOwner = account`, `signer = operator`, and `owner = LP wallet`.

The adapter intentionally does not expose `withdraw`, `arbitraryCall`,
`transferTo`, `setOwner`, or `setOperator`.

The future wet path is additionally gated by
`src/execution/lp-transaction-policy.mjs`, which re-encodes and validates every
intent against the exact `VillaAccount` operator ABI before the single writer
boundary. `src/execution/lp-writer.mjs` is the only planned broadcast seam; it
serializes nonce-bearing calls and halts on `UNKNOWN`. See
`docs/LP_TRANSACTION_POLICY.md` and `docs/LP_RECONCILIATION_MODEL.md`.

## Read reconciliation

The adapter reads, per account and market:

- direct collateral balance;
- the pool's withdrawable vault credit for the account;
- ERC-6909 YES and NO balances for the market's pool/nonce IDs;
- account-owned open orders from the pool;
- order owner, remaining quantity, expiry, and market binding;
- settlement resolution and payout vector;
- account/operator/market approval state.
- direct account collateral and fixed pool-vault credit.

Chain state is authoritative. The existing VILLA reconciliation rules remain in force: an indexer disagreement is ambiguous until the chain read resolves it, and an unknown order or inventory item is not silently treated as zero.

## Execution envelope

The adapter must serialize account writes per account. Before a future live write it checks market status, pool binding, order expiry, caps, and the Risk Governor decision. After a receipt it re-reads the exact order/account scope. On failure it keeps the account state unchanged in the local journal and reports the protocol revert without retrying a different target. Phase 3A stops before this write boundary and returns a deterministic plan with `broadcast: false`.

The existing hosted product remains read-only. Public Start remains disabled.
The Phase 2 account fixture is used only through public reads in Phase 3A; its
operator is currently revoked and its capital is zero. No Phase 3A write may
authorize, fund, trade, cancel, mint, burn, redeem, or withdraw through that
account.
