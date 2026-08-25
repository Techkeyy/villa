/**
 * Realized volatility from a price series.
 *
 * Unit of the returned number: **per square-root second**.
 *
 * Construction (the elapsed-time estimator used by the DreamDEX kit's
 * SpotHistory, without its book-mid fallback):
 *
 *   r_i = ln(P_i / P_{i-1})
 *   σ = sqrt(Σ r_i² / Σ Δt_i)
 *
 * `Σ Δt_i` is measured in seconds. Therefore the fair-value model can form the
 * dimensionless remaining move `σ * sqrt(τ_seconds)` without annualisation or
 * an implicit minutes/seconds conversion.
 *
 * Repeated timestamps are collapsed to the newest price and contribute no
 * return. Repeated prices with positive elapsed time do contribute elapsed time
 * and zero squared return; this prevents polling frequency from inflating vol.
 */

export class VolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VolError";
    this.code = code;
  }
}

/**
 * @typedef {{ price: number, tSec: number }} PriceTick
 */

/**
 * @param {PriceTick[]} ticks  chronological prices, unix seconds
 * @param {{ minReturns?: number, maxAgeSec?: number, maxGapSec?: number, minElapsedSec?: number, nowSec?: number }} [opts]
 * @returns {{ sigmaPerSqrtSec: number, returns: number, elapsedSec: number, lastPrice: number, lastTSec: number, maxGapSec: number, maxAbsLogReturn: number, outlierRatio: number }}
 */
export function realizedVolPerSqrtSec(ticks, opts = {}) {
  const minReturns = opts.minReturns ?? 12;
  const maxAgeSec = opts.maxAgeSec ?? 120;
  const maxGapSec = opts.maxGapSec ?? Infinity;
  const minElapsedSec = opts.minElapsedSec ?? 0;
  const nowSec = opts.nowSec;

  if (!Number.isInteger(minReturns) || minReturns < 1) {
    throw new VolError("BAD_OPTIONS", "minReturns must be a positive integer");
  }
  if (!(maxAgeSec >= 0) || !Number.isFinite(maxAgeSec)) {
    throw new VolError("BAD_OPTIONS", "maxAgeSec must be finite and >= 0");
  }
  if (!(minElapsedSec >= 0) || !Number.isFinite(minElapsedSec)) {
    throw new VolError("BAD_OPTIONS", "minElapsedSec must be finite and >= 0");
  }
  if (!(maxGapSec > 0) && maxGapSec !== Infinity) {
    throw new VolError("BAD_OPTIONS", "maxGapSec must be > 0 or Infinity");
  }
  if (nowSec !== undefined && (!Number.isFinite(nowSec) || nowSec < 0)) {
    throw new VolError("BAD_OPTIONS", "nowSec must be a finite unix timestamp");
  }

  if (!Array.isArray(ticks) || ticks.length < minReturns + 1) {
    throw new VolError("TOO_FEW", `need at least ${minReturns + 1} ticks, got ${ticks?.length ?? 0}`);
  }

  let sumSq = 0;
  let elapsed = 0;
  let n = 0;
  let maxGap = 0;
  let maxAbs = 0;
  let prev = null;

  for (const tick of ticks) {
    if (!tick || !(tick.price > 0) || !Number.isFinite(tick.price) || !Number.isFinite(tick.tSec) || tick.tSec < 0) {
      throw new VolError("BAD_TICK", "every price tick must have a finite positive price and unix timestamp");
    }
    if (prev === null) {
      prev = tick;
      continue;
    }
    const dt = tick.tSec - prev.tSec;
    if (dt < 0) {
      throw new VolError("UNORDERED", "ticks must be non-decreasing in tSec");
    }
    if (dt === 0) {
      // Same-second oracle observations cannot form a time-normalized return.
      // Keep the latest value so the next positive-dt return starts there.
      prev = tick;
      continue;
    }
    if (dt > maxGapSec) {
      throw new VolError("GAP", `observation gap ${dt}s exceeds max ${maxGapSec}s`);
    }
    const r = Math.log(tick.price / prev.price);
    if (!Number.isFinite(r)) {
      throw new VolError("BAD_RETURN", "non-finite log return");
    }
    sumSq += r * r;
    elapsed += dt;
    n += 1;
    maxGap = Math.max(maxGap, dt);
    maxAbs = Math.max(maxAbs, Math.abs(r));
    prev = tick;
  }

  if (n < minReturns || elapsed <= 0 || elapsed < minElapsedSec) {
    throw new VolError("TOO_FEW", `only ${n} positive-dt returns over ${elapsed}s`);
  }

  if (nowSec !== undefined) {
    const age = nowSec - prev.tSec;
    if (age < -5) {
      throw new VolError("FUTURE", `last tick is ${-age}s ahead of now`);
    }
    if (age > maxAgeSec) {
      throw new VolError("STALE", `last tick is ${age}s old (max ${maxAgeSec})`);
    }
  }

  const sigma = Math.sqrt(sumSq / elapsed);
  if (!(sigma > 0) || !Number.isFinite(sigma)) {
    throw new VolError("ZERO", "realized vol collapsed to zero — no price movement in the window");
  }

  const rmsReturn = Math.sqrt(sumSq / n);
  return {
    sigmaPerSqrtSec: sigma,
    returns: n,
    elapsedSec: elapsed,
    lastPrice: prev.price,
    lastTSec: prev.tSec,
    maxGapSec: maxGap,
    maxAbsLogReturn: maxAbs,
    outlierRatio: rmsReturn > 0 ? maxAbs / rmsReturn : Infinity,
  };
}

/** Convert 1-minute log-return stdev to per-sqrt-second. */
export function perMinuteToPerSqrtSec(sigmaPerMinute) {
  if (!(sigmaPerMinute > 0) || !Number.isFinite(sigmaPerMinute)) {
    throw new VolError("BAD_VOL", "per-minute vol must be positive and finite");
  }
  return sigmaPerMinute / Math.sqrt(60);
}
