/**
 * Pure policy and reconciliation helpers for the one-shot execution adapter.
 *
 * No SDK, wallet, clock, RPC, indexer, environment, or transaction is
 * reachable from this module. It accepts a fresh normalized snapshot and
 * returns a structured refusal or an exact order intent.
 */

export const EXECUTION_ADAPTER_VERSION = "villa-execution-v1";

export const DEFAULT_EXECUTION_POLICY = Object.freeze({
  version: EXECUTION_ADAPTER_VERSION,
  maxDecisionAgeMs: 5_000,
  minExpiryHeadroomSec: 30,
  maxPriceAgeSec: 15,
  maxFuturePriceSec: 5,
  maxSourceAgeSec: 60,
  maxOrders: 2,
  maxPostOnlyRetries: 3,
});

export class ExecutionPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExecutionPolicyError";
    this.code = code;
  }
}

function raw(value, label) {
  try {
    const result = typeof value === "bigint" ? value : BigInt(String(value));
    if (result < 0n) throw new Error();
    return result;
  } catch {
    throw new ExecutionPolicyError("RAW_INVALID", `${label} must be a non-negative integer raw value`);
  }
}

function positiveRaw(value, label) {
  const result = raw(value, label);
  if (result <= 0n) throw new ExecutionPolicyError("RAW_INVALID", `${label} must be positive`);
  return result;
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new ExecutionPolicyError("INPUT_INVALID", `${label} must be finite`);
  return value;
}

function expectedOrderRaw(expected, label) {
  if (!expected || !expected.action || !["BUY_YES", "SELL_YES"].includes(expected.action)) {
    throw new ExecutionPolicyError("ORDER_INVALID", `${label}.action must be BUY_YES or SELL_YES`);
  }
  return {
    action: expected.action,
    priceRaw: positiveRaw(expected.priceRaw, `${label}.priceRaw`),
    quantityRaw: positiveRaw(expected.quantityRaw, `${label}.quantityRaw`),
    owner: expected.owner,
  };
}

/** A restrictive test cap may only lower the planner's requested quantity. */
export function applyVerificationCap({ plannerQuantityRaw, verificationCapRaw }) {
  const planned = positiveRaw(plannerQuantityRaw, "plannerQuantityRaw");
  const cap = verificationCapRaw === null || verificationCapRaw === undefined
    ? planned
    : positiveRaw(verificationCapRaw, "verificationCapRaw");
  return planned < cap ? planned : cap;
}

export function buyEscrowRaw({ priceRaw, quantityRaw, oneRaw }) {
  const price = positiveRaw(priceRaw, "priceRaw");
  const quantity = positiveRaw(quantityRaw, "quantityRaw");
  const one = positiveRaw(oneRaw, "oneRaw");
  if (price >= one) throw new ExecutionPolicyError("PRICE_INVALID", "BUY price must be below oneRaw");
  return (price * quantity + one - 1n) / one;
}

export function sellEscrowRaw({ quantityRaw }) {
  return positiveRaw(quantityRaw, "quantityRaw");
}

/**
 * Convert one planner side into a writer intent. The price is never changed;
 * only quantity may be reduced by the explicit verification cap.
 */
export function targetFromPlan(plan, side, verificationCapRaw = null) {
  if (!plan || !["bid", "ask"].includes(side)) throw new ExecutionPolicyError("PLAN_INVALID", "plan side is required");
  const candidate = plan[side];
  if (!candidate || candidate.enabled !== true) return { enabled: false, reason: candidate?.skipReason || "SIDE_DISABLED" };
  const action = side === "bid" ? "BUY_YES" : "SELL_YES";
  if (candidate.action !== action) throw new ExecutionPolicyError("PLAN_INVALID", `${side} action does not match the expected binary side`);
  const plannerQuantityRaw = positiveRaw(candidate.targetQuantityRaw, `${side}.targetQuantityRaw`);
  return {
    enabled: true,
    side,
    action,
    plannerPriceRaw: positiveRaw(candidate.targetPriceRaw, `${side}.targetPriceRaw`),
    plannerQuantityRaw,
    quantityRaw: applyVerificationCap({ plannerQuantityRaw, verificationCapRaw }),
  };
}

/**
 * Final preflight gate. It checks facts that may change between planning and
 * broadcast; it never mutates state and never sends a transaction.
 */
