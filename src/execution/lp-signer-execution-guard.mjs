/**
 * Shared pre-write safety boundary for every signer-backed worker.
 *
 * This helper does not load a signer and does not perform a chain write. It
 * proves the immutable session envelope, initializes the transaction journal,
 * and adopts the exact broker-owned global execution claim before a caller
 * may construct the private writer.
 */

import { createFileGlobalExecutionAdmission } from "./lp-global-admission.mjs";
import { initializeDurableJournal, readExecutionProvenance } from "./lp-execution-provenance.mjs";

export class LpSignerExecutionGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LpSignerExecutionGuardError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new LpSignerExecutionGuardError(code, message);
}

function scopeSession(session) {
  if (!session || typeof session !== "object") fail("SIGNER_SCOPE_REQUIRED", "an exact execution session is required");
  for (const field of ["sessionId", "owner", "account", "operator"]) {
    if (!String(session[field] ?? "")) fail("SIGNER_SCOPE_REQUIRED", `session ${field} is required`);
  }
  return {
    sessionId: String(session.sessionId),
    owner: String(session.owner).toLowerCase(),
    account: String(session.account).toLowerCase(),
    operator: String(session.operator).toLowerCase(),
  };
}

/** Prepare, but never broadcast, one exact signer execution scope. */
export function prepareSignerExecution({
  session,
  journalPath,
  provenancePath,
  globalAdmissionFile,
  admissionId,
  role,
} = {}) {
  const exact = scopeSession(session);
  if (!journalPath || !provenancePath) fail("SIGNER_PROVENANCE_REQUIRED", "provenance and journal paths are required before signer execution");
  if (!globalAdmissionFile || !admissionId) fail("GLOBAL_ADMISSION_REQUIRED", "the exact durable global execution admission is required before signer execution");

  let provenance;
  try {
    provenance = readExecutionProvenance(provenancePath, { session });
  } catch (error) {
    fail(error?.code ?? "PROVENANCE_INVALID", error?.message ?? "execution provenance is invalid");
  }
  if (!provenance) fail("PROVENANCE_REQUIRED", "new signer execution requires immutable provenance");

  let journal;
  try {
    journal = initializeDurableJournal({ journalPath, session, provenancePath });
  } catch (error) {
    fail(error?.code ?? "JOURNAL_INVALID", error?.message ?? "transaction journal is invalid");
  }

  const admissionStore = createFileGlobalExecutionAdmission({ filePath: globalAdmissionFile });
  let admission;
  try {
    admission = admissionStore.adopt({ admissionId, session: exact, role });
  } catch (error) {
    fail(error?.code ?? "GLOBAL_ADMISSION_INVALID", error?.message ?? "global execution admission could not be adopted");
  }

  return Object.freeze({ exactSession: Object.freeze(exact), provenance, journal, admissionStore, admission });
}
