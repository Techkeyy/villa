import { DEFAULT_RISK_CONFIG, RISK_GOVERNOR_VERSION, RiskConfigError, validateRiskConfig } from "./config.mjs";
import { calculateBinaryExposure, ExposureError } from "./exposure.mjs";

export const RISK_REASON_CODES = Object.freeze([
  "NONE",
  "CONFIG_INVALID",
  "INVALID_STATE",
  "CHAIN_TIME_INVALID",
  "CHAIN_TIME_STALE",
  "PRICE_INVALID",
  "PRICE_STALE",
  "PRICE_TIMESTAMP_FUTURE",
  "PRICE_TIMESTAMP_NON_MONOTONIC",
  "FAIR_VALUE_INVALID",
  "MODEL_CONFIDENCE_LOW",
  "MODEL_DATA_QUALITY_LOW",
  "REFERENCE_INVALID",
  "REFERENCE_AMBIGUOUS",
  "REFERENCE_SCALING_UNSUPPORTED",
  "MARKET_STATUS_INVALID",
  "MARKET_NOT_TRADING",
  "EXPIRY_INVALID",
  "MARKET_EXPIRED",
  "EXPIRY_TOO_CLOSE",
  "OPEN_ORDER_STATE_INVALID",
  "EXPOSURE_INVALID",
  "DIRECTIONAL_EXPOSURE_SOFT",
  "DIRECTIONAL_EXPOSURE_HARD",
  "GROSS_EXPOSURE_HARD",
  "CAPITAL_LIMIT_HARD",
  "COLLATERAL_RESERVE_LOW",
  "GAS_RESERVE_LOW",
  "DRAWDOWN_INVALID",
  "DRAWDOWN_HARD_STOP",
  "VOLATILITY_EMERGENCY",
]);

const REASON_ORDER = new Map(RISK_REASON_CODES.map((code, index) => [code, index]));

const REASON_TEXT = Object.freeze({
  CONFIG_INVALID: "risk configuration is invalid or unsupported",
  INVALID_STATE: "a required risk input is missing or malformed",
  CHAIN_TIME_INVALID: "authoritative chain time is missing or malformed",
  CHAIN_TIME_STALE: "the chain-time observation is too old",
  PRICE_INVALID: "the underlying price or its timestamp is unusable",
  PRICE_STALE: "the underlying price is older than the configured limit",
  PRICE_TIMESTAMP_FUTURE: "the price timestamp is materially ahead of chain time",
  PRICE_TIMESTAMP_NON_MONOTONIC: "the collector reported a non-monotonic price timestamp",
  FAIR_VALUE_INVALID: "the fair-value result is not a finite binary probability",
  MODEL_CONFIDENCE_LOW: "fair-value data quality is below the configured minimum",
  MODEL_DATA_QUALITY_LOW: "fair-value collector classified its data quality as LOW",
  REFERENCE_INVALID: "the settlement reference is missing or invalid",
  REFERENCE_AMBIGUOUS: "the settlement reference scaling is ambiguous",
  REFERENCE_SCALING_UNSUPPORTED: "the settlement reference scaling is unsupported",
  MARKET_STATUS_INVALID: "on-chain market status is missing or malformed",
  MARKET_NOT_TRADING: "the on-chain market is not in Trading status",
  EXPIRY_INVALID: "market expiry is missing or malformed",
  MARKET_EXPIRED: "market expiry has passed on the chain clock",
  EXPIRY_TOO_CLOSE: "remaining chain-time headroom is below the configured minimum",
  OPEN_ORDER_STATE_INVALID: "open-order state is missing, stale, or ambiguous",
  EXPOSURE_INVALID: "binary inventory or open-order exposure is malformed",
  DIRECTIONAL_EXPOSURE_SOFT: "soft directional exposure boundary permits reduce-only actions",
  DIRECTIONAL_EXPOSURE_HARD: "worst-case directional exposure reaches the hard limit",
  GROSS_EXPOSURE_HARD: "worst-case gross outcome exposure reaches the hard limit",
  CAPITAL_LIMIT_HARD: "capital-at-risk or collateral reserve reaches a hard limit",
  COLLATERAL_RESERVE_LOW: "available collateral is below the required reserve",
  GAS_RESERVE_LOW: "native-token gas reserve is below the required reserve",
  DRAWDOWN_INVALID: "drawdown accounting is required but unavailable or malformed",
  DRAWDOWN_HARD_STOP: "configured drawdown hard stop is reached",
  VOLATILITY_EMERGENCY: "realized volatility exceeds the explicitly configured emergency limit",
});

