import assert from "node:assert/strict";
import test from "node:test";
import { decideRunningQuote } from "./lp-running-quote.mjs";

const ask = { targetPriceRaw: "700000", targetQuantityRaw: "1000" };
const order = { isBid: false, priceRaw: "700000", quantityRemainingRaw: "1000" };

test("running quote keeps an unchanged SELL_YES order", () => {
  assert.deepEqual(decideRunningQuote({ readiness: { disposition: "EXECUTE" }, currentOrder: order, desiredAsk: ask }), { action: "KEEP", state: "RUNNING", reasonCode: "HYSTERESIS_HOLDS" });
});
test("running quote places or replaces only when needed", () => {
  assert.equal(decideRunningQuote({ readiness: { disposition: "EXECUTE" }, desiredAsk: ask }).action, "PLACE");
  assert.equal(decideRunningQuote({ readiness: { disposition: "EXECUTE" }, currentOrder: { ...order, priceRaw: "710000" }, desiredAsk: ask }).action, "REPLACE");
});
test("stale or empty quote suspends new risk and cancels only an existing quote", () => {
  assert.equal(decideRunningQuote({ readiness: { disposition: "WAITING_FOR_FRESH_PRICE", reasonCode: "PRICE_STALE" }, desiredAsk: ask }).action, "WAIT");
  assert.equal(decideRunningQuote({ readiness: { disposition: "WAITING_FOR_QUOTE", reasonCode: "NO_QUOTE" }, currentOrder: order, desiredAsk: ask }).action, "CANCEL");
});
test("genuine safety failure halts and never authorizes a place", () => {
  assert.equal(decideRunningQuote({ readiness: { disposition: "FAIL_CLOSED", reasonCode: "PROJECTED_RISK_HALT" }, desiredAsk: ask }).action, "HALT");
  assert.equal(decideRunningQuote({ readiness: { disposition: "FAIL_CLOSED", reasonCode: "PROJECTED_RISK_HALT" }, currentOrder: order, desiredAsk: ask }).action, "HALT_CANCEL");
});
