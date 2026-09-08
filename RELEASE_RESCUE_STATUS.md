# Release rescue: partial package A, NOT a release candidate

Base: `797ad6a7efdaf6823e92d851e3632846085cb453`.
Branch: `codex/release-rescue`. The original checkout and unpushed `cb3b96f`
are not part of this rescue branch.

## Implemented locally

- Explicit stale-price waiting survives quote gate, reconciliation and preflight.
- A simultaneous non-price HALT remains fail-closed.
- Opted-in risk collection passes stale upstream age to the unchanged governor
  thresholds. Other fetchSpot callers keep their existing rejection behavior.
- Missing/empty books do not manufacture a quote. Explicit transient data/read
  failures retry without creating new-risk transactions.
- Stop before a first mint handles null tracked inventory without adopting
  nonzero account inventory. Stop during fresh-data reevaluation does not mint.
- Market/session/lease scope is emitted earlier. Reporting remains best-effort;
  this is NOT a new authoritative recovery record or durability guarantee.

## Blocking package A: authoritative recovery is incomplete

Do not deploy this branch as the complete rescue. No recovery classification
or binding-release policy was loosened.

The existing no-market reader returns null inventory/positions and null vault
credit. It does not enumerate all value locations. Contract exposure getters
walk tracked markets but do not include withdrawable vault collateral; the
tracked-market array has no public enumeration getter. Therefore an omitted
market ID, absent journal and zero exposure are not sufficient proof that all
required inventory/order/settlement/value facts are clean.

Completion needs an authoritative source of market/value provenance, strict
handling of incomplete historical records and remaining worker/cgroup authority,
plus account-scoped retry integration. Missing facts must continue to reject.
Do not substitute an expanded error allowlist, status-only terminal check, or
an implicit null-to-zero conversion for that evidence.

Mint-confirmed/order-failed recovery and normal-user retry remain unimplemented.
Work packages C and B, shared-operator admission, frontend control fixes, and
orphan-worker verification have not been completed in this branch.

## Multi-user scope

Independent user accounts, deposits, authorizations and withdrawals are unchanged.
Concurrent strategy execution is NOT made safe by this patch. The approved
temporary testnet shared-operator serialization has NOT been implemented yet.
Its eventual gate must cover strategy, settlement and recovery, survive process
restart, and release only after authoritative evidence excludes remaining writer
authority and unresolved transactions. Public busy responses must reveal no
other owner's identifiers or state.

Future production architecture remains global/shared nonce coordination or
independent operator execution lanes, not a single-user product.

## Test scope

Worker integration invocation:

```text
node --experimental-vm-modules --test src/execution/lp-rescue-worker.integration.test.mjs
```

These tests execute the actual worker entry point with mocked network, account
adapter, policy/writer transaction boundary and signer loader. They execute the
real planner, governor, preflight, heartbeat and settlement/Stop logic. They are
not wet execution and do not certify contract calls or production recovery.
Without the VM flag, worker tests explicitly skip; run the command above.

Additional cross-module tests are in `lp-rescue-wait.integration.test.mjs`.
The requested fifteen-scenario acceptance matrix is NOT complete.

Results for this partial patch:

- 13/13 implemented integration cases (7 worker + 6 cross-module).
- 40/40 directly affected existing tests.
- 153/153 quick regression tests for lease, writer, policy, governor and planner.
- One broader default-suite attempt, with VM integration enabled, was terminated
  at its hard 120-second deadline. No complete suite total is available. Ganache
  reported a missing native uWS build and selected its JavaScript fallback.

These results do not establish package A recovery, packages C/B, serialization,
frontend truth, orphan safety or readiness for a real-wallet acceptance run.

No push, deployment, service restart, production recovery, signer access or wet
session is authorized by this document. Do not use this partial patch to claim
that Start, settlement, withdrawal, concurrency or the entire lifecycle is fixed.
