/**
 * Live acquisition/assembly for Phase 4B. Policy remains in policy.mjs; this
 * file only maps SDK/chain/indexer reads into the existing pure pipeline.
 */
import { isBinaryMarket } from "@somnia-chain/markets-sdk";
import { evaluateRisk, DEFAULT_RISK_CONFIG } from "../risk-governor/index.mjs";
import { collectRiskSnapshot, readChainTime, readOpenOrders } from "../risk-governor/live.mjs";
import { decimalToRaw, planQuotes } from "../quote-planner/index.mjs";
import { minValidQuantity, toRaw } from "../../scripts/lib/write-path.mjs";

export const EXECUTION_MIN_INTERVAL_SEC = 300;
export const EXECUTION_MIN_HEADROOM_SEC = 600;

function rawBook(level, decimals, label) {
  if (!Array.isArray(level) || level[0] === undefined || level[0] === null) return null;
  const value = Number(level[0]);
  if (!Number.isFinite(value)) throw new Error(`${label} is not finite`);
  return toRaw(value.toFixed(decimals), decimals).toString();
}

function midpoint(book) {
  const bid = book?.bids?.[0]?.[0];
  const ask = book?.asks?.[0]?.[0];
  if (!(bid > 0) || !(ask > 0) || bid >= ask || bid >= 1 || ask > 1) return null;
  return (bid + ask) / 2;
}

function buildPlannerInput({ snapshot, decision, book, params, context }) {
  const decimals = context.decimals;
  const oneRaw = 10n ** BigInt(decimals);
  const minQuantity = minValidQuantity(params);
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
    book: { bestBidRaw: rawBook(book.bids?.[0], decimals, "best bid"), bestAskRaw: rawBook(book.asks?.[0], decimals, "best ask"), empty: !book.bids?.length && !book.asks?.length },
    grid: { decimals, oneRaw: oneRaw.toString(), tickSizeRaw: params.tickSize.toString(), lotSizeRaw: params.lotSize.toString(), minQuantityRaw: params.minQuantity.toString() },
    capital: {
      collateralAvailableRaw: decimalToRaw(String(snapshot.capital.collateralAvailable), decimals, "nearest", "collateral").toString(),
      collateralReserveRaw: decimalToRaw(String(DEFAULT_RISK_CONFIG.minCollateralReserve), decimals, "nearest", "collateral reserve").toString(),
      collateralReserve: DEFAULT_RISK_CONFIG.minCollateralReserve,
    },
    market: { marketId: context.marketId, timeRemainingSec: decision.authoritativeTime.timeRemainingSec },
    quote: { baseQuantityRaw: (minQuantity > params.lotSize * 5n ? minQuantity : params.lotSize * 5n).toString() },
  };
}

export async function discoverCleanBtcMarket(exchange, owner, chainNowSec, { minIntervalSec = EXECUTION_MIN_INTERVAL_SEC, minHeadroomSec = EXECUTION_MIN_HEADROOM_SEC } = {}) {
  const loaded = Object.values(await exchange.loadMarkets(true));
  const candidates = [];
  const activeOrderMarkets = [];
  for (const market of loaded) {
    if (market.type !== "binary" || !isBinaryMarket(market.info) || market.info.asset !== "BTC") continue;
    const intervalSec = Number(market.info.intervalSec);
    if (!Number.isFinite(intervalSec) || intervalSec < minIntervalSec) continue;
    let onchain;
    try { onchain = await exchange.client.getMarketOnchain(market.info.marketId); } catch { continue; }
    const expirySec = Number(onchain.expiry ?? market.info.expiry);
    if (Number(onchain.status) !== 1 || onchain.isResolved || onchain.isVoided || !Number.isFinite(expirySec) || expirySec - chainNowSec < minHeadroomSec) continue;
    const activeIds = await exchange.client.getOwnOpenOrdersOnchain(onchain.pool, owner);
    if (activeIds.length) activeOrderMarkets.push({ marketId: market.info.marketId, symbol: market.symbol, pool: onchain.pool, ids: activeIds.map(String) });
    candidates.push({ market, onchain, intervalSec, expirySec, secondsLeft: expirySec - chainNowSec });
  }
  if (activeOrderMarkets.length) throw new Error(`ACTIVE_ORDERS_EXIST: ${activeOrderMarkets.reduce((n, item) => n + item.ids.length, 0)} active VILLA order(s) found across current BTC pools`);
  candidates.sort((a, b) => b.intervalSec - a.intervalSec || b.secondsLeft - a.secondsLeft);
  if (!candidates.length) throw new Error(`no clean BTC Trading market with ${minHeadroomSec}s headroom`);
  return { selected: candidates[0], candidates };
}

