/**
 * Shannon write-path gate.
 * Discover a BTC Event Contract, rest one tiny post-only BUY, confirm it, cancel it.
 * Not a strategy. Does not mint, redeem, or take liquidity.
 *
 *   node --env-file=.env scripts/verify-write-path.mjs
 *   node --env-file=.env scripts/verify-write-path.mjs --dry-run
 */
import {
  SomniaMarkets,
  SOMNIA_TESTNET_ADDRESSES,
  SOMNIA_TESTNET_PRICE_FEED,
  isBinaryMarket,
  ORDER_TYPE,
  ContractRevertError,
} from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, formatEther, http } from "viem";
import {
  WritePathError,
  toRaw,
  fromRaw,
  isOnGrid,
  minValidQuantity,
  selectRestingBuyPrice,
  buyEscrow,
  rejectMarket,
  compareCandidates,
  orderExpireNs,
  assertSufficientStt,
  assertSufficientCollateral,
  isPostOnlyWouldCross,
  secondsLeft,
} from "./lib/write-path.mjs";

const DRY = process.argv.includes("--dry-run") || process.env.DRY === "1";
const RPC_URL = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const INDEXER_URL = process.env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = process.env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws";
const TUSDC = (SOMNIA_TESTNET_ADDRESSES.collateral || SOMNIA_TESTNET_ADDRESSES.testUsdc);
const MIN_STT_WEI = 10n ** 15n; // 0.001 STT — gas on Shannon is cheap; this is a floor, not a guess of cost
const MIN_INTERVAL_SEC = 300;
const MIN_LEFT_SEC = 120;
const POLL_MS = 400;
const POLL_ATTEMPTS = 25;
const CROSS_RETRIES = 3;

function log(step, detail = "") {
  const extra = detail ? `  ${detail}` : "";
  console.log(`${step}${extra}`);
}

function fail(kind, message) {
  console.error(`FAIL [${kind}] ${message}`);
  process.exitCode = 1;
  throw new WritePathError(kind, message);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  fail("environment", "OPERATOR_PRIVATE_KEY is unset. Create a disposable wallet into .env first.");
}

const exchange = new SomniaMarkets({
  indexerUrl: INDEXER_URL,
  chain: somniaShannon,
  wsRpcUrl: WS_RPC_URL,
  addresses: SOMNIA_TESTNET_ADDRESSES,
  priceFeed: SOMNIA_TESTNET_PRICE_FEED,
  privateKey: PRIVATE_KEY,
});

const me = exchange.walletAddress;
if (!me) fail("environment", "SDK did not derive a wallet address from OPERATOR_PRIVATE_KEY");

const publicClient = createPublicClient({
  chain: somniaShannon,
  transport: http(RPC_URL),
});

log("wallet", me);
log("mode", DRY ? "dry-run (no send)" : "wet");

const sttBefore = await publicClient.getBalance({ address: me });
const tusdcBefore = TUSDC ? await exchange.client.getErc20Balance(TUSDC, me) : 0n;
log("STT", `${formatEther(sttBefore)} (${sttBefore} wei)`);
log("tUSDC raw", String(tusdcBefore));

let placedOrderId = undefined;
let placedPool = undefined;
let yesSymbol = undefined;

async function cleanup() {
  if (placedOrderId === undefined || !placedPool || DRY) return;
  log("cleanup", `cancel order ${placedOrderId} on ${placedPool}`);
  try {
    await exchange.trader.cancelOrder({ pool: placedPool, orderId: placedOrderId });
  } catch (err) {
    console.error("cleanup cancel failed:", err?.errorName || err?.message || err);
  }
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(1);
});

