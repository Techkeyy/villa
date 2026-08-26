import test from "node:test";
import assert from "node:assert/strict";
import {
  CONFIGURED_SERIES,
  DEFAULT_ORCHESTRATOR_CONFIG,
  ORCHESTRATOR_EVENTS,
  ORCHESTRATOR_VERSION,
  assertCommittedCollateralCap,
  assertConfiguredSeries,
  assertExposureCap,
  assertJournalSecretFree,
  assertKnownReconciliation,
  assertProvisioningCap,
  assertRestingOrderCap,
  capPlannerQuantity,
  closeMarket,
  createOrchestratorState,
  deriveCycleActions,
  emitEvent,
  initializeMarket,
  incrementTransactionBudget,
  journalFromState,
  marketContext,
  orderExpirySeconds,
  pairedInventory,
  provisioningRequired,
  recordBurn,
  recordCycle,
  recordGas,
  recordMint,
  recordOrderOutcome,
  recordSafeReconciliation,
  recordSettlementPosition,
  reconcileJournal,
  seriesIdentity,
  sessionElapsed,
  setHalted,
  setWaitingForMarket,
  setWaitingForSuccessor,
  shouldRequote,
  shouldStopQuoting,
  stateScopeAudit,
  trackOrder,
  validateOrchestratorConfig,
} from "./index.mjs";
import { createSerializedWriteQueue } from "../execution/write-queue.mjs";
import { assertPlanMarketBound, preflightOrder } from "../execution/policy.mjs";

function context(id = "A", intervalSec = 300, expirySec = 1_000) {
  return marketContext({
    marketId: id,
    series: seriesIdentity({ asset: "BTC", intervalSec }),
    expirySec,
    status: 1,
    yesId: `${id}-yes`,
    noId: `${id}-no`,
    reference: { status: "VALID", source: "strike", price: 100 },
    pool: `${id}-pool`,
    venueId: "venue-a",
  });
}

function state() {
  return createOrchestratorState({ sessionId: "session-1", startedChainSec: 100 });
}

function plan({ bid = true, ask = true, bidPrice = "400000", askPrice = "600000", bidQuantity = "1000", askQuantity = "1000", marketId = "A" } = {}) {
  return {
    marketId,
    plan: bid && ask ? "ACTIVE" : bid || ask ? "ONE_SIDED" : "NO_QUOTE",
    reasonCodes: [],
    bid: { enabled: bid, action: "BUY_YES", targetPriceRaw: bidPrice, targetQuantityRaw: bidQuantity, skipReason: bid ? null : "ACTION_NOT_PERMITTED" },
    ask: { enabled: ask, action: "SELL_YES", targetPriceRaw: askPrice, targetQuantityRaw: askQuantity, skipReason: ask ? null : "NO_SELL_INVENTORY" },
  };
}

function governor(stateName = "ALLOW") {
  return { state: stateName, primaryReasonCode: stateName === "HALT" ? "PRICE_STALE" : "NONE", permissions: { allowedActions: stateName === "HALT" ? [] : ["BUY_YES", "SELL_YES"] } };
}

test("1. orchestrator starts on the configured series only", () => {
  const config = validateOrchestratorConfig();
  assert.deepEqual(config.series, CONFIGURED_SERIES);
  assert.equal(config.version, ORCHESTRATOR_VERSION);
});

test("2. wrong interval is never selected", () => {
  assert.throws(() => assertConfiguredSeries(seriesIdentity({ asset: "BTC", intervalSec: 60 })), /configured series/);
});

test("3. HALT produces no placement actions", () => {
  const result = deriveCycleActions({ plan: plan(), governor: governor("HALT"), currentOrders: [], inventory: { yesRaw: 0n }, minQuantityRaw: 1000n, chainNowSec: 100, expirySec: 1_000 });
  assert.deepEqual(result.actions, []);
  assert.equal(result.state, "HALTED");
});

test("4. HALT cancels eligible resting session orders", () => {
  const result = deriveCycleActions({ plan: plan(), governor: governor("HALT"), currentOrders: [{ action: "BUY_YES", orderId: "1" }], inventory: { yesRaw: 0n }, minQuantityRaw: 1000n, chainNowSec: 100, expirySec: 1_000 });
  assert.deepEqual(result.actions, [{ type: "CANCEL_ALL", reason: "GOVERNOR_HALT" }]);
});

