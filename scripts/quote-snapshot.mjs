/**
 * Read-only live VILLA quote-planner snapshot.
 *
 * This command assembles live data, evaluates the existing pure governor, and
 * calls the pure quote planner. It has no signer and never places, cancels,
 * mints, faucets, or sends a transaction.
 */

import { DEFAULT_RISK_CONFIG, evaluateRisk } from "../src/risk-governor/index.mjs";
import { collectRiskSnapshot, createReadOnlyExchange } from "../src/risk-governor/live.mjs";
import { decimalToRaw, planQuotes } from "../src/quote-planner/index.mjs";

function formatNumber(value, digits = 4) {
  return Number.isFinite(value) ? value.toFixed(digits) : "unavailable";
}

function rawString(value) {
  return typeof value === "bigint" ? value.toString() : String(value);
}

function bestRaw(level, decimals, name) {
  if (!Array.isArray(level) || level.length < 1) return null;
  return decimalToRaw(String(level[0]), decimals, "nearest", name).toString();
}

function midpoint(book) {
  const bid = book?.bids?.[0]?.[0];
  const ask = book?.asks?.[0]?.[0];
  if (!(bid > 0) || !(ask > 0) || bid >= 1 || ask > 1 || bid >= ask) return null;
  return (bid + ask) / 2;
}

function printSide(label, side) {
  if (side.enabled) {
    console.log(`${label}:                   ${side.action} ${formatNumber(side.targetQuantity, 6)} @ ${(side.targetPrice * 100).toFixed(2)}%`);
    console.log(`${label} raw:               qty ${side.targetQuantityRaw} / price ${side.targetPriceRaw}`);
  } else {
    console.log(`${label}:                   disabled (${side.skipReason || "no quote"})`);
  }
}

async function main() {
  const exchange = createReadOnlyExchange();
  try {
    const { snapshot, context } = await collectRiskSnapshot(exchange);
    const decision = evaluateRisk(snapshot, DEFAULT_RISK_CONFIG);
    const yesSymbol = context.market.outcomes?.find((outcome) => outcome.label === "YES")?.symbol;
    if (!yesSymbol) throw new Error("live market has no YES outcome symbol");
    const book = await exchange.fetchOrderBook(yesSymbol, 3);
    const params = await exchange.client.getBinaryBookParams(context.onchain.pool);
    const decimals = context.decimals;
    const oneRaw = 10n ** BigInt(decimals);
    const bestBidRaw = bestRaw(book.bids?.[0], decimals, "best bid");
    const bestAskRaw = bestRaw(book.asks?.[0], decimals, "best ask");
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
        limits: {
          directionalExposureHard: DEFAULT_RISK_CONFIG.directionalExposureHard,
          grossExposureHard: DEFAULT_RISK_CONFIG.grossExposureHard,
        },
      },
      inventory: {
        yes: snapshot.inventory.yes,
        no: snapshot.inventory.no,
        yesAvailableRaw: decimalToRaw(String(snapshot.inventory.yes), decimals, "nearest", "YES inventory").toString(),
      },
      pendingOrders: snapshot.openOrders,
      book: { bestBidRaw, bestAskRaw, empty: bestBidRaw === null && bestAskRaw === null },
      grid: {
        decimals,
        oneRaw: rawString(oneRaw),
        tickSizeRaw: rawString(params.tickSize),
        lotSizeRaw: rawString(params.lotSize),
        minQuantityRaw: rawString(params.minQuantity),
      },
      capital: {
        collateralAvailable: snapshot.capital.collateralAvailable,
        collateralReserve: DEFAULT_RISK_CONFIG.minCollateralReserve,
      },
      market: {
        marketId: context.marketId,
        timeRemainingSec: decision.authoritativeTime.timeRemainingSec,
      },
      quote: { baseQuantityRaw: baseQuantityRaw.toString() },
    });
    const bookMid = midpoint(book);
    const warnings = [...context.accountingWarnings, ...plan.warnings, ...(bookMid === null ? ["BOOK_MIDPOINT_UNAVAILABLE"] : [])];

    console.log("VILLA QUOTE PLANNER SNAPSHOT");
    console.log("");
    console.log(`Market:                 ${context.market.symbol}`);
    console.log(`Market ID:              ${context.marketId}`);
    console.log(`On-chain status:        ${context.onchain.status === 1 ? "Trading" : context.onchain.status} (${context.onchain.status})`);
    console.log(`Chain time:             ${decision.authoritativeTime.chainNowSec}`);
    console.log(`Reference:              ${formatNumber(context.reference.price)} (${context.reference.kind}, raw scale 10^${context.reference.scaleExponent10})`);
    console.log(`BTC now:                ${formatNumber(context.spot.price, 2)}`);
    console.log(`Time left:              ${formatNumber(decision.authoritativeTime.timeRemainingSec, 0)}s`);
    console.log(`Realized volatility:    ${context.volatility.sigmaPerSqrtSec.toExponential(6)} per sqrt-second`);
    console.log(`VILLA fair value:       UP ${(snapshot.fairValue.pUp * 100).toFixed(1)}% / DOWN ${(snapshot.fairValue.pDown * 100).toFixed(1)}%`);
    console.log(`Model confidence:       ${snapshot.fairValue.dataQualityStatus} (${(snapshot.fairValue.confidence * 100).toFixed(1)}% data quality)`);
    console.log("");
    console.log(`YES book:               bid ${book.bids?.[0]?.[0] === undefined ? "none" : `${(book.bids[0][0] * 100).toFixed(2)}%`} / ask ${book.asks?.[0]?.[0] === undefined ? "none" : `${(book.asks[0][0] * 100).toFixed(2)}%`}`);
    console.log(`DreamDEX midpoint:      ${bookMid === null ? "unavailable" : `${(bookMid * 100).toFixed(2)}%`} (comparison only)`);
    console.log(`Midpoint affects fair:   NO`);
    console.log(`Grid:                   tick ${params.tickSize} / lot ${params.lotSize} / min ${params.minQuantity} raw`);
    console.log(`Inventory:              YES ${formatNumber(snapshot.inventory.yes, 6)} / NO ${formatNumber(snapshot.inventory.no, 6)}`);
    console.log(`Open orders:            ${snapshot.openOrders.length} (${snapshot.openOrdersStatus})`);
    console.log(`Governor:               ${decision.state} (${decision.primaryReasonCode})`);
    console.log(`Quote plan:             ${plan.plan}`);
    console.log(`Effective center:       ${(plan.center.effectiveCenter * 100).toFixed(2)}% (skew ${plan.center.inventorySkew >= 0 ? "+" : ""}${(plan.center.inventorySkew * 100).toFixed(2)}pp)`);
    console.log(`Half-spread:            ${(plan.spread.finalHalfSpread * 100).toFixed(2)}% (base ${plan.spread.baseHalfSpread.toFixed(3)}, vol +${plan.spread.volatilityAdjustment.toFixed(4)}, expiry +${plan.spread.expiryAdjustment.toFixed(4)}, confidence +${plan.spread.confidenceAdjustment.toFixed(4)})`);
    printSide("YES bid", plan.bid);
    printSide("YES ask", plan.ask);
    console.log(`Reasons:                ${plan.reasonCodes.join(", ") || "none"}`);
    console.log(`Warnings:               ${warnings.length ? [...new Set(warnings)].join(", ") : "none"}`);
    console.log("");
    console.log("Transactions sent:      NO");
    console.log("Order placement:        NO");
  } finally {
    await exchange.close().catch(() => undefined);
  }
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(`QUOTE SNAPSHOT REFUSED: ${err?.message || err}`);
  process.exit(1);
}
