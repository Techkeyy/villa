/**
 * Read-only live fair-value snapshot.
 *
 * It discovers a BTC binary market, verifies the authoritative on-chain
 * Trading status, resolves the settlement reference, reads the underlying
 * price/history, and then compares VILLA's independent value with the book.
 * There is no signer in this script and no transaction path.
 */

import {
  SomniaMarkets,
  SOMNIA_TESTNET_ADDRESSES,
  SOMNIA_TESTNET_PRICE_FEED,
  isBinaryMarket,
} from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { estimateFairValue } from "../src/fair-value/model.mjs";
import {
  fetchReference,
  fetchSpot,
  fetchVolFromPriceHistory,
} from "../src/fair-value/live.mjs";

const INDEXER_URL = process.env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = process.env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws";
const MIN_HEADROOM_SEC = 120;
const PREFERRED_MIN_INTERVAL_SEC = 300;

const exchange = new SomniaMarkets({
  indexerUrl: INDEXER_URL,
  chain: somniaShannon,
  wsRpcUrl: WS_RPC_URL,
  addresses: SOMNIA_TESTNET_ADDRESSES,
  priceFeed: SOMNIA_TESTNET_PRICE_FEED,
});

function asFiniteNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} is not finite`);
  return n;
}

function candidateRank(a, b, nowSec) {
  const aPreferred = Number(a.info.intervalSec) >= PREFERRED_MIN_INTERVAL_SEC;
  const bPreferred = Number(b.info.intervalSec) >= PREFERRED_MIN_INTERVAL_SEC;
  if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
  const interval = Number(a.info.intervalSec) - Number(b.info.intervalSec);
  if (interval !== 0) return interval;
  return asFiniteNumber(b.info.expiry, "expiry") - asFiniteNumber(a.info.expiry, "expiry");
}

async function findLiveBtcMarket(nowSec) {
  const loaded = Object.values(await exchange.loadMarkets(true));
  const candidates = loaded
    .filter((m) => m.type === "binary" && isBinaryMarket(m.info))
    .filter((m) => m.info.asset === "BTC")
    .sort((a, b) => candidateRank(a, b, nowSec));

  const rejected = [];
  for (const market of candidates) {
    const marketId = market.info.marketId;
    try {
      const onchain = await exchange.client.getMarketOnchain(marketId);
      if (Number(onchain.status) !== 1 || onchain.isResolved || onchain.isVoided) {
        rejected.push(`${market.symbol}: on-chain status ${onchain.status}`);
        continue;
      }
      const expirySec = asFiniteNumber(onchain.expiry ?? market.info.expiry, "on-chain expiry");
      if (expirySec - nowSec < MIN_HEADROOM_SEC) {
        rejected.push(`${market.symbol}: only ${Math.floor(expirySec - nowSec)}s headroom`);
        continue;
      }
      return { market, onchain };
    } catch (err) {
      rejected.push(`${market.symbol}: ${err?.message || err}`);
    }
  }
  throw new Error(
    `no live BTC Event Contract with ${MIN_HEADROOM_SEC}s headroom and on-chain Trading status; checked ${candidates.length} candidates${rejected.length ? ` (${rejected.slice(0, 4).join("; ")})` : ""}`,
  );
}

function midpoint(book) {
  const bid = book?.bids?.[0]?.[0];
  const ask = book?.asks?.[0]?.[0];
  if (!(bid > 0) || !(ask > 0) || bid >= 1 || ask > 1) return null;
  const mid = (bid + ask) / 2;
  return mid > 0 && mid < 1 && Number.isFinite(mid) ? mid : null;
}

async function main() {
  const workstationNowSec = Date.now() / 1000;
  const spot = await fetchSpot(exchange, "BTC", { nowSec: workstationNowSec });
  // The price feed gives us a chain timestamp. Use that clock for history age
  // and expiry math; the workstation clock may lag Shannon by several minutes.
  let chainNowSec = spot.tSec;
  const { market, onchain } = await findLiveBtcMarket(chainNowSec);
  const resolvedReference = await fetchReference(exchange, {
    marketId: market.info.marketId,
    strike: market.info.strike,
    spot: spot.price,
  });
  const volatility = await fetchVolFromPriceHistory(exchange, "BTC", {
    nowSec: chainNowSec,
    refreshChainTime: true,
    limit: 240,
    minReturns: 12,
    minElapsedSec: 60,
    maxAgeSec: 180,
    maxGapSec: 180,
  });
  if (volatility.chainNowSec !== undefined && volatility.chainNowSec > chainNowSec) chainNowSec = volatility.chainNowSec;
  const expirySec = asFiniteNumber(onchain.expiry ?? market.info.expiry, "on-chain expiry");
  const timeRemainingSec = expirySec - chainNowSec;
  if (!(timeRemainingSec > 0)) throw new Error("market expired while snapshot was being assembled");

  const fair = estimateFairValue({
    currentUnderlyingPrice: spot.price,
    referencePrice: resolvedReference.price,
    timeRemainingSec,
    volatility,
    dataQuality: {
      priceAgeSec: spot.priceAgeSec,
      referenceSource: resolvedReference.kind,
    },
  });

  const yesSymbol = market.outcomes?.find((outcome) => outcome.label === "YES")?.symbol;
  let book = null;
  let bookWarning = null;
  if (yesSymbol) {
    try {
      book = await exchange.fetchOrderBook(yesSymbol, 3);
    } catch (err) {
      bookWarning = `BOOK_READ_FAILED: ${err?.message || err}`;
    }
  } else {
    bookWarning = "BOOK_UNAVAILABLE: market has no YES outcome symbol";
  }
  const bookMid = midpoint(book);
  const difference = bookMid === null ? null : fair.pUp - bookMid;
  const warnings = [...fair.warnings];
  if (spot.chainClockSkewSec > 0 && Math.round(spot.chainClockSkewSec) > 0) warnings.push(`CHAIN_CLOCK_SKEW_${Math.round(spot.chainClockSkewSec)}S`);
  if (bookWarning) warnings.push(bookWarning);

  console.log("VILLA FAIR VALUE SNAPSHOT");
  console.log("");
  console.log(`Market:                 ${market.symbol}`);
  console.log(`Market ID:              ${market.info.marketId}`);
  console.log(`Interval:               ${market.info.intervalSec}s`);
  console.log(`On-chain status:        Trading (${onchain.status})`);
  console.log(`Reference:              ${resolvedReference.price.toFixed(2)} (${resolvedReference.kind}, raw scale 10^${resolvedReference.scaleExponent10})`);
  console.log(`BTC now:                ${spot.price.toFixed(2)}`);
  console.log(`Price age:              ${spot.priceAgeSec.toFixed(1)}s`);
  if (spot.sourceAgeSec !== null) console.log(`Source age:             ${spot.sourceAgeSec.toFixed(1)}s`);
  if (spot.chainClockSkewSec > 0) console.log(`Chain clock offset:     +${spot.chainClockSkewSec.toFixed(1)}s vs workstation`);
  console.log(`Time left:              ${Math.round(timeRemainingSec)}s`);
  console.log(`Realized volatility:    ${volatility.sigmaPerSqrtSec.toExponential(6)} per sqrt-second`);
  console.log(`Vol observations:       ${volatility.returns} over ${Math.round(volatility.elapsedSec)}s`);
  console.log("");
  console.log(`VILLA (${fair.modelVersion}):  UP ${(fair.pUp * 100).toFixed(1)}%  /  DOWN ${(fair.pDown * 100).toFixed(1)}%`);
  console.log(`Model confidence:       ${fair.dataQualityStatus} (${(fair.confidence * 100).toFixed(1)}% data-quality score)`);
  console.log(`DreamDEX midpoint:      ${bookMid === null ? "unavailable" : `${(bookMid * 100).toFixed(1)}%`}  (comparison only)`);
  console.log(`Difference:              ${difference === null ? "unavailable" : `${difference >= 0 ? "+" : ""}${(difference * 100).toFixed(1)} percentage points`}`);
  console.log("");
  console.log("Model inputs:            underlying price, reference, time left, realized volatility");
  console.log("Book midpoint input:     NO — fetched after pricing for comparison only");
  console.log(`Warnings:                ${warnings.length ? warnings.join(", ") : "none"}`);
}

try {
  await main();
  // The SDK's read client may retain an internal transport handle. This script
  // is intentionally a bounded one-shot snapshot, so end after the result is
  // printed instead of leaving a terminal process alive.
  process.exit(0);
} catch (err) {
  console.error(`FAIR VALUE SNAPSHOT REFUSED: ${err?.message || err}`);
  process.exit(1);
}
