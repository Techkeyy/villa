import test from "node:test";
import assert from "node:assert/strict";
import { fetchSpot } from "../fair-value/live.mjs";
import { evaluateRisk } from "../risk-governor/index.mjs";
import { assessProjectedQuote } from "./lp-quote-gate.mjs";
import { readQuoteBook, planAvailableBook } from "./lp-book-readiness.mjs";
import { reconcileLpSession } from "./lp-reconciliation.mjs";
import { evaluateWetExecutionPreflight } from "./lp-preflight.mjs";
import { createLpExecutionSession, createAccountLeaseStore, attachLease, transitionLpSession } from "./lp-session.mjs";
import { assessSessionSettlement } from "../settlement/session-lifecycle.mjs";

const account = "0x1111111111111111111111111111111111111111";
const owner = "0x2222222222222222222222222222222222222222";
const operator = "0x3333333333333333333333333333333333333333";
const marketId = "0x" + "aa".repeat(32);
const quotePlan = { plan: "ONE_SIDED", ask: { enabled: true, action: "SELL_YES" } };
function snapshot(feed = {}, gas = 1) {
  return {
    fairValue: { modelVersion: "villa-fv-v1", pUp: 0.6, pDown: 0.4, confidence: 0.95, dataQualityStatus: "HIGH", referenceSource: "strike", realizedVolPerSqrtSec: 0.0001 },
    chainTime: { chainNowSec: 1000, observationAgeSec: 1, blockNumber: 22, localNowMs: 1000000, observedAtLocalMs: 999000, clockOffsetSec: 0 },
    feed: { price: 78500, timestampSec: 999, sourceAgeSec: 2, ...feed },
    market: { status: 1, expirySec: 1300, reference: { status: "VALID", source: "strike", scaleExponent10: 2 } },
    inventory: { yes: 0, no: 0 }, openOrdersStatus: "VERIFIED", openOrders: [],
    capital: { collateralAvailable: 55, capitalAtRisk: 0 }, gas: { nativeBalance: gas }, drawdown: { status: "AVAILABLE", ratio: 0 },
  };
}
function admission(projectedDecision, plan = quotePlan) {
  let session = transitionLpSession(createLpExecutionSession({ sessionId: "wait-integration", account, owner, operator, marketSeries: "BTC", currentMarketId: marketId, riskPolicyVersion: "villa-risk-v1", createdAt: 1000 }), "PREFLIGHT", { atMs: 1100 });
  const store = createAccountLeaseStore({ now: () => 1100 });
  const lease = store.acquire(session);
  session = attachLease(session, lease);
  const gate = assessProjectedQuote({ projectedDecision, quotePlan: plan });
  const risk = { ...projectedDecision, waitState: gate.disposition };
  const orders = { account, status: "VERIFIED", orders: [] };
  const inventory = { account, status: "VERIFIED", yesRaw: 0n, noRaw: 0n };
  const market = { marketId, series: "BTC", status: 1, valid: true, current: true, currentMarketId: marketId };
  const reconciliation = reconcileLpSession({ session, accountState: { account }, market, orders, inventory, risk });
  const preflight = evaluateWetExecutionPreflight({ session, nowMs: 1200, lease: { ...lease, held: true }, chain: { id: 50312 }, executionEnabled: true,
    account: { address: account, owner, operator, runtimeVerified: true }, owner: { address: owner, verified: true }, operator: { configuredAddress: operator, signerAddress: operator },
    market, orders, inventory, reconciliation, risk, capital: { collateralRaw: 55000000n }, permissions: { requiresMarketApproval: false, requiresProtocolApproval: false }, riskLimits: { valid: true }, executionConfig: { mode: "WET", minimumCollateralRaw: 1n },
  });
  return { session, store, inventory, orders, gate, reconciliation, preflight };
}
test("actual governor stale price passes quote gate, reconciliation and waiting preflight; fresh data resumes", () => {
  const stale = admission(evaluateRisk(snapshot({ timestampSec: 980 })));
  assert.equal(stale.gate.disposition, "WAITING_FOR_FRESH_PRICE");
  assert.equal(stale.reconciliation.status, "RECONCILED");
  assert.equal(stale.preflight.allowed, true, stale.preflight.reasons.join(","));
  assert.equal(admission(evaluateRisk(snapshot())).gate.disposition, "EXECUTE");
});
test("NO_QUOTE admission crosses RUNNING -> STOPPING -> clean settlement -> released lease without tracked mint", () => {
  const state = admission(evaluateRisk(snapshot()), { plan: "NO_QUOTE" });
  assert.equal(state.preflight.allowed, true);
  assert.equal(state.gate.disposition, "WAITING_FOR_QUOTE");
  let session = transitionLpSession(state.session, "RUNNING", { atMs: 1200 });
  session = transitionLpSession(session, "STOPPING", { atMs: 1300 });
  const settlement = assessSessionSettlement({ session, account, owner, marketId, onchain: { status: 1, isResolved: false, isVoided: false }, held: null, owned: state.inventory, orders: state.orders });
  assert.equal(settlement.state, "STOPPED_CLEAN");
  session = transitionLpSession(session, settlement.state, { atMs: 1400 });
  assert.equal(state.store.release(session, { reconciled: true }).released, true);
  assert.equal(state.store.get(account), null);
});
test("null tracked mint never adopts nonzero inventory", () => {
  const state = admission(evaluateRisk(snapshot()));
  assert.throws(() => assessSessionSettlement({ session: state.session, account, owner, marketId, held: null, owned: { yesRaw: 1n, noRaw: 0n }, orders: state.orders }), { code: "OWNERSHIP_MISMATCH" });
});
test("upstream stale metadata reaches unchanged governor threshold rather than throwing in opted-in collection", async () => {
  const exchange = { client: { fetchPriceFeedInfo: async () => ({ latest: { price: 78500, blockTimestamp: 999 }, updatedAtMs: 1000000, sourceUpdatedAtMs: 939000 }) } };
  await assert.rejects(fetchSpot(exchange, "BTC", { nowMs: 1000000, nowSec: 1000 }), { code: "STALE_SOURCE" });
  const spot = await fetchSpot(exchange, "BTC", { nowMs: 1000000, nowSec: 1000, deferSourceFreshnessToGovernor: true });
  assert.equal(spot.sourceAgeSec, 61);
  const result = admission(evaluateRisk(snapshot({ sourceAgeSec: spot.sourceAgeSec })));
  assert.equal(result.gate.disposition, "WAITING_FOR_FRESH_PRICE");
  assert.equal(result.preflight.allowed, true);
});
test("stale price cannot hide another real HALT", () => {
  const result = admission(evaluateRisk(snapshot({ timestampSec: 980 }, 0)));
  assert.equal(result.gate.disposition, "FAIL_CLOSED");
  assert.equal(result.reconciliation.status, "UNKNOWN");
  assert.equal(result.preflight.allowed, false);
});
test("missing/empty/read-failed books wait; returned book permits reevaluation", async () => {
  for (const read of [async () => null, async () => ({ bids: [], asks: [] }), async () => { throw new Error("offline"); }]) {
    const book = await readQuoteBook(read);
    const plan = planAvailableBook({}, book, () => { throw new Error("must not quote unavailable data"); });
    assert.equal(admission(evaluateRisk(snapshot()), plan).gate.disposition, "WAITING_FOR_QUOTE");
  }
  const book = await readQuoteBook(async () => ({ bids: [[0.5, 1]], asks: [[0.7, 1]] }));
  assert.equal(planAvailableBook({}, book, () => quotePlan), quotePlan);
});
