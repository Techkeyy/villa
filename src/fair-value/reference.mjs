/**
 * Resolve the settlement reference used by a binary Event Contract.
 *
 * The SDK documents both `BinaryMarket.strike` and `getOpeningPrices` as raw
 * integers in the oracle price scale. The live feed exposes human units, while
 * the market row does not carry the exponent. The official `ec-oracle-follow`
 * helper therefore tries powers of ten 0..18, chooses the closest candidate in
 * log space, and refuses candidates farther than 2x from current spot.
 *
 * VILLA keeps that verified compatibility boundary, but returns the selected
 * power explicitly (`scaleExponent10`) so this is an auditable rule rather than
 * a silent decimal guess. A non-zero strike that cannot be placed near spot
 * fails closed. `strike = "0"` means the opening-price reference must be read
 * separately; it is not treated as an unusable market.
 */

export class ReferenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReferenceError";
    this.code = code;
  }
}

/**
 * @param {string | number | bigint | undefined} rawStrike
 * @param {number} spot same units as the price feed
 * @returns {{ price: number, scaleExponent10: number, logDistance: number } | null}
 */
export function scaleRawToSpot(rawStrike, spot) {
  if (rawStrike === undefined || rawStrike === null || rawStrike === "") return null;
  if (!(spot > 0) || !Number.isFinite(spot)) return null;

  const rawText = typeof rawStrike === "bigint" ? rawStrike.toString() : String(rawStrike).trim();
  if (!/^\d+$/.test(rawText)) return null;

  let raw;
  try {
    raw = Number(BigInt(rawText));
  } catch {
    return null;
  }
  if (!Number.isFinite(raw) || raw <= 0) return null;

  let best = null;
  let bestErr = Infinity;
  let bestExp = null;
  for (let exp = 0; exp <= 18; exp++) {
    const candidate = raw / 10 ** exp;
    if (!(candidate > 0) || !Number.isFinite(candidate)) continue;
    const err = Math.abs(Math.log(candidate / spot));
    if (err < bestErr) {
      bestErr = err;
      best = candidate;
      bestExp = exp;
    }
  }

  return best !== null && bestExp !== null && bestErr <= Math.log(2)
    ? { price: best, scaleExponent10: bestExp, logDistance: bestErr }
    : null;
}

/**
 * @param {{ strike?: string | number | bigint | null, openingRaw?: string | number | bigint | null, spot: number }} p
 * @returns {{ kind: "strike" | "opening", price: number, raw: string, scaleExponent10: number, logDistance: number }}
 */
export function resolveReference(p) {
  if (!(p?.spot > 0) || !Number.isFinite(p.spot)) {
    throw new ReferenceError("NO_SPOT", "spot must be a positive finite number");
  }

  const strike = p.strike == null ? "" : String(p.strike).trim();
  const strikeIsZero = strike === "" || strike === "0";

  if (!strikeIsZero) {
    const scaled = scaleRawToSpot(strike, p.spot);
    if (scaled === null) {
      throw new ReferenceError(
        "UNUSABLE_STRIKE",
        `strike ${strike} cannot be scaled onto spot ${p.spot} within 2x`,
      );
    }
    return { kind: "strike", price: scaled.price, raw: strike, scaleExponent10: scaled.scaleExponent10, logDistance: scaled.logDistance };
  }

  if (p.openingRaw == null || p.openingRaw === "") {
    throw new ReferenceError(
      "MISSING_OPENING",
      "strike is 0/empty — opening price is required and was not supplied",
    );
  }
  const openingRaw = String(p.openingRaw).trim();
  const opening = scaleRawToSpot(openingRaw, p.spot);
  if (opening === null) {
    throw new ReferenceError(
      "UNUSABLE_OPENING",
      `opening ${openingRaw} cannot be scaled onto spot ${p.spot} within 2x`,
    );
  }
  return {
    kind: "opening",
    price: opening.price,
    raw: openingRaw,
    scaleExponent10: opening.scaleExponent10,
    logDistance: opening.logDistance,
  };
}
