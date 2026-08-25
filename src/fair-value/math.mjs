/**
 * Numerical helpers for the fair-value engine.
 * Standard normal CDF via Abramowitz–Stegun erf (formula 7.1.26).
 */

/** Error function. Max abs error ~1.5e-7 on the real line. */
export function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-a * a));
  return sign * y;
}

/** Φ(x) = P(Z <= x) for Z ~ N(0,1). */
export function phi(x) {
  if (x === 0) return 0.5;
  if (!Number.isFinite(x)) {
    if (x === Infinity) return 1;
    if (x === -Infinity) return 0;
    return NaN;
  }
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