export function preflightOrder(input, suppliedPolicy = DEFAULT_EXECUTION_POLICY) {
  const policy = { ...DEFAULT_EXECUTION_POLICY, ...suppliedPolicy };
  if (policy.version !== EXECUTION_ADAPTER_VERSION) return { allowed: false, code: "POLICY_INVALID", reason: "unsupported execution policy version" };
  const ageMs = finite(input?.nowMs, "nowMs") - finite(input?.capturedAtMs, "capturedAtMs");
  if (ageMs < 0 || ageMs > policy.maxDecisionAgeMs) return { allowed: false, code: "DECISION_STALE", reason: `decision age ${ageMs}ms exceeds ${policy.maxDecisionAgeMs}ms`, ageMs };
  if (!Number.isInteger(input?.chainNowSec) || input.chainNowSec < 0) return { allowed: false, code: "CHAIN_TIME_INVALID", reason: "authoritative chain time is invalid" };
  if (input.market?.status !== 1) return { allowed: false, code: "MARKET_NOT_TRADING", reason: "market is not Trading" };
  const expirySec = finite(input.market.expirySec, "market.expirySec");
  const timeRemainingSec = expirySec - input.chainNowSec;
  if (timeRemainingSec < policy.minExpiryHeadroomSec) return { allowed: false, code: "EXPIRY_UNSAFE", reason: `only ${timeRemainingSec}s of chain-time headroom remains` };
  if (!Number.isFinite(input.feed?.price) || input.feed.price <= 0 || !Number.isFinite(input.feed?.timestampSec)) return { allowed: false, code: "FEED_INVALID", reason: "price feed is invalid" };
  const rawPriceAgeSec = input.chainNowSec - input.feed.timestampSec;
  if (rawPriceAgeSec < -policy.maxFuturePriceSec) return { allowed: false, code: "FEED_INVALID", reason: `price feed timestamp is ${Math.abs(rawPriceAgeSec)}s ahead of chain time` };
  const priceAgeSec = Math.max(0, rawPriceAgeSec);
  if (priceAgeSec > policy.maxPriceAgeSec) return { allowed: false, code: "FEED_STALE", reason: `price feed age ${priceAgeSec}s is outside policy` };
  if (input.feed.sourceAgeSec !== null && input.feed.sourceAgeSec !== undefined && (input.feed.sourceAgeSec < 0 || input.feed.sourceAgeSec > policy.maxSourceAgeSec)) return { allowed: false, code: "FEED_SOURCE_STALE", reason: "upstream feed source is stale" };
  if (input.openOrdersStatus !== "VERIFIED") return { allowed: false, code: "OPEN_ORDER_STATE_INVALID", reason: "open-order reconciliation is not verified" };
  if (!input.governor || input.governor.state === "HALT") return { allowed: false, code: "GOVERNOR_HALT", reason: input.governor?.primaryReasonCode || "governor halted" };
  const intent = expectedOrderRaw(input.intent, "intent");
  if (!input.governor.permissions?.allowedActions?.includes(intent.action)) return { allowed: false, code: "ACTION_NOT_PERMITTED", reason: `${intent.action} is not permitted by the governor` };
  if (input.sidePlan?.enabled !== true || input.sidePlan.action !== intent.action) return { allowed: false, code: "PLAN_SIDE_DISABLED", reason: "planner did not enable this exact action" };
  const plannerQuantity = positiveRaw(input.sidePlan.targetQuantityRaw, "sidePlan.targetQuantityRaw");
  if (intent.quantityRaw > plannerQuantity) return { allowed: false, code: "QUANTITY_EXCEEDS_PLAN", reason: "execution quantity exceeds planner target" };
  if (input.verificationCapRaw !== null && input.verificationCapRaw !== undefined && intent.quantityRaw > positiveRaw(input.verificationCapRaw, "verificationCapRaw")) return { allowed: false, code: "QUANTITY_EXCEEDS_CAP", reason: "execution quantity exceeds verification cap" };
  const one = positiveRaw(input.grid?.oneRaw, "grid.oneRaw");
  const tick = positiveRaw(input.grid?.tickSizeRaw, "grid.tickSizeRaw");
  const lot = positiveRaw(input.grid?.lotSizeRaw, "grid.lotSizeRaw");
  const minimum = positiveRaw(input.grid?.minQuantityRaw, "grid.minQuantityRaw");
  if (tick >= one || intent.priceRaw >= one || intent.priceRaw % tick !== 0n || intent.quantityRaw % lot !== 0n || intent.quantityRaw < minimum) return { allowed: false, code: "GRID_INVALID", reason: "order is off the binary tick/lot/minimum grid" };
  const bestBid = input.book?.bestBidRaw === null || input.book?.bestBidRaw === undefined ? null : raw(input.book.bestBidRaw, "book.bestBidRaw");
  const bestAsk = input.book?.bestAskRaw === null || input.book?.bestAskRaw === undefined ? null : raw(input.book.bestAskRaw, "book.bestAskRaw");
  if (bestBid !== null && (bestBid <= 0n || bestBid >= one || bestBid % tick !== 0n)) return { allowed: false, code: "BOOK_INVALID", reason: "best bid is invalid" };
  if (bestAsk !== null && (bestAsk <= 0n || bestAsk >= one || bestAsk % tick !== 0n)) return { allowed: false, code: "BOOK_INVALID", reason: "best ask is invalid" };
  if (bestBid !== null && bestAsk !== null && bestBid >= bestAsk) return { allowed: false, code: "BOOK_INVALID", reason: "best bid is not below best ask" };
  if (intent.action === "BUY_YES" && bestAsk !== null && intent.priceRaw >= bestAsk) return { allowed: false, code: "POST_ONLY_WOULD_CROSS", reason: "BUY_YES target reaches the best ask" };
  if (intent.action === "SELL_YES" && bestBid !== null && intent.priceRaw <= bestBid) return { allowed: false, code: "POST_ONLY_WOULD_CROSS", reason: "SELL_YES target reaches the best bid" };
  const availableYes = raw(input.availableYesRaw, "availableYesRaw");
  if (intent.action === "SELL_YES" && availableYes < intent.quantityRaw) return { allowed: false, code: "INVENTORY_INSUFFICIENT", reason: "visible/free YES balance is below the order quantity" };
  const collateral = raw(input.collateralAvailableRaw, "collateralAvailableRaw");
  const reserve = raw(input.collateralReserveRaw ?? 0n, "collateralReserveRaw");
  const escrow = intent.action === "BUY_YES" ? buyEscrowRaw({ priceRaw: intent.priceRaw, quantityRaw: intent.quantityRaw, oneRaw: one }) : sellEscrowRaw({ quantityRaw: intent.quantityRaw });
  if (intent.action === "BUY_YES" && collateral < escrow + reserve) return { allowed: false, code: "COLLATERAL_INSUFFICIENT", reason: "BUY escrow plus reserve exceeds available tUSDC" };
  return { allowed: true, ageMs, intent, escrowRaw: escrow, timeRemainingSec };
}

