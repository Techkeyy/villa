/**
 * Read-only acquisition and assembly for the bounded rollover proof.
 *
 * This file owns SDK/indexer/RPC calls only.  It never creates a signer and
 * never imports a writer.  Selection, state transitions, market binding, and
 * residual classification remain in ./index.mjs so they are fixture-testable.
 */

import { isBinaryMarket } from "@somnia-chain/markets-sdk";
import { createReadOnlyExchange, readChainTime, readOpenOrders, collectRiskSnapshot } from "../risk-governor/live.mjs";
import { evaluateRisk, DEFAULT_RISK_CONFIG } from "../risk-governor/index.mjs";
import { decimalToRaw, planQuotes } from "../quote-planner/index.mjs";
import { fetchReference, fetchSpot } from "../fair-value/live.mjs";
import {
  buildMarketContext,
  classifyMarketInventory,
  inventoryForMarket,
  selectSuccessor,
  verifySuccessorCandidate,
} from "./index.mjs";

export const ROLLOVER_INITIAL_HEADROOM_SEC = 15;
export const ROLLOVER_SHORT_INTERVALS_SEC = Object.freeze([60, 300]);
export const ROLLOVER_DISCOVERY_LIMIT = 100;
export const ROLLOVER_POLL_INTERVAL_MS = 3_000;
export const ROLLOVER_MAX_OBSERVATION_SEC = 420;
export const PHASE_5A_RESIDUAL_MARKET_ID = "0x000000000000000000000000000000000000000000000000000000000000a00b";

function finite(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label} is not finite`);
  return result;
}

function marketIdOf(row) {
  return row?.marketId ?? row?.info?.marketId ?? row?.id ?? null;
}

function indexedInterval(row) {
  return finite(row?.intervalSec ?? row?.info?.intervalSec, "indexed intervalSec");
}

function indexedExpiry(row) {
  return finite(row?.expiry ?? row?.info?.expiry, "indexed expiry");
}

function isTrading(onchain) {
  return Number(onchain?.status) === 1 && !onchain?.isResolved && !onchain?.isVoided;
}

function candidateSort(a, b) {
  const aInterval = indexedInterval(a);
  const bInterval = indexedInterval(b);
  const aPreferred = ROLLOVER_SHORT_INTERVALS_SEC.includes(aInterval);
  const bPreferred = ROLLOVER_SHORT_INTERVALS_SEC.includes(bInterval);
  if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
  if (aInterval !== bInterval) return aInterval - bInterval;
  return indexedExpiry(a) - indexedExpiry(b) || String(marketIdOf(a)).localeCompare(String(marketIdOf(b)));
}

/** Adapt an SDK BinaryMarket row to the existing read-only risk collector. */
export function toCollectorMarket(row, onchain) {
  const marketId = marketIdOf(row);
  if (!marketId) throw new Error("binary row has no marketId");
  const asset = String(row.asset ?? "").toUpperCase();
  const intervalSec = indexedInterval(row);
  const expiry = String(onchain?.expiry ?? row.expiry);
  const decimals = Number(row.quoteDecimals ?? row.baseDecimals ?? onchain?.decimals);
  return {
    type: "binary",
    marketType: "BINARY",
    symbol: row.symbol ?? `${asset}-${intervalSec}s`,
    active: true,
    outcomes: [
      { label: "YES", index: 0, symbol: `${row.symbol ?? `${asset}-${intervalSec}s`}#YES` },
      { label: "NO", index: 1, symbol: `${row.symbol ?? `${asset}-${intervalSec}s`}#NO` },
    ],
    info: {
      marketId: String(marketId),
      asset,
      intervalSec: String(intervalSec),
      expiry,
      strike: String(row.strike ?? "0"),
      baseDecimals: decimals,
      quoteDecimals: decimals,
      venueId: row.venueId ?? null,
    },
  };
}

