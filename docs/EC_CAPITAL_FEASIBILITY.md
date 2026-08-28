# DreamDEX Event Contract Capital Feasibility

Status: Phase 0 research and feasibility lock

## Decision

Chosen architecture: `PER_USER_VILLA_ACCOUNT_REQUIRED`

The existing VILLA engine cannot yet be presented as an open multi-LP service backed by one operator signer. The current official Event Contract documentation and installed `@somnia-chain/markets-sdk` expose owner-scoped or caller-scoped pieces, but do not establish a complete, narrowly scoped, revocable delegation model for the full Event Contract lifecycle.

This is a feasibility conclusion, not an implementation authorization. No capital or deposit implementation is started by this phase.

## Sources and evidence used

- Official Event Contract behavior, fixed-payout outcomes, collateral, and redemption: [DreamDEX Event Contracts](https://app.dreamdex.io/docs/trading/event-contracts).
- Binary market structure, pool recycling, order escrow, and lifecycle statuses: [DreamDEX Market Structure](https://app.dreamdex.io/docs/developers/event-contracts/market-structure).
- Official binary order, mint, burn, and redeem examples: [DreamDEX Event Contract Recipes](https://app.dreamdex.io/docs/developers/event-contracts/recipes).
- Deployed Shannon contract addresses: [DreamDEX Contracts and Addresses](https://app.dreamdex.io/docs/developers/event-contracts/contracts-and-addresses).
- Lifecycle and integration caveats: [DreamDEX Event Contract Gotchas](https://app.dreamdex.io/docs/developers/event-contracts/gotchas).
- Spot-only delegated bot flow: [DreamDEX bot kit skill](https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/skills/dreamdex-bot/SKILL.md).
- Installed package inspected locally: `node_modules/@somnia-chain/markets-sdk` version `0.28.1`, including `src/binary/sets.ts`, `src/binary/settlement.ts`, `src/orders.ts`, `src/tradeAbi.ts`, `src/trade.ts`, `src/spot/operatorGrants.ts`, and `src/config.ts`.

Read-only Shannon checks were also performed against chain ID `50312` using the current future BTC 5-minute market. The check found a live market and binary pool, read the module market record and binary pool parameters, computed the installed ABI selector for `placeBinaryOrderFor`, and simulated delegated calls with dummy addresses. The delegated simulations reverted. No transaction was sent.

## Capability matrix

| Question | Finding | Evidence and boundary |
| --- | --- | --- |
| Can owner A fund owner-scoped capital? | A can fund a normal wallet or pool path, but owner-scoped VILLA allocation was not proven. | Official EC collateral and pool recipes; no per-LP account boundary in the current engine. |
| Can operator B place a binary EC order for A? | Not proven as a safe delegated capability. | The installed binary ABI contains `placeBinaryOrderFor`, but the current SDK facade does not expose it, no EC permission registry was found, and a live read-only simulation with dummy parties reverted. |
| Can operator B cancel A's binary order? | No delegated cancel path was found. | `binaryPoolWriteAbi` exposes `cancelOrder` and `reduceOrder`, but no `cancelOrderFor`; official EC recipes use caller-scoped cancellation. |
| Where is BUY collateral drawn from? | The binary order escrows collateral at placement, with the documented vault-first then wallet behavior. | [Market Structure](https://app.dreamdex.io/docs/developers/event-contracts/market-structure). |
| Where do fills and outcome assets settle? | The pool and settlement module account for the Event Contract position; owner preservation across an operator path was not proven. | Official lifecycle/settlement docs and the installed binary settlement source. |
| Can B withdraw A collateral? | No delegated withdrawal route was found in the EC surface inspected. | No withdrawal-for method or EC operator withdrawal permission was found. This remains a required negative test for any future account design. |
| Can B mint a complete set for A? | No owner/delegate mint method was found. | SDK `mintSet` calls the pool's caller-scoped `mintSet`; no `mintSetFor` is exposed. |
| Can B burn or merge A's pair? | No owner/delegate burn method was found. | SDK `burnSet` calls caller-scoped `burnSet`; no `burnSetFor` is exposed. |
| Can B redeem A's winner? | Yes, a signed owner authorization route exists, but it is not a complete trading delegation model. | SDK `signRedeemAuth` and `redeemFor` call the module relayer route; payout is pinned to the owner. It requires an owner signature and still needs a dedicated end-to-end proof. |
| Can A revoke B immediately? | Spot revocation is documented; EC revocation is not established. | The bot kit and SDK operator grants are explicitly spot-only, with pool and global scopes. No EC registry was found. |
| Are permissions owner/function/pool/venue/global scoped? | The proven registry is spot-only and supports pool/global grant scopes. | `src/spot/operatorGrants.ts` and the official bot kit. This cannot be assumed for BinaryPool or Event Contract lifecycle calls. |
| What happens when BTC 5m rolls to another market? | `marketId` changes to the next market while pools are recycled across windows. | [Market Structure](https://app.dreamdex.io/docs/developers/event-contracts/market-structure) and read-only module/pool inspection. |
| Does operator permission survive or reapply across recycled pools? | Not proven. | No Event Contract permission lifecycle or automatic reapplication was found. A future design must bind authorization to an explicit owner/account and market scope. |
| Can one hot operator safely service multiple owners? | Not with the current shared signer and unproven EC delegation surface. | Multi-owner isolation requires the chosen per-user account boundary and revocation tests before acceptance. |
| Are order, fill, settlement, and redemption ownership preserved as LP, not bot? | Direct owner flows preserve the caller; delegated preservation is incomplete. | `redeemFor` pins payout to the owner, while order, cancel, mint, and burn delegation were not proven. |

## Wet proof status

No wet EC delegation proof was performed. The work completed was official-document research, installed SDK and ABI inspection, live read-only chain inspection, and non-writing call simulation. There was no deposit, no funded delegated order, no cancellation write, no mint, no burn, no redemption write, and no blockchain transaction.

## Required proof before capital implementation

The next capital phase must first produce an isolated disposable Shannon test plan that proves, with owner A and operator B:

1. owner funding and allocation,
2. narrowly scoped order placement,
3. owner-preserving fill and position ownership,
4. delegated cancellation,
5. complete-set behavior if needed by the engine,
6. settlement and owner-only redemption,
7. immediate revocation,
8. no operator withdrawal,
9. market rollover and authorization reapplication,
10. isolation across two independent LP accounts.

If any item fails, capital remains gated and the UI must continue to state that the path is under development.

