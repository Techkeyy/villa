/**
 * VILLA's independent fair-value core for a binary UP/DOWN Event Contract.
 *
 * This module is pure. It does not know about RPC, GraphQL, wallets, markets,
 * order books, inventory, or environment variables. The only model inputs are
 * the underlying price, the settlement reference, remaining time, and realized
 * log-return volatility. Data-quality facts are supplied separately so the
 * result can refuse stale or weak observations instead of returning 0.5.
 */

import { phi } from "./math.mjs";

export const FAIR_VALUE_MODEL_VERSION = "villa-fv-v1";

export const DATA_QUALITY_LIMITS = Object.freeze({
  minVolReturns: 12,
  minVolElapsedSec: 60,
  maxPriceAgeSec: 15,
  maxObservationGapSec: 180,
  maxHorizonMultiple: 60,
});

/** Remaining move beyond this is treated as a unit/configuration error. */
export const MAX_REMAINING_LOG_MOVE = 3;

export class FairValueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FairValueError";
    this.code = code;
  }
}

/**
 * @typedef {{
 *   sigmaPerSqrtSec: number,
 *   returns: number,
 *   elapsedSec: number,
 *   maxGapSec: number,
 *   maxAbsLogReturn: number,
 *   outlierRatio: number,
 * }} VolatilityInput
 */

/**
 * @typedef {{
 *   priceAgeSec: number,
 *   referenceSource: "strike" | "opening",
 * }} DataQualityInput
 */

/**
 * @typedef {{
 *   currentUnderlyingPrice: number,
 *   referencePrice: number,
 *   timeRemainingSec: number,
 *   volatility: VolatilityInput,
 *   dataQuality: DataQualityInput,
 * }} FairValueInput
 */

/**
 * @typedef {{
 *   modelVersion: string,
 *   pUp: number,
 *   pDown: number,
 *   confidence: number,
 *   dataQualityStatus: "HIGH" | "MEDIUM" | "LOW",
 *   dataQuality: { score: number, status: "HIGH" | "MEDIUM" | "LOW", factors: Record<string, number>, warnings: string[] },
 *   currentUnderlyingPrice: number,
 *   referencePrice: number,
 *   referenceSource: "strike" | "opening",
 *   distanceFromReference: number,
 *   logMoneyness: number,
 *   timeRemainingSec: number,
 *   realizedVolPerSqrtSec: number,
 *   volatilityObservations: number,
 *   volatilityElapsedSec: number,
 *   remainingLogMove: number,
 *   z: number,
 *   inputsUsed: string[],
 *   warnings: string[],
 * }} FairValue
 */

/**
 * Estimate P(final underlying price >= reference price).
 *
 * Baseline distribution: the future log return over the remaining horizon is
 * normal with zero mean and standard deviation σ√τ. Therefore:
 *
 *   pUp = Φ( ln(S / K) / (σ√τ) )
 *
 * This is a zero-drift *log-return* assumption. It does not claim a directional
 * mean or use the DreamDEX book. The output's confidence is a data-quality
 * score, not a second probability and not `pUp` certainty.
 *
 * @param {FairValueInput} input
 * @returns {FairValue}
 */
