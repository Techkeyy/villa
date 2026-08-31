/**
 * Pure post-mint quote feasibility for the bounded first LP cycle.
 *
 * This module never reads chain state and never creates a write. Callers give
 * it a current snapshot, a projected quote/risk result, and (optionally) the
 * result of validating the unsigned sequence. Keeping the projection here
 * makes the planner's circular dependency explicit instead of hiding a mint
 * behind the normal pre-mint NO_QUOTE result.
 */

import { DEFAULT_PHASE_3B1_CAPS } from "./lp-transaction-policy.mjs";
import { DEFAULT_RISK_CONFIG } from "../risk-governor/config.mjs";

export const LP_QUOTE_FEASIBILITY_VERSION = "villa-lp-quote-feasibility-v1";

function raw(value, label, { positive = false } = {}) {
  let result;
  try { result = typeof value === "bigint" ? value : BigInt(String(value)); } catch { throw new Error(`${label} must be an integer raw value`); }
  if (result < 0n || (positive && result === 0n)) throw new Error(`${label} must be ${positive ? "positive" : "non-negative"}`);
  return result;
}

function integer(value, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return result;
}

function uniqueReasons(reasons) {
  const seen = new Set();
  return reasons.filter((item) => {
    const code = typeof item === "string" ? item : item?.code;
    if (!code || seen.has(code)) return false;
    seen.add(code);
    return true;
  });
}

function reason(code, message) {
  return { code, reason: message };
}

function rawOrNull(value, label) {
  if (value === null || value === undefined) return null;
  try { return raw(value, label, { positive: true }); } catch { return null; }
}

function decimalRaw(value, decimals = 6) {
  return raw(Math.round(Number(value) * 10 ** decimals), "book price", { positive: true });
}

function sideEntries(quotePlan) {
  return ["bid", "ask"].map((name) => ({ name, side: quotePlan?.[name] })).filter(({ side }) => side?.enabled === true);
}

function marketBookPrice(market, side) {
  const rows = side === "BUY_YES" ? market?.book?.asks : market?.book?.bids;
  const value = rows?.[0]?.[0];
  return value === undefined || value === null ? null : decimalRaw(value);
}

/** Project account balances after a planning-only complete-set mint. */
export function projectLpState({ collateralRaw, yesRaw, noRaw, mintAmountRaw = 0n } = {}) {
  const collateral = raw(collateralRaw, "collateralRaw");
  const yes = raw(yesRaw, "yesRaw");
  const no = raw(noRaw, "noRaw");
  const mint = raw(mintAmountRaw, "mintAmountRaw");
  if (mint > collateral) throw new Error("mintAmountRaw cannot exceed projected collateral");
  return Object.freeze({
    projected: mint > 0n,
    collateralRaw: collateral - mint,
    yesRaw: yes + mint,
    noRaw: no + mint,
    mintAmountRaw: mint,
    source: Object.freeze({ collateralRaw: collateral, yesRaw: yes, noRaw: no }),
  });
}

/** Generate every lot-aligned candidate from the venue minimum to the cap. */
export function generateMintCandidates({ minimumAmountRaw, maximumAmountRaw = DEFAULT_PHASE_3B1_CAPS.MAX_MINT_AMOUNT, stepRaw = minimumAmountRaw } = {}) {
  const minimum = raw(minimumAmountRaw, "minimumAmountRaw", { positive: true });
  const maximum = raw(maximumAmountRaw, "maximumAmountRaw", { positive: true });
  const step = raw(stepRaw, "stepRaw", { positive: true });
  if (minimum > maximum) return Object.freeze([]);
  const values = [];
  for (let value = minimum; value <= maximum; value += step) values.push(value);
  if (values[values.length - 1] !== maximum && maximum > values[values.length - 1] && maximum % step === 0n) values.push(maximum);
  return Object.freeze(values);
}

/**
 * Validate a projected quote against the same bounded policy dimensions used
 * by the normal quote plan. This does not replace planQuotes or transaction
 * policy validation; it proves the projected result remains inside them.
 */
