/**
 * Pure capital-floor arithmetic for the bounded Phase 3B1B proof.
 *
 * This module intentionally knows nothing about RPC, wallets, accounts, or
 * writers. It keeps the deposit floor, strategy floor, and test-cap proposal
 * as separate concepts and reports current-cap violations instead of silently
 * raising the live policy.
 */

import { decimalToRaw } from "../quote-planner/index.mjs";
import { DEFAULT_PHASE_3B1_CAPS } from "./lp-transaction-policy.mjs";

export const LP_CAPITAL_CALIBRATION_VERSION = "villa-lp-capital-calibration-v1";
// Historical Phase 3B1A.4 baseline. Keep it explicit so that re-running the
// calibration still reports the before/after policy boundary after activation.
export const PHASE_3B1A4_BASELINE_CAPITAL_RAW = 1_000_000n;
export const CALIBRATION_CANDIDATES_TUSDC = Object.freeze([
  "1.001",
  "1.002",
  "1.005",
  "1.010",
  "1.025",
  "1.050",
  "1.100",
  "1.250",
]);

export const NON_CAPITAL_CAP_KEYS = Object.freeze([
  "MAX_ORDER_NOTIONAL",
  "MAX_OPEN_ORDERS",
  "MAX_PENDING_EXPOSURE",
  "MAX_MINT_AMOUNT",
  "MAX_SESSION_DURATION_SEC",
  "MAX_TX_COUNT",
]);

function raw(value, label, { positive = false } = {}) {
  let result;
  try { result = typeof value === "bigint" ? value : BigInt(String(value)); } catch { throw new Error(`${label} must be an integer raw value`); }
  if (result < 0n || (positive && result === 0n)) throw new Error(`${label} must be ${positive ? "positive" : "non-negative"}`);
  return result;
}

function unique(values) {
  return [...new Set(values)];
}

function human(rawValue, decimals) {
  return Number(rawValue) / 10 ** decimals;
}

function ceilCost(priceRaw, quantityRaw, oneRaw) {
  return (priceRaw * quantityRaw + oneRaw - 1n) / oneRaw;
}

function path(rawRequired, feasible, reason, components) {
  return Object.freeze({
    feasible: feasible === true,
    requiredCapitalRaw: rawRequired,
    requiredCapital: human(rawRequired, components.decimals),
    reason: reason ?? null,
    components: Object.freeze(components),
  });
}

/**
 * Derive both capital paths from exact six-decimal raw-unit components.
 *
 * BUY-only requires reserve + DreamDEX-held collateral + BUY order escrow.
 * MINT+SELL requires reserve + DreamDEX-held collateral + the complete-set
 * mint. A SELL does not add collateral escrow; its inventory requirement is
 * represented separately and must be satisfied by current inventory or M.
 * Safety margin is deliberately an explicit input and is zero for the
 * mathematical floor.
 */
export function deriveCapitalEquation({
  decimals = 6,
  collateralReserveRaw,
  minimumMintRaw = 0n,
  buyPriceRaw = null,
  buyQuantityRaw = 0n,
  dreamDexReservedCollateralRaw = 0n,
  safetyMarginRaw = 0n,
  buyFeasible = false,
  mintSellFeasible = false,
  inventoryRequiredRaw = minimumMintRaw,
  currentInventoryRaw = 0n,
} = {}) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("decimals must be an integer from 0 to 18");
  const oneRaw = 10n ** BigInt(decimals);
  const reserve = raw(collateralReserveRaw, "collateralReserveRaw");
  const minimumMint = raw(minimumMintRaw, "minimumMintRaw");
  const dreamDexReserved = raw(dreamDexReservedCollateralRaw, "dreamDexReservedCollateralRaw");
  const safety = raw(safetyMarginRaw, "safetyMarginRaw");
  const currentInventory = raw(currentInventoryRaw, "currentInventoryRaw");
  const inventoryRequired = raw(inventoryRequiredRaw, "inventoryRequiredRaw");
  const buyQuantity = raw(buyQuantityRaw, "buyQuantityRaw");
  const buyPrice = buyPriceRaw === null || buyPriceRaw === undefined ? null : raw(buyPriceRaw, "buyPriceRaw", { positive: true });
  const buyEscrow = buyPrice === null || buyQuantity === 0n ? 0n : ceilCost(buyPrice, buyQuantity, oneRaw);
  const buyComponents = {
    decimals,
    oneRaw,
    reserveRaw: reserve,
    dreamDexReservedCollateralRaw: dreamDexReserved,
    buyOrderCollateralRaw: buyEscrow,
    minimumMintRaw: 0n,
    inventoryRequiredRaw: 0n,
    currentInventoryRaw: currentInventory,
    roundingRaw: buyEscrow - (buyPrice === null ? 0n : (buyPrice * buyQuantity) / oneRaw),
    safetyMarginRaw: safety,
  };
  const mintSellInventoryGap = inventoryRequired > currentInventory ? inventoryRequired - currentInventory : 0n;
  const mintRequired = mintSellInventoryGap > minimumMint ? mintSellInventoryGap : minimumMint;
  const mintSellComponents = {
    decimals,
    oneRaw,
    reserveRaw: reserve,
    dreamDexReservedCollateralRaw: dreamDexReserved,
    buyOrderCollateralRaw: 0n,
    minimumMintRaw: mintRequired,
    inventoryRequiredRaw: inventoryRequired,
    currentInventoryRaw: currentInventory,
    roundingRaw: 0n,
    safetyMarginRaw: safety,
  };
  const buyRequired = reserve + dreamDexReserved + buyEscrow + safety;
  const mintSellRequired = reserve + dreamDexReserved + mintRequired + safety;
  const buyPath = path(buyRequired, buyFeasible, buyFeasible ? null : "BUY path is not feasible under the supplied account/quote facts", buyComponents);
  const mintSellPath = path(mintSellRequired, mintSellFeasible, mintSellFeasible ? null : "MINT+SELL path is not feasible under the supplied account/quote facts", mintSellComponents);
  const feasibleRequirements = [buyPath, mintSellPath].filter((item) => item.feasible).map((item) => item.requiredCapitalRaw);
  const mathematicalMinimumRaw = feasibleRequirements.length ? feasibleRequirements.reduce((lowest, item) => item < lowest ? item : lowest) : null;
  return Object.freeze({
    version: LP_CAPITAL_CALIBRATION_VERSION,
    decimals,
    oneRaw,
    paths: Object.freeze({ buyOnly: buyPath, mintSell: mintSellPath }),
    inventory: Object.freeze({ currentRaw: currentInventory, requiredRaw: inventoryRequired, gapRaw: mintSellInventoryGap, minimumMintRaw: mintRequired }),
    mathematicalMinimumRaw,
    mathematicalMinimum: mathematicalMinimumRaw === null ? null : human(mathematicalMinimumRaw, decimals),
  });
}

