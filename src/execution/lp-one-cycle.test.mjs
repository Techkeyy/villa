import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runLpOneCycle } from "./lp-one-cycle.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const SESSION = { sessionId: "one-cycle-session", account: ACCOUNT };
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OPERATOR = "0xaf4ee6c0c6ff6337f4c4f07b87c8343df73e8d37";
const WET_SESSION = { sessionId: "wet-one-cycle-session", account: ACCOUNT, operator: OPERATOR, marketSeries: "BINARY:BTC:300", currentMarketId: MARKET };
const PLAN = Object.freeze({ broadcast: false, to: ACCOUNT, account: ACCOUNT, orderOwner: ACCOUNT });

function facts() {
  return { fresh: true, session: SESSION, market: { marketId: MARKET } };
}

function wetFacts(overrides = {}) {
  return {
    fresh: true,
    session: WET_SESSION,
    lease: { held: true, account: ACCOUNT, sessionId: WET_SESSION.sessionId },
    operator: { signerAddress: OPERATOR },
    account: { operator: OPERATOR },
    market: { marketId: MARKET, series: "BINARY:BTC:300" },
    ...overrides,
  };
}

test("SHADOW is the default-safe one-cycle result and never consults a writer", async () => {
  let writerCalls = 0;
  const result = await runLpOneCycle({ request: { oneCycle: true, account: ACCOUNT, sessionId: SESSION.sessionId }, facts: facts(), buildPlans: async () => [PLAN], validatePlan: () => ({ allowed: true }), writer: { enqueue: async () => { writerCalls += 1; } } });
  assert.equal(result.status, "SHADOW");
  assert.equal(result.broadcast, false);
  assert.equal(result.writes, 0);
  assert.equal(writerCalls, 0);
});

test("wet mode stays disabled without a writer call and requires explicit fresh scope", async () => {
  let writerCalls = 0;
  const disabled = await runLpOneCycle({ mode: "WET", executionEnabled: false, request: { oneCycle: true, account: ACCOUNT, sessionId: WET_SESSION.sessionId }, facts: wetFacts(), buildPlans: async () => [PLAN], validatePlan: () => ({ allowed: true }), writer: { enqueue: async () => { writerCalls += 1; } }, preflight: () => ({ allowed: true }) });
  assert.equal(disabled.reason, "EXECUTION_DISABLED");
  assert.equal(writerCalls, 0);
  const stale = await runLpOneCycle({ request: { oneCycle: true }, facts: { ...facts(), fresh: false }, buildPlans: async () => [PLAN] });
  assert.equal(stale.reason, "FRESH_PREFLIGHT_REQUIRED");
});

test("wet mode performs one serialized plan sequence only after preflight and policy", async () => {
  const writes = [];
  const events = [];
  const result = await runLpOneCycle({
    mode: "WET",
    executionEnabled: true,
    request: { oneCycle: true, account: ACCOUNT, sessionId: WET_SESSION.sessionId },
    facts: wetFacts(),
    preflight: (input) => { assert.equal(input.executionEnabled, true); return { allowed: true }; },
    buildPlans: async () => [PLAN, { ...PLAN, action: "CANCEL_ORDER" }],
    validatePlan: () => ({ allowed: true }),
    writer: { enqueue: async (plan) => { writes.push(plan.action ?? "PLACE_ORDER"); return { state: "CONFIRMED" }; } },
    onEvent: (event) => events.push(event.event),
  });
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.broadcast, true);
  assert.equal(result.writes, 2);
  assert.deepEqual(writes, ["PLACE_ORDER", "CANCEL_ORDER"]);
  assert.deepEqual(events, ["LP_ONE_CYCLE_COMPLETE"]);
});

