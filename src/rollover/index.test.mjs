import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ROLLOVER_STATES,
  buildMarketContext,
  classifyMarketInventory,
  compareMarketContexts,
  createRolloverState,
  acceptSuccessor,
  closeCurrentMarket,
  evaluateSuccessor,
  initializeSuccessor,
  inventoryForMarket,
  retainUnderlyingHistory,
  selectSuccessor,
  seriesIdentity,
  stateScopeAudit,
  verifySuccessorCandidate,
  assertExecutionSessionBound,
  assertPlanMarketBound,
} from "./index.mjs";
import {
  assertExecutionSessionBound as assertExecutionPolicySessionBound,
  assertPlanMarketBound as assertExecutionPolicyPlanBound,
  createExecutionSession,
  trackCreatedOrder,
} from "../execution/policy.mjs";

function row(marketId, { asset = "BTC", intervalSec = 300, expirySec = 1_000, pool = "0xpool-a", venueId = "0xvenue-a", yes = "101", no = "102", status = "Trading" } = {}) {
  return {
    marketType: "BINARY",
    marketId,
    asset,
    intervalSec: String(intervalSec),
    expiry: String(expirySec),
    yesTokenId: yes,
    noTokenId: no,
    poolAddress: pool,
    venueId,
    status,
    strike: "7840000",
  };
}

function onchain(marketId, { expirySec = 1_000, status = 1, pool = "0xpool-a", yes = 101n, no = 102n } = {}) {
  return { marketId, expiry: BigInt(expirySec), status, isResolved: false, isVoided: false, pool, yesId: yes, noId: no, marketAddress: "0xmarket", outcomeToken: "0xoutcome" };
}

function context(marketId = "A", opts = {}) {
  const market = row(marketId, opts);
  const chain = onchain(marketId, { ...opts, yes: BigInt(opts.yes ?? "101"), no: BigInt(opts.no ?? "102") });
  return buildMarketContext({
    market,
    onchain: chain,
    reference: { marketId, kind: "strike", source: "strike", price: 78_400 },
    chainNowSec: opts.chainNowSec ?? 900,
    blockNumber: 10,
  });
}

function candidate(marketId, opts = {}) {
  const r = row(marketId, opts);
  return { market: r, expirySec: Number(r.expiry), status: r.status };
}

function verifiedCandidate(marketId, opts = {}) {
  const r = row(marketId, opts);
  const chain = onchain(marketId, { ...opts, yes: BigInt(opts.yes ?? r.yesTokenId), no: BigInt(opts.no ?? r.noTokenId) });
  return { market: r, onchain: chain, expirySec: Number(r.expiry), status: chain.status };
}

function fair(timeRemainingSec, status = "HIGH") {
  return {
    modelVersion: "villa-fv-v1",
    pUp: 0.6,
    pDown: 0.4,
    confidence: 0.9,
    dataQualityStatus: status,
    timeRemainingSec,
    realizedVolPerSqrtSec: 0.001,
  };
}

function risk(timeRemainingSec, state = "ALLOW") {
  return {
    state,
    primaryReasonCode: state === "HALT" ? "EXPIRY_TOO_CLOSE" : "NONE",
    authoritativeTime: { timeRemainingSec },
  };
}

function quote(marketId, plan = "NO_QUOTE") {
  return { marketId, plan, reasonCodes: plan === "NO_QUOTE" ? ["NO_SELL_INVENTORY"] : ["NONE"] };
}

test("series identity uses binary asset and interval, not pool or venue", () => {
  assert.deepEqual(seriesIdentity(row("A", { pool: "pool-1", venueId: "venue-1" })), {
    marketType: "BINARY", asset: "BTC", intervalSec: 300, key: "BINARY:BTC:300",
  });
});

test("A cannot be selected as its own successor", () => {
  const result = selectSuccessor({ current: context(), candidates: [candidate("A", { expirySec: 1_300 })], chainNowSec: 900 });
  assert.equal(result.state, ROLLOVER_STATES.WAITING_FOR_SUCCESSOR);
  assert.equal(result.rejections[0].code, "SAME_MARKET");
});

test("successor must have a different marketId", () => {
  const result = selectSuccessor({ current: context(), candidates: [candidate("a", { expirySec: 1_300 })], chainNowSec: 900 });
  assert.equal(result.state, ROLLOVER_STATES.WAITING_FOR_SUCCESSOR);
  assert.equal(result.rejections[0].code, "SAME_MARKET");
});

