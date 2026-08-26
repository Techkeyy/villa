/** Serialize every signer write through one promise chain. */
export function createSerializedWriteQueue(send) {
  if (typeof send !== "function") throw new TypeError("send must be a function");
  let tail = Promise.resolve();
  let closed = false;
  let pending = 0;
  return {
    enqueue(label, operation) {
      if (closed) return Promise.reject(new Error(`write queue is closed (${label})`));
      if (typeof operation !== "function") return Promise.reject(new TypeError("write operation must be a function"));
      pending += 1;
      const run = tail.then(async () => send(label, operation));
      tail = run.catch(() => undefined).finally(() => { pending -= 1; });
      return run;
    },
    close() { closed = true; },
    get pending() { return pending; },
  };
}
