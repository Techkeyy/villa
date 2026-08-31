# LP transaction policy

Phase 3B0 adds one central policy boundary in
`src/execution/lp-transaction-policy.mjs`. A future wet writer must call
`policy.validate(plan)` immediately before it can broadcast. There are no
ad-hoc transaction sends elsewhere in this boundary.

## Allowlist

Only these exact `VillaAccount` operator methods are permitted:

| Operation | Contract method | Account effect |
| --- | --- | --- |
| Place | `operatorPlaceOrder` | Places a bounded order through the account's approved current pool |
| Cancel | `operatorCancelOrder` | Cancels one account-scoped order |
| Reduce | `operatorReduceOrder` | Reduces one account-scoped order |
| Mint | `operatorMintSet` | Creates complete-set inventory in the account |
| Burn | `operatorBurnSet` | Burns paired complete-set inventory from the account |
| Redeem | `operatorRedeem` | Redeems a resolved account position |
| Claim vault credit | `operatorClaimVault` | Credits the account's fixed pool-vault balance back into the account |

The actual method names and arguments are taken from `contracts/VillaAccount.sol`.
The policy re-encodes the supplied arguments and compares the resulting
selector and full calldata. An unknown selector, method, argument, or target is
rejected.

## Explicit denials

The operator policy rejects withdrawal, ownership changes, operator changes,
market approval changes, unsupported-token recovery, arbitrary calls, arbitrary
ERC20 transfers, arbitrary recipients, unknown destinations, and direct
operator-EOA spending of LP collateral. The adapter has no methods for those
operations, and the policy does not accept their selectors.

## Identity and intent checks

Every plan must contain a deterministic intent envelope with:

```text
sessionId, account, owner, operator, chainId, marketId, action,
amount, price, side, expiration, destination, policyVersion, txIndex, createdAt
```

The policy requires:

- `to == destination == account == orderOwner`;
- `signer == operator`, while `owner` remains separate;
- Shannon chain `50312` and the session's exact current `marketId`;
- full calldata equality with the allowlisted contract ABI;
- exact amount, price, side, and expiry equality between intent and calldata;
- an unexpired intent and a transaction index below the cycle cap; and
- no native value.

The transaction is derived from the approved intent. Changing the account,
owner, signer, chain, market, selector, destination, amount, price, expiry, or
intent age causes validation to fail.

## First-cycle hard caps

All quantities are six-decimal tUSDC raw units where applicable. These are hard
upper bounds enforced by code; later phases may lower them but may not raise
them without a new safety review.

| Cap | Value |
| --- | ---: |
| `MAX_ACCOUNT_CAPITAL` | `1.00 tUSDC` |
| `MAX_ORDER_NOTIONAL` | `0.25 tUSDC` |
| `MAX_OPEN_ORDERS` | `2` |
| `MAX_PENDING_EXPOSURE` | `0.25 tUSDC` |
| `MAX_MINT_AMOUNT` | `0.25 tUSDC` |
| `MAX_SESSION_DURATION` | `900` seconds |
| `MAX_TX_COUNT` | `12` |

These caps do not authorize execution. They constrain a future explicitly
approved one-account test.