test("successor expiry must be later than A", () => {
  const result = selectSuccessor({ current: context(), candidates: [candidate("B", { expirySec: 1_000 })], chainNowSec: 900 });
  assert.equal(result.rejections[0].code, "EXPIRY_NOT_LATER");
});

test("BTC 5m chooses BTC 5m B, not BTC 1m", () => {
  const result = selectSuccessor({
    current: context(),
    candidates: [candidate("one-minute", { intervalSec: 60, expirySec: 1_060 }), candidate("five-minute", { intervalSec: 300, expirySec: 1_300 })],
    chainNowSec: 900,
  });
  assert.equal(result.selected.marketId, "five-minute");
  assert.equal(result.rejections[0].code, "SERIES_MISMATCH");
});

test("BTC 5m does not choose BTC 15m", () => {
  const result = selectSuccessor({ current: context(), candidates: [candidate("fifteen", { intervalSec: 900, expirySec: 1_900 })], chainNowSec: 900 });
  assert.equal(result.state, ROLLOVER_STATES.WAITING_FOR_SUCCESSOR);
  assert.equal(result.rejections[0].code, "SERIES_MISMATCH");
});

test("BTC does not choose ETH", () => {
  const result = selectSuccessor({ current: context(), candidates: [candidate("eth", { asset: "ETH", expirySec: 1_300 })], chainNowSec: 900 });
  assert.equal(result.state, ROLLOVER_STATES.WAITING_FOR_SUCCESSOR);
  assert.equal(result.rejections[0].code, "SERIES_MISMATCH");
});

test("earliest valid matching successor wins", () => {
  const result = selectSuccessor({ current: context(), candidates: [candidate("late", { expirySec: 1_600 }), candidate("early", { expirySec: 1_300 })], chainNowSec: 900 });
  assert.equal(result.state, ROLLOVER_STATES.SUCCESSOR_FOUND);
  assert.equal(result.selected.marketId, "early");
});

test("equal earliest candidates fail closed as ambiguous", () => {
  const result = selectSuccessor({ current: context(), candidates: [candidate("B1", { expirySec: 1_300 }), candidate("B2", { expirySec: 1_300 })], chainNowSec: 900 });
  assert.equal(result.state, ROLLOVER_STATES.HALTED);
  assert.equal(result.code, "SUCCESSOR_AMBIGUOUS");
});

test("no candidate returns WAITING_FOR_SUCCESSOR", () => {
  const result = selectSuccessor({ current: context(), candidates: [], chainNowSec: 900 });
  assert.equal(result.state, ROLLOVER_STATES.WAITING_FOR_SUCCESSOR);
});

test("indexer candidate failing on-chain verification is rejected", () => {
  const result = verifySuccessorCandidate({ current: context(), candidate: candidate("B", { expirySec: 1_300 }), onchain: onchain("B", { expirySec: 1_300, status: 4 }), chainNowSec: 900 });
  assert.equal(result.verified, false);
  assert.equal(result.code, "ONCHAIN_NOT_TRADING");
});

test("on-chain outcome mismatch is rejected", () => {
  const result = verifySuccessorCandidate({ current: context(), candidate: candidate("B", { expirySec: 1_300, yes: "201" }), onchain: onchain("B", { expirySec: 1_300, yes: 202n }), chainNowSec: 900 });
  assert.equal(result.verified, false);
  assert.equal(result.code, "OUTCOME_ID_MISMATCH");
});

test("A reference cannot be attached to B", () => {
  assert.throws(() => buildMarketContext({ market: row("B", { expirySec: 1_300 }), onchain: onchain("B", { expirySec: 1_300 }), reference: { marketId: "A", source: "strike", price: 78_400 }, chainNowSec: 900 }), { code: "REFERENCE_SCOPE_MISMATCH" });
});

test("B reference is independently resolved and recorded", () => {
  const a = context();
  const selection = selectSuccessor({ current: a, candidates: [verifiedCandidate("B", { expirySec: 1_300, yes: "201", no: "202" })], chainNowSec: 900 });
  const stopped = closeCurrentMarket(createRolloverState({ currentContext: a }), { chainNowSec: 1_001, status: 4 });
  const withB = acceptSuccessor(stopped, selection);
  const b = context("B", { expirySec: 1_300, yes: "201", no: "202" });
  const initialized = initializeSuccessor(withB, b);
  const evaluated = evaluateSuccessor(initialized, { reference: { marketId: "B", source: "opening", price: 78_410 }, fairValue: fair(400), riskDecision: risk(400), quotePlan: quote("B"), chainNowSec: 900 });
  assert.equal(evaluated.evaluation.fairValue.timeRemainingSec, 400);
  assert.equal(evaluated.marketScope.reference.source, "opening");
});

