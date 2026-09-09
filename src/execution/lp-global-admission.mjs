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
export const LP_GLOBAL_ADMISSION_DIRECTORY_MODE = 0o750;
export const LP_GLOBAL_ADMISSION_FILE_MODE = 0o600;

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
function withPath(value, filePath) { return value ? { ...value, path: filePath } : value; }
function serialize(value) { return JSON.stringify(value, null, 2); }
function isAccessError(error) { return error?.code === "EACCES" || error?.code === "EPERM"; }
function accessFailure(error) { return isAccessError(error) ? "ACCESS_DENIED" : "IO_FAILURE"; }

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: LP_GLOBAL_ADMISSION_DIRECTORY_MODE });
  fs.chmodSync(directory, LP_GLOBAL_ADMISSION_DIRECTORY_MODE);
}

function intendedOwner(directory) {
  if (process.platform === "win32" || typeof process.getuid !== "function" || process.getuid() !== 0) return null;
  const stat = fs.statSync(directory);
  if (!Number.isInteger(stat.uid) || !Number.isInteger(stat.gid)) return null;
  return { uid: stat.uid, gid: stat.gid };
}

function prepareVisiblePermissions(file, owner) {
  fs.chmodSync(file, LP_GLOBAL_ADMISSION_FILE_MODE);
  if (owner) fs.chownSync(file, owner.uid, owner.gid);
}

function assertVisiblePermissions(file, owner) {
  const stat = fs.statSync(file);
  if (process.platform !== "win32" && (stat.mode & 0o777) !== LP_GLOBAL_ADMISSION_FILE_MODE) fail("GLOBAL_ADMISSION_PERMISSION_INVALID", "the durable global admission permissions are invalid");
  if (process.platform !== "win32" && owner && (stat.uid !== owner.uid || stat.gid !== owner.gid)) fail("GLOBAL_ADMISSION_PERMISSION_INVALID", "the durable global admission ownership is invalid");
}

