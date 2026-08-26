/**
 * Read/write boundary for settlement lifecycle verification.
 *
 * All decisions that can be unit-tested live in index.mjs.  This file only
 * acquires chain/indexer state and delegates a confirmed redeem to the SDK
 * after the caller has explicitly enabled the bounded write path.
 */

import {
  SomniaMarkets,
  SOMNIA_TESTNET_ADDRESSES,
  SOMNIA_TESTNET_PRICE_FEED,
  erc6909Abi,
} from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { isAddress } from "viem";
import {
  ONCHAIN_STATUS,
  SettlementLifecycleError,
  authoritativeResolution,
  buildClaimSweepEntry,
  buildRedemptionPlan,
  classifyMarketState,
  historicalMarketMatches,
  reconcileMintBalances,
} from "./index.mjs";

export const SETTLEMENT_MIN_HEADROOM_SEC = 90;
export const SETTLEMENT_SHORT_INTERVALS_SEC = Object.freeze([60, 300]);
export const SETTLEMENT_FINALIZED_LIMIT = 200;

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new SettlementLifecycleError("INVALID_DATA", `${label} is not finite`);
  return number;
}

function raw(value, label) {
  try {
    const result = typeof value === "bigint" ? value : BigInt(String(value));
    if (result < 0n) throw new Error("negative");
    return result;
  } catch {
    throw new SettlementLifecycleError("INVALID_RAW", `${label} is not a non-negative integer`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameAddress(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function marketRowId(row) {
  const id = row?.marketId ?? row?.info?.marketId;
  if (typeof id !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(id)) return null;
  return id;
}

function indexedExpiry(row) {
  return finite(row?.expiry ?? row?.info?.expiry, "indexed expiry");
}

function indexedInterval(row) {
  return finite(row?.intervalSec ?? row?.info?.intervalSec, "indexed intervalSec");
}

export function createSettlementExchange({ dryRun = false, env = process.env } = {}) {
  if (dryRun) {
    const account = env.OPERATOR_ADDRESS;
    if (!account || !isAddress(account)) throw new SettlementLifecycleError("ENVIRONMENT", "OPERATOR_ADDRESS is required for settlement dry-run reads");
    return new SomniaMarkets({
      account,
      indexerUrl: env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql",
      chain: somniaShannon,
      wsRpcUrl: env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws",
      addresses: SOMNIA_TESTNET_ADDRESSES,
      priceFeed: SOMNIA_TESTNET_PRICE_FEED,
    });
  }
  if (!env.OPERATOR_PRIVATE_KEY) throw new SettlementLifecycleError("ENVIRONMENT", "OPERATOR_PRIVATE_KEY is unset; the existing .env is required");
  return new SomniaMarkets({
    indexerUrl: env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql",
    chain: somniaShannon,
    wsRpcUrl: env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws",
    addresses: SOMNIA_TESTNET_ADDRESSES,
    priceFeed: SOMNIA_TESTNET_PRICE_FEED,
    privateKey: env.OPERATOR_PRIVATE_KEY,
  });
}

export async function readChainTime(exchange) {
  const startedAtMs = Date.now();
  const block = await exchange.client.getViemClient().getBlock();
  const observedAtMs = Date.now();
  const chainNowSec = finite(block.timestamp, "chain block timestamp");
  return {
    chainNowSec,
    blockNumber: block.number === undefined ? null : Number(block.number),
    observedAtMs,
    observationAgeSec: Math.max(0, (observedAtMs - startedAtMs) / 1000),
    clockOffsetSec: chainNowSec - observedAtMs / 1000,
  };
}

export async function readBalances(exchange, onchain, owner) {
  if (!owner || !isAddress(owner)) throw new SettlementLifecycleError("ENVIRONMENT", "valid owner address is required for balance reads");
  const publicClient = exchange.client.getViemClient();
  const [sttRaw, collateralRaw, yesRaw, noRaw] = await Promise.all([
    publicClient.getBalance({ address: owner }),
    exchange.client.getErc20Balance(onchain.collateral, owner),
    exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: owner, id: onchain.yesId }),
    exchange.client.getOutcomeBalance({ outcomeToken: onchain.outcomeToken, account: owner, id: onchain.noId }),
  ]);
  return {
    sttRaw: raw(sttRaw, "STT balance"),
    collateralRaw: raw(collateralRaw, "collateral balance"),
    yesRaw: raw(yesRaw, "YES balance"),
    noRaw: raw(noRaw, "NO balance"),
  };
}

export async function readOperatorApproval(exchange, onchain, owner) {
  const publicClient = exchange.client.getViemClient();
  const module = SOMNIA_TESTNET_ADDRESSES.binaryModule;
  return Boolean(await publicClient.readContract({
    address: onchain.outcomeToken,
    abi: erc6909Abi,
    functionName: "isOperator",
    args: [owner, module],
  }));
}

/**
 * Discover from the current indexer page, then gate every candidate on live
 * chain state.  The marketId is the identity; pool is retained only as the
 * current execution parameter returned by getMarketOnchain.
 */
export async function discoverShortBtcMarket(exchange, { chainNowSec, minHeadroomSec = SETTLEMENT_MIN_HEADROOM_SEC, requireShort = true } = {}) {
  // The unfiltered registry page is dominated by historical rows.  Ask the
  // indexer for its Trading slice first, then verify that slice on-chain.
  const rows = await exchange.client.listBinaryMarkets({ asset: "BTC", status: "Trading", limit: SETTLEMENT_FINALIZED_LIMIT });
  const candidates = rows
    .filter((row) => marketRowId(row))
    .filter((row) => SETTLEMENT_SHORT_INTERVALS_SEC.includes(Math.round(indexedInterval(row))))
    .map((row) => ({ row, marketId: marketRowId(row), intervalSec: Math.round(indexedInterval(row)) }))
    .sort((a, b) => a.intervalSec - b.intervalSec || indexedExpiry(a.row) - indexedExpiry(b.row));
  const rejected = [];
  for (const candidate of candidates) {
    let onchain;
    try {
      onchain = await exchange.client.getMarketOnchain(candidate.marketId);
      const expirySec = finite(onchain.expiry, "on-chain expiry");
      if (expirySec - chainNowSec < minHeadroomSec) {
        rejected.push(`${candidate.marketId}: only ${Math.floor(expirySec - chainNowSec)}s headroom`);
        continue;
      }
      if (Number(onchain.status) !== ONCHAIN_STATUS.Trading || onchain.isResolved || onchain.isVoided) {
        rejected.push(`${candidate.marketId}: on-chain state ${Number(onchain.status)}`);
        continue;
      }
      return {
        row: candidate.row,
        marketId: candidate.marketId,
        intervalSec: candidate.intervalSec,
        expirySec,
        secondsLeft: expirySec - chainNowSec,
        onchain,
      };
    } catch (error) {
      rejected.push(`${candidate.marketId}: ${error?.message || error}`);
    }
  }
  const requirement = requireShort ? "short BTC (1m/5m)" : "BTC";
  throw new SettlementLifecycleError("MARKET_STATE", `no ${requirement} Trading Event Contract with ${minHeadroomSec}s chain-time headroom; checked ${candidates.length}; ${rejected.slice(0, 4).join("; ")}`);
}

export async function readVerifiedOrders(exchange, onchain, owner, marketId, decimals) {
  const [chainIds, indexedRows] = await Promise.all([
    exchange.client.getOwnOpenOrdersOnchain(onchain.pool, owner),
    exchange.client.getOpenOrders(owner, { pool: onchain.pool, limit: 1000 }),
  ]);
  const rows = indexedRows.filter((row) => sameAddress(row.market, marketId));
  const chainSet = chainIds.map(String).sort();
  const indexSet = rows.map((row) => String(row.orderId)).sort();
  if (chainSet.length !== indexSet.length || chainSet.some((id, index) => id !== indexSet[index])) {
    throw new SettlementLifecycleError("OPEN_ORDERS_AMBIGUOUS", "indexer and on-chain open-order ids disagree");
  }
  return { status: "VERIFIED", count: chainSet.length, ids: chainSet, decimals };
}

export async function readPayoutNumerators(exchange, onchain) {
  const vector = await exchange.client.getViemClient().readContract({
    address: onchain.marketAddress,
    abi: [{ type: "function", name: "payoutNumerators", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] }],
    functionName: "payoutNumerators",
  });
  if (!Array.isArray(vector) || vector.length !== 2) throw new SettlementLifecycleError("INVALID_PAYOUT_VECTOR", "resolved market did not return a binary payout vector");
  return vector.map((value, index) => raw(value, `payoutNumerators[${index}]`));
}

export async function waitForHistoricalRediscovery(exchange, targetMarketId, { asset = "BTC", attempts = 6, delayMs = 1000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rows = await exchange.client.listBinaryMarkets({ status: "Finalized", asset, limit: SETTLEMENT_FINALIZED_LIMIT });
    const row = rows.find((candidate) => historicalMarketMatches(candidate, targetMarketId));
    if (row) return { found: true, attempt: attempt + 1, row };
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  return { found: false, attempt: attempts, row: null };
}

/** loadMarkets is intentionally a negative test after settlement, not identity discovery. */
export async function checkNormalMarketPresence(exchange, targetMarketId, timeoutMs = 8_000) {
  let timer;
  try {
    const loaded = await Promise.race([
      exchange.loadMarkets(true),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("loadMarkets timeout")), timeoutMs); }),
    ]);
    const found = Object.values(loaded).some((market) => String(market?.info?.marketId ?? "").toLowerCase() === targetMarketId.toLowerCase());
    return { found, status: "READ" };
  } catch (error) {
    return { found: null, status: "UNAVAILABLE", warning: error?.message || String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readSettlementSnapshot(exchange, selected, owner) {
  const [onchain, balances, orders] = await Promise.all([
    exchange.client.getMarketOnchain(selected.marketId),
    readBalances(exchange, selected.onchain, owner),
    readVerifiedOrders(exchange, selected.onchain, owner, selected.marketId, selected.onchain.decimals),
  ]);
  const resolution = authoritativeResolution({
    onchain,
    indexerStatus: selected.row?.status,
    indexerWinningOutcome: selected.row?.winningOutcome,
  });
  return { onchain, balances, orders, resolution };
}

/** Read the operator's outcome inventory across the current BTC slice. */
export async function scanActiveBtcInventory(exchange, owner, { limit = SETTLEMENT_FINALIZED_LIMIT } = {}) {
  const rows = await exchange.client.listBinaryMarkets({ asset: "BTC", status: "Trading", limit });
  const unique = [...new Map(rows.map((row) => [marketRowId(row), row]).filter(([id]) => id)).values()];
  const entries = [];
  const errors = [];
  for (const row of unique) {
    try {
      const onchain = await exchange.client.getMarketOnchain(row.marketId);
      const balances = await readBalances(exchange, onchain, owner);
      const activeOrderIds = Number(onchain.status) === ONCHAIN_STATUS.Trading
        ? (await exchange.client.getOwnOpenOrdersOnchain(onchain.pool, owner)).map(String)
        : [];
      if (balances.yesRaw !== 0n || balances.noRaw !== 0n || activeOrderIds.length) {
        entries.push({ marketId: row.marketId, symbol: row.symbol ?? null, intervalSec: row.intervalSec ?? null, yesRaw: balances.yesRaw, noRaw: balances.noRaw, activeOrderIds, status: Number(onchain.status) });
      }
    } catch (error) {
      errors.push({ marketId: row.marketId, warning: error?.message || String(error) });
    }
  }
  return { scanned: unique.length, entries, errors };
}

/** Read-only finalized claim sweep. It never returns a signer or calls redeem. */
export async function scanFinalizedBtcClaimSweep(exchange, owner, { limit = SETTLEMENT_FINALIZED_LIMIT } = {}) {
  const rows = await exchange.client.listBinaryMarkets({ asset: "BTC", status: "Finalized", limit });
  const unique = [...new Map(rows.map((row) => [marketRowId(row), row]).filter(([id]) => id)).values()];
  const entries = [];
  const errors = [];
  for (const row of unique) {
    try {
      const onchain = await exchange.client.getMarketOnchain(row.marketId);
      const balances = await readBalances(exchange, onchain, owner);
      const entry = buildFinalizedClaimSweepEntry({ row, onchain, yesRaw: balances.yesRaw, noRaw: balances.noRaw });
      if (entry.claimableOutcomes?.length || entry.warnings?.length) entries.push({ ...entry, symbol: row.symbol ?? null, intervalSec: row.intervalSec ?? null });
    } catch (error) {
      errors.push({ marketId: row.marketId ?? null, warning: error?.message || String(error) });
    }
  }
  return { scanned: unique.length, entries, errors };
}

export function buildSettlementRedemptionPlan({ selected, snapshot, payoutNumerators, owned, alreadyRedeemed }) {
  const resolution = snapshot.resolution.resolution;
  if (!resolution) throw new SettlementLifecycleError("NOT_REDEEMABLE", `market ${selected.marketId} is ${snapshot.resolution.state}`);
  return buildRedemptionPlan({
    marketId: selected.marketId,
    resolution,
    winningOutcome: resolution === "RESOLVED" ? snapshot.onchain.winningOutcome : undefined,
    payoutNumerators,
    held: { yesRaw: snapshot.balances.yesRaw, noRaw: snapshot.balances.noRaw },
    owned,
    outcomeIds: { yes: selected.onchain.yesId, no: selected.onchain.noId },
    alreadyRedeemed,
  });
}

export function verifyMintReadback({ baseline, afterMint, mintAmountRaw }) {
  const result = reconcileMintBalances({ baseline, afterMint, mintAmountRaw });
  if (result.directionalDeltaRaw !== 0n) throw new SettlementLifecycleError("EXPOSURE_VERIFY", "complete-set mint produced directional exposure");
  return result;
}

export function buildFinalizedClaimSweepEntry({ row, onchain, yesRaw, noRaw }) {
  const state = classifyMarketState({
    status: onchain.status,
    isResolved: onchain.isResolved,
    isVoided: onchain.isVoided,
    finalized: onchain.finalized,
  });
  if (!state.resolution) {
    return { marketId: row.marketId, state: state.state, claimableOutcomes: [], amountsRaw: [], warnings: ["FINALIZED_WITHOUT_ONCHAIN_RESOLUTION"] };
  }
  return buildClaimSweepEntry({
    marketId: row.marketId,
    resolution: state.resolution,
    winningOutcome: state.resolution === "RESOLVED" ? onchain.winningOutcome : undefined,
    held: { yesRaw, noRaw },
  });
}
