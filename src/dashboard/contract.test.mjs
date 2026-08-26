import assert from "node:assert/strict";
import test from "node:test";
import { buildDashboardSnapshot, DASHBOARD_DATA_CONTRACT_VERSION, PNL_UNAVAILABLE } from "./contract.mjs";

const input = {
  generatedAtChainSec: 100,
  system: { running: true, network: "Somnia Shannon", walletAddress: "0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37", currentSeries: "BINARY:BTC:300", orchestratorVersion: "villa-orchestrator-v1" },
  market: { marketId: "A", asset: "BTC", intervalSec: 300, reference: 78_025.85, currentUnderlying: 78_100, expiry: 1000, timeRemainingSec: 900, status: "Trading" },
  model: { pUp: 0.71, pDown: 0.29, confidence: 0.9, realizedVolPerSqrtSec: 0.001, modelVersion: "villa-fv-v1" },
  bookQuotes: { bestBid: 650000, bestAsk: 700000, targetBid: 640000, targetAsk: 710000, restingBid: 640000, restingAsk: null, bidQuantity: 1000, askQuantity: 0, quotePlanVersion: "villa-quote-v1" },
  risk: { action: "ALLOW", triggeredReasons: [], exposure: { up: 0, down: 0 }, riskCapacity: { up: 10, down: 10 }, collateral: { availableRaw: 1000000 }, gas: { nativeBalanceRaw: 1000000000000000000n } },
  inventory: { yesRaw: 1000n, noRaw: 1000n, completeSetsRaw: 1000n, directionalExposure: 0, classifications: ["PAIRED_BURNABLE_INVENTORY"] },
  events: [{ type: "QUOTE_PLAN_UPDATED", sequence: 1, atChainSec: 100, facts: { quotePlanVersion: "villa-quote-v1" } }],
  lifecycle: { currentMarket: "A", previousMarket: "B", rolloverState: "ACTIVE" },
  accounting: { tUSDC: 1000000n, STT: 1000000000000000000n, pnl: 123 },
};

test("maps stable system, market, model, quote, risk, inventory, activity, lifecycle, and accounting fields", () => {
  const snapshot = buildDashboardSnapshot(input);
  assert.equal(snapshot.contractVersion, DASHBOARD_DATA_CONTRACT_VERSION);
  assert.equal(snapshot.system.state, "RUNNING");
  assert.equal(snapshot.market.intervalSec, 300);
  assert.equal(snapshot.model.fairValueModelVersion, "villa-fv-v1");
  assert.equal(snapshot.bookQuotes.dreamdex.bestBid, "650000");
  assert.equal(snapshot.bookQuotes.villa.bidQuantity, "1000");
  assert.equal(snapshot.risk.action, "ALLOW");
  assert.equal(snapshot.inventory.completeSets, "1000");
  assert.equal(snapshot.activity.events[0].type, "QUOTE_PLAN_UPDATED");
  assert.equal(snapshot.lifecycle.previousMarket, "B");
  assert.equal(snapshot.accounting.tUSDC, "1000000");
});

test("never fabricates PnL and exposes PNL_UNAVAILABLE", () => {
  const snapshot = buildDashboardSnapshot(input);
  assert.equal(snapshot.accounting.pnlState, PNL_UNAVAILABLE);
  assert.equal(snapshot.accounting.pnl, null);
});

test("identical backend facts map deterministically", () => {
  assert.deepEqual(buildDashboardSnapshot(input), buildDashboardSnapshot(input));
});

test("rejects invalid dashboard risk actions and secret-like input fields", () => {
  assert.throws(() => buildDashboardSnapshot({ risk: { action: "TRADE" } }), (error) => error.code === "DASHBOARD_RISK_INVALID");
  assert.throws(() => buildDashboardSnapshot({ secret: "must not pass" }), (error) => error.code === "SECRET_LEAK");
});
