/**
 * Read-only state collection for the risk snapshot.
 *
 * This module is deliberately not imported by governor.mjs. It may use the
 * SDK, RPC, indexer, price feed, and environment configuration; it produces a
 * normalized snapshot for the pure governor and never creates a signer.
 */

import {
  SomniaMarkets,
  SOMNIA_TESTNET_ADDRESSES,
  SOMNIA_TESTNET_PRICE_FEED,
  isBinaryMarket,
} from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { isAddress } from "viem";
import { estimateFairValue } from "../fair-value/model.mjs";
import { fetchReference, fetchSpot, fetchVolFromPriceHistory } from "../fair-value/live.mjs";

export const RISK_SNAPSHOT_MIN_HEADROOM_SEC = 120;
export const RISK_SNAPSHOT_PREFERRED_MIN_INTERVAL_SEC = 300;

function asFiniteNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} is not finite`);
  return n;
}

function rawToHuman(value, decimals) {
  const raw = typeof value === "bigint" ? value : BigInt(String(value));
  return Number(raw) / 10 ** decimals;
}

function candidateRank(a, b) {
  const aPreferred = Number(a.info.intervalSec) >= RISK_SNAPSHOT_PREFERRED_MIN_INTERVAL_SEC;
  const bPreferred = Number(b.info.intervalSec) >= RISK_SNAPSHOT_PREFERRED_MIN_INTERVAL_SEC;
  if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
  const interval = Number(b.info.intervalSec) - Number(a.info.intervalSec);
  if (interval !== 0) return interval;
  return Number(b.info.expiry) - Number(a.info.expiry);
}

export function createReadOnlyExchange(env = process.env) {
  const account = env.OPERATOR_ADDRESS;
  if (!account || !isAddress(account)) throw new Error("OPERATOR_ADDRESS is required for read-only account-scoped reads");
  return new SomniaMarkets({
    account,
    indexerUrl: env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql",
    chain: somniaShannon,
    wsRpcUrl: env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws",
    addresses: SOMNIA_TESTNET_ADDRESSES,
    priceFeed: SOMNIA_TESTNET_PRICE_FEED,
  });
}

/** Read one current block; chainNowSec, not local wall time, drives the decision. */
export async function readChainTime(exchange) {
  const startedAtMs = Date.now();
  const block = await exchange.client.getViemClient().getBlock();
  const observedAtLocalMs = Date.now();
  const observationAgeSec = Math.max(0, (observedAtLocalMs - startedAtMs) / 1000);
  const chainNowSec = asFiniteNumber(block.timestamp, "chain block timestamp");
  return {
    chainNowSec,
    observationAgeSec,
    blockNumber: block.number === undefined ? null : Number(block.number),
    localNowMs: observedAtLocalMs,
    observedAtLocalMs: startedAtMs,
    clockOffsetSec: chainNowSec - observedAtLocalMs / 1000,
  };
}

export async function findLiveBtcMarket(exchange, chainNowSec, minHeadroomSec = RISK_SNAPSHOT_MIN_HEADROOM_SEC) {
  const loaded = Object.values(await exchange.loadMarkets(true));
  const candidates = loaded
    .filter((m) => m.type === "binary" && isBinaryMarket(m.info))
    .filter((m) => m.info.asset === "BTC")
    .filter((m) => asFiniteNumber(m.info.expiry, "expiry") - chainNowSec >= minHeadroomSec)
    .sort(candidateRank);

  const rejected = [];
  for (const market of candidates) {
    try {
      const onchain = await exchange.client.getMarketOnchain(market.info.marketId);
      if (Number(onchain.status) !== 1 || onchain.isResolved || onchain.isVoided) {
        rejected.push(`${market.symbol}: status ${onchain.status}`);
        continue;
      }
      return { market, onchain };
    } catch (err) {
      rejected.push(`${market.symbol}: ${err?.message || err}`);
    }
  }
  throw new Error(
    `no live BTC Event Contract with ${minHeadroomSec}s headroom and on-chain Trading status; checked ${candidates.length} candidates${rejected.length ? ` (${rejected.slice(0, 4).join("; ")})` : ""}`,
  );
}

function parseBinarySide(side) {
  const match = /^(BUY|SELL)_(YES|NO)$/.exec(String(side ?? ""));
  return match ? { side: match[1], outcome: match[2] } : null;
}

function sameIds(a, b) {
  const left = [...a].map(String).sort();
  const right = [...b].map(String).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Reconcile indexer outcome classification with chain-head active ids. The
 * pool's raw order struct exposes only bid/ask, so the indexer BinarySide is
 * used only after every active id is confirmed on-chain and the two sets match.
 */
export async function readOpenOrders(exchange, onchain, owner, marketId, decimals) {
  const [chainIds, indexedRows] = await Promise.all([
    exchange.client.getOwnOpenOrdersOnchain(onchain.pool, owner),
    exchange.client.getOpenOrders(owner, { pool: onchain.pool, limit: 1000 }),
  ]);
  const matchingRows = indexedRows.filter((row) => String(row.market).toLowerCase() === String(marketId).toLowerCase());
  if (chainIds.length === 0 && matchingRows.length === 0) return { status: "VERIFIED", orders: [], indexedCount: 0, chainCount: 0 };
  if (!sameIds(chainIds, matchingRows.map((row) => row.orderId))) {
    return { status: "AMBIGUOUS", orders: [], indexedCount: matchingRows.length, chainCount: chainIds.length, warning: "OPEN_ORDER_INDEXER_CHAIN_MISMATCH" };
  }

  const chainOrders = await Promise.all(chainIds.map((id) => exchange.client.getOrderOnchain(onchain.pool, id)));
  if (chainOrders.some((order) => order === null)) {
    return { status: "AMBIGUOUS", orders: [], indexedCount: matchingRows.length, chainCount: chainIds.length, warning: "OPEN_ORDER_RACE_DURING_READ" };
  }

  const orders = [];
  for (const row of matchingRows) {
    const parsed = parseBinarySide(row.side);
    if (!parsed) return { status: "AMBIGUOUS", orders: [], indexedCount: matchingRows.length, chainCount: chainIds.length, warning: "OPEN_ORDER_SIDE_UNCLASSIFIED" };
    const chainOrder = chainOrders.find((order) => String(order.orderId) === String(row.orderId));
    const remainingQty = rawToHuman(row.quantityRemaining, decimals);
    const chainRemainingQty = rawToHuman(chainOrder.quantityRemaining, decimals);
    if (!Number.isFinite(remainingQty) || remainingQty < 0 || Math.abs(remainingQty - chainRemainingQty) > 1e-9) {
      return { status: "AMBIGUOUS", orders: [], indexedCount: matchingRows.length, chainCount: chainIds.length, warning: "OPEN_ORDER_QUANTITY_CHANGED_DURING_READ" };
    }
    orders.push({
      id: String(row.orderId),
      outcome: parsed.outcome,
      side: parsed.side,
      remainingQty,
      priceYes: rawToHuman(row.price, decimals),
    });
  }
  return { status: "VERIFIED", orders, indexedCount: matchingRows.length, chainCount: chainIds.length };
}

function committedBuyCollateral(openOrders) {
  return openOrders.reduce((total, order) => {
    if (order.side !== "BUY") return total;
    const ownPrice = order.outcome === "NO" ? 1 - order.priceYes : order.priceYes;
    return total + Math.max(0, ownPrice) * order.remainingQty;
  }, 0);
}

/** Collect a complete normalized risk snapshot without a signer or write path. */
export async function collectRiskSnapshot(exchange, options = {}) {
  const chainTime = options.chainTime ?? await readChainTime(exchange);
  const spot = await fetchSpot(exchange, "BTC", { nowSec: chainTime.chainNowSec });
  const { market, onchain } = options.market ?? await findLiveBtcMarket(exchange, chainTime.chainNowSec, options.minHeadroomSec ?? RISK_SNAPSHOT_MIN_HEADROOM_SEC);
  const marketId = market.info.marketId;
  const expirySec = asFiniteNumber(market.info.expiry, "market expiry");
  const resolvedReference = await fetchReference(exchange, { marketId, strike: market.info.strike, spot: spot.price });
  const volatility = await fetchVolFromPriceHistory(exchange, "BTC", {
    nowSec: chainTime.chainNowSec,
    limit: 240,
    minReturns: 12,
    minElapsedSec: 60,
    maxAgeSec: 180,
    maxGapSec: 180,
  });
  const timeRemainingSec = expirySec - chainTime.chainNowSec;
  const fairValue = estimateFairValue({
    currentUnderlyingPrice: spot.price,
    referencePrice: resolvedReference.price,
    timeRemainingSec,
    volatility,
    dataQuality: { priceAgeSec: spot.priceAgeSec, referenceSource: resolvedReference.kind },
  });

  const owner = options.owner ?? exchange.walletAddress;
  if (!owner || !isAddress(owner)) throw new Error("read-only risk collection needs a valid operator address");
  const decimals = asFiniteNumber(market.info.baseDecimals ?? market.info.quoteDecimals, "market decimals");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error(`unsupported market decimals ${decimals}`);
  const [yesRaw, noRaw, collateralRaw, gasRaw, openOrderRead] = await Promise.all([
    exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: owner, id: onchain.yesId }),
    exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: owner, id: onchain.noId }),
    exchange.client.getErc20Balance(onchain.collateral, owner),
    exchange.client.getViemClient().getBalance({ address: owner }),
    readOpenOrders(exchange, onchain, owner, marketId, decimals),
  ]);

  const inventory = { yes: rawToHuman(yesRaw, decimals), no: rawToHuman(noRaw, decimals) };
  const collateralAvailable = rawToHuman(collateralRaw, decimals);
  const gasNative = rawToHuman(gasRaw, 18);
  const capitalAtRisk = openOrderRead.status === "VERIFIED" ? committedBuyCollateral(openOrderRead.orders) : 0;

  return {
    snapshot: {
      fairValue,
      chainTime,
      feed: {
        price: spot.price,
        timestampSec: spot.tSec,
        sourceAgeSec: spot.sourceAgeSec,
      },
      market: {
        status: Number(onchain.status),
        expirySec,
        reference: {
          status: "VALID",
          source: resolvedReference.kind,
          scaleExponent10: resolvedReference.scaleExponent10,
        },
      },
      inventory,
      openOrdersStatus: openOrderRead.status,
      openOrders: openOrderRead.orders,
      capital: {
        collateralAvailable,
        capitalAtRisk,
        accountingStatus: "PARTIAL",
      },
      gas: { nativeBalance: gasNative },
      drawdown: { status: "UNAVAILABLE" },
    },
    context: {
      market,
      onchain,
      marketId,
      owner,
      decimals,
      spot,
      volatility,
      reference: resolvedReference,
      openOrderRead,
      accountingWarnings: ["CAPITAL_ACCOUNTING_PARTIAL", "DRAWDOWN_UNACCOUNTED"],
    },
  };
}
