import assert from "node:assert/strict";
import test from "node:test";
import { createSerializedWetWriter } from "./lp-writer.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function plan(index = 0) {
  return {
    broadcast: false,
    intent: { sessionId: "session-writer", account: ACCOUNT, marketId: MARKET, action: "PLACE_ORDER", txIndex: index },
    account: ACCOUNT,
    marketId: MARKET,
  };
}

function policy() {
  return { caps: { MAX_TX_COUNT: 12 }, validate: () => ({ allowed: true }) };
}

test("one serialized writer assigns deterministic nonces and never broadcasts concurrently", async () => {
  let active = 0;
  let maximum = 0;
  const nonces = [];
  const writer = createSerializedWetWriter({
    policy: policy(),
    readPendingNonce: async () => 7,
    send: async ({ nonce }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      nonces.push(nonce);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return `0x${String(nonce).padStart(64, "0")}`;
    },
    waitForReceipt: async () => ({ status: "0x1" }),
  });
  const results = await Promise.all([writer.enqueue(plan(0)), writer.enqueue(plan(1))]);
  assert.deepEqual(nonces, [7, 8]);
  assert.equal(maximum, 1);
  assert.deepEqual(results.map((result) => result.state), ["CONFIRMED", "CONFIRMED"]);
  assert.equal(writer.getState().unknown, 0);
  writer.close();
  await assert.rejects(() => writer.enqueue(plan(2)), { code: "WRITER_CLOSED" });
});

test("receipt timeout becomes UNKNOWN, halts writes, and resumes only after authoritative reconciliation", async () => {
  let waitCount = 0;
  let sends = 0;
  const writer = createSerializedWetWriter({
    policy: policy(),
    readPendingNonce: async () => 3,
    send: async () => { sends += 1; return "0xuncertain"; },
    waitForReceipt: async () => { waitCount += 1; if (waitCount === 1) throw Object.assign(new Error("timeout"), { code: "RECEIPT_TIMEOUT" }); return { status: 1 }; },
  });
  await assert.rejects(() => writer.enqueue(plan(0)), { code: "UNKNOWN" });
  assert.equal(waitCount, 1);
  assert.equal(sends, 1);
  assert.equal(writer.getState().halted, true);
  await assert.rejects(() => writer.enqueue(plan(1)), { code: "WRITER_HALTED" });
  const record = writer.getRecord("0xuncertain");
  assert.equal(record.state, "UNKNOWN");
  await writer.reconcileUnknown({ txHash: "0xuncertain", receipt: { status: 1 } });
  assert.equal(writer.getState().halted, false);
  assert.equal((await writer.enqueue(plan(1))).state, "CONFIRMED");
});

test("a definitive pre-broadcast rejection is REVERTED, while an uncertain send is UNKNOWN", async () => {
  let count = 0;
  const writer = createSerializedWetWriter({
    policy: policy(),
    readPendingNonce: async () => 1,
    send: async () => {
      count += 1;
      if (count === 1) throw Object.assign(new Error("local validation"), { code: "USER_REJECTED" });
      throw Object.assign(new Error("network lost after submission"), { code: "NETWORK_ERROR", uncertain: true });
    },
    waitForReceipt: async () => ({ status: 1 }),
  });
  await assert.rejects(() => writer.enqueue(plan(0)), /local validation/);
  assert.equal(writer.getState().records[0].state, "REVERTED");
  await assert.rejects(() => writer.enqueue(plan(1)), { code: "NETWORK_ERROR" });
  assert.equal(writer.getState().halted, true);
  assert.equal(writer.getState().records[1].state, "UNKNOWN");
  assert.equal(typeof writer.retry, "undefined");
});

test("nonce conflict halts the single writer before a second broadcast", async () => {
  let reads = 0;
  let sends = 0;
  const writer = createSerializedWetWriter({
    policy: policy(),
    readPendingNonce: async () => { reads += 1; return reads === 1 ? 4 : 6; },
    send: async () => { sends += 1; return "0xknown"; },
    waitForReceipt: async () => ({ status: 1 }),
  });
  await writer.enqueue(plan(0));
  await assert.rejects(() => writer.enqueue(plan(1)), { code: "NONCE_CONFLICT" });
  assert.equal(sends, 1);
  assert.equal(writer.getState().halted, true);
});
