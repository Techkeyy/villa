/**
 * Private account-bound wet writer.
 *
 * This is the only module that may receive a verified signer. Its public
 * surface accepts a policy-prepared VILLA plan, never { to, data, value }.
 * The target, ABI, function, and arguments are revalidated before simulation
 * and again immediately before the private wallet client is invoked.
 */

import * as fs from "node:fs";
import path from "node:path";
import { VILLA_ACCOUNT_OPERATOR_ABI } from "./lp-adapter.mjs";
import { LP_ALLOWED_ACCOUNT_OPERATIONS } from "./lp-transaction-policy.mjs";

export const LP_PRIVATE_WRITER_VERSION = "villa-private-account-writer-v1";
export const LP_PRIVATE_WRITER_STATES = Object.freeze(["PENDING", "CONFIRMED", "REVERTED", "UNKNOWN"]);

const ALLOWED_FUNCTIONS = new Set(LP_ALLOWED_ACCOUNT_OPERATIONS);

export class LpPrivateWriterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LpPrivateWriterError";
    this.code = code;
  }
}

function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

function numberNonce(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new LpPrivateWriterError("NONCE_INVALID", "transaction nonce must be a non-negative safe integer");
  return parsed;
}

function receiptState(receipt) {
  if (!receipt) return "UNKNOWN";
  if (receipt.status === 1 || receipt.status === "0x1" || receipt.status === "success" || receipt.status === true) return "CONFIRMED";
  if (receipt.status === 0 || receipt.status === "0x0" || receipt.status === "reverted" || receipt.status === false) return "REVERTED";
  return "UNKNOWN";
}

function blockNumber(receipt) {
  return receipt?.blockNumber === undefined || receipt?.blockNumber === null ? null : String(receipt.blockNumber);
}

function uncertain(error) {
  return Boolean(error?.uncertain || ["TIMEOUT", "NETWORK_ERROR", "RPC_ERROR", "RECEIPT_TIMEOUT", "UNKNOWN"].includes(error?.code));
}

function journalString(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? `${item}n` : item, 2);
}

function validPlan(plan) {
  return Boolean(plan && typeof plan === "object" && plan.intent && typeof plan.intent === "object" && ALLOWED_FUNCTIONS.has(plan.functionName));
}

/**
 * Create one account-bound writer. `walletClient` and `signer` are private
 * closure values and are never returned. The factory itself refuses to build
 * while execution is disabled, which makes the disabled path unable to reach
 * any wallet invocation.
 */
