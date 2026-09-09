import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { classifyScopedOpenOrderCancellation, recoveryActions, validateOrderLifecycleProof } from "./lp-session-recovery.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION = "uat-1000-aaaaaaaa";
const PROVENANCE = { schemaVersion: "villa-lp-execution-provenance-v1", sessionId: SESSION, account: ACCOUNT, owner: OWNER, operator: OPERATOR, marketId: MARKET };

function record(action, hash, extra = {}) {
  return { hash, sessionId: SESSION, account: ACCOUNT, owner: OWNER, operator: OPERATOR, marketId: MARKET, action, state: "CONFIRMED", ...extra };
}

function fixture({ placements = 1, cancelled = [], live = [placements - 1], prices = [], journalPatch = {}, accountPatch = {}, storedPatch = {}, provenance = PROVENANCE, filledPlacements = [], facts = {}, settlementFacts = {}, globalAdmissionState = "FREE" } = {}) {
  const placeRecords = Array.from({ length: placements }, (_, index) => record("PLACE_ORDER", "place-" + index, { amountRaw: "1000", priceRaw: String(prices[index] ?? (568000 + index * 1000)), side: "SELL_YES" }));
  const lifecycleRecords = [record("MINT_COMPLETE_SET", "mint-0", { amountRaw: "1000" })];
  const cancelledSet = new Set(cancelled);
  for (let index = 0; index < placements; index += 1) {
    lifecycleRecords.push(placeRecords[index]);
    if (cancelledSet.has(index)) lifecycleRecords.push(record("CANCEL_ORDER", "cancel-" + index, { amountRaw: String(7 + index) }));
  }
  const currentOrders = live.map((index) => ({ orderId: String(7 + index), owner: ACCOUNT, marketId: MARKET, quantityRemainingRaw: "1000", priceRaw: placeRecords[index].priceRaw, isBid: false }));
  const stored = { session: { sessionId: SESSION, account: ACCOUNT, owner: OWNER, operator: OPERATOR, currentMarketId: MARKET, leaseId: "lease-old" }, snapshot: { openOrders: currentOrders }, ...storedPatch };
  const journal = { initializedBeforeWrite: true, writeAuthorityReached: true, pending: 0, unknown: 0, reverted: 0, records: lifecycleRecords, ...journalPatch };
  const accountState = { identity: { aggregateExposure: 2000n, mintExposure: 2000n }, capital: { directCollateralRaw: 1_000_000n, vaultRaw: 0n }, inventory: { yesRaw: 0n, noRaw: 1000n }, orders: { status: "VERIFIED", orders: currentOrders.map((order) => ({ ...order, orderId: BigInt(order.orderId), quantityRemainingRaw: 1000n, priceRaw: BigInt(order.priceRaw) })) }, ...accountPatch };
  const baseFacts = { activeUnit: false, activeLease: false, activeSignerWorker: false, openOrders: currentOrders.length, outcomeInventory: 1000, aggregateExposure: 2000, mintExposure: 2000, vault: 0, claimableValue: 0, pendingSettlement: "UNKNOWN", redeemableValue: 0, unknownTransactions: 0 };
  return { session: { sessionId: SESSION, account: ACCOUNT, owner: OWNER, operator: OPERATOR, currentMarketId: MARKET }, stored, expiredLease: { leaseId: "lease-old", sessionId: SESSION, account: ACCOUNT, owner: OWNER, operator: OPERATOR, expiresAt: 900 }, journal, accountState, provenance, filledPlacements, settlementFacts: { state: "SETTLEMENT_BLOCKED", reason: "OPEN_ORDER_STATE_UNKNOWN", ...settlementFacts }, facts: { ...baseFacts, ...facts }, globalAdmissionState };
}

function proof(value) {
  return validateOrderLifecycleProof(value);
}

function hasCode(code) {
  return (error) => error?.code === code;
}

test("one confirmed placement with one verified live order is recoverable", () => {
  const value = fixture();
  const result = proof(value);
  assert.deepEqual({ placements: result.placements, cancelled: result.cancelled, filled: result.filled, live: result.live }, { placements: 1, cancelled: 0, filled: 0, live: ["7"] });
});

test("multiple placements with all but the current live order cancelled are recoverable", () => {
  const value = fixture({ placements: 3, cancelled: [0, 1], live: [2] });
  const result = classifyScopedOpenOrderCancellation(value);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.lifecycle, { placements: 3, cancelled: 2, filled: 0, live: ["9"], cancelledOrderIds: ["7", "8"], provenance: result.provenance });
  assert.deepEqual(result.actions.cancelOrderIds, [9n]);
});

