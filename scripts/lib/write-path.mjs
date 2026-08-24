/**
 * Pure helpers for the Shannon write-path gate.
 * No network. No secrets. Tick/lot math uses integer raw units.
 */

export class WritePathError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "WritePathError";
    this.code = code;
  }
}

/** @param {string | number} human @param {number} decimals */
export function toRaw(human, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new WritePathError("INVALID_DECIMALS", `decimals ${decimals} is not usable`);
  }
  const s = typeof human === "number" ? human.toFixed(decimals) : String(human).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new WritePathError("INVALID_AMOUNT", `not a non-negative decimal: ${human}`);
  }
  const [w, f = ""] = s.split(".");
  if (f.length > decimals) {
    throw new WritePathError("INVALID_AMOUNT", `more than ${decimals} fractional digits: ${human}`);
  }
  const frac = f.padEnd(decimals, "0");
  return BigInt(w + frac);
}

/** @param {bigint} raw @param {number} decimals */
export function fromRaw(raw, decimals) {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  const out = frac.length ? `${whole}.${frac}` : whole;
  return neg ? `-${out}` : out;
}

/** @param {bigint} raw @param {bigint} step */
export function snapDownRaw(raw, step) {
  if (step <= 0n) throw new WritePathError("INVALID_GRID", "grid step must be > 0");
  if (raw < 0n) throw new WritePathError("INVALID_AMOUNT", "raw amount must be >= 0");
  return (raw / step) * step;
}

/** @param {bigint} raw @param {bigint} step */
export function isOnGrid(raw, step) {
  if (step <= 0n) return false;
  return raw > 0n && raw % step === 0n;
}

/**
 * Smallest quantity the book will accept: max(lot, minQty), already on the lot grid.
 * @param {{ lotSize: bigint, minQuantity: bigint }} params
 */
export function minValidQuantity(params) {
  const lot = params.lotSize;
  const minQ = params.minQuantity;
  if (lot <= 0n) throw new WritePathError("INVALID_GRID", "lotSize must be > 0");
  const floor = minQ > lot ? minQ : lot;
  const snapped = snapDownRaw(floor, lot);
  const qty = snapped >= floor ? snapped : snapped + lot;
  if (qty < minQ) {
    throw new WritePathError("LOT", `cannot satisfy minQuantity ${minQ} on lot ${lot}`);
  }
  return qty;
}

/**
 * Resting BUY price in YES terms, strictly below the best ask.
 * Parks several ticks under the best bid so the test is unlikely to get hit.
 *
 * @param {{
 *   bestBid?: bigint,
 *   bestAsk?: bigint,
 *   tickSize: bigint,
 *   one: bigint,
 *   parkTicks?: number,
 * }} p
 */
export function selectRestingBuyPrice(p) {
  const tick = p.tickSize;
  const one = p.one;
  if (tick <= 0n || one <= 0n) throw new WritePathError("INVALID_GRID", "tick and one must be > 0");
  if (tick >= one) throw new WritePathError("TICK", "tickSize must be < 1.0 in price units");

  const park = BigInt(p.parkTicks ?? 10);
  let candidate;
  if (p.bestBid !== undefined && p.bestBid > tick * park) {
    candidate = snapDownRaw(p.bestBid - tick * park, tick);
  } else {
    // 10% of 1.0, or 10 ticks, whichever is larger and still < 1.
    const tenPct = snapDownRaw(one / 10n, tick);
    const tenTicks = tick * 10n;
    candidate = tenPct > tenTicks ? tenPct : tenTicks;
  }
  if (candidate < tick) candidate = tick;

  if (p.bestAsk !== undefined) {
    const maxRest = p.bestAsk - tick;
    if (maxRest < tick) {
      throw new WritePathError("WOULD_CROSS", "best ask is at the first tick; a buy cannot rest");
    }
    if (candidate >= p.bestAsk) candidate = snapDownRaw(maxRest, tick);
  }

  if (!isOnGrid(candidate, tick)) {
    throw new WritePathError("TICK", `price ${candidate} is off the tick grid ${tick}`);
  }
  if (candidate <= 0n || candidate >= one) {
    throw new WritePathError("TICK", `price ${candidate} is outside (0, 1)`);
  }
  if (p.bestAsk !== undefined && candidate >= p.bestAsk) {
    throw new WritePathError("WOULD_CROSS", "calculated buy price would cross the ask");
  }
  return candidate;
}

