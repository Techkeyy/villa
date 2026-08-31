import assert from "node:assert/strict";
import test from "node:test";
import { evaluateWetExecutionPreflight } from "./lp-preflight.mjs";
import { DEFAULT_PHASE_3B1_CAPS } from "./lp-transaction-policy.mjs";
import { createLpExecutionSession, createAccountLeaseStore, transitionLpSession } from "./lp-session.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function base() {
  let session = createLpExecutionSession({ sessionId: "session-preflight", account: ACCOUNT, owner: OWNER, operator: OPERATOR, marketSeries: "BTC 5m", currentMarketId: MARKET, riskPolicyVersion: "villa-risk-v1", createdAt: 1000 });
  session = transitionLpSession(session, "PREFLIGHT", { atMs: 1100 });
  const leases = createAccountLeaseStore({ now: () => 1100 });
  const lease = leases.acquire(session, { atMs: 1100 });
  return {
    nowMs: 1200,
    session,
    lease: { ...lease, held: true },
    chain: { id: 50312 },
    executionEnabled: true,
    account: { address: ACCOUNT, owner: OWNER, operator: OPERATOR, runtimeVerified: true },
    owner: { address: OWNER, verified: true },
    operator: { configuredAddress: OPERATOR, signerAddress: OPERATOR },
    capital: { collateralRaw: 500_000n },
    market: { marketId: MARKET, series: "BTC 5m", status: 1, valid: true, current: true, currentMarketId: MARKET },
    orders: { account: ACCOUNT, status: "VERIFIED", orders: [] },
    inventory: { account: ACCOUNT, status: "VERIFIED", yesRaw: 0n, noRaw: 0n },
    reconciliation: { status: "RECONCILED", pendingTransactions: 0, unknownTransactions: 0, unknownOrders: 0 },
    permissions: { requiresMarketApproval: true, marketApproved: true, requiresProtocolApproval: true, protocolPrepared: true },
    riskLimits: { valid: true },
    risk: { state: "ALLOW" },
    executionConfig: { minimumCollateralRaw: 1n, mode: "WET" },
  };
}

test("wet preflight passes only with every account, market, risk, lease, and reconciliation fact verified", () => {
  const result = evaluateWetExecutionPreflight(base());
  assert.equal(result.allowed, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.broadcast, false);
  assert.equal(result.account, ACCOUNT);
});

test("execution cannot arm while disabled, lease is absent, or session is not in PREFLIGHT", () => {
  const disabled = evaluateWetExecutionPreflight({ ...base(), executionEnabled: false });
  assert.equal(disabled.allowed, false);
  assert.ok(disabled.reasons.includes("EXECUTION_DISABLED"));
  const leaseMissing = evaluateWetExecutionPreflight({ ...base(), lease: { held: false } });
  assert.ok(leaseMissing.reasons.includes("ACCOUNT_LEASE_NOT_HELD"));
  const invalidState = evaluateWetExecutionPreflight({ ...base(), session: transitionLpSession(base().session, "ERROR", { atMs: 1200 }) });
  assert.ok(invalidState.reasons.includes("SESSION_STATE_INVALID"));
});

test("wrong signer/operator/owner and insufficient or over-capitalized accounts are denied", () => {
  const signer = evaluateWetExecutionPreflight({ ...base(), operator: { configuredAddress: OPERATOR, signerAddress: OWNER } });
  assert.ok(signer.reasons.includes("SIGNER_MISMATCH"));
  const operator = evaluateWetExecutionPreflight({ ...base(), account: { ...base().account, operator: OWNER } });
  assert.ok(operator.reasons.includes("OPERATOR_NOT_AUTHORIZED"));
  const owner = evaluateWetExecutionPreflight({ ...base(), owner: { address: OWNER, verified: false } });
  assert.ok(owner.reasons.includes("OWNER_NOT_VERIFIED"));
  const low = evaluateWetExecutionPreflight({ ...base(), capital: { collateralRaw: 0n } });
  assert.ok(low.reasons.includes("INSUFFICIENT_CAPITAL"));
  const high = evaluateWetExecutionPreflight({ ...base(), capital: { collateralRaw: DEFAULT_PHASE_3B1_CAPS.MAX_ACCOUNT_CAPITAL + 1n } });
  assert.ok(high.reasons.includes("ACCOUNT_CAPITAL_CAP"));
});

test("stale or resolved market and unverified orders/inventory block START", () => {
  const stale = evaluateWetExecutionPreflight({ ...base(), market: { ...base().market, marketId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } });
  assert.ok(stale.reasons.includes("STALE_MARKET_ID"));
  const series = evaluateWetExecutionPreflight({ ...base(), market: { ...base().market, series: "ETH 5m" } });
  assert.ok(series.reasons.includes("MARKET_SERIES_MISMATCH"));
  const closed = evaluateWetExecutionPreflight({ ...base(), market: { ...base().market, status: 2 } });
  assert.ok(closed.reasons.includes("MARKET_NOT_TRADING"));
  const orders = evaluateWetExecutionPreflight({ ...base(), orders: { account: ACCOUNT, status: "UNKNOWN", orders: [] } });
  assert.ok(orders.reasons.includes("OPEN_ORDER_STATE_UNKNOWN"));
  const inventory = evaluateWetExecutionPreflight({ ...base(), inventory: { account: ACCOUNT, status: "UNKNOWN" } });
  assert.ok(inventory.reasons.includes("INVENTORY_STATE_UNKNOWN"));
  const present = evaluateWetExecutionPreflight({ ...base(), orders: { account: ACCOUNT, status: "VERIFIED", orders: [{ owner: ACCOUNT, orderId: 1 }] } });
  assert.ok(present.reasons.includes("OPEN_ORDERS_PRESENT"));
});

test("pending or unknown transactions, unknown orders, risk HALT, and active duration block START", () => {
  const pending = evaluateWetExecutionPreflight({ ...base(), reconciliation: { status: "UNKNOWN", pendingTransactions: 1, unknownTransactions: 0, unknownOrders: 0 } });
  assert.ok(pending.reasons.includes("PENDING_TRANSACTION"));
  assert.ok(pending.reasons.includes("RECONCILIATION_REQUIRED"));
  const unknown = evaluateWetExecutionPreflight({ ...base(), reconciliation: { status: "UNKNOWN", pendingTransactions: 0, unknownTransactions: 1, unknownOrders: 1 } });
  assert.ok(unknown.reasons.includes("UNKNOWN_TRANSACTION"));
  assert.ok(unknown.reasons.includes("UNKNOWN_ORDER_STATE"));
  const halt = evaluateWetExecutionPreflight({ ...base(), risk: { state: "HALT" } });
  assert.ok(halt.reasons.includes("RISK_HALTED"));
  const duration = evaluateWetExecutionPreflight({ ...base(), nowMs: 901_001 });
  assert.ok(duration.reasons.includes("SESSION_DURATION_EXCEEDED"));
  const raisedCap = evaluateWetExecutionPreflight({ ...base(), caps: { MAX_ACCOUNT_CAPITAL: DEFAULT_PHASE_3B1_CAPS.MAX_ACCOUNT_CAPITAL + 1n } });
  assert.ok(raisedCap.reasons.includes("CAPS_INVALID"));
});
