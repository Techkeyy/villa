# VILLA settlement lifecycle

VILLA does not own or settle Event Contracts. DreamDEX owns the markets; VILLA
holds outcome positions, waits for the protocol's terminal state, and
pull-claims value that the protocol says is redeemable.

The Phase 5A flow is bounded:

`Trading → mint one complete set → hold through expiry → observe chain resolution → redeem → reconcile → stop`

It is not a quote loop. It does not place/cancel orders, resolve/void a market,
or automatically enter the next market.

## Plain-language contract

The installed SDK exposes these on-chain states:

| Numeric status | Name | Redeemable? |
| ---: | --- | --- |
| 0 | Listed | No |
| 1 | Trading | No |
| 2 | Locked | No |
| 3 | Settling | No |
| 4 | Resolved | Yes, once resolution is readable |
| 5 | Voided | Yes, both sides can be claimed |

The indexer’s `Finalized` label is a separate historical state. It helps VILLA
rediscover old markets and perform a claim sweep, but it cannot establish a
winner by itself. On-chain status flags and the deployed payout vector are
authoritative.

DreamDEX does not automatically push winnings to the wallet. VILLA explicitly
redeems the winning outcome. A resolved loser has zero payout and is not sent
to `redeem`; if its ERC-6909 token remains, the state labels that known
zero-value residual. A void uses the protocol’s uniform half-payout vector, so
both held sides are planned.

## Code and safety boundary

`src/settlement/index.mjs` is pure `villa-settlement-v1` logic. It classifies
state, validates explicit outcome indices, plans idempotent redemption legs,
calculates payout vectors, and reconciles raw balances. It has no SDK, RPC,
indexer, wallet, environment, order, or transaction dependency.

`src/settlement/live.mjs` and `scripts/verify-settlement.mjs` are the I/O
boundary. The script requires exactly one mode:

```text
npm run verify:settlement:dry
npm run verify:settlement
```

Dry mode scans recent `Finalized` BTC markets for nonzero claimable holdings,
selects a current short BTC market, resolves its reference, reads balances,
and prints the intended lifecycle. It never calls a signer write. Wet mode
requires the package’s explicit `--confirm`, mints only one minimum valid set,
and stops after redemption/reconciliation. It never reads the order book or
places/cancels orders.

Each boundary is recorded in a secret-free JSON file under ignored
`runtime/state/`. `--resume=<state-file>` reads the same `marketId`; a pool is
never treated as a market identity. If the bounded watch sees no terminal
state, it records `SETTLEMENT_PENDING`, preserves the pair, and stops without
calling a poke, void, burn, or rollover workaround.

## Explicit redemption

The current SDK call is:

```js
exchange.trader.redeem({
  marketId,
  market,
  outcomeToken,
  outcomeIdx, // explicit 0 = YES, 1 = NO
  amount,
  autoApprove: true,
});
```

For a resolved market, VILLA submits only the held winner:

```text
winning YES: redeem outcomeIdx 0; skip NO as zero payout
winning NO:  redeem outcomeIdx 1; skip YES as zero payout
```

For a void, both legs are explicit. Every leg is re-read immediately before
submission, serialized, confirmed with its own receipt, and followed by its
own balance read. The SDK may send a one-time ERC-6909 module-operator
approval when `autoApprove: true`; VILLA records whether that approval was
already present and warns when setup may be required.

## Exact accounting

All settlement arithmetic stays in raw integers. The controlled mint must show:

```text
YES_after - YES_before = mintAmount
NO_after  - NO_before  = mintAmount
collateral_before - collateral_after = mintAmount
D = YES - NO = 0 for the controlled increment
```

The deployed payout vector uses denominator `10,000,000`:

```text
payout = floor(amountRaw × payoutNumerator[outcomeIdx] / 10,000,000)
```

The live verifier reads the vector from the deployed market. It keeps
collateral debit/return, expected/measured payout, native STT balance delta,
and receipt gas (`gasUsed × effectiveGasPrice`) as separate facts. Gas is not
described as payout or profit.

## Discovery and idempotency

Normal `loadMarkets()` may omit finalized binaries. VILLA checks that view only
as a diagnostic, then rediscoveries through:

```js
client.listBinaryMarkets({ status: "Finalized", asset: "BTC", limit: 200 })
```

The row is matched by case-insensitive `marketId`. A dry claim sweep reports
only nonzero claimable outcome balances; zero balances and losing residuals do
not create false claims. A zero/already-cleared leg becomes a structured
`SKIP` reason, so restart does not replay a redeem blindly.

## Structured events

The session stream records:

`SETTLEMENT_SESSION_STARTED`, `COMPLETE_SET_MINTED`, `MARKET_LOCKED`,
`MARKET_SETTLING`, `MARKET_RESOLVED`, `MARKET_VOIDED`, `REDEEM_PLANNED`,
`REDEEM_SUBMITTED`, `REDEEM_CONFIRMED`, `PAYOUT_RECONCILED`, and
`SETTLEMENT_SESSION_CLEAN`.

## Validation and limits

The pure suite has 30 deterministic tests for state refusal, resolved YES/NO,
void, complete-set accounting, explicit outcome mapping, payout vectors,
zero/already-cleared balances, finalized rediscovery, restart checks, secret
exclusion, and separate gas/payout ledgers. The first wet proof is deliberately
one short BTC market and one minimum set. It does not prove predictive edge,
maker profitability, automatic rollover, or that every future oracle resolves
within the configured bound.

The bounded Shannon proof passed on 2026-08-26 for one BTC 5m market (marketId
ending `a00b`). It minted `1000` raw, observed on-chain `Resolved (4)` with
YES as winner, redeemed explicit `outcomeIdx: 0`, and measured exact `1000` raw
collateral return. The normal market view omitted the settled market while
`status: "Finalized"` rediscovered the exact id. The final active-order count
was zero. The only remaining outcome token was the documented `1000` raw
resolved-loser residual; the final dry claim sweep reported no claimable side.
Transaction and gas evidence is recorded in `docs/TECHNICAL_VERIFICATION.md`.

## Rollover coexistence

Phase 5B keeps settlement tracking separate from successor decision state. A
market may be terminal and retained in the rollover settlement history while a
later B market is active for fresh reference, fair value, governor, and quote
planning. The rollover verifier does not claim A's settlement value or alter
A's balances; it only labels the known historical losing residual and proves
that its token id is excluded from B's 0/0 inventory. Settlement can therefore
be completed by this lifecycle without allowing an A residual to be treated as
B inventory.

## Phase 6A settlement overlap

The bounded autonomous runner calls the existing read-only finalized-market
and known-residual check during each configured BTC 5m cycle. A historical
losing residual is recorded as a zero-value settlement fact and never enters
the active market's inventory or directional exposure. If an unmatched
current-market balance remains after order cleanup, it is registered under
that exact old `marketId` before successor initialization.

The runner does not convert a claim check into an unbounded claim loop. Any
future redeem write must use the same serialized queue as mint/place/cancel/
burn and the existing explicit settlement guards. A may therefore remain in
settlement tracking while B is Trading, with no scope leakage between their
outcome ids, references, balances, or quote plans.