export function createFileGlobalExecutionAdmission({ filePath, now = () => Date.now(), durationMs = LP_GLOBAL_ADMISSION_DURATION_MS } = {}) {
  if (!filePath || typeof filePath !== "string") fail("GLOBAL_ADMISSION_REQUIRED", "a durable global admission path is required");
  if (!Number.isInteger(durationMs) || durationMs < 1) fail("GLOBAL_ADMISSION_INVALID", "global admission duration must be positive");

  function classifyValue(value, at) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "CORRUPT_CONTENT", record: null, reason: "SCHEMA" };
    try {
      if (value.version !== LP_GLOBAL_ADMISSION_VERSION || !value.admissionId || !value.session) return { status: "CORRUPT_CONTENT", record: value, reason: "SCHEMA" };
      normalizedSession(value.session);
      scope(value.role, "admission role");
      if (!["ADMITTED", "ACTIVE"].includes(String(value.state))) return { status: "CORRUPT_CONTENT", record: value, reason: "SCHEMA" };
      if (value.pid !== null && (!Number.isInteger(Number(value.pid)) || Number(value.pid) < 1)) return { status: "CORRUPT_CONTENT", record: value, reason: "SCHEMA" };
      const acquiredAt = timestamp(value.acquiredAt);
      const heartbeatAt = timestamp(value.heartbeatAt);
      const expiresAt = timestamp(value.expiresAt);
      if (heartbeatAt < acquiredAt || expiresAt < heartbeatAt) return { status: "CORRUPT_CONTENT", record: value, reason: "SCHEMA" };
      return { status: expiresAt > at ? "VALID_ACTIVE" : "VALID_EXPIRED", record: value, reason: null };
    } catch {
      return { status: "CORRUPT_CONTENT", record: value, reason: "SCHEMA" };
    }
  }

  function inspect() {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return { status: "CORRUPT_CONTENT", record: null, reason: "UNREADABLE" };
    } catch (error) {
      if (error?.code === "ENOENT") return { status: "ABSENT", record: null, reason: null };
      return { status: accessFailure(error), record: null, reason: isAccessError(error) ? "ACCESS" : "IO" };
    }
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      return { status: accessFailure(error), record: null, reason: isAccessError(error) ? "ACCESS" : "IO" };
    }
    if (!raw.trim()) return { status: "CORRUPT_CONTENT", record: null, reason: "EMPTY" };
    let value;
    try { value = JSON.parse(raw); } catch { return { status: "CORRUPT_CONTENT", record: null, reason: "JSON" }; }
    return classifyValue(value, timestamp(now()));
  }

  function read() {
    const inspected = inspect();
    if (inspected.status === "ABSENT") return null;
    if (inspected.status === "ACCESS_DENIED") fail("GLOBAL_ADMISSION_ACCESS_DENIED", "the durable global admission cannot be read by this identity");
    if (inspected.status === "IO_FAILURE") fail("GLOBAL_ADMISSION_IO_FAILURE", "the durable global admission could not be read due to an I/O failure");
    if (inspected.status === "CORRUPT_CONTENT") fail("GLOBAL_ADMISSION_CORRUPT", inspected.reason === "SCHEMA" ? "the durable global admission schema is unsupported" : "the durable global admission content is corrupt");
    return inspected.record;
  }

  function atomicWrite(value, { exclusive = false } = {}) {
    const directory = path.dirname(filePath);
    ensureDirectory(directory);
    const owner = intendedOwner(directory);
    const temporary = path.join(directory, "." + path.basename(filePath) + ".tmp-" + process.pid + "-" + randomUUID());
    let handle;
    try {
      handle = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(handle, serialize(value), { encoding: "utf8" });
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = undefined;
      prepareVisiblePermissions(temporary, owner);
      if (exclusive) {
        fs.linkSync(temporary, filePath);
        fs.unlinkSync(temporary);
      } else {
        fs.renameSync(temporary, filePath);
      }
      assertVisiblePermissions(filePath, owner);
    } catch (error) {
      if (handle !== undefined) {
        try { fs.closeSync(handle); } catch { /* preserve the original failure */ }
      }
      try { fs.unlinkSync(temporary); } catch { /* preserve the original failure */ }
      throw error;
    }
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
    try {
      atomicWrite(admission, { exclusive: true });
    } catch (error) {
      if (error?.code === "EEXIST") fail("GLOBAL_EXECUTION_BUSY", "VILLA is currently running another strategy. Try again shortly.");
      throw error;
    }
    return clone(withPath(admission, filePath));
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
    atomicWrite(updated);
    return clone(withPath(updated, filePath));
  }
  function heartbeat({ admissionId, session, pid = process.pid } = {}) {
    const existing = assertClaim(admissionId, session);
    const at = timestamp(now());
    if (Number(existing.expiresAt) <= at) fail("GLOBAL_ADMISSION_EXPIRED", "global execution admission expired");
    const updated = { ...existing, pid: Number(pid), state: "ACTIVE", heartbeatAt: at, expiresAt: at + durationMs };
    atomicWrite(updated);
    return clone(withPath(updated, filePath));
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
  function reconcileCorrupt({ admissionId, session, isActive, isZeroWrite } = {}) {
    const exactSession = normalizedSession(session);
    const inspected = inspect();
    if (inspected.status !== "CORRUPT_CONTENT") fail("GLOBAL_ADMISSION_NOT_CORRUPT", "the durable global admission does not contain corrupt content");
    const record = inspected.record;
    if (!record?.admissionId || !record.session) fail("GLOBAL_ADMISSION_SCOPE_UNKNOWN", "the corrupt admission has no independently verifiable session scope");
    let corruptSession;
    try { corruptSession = normalizedSession(record.session); } catch { fail("GLOBAL_ADMISSION_SCOPE_UNKNOWN", "the corrupt admission has no independently verifiable session scope"); }
    if (record.admissionId !== String(admissionId ?? "") || !sameSession(corruptSession, exactSession)) fail("GLOBAL_ADMISSION_SCOPE_MISMATCH", "the corrupt global execution admission does not belong to this session");
    if (typeof isActive !== "function" || isActive(record) !== false) fail("GLOBAL_ADMISSION_LIVENESS_UNKNOWN", "corrupt admission liveness is not authoritatively clear");
    if (typeof isZeroWrite !== "function" || isZeroWrite(record) !== true) fail("GLOBAL_ADMISSION_ZERO_WRITE_UNKNOWN", "corrupt admission zero-write evidence is not authoritative");
    fs.unlinkSync(filePath);
    return { released: true, admissionId: record.admissionId, sessionId: record.session.sessionId, reason: "CORRUPT_SCOPED_ADMISSION_RECONCILED" };
  }

  return Object.freeze({ claim, adopt, heartbeat, release, reconcileStale, reconcileCorrupt, inspect, get: () => clone(read()), filePath });

}