test("5. NO_QUOTE waits without market fallback", () => {
  const result = deriveCycleActions({ plan: plan({ bid: false, ask: false }), governor: governor(), currentOrders: [], inventory: { yesRaw: 0n }, minQuantityRaw: 1000n, chainNowSec: 100, expirySec: 1_000 });
  assert.equal(result.state, "NO_QUOTE");
  assert.deepEqual(result.actions, []);
});

test("6. ALLOW can create planner-derived quote actions", () => {
  const result = deriveCycleActions({ plan: plan(), governor: governor(), currentOrders: [], inventory: { yesRaw: 1000n }, minQuantityRaw: 1000n, chainNowSec: 100, expirySec: 1_000, tickSizeRaw: 1000 });
  assert.deepEqual(result.actions.map((item) => item.type), ["PLACE", "PLACE"]);
  assert.deepEqual(result.actions.map((item) => item.action), ["SELL_YES", "BUY_YES"]);
});

test("7. inventory provisioning occurs only when the ask requires current YES", () => {
  assert.equal(provisioningRequired({ plan: plan({ ask: false }), yesRaw: 0n, minQuantityRaw: 1000n }), true);
  assert.equal(provisioningRequired({ plan: plan({ ask: false }), yesRaw: 1000n, minQuantityRaw: 1000n }), false);
});

test("8. adequate current-market inventory prevents repeated mint", () => {
  const result = deriveCycleActions({ plan: plan({ ask: false }), governor: governor(), currentOrders: [], inventory: { yesRaw: 1000n }, minQuantityRaw: 1000n, chainNowSec: 100, expirySec: 1_000 });
  assert.equal(result.actions.some((item) => item.type === "MINT_MINIMUM"), false);
});

test("9. post-mint state is represented as a new cycle input", () => {
  let current = state();
  current = initializeMarket(current, context(), 101);
  const before = recordCycle(current, { chainNowSec: 102, pipeline: { plan: plan({ ask: false }), decision: governor(), inventory: { yesRaw: 0n, noRaw: 0n }, snapshot: { fairValue: { pUp: 0.5 } } } });
  const after = recordCycle(before, { chainNowSec: 103, pipeline: { plan: plan(), decision: governor(), inventory: { yesRaw: 1000n, noRaw: 1000n }, snapshot: { fairValue: { pUp: 0.5 } } } });
  assert.notDeepEqual(before.previousInventory, after.previousInventory);
  assert.equal(after.cycle, 2);
});

test("10. tiny quote changes are suppressed by hysteresis", () => {
  const result = shouldRequote({ previousPlan: plan({ bidPrice: "400000" }), currentPlan: plan({ bidPrice: "401000" }), currentOrders: [{ side: "bid", action: "BUY_YES", priceRaw: "400000", quantityRaw: "1000" }, { side: "ask", action: "SELL_YES", priceRaw: "600000", quantityRaw: "1000" }], previousGovernor: governor(), currentGovernor: governor(), previousInventory: { yesRaw: 1000n }, currentInventory: { yesRaw: 1000n }, chainNowSec: 100, oldestOrderChainSec: 100, policy: { tickSizeRaw: 1000, minRequoteTicks: 2 } });
  assert.equal(result.requote, false);
  assert.equal(result.reason, "HYSTERESIS_HOLDS");
});

test("11. meaningful price movement triggers replan", () => {
  const result = shouldRequote({ previousPlan: plan({ bidPrice: "400000" }), currentPlan: plan({ bidPrice: "402000" }), currentOrders: [{ side: "bid", action: "BUY_YES", priceRaw: "400000", quantityRaw: "1000" }, { side: "ask", action: "SELL_YES", priceRaw: "600000", quantityRaw: "1000" }], previousGovernor: governor(), currentGovernor: governor(), previousInventory: { yesRaw: 1000n }, currentInventory: { yesRaw: 1000n }, chainNowSec: 100, oldestOrderChainSec: 100, policy: { tickSizeRaw: 1000, minRequoteTicks: 2 } });
  assert.equal(result.requote, true);
});

test("12. inventory change triggers replan", () => {
  const result = shouldRequote({ previousPlan: plan(), currentPlan: plan(), currentOrders: [{ side: "bid", action: "BUY_YES", priceRaw: "400000", quantityRaw: "1000" }, { side: "ask", action: "SELL_YES", priceRaw: "600000", quantityRaw: "1000" }], previousGovernor: governor(), currentGovernor: governor(), previousInventory: { yesRaw: 1000n }, currentInventory: { yesRaw: 0n }, chainNowSec: 100, oldestOrderChainSec: 100, policy: { tickSizeRaw: 1000 } });
  assert.equal(result.reason, "INVENTORY_CHANGED");
});