function finite(value) {
  return Number.isFinite(value);
}

function nonNegative(value) {
  return finite(value) && value >= 0;
}

function nullIfNotFinite(value) {
  return finite(value) ? value : null;
}

function addReason(reasons, code) {
  if (!reasons.includes(code)) reasons.push(code);
}

function addWarning(warnings, code) {
  if (!warnings.includes(code)) warnings.push(code);
}

function sortCodes(codes) {
  return [...new Set(codes)].sort((a, b) => (REASON_ORDER.get(a) ?? 999) - (REASON_ORDER.get(b) ?? 999));
}

function validateFairValue(fairValue, reasons, warnings, config) {
  if (!fairValue || fairValue.valid === false) {
    addReason(reasons, "FAIR_VALUE_INVALID");
    return;
  }
  const { pUp, pDown, confidence, modelVersion, dataQualityStatus } = fairValue;
  if (!finite(pUp) || !finite(pDown) || pUp < 0 || pUp > 1 || pDown < 0 || pDown > 1 || Math.abs(pUp + pDown - 1) > 1e-9 || typeof modelVersion !== "string" || modelVersion.length === 0) {
    addReason(reasons, "FAIR_VALUE_INVALID");
    return;
  }
  if (!finite(confidence) || confidence < 0 || confidence > 1) {
    addReason(reasons, "FAIR_VALUE_INVALID");
    return;
  }
  if (confidence < config.minModelConfidence) addReason(reasons, "MODEL_CONFIDENCE_LOW");
  if (dataQualityStatus === "LOW") addReason(reasons, "MODEL_DATA_QUALITY_LOW");
  if (!["HIGH", "MEDIUM", "LOW"].includes(dataQualityStatus)) addReason(reasons, "FAIR_VALUE_INVALID");
  if (fairValue.realizedVolPerSqrtSec !== undefined && !nonNegative(fairValue.realizedVolPerSqrtSec)) addReason(reasons, "FAIR_VALUE_INVALID");
  if (config.maxEmergencyVolatilityPerSqrtSec !== null && finite(fairValue.realizedVolPerSqrtSec) && fairValue.realizedVolPerSqrtSec > config.maxEmergencyVolatilityPerSqrtSec) {
    addReason(reasons, "VOLATILITY_EMERGENCY");
  }
  if (Array.isArray(fairValue.warnings) && fairValue.warnings.includes("EXTREME_NORMALIZED_DISTANCE")) addWarning(warnings, "MODEL_EXTREME_NORMALIZED_DISTANCE");
}

function validateReference(market, fairValue, reasons) {
  const reference = market?.reference;
  if (!reference || typeof reference !== "object") {
    addReason(reasons, "REFERENCE_INVALID");
    return;
  }
  if (reference.status === "AMBIGUOUS") {
    addReason(reasons, "REFERENCE_AMBIGUOUS");
    return;
  }
  if (reference.status === "UNSUPPORTED") {
    addReason(reasons, "REFERENCE_SCALING_UNSUPPORTED");
    return;
  }
  if (reference.status !== "VALID") {
    addReason(reasons, "REFERENCE_INVALID");
    return;
  }
  if (!Number.isInteger(reference.scaleExponent10) || reference.scaleExponent10 < 0 || reference.scaleExponent10 > 18) {
    addReason(reasons, "REFERENCE_SCALING_UNSUPPORTED");
  }
  if (reference.source !== "strike" && reference.source !== "opening") addReason(reasons, "REFERENCE_INVALID");
  if (fairValue?.referenceSource !== undefined && fairValue.referenceSource !== reference.source) addReason(reasons, "REFERENCE_INVALID");
}

function validateChainTime(chainTime, reasons, config) {
  if (!chainTime || !Number.isInteger(chainTime.chainNowSec) || chainTime.chainNowSec < 0) {
    addReason(reasons, "CHAIN_TIME_INVALID");
    return;
  }
  if (!finite(chainTime.observationAgeSec) || chainTime.observationAgeSec < 0) {
    addReason(reasons, "CHAIN_TIME_INVALID");
  } else if (chainTime.observationAgeSec > config.maxChainTimeAgeSec) {
    addReason(reasons, "CHAIN_TIME_STALE");
  }
  for (const name of ["localNowMs", "observedAtLocalMs", "clockOffsetSec"]) {
    if (chainTime[name] !== undefined && !finite(chainTime[name])) addReason(reasons, "CHAIN_TIME_INVALID");
  }
}

