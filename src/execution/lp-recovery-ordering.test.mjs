import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { classifyScopedOpenOrderCancellation, recoveryActions } from "./lp-session-recovery.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION = "uat-1000-aaaaaaaa";

function fixture(overrides = {}) {
  const session = { sessionId: SESSION, account: ACCOUNT, owner: OWNER, operator: OPERATOR, currentMarketId: MARKET };
  const order = { orderId: "7", owner: ACCOUNT, marketId: MARKET, quantityRemainingRaw: "1000", priceRaw: "568000" };
  const stored = { session: { ...session, leaseId: "lease-old" }, snapshot: { openOrders: [order] } };
  const expiredLease = { leaseId: "lease-old", sessionId: SESSION, account: ACCOUNT, owner: OWNER, operator: OPERATOR, expiresAt: 900 };
  const journal = { initializedBeforeWrite: true, writeAuthorityReached: true, pending: 0, unknown: 0, reverted: 0, records: [
    { sessionId: SESSION, account: ACCOUNT, marketId: MARKET, action: "MINT_COMPLETE_SET", state: "CONFIRMED", amountRaw: "1000" },
    { sessionId: SESSION, account: ACCOUNT, marketId: MARKET, action: "PLACE_ORDER", state: "CONFIRMED", amountRaw: "1000", priceRaw: "568000", side: "SELL_YES" },
  ] };
  const accountState = { identity: { aggregateExposure: 2000n, mintExposure: 2000n }, capital: { directCollateralRaw: 1_000_000n, vaultRaw: 0n }, inventory: { yesRaw: 0n, noRaw: 1000n }, orders: { status: "VERIFIED", orders: [{ ...order, orderId: 7n, quantityRemainingRaw: 1000n, priceRaw: 568000n, isBid: false }] } };
  const settlementFacts = { state: "SETTLEMENT_BLOCKED", reason: "OPEN_ORDER_STATE_UNKNOWN" };
  const facts = { activeUnit: false, activeLease: false, activeSignerWorker: false, openOrders: 1, outcomeInventory: 1000, aggregateExposure: 2000, mintExposure: 2000, vault: 0, claimableValue: 0, pendingSettlement: "UNKNOWN", redeemableValue: 0, unknownTransactions: 0 };
  return {
    session: { ...session, ...overrides.session },
    stored: overrides.stored ?? stored,
    expiredLease: overrides.expiredLease ?? expiredLease,
    journal: overrides.journal ?? journal,
    accountState: overrides.accountState ?? accountState,
    settlementFacts: overrides.settlementFacts ?? settlementFacts,
    facts: { ...facts, ...(overrides.facts ?? {}) },
    globalAdmissionState: overrides.globalAdmissionState ?? "FREE",
  };
}

test("verified open order allows only the scoped risk-reducing cancellation", () => {
  const value = fixture();
  const result = classifyScopedOpenOrderCancellation(value);
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "SETTLEMENT_BLOCKED_BY_OPEN_ORDER");
});

test("the staged exception returns no mint, place, reprice, burn, or claim action", () => {
  const result = classifyScopedOpenOrderCancellation(fixture());
  assert.deepEqual(result.actions, { cancelOrderIds: [7n], burnAmountRaw: 0n, claimVaultRaw: 0n });
});

test("ambiguous order identity fails closed", () => {
  const value = fixture({ accountState: { ...fixture().accountState, orders: { status: "VERIFIED", orders: [{ ...fixture().accountState.orders.orders[0], priceRaw: 569000n }] } } });
  const result = classifyScopedOpenOrderCancellation(value);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "RECOVERY_ORDER_SCOPE_MISMATCH");
});

test("order that disappeared is re-read and not cancelled again", () => {
  const value = fixture({ accountState: { ...fixture().accountState, orders: { status: "VERIFIED", orders: [] } } });
  const result = classifyScopedOpenOrderCancellation(value);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "ORDER_STATE_UNVERIFIED");
});

test("active worker blocks staged cancellation", () => {
  const result = classifyScopedOpenOrderCancellation(fixture({ facts: { activeUnit: true } }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "ACTIVE_UNIT");
});

test("active lease blocks staged cancellation", () => {
  const result = classifyScopedOpenOrderCancellation(fixture({ facts: { activeLease: true } }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "ACTIVE_LEASE");
});

test("admission held by another execution blocks staged cancellation", () => {
  const result = classifyScopedOpenOrderCancellation(fixture({ globalAdmissionState: "OTHER" }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "GLOBAL_ADMISSION_NOT_SCOPED");
});

test("unknown settlement for a reason other than open-order blockage fails closed", () => {
  const result = classifyScopedOpenOrderCancellation(fixture({ settlementFacts: { state: "SETTLEMENT_BLOCKED", reason: "UNKNOWN_TRANSACTION" } }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "SETTLEMENT_UNKNOWN_FOR_OTHER_REASON");
});

test("another missing authority remains fail closed even with a verified order", () => {
  const result = classifyScopedOpenOrderCancellation(fixture({ facts: { vault: "UNKNOWN" } }));
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "AUTHORITATIVE_FACT_MISSING");
});

test("the scoped exception cannot authorize a risk-adding transaction", () => {
  const result = classifyScopedOpenOrderCancellation(fixture());
  assert.deepEqual(Object.keys(result.actions).sort(), ["burnAmountRaw", "cancelOrderIds", "claimVaultRaw"]);
  assert.equal(result.actions.cancelOrderIds.length, 1);
  assert.equal(result.actions.burnAmountRaw, 0n);
  assert.equal(result.actions.claimVaultRaw, 0n);
});

test("paired inventory after confirmed cancellation is eligible for bounded burn", () => {
  const result = classifyScopedOpenOrderCancellation(fixture());
  const afterCancel = { ...fixture().accountState, inventory: { yesRaw: 1000n, noRaw: 1000n }, orders: { status: "VERIFIED", orders: [] } };
  const actions = recoveryActions({ session: fixture().session, provenance: result.provenance, accountState: afterCancel });
  assert.equal(actions.burnAmountRaw, 1000n);
});

test("one-sided post-cancel inventory is not blindly burned", () => {
  const result = classifyScopedOpenOrderCancellation(fixture());
  const afterCancel = { ...fixture().accountState, inventory: { yesRaw: 0n, noRaw: 1000n }, orders: { status: "VERIFIED", orders: [] } };
  const actions = recoveryActions({ session: fixture().session, provenance: result.provenance, accountState: afterCancel });
  assert.equal(actions.burnAmountRaw, 0n);
  assert.equal(actions.claimVaultRaw, 0n);
});

test("recovery re-reads journal, settlement, exposure, and facts before burn or claim", () => {
  const source = fs.readFileSync(path.resolve("scripts/lp-account-recovery.mjs"), "utf8");
  const cancelCheck = source.indexOf("RECOVERY_CANCEL_INCOMPLETE");
  const rereadFacts = source.indexOf("const postCancelFacts", cancelCheck);
  const burn = source.indexOf("actions.burnAmountRaw", rereadFacts);
  const release = source.indexOf("leaseStore.release(session, { reconciled: true })", burn);
  assert.ok(cancelCheck >= 0 && rereadFacts > cancelCheck && burn > rereadFacts && release > burn);
  assert.match(source, /postCancelRecovery\.classification === "UNKNOWN"/);
});