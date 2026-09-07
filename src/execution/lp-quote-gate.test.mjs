import assert from "node:assert/strict";
import test from "node:test";
import { assessProjectedQuote, buildPriceFreshnessTelemetry } from "./lp-quote-gate.mjs";

const allow = { state: "ALLOW" };
const activeAsk = { plan: "ONE_SIDED", ask: { enabled: true, action: "SELL_YES", targetPriceRaw: "600000", targetQuantityRaw: "1000" } };

test("NO_QUOTE is nonfatal and reaches no writer action", () => {
  let chainWrites = 0;
  const result = assessProjectedQuote({ projectedDecision: allow, quotePlan: { plan: "NO_QUOTE", ask: { enabled: false, action: "SELL_YES" } } });
  if (result.disposition === "EXECUTE") chainWrites += 1;
  assert.equal(result.disposition, "WAITING_FOR_QUOTE");
  assert.equal(result.reasonCode, "NO_QUOTE");
  assert.equal(chainWrites, 0);
});

test("disabled ask is nonfatal and reaches no writer action", () => {
  let chainWrites = 0;
  const result = assessProjectedQuote({ projectedDecision: allow, quotePlan: { plan: "ONE_SIDED", ask: { enabled: false, action: "SELL_YES" } } });
  if (result.disposition === "EXECUTE") chainWrites += 1;
  assert.equal(result.disposition, "WAITING_FOR_QUOTE");
  assert.equal(result.reasonCode, "ASK_DISABLED");
  assert.equal(chainWrites, 0);
});

test("PRICE_STALE at startup waits without writer action", () => {
  let chainWrites = 0;
  const result = assessProjectedQuote({ projectedDecision: { state: "HALT", primaryReasonCode: "PRICE_STALE" }, quotePlan: activeAsk });
  if (result.disposition === "EXECUTE") chainWrites += 1;
  assert.equal(result.disposition, "WAITING_FOR_FRESH_PRICE");
  assert.equal(result.reasonCode, "PRICE_STALE");
  assert.equal(chainWrites, 0);
});

test("PRICE_STALE during reevaluation stays alive without new risk or writes", () => {
  let reevaluations = 0;
  let chainWrites = 0;
  for (let index = 0; index < 2; index += 1) {
    reevaluations += 1;
    const result = assessProjectedQuote({ projectedDecision: { state: "HALT", primaryReasonCode: "PRICE_STALE" }, quotePlan: activeAsk });
    if (result.disposition === "EXECUTE") chainWrites += 1;
    assert.equal(result.disposition, "WAITING_FOR_FRESH_PRICE");
  }
  assert.equal(reevaluations, 2);
  assert.equal(chainWrites, 0);
});

test("fresh price resumes the existing SELL_YES quote path", () => {
  const stale = assessProjectedQuote({ projectedDecision: { state: "HALT", primaryReasonCode: "PRICE_STALE" }, quotePlan: activeAsk });
  const fresh = assessProjectedQuote({ projectedDecision: { state: "ALLOW" }, quotePlan: { plan: "ACTIVE", ask: activeAsk.ask } });
  assert.equal(stale.disposition, "WAITING_FOR_FRESH_PRICE");
  assert.equal(fresh.disposition, "EXECUTE");
  assert.equal(fresh.reasonCode, "SELL_YES_READY");
});

test("other HALT reasons remain fail-closed", () => {
  const result = assessProjectedQuote({ projectedDecision: { state: "HALT", primaryReasonCode: "DRAWDOWN_HARD_STOP" }, quotePlan: activeAsk });
  assert.equal(result.disposition, "FAIL_CLOSED");
  assert.equal(result.reasonCode, "PROJECTED_RISK_HALT");
});

test("freshness telemetry preserves source age availability and last fresh timestamp", () => {
  const stale = buildPriceFreshnessTelemetry({
    snapshot: { chainTime: { chainNowSec: 100 }, feed: { timestampSec: 80, sourceAgeSec: 61 } },
    decision: { state: "HALT", primaryReasonCode: "PRICE_STALE" },
    maxPriceAgeSec: 15,
    maxSourceAgeSec: 60,
  });
  assert.equal(stale.feedAgeSec, 20);
  assert.equal(stale.sourceAgeSec, 61);
  assert.equal(stale.lastFreshPriceTimestampSec, null);
  assert.deepEqual(stale.freshnessThresholds, { maxFeedAgeSec: 15, maxSourceAgeSec: 60 });

  const fresh = buildPriceFreshnessTelemetry({
    snapshot: { chainTime: { chainNowSec: 100 }, feed: { timestampSec: 99, sourceAgeSec: null } },
    decision: { state: "ALLOW" },
    lastFreshPriceTimestampSec: null,
    maxPriceAgeSec: 15,
    maxSourceAgeSec: 60,
  });
  assert.equal(fresh.sourceAgeSec, null);
  assert.equal(fresh.lastFreshPriceTimestampSec, 99);
});


test("valid SELL_YES preserves the execution disposition", () => {
  const result = assessProjectedQuote({ projectedDecision: allow, quotePlan: { plan: "ACTIVE", ask: activeAsk.ask } });
  assert.equal(result.disposition, "EXECUTE");
  assert.equal(result.reasonCode, "SELL_YES_READY");
});

test("action mismatch fails closed and cannot reach a writer", () => {
  let chainWrites = 0;
  const result = assessProjectedQuote({ projectedDecision: allow, quotePlan: { plan: "ONE_SIDED", ask: { enabled: true, action: "BUY_YES" } } });
  if (result.disposition === "EXECUTE") chainWrites += 1;
  assert.equal(result.disposition, "FAIL_CLOSED");
  assert.equal(result.reasonCode, "QUOTE_ACTION_MISMATCH");
  assert.equal(chainWrites, 0);
});