export function validateProjectedQuote({ riskDecision, quotePlan, quoteExecution = {}, market, pendingOrderCount = 0, pendingExposureRaw = 0n, accountMaxOrderQuantityRaw = null, accountMaxOrderCollateralRaw = null, caps = DEFAULT_PHASE_3B1_CAPS } = {}) {
  const reasons = [];
  const sides = sideEntries(quotePlan);
  const accountMaxQuantity = rawOrNull(accountMaxOrderQuantityRaw, "accountMaxOrderQuantityRaw");
  const accountMaxCollateral = rawOrNull(accountMaxOrderCollateralRaw, "accountMaxOrderCollateralRaw");
  if (riskDecision?.state === "HALT") reasons.push(reason("RISK_HALTED", "projected collateral or another risk rule halts the projected state"));
  if (!quotePlan || quotePlan.plan === "NO_QUOTE") reasons.push(reason("PROJECTED_NO_QUOTE", `projected quote planner returned NO_QUOTE${quotePlan?.reasonCodes?.length ? ` (${quotePlan.reasonCodes.join(", ")})` : ""}`));
  if (quoteExecution.postOnly !== true || Number(quoteExecution.orderType) !== 3) reasons.push(reason("POST_ONLY_NOT_PROVEN", "projected quote is not explicitly bounded post-only"));
  if (quoteExecution.policyValid !== true) reasons.push(reason("POLICY_QUOTE_NOT_PROVEN", "projected quote has not passed the account transaction policy"));
  if (integer(pendingOrderCount, "pendingOrderCount") + sides.length > caps.MAX_OPEN_ORDERS) reasons.push(reason("OPEN_ORDER_CAP", "projected quote exceeds the open-order cap"));

  let totalQuantity = raw(pendingExposureRaw, "pendingExposureRaw");
  for (const { name, side } of sides) {
    const price = rawOrNull(side.targetPriceRaw, `${name}.targetPriceRaw`);
    const quantity = rawOrNull(side.targetQuantityRaw, `${name}.targetQuantityRaw`);
    if (price === null || quantity === null) {
      reasons.push(reason("QUOTE_SIDE_INVALID", `${name} has no positive raw price and quantity`));
      continue;
    }
    totalQuantity += quantity;
    const tick = rawOrNull(market?.grid?.tickSizeRaw ?? market?.grid?.tickSize, "tickSizeRaw");
    const lot = rawOrNull(market?.grid?.lotSizeRaw ?? market?.grid?.lotSize, "lotSizeRaw");
    const minimum = rawOrNull(market?.minimumOrderRaw ?? market?.grid?.minQuantityRaw ?? market?.grid?.minQuantity, "minimumOrderRaw");
    if (tick === null || lot === null || minimum === null) reasons.push(reason("VENUE_GRID_INVALID", "projected quote is missing venue tick, lot, or minimum"));
    else {
      if (price % tick !== 0n) reasons.push(reason("PRICE_OFF_GRID", `${name} price is off the venue tick grid`));
      if (quantity % lot !== 0n) reasons.push(reason("QUANTITY_OFF_GRID", `${name} quantity is off the venue lot grid`));
      if (quantity < minimum) reasons.push(reason("MIN_QUANTITY_UNMET", `${name} quantity is below the venue minimum`));
    }
    if (price <= 0n || price >= 1_000_000n) reasons.push(reason("PRICE_INVALID", `${name} price is outside the binary range`));
    if (quantity > caps.MAX_ORDER_NOTIONAL) reasons.push(reason("ORDER_NOTIONAL_CAP", `${name} quantity exceeds the bounded order cap`));
    if (accountMaxQuantity !== null && quantity > accountMaxQuantity) reasons.push(reason("ACCOUNT_ORDER_QUANTITY_LIMIT", `${name} quantity exceeds VillaAccount.maxOrderQuantity`));
    const oneRaw = rawOrNull(market?.grid?.oneRaw ?? 1_000_000n, "oneRaw") ?? 1_000_000n;
    const collateralRequired = side.action?.startsWith("BUY") ? (price * quantity + oneRaw - 1n) / oneRaw : 0n;
    if (accountMaxCollateral !== null && collateralRequired > accountMaxCollateral) reasons.push(reason("ACCOUNT_ORDER_COLLATERAL_LIMIT", `${name} collateral exceeds VillaAccount.maxOrderCollateral`));
    if (!riskDecision?.permissions?.allowedActions?.includes(side.action)) reasons.push(reason("RISK_ACTION_NOT_ALLOWED", `${name} action is not allowed by the projected governor`));
    const comparison = marketBookPrice(market, side.action);
    if (comparison !== null) {
      if (side.action?.startsWith("BUY") && price >= comparison) reasons.push(reason("POST_ONLY_WOULD_CROSS", `${name} would cross the live best ask`));
      if (side.action?.startsWith("SELL") && price <= comparison) reasons.push(reason("POST_ONLY_WOULD_CROSS", `${name} would cross the live best bid`));
    }
    const worst = side.projectedExposure?.worstCase;
    const limits = quotePlan?.governor?.limits ?? riskDecision?.exposureLimits ?? riskDecision?.limits ?? {
      directionalExposureHard: DEFAULT_RISK_CONFIG.directionalExposureHard,
      grossExposureHard: DEFAULT_RISK_CONFIG.grossExposureHard,
    };
    if (worst && (worst.directionalUp >= limits.directionalExposureHard || worst.directionalDown >= limits.directionalExposureHard || worst.grossOutcome >= limits.grossExposureHard)) reasons.push(reason("RISK_HEADROOM", `${name} projected exposure reaches a hard governor limit`));
  }
  if (totalQuantity > caps.MAX_PENDING_EXPOSURE) reasons.push(reason("PENDING_EXPOSURE_CAP", "projected quote quantity exceeds the pending-exposure cap"));
  if (sides.length === 0) reasons.push(reason("NO_POST_ONLY_ORDER", "projected quote has no enabled side"));
  return Object.freeze({ valid: uniqueReasons(reasons).length === 0, reasons: Object.freeze(uniqueReasons(reasons)), enabledSides: Object.freeze(sides.map(({ name, side }) => ({ name, action: side.action, priceRaw: String(side.targetPriceRaw), quantityRaw: String(side.targetQuantityRaw) }))), pendingExposureRaw: totalQuantity.toString() });
}

