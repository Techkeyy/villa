import assert from "node:assert/strict";
import test from "node:test";
import { classifyReceipt, reconcileLpSession, reconcileRestart, assertReconciledForLeaseRelease } from "./lp-reconciliation.mjs";
import { createLpExecutionSession } from "./lp-session.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const session = createLpExecutionSession({ sessionId: "session-reconcile", account: ACCOUNT, owner: OWNER, operator: OPERATOR, marketSeries: "BTC 5m", currentMarketId: MARKET, riskPolicyVersion: "villa-risk-v1", createdAt: 1000 });

function facts(overrides = {}) {
  return {
    session,
    accountState: { account: ACCOUNT, identity: { account: ACCOUNT }, capital: { account: ACCOUNT, collateralRaw: 500_000n }, inventory: { account: ACCOUNT }, orders: { account: ACCOUNT }, fills: [] },
    market: { marketId: MARKET, series: "BTC 5m" },
    orders: { account: ACCOUNT, status: "VERIFIED", orders: [] },
    inventory: { account: ACCOUNT, status: "VERIFIED", yesRaw: 0n, noRaw: 0n },
    transactions: [{ txHash: "0xconfirmed", state: "CONFIRMED", receipt: { status: 1 } }],
    settlementClaims: [],
    successorMarket: { marketId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    risk: { state: "ALLOW" },
    ...overrides,
  };
}

test("receipt classification is conservative and explicit", () => {
  assert.equal(classifyReceipt({ status: 1 }), "CONFIRMED");
  assert.equal(classifyReceipt({ status: "0x0" }), "REVERTED");
  assert.equal(classifyReceipt(null), "UNKNOWN");
  assert.equal(classifyReceipt({ status: "pending" }), "UNKNOWN");
});
test("reconciliation includes account capital, inventory, orders, fills, claims, market, successor, risk, and safe release", () => {
  const result = reconcileLpSession(facts());
  assert.equal(result.status, "RECONCILED");
  assert.equal(result.safeToStart, true);
  assert.equal(result.safeToReleaseLease, true);
  assert.equal(result.account, ACCOUNT);
  assert.equal(result.collateral.collateralRaw, 500_000n);
  assert.equal(result.successorMarket.marketId.startsWith("0xbb"), true);
  assertReconciledForLeaseRelease(result);
});
test("pending and unknown transaction states block START and lease release", () => {
  const pending = reconcileLpSession(facts({ transactions: [{ txHash: "0xp", state: "PENDING" }] }));
  assert.equal(pending.status, "UNKNOWN");
  assert.ok(pending.reasons.includes("PENDING_TRANSACTION"));
  assert.equal(pending.safeToReleaseLease, false);
  const unknown = reconcileLpSession(facts({ transactions: [{ txHash: "0xu", state: "UNKNOWN" }] }));
  assert.ok(unknown.reasons.includes("UNKNOWN_TRANSACTION"));
  assert.throws(() => assertReconciledForLeaseRelease(unknown), { code: "LEASE_RELEASE_BLOCKED" });
});

test("contradictory account/order/inventory/market facts fail closed", () => {
  const account = reconcileLpSession(facts({ accountState: { account: OWNER } }));
  assert.ok(account.reasons.includes("ACCOUNT_SCOPE_MISMATCH"));
  const order = reconcileLpSession(facts({ orders: { account: ACCOUNT, status: "VERIFIED", orders: [{ owner: OWNER, orderId: 1 }] } }));
  assert.ok(order.reasons.includes("ORDER_SCOPE_MISMATCH"));
  const inventory = reconcileLpSession(facts({ inventory: { account: ACCOUNT, status: "UNKNOWN" } }));
  assert.ok(inventory.reasons.includes("INVENTORY_STATE_UNKNOWN"));
  const market = reconcileLpSession(facts({ market: { marketId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", series: "BTC 5m" } }));
  assert.ok(market.reasons.includes("MARKET_SCOPE_MISMATCH"));
});

test("restart recovery refuses stale local memory and permits only safe reconciled recovery", () => {
  assert.deepEqual(reconcileRestart({ session, observation: { status: "UNKNOWN", safeToStart: false } }), { recovered: false, state: "ERROR", reason: "RESTART_RECONCILIATION_REQUIRED" });
  assert.deepEqual(reconcileRestart({ session, observation: { status: "RECONCILED", safeToStart: false } }), { recovered: false, state: "ERROR", reason: "RESTART_STATE_NOT_SAFE" });
  assert.deepEqual(reconcileRestart({ session, observation: { status: "RECONCILED", safeToStart: true } }), { recovered: true, state: "PREFLIGHT", reason: "RECONCILED_BEFORE_NEW_SESSION", account: ACCOUNT, marketId: MARKET });
});
