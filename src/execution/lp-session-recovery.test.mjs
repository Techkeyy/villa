import assert from "node:assert/strict";
import test from "node:test";
import { classifyRecoveryRoute, recoveryActions, SIGNER_FREE_PREMARKET_ROUTE, validateExpiredSessionRecovery, validatePreflightFailureRecovery, validateSignerFreePreMarketEvidence } from "./lp-session-recovery.mjs";

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

function preMarketFixtures() {
  const session = { sessionId: "uat-1788674963992-5d565c2d", account: ACCOUNT, owner: OWNER, operator: OPERATOR, currentMarketId: null };
  const stored = { session: { ...session, leaseId: null }, error: { code: "ACCOUNT_CAPITAL_CAP", message: "account capital exceeds the bounded cap" }, snapshot: null };
  const accountState = {
    capital: { directCollateralRaw: 2_001_000n, vaultRaw: null },
    identity: { aggregateExposure: 0n, mintExposure: 0n },
    inventory: null,
    positions: null,
    orders: { status: "NOT_SELECTED", orders: [] },
  };
  return { session, stored, expiredLease: null, journal: { pending: 0, unknown: 0, reverted: 0, records: [] }, accountState, activeUnit: false };
}

function preMarketStatus(value, patch = {}) {
  return {
    state: "ERROR",
    session: { ...value.session },
    error: { code: "ACCOUNT_CAPITAL_CAP" },
    result: null,
    snapshot: null,
    ...patch,
  };
}

function productionPreMarketFixtures() {
  const value = preMarketFixtures();
  const session = { ...value.session };
  const storedSession = { ...value.stored.session };
  delete session.currentMarketId;
  delete storedSession.currentMarketId;
  return {
    ...value,
    session,
    stored: { ...value.stored, session: storedSession },
    status: { state: "ERROR", session, error: { code: "ACCOUNT_CAPITAL_CAP" }, result: null, snapshot: null },
  };
}

