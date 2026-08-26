# VILLA

Autonomous liquidity manager for DreamDEX Event Contracts.

Operator-facing. Not a prediction market. Not a retail Up/Down app. Ordinary traders meet VILLA only as orders on DreamDEX.

This repository is in **Phase 5A**. The independent `villa-fv-v1` fair-value
engine, deterministic `villa-risk-v1` governor, pure `villa-quote-v1` planner,
complete-set inventory lifecycle, and bounded end-to-end quote execution
verifier are present, along with a bounded settlement/redeem lifecycle
verifier. There is no product UI, successor rollover, or continuous quoting
loop yet.

## Repo

`C:\Users\HomePC\Desktop\villa`

## Status

Shannon reads work. **Wet lifecycle verification passed** for one minimum
complete set: mint, post-only `SELL_YES` rest, exact cancel, and `burnSet` on a
live BTC Event Contract (see `docs/INVENTORY_LIFECYCLE.md`). It does not prove
fills or settlement redemption.

```bash
npm install
npm test
npm run doctor
npm run fair-value
npm run risk
npm run quote
npm run verify:write:dry
npm run verify:inventory:dry
npm run verify:quote-cycle:dry
npm run verify:settlement:dry
npm run verify:quote-cycle -- --confirm
npm run verify:settlement
```

`verify:write` sends one tiny post-only BUY and cancels it. It needs `OPERATOR_PRIVATE_KEY` in gitignored `.env`, STT for gas, and tUSDC (`npm run fund:tusdc` after STT arrives).

`verify:inventory` sends one bounded mint / post-only `SELL_YES` / exact cancel /
`burnSet` sequence. Use the dry run first; it does not create a quote loop or
exercise settlement.

`verify:quote-cycle:dry` exercises live acquisition and the full model → risk →
quote → execution preflight without a signer. The wet command requires the
explicit `--confirm` flag and is limited to one BTC market, one minimum lot,
two post-only orders, exact cancellation, and temporary complete-set cleanup.

`verify:settlement:dry` scans recent Finalized BTC markets for claimable
outcome balances and reads one current short BTC market without writes. The
wet settlement command requires explicit confirmation and is limited to one
minimum complete-set mint, expiry/resolution observation, explicit SDK
redemption, and exact payout reconciliation. It never uses the order book or
places/cancels orders. A pending session can be resumed from its gitignored
`runtime/state/settlement-session-*.json` record.

## Docs

| File | Role |
| --- | --- |
| `docs/HACKATHON.md` | Rules, judging, build requirements |
| `docs/PROJECT_UNDERSTANDING.md` | What VILLA is |
| `docs/TECHNICAL_VERIFICATION.md` | Capability matrix |
| `docs/ARCHITECTURE_NOTES.md` | Layers from verified APIs |
| `docs/DECISIONS.md` | Choices and why |
| `docs/SOURCES.md` | Claim → URL/file |
| `docs/BUILD_PLAN.md` | MVP, stretch, order of work |
| `docs/INVENTORY_LIFECYCLE.md` | Complete-set mint, SELL escrow, exact cancel, and burn evidence |
| `docs/EXECUTION_ADAPTER.md` | Bounded quote execution, reconciliation, and cleanup boundary |
| `docs/SETTLEMENT_LIFECYCLE.md` | Finalization, explicit redeem, claim sweep, and payout reconciliation |
| `docs/FAIR_VALUE_MODEL.md` | Independent fair-value formula, units, and validation |
| `docs/RISK_GOVERNOR.md` | Deterministic risk states, exposure math, policy, and refusal boundary |
| `docs/INCOMING-BRIEF.md` | Directing-agent spec as received |

## Secrets

Disposable testnet wallet only. `.env` is gitignored. `.env.example` has names, not values.

`npm run risk` is read-only. It prints the governor state and a comparison-only
DreamDEX midpoint; it does not cancel orders or send any transaction.
