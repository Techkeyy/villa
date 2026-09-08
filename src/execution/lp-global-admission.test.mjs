import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFileGlobalExecutionAdmission } from "./lp-global-admission.mjs";

const OPERATOR = "0xaf4ee6c0c6ff6337f4c4f07b87c8343df73e8d37";
const OWNER = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";

function session(overrides = {}) {
  return { sessionId: "uat-9999999999999-aabbccdd", owner: OWNER, account: ACCOUNT, operator: OPERATOR, ...overrides };
}

function tempScope() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "villa-global-admission-"));
  return { directory, filePath: path.join(directory, "global-admission.json") };
}

function cleanup(value) {
  fs.rmSync(value.directory, { recursive: true, force: true });
}

test("reader distinguishes valid active, valid expired, and absent admission records", () => {
  const value = tempScope();
  try {
    let now = 1_000;
    const store = createFileGlobalExecutionAdmission({ filePath: value.filePath, now: () => now, durationMs: 30 });
    assert.equal(store.inspect().status, "ABSENT");
    const claim = store.claim({ session: session(), pid: 1234 });
    assert.equal(store.inspect().status, "VALID_ACTIVE");
    now = 1_030;
    assert.equal(store.inspect().status, "VALID_EXPIRED");
    assert.equal(store.get().admissionId, claim.admissionId);
    store.reconcileStale({ admissionId: claim.admissionId, session: session(), isActive: () => false });
    assert.equal(store.inspect().status, "ABSENT");
  } finally {
    cleanup(value);
  }
});

test("empty, truncated, and malformed-schema records are CORRUPT and fail closed", () => {
  const cases = [
    { name: "empty", content: "" },
    { name: "truncated", content: '{"version":"villa-lp-global-admission-v1"' },
    { name: "schema", content: JSON.stringify({ version: "old-schema", admissionId: "admission-old", session: session() }) },
  ];
  for (const item of cases) {
    const value = tempScope();
    try {
      fs.writeFileSync(value.filePath, item.content, { mode: 0o600 });
      const store = createFileGlobalExecutionAdmission({ filePath: value.filePath, now: () => 1_000 });
      assert.equal(store.inspect().status, "CORRUPT", item.name);
      assert.throws(() => store.get(), { code: "GLOBAL_ADMISSION_CORRUPT" }, item.name);
    } finally {
      cleanup(value);
    }
  }
});

test("interrupted same-directory temp write does not become a visible admission", () => {
  const value = tempScope();
  try {
    fs.mkdirSync(value.directory, { recursive: true });
    fs.writeFileSync(`${value.filePath}.tmp-interrupted`, '{"version":"villa-lp-global-admission-v1"', { mode: 0o600 });
    const store = createFileGlobalExecutionAdmission({ filePath: value.filePath, now: () => 1_000 });
    assert.equal(store.inspect().status, "ABSENT");
    store.claim({ session: session(), pid: 1234 });
    assert.equal(store.inspect().status, "VALID_ACTIVE");
  } finally {
    cleanup(value);
  }
});

function corruptScopedRecord(filePath) {
  fs.writeFileSync(filePath, JSON.stringify({
    version: "unsupported-version",
    admissionId: "admission-corrupt-scoped",
    session: session(),
  }), { mode: 0o600 });
}

test("dead zero-write owner of a corrupt record can be reclaimed only with exact scope", () => {
  const value = tempScope();
  try {
    corruptScopedRecord(value.filePath);
    const store = createFileGlobalExecutionAdmission({ filePath: value.filePath, now: () => 1_000 });
    const result = store.reconcileCorrupt({
      admissionId: "admission-corrupt-scoped",
      session: session(),
      isActive: () => false,
      isZeroWrite: () => true,
    });
    assert.equal(result.reason, "CORRUPT_SCOPED_ADMISSION_RECONCILED");
    assert.equal(store.inspect().status, "ABSENT");
  } finally {
    cleanup(value);
  }
});

test("corrupt admission with uncertain or live execution remains blocked", () => {
  for (const evidence of [
    { isActive: () => true, isZeroWrite: () => true, code: "GLOBAL_ADMISSION_LIVENESS_UNKNOWN" },
    { isActive: () => null, isZeroWrite: () => true, code: "GLOBAL_ADMISSION_LIVENESS_UNKNOWN" },
    { isActive: () => false, isZeroWrite: () => false, code: "GLOBAL_ADMISSION_ZERO_WRITE_UNKNOWN" },
  ]) {
    const value = tempScope();
    try {
      corruptScopedRecord(value.filePath);
      const store = createFileGlobalExecutionAdmission({ filePath: value.filePath, now: () => 1_000 });
      assert.throws(() => store.reconcileCorrupt({
        admissionId: "admission-corrupt-scoped",
        session: session(),
        isActive: evidence.isActive,
        isZeroWrite: evidence.isZeroWrite,
      }), { code: evidence.code });
      assert.equal(store.inspect().status, "CORRUPT");
    } finally {
      cleanup(value);
    }
  }
});

test("corrupt record with the wrong owner or account cannot be reclaimed", () => {
  const value = tempScope();
  try {
    corruptScopedRecord(value.filePath);
    const store = createFileGlobalExecutionAdmission({ filePath: value.filePath, now: () => 1_000 });
    assert.throws(() => store.reconcileCorrupt({
      admissionId: "admission-corrupt-scoped",
      session: session({ account: "0x3333333333333333333333333333333333333333" }),
      isActive: () => false,
      isZeroWrite: () => true,
    }), { code: "GLOBAL_ADMISSION_SCOPE_MISMATCH" });
    assert.equal(store.inspect().status, "CORRUPT");
  } finally {
    cleanup(value);
  }
});