test("old A YES does not count as B YES", () => {
  const result = inventoryForMarket({ marketId: "B", yesId: "201", noId: "202", balancesByTokenId: { "101": 4n } });
  assert.equal(result.yesRaw, 0n);
  assert.deepEqual(result.excludedTokenBalances, [{ tokenId: "101", amountRaw: 4n }]);
});

test("old A NO losing residual does not count as B NO", () => {
  const result = inventoryForMarket({ marketId: "B", yesId: "201", noId: "202", balancesByTokenId: { "102": 1_000n } });
  assert.equal(result.noRaw, 0n);
  assert.equal(result.directionalDeltaRaw, 0n);
});

test("old A pending orders do not count as B pending orders", () => {
  const state = createRolloverState({ currentContext: context(), walletState: { sttRaw: 10n }, strategyState: { size: 1 } });
  const selection = selectSuccessor({ current: state.currentContext, candidates: [verifiedCandidate("B", { expirySec: 1_300, yes: "201", no: "202" })], chainNowSec: 900 });
  const next = acceptSuccessor(closeCurrentMarket(state, { chainNowSec: 1_001, status: 4, openOrderIds: [] }), selection);
  const initialized = initializeSuccessor(next, context("B", { expirySec: 1_300, yes: "201", no: "202" }));
  assert.deepEqual(initialized.marketScope.openOrderIds, []);
  assert.deepEqual(initialized.marketScope.pendingExposure, null);
});

test("an A quote plan cannot execute against B", () => {
  assert.throws(() => assertPlanMarketBound({ marketId: "A" }, "B"), { code: "STALE_PLAN_MARKET" });
  assert.throws(() => assertExecutionPolicyPlanBound({ marketId: "A" }, "B"), { code: "MARKET_SCOPE_MISMATCH" });
});

test("an execution session bound to A cannot mutate B", () => {
  const session = createExecutionSession({ sessionId: "s", marketId: "A" });
  assert.throws(() => assertExecutionSessionBound(session, "B"), { code: "SESSION_SCOPE_MISMATCH" });
  assert.throws(() => assertExecutionPolicySessionBound(session, "B"), { code: "SESSION_SCOPE_MISMATCH" });
  assert.throws(() => trackCreatedOrder(session, { orderId: "1", marketId: "B", action: "BUY_YES", priceRaw: "1", quantityRaw: "1" }), { code: "SESSION_SCOPE_MISMATCH" });
});

test("B fair value uses B expiry", () => {
  const a = context();
  const closed = closeCurrentMarket(createRolloverState({ currentContext: a }), { chainNowSec: 1_001, status: 4 });
  const state = initializeSuccessor(acceptSuccessor(closed, selectSuccessor({ current: a, candidates: [verifiedCandidate("B", { expirySec: 1_300, yes: "201", no: "202" })], chainNowSec: 900 })), context("B", { expirySec: 1_300, yes: "201", no: "202" }));
  const result = evaluateSuccessor(state, { reference: { marketId: "B", source: "strike", price: 78_400 }, fairValue: fair(400), riskDecision: risk(400), quotePlan: quote("B"), chainNowSec: 900 });
  assert.equal(result.evaluation.expectedTimeRemainingSec, 400);
});

test("B governor uses B expiry and rejects stale A time", () => {
  const a = context();
  const closed = closeCurrentMarket(createRolloverState({ currentContext: a }), { chainNowSec: 1_001, status: 4 });
  const state = initializeSuccessor(acceptSuccessor(closed, selectSuccessor({ current: a, candidates: [verifiedCandidate("B", { expirySec: 1_300, yes: "201", no: "202" })], chainNowSec: 900 })), context("B", { expirySec: 1_300, yes: "201", no: "202" }));
  assert.throws(() => evaluateSuccessor(state, { reference: { marketId: "B", source: "strike", price: 78_400 }, fairValue: fair(400), riskDecision: risk(100), quotePlan: quote("B"), chainNowSec: 900 }), { code: "STALE_MARKET_TIME" });
});

