import assert from "node:assert/strict";
import test from "node:test";
import { LP_FAILURE_DRILL_CASES, summarizeFailureDrill } from "./lp-failure-drill.mjs";

test("the complete A-J pre-wet failure drill is enumerated and requires denial", () => {
  assert.deepEqual(LP_FAILURE_DRILL_CASES.map((item) => item.id), ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
  const result = summarizeFailureDrill(LP_FAILURE_DRILL_CASES.map((item) => ({ id: item.id, denied: true, reason: item.expected })));
  assert.equal(result.passed, true);
  assert.equal(result.cases.length, 10);
});
