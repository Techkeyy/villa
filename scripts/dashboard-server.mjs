import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDashboardSnapshot } from "../src/dashboard/contract.mjs";
import { buildReplayEnvelope, REPLAY_SCENES } from "../src/dashboard/replay.mjs";
import { DEFAULT_RISK_CONFIG, evaluateRisk } from "../src/risk-governor/index.mjs";
import { collectRiskSnapshot, createReadOnlyExchange } from "../src/risk-governor/live.mjs";
import { decimalToRaw, planQuotes } from "../src/quote-planner/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dashboardRoot = path.join(root, "dashboard");
const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const port = Number(portArg?.slice("--port=".length) || process.env.PORT || 4173);
const defaultMode = process.argv.includes("--replay") ? "replay" : process.argv.includes("--live") ? "live" : "replay";

const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
});

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

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

function midPrice(book) {
  const bid = Number(book?.bids?.[0]?.[0]);
  const ask = Number(book?.asks?.[0]?.[0]);
  if (!(bid > 0) || !(ask > 0) || bid >= ask || ask > 1) return null;
  return (bid + ask) / 2;
}

function liveRestingRaw(orders, side, decimals) {
  const order = orders.find((item) => item.side === (side === "bid" ? "BUY" : "SELL") && item.outcome === "YES");
  return order ? rawFromDecimal(order.priceYes, decimals, `${side} resting price`) : null;
}

async function buildLiveEnvelope() {
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

async function serveStatic(response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const requested = path.resolve(dashboardRoot, relative);
  if (!requested.startsWith(`${dashboardRoot}${path.sep}`)) return json(response, 403, { error: "forbidden path" });
  try {
    const body = await fs.readFile(requested);
    const extension = path.extname(requested).toLowerCase();
    response.writeHead(200, { "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (url.pathname === "/presenter.mjs") {
    try {
      const body = await fs.readFile(path.join(root, "src", "dashboard", "presenter.mjs"));
      response.writeHead(200, { "Content-Type": CONTENT_TYPES[".mjs"], "Cache-Control": "no-store" });
      response.end(body);
    } catch {
      json(response, 404, { error: "presentation module unavailable" });
    }
    return;
  }
  if (url.pathname === "/api/scenes") return json(response, 200, { scenes: REPLAY_SCENES });
  if (url.pathname === "/api/snapshot") {
    const requestedMode = (url.searchParams.get("mode") || defaultMode).toLowerCase();
    try {
      if (requestedMode === "live") return json(response, 200, await buildLiveEnvelope());
      return json(response, 200, buildReplayEnvelope(url.searchParams.get("scene") || "quote"));
    } catch (error) {
      return json(response, 503, { error: requestedMode === "live" ? `Live read refused: ${error?.message || error}` : `Replay unavailable: ${error?.message || error}` });
    }
  }
  return serveStatic(response, url.pathname);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`VILLA dashboard listening at http://127.0.0.1:${port}`);
  console.log(`Default mode: ${defaultMode.toUpperCase()}; live mode is read-only`);
});
