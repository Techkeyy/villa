import assert from "node:assert/strict";
import test from "node:test";
import { assessProjectedQuote } from "./lp-quote-gate.mjs";

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

test("HALT remains fail-closed", () => {
  const result = assessProjectedQuote({ projectedDecision: { state: "HALT", primaryReasonCode: "PRICE_STALE" }, quotePlan: activeAsk });
  assert.equal(result.disposition, "FAIL_CLOSED");
  assert.equal(result.reasonCode, "PROJECTED_RISK_HALT");
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
