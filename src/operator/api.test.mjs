import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createOperatorAuth } from "./auth.mjs";
import { createOperatorApiServer } from "../../scripts/operator-api.mjs";

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
    async getState() { return { state: "STOPPED", controls: { canStart: true } }; },
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
