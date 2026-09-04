# Per-user LP accounting specification

## Account identity

Every LP has an independent tuple:

```text
lpAccount = { owner, accountAddress, accountVersion, operator, currentExposure, mintExposure }
```

No balance, order, fill, inventory item, vault credit, or settlement claim may be attributed to another LP. The historical VILLA operator wallet is not an LP deposit account in this model.

V1 accounts remain readable and owner-withdrawable for compatibility, but V1
market preparation is owner-approved and V1 cannot enter autonomous execution.
V2 uses owner-set current aggregate-exposure and mint-exposure caps; exposure is
recomputed from tracked-market balances and live orders, so genuine release of
risk capacity is reusable. A residual inventory or ambiguous order remains
accounted for until it is cleared.

## Asset buckets

For one account and market, the ledger reads these buckets separately:

| Bucket | Meaning |
| --- | --- |
| `directCollateralRaw` | ERC-20 collateral held by the account |
| `vaultCollateralRaw[pool]` | DreamDEX pool-vault credit owned by the account |
| `yesRaw` / `noRaw` | ERC-6909 outcome inventory for the pool nonce |
| `openOrders[]` | Exact chain orders whose owner is the account |
| `redeemedRaw` | Settled payout observed in the account balance or fixed vault credit |

`availableCollateralRaw` is only the direct balance plus explicitly readable withdrawable vault credit. Locked order escrow and outcome inventory are not available collateral.

## Future UI value definitions

These values are derived from authoritative account, pool, order, inventory,
and settlement reads. They are not estimates from a shared VILLA ledger.

| UI value | Exact meaning | Authoritative source |
| --- | --- | --- |
| `ALLOCATED` | Collateral that the owner has deposited into this account and assigned to the account's bounded strategy scope | Account collateral balance plus the account's owner-approved market and cap configuration |
| `AVAILABLE` | Direct account collateral not locked in order escrow and not represented only as a pool-vault credit | Collateral ERC-20 balance, less exact live order escrow; pool `getWithdrawableBalance(account, collateral)` is tracked separately until claimed |
| `DEPLOYED` | Current-market collateral and outcome inventory committed to live orders or held as strategy inventory, with each bucket kept separate | Account-owned open orders, direct collateral, ERC-6909 YES/NO balances, and pool vault credit |
| `PENDING SETTLEMENT` | Resolved or locked market inventory whose settlement state is known but whose redeemable payout has not yet been claimed | Market settlement status, payout vector, exact account outcome balances, and redemption records keyed by market ID |
| `WITHDRAWABLE` | Collateral the owner can safely withdraw to the owner address after exact chain reconciliation | Direct account collateral plus explicitly readable pool-vault credit after open-order and inventory checks |
| `REALIZED RESULT` | Observed redeemed collateral and recorded fees/gas for a closed market; unavailable where the protocol does not expose a complete authoritative cash-flow model | Settlement payout events, account balance deltas, vault credits, and exact transaction receipts; otherwise `PNL_UNAVAILABLE` |

`ALLOCATED`, `DEPLOYED`, and `AVAILABLE` must not double-count the same raw
collateral. Outcome inventory is reported as inventory exposure, not silently
converted to collateral value. A known losing residual remains explicitly
labelled and is not treated as a negative or positive realized result.

## Lifecycle accounting

- Owner deposit increases `directCollateralRaw` only.
- Buy placement decreases direct collateral by the pool's exact escrow; sell placement decreases the matching outcome bucket.
- A fill is reconciled from the pool/order events and balances. It is not inferred from a local success flag.
- Mint decreases collateral by the exact set amount and increases YES and NO by that amount.
- Burn decreases the paired minimum of YES and NO and increases collateral or the pool-vault credit according to the live protocol result.
- Cancel/reduce reconciliation records returned escrow as a direct balance or fixed pool-vault credit, never as operator income.
- Redemption uses the resolved market payout vector. Losing inventory remains a labelled zero-value residual until the account's hygiene policy closes it; no profit is fabricated.
- Owner withdrawal decreases account collateral and increases only the owner wallet. A vault claim first credits the account because the account is the pool caller.

## Isolation invariant

For any two accounts A and B:

```text
orders(A) and orders(B) are disjoint
inventory(A) and inventory(B) are disjoint
vaultCredits(A) and vaultCredits(B) are disjoint
withdrawDestination(A) = owner(A)
withdrawDestination(B) = owner(B)
```

The live two-LP proof must demonstrate this with two distinct account addresses, not merely two UI sessions pointing at one wallet.

## Live Phase 2 accounting evidence

The real Shannon owner-browser proof deposited exactly 1.00 tUSDC into one
personal account. The owner wallet moved from 500.00 to 499.00 tUSDC, while
the account showed 1.00 tUSDC allocated, available, and withdrawable. After
operator authorization and revocation, the owner withdrew exactly 1.00 tUSDC
to itself. The account ended at 0.00 tUSDC and capital was not changed by
revocation. This proves the direct owner-account buckets for the tested
lifecycle; it does not prove multi-LP engine delegation.

## Accounting limitations

This specification is custody and lifecycle accounting. It does not claim realized maker PnL, profitability, or a complete fee model where the protocol does not expose enough authoritative data. The UI must retain the existing `PNL_UNAVAILABLE` honesty boundary.
