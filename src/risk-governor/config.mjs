/**
 * Versioned, explicit risk policy for the deterministic governor.
 *
 * The numbers are operator policy, not claims about DreamDEX. They are kept in
 * one object so a future operator configuration layer can replace this object
 * without changing the decision code or silently changing the meaning of an
 * old decision.
 */

export const RISK_GOVERNOR_VERSION = "villa-risk-v1";

export const DEFAULT_RISK_CONFIG = Object.freeze({
  version: RISK_GOVERNOR_VERSION,
  tradingStatus: 1,
  maxChainTimeAgeSec: 15,
  maxPriceAgeSec: 15,
  maxSourceAgeSec: 60,
  maxFutureTimestampSec: 5,
  minModelConfidence: 0.75,
  minExpiryHeadroomSec: 30,
  directionalExposureWarning: 5,
  directionalExposureSoft: 7,
  directionalExposureHard: 10,
  grossExposureWarning: 16,
  grossExposureHard: 20,
  capitalAtRiskWarning: 80,
  capitalAtRiskHard: 100,
  minCollateralReserve: 1,
  minGasReserve: 0.1,
  drawdownWarningRatio: 0.03,
  drawdownHardStopRatio: 0.05,
  requireDrawdownAccounting: false,
  maxEmergencyVolatilityPerSqrtSec: null,
});

export class RiskConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RiskConfigError";
    this.code = code;
  }
}

function finiteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RiskConfigError("CONFIG_INVALID", `${name} must be finite and >= 0`);
  }
}

function finitePositive(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RiskConfigError("CONFIG_INVALID", `${name} must be finite and > 0`);
  }
}

/** Validate and freeze a policy without reading environment or external state. */
export function validateRiskConfig(config = DEFAULT_RISK_CONFIG) {
  if (!config || typeof config !== "object") {
    throw new RiskConfigError("CONFIG_INVALID", "risk config must be an object");
  }
  if (config.version !== RISK_GOVERNOR_VERSION) {
    throw new RiskConfigError("CONFIG_INVALID", `unsupported risk config version ${config.version}`);
  }
  if (!Number.isInteger(config.tradingStatus) || config.tradingStatus < 0) {
    throw new RiskConfigError("CONFIG_INVALID", "tradingStatus must be a non-negative integer");
  }
  for (const name of [
    "maxChainTimeAgeSec",
    "maxPriceAgeSec",
    "maxSourceAgeSec",
    "maxFutureTimestampSec",
    "minModelConfidence",
    "minExpiryHeadroomSec",
    "directionalExposureWarning",
    "directionalExposureSoft",
    "directionalExposureHard",
    "grossExposureWarning",
    "grossExposureHard",
    "capitalAtRiskWarning",
    "capitalAtRiskHard",
    "minCollateralReserve",
    "minGasReserve",
    "drawdownWarningRatio",
    "drawdownHardStopRatio",
  ]) {
    finiteNonNegative(config[name], name);
  }
  if (config.minModelConfidence > 1) {
    throw new RiskConfigError("CONFIG_INVALID", "minModelConfidence must be <= 1");
  }
  if (!(config.directionalExposureWarning < config.directionalExposureSoft && config.directionalExposureSoft < config.directionalExposureHard)) {
    throw new RiskConfigError("CONFIG_INVALID", "directional exposure warning < soft < hard is required");
  }
  if (!(config.grossExposureWarning < config.grossExposureHard)) {
    throw new RiskConfigError("CONFIG_INVALID", "gross exposure warning must be below hard");
  }
  if (!(config.capitalAtRiskWarning < config.capitalAtRiskHard)) {
    throw new RiskConfigError("CONFIG_INVALID", "capital-at-risk warning must be below hard");
  }
  if (!(config.drawdownWarningRatio < config.drawdownHardStopRatio)) {
    throw new RiskConfigError("CONFIG_INVALID", "drawdown warning must be below hard stop");
  }
  if (config.maxEmergencyVolatilityPerSqrtSec !== null) {
    finitePositive(config.maxEmergencyVolatilityPerSqrtSec, "maxEmergencyVolatilityPerSqrtSec");
  }
  if (typeof config.requireDrawdownAccounting !== "boolean") {
    throw new RiskConfigError("CONFIG_INVALID", "requireDrawdownAccounting must be boolean");
  }
  return Object.freeze({ ...config });
}
