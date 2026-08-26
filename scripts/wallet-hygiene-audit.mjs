/**
 * Phase 6A.2: final read-only wallet hygiene audit and one exact claim.
 *
 * The normal mode requires --confirm and may redeem only the known a3cf
 * winning YES balance. It never places orders, mints, starts the loop, or
 * selects a market. --dry-run performs the same reads and planning only.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAddress } from "viem";
import { DEFAULT_RISK_CONFIG } from "../src/risk-governor/config.mjs";
import {
  SettlementLifecycleError,
  assertSecretFree,
} from "../src/settlement/index.mjs";
import {
  buildFinalizedClaimSweepEntry,
  createSettlementExchange,
  readBalances,
  readChainTime,
  readOperatorApproval,
  readPayoutNumerators,
  readVerifiedOrders,
  scanFinalizedBtcClaimSweep,
} from "../src/settlement/live.mjs";
import {
  assertExactClaimableEntry,
  buildWalletInventoryAudit,
  reconcileWalletClaim,
  WALLET_AUDIT_VERSION,
  WALLET_INVENTORY_CLASSIFICATIONS,
} from "../src/settlement/wallet-audit.mjs";
import { createSerializedWriteQueue } from "../src/execution/write-queue.mjs";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const CONFIRM = args.has("--confirm");
const JOURNAL_PATH = process.env.VILLA_WALLET_HYGIENE_JOURNAL || "runtime/state/wallet-hygiene-v1.json";
const FINALIZED_LIMIT = 200;
const MIN_GAS_RESERVE_WEI = 100_000_000_000_000_000n; // DEFAULT_RISK_CONFIG.minGasReserve = 0.1 STT
const TARGET_MARKET_ID = "0x000000000000000000000000000000000000000000000000000000000000a3cf";
const TARGET_ORDER_ID = "147573952589676446899";

function jsonSafe(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function log(label, details = undefined) {
  console.log(`${label}${details === undefined ? "" : ` ${typeof details === "string" ? details : jsonSafe(details)}`}`);
}

function fail(code, message) {
  throw new SettlementLifecycleError(code, message);
}

function sameId(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function marketIdOf(value) {
  const id = value?.marketId ?? value?.id ?? value?.market?.id ?? value?.info?.marketId;
  if (typeof id !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(id)) return null;
  return id;
}

function txSummary(result) {
  if (!result?.hash || !result?.receipt || result.receipt.status !== "success") fail("TX_UNCONFIRMED", "a3cf redeem did not return a successful SDK receipt");
  const receipt = result.receipt;
  const gasWei = receipt.gasUsed !== undefined && receipt.effectiveGasPrice !== undefined
    ? receipt.gasUsed * receipt.effectiveGasPrice
    : 0n;
  return {
    hash: String(result.hash),
    status: receipt.status,
    blockNumber: receipt.blockNumber === undefined ? null : String(receipt.blockNumber),
    gasUsed: receipt.gasUsed === undefined ? null : String(receipt.gasUsed),
    effectiveGasPrice: receipt.effectiveGasPrice === undefined ? null : String(receipt.effectiveGasPrice),
    gasWei: String(gasWei),
  };
}

function ownerFromEnv(exchange) {
  const owner = process.env.OPERATOR_ADDRESS || exchange.walletAddress;
  if (!owner || !isAddress(owner)) fail("ENVIRONMENT", "OPERATOR_ADDRESS is required; preserve the existing .env");
  if (exchange.walletAddress && exchange.walletAddress.toLowerCase() !== owner.toLowerCase()) fail("ENVIRONMENT", "OPERATOR_ADDRESS does not match the existing signer wallet");
  return owner;
}

function fallbackMarketRow(position) {
  const market = position?.market ?? position?.marketInfo ?? position ?? {};
  return {
    id: market.id ?? market.marketId,
    marketId: market.marketId ?? market.id,
    asset: market.asset ?? null,
    intervalSec: market.intervalSec ?? null,
    interval: market.interval ?? null,
    expiry: market.expiry ?? null,
    status: market.status ?? null,
    winningOutcome: market.winningOutcome ?? null,
    finalized: market.finalized ?? null,
    symbol: market.symbol ?? null,
  };
}

async function readMarketObservation(exchange, owner, marketId, fallbackRow = null) {
  const indexed = await exchange.client.getBinaryMarket(marketId);
  const row = indexed ?? fallbackMarketRow(fallbackRow);
  const onchainRaw = await exchange.client.getMarketOnchain(marketId);
  const onchain = {
    ...onchainRaw,
    marketId,
    isResolved: Boolean(onchainRaw.isResolved),
    isVoided: Boolean(onchainRaw.isVoided),
    finalized: Boolean(onchainRaw.finalized),
  };
  const balances = await readBalances(exchange, onchain, owner);
  const orders = await readVerifiedOrders(exchange, onchain, owner, marketId, onchain.decimals);
  const payoutNumerators = Number(onchain.status) === 4 || Number(onchain.status) === 5
    ? await readPayoutNumerators(exchange, onchain)
    : null;
  return {
    marketId,
    row,
    indexerFound: Boolean(indexed),
    onchain,
    balances,
    orders,
    payoutNumerators,
  };
}

function uniqueMarketRows(portfolio) {
  const rows = new Map();
  for (const position of portfolio.positions ?? []) {
    const id = marketIdOf(position);
    if (id) rows.set(id.toLowerCase(), { id, row: position.market });
  }
  for (const order of portfolio.openOrders ?? []) {
    const id = marketIdOf(order);
    if (id && !rows.has(id.toLowerCase())) rows.set(id.toLowerCase(), { id, row: order.market ?? order.marketInfo });
  }
  return [...rows.values()];
}

async function collectWalletAudit(exchange, owner) {
  const portfolio = await exchange.client.getPortfolio(owner, { ordersLimit: 1000, tradesLimit: 1000 });
  const observations = [];
  const readErrors = [];
  for (const candidate of uniqueMarketRows(portfolio)) {
    try {
      observations.push(await readMarketObservation(exchange, owner, candidate.id, candidate.row));
    } catch (error) {
      readErrors.push({ marketId: candidate.id, warning: error?.message || String(error) });
    }
  }
  const audit = buildWalletInventoryAudit({ positions: portfolio.positions ?? [], observations });
  const indexedOpenOrders = await exchange.client.getOpenOrders(owner, { limit: 1000 });
  const indexedOrderIds = [...new Set(indexedOpenOrders.map((order) => String(order.orderId)))].sort();
  const portfolioOrderIds = [...new Set((portfolio.openOrders ?? []).map((order) => String(order.orderId)))].sort();
  const activeOrderState = {
    indexedCount: indexedOpenOrders.length,
    portfolioCount: portfolio.openOrders?.length ?? 0,
    indexedOrderIds,
    portfolioOrderIds,
    verifiedEmpty: indexedOpenOrders.length === 0 && (portfolio.openOrders?.length ?? 0) === 0,
  };
  return { portfolio, observations, audit, readErrors, activeOrderState };
}

async function readTargetOrigin(exchange, owner, observation) {
  const orders = await exchange.client.getOrders(owner, { pool: observation.onchain.pool, limit: 1000 });
  const fills = await exchange.client.getFills(observation.onchain.pool, { limit: 1000 });
  const targetOrder = orders.find((order) => String(order.orderId) === TARGET_ORDER_ID && sameId(order.market, TARGET_MARKET_ID)) ?? null;
  const targetFills = fills.filter((fill) => sameId(fill.market, TARGET_MARKET_ID) && (sameId(fill.maker, owner) || sameId(fill.taker, owner)));
  return {
    source: targetOrder || targetFills.length ? "indexed VILLA-wallet order/fill history" : "not found in indexed owner order/fill history",
    exactOrder: targetOrder,
    exactFills: targetFills,
    sessionAttribution: null,
    note: "No matching VILLA runtime journal or structured session event records this market; exact phase/session attribution is unavailable.",
  };
}

async function readClaimSweep(exchange, owner) {
  const sweep = await scanFinalizedBtcClaimSweep(exchange, owner, { limit: FINALIZED_LIMIT });
  return { scanned: sweep.scanned, entries: sweep.entries, errors: sweep.errors };
}

async function waitForCleanPortfolio(exchange, owner, attempts = 8) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await collectWalletAudit(exchange, owner);
    const target = last.audit.entries.find((entry) => sameId(entry.marketId, TARGET_MARKET_ID));
    if ((!target || target.balanceRaw === 0n) && last.audit.unknownCount === 0) return last;
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return last;
}

function cleanSummary(snapshot) {
  return {
    model: snapshot.audit.model,
    entries: snapshot.audit.entries,
    unknownCount: snapshot.audit.unknownCount,
    claimable: snapshot.audit.claimable,
    active: snapshot.audit.active,
    zeroValueResiduals: snapshot.audit.zeroValueResiduals,
    activeOrderState: snapshot.activeOrderState,
    readErrors: snapshot.readErrors,
  };
}

function addEvent(state, type, facts, atChainSec = null) {
  state.events.push({ sequence: state.events.length + 1, type, atChainSec, facts });
}

async function saveState(state) {
  assertSecretFree(state);
  await mkdir("runtime/state", { recursive: true });
  await writeFile(JOURNAL_PATH, jsonSafe(state) + "\n", "utf8");
}

async function readPreviousState() {
  if (!existsSync(JOURNAL_PATH)) return null;
  const parsed = JSON.parse(await readFile(JOURNAL_PATH, "utf8"));
  assertSecretFree(parsed);
  return parsed;
}

async function main() {
  if (DRY_RUN === CONFIRM) fail("USAGE", "choose exactly one of --dry-run or --confirm");
  const exchange = createSettlementExchange({ dryRun: DRY_RUN });
  try {
    const owner = ownerFromEnv(exchange);
    const previous = await readPreviousState();
    const chainTime = await readChainTime(exchange);
    const before = await collectWalletAudit(exchange, owner);
    if (before.readErrors.length) fail("WALLET_AUDIT_READ", `full wallet audit had ${before.readErrors.length} unreadable market(s)`);
    if (before.audit.unknownCount) fail("UNKNOWN_INVENTORY", `full wallet audit found ${before.audit.unknownCount} UNKNOWN outcome position(s)`);
    if (!before.activeOrderState.verifiedEmpty) fail("ACTIVE_ORDERS_EXIST", "wallet hygiene requires zero indexed and portfolio open orders");
    let targetObservation = before.observations.find((item) => sameId(item.marketId, TARGET_MARKET_ID));
    let targetEntry = before.audit.entries.find((entry) => sameId(entry.marketId, TARGET_MARKET_ID) && entry.outcomeIdx === 0);
    const priorRedemption = previous?.redemption?.reconciliation?.winningBalanceCleared === true;
    if (!targetObservation && priorRedemption) targetObservation = await readMarketObservation(exchange, owner, TARGET_MARKET_ID, null);
    if (!targetObservation || (!targetEntry && !priorRedemption)) fail("TARGET_NOT_FOUND", "a3cf is absent from the exact wallet audit");
    if (!targetEntry && priorRedemption) {
      if (targetObservation.balances.yesRaw !== 0n || targetObservation.balances.noRaw !== 0n) fail("TARGET_REDEEM_STATE_CONFLICT", "prior a3cf redemption is recorded but direct balance is nonzero");
      targetEntry = {
        marketId: TARGET_MARKET_ID,
        outcome: "YES",
        outcomeIdx: 0,
        tokenId: String(targetObservation.onchain.yesId),
        balanceRaw: 0n,
        classification: WALLET_INVENTORY_CLASSIFICATIONS.ALREADY_REDEEMED,
        action: "SKIP",
        expectedPayoutRaw: 0n,
        reason: "ALREADY_REDEEMED",
      };
    }
    const origin = await readTargetOrigin(exchange, owner, targetObservation);
    const targetSweep = await readClaimSweep(exchange, owner);
    if (targetSweep.errors.length) {
      log("CLAIM_SWEEP_ERRORS", targetSweep.errors);
      fail("CLAIM_SWEEP", `claim sweep had ${targetSweep.errors.length} unreadable row(s)`);
    }
    const sweepClaimIds = targetSweep.entries.filter((entry) => entry.claimableOutcomes?.length).map((entry) => String(entry.marketId).toLowerCase());
    if (sweepClaimIds.some((id) => id === TARGET_MARKET_ID.toLowerCase()) && targetEntry.classification !== WALLET_INVENTORY_CLASSIFICATIONS.CLAIMABLE_SETTLED_INVENTORY) fail("SWEEP_AUDIT_CONFLICT", "claim sweep and exact wallet audit disagree for a3cf");
    if (targetEntry.classification === WALLET_INVENTORY_CLASSIFICATIONS.ALREADY_REDEEMED) {
      log("IDEMPOTENT_NO_WRITE", { marketId: TARGET_MARKET_ID, noWrites: true, winningBalanceRaw: targetObservation.balances.yesRaw, unknownCount: before.audit.unknownCount, activeOrders: before.activeOrderState.indexedCount });
      return;
    }
    if (targetEntry.classification !== WALLET_INVENTORY_CLASSIFICATIONS.CLAIMABLE_SETTLED_INVENTORY || targetEntry.action !== "REDEEM") fail("TARGET_NOT_CLAIMABLE", "a3cf is not an exact winning claimable position");
    const operatorApproval = await readOperatorApproval(exchange, targetObservation.onchain, owner);
    const initialBalances = targetObservation.balances;
    if (initialBalances.sttRaw < MIN_GAS_RESERVE_WEI) fail("GAS_RESERVE_LOW", `STT balance is below ${DEFAULT_RISK_CONFIG.minGasReserve} STT reserve`);
    const plan = {
      marketId: targetEntry.marketId,
      outcome: targetEntry.outcome,
      outcomeIdx: targetEntry.outcomeIdx,
      amountRaw: targetEntry.balanceRaw,
      expectedPayoutRaw: targetEntry.expectedPayoutRaw,
      classification: targetEntry.classification,
      action: targetEntry.action,
      tokenId: targetEntry.tokenId,
    };
    assertExactClaimableEntry(targetEntry, { marketId: TARGET_MARKET_ID, outcomeIdx: 0, amountRaw: targetEntry.balanceRaw });
    const state = {
      schema: "villa-wallet-hygiene-v1",
      model: WALLET_AUDIT_VERSION,
      sessionId: `wallet-hygiene-${Date.now()}`,
      owner,
      target: { marketId: TARGET_MARKET_ID, tokenId: targetEntry.tokenId, outcome: "YES", amountRaw: targetEntry.balanceRaw, origin },
      preflight: { chainTime, operatorApproval, initialSttRaw: initialBalances.sttRaw, initialCollateralRaw: initialBalances.collateralRaw, activeOrderState: before.activeOrderState, audit: cleanSummary(before), claimSweep: targetSweep, plan },
      events: previous?.events ?? [],
      redemption: previous?.redemption ?? null,
      final: null,
    };
    addEvent(state, "WALLET_OUTCOME_INVENTORY_AUDITED", { audit: cleanSummary(before) }, chainTime.chainNowSec);
    addEvent(state, "A3CF_POSITION_IDENTIFIED", { marketId: TARGET_MARKET_ID, classification: targetEntry.classification, tokenId: targetEntry.tokenId, balanceRaw: targetEntry.balanceRaw, origin }, chainTime.chainNowSec);
    addEvent(state, "A3CF_REDEEM_PLANNED", { marketId: TARGET_MARKET_ID, outcome: "YES", amountRaw: targetEntry.balanceRaw, expectedPayoutRaw: targetEntry.expectedPayoutRaw }, chainTime.chainNowSec);
    log("WALLET_AUDIT", cleanSummary(before));
    log("A3CF_ORIGIN", origin);
    log("A3CF_PLAN", plan);
    if (DRY_RUN) {
      log("DRY_RUN", { noWrites: true, operatorApproval, currentSttRaw: initialBalances.sttRaw, currentCollateralRaw: initialBalances.collateralRaw });
      return;
    }
    if (!CONFIRM) fail("CONFIRM_REQUIRED", "wet wallet hygiene requires --confirm");
    if (!operatorApproval) fail("OPERATOR_APPROVAL", "ERC-6909 approval is not already present; refusing an unplanned setup write");
    await saveState(state);
    const queue = createSerializedWriteQueue((_label, operation) => operation());
    const freshObservation = await readMarketObservation(exchange, owner, TARGET_MARKET_ID, targetObservation.row);
    const freshSnapshot = buildWalletInventoryAudit({
      positions: [{ market: freshObservation.row, outcomeIndex: 0, tokenId: freshObservation.onchain.yesId, balance: freshObservation.balances.yesRaw.toString() }],
      observations: [freshObservation],
    });
    const freshEntry = freshSnapshot.entries.find((entry) => entry.outcomeIdx === 0);
    if (!freshEntry || freshEntry.classification !== WALLET_INVENTORY_CLASSIFICATIONS.CLAIMABLE_SETTLED_INVENTORY) fail("TARGET_PREFLIGHT_CHANGED", "a3cf was not still an exact claimable winning position immediately before redeem");
    assertExactClaimableEntry(freshEntry, { marketId: TARGET_MARKET_ID, outcomeIdx: 0, amountRaw: freshEntry.balanceRaw });
    if (freshObservation.orders.count !== 0) fail("ACTIVE_ORDERS_EXIST", "a3cf acquired an active order before redeem");
    addEvent(state, "A3CF_REDEEM_SUBMITTED", { marketId: TARGET_MARKET_ID, outcome: "YES", amountRaw: freshEntry.balanceRaw }, (await readChainTime(exchange)).chainNowSec);
    await saveState(state);
    const result = await queue.enqueue(`redeem:${TARGET_MARKET_ID}:YES`, () => exchange.trader.redeem({
      marketId: TARGET_MARKET_ID,
      market: freshObservation.onchain.marketAddress,
      outcomeToken: freshObservation.onchain.outcomeToken,
      outcomeIdx: 0,
      amount: freshEntry.balanceRaw,
      autoApprove: false,
    }));
    const transaction = txSummary(result);
    const afterRedeem = await readBalances(exchange, freshObservation.onchain, owner);
    const actualPayoutRaw = afterRedeem.collateralRaw - freshObservation.balances.collateralRaw;
    const reconciliation = reconcileWalletClaim({ entry: freshEntry, before: freshObservation.balances, after: afterRedeem, actualPayoutRaw, receiptGasWei: BigInt(transaction.gasWei) });
    state.redemption = { transaction, before: freshObservation.balances, after: afterRedeem, reconciliation };
    addEvent(state, "A3CF_REDEEM_CONFIRMED", { transaction, marketId: TARGET_MARKET_ID, outcome: "YES", amountRaw: freshEntry.balanceRaw }, null);
    addEvent(state, "A3CF_PAYOUT_RECONCILED", { reconciliation }, null);
    await saveState(state);
    const finalSnapshot = await waitForCleanPortfolio(exchange, owner);
    const finalSweep = await readClaimSweep(exchange, owner);
    if (finalSnapshot.readErrors.length) fail("WALLET_AUDIT_READ", `final wallet audit had ${finalSnapshot.readErrors.length} unreadable market(s)`);
    if (finalSnapshot.audit.unknownCount) fail("UNKNOWN_INVENTORY", `final wallet audit found ${finalSnapshot.audit.unknownCount} UNKNOWN outcome position(s)`);
    if (!finalSnapshot.activeOrderState.verifiedEmpty) fail("ACTIVE_ORDERS_EXIST", "final wallet audit found active orders");
    if (finalSnapshot.audit.claimable.length) fail("UNCLAIMED_WINNER", "final wallet audit still has a winning claimable position");
    if (finalSweep.errors.length) {
      log("FINAL_CLAIM_SWEEP_ERRORS", finalSweep.errors);
      fail("CLAIM_SWEEP", `final claim sweep had ${finalSweep.errors.length} unreadable row(s)`);
    }
    const finalChainTime = await readChainTime(exchange);
    const finalBalances = await readBalances(exchange, freshObservation.onchain, owner);
    state.final = { chainTime: finalChainTime, balances: finalBalances, audit: cleanSummary(finalSnapshot), claimSweep: finalSweep, activeOrderState: finalSnapshot.activeOrderState, unknownCount: finalSnapshot.audit.unknownCount, noNewOrdersOrMints: true };
    addEvent(state, "WALLET_HYGIENE_CLEAN", { unknownCount: 0, activeOrders: 0, claimableWinners: 0, residuals: finalSnapshot.audit.zeroValueResiduals }, finalChainTime.chainNowSec);
    await saveState(state);
    log("FINAL_CLAIM_SWEEP", finalSweep);
    log("RESULT", { ok: true, model: WALLET_AUDIT_VERSION, statePath: JOURNAL_PATH, owner, redemption: state.redemption, final: state.final });
  } finally {
    try { await exchange.destroy?.(); } catch { /* optional SDK close */ }
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(`WALLET HYGIENE ${DRY_RUN ? "DRY-RUN " : ""}REFUSED: ${error?.message || error}`);
  process.exitCode = 1;
}
