/**
 * Chain/venue-authoritative reconciliation for an account-bound session.
 * Local journals and indexer observations are evidence only; missing or
 * contradictory state is UNKNOWN and blocks START or lease release.
 */

import { isAddress } from "viem";
import { LP_SESSION_VERSION } from "./lp-session.mjs";

export const LP_RECONCILIATION_VERSION = "villa-lp-reconciliation-v1";
export const LP_RECONCILIATION_STATUSES = Object.freeze(["RECONCILED", "UNKNOWN"]);
export const LP_TRANSACTION_OBSERVATION_STATES = Object.freeze(["PENDING", "CONFIRMED", "REVERTED", "UNKNOWN"]);

export class LpReconciliationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LpReconciliationError";
    this.code = code;
  }
}
function sameAddress(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return /^0x[0-9a-fA-F]{40}$/.test(a) && /^0x[0-9a-fA-F]{40}$/.test(b) && isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}
function copy(value) {
  return value ? structuredClone(value) : value;
}

export function classifyReceipt(receipt) {
  if (!receipt) return "UNKNOWN";
  if (receipt.status === 1 || receipt.status === "0x1" || receipt.status === "success" || receipt.status === true) return "CONFIRMED";
  if (receipt.status === 0 || receipt.status === "0x0" || receipt.status === "reverted" || receipt.status === false) return "REVERTED";
  return "UNKNOWN";
}

function transactionState(observation) {
  if (!observation) return "UNKNOWN";
  if (LP_TRANSACTION_OBSERVATION_STATES.includes(observation.state)) return observation.state;
  return classifyReceipt(observation.receipt);
}

function identityState({ session, accountState }) {
  const checks = [
    accountState?.account,
    accountState?.identity?.account,
    accountState?.capital?.account,
    accountState?.inventory?.account,
    accountState?.orders?.account,
  ];
  return checks.every((value) => value === undefined || sameAddress(value, session.account));
}

/** Reconcile every required session fact from fresh chain/venue observations. */
export function reconcileLpSession({
  session,
  accountState,
  market,
  orders,
  inventory,
  transactions = [],
  settlementClaims = [],
  successorMarket = null,
  risk = null,
  source = "CHAIN_AND_VENUE",
} = {}) {
  if (!session || session.version !== LP_SESSION_VERSION) throw new LpReconciliationError("SESSION_INVALID", "a valid LP session is required");
  const reasons = [];
  if (!identityState({ session, accountState: accountState ?? {} })) reasons.push("ACCOUNT_SCOPE_MISMATCH");
  if (!market || String(market.marketId ?? "").toLowerCase() !== session.currentMarketId.toLowerCase()) reasons.push("MARKET_SCOPE_MISMATCH");
  if (market && market.series !== undefined && market.series !== session.marketSeries) reasons.push("MARKET_SERIES_MISMATCH");
  if (!orders || orders.status !== "VERIFIED") reasons.push("ORDER_STATE_UNKNOWN");
  if (!inventory || inventory.status !== "VERIFIED") reasons.push("INVENTORY_STATE_UNKNOWN");
  const transactionStates = transactions.map((observation) => ({
    txHash: observation?.txHash ?? null,
    state: transactionState(observation),
    nonce: observation?.nonce ?? null,
    action: observation?.action ?? null,
  }));
  const pendingTransactions = transactionStates.filter((item) => item.state === "PENDING").length;
  const unknownTransactions = transactionStates.filter((item) => item.state === "UNKNOWN").length;
  if (pendingTransactions > 0) reasons.push("PENDING_TRANSACTION");
  if (unknownTransactions > 0) reasons.push("UNKNOWN_TRANSACTION");
  const unknownOrders = Number(orders?.unknownCount ?? 0);
  if (unknownOrders > 0) reasons.push("UNKNOWN_ORDER_STATE");
  const openOrders = Array.isArray(orders?.orders) ? orders.orders : [];
  if (openOrders.some((order) => order.owner && !sameAddress(order.owner, session.account))) reasons.push("ORDER_SCOPE_MISMATCH");
  if (risk?.state === "HALT") reasons.push("RISK_HALTED");
  const status = reasons.length === 0 ? "RECONCILED" : "UNKNOWN";
  return Object.freeze({
    version: LP_RECONCILIATION_VERSION,
    status,
    source,
    sessionId: session.sessionId,
    account: session.account,
    owner: session.owner,
    operator: session.operator,
    marketId: market?.marketId ?? session.currentMarketId,
    currentMarketId: market?.marketId ?? null,
    successorMarket: successorMarket ? copy(successorMarket) : null,
    collateral: copy(accountState?.capital ?? null),
    completeSetInventory: copy(accountState?.completeSetInventory ?? null),
    inventory: copy(inventory ?? accountState?.inventory ?? null),
    orders: copy(orders ?? accountState?.orders ?? null),
    openOrders,
    fills: copy(accountState?.fills ?? []),
    pendingTransactions,
    unknownTransactions,
    transactionStates: Object.freeze(transactionStates),
    settlementClaims: copy(settlementClaims),
    risk: copy(risk),
    reasons: Object.freeze([...new Set(reasons)]),
    safeToStart: status === "RECONCILED" && openOrders.length === 0,
    safeToReleaseLease: status === "RECONCILED" && openOrders.length === 0 && pendingTransactions === 0 && unknownTransactions === 0 && unknownOrders === 0,
    safeToBurn: status === "RECONCILED" && Boolean(accountState?.completeSetInventory?.burnableRaw),
  });
}

export function assertReconciledForLeaseRelease(result) {
  if (!result || result.status !== "RECONCILED" || result.safeToReleaseLease !== true) throw new LpReconciliationError("LEASE_RELEASE_BLOCKED", "lease cannot be released before an authoritative terminal reconciliation");
  return true;
}

export function reconcileRestart({ session, observation }) {
  if (!session || session.version !== LP_SESSION_VERSION) throw new LpReconciliationError("SESSION_INVALID", "a valid LP session is required");
  if (!observation || observation.status !== "RECONCILED") return { recovered: false, state: "ERROR", reason: "RESTART_RECONCILIATION_REQUIRED" };
  if (!observation.safeToStart) return { recovered: false, state: "ERROR", reason: "RESTART_STATE_NOT_SAFE" };
  return { recovered: true, state: "PREFLIGHT", reason: "RECONCILED_BEFORE_NEW_SESSION", account: session.account, marketId: session.currentMarketId };
}
