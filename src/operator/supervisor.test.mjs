import test from "node:test";
import assert from "node:assert/strict";
import { createEngineSupervisor, OperatorControlError } from "./supervisor.mjs";

function harness() {
  let hooks;
  const sent = [];
  const supervisor = createEngineSupervisor({
    env: { VILLA_EXECUTION_ENABLED: "true" },
    runnerFactory: async (options) => {
      hooks = options;
      return { send: (type, reason) => sent.push({ type, reason }) };
    },
    readOnlyReader: async () => ({ mode: "LIVE", snapshot: { market: { intervalSec: 300 } }, evidence: null }),
  });
  return { supervisor, sent, hooks: () => hooks };
}

test("start rejects duplicate sessions and exposes configured state", async () => {
  const { supervisor, hooks } = harness();
  const started = await supervisor.start();
  assert.equal(started.state, "STARTING");
  await assert.rejects(supervisor.start(), (error) => error instanceof OperatorControlError && error.code === "SESSION_ALREADY_ACTIVE");
  hooks().onRecord({ event: "SESSION_STARTED", facts: {} });
  hooks().onRecord({ snapshot: { governor: "ALLOW", plan: "ACTIVE", restingOrders: 2, marketId: "0xabc" } });
  const state = await supervisor.getState();
  assert.equal(state.state, "QUOTING");
  assert.equal(state.snapshot.marketId, "0xabc");
  assert.equal(JSON.stringify(state).includes("PRIVATE_KEY"), false);
});

test("pause, resume, stop, and emergency cancel send real runner controls", async () => {
  const { supervisor, sent, hooks } = harness();
  await supervisor.start();
  hooks().onRecord({ event: "SESSION_STARTED", facts: {} });
  await supervisor.pause();
  hooks().onRecord({ event: "SESSION_PAUSED", facts: {} });
  assert.equal((await supervisor.getState()).state, "PAUSED");
  await supervisor.resume();
  hooks().onRecord({ event: "SESSION_RESUMED", facts: {} });
  await supervisor.stop();
  assert.deepEqual(sent, [
    { type: "pause", reason: "OPERATOR_PAUSE" },
    { type: "resume", reason: "OPERATOR_RESUME" },
    { type: "stop", reason: "OPERATOR_STOP" },
  ]);
  hooks().onExit({ code: 0, signal: null });
  assert.equal((await supervisor.getState()).state, "STOPPED");

  const second = harness();
  await second.supervisor.start();
  await second.supervisor.emergencyCancelAll();
  assert.deepEqual(second.sent.at(-1), { type: "stop", reason: "EMERGENCY_CANCEL_ALL" });
});

test("state reporting exposes a safe read-only preflight when stopped", async () => {
  const { supervisor } = harness();
  const state = await supervisor.getState();
  assert.equal(state.state, "STOPPED");
  assert.equal(state.readOnly.mode, "LIVE");
  assert.equal(state.controls.canStart, true);
});

test("Risk Governor HALT refuses a new session with an explicit reason", async () => {
  const supervisor = createEngineSupervisor({
    env: { VILLA_EXECUTION_ENABLED: "true" },
    runnerFactory: async () => ({ send() {} }),
    readOnlyReader: async () => ({ mode: "LIVE", snapshot: { risk: { action: "HALT", triggeredReasons: ["GAS_LOW"] } } }),
  });
  await assert.rejects(
    supervisor.start(),
    (error) => error instanceof OperatorControlError
      && error.code === "RISK_GOVERNOR_HALTED"
      && /GAS_LOW/.test(error.message),
  );
});

test("disabled execution refuses START without spawning a writer", async () => {
  let spawned = 0;
  const supervisor = createEngineSupervisor({
    env: {},
    runnerFactory: async () => { spawned += 1; return { send() {} }; },
  });
  await assert.rejects(
    supervisor.start(),
    (error) => error instanceof OperatorControlError && error.code === "EXECUTION_DISABLED" && /No writer was started/.test(error.message),
  );
  assert.equal(spawned, 0);
  const state = await supervisor.getState();
  assert.equal(state.state, "STOPPED");
  assert.equal(state.executionEnabled, false);
  assert.equal(state.activity[0].type, "CONTROL_START_REFUSED");
});

test("only explicit execution enablement can reach the runner factory", async () => {
  for (const value of [undefined, "false", "malformed"]) {
    let spawned = 0;
    const supervisor = createEngineSupervisor({ env: { VILLA_EXECUTION_ENABLED: value }, runnerFactory: async () => { spawned += 1; return { send() {} }; } });
    await assert.rejects(supervisor.start(), (error) => error.code === "EXECUTION_DISABLED");
    assert.equal(spawned, 0);
  }
  let spawned = 0;
  const armed = createEngineSupervisor({ env: { VILLA_EXECUTION_ENABLED: "true" }, runnerFactory: async () => { spawned += 1; return { send() {} }; } });
  const state = await armed.start();
  assert.equal(state.state, "STARTING");
  assert.equal(spawned, 1);
});
