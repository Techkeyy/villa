# Phase 2 security audit

Status: local code review complete; live browser proof and public enablement are gated separately.

Scope: the Phase 2 browser account client, static app surface, direct `VillaAccount` deployment path, account discovery, tUSDC approval and deposit, authorization and revocation, owner-only withdrawal, and public proof separation.

## Findings summary

| Severity | Finding | Disposition |
| --- | --- | --- |
| Critical | No private key or signer material is read by the browser app. | Pass |
| Critical | No generic contract call, arbitrary withdrawal destination, or user-selected operator exists in the Phase 2 client. | Pass |
| High | Capital actions require connected-wallet ownership, exact runtime code, exact immutable wiring, and chain 50312. | Pass in code review |
| High | Post-receipt success requires exact on-chain state and balance reconciliation. | Pass in code review |
| Medium | A full provider log scan can exceed Shannon RPC range limits. | Mitigated by the official explorer index, on-chain candidate verification, and fail-closed retry behavior |
| Medium | Browser wallet, explorer CORS, and live testnet conditions require real browser proof. | Open gate, not silently waived |
| Low | Local storage can be edited. | Safe because it is only a candidate hint and every candidate is verified on-chain |

No Critical or High vulnerability was identified in the implementation review. This is an internal engineering audit, not a third-party audit or a guarantee of safety.

## Review checklist

### Identity and discovery

- Connected wallet address is normalized from EIP-1193 response.
- Chain ID is read from the wallet, not from a URL or form.
- A candidate account must match pinned runtime bytecode exactly.
- `owner()` must equal the connected wallet.
- All four immutable protocol addresses must match trusted configuration.
- Explorer logs and local storage are never treated as authorization.
- URL/query/body account injection is not used.

### Deployment

- Browser deployment uses the checked `VillaAccount` creation bytecode only.
- Constructor owner is the connected wallet.
- Constructor operator is zero.
- Receipt, contract address, code, owner, operator, and wiring are checked before success.
- No factory, proxy upgrade, or mutable implementation is introduced.

### Capital

- tUSDC is fixed to the Shannon test collateral address.
- Decimal parsing is integer based and accepts no negative, scientific, NaN, or over-precision value.
- Approval is exact and scoped to the verified account.
- Deposit is an owner call to the verified account.
- Wallet and account deltas must equal the requested amount.
- Withdraw has no destination input and is owner-only in the proven contract.
- Withdraw wallet and account deltas must reconcile exactly.

### Authorization

- The trusted operator is configuration, not a form field.
- An unexpected existing operator is not overwritten.
- Authorize and revoke reread the operator after the receipt.
- Start VILLA remains disabled and no execution engine call exists in the browser client.

### UX and phishing resistance

- Wallet requests are visible as WAITING_FOR_WALLET.
- Hash, receipt, and post-transaction reads are distinguished.
- FAILED is shown when the wallet rejects or verification fails.
- Technical hashes are behind a technical-detail disclosure.
- Private-key language is explicit.
- Public faucet links point to Somnia resources.

## Required live gates

Before public enabled status, an owner or authorized tester must complete the real browser proof with a disposable Wallet A and Wallet B:

1. Connect and switch to Shannon.
2. Create or rediscover Wallet A's account after deleting local storage.
3. Approve and deposit an exact small tUSDC amount.
4. Authorize, revoke, and reauthorize the trusted operator.
5. Withdraw the available amount to Wallet A and reconcile the balances.
6. Reload and start a new session to rediscover the account.
7. Confirm Wallet B cannot discover or act on Wallet A's account.
8. Confirm no runner spawn, DreamDEX order, or blockchain write outside the explicitly approved account setup actions.

The local `Audit-skill` file named by the project owner was unavailable in this builder environment. Equivalent security checks are recorded here without claiming that unavailable skill was read. The browser gate remains open until a real wallet-capable browser run is observed.
