import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTerminalBindingClear } from "./uat-terminal-binding.mjs";

const SESSION = "uat-1788913524343-bdda400e";
const OWNER = "0xac98f6a5dd641ab4bea67b17e62ca4c31be4f5a7";
const ACCOUNT = "0xa06be370f8bdb3dec90ca8858ec52e47586e1d5a";
const base = () => ({ sessionId: SESSION, owner: OWNER, account: ACCOUNT, status: { state: "STOPPED_CLEAN", session: { sessionId: SESSION, owner: OWNER, account: ACCOUNT }, snapshot: { pendingSettlement: null }, result: { pendingSettlement: false } }, unitsInactive: true, leaseAbsent: true, admission: null, accountState: { identity: { aggregateExposure: 0n, mintExposure: 0n }, capital: { vaultRaw: 0n }, inventory: { yesRaw: 0n, noRaw: 0n }, orders: { status: "VERIFIED", orders: [] } } });

test("clean terminal account session can clear only its exact binding", () => {
  assert.deepEqual(evaluateTerminalBindingClear(base()), { eligible: true, code: "TERMINAL_CLEAN" });
});

test("active settlement, lease, admission, value, and scope remain blocked", () => {
  assert.equal(evaluateTerminalBindingClear({ ...base(), status: { ...base().status, state: "SETTLING" } }).eligible, false);
  assert.equal(evaluateTerminalBindingClear({ ...base(), leaseAbsent: false }).code, "LEASE_ACTIVE_OR_UNKNOWN");
  assert.equal(evaluateTerminalBindingClear({ ...base(), admission: { admissionId: "other" } }).code, "GLOBAL_ADMISSION_NOT_FREE");
  assert.equal(evaluateTerminalBindingClear({ ...base(), accountState: { ...base().accountState, inventory: { yesRaw: 1n, noRaw: 0n } } }).code, "INVENTORY_PRESENT_OR_UNKNOWN");
  assert.equal(evaluateTerminalBindingClear({ ...base(), accountState: { ...base().accountState, identity: { aggregateExposure: 1n, mintExposure: 0n } } }).code, "EXPOSURE_PRESENT_OR_UNKNOWN");
  assert.equal(evaluateTerminalBindingClear({ ...base(), sessionId: "uat-1788913524343-deadbeef" }).code, "BINDING_SCOPE_MISMATCH");
});
