/**
 * Pure fact gate for a genuinely current BTC 5m Shannon market.
 *
 * Market IDs are supplied by the live indexer/RPC read and are never
 * hardcoded. The selector verifies the exact configured series and requires
 * the venue facts needed by the first bounded proof.
 */

export const LP_MARKET_SELECTION_VERSION = "villa-lp-market-selection-v1";
export const LP_MARKET_SERIES = "BINARY:BTC:300";
export const LP_MARKET_ASSET = "BTC";
export const LP_MARKET_INTERVAL_SEC = 300;
export const LP_MARKET_MIN_HEADROOM_SEC = 120;

export class LpMarketSelectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LpMarketSelectionError";
    this.code = code;
  }
}

function finite(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new LpMarketSelectionError("FACT_INVALID", `${label} must be finite`);
  return result;
}

function marketId(value) {
  const text = String(value ?? "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) throw new LpMarketSelectionError("MARKET_ID_INVALID", "current market id must be bytes32");
  return text.toLowerCase();
}

function statusIsTrading(value) {
  return Number(value) === 1 || String(value ?? "").toLowerCase() === "trading";
}

function requiredFact(candidate, names, label) {
  for (const name of names) {
    if (candidate[name] !== undefined && candidate[name] !== null) return candidate[name];
  }
  throw new LpMarketSelectionError("FACT_MISSING", `${label} was not verified for the live market`);
}

function candidateFacts(candidate) {
  const row = candidate?.row ?? candidate?.market ?? candidate;
  const onchain = candidate?.onchain ?? {};
  const marketIdValue = marketId(candidate?.marketId ?? row?.marketId ?? row?.info?.marketId ?? row?.id);
  const asset = String(row?.asset ?? row?.info?.asset ?? "").toUpperCase();
  const intervalSec = finite(row?.intervalSec ?? row?.info?.intervalSec, "market intervalSec");
  const expirySec = finite(candidate?.expirySec ?? onchain?.expiry ?? row?.expiry ?? row?.info?.expiry, "market expiry");
  const status = onchain?.status ?? candidate?.status ?? row?.status;
  if (asset !== LP_MARKET_ASSET || intervalSec !== LP_MARKET_INTERVAL_SEC) throw new LpMarketSelectionError("SERIES_MISMATCH", `market must be ${LP_MARKET_SERIES}`);
  if (!statusIsTrading(status) || onchain?.isResolved || onchain?.isVoided) throw new LpMarketSelectionError("MARKET_NOT_TRADING", "market is not currently Trading");
  if (candidate?.poolFinalized === true || onchain?.poolFinalized === true) throw new LpMarketSelectionError("POOL_FINALIZED", "market pool is already finalized and cannot accept a bounded order proof");
  const grid = requiredFact(candidate, ["grid", "bookParams", "params"], "order grid");
  const book = requiredFact(candidate, ["book", "orderBook"], "order book");
  const reference = requiredFact(candidate, ["reference", "referencePrice"], "reference price");
  const minimumOrderRaw = candidate?.minimumOrderRaw ?? candidate?.minQuantityRaw ?? grid?.minQuantityRaw ?? grid?.minQuantity;
  if (minimumOrderRaw === undefined || minimumOrderRaw === null) throw new LpMarketSelectionError("MIN_ORDER_MISSING", "minimum order quantity was not verified");
  return {
    marketId: marketIdValue,
    series: LP_MARKET_SERIES,
    asset,
    intervalSec,
    expirySec,
    status: "Trading",
    strike: row?.strike ?? row?.info?.strike ?? null,
    venueId: row?.venueId ?? row?.info?.venueId ?? null,
    pool: onchain?.pool ?? candidate?.pool ?? null,
    poolFinalized: false,
    grid,
    book,
    reference,
    minimumOrderRaw: String(minimumOrderRaw),
  };
}

/** Select the earliest current candidate after all exact-series fact checks. */
export function selectCurrentBtc5mMarket({ candidates = [], chainNowSec, minHeadroomSec = LP_MARKET_MIN_HEADROOM_SEC } = {}) {
  const now = finite(chainNowSec, "chainNowSec");
  const headroom = finite(minHeadroomSec, "minHeadroomSec");
  if (!Array.isArray(candidates)) throw new LpMarketSelectionError("CANDIDATES_INVALID", "market candidates must be an array");
  const rejected = [];
  const accepted = [];
  for (const candidate of candidates) {
    try {
      const facts = candidateFacts(candidate);
      const secondsRemaining = facts.expirySec - now;
      if (secondsRemaining < headroom) throw new LpMarketSelectionError("HEADROOM_INSUFFICIENT", `market has only ${Math.floor(secondsRemaining)}s of headroom`);
      accepted.push({ ...facts, secondsRemaining });
    } catch (error) {
      rejected.push({ marketId: candidate?.marketId ?? candidate?.row?.marketId ?? null, code: error?.code ?? "FACT_INVALID", reason: error?.message ?? String(error) });
    }
  }
  accepted.sort((left, right) => left.expirySec - right.expirySec || left.marketId.localeCompare(right.marketId));
  return Object.freeze({
    version: LP_MARKET_SELECTION_VERSION,
    series: LP_MARKET_SERIES,
    chainNowSec: now,
    minHeadroomSec: headroom,
    selected: accepted[0] ?? null,
    accepted: Object.freeze(accepted),
    rejected: Object.freeze(rejected),
  });
}
