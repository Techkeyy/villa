import assert from "node:assert/strict";
import test from "node:test";
import { CONTROL_ACTIVE_STATES, CONTROL_STOP_TERMINAL_STATES, ControlClientError, controlStateAfterPollFailure, controlTransactionView, createAccountControlClient, reconcileControlPayload, waitForControlStop } from "../../dashboard/control-client.mjs";

const OWNER = "0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d";

function response(body, ok = true, status = 200) {
  return { ok, status, async json() { return body; } };
}

test("control client authenticates and sends the selected account scope", async () => {
  globalThis.window = { location: { hostname: "localhost" } };
  const calls = [];
  const responses = [
    response({ engineApiUrl: "http://127.0.0.1:8782" }),
    response({ message: "VILLA sign-in", nonce: "nonce-1", address: OWNER }),
    response({ token: "session-token" }),
    response({ code: "EXECUTION_DISABLED", error: "safe mode", requestId: "req-1" }, false, 423),
  ];
  const provider = {
    async request({ method }) {
      assert.equal(method, "personal_sign");
      return "0xsignature";
    },
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return responses.shift();
  };
  const account = "0x1111111111111111111111111111111111111111";
  const client = createAccountControlClient({ fetchImpl, provider, ownerProvider: () => OWNER, accountProvider: () => account });

  await assert.rejects(client.start(), (error) => error instanceof ControlClientError && error.code === "EXECUTION_DISABLED");
  const request = calls.at(-1);
  assert.equal(request.url, "http://127.0.0.1:8782/account/session/start");
  assert.deepEqual(JSON.parse(request.options.body), { account });
  assert.match(request.options.headers.Authorization, /^Bearer session-token$/);
});

test("control client keeps wallet cancellation stable and does not verify", async () => {
  globalThis.window = { location: { hostname: "localhost" } };
  const calls = [];
  const responses = [
    response({ engineApiUrl: "http://127.0.0.1:8782" }),
    response({ message: "VILLA sign-in", nonce: "nonce-2", address: OWNER }),
  ];
  const provider = { async request() { throw { code: 4001 }; } };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return responses.shift();
  };
  const client = createAccountControlClient({ fetchImpl, provider, ownerProvider: () => OWNER, accountProvider: () => "0x1111111111111111111111111111111111111111" });

  await assert.rejects(client.start(), (error) => error instanceof ControlClientError && error.code === "WALLET_REJECTED");
  assert.equal(calls.filter(({ url }) => url.endsWith("/account/auth/verify")).length, 0);
});

test("control client exposes only fixed safe controls", () => {
  globalThis.window = { location: { hostname: "localhost" } };
  const client = createAccountControlClient({ fetchImpl: async () => response({ engineApiUrl: "http://127.0.0.1:8782" }) });
  assert.deepEqual(Object.keys(client).sort(), ["authenticate", "clear", "loadConfig", "settle", "start", "state", "stop"]);
  assert.equal("sendTransaction" in client, false);
  assert.equal("withdraw" in client, false);
});

test("control client includes the selected account on read state requests", async () => {
  globalThis.window = { location: { hostname: "localhost" } };
  const account = "0x2222222222222222222222222222222222222222";
  const calls = [];
  const responses = [
    response({ engineApiUrl: "http://127.0.0.1:8782" }),
    response({ message: "VILLA sign-in", nonce: "nonce-3", address: OWNER }),
    response({ token: "session-token" }),
    response({ state: "STOPPED" }),
  ];
  const provider = { async request() { return "0xsignature"; } };
  const fetchImpl = async (url, options = {}) => { calls.push({ url, options }); return responses.shift(); };
  const client = createAccountControlClient({ fetchImpl, provider, ownerProvider: () => OWNER, accountProvider: () => account });
  await client.state();
  assert.equal(new URL(calls.at(-1).url).searchParams.get("account"), account);
});

