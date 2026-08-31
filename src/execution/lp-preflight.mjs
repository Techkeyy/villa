/**
 * Single wet-execution START gate. It consumes fresh, independently verified
 * facts and returns exact refusal reasons. It does not create a writer or send
 * a transaction.
 */

import { isAddress } from "viem";
import { DEFAULT_PHASE_3B1_CAPS, normalizePhase3B1Caps } from "./lp-transaction-policy.mjs";
import { LP_SESSION_VERSION } from "./lp-session.mjs";
import { evaluateLpExecutionReadiness } from "./lp-readiness.mjs";

export const LP_WET_PREFLIGHT_VERSION = "villa-wet-preflight-v1";
export const LP_WET_PREFLIGHT_REASONS = Object.freeze([
  "EXECUTION_DISABLED",
  "SESSION_INVALID",
  "SESSION_STATE_INVALID",
  "SESSION_DURATION_EXCEEDED",
  "ACCOUNT_LEASE_NOT_HELD",
  "MARKET_NOT_TRADING",
  "MARKET_SERIES_MISMATCH",
  "STALE_MARKET_ID",
  "OPEN_ORDER_STATE_UNKNOWN",
  "OPEN_ORDERS_PRESENT",
  "INVENTORY_STATE_UNKNOWN",
  "RECONCILIATION_REQUIRED",
  "PENDING_TRANSACTION",
  "UNKNOWN_TRANSACTION",
  "UNKNOWN_ORDER_STATE",
  "ACCOUNT_CAPITAL_CAP",
  "CAPS_INVALID",
]);

function sameAddress(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  return /^0x[0-9a-fA-F]{40}$/.test(a) && /^0x[0-9a-fA-F]{40}$/.test(b) && isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
}

function add(reasons, code) {
  if (!reasons.includes(code)) reasons.push(code);
}

function raw(value) {
  try { const result = typeof value === "bigint" ? value : BigInt(String(value)); return result >= 0n ? result : null; } catch { return null; }
}

function chainIdOf(value) {
  return Number(value?.id ?? value?.chainId ?? value);
}

function sessionValid(session) {
  return Boolean(session && session.version === LP_SESSION_VERSION && typeof session.sessionId === "string" && typeof session.account === "string" && typeof session.owner === "string" && typeof session.operator === "string");
}

/**
 * The requested mode is WET only to prove that the same account-bound
 * readiness facts are checked at the future arm boundary. This function still
 * performs no broadcast and requires an explicit executionEnabled input.
 */
export function evaluateWetExecutionPreflight(input = {}) {
  const reasons = [];
  const session = input.session;
  if (!sessionValid(session)) add(reasons, "SESSION_INVALID");
  if (session && session.state !== "PREFLIGHT") add(reasons, "SESSION_STATE_INVALID");
  const nowMs = Number(input.nowMs);
  if (sessionValid(session) && Number.isFinite(nowMs) && nowMs - Number(session.createdAt) > Number(input.caps?.MAX_SESSION_DURATION_SEC ?? DEFAULT_PHASE_3B1_CAPS.MAX_SESSION_DURATION_SEC) * 1000) add(reasons, "SESSION_DURATION_EXCEEDED");
  if (input.executionEnabled !== true) add(reasons, "EXECUTION_DISABLED");

  const lease = input.lease ?? {};
  if (!lease.held || !sameAddress(lease.account, session?.account) || lease.sessionId !== session?.sessionId) add(reasons, "ACCOUNT_LEASE_NOT_HELD");

  const market = input.market ?? null;
  if (!market || !(market.status === 1 || market.status === "Trading")) add(reasons, "MARKET_NOT_TRADING");
  if (market && sessionValid(session) && String(market.series ?? "") !== session.marketSeries) add(reasons, "MARKET_SERIES_MISMATCH");
  if (market && sessionValid(session) && String(market.marketId ?? "").toLowerCase() !== session.currentMarketId.toLowerCase()) add(reasons, "STALE_MARKET_ID");

  const orders = input.orders ?? null;
  if (!orders || orders.status !== "VERIFIED") add(reasons, "OPEN_ORDER_STATE_UNKNOWN");
  else {
    if (!sameAddress(orders.account, session?.account)) add(reasons, "UNKNOWN_ORDER_STATE");
    if ((orders.orders ?? []).some((order) => order.owner && !sameAddress(order.owner, session.account))) add(reasons, "UNKNOWN_ORDER_STATE");
    if ((orders.orders ?? []).length > 0) add(reasons, "OPEN_ORDERS_PRESENT");
  }

  const inventory = input.inventory ?? null;
  if (!inventory || inventory.status !== "VERIFIED" || !sameAddress(inventory.account, session?.account)) add(reasons, "INVENTORY_STATE_UNKNOWN");

  const reconciliation = input.reconciliation ?? null;
  if (!reconciliation || reconciliation.status !== "RECONCILED") add(reasons, "RECONCILIATION_REQUIRED");
  if ((reconciliation?.pendingTransactions ?? 0) > 0) add(reasons, "PENDING_TRANSACTION");
  if ((reconciliation?.unknownTransactions ?? 0) > 0) add(reasons, "UNKNOWN_TRANSACTION");
  if ((reconciliation?.unknownOrders ?? 0) > 0) add(reasons, "UNKNOWN_ORDER_STATE");

  const capital = raw(input.capital?.collateralRaw ?? input.capital?.directCollateralRaw ?? input.capital?.collateralAvailableRaw);
  let caps;
  try { caps = normalizePhase3B1Caps(input.caps ?? {}); } catch { caps = DEFAULT_PHASE_3B1_CAPS; add(reasons, "CAPS_INVALID"); }
  if (capital === null || capital > caps.MAX_ACCOUNT_CAPITAL) add(reasons, "ACCOUNT_CAPITAL_CAP");

  const readiness = evaluateLpExecutionReadiness({
    ...input,
    allowedExecutionModes: ["WET"],
    account: { ...(input.account ?? {}), address: session?.account },
    owner: { ...(input.owner ?? {}), address: session?.owner },
    operator: { ...(input.operator ?? {}), configuredAddress: session?.operator },
    executionConfig: { ...(input.executionConfig ?? {}), mode: "WET" },
  });
  for (const reason of readiness.reasons) add(reasons, reason);
  return Object.freeze({
    version: LP_WET_PREFLIGHT_VERSION,
    allowed: reasons.length === 0,
    reasons: Object.freeze(reasons),
    sessionId: session?.sessionId ?? null,
    account: session?.account ?? null,
    owner: session?.owner ?? null,
    operator: session?.operator ?? null,
    chainId: chainIdOf(input.chain),
    marketId: market?.marketId ?? null,
    broadcast: false,
    readiness,
  });
}
