import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createOperatorAuth } from "./auth.mjs";
import { createOperatorApiServer, createProductionOperatorServer } from "../../scripts/operator-api.mjs";

async function request(base, path, { method = "GET", body, token, origin = "http://allowed.test" } = {}) {
  const headers = { Origin: origin };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test("operator API rejects unauthorized controls and permits an authorized session", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const auth = createOperatorAuth({ authorizedAddress: account.address });
  const calls = [];
  const control = {
    async getState() { return { state: "STOPPED", executionEnabled: false, controls: { canStart: true } }; },
    getConfig() { return { config: { series: "BTC 5m" } }; },
    getActivity() { return []; },
    async start(config) { calls.push(["start", config]); return { state: "STARTING" }; },
    async pause() { calls.push(["pause"]); return { state: "PAUSED" }; },
    async resume() { calls.push(["resume"]); return { state: "WATCHING" }; },
    async stop(reason) { calls.push(["stop", reason]); return { state: "STOPPING" }; },
    async emergencyCancelAll() { calls.push(["cancel-all"]); return { state: "STOPPING" }; },
  };
  const server = createOperatorApiServer({ control, auth, allowedOrigins: ["http://allowed.test"] });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const rejected = await request(base, "/state");
    assert.equal(rejected.status, 401);
    const invalidToken = await request(base, "/state", { token: "invalid-session-token" });
    assert.equal(invalidToken.status, 401);
    const health = await request(base, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.execution, "disabled");
    const nonce = await request(base, "/auth/nonce", { method: "POST", body: { address: account.address } });
    const signature = await account.signMessage({ message: nonce.body.message });
    const verified = await request(base, "/auth/verify", { method: "POST", body: { ...nonce.body, signature } });
    assert.equal(verified.status, 200);
    const state = await request(base, "/state", { token: verified.body.token });
    assert.equal(state.status, 200);
    const started = await request(base, "/session/start", { method: "POST", token: verified.body.token, body: { capitalAllocationHuman: 0.001 } });
    assert.equal(started.status, 202);
    assert.deepEqual(calls, [["start", { capitalAllocationHuman: 0.001 }]]);
    const originRejected = await request(base, "/health", { origin: "http://not-allowed.test" });
    assert.equal(originRejected.status, 403);
  } finally {
    server.close();
  }
});

test("operator API rate limits repeated requests per client", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const server = createOperatorApiServer({
    control: { async getState() { return { state: "STOPPED", executionEnabled: false }; } },
    auth: createOperatorAuth({ authorizedAddress: account.address }),
    allowedOrigins: ["http://allowed.test"],
    rateLimit: { windowMs: 60_000, maxRequests: 1 },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await request(base, "/health")).status, 200);
    const limited = await request(base, "/health");
    assert.equal(limited.status, 429);
    assert.equal(limited.body.code, "RATE_LIMITED");
    assert.ok(limited.headers.get("retry-after"));
  } finally {
    server.close();
  }
});

test("unarmed production API boots without a private key and never reaches the writer", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  let privateKeyReads = 0;
  let runnerSpawns = 0;
  const env = new Proxy({
    OPERATOR_ADDRESS: account.address,
    VILLA_ALLOWED_ORIGINS: "http://allowed.test",
    VILLA_EXECUTION_ENABLED: "false",
  }, {
    get(target, property, receiver) {
      if (property === "OPERATOR_PRIVATE_KEY") {
        privateKeyReads += 1;
        throw new Error("OPERATOR_PRIVATE_KEY must not be read in safe mode");
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const server = createProductionOperatorServer(env, {
    readOnlyReader: async () => ({ mode: "LIVE", snapshot: { market: { intervalSec: 300 } }, evidence: null }),
    runnerFactory: async () => {
      runnerSpawns += 1;
      throw new Error("the runner must not spawn while execution is disabled");
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await request(base, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.execution, "disabled");
    assert.equal(health.headers.get("access-control-allow-origin"), "http://allowed.test");
    assert.equal(health.headers.get("access-control-allow-credentials"), "true");
    assert.notEqual(health.headers.get("access-control-allow-origin"), "*");

    const unauthorized = await request(base, "/state");
    assert.equal(unauthorized.status, 401);

    const nonce = await request(base, "/auth/nonce", { method: "POST", body: { address: account.address } });
    const signature = await account.signMessage({ message: nonce.body.message });
    const verified = await request(base, "/auth/verify", { method: "POST", body: { ...nonce.body, signature } });
    assert.equal(verified.status, 200);

    const token = verified.body.token;
    const config = await request(base, "/config", { token });
    assert.equal(config.status, 200);
    assert.equal(config.body.executionEnabled, false);
    const activity = await request(base, "/activity", { token });
    assert.equal(activity.status, 200);
    assert.deepEqual(activity.body.activity, []);
    const state = await request(base, "/state", { token });
    assert.equal(state.status, 200);
    assert.equal(state.body.state, "STOPPED");
    assert.equal(state.body.executionEnabled, false);
    assert.equal(state.body.readOnly.mode, "LIVE");

    const started = await request(base, "/session/start", { method: "POST", token, body: {} });
    assert.equal(started.status, 423);
    assert.equal(started.body.code, "EXECUTION_DISABLED");
    assert.equal(runnerSpawns, 0);
    assert.equal(privateKeyReads, 0);
    assert.equal(JSON.stringify(state.body).includes("OPERATOR_PRIVATE_KEY"), false);
  } finally {
    server.close();
  }
});