test("one-cycle coordinator rejects loops, rollover, missing policy, and non-broadcast plans", async () => {
  const loop = await runLpOneCycle({ request: { oneCycle: true, loop: true }, facts: facts(), buildPlans: async () => [PLAN] });
  assert.equal(loop.reason, "ONE_CYCLE_ONLY");
  const denied = await runLpOneCycle({ mode: "WET", executionEnabled: true, request: { oneCycle: true, account: ACCOUNT, sessionId: WET_SESSION.sessionId }, facts: wetFacts(), buildPlans: async () => [PLAN], preflight: () => ({ allowed: true }), writer: { enqueue: async () => undefined } });
  assert.equal(denied.reason, "POLICY_REQUIRED");
  const shadowPolicy = await runLpOneCycle({ request: { oneCycle: true, account: ACCOUNT, sessionId: SESSION.sessionId }, facts: facts(), buildPlans: async () => [PLAN] });
  assert.equal(shadowPolicy.reason, "POLICY_REQUIRED");
  const broadcast = await runLpOneCycle({ request: { oneCycle: true, account: ACCOUNT, sessionId: SESSION.sessionId }, facts: facts(), buildPlans: async () => [{ broadcast: true }], validatePlan: () => ({ allowed: true }) });
  assert.equal(broadcast.reason, "BROADCAST_BOUNDARY");
});

test("wet mode denies missing or mismatched signer, revoked operator, held-lease mismatch, and RPC timeout before a writer", async () => {
  const options = { mode: "WET", executionEnabled: true, request: { oneCycle: true, account: ACCOUNT, sessionId: WET_SESSION.sessionId }, buildPlans: async () => [PLAN], validatePlan: () => ({ allowed: true }), preflight: () => ({ allowed: true }), writer: { enqueue: async () => { throw new Error("must not write"); } } };
  const missingSigner = await runLpOneCycle({ ...options, facts: wetFacts({ operator: {} }) });
  assert.equal(missingSigner.reason, "SIGNER_MISMATCH");
  const revoked = await runLpOneCycle({ ...options, facts: wetFacts({ account: { operator: "0x5555555555555555555555555555555555555555" } }) });
  assert.equal(revoked.reason, "OPERATOR_NOT_AUTHORIZED");
  const leaseHeldElsewhere = await runLpOneCycle({ ...options, facts: wetFacts({ lease: { held: true, account: "0x5555555555555555555555555555555555555555", sessionId: "other" } }) });
  assert.equal(leaseHeldElsewhere.reason, "ACCOUNT_LEASE_REQUIRED");
  const timeout = await runLpOneCycle({ ...options, readFreshFacts: async () => { throw Object.assign(new Error("timeout"), { code: "TIMEOUT" }); } });
  assert.equal(timeout.reason, "FRESH_FACTS_UNAVAILABLE");
});

test("the shell entrypoint is shadow-only while the signer runtime is absent", () => {
  const child = spawnSync(process.execPath, ["scripts/lp-one-cycle.mjs", "--one-cycle", `--account=${ACCOUNT}`, "--session-id=cli-test-session"], { encoding: "utf8", env: { ...process.env, VILLA_EXECUTION_ENABLED: "false", VILLA_EXECUTION_MODE: "WET", OPERATOR_PRIVATE_KEY: undefined } });
  assert.equal(child.status, 2);
  const result = JSON.parse(child.stdout);
  assert.equal(result.result, "REFUSED");
  assert.equal(result.code, "EXECUTION_DISABLED");
  assert.equal(result.broadcast, false);
  assert.equal(result.writes, 0);
});

test("the shell entrypoint refuses a one-cycle request without explicit account and session", () => {
  const child = spawnSync(process.execPath, ["scripts/lp-one-cycle.mjs", "--one-cycle"], { encoding: "utf8", env: { ...process.env, VILLA_EXECUTION_ENABLED: "false", VILLA_EXECUTION_MODE: "SHADOW", OPERATOR_PRIVATE_KEY: undefined } });
  assert.equal(child.status, 2);
  assert.equal(JSON.parse(child.stderr).code, "ACCOUNT_SESSION_REQUIRED");
});
