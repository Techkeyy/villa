# Incoming brief — VILLA

Captured from the directing agent during onboarding. The brief was still arriving when this file was written. Anything not in this file is **not assumed**.

Last update: 2026-08-24.

## Locked

- **Project name:** VILLA
- **Hackathon:** Somnia × DreamDEX Event Contracts Hackathon
- **Repo location:** `Desktop/villa` (this folder)

## What VILLA is

VILLA is an autonomous liquidity manager for DreamDEX Event Contracts.

It is **not** its own prediction market.

It is **not** primarily another consumer betting/trading frontend.

DreamDEX hosts the Event Contract markets. Ordinary users trade on DreamDEX.

VILLA is operated by someone who wants to deploy capital into those markets.

The operator funds VILLA and sets safety/risk limits.

VILLA then aims to:

- discover appropriate live DreamDEX Event Contract markets
- independently estimate fair probability/value using relevant market data
- place liquidity into DreamDEX order books
- provide buy/sell liquidity
- react when orders fill
- track its inventory/exposure
- adjust its pricing based on its current exposure and market conditions
- reduce or stop activity when predefined risk conditions are reached
- handle market expiry/settlement correctly
- claim eligible settled value
- recycle available capital into successor markets
- expose all important actions and reasoning through a clear operator dashboard

**Direct user:** the liquidity provider / operator.

**Indirect users:** other traders, only because VILLA's orders sit in DreamDEX's order book.

## Important product distinction

Do **not** reduce VILLA to:

> "the DreamDEX ec-maker bot with a dashboard."

DreamDEX already ships substantial Event Contract bot infrastructure (`ec-maker`, `ec-oracle-follow`, `ec-settlement`, and related strategies). VILLA's innovation has to live **above** that plumbing.

## Differentiating layer (as specified so far)

### A. Fair value engine

Instead of simply copying the current order-book midpoint, VILLA should derive its own view of the probability/value of an Event Contract from verified available information such as:

- underlying asset price
- market opening/reference price
- time remaining
- volatility
- other legitimately available/verified inputs

Do **not** assume the exact model yet.

### B. Adaptive quoting

VILLA's quoting behavior should respond to:

- its fair value
- its current inventory
- market volatility
- time remaining
- confidence/uncertainty
- configured risk limits

### C. Risk governor

VILLA should have deterministic safety controls.

Possible examples include:

- stale/unavailable price source
- excessive inventory/exposure
- excessive loss/drawdown
- market no longer tradable
- expiry too close
- abnormal volatility
- insufficient collateral/inventory
- extreme divergence between model and market

The list was introduced as "possible examples". Treat it as a candidate set, not a frozen spec, until the directing agent confirms.

These are product requirements, **not** claims that every mechanism is already supported. Verify implementability before freezing rules.

### D. Capital lifecycle

Where technically supported:

```
capital
→ Event Contract inventory/liquidity
→ fills
→ settlement
→ claim
→ available capital
→ next appropriate market
```

Each step must be checked against actual DreamDEX/Somnia behavior (see `TECHNICAL_VERIFICATION.md`). Do not assume SpotPool behavior, session keys, window lengths, or settlement.

## Explicitly not decided in the incoming messages

These were mentioned as later phases or were cut off:

- remaining product layers beyond A/B/C
- exact fair-value model
- UI/UX (use `design-skill` later)
- README polish (use `perfect-readme` later)
- pre-submission audit (use `Audit-skill` later)
- whether on-chain risk gates are required vs off-chain rules
- which windows/assets are in MVP
- custody model (operator EOA vs vault)

## Related prior research on this machine (not this product)

Desktop already contains `house-spike/` and idea-research notes for a product called **House**. That work is about the same venue and some of the same mechanics. VILLA is the project we are building. Do not copy House's retail "be the house" framing, file layout, or assumed model into VILLA unless the directing agent approves it.

House research is useful as **venue evidence**, not as a substitute for this brief.