export function createAccountBoundPrivateWriter({
  session,
  lease,
  policy,
  signer,
  publicClient,
  walletClient,
  executionEnabled,
  readLatestNonce,
  readPendingNonce,
  readReceipt = null,
  journalPath = null,
  now = () => Date.now(),
} = {}) {
  if (executionEnabled !== true) throw new LpPrivateWriterError("EXECUTION_DISABLED", "the private writer cannot be created while execution is disabled");
  if (!session || typeof session.account !== "string" || typeof session.operator !== "string") throw new LpPrivateWriterError("SESSION_REQUIRED", "an immutable account-bound session is required");
  const leaseIsHeld = () => Boolean(lease?.held) &&
    String(lease.account ?? "").toLowerCase() === session.account.toLowerCase() &&
    String(lease.sessionId ?? "") === String(session.sessionId ?? "") &&
    (!session.leaseId || String(lease.leaseId ?? "") === String(session.leaseId)) &&
    (lease.state === undefined || lease.state === "HELD") &&
    (lease.expiresAt === undefined || Number(lease.expiresAt) > Number(now()));
  if (!leaseIsHeld()) throw new LpPrivateWriterError("ACCOUNT_LEASE_REQUIRED", "a held account lease bound to the session is required");
  if (!signer || String(signer.address ?? "").toLowerCase() !== session.operator.toLowerCase()) throw new LpPrivateWriterError("SIGNER_MISMATCH", "private signer does not match the session operator");
  if (!policy || typeof policy.validate !== "function") throw new LpPrivateWriterError("POLICY_REQUIRED", "the central transaction policy is required");
  if (!publicClient || typeof publicClient.simulateContract !== "function") throw new LpPrivateWriterError("SIMULATOR_REQUIRED", "a public simulation client is required");
  if (!walletClient || typeof walletClient.writeContract !== "function") throw new LpPrivateWriterError("WALLET_REQUIRED", "the private wallet client is required");
  if (typeof readLatestNonce !== "function" || typeof readPendingNonce !== "function") throw new LpPrivateWriterError("NONCE_READER_REQUIRED", "latest and pending nonce readers are required");

  let closed = false;
  let halted = false;
  let tail = Promise.resolve();
  let nextNonce = null;
  let sequence = 0;
  const records = new Map();

  function persist() {
    if (!journalPath) return;
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    const temporary = `${journalPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, journalString({ version: LP_PRIVATE_WRITER_VERSION, nextNonce, sequence, halted, records: [...records.values()] }), { mode: 0o600 });
    fs.renameSync(temporary, journalPath);
  }

  function restore() {
    if (!journalPath || !fs.existsSync(journalPath)) return;
    let payload;
    try { payload = JSON.parse(fs.readFileSync(journalPath, "utf8")); } catch { throw new LpPrivateWriterError("JOURNAL_CORRUPT", "private writer journal is unreadable; recovery is blocked"); }
    if (payload?.version !== LP_PRIVATE_WRITER_VERSION || !Array.isArray(payload.records)) throw new LpPrivateWriterError("JOURNAL_CORRUPT", "private writer journal version is unsupported; recovery is blocked");
    nextNonce = payload.nextNonce === null || payload.nextNonce === undefined ? null : numberNonce(payload.nextNonce);
    sequence = Number.isSafeInteger(Number(payload.sequence)) && Number(payload.sequence) >= 0 ? Number(payload.sequence) : 0;
    halted = Boolean(payload.halted);
    for (const record of payload.records) {
      if (!record || typeof record.hash !== "string") throw new LpPrivateWriterError("JOURNAL_CORRUPT", "private writer journal contains an invalid record");
      const recovered = record.state === "PENDING"
        ? { ...record, state: "UNKNOWN", reason: "process restarted before an authoritative receipt", errorCode: "RESTART_RECONCILIATION_REQUIRED", updatedAt: now() }
        : record;
      records.set(record.hash, recovered);
      if (recovered.state === "UNKNOWN") halted = true;
    }
    persist();
  }

  restore();

  function state() {
    return {
      version: LP_PRIVATE_WRITER_VERSION,
      halted,
      closed,
      nextNonce,
      pending: [...records.values()].filter((record) => record.state === "PENDING").length,
      unknown: [...records.values()].filter((record) => record.state === "UNKNOWN").length,
      records: clone([...records.values()]),
    };
  }

  function update(hash, fields) {
    const current = records.get(hash);
    if (!current) throw new LpPrivateWriterError("TX_UNKNOWN", `transaction ${hash} is not tracked`);
    const updated = { ...current, ...fields, updatedAt: now() };
    records.set(hash, updated);
    persist();
    return clone(updated);
  }

  async function allocateNonce() {
    const latest = numberNonce(await readLatestNonce());
    const pending = numberNonce(await readPendingNonce());
    if (latest !== pending) {
      halted = true;
      persist();
      throw new LpPrivateWriterError("NONCE_CONFLICT", `latest nonce ${latest} differs from pending nonce ${pending}`);
    }
    if (nextNonce === null) nextNonce = pending;
    if (pending !== nextNonce) {
      halted = true;
      persist();
      throw new LpPrivateWriterError("NONCE_CONFLICT", `chain pending nonce ${pending} differs from writer nonce ${nextNonce}`);
    }
    const allocated = nextNonce;
    nextNonce += 1;
    persist();
    return allocated;
  }

  async function execute(plan) {
    if (halted) throw new LpPrivateWriterError("WRITER_HALTED", "private writer is halted until unknown state is reconciled");
    if (!leaseIsHeld()) throw new LpPrivateWriterError("ACCOUNT_LEASE_REQUIRED", "the account lease is no longer held for this session");
    if (!validPlan(plan)) throw new LpPrivateWriterError("INTENT_REQUIRED", "writer accepts only a policy-prepared VILLA intent");
    const validation = policy.validate(plan, { nowMs: now() });
    if (!validation?.allowed) throw new LpPrivateWriterError(validation?.code ?? "POLICY_DENIED", validation?.reason ?? "transaction policy denied the intent");
    const txNonce = await allocateNonce();
    const txIndex = Number(plan.intent.txIndex);
    const intentId = plan.intent.intentId ?? `${plan.intent.sessionId}:${txIndex}`;
    const provisionalHash = `intent-${plan.intent.sessionId}-${txIndex}-${sequence}`;
    sequence += 1;
    records.set(provisionalHash, { hash: provisionalHash, intentId, sessionId: plan.intent.sessionId, action: plan.intent.action, account: session.account, marketId: plan.intent.marketId, amountRaw: plan.intent.amountRaw === null || plan.intent.amountRaw === undefined ? null : String(plan.intent.amountRaw), priceRaw: plan.intent.priceRaw === null || plan.intent.priceRaw === undefined ? null : String(plan.intent.priceRaw), side: plan.intent.side ?? null, nonce: txNonce, state: "PENDING", createdAt: now(), updatedAt: now(), receiptBlock: null, revertReason: null });
    persist();

    let txHash;
    try {
      // The only wallet call is constructed from the already validated
      // allowlisted function and typed arguments. No caller-supplied target,
      // selector, calldata, or native value reaches this closure.
      const simulation = await publicClient.simulateContract({ account: signer, address: session.account, abi: VILLA_ACCOUNT_OPERATOR_ABI, functionName: plan.functionName, args: plan.args, value: 0n });
      txHash = await walletClient.writeContract({ ...(simulation.request ?? { address: session.account, abi: VILLA_ACCOUNT_OPERATOR_ABI, functionName: plan.functionName, args: plan.args, value: 0n }), account: signer, chain: walletClient.chain, nonce: txNonce });
      if (!txHash || typeof txHash !== "string") throw Object.assign(new Error("private wallet returned no transaction hash"), { uncertain: true, code: "UNKNOWN" });
      const current = records.get(provisionalHash);
      records.delete(provisionalHash);
      records.set(txHash, { ...current, hash: txHash, sentAt: now(), updatedAt: now() });
      persist();
    } catch (error) {
      if (uncertain(error)) {
        halted = true;
        update(provisionalHash, { state: "UNKNOWN", reason: "broadcast outcome is uncertain", errorCode: error?.code ?? "UNKNOWN" });
      } else update(provisionalHash, { state: "REVERTED", reason: error?.message ?? "transaction was rejected before broadcast", revertReason: error?.message ?? null });
      throw error;
    }

    let receipt;
    try {
      receipt = await walletClient.waitForTransactionReceipt({ hash: txHash });
    } catch (error) {
      halted = true;
      update(txHash, { state: "UNKNOWN", reason: "receipt outcome is unknown", errorCode: error?.code ?? "RECEIPT_TIMEOUT" });
      throw new LpPrivateWriterError("UNKNOWN", `transaction ${txHash} requires reconciliation before another write`);
    }
    const result = receiptState(receipt);
    if (result === "UNKNOWN") {
      halted = true;
      update(txHash, { state: "UNKNOWN", reason: "receipt status was not definitive" });
      throw new LpPrivateWriterError("UNKNOWN", `transaction ${txHash} requires reconciliation before another write`);
    }
    return update(txHash, { state: result, receiptStatus: receipt.status, receiptBlock: blockNumber(receipt), revertReason: result === "REVERTED" ? (receipt.revertReason ?? null) : null });
  }

  function enqueue(plan) {
    if (closed) return Promise.reject(new LpPrivateWriterError("WRITER_CLOSED", "private writer is closed"));
    if (halted) return Promise.reject(new LpPrivateWriterError("WRITER_HALTED", "private writer is halted until unknown state is reconciled"));
    const run = tail.then(() => execute(plan));
    tail = run.catch(() => undefined);
    return run;
  }

  async function reconcileUnknown({ txHash, receipt = undefined } = {}) {
    const current = records.get(txHash);
    if (!current) throw new LpPrivateWriterError("TX_UNKNOWN", `transaction ${txHash} is not tracked`);
    if (current.state !== "UNKNOWN") return clone(current);
    const observed = receipt === undefined && typeof readReceipt === "function" ? await readReceipt(txHash) : receipt;
    const result = receiptState(observed);
    if (result === "UNKNOWN") return clone(current);
    const recovered = update(txHash, { state: result, receiptStatus: observed.status, receiptBlock: blockNumber(observed), revertReason: result === "REVERTED" ? (observed.revertReason ?? null) : null, reconciledAt: now() });
    halted = [...records.values()].some((record) => record.state === "UNKNOWN");
    persist();
    return recovered;
  }

  return Object.freeze({
    enqueue,
    reconcileUnknown,
    close: () => { closed = true; persist(); },
    getState: state,
    getRecord: (hash) => clone(records.get(hash)),
  });
}

export { receiptState };