/** Read and on-chain-gate short BTC windows for selecting Market A. */
export async function discoverCurrentShortBtc(exchange, chainNowSec, {
  minHeadroomSec = ROLLOVER_INITIAL_HEADROOM_SEC,
  limit = ROLLOVER_DISCOVERY_LIMIT,
} = {}) {
  const startedAtMs = Date.now();
  const query = typeof exchange.client.listLiveBinaryMarkets === "function"
    ? "client.listLiveBinaryMarkets"
    : "client.listBinaryMarkets";
  const rows = typeof exchange.client.listLiveBinaryMarkets === "function"
    ? await exchange.client.listLiveBinaryMarkets({ asset: "BTC", status: "Trading", orderBy: "closingSoon", limit, nowSec: Math.floor(chainNowSec) })
    : await exchange.client.listBinaryMarkets({ asset: "BTC", status: "Trading", limit });
  const candidates = rows
    .filter((row) => isBinaryMarket(row) || String(row.marketType ?? "").toUpperCase() === "BINARY")
    .filter((row) => String(row.asset ?? "").toUpperCase() === "BTC")
    .filter((row) => ROLLOVER_SHORT_INTERVALS_SEC.includes(indexedInterval(row)))
    .filter((row) => indexedExpiry(row) - chainNowSec >= minHeadroomSec)
    .sort(candidateSort);
  const rejected = [];
  for (const row of candidates) {
    const marketId = marketIdOf(row);
    try {
      const onchain = await exchange.client.getMarketOnchain(marketId);
      if (!isTrading(onchain) || finite(onchain.expiry, "on-chain expiry") - chainNowSec < minHeadroomSec) {
        rejected.push({ marketId, code: "ONCHAIN_NOT_TRADING_OR_HEADROOM", status: onchain.status, expiry: String(onchain.expiry) });
        continue;
      }
      const openOrderRead = await readOpenOrders(exchange, onchain, exchange.walletAddress, marketId, onchain.decimals);
      if (openOrderRead.status !== "VERIFIED") {
        rejected.push({ marketId, code: "OPEN_ORDER_STATE_INVALID", warning: openOrderRead.warning });
        continue;
      }
      if (openOrderRead.orders.length > 0) {
        rejected.push({ marketId, code: "VILLA_ORDERS_EXIST", count: openOrderRead.orders.length });
        continue;
      }
      return {
        query,
        rowsReturned: rows.length,
        durationMs: Date.now() - startedAtMs,
        candidatesConsidered: candidates.length,
        rejected,
        selected: { row, onchain, marketId: String(marketId), intervalSec: indexedInterval(row), expirySec: finite(onchain.expiry, "on-chain expiry"), openOrderRead },
      };
    } catch (error) {
      rejected.push({ marketId, code: "CANDIDATE_READ_FAILED", reason: error?.message ?? String(error) });
    }
  }
  return {
    query,
    rowsReturned: rows.length,
    durationMs: Date.now() - startedAtMs,
    candidatesConsidered: candidates.length,
    rejected,
    selected: null,
  };
}

export async function resolveLiveMarketContext(exchange, selected, chainTime) {
  const row = selected.row ?? selected.market ?? selected;
  const marketId = selected.marketId ?? marketIdOf(row);
  const spot = await fetchSpot(exchange, "BTC", { nowSec: chainTime.chainNowSec });
  const reference = await fetchReference(exchange, {
    marketId,
    strike: row.strike,
    spot: spot.price,
  });
  return buildMarketContext({
    market: row,
    onchain: selected.onchain,
    reference: { ...reference, marketId },
    chainNowSec: chainTime.chainNowSec,
    blockNumber: chainTime.blockNumber,
  });
}

/**
 * Rediscover and verify only the same configured series.  Each indexer row is
 * checked against chain truth before the pure selector sees it.
 */
