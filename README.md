# VILLA

Independent liquidity intelligence for DreamDEX Event Contracts.

VILLA is an operator-facing liquidity engine for Somnia Shannon Event
Contracts. It forms its own fair value, applies deterministic risk rules,
plans adaptive post-only quotes, reconciles inventory and fills, recovers
settled value, and follows the next market window.

VILLA is for the liquidity provider, not the retail bettor. DreamDEX remains
the venue. Ordinary traders meet VILLA only as liquidity on the DreamDEX book.

**Public product overview:** [villa-ten-ashen.vercel.app](https://villa-ten-ashen.vercel.app/)
— the default first page explains VILLA in plain language and leads into the
read-only replay and operator surfaces. The local replay command is
`npm run dashboard:replay`.

**Legacy replay service:** [villa-yhzx.onrender.com](https://villa-yhzx.onrender.com)
remains available as a replay-only fallback; it is not the primary VILLA UI.

**Public repository:** [github.com/Techkeyy/villa](https://github.com/Techkeyy/villa)

**Demo video:** to be recorded by the operator after the rehearsal below.

**Network:** Somnia Shannon testnet, chain ID 50312.

[Hackathon](https://dorahacks.io/hackathon/event-contracts/detail) | [DreamDEX Event Contracts docs](https://docs.dreamdex.io/developers/event-contracts) | [DreamDEX bot kit](https://github.com/somnia-chain/dreamdex-bot-kit) | [License](LICENSE)

## The problem

Event Contract books need liquidity. A basic maker can place orders, but a
useful autonomous liquidity desk must answer more than "what is the last
midpoint?":

- What is the contract actually worth?
- How should inventory change the quote?
- When should quoting stop?
- What happens when an order fills?
- How does capital get claimed after settlement?
- Which market should receive the next bounded allocation?

The stock DreamDEX maker plumbing is valuable, but its fair price can be the
book midpoint, or `0.5` when the book is empty. That is useful execution
plumbing, not an independent view of the underlying market.

## What VILLA does

VILLA turns verified BTC and Event Contract data into a bounded operator
decision:

```text
BTC price feed + Event Contract reference
              |
              v
        villa-fv-v1
              |
              v
        villa-risk-v1
              |
              v
        villa-quote-v1
              |
              v
     bounded execution adapter
              |
              v
        DreamDEX binary CLOB

inventory -> fills -> settlement -> claim -> successor rollover

                 villa-dashboard-v1
                         |
                         v
                 operator cockpit
```

The fair-value core answers "what do we think UP is worth?" The Risk Governor
answers "are we allowed to take more risk?" Those are separate boundaries.
The cockpit is read-only and observational.

## Why DreamDEX Event Contracts

DreamDEX supplies binary UP/DOWN markets with fixed expiry and on-chain
settlement. That creates a real liquidity-operator problem: quotes must be
independent, inventory-aware, time-aware, post-only safe, and able to survive
the full capital lifecycle. VILLA uses the official
`@somnia-chain/markets-sdk` Event Contract surface on Shannon, not the
spot-only HTTP path.

## Why VILLA is different from `ec-maker`

VILLA builds above the official bot kit rather than replacing it or wrapping it
with a dashboard. The differentiating layer is:

| Capability | VILLA contribution |
| --- | --- |
| Value | `villa-fv-v1` derives UP probability from underlying price, reference, time, and realized log-return volatility. The DreamDEX midpoint is comparison only. |
| Quality | Freshness, history coverage, spacing, stability, and extrapolation produce a separate data-quality assessment. Broken inputs refuse closed. |
| Risk | `villa-risk-v1` produces deterministic `ALLOW`, `REDUCE_ONLY`, or `HALT` decisions with named reasons. |
| Exposure | Worst-case stress includes every signed pending binary order delta. Opposing orders are not netted optimistically. |
| Quotes | `villa-quote-v1` adapts spread, inventory skew, size, collateral, expiry, confidence, and exact tick/lot/minimum rules. |
| Lifecycle | Bounded execution, fill reconciliation, complete-set inventory, explicit redemption, wallet hygiene, and same-series successor rollover. |
| UX | A single cockpit explains fair value, venue comparison, quote posture, risk, inventory, lifecycle, evidence, and `PNL_UNAVAILABLE`. |

## Verified on Shannon

These are bounded testnet proofs, not claims of profitability or production
readiness.

| Evidence | Result |
| --- | --- |
| Live Event Contract write path | A tiny post-only `BUY_YES` rested on chain and was cancelled exactly. |
| Complete-set inventory | Minimum mint, post-only `SELL_YES` rest, exact cancel, and `burnSet` passed with a clean final state. |
| Two-sided liquidity | A bounded quote checkpoint rested and reconciled both post-only sides. |
| Organic fills | Two genuine external `SELL_YES` fills were recovered under their exact market IDs. |
| Settlement | Winning residuals were redeemed through the SDK and payout amounts reconciled. Known zero-value losing residuals remained labelled, not hidden. |
| Rollover | A terminal BTC window was closed and a later same-series successor was rediscovered without mixing market scope. |
| Wallet hygiene | Final audit ended with zero active orders and zero unknown inventory. |
| Local audit | 404/404 total tests and 30/30 dashboard tests passed in the Phase 7A audit. |

Detailed evidence, hashes, conditions, and limitations are in
[`docs/TECHNICAL_VERIFICATION.md`](docs/TECHNICAL_VERIFICATION.md),
[`docs/FINAL_AUDIT.md`](docs/FINAL_AUDIT.md), and
[`docs/BACKEND_FREEZE.md`](docs/BACKEND_FREEZE.md).

## Run the replay cockpit

Requires Node.js 20 or newer.

```bash
npm install
npm run dashboard:replay
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). The default route is the
public product explainer. Enter the operator console from its primary CTA, or
use the replay action to inspect the three labelled evidence scenes:

- Quote proof: recorded two-sided post-only liquidity.
- Rollover proof: terminal market, successor discovery, and an honest `NO QUOTE`.
- Settlement proof: organic fills, redemptions, payout reconciliation, and wallet hygiene.

Replay is built from verified facts and does not send transactions. It does not
pretend that recorded events are happening live.

## Read-only live mode

To run the server-side Shannon adapter locally, provide the required names in a
gitignored `.env` and run:

```bash
npm run dashboard:live
```

The browser receives no environment variables, signer, private key, or writer
queue. If the live adapter cannot read a safe snapshot, the UI shows a `LIVE`
and `READ ONLY` error and does not silently fall back to replay.

Other read-only commands:

```bash
npm run doctor
npm run fair-value
npm run risk
npm run quote
```

`npm start` is the hosted replay command. The deployment configuration uses
only `HOST=0.0.0.0`; it must never receive `OPERATOR_PRIVATE_KEY` or any other
signing material. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Verify the project

```bash
npm test
npm run dashboard:test
npm run dashboard:build
```

The audited baseline is 404 passing tests, including 30 dashboard tests. The
production dependency audit reported zero vulnerabilities. The dashboard build
checks the static assets, favicon, replay markers, and unavailable-PnL marker.

Write-capable scripts exist only for bounded local testnet verification and
require explicit confirmation where applicable. Do not run them casually or
on a wallet that holds real value:

```bash
npm run verify:write:dry
npm run verify:inventory:dry
npm run verify:quote-cycle:dry
npm run verify:settlement:dry
npm run verify:rollover
npm run villa:bounded:dry
```

Wet write, mint, fill, redeem, and autonomous-run verification is not part of
normal dashboard use. No new transaction is required for the replay cockpit.

## Honest limitations

- This is a bounded Somnia Shannon testnet proof, not an indefinite production daemon.
- Complete realized maker PnL and all cash-flow components are unavailable; the UI says `PNL_UNAVAILABLE`.
- Restart recovery is bounded and explicit.
- Event Contract session-key/operator authorization is not verified for VILLA's MVP.
- Organic fills are market-dependent and are not manufactured for a demo.
- The zero-drift fair-value baseline is a correctness-first model, not a claim of predictive edge.
- Hosted mode is explainer-first, read-only, and signer-free. Live read-only mode may be unavailable when public RPC/indexer access is not safe or reliable.

## How I tried to break it

| Adversarial case | Behavior |
| --- | --- |
| Missing, invalid, stale, future, or non-monotonic price | Refuses or halts with a structured reason; never returns neutral `0.5` as an error sentinel. |
| Missing, zero, ambiguous, or unsupported reference scaling | Refuses closed. Explicit strike and opening-price fallback are resolved separately. |
| Gapped or insufficient volatility history | Refuses fair value or lowers data quality according to the documented boundary. |
| Expired or non-Trading market | Refuses new risk and distinguishes terminal lifecycle state. |
| Large inventory or pending orders | Stresses signed order deltas and enters `REDUCE_ONLY` or `HALT` as configured. |
| Post-only crossing or venue minimum failure | Clips or refuses the affected side; it does not cross the book. |
| Indexer and chain disagreement | Reconciles with chain authority and fails closed on unknown state. |
| Missing PnL accounting | Exposes `PNL_UNAVAILABLE`; no zero-profit fiction is created. |
| Live dashboard failure | Shows an explicit live read error; it does not substitute replay content. |

## Architecture and trust boundary

| Layer | Job |
| --- | --- |
| SDK and read adapters | Discover `marketId`, on-chain status, reference, price feed, book, balances, and chain time. |
| Fair value | Pure `villa-fv-v1` calculation with no RPC, wallet, book, or environment dependency. |
| Governor | Pure `villa-risk-v1` safety policy with exposure and pending-order stress. |
| Quote planner | Pure `villa-quote-v1` value-centred adaptive quote planning. |
| Execution | Bounded, serialized, post-only write adapter with reconciliation and cleanup. |
| Lifecycle | Inventory, settlement, claim recovery, wallet hygiene, and successor scope. |
| Dashboard | Read-only server adapter, replay envelope, pure presenter, and browser cockpit. |

The operator EOA is the current custody boundary for local testnet proofs. The
The public experience is not a wallet and cannot write to DreamDEX. Operator
controls are a separate surface and remain behind the wallet ownership gate.

## Hackathon fit

| DoraHacks criterion | VILLA evidence |
| --- | --- |
| Technical Implementation, 25% | Real DreamDEX Event Contract SDK integration on Shannon, verified post-only writes, inventory, settlement, and reconciliation. |
| Innovation and Originality, 20% | Independent underlying-based value, deterministic governor, pending exposure, lifecycle recycling, and operator workflow above `ec-maker`. |
| User Experience and Design, 20% | Readable one-page cockpit with replay/live honesty, named risk reasons, quote comparison, lifecycle evidence, and responsive UI. |
| Business and Ecosystem Impact, 20% | Software for the liquidity operator that can help keep Event Contract books usable for ordinary DreamDEX traders. |
| Presentation and Demo, 15% | Stable replay of real quote, fill, rollover, and settlement evidence, with a prepared 2 to 3 minute script. |

The current DoraHacks page displays a deadline of 2026/09/08 19:00 in the
Africa/Lagos browser session but does not state a timezone. This is recorded as
`TIMEZONE_NOT_EXPLICIT`; UTC is not guessed. See [`docs/HACKATHON.md`](docs/HACKATHON.md).

## SDK and documentation feedback

The useful feedback from implementation is constructive:

- current SDK and older bot-kit examples can differ;
- live venue IDs move, so discovery should provide the active value;
- recycled pools require `marketId` identity;
- `strike = 0` requires a documented opening-price path;
- chain time matters for expiry, freshness, and local clock offsets;
- finalized losing token residuals need explicit classification;
- exact tick, lot, and minimum helpers would reduce repeated integration errors.

## Demo and submission preparation

- Demo rehearsal: [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md)
- Submission copy: [`docs/SUBMISSION.md`](docs/SUBMISSION.md)
- Deployment/security boundary: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)
- Skills checkpoint: [`docs/SKILLS_COMPLIANCE.md`](docs/SKILLS_COMPLIANCE.md)

The public repository and deployed replay demo are published for inspection.
The final video is not recorded or uploaded automatically, and DoraHacks
submission is not performed by this repository workflow.

## Project records

- [`docs/PROJECT_UNDERSTANDING.md`](docs/PROJECT_UNDERSTANDING.md)
- [`docs/ARCHITECTURE_NOTES.md`](docs/ARCHITECTURE_NOTES.md)
- [`docs/DECISIONS.md`](docs/DECISIONS.md)
- [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md)
- [`docs/FAIR_VALUE_MODEL.md`](docs/FAIR_VALUE_MODEL.md)
- [`docs/RISK_GOVERNOR.md`](docs/RISK_GOVERNOR.md)
- [`docs/QUOTE_PLANNER.md`](docs/QUOTE_PLANNER.md)
- [`docs/AUTONOMOUS_LOOP.md`](docs/AUTONOMOUS_LOOP.md)
- [`docs/FINAL_AUDIT.md`](docs/FINAL_AUDIT.md)
