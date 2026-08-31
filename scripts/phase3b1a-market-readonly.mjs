/**
 * Public market-fact probe for Phase 3B1A. It does not load .env, create a
 * wallet, read a private key, or send a transaction. The zero address is used
 * only for the SDK's required read-context field; no LP account is queried.
 */

import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED, isBinaryMarket } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, http } from "viem";
import { fetchReference, fetchSpot } from "../src/fair-value/live.mjs";
import { ZERO_ADDRESS } from "../src/execution/lp-adapter.mjs";
import { selectCurrentBtc5mMarket } from "../src/execution/lp-market-selection.mjs";

const RPC_URL = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const INDEXER_URL = process.env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = process.env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws";
const publicClient = createPublicClient({ chain: somniaShannon, transport: http(RPC_URL, { timeout: 15_000 }) });
const exchange = new SomniaMarkets({ account: ZERO_ADDRESS, indexerUrl: INDEXER_URL, chain: somniaShannon, wsRpcUrl: WS_RPC_URL, addresses: SOMNIA_TESTNET_ADDRESSES, priceFeed: SOMNIA_TESTNET_PRICE_FEED });
const jsonSafe = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, null, 2);
async function closeExchange() {
  await Promise.race([exchange.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 500))]);
}

let exitCode = 0;
try {
  const block = await publicClient.getBlock();
  const chainNowSec = Number(block.timestamp);
  const rows = typeof exchange.client.listLiveBinaryMarkets === "function"
    ? await exchange.client.listLiveBinaryMarkets({ asset: "BTC", intervalSec: 300, status: "Trading", orderBy: "closingSoon", limit: 100, nowSec: Math.floor(chainNowSec) })
    : await exchange.client.listBinaryMarkets({ asset: "BTC", intervalSec: 300, status: "Trading", limit: 100 });
  const candidates = [];
  for (const row of rows) {
    if (!(isBinaryMarket(row) || String(row.marketType ?? row.info?.marketType ?? "").toUpperCase() === "BINARY")) continue;
    if (String(row.asset ?? row.info?.asset ?? "").toUpperCase() !== "BTC") continue;
    if (Number(row.intervalSec ?? row.info?.intervalSec) !== 300) continue;
    const marketId = row.marketId ?? row.info?.marketId ?? row.id;
    if (!marketId) continue;
    const onchain = await exchange.client.getMarketOnchain(marketId);
    if (Number(onchain.status) !== 1 || onchain.isResolved || onchain.isVoided) continue;
    const params = await exchange.client.getBinaryBookParams(onchain.pool);
    const spot = await fetchSpot(exchange, "BTC", { nowSec: chainNowSec });
    const reference = await fetchReference(exchange, { marketId, strike: row.strike ?? row.info?.strike, spot: spot.price });
    const market = (await exchange.loadMarkets(true))[row.symbol] ?? Object.values(await exchange.loadMarkets(true)).find((item) => String(item.info?.marketId).toLowerCase() === String(marketId).toLowerCase());
    const yesSymbol = market?.outcomes?.find((outcome) => outcome.label === "YES")?.symbol;
    const book = yesSymbol ? await exchange.fetchOrderBook(yesSymbol, 3) : { bids: [], asks: [] };
    candidates.push({ row, onchain: { ...onchain, poolFinalized: Boolean(params.finalized) }, marketId: String(marketId), grid: { tickSizeRaw: String(params.tickSize), lotSizeRaw: String(params.lotSize), minQuantityRaw: String(params.minQuantity) }, minimumOrderRaw: String(params.minQuantity), book: { bids: book?.bids?.slice?.(0, 3) ?? [], asks: book?.asks?.slice?.(0, 3) ?? [] }, reference: { price: reference.price, source: reference.kind }, spot: { price: spot.price, timestampSec: spot.tSec } });
  }
  const result = selectCurrentBtc5mMarket({ candidates, chainNowSec });
  console.log(jsonSafe({ result: result.selected ? "PASS" : "BLOCKED", chainNowSec, blockNumber: block.number?.toString?.() ?? null, query: "live BTC 5m Trading", selected: result.selected, candidates: candidates.map((item) => ({ marketId: item.marketId, expirySec: item.onchain.expiry, pool: item.onchain.pool, poolFinalized: item.onchain.poolFinalized })), rejected: result.rejected.slice(0, 12) }));
  if (!result.selected) exitCode = 2;
} catch (error) {
  console.error(jsonSafe({ result: "BLOCKED", code: error?.code ?? "READONLY_PROBE_FAILED", reason: error?.message ?? String(error) }));
  exitCode = 1;
} finally {
  await closeExchange();
}
process.exit(exitCode);