export function createExecutionSession({ sessionId, marketId, verificationCapRaw = null, maxOrders = DEFAULT_EXECUTION_POLICY.maxOrders }) {
  if (!sessionId || !marketId) throw new ExecutionPolicyError("SESSION_INVALID", "sessionId and marketId are required");
  if (!Number.isInteger(maxOrders) || maxOrders < 1) throw new ExecutionPolicyError("SESSION_INVALID", "maxOrders must be positive");
  return { version: EXECUTION_ADAPTER_VERSION, sessionId: String(sessionId), marketId: String(marketId), verificationCapRaw: verificationCapRaw === null ? null : positiveRaw(verificationCapRaw, "verificationCapRaw"), maxOrders, mintedTemporaryRaw: 0n, createdOrders: [], events: [] };
}

export function recordExecutionEvent(session, type, facts = {}, atMs = 0) {
  if (!session || !session.sessionId || !type || !Number.isFinite(atMs)) throw new ExecutionPolicyError("SESSION_INVALID", "session, event type, and finite event time are required");
  return { ...session, events: [...session.events, { sessionId: session.sessionId, type, atMs, facts: structuredClone(facts) }] };
}

export function trackCreatedOrder(session, order) {
  const id = String(order?.orderId ?? "");
  if (!id || !order.action) throw new ExecutionPolicyError("ORDER_INVALID", "created order id and action are required");
  if (session.createdOrders.some((item) => item.orderId === id)) throw new ExecutionPolicyError("ORDER_DUPLICATE", `order ${id} is already tracked`);
  if (session.createdOrders.length >= session.maxOrders) throw new ExecutionPolicyError("ORDER_LIMIT", `session limit is ${session.maxOrders} orders`);
  return { ...session, createdOrders: [...session.createdOrders, { orderId: id, pool: order.pool, action: order.action, priceRaw: String(order.priceRaw), quantityRaw: String(order.quantityRaw), txHash: order.txHash ?? null }] };
}

export function sessionCleanupOrderIds(session, activeOrderIds) {
  const active = new Set((activeOrderIds ?? []).map(String));
  return session.createdOrders.map((order) => order.orderId).filter((id) => active.has(id));
}

/** On-chain is strongest; contradictory indexed fields produce UNKNOWN. */
export function classifyOrderReconciliation({ expected, onchain, indexed = null, cancelRequested = false, fillsRaw = 0n }) {
  const target = expectedOrderRaw(expected, "expected");
  const fills = raw(fillsRaw, "fillsRaw");
  if (onchain) {
    let remaining;
    try { remaining = raw(onchain.quantityRemaining, "onchain.quantityRemaining"); } catch { return "UNKNOWN"; }
    if (onchain.price !== target.priceRaw || onchain.isBid !== (target.action === "BUY_YES")) return "UNKNOWN";
    if (indexed) {
      let indexedRemaining;
      try { indexedRemaining = raw(indexed.remainingQtyRaw, "indexed.remainingQtyRaw"); } catch { return "UNKNOWN"; }
      if (indexed.side !== (target.action === "BUY_YES" ? "BUY" : "SELL") || indexedRemaining !== remaining) return "UNKNOWN";
    }
    if (fills > 0n && remaining === 0n) return "FILLED";
    if (fills > 0n && remaining < target.quantityRaw) return "PARTIALLY_FILLED";
    if (remaining > 0n) return "RESTING";
  }
  if (!onchain && cancelRequested && !indexed) return "CANCELLED";
  if (!onchain && fills >= target.quantityRaw) return "FILLED";
  return "UNKNOWN";
}

export function hypotheticalSecondOrderAllowed({ governor, plan, side }) {
  const target = targetFromPlan(plan, side, null);
  if (!target.enabled) return { allowed: false, reason: target.reason };
  const allowedActions = governor?.permissions?.allowedActions ?? [];
  if (!allowedActions.includes(target.action)) return { allowed: false, reason: "ACTION_NOT_PERMITTED" };
  return { allowed: true, target };
}
