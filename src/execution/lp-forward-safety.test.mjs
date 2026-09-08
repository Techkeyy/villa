import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createExecutionProvenance, initializeDurableJournal, persistExecutionProvenance } from "./lp-execution-provenance.mjs";
import { createFileGlobalExecutionAdmission } from "./lp-global-admission.mjs";
import { createAccountBoundPrivateWriter } from "./lp-private-writer.mjs";
import { classifyFactBasedRecovery, classifyRecoveryRoute, LEGACY_AMBIGUOUS_CLASSIFICATION, SIGNER_FREE_PREMARKET_ROUTE } from "./lp-session-recovery.mjs";

const OWNER = "0x1111111111111111111111111111111111111111";
const ACCOUNT_A = "0x2222222222222222222222222222222222222222";
const ACCOUNT_B = "0x3333333333333333333333333333333333333333";
const OPERATOR = "0x4444444444444444444444444444444444444444";
const SESSION = "uat-1000-aaaaaaaa";
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "villa-forward-safety-")); }
function session(account = ACCOUNT_A, sessionId = SESSION, currentMarketId = null) {
  return { sessionId, account, owner: OWNER, operator: OPERATOR, currentMarketId };
}
function provenanceFor(account = ACCOUNT_A, sessionId = SESSION) {
  return createExecutionProvenance({ session: session(account, sessionId), journalPath: path.join(tempDir(), "transactions.json"), now: () => 1000 });
}
function cleanFacts() {
  return { activeUnit: false, activeLease: false, activeSignerWorker: false, openOrders: 0, outcomeInventory: 0, aggregateExposure: 0, mintExposure: 0, vault: 0, claimableValue: 0, pendingSettlement: false, redeemableValue: 0, unknownTransactions: 0 };
}
function preMarketStored(account = ACCOUNT_A, sessionId = SESSION) {
  return { session: session(account, sessionId), error: { code: "NO_VALID_QUOTE", message: "the live projected SELL_YES plan is not valid" } };
}

test("new session writes provenance and initializes its journal before writer use", () => {
  const directory = tempDir();
  const journalPath = path.join(directory, "transactions.json");
  const provenancePath = path.join(directory, "provenance.json");
  const provenance = createExecutionProvenance({ session: session(), journalPath, now: () => 1000 });
  persistExecutionProvenance({ provenancePath, provenance });
  const journal = initializeDurableJournal({ journalPath, session: session(), provenancePath, now: () => 1000 });
  assert.equal(fs.existsSync(provenancePath), true);
  assert.equal(fs.existsSync(journalPath), true);
  assert.equal(journal.initializedBeforeWrite, true);
  assert.equal(journal.writeAuthorityReached, false);
  assert.equal(JSON.parse(fs.readFileSync(provenancePath, "utf8")).sessionId, SESSION);
  assert.doesNotThrow(() => persistExecutionProvenance({ provenancePath, provenance }));
});

test("legacy pre-market records are explicitly ambiguous, while new records use the signer-free route", () => {
  const stored = preMarketStored();
  assert.equal(classifyRecoveryRoute({ session: session(), stored }), LEGACY_AMBIGUOUS_CLASSIFICATION);
  assert.equal(classifyRecoveryRoute({ session: session(), stored, provenance: provenanceFor() }), SIGNER_FREE_PREMARKET_ROUTE);
});

test("fact-based recovery fails closed for missing evidence and allows only a clean pre-write record", () => {
  const provenance = provenanceFor();
  assert.deepEqual(classifyFactBasedRecovery({ provenance, journal: null, facts: cleanFacts() }).classification, "UNKNOWN");
  const clean = classifyFactBasedRecovery({ provenance, journal: { initializedBeforeWrite: true, writeAuthorityReached: false, records: [] }, facts: cleanFacts() });
  assert.deepEqual(clean, { classification: "CLEAN", safeToRetry: true, reason: "PRE_WRITE" });
  const dirty = classifyFactBasedRecovery({ provenance, journal: { initializedBeforeWrite: true, writeAuthorityReached: true, records: [] }, facts: cleanFacts() });
  assert.equal(dirty.classification, "DIRTY");
  assert.equal(dirty.safeToRetry, false);
});

test("private writer refuses signer-backed construction without immutable provenance", () => {
  assert.throws(() => createAccountBoundPrivateWriter({
    session: { ...session(ACCOUNT_A, SESSION, MARKET), leaseId: "lease-1" },
    lease: { held: true, account: ACCOUNT_A, owner: OWNER, operator: OPERATOR, sessionId: SESSION, leaseId: "lease-1" },
    policy: { validate: () => ({ allowed: true }) },
    signer: { address: OPERATOR },
    publicClient: { simulateContract: async () => ({ request: {} }) },
    walletClient: { writeContract: async () => "0x" + "a".repeat(64) },
    executionEnabled: true,
    readLatestNonce: async () => 0,
    readPendingNonce: async () => 0,
    requireProvenance: true,
  }), { code: "PROVENANCE_REQUIRED" });
});
test("durable admission serializes independent users and survives a second store instance", () => {
  const filePath = path.join(tempDir(), "global-execution-admission.json");
  const storeA = createFileGlobalExecutionAdmission({ filePath, now: () => 1000, durationMs: 1000 });
  const storeB = createFileGlobalExecutionAdmission({ filePath, now: () => 1000, durationMs: 1000 });
  const first = storeA.claim({ session: session(ACCOUNT_A, "uat-1000-aaaaaaaa"), role: "strategy" });
  assert.equal(storeB.get().session.account, ACCOUNT_A);
  assert.throws(() => storeB.claim({ session: session(ACCOUNT_B, "uat-1001-bbbbbbbb"), role: "strategy" }), { code: "GLOBAL_EXECUTION_BUSY" });
  storeA.release({ admissionId: first.admissionId, session: session(ACCOUNT_A, "uat-1000-aaaaaaaa") });
  const second = storeB.claim({ session: session(ACCOUNT_B, "uat-1001-bbbbbbbb"), role: "strategy" });
  assert.equal(second.session.account, ACCOUNT_B);
  storeB.release({ admissionId: second.admissionId, session: session(ACCOUNT_B, "uat-1001-bbbbbbbb") });
});

test("expired admission requires explicit false liveness before scoped reconciliation", () => {
  const filePath = path.join(tempDir(), "global-execution-admission.json");
  let now = 1000;
  const store = createFileGlobalExecutionAdmission({ filePath, now: () => now, durationMs: 10 });
  const first = store.claim({ session: session(ACCOUNT_A), role: "recovery" });
  now = 1011;
  assert.throws(() => store.reconcileStale({ admissionId: first.admissionId, session: first.session, isActive: () => true }), { code: "GLOBAL_ADMISSION_LIVENESS_UNKNOWN" });
  assert.equal(store.reconcileStale({ admissionId: first.admissionId, session: first.session, isActive: () => false }).reason, "STALE_SCOPED_ADMISSION_RECONCILED");
  const next = store.claim({ session: session(ACCOUNT_B, "uat-1001-bbbbbbbb"), role: "settlement" });
  assert.equal(next.role, "settlement");
  store.release({ admissionId: next.admissionId, session: next.session });
});