export function estimateFairValue(input) {
  const {
    currentUnderlyingPrice: spot,
    referencePrice: reference,
    timeRemainingSec,
    volatility,
    dataQuality,
  } = input ?? {};

  if (!(spot > 0) || !Number.isFinite(spot)) {
    throw new FairValueError("BAD_SPOT", "current underlying price must be positive and finite");
  }
  if (!(reference > 0) || !Number.isFinite(reference)) {
    throw new FairValueError("BAD_REFERENCE", "reference price must be positive and finite");
  }
  if (!Number.isFinite(timeRemainingSec)) {
    throw new FairValueError("BAD_TIME", "timeRemainingSec must be finite");
  }
  if (timeRemainingSec < 0) {
    throw new FairValueError("EXPIRED", "market is expired; fair value is not tradeable");
  }
  validateDataQuality(dataQuality);
  validateVolatility(volatility, timeRemainingSec);

  const logMoneyness = Math.log(spot / reference);
  if (!Number.isFinite(logMoneyness)) {
    throw new FairValueError("NONFINITE", "log moneyness is not finite");
  }

  const quality = buildDataQuality(dataQuality, volatility, timeRemainingSec);
  const warnings = [...quality.warnings];
  const distanceFromReference = spot / reference - 1;

  if (timeRemainingSec === 0) {
    const pUp = spot >= reference ? 1 : 0;
    return {
      modelVersion: FAIR_VALUE_MODEL_VERSION,
      pUp,
      pDown: 1 - pUp,
      confidence: quality.score,
      dataQualityStatus: quality.status,
      dataQuality: quality,
      currentUnderlyingPrice: spot,
      referencePrice: reference,
      referenceSource: dataQuality.referenceSource,
      distanceFromReference,
      logMoneyness,
      timeRemainingSec,
      realizedVolPerSqrtSec: volatility.sigmaPerSqrtSec,
      volatilityObservations: volatility.returns,
      volatilityElapsedSec: volatility.elapsedSec,
      remainingLogMove: 0,
      z: pUp === 1 ? Infinity : -Infinity,
      inputsUsed: ["currentUnderlyingPrice", "referencePrice", "timeRemainingSec"],
      warnings,
    };
  }

  const remainingLogMove = volatility.sigmaPerSqrtSec * Math.sqrt(timeRemainingSec);
  if (!(remainingLogMove > 0) || !Number.isFinite(remainingLogMove)) {
    throw new FairValueError("BAD_SCALE", "σ√τ must be positive and finite");
  }
  if (remainingLogMove > MAX_REMAINING_LOG_MOVE) {
    throw new FairValueError(
      "UNIT_MISMATCH",
      `σ√τ = ${remainingLogMove.toFixed(3)} exceeds ${MAX_REMAINING_LOG_MOVE}; check volatility/time units`,
    );
  }

  const z = logMoneyness / remainingLogMove;
  if (!Number.isFinite(z)) {
    throw new FairValueError("NONFINITE", "normalized distance is not finite");
  }
  const pUp = clamp01(phi(z));
  if (!Number.isFinite(pUp)) {
    throw new FairValueError("NONFINITE", "probability calculation is not finite");
  }

  if (dataQuality.referenceSource === "opening") warnings.push("REFERENCE_FROM_OPENING_PRICE");
  if (Math.abs(z) > 4) warnings.push("EXTREME_NORMALIZED_DISTANCE");

  return {
    modelVersion: FAIR_VALUE_MODEL_VERSION,
    pUp,
    pDown: 1 - pUp,
    confidence: quality.score,
    dataQualityStatus: quality.status,
    dataQuality: quality,
    currentUnderlyingPrice: spot,
    referencePrice: reference,
    referenceSource: dataQuality.referenceSource,
    distanceFromReference,
    logMoneyness,
    timeRemainingSec,
    realizedVolPerSqrtSec: volatility.sigmaPerSqrtSec,
    volatilityObservations: volatility.returns,
    volatilityElapsedSec: volatility.elapsedSec,
    remainingLogMove,
    z,
    inputsUsed: ["currentUnderlyingPrice", "referencePrice", "timeRemainingSec", "realizedVolPerSqrtSec"],
    warnings: [...new Set(warnings)],
  };
}

function validateDataQuality(q) {
  if (!q || (q.referenceSource !== "strike" && q.referenceSource !== "opening")) {
    throw new FairValueError("BAD_REFERENCE_SOURCE", "referenceSource must be strike or opening");
  }
  if (!Number.isFinite(q.priceAgeSec) || q.priceAgeSec < 0) {
    throw new FairValueError("BAD_PRICE_AGE", "priceAgeSec must be finite and >= 0");
  }
  if (q.priceAgeSec > DATA_QUALITY_LIMITS.maxPriceAgeSec) {
    throw new FairValueError("STALE_PRICE", `price age ${q.priceAgeSec}s exceeds ${DATA_QUALITY_LIMITS.maxPriceAgeSec}s`);
  }
}

