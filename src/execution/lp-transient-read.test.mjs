import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RPC_WAIT_MAX_MS, isTransientRpcTransportError, readUntilAvailable, transientReadWait } from "./lp-transient-read.mjs";

test("a transient RPC failure retries and returns the fresh read", async () => {
  let reads = 0;
  const waits = [];
  const result = await readUntilAvailable({
    read: async () => { reads += 1; if (reads === 1) throw Object.assign(new Error("fetch failed"), { name: "HttpRequestError" }); return { identity: "fresh" }; },
    stopped: () => false,
    onWait: async (state, reason, meta) => waits.push({ state, reason, attempt: meta.attempt }),
    delay: async () => undefined,
    transportState: "WAITING_FOR_RPC",
  });
  assert.deepEqual(result.value, { identity: "fresh" });
  assert.equal(reads, 2);
  assert.deepEqual(waits, [{ state: "WAITING_FOR_RPC", reason: "HttpRequestError", attempt: 1 }]);
});

test("repeated RPC transport failure enters bounded safety timeout", async () => {
  let clock = 0;
  let reads = 0;
  await assert.rejects(() => readUntilAvailable({
    read: async () => { reads += 1; throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" }); },
    stopped: () => false,
    onWait: async () => undefined,
    delay: async () => { clock += 50; },
    transportState: "WAITING_FOR_RPC",
    maxWaitMs: 100,
    now: () => clock,
  }), (error) => error.code === "RPC_SAFETY_TIMEOUT" && error.attempts === 3);
  assert.equal(reads, 3);
});

test("the running-session RPC budget is finite and bounded", () => {
  assert.equal(DEFAULT_RPC_WAIT_MAX_MS, 120_000);
});

test("RPC waiting does not perform any write action", async () => {
  let writes = 0;
  let reads = 0;
  const result = await readUntilAvailable({
    read: async () => { reads += 1; if (reads === 1) throw Object.assign(new Error("fetch failed"), { code: "RPC_TRANSPORT" }); return "authoritative"; },
    stopped: () => false,
    onWait: async () => { writes += 0; },
    delay: async () => undefined,
    transportState: "WAITING_FOR_RPC",
  });
  assert.equal(result.value, "authoritative");
  assert.equal(writes, 0);
});

test("transport failures are classified separately from contract reverts and scope failures", () => {
  assert.equal(isTransientRpcTransportError(Object.assign(new Error("fetch failed"), { name: "HttpRequestError" })), true);
  assert.equal(isTransientRpcTransportError(Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" })), false);
  assert.equal(isTransientRpcTransportError(Object.assign(new Error("owner mismatch"), { code: "ACCOUNT_IDENTITY_MISMATCH" })), false);
  assert.equal(transientReadWait(Object.assign(new Error("execution reverted"), { name: "ContractFunctionRevertedError" }), { transportState: "WAITING_FOR_RPC" }), null);
});

test("price freshness remains a price wait, not an RPC wait", () => {
  assert.equal(transientReadWait(Object.assign(new Error("stale"), { code: "STALE_SOURCE" }), { transportState: "WAITING_FOR_RPC" }), "WAITING_FOR_FRESH_PRICE");
});

test("a requested stop ends the wait without another read", async () => {
  let stopped = false;
  let reads = 0;
  const result = await readUntilAvailable({
    read: async () => { reads += 1; throw Object.assign(new Error("fetch failed"), { code: "RPC_TRANSPORT" }); },
    stopped: () => stopped,
    onWait: async () => { stopped = true; },
    delay: async () => { throw new Error("delay should not run"); },
    transportState: "WAITING_FOR_RPC",
  });
  assert.equal(result.stopped, true);
  assert.equal(reads, 1);
});