test("13. governor change triggers replan", () => {
  const result = shouldRequote({ previousPlan: plan(), currentPlan: plan(), currentOrders: [{ side: "bid", action: "BUY_YES", priceRaw: "400000", quantityRaw: "1000" }, { side: "ask", action: "SELL_YES", priceRaw: "600000", quantityRaw: "1000" }], previousGovernor: governor(), currentGovernor: governor("REDUCE_ONLY"), previousInventory: { yesRaw: 1000n }, currentInventory: { yesRaw: 1000n }, chainNowSec: 100, oldestOrderChainSec: 100, policy: { tickSizeRaw: 1000 } });
  assert.equal(result.reason, "GOVERNOR_CHANGED");
});

test("14. stale feed governor state produces quote cancellation", () => {
  const result = deriveCycleActions({ plan: plan(), governor: governor("HALT"), currentOrders: [{ action: "BUY_YES", orderId: "1" }], inventory: { yesRaw: 1000n }, minQuantityRaw: 1000n, chainNowSec: 100, expirySec: 1_000 });
  assert.equal(result.actions[0].type, "CANCEL_ALL");
});

test("15. stale chain state governor state produces no placement", () => {
  const result = deriveCycleActions({ plan: plan(), governor: governor("HALT"), currentOrders: [], inventory: { yesRaw: 1000n }, minQuantityRaw: 1000n, chainNowSec: 100, expirySec: 1_000 });
  assert.equal(result.actions.some((item) => item.type === "PLACE"), false);
});

test("16. market status change is represented by HALT", () => {
  const halted = setHalted(state(), "MARKET_NOT_TRADING", { status: 4 }, 200);
  assert.equal(halted.state, "HALTED");
  assert.equal(halted.events.at(-1).facts.reason, "MARKET_NOT_TRADING");
});

test("17. expiry headroom removes quotes", () => {
  const result = deriveCycleActions({ plan: plan(), governor: governor(), currentOrders: [{ action: "BUY_YES", orderId: "1" }], inventory: { yesRaw: 1000n }, minQuantityRaw: 1000n, chainNowSec: 910, expirySec: 1_000 });
  assert.equal(result.state, "STOPPING");
  assert.equal(result.actions[0].type, "CANCEL_ALL");
});

test("18. post-only preflight blocks a stale crossing quote", () => {
  const result = preflightOrder({ nowMs: 101, capturedAtMs: 100, chainNowSec: 100, market: { status: 1, expirySec: 1_000 }, feed: { price: 100, timestampSec: 100, sourceAgeSec: 0 }, openOrdersStatus: "VERIFIED", governor: governor(), sidePlan: { enabled: true, action: "BUY_YES", targetPriceRaw: "600000", targetQuantityRaw: "1000" }, intent: { action: "BUY_YES", priceRaw: "600000", quantityRaw: "1000" }, grid: { oneRaw: "1000000", tickSizeRaw: "1000", lotSizeRaw: "1000", minQuantityRaw: "1000" }, book: { bestBidRaw: "500000", bestAskRaw: "550000" }, availableYesRaw: "0", collateralAvailableRaw: "1000000", collateralReserveRaw: "0" });
  assert.equal(result.code, "POST_ONLY_WOULD_CROSS");
});

test("19. PostOnlyWouldCross has no taker fallback in the action policy", () => {
  const result = deriveCycleActions({ plan: plan(), governor: governor(), currentOrders: [], inventory: { yesRaw: 1000n }, minQuantityRaw: 1000n, chainNowSec: 100, expirySec: 1_000 });
  assert.equal(result.actions.every((item) => item.type !== "TAKER"), true);
});

test("20. first resting order leaves the missing second side actionable", () => {
  const result = deriveCycleActions({ plan: plan(), governor: governor(), currentOrders: [{ side: "ask", action: "SELL_YES", priceRaw: "600000", quantityRaw: "1000" }], inventory: { yesRaw: 1000n }, minQuantityRaw: 1000n, chainNowSec: 100, expirySec: 1_000 });
  assert.equal(result.actions.some((item) => item.type === "PLACE" && item.side === "bid"), true);
});