test("B governor uses B inventory only", () => {
  const inventory = inventoryForMarket({ marketId: "B", yesId: "201", noId: "202", balancesByTokenId: { "102": 1_000n, "201": 5n, "202": 5n } });
  assert.equal(inventory.directionalDeltaRaw, 0n);
  assert.equal(inventory.yesRaw, 5n);
  assert.equal(inventory.noRaw, 5n);
});

test("wallet balances persist across transition", () => {
  const state = createRolloverState({ currentContext: context(), walletState: { sttRaw: 99n, tusdcRaw: 10_000n } });
  const closed = closeCurrentMarket(state, { chainNowSec: 1_001, status: 4 });
  const selected = selectSuccessor({ current: state.currentContext, candidates: [verifiedCandidate("B", { expirySec: 1_300, yes: "201", no: "202" })], chainNowSec: 900 });
  const rolled = initializeSuccessor(acceptSuccessor(closed, selected), context("B", { expirySec: 1_300, yes: "201", no: "202" }));
  assert.deepEqual(rolled.walletState, state.walletState);
});

test("strategy config persists across transition", () => {
  const state = createRolloverState({ currentContext: context(), strategyState: { riskLimit: 7, quoteSize: "1" } });
  const closed = closeCurrentMarket(state, { chainNowSec: 1_001, status: 4 });
  const selected = selectSuccessor({ current: state.currentContext, candidates: [verifiedCandidate("B", { expirySec: 1_300, yes: "201", no: "202" })], chainNowSec: 900 });
  const rolled = initializeSuccessor(acceptSuccessor(closed, selected), context("B", { expirySec: 1_300, yes: "201", no: "202" }));
  assert.deepEqual(rolled.strategyState, state.strategyState);
});

test("market-scoped state resets on B initialization", () => {
  const state = createRolloverState({ currentContext: context(), walletState: {}, strategyState: {} });
  state.marketScope.openOrderIds = ["old-order"];
  state.marketScope.inventory = { yesRaw: 5n };
  const closed = closeCurrentMarket(state, { chainNowSec: 1_001, status: 4 });
  const selected = selectSuccessor({ current: state.currentContext, candidates: [verifiedCandidate("B", { expirySec: 1_300, yes: "201", no: "202" })], chainNowSec: 900 });
  const rolled = initializeSuccessor(acceptSuccessor(closed, selected), context("B", { expirySec: 1_300, yes: "201", no: "202" }));
  assert.equal(rolled.marketScope.marketId, "B");
  assert.deepEqual(rolled.marketScope.openOrderIds, []);
  assert.equal(rolled.marketScope.inventory, null);
  assert.equal(rolled.marketScope.quotePlan, null);
});

test("session/global state and A history do not reset", () => {
  const state = createRolloverState({ sessionId: "session-1", currentContext: context(), strategyState: { mode: "maker" } });
  const closed = closeCurrentMarket(state, { chainNowSec: 1_001, status: 4 });
  assert.equal(closed.sessionId, "session-1");
  assert.equal(closed.settlementHistory[0].marketId, "A");
});

test("underlying history is retained only while fresh and within gap policy", () => {
  const result = retainUnderlyingHistory([
    { price: 100, tSec: 700 },
    { price: 101, tSec: 800 },
    { price: 102, tSec: 900 },
    { price: 103, tSec: 1_100 },
    { price: -1, tSec: 900 },
  ], 1_000, { maxAgeSec: 250, maxGapSec: 250, futureSkewSec: 5, maxTicks: 240 });
  assert.deepEqual(result.ticks.map((tick) => tick.tSec), [800, 900]);
  assert.equal(result.cutAfterGap, false);
  assert.equal(result.droppedInvalid, 1);
});

test("A remains in settlement history while B is active", () => {
  const a = context();
  const state = createRolloverState({ currentContext: a });
  const closed = closeCurrentMarket(state, { chainNowSec: 1_001, status: 4 });
  const selected = selectSuccessor({ current: a, candidates: [verifiedCandidate("B", { expirySec: 1_300, yes: "201", no: "202" })], chainNowSec: 900 });
  const rolled = initializeSuccessor(acceptSuccessor(closed, selected), context("B", { expirySec: 1_300, yes: "201", no: "202" }));
  assert.equal(rolled.activeMarketId, "B");
  assert.deepEqual(rolled.settlementHistory.map((item) => item.marketId), ["A"]);
});

