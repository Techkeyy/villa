# VILLA account-bound wet proof

Status: VERIFIED on Somnia Shannon testnet. This document is a public, secret-free evidence record. It describes a completed bounded proof and does not authorize another run.

## What the proof shows

One LP-funded `VillaAccount` owned a real DreamDEX order. The LP wallet remained the owner of the account and capital. The canonical VILLA operator executed only approved account-bound actions. The order was cancelled, paired inventory was burned, and the account returned to its recorded starting collateral. VILLA did not call owner withdrawal.

Plain-language sequence:

1. The LP funded the personal account with `1,002,000` raw tUSDC.
2. The LP authorized the canonical VILLA operator.
3. VILLA minted the minimum complete set for the exact BTC 24-hour market.
4. VILLA placed one real post-only `SELL_YES` order.
5. DreamDEX recorded the `VillaAccount` as the order owner.
6. The separate VILLA operator was the execution caller, not the capital owner.
7. The order was cancelled.
8. Paired inventory was burned.
9. Capital reconciled to `1,002,000` raw tUSDC.
10. The session stopped, the lease was released, and execution stayed disabled.

## Canonical identities

| Role | Address |
| --- | --- |
| Owner wallet | `0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d` |
| Capital and order owner, VillaAccount | `0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2` |
| VILLA execution operator | `0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37` |
| Chain | Somnia Shannon, `50312` |
| Market | BTC 24-hour, `0x0000000000000000000000000000000000000000000000000000000000010a14` |

## Order facts

| Fact | Recorded value |
| --- | --- |
| Mint | `1000` raw |
| Side | `SELL_YES` |
| Price | `0.356` |
| Quantity | `1000` raw |
| Order ID | `166020696663386049266` |
| Order owner | VillaAccount, verified |
| Final collateral | `1,002,000` raw tUSDC |
| Final YES | `0` |
| Final NO | `0` |
| Open orders | `0` |
| Owner withdrawal | Not called |
| Session | Stopped |
| Execution | Disabled |

## Transaction evidence

| Action | Transaction hash |
| --- | --- |
| MINT TX | `0x0389fac8ca7fe56bf6b2b96324fd69dd4799845926e920fe136627445171b972` |
| ORDER TX | `0xbb4e0d8b33259858dee23a50ce9bbd8dac60fe3b52a803fdce260a429ba89e6d` |
| CANCEL TX | `0x80a3563c92ef35fedfa61af5ae099ce5804cf74e80158615a0e7852a36078735` |
| BURN TX | `0xb645b3b0b9ffbc7cd72c1b40aaca0f2f344afe64fb2c6c1145fa56fe81f0b87e` |

## Supporting historical evidence

The earlier f920 record is supporting lifecycle evidence for settlement and redemption. It is not the canonical order proof, and its market is not reused for this release claim.

## Safety conclusion

The proof demonstrates account ownership and constrained operator scope. The account contract does not expose arbitrary destination or calldata input through the public app. The browser does not receive the private execution credential. The public release keeps persistent execution disabled, and safe-mode Start returns without spawning a writer or sending a transaction.

## Release verification

The final release gate recorded these results after public publication and production verification:

| Gate | Result |
| --- | --- |
| Full regression | 651/651 release run |
| Dashboard | 95/95 release run |
| Operator | 25/25 release run |
| Execution | 210/210 baseline |
| Focused recovery | 13/13 |
| Focused writer/session/reconciliation/policy | 72/72 |
| Solidity account artifact compile | PASS |
| Secret scan | CLEAN |
| Production dependency audit | 0 vulnerabilities |

No new wet trading cycle is required for this release. The public `/proof` route renders the same evidence as a read-only envelope.
