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

export function validateExpiredSessionRecovery({ session, stored, expiredLease, journal, accountState } = {}) {
  if (!session || !stored?.session || !expiredLease) fail("RECOVERY_STATE_REQUIRED", "session, private state, and expired lease are required");
  for (const [field, exact = false] of [["owner"], ["account"], ["operator"], ["currentMarketId"], ["sessionId", true]]) {
    const matches = exact ? String(stored.session[field] ?? "") === String(session[field] ?? "") : same(stored.session[field], session[field]);
    if (!matches) fail("RECOVERY_SCOPE_MISMATCH", `private state ${field} does not match the recovery session`);
  }
  if (!same(expiredLease.owner, session.owner) || !same(expiredLease.account, session.account) || !same(expiredLease.operator, session.operator)
    || String(expiredLease.sessionId ?? "") !== session.sessionId || String(stored.session.leaseId ?? "") !== String(expiredLease.leaseId ?? "")) {
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