test("control client accepts a same-account Start reattachment response", async () => {
  globalThis.window = { location: { hostname: "localhost" } };
  const account = "0x3333333333333333333333333333333333333333";
  const session = { sessionId: "uat-1234567891-abcdef12", owner: OWNER, account, state: "RUNNING" };
  const responses = [
    response({ engineApiUrl: "http://127.0.0.1:8782" }),
    response({ message: "VILLA sign-in", nonce: "nonce-4", address: OWNER }),
    response({ token: "session-token" }),
    response({ state: "RUNNING", session }, true, 202),
  ];
  const provider = { async request() { return "0xsignature"; } };
  const client = createAccountControlClient({ fetchImpl: async () => responses.shift(), provider, ownerProvider: () => OWNER, accountProvider: () => account });
  const attached = await client.start();
  assert.equal(attached.state, "RUNNING");
  assert.deepEqual(attached.session, session);
});

test("state polling renews an expired session once without retrying the command", async () => {
  globalThis.window = { location: { hostname: "localhost" } };
  const account = "0x3333333333333333333333333333333333333333";
  const responses = [
    response({ engineApiUrl: "http://127.0.0.1:8782" }),
    response({ message: "VILLA sign-in", nonce: "nonce-expired-1", address: OWNER }),
    response({ token: "expired-token", expiresAt: Date.now() - 1 }),
    response({ code: "SESSION_REQUIRED", error: "expired" }, false, 401),
    response({ message: "VILLA sign-in", nonce: "nonce-expired-2", address: OWNER }),
    response({ token: "fresh-token", expiresAt: Date.now() + 60_000 }),
    response({ state: "ERROR", error: { code: "ACCOUNT_CAPITAL_CAP", message: "account capital exceeds the bounded sustained-UAT cap" } }),
  ];
  let signatures = 0;
  const provider = { async request() { signatures += 1; return "0xsignature"; } };
  const client = createAccountControlClient({ fetchImpl: async () => responses.shift(), provider, ownerProvider: () => OWNER, accountProvider: () => account });
  const state = await client.state();
  assert.equal(state.state, "ERROR");
  assert.equal(signatures, 2);
});

test("expired command authentication does not automatically retry Start", async () => {
  globalThis.window = { location: { hostname: "localhost" } };
  const account = "0x4444444444444444444444444444444444444444";
  const responses = [
    response({ engineApiUrl: "http://127.0.0.1:8782" }),
    response({ message: "VILLA sign-in", nonce: "nonce-command", address: OWNER }),
    response({ token: "command-token", expiresAt: Date.now() + 60_000 }),
    response({ code: "SESSION_REQUIRED", error: "expired" }, false, 401),
  ];
  let signatures = 0;
  const provider = { async request() { signatures += 1; return "0xsignature"; } };
  const calls = [];
  const client = createAccountControlClient({ fetchImpl: async (url) => { calls.push(url); return responses.shift(); }, provider, ownerProvider: () => OWNER, accountProvider: () => account });
  await assert.rejects(client.start(), { code: "SESSION_REQUIRED" });
  assert.equal(signatures, 1);
  assert.equal(calls.filter((url) => url.endsWith("/account/session/start")).length, 1);
});

test("control stop polling waits for the terminal state", async () => {
  const states = ["STOPPING", "STOPPING", "STOPPED"];
  const observed = [];
  const result = await waitForControlStop(
    async () => ({ state: states.shift() }),
    { delayMs: 0, onState: (_payload, state) => observed.push(state) },
  );
  assert.equal(result.complete, true);
  assert.equal(result.state, "STOPPED");
  assert.deepEqual(observed, ["STOPPING", "STOPPING", "STOPPED"]);
});

test("control stop polling reports an unfinished reconciliation without claiming success", async () => {
  const result = await waitForControlStop(async () => ({ state: "STOPPING" }), { delayMs: 0, maxAttempts: 2 });
  assert.equal(result.complete, false);
  assert.equal(result.state, "STOPPING");
});

