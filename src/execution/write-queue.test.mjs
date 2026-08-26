import test from "node:test";
import assert from "node:assert/strict";
import { createSerializedWriteQueue } from "./write-queue.mjs";

test("all queued writes execute serially even when callers enqueue concurrently", async () => {
  let active = 0;
  let maximum = 0;
  const order = [];
  const queue = createSerializedWriteQueue(async (label, operation) => {
    active += 1;
    maximum = Math.max(maximum, active);
    order.push(`start:${label}`);
    const result = await operation();
    order.push(`end:${label}`);
    active -= 1;
    return result;
  });
  const results = await Promise.all([
    queue.enqueue("mint", async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return "minted"; }),
    queue.enqueue("ask", async () => "ask-placed"),
    queue.enqueue("cancel", async () => "cancelled"),
  ]);
  assert.deepEqual(results, ["minted", "ask-placed", "cancelled"]);
  assert.equal(maximum, 1);
  assert.deepEqual(order, ["start:mint", "end:mint", "start:ask", "end:ask", "start:cancel", "end:cancel"]);
  queue.close();
  await assert.rejects(queue.enqueue("late", async () => undefined), /closed/);
});
