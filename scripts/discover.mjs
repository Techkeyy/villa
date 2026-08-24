/**
 * Read-only live discovery. Not a product. Prints market shape facts.
 */
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED, isBinaryMarket } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const exchange = new SomniaMarkets({
  indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
  chain: somniaShannon,
  wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws",
  addresses: SOMNIA_TESTNET_ADDRESSES,
  priceFeed: SOMNIA_TESTNET_PRICE_FEED,
});

const now = Date.now() / 1000;
const rows = await exchange.client.listBinaryMarkets({ limit: 200 });
const intervals = {};
const assets = {};
const statuses = {};
const venues = {};
let future = 0;
for (const r of rows) {
  const iv = String(r.intervalSec ?? "?");
  intervals[iv] = (intervals[iv] || 0) + 1;
  const a = String(r.asset ?? "?");
  assets[a] = (assets[a] || 0) + 1;
  const st = String(r.status ?? r.clobStatus ?? "?");
  statuses[st] = (statuses[st] || 0) + 1;
  const v = String(r.venueId ?? "?").slice(0, 18);
  venues[v] = (venues[v] || 0) + 1;
  if (Number(r.expiry ?? 0) > now) future += 1;
}

console.log("listBinaryMarkets limit=200");
console.log("rows", rows.length, "expiry>now", future);
console.log("assets", JSON.stringify(assets));
console.log("intervals_sec", JSON.stringify(intervals));
console.log("indexed_status", JSON.stringify(statuses));
console.log("venueId_prefixes", JSON.stringify(venues));

const liveish = rows
  .filter((r) => Number(r.expiry ?? 0) > now)
  .sort((a, b) => Number(a.expiry) - Number(b.expiry));

console.log("\nfuture windows (first 12):");
for (const r of liveish.slice(0, 12)) {
  const left = Math.round(Number(r.expiry) - now);
  console.log(
    JSON.stringify({
      asset: r.asset,
      intervalSec: Number(r.intervalSec),
      strike: r.strike,
      expiry: r.expiry,
      leftSec: left,
      status: r.status,
      tradeCount: r.tradeCount,
      symbol: r.symbol,
      marketId: r.marketId,
    }),
  );
}

if (liveish[0]?.marketId) {
  const id = liveish[0].marketId;
  const onchain = await exchange.client.getMarketOnchain(id);
  console.log("\nonchain sample keys", Object.keys(onchain));
  console.log(
    JSON.stringify({
      status: onchain.status,
      expiry: String(onchain.expiry),
      pool: onchain.pool,
      isResolved: onchain.isResolved,
      isVoided: onchain.isVoided,
    }),
  );
  try {
    const opening = await exchange.client.getOpeningPrices([id]);
    console.log("getOpeningPrices", JSON.stringify(opening));
  } catch (e) {
    console.log("getOpeningPrices FAIL", e.message);
  }
}

const loaded = Object.values(await exchange.loadMarkets(true));
const binaries = loaded.filter((m) => m.type === "binary" || isBinaryMarket(m.info));
const active = binaries.filter((m) => m.active);
console.log("\nloadMarkets tradables", loaded.length, "binary", binaries.length, "active_flag", active.length);
if (active[0]) {
  const info = active[0].info;
  console.log("active sample", active[0].symbol, {
    asset: info.asset,
    intervalSec: info.intervalSec,
    strike: info.strike,
    expiry: info.expiry,
    venueId: info.venueId,
  });
  const yes = active[0].outcomes?.[0]?.symbol;
  if (yes) {
    const book = await exchange.fetchOrderBook(yes, 3);
    console.log("book", yes, { bids: book.bids?.slice(0, 3), asks: book.asks?.slice(0, 3) });
  }
}

try {
  const px = await exchange.fetchPrice("BTC");
  console.log("\nfetchPrice BTC", px);
} catch (e) {
  console.log("fetchPrice FAIL", e.message);
}

try {
  const candles = await exchange.fetchPriceOHLCV("BTC", "1m", undefined, 5);
  console.log("ohlcv 1m last", candles.slice(-2));
} catch (e) {
  console.log("ohlcv FAIL", e.message);
}

const finalized = await exchange.client.listBinaryMarkets({ status: "Finalized", limit: 5 });
console.log("\nfinalized sample", finalized.length, finalized[0] && { asset: finalized[0].asset, status: finalized[0].status, expiry: finalized[0].expiry });
