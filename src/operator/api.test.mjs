import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createOperatorAuth } from "./auth.mjs";
import { AccountControlError } from "./account-control.mjs";
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
    const arbitrary = await request(base, "/session/start", { method: "POST", token: verified.body.token, body: { to: account.address, data: "0xdeadbeef" } });
    assert.equal(arbitrary.status, 400);
    assert.equal(arbitrary.body.code, "ARBITRARY_CALL_DENIED");
    assert.equal(calls.length, 1);
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


test("production release wires owner-authenticated safe account control", async () => {
  const operator = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  const villaAccount = "0x1111111111111111111111111111111111111111";
  let runnerSpawns = 0;
  const env = {
    OPERATOR_ADDRESS: operator.address,
    VILLA_ENGINE_OPERATOR: operator.address,
    VILLA_ALLOWED_ORIGINS: "http://allowed.test",
    VILLA_EXECUTION_ENABLED: "false",
  };
  const server = createProductionOperatorServer(env, {
    readOnlyReader: async () => ({ mode: "LIVE", snapshot: null }),
    runnerFactory: async () => { runnerSpawns += 1; throw new Error("runner must not spawn"); },
    accountVerifier: async ({ caller, account }) => ({ account, owner: caller, operator: operator.address, accountVersion: 2, version: 2, runtimeVerified: true, onChain: true }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const accountRejected = await request(base, "/account/state");
    assert.equal(accountRejected.status, 401);
    assert.match(accountRejected.body.error, /owner wallet/i);
    assert.doesNotMatch(accountRejected.body.error, /operator wallet/i);
    const nonce = await request(base, "/account/auth/nonce", { method: "POST", body: { address: owner.address } });
    assert.equal(nonce.status, 200);
    const signature = await owner.signMessage({ message: nonce.body.message });
    const verified = await request(base, "/account/auth/verify", { method: "POST", body: { ...nonce.body, signature } });
    assert.equal(verified.status, 200);
    const token = verified.body.token;
    const state = await request(base, "/account/state?account=" + villaAccount, { token });
    assert.equal(state.status, 200);
    assert.equal(state.body.safety.executionEnabled, false);
    assert.equal(state.body.safety.arbitraryRelay, false);
    assert.equal(state.body.safety.withdrawViaControl, false);
    assert.ok(state.body.readiness.reasons.includes("ACCOUNT_EXECUTION_DISABLED"));
    const started = await request(base, "/account/session/start", { method: "POST", token, body: { account: villaAccount } });
    assert.equal(started.status, 423);
    assert.equal(started.body.code, "ACCOUNT_EXECUTION_DISABLED");
    const stopped = await request(base, "/account/session/stop", { method: "POST", token, body: { account: villaAccount } });
    assert.equal(stopped.status, 202);
    assert.equal(stopped.body.executionEnabled, false);
    assert.equal(runnerSpawns, 0);
  } finally {
    server.close();
  }
});

test("verified account Start works with global execution false and the account gate true", async () => {
  const operator = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  const villaAccount = "0x2222222222222222222222222222222222222222";
  let starts = 0;
  const server = createProductionOperatorServer({
    OPERATOR_ADDRESS: operator.address,
    VILLA_ENGINE_OPERATOR: operator.address,
    VILLA_ALLOWED_ORIGINS: "http://allowed.test",
    VILLA_EXECUTION_ENABLED: "false",
    VILLA_ACCOUNT_EXECUTION_ENABLED: "true",
    VILLA_UAT_EXECUTION_ENABLED: "false",
  }, {
    readOnlyReader: async () => ({ mode: "LIVE", snapshot: null }),
    accountVerifier: async ({ caller, account }) => ({ account, owner: caller, operator: operator.address, accountVersion: 2, version: 2, runtimeVerified: true, onChain: true }),
    controlFactory: () => ({
      async getState() { return { state: "STOPPED", session: null }; },
      async start() { starts += 1; return { state: "STARTING" }; },
      async stop() { return { state: "STOPPED" }; },
      async settle() { return { state: "SETTLED" }; },
      async pause() { return { state: "PAUSED" }; },
      async resume() { return { state: "RUNNING" }; },
    }),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    const nonce = await request(base, "/account/auth/nonce", { method: "POST", body: { address: owner.address } });
    const signature = await owner.signMessage({ message: nonce.body.message });
    const verified = await request(base, "/account/auth/verify", { method: "POST", body: { ...nonce.body, signature } });
    const started = await request(base, "/account/session/start", { method: "POST", token: verified.body.token, body: { account: villaAccount } });
    assert.equal(started.status, 202);
    assert.equal(starts, 1);
  } finally {
    server.close();
  }
});

test("API restart recovers the bound account for its owner and rejects another wallet", async () => {
  const operator = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  const wrongOwner = privateKeyToAccount(generatePrivateKey());
  const villaAccount = "0x3333333333333333333333333333333333333333";
  const sessionId = "uat-1234567890-fedcba98";
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "villa-api-recovery-"));
  const statusPath = path.join(directory, sessionId + ".json");
  await fs.writeFile(statusPath, JSON.stringify({
    version: "villa-uat-state-v1",
    updatedAt: Date.now(),
    state: "RUNNING",
    session: { sessionId, account: villaAccount, owner: owner.address, operator: operator.address },
  }));
  const accountVerifier = async ({ caller, account }) => {
    if (caller.toLowerCase() !== owner.address.toLowerCase() || account.toLowerCase() !== villaAccount) {
      throw new AccountControlError("OWNER_SCOPE_MISMATCH", "account does not belong to this wallet", 403);
    }
    return { account, owner: owner.address, operator: operator.address, accountVersion: 2, version: 2, runtimeVerified: true, onChain: true };
  };
  let stopArgs = null;
  const commandRunner = (_command, args, _options, callback) => {
    stopArgs = args;
    void fs.writeFile(statusPath, JSON.stringify({
      version: "villa-uat-state-v1",
      updatedAt: Date.now() + 1,
      state: "STOPPED_SETTLEMENT_PENDING",
      session: { sessionId, account: villaAccount, owner: owner.address, operator: operator.address },
    })).then(() => callback(null));
  };
  const createServer = () => createProductionOperatorServer({
    OPERATOR_ADDRESS: operator.address,
    VILLA_ENGINE_OPERATOR: operator.address,
    VILLA_ALLOWED_ORIGINS: "http://allowed.test",
    VILLA_EXECUTION_ENABLED: "false",
    VILLA_ACCOUNT_EXECUTION_ENABLED: "true",
    VILLA_UAT_EXECUTION_ENABLED: "false",
    VILLA_UAT_LAUNCH_MODE: "systemd",
    VILLA_UAT_STATE_DIRECTORY: directory,
  }, {
    readOnlyReader: async () => ({ mode: "LIVE", snapshot: null }),
    accountVerifier,
    controlOptions: { commandRunner, pollMs: 1, readyTimeoutMs: 500 },
  });
  const serve = async (server) => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return "http://127.0.0.1:" + server.address().port;
  };
  const tokenFor = async (base, wallet) => {
    const nonce = await request(base, "/account/auth/nonce", { method: "POST", body: { address: wallet.address } });
    const signature = await wallet.signMessage({ message: nonce.body.message });
    const verified = await request(base, "/account/auth/verify", { method: "POST", body: { ...nonce.body, signature } });
    return verified.body.token;
  };
  const first = createServer();
  const firstBase = await serve(first);
  try {
    const firstToken = await tokenFor(firstBase, owner);
    const firstState = await request(firstBase, "/account/state?account=" + villaAccount, { token: firstToken });
    assert.equal(firstState.status, 200);
    assert.equal(firstState.body.state, "RUNNING");
  } finally {
    await new Promise((resolve) => first.close(resolve));
  }
  const second = createServer();
  const secondBase = await serve(second);
  try {
    const ownerToken = await tokenFor(secondBase, owner);
    const recovered = await request(secondBase, "/account/state?account=" + villaAccount, { token: ownerToken });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.session.sessionId, sessionId);
    const wrongToken = await tokenFor(secondBase, wrongOwner);
    const wrong = await request(secondBase, "/account/state?account=" + villaAccount, { token: wrongToken });
    assert.equal(wrong.status, 403);
    const stopped = await request(secondBase, "/account/session/stop", { method: "POST", token: ownerToken, body: { account: villaAccount } });
    assert.equal(stopped.status, 202);
    assert.equal(stopped.body.state, "STOPPED_SETTLEMENT_PENDING");
    assert.deepEqual(stopArgs, ["stop", sessionId]);
  } finally {
    await new Promise((resolve) => second.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test("optional account control routes are wallet-authenticated and reject arbitrary relay fields", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const villaAccount = "0x4444444444444444444444444444444444444444";
  const calls = [];
  const server = createOperatorApiServer({
    control: { async getState() { return { state: "STOPPED", executionEnabled: false }; } },
    auth: createOperatorAuth({ authorizedAddress: account.address }),
    accountControl: {
      async getState(input) { calls.push(["state", input]); return { state: "STOPPED", safety: { signerInBrowser: false } }; },
      async start(input) { calls.push(["start", input]); return { state: "RUNNING" }; },
      async stop(input) { calls.push(["stop", input]); return { state: "STOPPED" }; },
      async settle(input) { calls.push(["settle", input]); return { state: "SETTLED" }; },
      async recover(input) { calls.push(["recover", input]); return { state: "STOPPED_CLEAN" }; },
    },
    allowedOrigins: ["http://allowed.test"],
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const nonce = await request(base, "/auth/nonce", { method: "POST", body: { address: account.address } });
    const signature = await account.signMessage({ message: nonce.body.message });
    const verified = await request(base, "/auth/verify", { method: "POST", body: { ...nonce.body, signature } });
    const token = verified.body.token;
    const state = await request(base, "/account/state?account=" + villaAccount, { token });
    assert.equal(state.status, 200);
    assert.equal(calls[0][1].caller.toLowerCase(), account.address.toLowerCase());
    const started = await request(base, "/account/session/start", { method: "POST", token, body: { account: villaAccount } });
    assert.equal(started.status, 202);
    assert.equal(calls[1][0], "start");
    const arbitrary = await request(base, "/account/session/start", { method: "POST", token, body: { account: villaAccount, destination: account.address } });
    assert.equal(arbitrary.status, 400);
    assert.equal(arbitrary.body.code, "ARBITRARY_CALL_DENIED");
    const settled = await request(base, "/account/session/settle", { method: "POST", token, body: { account: villaAccount } });
    assert.equal(settled.status, 202);
    assert.equal(calls[2][0], "settle");
    const arbitrarySettle = await request(base, "/account/session/settle", { method: "POST", token, body: { account: villaAccount, destination: account.address } });
    assert.equal(arbitrarySettle.status, 400);
    assert.equal(arbitrarySettle.body.code, "ARBITRARY_CALL_DENIED");
    const recovered = await request(base, "/account/session/recover", { method: "POST", token, body: { account: villaAccount } });
    assert.equal(recovered.status, 202);
    assert.equal(calls[3][0], "recover");
    const arbitraryRecover = await request(base, "/account/session/recover", { method: "POST", token, body: { account: villaAccount, calldata: "0x1234" } });
    assert.equal(arbitraryRecover.status, 400);
    assert.equal(arbitraryRecover.body.code, "ARBITRARY_CALL_DENIED");
    assert.equal(calls.length, 4);
  } finally {
    server.close();
  }
});

test("account control can use a separate owner-auth session", async () => {
  const operator = privateKeyToAccount(generatePrivateKey());
  const owner = privateKeyToAccount(generatePrivateKey());
  const villaAccount = "0x5555555555555555555555555555555555555555";
  const calls = [];
  const server = createOperatorApiServer({
    control: { async getState() { return { state: "STOPPED", executionEnabled: false }; } },
    auth: createOperatorAuth({ authorizedAddress: operator.address }),
    accountAuth: createOperatorAuth({ authorizedAddress: owner.address }),
    accountControl: {
      async getState(input) { calls.push(input); return { state: "STOPPED" }; },
      async start() { return { state: "RUNNING" }; },
      async stop() { return { state: "STOPPED" }; },
    },
    allowedOrigins: ["http://allowed.test"],
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const accountRejected = await request(base, "/account/state");
    assert.equal(accountRejected.status, 401);
    assert.match(accountRejected.body.error, /owner wallet/i);
    assert.doesNotMatch(accountRejected.body.error, /operator wallet/i);
    const nonce = await request(base, "/account/auth/nonce", { method: "POST", body: { address: owner.address } });
    assert.equal(nonce.status, 200);
    const signature = await owner.signMessage({ message: nonce.body.message });
    const verified = await request(base, "/account/auth/verify", { method: "POST", body: { ...nonce.body, signature } });
    assert.equal(verified.status, 200);
    const state = await request(base, "/account/state?account=" + villaAccount, { token: verified.body.token });
    assert.equal(state.status, 200);
    assert.equal(calls[0].caller.toLowerCase(), owner.address.toLowerCase());
  } finally {
    server.close();
  }
});
