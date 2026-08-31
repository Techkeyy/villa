# Project understanding — VILLA

Skill: `Desktop/skill/project-understanding`. Product locked by the directing agent. Current status is Phase 0 LP product pivot; the backend and proven VILLA engine remain feature frozen while the public, LP, and proof surfaces are rebuilt. Phase 2A selected `villa-fv-v1`: a zero-drift log-return digital baseline with a separate data-quality score. Later implementation evidence is recorded in `docs/TECHNICAL_VERIFICATION.md` and the phase-specific lifecycle docs. Open multi-LP capital automation is gated by `PER_USER_VILLA_ACCOUNT_REQUIRED`.

## One sentence

**VILLA** helps **a liquidity provider** **understand and eventually put their own capital to work on DreamDEX Event Contract books** by **forming its own view of value, quoting inside risk limits, and recycling capital through settlement**.

## The problem, as a story

Tobi has stablecoins and does not want to guess whether Bitcoin ticks up in the next fifteen minutes. He is willing to be the person who *offers* both tickets, within a loss limit he can live with.

Dami wants to tap Up or Down on DreamDEX. Some windows have a book. Many do not. When the book exists, it may be a couple of resting quotes around nothing in particular.

The official maker bot can rest two-sided post-only orders. In source, its "fair" price is the **book midpoint, or 0.5 if the book is empty**. That is circular: the bot that is supposed to *create* the book prices off the book. On a quiet window that is pricing noise. On a window with a real book it is still not a view of Bitcoin.

Tobi cannot babysit every window. Windows die. Winnings do not arrive by themselves. Inventory leans when one side fills. He needs software that does the desk job and **shows him why**.

## Before / after

```
BEFORE  Capital sits idle, or Tobi bets, or he runs ec-maker quoting the mid.
AFTER   Tobi connects a wallet, reviews the capital boundary, and eventually
        watches independent value, quotes, inventory, and named stops. Other
        traders only see DreamDEX.
```

If the after is indistinguishable from `npm start -w ec-maker`, we failed originality.

## Actors

| Actor | User-facing? |
| --- | --- |
| Liquidity provider (Tobi) | Yes — direct product user |
| DreamDEX traders | No — they hit the book |
| Fair-value engine | Yes, as a number + inputs |
| Adaptive quoting | Yes, as bids/asks |
| Risk governor | Yes, as tripwires |
| DreamDEX CLOB + settlement | Indirectly |
| Price feed / opening price | As inputs |

## Operator journey

Arrival → understand the product → connect a wallet → review owner-scoped capital allocation → authorize only a proven permission path → start VILLA → see value vs market → monitor quotes and named stops → window ends → settle → withdraw. The Phase 0 UI makes the first steps clear and keeps capital actions gated until the account boundary is proven.

Magic moment: **the underlying ticks, fair value moves, quotes move, one English line explains it, and a halt is visible when rules say no.**

## Boxes

| Job | Likely tech (second) |
| --- | --- |
| Dashboard | Public explainer, LP workspace, and read-only proof route |
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

Historical proof custody: **operator EOA**. Open LP custody requires a per-user account boundary; holding other people's money through a shared operator wallet is not accepted.

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

## Phase 3A handoff: the account is the portfolio

The Phase 3A product change is an ownership boundary, not a new strategy. A
liquidity provider owns one `VillaAccount`; the VILLA operator signs calls to
that account; DreamDEX therefore sees the account as the trader. The signer is
not the LP balance, the LP order owner, or the settlement position.

The core loop remains:

```text
read one VillaAccount -> check readiness -> reuse fair value/risk/quotes -> build scoped calls -> show a shadow plan
```

The Phase 3A magic moment is still the account-specific explanation of what
VILLA would do and why it is allowed. It is not a transaction confirmation.
The load-bearing assumption for this phase is that every collateral,
inventory, order, exposure, settlement, and successor read can be carried by
one explicit VillaAccount address while the operator remains only the scoped
caller. The adapter tests, the real zero-capital Phase 2 account read, and the
shadow-mode no-broadcast gate verify that assumption.

## Phase 3B0 safety handoff

Before a wet session can exist, the loop becomes:

```text
acquire one account lease -> read chain/venue truth -> preflight -> derive one intent -> policy validate -> serialize -> reconcile
```

The risky assumption is now narrower: an operator signer can be kept as a
caller identity while every portfolio effect remains scoped to one
`VillaAccount`, including after a timeout, crash, restart, or STOP. The
account-scoped lease, deterministic intent policy, nonce-aware writer, and
authoritative reconciliation tests exercise that assumption without arming a
signer or sending a transaction.
