/**
 * Controlled Shannon complete-set inventory and SELL_YES lifecycle verifier.
 *
 * Wet mode is deliberately one bounded sequence:
 *   mint tiny YES+NO set -> verify -> post-only SELL_YES -> verify -> cancel
 *   -> verify -> burn the same paired set -> verify.
 *
 * It never takes liquidity, fills intentionally, cancels an unrelated order,
 * redeems a settled market, or runs a quote loop. Use --dry-run for the full
 * read/planning path without a signer or transaction.
 */
import {
  ContractRevertError,
  isBinaryMarket,
  ORDER_TYPE,
  SomniaMarkets,
  SOMNIA_TESTNET_ADDRESSES,
  SOMNIA_TESTNET_PRICE_FEED,
} from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, http } from "viem";
import { calculateBinaryExposure } from "../src/risk-governor/exposure.mjs";
import { createReadOnlyExchange, readChainTime, readOpenOrders } from "../src/risk-governor/live.mjs";
import {
  InventoryLifecycleError,
  burnableMintedAmount,
  completeSetExposure,
  expectedBalancesAfterMint,
  isPostOnlySellSafe,
  lifecycleEconomics,
  minimumMintAmount,
  safeOrderExpiryNs,
  selectRestingSellPrice,
  sellCapacityRaw,
  validateMintAmount,
} from "../src/inventory-lifecycle/index.mjs";
import { fromRaw, isPostOnlyWouldCross, toRaw } from "./lib/write-path.mjs";

const DRY = process.argv.includes("--dry-run") || process.env.DRY === "1";
const RPC_URL = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const INDEXER_URL = process.env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = process.env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws";
const MIN_INTERVAL_SEC = 300;
const MIN_HEADROOM_SEC = 600;
const MIN_STT_WEI = 10n ** 15n;
const POLL_MS = 400;
const POLL_ATTEMPTS = 25;
const CROSS_RETRIES = 3;

