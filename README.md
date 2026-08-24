# VILLA

Autonomous liquidity manager for DreamDEX Event Contracts.

Operator-facing. Not a prediction market. Not a retail Up/Down app. Ordinary traders meet VILLA only as orders on DreamDEX.

This repository is in **onboarding / verification**. There is no product UI and no quoting loop yet.

## Repo

`C:\Users\HomePC\Desktop\villa`

## Status

Shannon reads work. **Wet write-path passed** for one tiny post-only BUY rest+cancel on a live BTC Event Contract (see `docs/TECHNICAL_VERIFICATION.md`). That does not yet prove SELL, fills, or settlement.

```bash
npm install
npm test
npm run doctor
npm run verify:write:dry
npm run verify:write
```

`verify:write` sends one tiny post-only BUY and cancels it. It needs `OPERATOR_PRIVATE_KEY` in gitignored `.env`, STT for gas, and tUSDC (`npm run fund:tusdc` after STT arrives).

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
| `docs/INCOMING-BRIEF.md` | Directing-agent spec as received |

## Secrets

Disposable testnet wallet only. `.env` is gitignored. `.env.example` has names, not values.
