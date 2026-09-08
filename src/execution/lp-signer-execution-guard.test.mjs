import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createExecutionProvenance, initializeDurableJournal, persistExecutionProvenance } from "./lp-execution-provenance.mjs";
import { createFileGlobalExecutionAdmission } from "./lp-global-admission.mjs";
import { prepareSignerExecution } from "./lp-signer-execution-guard.mjs";
import { createAccountBoundPrivateWriter } from "./lp-private-writer.mjs";

const OPERATOR = "0xaf4ee6c0c6ff6337f4c4f07b87c8343df73e8d37";
const OWNER = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";

function session(overrides = {}) {
  return { sessionId: "uat-9999999999999-aabbccdd", owner: OWNER, account: ACCOUNT, operator: OPERATOR, currentMarketId: null, ...overrides };
}

function tempScope() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "villa-signer-guard-"));
  const journalPath = path.join(directory, "transactions.json");
  const provenancePath = path.join(directory, "provenance.json");
  const admissionPath = path.join(directory, "global-admission.json");
  return { directory, journalPath, provenancePath, admissionPath };
}

function clean(scope) {
  fs.rmSync(scope.directory, { recursive: true, force: true });
}

test("signer guard proves provenance and journal before adopting the exact admission", () => {
  const scope = tempScope();
  try {
    const exact = session();
    const admissionStore = createFileGlobalExecutionAdmission({ filePath: scope.admissionPath });
    const claim = admissionStore.claim({ session: exact, role: "recovery", pid: 1234 });
    const provenance = createExecutionProvenance({
      session: exact,
      executionAdmission: { id: claim.admissionId, path: scope.admissionPath },
      lease: { leaseId: "lease-1", sessionId: exact.sessionId, owner: exact.owner, account: exact.account, operator: exact.operator },
      journalPath: scope.journalPath,
      now: () => 1000,
    });
    persistExecutionProvenance({ provenancePath: scope.provenancePath, provenance });
    initializeDurableJournal({ journalPath: scope.journalPath, provenancePath: scope.provenancePath, session: exact });
    const guard = prepareSignerExecution({
      session: exact,
      journalPath: scope.journalPath,
      provenancePath: scope.provenancePath,
      globalAdmissionFile: scope.admissionPath,
      admissionId: claim.admissionId,
      role: "recovery",
    });
    assert.equal(guard.admissionStore.get().session.account, ACCOUNT.toLowerCase());
    assert.equal(guard.journal.initializedBeforeWrite, true);
    assert.equal(guard.provenance.schemaVersion, "villa-lp-execution-provenance-v1");
    guard.admissionStore.release({ admissionId: claim.admissionId, session: exact });
  } finally {
    clean(scope);
  }
});

test("missing or mismatched provenance rejects before signer admission", () => {
  const scope = tempScope();
  try {
    const exact = session();
    const admissionStore = createFileGlobalExecutionAdmission({ filePath: scope.admissionPath });
    const claim = admissionStore.claim({ session: exact, role: "settlement", pid: 1234 });
    assert.throws(() => prepareSignerExecution({
      session: exact,
      journalPath: scope.journalPath,
      provenancePath: scope.provenancePath,
      globalAdmissionFile: scope.admissionPath,
      admissionId: claim.admissionId,
      role: "settlement",
    }), (error) => error.code === "PROVENANCE_REQUIRED");
    assert.equal(admissionStore.get().admissionId, claim.admissionId);

    const provenance = createExecutionProvenance({
      session: exact,
      executionAdmission: { id: claim.admissionId, path: scope.admissionPath },
      journalPath: scope.journalPath,
      now: () => 1000,
    });
    persistExecutionProvenance({ provenancePath: scope.provenancePath, provenance });
    assert.throws(() => prepareSignerExecution({
      session: session({ owner: "0x3333333333333333333333333333333333333333" }),
      journalPath: scope.journalPath,
      provenancePath: scope.provenancePath,
      globalAdmissionFile: scope.admissionPath,
      admissionId: claim.admissionId,
      role: "settlement",
    }), (error) => error.code === "PROVENANCE_SCOPE_MISMATCH");
  } finally {
    clean(scope);
  }
});

test("private writer refuses a missing live global admission", () => {
  const fakeSession = session({ currentMarketId: "0x" + "1".repeat(64), leaseId: "lease-1" });
  assert.throws(() => createAccountBoundPrivateWriter({
    session: fakeSession,
    lease: { held: true, state: "HELD", leaseId: "lease-1", sessionId: fakeSession.sessionId, owner: OWNER, account: ACCOUNT, operator: OPERATOR, expiresAt: Date.now() + 10000 },
    policy: { validate: () => ({ allowed: true }) },
    signer: { address: OPERATOR },
    publicClient: { simulateContract: async () => ({ request: {} }) },
    walletClient: { writeContract: async () => "0x" + "a".repeat(64) },
    executionEnabled: true,
    readLatestNonce: async () => 0,
    readPendingNonce: async () => 0,
    requireGlobalAdmission: true,
    executionAdmission: { store: { get: () => null }, admissionId: "missing" },
  }), (error) => error.code === "GLOBAL_ADMISSION_REQUIRED");
});


test("private writer rechecks admission before broadcast", async () => {
  const scope = tempScope();
  let walletCalls = 0;
  try {
    const exact = session({ currentMarketId: "0x" + "1".repeat(64), leaseId: "lease-1" });
    const lease = { held: true, state: "HELD", leaseId: "lease-1", sessionId: exact.sessionId, owner: OWNER, account: ACCOUNT, operator: OPERATOR, expiresAt: Date.now() + 10000 };
    const admissionStore = createFileGlobalExecutionAdmission({ filePath: scope.admissionPath });
    const claim = admissionStore.claim({ session: exact, role: "strategy" });
    const provenance = createExecutionProvenance({ session: exact, executionAdmission: { id: claim.admissionId, path: scope.admissionPath }, lease, journalPath: scope.journalPath });
    persistExecutionProvenance({ provenancePath: scope.provenancePath, provenance });
    initializeDurableJournal({ journalPath: scope.journalPath, provenancePath: scope.provenancePath, session: exact });
    const writer = createAccountBoundPrivateWriter({
      session: exact,
      lease,
      policy: { validate: () => ({ allowed: true }) },
      signer: { address: OPERATOR },
      publicClient: {
        simulateContract: async () => {
          admissionStore.release({ admissionId: claim.admissionId, session: exact });
          return { request: {} };
        },
      },
      walletClient: { writeContract: async () => { walletCalls += 1; return "0x" + "a".repeat(64); } },
      executionEnabled: true,
      readLatestNonce: async () => 0,
      readPendingNonce: async () => 0,
      journalPath: scope.journalPath,
      provenancePath: scope.provenancePath,
      requireProvenance: true,
      executionAdmission: { store: admissionStore, admissionId: claim.admissionId, session: exact },
      requireGlobalAdmission: true,
    });
    await assert.rejects(writer.enqueue({ functionName: "operatorCancelOrder", args: [], intent: { sessionId: exact.sessionId, account: exact.account, owner: exact.owner, operator: exact.operator, marketId: exact.currentMarketId, action: "CANCEL_ORDER", txIndex: 0, orderId: "1" } }), (error) => error.code === "GLOBAL_ADMISSION_LOST");
    assert.equal(walletCalls, 0);
    writer.close();
  } finally {
    clean(scope);
  }
});