test("the target six-placement five-cancellation one-live shape is proven", () => {
  const value = fixture({ placements: 6, cancelled: [0, 1, 2, 3, 4], live: [5], prices: [545000, 547000, 547000, 559000, 539000, 511000] });
  const result = proof(value);
  assert.equal(result.placements, 6);
  assert.equal(result.cancelled, 5);
  assert.equal(result.filled, 0);
  assert.deepEqual(result.live, ["12"]);
});

test("all confirmed placements cancelled is clean with no live order", () => {
  const value = fixture({ placements: 3, cancelled: [0, 1, 2], live: [] });
  const result = proof(value);
  assert.equal(result.placements, 3);
  assert.equal(result.cancelled, 3);
  assert.deepEqual(result.live, []);
  assert.equal(result.filled, 0);
});

test("a placement with no cancelled, filled, or live outcome fails closed", () => {
  assert.throws(() => proof(fixture({ live: [] })), hasCode("ORDER_LIFECYCLE_UNKNOWN"));
});

test("an accounted confirmed fill is a valid placement outcome", () => {
  const value = fixture({ live: [], filledPlacements: [{ placementHash: "place-0", state: "CONFIRMED", accounted: true, amountRaw: "1000" }] });
  const result = proof(value);
  assert.equal(result.filled, 1);
  assert.deepEqual(result.live, []);
});

test("a journal placement without a hash fails closed", () => {
  const value = fixture();
  delete value.journal.records[1].hash;
  assert.throws(() => proof(value), hasCode("RECOVERY_PROVENANCE_MISMATCH"));
});

test("duplicate journal records are deduplicated and do not double-count", () => {
  const value = fixture();
  value.journal.records.push({ ...value.journal.records[1] });
  const result = proof(value);
  assert.equal(result.placements, 1);
});

test("conflicting duplicate journal records fail closed", () => {
  const value = fixture();
  value.journal.records.push({ ...value.journal.records[1], priceRaw: "569000" });
  assert.throws(() => proof(value), hasCode("RECOVERY_PROVENANCE_MISMATCH"));
});

test("uncertain transaction truth blocks staged recovery", () => {
  const value = fixture({ journalPatch: { unknown: 1 } });
  const result = classifyScopedOpenOrderCancellation(value);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "RECOVERY_TRANSACTION_UNKNOWN");
});

test("a mismatched current live order cannot be cancelled", () => {
  const value = fixture();
  value.accountState.orders.orders[0].priceRaw = 569000n;
  const result = classifyScopedOpenOrderCancellation(value);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "RECOVERY_ORDER_SCOPE_MISMATCH");
});

test("staged recovery authorizes only the exact current order cancellation", () => {
  const result = classifyScopedOpenOrderCancellation(fixture({ placements: 2, cancelled: [0], live: [1] }));
  assert.equal(result.allowed, true);
  assert.deepEqual(result.actions, { cancelOrderIds: [8n], burnAmountRaw: 0n, claimVaultRaw: 0n });
});

test("post-cancel facts are re-read before burn or claim and binding is released last", () => {
  const source = fs.readFileSync(path.resolve("scripts/lp-account-recovery.mjs"), "utf8");
  const cancelCheck = source.indexOf("RECOVERY_CANCEL_INCOMPLETE");
  const rereadFacts = source.indexOf("const postCancelFacts", cancelCheck);
  const burn = source.indexOf("actions.burnAmountRaw", rereadFacts);
  const release = source.indexOf("leaseStore.release(session, { reconciled: true })", burn);
  assert.ok(cancelCheck >= 0 && rereadFacts > cancelCheck && burn > rereadFacts && release > burn);
  assert.match(source, /postCancelRecovery\.classification === "UNKNOWN"/);
  assert.match(source, /scopedCancellation\.allowed\n\s+\? scopedCancellation\.provenance/);
});

test("wrong owner, account, or session scope is rejected", () => {
  const wrongAccount = fixture({ provenance: { ...PROVENANCE, account: "0x9999999999999999999999999999999999999999" } });
  const wrongOwner = fixture({ provenance: { ...PROVENANCE, owner: "0x9999999999999999999999999999999999999999" } });
  const wrongSession = fixture();
  wrongSession.session = { ...wrongSession.session, sessionId: "uat-other-session" };
  assert.throws(() => proof(wrongAccount), hasCode("RECOVERY_SCOPE_MISMATCH"));
  assert.throws(() => proof(wrongOwner), hasCode("RECOVERY_SCOPE_MISMATCH"));
  assert.throws(() => proof(wrongSession), hasCode("RECOVERY_SCOPE_MISMATCH"));
});