try {
  log("loadMarkets");
  const loaded = Object.values(await exchange.loadMarkets(true));
  const nowSec = Math.floor(Date.now() / 1000);
  const binary = loaded.filter((m) => m.type === "binary" && isBinaryMarket(m.info) && m.info.asset === "BTC");

  /** @type {any[]} */
  const candidates = [];
  for (const m of binary) {
    const intervalSec = Number(m.info.intervalSec);
    const expirySec = Number(m.info.expiry);
    let onchain;
    try {
      onchain = await exchange.client.getMarketOnchain(m.info.marketId);
    } catch (err) {
      log("skip", `${m.symbol} getMarketOnchain: ${err.message}`);
      continue;
    }
    const rejected = rejectMarket({
      asset: "BTC",
      intervalSec,
      expirySec: Number(onchain.expiry ?? expirySec),
      status: onchain.status,
      nowSec,
      minIntervalSec: MIN_INTERVAL_SEC,
      minLeftSec: MIN_LEFT_SEC,
    });
    if (rejected) continue;
    candidates.push({
      market: m,
      onchain,
      intervalSec,
      expirySec: Number(onchain.expiry ?? expirySec),
      nowSec,
    });
  }

  candidates.sort(compareCandidates);
  if (candidates.length === 0) {
    fail("market state", `no BTC Trading market with interval>=${MIN_INTERVAL_SEC}s and >=${MIN_LEFT_SEC}s left`);
  }

  const chosen = candidates[0];
  const m = chosen.market;
  const onchain = chosen.onchain;
  const info = m.info;
  const decimals = Number(onchain.decimals ?? info.quoteDecimals ?? 6);
  const one = 10n ** BigInt(decimals);
  yesSymbol = m.outcomes?.[0]?.symbol;
  if (!yesSymbol) fail("SDK", `${m.symbol} has no YES outcome symbol`);

  const bookParams = await exchange.client.getBinaryBookParams(onchain.pool);
  const book = await exchange.fetchOrderBook(yesSymbol, 5);
  const bestBidH = book.bids[0]?.[0];
  const bestAskH = book.asks[0]?.[0];
  const bestBid = bestBidH !== undefined ? toRaw(Number(bestBidH).toFixed(decimals), decimals) : undefined;
  const bestAsk = bestAskH !== undefined ? toRaw(Number(bestAskH).toFixed(decimals), decimals) : undefined;

  const qty = minValidQuantity(bookParams);
  let price = selectRestingBuyPrice({
    bestBid,
    bestAsk,
    tickSize: bookParams.tickSize,
    one,
  });
  if (!isOnGrid(price, bookParams.tickSize)) fail("code bug", "selected price is off-tick");
  if (!isOnGrid(qty, bookParams.lotSize)) fail("code bug", "selected qty is off-lot");
  if (qty < bookParams.minQuantity) fail("code bug", "selected qty below minQuantity");

  const escrow = buyEscrow(qty, price, one);
  const expireNs = orderExpireNs({
    nowSec,
    marketExpirySec: Number(onchain.expiry),
    lifetimeSec: 300,
  });

  log("selected", JSON.stringify({
    asset: info.asset,
    intervalSec: chosen.intervalSec,
    marketId: info.marketId,
    symbol: m.symbol,
    yes: yesSymbol,
    pool: onchain.pool,
    venueId: info.venueId,
    expiry: String(onchain.expiry),
    secondsLeft: secondsLeft(onchain.expiry, nowSec),
    onchainStatus: onchain.status,
    tickSize: String(bookParams.tickSize),
    lotSize: String(bookParams.lotSize),
    minQuantity: String(bookParams.minQuantity),
    decimals,
    bestBid: bestBidH ?? null,
    bestAsk: bestAskH ?? null,
  }));
  log("order plan", JSON.stringify({
    side: "BUY_YES",
    postOnly: true,
    priceHuman: fromRaw(price, decimals),
    priceRaw: String(price),
    amountHuman: fromRaw(qty, decimals),
    amountRaw: String(qty),
    escrowRaw: String(escrow),
    expireTimestampNs: String(expireNs),
  }));

  try {
    assertSufficientStt(sttBefore, MIN_STT_WEI);
  } catch (err) {
    fail("funding", err.message);
  }
  try {
    assertSufficientCollateral(tusdcBefore, escrow);
  } catch (err) {
    fail("funding", err.message);
  }

  if (DRY) {
    log("DRY", "would place then cancel; no transaction sent");
    log("PASS dry-run");
    process.exit(0);
  }

  let placed;
  let placePrice = price;
  for (let attempt = 1; attempt <= CROSS_RETRIES; attempt++) {
    try {
      placed = await exchange.trader.placeOrder({
        pool: onchain.pool,
        side: "BUY_YES",
        price: placePrice,
        quantity: qty,
        orderType: ORDER_TYPE.POST_ONLY,
        expireTimestampNs: expireNs,
      });
      break;
    } catch (err) {
      const cross = err instanceof ContractRevertError && isPostOnlyWouldCross(err);
      if (!cross || attempt === CROSS_RETRIES) {
        if (cross) {
          fail("contract revert", `PostOnlyWouldCross after ${CROSS_RETRIES} bounded retries`);
        }
        fail("contract revert", `${err?.errorName || err?.name || "revert"}: ${err?.message || err}`);
      }
      log("PostOnlyWouldCross", `attempt ${attempt}/${CROSS_RETRIES} — refresh book and reprice`);
      const refreshed = await exchange.fetchOrderBook(yesSymbol, 5);
      const rb = refreshed.bids[0]?.[0];
      const ra = refreshed.asks[0]?.[0];
      placePrice = selectRestingBuyPrice({
        bestBid: rb !== undefined ? toRaw(Number(rb).toFixed(decimals), decimals) : undefined,
        bestAsk: ra !== undefined ? toRaw(Number(ra).toFixed(decimals), decimals) : undefined,
        tickSize: bookParams.tickSize,
        one,
        parkTicks: 10 + attempt * 5,
      });
      log("reprice", fromRaw(placePrice, decimals));
    }
  }
  if (!placed) fail("contract revert", "placeOrder returned nothing");
  price = placePrice;

  placedPool = onchain.pool;
  placedOrderId = placed.orderId;
  const placeHash = placed.hash;
  const receiptStatus = placed.receipt?.status;
  log("placed tx", String(placeHash));
  log("receipt.status", String(receiptStatus));
  log("fills", String(placed.fills?.length ?? 0));
  if (placed.fills?.length) {
    await cleanup();
    fail("market state", "order filled immediately; this gate must rest, not take");
  }
  if (placedOrderId === undefined) {
    fail("SDK", "placeOrder returned no orderId (did not rest)");
  }
  log("orderId", String(placedOrderId));

  let seen = null;
  let seenAt = 0;
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    seen = await exchange.client.getOrderOnchain(onchain.pool, placedOrderId);
    if (seen && seen.quantityRemaining > 0n) {
      seenAt = i * POLL_MS;
      break;
    }
    await sleep(POLL_MS);
  }
  if (!seen || seen.quantityRemaining <= 0n) {
    fail("indexing", `getOrderOnchain did not show active order ${placedOrderId} after ${POLL_ATTEMPTS * POLL_MS}ms`);
  }
  log("onchain order", JSON.stringify({
    orderId: String(seen.orderId),
    owner: seen.owner,
    isBid: seen.isBid,
    price: String(seen.price),
    quantityRemaining: String(seen.quantityRemaining),
    confirmMs: seenAt,
  }));
  if (seen.owner.toLowerCase() !== me.toLowerCase()) {
    fail("unknown", `on-chain owner ${seen.owner} != wallet ${me}`);
  }

  let indexerMs = null;
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const open = await exchange.fetchOpenOrders(yesSymbol);
    const hit = open.find((o) => String(o.id) === String(placedOrderId));
    if (hit) {
      indexerMs = i * POLL_MS;
      log("indexer open", `found after ${indexerMs}ms`);
      break;
    }
    await sleep(POLL_MS);
  }
  if (indexerMs === null) {
    log("WARN indexer", `fetchOpenOrders never listed ${placedOrderId} within ${POLL_ATTEMPTS * POLL_MS}ms (on-chain confirm still stands)`);
  }

  const cancelled = await exchange.trader.cancelOrder({ pool: onchain.pool, orderId: placedOrderId });
  const cancelHash = cancelled.hash;
  log("cancel tx", String(cancelHash));
  placedOrderId = undefined;

  let gone = false;
  let goneAt = 0;
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    const still = await exchange.client.getOrderOnchain(onchain.pool, seen.orderId);
    if (still === null || still.quantityRemaining === 0n) {
      gone = true;
      goneAt = i * POLL_MS;
      break;
    }
    await sleep(POLL_MS);
  }
  if (!gone) {
    placedOrderId = seen.orderId;
    fail("contract revert", "cancel mined but getOrderOnchain still returns the order");
  }
  log("cancel confirmed on-chain", `${goneAt}ms`);

  const sttAfter = await publicClient.getBalance({ address: me });
  const tusdcAfter = TUSDC ? await exchange.client.getErc20Balance(TUSDC, me) : 0n;

  log("RESULT", JSON.stringify({
    ok: true,
    dry: false,
    wallet: me,
    rpc: RPC_URL,
    marketId: info.marketId,
    intervalSec: chosen.intervalSec,
    side: "BUY_YES",
    price: fromRaw(price, decimals),
    amount: fromRaw(qty, decimals),
    postOnly: true,
    placeHash,
    orderId: String(seen.orderId),
    cancelHash,
    onchainConfirmMs: seenAt,
    indexerConfirmMs: indexerMs,
    cancelConfirmMs: goneAt,
    sttBefore: formatEther(sttBefore),
    sttAfter: formatEther(sttAfter),
    tusdcBeforeRaw: String(tusdcBefore),
    tusdcAfterRaw: String(tusdcAfter),
  }));
  log("PASS wet write-path: placed post-only BUY, saw it on-chain, cancelled it, saw it gone");
  process.exit(0);
} catch (err) {
  if (process.exitCode !== 1) {
    const kind =
      err instanceof WritePathError ? err.code
      : err instanceof ContractRevertError ? "contract revert"
      : "unknown";
    console.error(`FAIL [${kind}] ${err.message}`);
    process.exitCode = 1;
  }
  await cleanup();
  process.exit(process.exitCode || 1);
} finally {
  try { await exchange.destroy?.(); } catch { /* optional */ }
}
