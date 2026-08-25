/**
 * Read-only acquisition of fair-value inputs from a live SomniaMarkets client.
 * This module contains I/O only. It never places, cancels, mints, redeems, or
 * reads wallet balances.
 */

import { resolveReference, ReferenceError } from "./reference.mjs";
import { realizedVolPerSqrtSec } from "./vol.mjs";

export class LiveDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LiveDataError";
    this.code = code;
  }
}

// Shannon's chain clock can run ahead of the workstation clock. A modest
// positive offset is not stale data; it is a clock-domain difference. The
// snapshot reports it and uses the latest chain timestamp for chain-time math.
export const MAX_CHAIN_CLOCK_SKEW_SEC = 900;
export const MAX_SOURCE_AGE_SEC = 60;

/**
 * Read the one-shot price-feed metadata so freshness uses the oracle write time
 * rather than the time our process happened to query it.
 *
 * @param {import("@somnia-chain/markets-sdk").SomniaMarkets} exchange
 * @param {string} asset
 * @param {{ nowMs?: number, nowSec?: number }} [opts]
 */
export async function fetchSpot(exchange, asset, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const nowSec = opts.nowSec ?? nowMs / 1000;
  const info = await exchange.client.fetchPriceFeedInfo(asset);
  const px = info?.latest;
  if (!px || !(px.price > 0) || !Number.isFinite(px.price)) {
    throw new LiveDataError("MISSING_SPOT", `price feed has no usable ${asset} observation`);
  }
  if (!Number.isFinite(px.blockTimestamp) || px.blockTimestamp <= 0) {
    throw new LiveDataError("BAD_SPOT_TIMESTAMP", "price feed block timestamp is invalid");
  }

  const priceAgeSec = info.updatedAtMs != null
    ? (nowMs - info.updatedAtMs) / 1000
    : nowSec - px.blockTimestamp;
  if (!Number.isFinite(priceAgeSec) || priceAgeSec < -MAX_CHAIN_CLOCK_SKEW_SEC) {
    throw new LiveDataError("BAD_SPOT_AGE", `price feed freshness is invalid: ${priceAgeSec}`);
  }

  const sourceAgeSec = info.sourceUpdatedAtMs == null || info.updatedAtMs == null
    ? null
    : (info.updatedAtMs - info.sourceUpdatedAtMs) / 1000;
  if (sourceAgeSec !== null && (!Number.isFinite(sourceAgeSec) || sourceAgeSec < -5)) {
    throw new LiveDataError("BAD_SOURCE_AGE", `price source freshness is invalid: ${sourceAgeSec}`);
  }
  if (sourceAgeSec !== null && sourceAgeSec > MAX_SOURCE_AGE_SEC) {
    throw new LiveDataError("STALE_SOURCE", `price source age ${sourceAgeSec}s exceeds ${MAX_SOURCE_AGE_SEC}s`);
  }

  return {
    price: px.price,
    tSec: px.blockTimestamp,
    priceAgeSec: Math.max(0, priceAgeSec),
    chainClockSkewSec: Math.max(0, -priceAgeSec),
    sourceAgeSec,
    blockNumber: px.blockNumber,
    blockTimestamp: px.blockTimestamp,
    updatedAtMs: info.updatedAtMs,
    sourceUpdatedAtMs: info.sourceUpdatedAtMs,
    feedDecimals: info.decimals,
  };
}

/**
 * Resolve a binary market's explicit strike or its strike=0 opening reference.
 * The market ID is deliberately used here; a recycled pool address is not a
 * market identity.
 *
 * @param {import("@somnia-chain/markets-sdk").SomniaMarkets} exchange
 * @param {{ marketId: string, strike?: string | null, spot: number }} p
 */
export async function fetchReference(exchange, p) {
  if (!p?.marketId || typeof p.marketId !== "string") {
    throw new ReferenceError("MISSING_MARKET_ID", "marketId is required to resolve an opening reference");
  }
  const strike = p.strike == null ? "" : String(p.strike).trim();
  if (strike !== "" && strike !== "0") {
    return resolveReference({ strike, spot: p.spot });
  }

  const openings = await exchange.client.getOpeningPrices([p.marketId]);
  const wanted = p.marketId.toLowerCase();
  const entry = Object.entries(openings ?? {}).find(([key]) => key.toLowerCase() === wanted);
  const openingRaw = entry?.[1] ?? null;
  return resolveReference({ strike: "0", openingRaw, spot: p.spot });
}

/**
 * Fetch newest-first SDK price points, put them in chronological order, and
 * estimate per-√second realized log-return volatility.
 *
 * @param {import("@somnia-chain/markets-sdk").SomniaMarkets} exchange
 * @param {string} asset
 * @param {{ limit?: number, nowSec?: number, maxAgeSec?: number, maxGapSec?: number, minReturns?: number, minElapsedSec?: number }} [opts]
 */
export async function fetchVolFromPriceHistory(exchange, asset, opts = {}) {
  const nowSec = opts.nowSec ?? Date.now() / 1000;
  const rows = await exchange.client.fetchPriceHistory(asset, { limit: opts.limit ?? 200 });
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new LiveDataError("MISSING_VOL_HISTORY", `price feed returned no ${asset} history`);
  }

  const ticks = rows
    .map((row) => ({
      price: row.price,
      tSec: row.blockTimestamp,
    }))
    .reverse();
  try {
    return await realizedVolPerSqrtSec(ticks, {
      nowSec,
      minReturns: opts.minReturns ?? 12,
      minElapsedSec: opts.minElapsedSec ?? 60,
      maxAgeSec: opts.maxAgeSec ?? 180,
      maxGapSec: opts.maxGapSec ?? 180,
    });
  } catch (err) {
    if (err?.name === "VolError") throw err;
    throw new LiveDataError("VOL_ESTIMATION_FAILED", String(err?.message || err));
  }
}
