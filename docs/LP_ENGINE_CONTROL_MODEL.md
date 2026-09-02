# LP engine control model

The account-bound control model is the only strategy control path exposed by
the final VILLA product. It is authenticated, account-scoped, policy-bound, and
safe-mode by default.

## Session identity

Every session is bound to one immutable tuple:

```text
sessionId + VillaAccount + LP owner + configured operator + Shannon chain + exact market series + exact market ID
```

The account address is the identity for collateral, inventory, orders, fills,
exposure, settlement, and rollover. An account-scoped lease permits one active
controller. Expired leases require authoritative chain and venue
reconciliation before recovery.

## START

The browser first authenticates the connected LP owner with a short-lived
message signature. It then sends an empty-body request to the account control
route. The server reads fresh account facts and runs the existing wet preflight.
The browser supplies no destination, selector, calldata, amount, withdrawal
instruction, or market override.

Start requires a verified owner/account pair, sufficient policy capital, the
fixed operator authorization, a fresh eligible market, `ALLOW` risk, a valid
quote plan, clean order and inventory state, reconciled transactions, an
available account lease, and a safe private runtime. With execution disabled,
Start returns `EXECUTION_DISABLED`, starts no writer, and sends no transaction.

## STOP

Stop is terminal for the current session. It blocks new expansion, requests
cancellation only for tracked account-owned orders, reconciles inventory and
settlement state, performs paired cleanup only when independently safe, and
releases the account lease after reconciliation. It never withdraws capital or
changes owner permission.

## Public safety boundary

The browser control client uses only these operations:

```text
POST /account/auth/nonce
POST /account/auth/verify
GET  /account/state
POST /account/session/start   {}
POST /account/session/stop    {}
```

The operator API rejects arbitrary transaction-shaped request fields. The
private signer stays inside the private engine process. Persistent unrestricted
execution remains disabled in the public release.

## State transitions

```text
STOPPED -> STARTING -> RUNNING
             |             |
             v             v
          ERROR        STOPPING -> STOPPED
```

The UI keeps the human state simple: ready, safe mode, running, stopping, or
needs attention. Technical refusal reasons remain secondary diagnostics.

## Explicit limitations

The final public deployment is not an always-on autonomous production daemon.
The tested account-bound writer and cleanup paths remain private runtime
components. A future production enablement requires a separate owner-approved
security and operational gate.