/** Convert the requested human candidate list using exact decimal parsing. */
export function calibrationCandidatesRaw({ decimals = 6, values = CALIBRATION_CANDIDATES_TUSDC } = {}) {
  return Object.freeze(values.map((value) => ({
    tUSDC: String(value),
    raw: decimalToRaw(String(value), decimals, "nearest", "capital candidate"),
  })));
}

/**
 * Summarize one simulated balance. `strategyFeasible` must already include
 * the real governor, planner, account limits, sequence, and non-capital caps.
 * The current cap is reported independently so a proposed replacement cap is
 * never mistaken for an activated policy.
 */
export function evaluateCapitalCandidate({
  capitalRaw,
  mathematicalMinimumRaw,
  recommendedCapitalRaw,
  currentCapitalCapRaw = DEFAULT_PHASE_3B1_CAPS.MAX_ACCOUNT_CAPITAL,
  strategyFeasible = false,
  currentCapsNonCapitalPass = false,
  path = null,
  reasonCodes = [],
} = {}) {
  const capital = raw(capitalRaw, "capitalRaw");
  const mathematical = mathematicalMinimumRaw === null || mathematicalMinimumRaw === undefined ? null : raw(mathematicalMinimumRaw, "mathematicalMinimumRaw");
  const recommended = recommendedCapitalRaw === null || recommendedCapitalRaw === undefined ? null : raw(recommendedCapitalRaw, "recommendedCapitalRaw");
  const currentCap = raw(currentCapitalCapRaw, "currentCapitalCapRaw");
  const currentCapitalPass = capital <= currentCap;
  const mathematicalPass = mathematical !== null && capital >= mathematical;
  const recommendedPass = recommended !== null && capital >= recommended;
  const reasons = [...reasonCodes];
  if (!currentCapitalPass) reasons.push("ACCOUNT_CAPITAL_CAP");
  if (!mathematicalPass) reasons.push("BELOW_MATHEMATICAL_FLOOR");
  if (!strategyFeasible) reasons.push("STRATEGY_NOT_FEASIBLE");
  return Object.freeze({
    capitalRaw: capital,
    mathematicalMinimumRaw: mathematical,
    recommendedCapitalRaw: recommended,
    path,
    mathematicalPass,
    recommendedPass,
    strategyFeasible: strategyFeasible === true,
    currentCapitalPass,
    currentCapsNonCapitalPass: currentCapsNonCapitalPass === true,
    currentCapsPass: strategyFeasible === true && currentCapitalPass && currentCapsNonCapitalPass === true,
    proposedReplacementCapPass: strategyFeasible === true && currentCapsNonCapitalPass === true,
    reasons: Object.freeze(unique(reasons)),
  });
}

/** Return a non-capital cap projection without changing the live cap object. */
export function compareLockedCaps(caps = DEFAULT_PHASE_3B1_CAPS, expected = DEFAULT_PHASE_3B1_CAPS) {
  const differences = NON_CAPITAL_CAP_KEYS.filter((key) => String(caps[key]) !== String(expected[key]));
  return Object.freeze({ pass: differences.length === 0, differences: Object.freeze(differences), values: Object.freeze(Object.fromEntries(NON_CAPITAL_CAP_KEYS.map((key) => [key, caps[key]]))) });
}
