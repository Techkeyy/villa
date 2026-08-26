# Phase 5B successor-market rollover

## Plain-English boundary

VILLA does not own the Event Contract venue or assume that one market lives
forever. A binary market is a bounded window. When the current window A is no
longer Trading, VILLA closes A's market-scoped decision context, discovers a
new market B from the current DreamDEX source, verifies B on-chain, and builds
a fresh read-only decision context for B.

The probability and governor are run again for B. The quote planner is also
run again, but its result is still only a plan. This milestone does not send a
transaction, manage orders, mint inventory, or claim a settled position.

The rollover means:

    observe A -> A leaves Trading -> close A context
      -> rediscover later same-series B -> verify B on-chain
      -> initialize fresh B scope -> reference -> fair value -> governor -> plan

The probability pUp is never copied from A. Wallet scope and strategy
configuration carry forward; market-scoped reference, expiry, outcome ids,
inventory, pending exposure, and quote plan reset for B.

## Identity and successor definition

marketId is the identity of every market. A pool address is a time-varying
execution resource and may be reused by a later window; it is never used as a
successor key. VILLA defines a stable series identity as:

    marketType = BINARY
    asset      = BTC (normalized uppercase)
    intervalSec = the exact configured interval

The series key is BINARY:<asset>:<intervalSec>. Venue is captured as a
diagnostic field, not made a required series discriminator, because the live
SDK/indexer evidence shows venue identifiers can move. Natural-language
market questions are not parsed.

The source adapter uses the installed SDK current
client.listLiveBinaryMarkets filter when available, with a compatibility
fallback to listBinaryMarkets. It asks for the same asset and interval as A,
then rejects candidates whose exact on-chain marketId, status, expiry, or
YES/NO ids do not agree. Among valid candidates it chooses the earliest later
expiry. Equal earliest expiries fail closed as SUCCESSOR_AMBIGUOUS; no valid
candidate produces WAITING_FOR_SUCCESSOR.

## State machine

The pure state machine is src/rollover/index.mjs, versioned as
villa-rollover-v1:

    ACTIVE
      -> STOPPING_CURRENT
      -> WAITING_FOR_SUCCESSOR
      -> SUCCESSOR_FOUND
      -> INITIALIZING_SUCCESSOR
      -> SUCCESSOR_READY
                             -> HALTED

An active A and active B cannot share one context. A is retained in
settlementHistory for later settlement tracking while B becomes the only
active market scope. An open A order, ambiguous candidate, stale B data, or a
missing B quote/risk input halts or waits; it never falls through to an
unrelated market.

The machine emits structured facts, including
MARKET_CONTEXT_STARTED, CURRENT_MARKET_NO_LONGER_TRADING,
MARKET_CONTEXT_CLOSED, SUCCESSOR_SEARCH_STARTED,
SUCCESSOR_CANDIDATE_FOUND, SUCCESSOR_REJECTED, SUCCESSOR_CONFIRMED,
MARKET_CONTEXT_INITIALIZED, REFERENCE_RESOLVED,
ROLLOVER_FAIR_VALUE_CALCULATED, ROLLOVER_GOVERNOR_EVALUATED,
ROLLOVER_QUOTE_PLANNED, ROLLOVER_READY, WAITING_FOR_SUCCESSOR, and
ROLLOVER_HALTED.

## Data scopes

| Scope | Rollover behavior |
| --- | --- |
| Market | Reset on B: market id, reference, expiry, status, YES/NO ids, inventory, pending exposure, quote plan, decision snapshot |
| Wallet | Carries forward: operator identity and capital facts; no secret is stored in rollover state |
| Strategy/session | Carries forward: session id and operator strategy configuration |
| Underlying history | Retained only under the documented freshness, future-skew, gap, duplicate-timestamp, and maximum-tick policy |
| Settlement tracking | A remains in history; B can be active while A is tracked separately |

inventoryForMarket reads only the exact B YES and NO token ids. An A balance or
pending order is therefore excluded from B. The live verifier also reads the
known Phase 5A historical market and labels its losing NO remainder as
KNOWN_ZERO_VALUE_SETTLED_RESIDUAL; it does not claim that the wallet is
globally empty.

