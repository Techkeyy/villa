import assert from "node:assert/strict";
import test from "node:test";
import { createLeaseHeartbeat } from "./lp-lease-heartbeat.mjs";
import { attachLease, createAccountLeaseStore, createLpExecutionSession, transitionLpSession } from "./lp-session.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OTHER_ACCOUNT = "0x2222222222222222222222222222222222222222";
const OWNER = "0x3333333333333333333333333333333333333333";
const OTHER_OWNER = "0x5555555555555555555555555555555555555555";
const OPERATOR = "0x4444444444444444444444444444444444444444";
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeSession({ sessionId = "uat-1000-aaaaaaaa", account = ACCOUNT, owner = OWNER, createdAt = 1000 } = {}) {
  return createLpExecutionSession({ sessionId, account, owner, operator: OPERATOR, marketSeries: "BINARY:BTC:300", currentMarketId: MARKET, riskPolicyVersion: "lease-test", createdAt });
}

function acquired({ clockRef, session = makeSession(), duration = 100 } = {}) {
  const store = createAccountLeaseStore({ now: () => clockRef.value, leaseDurationMs: duration });
  const lease = store.acquire(session);
  const attached = attachLease(session, lease);
  return { store, lease, session: attached };
}

test("1. lease is initially acquired for the exact owner/account/session", () => {
  const clockRef = { value: 1000 };
  const value = acquired({ clockRef });
  assert.equal(value.store.assertHeld(value.session).leaseId, value.lease.leaseId);
});

test("2. healthy worker renews comfortably before TTL", () => {
  const clockRef = { value: 1000 };
  const value = acquired({ clockRef });
  const heartbeat = createLeaseHeartbeat({ leaseStore: value.store, session: value.session, lease: value.lease, leaseDurationMs: 100, intervalMs: 40 });
  clockRef.value = 1040;
  heartbeat.renewNow();
  assert.equal(heartbeat.authority.expiresAt, 1140);
});

test("3. one session remains authoritative across many TTL periods", () => {
  const clockRef = { value: 1000 };
  const value = acquired({ clockRef });
  const heartbeat = createLeaseHeartbeat({ leaseStore: value.store, session: value.session, lease: value.lease, leaseDurationMs: 100, intervalMs: 40 });
  for (let index = 0; index < 100; index += 1) { clockRef.value += 40; heartbeat.renewNow(); }
  assert.equal(value.store.assertHeld(value.session).sessionId, value.session.sessionId);
});

test("4. another session cannot steal a live renewed lease", () => {
  const clockRef = { value: 1000 };
  const value = acquired({ clockRef });
  const heartbeat = createLeaseHeartbeat({ leaseStore: value.store, session: value.session, lease: value.lease, leaseDurationMs: 100, intervalMs: 40 });
  clockRef.value = 1040;
  heartbeat.renewNow();
  assert.throws(() => value.store.acquire(makeSession({ sessionId: "uat-1001-bbbbbbbb", createdAt: 1040 })), { code: "ACCOUNT_LEASE_HELD" });
});

test("5. wrong owner cannot renew another owner's lease", () => {
  const clockRef = { value: 1000 };
  const value = acquired({ clockRef });
  const impostor = { ...value.session, owner: OTHER_OWNER };
  assert.throws(() => value.store.heartbeat(impostor), { code: "LEASE_SCOPE_MISMATCH" });
});

test("6. wrong account cannot renew another account's lease", () => {
  const clockRef = { value: 1000 };
  const value = acquired({ clockRef });
  assert.throws(() => value.store.heartbeat({ ...value.session, account: OTHER_ACCOUNT }), { code: "LEASE_SCOPE_MISMATCH" });
});

test("7. wrong session id or lease id cannot renew authority", () => {
  const clockRef = { value: 1000 };
  const value = acquired({ clockRef });
  assert.throws(() => value.store.heartbeat({ ...value.session, sessionId: "uat-1002-cccccccc" }), { code: "LEASE_SCOPE_MISMATCH" });
  assert.throws(() => value.store.heartbeat({ ...value.session, leaseId: "lease-impostor" }), { code: "LEASE_SCOPE_MISMATCH" });
});

