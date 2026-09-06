import assert from "node:assert/strict";
import test from "node:test";
import { recoveryActions, validateExpiredSessionRecovery, validatePreflightFailureRecovery } from "./lp-session-recovery.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION = "uat-1000-aaaaaaaa";
const LEASE = "lease-old";

function fixtures() {
  const session = { sessionId: SESSION, account: ACCOUNT, owner: OWNER, operator: OPERATOR, currentMarketId: MARKET };
  const stored = { session: { ...session, leaseId: LEASE }, snapshot: { openOrders: [{ orderId: "7", owner: ACCOUNT, quantityRemainingRaw: "1000", priceRaw: "568000" }] } };
  const expiredLease = { leaseId: LEASE, sessionId: SESSION, account: ACCOUNT, owner: OWNER, operator: OPERATOR, expiresAt: 900 };
  const journal = { pending: 0, unknown: 0, reverted: 0, records: [
    { sessionId: SESSION, account: ACCOUNT, marketId: MARKET, action: "MINT_COMPLETE_SET", state: "CONFIRMED", amountRaw: "1000" },
    { sessionId: SESSION, account: ACCOUNT, marketId: MARKET, action: "PLACE_ORDER", state: "CONFIRMED", amountRaw: "1000", priceRaw: "568000", side: "SELL_YES" },
  ] };
  const accountState = { capital: { directCollateralRaw: 1_000_000n, vaultRaw: 0n }, inventory: { yesRaw: 0n, noRaw: 1000n }, orders: { status: "VERIFIED", orders: [{ orderId: 7n, owner: ACCOUNT, marketId: MARKET, quantityRemainingRaw: 1000n, priceRaw: 568000n }] } };
  return { session, stored, expiredLease, journal, accountState };
}

test("10. authenticated expired-session recovery derives only the proven cancellation", () => {
  const value = fixtures();
  const provenance = validateExpiredSessionRecovery(value);
  const actions = recoveryActions({ session: value.session, provenance, accountState: value.accountState });
  assert.deepEqual(actions.cancelOrderIds, [7n]);
  assert.equal(actions.burnAmountRaw, 0n);
});
test("legacy expired-session recovery accepts an absent stored lease id but rejects a conflicting one", () => {
  const value = fixtures();
  const legacyStored = { ...value.stored, session: { ...value.stored.session, leaseId: null } };
  assert.doesNotThrow(() => validateExpiredSessionRecovery({ ...value, stored: legacyStored }));
  const conflictingStored = { ...value.stored, session: { ...value.stored.session, leaseId: "lease-other" } };
  assert.throws(() => validateExpiredSessionRecovery({ ...value, stored: conflictingStored }), { code: "RECOVERY_SCOPE_MISMATCH" });
});


test("one-sided fills preserve the residual position and burn only a free pair", () => {
  const value = fixtures();
  const provenance = validateExpiredSessionRecovery(value);
  const afterCancel = { ...value.accountState, inventory: { yesRaw: 400n, noRaw: 1000n }, orders: { status: "VERIFIED", orders: [] } };
  const actions = recoveryActions({ session: value.session, provenance, accountState: afterCancel });
  assert.equal(actions.burnAmountRaw, 400n);
  assert.equal(afterCancel.inventory.noRaw - actions.burnAmountRaw, 600n);
});

test("vault credit is claimed only after orders and paired inventory are cleared", () => {
  const value = fixtures();
  const provenance = validateExpiredSessionRecovery(value);
  const cleared = { ...value.accountState, capital: { directCollateralRaw: 1_000_000n, vaultRaw: 568n }, inventory: { yesRaw: 0n, noRaw: 600n }, orders: { status: "VERIFIED", orders: [] } };
  const actions = recoveryActions({ session: value.session, provenance, accountState: cleared });
  assert.equal(actions.burnAmountRaw, 0n);
  assert.equal(actions.claimVaultRaw, 568n);
});

test("unproven orders and cross-owner recovery are rejected", () => {
  const value = fixtures();
  assert.throws(() => validateExpiredSessionRecovery({ ...value, stored: { ...value.stored, session: { ...value.stored.session, owner: "0x4444444444444444444444444444444444444444" } } }), { code: "RECOVERY_SCOPE_MISMATCH" });
  const provenance = validateExpiredSessionRecovery(value);
  const foreignOrder = { ...value.accountState, orders: { status: "VERIFIED", orders: [{ ...value.accountState.orders.orders[0], orderId: 8n }] } };
  assert.throws(() => recoveryActions({ session: value.session, provenance, accountState: foreignOrder }), { code: "RECOVERY_ORDER_SCOPE_MISMATCH" });
});

test("preflight-only capital failure reconciles with no lease, no journal writes, and empty account state", () => {
  const session = { sessionId: "uat-1788674963992-5d565c2d", account: ACCOUNT, owner: OWNER, operator: OPERATOR, currentMarketId: MARKET };
  const result = validatePreflightFailureRecovery({
    session,
    stored: { session: { ...session, leaseId: null }, error: { code: "ACCOUNT_CAPITAL_CAP" } },
    expiredLease: null,
    journal: { pending: 0, unknown: 0, reverted: 0, records: [] },
    accountState: { capital: { directCollateralRaw: 2_001_000n, vaultRaw: 0n }, inventory: { yesRaw: 0n, noRaw: 0n }, orders: { status: "VERIFIED", orders: [] } },
  });
  assert.equal(result.capitalRaw, 2_001_000n);
  assert.equal(result.nextTxIndex, 0);
});

test("preflight-only recovery fails closed on a lease, chain activity, inventory, or vault credit", () => {
  const session = { sessionId: SESSION, account: ACCOUNT, owner: OWNER, operator: OPERATOR, currentMarketId: MARKET };
  const args = { session, stored: { session: { ...session, leaseId: null }, error: { code: "ACCOUNT_CAPITAL_CAP" } }, journal: { pending: 0, unknown: 0, reverted: 0, records: [] }, accountState: { capital: { directCollateralRaw: 2_001_000n, vaultRaw: 0n }, inventory: { yesRaw: 0n, noRaw: 0n }, orders: { status: "VERIFIED", orders: [] } } };
  assert.throws(() => validatePreflightFailureRecovery({ ...args, expiredLease: { leaseId: "unexpected" } }), { code: "RECOVERY_LEASE_UNEXPECTED" });
  assert.throws(() => validatePreflightFailureRecovery({ ...args, journal: { ...args.journal, records: [{ action: "PLACE_ORDER" }] } }), { code: "RECOVERY_CHAIN_ACTIVITY_PRESENT" });
  assert.throws(() => validatePreflightFailureRecovery({ ...args, accountState: { ...args.accountState, inventory: { yesRaw: 1n, noRaw: 0n } } }), { code: "RECOVERY_INVENTORY_PRESENT" });
  assert.throws(() => validatePreflightFailureRecovery({ ...args, accountState: { ...args.accountState, capital: { directCollateralRaw: 2_001_000n, vaultRaw: 1n } } }), { code: "RECOVERY_SETTLEMENT_PRESENT" });
});