test("21. order reconciliation can record RESTING", () => {
  let current = initializeMarket(state(), context(), 101);
  current = trackOrder(current, { orderId: "1", action: "BUY_YES", side: "bid", priceRaw: "400000", quantityRaw: "1000" }, 102);
  const updated = recordOrderOutcome(current, { orderId: "1" }, "RESTING", { remainingRaw: "1000" }, 103);
  assert.equal(updated.events.at(-1).type, "INVENTORY_RECONCILED");
  assert.equal(updated.restingOrders.length, 1);
});

test("22. partial fill records actual remaining quantity", () => {
  let current = initializeMarket(state(), context(), 101);
  current = trackOrder(current, { orderId: "1", action: "BUY_YES", side: "bid", priceRaw: "400000", quantityRaw: "1000" }, 102);
  const updated = recordOrderOutcome(current, { orderId: "1" }, "PARTIALLY_FILLED", { filledRaw: "400", remainingRaw: "600" }, 103);
  assert.equal(updated.events.at(-1).facts.remainingRaw, "600");
  assert.equal(updated.accounting.fills[0].filledRaw, "400");
});

test("23. full fill records fill facts and removes the resting order", () => {
  let current = initializeMarket(state(), context(), 101);
  current = trackOrder(current, { orderId: "1", action: "BUY_YES", side: "bid", priceRaw: "400000", quantityRaw: "1000" }, 102);
  const updated = recordOrderOutcome(current, { orderId: "1" }, "FILLED", { filledRaw: "1000", remainingRaw: "0" }, 103);
  assert.equal(updated.restingOrders.length, 0);
  assert.equal(updated.events.at(-1).type, "ORDER_FILLED");
});

test("24. a fill changes inventory and therefore causes re-evaluation", () => {
  const result = shouldRequote({ previousPlan: plan(), currentPlan: plan(), currentOrders: [{ side: "bid", action: "BUY_YES", priceRaw: "400000", quantityRaw: "1000" }, { side: "ask", action: "SELL_YES", priceRaw: "600000", quantityRaw: "1000" }], previousGovernor: governor(), currentGovernor: governor(), previousInventory: { yesRaw: 1000n, noRaw: 1000n }, currentInventory: { yesRaw: 1400n, noRaw: 1000n }, chainNowSec: 100, oldestOrderChainSec: 100, policy: { tickSizeRaw: 1000 } });
  assert.equal(result.reason, "INVENTORY_CHANGED");
});

test("25. fill exposure cannot exceed the verification cap", () => {
  assert.throws(() => assertExposureCap({ yesRaw: 2000n, noRaw: 0n, decimals: 6 }), /directional exposure/);
});

test("26. unknown fill reconciliation fails closed", () => {
  assert.throws(() => assertKnownReconciliation("UNKNOWN"), /reconciliation/);
});

test("27. paired inventory uses min YES/NO", () => {
  assert.deepEqual(pairedInventory({ yesRaw: 1200n, noRaw: 1000n }), { pairedRaw: 1000n, directionalResidualRaw: 200n });
});

test("28. unmatched directional inventory is preserved", () => {
  const result = pairedInventory({ yesRaw: 0n, noRaw: 1000n });
  assert.equal(result.pairedRaw, 0n);
  assert.equal(result.directionalResidualRaw, -1000n);
});

test("29. old-market outcome residual is excluded from current scope", () => {
  let current = initializeMarket(state(), context("B"), 101);
  const audit = stateScopeAudit({ state: current, currentMarketId: "B", currentOutcomeIds: { yes: "B-yes", no: "B-no" }, oldOutcomeIds: { yes: "A-yes", no: "A-no" } });
  assert.equal(audit.marketBound, true);
  assert.equal(audit.oldOutcomeIdsExcluded, true);
});

test("30. market close starts rollover", () => {
  let current = initializeMarket(state(), context("A"), 101);
  current = closeMarket(current, { chainNowSec: 200, status: "RESOLVED", inventory: { yesRaw: 0n, noRaw: 1000n } });
  assert.equal(current.state, "MARKET_CLOSED");
  assert.equal(current.settlementRecords[0].marketId, "A");
});

test("31. successor preserves configured interval", () => {
  let current = closeMarket(initializeMarket(state(), context("A"), 101), { chainNowSec: 200 });
  current = initializeMarket(current, context("B", 300, 1_300), 201);
  assert.equal(current.currentMarket.series.key, "BINARY:BTC:300");
});

test("32. no successor enters waiting state", () => {
  const current = setWaitingForSuccessor(state(), { reason: "NO_VALID_SUCCESSOR" }, 200);
  assert.equal(current.state, "WAITING_FOR_SUCCESSOR");
});

