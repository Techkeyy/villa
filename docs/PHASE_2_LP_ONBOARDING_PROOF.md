# Phase 2 LP onboarding proof

Status: Phase 2 complete on Somnia Shannon testnet. Phase 3 autonomous engine
connection has not started.

This record combines the owner's real browser evidence with public Shannon
receipt reads. It proves the non-custodial LP account lifecycle for one owner.
It does not claim profitability, production readiness, or live autonomous
market making.

## Verified identities

| Item | Value |
| --- | --- |
| Network | Somnia Shannon Testnet, chain ID 50312 |
| Owner wallet | 0xCc67779F8eDb2C80DC665775C5597657C512FE1A |
| VILLA account | 0xFc9dbf0a8468aA56799b4e23B1EBe936426eE30b |
| Collateral | tUSDC, six decimals |
| Starting wallet balance | 500.00 tUSDC |

## Shannon transactions

Receipt status and block numbers were read from the Shannon RPC. All six
receipts returned success (0x1).

| Step | Transaction | Block | What it proves |
| --- | --- | ---: | --- |
| Create account | 0x6404c0107cbb2eead13f775cd67b9ba72e53539ad370dfe98a450a4ea653d1e0 | 474637349 (0x1c4a6425) | The connected wallet deployed the verified personal account. The receipt contract address is the VILLA account above. |
| Exact approval | 0x1067b040868aeb8406877d5ff08f9170ba61e3a99040dce502fc1ff566c9ee21 | 475755507 (0x1c5b73f3) | The owner approved exactly 1.00 tUSDC for the VILLA account, not an unlimited amount. |
| Deposit | 0xbeef5236b5864d94c6563cae0f2bb20dec0893fbb02d1360ec68be61cbc9ae37 | 475755648 (0x1c5b7480) | Exactly 1.00 tUSDC moved from the owner wallet into the owner's account. |
| Authorize | 0x2c4229935aff39e2cd5bc98466213ed3ebd66db6b0be65a1fcecdc5709293691 | 475757897 (0x1c5b7d49) | The owner set the configured VILLA operator through setOperator. |
| Revoke | 0xa4a8751727bf23c56dec16ea6e41f8c7725be973793c48ece4abbba9855cadbc | 475759982 (0x1c5b856e) | The owner revoked VILLA and returned the operator to zero. |
| Withdraw | 0x66e82e07645a881c03ca14c86fdac0e8d8fd6be0b7757315dea0ffad84b93e9b | 475761221 (0x1c5b8a45) | The owner withdrew exactly 1.00 tUSDC to the owner wallet. No destination field was used. |

## Before and after

Before creation, no verified VILLA account was available to the wallet. The
new account was verified against the pinned runtime, owner, Shannon protocol
wiring, and zero initial operator before the UI reported success.

After the deposit, the owner browser showed:

    wallet:       499 tUSDC
    allocated:    1 tUSDC
    available:    1 tUSDC
    withdrawable: 1 tUSDC

Authorization changed NOT AUTHORIZED to AUTHORIZED. Revocation changed it back
to NOT AUTHORIZED while capital remained untouched. The final withdrawal
returned the 1 tUSDC to the owner wallet and left account capital at 0 tUSDC.

## What Phase 2 proves

- A compatible browser wallet can connect to Shannon.
- One owner can deploy a personal VillaAccount.
- The wallet remains the account owner.
- The account can be rediscovered after reload.
- Incorrect candidates fail closed during runtime, owner, and wiring verification.
- The owner can approve exactly the requested tUSDC amount.
- The owner can deposit and withdraw its own collateral.
- Authorization is separate from depositing.
- The owner can authorize and revoke the scoped VILLA operator.
- Revocation does not remove owner capital.
- Withdrawal has no arbitrary recipient.
- The lifecycle is non-custodial.
- Start VILLA and automated execution remain disabled.

## Implementation fixes proved by the browser gate

Phase 2 discovery and owner-action testing found and fixed these issues:

1. Wrong-network discovery now stops before account reads and exposes an enabled
   Shannon switch flow.
2. Discovery panels are rendered from one canonical state, so loading, empty,
   discovered, and error states cannot overlap.
3. The dashboard stylesheet now makes the HTML hidden attribute authoritative
   with the global display-none invariant.
4. The account verifier uses the pinned runtime artifact and independently
   checks owner and protocol wiring.
5. The shared readiness evaluator retains wallet, chain, discovery, verified
   identity, owner match, and current-account identity. The action contexts now
   carry the current verified account address through balance refreshes.

## Security invariants

- There is no shared LP hot wallet in the browser flow.
- The browser never receives or collects a user private key.
- Withdrawals are owner-only and always return to the connected owner.
- The operator cannot withdraw.
- Approval is exact and account-scoped.
- No generic or arbitrary contract-call primitive is exposed.
- No arbitrary withdrawal recipient is accepted.
- Incorrect account candidates fail closed.
- An unresolved candidate does not authorize duplicate account deployment.
- Revoke sets the operator to the zero address.
- Start VILLA is disabled.
- No engine signer is present in the browser or Vercel frontend.
- No secrets are committed.

## Remaining limitations and Phase 3 boundary

- This is one real owner/account lifecycle proof. A separate two-LP isolation
  proof is still required before claiming open multi-LP delegation.
- The per-LP account is not connected to the autonomous VILLA engine yet.
- Public Start, Pause, Stop, runner spawn, and DreamDEX order placement remain
  unavailable from the frontend.
- Historical VILLA market-making, fills, settlement, and rollover evidence is
  replay evidence, not a claim that those actions are running now.
- No profitability, APR, yield, or realized PnL claim is made.
- No final video was recorded and no DoraHacks submission was made.
