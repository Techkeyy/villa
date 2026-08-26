import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EXECUTION_POLICY,
  applyVerificationCap,
  buyEscrowRaw,
  classifyOrderReconciliation,
  createExecutionSession,
  hypotheticalSecondOrderAllowed,
  preflightOrder,
  recordExecutionEvent,
  sellEscrowRaw,
  sessionCleanupOrderIds,
  targetFromPlan,
  trackCreatedOrder,
} from "./policy.mjs";
import { burnableMintedAmount } from "../inventory-lifecycle/index.mjs";

const ONE = 1_000_000n;

function baseInput(overrides = {}) {
  const base = {
    nowMs: 1_000,
    capturedAtMs: 1_000,
    chainNowSec: 100,
    market: { status: 1, expirySec: 200 },
    feed: { price: 78_000, timestampSec: 100, sourceAgeSec: 1 },
    openOrdersStatus: "VERIFIED",
    governor: { state: "ALLOW", permissions: { allowedActions: ["BUY_YES", "SELL_YES"] } },
    sidePlan: { enabled: true, action: "BUY_YES", targetPriceRaw: "600000", targetQuantityRaw: "1000" },
    intent: { action: "BUY_YES", priceRaw: 600_000n, quantityRaw: 1_000n },
    verificationCapRaw: 1_000n,
    grid: { oneRaw: "1000000", tickSizeRaw: "1000", lotSizeRaw: "1000", minQuantityRaw: "1000" },
    book: { bestBidRaw: "500000", bestAskRaw: "800000" },
    availableYesRaw: 0n,
    collateralAvailableRaw: 100_000_000n,
    collateralReserveRaw: 1_000_000n,
  };
  return {
    ...base,
    ...overrides,
    market: { ...base.market, ...(overrides.market ?? {}) },
    feed: { ...base.feed, ...(overrides.feed ?? {}) },
    governor: { ...base.governor, ...(overrides.governor ?? {}), permissions: { ...base.governor.permissions, ...(overrides.governor?.permissions ?? {}) } },
    sidePlan: { ...base.sidePlan, ...(overrides.sidePlan ?? {}) },
    intent: { ...base.intent, ...(overrides.intent ?? {}) },
    grid: { ...base.grid, ...(overrides.grid ?? {}) },
    book: { ...base.book, ...(overrides.book ?? {}) },
  };
}

const plan = {
  bid: { enabled: true, action: "BUY_YES", targetPriceRaw: "600000", targetQuantityRaw: "5000" },
  ask: { enabled: true, action: "SELL_YES", targetPriceRaw: "700000", targetQuantityRaw: "5000" },
};

const expectedBid = { orderId: "11", action: "BUY_YES", priceRaw: 600_000n, quantityRaw: 1_000n };

test("HALT policy refuses every order before a writer is reachable", () => {
  const result = preflightOrder(baseInput({ governor: { state: "HALT", permissions: { allowedActions: [] } } }));
  assert.equal(result.allowed, false);
  assert.equal(result.code, "GOVERNOR_HALT");
});

test("NO_QUOTE side is converted to a disabled target", () => {
  const result = targetFromPlan({ ...plan, ask: { enabled: false, skipReason: "NO_SELL_INVENTORY" } }, "ask", 1_000n);
  assert.deepEqual(result, { enabled: false, reason: "NO_SELL_INVENTORY" });
});

test("stale decisions fail closed", () => {
  const result = preflightOrder(baseInput({ nowMs: 7_001 }));
  assert.equal(result.code, "DECISION_STALE");
});

test("non-Trading markets fail closed", () => {
  const result = preflightOrder(baseInput({ market: { status: 2 } }));
  assert.equal(result.code, "MARKET_NOT_TRADING");
});

test("unsafe expiry headroom refuses a target", () => {
  const result = preflightOrder(baseInput({ market: { expirySec: 129 } }));
  assert.equal(result.code, "EXPIRY_UNSAFE");
});

test("stale feed refuses a target", () => {
  const result = preflightOrder(baseInput({ feed: { timestampSec: 80 } }));
  assert.equal(result.code, "FEED_STALE");
});

test("small feed timestamp lead is accepted within the clock-skew tolerance", () => {
  assert.equal(preflightOrder(baseInput({ feed: { timestampSec: 104 } })).allowed, true);
  assert.equal(preflightOrder(baseInput({ feed: { timestampSec: 110 } })).code, "FEED_INVALID");
});

test("underlying feed prices are positive prices, not probabilities", () => {
  assert.equal(preflightOrder(baseInput()).allowed, true);
  assert.equal(preflightOrder(baseInput({ feed: { price: 0 } })).code, "FEED_INVALID");
});

