/** Pure provenance checks and action derivation for expired-session recovery. */

import { DEFAULT_PHASE_3B1_CAPS } from "./lp-transaction-policy.mjs";

const ALLOWED_ACTIONS = new Set([
  "PREPARE_MARKET",
  "MINT_COMPLETE_SET",
  "PLACE_ORDER",
  "CANCEL_ORDER",
  "BURN_COMPLETE_SET",
  "CLAIM_VAULT_CREDIT",
]);
const PREMARKET_FAILURE_CODES = new Set(["ACCOUNT_CAPITAL_CAP"]);
export const PREMARKET_RECOVERY_CLASSIFICATION = "NARROW_PREMARKET_RECOVERY";

export class LpSessionRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LpSessionRecoveryError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new LpSessionRecoveryError(code, message);
}

function same(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function raw(value, label) {
  try {
    const result = typeof value === "bigint" ? value : BigInt(String(value ?? 0));
    if (result < 0n) throw new Error();
    return result;
  } catch {
    fail("RECOVERY_VALUE_INVALID", `${label} must be a non-negative raw integer`);
  }
}

function orderId(value) {
  return raw(value, "order id").toString();
}

function emptyRaw(value, label) {
  if (value === undefined || value === null) return;
  if (raw(value, label) !== 0n) fail("RECOVERY_MARKET_STATE_PRESENT", `pre-market recovery requires zero ${label}`);
}

function assertEmptyStatusSnapshot(snapshot) {
  if (snapshot === undefined || snapshot === null) return;
  if (snapshot.marketId !== undefined && snapshot.marketId !== null) fail("RECOVERY_MARKET_STATE_PRESENT", "pre-market recovery requires no selected market");
  if (!Array.isArray(snapshot.openOrders) || snapshot.openOrders.length !== 0) fail("RECOVERY_ORDER_STATE_UNKNOWN", "pre-market recovery requires an empty order snapshot");
  emptyRaw(snapshot.yesRaw, "YES inventory");
  emptyRaw(snapshot.noRaw, "NO inventory");
  emptyRaw(snapshot.aggregateExposure, "aggregate exposure");
  emptyRaw(snapshot.mintExposure, "mint exposure");
  if (snapshot.positions !== undefined && snapshot.positions !== null) fail("RECOVERY_MARKET_STATE_PRESENT", "pre-market recovery requires no positions");
  if (snapshot.position !== undefined && snapshot.position !== null) fail("RECOVERY_MARKET_STATE_PRESENT", "pre-market recovery requires no positions");
  if (snapshot.pendingSettlement !== undefined && snapshot.pendingSettlement !== null && snapshot.pendingSettlement !== false) {
    fail("RECOVERY_SETTLEMENT_PRESENT", "pre-market recovery requires no pending settlement");
  }
  if (Array.isArray(snapshot.writes) && snapshot.writes.length > 0) fail("RECOVERY_CHAIN_ACTIVITY_PRESENT", "pre-market recovery requires no write evidence");
}

function assertNoWriteEvidence(document, label) {
  if (!document || typeof document !== "object") return;
  if (Array.isArray(document.writes) && document.writes.length > 0) fail("RECOVERY_CHAIN_ACTIVITY_PRESENT", `${label} contains write evidence`);
  if (Array.isArray(document.transactions) && document.transactions.length > 0) fail("RECOVERY_CHAIN_ACTIVITY_PRESENT", `${label} contains transaction evidence`);
  if (Array.isArray(document.result?.writes) && document.result.writes.length > 0) fail("RECOVERY_CHAIN_ACTIVITY_PRESENT", `${label} contains write evidence`);
}

/** Classify recovery before any service launch. Null market is only eligible
 * for the explicit allowlisted terminal preflight error. */
export function classifyRecoveryRoute({ session, stored } = {}) {
  if (!session || !stored?.session) fail("RECOVERY_STATE_REQUIRED", "session and private state are required");
  const storedMarketId = stored.session.currentMarketId;
  const sessionMarketId = session.currentMarketId;
  if (storedMarketId === null || sessionMarketId === null) {
    if (storedMarketId === null && sessionMarketId === null && PREMARKET_FAILURE_CODES.has(String(stored.error?.code ?? ""))) return "SIGNER_FREE_PREMARKET";
    fail("RECOVERY_NOT_PREFLIGHT_ONLY", "the failed session is not an explicitly allowlisted pre-market rejection");
  }
  if (!same(storedMarketId, sessionMarketId)) fail("RECOVERY_SCOPE_MISMATCH", "private state currentMarketId does not match the recovery session");
  return "SIGNER_CAPABLE_MARKET";
}

/** Validate the complete signer-free pre-market evidence set. This function
 * has no chain-write or signer capability and is shared by the root broker and
 * focused recovery tests. */
export function validateSignerFreePreMarketEvidence({ session, stored, status, expiredLease = null, journal, accountState, activeUnit = false } = {}) {
  const route = classifyRecoveryRoute({ session, stored });
  if (route !== "SIGNER_FREE_PREMARKET") fail("RECOVERY_NOT_PREFLIGHT_ONLY", "the session is not eligible for signer-free pre-market reconciliation");
  if (!status || status.state !== "ERROR" || !status.session || (status.result !== null && status.result !== undefined)) {
    fail("RECOVERY_STATUS_INVALID", "pre-market recovery requires the exact terminal error status");
  }
  for (const [field, exact = false] of [["owner"], ["account"], ["operator"], ["sessionId", true]]) {
    const matches = exact ? String(status.session[field] ?? "") === String(session[field] ?? "") : same(status.session[field], session[field]);
    if (!matches) fail("RECOVERY_SCOPE_MISMATCH", `public status ${field} does not match the recovery session`);
  }
  if (status.session.currentMarketId !== null || status.error?.code !== "ACCOUNT_CAPITAL_CAP") {
    fail("RECOVERY_NOT_PREFLIGHT_ONLY", "public status is not the allowlisted terminal pre-market rejection");
  }
  if (status.session.leaseId !== null && status.session.leaseId !== undefined && String(status.session.leaseId) !== "") {
    fail("RECOVERY_LEASE_UNEXPECTED", "a pre-market failure must not contain a stored lease");
  }
  assertEmptyStatusSnapshot(status.snapshot);
  assertNoWriteEvidence(stored, "private state");
  assertNoWriteEvidence(status, "public status");
  return validatePreflightFailureRecovery({ session, stored, expiredLease, journal, accountState, activeUnit });
}

/** Validate a failed START that stopped before lease acquisition or any write. */
export function validatePreflightFailureRecovery({ session, stored, expiredLease = null, journal, accountState, activeUnit = false } = {}) {
  if (!session || !stored?.session) fail("RECOVERY_STATE_REQUIRED", "session and private state are required");
  const preMarketFailure = stored.session.currentMarketId === null && session.currentMarketId === null;
  for (const [field, exact = false] of [["owner"], ["account"], ["operator"], ...(preMarketFailure ? [] : [["currentMarketId"]]), ["sessionId", true]]) {
    const matches = exact ? String(stored.session[field] ?? "") === String(session[field] ?? "") : same(stored.session[field], session[field]);
    if (!matches) fail("RECOVERY_SCOPE_MISMATCH", `private state ${field} does not match the recovery session`);
  }
  if (String(stored.error?.code ?? "") !== "ACCOUNT_CAPITAL_CAP") fail("RECOVERY_NOT_PREFLIGHT_ONLY", "the failed session is not a recognized preflight-only capital rejection");

  if (preMarketFailure) {
    if (activeUnit !== false) fail("RECOVERY_ACTIVE_UNIT", "pre-market recovery requires the original session unit to be inactive");
    if (expiredLease) fail("RECOVERY_LEASE_UNEXPECTED", "a pre-market failure must not have acquired an account lease");
    if (stored.session.leaseId !== null && stored.session.leaseId !== undefined && String(stored.session.leaseId) !== "") {
      fail("RECOVERY_LEASE_UNEXPECTED", "a pre-market failure must not contain a stored lease");
    }
    if (!journal || !Array.isArray(journal.records) || (journal.pending ?? 0) > 0 || (journal.unknown ?? 0) > 0 || (journal.reverted ?? 0) > 0 || journal.records.length > 0) {
      fail("RECOVERY_CHAIN_ACTIVITY_PRESENT", "pre-market recovery is blocked by durable transaction activity");
    }
    if (accountState?.orders?.status !== "NOT_SELECTED" || !Array.isArray(accountState.orders.orders) || accountState.orders.orders.length !== 0) {
      fail("RECOVERY_ORDER_STATE_UNKNOWN", "pre-market recovery requires authoritative absence of market-bound orders");
    }
    if (accountState.inventory !== null || accountState.positions !== null) {
      fail("RECOVERY_MARKET_STATE_PRESENT", "pre-market recovery cannot accept market-bound inventory or positions");
    }
    if (!accountState?.capital || !Object.hasOwn(accountState.capital, "directCollateralRaw") || !Object.hasOwn(accountState.capital, "vaultRaw")) {
      fail("RECOVERY_CAPITAL_STATE_UNKNOWN", "pre-market recovery requires authoritative account capital state");
    }
    if (accountState.capital.vaultRaw !== null && raw(accountState.capital.vaultRaw, "vault credit") !== 0n) {
      fail("RECOVERY_SETTLEMENT_PRESENT", "pre-market recovery requires no settlement credit");
    }
    if (accountState?.identity?.aggregateExposure == null || accountState?.identity?.mintExposure == null) {
      fail("RECOVERY_RISK_STATE_UNKNOWN", "pre-market recovery requires authoritative account exposure state");
    }
    if (raw(accountState.identity.aggregateExposure, "aggregate exposure") !== 0n) fail("RECOVERY_EXPOSURE_PRESENT", "pre-market recovery requires zero aggregate exposure");
    if (raw(accountState.identity.mintExposure, "mint exposure") !== 0n) fail("RECOVERY_MINT_EXPOSURE_PRESENT", "pre-market recovery requires zero mint exposure");
    return Object.freeze({ classification: PREMARKET_RECOVERY_CLASSIFICATION, capitalRaw: raw(accountState?.capital?.directCollateralRaw, "account capital"), nextTxIndex: 0 });
  }

  if (!same(stored.session.currentMarketId, session.currentMarketId)) fail("RECOVERY_SCOPE_MISMATCH", "private state currentMarketId does not match the recovery session");
  if (expiredLease) fail("RECOVERY_LEASE_UNEXPECTED", "a preflight-only failure must not have acquired an account lease");
  if ((journal?.pending ?? 0) > 0 || (journal?.unknown ?? 0) > 0 || (journal?.reverted ?? 0) > 0 || (journal?.records ?? []).length > 0) {
    fail("RECOVERY_CHAIN_ACTIVITY_PRESENT", "preflight-only recovery is blocked by durable transaction activity");
  }
  if (accountState?.orders?.status !== "VERIFIED" || (accountState.orders.orders ?? []).length !== 0) fail("RECOVERY_ORDER_STATE_UNKNOWN", "preflight-only recovery requires authoritative empty orders");
  if (raw(accountState?.inventory?.yesRaw, "YES inventory") !== 0n || raw(accountState?.inventory?.noRaw, "NO inventory") !== 0n) fail("RECOVERY_INVENTORY_PRESENT", "preflight-only recovery requires empty outcome inventory");
  if (raw(accountState?.capital?.vaultRaw, "vault credit") !== 0n) fail("RECOVERY_SETTLEMENT_PRESENT", "preflight-only recovery requires zero vault credit");
  return Object.freeze({ classification: "MARKET_BOUND_PREFLIGHT_RECOVERY", capitalRaw: raw(accountState?.capital?.directCollateralRaw, "account capital"), nextTxIndex: 0 });
}

export function validateExpiredSessionRecovery({ session, stored, expiredLease, journal, accountState } = {}) {
  if (!session || !stored?.session || !expiredLease) fail("RECOVERY_STATE_REQUIRED", "session, private state, and expired lease are required");
  for (const [field, exact = false] of [["owner"], ["account"], ["operator"], ["currentMarketId"], ["sessionId", true]]) {
    const matches = exact ? String(stored.session[field] ?? "") === String(session[field] ?? "") : same(stored.session[field], session[field]);
    if (!matches) fail("RECOVERY_SCOPE_MISMATCH", `private state ${field} does not match the recovery session`);
  }
  const storedLeaseId = stored.session.leaseId;
  const storedLeaseConflicts = storedLeaseId !== null && storedLeaseId !== undefined && String(storedLeaseId) !== ""
    && String(storedLeaseId) !== String(expiredLease.leaseId ?? "");
  if (!same(expiredLease.owner, session.owner) || !same(expiredLease.account, session.account) || !same(expiredLease.operator, session.operator)
    || String(expiredLease.sessionId ?? "") !== session.sessionId || storedLeaseConflicts) {
    fail("RECOVERY_SCOPE_MISMATCH", "expired lease does not match the exact stored owner/account/operator/session authority");
  }
  if ((journal?.pending ?? 0) > 0 || (journal?.unknown ?? 0) > 0) fail("RECOVERY_TRANSACTION_UNKNOWN", "pending or unknown transaction truth blocks recovery");
  if ((journal?.reverted ?? 0) > 0) fail("RECOVERY_TRANSACTION_REVERTED", "a reverted session transaction requires manual review");
  const records = journal?.records ?? [];
  for (const record of records) {
    if (record.state !== "CONFIRMED" || !ALLOWED_ACTIONS.has(record.action)
      || !same(record.account, session.account) || !same(record.marketId, session.currentMarketId)
      || String(record.sessionId ?? "") !== session.sessionId) {
      fail("RECOVERY_JOURNAL_SCOPE_MISMATCH", "journal contains a non-confirmed or out-of-scope action");
    }
  }
  const mints = records.filter((record) => record.action === "MINT_COMPLETE_SET");
  const places = records.filter((record) => record.action === "PLACE_ORDER");
  if (mints.length !== 1 || places.length !== 1) fail("RECOVERY_PROVENANCE_MISMATCH", "recovery requires exactly one confirmed mint and one confirmed placed order");
  const mintAmountRaw = raw(mints[0].amountRaw, "mint amount");
  if (mintAmountRaw === 0n || mintAmountRaw > DEFAULT_PHASE_3B1_CAPS.MAX_MINT_AMOUNT) fail("RECOVERY_PROVENANCE_MISMATCH", "confirmed mint is outside the bounded policy");
  if (places[0].side !== "SELL_YES" || raw(places[0].amountRaw, "order quantity") > mintAmountRaw) fail("RECOVERY_PROVENANCE_MISMATCH", "confirmed order is not the bounded SELL_YES funded by this mint");

  const snapshotOrders = Array.isArray(stored.snapshot?.openOrders) ? stored.snapshot.openOrders : [];
  const knownOrders = new Map(snapshotOrders.map((order) => [orderId(order.orderId), order]));
  const liveOrders = accountState?.orders?.orders ?? [];
  if (accountState?.orders?.status !== "VERIFIED") fail("RECOVERY_ORDER_STATE_UNKNOWN", "authoritative account order state is unavailable");
  for (const order of liveOrders) {
    const known = knownOrders.get(orderId(order.orderId));
    if (!known || !same(order.owner, session.account) || !same(order.marketId, session.currentMarketId)
      || raw(order.quantityRemainingRaw, "remaining quantity") > raw(known.quantityRemainingRaw, "stored remaining quantity")
      || raw(order.priceRaw, "order price") !== raw(known.priceRaw, "stored order price")) {
      fail("RECOVERY_ORDER_SCOPE_MISMATCH", "a live order is not proven to belong to this exact failed session");
    }
  }
  const yesRaw = raw(accountState?.inventory?.yesRaw, "YES inventory");
  const noRaw = raw(accountState?.inventory?.noRaw, "NO inventory");
  if (yesRaw > mintAmountRaw || noRaw > mintAmountRaw) fail("RECOVERY_INVENTORY_SCOPE_MISMATCH", "inventory exceeds the session's confirmed mint provenance");
  return Object.freeze({
    mintAmountRaw,
    trackedInventory: Object.freeze({ yesRaw: mintAmountRaw, noRaw: mintAmountRaw }),
    knownOrderIds: Object.freeze([...knownOrders.keys()]),
    nextTxIndex: records.length,
  });
}

export function recoveryActions({ session, provenance, accountState } = {}) {
  if (!session || !provenance || !accountState) fail("RECOVERY_STATE_REQUIRED", "recovery action state is required");
  const known = new Set(provenance.knownOrderIds ?? []);
  const cancelOrderIds = [];
  for (const order of accountState.orders?.orders ?? []) {
    const id = orderId(order.orderId);
    if (!known.has(id) || !same(order.owner, session.account) || !same(order.marketId, session.currentMarketId)) {
      fail("RECOVERY_ORDER_SCOPE_MISMATCH", "recovery cannot cancel an unproven order");
    }
    cancelOrderIds.push(raw(order.orderId, "order id"));
  }
  const yesRaw = raw(accountState.inventory?.yesRaw, "YES inventory");
  const noRaw = raw(accountState.inventory?.noRaw, "NO inventory");
  const burnAmountRaw = cancelOrderIds.length === 0 ? (yesRaw < noRaw ? yesRaw : noRaw) : 0n;
  const claimVaultRaw = cancelOrderIds.length === 0 && burnAmountRaw === 0n ? raw(accountState.capital?.vaultRaw, "vault credit") : 0n;
  return Object.freeze({ cancelOrderIds: Object.freeze(cancelOrderIds), burnAmountRaw, claimVaultRaw });
}
