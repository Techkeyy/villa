/**
 * Account-bound execution session and lease primitives.
 *
 * A session is immutable with respect to account, owner, operator, chain, and
 * market identity. The lease is deliberately account-scoped: a second
 * controller cannot silently take over an account, and an expired lease may
 * only be recovered after an authoritative reconciliation.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { isAddress } from "viem";
import { SHANNON_CHAIN_ID, ZERO_ADDRESS } from "./lp-adapter.mjs";

export const LP_SESSION_VERSION = "villa-lp-session-v1";
export const LP_SESSION_STATES = Object.freeze([
  "CREATED",
  "PREFLIGHT",
  "RUNNING",
  "PAUSED",
  "STOPPING",
  "STOPPED",
  "ERROR",
]);

const ACTIVE_STATES = new Set(["CREATED", "PREFLIGHT", "RUNNING", "PAUSED", "STOPPING", "ERROR"]);
const TRANSITIONS = Object.freeze({
  CREATED: Object.freeze(["PREFLIGHT", "STOPPED", "ERROR"]),
  PREFLIGHT: Object.freeze(["RUNNING", "STOPPING", "STOPPED", "ERROR"]),
  RUNNING: Object.freeze(["PAUSED", "STOPPING", "ERROR"]),
  PAUSED: Object.freeze(["PREFLIGHT", "STOPPING", "ERROR"]),
  STOPPING: Object.freeze(["STOPPED", "ERROR"]),
  STOPPED: Object.freeze([]),
  ERROR: Object.freeze(["PREFLIGHT", "STOPPING", "STOPPED"]),
});

export class LpSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LpSessionError";
    this.code = code;
  }
}

function address(value, label) {
  const text = String(value ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(text) || !isAddress(text)) {
    throw new LpSessionError("ADDRESS_INVALID", `${label} must be a valid address`);
  }
  return text.toLowerCase();
}

function marketId(value) {
  const text = String(value ?? "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) throw new LpSessionError("MARKET_INVALID", "currentMarketId must be a bytes32 value");
  return text.toLowerCase();
}

function finiteMs(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new LpSessionError("TIME_INVALID", `${label} must be a non-negative finite number`);
  return parsed;
}

function copy(value) {
  return value ? structuredClone(value) : null;
}

export function createLpExecutionSession({
  sessionId = `lp-${randomUUID()}`,
  account,
  owner,
  operator,
  chainId = SHANNON_CHAIN_ID,
  marketSeries,
  currentMarketId,
  riskPolicyVersion,
  executionMode = "WET",
  createdAt = Date.now(),
  maxSessionDurationSec = 900,
} = {}) {
  const normalizedAccount = address(account, "VillaAccount");
  const normalizedOwner = address(owner, "LP owner");
  const normalizedOperator = address(operator, "authorized operator");
  if (normalizedAccount === normalizedOwner || normalizedAccount === normalizedOperator || normalizedOwner === normalizedOperator) {
    throw new LpSessionError("IDENTITY_COLLISION", "session identities must remain distinct");
  }
  if (Number(chainId) !== SHANNON_CHAIN_ID) throw new LpSessionError("CHAIN_UNSUPPORTED", `session chain must be ${SHANNON_CHAIN_ID}`);
  if (!String(marketSeries ?? "").trim()) throw new LpSessionError("SERIES_INVALID", "marketSeries is required");
  if (!riskPolicyVersion || !String(riskPolicyVersion).trim()) throw new LpSessionError("RISK_POLICY_INVALID", "riskPolicyVersion is required");
  if (!Number.isInteger(maxSessionDurationSec) || maxSessionDurationSec < 1) throw new LpSessionError("SESSION_CAP_INVALID", "maxSessionDurationSec must be a positive integer");

  return Object.freeze({
    version: LP_SESSION_VERSION,
    sessionId: String(sessionId),
    account: normalizedAccount,
    owner: normalizedOwner,
    operator: normalizedOperator,
    chainId: SHANNON_CHAIN_ID,
    marketSeries: String(marketSeries),
    currentMarketId: marketId(currentMarketId),
    riskPolicyVersion: String(riskPolicyVersion),
    executionMode: String(executionMode),
    createdAt: finiteMs(createdAt, "createdAt"),
    updatedAt: finiteMs(createdAt, "createdAt"),
    maxSessionDurationSec,
    state: "CREATED",
    leaseId: null,
  });
}

export function transitionLpSession(session, nextState, { atMs = Date.now() } = {}) {
  if (!session || session.version !== LP_SESSION_VERSION || !LP_SESSION_STATES.includes(session.state)) throw new LpSessionError("SESSION_INVALID", "a valid LP session is required");
  if (!LP_SESSION_STATES.includes(nextState) || !TRANSITIONS[session.state].includes(nextState)) {
    throw new LpSessionError("STATE_TRANSITION_INVALID", `${session.state} cannot transition to ${nextState}`);
  }
  return Object.freeze({ ...session, state: nextState, updatedAt: finiteMs(atMs, "atMs") });
}

export function assertLpSessionScope(session, { account, owner, operator, chainId, marketSeries, marketId: expectedMarketId } = {}) {
  if (!session || session.version !== LP_SESSION_VERSION) throw new LpSessionError("SESSION_INVALID", "a valid LP session is required");
  if (account !== undefined && address(account, "account") !== session.account) throw new LpSessionError("ACCOUNT_SCOPE_MISMATCH", "session cannot operate another VillaAccount");
  if (owner !== undefined && address(owner, "owner") !== session.owner) throw new LpSessionError("OWNER_SCOPE_MISMATCH", "session owner does not match");
  if (operator !== undefined && address(operator, "operator") !== session.operator) throw new LpSessionError("OPERATOR_SCOPE_MISMATCH", "session operator does not match");
  if (chainId !== undefined && Number(chainId) !== session.chainId) throw new LpSessionError("CHAIN_SCOPE_MISMATCH", "session chain does not match");
  if (marketSeries !== undefined && String(marketSeries) !== session.marketSeries) throw new LpSessionError("SERIES_SCOPE_MISMATCH", "session market series does not match");
  if (expectedMarketId !== undefined && marketId(expectedMarketId) !== session.currentMarketId) throw new LpSessionError("MARKET_SCOPE_MISMATCH", "session is bound to a different market");
  return true;
}

/**
 * In-memory lease implementation for the pre-wet boundary. Production must
 * back the same contract with a durable store shared by all engine instances.
 */
