# VILLA LP user journey

Status: Phase 2 live owner-browser proof complete. The per-LP account lifecycle is public testnet functionality; autonomous engine connection remains outside Phase 2.

VILLA is for liquidity providers and operators who want to make their own capital available to DreamDEX Event Contracts. It is not a retail betting screen. The journey keeps the owner wallet, the user-owned VILLA account, and the future automation permission visible.

## Live Phase 2 evidence

The owner-browser lifecycle completed on Somnia Shannon for one owner and one
personal account. The owner deployed the account, approved exactly 1.00 tUSDC,
deposited it, authorized and revoked the configured operator, and withdrew the
same 1.00 tUSDC back to the owner wallet. The account ended with 0 tUSDC and
the operator revoked. Transaction hashes and receipt blocks are recorded in
PHASE_2_LP_ONBOARDING_PROOF.md.

## Core journey

| LP moment | Product response | System truth |
| --- | --- | --- |
| Understand | The public explainer describes VILLA in plain language and links to the LP workspace and verified replay. | No wallet or capital request occurs on `/`. |
| Connect | The visitor connects a normal EIP-1193 wallet. | The browser receives an address only. No private key is requested or handled. |
| Choose network | The product checks chain ID 50312 and offers the standard wallet switch or add-network request. | Actions remain paused until Somnia Shannon is confirmed. |
| Find account | VILLA checks a local hint, the Shannon Explorer ownership-event index, and a provider log fallback. | Every candidate is rechecked by exact runtime code, owner, immutable wiring, and chain. Index data is never authorization. |
| Create account | If no verified account exists, the wallet deploys the audited `VillaAccount` bytecode with the connected owner and operator set to zero. | The UI reports success only after receipt, address, bytecode, owner, operator, and wiring verification. |
| Add liquidity | The owner enters an exact six-decimal tUSDC amount. The wallet approves that account for that amount if needed, then deposits into the account. Operator authorization is not required for this owner deposit. | Post-transaction wallet and account deltas must reconcile exactly. |
| Authorize | The owner can set the trusted VILLA operator or revoke it. | The product refuses to overwrite an unexpected operator and rereads the operator after each transaction. |
| Review capital | My Liquidity shows wallet balance, allocated, available, and withdrawable capital. | Deployed and pending settlement remain zero while execution is disconnected. No PnL, APR, yield, or profit claim is shown. |
| Start | The workspace explains readiness and keeps Start VILLA disabled. | Phase 2 does not connect the execution engine or place DreamDEX orders. |
| Withdraw | The owner enters an amount and withdraws to the connected owner wallet. | There is no destination field. Owner, code, exact decrease, and exact wallet increase are verified. |
| Reconnect | Refresh, reload, and a new session rediscover the account from verified on-chain evidence. | Deleting local storage does not destroy account identity. |

### Phase 2 deposit minimum

The Phase 2 product minimum is **1.00 tUSDC** (`1,000,000` raw units at six
decimals). The browser rejects zero, negative, malformed, over-precision, and
below-minimum values without opening a wallet request, and rejects amounts above
the connected wallet balance. This is a product-layer onboarding floor, not a
change to VillaAccount contract economics; a future live market-making phase may
replace it with a strategy-derived minimum.

If the current allowance is below the requested amount, VILLA requests an
approval for exactly that amount with the verified VillaAccount as spender. It
never requests an unlimited approval. An existing sufficient allowance skips the
approval and proceeds to deposit. If approval succeeds but deposit fails, retry
rechecks allowance and does not request the same approval unnecessarily.

## Browser states

### Disconnected

The app offers Connect wallet, identifies Somnia Shannon Testnet, and says that VILLA never asks for a private key. It does not show a capital form before a wallet is connected.

### Connected, wrong network

The app shows the connected address and an enabled Switch to Shannon action when the wallet is on another chain. Account history and capital actions remain paused until chain ID 50312 is read from the wallet.

### Connected, account lookup in progress

The app shows a compact loading state while it reads the verified account artifact, indexed ownership history, and chain state. If verification cannot complete, loading stops in an explicit Account lookup unavailable state with Retry; the create-account action remains hidden until discovery succeeds or returns a genuine no-account result.

### Connected, no verified account

The app offers Create VILLA account. The copy explains that the connected wallet remains owner and that automation starts unauthorized.

### Account ready for setup

The app shows exact tUSDC funding, authorization, and owner-only withdrawal actions. Every write uses the wallet and shows WAITING_FOR_WALLET, SUBMITTED, CONFIRMING, SUCCESS, or FAILED. The canonical `isVerifiedOwnerAccountReady(state)` predicate is shared by the ACCOUNT READY badge, Add Liquidity, Withdraw, and authorization eligibility, so rendered readiness cannot disagree with an owner action guard.

### Capital account ready

After funding and authorization, the readiness card may say READY for the next integration phase. Start VILLA remains disabled, and Deployed and Pending settlement remain zero.

### Failed or rejected

The app says what was not verified, keeps the transaction hash in technical detail when available, and does not record success. Wallet rejection, wrong network, wrong owner, wrong code, unexpected operator, and unavailable discovery are distinct safety cases.

## Owner control rules

- The connected wallet is the only source of the current owner address.
- A URL parameter, request body, local storage value, or visible account address cannot select an account for capital actions.
- The account contract has no withdrawal destination input. Withdrawal is owner-only and returns collateral to the contract owner.
- VILLA authorization is a narrow, visible owner transaction. Revoke is always available after authorization.
- The public proof route remains read-only and cannot call the account or engine control plane.
