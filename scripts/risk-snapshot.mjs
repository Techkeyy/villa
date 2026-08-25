/**
 * Read-only live risk-governor snapshot.
 *
 * This command reads chain/indexer/price-feed state, evaluates the pure
 * governor, and optionally reads the YES book for a comparison-only line. It
 * never constructs a private-key signer and never places, cancels, faucets,
 * mints, burns, redeems, or sends a transaction.
 */

import { DEFAULT_RISK_CONFIG, evaluateRisk } from "../src/risk-governor/index.mjs";
import { collectRiskSnapshot, createReadOnlyExchange } from "../src/risk-governor/live.mjs";

function midpoint(book) {
  const bid = book?.bids?.[0]?.[0];
  const ask = book?.asks?.[0]?.[0];
  if (!(bid > 0) || !(ask > 0) || bid >= 1 || ask > 1) return null;
  const mid = (bid + ask) / 2;
  return Number.isFinite(mid) && mid > 0 && mid < 1 ? mid : null;
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "unavailable";
}

async function main() {
  const exchange = createReadOnlyExchange();
  try {
    const { snapshot, context } = await collectRiskSnapshot(exchange);
    const decision = evaluateRisk(snapshot, DEFAULT_RISK_CONFIG);

    let bookMid = null;
    let bookWarning = null;
    const yesSymbol = context.market.outcomes?.find((outcome) => outcome.label === "YES")?.symbol;
    if (yesSymbol) {
      try {
        bookMid = midpoint(await exchange.fetchOrderBook(yesSymbol, 3));
      } catch (err) {
        bookWarning = `BOOK_READ_FAILED: ${err?.message || err}`;
      }
    } else {
      bookWarning = "BOOK_UNAVAILABLE: market has no YES outcome symbol";
    }

    const exposure = decision.exposure.worstCase;
    const warnings = [...context.accountingWarnings, ...decision.warnings];
    if (bookWarning) warnings.push(bookWarning);

    console.log("VILLA RISK GOVERNOR SNAPSHOT");
    console.log("");
    console.log(`Market:                 ${context.market.symbol}`);
    console.log(`Market ID:              ${context.marketId}`);
    console.log(`On-chain status:        ${context.onchain.status === 1 ? "Trading" : context.onchain.status} (${context.onchain.status})`);
    console.log(`Chain time:             ${decision.authoritativeTime.chainNowSec}`);
    console.log(`Chain time age:         ${formatNumber(decision.authoritativeTime.chainObservationAgeSec, 2)}s`);
    console.log(`Reference:              ${formatNumber(context.reference.price)} (${context.reference.kind}, raw scale 10^${context.reference.scaleExponent10})`);
    console.log(`BTC now:                ${formatNumber(context.spot.price)}`);
    console.log(`Time left:              ${formatNumber(decision.authoritativeTime.timeRemainingSec, 0)}s`);
    console.log(`Realized volatility:    ${context.volatility.sigmaPerSqrtSec.toExponential(6)} per sqrt-second`);
    console.log(`VILLA fair value:       UP ${(snapshot.fairValue.pUp * 100).toFixed(1)}% / DOWN ${(snapshot.fairValue.pDown * 100).toFixed(1)}%`);
    console.log(`Model confidence:       ${snapshot.fairValue.dataQualityStatus} (${(snapshot.fairValue.confidence * 100).toFixed(1)}% data quality)`);
    console.log("");
    console.log(`Inventory:              YES ${formatNumber(snapshot.inventory.yes, 6)} / NO ${formatNumber(snapshot.inventory.no, 6)}`);
    console.log(`Directional balance:    D=${formatNumber(decision.exposure.current?.directionalBalance, 6)} (YES - NO)`);
    console.log(`Worst-case exposure:    UP ${formatNumber(exposure?.directionalUp, 6)} / DOWN ${formatNumber(exposure?.directionalDown, 6)} / gross ${formatNumber(exposure?.grossOutcome, 6)}`);
    console.log(`Pending stress:         UP +${formatNumber(decision.exposure.directionalStress?.worstUp?.pendingDelta, 6)} / DOWN +${formatNumber(decision.exposure.directionalStress?.worstDown?.pendingDelta === undefined ? null : Math.abs(decision.exposure.directionalStress.worstDown.pendingDelta), 6)}`);
    console.log(`Open orders:            ${context.openOrderRead.chainCount} chain / ${context.openOrderRead.indexedCount} indexed (${snapshot.openOrdersStatus})`);
    console.log("");
    console.log(`Governor:               ${decision.state}`);
    console.log(`Primary reason:         ${decision.primaryReasonCode}`);
    console.log(`Allowed actions:        ${decision.permissions.allowedActions.join(", ") || "none"}`);
    console.log(`Reduce-only cap:        ${decision.reduceOnlyPolicy?.maxQuantityBeforeNeutral === undefined ? "unavailable" : `${decision.reduceOnlyPolicy.maxQuantityBeforeNeutral.toFixed(6)} ${decision.reduceOnlyPolicy.permittedDirection ? `toward ${decision.reduceOnlyPolicy.permittedDirection}` : "(neutral)"}`}`);
    console.log(`Size multiplier:        ${decision.sizeMultiplier.toFixed(2)}`);
    console.log(`Cancel existing:        ${decision.cancelExisting ? "RECOMMENDED (no cancellation executed)" : "no"}`);
    console.log(`Additional risk budget: UP ${formatNumber(decision.maxAdditionalExposure.directionalUp, 6)} / DOWN ${formatNumber(decision.maxAdditionalExposure.directionalDown, 6)}`);
    console.log(`DreamDEX midpoint:      ${bookMid === null ? "unavailable" : `${(bookMid * 100).toFixed(1)}%`}  (comparison only)`);
    console.log(`Difference:             ${bookMid === null ? "unavailable" : `${snapshot.fairValue.pUp - bookMid >= 0 ? "+" : ""}${((snapshot.fairValue.pUp - bookMid) * 100).toFixed(1)} percentage points`}`);
    console.log(`Midpoint affects state:  NO`);
    console.log(`Warnings:               ${warnings.length ? [...new Set(warnings)].join(", ") : "none"}`);
    console.log("");
    console.log("Transactions sent:      NO");
  } finally {
    await exchange.close().catch(() => undefined);
  }
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(`RISK SNAPSHOT REFUSED: ${err?.message || err}`);
  process.exit(1);
}
