import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const sessionSource = fs.readFileSync(new URL("../../scripts/lp-account-session.mjs", import.meta.url), "utf8");

test("strategy session keeps distinct session, cycle, and cleanup budgets", () => {
  assert.match(sessionSource, /let sessionTxIndex = 0/);
  assert.match(sessionSource, /let cycleTxIndex = 0/);
  assert.match(sessionSource, /let cleanupTxIndex = 0/);
  assert.match(sessionSource, /cycleTxIndex = 0;\n      const chain/);
  assert.match(sessionSource, /cleanupTxIndex = 0;\n      session = transitionLpSession/);
  assert.match(sessionSource, /budget: "cleanup"/);
});

test("cycle cap exhaustion requests a safety stop instead of generic failure", () => {
  assert.match(sessionSource, /if \(error\?\.code !== "TX_COUNT_CAP"\) return false/);
  assert.match(sessionSource, /requestStop\("TX_COUNT_CAP"\)/);
  assert.match(sessionSource, /Transaction safety limit reached; blocking new risk/);
});

test("cleanup remains bounded by the existing transaction policy", () => {
  assert.match(sessionSource, /policy\.prepare\(.*cycleTxIndex: budgetIndex/s);
  assert.match(sessionSource, /if \(budget === "cleanup"\) cleanupTxIndex \+= 1/);
});