/**
 * Evaluate one hypothetical mint. `evaluateProjectedState` is supplied by the
 * live read-only probe so the pure module does not own model/risk construction.
 */
export function evaluateMintCandidate({ collateralRaw, yesRaw, noRaw, mintAmountRaw, minimumMintRaw, caps = DEFAULT_PHASE_3B1_CAPS, accountMaxOrderQuantityRaw = null, accountMaxOrderCollateralRaw = null, evaluateProjectedState } = {}) {
  const amount = raw(mintAmountRaw, "mintAmountRaw", { positive: true });
  const minimum = raw(minimumMintRaw, "minimumMintRaw", { positive: true });
  const maxAccount = accountMaxOrderCollateralRaw === null || accountMaxOrderCollateralRaw === undefined ? null : raw(accountMaxOrderCollateralRaw, "accountMaxOrderCollateralRaw", { positive: true });
  const reasons = [];
  if (amount < minimum) reasons.push(reason("MINT_BELOW_VENUE_MINIMUM", "candidate is below the venue minimum quantity"));
  if (amount > caps.MAX_MINT_AMOUNT) reasons.push(reason("MINT_CAP", "candidate exceeds the Phase 3B hard mint cap"));
  if (maxAccount !== null && amount > maxAccount) reasons.push(reason("ACCOUNT_MINT_LIMIT", "candidate exceeds VillaAccount.maxOrderCollateral"));
  let state = null;
  try { state = projectLpState({ collateralRaw, yesRaw, noRaw, mintAmountRaw: amount }); } catch (error) { reasons.push(reason("PROJECTED_BALANCE_INVALID", error.message)); }
  let evaluated = null;
  if (state && typeof evaluateProjectedState === "function") evaluated = evaluateProjectedState(state);
  const quoteValidation = evaluated ? validateProjectedQuote({ ...evaluated, accountMaxOrderQuantityRaw, accountMaxOrderCollateralRaw, caps }) : null;
  if (evaluated?.riskDecision?.state === "HALT") reasons.push(reason("RISK_HALTED", "projected state is halted by the existing Risk Governor"));
  if (quoteValidation && !quoteValidation.valid) reasons.push(...quoteValidation.reasons);
  if (evaluated?.sequencePolicyValid !== true) reasons.push(reason("PROJECTED_SEQUENCE_INVALID", "the complete projected sequence did not pass the unsigned policy boundary"));
  const unique = uniqueReasons(reasons);
  return Object.freeze({ version: LP_QUOTE_FEASIBILITY_VERSION, viable: unique.length === 0, mintAmountRaw: amount.toString(), state, riskDecision: evaluated?.riskDecision ?? null, quotePlan: evaluated?.quotePlan ?? null, quoteExecution: evaluated?.quoteExecution ?? null, quoteValidation, sequencePolicyValid: evaluated?.sequencePolicyValid === true, reasons: Object.freeze(unique) });
}

export function findSmallestViableMint(candidates, evaluate) {
  if (!Array.isArray(candidates) || typeof evaluate !== "function") throw new Error("candidates and evaluate are required");
  for (const candidate of candidates) {
    const result = evaluate(candidate);
    if (result?.viable === true) return result;
  }
  return null;
}

/** Recommend the least-mutating plan that has already passed feasibility. */
export function recommendQuotePath({ buyWithoutMint, sellAfterMint } = {}) {
  if (buyWithoutMint?.viable === true) return Object.freeze({ path: "A", reason: "BUY without mint is feasible and avoids mint/burn mutations" });
  if (sellAfterMint?.viable === true) return Object.freeze({ path: "B", reason: "minimal mint then SELL is the first feasible bounded path" });
  return Object.freeze({ path: null, reason: "no permitted quote path is feasible" });
}
