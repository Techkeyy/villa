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
const PREMARKET_FAILURE_CODES = new Set(["ACCOUNT_CAPITAL_CAP", "NO_VALID_QUOTE", "PRICE_STALE"]);
export const SIGNER_FREE_PREMARKET_ROUTE = "SIGNER_FREE_PREMARKET_RECONCILIATION";
export const PREMARKET_RECOVERY_CLASSIFICATION = "NARROW_PREMARKET_RECOVERY";
export const LEGACY_AMBIGUOUS_CLASSIFICATION = "LEGACY_AMBIGUOUS";

export function isPreMarketFailureCode(code, message = null) {
  const normalizedCode = String(code ?? "");
  return PREMARKET_FAILURE_CODES.has(normalizedCode)
    || (normalizedCode === "PROJECTED_RISK_HALT" && message === "the live projected risk decision is HALT: PRICE_STALE");
}

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

function noMarket(value) {
  return value === null || value === undefined;
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
export function classifyRecoveryRoute({ session, stored, provenance = null } = {}) {
  if (!session || !stored?.session) fail("RECOVERY_STATE_REQUIRED", "session and private state are required");
  const storedMarketId = stored.session.currentMarketId;
  const sessionMarketId = session.currentMarketId;
  if (noMarket(storedMarketId) || noMarket(sessionMarketId)) {
    if (noMarket(storedMarketId) && noMarket(sessionMarketId) && isPreMarketFailureCode(stored.error?.code, stored.error?.message)) {
      if (!provenance) return LEGACY_AMBIGUOUS_CLASSIFICATION;
      if (provenance.schemaVersion !== "villa-lp-execution-provenance-v1") fail("RECOVERY_PROVENANCE_UNKNOWN", "the new-session provenance envelope is invalid");
      return SIGNER_FREE_PREMARKET_ROUTE;
    }
    fail("RECOVERY_NOT_PREFLIGHT_ONLY", "the failed session is not an explicitly allowlisted pre-market rejection");
  }
  if (!same(storedMarketId, sessionMarketId)) fail("RECOVERY_SCOPE_MISMATCH", "private state currentMarketId does not match the recovery session");
  return "SIGNER_CAPABLE_MARKET";
}

/** Validate the complete signer-free pre-market evidence set. This function
 * has no chain-write or signer capability and is shared by the root broker and
 * focused recovery tests. */
export function validateSignerFreePreMarketEvidence({ session, stored, status, provenance = null, expiredLease = null, journal, accountState, activeUnit = false } = {}) {
  const route = classifyRecoveryRoute({ session, stored, provenance });
  if (route !== SIGNER_FREE_PREMARKET_ROUTE) fail("RECOVERY_NOT_PREFLIGHT_ONLY", "the session is not eligible for signer-free pre-market reconciliation");
  if (!status || status.state !== "ERROR" || !status.session || (status.result !== null && status.result !== undefined)) {
    fail("RECOVERY_STATUS_INVALID", "pre-market recovery requires the exact terminal error status");
  }
  for (const [field, exact = false] of [["owner"], ["account"], ["operator"], ["sessionId", true]]) {
    const matches = exact ? String(status.session[field] ?? "") === String(session[field] ?? "") : same(status.session[field], session[field]);
    if (!matches) fail("RECOVERY_SCOPE_MISMATCH", `public status ${field} does not match the recovery session`);
  }
  if (!noMarket(status.session.currentMarketId) || !isPreMarketFailureCode(status.error?.code, status.error?.message)) {
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
  const preMarketFailure = noMarket(stored.session.currentMarketId) && noMarket(session.currentMarketId);
  for (const [field, exact = false] of [["owner"], ["account"], ["operator"], ...(preMarketFailure ? [] : [["currentMarketId"]]), ["sessionId", true]]) {
    const matches = exact ? String(stored.session[field] ?? "") === String(session[field] ?? "") : same(stored.session[field], session[field]);
    if (!matches) fail("RECOVERY_SCOPE_MISMATCH", `private state ${field} does not match the recovery session`);
  }
  if (preMarketFailure ? !isPreMarketFailureCode(stored.error?.code, stored.error?.message) : stored.error?.code !== "ACCOUNT_CAPITAL_CAP") {
  fail("RECOVERY_NOT_PREFLIGHT_ONLY", "the failed session is not a recognized preflight-only rejection");
}

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

export function validateExpiredSessionRecovery({ session, stored, provenance = null, expiredLease, journal, accountState } = {}) {
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
  if (mints.length !== 1 || places.length > 1) fail("RECOVERY_PROVENANCE_MISMATCH", "recovery requires exactly one confirmed mint and no more than one confirmed placed order");
  const mintAmountRaw = raw(mints[0].amountRaw, "mint amount");
  if (mintAmountRaw === 0n || mintAmountRaw > DEFAULT_PHASE_3B1_CAPS.MAX_MINT_AMOUNT) fail("RECOVERY_PROVENANCE_MISMATCH", "confirmed mint is outside the bounded policy");
  if (places[0] && (places[0].side !== "SELL_YES" || raw(places[0].amountRaw, "order quantity") > mintAmountRaw)) fail("RECOVERY_PROVENANCE_MISMATCH", "confirmed order is not the bounded SELL_YES funded by this mint");

  const snapshotOrders = Array.isArray(stored.snapshot?.openOrders) ? stored.snapshot.openOrders : [];
  const knownOrders = new Map(snapshotOrders.map((order) => [orderId(order.orderId), order]));
  const liveOrders = accountState?.orders?.orders ?? [];
  if (accountState?.orders?.status !== "VERIFIED") fail("RECOVERY_ORDER_STATE_UNKNOWN", "authoritative account order state is unavailable");
  for (const order of liveOrders) {
    const known = knownOrders.get(orderId(order.orderId));
    if (!known || !same(order.owner, session.account) || !same(order.marketId, session.currentMarketId)
      || raw(order.quantityRemainingRaw, "remaining quantity") > raw(known.quantityRemainingRaw, "stored remaining quantity")
      || raw(order.priceRaw, "order price") !== raw(known.priceRaw, "stored order price")
      || (places[0]?.side === "SELL_YES" && order.isBid !== false)) {
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

/** Fact-based classification for new records. Missing evidence is UNKNOWN and fails closed. */
export function classifyFactBasedRecovery({ provenance, journal, facts = {} } = {}) {
  if (!provenance || provenance.schemaVersion !== "villa-lp-execution-provenance-v1") return Object.freeze({ classification: LEGACY_AMBIGUOUS_CLASSIFICATION, safeToRetry: false });
  if (!journal || journal.initializedBeforeWrite !== true || !Array.isArray(journal.records)) return Object.freeze({ classification: "UNKNOWN", safeToRetry: false, reason: "JOURNAL_UNAVAILABLE" });
  const required = ["activeUnit", "activeLease", "activeSignerWorker", "openOrders", "outcomeInventory", "aggregateExposure", "mintExposure", "vault", "claimableValue", "pendingSettlement", "redeemableValue", "unknownTransactions"];
  if (required.some((key) => facts[key] === undefined || facts[key] === null || facts[key] === "UNKNOWN")) return Object.freeze({ classification: "UNKNOWN", safeToRetry: false, reason: "AUTHORITATIVE_FACT_MISSING" });
  if (journal.records.some((record) => record?.state !== "CONFIRMED" || !ALLOWED_ACTIONS.has(record?.action))) {
    return Object.freeze({ classification: "UNKNOWN", safeToRetry: false, reason: "JOURNAL_RECORD_UNRESOLVED" });
  }
  const clean = facts.activeUnit === false && facts.activeLease === false && facts.activeSignerWorker === false && facts.openOrders === 0 && facts.outcomeInventory === 0 && facts.aggregateExposure === 0 && facts.mintExposure === 0 && facts.vault === 0 && facts.claimableValue === 0 && facts.pendingSettlement === false && facts.redeemableValue === 0 && facts.unknownTransactions === 0;
  const positive = (value) => {
    try { return BigInt(String(value)) > 0n; } catch { return false; }
  };
  const reasons = [];
  const requiredActions = [];
  if (facts.activeUnit === true) { reasons.push("ACTIVE_UNIT"); requiredActions.push("WAIT_FOR_WORKER"); }
  if (facts.activeLease === true) { reasons.push("ACTIVE_LEASE"); requiredActions.push("WAIT_FOR_WORKER"); }
  if (facts.activeSignerWorker === true) { reasons.push("ACTIVE_SIGNER_WORKER"); requiredActions.push("WAIT_FOR_WORKER"); }
  if (positive(facts.unknownTransactions)) { reasons.push("UNKNOWN_TRANSACTIONS"); requiredActions.push("RECONCILE_TRANSACTIONS"); }
  if (positive(facts.openOrders)) { reasons.push("OPEN_ORDERS"); requiredActions.push("CANCEL_ORDERS"); }
  if (positive(facts.outcomeInventory)) { reasons.push("OUTCOME_INVENTORY"); requiredActions.push("RECONCILE_INVENTORY"); }
  if (facts.pendingSettlement === true) { reasons.push("PENDING_SETTLEMENT"); requiredActions.push("WAIT_FOR_SETTLEMENT"); }
  if (positive(facts.vault) || positive(facts.claimableValue) || positive(facts.redeemableValue)) { reasons.push("VALUE_REMAINS"); requiredActions.push("CLAIM_REDEEM_VALUE"); }
  if (positive(facts.aggregateExposure) || positive(facts.mintExposure)) { reasons.push("EXPOSURE_REMAINS"); requiredActions.push("RECONCILE_EXPOSURE"); }
  if (!clean) return Object.freeze({ classification: "DIRTY", safeToRetry: false, reason: reasons.join("+") || "ACCOUNT_STATE_PRESENT", requiredActions: Object.freeze([...new Set(requiredActions)]) });
  if (journal.records.length === 0 && journal.writeAuthorityReached === true) return Object.freeze({ classification: "DIRTY", safeToRetry: false, reason: "WRITE_EVIDENCE_PRESENT" });
  return Object.freeze({ classification: "CLEAN", safeToRetry: true, reason: journal.records.length === 0 && journal.writeAuthorityReached !== true ? "PRE_WRITE" : "NO_REMAINING_VALUE" });
}

/** Prove every confirmed placement has an authoritative lifecycle outcome. */
export function validateOrderLifecycleProof({ session, stored, provenance = null, expiredLease = null, journal, accountState, filledPlacements = [] } = {}) {
  if (!session || !stored?.session || !provenance || provenance.schemaVersion !== "villa-lp-execution-provenance-v1") {
    fail("RECOVERY_PROVENANCE_MISMATCH", "immutable execution provenance is required");
  }
  for (const [field, exact = false] of [["owner"], ["account"], ["operator"], ["currentMarketId"], ["sessionId", true]]) {
    const matches = exact ? String(stored.session[field] ?? "") === String(session[field] ?? "") : same(stored.session[field], session[field]);
    const provenanceField = field === "currentMarketId" ? "marketId" : field;
    const provenanceMatches = provenance[provenanceField] !== undefined && (exact ? String(provenance[provenanceField]) === String(session[field]) : same(provenance[provenanceField], session[field]));
    if (!matches || !provenanceMatches) fail("RECOVERY_SCOPE_MISMATCH", "execution provenance does not match the exact recovery session");
  }
  if (!expiredLease) fail("RECOVERY_STATE_REQUIRED", "the exact expired lease is required for scoped lifecycle recovery");
  const storedLeaseId = stored.session.leaseId;
  const storedLeaseConflicts = storedLeaseId !== null && storedLeaseId !== undefined && String(storedLeaseId) !== "" && String(storedLeaseId) !== String(expiredLease.leaseId ?? "");
  if (!same(expiredLease.owner, session.owner) || !same(expiredLease.account, session.account) || !same(expiredLease.operator, session.operator) || String(expiredLease.sessionId ?? "") !== session.sessionId || storedLeaseConflicts) {
    fail("RECOVERY_SCOPE_MISMATCH", "expired lease does not match the exact stored owner/account/operator/session authority");
  }
  if ((journal?.pending ?? 0) > 0 || (journal?.unknown ?? 0) > 0) fail("RECOVERY_TRANSACTION_UNKNOWN", "pending or unknown transaction truth blocks recovery");
  if ((journal?.reverted ?? 0) > 0) fail("RECOVERY_TRANSACTION_REVERTED", "a reverted session transaction requires manual review");
  const records = journal?.records;
  if (!Array.isArray(records)) fail("RECOVERY_TRANSACTION_UNKNOWN", "durable lifecycle journal is unavailable");
  const unique = new Map();
  for (const record of records) {
    if (!record?.hash) fail("RECOVERY_PROVENANCE_MISMATCH", "confirmed lifecycle record is missing its transaction hash");
    const key = String(record.hash).toLowerCase();
    const prior = unique.get(key);
    if (prior) {
      const shape = (item) => JSON.stringify({ action: item.action, state: item.state, amountRaw: item.amountRaw, priceRaw: item.priceRaw, side: item.side });
      if (shape(prior) !== shape(record)) fail("RECOVERY_PROVENANCE_MISMATCH", "duplicate journal hash has conflicting lifecycle fields");
      continue;
    }
    unique.set(key, record);
  }
  const ordered = [...unique.values()];
  for (const record of ordered) {
    if (record.state !== "CONFIRMED" || !ALLOWED_ACTIONS.has(record.action)
      || !same(record.account, session.account) || !same(record.marketId, session.currentMarketId)
      || String(record.sessionId ?? "") !== session.sessionId) {
      fail("RECOVERY_JOURNAL_SCOPE_MISMATCH", "journal contains a non-confirmed or out-of-scope lifecycle action");
    }
  }
  const mints = ordered.filter((record) => record.action === "MINT_COMPLETE_SET");
  const places = ordered.filter((record) => record.action === "PLACE_ORDER");
  if (mints.length !== 1 || places.length === 0) fail("RECOVERY_PROVENANCE_MISMATCH", "recovery requires one confirmed mint and at least one confirmed placement");
  const mintAmountRaw = raw(mints[0].amountRaw, "mint amount");
  if (mintAmountRaw === 0n || mintAmountRaw > DEFAULT_PHASE_3B1_CAPS.MAX_MINT_AMOUNT) fail("RECOVERY_PROVENANCE_MISMATCH", "confirmed mint is outside the bounded policy");
  for (const place of places) {
    if (place.side !== "SELL_YES" || raw(place.amountRaw, "order quantity") > mintAmountRaw || raw(place.priceRaw, "order price") === 0n) {
      fail("RECOVERY_PROVENANCE_MISMATCH", "confirmed placement is not a bounded SELL_YES funded by this mint");
    }
  }
  const unmatched = [];
  const cancelledOrderIds = new Set();
  for (const record of ordered) {
    if (record.action === "PLACE_ORDER") unmatched.push(record);
    if (record.action === "CANCEL_ORDER") {
      if (unmatched.length === 0) fail("RECOVERY_PROVENANCE_MISMATCH", "confirmed cancellation has no preceding unmatched placement");
      const id = orderId(record.amountRaw);
      if (cancelledOrderIds.has(id)) fail("RECOVERY_PROVENANCE_MISMATCH", "the same order was cancelled more than once");
      cancelledOrderIds.add(id);
      unmatched.pop();
    }
  }
  if (accountState?.orders?.status !== "VERIFIED" || !Array.isArray(accountState.orders.orders)) fail("RECOVERY_ORDER_STATE_UNKNOWN", "authoritative account order state is unavailable");
  const snapshotOrders = Array.isArray(stored.snapshot?.openOrders) ? stored.snapshot.openOrders : [];
  const knownOrders = new Map(snapshotOrders.map((order) => [orderId(order.orderId), order]));
  const live = [];
  for (const order of accountState.orders.orders) {
    const id = orderId(order.orderId);
    const known = knownOrders.get(id);
    if (!known || !same(order.owner, session.account) || !same(order.marketId, session.currentMarketId)
      || raw(order.quantityRemainingRaw, "remaining quantity") > raw(known.quantityRemainingRaw, "stored remaining quantity")
      || raw(order.priceRaw, "order price") !== raw(known.priceRaw, "stored order price") || order.isBid !== false) {
      fail("RECOVERY_ORDER_SCOPE_MISMATCH", "a live order is not proven to belong to this exact failed session");
    }
    const matchIndex = unmatched.findIndex((place) => same(place.side, "SELL_YES") && raw(place.priceRaw, "placement price") === raw(order.priceRaw, "order price") && raw(place.amountRaw, "placement quantity") >= raw(order.quantityRemainingRaw, "remaining quantity"));
    if (matchIndex < 0) fail("RECOVERY_ORDER_SCOPE_MISMATCH", "a live order has no matching confirmed placement");
    unmatched.splice(matchIndex, 1);
    live.push(id);
  }
  const filledByHash = new Map();
  for (const fill of filledPlacements ?? []) {
    const key = String(fill?.placementHash ?? "").toLowerCase();
    if (!key || filledByHash.has(key)) fail("RECOVERY_PROVENANCE_MISMATCH", "filled placement evidence is missing or duplicated");
    filledByHash.set(key, fill);
  }
  const filled = [];
  for (const place of unmatched) {
    const evidence = filledByHash.get(String(place.hash).toLowerCase());
    if (!evidence || evidence.state !== "CONFIRMED" || evidence.accounted !== true || raw(evidence.amountRaw, "filled quantity") !== raw(place.amountRaw, "placement quantity")) {
      fail("ORDER_LIFECYCLE_UNKNOWN", "a confirmed placement has no authoritative cancelled, filled, or live outcome");
    }
    filled.push(place.hash);
  }
  const nextProvenance = Object.freeze({ ...provenance, trackedInventory: Object.freeze({ yesRaw: mintAmountRaw, noRaw: mintAmountRaw }), knownOrderIds: Object.freeze([...knownOrders.keys()]), nextTxIndex: ordered.length });
  return Object.freeze({ placements: places.length, cancelled: cancelledOrderIds.size, filled: filled.length, live: Object.freeze(live), cancelledOrderIds: Object.freeze([...cancelledOrderIds]), provenance: nextProvenance });
}

/**
 * The only recovery exception to an unknown settlement fact is a verified,
 * strictly risk-reducing cancellation. The proof is the complete order
 * lifecycle, not a legacy limit on the number of quote placements.
 */
export function classifyScopedOpenOrderCancellation({ session, stored, expiredLease, journal, accountState, settlementFacts, facts, provenance = null, filledPlacements = [], globalAdmissionState = "UNKNOWN" } = {}) {
  if (settlementFacts?.state !== "SETTLEMENT_BLOCKED" || settlementFacts?.reason !== "OPEN_ORDER_STATE_UNKNOWN" || facts?.pendingSettlement !== "UNKNOWN") {
    return Object.freeze({ allowed: false, reason: "SETTLEMENT_UNKNOWN_FOR_OTHER_REASON" });
  }
  const requiredExceptSettlement = ["activeUnit", "activeLease", "activeSignerWorker", "openOrders", "outcomeInventory", "aggregateExposure", "mintExposure", "vault", "claimableValue", "redeemableValue", "unknownTransactions"];
  if (requiredExceptSettlement.some((key) => facts[key] === undefined || facts[key] === null || facts[key] === "UNKNOWN")) {
    return Object.freeze({ allowed: false, reason: "AUTHORITATIVE_FACT_MISSING" });
  }
  if (facts?.activeUnit !== false) return Object.freeze({ allowed: false, reason: "ACTIVE_UNIT" });
  if (facts?.activeLease !== false) return Object.freeze({ allowed: false, reason: "ACTIVE_LEASE" });
  if (facts?.activeSignerWorker !== false) return Object.freeze({ allowed: false, reason: "ACTIVE_SIGNER_WORKER" });
  if (!["FREE", "HELD_BY_SCOPED_RECOVERY"].includes(globalAdmissionState)) return Object.freeze({ allowed: false, reason: "GLOBAL_ADMISSION_NOT_SCOPED" });
  if (accountState?.orders?.status !== "VERIFIED" || !Array.isArray(accountState.orders.orders) || accountState.orders.orders.length === 0) {
    return Object.freeze({ allowed: false, reason: "ORDER_STATE_UNVERIFIED" });
  }
  try {
    const lifecycle = validateOrderLifecycleProof({ session, stored, provenance, expiredLease, journal, accountState, filledPlacements });
    if (lifecycle.live.length !== 1) return Object.freeze({ allowed: false, reason: "ORDER_SCOPE_AMBIGUOUS" });
    const actions = recoveryActions({ session, provenance: lifecycle.provenance, accountState });
    if (actions.cancelOrderIds.length !== accountState.orders.orders.length || actions.cancelOrderIds.length !== 1) {
      return Object.freeze({ allowed: false, reason: "ORDER_SCOPE_AMBIGUOUS" });
    }
    return Object.freeze({ allowed: true, reason: "SETTLEMENT_BLOCKED_BY_OPEN_ORDER", provenance: lifecycle.provenance, lifecycle, actions });
  } catch (error) {
    return Object.freeze({ allowed: false, reason: error?.code ?? "ORDER_SCOPE_INVALID" });
  }
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
