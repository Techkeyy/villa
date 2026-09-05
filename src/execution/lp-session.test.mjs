import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LP_SESSION_STATES,
  attachLease,
  assertLpSessionScope,
  createAccountLeaseStore,
  createFileAccountLeaseStore,
  createLpExecutionSession,
  transitionLpSession,
} from "./lp-session.mjs";
import { reconcileRestart } from "./lp-reconciliation.mjs";

const ACCOUNT_A = "0x1111111111111111111111111111111111111111";
const ACCOUNT_B = "0x2222222222222222222222222222222222222222";
const OWNER = "0x3333333333333333333333333333333333333333";
const OPERATOR = "0x4444444444444444444444444444444444444444";
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function session(account = ACCOUNT_A, createdAt = 1000) {
  return createLpExecutionSession({
    sessionId: `session-${account.slice(2, 6)}`,
    account,
    owner: OWNER,
    operator: OPERATOR,
    marketSeries: "BTC 5m",
    currentMarketId: MARKET,
    riskPolicyVersion: "villa-risk-v1",
    createdAt,
  });
}

test("session binds the account, owner, operator, chain, market, risk policy, and state", () => {
  const value = session();
  assert.equal(value.account, ACCOUNT_A);
  assert.equal(value.owner, OWNER);
  assert.equal(value.operator, OPERATOR);
  assert.equal(value.chainId, 50312);
  assert.equal(value.currentMarketId, MARKET);
  assert.equal(value.state, "CREATED");
  assert.ok(LP_SESSION_STATES.includes(value.state));
  assert.throws(() => assertLpSessionScope(value, { account: ACCOUNT_B }), { code: "ACCOUNT_SCOPE_MISMATCH" });
});

test("session state transitions are explicit and account identity cannot be replaced", () => {
  let value = session();
  value = transitionLpSession(value, "PREFLIGHT", { atMs: 1100 });
  value = transitionLpSession(value, "RUNNING", { atMs: 1200 });
  value = transitionLpSession(value, "PAUSED", { atMs: 1300 });
  assert.throws(() => transitionLpSession(value, "CREATED"), { code: "STATE_TRANSITION_INVALID" });
  assert.equal(value.account, ACCOUNT_A);
  assert.throws(() => createLpExecutionSession({ ...value, account: OWNER }), { code: "IDENTITY_COLLISION" });
});

test("one active lease is enforced per VillaAccount while another account remains independent", () => {
  let clock = 1000;
  const leases = createAccountLeaseStore({ now: () => clock, leaseDurationMs: 100 });
  const first = session(ACCOUNT_A);
  const second = session(ACCOUNT_B);
  const leaseA = leases.acquire(first);
  assert.throws(() => leases.acquire(session(ACCOUNT_A)), { code: "ACCOUNT_LEASE_HELD" });
  const leaseB = leases.acquire(second);
  assert.equal(leaseA.account, ACCOUNT_A);
  assert.equal(leaseB.account, ACCOUNT_B);
  assert.equal(leases.has(ACCOUNT_A), true);
  assert.equal(leases.has(ACCOUNT_B), true);
});

test("expired lease recovery requires reconciliation and cannot transfer control across accounts", () => {
  let clock = 1000;
  const leases = createAccountLeaseStore({ now: () => clock, leaseDurationMs: 100 });
  const oldSession = session();
  const oldLease = leases.acquire(oldSession);
  clock = 1200;
  assert.throws(() => leases.acquire(session(), { atMs: clock }), { code: "STALE_LEASE_REQUIRES_RECONCILIATION" });
  const recovered = session(ACCOUNT_A, clock);
  const recoveredLease = leases.recoverExpired(recovered, { atMs: clock, expectedLeaseId: oldLease.leaseId });
  assert.equal(recoveredLease.recoveredExpiredLease, true);
  const attached = attachLease(recovered, recoveredLease);
  assert.throws(() => leases.assertHeld({ ...attached, account: ACCOUNT_B }), { code: "LEASE_SCOPE_MISMATCH" });
  assert.throws(() => leases.release(recovered, { reconciled: false }), { code: "LEASE_RELEASE_BLOCKED" });
  const stopped = transitionLpSession(transitionLpSession(attached, "PREFLIGHT", { atMs: 1210 }), "STOPPED", { atMs: 1220 });
  assert.equal(leases.release(stopped, { reconciled: true, atMs: 1220 }).released, true);
  assert.equal(leases.has(ACCOUNT_A), false);
  assert.equal(oldLease.account, ACCOUNT_A);
});

test("lease attachment and restart recovery retain the same account and require safe reconciliation", () => {
  const value = session();
  const leases = createAccountLeaseStore({ now: () => 1000 });
  const lease = leases.acquire(value);
  const attached = attachLease(value, lease);
  assert.equal(attached.leaseId, lease.leaseId);
  assert.deepEqual(reconcileRestart({ session: attached, observation: { status: "UNKNOWN" } }), { recovered: false, state: "ERROR", reason: "RESTART_RECONCILIATION_REQUIRED" });
  assert.deepEqual(reconcileRestart({ session: attached, observation: { status: "RECONCILED", safeToStart: true } }), { recovered: true, state: "PREFLIGHT", reason: "RECONCILED_BEFORE_NEW_SESSION", account: ACCOUNT_A, marketId: MARKET });
});

test("durable lease files enforce one controller across independent stores and require reconciled stale recovery", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "villa-lease-"));
  try {
    let clock = 1000;
    const firstStore = createFileAccountLeaseStore({ directory, now: () => clock, leaseDurationMs: 100 });
    const secondStore = createFileAccountLeaseStore({ directory, now: () => clock, leaseDurationMs: 100 });
    const first = session();
    const firstLease = firstStore.acquire(first);
    assert.throws(() => secondStore.acquire(session()), { code: "ACCOUNT_LEASE_HELD" });
    clock = 1200;
    assert.throws(() => secondStore.acquire(session(), { atMs: clock }), { code: "STALE_LEASE_REQUIRES_RECONCILIATION" });
    const recovered = session(ACCOUNT_A, clock);
    const lease = secondStore.recoverExpired(recovered, { atMs: clock, expectedLeaseId: firstLease.leaseId });
    assert.equal(lease.recoveredExpiredLease, true);
    const attached = attachLease(recovered, lease);
    const stopped = transitionLpSession(transitionLpSession(attached, "PREFLIGHT", { atMs: 1210 }), "STOPPED", { atMs: 1220 });
    secondStore.release(stopped, { reconciled: true, atMs: 1220 });
    assert.equal(firstStore.has(ACCOUNT_A), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
