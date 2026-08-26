import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildDashboardSnapshot } from "./contract.mjs";
import { buildReplayEnvelope } from "./replay.mjs";
import {
  abbreviate,
  formatProbability,
  importantEvents,
  projectDashboard,
  quoteProjection,
  quoteSide,
  stateProjection,
} from "./presenter.mjs";

const quoteSnapshot = buildReplayEnvelope("quote").snapshot;

function copySnapshot(snapshot = quoteSnapshot, changes = {}) {
  return structuredClone({ ...snapshot, ...changes });
}

test("ALLOW state renders as a quoting permission", () => {
  assert.equal(stateProjection(quoteSnapshot).key, "QUOTING");
  assert.equal(projectDashboard(quoteSnapshot, { mode: "REPLAY" }).risk.action, "ALLOW");
});

test("REDUCE_ONLY stays distinct from ALLOW", () => {
  const snapshot = copySnapshot(quoteSnapshot, { risk: { ...quoteSnapshot.risk, action: "REDUCE_ONLY", triggeredReasons: ["DIRECTIONAL_EXPOSURE_SOFT"] } });
  assert.equal(stateProjection(snapshot).key, "REDUCE_ONLY");
  assert.notEqual(stateProjection(snapshot).key, stateProjection(quoteSnapshot).key);
});

test("HALT keeps the exact reason visible", () => {
  const snapshot = copySnapshot(quoteSnapshot, { risk: { ...quoteSnapshot.risk, action: "HALT", triggeredReasons: ["MODEL_CONFIDENCE_LOW"] } });
  const view = projectDashboard(snapshot, { mode: "LIVE" });
  assert.equal(view.state.key, "HALTED");
  assert.equal(view.risk.reasonCode, "MODEL_CONFIDENCE_LOW");
});

test("NO_QUOTE is distinct from HALT", () => {
  const noQuote = buildReplayEnvelope("rollover").snapshot;
  const halted = buildReplayEnvelope("settlement").snapshot;
  assert.equal(stateProjection(noQuote).key, "NO_QUOTE");
  assert.equal(stateProjection(halted).key, "HALTED");
  assert.notEqual(stateProjection(noQuote).key, stateProjection(halted).key);
});

test("pUp and pDown remain separate probability values", () => {
  const view = projectDashboard(quoteSnapshot, { mode: "REPLAY" });
  assert.equal(formatProbability(view.fair.pUp), "76.8%");
  assert.equal(formatProbability(view.fair.pDown), "23.2%");
});

test("confidence is rendered independently from probability", () => {
  const view = projectDashboard(quoteSnapshot, { mode: "REPLAY" });
  assert.equal(view.fair.confidence, 0.9);
  assert.notEqual(view.fair.confidence, view.fair.pUp);
});

test("DreamDEX midpoint is exposed as comparison data", () => {
  const envelope = buildReplayEnvelope("quote");
  const view = projectDashboard(envelope.snapshot, envelope);
  assert.equal(view.midpoint, 0.7165);
  assert.equal(view.modeLabel, "REPLAY");
});

test("one-sided quote posture is intentional", () => {
  const snapshot = buildDashboardSnapshot({ ...quoteSnapshot, bookQuotes: { ...quoteSnapshot.bookQuotes, villa: { ...quoteSnapshot.bookQuotes.villa, targetAsk: null, restingAsk: null, askQuantity: "0" } } });
  const quotes = quoteProjection(snapshot);
  assert.equal(quotes.oneSided, true);
  assert.equal(quotes.twoSided, false);
  assert.equal(quotes.ask.state, "NO_QUOTE");
});

test("two-sided quote posture is visible", () => {
  const quotes = quoteProjection(quoteSnapshot);
  assert.equal(quotes.twoSided, true);
  assert.equal(quotes.bid.state, "RESTING");
  assert.equal(quotes.ask.state, "RESTING");
});

test("resting quote state wins over target state", () => {
  assert.equal(quoteSide(quoteSnapshot, "bid").state, "RESTING");
  assert.equal(quoteSide(quoteSnapshot, "ask").state, "RESTING");
});

test("filled order state can be shown without inventing a resting order", () => {
  const snapshot = buildDashboardSnapshot({ ...quoteSnapshot, bookQuotes: { ...quoteSnapshot.bookQuotes, villa: { ...quoteSnapshot.bookQuotes.villa, targetAsk: null, restingAsk: null } }, activity: { events: [{ type: "ORDER_FILLED", facts: { action: "SELL_YES", quantityRaw: "1000" } }] } });
  assert.equal(quoteSide(snapshot, "ask").state, "FILLED");
});

test("inventory direction is derived from current-market inventory", () => {
  const view = projectDashboard(quoteSnapshot, { mode: "REPLAY" });
  assert.equal(view.exposure.yes, 0.001);
  assert.equal(view.exposure.no, 0.001);
  assert.equal(view.exposure.direction, "NEUTRAL");
});

