# VILLA LP User Journey

Status: Phase 0 product journey lock

## Core journey

| LP moment | LP goal | Product response | System truth |
| --- | --- | --- | --- |
| Discover | Understand whether VILLA is for them | Public explainer says VILLA is for DreamDEX liquidity providers and explains the workflow in plain language. | No wallet or capital request on the landing page. |
| Connect | Bring a compatible wallet into the product | Wallet connection is the first app action. | Connection is informational in this phase. No private key is requested. |
| Review capital | Decide how much capital to allocate | My Liquidity shows wallet balance context, allocated capital, and the amount-to-use field. | Add Liquidity stays gated while the per-user account boundary is unbuilt. |
| Authorize | Understand what VILLA may do | Permission language is owner-first and narrowly scoped. | No authorization transaction is presented until the capability is proven. |
| Start | Begin market-making | The future action is labelled Start VILLA. | The preview control remains disabled in this phase. |
| Monitor | See fair value, market comparison, risk, capital, orders, activity, and settlement | A compact running view prioritizes state, market, risk, and valid actions. | No invented live values are shown as real. |
| Stop | Retain control of the strategy | Pause, resume, and stop are state-dependent. | Safe-mode preview has no capital-side effect. |
| Settle | Understand when capital is available | Settlement explains pending, settled, and withdrawable states. | Unsettled capital is not described as immediately withdrawable. |
| Withdraw | Return capital to the LP | Withdrawal appears only when the real path is implemented and proven. | The current UI does not imply that a disabled withdrawal succeeded. |
| Verify | Inspect evidence without operational clutter | Proof and replay live on `/proof`. | Replay is explicitly labelled as evidence, not current LP activity. |

## State model

### Disconnected

The app says: “Become a DreamDEX liquidity provider.” It offers Connect wallet and identifies Shannon Testnet. It does not render a dense dashboard before the first action.

### Connected, no allocation

The app introduces My Liquidity with wallet balance context, allocated-to-VILLA status, an amount-to-use field, and a disabled Add liquidity action with a truthful development message.

### Ready preview

The app can show the intended shape of My VILLA: BTC 5 minute market, VILLA fair value, DreamDEX comparison, risk state, and Start VILLA. Preview values are clearly marked unavailable or preview-only until a real capital path exists.

### Running, paused, halted, stopped

- Running: show Pause and Stop.
- Paused: show Resume and Stop.
- Halted: show the reason and Stop.
- Stopped: show settlement state, deployed and available balances when real, plus future Add liquidity and Withdraw actions.

The app must never expose an action that is invalid for the current state.

## Language rules

Use liquidity provider, capital, allocation, strategy, risk, orders, activity, settlement, and withdrawal. Keep operator key, private engine, raw market identifiers, and execution internals under Advanced or out of the primary journey. Do not call the main application surface an operator cockpit.

