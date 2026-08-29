# Phase 2 LP onboarding

Status: implementation complete locally; public enablement remains gated by disposable-wallet browser proof and owner approval.

Phase 2 turns `/app` into a real non-custodial LP account setup surface on Somnia Shannon. The product flow is:

```text
CONNECT WALLET
  -> CREATE OWN VILLA ACCOUNT
  -> ADD OWN tUSDC
  -> SEE CAPITAL
  -> AUTHORIZE VILLA
  -> REVOKE VILLA
  -> WITHDRAW TO CONNECTED OWNER WALLET
```

The historical operator wallet and the VILLA execution engine are not used by this flow. `Start VILLA` stays disabled, `VILLA_EXECUTION_ENABLED` is not changed, no signer material is installed, and no DreamDEX order or blockchain transaction is sent by the app except a wallet-approved account, token, authorization, or withdrawal action.

## Product surfaces

- `/` is the public product explainer for judges, first-time visitors, and prospective liquidity providers.
- `/app` is the owner-scoped VILLA account workspace.
- `/proof` is the separate read-only replay surface.

## Account boundary

The connected wallet owns one direct-deployed `VillaAccount`. The account holds the LP's tUSDC. The owner can deposit, withdraw to itself, set the trusted operator, and revoke the operator. The operator address is trusted configuration, not user input. See [LP account discovery](LP_ACCOUNT_DISCOVERY.md) and [VILLA account architecture](VILLA_ACCOUNT_ARCHITECTURE.md).

## Capital boundary

The amount field accepts exact tUSDC values at six decimals. The browser reads wallet balance, account balance, and allowance before acting. If required, it requests an exact token approval for the account, then an exact owner deposit. After confirmation, it requires the wallet decrease and account increase to equal the requested amount. Withdrawal uses only the connected owner account and performs the inverse reconciliation.

The UI labels capital as Allocated, Available, and Withdrawable. Deployed and Pending settlement are zero while execution is disconnected. VILLA does not display PnL, APR, yield, or profitability claims.

## Transaction states

Every wallet write communicates the following states:

- READY: the product has verified the account and is ready to ask the wallet;
- WAITING_FOR_WALLET: the LP must review the request in the wallet;
- SUBMITTED: the wallet returned a transaction hash;
- CONFIRMING: the product is waiting for a receipt and then post-transaction reads;
- SUCCESS: receipt and state reconciliation passed;
- FAILED: the receipt reverted, the wallet rejected the request, or verification failed.

Success is never shown solely because a wallet returned a hash.

## Staged enablement

Phase 2 follows the safety sequence `LOCAL -> TEST BUILD -> DISPOSABLE WALLET -> PUBLIC PREVIEW -> OWNER APPROVAL -> PUBLIC ENABLED`.

The local implementation may be exercised with a disposable Shannon wallet. A public deployment must remain preview or disabled until the browser proof covers Wallet A, Wallet B isolation, reload rediscovery, rejection states, exact deltas, and the security audit. The owner must approve any transition to public enabled. This task does not authorize wet strategy execution, final video recording, or DoraHacks submission.