export function createAccountLeaseStore({ now = () => Date.now(), leaseDurationMs = 30_000 } = {}) {
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1) throw new LpSessionError("LEASE_INVALID", "leaseDurationMs must be positive");
  const leases = new Map();

  function timestamp(value) { return finiteMs(value ?? now(), "lease time"); }
  function get(account) { return copy(leases.get(address(account, "account"))); }
  function assertLease(lease, session, atMs = now()) {
    if (!lease || lease.account !== session.account || lease.sessionId !== session.sessionId) throw new LpSessionError("LEASE_SCOPE_MISMATCH", "lease does not belong to this session");
    if (lease.expiresAt <= timestamp(atMs)) throw new LpSessionError("LEASE_EXPIRED", "account lease has expired");
    return lease;
  }

  function acquire(session, { reconciled = false, atMs = now() } = {}) {
    if (!session || session.version !== LP_SESSION_VERSION) throw new LpSessionError("SESSION_INVALID", "a valid LP session is required");
    const at = timestamp(atMs);
    const existing = leases.get(session.account);
    if (existing && existing.expiresAt > at) throw new LpSessionError("ACCOUNT_LEASE_HELD", `VillaAccount ${session.account} already has an active controller`);
    if (existing && !reconciled) throw new LpSessionError("STALE_LEASE_REQUIRES_RECONCILIATION", "an expired account lease requires chain/venue reconciliation before recovery");
    const lease = {
      version: "villa-account-lease-v1",
      leaseId: `lease-${randomUUID()}`,
      account: session.account,
      sessionId: session.sessionId,
      owner: session.owner,
      operator: session.operator,
      acquiredAt: at,
      heartbeatAt: at,
      expiresAt: at + leaseDurationMs,
      recoveredExpiredLease: Boolean(existing),
      state: "HELD",
    };
    leases.set(session.account, lease);
    return copy(lease);
  }

  function heartbeat(session, { atMs = now() } = {}) {
    const at = timestamp(atMs);
    const current = assertLease(leases.get(session?.account), session, at);
    const next = { ...current, heartbeatAt: at, expiresAt: at + leaseDurationMs };
    leases.set(session.account, next);
    return copy(next);
  }

  function release(session, { reconciled = false, atMs = now() } = {}) {
    if (!reconciled) throw new LpSessionError("LEASE_RELEASE_BLOCKED", "lease remains held until reconciliation is complete");
    if (!session || !["STOPPING", "STOPPED", "ERROR"].includes(session.state)) throw new LpSessionError("LEASE_RELEASE_BLOCKED", "only a stopping or terminal session may release its lease");
    const current = leases.get(session.account);
    if (!current || current.sessionId !== session.sessionId) throw new LpSessionError("LEASE_SCOPE_MISMATCH", "session does not own the account lease");
    leases.delete(session.account);
    return { released: true, account: session.account, sessionId: session.sessionId, releasedAt: timestamp(atMs) };
  }

  function assertHeld(session, { atMs = now() } = {}) {
    return copy(assertLease(leases.get(session?.account), session, atMs));
  }

  return Object.freeze({
    acquire,
    heartbeat,
    release,
    get,
    assertHeld,
    has: (account) => Boolean(get(account)),
    activeStates: ACTIVE_STATES,
  });
}

/**
 * Durable single-host lease implementation. The lock file is created with
 * O_EXCL, so two engine processes cannot acquire the same account at once.
 * An expired file is never overwritten without an explicit reconciliation;
 * production deployments should place `directory` on the private engine
 * filesystem with access limited to the `villa` service account.
 */