test("ambiguous open-order reads refuse a target", () => {
  const result = preflightOrder(baseInput({ openOrdersStatus: "AMBIGUOUS" }));
  assert.equal(result.code, "OPEN_ORDER_STATE_INVALID");
});

test("governor action permissions are enforced", () => {
  const result = preflightOrder(baseInput({ governor: { permissions: { allowedActions: ["SELL_YES"] } } }));
  assert.equal(result.code, "ACTION_NOT_PERMITTED");
});

test("disabled planner sides cannot be revived by execution", () => {
  const result = preflightOrder(baseInput({ sidePlan: { enabled: false, action: "BUY_YES" } }));
  assert.equal(result.code, "PLAN_SIDE_DISABLED");
});

test("the verification cap can only reduce quantity", () => {
  assert.equal(applyVerificationCap({ plannerQuantityRaw: 5_000n, verificationCapRaw: 1_000n }), 1_000n);
  assert.equal(applyVerificationCap({ plannerQuantityRaw: 500n, verificationCapRaw: 1_000n }), 500n);
});

test("execution rejects quantity above the planner target", () => {
  const result = preflightOrder(baseInput({ intent: { quantityRaw: 2_000n } }));
  assert.equal(result.code, "QUANTITY_EXCEEDS_PLAN");
});

test("execution rejects quantity above the cap", () => {
  const result = preflightOrder(baseInput({ sidePlan: { targetQuantityRaw: "5000" }, intent: { quantityRaw: 2_000n } }));
  assert.equal(result.code, "QUANTITY_EXCEEDS_CAP");
});

test("off-grid price and quantity are refused", () => {
  assert.equal(preflightOrder(baseInput({ intent: { priceRaw: 600_500n } })).code, "GRID_INVALID");
  assert.equal(preflightOrder(baseInput({ verificationCapRaw: null, sidePlan: { targetQuantityRaw: "2000" }, intent: { quantityRaw: 1_001n } })).code, "GRID_INVALID");
});

test("invalid book ordering is refused", () => {
  const result = preflightOrder(baseInput({ book: { bestBidRaw: "800000", bestAskRaw: "700000" } }));
  assert.equal(result.code, "BOOK_INVALID");
});

test("a BUY target that reaches the ask is refused as post-only unsafe", () => {
  const result = preflightOrder(baseInput({ intent: { priceRaw: 800_000n }, sidePlan: { targetPriceRaw: "800000" } }));
  assert.equal(result.code, "POST_ONLY_WOULD_CROSS");
});

test("a SELL target that reaches the bid is refused as post-only unsafe", () => {
  const result = preflightOrder(baseInput({
    sidePlan: { action: "SELL_YES", targetPriceRaw: "700000", targetQuantityRaw: "1000" },
    intent: { action: "SELL_YES", priceRaw: 500_000n },
    availableYesRaw: 1_000n,
  }));
  assert.equal(result.code, "POST_ONLY_WOULD_CROSS");
});

test("SELL requires visible YES inventory", () => {
  const result = preflightOrder(baseInput({
    sidePlan: { action: "SELL_YES", targetPriceRaw: "700000", targetQuantityRaw: "1000" },
    intent: { action: "SELL_YES", priceRaw: 700_000n },
  }));
  assert.equal(result.code, "INVENTORY_INSUFFICIENT");
});

test("BUY requires collateral escrow plus reserve", () => {
  const result = preflightOrder(baseInput({ collateralAvailableRaw: 1_000_599n }));
  assert.equal(result.code, "COLLATERAL_INSUFFICIENT");
});

test("allowed BUY preflight returns exact ceil escrow", () => {
  const result = preflightOrder(baseInput());
  assert.equal(result.allowed, true);
  assert.equal(result.escrowRaw, 600n);
});

test("allowed SELL preflight returns exact token escrow", () => {
  const result = preflightOrder(baseInput({
    sidePlan: { action: "SELL_YES", targetPriceRaw: "700000", targetQuantityRaw: "1000" },
    intent: { action: "SELL_YES", priceRaw: 700_000n },
    availableYesRaw: 1_000n,
  }));
  assert.equal(result.allowed, true);
  assert.equal(result.escrowRaw, 1_000n);
});

test("escrow helpers are unit-exact", () => {
  assert.equal(buyEscrowRaw({ priceRaw: 600_001n, quantityRaw: 1_000n, oneRaw: ONE }), 601n);
  assert.equal(sellEscrowRaw({ quantityRaw: 1_000n }), 1_000n);
});

test("verification cap preserves planner price", () => {
  const target = targetFromPlan(plan, "bid", 1_000n);
  assert.equal(target.plannerPriceRaw, 600_000n);
  assert.equal(target.quantityRaw, 1_000n);
});

