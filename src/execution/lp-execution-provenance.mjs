/**
 * Durable forward-safety envelope for one account-bound execution session.
 *
 * The envelope is created with O_EXCL and is never overwritten. Mutable
 * transaction facts belong in the durable journal; this file preserves the
 * exact identity and intended scope that recovery must never reconstruct from
 * an error message.
 */

import * as fs from "node:fs";
import path from "node:path";

export const LP_EXECUTION_PROVENANCE_VERSION = "villa-lp-execution-provenance-v1";
export const LP_JOURNAL_VERSION = "villa-private-account-writer-v1";

export class LpExecutionProvenanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LpExecutionProvenanceError";
    this.code = code;
  }
}

function fail(code, message) { throw new LpExecutionProvenanceError(code, message); }
function text(value, label, { required = true } = {}) {
  const result = String(value ?? "");
  if (required && !result) fail("PROVENANCE_SCOPE_INVALID", `${label} is required`);
  return result;
}
function address(value, label) {
  const result = text(value, label).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(result)) fail("PROVENANCE_SCOPE_INVALID", `${label} is invalid`);
  return result;
}
function market(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(result)) fail("PROVENANCE_SCOPE_INVALID", "marketId must be bytes32 or null");
  return result;
}
function timestamp(value) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) fail("PROVENANCE_TIME_INVALID", "provenance timestamp must be a non-negative finite number");
  return result;
}
function json(value) { return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? `${item}n` : item, 2); }
function ensureDirectory(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function read(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { fail("PROVENANCE_CORRUPT", `${label} is unreadable`); }
}

function sameScope(left, right) {
  return left?.sessionId === right?.sessionId
    && left?.account === right?.account
    && left?.owner === right?.owner
    && left?.operator === right?.operator
    && left?.marketId === right?.marketId;
}

export function createExecutionProvenance({ session, marketIdentity = null, executionAdmission = null, lease = null, journalPath, executionStage = "PREPARED", now = () => Date.now() } = {}) {
  if (!session) fail("PROVENANCE_SCOPE_INVALID", "session is required");
  const normalized = {
    sessionId: text(session.sessionId, "sessionId"),
    account: address(session.account, "account"),
    owner: address(session.owner, "owner"),
    operator: address(session.operator, "operator"),
    marketId: market(session.currentMarketId),
  };
  if (!journalPath) fail("PROVENANCE_SCOPE_INVALID", "journalPath is required");
  const admission = executionAdmission ? {
    id: text(executionAdmission.id ?? executionAdmission.admissionId, "execution admission id"),
    path: text(executionAdmission.path ?? executionAdmission.filePath, "execution admission path"),
  } : null;
  const leaseIdentity = lease ? {
    leaseId: text(lease.leaseId, "leaseId"),
    account: address(lease.account, "lease account"),
    owner: address(lease.owner, "lease owner"),
    operator: address(lease.operator, "lease operator"),
    sessionId: text(lease.sessionId, "lease sessionId"),
  } : null;
  if (leaseIdentity && (leaseIdentity.account !== normalized.account || leaseIdentity.owner !== normalized.owner || leaseIdentity.operator !== normalized.operator || leaseIdentity.sessionId !== normalized.sessionId)) {
    fail("PROVENANCE_SCOPE_INVALID", "lease identity does not match the execution session");
  }
  return Object.freeze({
    schemaVersion: LP_EXECUTION_PROVENANCE_VERSION,
    sessionId: normalized.sessionId,
    owner: normalized.owner,
    account: normalized.account,
    operator: normalized.operator,
    marketId: normalized.marketId,
    marketIdentity: marketIdentity === null || marketIdentity === undefined ? null : Object.freeze({ ...marketIdentity }),
    executionAdmission: admission ? Object.freeze(admission) : null,
    lease: leaseIdentity ? Object.freeze(leaseIdentity) : null,
    transactionJournal: Object.freeze({ identity: `journal:${normalized.sessionId}`, path: String(journalPath) }),
    executionStage: text(executionStage, "executionStage"),
    writeAuthorityReached: false,
    createdAt: timestamp(now()),
  });
}

/** Persist once. Reusing the exact envelope is idempotent; changing scope is not. */
export function persistExecutionProvenance({ provenancePath, provenance } = {}) {
  if (!provenancePath || !provenance || provenance.schemaVersion !== LP_EXECUTION_PROVENANCE_VERSION) fail("PROVENANCE_REQUIRED", "a valid execution provenance envelope is required");
  ensureDirectory(provenancePath);
  if (fs.existsSync(provenancePath)) {
    const existing = read(provenancePath, "execution provenance");
    if (JSON.stringify(existing) !== JSON.stringify(provenance)) fail("PROVENANCE_IMMUTABLE", "execution provenance already exists with a different scope");
    return existing;
  }
  let handle;
  try {
    handle = fs.openSync(provenancePath, "wx", 0o600);
    fs.writeFileSync(handle, json(provenance));
  } catch (error) {
    if (error?.code === "EEXIST") return persistExecutionProvenance({ provenancePath, provenance });
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
  return provenance;
}

export function readExecutionProvenance(provenancePath, { session = null } = {}) {
  if (!provenancePath || !fs.existsSync(provenancePath)) return null;
  const value = read(provenancePath, "execution provenance");
  if (value?.schemaVersion !== LP_EXECUTION_PROVENANCE_VERSION) fail("PROVENANCE_CORRUPT", "execution provenance schema is unsupported");
  if (session) {
    const expected = { sessionId: String(session.sessionId), account: String(session.account).toLowerCase(), owner: String(session.owner).toLowerCase(), operator: String(session.operator).toLowerCase(), marketId: market(session.currentMarketId) };
    if (!sameScope(value, expected)) fail("PROVENANCE_SCOPE_MISMATCH", "execution provenance does not match the session scope");
  }
  return value;
}

/** Initialize the journal before a signer-backed writer can be constructed. */
export function initializeDurableJournal({ journalPath, session, provenancePath, now = () => Date.now() } = {}) {
  if (!journalPath || !session) fail("JOURNAL_REQUIRED", "journal path and session are required");
  ensureDirectory(journalPath);
  const metadata = {
    version: LP_JOURNAL_VERSION,
    schemaVersion: "villa-lp-transaction-journal-v2",
    sessionId: String(session.sessionId),
    owner: String(session.owner).toLowerCase(),
    account: String(session.account).toLowerCase(),
    operator: String(session.operator).toLowerCase(),
    marketId: market(session.currentMarketId),
    provenancePath: provenancePath ?? null,
    initializedBeforeWrite: true,
    writeAuthorityReached: false,
    initializedAt: timestamp(now()),
    nextNonce: null,
    sequence: 0,
    halted: false,
    records: [],
  };
  if (fs.existsSync(journalPath)) {
    const existing = read(journalPath, "transaction journal");
    if (existing?.version !== LP_JOURNAL_VERSION || existing.initializedBeforeWrite !== true || !Array.isArray(existing.records)) fail("JOURNAL_CORRUPT", "transaction journal schema is unsupported");
    for (const field of ["sessionId", "owner", "account", "operator"]) {
      if (existing[field] !== undefined && String(existing[field]).toLowerCase() !== String(metadata[field]).toLowerCase()) fail("JOURNAL_SCOPE_MISMATCH", "transaction journal does not match the session scope");
    }
    if (existing.marketId !== undefined && existing.marketId !== metadata.marketId) fail("JOURNAL_SCOPE_MISMATCH", "transaction journal market does not match the session scope");
    return existing;
  }
  let handle;
  try {
    handle = fs.openSync(journalPath, "wx", 0o600);
    fs.writeFileSync(handle, json(metadata));
  } catch (error) {
    if (error?.code === "EEXIST") return initializeDurableJournal({ journalPath, session, provenancePath, now });
    throw error;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
  return metadata;
}

