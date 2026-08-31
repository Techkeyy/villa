import assert from "node:assert/strict";
import test from "node:test";
import { safeLpLogEvent, safeLpLogJson } from "./lp-logging.mjs";

test("execution logs use a safe allowlist and retain public operational facts", () => {
  const event = safeLpLogEvent({ event: "LP_ONE_CYCLE_SHADOW", account: "0x111", marketId: "0xaaa", broadcast: false, amountRaw: 123n, OPERATOR_PRIVATE_KEY: "must-not-appear", seed: "must-not-appear" });
  assert.equal(event.event, "LP_ONE_CYCLE_SHADOW");
  assert.equal(event.broadcast, false);
  assert.equal("amountRaw" in event, false);
  assert.equal("OPERATOR_PRIVATE_KEY" in event, false);
  assert.equal("seed" in event, false);
  assert.equal(safeLpLogJson(event).includes("must-not-appear"), false);
});