test("historical residuals never enter active inventory", () => {
  const envelope = buildReplayEnvelope("settlement");
  const view = projectDashboard(envelope.snapshot, envelope);
  assert.equal(view.exposure.classifications.includes("KNOWN_ZERO_VALUE_SETTLED_RESIDUAL"), false);
  assert.equal(view.lifecycle.residuals[0].classification, "KNOWN_ZERO_VALUE_SETTLED_RESIDUAL");
});

test("rollover projection keeps previous and current market ids separate", () => {
  const envelope = buildReplayEnvelope("rollover");
  const view = projectDashboard(envelope.snapshot, envelope);
  assert.equal(view.lifecycle.previous.endsWith("a17b"), true);
  assert.equal(view.lifecycle.current.endsWith("a17d"), true);
  assert.notEqual(view.lifecycle.previous, view.lifecycle.current);
});

test("settlement history renders exact recorded claims", () => {
  const envelope = buildReplayEnvelope("settlement");
  const view = projectDashboard(envelope.snapshot, envelope);
  assert.equal(view.lifecycle.claims.length, 3);
  assert.equal(view.lifecycle.claims[0].status, "REDEEMED");
});

test("zero-value residual retains its explicit classification", () => {
  const residual = buildReplayEnvelope("settlement").snapshot.lifecycle.historicalResiduals[0];
  assert.equal(residual.classification, "KNOWN_ZERO_VALUE_SETTLED_RESIDUAL");
  assert.equal(residual.status, "SETTLED_ZERO_VALUE");
});

test("PnL remains unavailable and is never normalized to zero", () => {
  const snapshot = buildReplayEnvelope("settlement").snapshot;
  assert.equal(snapshot.accounting.pnlState, "PNL_UNAVAILABLE");
  assert.equal(snapshot.accounting.pnl, null);
});

test("timeline limits noisy event history to the operator view", () => {
  const types = ["MARKET_INITIALIZED", "FAIR_VALUE_UPDATED", "GOVERNOR_STATE_CHANGED", "QUOTE_PLAN_UPDATED", "INVENTORY_MINTED", "ORDER_RESTING", "ORDER_FILLED", "ORDER_CANCELLED", "INVENTORY_RECONCILED", "MARKET_STOPPING", "MARKET_CLOSED", "SUCCESSOR_READY", "CLAIMABLE_POSITION_FOUND", "REDEEM_CONFIRMED", "WALLET_HYGIENE_CLEAN"];
  assert.equal(importantEvents(types.map((type, index) => ({ type, sequence: index + 1, facts: {} })), 10).length, 10);
});

test("replay mode is explicit in the view", () => {
  const envelope = buildReplayEnvelope("quote");
  const view = projectDashboard(envelope.snapshot, envelope);
  assert.equal(view.mode, "REPLAY");
  assert.equal(view.modeLabel, "REPLAY");
});

test("live mode is explicit in the view", () => {
  const view = projectDashboard(quoteSnapshot, { mode: "LIVE", source: "Live read-only Shannon adapter" });
  assert.equal(view.mode, "LIVE");
  assert.equal(view.modeLabel, "LIVE");
});

test("the dashboard contract rejects private-key fields before presentation", () => {
  assert.throws(() => buildDashboardSnapshot({ privateKey: "never" }), (error) => error.code === "SECRET_LEAK");
});

test("secrets are not referenced by the browser application", () => {
  const browserSource = fs.readFileSync(new URL("../../dashboard/app.mjs", import.meta.url), "utf8");
  assert.equal(/private.?key|PRIVATE_KEY|secret/i.test(browserSource), false);
});

test("long identifiers are abbreviated for the operator view", () => {
  const id = "0x000000000000000000000000000000000000000000000000000000000000a3cf";
  assert.equal(abbreviate(id), "0x0000...a3cf");
});

test("probability display clamps unsafe presentation values", () => {
  assert.equal(formatProbability(2), "100.0%");
  assert.equal(formatProbability(-1), "0.0%");
  assert.equal(formatProbability(null), "Unavailable");
});

test("replay evidence uses the recorded external fill ids", () => {
  const evidence = buildReplayEnvelope("settlement").evidence;
  assert.equal(evidence.fills[0].orderId, "55340232221128713213");
  assert.equal(evidence.fills[1].orderId, "18446744073709615271");
});

test("live and replay share the same backend contract shape", () => {
  const replay = buildReplayEnvelope("rollover").snapshot;
  const liveLike = buildDashboardSnapshot({ system: { state: "RUNNING" }, market: { status: "Trading" }, model: {}, bookQuotes: {}, risk: { action: "ALLOW" }, inventory: {}, events: [], lifecycle: {}, accounting: {} });
  assert.deepEqual(Object.keys(replay), Object.keys(liveLike));
});
