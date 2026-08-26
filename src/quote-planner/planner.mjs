/**
 * Pure deterministic adaptive quote planner for a single binary YES book.
 *
 * This module deliberately has no RPC, SDK, wallet, environment, clock, or
 * order-placement dependency. It consumes a normalized fair-value result,
 * the already-evaluated governor decision, inventory/pending-order state, and
 * exact per-market grid parameters. It returns a structured plan only.
 */

import {
  assessReduceOnlyOrder,
  calculateBinaryExposure,
  calculateBinaryExposureWithAdditionalOrder,
} from "../risk-governor/exposure.mjs";
import { DEFAULT_QUOTE_CONFIG, QUOTE_PLANNER_VERSION, validateQuoteConfig } from "./config.mjs";

const ACTIONS = Object.freeze({ bid: "BUY_YES", ask: "SELL_YES" });
const SIZE_SCALE = 1_000_000n;

export const QUOTE_REASON_CODES = Object.freeze([
  "NONE",
  "INPUT_INVALID",
  "FAIR_VALUE_INVALID",
  "GRID_INVALID",
  "BOOK_INVALID",
  "EXPIRED",
  "GOVERNOR_HALT",
  "GOVERNOR_REDUCE_ONLY",
  "NO_REDUCE_ONLY_DIRECTION",
  "ACTION_NOT_PERMITTED",
  "NO_SELL_INVENTORY",
  "INSUFFICIENT_COLLATERAL",
  "COLLATERAL_RESERVE",
  "MIN_QUANTITY_UNMET",
  "RISK_HEADROOM",
  "REDUCE_ONLY_CAP",
  "POST_ONLY_CONSTRAINT",
  "PRICE_BOUND",
  "QUOTE_GAP_ENFORCED",
  "LOW_CONFIDENCE_WIDENED",
  "VOLATILITY_WIDENED",
  "EXPIRY_WIDENED",
  "INVENTORY_SKEW",
  "PENDING_ORDER_STRESS",
]);

export class QuotePlannerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QuotePlannerError";
    this.code = code;
  }
}