## B initialization pipeline

After successor discovery, the adapter takes a fresh chain-head read and
rechecks B. It resolves B's strike or, when the strike is zero, B's opening
price using B's marketId. It then assembles the existing read-only pipeline:

    B spot + B reference + B history
      -> villa-fv-v1
      -> villa-risk-v1
      -> villa-quote-v1

The DreamDEX YES book is read separately for comparison/post-only context. It
does not feed fair value, governor state, or quote centre. If B's governor
returns HALT, B remains a valid initialized context but the state becomes
HALTED; the adapter does not silently choose a third market. If B has no valid
quote because of minimum quantity or post-only constraints, the structured
NO_QUOTE result is retained and no fallback is attempted.

## Live verifier and safety boundary

scripts/verify-rollover.mjs is bounded by maximum observation time, poll
interval, and successor-discovery attempts. Chain block time controls expiry
and selection. Local wall time is used only to enforce the process bound and
measure latency.

The verifier imports the read-only exchange and the pure fair-value, risk, and
quote layers. It contains no signer, writer queue, order-control call, or
unbounded loop. npm run verify:rollover is the reproducible command. A
successful run must end with zero active operator orders and transactionCount
equal to zero.

## Shannon evidence (2026-08-26)

The final bounded proof selected BTC 1m Market A
0x000000000000000000000000000000000000000000000000000000000000a17b,
observed chain status Resolved (4) at chain time 1787745241, and verified zero
A orders through both chain and indexer reads. It rediscovered the same series
as Market B:
0x000000000000000000000000000000000000000000000000000000000000a17d,
with expiry advancing from 1787745240 to 1787745300. The successor search
returned one candidate in 593 ms; B was rechecked on-chain and initialized
with a fresh strike reference of 78529.44 at raw scale 10^2.
The observed A/B overlap was 0s: B first appeared after A left Trading.

A's exact YES/NO token ids were
776664966871418313858016266783285107726519691425877167524175228708608 /
776664966871418313858016266783285107726519691425877167524175228708609;
B's were
1794547639858194023358288879777632407713807181339744266363869969026304 /
1794547639858194023358288879777632407713807181339744266363869969026305.
The venue id stayed
0x1a1e6821cde7d0159c0d293177871e09677b4e42307c7db3ba94f8648a5a050f,
while the pool changed from
0x1ccedff37647f3216201b5b556dc28fdf9d71eb4 to
0x42903fa9f7fe00dd26d29bdc1d826caa6dc29e62; neither field replaced
marketId as identity.

At the B snapshot, BTC was 78532.35, the model reported pUp = 0.5501084,
pDown = 0.4498916, 57s remaining, realized volatility 3.8973363e-5 per
square-root second, and HIGH data quality (0.95). The governor was ALLOW.
The quote planner returned NO_QUOTE because the live minimum-quantity and
post-only constraints left no valid target; that result was retained rather
than routed elsewhere. B inventory was exactly 0/0, B open-order
reconciliation was VERIFIED with zero orders, and the final operator
active-order scan was zero.

The known Phase 5A market ...a00b was read separately: NO 1000 raw was
classified as KNOWN_ZERO_VALUE_SETTLED_RESIDUAL, with no claimable winning
balance. No transaction was sent by this proof.

## Tests and limitations

The pure rollover suite contains 45 deterministic tests covering identity,
same-series selection, pool reuse, equal-expiry ambiguity, on-chain mismatch,
chain-time behavior, A/B state isolation, wallet and strategy persistence,
reference/fair-value/governor/quote rebinding, residual classification,
history retention, event determinism, and the verifier's lack of write-capable
calls.

This is not a continuous market-following daemon and does not prove that A's
settlement is complete before B becomes active. It intentionally leaves
settlement claims to the existing Phase 5A lifecycle and leaves live order
control to a future bounded execution decision. A future runner must persist
and recover this state from fresh chain/indexer reads before any trading
action.
