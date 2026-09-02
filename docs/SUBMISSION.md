# VILLA DoraHacks submission copy

Status: READY FOR OPERATOR REVIEW. This copy is prepared but not submitted.
The demo video field remains for the operator to complete after recording.

## Project fields

| Field | Prepared value |
| --- | --- |
| Project name | VILLA |
| One-line description | Account-bound liquidity infrastructure for DreamDEX Event Contracts on Somnia Shannon |
| Public repository | https://github.com/Techkeyy/villa |
| Live app | https://villa-ten-ashen.vercel.app/ |
| Proof page | https://villa-ten-ashen.vercel.app/proof |
| Network | Somnia Shannon testnet, chain ID 50312 |
| Demo video | `ADD_OPERATOR_VIDEO_URL_AFTER_RECORDING` |

## Problem

Event Contract markets need liquidity so traders can find a price. For the
liquidity provider, making that market means repeating pricing decisions,
checking risk and inventory, managing orders, and cleaning up after fills,
rollover, or settlement. The operational burden can leave books thin and
capital state difficult to inspect.

## Solution

VILLA is an operator-facing liquidity product for DreamDEX binary Event
Contracts. It gives each LP a personal on-chain `VillaAccount`, then combines
independent BTC fair value, deterministic risk controls, post-only quote
planning, inventory accounting, lifecycle management, and an inspectable proof
surface.

The LP owns the capital and the DreamDEX order. A separate canonical VILLA
operator may execute only approved account-bound actions. The operator cannot
withdraw LP funds or submit an arbitrary destination or calldata request.

## How it works

1. Connect a wallet to Somnia Shannon.
2. Create and fund a personal VillaAccount.
3. Authorize the canonical VILLA operator.
4. Read the exact DreamDEX market, book, account, and risk state.
5. Form fair value and a bounded post-only quote plan.
6. Monitor fills, inventory, rollover, and settlement.
7. Stop, reconcile, and leave owner withdrawal as a separate wallet action.

The product is for liquidity providers and operators, not retail bettors. Its
economic objective is potential spread capture. It makes no promise of profit,
yield, or positive PnL.

## Why DreamDEX

DreamDEX provides the Event Contract markets, order books, and settlement
lifecycle. VILLA adds a repeatable LP process above that venue: a clearer maker
workflow, explicit risk decisions, account-scoped inventory, and evidence that
a real order belonged to the LP account.

## Why Somnia

Somnia Shannon provides a fast testnet environment for the account, venue, and
lifecycle proof. VILLA uses chain ID `50312`, the official markets SDK, and
account-bound reads and writes through the fixed protocol configuration.

## Innovation

The core differentiator is the identity split. The LP's VillaAccount owns
collateral and orders, while the VILLA operator only acts within the approved
account boundary. That makes custody, order ownership, and operator execution
visible as separate facts instead of treating one server wallet as the product.

## Verified testnet evidence

The canonical proof used BTC 24-hour market `0x0000000000000000000000000000000000000000000000000000000000010a14`.

- VillaAccount: `0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2`.
- Owner wallet: `0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d`.
- VILLA operator: `0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37`.
- One minimum `1000` raw mint.
- One post-only `SELL_YES` order at `0.356`, quantity `1000` raw.
- Order ID `166020696663386049266`.
- DreamDEX order owner matched the VillaAccount.
- Cancel and paired burn completed.
- Final collateral was `1,002,000` raw tUSDC, with zero YES, zero NO, and zero open orders.

The exact transaction hashes are in [`docs/ACCOUNT_BOUND_WET_PROOF.md`](ACCOUNT_BOUND_WET_PROOF.md) and the public `/proof` route. The public app is safe-mode and the proof surface is read-only.

## Security and non-custodial architecture

The browser receives no execution credential. Start authenticates the owner wallet
with a short-lived message signature and sends only an empty-body account-bound
control request. The server owns fresh facts and preflight. Public control
requests reject arbitrary transaction fields. The private engine keeps its
signer outside the repository and outside Vercel. Persistent execution remains
disabled in this release.

Stop blocks new expansion, cleans only tracked account-owned orders, reconciles
state, and never withdraws capital. Owner withdrawal is direct, owner-scoped,
and destination-free.

## Tech stack

- Node.js and native ESM.
- `viem` for Ethereum-compatible chain reads and typed account operations.
- `@somnia-chain/markets-sdk` for DreamDEX market data and protocol access.
- Static dashboard and replay API for the public frontend.
- Account adapter, fair-value model, Risk Governor, quote planner, inventory
  lifecycle, settlement, lease, reconciliation, and typed private writer.
- Vercel for the public dashboard and a separate private engine boundary.

## Limitations

This is a bounded Shannon testnet MVP for a single canonical operator
configuration. Market data changes, full realized PnL is not claimed, and the
public release does not run persistent autonomous execution. Multi-LP operations
and broader venue coverage remain future work.

## Submission checklist

- [x] Public repository prepared.
- [x] Public app and proof URLs prepared.
- [x] Canonical account-bound proof documented.
- [x] README and demo script updated.
- [ ] Operator records and uploads the 2 to 3 minute video.
- [ ] Operator completes DoraHacks team fields.
- [ ] Operator pastes the final video link.
- [ ] Operator presses Submit only after reviewing every field.