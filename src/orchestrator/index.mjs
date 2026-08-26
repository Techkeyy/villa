/**
 * Pure bounded autonomous orchestration policy.
 *
 * This module coordinates facts and actions but owns no SDK, RPC, wallet,
 * environment, clock, or transaction dependency. The live adapter supplies
 * snapshots and executes the returned actions through the existing writer.
 */

export const ORCHESTRATOR_VERSION = "villa-loop-v1";

export const CONFIGURED_SERIES = Object.freeze({
  marketType: "BINARY",
  asset: "BTC",
  intervalSec: 300,
  key: "BINARY:BTC:300",
});

export const ORCHESTRATOR_STATES = Object.freeze([
  "STARTING",
  "WAITING_FOR_MARKET",
  "ACTIVE",
  "NO_QUOTE",
  "HALTED",
  "STOPPING",
  "MARKET_CLOSED",
  "WAITING_FOR_SUCCESSOR",
  "SESSION_LIMIT_REACHED",
  "CLEAN",
  "FAILED",
]);

export const ORCHESTRATOR_EVENTS = Object.freeze([
  "SESSION_STARTED",
  "MARKET_DISCOVERY_STARTED",
  "MARKET_INITIALIZED",
  "FAIR_VALUE_UPDATED",
  "GOVERNOR_STATE_CHANGED",
  "QUOTE_PLAN_UPDATED",
  "NO_QUOTE",
  "INVENTORY_MINTED",
  "ORDER_SUBMITTED",
  "ORDER_RESTING",
  "ORDER_REQUOTED",
  "ORDER_PARTIALLY_FILLED",
  "ORDER_FILLED",
  "ORDER_CANCELLED",
  "INVENTORY_RECONCILED",
  "PAIRED_INVENTORY_BURNED",
  "MARKET_STOPPING",
  "MARKET_CLOSED",
  "SUCCESSOR_WAIT",
  "SUCCESSOR_READY",
  "SETTLEMENT_POSITION_TRACKED",
  "REDEEM_CONFIRMED",
  "SESSION_LIMIT_REACHED",
  "SESSION_CLEAN",
  "SESSION_HALTED",
]);

export const DEFAULT_ORCHESTRATOR_CONFIG = Object.freeze({
  version: ORCHESTRATOR_VERSION,
  series: CONFIGURED_SERIES,
  maxMarkets: 3,
  maxSessionDurationSec: 720,
  pollIntervalSec: 10,
  minDiscoveryHeadroomSec: 120,
  stopQuoteHeadroomSec: 90,
  orderLifetimeSec: 75,
  orderSafetySec: 2,
  maxRestingOrders: 2,
  maxTransactions: 30,
  maxOrderReplacements: 2,
  maxMints: 3,
  maxDiscoveryRetries: 36,
  maxReadRetries: 3,
  maxOrderAgeSec: 240,
  minRequoteTicks: 2,
  minRequoteSizeRatio: 0.25,
  maxProvisionLotsPerMarket: 1,
  maxProvisionedCollateralHuman: 0.001,
  maxCommittedCollateralHuman: 0.002,
  maxDirectionalExposureHuman: 0.001,
  maxTotalProvisionedCollateralHuman: 0.003,
});