function validatePrice(feed, chainTime, reasons, config) {
  if (!feed || !finite(feed.price) || feed.price <= 0 || !finite(feed.timestampSec) || feed.timestampSec < 0) {
    addReason(reasons, "PRICE_INVALID");
    return;
  }
  if (feed.timestampStatus === "NON_MONOTONIC") addReason(reasons, "PRICE_TIMESTAMP_NON_MONOTONIC");
  if (feed.timestampStatus === "MISSING") addReason(reasons, "PRICE_INVALID");
  if (Number.isInteger(chainTime?.chainNowSec)) {
    const age = chainTime.chainNowSec - feed.timestampSec;
    if (age > config.maxPriceAgeSec) addReason(reasons, "PRICE_STALE");
    if (age < -config.maxFutureTimestampSec) addReason(reasons, "PRICE_TIMESTAMP_FUTURE");
  }
  if (feed.sourceAgeSec !== undefined && (!nonNegative(feed.sourceAgeSec) || feed.sourceAgeSec > config.maxSourceAgeSec)) addReason(reasons, "PRICE_STALE");
}

function validateMarket(market, chainTime, reasons, config) {
  if (!market || !Number.isInteger(market.status) || market.status < 0) addReason(reasons, "MARKET_STATUS_INVALID");
  else if (market.status !== config.tradingStatus) addReason(reasons, "MARKET_NOT_TRADING");

  if (!finite(market?.expirySec) || market.expirySec < 0) {
    addReason(reasons, "EXPIRY_INVALID");
    return;
  }
  if (Number.isInteger(chainTime?.chainNowSec)) {
    const timeRemainingSec = market.expirySec - chainTime.chainNowSec;
    if (timeRemainingSec < 0) addReason(reasons, "MARKET_EXPIRED");
    else if (timeRemainingSec < config.minExpiryHeadroomSec) addReason(reasons, "EXPIRY_TOO_CLOSE");
  }
}

function validateCapital(capital, reasons, config) {
  if (!capital || !nonNegative(capital.collateralAvailable) || !nonNegative(capital.capitalAtRisk)) {
    addReason(reasons, "INVALID_STATE");
    return;
  }
  if (capital.capitalAtRisk >= config.capitalAtRiskHard) addReason(reasons, "CAPITAL_LIMIT_HARD");
  if (capital.collateralAvailable < config.minCollateralReserve) addReason(reasons, "COLLATERAL_RESERVE_LOW");
}

function validateGas(gas, reasons) {
  if (!gas || !nonNegative(gas.nativeBalance)) addReason(reasons, "INVALID_STATE");
}

function validateDrawdown(drawdown, reasons, warnings, config) {
  if (!drawdown || drawdown.status === "UNAVAILABLE") {
    if (config.requireDrawdownAccounting) addReason(reasons, "DRAWDOWN_INVALID");
    else addWarning(warnings, "DRAWDOWN_UNACCOUNTED");
    return null;
  }
  if (drawdown.status !== undefined && drawdown.status !== "AVAILABLE") {
    addReason(reasons, "DRAWDOWN_INVALID");
    return null;
  }
  if (!nonNegative(drawdown.ratio)) {
    addReason(reasons, "DRAWDOWN_INVALID");
    return null;
  }
  if (drawdown.ratio >= config.drawdownHardStopRatio) addReason(reasons, "DRAWDOWN_HARD_STOP");
  else if (drawdown.ratio >= config.drawdownWarningRatio) addWarning(warnings, "DRAWDOWN_WARNING");
  return drawdown.ratio;
}

function emptyExposure() {
  return {
    current: null,
    worstCase: null,
    directionalStress: null,
    pendingRiskIncrease: null,
    reduceOnlyPolicy: null,
    openOrderSummary: null,
  };
}

function explanation(code, severity) {
  return { code, severity, message: REASON_TEXT[code] ?? "rule triggered" };
}