test("stop terminal states include clean completion and cleanup error", () => {
  assert.ok(CONTROL_STOP_TERMINAL_STATES.includes("STOPPED_CLEAN"));
  assert.ok(CONTROL_STOP_TERMINAL_STATES.includes("ERROR"));
});

test("authoritative clean terminal state reconciles stale RUNNING state to STOPPED", () => {
  const reconciled = reconcileControlPayload(
    { state: "STOPPED_CLEAN", session: null, result: { status: "STOPPED_CLEAN", reason: "SESSION_DURATION_CAP" } },
    { state: "RUNNING", session: { sessionId: "uat-stale" }, snapshot: { strategy: { side: "SELL_YES" } }, result: null },
  );
  assert.equal(reconciled.state, "STOPPED");
  assert.equal(reconciled.session, null);
  assert.equal(reconciled.snapshot, null);
  assert.equal(reconciled.result.reason, "SESSION_DURATION_CAP");
  assert.equal(reconciled.active, false);
});

test("authoritative ERROR clears stale active session without claiming it stopped", () => {
  const reconciled = reconcileControlPayload(
    { state: "ERROR", session: null, error: { code: "UAT_SESSION_FAILED" } },
    { state: "RUNNING", session: { sessionId: "uat-stale" }, snapshot: { strategy: { side: "SELL_YES" } }, result: null },
  );
  assert.equal(reconciled.state, "ERROR");
  assert.equal(reconciled.session, null);
  assert.equal(reconciled.snapshot, null);
  assert.equal(reconciled.result, null);
});

test("authoritative nested ERROR overrides a stale STARTING outer state", () => {
  const reconciled = reconcileControlPayload(
    { state: "STARTING", session: { state: "ERROR", sessionId: "uat-failed" }, error: { code: "ACCOUNT_PREFLIGHT_BLOCKED" } },
    { state: "RUNNING", session: { sessionId: "uat-failed" }, snapshot: { strategy: { side: "SELL_YES" } } },
  );
  assert.equal(reconciled.state, "ERROR");
  assert.equal(reconciled.active, false);
});

test("current active settlement state outranks an old terminal result", () => {
  const reconciled = reconcileControlPayload(
    { state: "SETTLING", session: { state: "SETTLING", sessionId: "uat-settling" }, result: { status: "SETTLED" } },
    { state: "RUNNING", session: { sessionId: "uat-settling" }, result: { status: "SETTLED" } },
  );
  assert.equal(reconciled.state, "SETTLING");
  assert.equal(reconciled.active, true);

});

test("authoritative nested result ERROR overrides a stale RECONNECTING outer state", () => {
  const reconciled = reconcileControlPayload(
    { state: "RECONNECTING", session: null, result: { status: "ERROR", code: "ACCOUNT_CAPITAL_CAP" } },
    { state: "RUNNING", session: { sessionId: "uat-failed" }, snapshot: { strategy: { side: "SELL_YES" } } },
  );
  assert.equal(reconciled.state, "ERROR");
  assert.equal(reconciled.active, false);
});

test("transient polling failure enters reconnecting instead of fake STOPPED", () => {
  assert.equal(controlStateAfterPollFailure("RUNNING"), "RECONNECTING");
  assert.equal(controlStateAfterPollFailure("RECONNECTING"), "RECONNECTING");
  assert.notEqual(controlStateAfterPollFailure("RUNNING"), "STOPPED");
});

test("a subsequent authoritative poll replaces reconnecting state and preserves completed result", () => {
  const reconciled = reconcileControlPayload(
    { state: "STOPPED_CLEAN", session: null, result: { status: "STOPPED_CLEAN", reason: "OWNER_STOP" } },
    { state: "RECONNECTING", session: { sessionId: "uat-stale" }, snapshot: null, result: null },
  );
  assert.equal(reconciled.state, "STOPPED");
  assert.equal(reconciled.result.reason, "OWNER_STOP");
});

