# Phase 3B1A.5 capital policy activation and safe top-up

Status: PASS, local policy activation and unsigned owner preparation complete.

This phase activates the director-approved bounded Phase 3B1 wet-test cap. It
does not send a top-up, approve a market, prepare a market, install a signer,
enable execution, or push a commit.

## Separate capital concepts

| Concept | Value | Scope |
|---|---:|---|
| `MIN_INITIAL_DEPOSIT_TUSDC` | `1.00` | Public first-funding minimum for an unfunded account |
| `MIN_STRATEGY_CAPITAL_TUSDC` | `1.001` | Bounded strategy feasibility floor |
| `PHASE_3B1_RECOMMENDED_CAP_TUSDC` | `1.002` | Phase 3B1 engineering-test cap only |
| `MIN_TOP_UP_TUSDC` | `0.001` | Minimum positive increment for an already-funded account |

The test cap is not a public-user capital ceiling. The initial-deposit floor
is still `1.00 tUSDC`, and an unfunded account cannot accumulate smaller
increments to bypass it.

## Activated bounded caps

```text
MAX_ACCOUNT_CAPITAL   = 1,002,000 raw = 1.002 tUSDC
MAX_ORDER_NOTIONAL    =   250,000 raw = 0.25 tUSDC
MAX_OPEN_ORDERS       = 2
MAX_PENDING_EXPOSURE  =   250,000 raw = 0.25 tUSDC
MAX_MINT_AMOUNT       =   250,000 raw = 0.25 tUSDC
MAX_SESSION_DURATION  = 900 seconds
MAX_TX_COUNT          = 12
```

All capital comparisons are integer raw-unit comparisons. Exact cap behavior
is therefore:

```text
1,001,999 raw: allowed
1,002,000 raw: allowed
1,002,001 raw: CAP_EXCEEDED
```

## Top-up semantics

The liquidity flow uses the verified account collateral balance to choose the
minimum. A zero-collateral account must deposit at least `1.00 tUSDC`. A
funded account may top up by at least `0.001 tUSDC`. Input parsing accepts no
more than six decimals, performs no rounding, rejects zero and negative
amounts, and checks the connected wallet balance before creating requests.

## Exact disposable-account plan

```text
OWNER:
  0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d
VILLA ACCOUNT:
  0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2
TOKEN:
  0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E
CURRENT CAPITAL:
  1,000,000 raw = 1.000 tUSDC
TOP-UP:
  2,000 raw = 0.002 tUSDC
RESULTING CAPITAL:
  1,002,000 raw = 1.002 tUSDC
APPROVAL TARGET:
  VillaAccount, exact amount 2,000 raw
DEPOSIT TARGET:
  VillaAccount, exact amount 2,000 raw
```

The owner-preparation module emits two unsigned requests only:

1. finite `approve(VillaAccount, 2,000)` on tUSDC;
2. `deposit(2,000)` on the VillaAccount.

There is no unlimited approval, no `1.00 tUSDC` approval, no overfunding, no
private key field, and no automatic transaction generation. The prepared plan
remains subject to the owner's wallet review and confirmation in a later
explicit step.

## Projected readiness proof

The unsigned projection is:

```text
capital:                    1.002 tUSDC
minimum strategy capital:   PASS at 1.001 tUSDC
Phase 3B1 cap:              PASS at exact 1.002 tUSDC boundary
minimum mint:               0.001 tUSDC
post-mint collateral:       1.001 tUSDC
collateral reserve:         PASS at 1.000 tUSDC
MINT+SELL feasibility:      PASS under the previously proven compatible market conditions
```

This is a mathematical projection, not a claim about live state. Fresh market
selection remains a separate later gate after the owner top-up is actually
confirmed.

## Safety verdict

```text
live account mutated:       no
owner approval requested:   no
market approval prepared:   no
signer installed:           no
execution enabled:          no
transactions sent:          no
```