/**
 * Collateral a BUY_YES escrows: ceil(qty * price / one).
 * @param {bigint} quantity
 * @param {bigint} price
 * @param {bigint} one
 */
export function buyEscrow(quantity, price, one) {
  if (quantity <= 0n || price <= 0n || one <= 0n) {
    throw new WritePathError("INVALID_AMOUNT", "quantity, price, and one must be > 0");
  }
  return (quantity * price + one - 1n) / one;
}

export function secondsLeft(expirySec, nowSec) {
  return Number(expirySec) - Number(nowSec);
}

export function hasExpiryHeadroom(expirySec, nowSec, minLeftSec) {
  return secondsLeft(expirySec, nowSec) >= minLeftSec;
}

/**
 * Prefer 5m+ windows with enough time left. Reject 1m and nearly-expired markets.
 *
 * @param {{
 *   asset: string,
 *   intervalSec: number,
 *   expirySec: number,
 *   status: number,
 *   nowSec: number,
 *   minIntervalSec?: number,
 *   minLeftSec?: number,
 * }} c
 * @returns {null | { reject: string }}
 */
export function rejectMarket(c) {
  if (c.asset !== "BTC") return { reject: `asset ${c.asset} is not BTC` };
  if (c.status !== 1) return { reject: `on-chain status ${c.status} is not Trading (1)` };
  const minIv = c.minIntervalSec ?? 300;
  if (!(c.intervalSec >= minIv)) {
    return { reject: `interval ${c.intervalSec}s is shorter than ${minIv}s` };
  }
  const minLeft = c.minLeftSec ?? 120;
  const left = secondsLeft(c.expirySec, c.nowSec);
  if (left < minLeft) {
    return { reject: `only ${left}s left; need ${minLeft}s headroom` };
  }
  return null;
}

/**
 * Rank: longer interval first, then more time remaining.
 * @param {{ intervalSec: number, expirySec: number, nowSec: number }} a
 * @param {{ intervalSec: number, expirySec: number, nowSec: number }} b
 */
export function compareCandidates(a, b) {
  if (a.intervalSec !== b.intervalSec) return b.intervalSec - a.intervalSec;
  return secondsLeft(b.expirySec, b.nowSec) - secondsLeft(a.expirySec, a.nowSec);
}

/**
 * Order expiry in nanoseconds: soon, but never past the market's own expiry.
 * @param {{ nowSec: number, marketExpirySec: number, lifetimeSec?: number }} p
 */
export function orderExpireNs(p) {
  const life = p.lifetimeSec ?? 300;
  const wanted = p.nowSec + life;
  // Leave a few seconds of slack vs market expiry so we never send OrderExpiryBeyondMarket.
  const cap = p.marketExpirySec - 2;
  const sec = Math.min(wanted, cap);
  if (sec <= p.nowSec) {
    throw new WritePathError("EXPIRY", "market expiry is too close to set a future order expiry");
  }
  return BigInt(sec) * 1_000_000_000n;
}

export function assertSufficientStt(balanceWei, minWei) {
  if (balanceWei < minWei) {
    throw new WritePathError(
      "INSUFFICIENT_STT",
      `STT balance ${balanceWei} wei is below minimum ${minWei} wei`,
    );
  }
}

export function assertSufficientCollateral(balanceRaw, neededRaw) {
  if (balanceRaw < neededRaw) {
    throw new WritePathError(
      "INSUFFICIENT_TUSDC",
      `tUSDC ${balanceRaw} < required ${neededRaw} (raw)`,
    );
  }
}

export function isPostOnlyWouldCross(err) {
  const name = err?.errorName || err?.shortMessage || err?.message || String(err);
  return String(name).includes("PostOnlyWouldCross");
}