function decisionForInvalidConfig(err) {
  return {
    governorVersion: RISK_GOVERNOR_VERSION,
    configurationVersion: null,
    state: "HALT",
    permissions: { allowNewRisk: false, allowRiskIncreasingOrders: false, allowReduceOnly: false, allowedActions: [] },
    cancelExisting: true,
    maxAdditionalExposure: { directionalUp: 0, directionalDown: 0, grossOutcome: 0, capitalAtRisk: 0 },
    sizeMultiplier: 0,
    primaryReasonCode: "CONFIG_INVALID",
    triggeredRules: ["CONFIG_INVALID"],
    warnings: [],
    explanations: [explanation("CONFIG_INVALID", "HALT")],
    authoritativeTime: null,
    exposure: emptyExposure(),
    reduceOnlyPolicy: null,
    model: null,
    error: err?.message || "risk config invalid",
  };
}

/**
 * Evaluate one normalized risk snapshot. This function is pure and
 * deterministic: no clock, network, wallet, order book, environment, or I/O.
 */
export function evaluateRisk(snapshot, suppliedConfig = DEFAULT_RISK_CONFIG) {
  let config;
  try {
    config = validateRiskConfig(suppliedConfig);
  } catch (err) {
    return decisionForInvalidConfig(err);
  }

  const input = snapshot ?? {};
  const reasons = [];
  const warnings = [];
  validateChainTime(input.chainTime, reasons, config);
  validatePrice(input.feed, input.chainTime, reasons, config);
  validateMarket(input.market, input.chainTime, reasons, config);
  validateReference(input.market, input.fairValue, reasons);
  validateFairValue(input.fairValue, reasons, warnings, config);
  validateCapital(input.capital, reasons, config);
  validateGas(input.gas, reasons);
  const drawdownRatio = validateDrawdown(input.drawdown, reasons, warnings, config);

  if (input.openOrdersStatus !== "VERIFIED") addReason(reasons, "OPEN_ORDER_STATE_INVALID");
  let exposure = emptyExposure();
  try {
    exposure = calculateBinaryExposure({
      yes: input.inventory?.yes,
      no: input.inventory?.no,
      openOrders: input.openOrders,
    });
  } catch (err) {
    if (err instanceof ExposureError) addReason(reasons, "EXPOSURE_INVALID");
    else addReason(reasons, "INVALID_STATE");
  }

  if (exposure.worstCase) {
    const worst = exposure.worstCase;
    if (worst.directionalUp >= config.directionalExposureHard || worst.directionalDown >= config.directionalExposureHard) addReason(reasons, "DIRECTIONAL_EXPOSURE_HARD");
    if (worst.grossOutcome >= config.grossExposureHard) addReason(reasons, "GROSS_EXPOSURE_HARD");
    if (worst.directionalUp >= config.directionalExposureWarning || worst.directionalDown >= config.directionalExposureWarning) addWarning(warnings, "DIRECTIONAL_EXPOSURE_WARNING");
    if (worst.grossOutcome >= config.grossExposureWarning) addWarning(warnings, "GROSS_EXPOSURE_WARNING");
  }
  if (input.capital && nonNegative(input.capital.capitalAtRisk) && input.capital.capitalAtRisk >= config.capitalAtRiskWarning && input.capital.capitalAtRisk < config.capitalAtRiskHard) addWarning(warnings, "CAPITAL_AT_RISK_WARNING");
  if (input.gas && nonNegative(input.gas.nativeBalance) && input.gas.nativeBalance < config.minGasReserve) addReason(reasons, "GAS_RESERVE_LOW");
  if (drawdownRatio !== null && drawdownRatio >= config.drawdownWarningRatio && drawdownRatio < config.drawdownHardStopRatio) addWarning(warnings, "DRAWDOWN_WARNING");

  const orderedReasons = sortCodes(reasons);
  const hardHalt = orderedReasons.length > 0;
  const worst = exposure.worstCase;
  const softUp = worst && worst.directionalUp >= config.directionalExposureSoft;
  const softDown = worst && worst.directionalDown >= config.directionalExposureSoft;
  const reduceOnly = !hardHalt && (softUp || softDown);
  const state = hardHalt ? "HALT" : reduceOnly ? "REDUCE_ONLY" : "ALLOW";

  if (worst && state === "ALLOW" && (worst.directionalUp >= config.directionalExposureWarning || worst.directionalDown >= config.directionalExposureWarning)) addWarning(warnings, "SIZE_REDUCED_FOR_EXPOSURE");
  const reducePolicy = exposure.reduceOnlyPolicy;
  const allowedActions = state === "HALT"
    ? []
    : state === "REDUCE_ONLY"
      ? reducePolicy?.permittedActions ?? []
      : ["BUY_YES", "SELL_YES", "BUY_NO", "SELL_NO"];

  let sizeMultiplier = state === "HALT" || state === "REDUCE_ONLY" ? 0 : 1;
  if (state === "ALLOW" && worst) {
    const exposureRatio = Math.max(worst.directionalUp, worst.directionalDown) / config.directionalExposureHard;
    if (exposureRatio >= config.directionalExposureWarning / config.directionalExposureHard) sizeMultiplier = Math.min(sizeMultiplier, 0.5);
  }
  if (warnings.includes("DRAWDOWN_WARNING")) sizeMultiplier = Math.min(sizeMultiplier, 0.5);

  const maxAdditionalExposure = {
    directionalUp: worst ? Math.max(0, config.directionalExposureHard - worst.directionalUp) : 0,
    directionalDown: worst ? Math.max(0, config.directionalExposureHard - worst.directionalDown) : 0,
    grossOutcome: worst ? Math.max(0, config.grossExposureHard - worst.grossOutcome) : 0,
    capitalAtRisk: input.capital && nonNegative(input.capital.capitalAtRisk) ? Math.max(0, config.capitalAtRiskHard - input.capital.capitalAtRisk) : 0,
  };
  if (state !== "ALLOW") {
    // REDUCE_ONLY has no budget for additional risk. Its permitted order
    // direction and neutralization cap are exposed separately below.
    maxAdditionalExposure.directionalUp = 0;
    maxAdditionalExposure.directionalDown = 0;
    maxAdditionalExposure.grossOutcome = 0;
    maxAdditionalExposure.capitalAtRisk = 0;
  }

  const time = input.chainTime && finite(input.chainTime.chainNowSec) && finite(input.market?.expirySec)
    ? input.market.expirySec - input.chainTime.chainNowSec
    : null;
  const primaryReasonCode = orderedReasons[0] ?? (reduceOnly ? "DIRECTIONAL_EXPOSURE_SOFT" : "NONE");
  const triggeredRules = reduceOnly ? ["DIRECTIONAL_EXPOSURE_SOFT"] : orderedReasons;
  const explanationCodes = sortCodes([...orderedReasons, ...(reduceOnly ? ["DIRECTIONAL_EXPOSURE_SOFT"] : [])]);

  return {
    governorVersion: RISK_GOVERNOR_VERSION,
    configurationVersion: config.version,
    state,
    permissions: {
      allowNewRisk: state === "ALLOW",
      allowRiskIncreasingOrders: state === "ALLOW",
      allowReduceOnly: state === "ALLOW" || (state === "REDUCE_ONLY" && (reducePolicy?.permittedActions.length ?? 0) > 0),
      allowedActions,
    },
    cancelExisting: state === "HALT",
    maxAdditionalExposure,
    sizeMultiplier,
    primaryReasonCode,
    triggeredRules,
    warnings: [...warnings],
    explanations: explanationCodes.map((code) => explanation(code, state === "HALT" && orderedReasons.includes(code) ? "HALT" : state === "REDUCE_ONLY" && code === "DIRECTIONAL_EXPOSURE_SOFT" ? "REDUCE_ONLY" : "WARNING")),
    authoritativeTime: {
      chainNowSec: nullIfNotFinite(input.chainTime?.chainNowSec),
      expirySec: nullIfNotFinite(input.market?.expirySec),
      timeRemainingSec: nullIfNotFinite(time),
      chainObservationAgeSec: nullIfNotFinite(input.chainTime?.observationAgeSec),
      blockNumber: input.chainTime?.blockNumber ?? null,
      localNowMs: nullIfNotFinite(input.chainTime?.localNowMs),
      clockOffsetSec: nullIfNotFinite(input.chainTime?.clockOffsetSec),
    },
    exposure,
    reduceOnlyPolicy: reducePolicy,
    model: input.fairValue ? {
      modelVersion: input.fairValue.modelVersion ?? null,
      pUp: nullIfNotFinite(input.fairValue.pUp),
      pDown: nullIfNotFinite(input.fairValue.pDown),
      confidence: nullIfNotFinite(input.fairValue.confidence),
      dataQualityStatus: input.fairValue.dataQualityStatus ?? null,
    } : null,
    market: {
      status: Number.isInteger(input.market?.status) ? input.market.status : null,
      referenceSource: input.market?.reference?.source ?? null,
      referenceScaleExponent10: Number.isInteger(input.market?.reference?.scaleExponent10) ? input.market.reference.scaleExponent10 : null,
    },
  };
}

export { RiskConfigError };