export class OrchestratorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OrchestratorError";
    this.code = code;
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new OrchestratorError("CONFIG_INVALID", `${label} must be finite`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new OrchestratorError("CONFIG_INVALID", `${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new OrchestratorError("CONFIG_INVALID", `${label} must be a non-negative integer`);
  return value;
}

function positiveRatio(value, label) {
  finite(value, label);
  if (value <= 0 || value > 1) throw new OrchestratorError("CONFIG_INVALID", `${label} must be in (0, 1]`);
  return value;
}

function marketId(value, label = "marketId") {
  if (typeof value !== "string" || value.trim() === "") throw new OrchestratorError("MARKET_SCOPE_INVALID", `${label} is required`);
  return value;
}

function sameId(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function sameSeries(left, right) {
  return Boolean(left && right)
    && String(left.marketType ?? "BINARY").toUpperCase() === String(right.marketType ?? "BINARY").toUpperCase()
    && String(left.asset ?? "").toUpperCase() === String(right.asset ?? "").toUpperCase()
    && Number(left.intervalSec) === Number(right.intervalSec);
}

function parseRaw(value, label) {
  try {
    const result = typeof value === "bigint" ? value : BigInt(String(value));
    if (result < 0n) throw new Error("negative");
    return result;
  } catch {
    throw new OrchestratorError("RAW_INVALID", `${label} must be a non-negative integer raw value`);
  }
}

function rawOrNull(value) {
  return value === null || value === undefined ? null : parseRaw(value, "raw");
}

function mapWithBigInts(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}

/** Validate the intentionally narrow one-series bounded policy. */
export function validateOrchestratorConfig(supplied = DEFAULT_ORCHESTRATOR_CONFIG) {
  const config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...supplied, series: { ...CONFIGURED_SERIES, ...(supplied?.series ?? {}) } };
  if (config.version !== ORCHESTRATOR_VERSION) throw new OrchestratorError("CONFIG_INVALID", `unsupported orchestrator version ${config.version}`);
  if (config.series.marketType !== "BINARY" || String(config.series.asset).toUpperCase() !== "BTC" || Number(config.series.intervalSec) !== 300) {
    throw new OrchestratorError("CONFIG_INVALID", "Phase 6A must configure exactly BINARY:BTC:300");
  }
  config.series = Object.freeze({ marketType: "BINARY", asset: "BTC", intervalSec: 300, key: "BINARY:BTC:300" });
  positiveInteger(config.maxMarkets, "maxMarkets");
  positiveInteger(config.maxSessionDurationSec, "maxSessionDurationSec");
  positiveInteger(config.pollIntervalSec, "pollIntervalSec");
  positiveInteger(config.minDiscoveryHeadroomSec, "minDiscoveryHeadroomSec");
  positiveInteger(config.stopQuoteHeadroomSec, "stopQuoteHeadroomSec");
  positiveInteger(config.orderLifetimeSec, "orderLifetimeSec");
  positiveInteger(config.orderSafetySec, "orderSafetySec");
  positiveInteger(config.maxRestingOrders, "maxRestingOrders");
  positiveInteger(config.maxTransactions, "maxTransactions");
  nonNegativeInteger(config.maxOrderReplacements, "maxOrderReplacements");
  positiveInteger(config.maxMints, "maxMints");
  positiveInteger(config.maxDiscoveryRetries, "maxDiscoveryRetries");
  positiveInteger(config.maxReadRetries, "maxReadRetries");
  positiveInteger(config.maxOrderAgeSec, "maxOrderAgeSec");
  positiveInteger(config.minRequoteTicks, "minRequoteTicks");
  positiveRatio(config.minRequoteSizeRatio, "minRequoteSizeRatio");
  positiveInteger(config.maxProvisionLotsPerMarket, "maxProvisionLotsPerMarket");
  finite(config.maxProvisionedCollateralHuman, "maxProvisionedCollateralHuman");
  finite(config.maxCommittedCollateralHuman, "maxCommittedCollateralHuman");
  finite(config.maxDirectionalExposureHuman, "maxDirectionalExposureHuman");
  finite(config.maxTotalProvisionedCollateralHuman, "maxTotalProvisionedCollateralHuman");
  for (const [name, value] of Object.entries({
    maxProvisionedCollateralHuman: config.maxProvisionedCollateralHuman,
    maxCommittedCollateralHuman: config.maxCommittedCollateralHuman,
    maxDirectionalExposureHuman: config.maxDirectionalExposureHuman,
    maxTotalProvisionedCollateralHuman: config.maxTotalProvisionedCollateralHuman,
  })) if (value <= 0) throw new OrchestratorError("CONFIG_INVALID", `${name} must be positive`);
  if (config.stopQuoteHeadroomSec <= 30) throw new OrchestratorError("CONFIG_INVALID", "stopQuoteHeadroomSec must leave room beyond governor headroom");
  if (config.orderLifetimeSec >= config.stopQuoteHeadroomSec) throw new OrchestratorError("CONFIG_INVALID", "orderLifetimeSec must be below stopQuoteHeadroomSec");
  if (config.maxProvisionedCollateralHuman > config.maxCommittedCollateralHuman) throw new OrchestratorError("CONFIG_INVALID", "provisioned collateral cannot exceed committed collateral cap");
  return Object.freeze(config);
}

export function seriesIdentity({ marketType = "BINARY", asset, intervalSec } = {}) {
  const normalized = {
    marketType: String(marketType).toUpperCase(),
    asset: String(asset ?? "").toUpperCase(),
    intervalSec: Number(intervalSec),
  };
  if (normalized.marketType !== "BINARY" || !normalized.asset || !Number.isInteger(normalized.intervalSec) || normalized.intervalSec <= 0) {
    throw new OrchestratorError("SERIES_INVALID", "binary asset and positive integer intervalSec are required");
  }
  return { ...normalized, key: `${normalized.marketType}:${normalized.asset}:${normalized.intervalSec}` };
}

export function assertConfiguredSeries(series, config = DEFAULT_ORCHESTRATOR_CONFIG) {
  const expected = validateOrchestratorConfig(config).series;
  const actual = seriesIdentity(series);
  if (!sameSeries(actual, expected)) throw new OrchestratorError("SERIES_MISMATCH", `configured series is ${expected.key}; received ${actual.key}`);
  return actual;
}

/** Normalize only the market facts used by lifecycle binding. */
export function marketContext({ marketId: id, series, expirySec, status, yesId, noId, reference = null, pool = null, venueId = null } = {}) {
  const normalizedSeries = seriesIdentity(series);
  const normalized = {
    marketId: marketId(id),
    series: normalizedSeries,
    expirySec: finite(Number(expirySec), "expirySec"),
    status: Number(status),
    yesId: String(yesId ?? ""),
    noId: String(noId ?? ""),
    reference: clone(reference),
    pool: pool ?? null,
    venueId: venueId ?? null,
  };
  if (!Number.isInteger(normalized.status) || normalized.status < 0) throw new OrchestratorError("MARKET_INVALID", "status must be a non-negative integer");
  if (!normalized.yesId || !normalized.noId || normalized.yesId === normalized.noId) throw new OrchestratorError("MARKET_INVALID", "distinct YES and NO ids are required");
  return normalized;
}

function emptyLedger() {
  return {
    initialSttRaw: null,
    finalSttRaw: null,
    initialCollateralRaw: null,
    finalCollateralRaw: null,
    mintCollateralRaw: 0n,
    buyEscrowRaw: 0n,
    sellEscrowRaw: 0n,
    fills: [],
    cancellations: 0,
    burnReturnsRaw: 0n,
    redeemPayoutRaw: 0n,
    gasWei: 0n,
  };
}

export function createOrchestratorState({ sessionId, config = DEFAULT_ORCHESTRATOR_CONFIG, startedChainSec = null, journal = null } = {}) {
  const validated = validateOrchestratorConfig(config);
  if (!sessionId) throw new OrchestratorError("SESSION_INVALID", "sessionId is required");
  const base = {
    version: ORCHESTRATOR_VERSION,
    sessionId: String(sessionId),
    config: validated,
    configuredSeries: clone(validated.series),
    state: "STARTING",
    startedChainSec: startedChainSec === null ? null : finite(Number(startedChainSec), "startedChainSec"),
    cycle: 0,
    marketsInitialized: 0,
    marketsVisited: [],
    currentMarket: null,
    settlementRecords: [],
    knownOrderIds: [],
    restingOrders: [],
    previousPlan: null,
    previousGovernor: null,
    previousInventory: null,
    lastSafeReconciliation: null,
    temporaryMintByMarket: {},
    accounting: emptyLedger(),
    caps: { transactionsUsed: 0, orderReplacements: 0, mints: 0, discoveryRetries: 0, readRetries: 0 },
    events: [],
    journalRevision: 0,
  };
  if (journal) return reconcileJournal(journal, { state: base.state, sessionId: base.sessionId });
  return emitEvent(base, "SESSION_STARTED", { orchestratorVersion: ORCHESTRATOR_VERSION, series: validated.series, caps: validated }, startedChainSec ?? 0);
}

function assertState(state) {
  if (!state || typeof state !== "object" || !ORCHESTRATOR_STATES.includes(state.state)) throw new OrchestratorError("STATE_INVALID", "orchestrator state is invalid");
}

export function emitEvent(state, type, facts = {}, atChainSec = null) {
  assertState(state);
  if (!ORCHESTRATOR_EVENTS.includes(type)) throw new OrchestratorError("EVENT_INVALID", `unsupported orchestrator event ${type}`);
  const next = clone(state);
  next.events = [...(state.events ?? []), {
    sequence: (state.events?.length ?? 0) + 1,
    sessionId: state.sessionId,
    type,
    atChainSec: atChainSec === null ? null : Number(atChainSec),
    facts: mapWithBigInts(clone(facts)),
  }];
  next.journalRevision = (state.journalRevision ?? 0) + 1;
  return next;
}

export function initializeMarket(state, context, chainNowSec) {
  assertState(state);
  if (state.marketsInitialized >= state.config?.maxMarkets) {
    return setSessionLimitReached(state, "MARKET_COUNT_CAP", { maxMarkets: state.config.maxMarkets });
  }
  if (state.currentMarket) throw new OrchestratorError("MARKET_SCOPE_ACTIVE", "close the current market before initializing another");
  if (!sameSeries(context.series, state.configuredSeries)) throw new OrchestratorError("SERIES_MISMATCH", "market is outside configured BINARY:BTC:300 series");
  const normalized = marketContext(context);
  const next = {
    ...clone(state),
    state: "ACTIVE",
    marketsInitialized: state.marketsInitialized + 1,
    currentMarket: normalized,
    marketsVisited: [...state.marketsVisited, normalized.marketId],
    knownOrderIds: [],
    restingOrders: [],
    previousPlan: null,
    previousGovernor: null,
    previousInventory: null,
    temporaryMintByMarket: { ...state.temporaryMintByMarket, [normalized.marketId]: 0n },
  };
  return emitEvent(next, "MARKET_INITIALIZED", { marketId: normalized.marketId, series: normalized.series, reset: ["reference", "expiry", "yesId", "noId", "inventory", "pendingExposure", "quotePlan", "openOrders"] }, chainNowSec);
}

export function setWaitingForMarket(state, facts = {}, chainNowSec = null) {
  return emitEvent({ ...clone(state), state: "WAITING_FOR_MARKET" }, "SUCCESSOR_WAIT", facts, chainNowSec);
}

export function setWaitingForSuccessor(state, facts = {}, chainNowSec = null) {
  return emitEvent({ ...clone(state), state: "WAITING_FOR_SUCCESSOR" }, "SUCCESSOR_WAIT", facts, chainNowSec);
}

export function setSessionLimitReached(state, reason, facts = {}, chainNowSec = null) {
  return emitEvent({ ...clone(state), state: "SESSION_LIMIT_REACHED" }, "SESSION_LIMIT_REACHED", { reason, ...facts }, chainNowSec);
}

export function setHalted(state, reason, facts = {}, chainNowSec = null) {
  return emitEvent({ ...clone(state), state: "HALTED" }, "SESSION_HALTED", { reason, ...facts }, chainNowSec);
}

export function setClean(state, facts = {}, chainNowSec = null) {
  return emitEvent({ ...clone(state), state: "CLEAN" }, "SESSION_CLEAN", facts, chainNowSec);
}

export function setFailed(state, reason, facts = {}, chainNowSec = null) {
  return emitEvent({ ...clone(state), state: "FAILED" }, "SESSION_HALTED", { reason, fatal: true, ...facts }, chainNowSec);
}

export function shouldStopQuoting({ chainNowSec, expirySec, config = DEFAULT_ORCHESTRATOR_CONFIG } = {}) {
  const policy = validateOrchestratorConfig(config);
  const now = finite(Number(chainNowSec), "chainNowSec");
  const expiry = finite(Number(expirySec), "expirySec");
  return { stop: expiry - now <= policy.stopQuoteHeadroomSec, timeRemainingSec: expiry - now, reason: expiry - now <= policy.stopQuoteHeadroomSec ? "EXPIRY_HEADROOM" : null };
}

function sideFromPlan(plan, side, quantityCapRaw = null) {
  const candidate = plan?.[side];
  if (!candidate || candidate.enabled !== true) return null;
  const plannedQuantity = parseRaw(candidate.targetQuantityRaw, `${side}.targetQuantityRaw`);
  const quantityRaw = quantityCapRaw === null ? plannedQuantity : capPlannerQuantity({ plannerQuantityRaw: plannedQuantity, capRaw: quantityCapRaw });
  return { side, action: candidate.action, priceRaw: parseRaw(candidate.targetPriceRaw, `${side}.targetPriceRaw`), quantityRaw };
}

function sideOrder(orders, side) {
  const action = side === "bid" ? "BUY_YES" : "SELL_YES";
  return (orders ?? []).find((order) => order.action === action || order.side === side || order.side === (side === "bid" ? "BUY" : "SELL")) ?? null;
}

function materiallyDifferent(previous, next, policy) {
  if (!previous || !next) return true;
  if (previous.action !== next.action) return true;
  const tick = parseRaw(policy.tickSizeRaw ?? 1, "tickSizeRaw");
  const priceDelta = previous.priceRaw > next.priceRaw ? previous.priceRaw - next.priceRaw : next.priceRaw - previous.priceRaw;
  if (priceDelta >= tick * BigInt(policy.minRequoteTicks)) return true;
  const priorQuantity = previous.quantityRaw;
  const nextQuantity = next.quantityRaw;
  if (priorQuantity === nextQuantity) return false;
  const larger = priorQuantity > nextQuantity ? priorQuantity : nextQuantity;
  const smaller = priorQuantity > nextQuantity ? nextQuantity : priorQuantity;
  if (larger === 0n) return true;
  return Number(larger - smaller) / Number(larger) >= policy.minRequoteSizeRatio;
}

/** Deterministic hysteresis: a tiny price/size move does not write. */
export function shouldRequote({ previousPlan, currentPlan, currentOrders = [], previousGovernor, currentGovernor, previousInventory, currentInventory, chainNowSec, oldestOrderChainSec = null, quantityCapRaw = null, policy = {} } = {}) {
  const config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...policy };
  if (!currentPlan || currentPlan.plan === "NO_QUOTE") return { requote: currentOrders.length > 0, reason: currentOrders.length > 0 ? "PLAN_NO_QUOTE" : "NO_QUOTE" };
  if (currentOrders.length === 0) return { requote: true, reason: "NO_RESTING_ORDERS" };
  if (previousGovernor?.state !== currentGovernor?.state) return { requote: true, reason: "GOVERNOR_CHANGED" };
  if (JSON.stringify(mapWithBigInts(previousInventory ?? null)) !== JSON.stringify(mapWithBigInts(currentInventory ?? null))) return { requote: true, reason: "INVENTORY_CHANGED" };
  const age = oldestOrderChainSec === null ? 0 : Number(chainNowSec) - Number(oldestOrderChainSec);
  if (age >= config.maxOrderAgeSec) return { requote: true, reason: "ORDER_MAX_AGE" };
  for (const side of ["bid", "ask"]) {
    const desired = sideFromPlan(currentPlan, side, quantityCapRaw);
    const resting = sideOrder(currentOrders, side);
    if (!desired && resting) return { requote: true, reason: "SIDE_STRATEGICALLY_INVALID" };
    if (desired && !resting) return { requote: true, reason: "SIDE_MISSING" };
    if (desired && resting && materiallyDifferent({ ...resting, priceRaw: parseRaw(resting.priceRaw, "resting.priceRaw"), quantityRaw: parseRaw(resting.quantityRaw ?? resting.remainingQtyRaw, "resting.quantityRaw") }, desired, config)) {
      return { requote: true, reason: "MEANINGFUL_PLAN_CHANGE" };
    }
  }
  return { requote: false, reason: "HYSTERESIS_HOLDS" };
}

export function provisioningRequired({ plan, yesRaw, minQuantityRaw } = {}) {
  const yes = parseRaw(yesRaw ?? 0n, "yesRaw");
  const minimum = parseRaw(minQuantityRaw, "minQuantityRaw");
  return Boolean(plan?.ask?.enabled !== true && plan?.ask?.skipReason === "NO_SELL_INVENTORY" && yes < minimum);
}

/** The verification cap can only reduce a planner quantity. */
export function capPlannerQuantity({ plannerQuantityRaw, capRaw } = {}) {
  const planned = parseRaw(plannerQuantityRaw, "plannerQuantityRaw");
  const cap = parseRaw(capRaw, "capRaw");
  return planned < cap ? planned : cap;
}

export function orderExpirySeconds({ chainNowSec, marketExpirySec, config = DEFAULT_ORCHESTRATOR_CONFIG } = {}) {
  const policy = validateOrchestratorConfig(config);
  const now = Math.floor(finite(Number(chainNowSec), "chainNowSec"));
  const expiry = Math.floor(finite(Number(marketExpirySec), "marketExpirySec"));
  const result = Math.min(now + policy.orderLifetimeSec, expiry - policy.orderSafetySec);
  if (result <= now) throw new OrchestratorError("EXPIRY_UNSAFE", "order expiry is not safely in the future");
  return result;
}

export function deriveCycleActions({ plan, governor, inventory, minQuantityRaw, currentOrders = [], previousPlan = null, previousGovernor = null, previousInventory = null, chainNowSec, expirySec, oldestOrderChainSec = null, quantityCapRaw = null, tickSizeRaw, config = DEFAULT_ORCHESTRATOR_CONFIG } = {}) {
  const policy = validateOrchestratorConfig({ ...config, tickSizeRaw });
  const stop = shouldStopQuoting({ chainNowSec, expirySec, config: policy });
  if (stop.stop) return { state: "STOPPING", actions: currentOrders.length ? [{ type: "CANCEL_ALL", reason: stop.reason }] : [], reason: stop.reason };
  if (governor?.state === "HALT") return { state: "HALTED", actions: currentOrders.length ? [{ type: "CANCEL_ALL", reason: "GOVERNOR_HALT" }] : [], reason: governor.primaryReasonCode ?? "GOVERNOR_HALT" };
  if (plan?.plan === "NO_QUOTE") return { state: "NO_QUOTE", actions: currentOrders.length ? [{ type: "CANCEL_ALL", reason: "NO_QUOTE" }] : [], reason: plan.reasonCodes?.[0] ?? "NO_QUOTE" };
  const hysteresis = shouldRequote({ previousPlan, currentPlan: plan, currentOrders, previousGovernor, currentGovernor: governor, previousInventory, currentInventory: inventory, chainNowSec, oldestOrderChainSec, quantityCapRaw, policy });
  const actions = [];
  if (provisioningRequired({ plan, yesRaw: inventory?.yesRaw ?? 0n, minQuantityRaw })) actions.push({ type: "MINT_MINIMUM", reason: "ASK_REQUIRES_CURRENT_MARKET_YES" });
  if (hysteresis.requote && currentOrders.length) actions.push({ type: "CANCEL_ALL", reason: hysteresis.reason });
  for (const side of ["ask", "bid"]) {
    const target = sideFromPlan(plan, side, quantityCapRaw);
    if (target && (hysteresis.requote || !sideOrder(currentOrders, side))) actions.push({ type: "PLACE", side, action: target.action, priceRaw: target.priceRaw, quantityRaw: target.quantityRaw, reason: hysteresis.reason });
  }
  return { state: actions.length ? "ACTIVE" : "ACTIVE", actions, reason: hysteresis.reason };
}

export function recordCycle(state, { chainNowSec, pipeline, orders = state.restingOrders } = {}) {
  assertState(state);
  const currentInventory = pipeline?.rawState
    ? { yesRaw: pipeline.rawState.yesRaw, noRaw: pipeline.rawState.noRaw }
    : pipeline?.inventory ?? null;
  const next = { ...clone(state), cycle: state.cycle + 1, restingOrders: clone(orders), previousPlan: clone(pipeline?.plan ?? null), previousGovernor: clone(pipeline?.decision ?? null), previousInventory: clone(currentInventory), lastSafeReconciliation: { chainNowSec, marketId: state.currentMarket?.marketId, orderIds: (orders ?? []).map((order) => String(order.orderId ?? order.id)) } };
  let updated = emitEvent(next, "FAIR_VALUE_UPDATED", { marketId: state.currentMarket?.marketId, fairValue: pipeline?.snapshot?.fairValue ?? pipeline?.fairValue ?? null }, chainNowSec);
  updated = emitEvent(updated, "GOVERNOR_STATE_CHANGED", { marketId: state.currentMarket?.marketId, state: pipeline?.decision?.state ?? null, reason: pipeline?.decision?.primaryReasonCode ?? null }, chainNowSec);
  updated = emitEvent(updated, "QUOTE_PLAN_UPDATED", { marketId: state.currentMarket?.marketId, plan: pipeline?.plan?.plan ?? null, bid: pipeline?.plan?.bid ?? null, ask: pipeline?.plan?.ask ?? null }, chainNowSec);
  return updated;
}

export function trackOrder(state, order, chainNowSec, { replacement = false } = {}) {
  const next = { ...clone(state), restingOrders: [...(state.restingOrders ?? []), clone(order)], knownOrderIds: [...new Set([...(state.knownOrderIds ?? []), String(order.orderId)])] };
  const updated = emitEvent(next, replacement ? "ORDER_REQUOTED" : "ORDER_SUBMITTED", { marketId: state.currentMarket?.marketId, orderId: String(order.orderId), side: order.side, action: order.action, priceRaw: String(order.priceRaw), quantityRaw: String(order.quantityRaw), postOnly: true }, chainNowSec);
  return emitEvent(updated, "ORDER_RESTING", { marketId: state.currentMarket?.marketId, orderId: String(order.orderId) }, chainNowSec);
}

export function recordOrderOutcome(state, order, classification, facts = {}, chainNowSec = null) {
  const event = classification === "FILLED" ? "ORDER_FILLED" : classification === "PARTIALLY_FILLED" ? "ORDER_PARTIALLY_FILLED" : classification === "CANCELLED" ? "ORDER_CANCELLED" : "INVENTORY_RECONCILED";
  const remaining = classification === "RESTING" ? state.restingOrders : (state.restingOrders ?? []).filter((item) => String(item.orderId) !== String(order.orderId));
  const next = { ...clone(state), restingOrders: clone(remaining), knownOrderIds: [...new Set((state.knownOrderIds ?? []).filter((id) => classification === "CANCELLED" ? String(id) !== String(order.orderId) : true))] };
  if (classification === "FILLED" || classification === "PARTIALLY_FILLED") next.accounting.fills = [...next.accounting.fills, { marketId: state.currentMarket?.marketId, orderId: String(order.orderId), classification, ...clone(facts) }];
  if (classification === "CANCELLED") next.accounting.cancellations += 1;
  return emitEvent(next, event, { marketId: state.currentMarket?.marketId, orderId: String(order.orderId), classification, ...facts }, chainNowSec);
}

export function recordMint(state, amountRaw, facts = {}, chainNowSec = null) {
  const amount = parseRaw(amountRaw, "amountRaw");
  const id = state.currentMarket?.marketId;
  const prior = parseRaw(state.temporaryMintByMarket?.[id] ?? 0n, "temporaryMint");
  const next = { ...clone(state), caps: { ...state.caps, mints: state.caps.mints + 1 }, temporaryMintByMarket: { ...state.temporaryMintByMarket, [id]: prior + amount } };
  next.accounting.mintCollateralRaw += amount;
  return emitEvent(next, "INVENTORY_MINTED", { marketId: id, amountRaw: amount, ...facts }, chainNowSec);
}

export function recordBurn(state, amountRaw, facts = {}, chainNowSec = null) {
  const amount = parseRaw(amountRaw, "amountRaw");
  const id = state.currentMarket?.marketId;
  const current = parseRaw(state.temporaryMintByMarket?.[id] ?? 0n, "temporaryMint");
  if (amount > current) throw new OrchestratorError("BURN_INVALID", "burn exceeds tracked temporary mint");
  const next = { ...clone(state), temporaryMintByMarket: { ...state.temporaryMintByMarket, [id]: current - amount } };
  next.accounting.burnReturnsRaw += amount;
  return emitEvent(next, "PAIRED_INVENTORY_BURNED", { marketId: id, amountRaw: amount, ...facts }, chainNowSec);
}

export function recordSettlementPosition(state, position, chainNowSec = null) {
  const id = marketId(position?.marketId);
  if (state.settlementRecords.some((item) => sameId(item.marketId, id))) return state;
  const next = { ...clone(state), settlementRecords: [...state.settlementRecords, { ...clone(position), marketId: id, status: position.status ?? "TRACKED" }] };
  return emitEvent(next, "SETTLEMENT_POSITION_TRACKED", { marketId: id, status: position.status ?? "TRACKED" }, chainNowSec);
}

export function closeMarket(state, { chainNowSec, status = "CLOSED", inventory = null, openOrders = [] } = {}) {
  if (!state.currentMarket) throw new OrchestratorError("MARKET_SCOPE_INVALID", "no active market to close");
  if (openOrders.length) throw new OrchestratorError("CLEANUP_BLOCKED", "cannot close a market with active current-session orders");
  const id = state.currentMarket.marketId;
  const next = { ...clone(state), state: "MARKET_CLOSED", currentMarket: null, restingOrders: [], knownOrderIds: [], previousPlan: null, previousGovernor: null, previousInventory: null, settlementRecords: [...state.settlementRecords, { marketId: id, status, inventory: clone(inventory), terminalChainSec: chainNowSec }] };
  return emitEvent(next, "MARKET_CLOSED", { marketId: id, status, settlementTracked: true }, chainNowSec);
}

export function incrementTransactionBudget(state, count = 1) {
  nonNegativeInteger(count, "count");
  if (state.caps.transactionsUsed + count > state.config.maxTransactions) throw new OrchestratorError("TRANSACTION_BUDGET", `transaction budget ${state.config.maxTransactions} exceeded`);
  return { ...clone(state), caps: { ...state.caps, transactionsUsed: state.caps.transactionsUsed + count } };
}

export function incrementReplacementBudget(state, count = 1) {
  nonNegativeInteger(count, "count");
  if (state.caps.orderReplacements + count > state.config.maxOrderReplacements) throw new OrchestratorError("REQUOTE_BUDGET", `order replacement budget ${state.config.maxOrderReplacements} exceeded`);
  return { ...clone(state), caps: { ...state.caps, orderReplacements: state.caps.orderReplacements + count } };
}

export function assertRestingOrderCap(orders, config = DEFAULT_ORCHESTRATOR_CONFIG) {
  const policy = validateOrchestratorConfig(config);
  if (orders.length > policy.maxRestingOrders) throw new OrchestratorError("ORDER_CAP", `at most ${policy.maxRestingOrders} resting orders are permitted`);
  return true;
}

export function assertExposureCap({ yesRaw, noRaw, decimals, config = DEFAULT_ORCHESTRATOR_CONFIG } = {}) {
  const policy = validateOrchestratorConfig(config);
  const yes = Number(parseRaw(yesRaw, "yesRaw")) / 10 ** Number(decimals);
  const no = Number(parseRaw(noRaw, "noRaw")) / 10 ** Number(decimals);
  if (!Number.isInteger(Number(decimals)) || Number(decimals) < 0 || Number(decimals) > 18) throw new OrchestratorError("CAP_INVALID", "decimals are invalid");
  if (Math.abs(yes - no) > policy.maxDirectionalExposureHuman + 1e-12) throw new OrchestratorError("DIRECTIONAL_CAP", "current directional exposure exceeds the bounded verification cap");
  return { yes, no, directional: yes - no, cap: policy.maxDirectionalExposureHuman };
}

export function assertProvisioningCap({ amountRaw, decimals, perMarketProvisionedRaw = 0n, totalProvisionedRaw = 0n, config = DEFAULT_ORCHESTRATOR_CONFIG } = {}) {
  const policy = validateOrchestratorConfig(config);
  const amount = parseRaw(amountRaw, "amountRaw");
  const perMarket = parseRaw(perMarketProvisionedRaw, "perMarketProvisionedRaw");
  const total = parseRaw(totalProvisionedRaw, "totalProvisionedRaw");
  const scale = 10 ** Number(decimals);
  if (Number(amount + perMarket) / scale > policy.maxProvisionedCollateralHuman + 1e-12) throw new OrchestratorError("PROVISION_CAP", "per-market temporary mint cap exceeded");
  if (Number(amount + total) / scale > policy.maxTotalProvisionedCollateralHuman + 1e-12) throw new OrchestratorError("PROVISION_CAP", "session temporary mint cap exceeded");
  return true;
}

export function assertCommittedCollateralCap({ mintRaw = 0n, buyEscrowRaw = 0n, decimals, config = DEFAULT_ORCHESTRATOR_CONFIG } = {}) {
  const policy = validateOrchestratorConfig(config);
  const total = Number(parseRaw(mintRaw, "mintRaw") + parseRaw(buyEscrowRaw, "buyEscrowRaw")) / 10 ** Number(decimals);
  if (total > policy.maxCommittedCollateralHuman + 1e-12) throw new OrchestratorError("CAPITAL_CAP", "temporary mint plus BUY escrow exceeds committed collateral cap");
  return total;
}

export function pairedInventory({ yesRaw, noRaw } = {}) {
  const yes = parseRaw(yesRaw, "yesRaw");
  const no = parseRaw(noRaw, "noRaw");
  return { pairedRaw: yes < no ? yes : no, directionalResidualRaw: yes - no };
}

export function assertKnownReconciliation(classification) {
  if (!["RESTING", "PARTIALLY_FILLED", "FILLED", "CANCELLED"].includes(classification)) {
    throw new OrchestratorError("RECONCILIATION_UNKNOWN", `order reconciliation is ${String(classification)}`);
  }
  return true;
}

export function sessionElapsed({ startedChainSec, chainNowSec, config = DEFAULT_ORCHESTRATOR_CONFIG } = {}) {
  const policy = validateOrchestratorConfig(config);
  const elapsed = finite(Number(chainNowSec), "chainNowSec") - finite(Number(startedChainSec), "startedChainSec");
  return { elapsedSec: elapsed, exceeded: elapsed >= policy.maxSessionDurationSec };
}

export function recordGas(state, gasWei, chainNowSec = null) {
  const amount = parseRaw(gasWei, "gasWei");
  const next = { ...clone(state) };
  next.accounting.gasWei += amount;
  return next;
}

export function recordSafeReconciliation(state, { chainNowSec, marketId: id, orderIds = [] } = {}) {
  const next = { ...clone(state), lastSafeReconciliation: { chainNowSec, marketId: id ?? state.currentMarket?.marketId ?? null, orderIds: orderIds.map(String) } };
  return emitEvent(next, "INVENTORY_RECONCILED", { marketId: id ?? state.currentMarket?.marketId ?? null, orderIds: orderIds.map(String) }, chainNowSec);
}

export function journalFromState(state) {
  assertState(state);
  const journal = {
    journalVersion: 1,
    orchestratorVersion: state.version,
    sessionId: state.sessionId,
    configuredSeries: clone(state.configuredSeries),
    currentMarketId: state.currentMarket?.marketId ?? null,
    activeKnownOrderIds: [...(state.knownOrderIds ?? [])],
    temporaryMintQuantities: clone(state.temporaryMintByMarket ?? {}),
    latestLifecycleState: state.state,
    marketsCompleted: state.marketsVisited.slice(0, state.marketsInitialized > 0 ? state.marketsInitialized - (state.currentMarket ? 1 : 0) : 0),
    marketsVisited: [...state.marketsVisited],
    settlementRecords: clone(state.settlementRecords),
    lastSafeReconciliation: clone(state.lastSafeReconciliation),
    caps: clone(state.caps),
    accounting: clone(state.accounting),
    journalRevision: state.journalRevision,
  };
  assertJournalSecretFree(journal);
  return journal;
}

export function assertJournalSecretFree(value) {
  const visit = (item, path) => {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (/(private|secret|mnemonic|seed|password)/i.test(key)) throw new OrchestratorError("SECRET_LEAK", `secret-like journal field at ${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, "journal");
  return true;
}

/** Chain, wallet, and live order facts override journal assumptions on resume. */
export function reconcileJournal(journal, truth = {}) {
  assertJournalSecretFree(journal);
  if (journal?.orchestratorVersion !== ORCHESTRATOR_VERSION) throw new OrchestratorError("JOURNAL_INVALID", "unsupported orchestrator journal version");
  const configuredSeries = assertConfiguredSeries(journal.configuredSeries);
  return {
    ...clone(journal),
    configuredSeries,
    currentMarketId: truth.marketId ?? journal.currentMarketId ?? null,
    activeKnownOrderIds: truth.activeOrderIds ? [...truth.activeOrderIds].map(String) : [...(journal.activeKnownOrderIds ?? [])].map(String),
    latestLifecycleState: truth.state ?? journal.latestLifecycleState,
    lastSafeReconciliation: truth.lastSafeReconciliation ?? journal.lastSafeReconciliation ?? null,
    reconciliationAuthority: "CHAIN_WALLET_ORDER_STATE",
  };
}

/** Rebuild a non-secret state shell; the caller must provide freshly-read market truth. */
export function restoreOrchestratorState(journal, truth = {}) {
  const reconciled = reconcileJournal(journal, truth);
  const base = createOrchestratorState({
    sessionId: reconciled.sessionId,
    startedChainSec: truth.startedChainSec ?? null,
  });
  return {
    ...base,
    state: truth.state ?? reconciled.latestLifecycleState ?? "WAITING_FOR_MARKET",
    marketsInitialized: Array.isArray(reconciled.marketsVisited) ? reconciled.marketsVisited.length : 0,
    marketsVisited: [...(reconciled.marketsVisited ?? [])],
    currentMarket: truth.currentMarket ?? null,
    settlementRecords: clone(reconciled.settlementRecords ?? []),
    knownOrderIds: [...(reconciled.activeKnownOrderIds ?? [])].map(String),
    temporaryMintByMarket: clone(reconciled.temporaryMintQuantities ?? {}),
    lastSafeReconciliation: clone(reconciled.lastSafeReconciliation ?? null),
    accounting: clone(reconciled.accounting ?? emptyLedger()),
    caps: clone(reconciled.caps ?? base.caps),
    events: [],
    journalRevision: Number(reconciled.journalRevision ?? 0),
  };
}

export function stateScopeAudit({ state, currentMarketId, currentOutcomeIds = {}, oldOutcomeIds = {} } = {}) {
  const current = state?.currentMarket;
  const marketBound = Boolean(current && currentMarketId && sameId(current.marketId, currentMarketId));
  const oldExcluded = Object.values(oldOutcomeIds).every((id) => String(id) !== String(currentOutcomeIds.yes) && String(id) !== String(currentOutcomeIds.no));
  return {
    marketBound,
    oldOutcomeIdsExcluded: oldExcluded,
    activeOrderIds: state?.knownOrderIds ?? [],
    settlementMarketIds: (state?.settlementRecords ?? []).map((item) => item.marketId),
  };
}

export { sameId, sameSeries };
