# Build plan

Skill: `Desktop/skill/build-process`. Do not start the product until the directing agent says so.

Priority ladder: prove the risky assumption → core loop → operator journey → reproducible → verify integrations → edges → polish.

## Constraints from judging

See `HACKATHON.md`. Technical 25% and originality 20% fail if we wrap `ec-maker`. UX 20% fails if there is no operator path. Ecosystem 20% wants real quotes.

## Proposed MVP (truthful)

One operator, one disposable Shannon wallet, **one series** (recommend BTC 15m *or* BTC 1m for demo-length rolls — pick after the write-path test).

Loop:

1. Operator sets size + halt limits (even a config file is enough until UI).
2. Discover live Trading window on the live venue id.
3. Read spot, reference (strike or opening), τ, a vol estimate.
4. Compute independent pUp (simple documented digital is enough if inputs are real).
5. Governor may refuse.
6. Post-only two-sided quotes; cancel/replace on the cycle.
7. Inventory from ERC-6909; skew or one-side when capped.
8. Scan Finalized, redeem what we hold.
9. On symbol change, reset position state and enter the successor.
10. A single operator view: value, quotes, inventory, last reason, halt state.

## Phase 2A status

Completed in this repository: a pure `villa-fv-v1` fair-value engine, a
read-only collector for the SDK price feed/history and strike/opening reference,
50 deterministic tests, and `npm run fair-value` for a live BTC snapshot. The
engine stops at `data → fair value → validation → explanation`. It has no signer,
order placement, cancellation, inventory, PnL, or governor dependency.

Fixture/offline path: replay a recorded snapshot so the demo survives indexer blips.

## Stretch (after the loop is real)

- ETH + extra cadences
- Reactivity-driven roll
- On-chain hard caps
- `placeBinaryOrderFor` if a live grant path is proven
- Builder-fee tagged routed flow (we are makers; only if we actually route)
- LLM narration of decisions (never decisions)
- Mainnet (decimals landmine)

## Prioritized work (stop after onboarding unless told to continue)

0. **This phase — DONE:** onboarding docs, doctor, live read discovery, kit+SDK inspection.
1. **DONE:** disposable testnet wallet + read-only doctor green + **one wet write test** in a clearly named script: faucet (if needed) → `getMarketOnchain` Trading with headroom → one post-only bid → confirm it rests → cancel → print balances. This proves one BUY rest/cancel only; it does not prove SELL, fills, or settlement.
2A. **DONE:** Pure fair-value unit tests and read-only live snapshot (spot, strike/opening, τ, realized vol; no order book in the model).
2B. **DONE:** deterministic `villa-risk-v1` governor, binary exposure math,
refusal policy, and read-only live risk snapshot. It stops at snapshot → risk
decision → explanation. It does not quote, cancel, or transact.
3. **DONE:** pure `villa-quote-v1` adaptive YES bid/ask planner, exact raw
tick/lot/minimum handling, pending-order projection, and read-only live quote
snapshot. No writer or transaction path is connected.
4. Next: a bounded quote-execution adapter against one live window, only after
explicit order expiry/reconciliation and lifecycle gates are designed.
5. Claim sweep on Finalized holdings (may be zero first day — prove the scan).
6. Successor rediscovery.
7. Operator dashboard (design-skill) wired to real engine state, four states on every async action.
8. Demo path + optional disclosed taker.
9. perfect-readme, Audit-skill, project-edge, submit.

Halfway checkpoint: if the future execution step is not quoting a real book,
cut cadence/asset/UI chrome, not the governor or pure planner boundaries.

## What not to do next

- Frontend, logos, landing page
- Forking `ec-maker`
- Installing global toolchains
- Mainnet
- Inventing session-key custody
- Connecting fair value to order control before the deterministic governor exists
- Treating the Phase 3 quote plan as proof that a SELL, fill, mint, or settlement path has been verified
