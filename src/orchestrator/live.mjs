/**
 * Read/write adapter for the bounded villa-loop-v1 session.
 *
 * Reads are assembled through the existing Phase 4B/5B adapters. Writes are
 * exposed only as small operations for the runner to enqueue through the one
 * serialized writer. No policy or fair-value math lives here.
 */

import {
  ContractRevertError,
  ORDER_TYPE,
  SOMNIA_TESTNET_ADDRESSES,
  SOMNIA_TESTNET_PRICE_FEED,
  SomniaMarkets,
  isBinaryMarket,
} from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, http, isAddress, webSocket } from "viem";
import { createReadOnlyExchange as createReadOnlyRiskExchange, readChainTime as readChainTimeRisk, readOpenOrders } from "../risk-governor/live.mjs";
import { assembleLivePipeline, readRawAccountState } from "../execution/live.mjs";
import { planQuotes } from "../quote-planner/index.mjs";
import {
  DEFAULT_EXECUTION_POLICY,
  classifyOrderReconciliation,
  preflightOrder,
  targetFromPlan,
} from "../execution/policy.mjs";
import { createSerializedWriteQueue } from "../execution/write-queue.mjs";
import { minValidQuantity, isPostOnlyWouldCross } from "../../scripts/lib/write-path.mjs";
import { burnableMintedAmount, safeOrderExpiryNs } from "../inventory-lifecycle/index.mjs";
import { readKnownHistoricalResidual } from "../rollover/live.mjs";
import { assembleSuccessorPipeline, discoverSuccessor as discoverRolloverSuccessor, toCollectorMarket } from "../rollover/live.mjs";
import {
  CONFIGURED_SERIES,
  DEFAULT_ORCHESTRATOR_CONFIG,
  OrchestratorError,
  assertCommittedCollateralCap,
  assertExposureCap,
  assertProvisioningCap,
  marketContext,
  seriesIdentity,
} from "./index.mjs";

export const ORCHESTRATOR_DISCOVERY_LIMIT = 100;
export const ORCHESTRATOR_FINALIZED_LIMIT = 200;
export const ORCHESTRATOR_POST_ONLY_ATTEMPTS = 2;

function finite(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new OrchestratorError("LIVE_DATA_INVALID", `${label} is not finite`);
  return result;
}

function marketIdOf(row) {
  return row?.marketId ?? row?.info?.marketId ?? row?.id ?? null;
}

function indexedInterval(row) {
  return finite(row?.intervalSec ?? row?.info?.intervalSec, "indexed intervalSec");
}

function indexedExpiry(row) {
  return finite(row?.expiry ?? row?.info?.expiry, "indexed expiry");
}

