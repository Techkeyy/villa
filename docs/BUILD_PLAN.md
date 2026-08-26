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
4. **DONE:** Phase 4A complete-set inventory + SELL-path verification: one
   minimum mint, one resting/cancelled post-only SELL_YES, exact pair burn, and
   final zero-state re-read. The future writer must consume observed escrow
   semantics and remain separate from the pure planner.
5. **DONE:** Phase 4B bounded quote execution: one explicit session, one-lot
   inventory provision, fresh model/risk/quote passes, post-only ASK then BID,
   exact on-chain/indexer reconciliation, exact cancellation, safe pair burn,
   and final clean-state scan. It is not a continuous loop.
6. **DONE:** Phase 5A bounded finalization + settlement redeem: one
   complete-set session, chain-authoritative resolution/void handling,
   explicit SDK redeem, finalized rediscovery, claim sweep dry path,
   restartable state, and exact payout/gas reconciliation. No rollover.
7. **DONE:** Phase 5B bounded successor-market rediscovery and rollover:
   chain-time A stop, same-series B verification, explicit scope reset, fresh
   B fair-value/risk/quote context, residual registry, and zero-write live
   proof. It is not a continuous loop and does not execute B quotes.
8. **DONE:** Phase 6A bounded autonomous orchestration:
   exact BTC 5m series, repeated fair-value/risk/quote cycles, capped
   post-only writes through one queue, reconciliation, expiry cleanup,
   settlement overlap, and verified same-series successor continuation.
   Final dry and wet proofs passed on 2026-08-26; see
   `docs/TECHNICAL_VERIFICATION.md`.
8A. **DONE:** Phase 6A.1 organic-fill settlement recovery: exact A/B claim
cases, market-specific payout planning, serialized redeems, collateral/gas
reconciliation, known-loser skip, residual registry, and duplicate-prevention
recheck. No new orders or mints.
9. Operator dashboard (design-skill) wired to real engine state, four states on every async action.
10. Demo path + optional disclosed taker.
11. perfect-readme, Audit-skill, project-edge, submit.

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
- Treating one bounded quote cycle as permission to start an always-on writer
- Treating `burnSet` as settlement redemption or treating one rollover as permission for continuous execution
- Treating the Phase 6A bounded runner as an always-on daemon; the next milestone must be explicitly approved

## Phase 5A settlement boundary

The settlement milestone stops at:

`mint complete set → hold → observe terminal chain state → redeem → reconcile → stop`.

It does not resolve/void, fill, quote, cancel, claim an unrelated market,
start a second wallet, or enter a successor window. The operator-facing claim
sweep is read-only and uses the SDK/indexer `Finalized` historical path.

## Phase 6A.2 final wallet hygiene and backend freeze

8B. **DONE:** Full wallet outcome audit, exact `a3cf` claim recovery,
zero-value residual classification, unknown-inventory fail-closed checks,
dashboard data-contract definition, and backend-freeze manifest. No new order,
mint, autonomous run, strategy change, or frontend work was introduced.

## Phase 6B operator cockpit

Phase 6B adds the single-page read-only cockpit in `dashboard/`, a server-side
live adapter in `scripts/dashboard-server.mjs`, the pure presenter in
`src/dashboard/presenter.mjs`, and labelled recorded scenes in
`src/dashboard/replay.mjs`. The backend trading layers remain feature-frozen.
The next decision after this phase is whether the UI and demo surface are
approved before any submission README or recording work begins.

## Phase 5B rollover boundary

The successor milestone stops at:

observe A terminal -> close A scope -> rediscover and verify later same-series
B -> initialize B -> reference -> fair value -> governor -> quote plan -> stop.

It does not place/cancel orders, mint/burn outcome sets, claim settlement
value, parse questions, derive a successor from a pool, or run continuously.
