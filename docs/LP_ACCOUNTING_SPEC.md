# Per-user LP accounting specification

## Account identity

Every LP has an independent tuple:

```text
lpAccount = { owner, accountAddress, operator, approvedMarkets }
```

No balance, order, fill, inventory item, vault credit, or settlement claim may be attributed to another LP. The historical VILLA operator wallet is not an LP deposit account in this model.

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

## Accounting limitations

This specification is custody and lifecycle accounting. It does not claim realized maker PnL, profitability, or a complete fee model where the protocol does not expose enough authoritative data. The UI must retain the existing `PNL_UNAVAILABLE` honesty boundary.
