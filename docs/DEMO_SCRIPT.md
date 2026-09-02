# VILLA demo rehearsal script

Status: ready for operator recording. Recording and upload are not performed by
this release task.

Target runtime: 2:30 to 2:55.

Start at [villa-ten-ashen.vercel.app](https://villa-ten-ashen.vercel.app/). The
public route is explainer-first. Use `/app` to show the LP journey and `/proof`
to show the read-only canonical account-bound evidence.

## Run of show

| Time | Screen and narration |
| --- | --- |
| 0:00-0:20 | Open `/`. "DreamDEX Event Contract books need liquidity. VILLA is for the liquidity provider or operator, not a retail betting screen. It helps make prices visible while the LP keeps custody of capital." |
| 0:20-0:45 | Point to the product explanation and LP journey. "Each LP gets a personal VillaAccount. The wallet funds it, authorizes the approved operator, and keeps owner-only withdrawal. VILLA cannot withdraw the account's capital." |
| 0:45-1:05 | Open `/app`. Show Connect, Create, Fund, Authorize, Ready, Start, Stop, and Withdraw. "The workspace makes the handoff visible. Start is an authenticated, account-bound control request. It is not a generic wallet transaction relay, and the public release remains safe-mode." |
| 1:05-1:25 | Return to `/` or `/proof` and explain pricing and safety. "VILLA reads the market and book, forms an independent fair value from BTC data, checks inventory and exposure, and lets the Risk Governor return ALLOW, REDUCE_ONLY, or HALT." |
| 1:25-2:05 | Open `/proof`, keep the canonical account-bound scene selected. "This is the real Shannon proof. The LP funded the account, VILLA minted the minimum complete set, and one post-only SELL_YES order was placed. DreamDEX recorded the VillaAccount as ORDER OWNER. The separate VILLA operator was the execution signer." Point to the owner and operator panels, order ID `166020696663386049266`, price `0.356`, and quantity `1000` raw. |
| 2:05-2:30 | Point to MINT TX, ORDER TX, CANCEL TX, and BURN TX. "The order was cancelled, paired inventory was burned, and capital reconciled to 1,002,000 raw tUSDC. YES, NO, and open orders ended at zero. The owner withdrawal path was not called." |
| 2:30-2:55 | Point to READ ONLY and the safe-mode copy. "The public proof is inspectable without a signer. VILLA's safety boundary is the point: the account owns the capital and order, the operator has constrained permissions, and the release does not claim guaranteed profit or production execution." |

## Rehearsal checks

- Say that the direct user is the liquidity provider or operator.
- Say `VillaAccount` when describing capital and order ownership.
- Say `VILLA operator` when describing the separate execution signer.
- Keep `/proof` in read-only mode. Do not connect a wallet during the proof walkthrough.
- Do not promise fills, profitability, yield, or positive PnL.
- Do not start a live session, create another market cycle, or send a transaction.
- Keep the final recording under three minutes.

## Evidence references

- Canonical proof record: [`ACCOUNT_BOUND_WET_PROOF.md`](ACCOUNT_BOUND_WET_PROOF.md).
- Public proof route: https://villa-ten-ashen.vercel.app/proof.
- Public repository: https://github.com/Techkeyy/villa.