test("control command requests remain single-shot while state reconciliation is read-only", async () => {
  globalThis.window = { location: { hostname: "localhost" } };
  const account = "0x5555555555555555555555555555555555555555";
  const calls = [];
  const responses = [
    response({ engineApiUrl: "http://127.0.0.1:8782" }),
    response({ message: "VILLA sign-in", nonce: "nonce-single-shot", address: OWNER }),
    response({ token: "session-token" }),
    response({ state: "RUNNING", session: { sessionId: "uat-one", account } }),
  ];
  const provider = { async request() { return "0xsignature"; } };
  const client = createAccountControlClient({ fetchImpl: async (url, options = {}) => { calls.push({ url, options }); return responses.shift(); }, provider, ownerProvider: () => OWNER, accountProvider: () => account });
  await client.start();
  assert.equal(calls.filter(({ url }) => url.endsWith("/account/session/start")).length, 1);
  assert.equal(calls.filter(({ url }) => url.endsWith("/account/session/stop")).length, 0);
});

test("stop command requests remain single-shot while completion polling stays read-only", async () => {
  globalThis.window = { location: { hostname: "localhost" } };
  const account = "0x6666666666666666666666666666666666666666";
  const calls = [];
  const responses = [
    response({ engineApiUrl: "http://127.0.0.1:8782" }),
    response({ message: "VILLA sign-in", nonce: "nonce-stop-single-shot", address: OWNER }),
    response({ token: "session-token" }),
    response({ state: "STOPPING", session: { sessionId: "uat-stop-one", account } }),
  ];
  const provider = { async request() { return "0xsignature"; } };
  const client = createAccountControlClient({ fetchImpl: async (url, options = {}) => { calls.push({ url, options }); return responses.shift(); }, provider, ownerProvider: () => OWNER, accountProvider: () => account });
  await client.stop();
  assert.equal(calls.filter(({ url }) => url.endsWith("/account/session/stop")).length, 1);
  assert.equal(calls.filter(({ url }) => url.endsWith("/account/session/start")).length, 0);
  assert.equal(calls.filter(({ url }) => url.endsWith("/account/state")).length, 0);
});

test("authoritative control state replaces the local transaction lifecycle", () => {
  assert.equal(controlTransactionView({ state: "STARTING" }).status, "CONFIRMING");
  assert.equal(controlTransactionView({ state: "RUNNING" }).status, "RUNNING");
  assert.equal(controlTransactionView({ state: "RUNNING", snapshot: { stage: { code: "WAITING_FOR_QUOTE" } } }).status, "WAITING");
  assert.equal(controlTransactionView({ state: "RUNNING", snapshot: { stage: { code: "WAITING_FOR_FRESH_PRICE" } } }).title, "Waiting for fresh market data");
  assert.equal(controlTransactionView({ state: "STOPPING" }).status, "STOPPING");
  assert.equal(controlTransactionView({ state: "SETTLING" }).status, "SETTLING");
  assert.equal(controlTransactionView({ state: "STOPPED_CLEAN", result: { status: "STOPPED_CLEAN" } }).status, "SUCCESS");
  assert.equal(controlTransactionView({ state: "ERROR", payload: { error: { code: "HALT", message: "risk halted" } } }).copy, "risk halted");
  assert.ok(CONTROL_ACTIVE_STATES.includes("WAITING_FOR_QUOTE"));
});


test("a completed transaction safety cap is rendered as a safe stop", () => {
  const view = controlTransactionView({ state: "STOPPED_CLEAN", result: { status: "STOPPED_CLEAN", reason: "TX_COUNT_CAP" } });
  assert.equal(view.status, "SUCCESS");
  assert.equal(view.title, "Strategy stopped safely");
  assert.equal(view.copy, "Transaction safety limit reached.");
  assert.notEqual(view.status, "FAILED");
});
