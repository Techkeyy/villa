# LP reconciliation model

Phase 3B0 treats Shannon and DreamDEX state as authoritative. A local journal,
intent, or indexer response is not execution truth by itself.

## Session snapshot

Before START, during a session, after every receipt, and before STOP releases a
lease, reconciliation reads the exact account scope for:

- collateral and fixed pool-vault credit;
- complete-set inventory and free YES/NO balances;
- open orders, order owner, market binding, remaining quantity, and expiry;
- known fills and their external order identifiers;
- pending transaction hashes and nonce observations;
- settlement claims and payout state;
- the current market ID and the same-series successor;
- risk state and the active policy version; and
- the session's exact account, owner, operator, and market identity.

The account address is used for every portfolio read. The operator EOA is only
the expected caller identity. Contradictory account/order data is never
normalized into zero.

## Transaction states

The serialized writer records exactly:

| State | Meaning | Next action |
| --- | --- | --- |
| `PENDING` | Broadcast or receipt is still in progress | Wait for authoritative receipt/reconciliation |
| `CONFIRMED` | Receipt succeeded | Re-read affected account/order state |
| `REVERTED` | Receipt definitively failed | Record failure; do not assume a state change |
| `UNKNOWN` | Broadcast/receipt outcome cannot be proven | Halt all writes and reconcile by hash/nonce |

An `UNKNOWN` result is never blindly retried. A nonce conflict also halts the
writer until the external nonce and pending hashes are explained.

## Order states

On-chain order fields are checked first. Indexer fields can strengthen the
result, but a contradiction or missing owner/market binding is
`UNKNOWN_ORDER_STATE`. A receipt alone does not prove that an order is resting
or cancelled.

## START and restart

START is denied if any transaction is `PENDING` or `UNKNOWN`, if an order or
inventory read is not verified, if the account/owner/operator scope differs, or
if the current market is stale. After a process or VPS restart, the next
process must acquire a fresh account lease only after it reconciles chain and
venue state. It cannot trust a prior journal to decide that an uncertain
transaction failed.

## STOP terminal proof

STOP blocks new placement, cancels only known session-owned orders, burns only a
verified paired increment when safe, preserves claimable resolved positions,
and performs a final reconciliation. The lease is released only when the final
result is `RECONCILED`, no open tracked orders remain, and no pending or unknown
transaction/order state exists. Otherwise the session is `ERROR`/halted and the
lease remains held for recovery. STOP never calls `withdraw`.