function isTrading(onchain) {
  return Number(onchain?.status) === 1 && !onchain?.isResolved && !onchain?.isVoided;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createOrchestratorExchange({ dryRun = false, env = process.env } = {}) {
  if (dryRun) return createReadOnlyRiskExchange(env);
  if (!env.OPERATOR_PRIVATE_KEY) throw new OrchestratorError("ENVIRONMENT", "OPERATOR_PRIVATE_KEY is unset; preserve the existing .env");
  const exchange = new SomniaMarkets({
    indexerUrl: env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql",
    chain: somniaShannon,
    wsRpcUrl: env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws",
    addresses: SOMNIA_TESTNET_ADDRESSES,
    priceFeed: SOMNIA_TESTNET_PRICE_FEED,
    privateKey: env.OPERATOR_PRIVATE_KEY,
  });
  // Keep the SDK's read/live-tail client on the configured WebSocket. The
  // bounded session's write client uses the same WebSocket for reads and
  // receipt subscriptions, but routes the raw transaction fallback over the
  // official Shannon HTTP alias. The public endpoints have intermittently
  // accepted reads while stalling realtime signed-write calls, so deliberately
  // select the SDK's standard eth_sendRawTransaction fallback at this boundary.
  // This remains the SDK writer, with the same local signer and one queue.
  const writeClient = createPublicClient({
    chain: somniaShannon,
    transport: webSocket(env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws", { timeout: 4_000 }),
  });
  const httpWriteClient = createPublicClient({
    chain: somniaShannon,
    transport: http(env.RPC_URL || "https://dream-rpc.somnia.network", { timeout: 10_000 }),
  });
  const routedWriteClient = new Proxy(writeClient, {
    get(target, property, receiver) {
      if (property === "request") {
        return (args, options) => {
          if (args?.method === "realtime_sendRawTransaction") {
            const unsupported = new Error("VILLA bounded writer selects the standard HTTP raw-transaction fallback");
            unsupported.code = -32601;
            return Promise.reject(unsupported);
          }
          if (args?.method === "eth_sendRawTransaction") return httpWriteClient.request(args, options);
          return target.request(args, options);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  exchange.villaTrader = exchange.client.createTrader({ privateKey: env.OPERATOR_PRIVATE_KEY, publicClient: routedWriteClient });
  return exchange;
}

export function traderFor(exchange) {
  return exchange.villaTrader ?? exchange.trader;
}

export function ownerForExchange(exchange, env = process.env, { dryRun = false } = {}) {
  const owner = env.OPERATOR_ADDRESS || exchange.walletAddress;
  if (!owner || !isAddress(owner)) throw new OrchestratorError("ENVIRONMENT", "OPERATOR_ADDRESS is required");
  if (!dryRun && exchange.walletAddress && exchange.walletAddress.toLowerCase() !== owner.toLowerCase()) {
    throw new OrchestratorError("ENVIRONMENT", "OPERATOR_ADDRESS does not match the existing signer wallet");
  }
  return owner;
}

export async function readChainTime(exchange, { retries = 3 } = {}) {
  let last;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try { return await readChainTimeRisk(exchange); } catch (error) { last = error; if (attempt + 1 < retries) await sleep(250 * (attempt + 1)); }
  }
  throw new OrchestratorError("CHAIN_TIME_READ_FAILED", last?.message || String(last));
}

async function liveRows(exchange) {
  if (typeof exchange.client.listLiveBinaryMarkets === "function") {
    return {
      query: "client.listLiveBinaryMarkets",
      rows: await exchange.client.listLiveBinaryMarkets({ asset: "BTC", intervalSec: 300, status: "Trading", orderBy: "closingSoon", limit: ORCHESTRATOR_DISCOVERY_LIMIT }),
    };
  }
  return {
    query: "client.listBinaryMarkets",
    rows: await exchange.client.listBinaryMarkets({ asset: "BTC", intervalSec: 300, status: "Trading", limit: ORCHESTRATOR_DISCOVERY_LIMIT }),
  };
}

function candidateRows(rows) {
  return rows
    .filter((row) => isBinaryMarket(row) || String(row.marketType ?? row.info?.marketType ?? "").toUpperCase() === "BINARY")
    .filter((row) => String(row.asset ?? row.info?.asset ?? "").toUpperCase() === CONFIGURED_SERIES.asset)
    .filter((row) => indexedInterval(row) === CONFIGURED_SERIES.intervalSec)
    .filter((row) => marketIdOf(row))
    .sort((a, b) => indexedExpiry(a) - indexedExpiry(b) || String(marketIdOf(a)).localeCompare(String(marketIdOf(b))));
}

/** Discover only BINARY:BTC:300. There is deliberately no interval fallback. */
export async function discoverConfiguredMarket(exchange, owner, chainNowSec, { minHeadroomSec = DEFAULT_ORCHESTRATOR_CONFIG.minDiscoveryHeadroomSec } = {}) {
  const startedAtMs = Date.now();
  const source = await liveRows(exchange);
  const candidates = candidateRows(source.rows);
  const rejected = [];
  const valid = [];
  for (const row of candidates) {
    const id = String(marketIdOf(row));
    try {
      const onchain = await exchange.client.getMarketOnchain(id);
      const expirySec = finite(onchain.expiry ?? row.expiry, "on-chain expiry");
      if (!isTrading(onchain)) { rejected.push({ marketId: id, code: "NOT_TRADING", status: Number(onchain.status) }); continue; }
      if (expirySec - chainNowSec < minHeadroomSec) { rejected.push({ marketId: id, code: "HEADROOM", secondsLeft: expirySec - chainNowSec }); continue; }
      const market = toCollectorMarket(row, onchain);
      const orders = await readOpenOrders(exchange, onchain, owner, id, Number(onchain.decimals ?? market.info.baseDecimals));
      if (orders.status !== "VERIFIED") { rejected.push({ marketId: id, code: "OPEN_ORDER_UNVERIFIED", warning: orders.warning }); continue; }
      if (orders.orders.length) { rejected.push({ marketId: id, code: "VILLA_ORDERS_EXIST", count: orders.orders.length }); continue; }
      valid.push({ row, market, onchain, marketId: id, intervalSec: CONFIGURED_SERIES.intervalSec, expirySec, openOrderRead: orders });
    } catch (error) {
      rejected.push({ marketId: id, code: "READ_FAILED", reason: error?.message || String(error) });
    }
  }
  return {
    query: source.query,
    rowsReturned: source.rows.length,
    candidatesConsidered: candidates.length,
    rejected,
    durationMs: Date.now() - startedAtMs,
    selected: valid[0] ?? null,
    candidates: valid,
    waiting: valid.length === 0,
  };
}

/** Use Phase 5B's verified same-series successor selection, then adapt to execution. */
export async function discoverConfiguredSuccessor(exchange, current, chainNowSec, { limit = ORCHESTRATOR_DISCOVERY_LIMIT } = {}) {
  const result = await discoverRolloverSuccessor(exchange, {
    marketId: current.marketId,
    asset: CONFIGURED_SERIES.asset,
    intervalSec: CONFIGURED_SERIES.intervalSec,
    expirySec: current.expirySec,
    series: seriesIdentity(CONFIGURED_SERIES),
  }, chainNowSec, { limit });
  if (!result.selection.selected) return { ...result, selected: null };
  const selected = result.selection.selected;
  return {
    ...result,
    selected: {
      ...selected,
      row: selected.market,
      market: toCollectorMarket(selected.market, selected.onchain),
      marketId: String(selected.marketId),
      intervalSec: CONFIGURED_SERIES.intervalSec,
      expirySec: finite(selected.onchain.expiry, "successor expiry"),
    },
  };
}

export function pureMarketContextFromPipeline(pipeline) {
  const onchain = pipeline.selected.onchain;
  return marketContext({
    marketId: pipeline.context.marketId,
    series: seriesIdentity({ asset: CONFIGURED_SERIES.asset, intervalSec: CONFIGURED_SERIES.intervalSec }),
    expirySec: Number(onchain.expiry),
    status: Number(onchain.status),
    yesId: onchain.yesId,
    noId: onchain.noId,
    reference: pipeline.context.reference,
    pool: onchain.pool,
    venueId: pipeline.selected?.row?.venueId ?? pipeline.selected?.row?.info?.venueId ?? null,
  });
}

/** Fresh DATA -> FAIR VALUE -> GOVERNOR -> QUOTE assembly for the exact market. */
export async function assembleOrchestratorPipeline(exchange, selected, owner, { knownOrderIds = [], knownOrders = [] } = {}) {
  const sourceRow = selected.row ?? selected.market;
  const normalized = { ...selected, market: toCollectorMarket(sourceRow, selected.onchain) };
  const chainTime = await readChainTime(exchange);
  const assembled = await assembleSuccessorPipeline(exchange, { ...selected, market: sourceRow }, chainTime, owner, { knownOrderIds, knownOrders });
  if (!assembled.params) throw new OrchestratorError("GRID_READ_FAILED", assembled.bookWarning || "binary book/grid parameters were unavailable");
  // The planner's adaptive size factors can reduce a one-lot base quantity to
  // zero. Keep the operator base at five lots, as in the verified Phase 4B
  // adapter, then apply the Phase 6A one-lot verification cap at execution.
  const minimum = minValidQuantity(assembled.params);
  const practicalBase = minimum > assembled.params.lotSize * 5n ? minimum : assembled.params.lotSize * 5n;
  assembled.plannerInput = { ...assembled.plannerInput, quote: { ...assembled.plannerInput.quote, baseQuantityRaw: practicalBase.toString() } };
  assembled.plan = planQuotes(assembled.plannerInput);
  const pipeline = {
    ...assembled,
    selected: normalized,
    market: { market: assembled.collectorMarket, onchain: normalized.onchain },
    capturedAtMs: Date.now(),
    chainTime,
    midpoint: assembled.bookSummary?.midpoint ?? null,
  };
  pipeline.rawState = await readAccount(exchange, pipeline, owner);
  return { ...pipeline, marketContext: pureMarketContextFromPipeline(pipeline) };
}

export async function readAccount(exchange, pipeline, owner) {
  return readRawAccountState(exchange, exchange.client.getViemClient(), { ...pipeline.context, onchain: pipeline.selected.onchain }, owner);
}

async function readIndexedOrder(exchange, owner, pipeline, orderId) {
  try {
    const rows = await exchange.client.getOpenOrders(owner, { pool: pipeline.market.onchain.pool, limit: 1000 });
    const row = rows.find((candidate) => String(candidate.orderId) === String(orderId));
    if (!row) return null;
    const side = String(row.side).startsWith("BUY_") ? "BUY" : String(row.side).startsWith("SELL_") ? "SELL" : null;
    if (!side) return { side: null, remainingQtyRaw: null };
    return { side, remainingQtyRaw: String(row.quantityRemaining) };
  } catch {
    return null;
  }
}

async function readHistoryOrder(exchange, owner, pipeline, orderId) {
  try {
    const rows = await exchange.client.getOrders(owner, { pool: pipeline.market.onchain.pool, limit: 1000 });
    const row = rows.find((candidate) => String(candidate.orderId) === String(orderId));
    if (!row) return null;
    return { filledRaw: String(row.filledQuantity ?? "0"), remainingRaw: String(row.quantityRemaining ?? "0"), status: row.status ?? null };
  } catch {
    return null;
  }
}

export async function reconcileOrder(exchange, owner, pipeline, expected, { cancelRequested = false, attempts = 4 } = {}) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const onchain = await exchange.client.getOrderOnchain(pipeline.market.onchain.pool, BigInt(expected.orderId)).catch(() => null);
    const indexed = await readIndexedOrder(exchange, owner, pipeline, expected.orderId);
    const history = onchain ? null : await readHistoryOrder(exchange, owner, pipeline, expected.orderId);
    const fillsRaw = BigInt(history?.filledRaw ?? 0);
    const classification = classifyOrderReconciliation({ expected, onchain, indexed, cancelRequested, fillsRaw });
    last = { classification, onchain, indexed, history, fillsRaw, attempt };
    if (["RESTING", "FILLED", "PARTIALLY_FILLED", "CANCELLED"].includes(classification)) return last;
    await sleep(400 * (attempt + 1));
  }
  throw new OrchestratorError("RECONCILIATION_UNKNOWN", `order ${expected.orderId} could not be reconciled${last ? ` (${last.classification})` : ""}`);
}

export function preflightInput(pipeline, target, side, owner, capRaw) {
  return {
    nowMs: Date.now(),
    capturedAtMs: pipeline.capturedAtMs,
    chainNowSec: pipeline.chainTime.chainNowSec,
    market: { status: Number(pipeline.market.onchain.status), expirySec: Number(pipeline.market.onchain.expiry) },
    feed: pipeline.snapshot.feed,
    openOrdersStatus: pipeline.snapshot.openOrdersStatus,
    governor: pipeline.decision,
    sidePlan: pipeline.plan[side],
    intent: { action: target.action, priceRaw: target.plannerPriceRaw, quantityRaw: target.quantityRaw, owner },
    verificationCapRaw: capRaw,
    grid: pipeline.plannerInput.grid,
    book: pipeline.plannerInput.book,
    availableYesRaw: pipeline.rawState.yesRaw,
    collateralAvailableRaw: pipeline.rawState.collateralRaw,
    collateralReserveRaw: pipeline.plannerInput.capital.collateralReserveRaw,
  };
}

export function verificationQuantity(pipeline) {
  return minValidQuantity(pipeline.params);
}

export function targetForPipeline(pipeline, side, capRaw) {
  return targetFromPlan(pipeline.plan, side, capRaw);
}

export function safeOrderExpiry(pipeline, config = DEFAULT_ORCHESTRATOR_CONFIG) {
  return safeOrderExpiryNs({
    chainNowSec: pipeline.chainTime.chainNowSec,
    marketExpirySec: Number(pipeline.market.onchain.expiry),
    lifetimeSec: config.orderLifetimeSec,
    safetySec: config.orderSafetySec,
  });
}

export async function placePostOnly(exchange, queue, pipeline, owner, side, capRaw, config = DEFAULT_ORCHESTRATOR_CONFIG) {
  const target = targetForPipeline(pipeline, side, capRaw);
  if (!target.enabled) return { skipped: true, reason: target.reason, target };
  const gate = preflightOrder(preflightInput(pipeline, target, side, owner, capRaw), DEFAULT_EXECUTION_POLICY);
  if (!gate.allowed) return { skipped: true, reason: gate.code, gate, target };
  const expireTimestampNs = safeOrderExpiry(pipeline, config);
  const expected = {
    orderId: null,
    marketId: pipeline.context.marketId,
    pool: pipeline.market.onchain.pool,
    action: target.action,
    side,
    priceRaw: target.plannerPriceRaw,
    quantityRaw: target.quantityRaw,
    expireTimestampNs,
  };
  let placed;
  try {
    placed = await queue.enqueue(`place:${side}`, () => traderFor(exchange).placeOrder({
      pool: expected.pool,
      side: expected.action,
      price: target.plannerPriceRaw,
      quantity: target.quantityRaw,
      outcomeToken: pipeline.market.onchain.outcomeToken,
      yesId: pipeline.market.onchain.yesId,
      noId: pipeline.market.onchain.noId,
      collateral: pipeline.market.onchain.collateral,
      orderType: ORDER_TYPE.POST_ONLY,
      expireTimestampNs,
    }));
  } catch (error) {
    const cross = error instanceof ContractRevertError && isPostOnlyWouldCross(error);
    return { skipped: true, reason: cross ? "POST_ONLY_WOULD_CROSS" : "WRITE_FAILED", retryable: cross, error, target, gate };
  }
  if (placed?.orderId === undefined) throw new OrchestratorError("ORDER_ID_MISSING", "post-only placement returned no order id");
  expected.orderId = String(placed.orderId);
  const evidence = await reconcileOrder(exchange, owner, pipeline, expected);
  return { skipped: false, expected, placed, evidence, gate, target };
}

export async function cancelOrder(exchange, queue, pipeline, owner, expected) {
  const active = await exchange.client.getOrderOnchain(expected.pool, BigInt(expected.orderId)).catch(() => null);
  if (active && active.quantityRemaining > 0n) {
    const receipt = await queue.enqueue(`cancel:${expected.orderId}`, () => traderFor(exchange).cancelOrder({ pool: expected.pool, orderId: BigInt(expected.orderId) }));
    const evidence = await reconcileOrder(exchange, owner, pipeline, expected, { cancelRequested: true });
    if (evidence.classification !== "CANCELLED") throw new OrchestratorError("CANCEL_RECONCILIATION", `order ${expected.orderId} did not reconcile as cancelled`);
    return { submitted: true, receipt, evidence };
  }
  const evidence = await reconcileOrder(exchange, owner, pipeline, expected, { cancelRequested: true });
  return { submitted: false, receipt: null, evidence };
}

export async function mintMinimum(exchange, queue, pipeline, amountRaw) {
  return queue.enqueue("mintSet", () => traderFor(exchange).mintSet({ pool: pipeline.market.onchain.pool, collateral: pipeline.market.onchain.collateral, amount: amountRaw }));
}

export async function burnPaired(exchange, queue, pipeline, amountRaw) {
  return queue.enqueue("burnSet", () => traderFor(exchange).burnSet({ pool: pipeline.market.onchain.pool, outcomeToken: pipeline.market.onchain.outcomeToken, amount: amountRaw }));
}

export async function readSettlementCheck(exchange, owner) {
  const [rows, residual] = await Promise.all([
    exchange.client.listBinaryMarkets({ asset: "BTC", status: "Finalized", limit: ORCHESTRATOR_FINALIZED_LIMIT }),
    readKnownHistoricalResidual(exchange, owner),
  ]);
  return { finalizedRows: rows.length, knownResidual: residual, claimable: residual.knownResidual?.filter((item) => item.classification === "CLAIMABLE_WINNING_OUTCOME") ?? [] };
}

export async function scanConfiguredActiveOrders(exchange, owner) {
  const source = await liveRows(exchange);
  const rows = candidateRows(source.rows);
  const entries = [];
  for (const row of rows) {
    const id = String(marketIdOf(row));
    try {
      const onchain = await exchange.client.getMarketOnchain(id);
      const ids = isTrading(onchain) ? await exchange.client.getOwnOpenOrdersOnchain(onchain.pool, owner) : [];
      if (ids.length) entries.push({ marketId: id, ids: ids.map(String), pool: onchain.pool });
    } catch (error) {
      entries.push({ marketId: id, ids: [], warning: error?.message || String(error) });
    }
  }
  return entries;
}

export function temporaryBurnAmount({ baseline, current, mintedRaw }) {
  if (!mintedRaw || mintedRaw <= 0n) return 0n;
  const yesDelta = current.yesRaw >= baseline.yesRaw ? current.yesRaw - baseline.yesRaw : 0n;
  const noDelta = current.noRaw >= baseline.noRaw ? current.noRaw - baseline.noRaw : 0n;
  const paired = yesDelta < noDelta ? yesDelta : noDelta;
  return paired < mintedRaw ? paired : mintedRaw;
}

export { createSerializedWriteQueue, readOpenOrders, burnableMintedAmount };