export async function discoverSuccessor(exchange, currentContext, chainNowSec, { limit = ROLLOVER_DISCOVERY_LIMIT } = {}) {
  const startedAtMs = Date.now();
  const query = typeof exchange.client.listLiveBinaryMarkets === "function"
    ? "client.listLiveBinaryMarkets"
    : "client.listBinaryMarkets";
  const rows = typeof exchange.client.listLiveBinaryMarkets === "function"
    ? await exchange.client.listLiveBinaryMarkets({ asset: currentContext.asset, intervalSec: currentContext.intervalSec, status: "Trading", orderBy: "closingSoon", limit, nowSec: Math.floor(chainNowSec) })
    : await exchange.client.listBinaryMarkets({ asset: currentContext.asset, intervalSec: currentContext.intervalSec, status: "Trading", limit });
  const candidates = [];
  const rejected = [];
  for (const row of rows) {
    let onchain;
    try {
      onchain = await exchange.client.getMarketOnchain(marketIdOf(row));
    } catch (error) {
      rejected.push({ marketId: marketIdOf(row), code: "ONCHAIN_READ_FAILED", reason: error?.message ?? String(error) });
      continue;
    }
    const result = verifySuccessorCandidate({ current: currentContext, candidate: row, onchain, chainNowSec });
    if (!result.verified) {
      rejected.push(result);
      continue;
    }
    candidates.push({ market: row, onchain, marketId: marketIdOf(row), status: onchain.status, expirySec: Number(onchain.expiry) });
  }
  const selection = selectSuccessor({ current: currentContext, candidates, chainNowSec });
  return {
    query,
    rowsReturned: rows.length,
    durationMs: Date.now() - startedAtMs,
    candidates,
    rejected: [...rejected, ...selection.rejections],
    selection,
  };
}

function minValidQuantity(params) {
  if (!params) return null;
  const lot = BigInt(params.lotSize);
  const minimum = BigInt(params.minQuantity);
  if (lot <= 0n || minimum <= 0n) return null;
  return ((minimum > lot ? minimum : lot) + lot - 1n) / lot * lot;
}

function bestPrice(level) {
  return level?.price === undefined || level?.price === null ? null : String(level.price);
}

export function binaryBookSummary(book, decimals) {
  const oneRaw = 10n ** BigInt(decimals);
  const bestBidRaw = bestPrice(book?.yesBids?.[0]);
  const bestAskRaw = bestPrice(book?.yesAsks?.[0]);
  const midpoint = bestBidRaw !== null && bestAskRaw !== null
    ? Number(BigInt(bestBidRaw) + BigInt(bestAskRaw)) / 2 / Number(oneRaw)
    : null;
  return { bestBidRaw, bestAskRaw, midpoint: Number.isFinite(midpoint) ? midpoint : null };
}

function buildPlannerInput({ snapshot, decision, book, params, context }) {
  const decimals = context.decimals;
  const oneRaw = 10n ** BigInt(decimals);
  const minQuantity = minValidQuantity(params);
  const rawOrNull = (value) => value === null || value === undefined ? null : String(value);
  return {
    fairValue: snapshot.fairValue,
    governor: {
      state: decision.state,
      permissions: decision.permissions,
      sizeMultiplier: decision.sizeMultiplier,
      triggeredRules: decision.triggeredRules,
      warnings: decision.warnings,
      reduceOnlyPolicy: decision.reduceOnlyPolicy,
      directionalRiskCapacity: DEFAULT_RISK_CONFIG.directionalExposureHard,
      limits: {
        directionalExposureHard: DEFAULT_RISK_CONFIG.directionalExposureHard,
        grossExposureHard: DEFAULT_RISK_CONFIG.grossExposureHard,
      },
    },
    inventory: {
      yesRaw: decimalToRaw(String(snapshot.inventory.yes), decimals, "nearest", "YES inventory").toString(),
      noRaw: decimalToRaw(String(snapshot.inventory.no), decimals, "nearest", "NO inventory").toString(),
      yesAvailableRaw: decimalToRaw(String(snapshot.inventory.yes), decimals, "nearest", "YES available inventory").toString(),
    },
    pendingOrders: snapshot.openOrders,
    book: { bestBidRaw: rawOrNull(book?.yesBids?.[0]?.price), bestAskRaw: rawOrNull(book?.yesAsks?.[0]?.price), empty: !book?.yesBids?.length && !book?.yesAsks?.length },
    grid: {
      decimals,
      oneRaw: oneRaw.toString(),
      tickSizeRaw: params ? String(params.tickSize) : null,
      lotSizeRaw: params ? String(params.lotSize) : null,
      minQuantityRaw: params ? String(params.minQuantity) : null,
    },
    capital: {
      collateralAvailableRaw: decimalToRaw(String(snapshot.capital.collateralAvailable), decimals, "nearest", "collateral").toString(),
      collateralReserveRaw: decimalToRaw(String(DEFAULT_RISK_CONFIG.minCollateralReserve), decimals, "nearest", "collateral reserve").toString(),
      collateralReserve: DEFAULT_RISK_CONFIG.minCollateralReserve,
    },
    market: { marketId: context.marketId, timeRemainingSec: decision.authoritativeTime.timeRemainingSec },
    quote: { baseQuantityRaw: minQuantity === null ? "0" : minQuantity.toString() },
  };
}