function validateVolatility(v, timeRemainingSec) {
  if (!v || !Number.isFinite(v.sigmaPerSqrtSec) || v.sigmaPerSqrtSec < 0) {
    throw new FairValueError("BAD_VOL", "realized volatility must be finite and >= 0");
  }
  for (const [name, value] of [
    ["returns", v.returns],
    ["elapsedSec", v.elapsedSec],
    ["maxGapSec", v.maxGapSec],
    ["maxAbsLogReturn", v.maxAbsLogReturn],
    ["outlierRatio", v.outlierRatio],
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new FairValueError("BAD_VOL_STATS", `${name} must be finite and >= 0`);
    }
  }
  if (!Number.isInteger(v.returns) || v.returns < DATA_QUALITY_LIMITS.minVolReturns) {
    throw new FairValueError("INSUFFICIENT_VOL", `need at least ${DATA_QUALITY_LIMITS.minVolReturns} volatility returns`);
  }
  if (v.elapsedSec < DATA_QUALITY_LIMITS.minVolElapsedSec) {
    throw new FairValueError("INSUFFICIENT_VOL", `need at least ${DATA_QUALITY_LIMITS.minVolElapsedSec}s of volatility history`);
  }
  if (!(v.maxGapSec > 0) || v.maxGapSec > DATA_QUALITY_LIMITS.maxObservationGapSec) {
    throw new FairValueError("BAD_VOL_GAP", "volatility observations have an unusable gap");
  }
  if (timeRemainingSec > 0 && !(v.sigmaPerSqrtSec > 0)) {
    throw new FairValueError("NO_VOL", "positive time remains but realized volatility is zero");
  }
}

function buildDataQuality(dataQuality, v, timeRemainingSec) {
  const freshness = clamp01(1 - dataQuality.priceAgeSec / DATA_QUALITY_LIMITS.maxPriceAgeSec);
  const observations = clamp01(v.returns / 24);
  const coverage = clamp01(v.elapsedSec / 120);
  const spacing = clamp01(60 / v.maxGapSec);
  const outlier = v.outlierRatio <= 4 ? 1 : v.outlierRatio <= 8 ? 0.75 : 0.5;
  const horizonMultiple = timeRemainingSec / Math.max(v.elapsedSec, 1);
  const horizon = horizonMultiple <= 10 ? 1 : horizonMultiple <= DATA_QUALITY_LIMITS.maxHorizonMultiple ? 0.75 : 0.5;
  const score = roundScore(
    0.3 * freshness +
      0.2 * observations +
      0.15 * coverage +
      0.1 * spacing +
      0.1 * outlier +
      0.15 * horizon,
  );
  const status = score >= 0.8 ? "HIGH" : score >= 0.6 ? "MEDIUM" : "LOW";
  const warnings = [];
  if (v.returns < 24) warnings.push("LOW_VOL_SAMPLE_COUNT");
  if (v.elapsedSec < 120) warnings.push("SHORT_VOL_COVERAGE");
  if (v.outlierRatio > 4) warnings.push("VOLATILITY_OUTLIER");
  if (horizonMultiple > 10) warnings.push("LONG_HORIZON_EXTRAPOLATION");

  return {
    score,
    status,
    factors: {
      priceFreshness: roundScore(freshness),
      volatilitySamples: roundScore(observations),
      volatilityCoverage: roundScore(coverage),
      observationSpacing: roundScore(spacing),
      volatilityStability: roundScore(outlier),
      horizonCoverage: roundScore(horizon),
    },
    warnings,
  };
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

function roundScore(x) {
  return Math.round(clamp01(x) * 1000) / 1000;
}
