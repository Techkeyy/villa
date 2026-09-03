/**
 * Account-bound settlement state for a completed LP session.
 *
 * This module is pure. Live code supplies fresh on-chain state, while this
 * layer keeps the exact session market, inventory, and payout decision bound
 * together. Indexer finality alone can never make a claim redeemable.
 */

import { authoritativeResolution, buildRedemptionPlan } from "./index.mjs";

export const SESSION_SETTLEMENT_STATES = Object.freeze([
  "STOPPED_CLEAN",
  "STOPPED_SETTLEMENT_PENDING",
  "SETTLEMENT_BLOCKED",
  "SETTLEMENT_READY",
  "SETTLING",
  "SETTLED",
  "WITHDRAWABLE",
]);

export class SessionSettlementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SessionSettlementError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SessionSettlementError(code, message);
}

function nonNegative(value, label) {
  if (typeof value !== "bigint" || value < 0n) fail("INVALID_RAW", label + " must be a non-negative raw integer");
  return value;
}

function positive(value, label) {
  nonNegative(value, label);
  if (value === 0n) fail("INVALID_RAW", label + " must be positive");
  return value;
}

function inventory(value = {}, label = "inventory") {
  return Object.freeze({ yesRaw: nonNegative(value.yesRaw ?? 0n, label + ".yesRaw"), noRaw: nonNegative(value.noRaw ?? 0n, label + ".noRaw") });
}

function same(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function normalizedOnchain(onchain = {}) {
  const status = typeof onchain.status === "bigint" ? Number(onchain.status) : onchain.status;
  return { ...onchain, status };
}

function sumInventory(value) {
  return value.yesRaw + value.noRaw;
}

/**
 * Determine the next truthful account-session settlement state from fresh
 * chain observations. Held is the inventory recorded by this session; the
 * current owned balance must never exceed it, preventing cross-session
 * residual adoption.
 */
export function assessSessionSettlement({
  session,
  account = null,
  owner = null,
  marketId,
  onchain,
  held,
  owned,
  orders = { status: "VERIFIED", orders: [] },
  pendingTransactions = 0,
  unknownTransactions = 0,
  payoutNumerators,
  outcomeIds = {},
  alreadyRedeemed = { yes: false, no: false },
  indexerStatus = null,
  indexerWinningOutcome = null,
} = {}) {
  if (!session || !same(session.currentMarketId, marketId)) fail("MARKET_SCOPE_MISMATCH", "settlement market differs from the session market");
  if (account !== null && !same(account, session.account)) fail("ACCOUNT_SCOPE_MISMATCH", "settlement account differs from the session account");
  if (owner !== null && !same(owner, session.owner)) fail("OWNER_SCOPE_MISMATCH", "settlement owner differs from the session owner");
  const heldInventory = inventory(held, "held");
  const ownedInventory = inventory(owned, "owned");
  if (ownedInventory.yesRaw > heldInventory.yesRaw || ownedInventory.noRaw > heldInventory.noRaw) fail("OWNERSHIP_MISMATCH", "current market inventory exceeds the amount tracked by this session");
  const openOrders = Array.isArray(orders?.orders) ? orders.orders : [];
  if (pendingTransactions > 0 || unknownTransactions > 0) {
    return Object.freeze({ state: "SETTLEMENT_BLOCKED", reason: "UNKNOWN_TRANSACTION", resolution: null, held: heldInventory, owned: ownedInventory, openOrders });
  }
  if (orders?.status !== "VERIFIED" || openOrders.length > 0) {
    return Object.freeze({ state: "SETTLEMENT_BLOCKED", reason: "OPEN_ORDER_STATE_UNKNOWN", resolution: null, held: heldInventory, owned: ownedInventory, openOrders });
  }
  const resolution = authoritativeResolution({ onchain: normalizedOnchain(onchain), indexerStatus, indexerWinningOutcome });
  if (sumInventory(ownedInventory) === 0n) {
    return Object.freeze({ state: resolution.redeemable ? "SETTLED" : "STOPPED_CLEAN", reason: "NO_REMAINING_INVENTORY", resolution, held: heldInventory, owned: ownedInventory, openOrders, plan: null });
  }
  if (!resolution.redeemable) {
    return Object.freeze({ state: "STOPPED_SETTLEMENT_PENDING", reason: "MARKET_NOT_REDEEMABLE", resolution, held: heldInventory, owned: ownedInventory, openOrders, plan: null });
  }
  const plan = buildRedemptionPlan({
    marketId,
    resolution: resolution.resolution,
    winningOutcome: resolution.resolution === "RESOLVED" ? (indexerWinningOutcome ?? onchain.winningOutcome) : undefined,
    payoutNumerators,
    held: heldInventory,
    owned: ownedInventory,
    outcomeIds: { yes: outcomeIds.yes, no: outcomeIds.no },
    alreadyRedeemed,
  });
  const claimable = plan.legs.filter((leg) => leg.action === "REDEEM");
  return Object.freeze({
    state: claimable.length > 0 ? "SETTLEMENT_READY" : "SETTLED",
    reason: claimable.length > 0 ? "REDEEMABLE_CLAIM" : "NO_REDEEMABLE_CLAIM",
    resolution,
    held: heldInventory,
    owned: ownedInventory,
    openOrders,
    plan,
  });
}

export function classifySessionPnl({ startingValueRaw, endingValueRaw, pendingValueRaw = 0n } = {}) {
  const starting = nonNegative(startingValueRaw, "startingValueRaw");
  const ending = nonNegative(endingValueRaw, "endingValueRaw");
  if (pendingValueRaw === null) return Object.freeze({ status: "PENDING_UNREALIZED", raw: null, startingValueRaw: starting, endingValueRaw: ending, pendingValueRaw: null });
  const pending = nonNegative(pendingValueRaw, "pendingValueRaw");
  if (pending > 0n) return Object.freeze({ status: "PENDING_UNREALIZED", raw: null, startingValueRaw: starting, endingValueRaw: ending, pendingValueRaw: pending });
  const raw = ending - starting;
  return Object.freeze({ status: raw > 0n ? "REALIZED_PROFIT" : raw < 0n ? "REALIZED_LOSS" : "BREAK_EVEN", raw, startingValueRaw: starting, endingValueRaw: ending, pendingValueRaw: 0n });
}

export function buildSettlementClaimIntent({ session, account = null, owner = null, marketId, outcomeIdx, amountRaw } = {}) {
  if (!session || !same(session.currentMarketId, marketId)) fail("MARKET_SCOPE_MISMATCH", "claim market differs from the session market");
  if (account !== null && !same(account, session.account)) fail("ACCOUNT_SCOPE_MISMATCH", "claim account differs from the session account");
  if (owner !== null && !same(owner, session.owner)) fail("OWNER_SCOPE_MISMATCH", "claim owner differs from the session owner");
  if (outcomeIdx !== 0 && outcomeIdx !== 1) fail("OUTCOME_INVALID", "claim outcome must be YES or NO");
  return Object.freeze({ marketId, outcomeIdx, amountRaw: positive(amountRaw, "claim amount"), account: session.account, owner: session.owner, operator: session.operator, chainId: session.chainId, destination: session.account, action: "REDEEM_RESOLVED" });
}
