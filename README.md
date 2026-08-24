# VILLA

Autonomous liquidity manager for DreamDEX Event Contracts.

Operator-facing. Not a prediction market. Not a retail Up/Down app. Ordinary traders meet VILLA only as orders on DreamDEX.

This repository is in **onboarding / verification**. There is no product UI and no quoting loop yet.

## Repo

`C:\Users\HomePC\Desktop\villa`

## Status

Shannon reads work. Writes are not proven in this repo. See `docs/TECHNICAL_VERIFICATION.md`.

```bash
npm install
npm run doctor
node scripts/discover.mjs
```

Both scripts are read-only.

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
