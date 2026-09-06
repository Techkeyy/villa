import assert from "node:assert/strict";
import test from "node:test";
import { formatActivityLabel, telemetryView } from "../../dashboard/uat-monitor.mjs";

test("telemetry view maps the real live snapshot into user-readable sections", () => {
  const view = telemetryView({
    state: "RUNNING",
    session: { sessionId: "uat-1-abcdef12" },
    snapshot: {
      market: { asset: "BTC", title: "BTC 5 minute event", intervalSec: 300, marketId: "0xabc", timeRemainingSec: 119, status: "Trading" },
      strategy: { fairValue: { pUp: 0.62, pDown: 0.38, confidence: 0.81 }, bestBidRaw: "420000", bestAskRaw: "430000", side: "SELL_YES", priceRaw: "430000", sizeRaw: "1000", postOnly: true },
      riskGovernor: { state: "ALLOW", currentAggregateExposureRaw: "1000", maxAggregateExposureRaw: "10000", currentMintExposureRaw: "1000", maxMintExposureRaw: "5000" },
      inventoryState: { freeYesRaw: "0", escrowedYesRaw: "1000", freeNoRaw: "1000", escrowedNoRaw: "0" },
      capitalState: { freeRaw: "1000000", deployedRaw: "1000", claimableRaw: "0", pendingRaw: "0" },
      health: { heartbeat: "HEALTHY", lease: "HELD", processState: "RUNNING" },
      activity: [{ atMs: 1, type: "CHAIN_WRITE", message: "Order placed" }],
      advanced: { sessionId: "uat-1-abcdef12", transactionHashes: [{ action: "placeOrder", hash: "0x123" }] },
    },
  });
  assert.equal(view.state, "RUNNING");
  assert.equal(view.active, true);
  assert.equal(view.marketAsset, "BTC");
  assert.equal(view.marketTimeRemaining, "1m 59s");
  assert.equal(view.fairValue, "YES 62.00% / NO 38.00%");
  assert.equal(view.confidence, "81.00%");
  assert.equal(view.quote, "SELL_YES · 0.43 · 0.001");
  assert.equal(view.exposure, "0.001 / 0.01");
  assert.equal(view.freeCapital, "1 tUSDC");
  assert.equal(view.advancedTx.length, 1);
  assert.equal(view.activity.length, 1);
  assert.equal(formatActivityLabel(view.activity[0]), "Order placed");
});

test("telemetry view explains unavailable P&L and does not invent an activity feed", () => {
  const view = telemetryView({ state: "STOPPED", snapshot: { marketId: "0xabc" } });
  assert.match(view.pnl, /P&L unavailable/);
  assert.equal(view.activity.length, 0);
  assert.equal(view.visible, true);
});
