import assert from "node:assert/strict";
import test from "node:test";
import { createLpSessionController } from "./lp-control.mjs";
import { createAccountLeaseStore, createLpExecutionSession, transitionLpSession } from "./lp-session.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function setup() {
  let session = createLpExecutionSession({ sessionId: "session-control", account: ACCOUNT, owner: OWNER, operator: OPERATOR, marketSeries: "BTC 5m", currentMarketId: MARKET, riskPolicyVersion: "villa-risk-v1", createdAt: 1000 });
  const leases = createAccountLeaseStore({ now: () => 1100 });
  const lease = leases.acquire(session, { atMs: 1100 });
  const cancelled = [];
  return { session, leases, lease, cancelled };
}

const order = { account: ACCOUNT, owner: ACCOUNT, marketId: MARKET, orderId: 7 };

test("START requires preflight, PAUSE cancels tracked orders and blocks new quoting", async () => {
  const value = setup();
  const controller = createLpSessionController({
    session: value.session,
    leaseStore: value.leases,
    lease: value.lease,
    now: () => 1200,
    preflight: () => ({ allowed: true, reasons: [] }),
    cancelOrder: async (item) => value.cancelled.push(item.orderId),
    reconcile: async () => ({ status: "RECONCILED", safeToReleaseLease: true }),
  });
  assert.equal((await controller.start()).started, true);
  const paused = await controller.pause({ openOrders: [order] });
  assert.equal(paused.session.state, "PAUSED");
  assert.deepEqual(value.cancelled, [7]);
  assert.equal(controller.getState().writesBlocked, true);
  assert.equal((await controller.resume()).started, true);
});

test("PAUSE and STOP cannot act on another account's order", async () => {
  const value = setup();
  const controller = createLpSessionController({ session: value.session, leaseStore: value.leases, lease: value.lease, now: () => 1200, preflight: () => ({ allowed: true }), reconcile: async () => ({ status: "RECONCILED", safeToReleaseLease: true }), cancelOrder: async () => value.cancelled.push("unexpected") });
  await controller.start();
  await assert.rejects(() => controller.pause({ openOrders: [{ account: "0x5555555555555555555555555555555555555555", marketId: MARKET, orderId: 1 }] }), { code: "ACCOUNT_SCOPE_MISMATCH" });
  assert.deepEqual(value.cancelled, []);
});

test("STOP cancels known orders, never withdraws, and releases the lease only after reconciliation", async () => {
  const value = setup();
  const controller = createLpSessionController({
    session: value.session,
    leaseStore: value.leases,
    lease: value.lease,
    now: () => 1200,
    preflight: () => ({ allowed: true }),
    cancelOrder: async (item) => value.cancelled.push(item.orderId),
    burnCompleteSet: async () => undefined,
    reconcile: async ({ phase }) => ({ status: "RECONCILED", safeToReleaseLease: true, phase }),
  });
  await controller.start();
  const stopped = await controller.stop({ openOrders: [order] });
  assert.equal(stopped.session.state, "STOPPED");
  assert.deepEqual(value.cancelled, [7]);
  assert.equal(value.leases.has(ACCOUNT), false);
  assert.equal(typeof controller.withdraw, "undefined");
});

test("STOP enters ERROR and keeps the lease when terminal reconciliation is not safe", async () => {
  const value = setup();
  const controller = createLpSessionController({ session: value.session, leaseStore: value.leases, lease: value.lease, now: () => 1200, preflight: () => ({ allowed: true }), cancelOrder: async () => undefined, reconcile: async () => ({ status: "UNKNOWN", safeToReleaseLease: false }) });
  await controller.start();
  await assert.rejects(() => controller.stop(), { code: "STOP_RECONCILIATION_FAILED" });
  assert.equal(controller.session.state, "ERROR");
  assert.equal(value.leases.has(ACCOUNT), true);
});

test("START denial is explicit and never invokes a writer", async () => {
  const value = setup();
  let writerCalls = 0;
  const controller = createLpSessionController({ session: value.session, leaseStore: value.leases, lease: value.lease, now: () => 1200, preflight: () => ({ allowed: false, reasons: ["UNKNOWN_TRANSACTION"] }), cancelOrder: async () => { writerCalls += 1; }, reconcile: async () => ({ status: "UNKNOWN", safeToReleaseLease: false }) });
  const result = await controller.start();
  assert.equal(result.started, false);
  assert.deepEqual(result.result.reasons, ["UNKNOWN_TRANSACTION"]);
  assert.equal(writerCalls, 0);
  assert.equal(controller.session.state, "ERROR");
});