function finite(value) {
  return Number.isFinite(value);
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function addReason(target, code) {
  if (code && !target.includes(code)) target.push(code);
}

function parseRawInteger(value, name) {
  if (typeof value === "bigint") {
    if (value < 0n) throw new QuotePlannerError("GRID_INVALID", `${name} must be >= 0`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new QuotePlannerError("GRID_INVALID", `${name} must be a non-negative safe integer`);
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new QuotePlannerError("GRID_INVALID", `${name} must be a non-negative raw integer`);
  }
  return BigInt(value);
}

function decimalParts(value, name) {
  if (typeof value === "bigint") return { digits: value.toString(), scale: 0, negative: false };
  if (typeof value !== "number" && typeof value !== "string") throw new QuotePlannerError("INPUT_INVALID", `${name} must be numeric`);
  if (typeof value === "number" && !Number.isFinite(value)) throw new QuotePlannerError("INPUT_INVALID", `${name} must be finite`);
  const text = String(value).trim();
  const match = text.match(/^([+-])?(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!match) throw new QuotePlannerError("INPUT_INVALID", `${name} is not a decimal number`);
  const negative = match[1] === "-";
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 1000) throw new QuotePlannerError("INPUT_INVALID", `${name} exponent is unsupported`);
  return {
    digits: `${match[2]}${fraction}`.replace(/^0+(?=\d)/, ""),
    scale: fraction.length - exponent,
    negative,
  };
}

/** Convert a decimal human value to raw units with explicit rounding. */
export function decimalToRaw(value, decimals, mode = "nearest", name = "value") {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new QuotePlannerError("GRID_INVALID", "decimals must be an integer from 0 to 36");
  const parts = decimalParts(value, name);
  if (parts.negative) throw new QuotePlannerError("INPUT_INVALID", `${name} must be non-negative`);
  const power = decimals - parts.scale;
  let numerator = BigInt(parts.digits || "0");
  if (power >= 0) return numerator * 10n ** BigInt(power);
  const divisor = 10n ** BigInt(-power);
  const quotient = numerator / divisor;
  const remainder = numerator % divisor;
  if (remainder === 0n || mode === "floor") return quotient;
  if (mode === "ceil") return quotient + 1n;
  if (mode !== "nearest") throw new QuotePlannerError("INPUT_INVALID", `unsupported rounding mode ${mode}`);
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

export function rawToHuman(raw, oneRaw) {
  const value = parseRawInteger(raw, "raw");
  const one = parseRawInteger(oneRaw, "oneRaw");
  if (one <= 0n) throw new QuotePlannerError("GRID_INVALID", "oneRaw must be positive");
  const result = Number(value) / Number(one);
  if (!finite(result)) throw new QuotePlannerError("GRID_INVALID", "raw value cannot be represented as a finite number");
  return result;
}

function floorGrid(raw, step) {
  return (raw / step) * step;
}

function ceilGrid(raw, step) {
  return ((raw + step - 1n) / step) * step;
}

function fixedMultiplier(value) {
  return BigInt(Math.floor(clamp(value, 0, 1) * Number(SIZE_SCALE)));
}

function scaleRaw(raw, multiplier) {
  return (raw * fixedMultiplier(multiplier)) / SIZE_SCALE;
}

function ceilCost(priceRaw, quantityRaw, oneRaw) {
  return (priceRaw * quantityRaw + oneRaw - 1n) / oneRaw;
}

function jsonRaw(raw) {
  return raw === null || raw === undefined ? null : raw.toString();
}

function finiteOrNull(value) {
  return finite(value) ? value : null;
}

function normalizeGrid(input) {
  const decimals = input?.decimals;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new QuotePlannerError("GRID_INVALID", "grid.decimals must be an integer from 0 to 18");
  const oneRaw = parseRawInteger(input.oneRaw ?? 10n ** BigInt(decimals), "grid.oneRaw");
  const tickSizeRaw = parseRawInteger(input.tickSizeRaw, "grid.tickSizeRaw");
  const lotSizeRaw = parseRawInteger(input.lotSizeRaw, "grid.lotSizeRaw");
  const minQuantityRaw = parseRawInteger(input.minQuantityRaw ?? lotSizeRaw, "grid.minQuantityRaw");
  if (oneRaw <= 0n || tickSizeRaw <= 0n || lotSizeRaw <= 0n || minQuantityRaw <= 0n) throw new QuotePlannerError("GRID_INVALID", "grid increments must be positive");
  if (minQuantityRaw % lotSizeRaw !== 0n) throw new QuotePlannerError("GRID_INVALID", "grid.minQuantityRaw must be lot aligned");
  if (oneRaw <= tickSizeRaw || oneRaw % tickSizeRaw !== 0n) throw new QuotePlannerError("GRID_INVALID", "grid.oneRaw must contain at least two complete price ticks");
  return { decimals, oneRaw, tickSizeRaw, lotSizeRaw, minQuantityRaw };
}

function normalizePriceBounds(market, grid) {
  const minRaw = parseRawInteger(market?.priceMinRaw ?? grid.tickSizeRaw, "market.priceMinRaw");
  const maxRaw = parseRawInteger(market?.priceMaxRaw ?? grid.oneRaw - grid.tickSizeRaw, "market.priceMaxRaw");
  const min = ceilGrid(minRaw, grid.tickSizeRaw);
  const max = floorGrid(maxRaw, grid.tickSizeRaw);
  if (min < grid.tickSizeRaw || max > grid.oneRaw - grid.tickSizeRaw || min > max) throw new QuotePlannerError("GRID_INVALID", "market price bounds are outside the binary probability grid");
  return { minRaw: min, maxRaw: max };
}

function normalizeBook(book, grid, bounds) {
  const result = { bestBidRaw: null, bestAskRaw: null, empty: book?.empty === true };
  for (const side of ["bestBidRaw", "bestAskRaw"]) {
    if (book?.[side] === undefined || book?.[side] === null) continue;
    const raw = parseRawInteger(book[side], `book.${side}`);
    if (raw < bounds.minRaw || raw > bounds.maxRaw || raw % grid.tickSizeRaw !== 0n) throw new QuotePlannerError("BOOK_INVALID", `book.${side} is outside or off the price grid`);
    result[side] = raw;
  }
  if (result.bestBidRaw !== null && result.bestAskRaw !== null && result.bestBidRaw >= result.bestAskRaw) throw new QuotePlannerError("BOOK_INVALID", "best bid must be below best ask for a post-only quote");
  return result;
}

function normalizeQuantity(value, grid, name) {
  if (value === undefined || value === null) return null;
  const raw = typeof value === "bigint" || typeof value === "string" && /^\d+$/.test(value)
    ? parseRawInteger(value, name)
    : decimalToRaw(value, grid.decimals, "nearest", name);
  return raw;
}

function normalizeInventory(inventory, grid) {
  const yes = inventory?.yesRaw !== undefined ? parseRawInteger(inventory.yesRaw, "inventory.yesRaw") : decimalToRaw(inventory?.yes, grid.decimals, "nearest", "inventory.yes");
  const no = inventory?.noRaw !== undefined ? parseRawInteger(inventory.noRaw, "inventory.noRaw") : decimalToRaw(inventory?.no, grid.decimals, "nearest", "inventory.no");
  const yesAvailable = inventory?.yesAvailableRaw !== undefined
    ? parseRawInteger(inventory.yesAvailableRaw, "inventory.yesAvailableRaw")
    : inventory?.yesAvailable !== undefined
      ? decimalToRaw(inventory.yesAvailable, grid.decimals, "nearest", "inventory.yesAvailable")
      : yes;
  if (yesAvailable > yes) throw new QuotePlannerError("INPUT_INVALID", "inventory.yesAvailable cannot exceed inventory.yes");
  return { yes, no, yesAvailable };
}

function normalizePendingOrders(orders) {
  if (!Array.isArray(orders)) throw new QuotePlannerError("INPUT_INVALID", "pendingOrders must be an array");
  return orders.map((order, index) => {
    if (!order || !["YES", "NO"].includes(order.outcome) || !["BUY", "SELL"].includes(order.side) || !finite(order.remainingQty) || order.remainingQty < 0) {
      throw new QuotePlannerError("INPUT_INVALID", `pendingOrders[${index}] is malformed`);
    }
    return { outcome: order.outcome, side: order.side, remainingQty: order.remainingQty };
  });
}

function normalizeFairValue(fairValue) {
  if (!fairValue || fairValue.valid === false || !finite(fairValue.pUp) || !finite(fairValue.pDown) || fairValue.pUp < 0 || fairValue.pUp > 1 || fairValue.pDown < 0 || fairValue.pDown > 1 || Math.abs(fairValue.pUp + fairValue.pDown - 1) > 1e-9 || !finite(fairValue.confidence) || fairValue.confidence < 0 || fairValue.confidence > 1 || !["HIGH", "MEDIUM", "LOW"].includes(fairValue.dataQualityStatus) || !finite(fairValue.realizedVolPerSqrtSec) || fairValue.realizedVolPerSqrtSec < 0) {
    throw new QuotePlannerError("FAIR_VALUE_INVALID", "fair value must be a valid finite binary result");
  }
  return fairValue;
}

function normalizeGovernor(input) {
  const governor = input?.governor ?? input?.risk;
  if (!governor || !["ALLOW", "REDUCE_ONLY", "HALT"].includes(governor.state)) throw new QuotePlannerError("INPUT_INVALID", "governor.state is required");
  const allowedActions = governor.permissions?.allowedActions;
  if (!Array.isArray(allowedActions)) throw new QuotePlannerError("INPUT_INVALID", "governor.permissions.allowedActions is required");
  const limits = governor.limits ?? governor.exposureLimits;
  if (!limits || !finite(limits.directionalExposureHard) || limits.directionalExposureHard <= 0 || !finite(limits.grossExposureHard) || limits.grossExposureHard <= 0) throw new QuotePlannerError("INPUT_INVALID", "governor exposure hard limits are required");
  const sizeMultiplier = governor.sizeMultiplier === undefined ? 1 : governor.sizeMultiplier;
  if (!finite(sizeMultiplier) || sizeMultiplier < 0 || sizeMultiplier > 1) throw new QuotePlannerError("INPUT_INVALID", "governor.sizeMultiplier must be between 0 and 1");
  const riskCapacity = governor.directionalRiskCapacity ?? limits.directionalExposureHard;
  if (!finite(riskCapacity) || riskCapacity <= 0) throw new QuotePlannerError("INPUT_INVALID", "governor.directionalRiskCapacity must be positive");
  return { ...governor, allowedActions, limits, sizeMultiplier, riskCapacity };
}

function makeSideSkeleton(action) {
  return {
    enabled: false,
    action,
    targetPrice: null,
    targetPriceRaw: null,
    targetQuantity: null,
    targetQuantityRaw: null,
    collateralRequiredRaw: null,
    inventoryAvailableRaw: null,
    projectedExposure: null,
    rationale: null,
    reasonCodes: [],
    skipReason: null,
  };
}

function noQuoteOutput(reasonCodes, warnings = [], extra = {}) {
  return {
    plannerVersion: QUOTE_PLANNER_VERSION,
    plan: "NO_QUOTE",
    bid: makeSideSkeleton(ACTIONS.bid),
    ask: makeSideSkeleton(ACTIONS.ask),
    reasonCodes: [...new Set(reasonCodes.length ? reasonCodes : ["INPUT_INVALID"])],
    warnings: [...new Set(warnings)],
    ...extra,
  };
}

function projectionIsSafe(projection, limits) {
  const worst = projection?.worstCase;
  return Boolean(worst && worst.directionalUp < limits.directionalExposureHard && worst.directionalDown < limits.directionalExposureHard && worst.grossOutcome < limits.grossExposureHard);
}

function pendingDirectionalForAction(exposure, action) {
  if (action === ACTIONS.ask) return exposure.pendingRiskIncrease.directionalDown;
  return exposure.pendingRiskIncrease.directionalUp;
}

function reduceOnlySafe(governor, exposure, currentDirectionalBalance, action, quantity) {
  if (governor.state !== "REDUCE_ONLY") return { permitted: true, code: null };
  const order = { outcome: "YES", side: action === ACTIONS.bid ? "BUY" : "SELL", remainingQty: quantity };
  const assessed = assessReduceOnlyOrder(currentDirectionalBalance, order);
  if (!assessed.permitted) return { permitted: false, code: assessed.overshootsNeutral ? "REDUCE_ONLY_CAP" : "ACTION_NOT_PERMITTED" };
  const pending = pendingDirectionalForAction(exposure, action);
  const cap = Math.max(0, Math.abs(currentDirectionalBalance) - pending);
  if (quantity > cap + 1e-12) return { permitted: false, code: "REDUCE_ONLY_CAP" };
  return { permitted: true, code: null };
}

function quoteReasonForUnavailable(side, initialCode) {
  addReason(side.reasonCodes, initialCode);
  if (!side.skipReason) side.skipReason = initialCode;
}

function buildRationale({ side, effectiveCenter, theoreticalPrice, finalPrice, desiredQuantityRaw, finalQuantityRaw, spread, size, exposure, priceClipped }) {
  return {
    direction: side === "bid" ? "BUY_YES_INCREASES_UP_EXPOSURE" : "SELL_YES_REDUCES_UP_OR_INCREASES_DOWN_EXPOSURE",
    fairCenter: effectiveCenter,
    theoreticalPrice,
    finalPrice,
    priceClippedByPostOnly: priceClipped,
    desiredQuantityRaw: jsonRaw(desiredQuantityRaw),
    finalQuantityRaw: jsonRaw(finalQuantityRaw),
    finalHalfSpread: spread.finalHalfSpread,
    sizeMultiplier: size.finalMultiplier,
    projectedWorstCase: exposure?.worstCase ?? null,
  };
}

function prepareSidePrice(side, theoreticalRaw, book, grid, bounds, reasons) {
  let priceRaw = side === "bid" ? floorGrid(theoreticalRaw, grid.tickSizeRaw) : ceilGrid(theoreticalRaw, grid.tickSizeRaw);
  let clipped = false;
  if (priceRaw < bounds.minRaw) {
    priceRaw = bounds.minRaw;
    clipped = true;
  }
  if (priceRaw > bounds.maxRaw) {
    priceRaw = bounds.maxRaw;
    clipped = true;
  }
  if (side === "bid" && book.bestAskRaw !== null) {
    const safeMax = floorGrid(book.bestAskRaw - grid.tickSizeRaw, grid.tickSizeRaw);
    if (safeMax < bounds.minRaw) return { priceRaw: null, clipped, reason: "POST_ONLY_CONSTRAINT" };
    if (priceRaw > safeMax) {
      priceRaw = safeMax;
      clipped = true;
      addReason(reasons, "POST_ONLY_CONSTRAINT");
    }
  }
  if (side === "ask" && book.bestBidRaw !== null) {
    const safeMin = ceilGrid(book.bestBidRaw + grid.tickSizeRaw, grid.tickSizeRaw);
    if (safeMin > bounds.maxRaw) return { priceRaw: null, clipped, reason: "POST_ONLY_CONSTRAINT" };
    if (priceRaw < safeMin) {
      priceRaw = safeMin;
      clipped = true;
      addReason(reasons, "POST_ONLY_CONSTRAINT");
    }
  }
  if (priceRaw < bounds.minRaw || priceRaw > bounds.maxRaw || priceRaw % grid.tickSizeRaw !== 0n) return { priceRaw: null, clipped, reason: "PRICE_BOUND" };
  return { priceRaw, clipped, reason: null };
}

function createProjectedExposure(inventory, pendingOrders, proposedOrders, grid) {
  const orders = proposedOrders.map((order) => ({ ...order, remainingQty: rawToHuman(order.remainingQtyRaw, grid.oneRaw) }));
  return calculateBinaryExposure({
    yes: rawToHuman(inventory.yes, grid.oneRaw),
    no: rawToHuman(inventory.no, grid.oneRaw),
    openOrders: [...pendingOrders, ...orders],
  });
}

function fitQuantity({ desiredRaw, side, priceRaw, inventory, pendingOrders, existingExposure, governor, grid, capitalAvailableRaw, reserveRaw, bounds, combinedOrders = [] }) {
  let upper = floorGrid(desiredRaw, grid.lotSizeRaw);
  const orderSide = side === "bid" ? "BUY" : "SELL";
  const action = side === "bid" ? ACTIONS.bid : ACTIONS.ask;
  if (upper < grid.minQuantityRaw) return { quantityRaw: 0n, code: "MIN_QUANTITY_UNMET" };

  if (side === "ask") {
    const pendingSellYesRaw = pendingOrders.filter((order) => order.outcome === "YES" && order.side === "SELL").reduce((sum, order) => sum + decimalToRaw(order.remainingQty, grid.decimals, "nearest", "pending sell quantity"), 0n);
    const inventoryCap = inventory.yesAvailable > pendingSellYesRaw ? inventory.yesAvailable - pendingSellYesRaw : 0n;
    const lotAlignedInventoryCap = floorGrid(inventoryCap, grid.lotSizeRaw);
    upper = upper < lotAlignedInventoryCap ? upper : lotAlignedInventoryCap;
    if (upper < grid.minQuantityRaw) return { quantityRaw: 0n, code: "NO_SELL_INVENTORY" };
  }

  function safe(quantityRaw) {
    if (quantityRaw < grid.minQuantityRaw || quantityRaw % grid.lotSizeRaw !== 0n) return false;
    if (side === "bid") {
      const cost = ceilCost(priceRaw, quantityRaw, grid.oneRaw);
      if (cost + reserveRaw > capitalAvailableRaw) return false;
    }
    const quantity = rawToHuman(quantityRaw, grid.oneRaw);
    const order = { outcome: "YES", side: orderSide, remainingQty: quantity };
    if (!governor.allowedActions.includes(action)) return false;
    const reduceCheck = reduceOnlySafe(governor, existingExposure, existingExposure.current.directionalBalance, action, quantity);
    if (!reduceCheck.permitted) return false;
    const projection = createProjectedExposure(inventory, pendingOrders, [...combinedOrders, { outcome: "YES", side: orderSide, remainingQtyRaw: quantityRaw }], grid);
    return projectionIsSafe(projection, governor.limits);
  }

  let lo = 0n;
  let hi = upper / grid.lotSizeRaw;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (safe(mid * grid.lotSizeRaw)) lo = mid;
    else hi = mid - 1n;
  }
  const quantityRaw = lo * grid.lotSizeRaw;
  if (quantityRaw < grid.minQuantityRaw) {
    if (side === "bid" && capitalAvailableRaw - reserveRaw < ceilCost(priceRaw, grid.minQuantityRaw, grid.oneRaw)) return { quantityRaw: 0n, code: "INSUFFICIENT_COLLATERAL" };
    if (side === "ask" && inventory.yesAvailable < grid.minQuantityRaw) return { quantityRaw: 0n, code: "NO_SELL_INVENTORY" };
    return { quantityRaw: 0n, code: "RISK_HEADROOM" };
  }
  const finalOrder = { outcome: "YES", side: orderSide, remainingQtyRaw: quantityRaw };
  const projection = createProjectedExposure(inventory, pendingOrders, [...combinedOrders, finalOrder], grid);
  const reason = side === "bid"
    ? ceilCost(priceRaw, quantityRaw, grid.oneRaw) + reserveRaw > capitalAvailableRaw ? "INSUFFICIENT_COLLATERAL" : null
    : quantityRaw < upper ? "RISK_HEADROOM" : null;
  return { quantityRaw, projection, code: reason };
}

function composeSide(side, priceInfo, desiredQuantityRaw, fit, spread, size, center, grid, book, inventory, reasons, existingExposure, combinedOrders) {
  const result = makeSideSkeleton(side === "bid" ? ACTIONS.bid : ACTIONS.ask);
  if (priceInfo.priceRaw === null) {
    quoteReasonForUnavailable(result, priceInfo.reason ?? "PRICE_BOUND");
    return result;
  }
  if (fit.quantityRaw <= 0n) {
    quoteReasonForUnavailable(result, fit.code ?? "MIN_QUANTITY_UNMET");
    result.inventoryAvailableRaw = side === "ask" ? jsonRaw(inventory.yesAvailable) : null;
    return result;
  }
  const price = rawToHuman(priceInfo.priceRaw, grid.oneRaw);
  const projection = fit.projection ?? createProjectedExposure(inventory, [], combinedOrders, grid);
  result.enabled = true;
  result.targetPriceRaw = jsonRaw(priceInfo.priceRaw);
  result.targetPrice = price;
  result.targetQuantityRaw = jsonRaw(fit.quantityRaw);
  result.targetQuantity = rawToHuman(fit.quantityRaw, grid.oneRaw);
  result.collateralRequiredRaw = side === "bid" ? jsonRaw(ceilCost(priceInfo.priceRaw, fit.quantityRaw, grid.oneRaw)) : "0";
  result.inventoryAvailableRaw = side === "ask" ? jsonRaw(inventory.yesAvailable) : null;
  result.projectedExposure = projection;
  result.rationale = buildRationale({
    side,
    effectiveCenter: center,
    theoreticalPrice: rawToHuman(side === "bid" ? priceInfo.theoreticalRaw : priceInfo.theoreticalRaw, grid.oneRaw),
    finalPrice: price,
    desiredQuantityRaw,
    finalQuantityRaw: fit.quantityRaw,
    spread,
    size,
    exposure: projection,
    priceClipped: priceInfo.clipped,
  });
  if (fit.code) addReason(result.reasonCodes, fit.code);
  if (priceInfo.clipped) addReason(result.reasonCodes, "POST_ONLY_CONSTRAINT");
  return result;
}

function attachTheoretical(priceInfo, theoreticalRaw) {
  return { ...priceInfo, theoreticalRaw };
}

/**
 * Plan one YES bid and/or YES ask. The return value is always a structured
 * result; malformed market/model inputs refuse to quote instead of becoming a
 * neutral 50/50 decision.
 */
export function planQuotes(input = {}, suppliedConfig = DEFAULT_QUOTE_CONFIG) {
  let config;
  try {
    config = validateQuoteConfig(suppliedConfig);
    const fair = normalizeFairValue(input.fairValue);
    const grid = normalizeGrid(input.grid);
    const bounds = normalizePriceBounds(input.market ?? {}, grid);
    const book = normalizeBook(input.book ?? {}, grid, bounds);
    const inventory = normalizeInventory(input.inventory ?? {}, grid);
    const pendingOrders = normalizePendingOrders(input.pendingOrders ?? input.openOrders);
    const governor = normalizeGovernor(input);
    const market = input.market ?? {};
    const timeRemainingSec = market.timeRemainingSec ?? fair.timeRemainingSec;
    if (!finite(timeRemainingSec) || timeRemainingSec <= 0) return noQuoteOutput(["EXPIRED"], [], { fairValue: fair, plannerVersion: QUOTE_PLANNER_VERSION });
    if (fair.timeRemainingSec !== undefined && finite(fair.timeRemainingSec) && Math.abs(fair.timeRemainingSec - timeRemainingSec) > 1) return noQuoteOutput(["INPUT_INVALID"], ["FAIR_VALUE_TIME_MISMATCH"], { fairValue: fair, plannerVersion: QUOTE_PLANNER_VERSION });
    const quote = input.quote ?? {};
    const baseQuantityRaw = normalizeQuantity(quote.baseQuantityRaw ?? quote.baseQuantity, grid, "quote.baseQuantity");
    if (baseQuantityRaw === null || baseQuantityRaw <= 0n) return noQuoteOutput(["INPUT_INVALID"], [], { fairValue: fair, plannerVersion: QUOTE_PLANNER_VERSION });
    const capitalAvailableRaw = input.capital?.collateralAvailableRaw !== undefined
      ? parseRawInteger(input.capital.collateralAvailableRaw, "capital.collateralAvailableRaw")
      : decimalToRaw(input.capital?.collateralAvailable, grid.decimals, "nearest", "capital.collateralAvailable");
    const reserveRaw = input.capital?.collateralReserveRaw !== undefined
      ? parseRawInteger(input.capital.collateralReserveRaw, "capital.collateralReserveRaw")
      : decimalToRaw(input.capital?.collateralReserve ?? 0, grid.decimals, "nearest", "capital.collateralReserve");
    if (reserveRaw > capitalAvailableRaw) return noQuoteOutput(["COLLATERAL_RESERVE"], [], { fairValue: fair, plannerVersion: QUOTE_PLANNER_VERSION });

    const exposure = calculateBinaryExposure({
      yes: rawToHuman(inventory.yes, grid.oneRaw),
      no: rawToHuman(inventory.no, grid.oneRaw),
      openOrders: pendingOrders,
    });
    const directionalBalance = exposure.current.directionalBalance;
    const skewRatio = clamp(directionalBalance / governor.riskCapacity, -1, 1);
    const inventorySkew = directionalBalance === 0 ? 0 : -skewRatio * config.maxInventorySkew;
    const fairCenter = fair.pUp;
    const effectiveCenter = clamp(fairCenter + inventorySkew, rawToHuman(bounds.minRaw, grid.oneRaw), rawToHuman(bounds.maxRaw, grid.oneRaw));
    const remainingLogMove = fair.realizedVolPerSqrtSec * Math.sqrt(timeRemainingSec);
    if (!finite(remainingLogMove) || remainingLogMove < 0) return noQuoteOutput(["FAIR_VALUE_INVALID"], [], { fairValue: fair, plannerVersion: QUOTE_PLANNER_VERSION });
    const expiryFactor = clamp((config.expiryReferenceSec - timeRemainingSec) / config.expiryReferenceSec, 0, 1);
    const confidenceFactor = clamp((config.idealConfidence - fair.confidence) / (config.idealConfidence - config.confidenceFloor), 0, 1);
    const volatilityAdjustment = config.volatilitySpreadMultiplier * remainingLogMove;
    const expiryAdjustment = config.maxExpiryHalfSpreadAdd * expiryFactor;
    const confidenceAdjustment = config.maxConfidenceHalfSpreadAdd * confidenceFactor;
    const finalHalfSpread = Math.min(config.maxHalfSpread, config.baseHalfSpread + volatilityAdjustment + expiryAdjustment + confidenceAdjustment);
    const confidenceSizeFactor = 1 - (1 - config.minSizeFactor) * confidenceFactor;
    const volatilitySizeFactor = 1 / (1 + config.volatilitySizeMultiplier * remainingLogMove);
    const expirySizeFactor = 1 - config.expirySizeReduction * expiryFactor;
    const riskSizeFactor = governor.state === "ALLOW" ? governor.sizeMultiplier : governor.state === "REDUCE_ONLY" ? 1 : 0;
    const finalSizeMultiplier = Math.min(riskSizeFactor, confidenceSizeFactor, volatilitySizeFactor, expirySizeFactor);
    const size = { baseQuantityRaw, confidenceSizeFactor, volatilitySizeFactor, expirySizeFactor, riskSizeFactor, finalMultiplier: finalSizeMultiplier };
    const spread = { baseHalfSpread: config.baseHalfSpread, volatilityAdjustment, expiryAdjustment, confidenceAdjustment, finalHalfSpread, remainingLogMove, expiryFactor, confidenceFactor };
    const shared = {
      plannerVersion: QUOTE_PLANNER_VERSION,
      marketId: market.marketId ?? null,
      plan: "NO_QUOTE",
      fairValue: {
        pUp: fair.pUp,
        pDown: 1 - fair.pUp,
        confidence: fair.confidence,
        dataQualityStatus: fair.dataQualityStatus,
        modelVersion: fair.modelVersion ?? null,
        currentUnderlyingPrice: fair.currentUnderlyingPrice ?? null,
        referencePrice: fair.referencePrice ?? null,
        referenceSource: fair.referenceSource ?? null,
        timeRemainingSec,
        realizedVolPerSqrtSec: fair.realizedVolPerSqrtSec,
      },
      center: { fairCenter, inventorySkew, effectiveCenter, directionalBalance, riskCapacity: governor.riskCapacity },
      spread,
      size: { ...size, baseQuantityRaw: jsonRaw(baseQuantityRaw) },
      governor: {
        state: governor.state,
        triggeredRules: [...(governor.triggeredRules ?? [])],
        warnings: [...(governor.warnings ?? [])],
        allowedActions: [...governor.allowedActions],
        maxAdditionalExposure: governor.maxAdditionalExposure ?? null,
      },
      exposure,
      warnings: [],
      reasonCodes: [],
    };
    const bid = makeSideSkeleton(ACTIONS.bid);
    const ask = makeSideSkeleton(ACTIONS.ask);
    if (governor.state === "HALT") {
      addReason(shared.reasonCodes, "GOVERNOR_HALT");
      shared.reasonCodes.push(...(governor.triggeredRules ?? []));
      quoteReasonForUnavailable(bid, "GOVERNOR_HALT");
      quoteReasonForUnavailable(ask, "GOVERNOR_HALT");
      return { ...shared, bid, ask, plan: "NO_QUOTE" };
    }
    if (governor.state === "REDUCE_ONLY") addReason(shared.reasonCodes, "GOVERNOR_REDUCE_ONLY");
    if (directionalBalance !== 0) addReason(shared.reasonCodes, "INVENTORY_SKEW");
    if (volatilityAdjustment > 0) addReason(shared.reasonCodes, "VOLATILITY_WIDENED");
    if (confidenceAdjustment > 0) addReason(shared.reasonCodes, "LOW_CONFIDENCE_WIDENED");
    if (expiryAdjustment > 0) addReason(shared.reasonCodes, "EXPIRY_WIDENED");
    if (pendingOrders.length > 0) addReason(shared.reasonCodes, "PENDING_ORDER_STRESS");
    const theoreticalBidRaw = decimalToRaw(clamp(effectiveCenter - finalHalfSpread, rawToHuman(bounds.minRaw, grid.oneRaw), rawToHuman(bounds.maxRaw, grid.oneRaw)), grid.decimals, "nearest", "theoretical bid");
    const theoreticalAskRaw = decimalToRaw(clamp(effectiveCenter + finalHalfSpread, rawToHuman(bounds.minRaw, grid.oneRaw), rawToHuman(bounds.maxRaw, grid.oneRaw)), grid.decimals, "nearest", "theoretical ask");
    const bidPrice = attachTheoretical(prepareSidePrice("bid", theoreticalBidRaw, book, grid, bounds, shared.reasonCodes), theoreticalBidRaw);
    const askPrice = attachTheoretical(prepareSidePrice("ask", theoreticalAskRaw, book, grid, bounds, shared.reasonCodes), theoreticalAskRaw);
    const desiredQuantityRaw = floorGrid(scaleRaw(baseQuantityRaw, finalSizeMultiplier), grid.lotSizeRaw);
    const bidAllowed = governor.state === "ALLOW" || (governor.state === "REDUCE_ONLY" && directionalBalance < 0);
    const askAllowed = governor.state === "ALLOW" || (governor.state === "REDUCE_ONLY" && directionalBalance > 0);
    let bidFit = { quantityRaw: 0n, code: null };
    let askFit = { quantityRaw: 0n, code: null };
    if (governor.state === "REDUCE_ONLY" && directionalBalance === 0) addReason(shared.reasonCodes, "NO_REDUCE_ONLY_DIRECTION");
    if (bidAllowed && governor.allowedActions.includes(ACTIONS.bid) && finalSizeMultiplier > 0 && bidPrice.priceRaw !== null) bidFit = fitQuantity({ desiredRaw: desiredQuantityRaw, side: "bid", priceRaw: bidPrice.priceRaw, inventory, pendingOrders, existingExposure: exposure, governor, grid, capitalAvailableRaw, reserveRaw, bounds });
    else if (!governor.allowedActions.includes(ACTIONS.bid) || (governor.state === "REDUCE_ONLY" && directionalBalance >= 0)) bidFit.code = governor.state === "REDUCE_ONLY" && directionalBalance === 0 ? "NO_REDUCE_ONLY_DIRECTION" : "ACTION_NOT_PERMITTED";
    else if (bidPrice.priceRaw === null) bidFit.code = bidPrice.reason ?? "PRICE_BOUND";
    else if (finalSizeMultiplier <= 0) bidFit.code = "MIN_QUANTITY_UNMET";
    if (askAllowed && governor.allowedActions.includes(ACTIONS.ask) && finalSizeMultiplier > 0 && askPrice.priceRaw !== null) askFit = fitQuantity({ desiredRaw: desiredQuantityRaw, side: "ask", priceRaw: askPrice.priceRaw, inventory, pendingOrders, existingExposure: exposure, governor, grid, capitalAvailableRaw, reserveRaw, bounds });
    else if (!governor.allowedActions.includes(ACTIONS.ask) || (governor.state === "REDUCE_ONLY" && directionalBalance <= 0)) askFit.code = governor.state === "REDUCE_ONLY" && directionalBalance === 0 ? "NO_REDUCE_ONLY_DIRECTION" : "ACTION_NOT_PERMITTED";
    else if (askPrice.priceRaw === null) askFit.code = askPrice.reason ?? "PRICE_BOUND";
    else if (finalSizeMultiplier <= 0) askFit.code = "MIN_QUANTITY_UNMET";

    let selectedBid = bidFit.quantityRaw > 0n ? { outcome: "YES", side: "BUY", remainingQtyRaw: bidFit.quantityRaw } : null;
    if (selectedBid && askFit.quantityRaw > 0n) {
      const combinedAskFit = fitQuantity({ desiredRaw: askFit.quantityRaw, side: "ask", priceRaw: askPrice.priceRaw, inventory, pendingOrders, existingExposure: exposure, governor, grid, capitalAvailableRaw, reserveRaw, bounds, combinedOrders: [selectedBid] });
      askFit = combinedAskFit;
    }
    const combinedOrders = [
      ...(selectedBid ? [selectedBid] : []),
      ...(askFit.quantityRaw > 0n ? [{ outcome: "YES", side: "SELL", remainingQtyRaw: askFit.quantityRaw }] : []),
    ];
    const combinedProjection = combinedOrders.length > 0 ? createProjectedExposure(inventory, pendingOrders, combinedOrders, grid) : null;
    if (combinedProjection && !projectionIsSafe(combinedProjection, governor.limits)) {
      if (askFit.quantityRaw > 0n) askFit = { quantityRaw: 0n, code: "RISK_HEADROOM" };
      else if (selectedBid) selectedBid = null;
    }
    if (bidAllowed && bidPrice.priceRaw !== null && bidFit.quantityRaw > 0n && selectedBid) {
      const projection = createProjectedExposure(inventory, pendingOrders, [selectedBid], grid);
      Object.assign(bidFit, { projection });
    }
    const finalCombinedOrders = [
      ...(selectedBid ? [selectedBid] : []),
      ...(askFit.quantityRaw > 0n ? [{ outcome: "YES", side: "SELL", remainingQtyRaw: askFit.quantityRaw }] : []),
    ];
    const finalCombinedProjection = finalCombinedOrders.length > 0
      ? createProjectedExposure(inventory, pendingOrders, finalCombinedOrders, grid)
      : null;
    if (finalCombinedOrders.length > 0) {
      if (!projectionIsSafe(finalCombinedProjection, governor.limits)) {
        if (selectedBid) bidFit = { quantityRaw: 0n, code: "RISK_HEADROOM" };
        if (askFit.quantityRaw > 0n) askFit = { quantityRaw: 0n, code: "RISK_HEADROOM" };
      }
    }
    const outputOrders = [
      ...(selectedBid ? [selectedBid] : []),
      ...(askFit.quantityRaw > 0n ? [{ outcome: "YES", side: "SELL", remainingQtyRaw: askFit.quantityRaw }] : []),
    ];
    const outputProjection = outputOrders.length > 0
      ? createProjectedExposure(inventory, pendingOrders, outputOrders, grid)
      : null;
    const builtBid = composeSide("bid", bidPrice, desiredQuantityRaw, selectedBid ? { ...bidFit, quantityRaw: selectedBid.remainingQtyRaw, projection: outputProjection ?? createProjectedExposure(inventory, pendingOrders, [selectedBid], grid) } : { quantityRaw: 0n, code: bidFit.code ?? "MIN_QUANTITY_UNMET" }, spread, size, effectiveCenter, grid, book, inventory, shared.reasonCodes, exposure, outputOrders);
    const builtAsk = composeSide("ask", askPrice, desiredQuantityRaw, askFit.quantityRaw > 0n ? { ...askFit, projection: outputProjection ?? askFit.projection } : askFit, spread, size, effectiveCenter, grid, book, inventory, shared.reasonCodes, exposure, outputOrders);
    const reasonCodes = [...new Set([...shared.reasonCodes, ...builtBid.reasonCodes, ...builtAsk.reasonCodes])];
    const enabledCount = Number(builtBid.enabled) + Number(builtAsk.enabled);
    return { ...shared, plan: enabledCount === 2 ? "ACTIVE" : enabledCount === 1 ? "ONE_SIDED" : "NO_QUOTE", bid: builtBid, ask: builtAsk, reasonCodes: reasonCodes.length ? reasonCodes : ["NONE"] };
  } catch (err) {
    const code = err instanceof QuotePlannerError ? err.code : "INPUT_INVALID";
    return noQuoteOutput([code], [], { plannerVersion: QUOTE_PLANNER_VERSION, error: err?.message ?? String(err) });
  }
}