test("33. successor initializes a fresh reference", () => {
  let current = initializeMarket(state(), context("A"), 101);
  current = closeMarket(current, { chainNowSec: 200 });
  current = initializeMarket(current, context("B", 300, 1_300), 201);
  assert.equal(current.currentMarket.reference.price, 100);
  assert.notEqual(current.currentMarket.marketId, "A");
});

test("34. successor initializes fresh token IDs", () => {
  let current = initializeMarket(state(), context("A"), 101);
  current = closeMarket(current, { chainNowSec: 200 });
  current = initializeMarket(current, context("B", 300, 1_300), 201);
  assert.equal(current.currentMarket.yesId, "B-yes");
  assert.equal(current.currentMarket.noId, "B-no");
});

test("35. old quote plan is rejected after rollover", () => {
  assert.throws(() => assertPlanMarketBound({ marketId: "A" }, "B"), /different market/);
});

test("36. A settlement can coexist with B", () => {
  let current = initializeMarket(state(), context("A"), 101);
  current = closeMarket(current, { chainNowSec: 200, status: "RESOLVED" });
  current = initializeMarket(current, context("B", 300, 1_300), 201);
  assert.equal(current.currentMarket.marketId, "B");
  assert.equal(current.settlementRecords[0].marketId, "A");
});

test("37. claim sweep does not make a zero-value residual redeemable", () => {
  let current = initializeMarket(state(), context("A"), 101);
  current = recordSettlementPosition(current, { marketId: "old", status: "KNOWN_ZERO_VALUE_SETTLED_RESIDUAL", noRaw: 1000n }, 102);
  assert.equal(current.settlementRecords[0].status, "KNOWN_ZERO_VALUE_SETTLED_RESIDUAL");
});

test("38. duplicate settlement tracking is idempotent", () => {
  let current = recordSettlementPosition(state(), { marketId: "A", status: "TRACKED" }, 101);
  current = recordSettlementPosition(current, { marketId: "A", status: "TRACKED" }, 102);
  assert.equal(current.settlementRecords.length, 1);
});

test("39. all writes through the queue are serialized", async () => {
  const order = [];
  const queue = createSerializedWriteQueue(async (label, operation) => { order.push(`start:${label}`); const result = await operation(); order.push(`end:${label}`); return result; });
  await Promise.all([queue.enqueue("a", async () => { await new Promise((resolve) => setTimeout(resolve, 2)); return "a"; }), queue.enqueue("b", async () => "b")]);
  assert.deepEqual(order, ["start:a", "end:a", "start:b", "end:b"]);
  queue.close();
});

test("40. transaction budget is enforced", () => {
  let current = state();
  current = { ...current, caps: { ...current.caps, transactionsUsed: current.config.maxTransactions } };
  assert.throws(() => incrementTransactionBudget(current), /transaction budget/);
});

test("41. replacement budget is represented in state", () => {
  const current = state();
  assert.equal(current.caps.orderReplacements, 0);
  assert.equal(current.config.maxOrderReplacements, 2);
});

test("42. market-count cap is enforced", () => {
  let current = state();
  current = initializeMarket(current, context("A"), 101);
  current = closeMarket(current, { chainNowSec: 200 });
  current = initializeMarket(current, context("B", 300, 1_300), 201);
  current = closeMarket(current, { chainNowSec: 400 });
  current = initializeMarket(current, context("C", 300, 1_600), 401);
  current = closeMarket(current, { chainNowSec: 700 });
  const limited = initializeMarket(current, context("D", 300, 1_900), 701);
  assert.equal(limited.state, "SESSION_LIMIT_REACHED");
});

test("43. session-duration cap is enforced", () => {
  assert.equal(sessionElapsed({ startedChainSec: 100, chainNowSec: 820 }).exceeded, true);
});

test("44. capital cap is enforced", () => {
  assert.throws(() => assertCommittedCollateralCap({ mintRaw: 1500n, buyEscrowRaw: 1000n, decimals: 6 }), /committed collateral/);
});

test("45. directional-exposure cap is enforced", () => {
  assert.throws(() => assertExposureCap({ yesRaw: 1000n, noRaw: 0n, decimals: 6, config: { ...DEFAULT_ORCHESTRATOR_CONFIG, maxDirectionalExposureHuman: 0.0005 } }), /directional exposure/);
});