test("active lease or another admission holder blocks staged cancellation", () => {
  const leaseResult = classifyScopedOpenOrderCancellation(fixture({ facts: { activeLease: true } }));
  const admissionResult = classifyScopedOpenOrderCancellation(fixture({ globalAdmissionState: "OTHER" }));
  assert.equal(leaseResult.reason, "ACTIVE_LEASE");
  assert.equal(admissionResult.reason, "GLOBAL_ADMISSION_NOT_SCOPED");
});

test("paired inventory is only burned after the staged order is gone", () => {
  const result = classifyScopedOpenOrderCancellation(fixture());
  const afterCancel = { ...fixture().accountState, inventory: { yesRaw: 1000n, noRaw: 1000n }, orders: { status: "VERIFIED", orders: [] } };
  const actions = recoveryActions({ session: fixture().session, provenance: result.provenance, accountState: afterCancel });
  assert.equal(actions.burnAmountRaw, 1000n);
});


test("the exact original lease remains valid for lifecycle proof", () => {
  assert.equal(proof(fixture()).live[0], "7");
});

test("an exact one-hop rotated lease with authoritative predecessor is valid", () => {
  const value = fixture();
  value.expiredLease = { ...value.expiredLease, leaseId: "lease-new", recoveredExpiredLease: true, recoveredLeaseId: "lease-old" };
  assert.equal(proof(value).live[0], "7");
});

test("multiple exact lease replacements must form one scoped lineage", () => {
  const value = fixture();
  value.expiredLease = {
    ...value.expiredLease,
    leaseId: "lease-new-2",
    recoveredExpiredLease: true,
    recoveredLeaseId: "lease-new-1",
    leaseLineage: [
      { previousLeaseId: "lease-old", replacementLeaseId: "lease-new-1", account: ACCOUNT, owner: OWNER, operator: OPERATOR, sessionId: SESSION, reason: "EXPIRED_LEASE_RECOVERY", timestamp: 1000 },
      { previousLeaseId: "lease-new-1", replacementLeaseId: "lease-new-2", account: ACCOUNT, owner: OWNER, operator: OPERATOR, sessionId: SESSION, reason: "EXPIRED_LEASE_RECOVERY", timestamp: 1100 },
    ],
  };
  assert.equal(proof(value).live[0], "7");
});

test("an unrelated replacement lease is rejected", () => {
  const value = fixture();
  value.expiredLease = { ...value.expiredLease, leaseId: "lease-new", recoveredExpiredLease: true, recoveredLeaseId: "lease-other" };
  assert.throws(() => proof(value), hasCode("RECOVERY_SCOPE_MISMATCH"));
});

test("replacement lineage with the wrong session or owner is rejected", () => {
  for (const patch of [{ sessionId: "uat-other-session" }, { owner: "0x9999999999999999999999999999999999999999" }]) {
    const value = fixture();
    value.expiredLease = {
      ...value.expiredLease,
      leaseId: "lease-new",
      recoveredExpiredLease: true,
      recoveredLeaseId: "lease-old",
      leaseLineage: [{ previousLeaseId: "lease-old", replacementLeaseId: "lease-new", account: ACCOUNT, owner: patch.owner ?? OWNER, operator: OPERATOR, sessionId: patch.sessionId ?? SESSION, reason: "EXPIRED_LEASE_RECOVERY", timestamp: 1000 }],
    };
    assert.throws(() => proof(value), hasCode("RECOVERY_SCOPE_MISMATCH"));
  }
});

test("missing or malformed replacement lineage is rejected", () => {
  const missing = fixture();
  missing.expiredLease = { ...missing.expiredLease, leaseId: "lease-new", recoveredExpiredLease: true };
  assert.throws(() => proof(missing), hasCode("RECOVERY_SCOPE_MISMATCH"));
  const malformed = fixture();
  malformed.expiredLease = { ...malformed.expiredLease, leaseId: "lease-new", recoveredExpiredLease: true, recoveredLeaseId: "lease-old", leaseLineage: {} };
  assert.throws(() => proof(malformed), hasCode("RECOVERY_SCOPE_MISMATCH"));
});

test("lease rotation authorizes only cleanup of the uniquely verified live order", () => {
  const value = fixture();
  value.expiredLease = { ...value.expiredLease, leaseId: "lease-new", recoveredExpiredLease: true, recoveredLeaseId: "lease-old" };
  const result = classifyScopedOpenOrderCancellation(value);
  assert.deepEqual(result.actions, { cancelOrderIds: [7n], burnAmountRaw: 0n, claimVaultRaw: 0n });
});