test("execution session tracks a unique bounded order set", () => {
  let session = createExecutionSession({ sessionId: "s-1", marketId: "m-1", verificationCapRaw: 1_000n, maxOrders: 2 });
  session = trackCreatedOrder(session, { orderId: 11n, pool: "0xpool", action: "SELL_YES", priceRaw: 700_000n, quantityRaw: 1_000n });
  session = trackCreatedOrder(session, { orderId: 12n, pool: "0xpool", action: "BUY_YES", priceRaw: 600_000n, quantityRaw: 1_000n });
  assert.deepEqual(sessionCleanupOrderIds(session, ["12", "99", "11"]), ["11", "12"]);
  assert.throws(() => trackCreatedOrder(session, { orderId: 13n, pool: "0xpool", action: "BUY_YES", priceRaw: 500_000n, quantityRaw: 1_000n }), /session limit/);
});

test("session events retain structured facts and session identity", () => {
  let session = createExecutionSession({ sessionId: "s-2", marketId: "m-2" });
  session = recordExecutionEvent(session, "TEST_EVENT", { quantityRaw: 1_000n }, 42);
  assert.equal(session.events[0].sessionId, "s-2");
  assert.equal(session.events[0].facts.quantityRaw, 1_000n);
});

test("on-chain active order is RESTING when fields match", () => {
  assert.equal(classifyOrderReconciliation({ expected: expectedBid, onchain: { price: 600_000n, quantityRemaining: 1_000n, isBid: true } }), "RESTING");
});

test("partial fill is distinguished from a resting untouched order", () => {
  assert.equal(classifyOrderReconciliation({ expected: expectedBid, onchain: { price: 600_000n, quantityRemaining: 500n, isBid: true }, fillsRaw: 500n }), "PARTIALLY_FILLED");
});

test("full fill is distinguished when on-chain remainder is zero", () => {
  assert.equal(classifyOrderReconciliation({ expected: expectedBid, onchain: { price: 600_000n, quantityRemaining: 0n, isBid: true }, fillsRaw: 1_000n }), "FILLED");
});

test("exact cancellation is recognized only after on-chain removal", () => {
  assert.equal(classifyOrderReconciliation({ expected: expectedBid, onchain: null, indexed: null, cancelRequested: true }), "CANCELLED");
  assert.equal(classifyOrderReconciliation({ expected: expectedBid, onchain: { price: 600_000n, quantityRemaining: 1_000n, isBid: true }, cancelRequested: true }), "RESTING");
});

test("receipt success without on-chain evidence remains UNKNOWN", () => {
  assert.equal(classifyOrderReconciliation({ expected: expectedBid, onchain: null, indexed: null }), "UNKNOWN");
});

test("contradictory indexer and chain fields remain UNKNOWN", () => {
  assert.equal(classifyOrderReconciliation({ expected: expectedBid, onchain: { price: 600_000n, quantityRemaining: 1_000n, isBid: true }, indexed: { side: "BUY", remainingQtyRaw: "900" } }), "UNKNOWN");
});

test("a malformed on-chain remainder remains UNKNOWN", () => {
  assert.equal(classifyOrderReconciliation({ expected: expectedBid, onchain: { price: 600_000n, quantityRemaining: "not-raw", isBid: true } }), "UNKNOWN");
});

test("second order is allowed only from the fresh plan and governor permission", () => {
  assert.equal(hypotheticalSecondOrderAllowed({ governor: { permissions: { allowedActions: ["BUY_YES", "SELL_YES"] } }, plan, side: "bid" }).allowed, true);
  assert.equal(hypotheticalSecondOrderAllowed({ governor: { permissions: { allowedActions: ["SELL_YES"] } }, plan, side: "bid" }).allowed, false);
  assert.equal(hypotheticalSecondOrderAllowed({ governor: { permissions: { allowedActions: ["BUY_YES"] } }, plan: { ...plan, bid: { enabled: false, skipReason: "RISK_HEADROOM" } }, side: "bid" }).allowed, false);
});

test("burnable cleanup is exact and refuses an unmatched pair", () => {
  assert.equal(burnableMintedAmount({ baselineYesRaw: 0n, baselineNoRaw: 0n, currentYesRaw: 1_000n, currentNoRaw: 1_000n, mintedAmountRaw: 1_000n }), 1_000n);
  assert.throws(() => burnableMintedAmount({ baselineYesRaw: 0n, baselineNoRaw: 0n, currentYesRaw: 0n, currentNoRaw: 1_000n, mintedAmountRaw: 1_000n }), /INCOMPLETE_SET|complete sets/);
});

test("policy output is deterministic for identical input", () => {
  const input = baseInput();
  assert.deepEqual(preflightOrder(input, DEFAULT_EXECUTION_POLICY), preflightOrder(structuredClone(input), DEFAULT_EXECUTION_POLICY));
});
