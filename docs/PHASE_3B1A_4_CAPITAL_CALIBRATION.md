# Phase 3B1A.4 bounded capital-floor calibration

Status: PASS, read-only calibration complete.

This phase derives the minimum strategy capital for one bounded Phase 3B1B
account-owned quote proof. It does not change the live disposable account, the
current hard cap, the public deposit minimum, or any on-chain state.

## Required recommendation

```text
CURRENT CAP:
1.00 tUSDC

MATHEMATICAL MINIMUM:
1.001 tUSDC

RECOMMENDED PHASE 3B1B CAP:
1.002 tUSDC

ADDITIONAL OWNER DEPOSIT REQUIRED:
0.002 tUSDC

PREFERRED PROOF PATH:
MINT+SELL

MAX ORDER NOTIONAL:
0.25 tUSDC

MAX EXPECTED EXPOSURE:
0.25 tUSDC

EXPECTED MAX TX COUNT:
12 policy cap; 4 writes in the selected proof path

WHY 1.002 tUSDC IS THE SMALLEST PRACTICAL SAFE VALUE:
1.001 tUSDC is the exact reserve boundary. 1.002 tUSDC is the first
sampled six-decimal value above it and leaves one additional 0.001 tUSDC
minimum-mint lot after the mint, without adding an arbitrary large buffer.
```

## Capital equation

All amounts are six-decimal tUSDC raw units.

```text
Path A, BUY-only:
capital >= reserve
        + DreamDEX-held BUY collateral
        + ceil(BUY price * BUY quantity / 1,000,000)
        + safety margin

Path B, MINT+SELL:
capital >= reserve
        + DreamDEX-held collateral
        + required complete-set mint
        + safety margin
```

For the authoritative account and the three fresh snapshots:

| Component | Raw units | tUSDC | Treatment |
|---|---:|---:|---|
| Risk Governor collateral reserve | 1,000,000 | 1.000 | Must remain available |
| Minimum venue mint | 1,000 | 0.001 | Produces one YES and one NO |
| DreamDEX open-order collateral | 0 | 0.000 | No open orders were read |
| DreamDEX vault credit | 0 | 0.000 | Reported, but not counted because this path has no withdrawal |
| Mathematical MINT+SELL floor | 1,001,000 | 1.001 | Exact boundary, zero margin |
| Recommended margin | 1,000 | 0.001 | One additional six-decimal mint lot |
| Recommended test capital | 1,002,000 | 1.002 | Proposed only |

The current 1.000 tUSDC balance fails because minting the venue minimum leaves
999,000 raw collateral, which is below the unchanged 1,000,000 raw reserve.
The exact 1.001 tUSDC boundary leaves exactly the reserve and passes the
existing strict `< reserve` Governor check. The additional 0.001 tUSDC is a
bounded operational margin, not a reserve relaxation.

The current account had zero YES inventory, so the minimum complete-set mint
is also the inventory requirement for a 1,000-raw SELL. A SELL has no new
collateral escrow in the planner. The selected pending exposure is 1,000 raw,
well below the unchanged 250,000-raw pending-exposure cap. Operator STT gas is
separate and is not included in the tUSDC equation.

## Fresh snapshot evidence

Three independent public read-only probes were run in parallel. Each had at
least 120 seconds of risk headroom:

| Snapshot | Market | Headroom | Live collateral | YES/NO | Result |
|---:|---|---:|---:|---|---|
| 1 | `...ed5a` | 195s | 1.000 tUSDC | 0 / 0 | eligible |
| 2 | `...ed5a` | 195s | 1.000 tUSDC | 0 / 0 | eligible |
| 3 | `...ed5a` | 195s | 1.000 tUSDC | 0 / 0 | eligible |

The repeated market identity reflects three fresh reads during one eligible
market window. The market/book state was re-read for every probe; the
calibration does not treat a stale market id as a successor or reuse owner
approval facts.

## Candidate matrix

The matrix is aggregated across all three fresh snapshots. `x/3` means the path
was feasible in `x` snapshots. “Current cap” refers only to the still-active
1.000 tUSDC `MAX_ACCOUNT_CAPITAL` policy. “Replacement” is a hypothetical
result and is not active.