test("46. verification cap only reduces planner quantity", () => {
  assert.equal(capPlannerQuantity({ plannerQuantityRaw: 3000n, capRaw: 1000n }), 1000n);
  assert.equal(capPlannerQuantity({ plannerQuantityRaw: 500n, capRaw: 1000n }), 500n);
});

test("47. journal contains no secrets", () => {
  const journal = journalFromState(state());
  assertJournalSecretFree(journal);
  assert.equal(Object.hasOwn(journal, "privateKey"), false);
});

test("48. restart uses chain truth over stale journal order state", () => {
  const journal = journalFromState({ ...state(), knownOrderIds: ["stale"], currentMarket: context("A") });
  const resumed = reconcileJournal(journal, { marketId: "A", activeOrderIds: [], state: "ACTIVE", lastSafeReconciliation: { chainNowSec: 200, orderIds: [] } });
  assert.deepEqual(resumed.activeKnownOrderIds, []);
  assert.equal(resumed.reconciliationAuthority, "CHAIN_WALLET_ORDER_STATE");
});

test("49. restart does not duplicate a mint", () => {
  const journal = journalFromState({ ...state(), caps: { ...state().caps, mints: 1 }, temporaryMintByMarket: { A: 1000n } });
  const resumed = reconcileJournal(journal, { state: "ACTIVE" });
  assert.equal(resumed.temporaryMintQuantities.A, 1000n);
});

test("50. restart does not duplicate an order", () => {
  const journal = journalFromState({ ...state(), knownOrderIds: ["1"] });
  const resumed = reconcileJournal(journal, { activeOrderIds: ["1"], state: "ACTIVE" });
  assert.deepEqual(resumed.activeKnownOrderIds, ["1"]);
});

test("51. restart does not duplicate redeem records", () => {
  const journal = journalFromState({ ...state(), settlementRecords: [{ marketId: "A", status: "REDEEM_CONFIRMED" }] });
  const resumed = reconcileJournal(journal, { state: "ACTIVE" });
  assert.equal(resumed.settlementRecords.length, 1);
});

test("52. same state/action inputs remain deterministic", () => {
  const input = { plan: plan(), governor: governor(), currentOrders: [], inventory: { yesRaw: 1000n }, minQuantityRaw: 1000n, chainNowSec: 100, expirySec: 1_000, tickSizeRaw: 1000 };
  assert.deepEqual(deriveCycleActions(input), deriveCycleActions(input));
});

test("53. final cleanup detects stranded orders", () => {
  const current = initializeMarket(state(), context("A"), 101);
  assert.throws(() => closeMarket(current, { chainNowSec: 200, openOrders: [{ orderId: "1" }] }), /active current-session orders/);
});

test("54. clean no-fill session restores temporary paired collateral", () => {
  let current = initializeMarket(state(), context("A"), 101);
  current = recordMint(current, 1000n, {}, 102);
  current = recordBurn(current, 1000n, {}, 103);
  assert.equal(current.accounting.mintCollateralRaw, current.accounting.burnReturnsRaw);
});

test("55. accounting keeps STT gas separate from tUSDC", () => {
  let current = recordGas(state(), 123n, 101);
  current = recordMint(current, 1000n, {}, 102);
  assert.equal(current.accounting.gasWei, 123n);
  assert.equal(current.accounting.mintCollateralRaw, 1000n);
});

test("56. order expiry is chain-time based and before market expiry", () => {
  assert.equal(orderExpirySeconds({ chainNowSec: 100, marketExpirySec: 1_000 }), 175);
});

test("57. stop policy uses chain time rather than local time", () => {
  assert.deepEqual(shouldStopQuoting({ chainNowSec: 910, expirySec: 1_000 }).stop, true);
});

test("58. waiting-for-market is explicit", () => {
  assert.equal(setWaitingForMarket(state(), { reason: "UNAVAILABLE" }, 101).state, "WAITING_FOR_MARKET");
});

test("59. event stream uses stable machine-readable types", () => {
  let current = state();
  current = emitEvent(current, "MARKET_DISCOVERY_STARTED", { series: CONFIGURED_SERIES }, 101);
  assert.equal(ORCHESTRATOR_EVENTS.includes(current.events.at(-1).type), true);
});

test("60. safe reconciliation records the exact market and order scope", () => {
  const current = recordSafeReconciliation(state(), { chainNowSec: 101, marketId: "A", orderIds: [1, 2] });
  assert.deepEqual(current.lastSafeReconciliation, { chainNowSec: 101, marketId: "A", orderIds: ["1", "2"] });
});