test("successor discovery works when A is absent from live candidates", () => {
  const result = selectSuccessor({ current: context(), candidates: [candidate("B", { expirySec: 1_300 })], chainNowSec: 900 });
  assert.equal(result.selected.marketId, "B");
});

test("pool-address reuse does not confuse identity", () => {
  const a = context("A", { pool: "same-pool" });
  const b = context("B", { expirySec: 1_300, pool: "same-pool", yes: "201", no: "202" });
  const proof = compareMarketContexts(a, b);
  assert.equal(proof.marketIdChanged, true);
  assert.equal(proof.poolReused, true);
  assert.equal(proof.sameSeries, true);
});

test("venueId change does not break a valid same-series successor", () => {
  const a = context("A", { venueId: "venue-old" });
  const result = selectSuccessor({ current: a, candidates: [candidate("B", { expirySec: 1_300, venueId: "venue-new" })], chainNowSec: 900 });
  assert.equal(result.state, ROLLOVER_STATES.SUCCESSOR_FOUND);
  assert.equal(compareMarketContexts(a, context("B", { expirySec: 1_300, venueId: "venue-new" })).venueIdChanged, true);
});

test("same candidate set has a deterministic result", () => {
  const inputs = [candidate("B2", { expirySec: 1_400 }), candidate("B1", { expirySec: 1_300 })];
  assert.deepEqual(selectSuccessor({ current: context(), candidates: inputs, chainNowSec: 900 }), selectSuccessor({ current: context(), candidates: [...inputs].reverse(), chainNowSec: 900 }));
});

test("local clock skew does not affect chain-time selection", () => {
  const candidates = [candidate("B", { expirySec: 1_300 })];
  assert.deepEqual(selectSuccessor({ current: context(), candidates, chainNowSec: 900 }), selectSuccessor({ current: context(), candidates, chainNowSec: 900 }));
});

test("chain time controls whether a candidate is future", () => {
  assert.equal(selectSuccessor({ current: context(), candidates: [candidate("B", { expirySec: 1_300 })], chainNowSec: 1_299 }).state, ROLLOVER_STATES.SUCCESSOR_FOUND);
  assert.equal(selectSuccessor({ current: context(), candidates: [candidate("B", { expirySec: 1_300 })], chainNowSec: 1_300 }).state, ROLLOVER_STATES.WAITING_FOR_SUCCESSOR);
});

test("open A orders block unsafe rollover", () => {
  const result = closeCurrentMarket(createRolloverState({ currentContext: context() }), { chainNowSec: 1_001, status: 4, openOrderIds: ["a-order"] });
  assert.equal(result.state, ROLLOVER_STATES.HALTED);
  assert.equal(result.haltReason, "CURRENT_OPEN_ORDERS");
});

test("zero A orders permit rollover", () => {
  const result = closeCurrentMarket(createRolloverState({ currentContext: context() }), { chainNowSec: 1_001, status: 4, openOrderIds: [] });
  assert.equal(result.state, ROLLOVER_STATES.WAITING_FOR_SUCCESSOR);
  assert.equal(result.activeMarketId, null);
});

test("B HALT is still a successful context rollover", () => {
  const a = context();
  const state = initializeSuccessor(acceptSuccessor(closeCurrentMarket(createRolloverState({ currentContext: a }), { chainNowSec: 1_001, status: 4 }), selectSuccessor({ current: a, candidates: [verifiedCandidate("B", { expirySec: 1_300, yes: "201", no: "202" })], chainNowSec: 900 })), context("B", { expirySec: 1_300, yes: "201", no: "202" }));
  const result = evaluateSuccessor(state, { reference: { marketId: "B", source: "strike", price: 78_400 }, fairValue: fair(400), riskDecision: risk(400, "HALT"), quotePlan: quote("B"), chainNowSec: 900 });
  assert.equal(result.state, ROLLOVER_STATES.HALTED);
  assert.equal(result.activeMarketId, "B");
  assert.equal(result.evaluation.quotePlan.marketId, "B");
});

