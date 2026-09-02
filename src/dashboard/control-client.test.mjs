import assert from "node:assert/strict";
import test from "node:test";
import { ControlClientError, createAccountControlClient } from "../../dashboard/control-client.mjs";

const OWNER = "0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d";

function response(body, ok = true, status = 200) {
  return { ok, status, async json() { return body; } };
}

test("control client authenticates and sends an empty-body account-bound start", async () => {
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
  const client = createAccountControlClient({ fetchImpl, provider, ownerProvider: () => OWNER });

  await assert.rejects(client.start(), (error) => error instanceof ControlClientError && error.code === "EXECUTION_DISABLED");
  const request = calls.at(-1);
  assert.equal(request.url, "http://127.0.0.1:8782/account/session/start");
  assert.deepEqual(JSON.parse(request.options.body), {});
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
  const client = createAccountControlClient({ fetchImpl, provider, ownerProvider: () => OWNER });

  await assert.rejects(client.start(), (error) => error instanceof ControlClientError && error.code === "WALLET_REJECTED");
  assert.equal(calls.filter(({ url }) => url.endsWith("/account/auth/verify")).length, 0);
});

test("control client exposes only fixed safe controls", () => {
  globalThis.window = { location: { hostname: "localhost" } };
  const client = createAccountControlClient({ fetchImpl: async () => response({ engineApiUrl: "http://127.0.0.1:8782" }) });
  assert.deepEqual(Object.keys(client).sort(), ["authenticate", "clear", "loadConfig", "start", "state", "stop"]);
  assert.equal("sendTransaction" in client, false);
  assert.equal("withdraw" in client, false);
});