export function createFileAccountLeaseStore({ directory, now = () => Date.now(), leaseDurationMs = 30_000 } = {}) {
  if (!directory || typeof directory !== "string") throw new LpSessionError("LEASE_INVALID", "a durable lease directory is required");
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1) throw new LpSessionError("LEASE_INVALID", "leaseDurationMs must be positive");
  fs.mkdirSync(directory, { recursive: true });

  function timestamp(value) { return finiteMs(value ?? now(), "lease time"); }
  function fileFor(account) { return path.join(directory, `${address(account, "account")}.lease.json`); }
  function read(file) {
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new LpSessionError("LEASE_CORRUPT", "durable account lease is unreadable; recovery is blocked"); }
  }
  function write(file, lease) {
    const handle = fs.openSync(file, "r+");
    try {
      fs.ftruncateSync(handle, 0);
      fs.writeFileSync(handle, JSON.stringify(lease));
    } finally {
      fs.closeSync(handle);
    }
  }
  function assertLease(lease, session, atMs = now()) {
    if (!lease || lease.account !== session.account || lease.sessionId !== session.sessionId) throw new LpSessionError("LEASE_SCOPE_MISMATCH", "lease does not belong to this session");
    if (lease.expiresAt <= timestamp(atMs)) throw new LpSessionError("LEASE_EXPIRED", "account lease has expired");
    return lease;
  }

  function acquire(session, { reconciled = false, atMs = now() } = {}) {
    if (!session || session.version !== LP_SESSION_VERSION) throw new LpSessionError("SESSION_INVALID", "a valid LP session is required");
    const file = fileFor(session.account);
    const at = timestamp(atMs);
    const existing = read(file);
    if (existing && existing.expiresAt > at) throw new LpSessionError("ACCOUNT_LEASE_HELD", `VillaAccount ${session.account} already has an active controller`);
    if (existing && !reconciled) throw new LpSessionError("STALE_LEASE_REQUIRES_RECONCILIATION", "an expired account lease requires chain/venue reconciliation before recovery");
    if (existing) {
      const staleFile = `${file}.stale-${randomUUID()}`;
      try { fs.renameSync(file, staleFile); fs.unlinkSync(staleFile); } catch { throw new LpSessionError("ACCOUNT_LEASE_HELD", "another controller changed the account lease during recovery"); }
    }
    const lease = {
      version: "villa-account-lease-v1",
      leaseId: `lease-${randomUUID()}`,
      account: session.account,
      sessionId: session.sessionId,
      owner: session.owner,
      operator: session.operator,
      acquiredAt: at,
      heartbeatAt: at,
      expiresAt: at + leaseDurationMs,
      recoveredExpiredLease: Boolean(existing),
      state: "HELD",
    };
    let handle;
    try {
      handle = fs.openSync(file, "wx");
      fs.writeFileSync(handle, JSON.stringify(lease));
    } catch (error) {
      throw new LpSessionError(error?.code === "EEXIST" ? "ACCOUNT_LEASE_HELD" : "LEASE_WRITE_FAILED", "durable account lease could not be acquired");
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
    }
    return copy(lease);
  }

  function heartbeat(session, { atMs = now() } = {}) {
    const file = fileFor(session.account);
    const current = assertLease(read(file), session, atMs);
    const at = timestamp(atMs);
    const next = { ...current, heartbeatAt: at, expiresAt: at + leaseDurationMs };
    write(file, next);
    return copy(next);
  }

  function release(session, { reconciled = false, atMs = now() } = {}) {
    if (!reconciled) throw new LpSessionError("LEASE_RELEASE_BLOCKED", "lease remains held until reconciliation is complete");
    if (!session || !["STOPPING", "STOPPED", "ERROR"].includes(session.state)) throw new LpSessionError("LEASE_RELEASE_BLOCKED", "only a stopping or terminal session may release its lease");
    const file = fileFor(session.account);
    const current = read(file);
    if (!current || current.sessionId !== session.sessionId) throw new LpSessionError("LEASE_SCOPE_MISMATCH", "session does not own the account lease");
    fs.unlinkSync(file);
    return { released: true, account: session.account, sessionId: session.sessionId, releasedAt: timestamp(atMs) };
  }

  function get(account) { return copy(read(fileFor(account))); }

  return Object.freeze({
    acquire,
    heartbeat,
    release,
    get,
    assertHeld: (session, { atMs = now() } = {}) => copy(assertLease(read(fileFor(session.account)), session, atMs)),
    has: (account) => Boolean(get(account)),
    activeStates: ACTIVE_STATES,
  });
}

export function attachLease(session, lease) {
  if (!lease) throw new LpSessionError("LEASE_INVALID", "lease is required");
  assertLpSessionScope(session, { account: lease.account, owner: lease.owner, operator: lease.operator });
  return Object.freeze({ ...session, leaseId: lease.leaseId });
}

export { TRANSITIONS };
