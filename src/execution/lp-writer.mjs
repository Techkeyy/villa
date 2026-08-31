/**
 * The only future wet writer boundary.
 *
 * Calls are serialized, nonce allocation is explicit, uncertain outcomes halt
 * the queue, and no retry is attempted without reconciliation. Tests inject a
 * sender; this module never discovers or loads signer material itself.
 */

export const LP_TX_STATES = Object.freeze(["PENDING", "CONFIRMED", "REVERTED", "UNKNOWN"]);
export const LP_WRITER_VERSION = "villa-serialized-writer-v1";

export class LpWriterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LpWriterError";
    this.code = code;
  }
}

function copy(value) {
  return value ? structuredClone(value) : value;
}

function nonce(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new LpWriterError("NONCE_INVALID", "pending nonce must be a non-negative safe integer");
  return result;
}

function receiptState(receipt) {
  if (!receipt) return "UNKNOWN";
  if (receipt.status === 1 || receipt.status === "0x1" || receipt.status === "success" || receipt.status === true) return "CONFIRMED";
  if (receipt.status === 0 || receipt.status === "0x0" || receipt.status === "reverted" || receipt.status === false) return "REVERTED";
  return "UNKNOWN";
}

function uncertainError(error) {
  return Boolean(error?.uncertain || ["TIMEOUT", "NETWORK_ERROR", "RPC_ERROR", "RECEIPT_TIMEOUT", "UNKNOWN"].includes(error?.code));
}

export function createSerializedWetWriter({
  policy,
  readPendingNonce,
  send,
  waitForReceipt,
  readReceipt = null,
  now = () => Date.now(),
} = {}) {
  if (!policy || typeof policy.validate !== "function") throw new LpWriterError("POLICY_REQUIRED", "a central transaction policy is required");
  if (typeof readPendingNonce !== "function") throw new LpWriterError("NONCE_READER_REQUIRED", "pending nonce reader is required");
  if (typeof send !== "function") throw new LpWriterError("SENDER_REQUIRED", "the single injected sender is required");
  if (typeof waitForReceipt !== "function") throw new LpWriterError("RECEIPT_READER_REQUIRED", "receipt waiter is required");

  let tail = Promise.resolve();
  let closed = false;
  let halted = false;
  let nextNonce = null;
  let sequence = 0;
  const records = new Map();

  function snapshot() {
    return {
      version: LP_WRITER_VERSION,
      halted,
      closed,
      nextNonce,
      pending: [...records.values()].filter((record) => record.state === "PENDING").length,
      unknown: [...records.values()].filter((record) => record.state === "UNKNOWN").length,
      records: copy([...records.values()]),
    };
  }

  function update(hash, fields) {
    const current = records.get(hash);
    if (!current) throw new LpWriterError("TX_UNKNOWN", `transaction ${hash} is not tracked`);
    const next = { ...current, ...fields, updatedAt: now() };
    records.set(hash, next);
    return copy(next);
  }

  async function allocateNonce() {
    const chainNonce = nonce(await readPendingNonce());
    if (nextNonce === null) nextNonce = chainNonce;
    if (chainNonce > nextNonce) {
      halted = true;
      throw new LpWriterError("NONCE_CONFLICT", `chain pending nonce ${chainNonce} is ahead of the writer nonce ${nextNonce}`);
    }
    const allocated = nextNonce;
    nextNonce += 1;
    return allocated;
  }

  async function execute(plan) {
    if (halted) throw new LpWriterError("WRITER_HALTED", "writer is halted until unknown state is reconciled");
    const validation = policy.validate(plan);
    if (!validation?.allowed) throw new LpWriterError(validation?.code ?? "POLICY_DENIED", validation?.reason ?? "transaction policy denied the plan");
    const caps = policy.caps ?? {};
    if (sequence >= Number(caps.MAX_TX_COUNT ?? Number.MAX_SAFE_INTEGER)) throw new LpWriterError("TX_COUNT_CAP", "transaction count exceeds the bounded cycle cap");
    const txNonce = await allocateNonce();
    const sequenceNumber = sequence;
    sequence += 1;
    const provisionalHash = `intent-${plan.intent.sessionId}-${plan.intent.txIndex}-${sequenceNumber}`;
    records.set(provisionalHash, { hash: provisionalHash, sessionId: plan.intent.sessionId, account: plan.account, marketId: plan.intent.marketId, action: plan.intent.action, nonce: txNonce, state: "PENDING", createdAt: now(), updatedAt: now() });
    let txHash;
    try {
      txHash = await send({ plan, nonce: txNonce });
      if (!txHash || typeof txHash !== "string") throw Object.assign(new Error("sender returned no transaction hash"), { uncertain: true, code: "UNKNOWN" });
      const current = records.get(provisionalHash);
      records.delete(provisionalHash);
      records.set(txHash, { ...current, hash: txHash, sentAt: now(), updatedAt: now() });
    } catch (error) {
      if (uncertainError(error)) {
        halted = true;
        update(provisionalHash, { state: "UNKNOWN", reason: "broadcast outcome is uncertain", errorCode: error?.code ?? "UNKNOWN" });
      } else update(provisionalHash, { state: "REVERTED", reason: error?.message ?? "transaction was rejected before broadcast" });
      throw error;
    }
    let receipt;
    try {
      receipt = await waitForReceipt(txHash);
    } catch (error) {
      halted = true;
      update(txHash, { state: "UNKNOWN", reason: "receipt outcome is unknown", errorCode: error?.code ?? "RECEIPT_TIMEOUT" });
      throw new LpWriterError("UNKNOWN", `transaction ${txHash} requires reconciliation before another write`);
    }
    const state = receiptState(receipt);
    if (state === "UNKNOWN") {
      halted = true;
      update(txHash, { state: "UNKNOWN", reason: "receipt status was not definitive" });
      throw new LpWriterError("UNKNOWN", `transaction ${txHash} requires reconciliation before another write`);
    }
    return update(txHash, { state, receiptStatus: receipt.status });
  }

  function enqueue(plan) {
    if (closed) return Promise.reject(new LpWriterError("WRITER_CLOSED", "writer is closed"));
    if (halted) return Promise.reject(new LpWriterError("WRITER_HALTED", "writer is halted until unknown state is reconciled"));
    const run = tail.then(() => execute(plan));
    tail = run.catch(() => undefined);
    return run;
  }

  async function reconcileUnknown({ txHash, receipt = undefined } = {}) {
    const current = records.get(txHash);
    if (!current) throw new LpWriterError("TX_UNKNOWN", `transaction ${txHash} is not tracked`);
    if (current.state !== "UNKNOWN") return copy(current);
    const observed = receipt === undefined && typeof readReceipt === "function" ? await readReceipt(txHash) : receipt;
    const state = receiptState(observed);
    if (state === "UNKNOWN") return copy(current);
    const result = update(txHash, { state, receiptStatus: observed.status, reconciledAt: now() });
    halted = [...records.values()].some((record) => record.state === "UNKNOWN");
    return result;
  }

  function markUnknown({ txHash, reason = "process stopped before definitive receipt" } = {}) {
    const current = records.get(txHash);
    if (!current) throw new LpWriterError("TX_UNKNOWN", `transaction ${txHash} is not tracked`);
    halted = true;
    return update(txHash, { state: "UNKNOWN", reason });
  }

  return Object.freeze({
    enqueue,
    reconcileUnknown,
    markUnknown,
    close: () => { closed = true; },
    getState: snapshot,
    getRecord: (hash) => copy(records.get(hash)),
  });
}

export { receiptState };