function noQuotePreMarketFixtures() {
  const value = productionPreMarketFixtures();
  return {
    ...value,
    stored: { ...value.stored, error: { code: "NO_VALID_QUOTE", message: "the live projected SELL_YES plan is not valid" } },
    status: { ...value.status, error: { code: "NO_VALID_QUOTE", message: "the live projected SELL_YES plan is not valid" } },
  };
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

test("narrow pre-market capital failure reconciles without a market", () => {
  const result = validatePreflightFailureRecovery(preMarketFixtures());
  assert.equal(result.classification, "NARROW_PREMARKET_RECOVERY");
  assert.equal(result.capitalRaw, 2_001_000n);
});

test("signer-free routing requires the explicit allowlisted pre-market failure", () => {
  const value = preMarketFixtures();
  assert.equal(classifyRecoveryRoute(value), SIGNER_FREE_PREMARKET_ROUTE);
  assert.throws(() => classifyRecoveryRoute({ ...value, stored: { ...value.stored, error: { code: "OTHER_FAILURE" } } }), { code: "RECOVERY_NOT_PREFLIGHT_ONLY" });
  assert.equal(classifyRecoveryRoute({ ...value, session: { ...value.session, currentMarketId: MARKET }, stored: { ...value.stored, session: { ...value.stored.session, currentMarketId: MARKET } } }), "SIGNER_CAPABLE_MARKET");
});

test("production-shaped missing currentMarketId routes to signer-free reconciliation", () => {
  const value = productionPreMarketFixtures();
  assert.equal(classifyRecoveryRoute(value), SIGNER_FREE_PREMARKET_ROUTE);
  const result = validateSignerFreePreMarketEvidence(value);
  assert.equal(result.classification, "NARROW_PREMARKET_RECOVERY");
});

test("production-shaped NO_VALID_QUOTE uses signer-free reconciliation when the pre-market state is clean", () => {
  const value = noQuotePreMarketFixtures();
  assert.equal(classifyRecoveryRoute(value), SIGNER_FREE_PREMARKET_ROUTE);
  const result = validateSignerFreePreMarketEvidence(value);
  assert.equal(result.classification, "NARROW_PREMARKET_RECOVERY");
  assert.equal(result.capitalRaw, 2_001_000n);
});

test("legacy PROJECTED_RISK_HALT PRICE_STALE uses the explicit signer-free pre-market route", () => {
  const value = productionPreMarketFixtures();
  const error = { code: "PROJECTED_RISK_HALT", message: "the live projected risk decision is HALT: PRICE_STALE" };
  const legacy = {
    ...value,
    stored: { ...value.stored, error },
    status: { ...value.status, error },
  };
  assert.equal(classifyRecoveryRoute(legacy), SIGNER_FREE_PREMARKET_ROUTE);
  assert.doesNotThrow(() => validateSignerFreePreMarketEvidence(legacy));
  assert.throws(() => validateSignerFreePreMarketEvidence({
    ...legacy,
    stored: { ...legacy.stored, error: { ...error, message: "the live projected risk decision is HALT: OTHER" } },
  }), { code: "RECOVERY_NOT_PREFLIGHT_ONLY" });
});

test("NO_VALID_QUOTE pre-market reconciliation rejects writes, leases, inventory, orders, settlement, and exposure", () => {
  const value = noQuotePreMarketFixtures();
  assert.throws(() => validateSignerFreePreMarketEvidence({ ...value, stored: { ...value.stored, writes: [{ action: "PLACE_ORDER" }] } }), { code: "RECOVERY_CHAIN_ACTIVITY_PRESENT" });
  assert.throws(() => validateSignerFreePreMarketEvidence({ ...value, journal: { ...value.journal, records: [{ action: "PLACE_ORDER" }] } }), { code: "RECOVERY_CHAIN_ACTIVITY_PRESENT" });
  assert.throws(() => validateSignerFreePreMarketEvidence({ ...value, expiredLease: { leaseId: "active" } }), { code: "RECOVERY_LEASE_UNEXPECTED" });
  assert.throws(() => validateSignerFreePreMarketEvidence({ ...value, accountState: { ...value.accountState, orders: { status: "VERIFIED", orders: [{ orderId: 1n }] } } }), { code: "RECOVERY_ORDER_STATE_UNKNOWN" });
  assert.throws(() => validateSignerFreePreMarketEvidence({ ...value, accountState: { ...value.accountState, inventory: { yesRaw: 1n, noRaw: 0n } } }), { code: "RECOVERY_MARKET_STATE_PRESENT" });
  assert.throws(() => validateSignerFreePreMarketEvidence({ ...value, accountState: { ...value.accountState, positions: { marketId: MARKET } } }), { code: "RECOVERY_MARKET_STATE_PRESENT" });
  assert.throws(() => validateSignerFreePreMarketEvidence({ ...value, accountState: { ...value.accountState, capital: { directCollateralRaw: 2_001_000n, vaultRaw: 1n } } }), { code: "RECOVERY_SETTLEMENT_PRESENT" });
  assert.throws(() => validateSignerFreePreMarketEvidence({ ...value, accountState: { ...value.accountState, identity: { aggregateExposure: 1n, mintExposure: 0n } } }), { code: "RECOVERY_EXPOSURE_PRESENT" });
  assert.throws(() => validateSignerFreePreMarketEvidence({ ...value, accountState: { ...value.accountState, identity: { aggregateExposure: 0n, mintExposure: 1n } } }), { code: "RECOVERY_MINT_EXPOSURE_PRESENT" });
});

test("NO_VALID_QUOTE pre-market reconciliation preserves exact owner, account, and session binding", () => {
  const value = noQuotePreMarketFixtures();
  assert.throws(() => validateSignerFreePreMarketEvidence({ ...value, stored: { ...value.stored, session: { ...value.stored.session, owner: "0x4444444444444444444444444444444444444444" } } }), { code: "RECOVERY_SCOPE_MISMATCH" });
  assert.throws(() => validateSignerFreePreMarketEvidence({ ...value, stored: { ...value.stored, session: { ...value.stored.session, account: "0x5555555555555555555555555555555555555555" } } }), { code: "RECOVERY_SCOPE_MISMATCH" });
  assert.throws(() => validateSignerFreePreMarketEvidence({ ...value, stored: { ...value.stored, session: { ...value.stored.session, sessionId: "uat-2000-bbbbbbbb" } } }), { code: "RECOVERY_SCOPE_MISMATCH" });
});

test("signer-free pre-market evidence validates terminal status and preserves the exact clean boundary", () => {
  const value = preMarketFixtures();
  const result = validateSignerFreePreMarketEvidence({ ...value, status: preMarketStatus(value, { snapshot: { openOrders: [], yesRaw: 0, noRaw: 0, aggregateExposure: 0, mintExposure: 0, pendingSettlement: null } }) });
  assert.equal(result.classification, "NARROW_PREMARKET_RECOVERY");
  assert.equal(result.capitalRaw, 2_001_000n);
  assert.throws(() => validateSignerFreePreMarketEvidence({ ...value, status: preMarketStatus(value, { state: "STOPPED_CLEAN" }) }), { code: "RECOVERY_STATUS_INVALID" });
  assert.throws(() => validateSignerFreePreMarketEvidence({ ...value, status: preMarketStatus(value, { result: { writes: ["unexpected"] } }) }), { code: "RECOVERY_STATUS_INVALID" });
});

test("signer-free status evidence rejects any market-bound state or write evidence", () => {
  const value = preMarketFixtures();
  assert.throws(() => validateSignerFreePreMarketEvidence({ ...value, status: preMarketStatus(value, { snapshot: { openOrders: [{ orderId: "1" }] } }) }), { code: "RECOVERY_ORDER_STATE_UNKNOWN" });
  assert.throws(() => validateSignerFreePreMarketEvidence({ ...value, status: preMarketStatus(value, { snapshot: { openOrders: [], marketId: MARKET } }) }), { code: "RECOVERY_MARKET_STATE_PRESENT" });
  assert.throws(() => validateSignerFreePreMarketEvidence({ ...value, status: preMarketStatus(value), stored: { ...value.stored, writes: [{ action: "PLACE_ORDER" }] } }), { code: "RECOVERY_CHAIN_ACTIVITY_PRESENT" });
});

test("pre-market recovery rejects an active lease or original worker", () => {
  const value = preMarketFixtures();
  assert.throws(() => validatePreflightFailureRecovery({ ...value, expiredLease: { leaseId: "unexpected" } }), { code: "RECOVERY_LEASE_UNEXPECTED" });
  assert.throws(() => validatePreflightFailureRecovery({ ...value, activeUnit: true }), { code: "RECOVERY_ACTIVE_UNIT" });
});

test("pre-market recovery rejects any durable chain activity", () => {
  const value = preMarketFixtures();
  assert.throws(() => validatePreflightFailureRecovery({ ...value, journal: { ...value.journal, records: [{ action: "PLACE_ORDER" }] } }), { code: "RECOVERY_CHAIN_ACTIVITY_PRESENT" });
  assert.throws(() => validatePreflightFailureRecovery({ ...value, journal: { ...value.journal, pending: 1 } }), { code: "RECOVERY_CHAIN_ACTIVITY_PRESENT" });
});

test("pre-market recovery rejects live order, inventory, position, settlement, or exposure state", () => {
  const value = preMarketFixtures();
  assert.throws(() => validatePreflightFailureRecovery({ ...value, accountState: { ...value.accountState, orders: { status: "VERIFIED", orders: [{ orderId: 1n }] } } }), { code: "RECOVERY_ORDER_STATE_UNKNOWN" });
  assert.throws(() => validatePreflightFailureRecovery({ ...value, accountState: { ...value.accountState, inventory: { yesRaw: 1n, noRaw: 0n } } }), { code: "RECOVERY_MARKET_STATE_PRESENT" });
  assert.throws(() => validatePreflightFailureRecovery({ ...value, accountState: { ...value.accountState, positions: { marketId: MARKET } } }), { code: "RECOVERY_MARKET_STATE_PRESENT" });
  assert.throws(() => validatePreflightFailureRecovery({ ...value, accountState: { ...value.accountState, capital: { directCollateralRaw: 2_001_000n, vaultRaw: 1n } } }), { code: "RECOVERY_SETTLEMENT_PRESENT" });
  assert.throws(() => validatePreflightFailureRecovery({ ...value, accountState: { ...value.accountState, identity: { aggregateExposure: 1n, mintExposure: 0n } } }), { code: "RECOVERY_EXPOSURE_PRESENT" });
  assert.throws(() => validatePreflightFailureRecovery({ ...value, accountState: { ...value.accountState, identity: { aggregateExposure: 0n, mintExposure: 1n } } }), { code: "RECOVERY_MINT_EXPOSURE_PRESENT" });
});

test("market-bound preflight recovery still requires exact market identity", () => {
  const value = fixtures();
  assert.doesNotThrow(() => validatePreflightFailureRecovery({ ...value, expiredLease: null, journal: { pending: 0, unknown: 0, reverted: 0, records: [] }, stored: { ...value.stored, error: { code: "ACCOUNT_CAPITAL_CAP" } }, accountState: { ...value.accountState, orders: { status: "VERIFIED", orders: [] }, inventory: { yesRaw: 0n, noRaw: 0n }, capital: { directCollateralRaw: 1_000_000n, vaultRaw: 0n } } }));
  assert.throws(() => validatePreflightFailureRecovery({ ...value, stored: { ...value.stored, session: { ...value.stored.session, currentMarketId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, error: { code: "ACCOUNT_CAPITAL_CAP" } } }), { code: "RECOVERY_SCOPE_MISMATCH" });
});

test("pre-market recovery rejects wrong owner, account, or session", () => {
  const value = preMarketFixtures();
  assert.throws(() => validatePreflightFailureRecovery({ ...value, stored: { ...value.stored, session: { ...value.stored.session, owner: "0x4444444444444444444444444444444444444444" } } }), { code: "RECOVERY_SCOPE_MISMATCH" });
  assert.throws(() => validatePreflightFailureRecovery({ ...value, stored: { ...value.stored, session: { ...value.stored.session, account: "0x5555555555555555555555555555555555555555" } } }), { code: "RECOVERY_SCOPE_MISMATCH" });
  assert.throws(() => validatePreflightFailureRecovery({ ...value, stored: { ...value.stored, session: { ...value.stored.session, sessionId: "uat-2000-bbbbbbbb" } } }), { code: "RECOVERY_SCOPE_MISMATCH" });
});

test("pre-market recovery leaves an unrelated session unchanged", () => {
  const value = preMarketFixtures();
  const unrelated = preMarketFixtures();
  const before = structuredClone(unrelated);
  validatePreflightFailureRecovery(value);
  assert.deepEqual(unrelated, before);
});

test("pre-market reconciliation is idempotent", () => {
  const value = preMarketFixtures();
  const first = validatePreflightFailureRecovery(value);
  const second = validatePreflightFailureRecovery(value);
  assert.deepEqual(second, first);
});

test("preflight-only recovery fails closed on a lease, chain activity, inventory, or vault credit", () => {
  const session = { sessionId: SESSION, account: ACCOUNT, owner: OWNER, operator: OPERATOR, currentMarketId: MARKET };
  const args = { session, stored: { session: { ...session, leaseId: null }, error: { code: "ACCOUNT_CAPITAL_CAP" } }, journal: { pending: 0, unknown: 0, reverted: 0, records: [] }, accountState: { capital: { directCollateralRaw: 2_001_000n, vaultRaw: 0n }, inventory: { yesRaw: 0n, noRaw: 0n }, orders: { status: "VERIFIED", orders: [] } } };
  assert.throws(() => validatePreflightFailureRecovery({ ...args, expiredLease: { leaseId: "unexpected" } }), { code: "RECOVERY_LEASE_UNEXPECTED" });
  assert.throws(() => validatePreflightFailureRecovery({ ...args, journal: { ...args.journal, records: [{ action: "PLACE_ORDER" }] } }), { code: "RECOVERY_CHAIN_ACTIVITY_PRESENT" });
  assert.throws(() => validatePreflightFailureRecovery({ ...args, accountState: { ...args.accountState, inventory: { yesRaw: 1n, noRaw: 0n } } }), { code: "RECOVERY_INVENTORY_PRESENT" });
  assert.throws(() => validatePreflightFailureRecovery({ ...args, accountState: { ...args.accountState, capital: { directCollateralRaw: 2_001_000n, vaultRaw: 1n } } }), { code: "RECOVERY_SETTLEMENT_PRESENT" });
});
