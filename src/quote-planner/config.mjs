/**
 * Versioned operator policy for VILLA's pure quote planner.
 *
 * These values describe how far VILLA is willing to quote around its fair
 * value and how aggressively it sizes a quote. They are not exchange rules
 * and they are not profitability claims. Exchange tick/lot/minimum values are
 * supplied per market by the read-only acquisition layer.
 */

export const QUOTE_PLANNER_VERSION = "villa-quote-v1";

export const DEFAULT_QUOTE_CONFIG = Object.freeze({
  version: QUOTE_PLANNER_VERSION,
  baseHalfSpread: 0.02,
  volatilitySpreadMultiplier: 1,
  expiryReferenceSec: 300,
  maxExpiryHalfSpreadAdd: 0.015,
  idealConfidence: 0.9,
  confidenceFloor: 0.75,
  maxConfidenceHalfSpreadAdd: 0.01,
  maxInventorySkew: 0.05,
  minSizeFactor: 0.5,
  volatilitySizeMultiplier: 5,
  expirySizeReduction: 0.5,
  maxHalfSpread: 0.25,
});

export class QuoteConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QuoteConfigError";
    this.code = code;
  }
}

function finiteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new QuoteConfigError("CONFIG_INVALID", `${name} must be finite and >= 0`);
  }
}

function finitePositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new QuoteConfigError("CONFIG_INVALID", `${name} must be finite and > 0`);
  }
}

/** Validate a quote policy without reading environment or external state. */
export function validateQuoteConfig(config = DEFAULT_QUOTE_CONFIG) {
  if (!config || typeof config !== "object") {
    throw new QuoteConfigError("CONFIG_INVALID", "quote config must be an object");
  }
  if (config.version !== QUOTE_PLANNER_VERSION) {
    throw new QuoteConfigError("CONFIG_INVALID", `unsupported quote planner version ${config.version}`);
  }
  for (const name of [
    "baseHalfSpread",
    "volatilitySpreadMultiplier",
    "maxExpiryHalfSpreadAdd",
    "maxConfidenceHalfSpreadAdd",
    "maxInventorySkew",
    "maxHalfSpread",
  ]) finiteNonNegative(config[name], name);
  for (const name of ["expiryReferenceSec", "idealConfidence", "confidenceFloor", "minSizeFactor", "volatilitySizeMultiplier", "expirySizeReduction"]) {
    finiteNonNegative(config[name], name);
  }
  if (config.idealConfidence > 1 || config.confidenceFloor > 1 || config.minSizeFactor > 1 || config.expirySizeReduction > 1) {
    throw new QuoteConfigError("CONFIG_INVALID", "confidence and size factors must be <= 1");
  }
  if (config.confidenceFloor >= config.idealConfidence) {
    throw new QuoteConfigError("CONFIG_INVALID", "confidenceFloor must be below idealConfidence");
  }
  if (config.maxInventorySkew > 1 || config.maxHalfSpread > 1) {
    throw new QuoteConfigError("CONFIG_INVALID", "probability adjustments must be <= 1");
  }
  finitePositive(config.expiryReferenceSec, "expiryReferenceSec");
  return Object.freeze({ ...config });
}