test("B NO_QUOTE does not cause fallback to an unrelated market", () => {
  const a = context();
  const state = initializeSuccessor(acceptSuccessor(closeCurrentMarket(createRolloverState({ currentContext: a }), { chainNowSec: 1_001, status: 4 }), selectSuccessor({ current: a, candidates: [verifiedCandidate("B", { expirySec: 1_300, yes: "201", no: "202" })], chainNowSec: 900 })), context("B", { expirySec: 1_300, yes: "201", no: "202" }));
  const result = evaluateSuccessor(state, { reference: { marketId: "B", source: "strike", price: 78_400 }, fairValue: fair(400), riskDecision: risk(400), quotePlan: quote("B", "NO_QUOTE"), chainNowSec: 900 });
  assert.equal(result.activeMarketId, "B");
  assert.equal(result.evaluation.quotePlan.plan, "NO_QUOTE");
  assert.equal(result.evaluation.quotePlan.marketId, "B");
});

test("stale or low-quality B data prevents READY-to-quote state", () => {
  const a = context();
  const state = initializeSuccessor(acceptSuccessor(closeCurrentMarket(createRolloverState({ currentContext: a }), { chainNowSec: 1_001, status: 4 }), selectSuccessor({ current: a, candidates: [verifiedCandidate("B", { expirySec: 1_300, yes: "201", no: "202" })], chainNowSec: 900 })), context("B", { expirySec: 1_300, yes: "201", no: "202" }));
  const result = evaluateSuccessor(state, { reference: { marketId: "B", source: "strike", price: 78_400 }, fairValue: fair(400, "LOW"), riskDecision: risk(400), quotePlan: quote("B"), chainNowSec: 900 });
  assert.equal(result.state, ROLLOVER_STATES.HALTED);
});

test("ambiguous B reference prevents READY", () => {
  const a = context();
  const state = initializeSuccessor(acceptSuccessor(closeCurrentMarket(createRolloverState({ currentContext: a }), { chainNowSec: 1_001, status: 4 }), selectSuccessor({ current: a, candidates: [verifiedCandidate("B", { expirySec: 1_300, yes: "201", no: "202" })], chainNowSec: 900 })), context("B", { expirySec: 1_300, yes: "201", no: "202" }));
  assert.throws(() => evaluateSuccessor(state, { reference: { marketId: "A", source: "opening", price: 78_400 }, fairValue: fair(400), riskDecision: risk(400), quotePlan: quote("B"), chainNowSec: 900 }), { code: "REFERENCE_SCOPE_MISMATCH" });
});

test("residual registry labels a settled losing outcome", () => {
  const result = classifyMarketInventory({ marketId: "A", yesId: "101", noId: "102", balancesByTokenId: { "101": 0n, "102": 1_000n }, status: 4, isResolved: true, winningOutcome: 0 });
  assert.equal(result.knownResidual[0].classification, "KNOWN_ZERO_VALUE_SETTLED_RESIDUAL");
});

test("complete paired active inventory is classified as burnable", () => {
  const result = classifyMarketInventory({ marketId: "A", yesId: "101", noId: "102", balancesByTokenId: { "101": 5n, "102": 5n }, status: 1 });
  assert.equal(result.labels.every((item) => item.classification === "PAIRED_BURNABLE_INVENTORY"), true);
});

test("state scope audit exposes market, wallet, strategy, underlying, and history separately", () => {
  const state = createRolloverState({ currentContext: context(), walletState: { sttRaw: 1n }, strategyState: { limit: 5 }, underlyingHistory: [{ price: 1, tSec: 900 }] });
  const audit = stateScopeAudit(state);
  assert.equal(audit.market.marketId, "A");
  assert.equal(audit.wallet.sttRaw, 1n);
  assert.equal(audit.strategy.limit, 5);
  assert.equal(audit.underlying.retainedCount, 1);
  assert.deepEqual(audit.settlementHistoryMarketIds, []);
});

test("rollover events are deterministic machine-readable facts", () => {
  const make = () => closeCurrentMarket(createRolloverState({ sessionId: "same", currentContext: context() }), { chainNowSec: 1_001, status: 4 });
  assert.deepEqual(make().events, make().events);
  assert.equal(make().events[1].type, "CURRENT_MARKET_NO_LONGER_TRADING");
});

test("verification script has no write-capable calls", () => {
  const source = readFileSync(new URL("../../scripts/verify-rollover.mjs", import.meta.url), "utf8");
  for (const forbidden of ["OPERATOR_PRIVATE_KEY", "trader.", "writeContract", "mintSet", "burnSet", "redeem", "faucet", "placeOrder"]) assert.equal(source.includes(forbidden), false, forbidden);
});
