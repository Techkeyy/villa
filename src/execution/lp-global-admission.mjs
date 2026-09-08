/**
 * Durable single-operator execution admission.
 *
 * This is intentionally a file-backed claim rather than an in-memory mutex.
 * The claim survives API/broker restarts and is adopted by the exact worker
 * that the broker launched. Stale claims require an explicit, scoped
 * liveness check before they can be removed.
 */

import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const LP_GLOBAL_ADMISSION_VERSION = "villa-lp-global-admission-v1";
export const LP_GLOBAL_ADMISSION_HEARTBEAT_MS = 10_000;
export const LP_GLOBAL_ADMISSION_DURATION_MS = 30_000;

export class LpGlobalAdmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LpGlobalAdmissionError";
    this.code = code;
  }
}

function fail(code, message) { throw new LpGlobalAdmissionError(code, message); }
function scope(value, label) {
  const result = String(value ?? "");
  if (!result) fail("GLOBAL_ADMISSION_SCOPE_INVALID", `${label} is required`);
  return result;
}
function address(value, label) {
  const result = scope(value, label).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(result)) fail("GLOBAL_ADMISSION_SCOPE_INVALID", `${label} is invalid`);
  return result;
}
function timestamp(value) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) fail("GLOBAL_ADMISSION_TIME_INVALID", "admission time is invalid");
  return result;
}
function normalizedSession(session) {
  if (!session) fail("GLOBAL_ADMISSION_SCOPE_INVALID", "session is required");
  return {
    sessionId: scope(session.sessionId, "sessionId"),
    owner: address(session.owner, "owner"),
    account: address(session.account, "account"),
    operator: address(session.operator, "operator"),
  };
}
function sameSession(left, right) {
  return left?.sessionId === right?.sessionId
    && left?.owner === right?.owner
    && left?.account === right?.account
    && left?.operator === right?.operator;
}
function clone(value) { return value ? structuredClone(value) : null; }
function serialize(value) { return JSON.stringify(value, null, 2); }

export function createFileGlobalExecutionAdmission({ filePath, now = () => Date.now(), durationMs = LP_GLOBAL_ADMISSION_DURATION_MS } = {}) {
  if (!filePath || typeof filePath !== "string") fail("GLOBAL_ADMISSION_REQUIRED", "a durable global admission path is required");
  if (!Number.isInteger(durationMs) || durationMs < 1) fail("GLOBAL_ADMISSION_INVALID", "global admission duration must be positive");

  function read() {
    if (!fs.existsSync(filePath)) return null;
    let value;
    try { value = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { fail("GLOBAL_ADMISSION_CORRUPT", "the durable global admission is unreadable"); }
    if (value?.version !== LP_GLOBAL_ADMISSION_VERSION || !value.admissionId || !value.session) fail("GLOBAL_ADMISSION_CORRUPT", "the durable global admission schema is unsupported");
    return value;
  }
  function write(value) {
    const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(temporary, serialize(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
  }
  function claim({ session, role = "strategy", pid = null } = {}) {
    const normalized = normalizedSession(session);
    const at = timestamp(now());
    const existing = read();
    if (existing) {
      if (Number(existing.expiresAt) > at) fail("GLOBAL_EXECUTION_BUSY", "VILLA is currently running another strategy. Try again shortly.");
      fail("GLOBAL_ADMISSION_STALE", "the global execution admission is stale and requires scoped reconciliation");
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const admission = {
      version: LP_GLOBAL_ADMISSION_VERSION,
      admissionId: `admission-${randomUUID()}`,
      role: scope(role, "admission role"),
      session: normalized,
      pid: pid === null ? null : Number(pid),
      state: "ADMITTED",
      acquiredAt: at,
      heartbeatAt: at,
      expiresAt: at + durationMs,
    };
    let handle;
    try {
      handle = fs.openSync(filePath, "wx", 0o600);
      fs.writeFileSync(handle, serialize(admission));
    } catch (error) {
      if (error?.code === "EEXIST") fail("GLOBAL_EXECUTION_BUSY", "VILLA is currently running another strategy. Try again shortly.");
      throw error;
    } finally {
      if (handle !== undefined) fs.closeSync(handle);
    }
    return clone(admission);
  }
  function assertClaim(admissionId, session) {
    const existing = read();
    if (!existing || existing.admissionId !== String(admissionId ?? "") || !sameSession(existing.session, normalizedSession(session))) {
      fail("GLOBAL_ADMISSION_SCOPE_MISMATCH", "global execution admission does not belong to this session");
    }
    return existing;
  }
  function adopt({ admissionId, session, role = undefined, pid = process.pid } = {}) {
    const existing = assertClaim(admissionId, session);
    const at = timestamp(now());
    if (Number(existing.expiresAt) <= at) fail("GLOBAL_ADMISSION_EXPIRED", "global execution admission expired before worker adoption");
    const updated = { ...existing, role: role ?? existing.role, pid: Number(pid), state: "ACTIVE", heartbeatAt: at, expiresAt: at + durationMs };
    write(updated);
    return clone(updated);
  }
  function heartbeat({ admissionId, session, pid = process.pid } = {}) {
    const existing = assertClaim(admissionId, session);
    const at = timestamp(now());
    if (Number(existing.expiresAt) <= at) fail("GLOBAL_ADMISSION_EXPIRED", "global execution admission expired");
    const updated = { ...existing, pid: Number(pid), state: "ACTIVE", heartbeatAt: at, expiresAt: at + durationMs };
    write(updated);
    return clone(updated);
  }
  function release({ admissionId, session } = {}) {
    assertClaim(admissionId, session);
    fs.unlinkSync(filePath);
    return { released: true, admissionId: String(admissionId), sessionId: String(session.sessionId) };
  }
  function reconcileStale({ admissionId, session, isActive } = {}) {
    const existing = assertClaim(admissionId, session);
    if (typeof isActive !== "function") fail("GLOBAL_ADMISSION_LIVENESS_UNKNOWN", "stale admission liveness is unavailable");
    if (isActive(existing) !== false) fail("GLOBAL_ADMISSION_LIVENESS_UNKNOWN", "global admission liveness is not authoritatively clear");
    fs.unlinkSync(filePath);
    return { released: true, admissionId: existing.admissionId, sessionId: existing.session.sessionId, reason: "STALE_SCOPED_ADMISSION_RECONCILED" };
  }
  return Object.freeze({ claim, adopt, heartbeat, release, reconcileStale, get: () => clone(read()), filePath });
}