test("8. heartbeat failure makes the shared writer authority fail closed", () => {
  const clockRef = { value: 1000 };
  const value = acquired({ clockRef });
  let visible = null;
  const heartbeat = createLeaseHeartbeat({ leaseStore: value.store, session: value.session, lease: value.lease, leaseDurationMs: 100, intervalMs: 40, onFailure: (error) => { visible = error.code; } });
  clockRef.value = 1200;
  assert.throws(() => heartbeat.renewNow(), { code: "LEASE_EXPIRED" });
  assert.equal(heartbeat.authority.held, false);
  assert.equal(visible, "LEASE_EXPIRED");
});

test("9. crashed worker lease expires and normal acquire remains blocked", () => {
  const clockRef = { value: 1000 };
  const value = acquired({ clockRef });
  clockRef.value = 1200;
  assert.throws(() => value.store.acquire(makeSession({ createdAt: 1200 })), { code: "STALE_LEASE_REQUIRES_RECONCILIATION" });
});

test("10. exact authenticated recovery can replace only its expired lease", () => {
  const clockRef = { value: 1000 };
  const value = acquired({ clockRef });
  clockRef.value = 1200;
  const recovery = makeSession({ createdAt: 1200 });
  assert.throws(() => value.store.recoverExpired(recovery, { expectedLeaseId: "wrong" }), { code: "LEASE_SCOPE_MISMATCH" });
  const recovered = value.store.recoverExpired(recovery, { expectedLeaseId: value.lease.leaseId });
  assert.equal(recovered.recoveredLeaseId, value.lease.leaseId);
});

test("11. two recovery workers cannot race into authority", () => {
  const clockRef = { value: 1000 };
  const value = acquired({ clockRef });
  clockRef.value = 1200;
  const recovery = makeSession({ createdAt: 1200 });
  value.store.recoverExpired(recovery, { expectedLeaseId: value.lease.leaseId });
  assert.throws(() => value.store.recoverExpired(recovery, { expectedLeaseId: value.lease.leaseId }), { code: "ACCOUNT_LEASE_HELD" });
});

test("13. simulated long run exceeds fifteen minutes and several TTLs while renewing", () => {
  const clockRef = { value: 0 };
  const value = acquired({ clockRef, session: makeSession({ createdAt: 0 }), duration: 30_000 });
  const heartbeat = createLeaseHeartbeat({ leaseStore: value.store, session: value.session, lease: value.lease, leaseDurationMs: 30_000, intervalMs: 10_000 });
  for (let elapsed = 10_000; elapsed <= 16 * 60_000; elapsed += 10_000) { clockRef.value = elapsed; heartbeat.renewNow(); }
  assert.equal(heartbeat.getState().healthy, true);
  assert.ok(heartbeat.authority.expiresAt > 16 * 60_000);
});

test("14-15. normal cleanup retains a valid lease and releases it after clean Stop", () => {
  const clockRef = { value: 1000 };
  const value = acquired({ clockRef });
  const heartbeat = createLeaseHeartbeat({ leaseStore: value.store, session: value.session, lease: value.lease, leaseDurationMs: 100, intervalMs: 40 });
  let running = transitionLpSession(transitionLpSession(value.session, "PREFLIGHT", { atMs: 1010 }), "RUNNING", { atMs: 1020 });
  clockRef.value = 1040;
  heartbeat.renewNow();
  running = transitionLpSession(running, "STOPPING", { atMs: 1050 });
  const stopped = transitionLpSession(running, "STOPPED_CLEAN", { atMs: 1060 });
  assert.equal(value.store.release(stopped, { reconciled: true, atMs: 1060 }).released, true);
  assert.equal(value.store.has(ACCOUNT), false);
});
