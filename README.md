# VILLA

Autonomous liquidity manager for DreamDEX Event Contracts.

Operator-facing. Not a prediction market. Not a retail Up/Down app. Ordinary traders meet VILLA only as orders on DreamDEX.

This repository is in **Phase 4A**. The independent `villa-fv-v1` fair-value
engine, deterministic `villa-risk-v1` governor, pure `villa-quote-v1` planner,
and bounded complete-set SELL lifecycle verifier are present. There is no
product UI or continuous quoting loop yet.

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
npm run verify:write
```

`verify:write` sends one tiny post-only BUY and cancels it. It needs `OPERATOR_PRIVATE_KEY` in gitignored `.env`, STT for gas, and tUSDC (`npm run fund:tusdc` after STT arrives).

`verify:inventory` sends one bounded mint / post-only `SELL_YES` / exact cancel /
`burnSet` sequence. Use the dry run first; it does not create a quote loop or
exercise settlement.

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
| `docs/FAIR_VALUE_MODEL.md` | Independent fair-value formula, units, and validation |
| `docs/RISK_GOVERNOR.md` | Deterministic risk states, exposure math, policy, and refusal boundary |
| `docs/INCOMING-BRIEF.md` | Directing-agent spec as received |

## Secrets

Disposable testnet wallet only. `.env` is gitignored. `.env.example` has names, not values.

`npm run risk` is read-only. It prints the governor state and a comparison-only
DreamDEX midpoint; it does not cancel orders or send any transaction.
