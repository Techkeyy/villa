import assert from "node:assert/strict";
import test from "node:test";
import { createAccountBoundControlPlane } from "./account-control.mjs";

const OWNER = "0x2222222222222222222222222222222222222222";
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x3333333333333333333333333333333333333333";

function controller() {
  let session = { version: "villa-lp-session-v1", sessionId: "account-control", account: ACCOUNT, owner: OWNER, operator: OPERATOR, marketSeries: "BTC 1h", currentMarketId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", state: "CREATED" };
  const calls = [];
  return {
    calls,
    getState: () => ({ session }),
    async start(facts) { calls.push(["start", facts]); session = { ...session, state: "RUNNING" }; return { started: true, session }; },
    async pause(input) { calls.push(["pause", input]); session = { ...session, state: "PAUSED" }; return { session }; },
    async resume(facts) { calls.push(["resume", facts]); session = { ...session, state: "RUNNING" }; return { started: true, session }; },
    async stop(input) { calls.push(["stop", input]); session = { ...session, state: "STOPPED" }; return { session }; },
  };
}

function facts() {
  return { owner: { address: OWNER }, account: { address: ACCOUNT }, session: null };
}

test("safe account control exposes readiness but never starts while public or execution gates are off", async () => {
  const underlying = controller();
  const control = createAccountBoundControlPlane({ sessionController: underlying, factsReader: facts, executionEnabled: false, publicEnabled: false, preflight: () => ({ allowed: true, reasons: [] }) });
  const state = await control.getState({ caller: OWNER });
  assert.equal(state.state, "STOPPED");
  assert.equal(state.safety.signerInBrowser, false);
  assert.equal(state.safety.arbitraryRelay, false);
  assert.ok(state.readiness.reasons.includes("PUBLIC_CONTROL_PLANE_DISABLED"));
  assert.ok(state.readiness.reasons.includes("EXECUTION_DISABLED"));
  await assert.rejects(() => control.start({ caller: OWNER }), { code: "PUBLIC_CONTROL_PLANE_DISABLED" });
  assert.deepEqual(underlying.calls, []);
});

test("enabled integration delegates only after preflight and keeps caller/account scope", async () => {
  const underlying = controller();
  const seen = [];
  const control = createAccountBoundControlPlane({ sessionController: underlying, factsReader: facts, executionEnabled: true, publicEnabled: true, preflight: (input) => { seen.push(input); return { allowed: true, reasons: [] }; } });
  const started = await control.start({ caller: OWNER });
  assert.equal(started.started, true);
  assert.equal(underlying.calls[0][0], "start");
  assert.equal(seen[0].session.account, ACCOUNT);
  await control.stop({ caller: OWNER });
  assert.equal(underlying.calls[1][0], "stop");
  assert.equal(typeof control.withdraw, "undefined");
  await assert.rejects(() => control.getState({ caller: "0x4444444444444444444444444444444444444444" }), { code: "OWNER_SCOPE_MISMATCH" });
});

test("Stop ignores client cleanup values and uses trusted account facts", async () => {
  const underlying = controller();
  const trustedOrder = { account: ACCOUNT, owner: ACCOUNT, marketId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", orderId: 7 };
  const control = createAccountBoundControlPlane({ sessionController: underlying, factsReader: () => ({ ...facts(), cleanup: { openOrders: [trustedOrder], burnAmountRaw: 7n, marketId: trustedOrder.marketId } }), executionEnabled: true, publicEnabled: true, preflight: () => ({ allowed: true, reasons: [] }) });
  await control.start({ caller: OWNER });
  await control.stop({ caller: OWNER, openOrders: [{ orderId: 999 }], burnAmountRaw: 999n, marketId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
  assert.deepEqual(underlying.calls[1][1], { openOrders: [trustedOrder], burnAmountRaw: 7n, marketId: trustedOrder.marketId });
});

test("preflight denial blocks Start and passes exact reasons to the caller", async () => {
  const underlying = controller();
  const control = createAccountBoundControlPlane({ sessionController: underlying, factsReader: facts, executionEnabled: true, publicEnabled: true, preflight: () => ({ allowed: false, reasons: ["RISK_HALTED", "STALE_MARKET_ID"] }) });
  await assert.rejects(() => control.start({ caller: OWNER }), (error) => error.code === "ACCOUNT_PREFLIGHT_BLOCKED" && error.details.reasons.includes("RISK_HALTED") && error.details.reasons.includes("STALE_MARKET_ID"));
  assert.deepEqual(underlying.calls, []);
});
