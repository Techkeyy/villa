import { buildDashboardSnapshot } from "./contract.mjs";
import { DEFAULT_RISK_CONFIG, evaluateRisk } from "../risk-governor/index.mjs";
import { collectRiskSnapshot, createReadOnlyExchange } from "../risk-governor/live.mjs";
import { decimalToRaw, planQuotes } from "../quote-planner/index.mjs";

function rawFromDecimal(value, decimals, label) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  try {
    return decimalToRaw(String(value), decimals, "nearest", label).toString();
  } catch {
    return null;
  }
}

function bestRaw(level, decimals, label) {
  return Array.isArray(level) && level.length ? rawFromDecimal(level[0], decimals, label) : null;
}

function liveRestingRaw(orders, side, decimals) {
  const order = orders.find((item) => item.side === (side === "bid" ? "BUY" : "SELL") && item.outcome === "YES");
  return order ? rawFromDecimal(order.priceYes, decimals, `${side} resting price`) : null;
}

/**
 * Build the read-only LIVE dashboard envelope shared by Node hosting and Vercel.
 * This module never creates a signer and never exposes a write-capable path.
 */
export async function buildLiveEnvelope() {
  const exchange = createReadOnlyExchange();
  try {
    const { snapshot, context } = await collectRiskSnapshot(exchange);
    const decision = evaluateRisk(snapshot, DEFAULT_RISK_CONFIG);
    const yesSymbol = context.market.outcomes?.find((outcome) => outcome.label === "YES")?.symbol;
    const book = yesSymbol ? await exchange.fetchOrderBook(yesSymbol, 3) : null;
    const params = await exchange.client.getBinaryBookParams(context.onchain.pool);
    const decimals = context.decimals;
    const bestBidRaw = bestRaw(book?.bids?.[0], decimals, "best bid");
    const bestAskRaw = bestRaw(book?.asks?.[0], decimals, "best ask");
    const baseQuantityRaw = params.lotSize * 5n;
    const plan = planQuotes({
      fairValue: snapshot.fairValue,
      governor: {
        state: decision.state,
        permissions: decision.permissions,
        sizeMultiplier: decision.sizeMultiplier,
        triggeredRules: decision.triggeredRules,
        warnings: decision.warnings,
        reduceOnlyPolicy: decision.reduceOnlyPolicy,
        directionalRiskCapacity: DEFAULT_RISK_CONFIG.directionalExposureHard,
        limits: { directionalExposureHard: DEFAULT_RISK_CONFIG.directionalExposureHard, grossExposureHard: DEFAULT_RISK_CONFIG.grossExposureHard },
      },
      inventory: {
        yes: snapshot.inventory.yes,
        no: snapshot.inventory.no,
        yesAvailableRaw: rawFromDecimal(snapshot.inventory.yes, decimals, "YES inventory"),
      },
      pendingOrders: snapshot.openOrders,
      book: { bestBidRaw, bestAskRaw, empty: bestBidRaw === null && bestAskRaw === null },
      grid: { decimals, oneRaw: (10n ** BigInt(decimals)).toString(), tickSizeRaw: String(params.tickSize), lotSizeRaw: String(params.lotSize), minQuantityRaw: String(params.minQuantity) },
      capital: { collateralAvailable: snapshot.capital.collateralAvailable, collateralReserve: DEFAULT_RISK_CONFIG.minCollateralReserve },
      market: { marketId: context.marketId, timeRemainingSec: decision.authoritativeTime.timeRemainingSec },
      quote: { baseQuantityRaw: baseQuantityRaw.toString() },
    });
    const market = context.market.info;
    const yesRaw = rawFromDecimal(snapshot.inventory.yes, decimals, "YES inventory");
    const noRaw = rawFromDecimal(snapshot.inventory.no, decimals, "NO inventory");
    const collateralRaw = rawFromDecimal(snapshot.capital.collateralAvailable, decimals, "collateral");
    const sttRaw = rawFromDecimal(snapshot.gas.nativeBalance, 18, "STT");
    const dashboardInput = {
      generatedAtChainSec: decision.authoritativeTime.chainNowSec,
      system: { state: "RUNNING", network: "Somnia Shannon", walletAddress: context.owner, currentSeries: `BINARY:${String(market.asset).toUpperCase()}:${Number(market.intervalSec)}`, orchestratorVersion: "villa-dashboard-live-read-v1" },
      market: { marketId: context.marketId, asset: market.asset, intervalSec: Number(market.intervalSec), reference: context.reference.price, currentUnderlying: context.spot.price, expiry: Number(market.expiry), timeRemainingSec: decision.authoritativeTime.timeRemainingSec, status: Number(context.onchain.status) === 1 ? "Trading" : String(context.onchain.status) },
      model: { pUp: snapshot.fairValue.pUp, pDown: snapshot.fairValue.pDown, confidence: snapshot.fairValue.confidence, volatility: snapshot.fairValue.realizedVolPerSqrtSec, fairValueModelVersion: snapshot.fairValue.modelVersion },
      bookQuotes: { dreamdex: { bestBid: bestBidRaw, bestAsk: bestAskRaw }, villa: { targetBid: plan.bid.targetPriceRaw, targetAsk: plan.ask.targetPriceRaw, restingBid: liveRestingRaw(snapshot.openOrders, "bid", decimals), restingAsk: liveRestingRaw(snapshot.openOrders, "ask", decimals), bidQuantity: plan.bid.targetQuantityRaw, askQuantity: plan.ask.targetQuantityRaw }, quotePlanVersion: "villa-quote-v1" },
      risk: { action: decision.state, triggeredReasons: decision.triggeredRules, exposure: decision.exposure, capacity: decision.maxAdditionalExposure, collateral: snapshot.capital, gas: snapshot.gas },
      inventory: { currentMarketYes: yesRaw, currentMarketNo: noRaw, completeSets: yesRaw !== null && noRaw !== null ? (BigInt(yesRaw) < BigInt(noRaw) ? yesRaw : noRaw) : null, directionalExposure: decision.exposure.current?.directionalBalance ?? null, classifications: ["CURRENT_MARKET_ONLY"] },
      events: [],
      lifecycle: { currentMarket: context.marketId, rolloverState: "ACTIVE", settlementClaims: [], historicalResiduals: [] },
      accounting: { tUSDC: collateralRaw, STT: sttRaw, knownCollateralMovement: { status: snapshot.capital.accountingStatus } },
    };
    return { mode: "LIVE", source: "Live read-only Shannon adapter", snapshot: buildDashboardSnapshot(dashboardInput), evidence: null };
  } finally {
    await exchange.close().catch(() => undefined);
  }
}