function log(step, detail = "") {
  console.log(`${step}${detail ? `  ${detail}` : ""}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asFiniteNumber(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new InventoryLifecycleError("INVALID_DATA", `${label} is not finite`);
  return result;
}

function rawBookPrice(level, decimals, label) {
  if (!Array.isArray(level) || level[0] === undefined || level[0] === null) return undefined;
  const numeric = Number(level[0]);
  if (!Number.isFinite(numeric)) throw new InventoryLifecycleError("INVALID_BOOK", `${label} is not finite`);
  return toRaw(numeric.toFixed(decimals), decimals);
}

function rawToHuman(raw, decimals) {
  return Number(raw) / 10 ** decimals;
}

function assertEqual(actual, expected, code, message) {
  if (actual !== expected) throw new InventoryLifecycleError(code, `${message}: got ${actual}, expected ${expected}`);
}

function jsonSafe(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function createExchange() {
  if (DRY) return createReadOnlyExchange();
  const privateKey = process.env.OPERATOR_PRIVATE_KEY;
  if (!privateKey) throw new InventoryLifecycleError("ENVIRONMENT", "OPERATOR_PRIVATE_KEY is unset; the existing .env is required");
  return new SomniaMarkets({
    indexerUrl: INDEXER_URL,
    chain: somniaShannon,
    wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_TESTNET_ADDRESSES,
    priceFeed: SOMNIA_TESTNET_PRICE_FEED,
    privateKey,
  });
}

async function discoverCleanMarket(exchange, owner, chainNowSec) {
  const loaded = Object.values(await exchange.loadMarkets(true));
  const candidates = [];
  const activeOrderMarkets = [];
  for (const market of loaded) {
    if (market.type !== "binary" || !isBinaryMarket(market.info) || market.info.asset !== "BTC") continue;
    const intervalSec = Number(market.info.intervalSec);
    if (!Number.isFinite(intervalSec) || intervalSec < MIN_INTERVAL_SEC) continue;
    let onchain;
    try {
      onchain = await exchange.client.getMarketOnchain(market.info.marketId);
    } catch {
      continue;
    }
    const expirySec = asFiniteNumber(onchain.expiry ?? market.info.expiry, "market expiry");
    if (Number(onchain.status) !== 1 || onchain.isResolved || onchain.isVoided || expirySec - chainNowSec < MIN_HEADROOM_SEC) continue;
    const activeIds = await exchange.client.getOwnOpenOrdersOnchain(onchain.pool, owner);
    if (activeIds.length) activeOrderMarkets.push({ symbol: market.symbol, pool: onchain.pool, count: activeIds.length });
    candidates.push({ market, onchain, intervalSec, expirySec, secondsLeft: expirySec - chainNowSec });
  }
  if (activeOrderMarkets.length) {
    throw new InventoryLifecycleError("ACTIVE_ORDERS_EXIST", `refusing lifecycle test while ${activeOrderMarkets.reduce((sum, item) => sum + item.count, 0)} active VILLA order(s) exist across ${activeOrderMarkets.length} BTC pool(s)`);
  }
  candidates.sort((a, b) => b.intervalSec - a.intervalSec || b.secondsLeft - a.secondsLeft);
  if (!candidates.length) throw new InventoryLifecycleError("MARKET_STATE", `no clean BTC Trading Event Contract with ${MIN_HEADROOM_SEC}s headroom`);
  return candidates[0];
}

async function readBalances(exchange, publicClient, onchain, owner) {
  const [sttRaw, collateralRaw, yesRaw, noRaw] = await Promise.all([
    publicClient.getBalance({ address: owner }),
    exchange.client.getErc20Balance(onchain.collateral, owner),
    exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: owner, id: onchain.yesId }),
    exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: owner, id: onchain.noId }),
  ]);
  return { sttRaw, collateralRaw, yesRaw, noRaw };
}

async function waitForOrder(exchange, pool, orderId) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const order = await exchange.client.getOrderOnchain(pool, orderId);
    if (order && order.quantityRemaining > 0n) return { order, elapsedMs: attempt * POLL_MS };
    await sleep(POLL_MS);
  }
  throw new InventoryLifecycleError("ORDER_READ", `on-chain order ${orderId} did not become active within ${POLL_ATTEMPTS * POLL_MS}ms`);
}

async function waitForGone(exchange, pool, orderId) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    const order = await exchange.client.getOrderOnchain(pool, orderId);
    if (!order || order.quantityRemaining === 0n) return attempt * POLL_MS;
    await sleep(POLL_MS);
  }
  throw new InventoryLifecycleError("CANCEL_READ", `order ${orderId} remained active after cancellation`);
}

async function readVerifiedTargetOrders(exchange, selected, owner, decimals) {
  const result = await readOpenOrders(exchange, selected.onchain, owner, selected.market.info.marketId, decimals);
  if (result.status !== "VERIFIED") throw new InventoryLifecycleError("OPEN_ORDER_READ", result.warning || "target open-order read was ambiguous");
  return result;
}

const exchange = createExchange();
const owner = process.env.OPERATOR_ADDRESS || exchange.walletAddress;
if (!owner) throw new InventoryLifecycleError("ENVIRONMENT", "OPERATOR_ADDRESS or derived wallet address is required");
if (!DRY && exchange.walletAddress && exchange.walletAddress.toLowerCase() !== owner.toLowerCase()) {
  throw new InventoryLifecycleError("ENVIRONMENT", "OPERATOR_ADDRESS does not match the wallet derived from OPERATOR_PRIVATE_KEY");
}
const publicClient = createPublicClient({ chain: somniaShannon, transport: http(RPC_URL) });

let selected;
let decimals;
let mintAmountRaw;
let minted = false;
let placedOrderId;
let placedPool;
let baseline;
let cleanupBlocked = false;

async function cancelExactIfActive() {
  if (DRY || placedOrderId === undefined || !placedPool) return false;
  const active = await exchange.client.getOrderOnchain(placedPool, placedOrderId).catch(() => null);
  if (!active || active.quantityRemaining <= 0n) return false;
  log("cleanup", `cancelling exact SELL_YES order ${placedOrderId}`);
  await exchange.trader.cancelOrder({ pool: placedPool, orderId: placedOrderId });
  await waitForGone(exchange, placedPool, placedOrderId);
  placedOrderId = undefined;
  return true;
}

async function cleanup() {
  if (DRY || !minted || !selected || cleanupBlocked) return;
  try {
    await cancelExactIfActive();
    const state = await readBalances(exchange, publicClient, selected.onchain, owner);
    const orders = await readVerifiedTargetOrders(exchange, selected, owner, decimals);
    if (orders.orders.length) {
      log("cleanup", "refusing burn while any target open order remains");
      return;
    }
    const yesDelta = state.yesRaw - baseline.yesRaw;
    const noDelta = state.noRaw - baseline.noRaw;
    if (yesDelta === mintAmountRaw && noDelta === mintAmountRaw) {
      log("cleanup", `burning exact unconsumed mint ${mintAmountRaw} raw`);
      await exchange.trader.burnSet({ pool: selected.onchain.pool, amount: mintAmountRaw });
      minted = false;
    } else {
      log("cleanup", `refusing blind burn: YES delta ${yesDelta}, NO delta ${noDelta}`);
    }
  } catch (err) {
    console.error(`CLEANUP WARNING: ${err?.message || err}`);
  }
}

async function main() {
  const chainTime = await readChainTime(exchange);
  selected = await discoverCleanMarket(exchange, owner, chainTime.chainNowSec);
  const { market, onchain } = selected;
  decimals = Number(onchain.decimals ?? market.info.baseDecimals ?? market.info.quoteDecimals ?? 6);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new InventoryLifecycleError("DECIMALS", `unsupported market decimals ${decimals}`);
  const oneRaw = 10n ** BigInt(decimals);
  const yesSymbol = market.outcomes?.find((outcome) => outcome.label === "YES")?.symbol;
  if (!yesSymbol) throw new InventoryLifecycleError("MARKET_STATE", "selected market has no YES outcome symbol");

  const params = await exchange.client.getBinaryBookParams(onchain.pool);
  mintAmountRaw = minimumMintAmount({ lotSizeRaw: params.lotSize, minQuantityRaw: params.minQuantity });
  validateMintAmount({ amountRaw: mintAmountRaw, lotSizeRaw: params.lotSize, minQuantityRaw: params.minQuantity });
  baseline = await readBalances(exchange, publicClient, onchain, owner);
  const baselineOrders = await readVerifiedTargetOrders(exchange, selected, owner, decimals);
  if (baselineOrders.orders.length) throw new InventoryLifecycleError("ACTIVE_ORDERS_EXIST", "target market has active orders at baseline");
  if (baseline.sttRaw < MIN_STT_WEI) throw new InventoryLifecycleError("FUNDING", `native balance is below ${MIN_STT_WEI} wei floor`);
  if (baseline.collateralRaw < mintAmountRaw) throw new InventoryLifecycleError("FUNDING", `tUSDC ${baseline.collateralRaw} is below mint amount ${mintAmountRaw}`);

  const book = await exchange.fetchOrderBook(yesSymbol, 5);
  const bestBidRaw = rawBookPrice(book.bids?.[0], decimals, "best bid");
  const bestAskRaw = rawBookPrice(book.asks?.[0], decimals, "best ask");
  const sellPriceRaw = selectRestingSellPrice({ oneRaw, tickSizeRaw: params.tickSize, bestBidRaw, bestAskRaw, parkTicks: 10 });
  if (!isPostOnlySellSafe({ oneRaw, tickSizeRaw: params.tickSize, priceRaw: sellPriceRaw, bestBidRaw, bestAskRaw })) throw new InventoryLifecycleError("WOULD_CROSS", "planned SELL_YES is not post-only safe");
  const orderChainTime = await readChainTime(exchange);
  const expireTimestampNs = safeOrderExpiryNs({ chainNowSec: orderChainTime.chainNowSec, marketExpirySec: Number(onchain.expiry), lifetimeSec: 300, safetySec: 2 });

  log("mode", DRY ? "dry-run (no signer write; no transaction sent)" : "wet (one bounded mint / SELL / cancel / burn sequence)");
  log("market", JSON.stringify({ symbol: market.symbol, marketId: market.info.marketId, intervalSec: selected.intervalSec, pool: onchain.pool, status: Number(onchain.status), expirySec: String(onchain.expiry), secondsLeft: Math.floor(selected.expirySec - chainTime.chainNowSec) }));
  log("outcomes", JSON.stringify({ outcomeToken: onchain.outcomeToken, yesId: String(onchain.yesId), noId: String(onchain.noId) }));
  log("baseline", JSON.stringify({ sttRaw: String(baseline.sttRaw), tUsdcRaw: String(baseline.collateralRaw), yesRaw: String(baseline.yesRaw), noRaw: String(baseline.noRaw), openOrders: baselineOrders.orders.length, chainTimeSec: chainTime.chainNowSec }));
  log("grid", JSON.stringify({ decimals, tickSizeRaw: String(params.tickSize), lotSizeRaw: String(params.lotSize), minQuantityRaw: String(params.minQuantity), mintAmountRaw: String(mintAmountRaw) }));
  log("SELL plan", JSON.stringify({ side: "SELL_YES", postOnly: true, bestBidRaw: bestBidRaw === undefined ? null : String(bestBidRaw), bestAskRaw: bestAskRaw === undefined ? null : String(bestAskRaw), priceRaw: String(sellPriceRaw), price: fromRaw(sellPriceRaw, decimals), quantityRaw: String(mintAmountRaw), quantity: fromRaw(mintAmountRaw, decimals), expireTimestampNs: String(expireTimestampNs) }));

  if (DRY) {
    log("risk exposure", JSON.stringify(calculateBinaryExposure({ yes: rawToHuman(baseline.yesRaw, decimals), no: rawToHuman(baseline.noRaw, decimals), openOrders: [] })));
    log("DRY", "would mint, verify equal YES+NO, place/cancel exact SELL_YES, verify zero fills, then burnSet; no transaction sent");
    log("PASS dry-run");
    return;
  }

  const mintedTx = await exchange.trader.mintSet({ pool: onchain.pool, amount: mintAmountRaw });
  minted = true;
  log("mint tx", String(mintedTx.hash));
  const afterMint = await readBalances(exchange, publicClient, onchain, owner);
  const expected = expectedBalancesAfterMint({ baselineYesRaw: baseline.yesRaw, baselineNoRaw: baseline.noRaw, amountRaw: mintAmountRaw });
  assertEqual(afterMint.yesRaw, expected.yesRaw, "MINT_VERIFY", "YES did not increase by the mint amount");
  assertEqual(afterMint.noRaw, expected.noRaw, "MINT_VERIFY", "NO did not increase by the mint amount");
  assertEqual(baseline.collateralRaw - afterMint.collateralRaw, mintAmountRaw, "MINT_VERIFY", "collateral debit was not exactly the mint amount");
  const postMintExposure = completeSetExposure({ yesRaw: afterMint.yesRaw, noRaw: afterMint.noRaw });
  const postMintRisk = calculateBinaryExposure({ yes: rawToHuman(afterMint.yesRaw, decimals), no: rawToHuman(afterMint.noRaw, decimals), openOrders: [] });
  if (postMintExposure.directionalDeltaRaw !== 0n) throw new InventoryLifecycleError("EXPOSURE_VERIFY", "post-mint YES/NO directional delta is not zero");
  log("mint verified", JSON.stringify({ tUsdcRaw: String(afterMint.collateralRaw), yesRaw: String(afterMint.yesRaw), noRaw: String(afterMint.noRaw), completeSetsRaw: String(postMintExposure.completeSetsRaw), directionalDeltaRaw: String(postMintExposure.directionalDeltaRaw), governorExposure: postMintRisk }));

  let placePriceRaw = sellPriceRaw;
  let placed;
  for (let attempt = 1; attempt <= CROSS_RETRIES; attempt++) {
    try {
      placed = await exchange.trader.placeOrder({
        pool: onchain.pool,
        side: "SELL_YES",
        price: placePriceRaw,
        quantity: mintAmountRaw,
        outcomeToken: onchain.outcomeToken,
        yesId: onchain.yesId,
        noId: onchain.noId,
        orderType: ORDER_TYPE.POST_ONLY,
        expireTimestampNs,
      });
      break;
    } catch (err) {
      const cross = err instanceof ContractRevertError && isPostOnlyWouldCross(err);
      if (!cross || attempt === CROSS_RETRIES) throw new InventoryLifecycleError(cross ? "POST_ONLY_CROSS" : "PLACE_REVERT", `${err?.errorName || err?.name || "placeOrder"}: ${err?.message || err}`);
      log("PostOnlyWouldCross", `attempt ${attempt}/${CROSS_RETRIES}; refreshing YES book`);
      const refreshed = await exchange.fetchOrderBook(yesSymbol, 5);
      const rb = rawBookPrice(refreshed.bids?.[0], decimals, "refreshed best bid");
      const ra = rawBookPrice(refreshed.asks?.[0], decimals, "refreshed best ask");
      placePriceRaw = selectRestingSellPrice({ oneRaw, tickSizeRaw: params.tickSize, bestBidRaw: rb, bestAskRaw: ra, parkTicks: 10 + attempt * 5 });
    }
  }
  if (!placed || placed.orderId === undefined) throw new InventoryLifecycleError("PLACE_REVERT", "SELL_YES returned no resting order id");
  placedPool = onchain.pool;
  placedOrderId = placed.orderId;
  if (placed.fills?.length) throw new InventoryLifecycleError("UNINTENTIONAL_FILL", "SELL_YES returned fills; this verifier requires a resting order");
  log("SELL tx", String(placed.hash));
  log("SELL orderId", String(placedOrderId));
  const activeRead = await waitForOrder(exchange, onchain.pool, placedOrderId);
  const active = activeRead.order;
  if (active.owner.toLowerCase() !== owner.toLowerCase() || active.isBid || active.price !== placePriceRaw || active.quantityRemaining !== mintAmountRaw) {
    throw new InventoryLifecycleError("ORDER_VERIFY", "on-chain SELL_YES fields did not match the exact requested owner, side, price, and quantity");
  }
  log("SELL on-chain", JSON.stringify({ owner: "operator", isBid: active.isBid, priceRaw: String(active.price), quantityRemainingRaw: String(active.quantityRemaining), confirmMs: activeRead.elapsedMs, fills: 0 }));
  const indexed = await readVerifiedTargetOrders(exchange, selected, owner, decimals);
  const indexedHit = indexed.orders.find((order) => order.id === String(placedOrderId));
  if (!indexedHit || indexedHit.outcome !== "YES" || indexedHit.side !== "SELL") throw new InventoryLifecycleError("ORDER_VERIFY", "indexer did not expose the exact resting SELL_YES");
  log("SELL indexer", JSON.stringify({ id: indexedHit.id, outcome: indexedHit.outcome, side: indexedHit.side, remainingQty: indexedHit.remainingQty, priceYes: indexedHit.priceYes }));

  const restingBalances = await readBalances(exchange, publicClient, onchain, owner);
  const visibleBalanceIncludesCommitment = restingBalances.yesRaw >= afterMint.yesRaw;
  const effectiveSellCapacity = sellCapacityRaw({ yesRaw: restingBalances.yesRaw, committedSellRaw: active.quantityRemaining, lotSizeRaw: params.lotSize, balanceIncludesCommitted: visibleBalanceIncludesCommitment });
  log("SELL inventory semantics", JSON.stringify({ visibleYesRaw: String(restingBalances.yesRaw), committedSellRaw: String(active.quantityRemaining), balanceIncludesCommitted: visibleBalanceIncludesCommitment, effectiveFreeSellCapacityRaw: String(effectiveSellCapacity) }));
  if (effectiveSellCapacity !== 0n) throw new InventoryLifecycleError("ORDER_VERIFY", "the full controlled YES amount was not committed by the resting SELL");

  const cancelled = await exchange.trader.cancelOrder({ pool: onchain.pool, orderId: placedOrderId });
  log("cancel tx", String(cancelled.hash));
  const cancelConfirmMs = await waitForGone(exchange, onchain.pool, placedOrderId);
  const afterCancelOrders = await readVerifiedTargetOrders(exchange, selected, owner, decimals);
  if (afterCancelOrders.orders.some((order) => order.id === String(placedOrderId))) throw new InventoryLifecycleError("CANCEL_VERIFY", "exact SELL order remained in open-order reads");
  const afterCancel = await readBalances(exchange, publicClient, onchain, owner);
  assertEqual(afterCancel.yesRaw, afterMint.yesRaw, "FILL_VERIFY", "YES balance changed across a no-fill SELL/cancel");
  assertEqual(afterCancel.noRaw, afterMint.noRaw, "FILL_VERIFY", "NO balance changed across a no-fill SELL/cancel");
  placedOrderId = undefined;
  log("cancel verified", JSON.stringify({ onChainGone: true, openOrderGone: true, confirmMs: cancelConfirmMs, yesRaw: String(afterCancel.yesRaw), noRaw: String(afterCancel.noRaw), fills: 0 }));

  const burnAmountRaw = burnableMintedAmount({ baselineYesRaw: baseline.yesRaw, baselineNoRaw: baseline.noRaw, currentYesRaw: afterCancel.yesRaw, currentNoRaw: afterCancel.noRaw, mintedAmountRaw: mintAmountRaw });
  const burnTx = await exchange.trader.burnSet({ pool: onchain.pool, amount: burnAmountRaw });
  minted = false;
  log("burnSet tx", String(burnTx.hash));
  log("burn distinction", "burnSet destroyed an equal pre-settlement YES+NO pair; this was not settlement redeem");
  const final = await readBalances(exchange, publicClient, onchain, owner);
  const economics = lifecycleEconomics({ collateralBeforeRaw: baseline.collateralRaw, collateralAfterMintRaw: afterMint.collateralRaw, collateralFinalRaw: final.collateralRaw, mintAmountRaw });
  assertEqual(final.yesRaw, baseline.yesRaw, "BURN_VERIFY", "final YES balance did not return to baseline");
  assertEqual(final.noRaw, baseline.noRaw, "BURN_VERIFY", "final NO balance did not return to baseline");
  assertEqual(final.collateralRaw, baseline.collateralRaw, "BURN_VERIFY", "final tUSDC did not return to baseline");
  const finalOrders = await readVerifiedTargetOrders(exchange, selected, owner, decimals);
  if (finalOrders.orders.length) throw new InventoryLifecycleError("CLEANUP_VERIFY", "target market has active orders after burn");
  log("RESULT", jsonSafe({ ok: true, model: "villa-inventory-v1", marketId: market.info.marketId, side: "SELL_YES", mintAmountRaw: String(mintAmountRaw), placeHash: String(placed.hash), cancelHash: String(cancelled.hash), burnHash: String(burnTx.hash), economics, final: { sttRaw: String(final.sttRaw), tUsdcRaw: String(final.collateralRaw), yesRaw: String(final.yesRaw), noRaw: String(final.noRaw), openOrders: finalOrders.orders.length } }));
  log("PASS inventory lifecycle: minted paired set, rested and cancelled exact SELL_YES, burned paired set, restored collateral");
}

try {
  await main();
  process.exit(0);
} catch (err) {
  console.error(`INVENTORY LIFECYCLE ${DRY ? "DRY-RUN " : ""}REFUSED: ${err?.message || err}`);
  if (!DRY) await cleanup();
  process.exitCode = 1;
} finally {
  try { await exchange.destroy?.(); } catch { /* optional SDK cleanup */ }
}