/** Assemble a fresh B snapshot, book comparison, governor, and quote plan. */
export async function assembleSuccessorPipeline(exchange, selected, chainTime, owner = exchange.walletAddress, options = {}) {
  const collectorMarket = toCollectorMarket(selected.market, selected.onchain);
  let collected;
  try {
    collected = await collectRiskSnapshot(exchange, {
      chainTime,
      market: { market: collectorMarket, onchain: selected.onchain },
      owner,
      knownOrderIds: options.knownOrderIds,
      knownOrders: options.knownOrders,
    });
  } catch (error) {
    throw new Error(`B risk snapshot read failed: ${error?.message || error}`);
  }
  const context = buildMarketContext({
    market: selected.market,
    onchain: selected.onchain,
    reference: { ...collected.context.reference, marketId: selected.marketId },
    chainNowSec: collected.snapshot.chainTime.chainNowSec,
    blockNumber: collected.snapshot.chainTime.blockNumber,
  });
  const decimals = context.decimals;
  let book = null;
  let params = null;
  let bookWarning = null;
  try {
    [book, params] = await Promise.all([
      exchange.client.getBinaryOrderBook(selected.onchain.pool, { depth: 5, decimals }),
      exchange.client.getBinaryBookParams(selected.onchain.pool),
    ]);
  } catch (error) {
    bookWarning = `BOOK_OR_GRID_READ_FAILED: ${error?.message ?? String(error)}`;
  }
  const decision = evaluateRisk(collected.snapshot, DEFAULT_RISK_CONFIG);
  const plannerInput = buildPlannerInput({ snapshot: collected.snapshot, decision, book, params, context: collected.context });
  const plan = planQuotes(plannerInput);
  let inventoryBalances;
  try {
    inventoryBalances = {
      [context.yesId]: await exchange.client.getOutcomeBalance({ outcomeToken: selected.onchain.outcomeToken, account: owner, id: BigInt(context.yesId) }),
      [context.noId]: await exchange.client.getOutcomeBalance({ outcomeToken: selected.onchain.outcomeToken, account: owner, id: BigInt(context.noId) }),
    };
  } catch (error) {
    throw new Error(`B inventory read failed: ${error?.message || error}`);
  }
  const inventory = inventoryForMarket({ marketId: selected.marketId, yesId: context.yesId, noId: context.noId, balancesByTokenId: inventoryBalances });
  return {
    selected,
    collectorMarket,
    context,
    snapshot: collected.snapshot,
    chainTime: collected.snapshot.chainTime,
    collectedContext: collected.context,
    decision,
    book,
    params,
    bookSummary: binaryBookSummary(book, decimals),
    bookWarning,
    plannerInput,
    plan,
    inventory,
    openOrderRead: collected.context.openOrderRead,
  };
}

export async function readKnownHistoricalResidual(exchange, owner = exchange.walletAddress) {
  try {
    const onchain = await exchange.client.getMarketOnchain(PHASE_5A_RESIDUAL_MARKET_ID);
    const [yesRaw, noRaw] = await Promise.all([
      exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: owner, id: onchain.yesId }),
      exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: owner, id: onchain.noId }),
    ]);
    return classifyMarketInventory({
      marketId: PHASE_5A_RESIDUAL_MARKET_ID,
      yesId: String(onchain.yesId),
      noId: String(onchain.noId),
      balancesByTokenId: { [String(onchain.yesId)]: yesRaw, [String(onchain.noId)]: noRaw },
      status: onchain.status,
      isResolved: onchain.isResolved,
      isVoided: onchain.isVoided,
      winningOutcome: onchain.winningOutcome,
    });
  } catch (error) {
    return { marketId: PHASE_5A_RESIDUAL_MARKET_ID, labels: [], knownResidual: [], warning: error?.message ?? String(error) };
  }
}

export { createReadOnlyExchange, readChainTime, readOpenOrders };