| Capital | Min mint | Post-mint collateral | Risk | BUY feasible | SELL after mint feasible | Quote | Pending exposure | Caps / reason |
|---:|---:|---:|---|---:|---:|---|---:|---|
| 1.000 | 0.001 | 0.999 | BUY ALLOW; MINT+SELL HALT | 0/3 | 0/3 | none | 0 | current pass; strategy fail: reserve low |
| 1.001 | 0.001 | 1.000 | ALLOW | 0/3 | 3/3 | MINT+SELL, 0.001 order | 0.001 | current cap fail; non-capital pass; BUY account quantity limit |
| 1.002 | 0.001 | 1.001 | ALLOW | 0/3 | 3/3 | MINT+SELL, 0.001 order | 0.001 | current cap fail; replacement pass; BUY quantity + collateral limits |
| 1.005 | 0.001 | 1.004 | ALLOW | 0/3 | 3/3 | MINT+SELL, 0.001 order | 0.001 | current cap fail; replacement pass; BUY quantity + collateral limits |
| 1.010 | 0.001 | 1.009 | ALLOW | 0/3 | 3/3 | MINT+SELL, 0.001 order | 0.001 | current cap fail; replacement pass; BUY quantity + collateral limits |
| 1.025 | 0.001 | 1.024 | ALLOW | 0/3 | 3/3 | MINT+SELL, 0.001 order | 0.001 | current cap fail; replacement pass; BUY quantity + collateral limits |
| 1.050 | 0.001 | 1.049 | ALLOW | 0/3 | 3/3 | MINT+SELL, 0.001 order | 0.001 | current cap fail; replacement pass; BUY quantity + collateral limits |
| 1.100 | 0.001 | 1.099 | ALLOW | 0/3 | 3/3 | MINT+SELL, 0.001 order | 0.001 | current cap fail; replacement pass; BUY quantity + collateral limits |
| 1.250 | 0.001 | 1.249 | ALLOW | 0/3 | 3/3 | MINT+SELL, 0.001 order | 0.001 | current cap fail; replacement pass; BUY quantity + collateral limits |

The BUY-only planner target was rejected by the deployed VillaAccount’s
1,000-raw `maxOrderQuantity`, and from 1.002 upward also by its 1,000-raw
`maxOrderCollateral` on the sampled BUY. Increasing account capital cannot
fix those account-level order limits. The MINT+SELL path uses exactly the
deployed 1,000-raw mint and SELL limits and passed all three snapshots.

## Proof-path choice

Path A would be two writes, BUY then cancel, but it is not feasible under the
deployed account’s order limits. Path B is the first robust path:

```text
mint minimum complete set
-> one post-only SELL owned by VillaAccount
-> cancel the tracked order
-> burn the controlled minted increment
-> reconcile and stop
```

The path uses four writes, remains below the 12-transaction cap, and proves
account-owned order construction without requiring a BUY escrow or weakening
the reserve rule. No owner request is emitted during calibration.

## Explicit policy proposal, not activated

If the director approves the result, the only capital-policy line proposed for
the next phase is:

```diff
// src/execution/lp-transaction-policy.mjs
-  MAX_ACCOUNT_CAPITAL: 1_000_000n,
+  MAX_ACCOUNT_CAPITAL: 1_002_000n,
```

This line was not changed in Phase 3B1A.4. All other cap values remain locked:

```text
MAX_ORDER_NOTIONAL       = 250,000 raw
MAX_OPEN_ORDERS          = 2
MAX_PENDING_EXPOSURE     = 250,000 raw
MAX_MINT_AMOUNT          = 250,000 raw
MAX_SESSION_DURATION_SEC = 900
MAX_TX_COUNT             = 12
```

The public Phase 2 deposit minimum remains independently defined as
`MIN_DEPOSIT_TUSDC = 1.00` and `MIN_DEPOSIT_RAW = 1,000,000`. It was not
changed. The proposed strategy floor is `MIN_STRATEGY_CAPITAL = 1.001`
tUSDC; the proposed bounded Phase 3B1B test cap is `1.002` tUSDC.

## Safety result

```text
live account mutated: no
owner approvals emitted: no
market approvals prepared: no
signer installed: no
execution enabled: no
transactions sent: no
```
