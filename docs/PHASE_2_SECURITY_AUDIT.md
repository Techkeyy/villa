# Phase 2 security audit

Status: Audit-skill applied to the local Phase 2 commit; live owner-browser proof and public enablement are gated separately.

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

## Actual Audit-skill evidence

The required skill was found and read at `C:\Users\HomePC\Desktop\skill\audit-skill\SKILL.md`. Its project-audit phases were applied to commit `321ce0a1e07aed5f5537d2be46de157fddfabe95`.

### Phase 0: claims inventory

The README and Phase 2 records were read before the checks. Checkable claims included chain ID 50312, public repository and deployment URLs, the `/`, `/app`, and `/proof` routes, exact tUSDC configuration, test counts, build commands, signer-free hosted execution, and the staged public-enable boundary. The public repository and published `master` ref were checked directly; the Vercel URL returned HTTP 200 but still served the previous replay-only build. The README was updated to distinguish the local Phase 2 commit from the older public deployment.

### Phase 1: mechanical hygiene

- `npm test`: 422 passing.
- `npm run operator:test`: 17 passing.
- `npm run dashboard:test`: 39 passing.
- `npm run dashboard:build`: passed.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilities.
- `git diff --check`: passed.
- No TODO or FIXME leftovers, dynamic `eval`/`Function` use, PEM/private-key headers, or tracked secret files were found. `console.log` occurrences are intentional CLI/server status output, not browser credential logging.
- The tracked repository is approximately 1.45 MiB of Git objects; `.scratch/`, `dist/`, runtime JSON, `.env`, and key extensions are covered by `.gitignore`.

### Phase 2: repository hygiene

The complete tracked-file list was reviewed. The current worktree is clean, the Phase 2 commit is one commit ahead of `origin/master`, and the public clone was independently clean at the published starting commit. No build output or scratch clone is tracked.

### Phase 3: claims versus reality

- The local `npm run dashboard:replay` command started successfully on a stable localhost port and `/app` returned HTTP 200.
- The public GitHub repository is public and owned by Techkeyy. Its unauthenticated `master` ref matches the starting local commit, not the unpushed Phase 2 commit.
- The clean public clone passed `npm ci`, `npm test` at 417/417 for the published baseline, and `npm run dashboard:build`.
- The public Vercel response is HTTP 200 and is the older replay-only deployment. Therefore Add Liquidity is not publicly enabled.
- The official Shannon explorer API logs query found the known Phase 1 ownership event; the browser client treats this API as an index and verifies candidates on-chain. See the [Shannon explorer API documentation](https://shannon-explorer.somnia.network/api-docs).

### Phase 4: adversarial checks

The Phase 2 tests cover zero, negative, over-precision, scientific, NaN, and insufficient amounts; wrong owner; wrong runtime code; wrong immutable wiring; unexpected operator; URL account injection; local storage as a candidate-only hint; exact approval/deposit/withdraw call shapes; transaction rejection and confirmation states; and owner-scoped capital actions. The mock provider test confirms Wallet B cannot pass Wallet A's expected-owner check.

### Phase 5: limits and remaining evidence

The real owner-browser proof has not yet been performed. It must use the owner's disposable Shannon Wallet A and Wallet B in a normal browser, record only public addresses and transaction hashes, and verify reload discovery, authorization/revocation, exact capital deltas, isolation, and zero strategy execution. Kane is optional for this functional proof; its currently stored OAuth token is expired. Public push, Vercel redeploy, and public Add Liquidity enablement remain blocked until this evidence and owner approval are complete.
