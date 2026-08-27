# Project understanding — VILLA

Skill: `Desktop/skill/project-understanding`. Product locked by the directing agent. Current status is Phase 7A final pre-submission audit; the backend and Phase 6B.1 read-only cockpit are feature frozen. Phase 2A selected `villa-fv-v1`: a zero-drift log-return digital baseline with a separate data-quality score. Later implementation evidence is recorded in `docs/TECHNICAL_VERIFICATION.md` and the phase-specific lifecycle docs.

## One sentence

**VILLA** helps **a liquidity provider / operator** **put capital to work on DreamDEX Event Contract books** by **forming its own view of value, quoting both sides inside risk limits, and recycling capital through settlement**.

## The problem, as a story

Tobi has stablecoins and does not want to guess whether Bitcoin ticks up in the next fifteen minutes. He is willing to be the person who *offers* both tickets, within a loss limit he can live with.

Dami wants to tap Up or Down on DreamDEX. Some windows have a book. Many do not. When the book exists, it may be a couple of resting quotes around nothing in particular.

The official maker bot can rest two-sided post-only orders. In source, its "fair" price is the **book midpoint, or 0.5 if the book is empty**. That is circular: the bot that is supposed to *create* the book prices off the book. On a quiet window that is pricing noise. On a window with a real book it is still not a view of Bitcoin.

Tobi cannot babysit every window. Windows die. Winnings do not arrive by themselves. Inventory leans when one side fills. He needs software that does the desk job and **shows him why**.

## Before / after

```
BEFORE  Capital sits idle, or Tobi bets, or he runs ec-maker quoting the mid.
AFTER   Tobi funds VILLA, sets limits, and watches an independent value, live
        quotes, inventory, and named stops. Other traders only see DreamDEX.
```

If the after is indistinguishable from `npm start -w ec-maker`, we failed originality.

## Actors

| Actor | User-facing? |
| --- | --- |
| Operator (Tobi) | Yes — only direct user |
| DreamDEX traders | No — they hit the book |
| Fair-value engine | Yes, as a number + inputs |
| Adaptive quoting | Yes, as bids/asks |
| Risk governor | Yes, as tripwires |
| DreamDEX CLOB + settlement | Indirectly |
| Price feed / opening price | As inputs |

## Operator journey

Arrival → see a desk not a casino → configure/fund outside the observational cockpit → VILLA discovers a live window → shows value vs market → posts quotes or refuses with a reason → fills move inventory and quotes → halt if a rule fires → window ends → claim → next window. The frozen Phase 6B screen observes this journey; it does not accept signer input or perform writes.

Magic moment: **the underlying ticks, fair value moves, quotes move, one English line explains it, and a halt is visible when rules say no.**

## Boxes

| Job | Likely tech (second) |
| --- | --- |
| Dashboard | Phase 6B.1 read-only operator cockpit |
| Collector | markets-sdk + priceFeed + RPC |
| Fair value | deterministic TypeScript `villa-fv-v1` zero-drift log-return digital model |
| Adaptive quoting | post-only via SDK/raw trader |
| Governor | deterministic rules |
| Claim / roll | `listBinaryMarkets(Finalized)` + `redeem` + rediscover |
| Memory | off-chain: limits, marketIds, reasons |

## Necessity test

- **Load-bearing:** Event Contracts, markets-sdk, Shannon, independent inputs, governor, operator UI for the hackathon.
- **Important:** auto-claim loop, successor poll, bigint tick placement.
- **Not MVP:** reactivity contract roller, spot session keys, LLM, Bot Builder, HTTP API, pooled vault.

## Trust

Operator trusts our off-chain process and DreamDEX settlement. Not "trustless." Two-sided quoting is not risk-free (adverse selection). If our process dies, orders should age off via mandatory expiry.

Default custody: **operator EOA**. Holding other people's money is a different product.

## Load-bearing assumption

On Shannon, sdk 0.28.1, one disposable wallet can discover a live binary, read spot + reference, rest a post-only quote, see inventory change, redeem a finalized market, and find the next window.

Discovery/read, bounded write/redeem, inventory, settlement, successor, and autonomous-loop paths are **verified with the conditions recorded in the current evidence docs**. This does not claim a production daemon, profitability, or unrestricted unattended operation.

## Smallest real MVP

One asset, one cadence, operator screen, independent value (even a simple documented digital using spot vs reference + τ + vol), two-sided post-only, inventory skew, governor halt on stale price / not tradable / expiry too close / inventory cap / drawdown cap, claim scan, successor rediscovery.

Must not drop the magic moment.

## Non-goals

Not a venue. Not a retail betting app. Not a Telegram bot. Not an LLM coin-flip. Not mainnet. Not copying House's retail slogan. Not pretending session keys work on Event Contracts.

## Three explanations

**Child:** People bet if Bitcoin will go up for a little while. VILLA is the stall that sells both tickets carefully.

**Adult:** DreamDEX already runs short Up/Down markets. Those markets need prices. VILLA is software for the person providing those prices. It uses Bitcoin itself, not just the last bet, and it stops when the operator's safety rules fire.

**Developer:** Off-chain deterministic engine + operator UI. Writes via `@somnia-chain/markets-sdk` 0.28.1 to Shannon binary pools. Differentiation is valuation, inventory policy, and a hard governor — not the existence of `createOrder`.
