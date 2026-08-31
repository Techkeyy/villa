# LP engine control model

Phase 3A defines the account-specific control semantics and Phase 3B0 adds the
unarmed wet-boundary model, but neither exposes public live controls. The public
VILLA Start action remains disabled. Phase 3A plans are `SHADOW`; Phase 3B0's
wet writer is policy-bound and test-injected only.

## Session identity

Every future session is bound to one tuple:

```text
sessionId + VillaAccount + LP owner + configured operator + exact market series
```

The session may not change its account, owner, operator, or market identity.
The operator signer is allowed to act only through that VillaAccount. The
account address, not the signer address, is the identity for collateral,
inventory, orders, fills, exposure, settlement, and rollover.

An account-scoped lease permits one active controller. Expired leases require
fresh chain/venue reconciliation before recovery. A process restart creates a
new session identity after that reconciliation; it never silently changes the
account or reuses an unverified transaction intent.

## START

START is accepted only after the wet preflight returns `allowed: true`. It must
verify Shannon, the account runtime, the account owner, the configured
operator, signer identity, current market identity, owner-approved market
permission, required protocol approval, capital minimum and hard cap, risk
limits, verified order/inventory state, reconciled transaction state, and the
absence of another controlling session.

In Phase 3A START creates a shadow session and computes one account-bound plan.
In Phase 3B0 the future wet session is still not armed: policy validation and
the writer are exercised only with injected test senders. No phase here submits
a transaction, changes account state, or starts a public control path. A failed
preflight returns explicit reason codes, including
`OPERATOR_NOT_AUTHORIZED`, `INSUFFICIENT_CAPITAL`, `MARKET_NOT_APPROVED`,
`STALE_MARKET_ID`, `UNKNOWN_TRANSACTION`, and `ACCOUNT_LEASE_NOT_HELD`.

## PAUSE

PAUSE stops all new quote planning and quote replacement for the session. It
does not withdraw capital, redeem positions, change account permissions, or
switch to another market. The session journal retains the last verified
account, inventory, order, and risk facts.

In Phase 3A shadow mode there are no resting orders to cancel. In a separately
approved future live mode, PAUSE requests cancellation only for the session's
tracked orders, reconciles each exact order, and then keeps the session paused.
It does not use broad cancellation and it does not touch unmanaged orders.

## STOP

STOP is terminal for the current session. It prevents new planning and writes,
requests cancellation of all tracked session orders in a serialized queue,
reconciles account inventory and settlement state, records any directional
residual under its exact market ID, and leaves the LP owner in control of the
account. It never withdraws LP capital, selects a withdrawal destination, or
liquidates unmatched inventory.

In shadow mode STOP records the plan as stopped and sends nothing. In the
future wet boundary STOP blocks new writes, cancels only known session-owned
orders, optionally burns only a verified paired increment, reconciles the
terminal state, and releases the lease only after reconciliation passes. It
never withdraws. A later session must pass fresh discovery and readiness
checks; it cannot resume a stale plan or reuse an old market ID after rollover.

## State transitions

```text
STOPPED -> STARTING -> SHADOWING
                         |  \
                       PAUSE  STOP
                         |      \
                      PAUSED -> STOPPED
```

There is no implicit resume after PAUSE and no automatic restart after STOP.
The public UI does not expose these transitions in Phase 3A.
