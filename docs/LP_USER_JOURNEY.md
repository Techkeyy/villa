# VILLA LP user journey

Status: Phase 2 implementation, public enablement gated by browser proof and owner approval.

VILLA is for liquidity providers and operators who want to make their own capital available to DreamDEX Event Contracts. It is not a retail betting screen. The journey keeps the owner wallet, the user-owned VILLA account, and the future automation permission visible.

## Core journey

| LP moment | Product response | System truth |
| --- | --- | --- |
| Understand | The public explainer describes VILLA in plain language and links to the LP workspace and verified replay. | No wallet or capital request occurs on `/`. |
| Connect | The visitor connects a normal EIP-1193 wallet. | The browser receives an address only. No private key is requested or handled. |
| Choose network | The product checks chain ID 50312 and offers the standard wallet switch or add-network request. | Actions remain paused until Somnia Shannon is confirmed. |
| Find account | VILLA checks a local hint, the Shannon Explorer ownership-event index, and a provider log fallback. | Every candidate is rechecked by exact runtime code, owner, immutable wiring, and chain. Index data is never authorization. |
| Create account | If no verified account exists, the wallet deploys the audited `VillaAccount` bytecode with the connected owner and operator set to zero. | The UI reports success only after receipt, address, bytecode, owner, operator, and wiring verification. |
| Add liquidity | The owner enters an exact six-decimal tUSDC amount. The wallet approves that account for that amount if needed, then deposits into the account. | Post-transaction wallet and account deltas must reconcile exactly. |
| Authorize | The owner can set the trusted VILLA operator or revoke it. | The product refuses to overwrite an unexpected operator and rereads the operator after each transaction. |
| Review capital | My Liquidity shows wallet balance, allocated, available, and withdrawable capital. | Deployed and pending settlement remain zero while execution is disconnected. No PnL, APR, yield, or profit claim is shown. |
| Start | The workspace explains readiness and keeps Start VILLA disabled. | Phase 2 does not connect the execution engine or place DreamDEX orders. |
| Withdraw | The owner enters an amount and withdraws to the connected owner wallet. | There is no destination field. Owner, code, exact decrease, and exact wallet increase are verified. |
| Reconnect | Refresh, reload, and a new session rediscover the account from verified on-chain evidence. | Deleting local storage does not destroy account identity. |

## Browser states

### Disconnected

The app offers Connect wallet, identifies Somnia Shannon Testnet, and says that VILLA never asks for a private key. It does not show a capital form before a wallet is connected.

### Connected, wrong network

The app shows the connected address and a Switch network action. Account history and capital actions remain paused until chain ID 50312 is read from the wallet.

### Connected, account lookup in progress

The app shows a compact loading state while it reads the verified account artifact, indexed ownership history, and chain state.

### Connected, no verified account

The app offers Create VILLA account. The copy explains that the connected wallet remains owner and that automation starts unauthorized.

### Account ready for setup

The app shows exact tUSDC funding, authorization, and owner-only withdrawal actions. Every write uses the wallet and shows WAITING_FOR_WALLET, SUBMITTED, CONFIRMING, SUCCESS, or FAILED.

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