export async function readRawAccountState(exchange, publicClient, context, owner) {
  const [sttRaw, collateralRaw, yesRaw, noRaw] = await Promise.all([
    publicClient.getBalance({ address: owner }),
    exchange.client.getErc20Balance(context.onchain.collateral, owner),
    exchange.client.getOutcomeBalance({ outcomeToken: context.onchain.outcomeToken, account: owner, id: context.onchain.yesId }),
    exchange.client.getOutcomeBalance({ outcomeToken: context.onchain.outcomeToken, account: owner, id: context.onchain.noId }),
  ]);
  return { sttRaw, collateralRaw, yesRaw, noRaw };
}

export async function assembleLivePipeline(exchange, { selected, owner, publicClient }) {
  const startedAtMs = Date.now();
  const chainTime = await readChainTime(exchange);
  const onchain = await exchange.client.getMarketOnchain(selected.market.info.marketId);
  const current = { market: selected.market, onchain };
  const { snapshot, context } = await collectRiskSnapshot(exchange, { chainTime, market: current, owner });
  const yesSymbol = context.market.outcomes?.find((outcome) => outcome.label === "YES")?.symbol;
  if (!yesSymbol) throw new Error("selected market has no YES outcome symbol");
  const [book, params, rawState] = await Promise.all([
    exchange.fetchOrderBook(yesSymbol, 5),
    exchange.client.getBinaryBookParams(onchain.pool),
    readRawAccountState(exchange, publicClient, context, owner),
  ]);
  const decision = evaluateRisk(snapshot, DEFAULT_RISK_CONFIG);
  const plannerInput = buildPlannerInput({ snapshot, decision, book, params, context });
  const plan = planQuotes(plannerInput);
  return {
    capturedAtMs: Date.now(),
    startedAtMs,
    chainTime,
    market: current,
    snapshot,
    context,
    decision,
    book,
    params,
    rawState,
    yesSymbol,
    plannerInput,
    plan,
    midpoint: midpoint(book),
  };
}

export function simulateMintPipeline(pipeline, mintAmountRaw) {
  const decimals = pipeline.context.decimals;
  const amount = BigInt(mintAmountRaw);
  if (amount <= 0n) throw new Error("mintAmountRaw must be positive");
  const snapshot = structuredClone(pipeline.snapshot);
  snapshot.inventory.yes += Number(amount) / 10 ** decimals;
  snapshot.inventory.no += Number(amount) / 10 ** decimals;
  snapshot.capital.collateralAvailable -= Number(amount) / 10 ** decimals;
  const decision = evaluateRisk(snapshot, DEFAULT_RISK_CONFIG);
  const plannerInput = buildPlannerInput({ snapshot, decision, book: pipeline.book, params: pipeline.params, context: pipeline.context });
  return { snapshot, decision, plannerInput, plan: planQuotes(plannerInput) };
}

export async function readTargetOpenOrders(exchange, pipeline, owner) {
  const result = await readOpenOrders(exchange, pipeline.context.onchain, owner, pipeline.context.marketId, pipeline.context.decimals);
  if (result.status !== "VERIFIED") throw new Error(result.warning || "open-order state is ambiguous");
  return result;
}

export { buildPlannerInput, midpoint, rawBook };
