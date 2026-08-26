/**
 * Bounded VILLA settlement verifier.
 *
 * Dry mode performs live reads and prints a structured claim sweep.  Wet mode
 * requires --confirm and executes one complete-set mint followed by the
 * current market's terminal resolution and explicit SDK redemption.  It never
 * places/cancels orders, takes liquidity, resolves/voids a market, or rolls
 * into a successor market.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  ONCHAIN_STATUS,
  SETTLEMENT_EVENTS,
  SettlementLifecycleError,
  assertSecretFree,
  classifyMarketState,
  reconcilePayout,
} from "../src/settlement/index.mjs";
import {
  buildFinalizedClaimSweepEntry,
  buildSettlementRedemptionPlan as buildLiveRedemptionPlan,
  checkNormalMarketPresence,
  createSettlementExchange,
  discoverShortBtcMarket,
  readChainTime,
  readBalances,
  readOperatorApproval,
  readPayoutNumerators,
  readSettlementSnapshot,
  scanActiveBtcInventory,
  readVerifiedOrders,
  waitForHistoricalRediscovery,
  verifyMintReadback,
} from "../src/settlement/live.mjs";
import { fetchReference, fetchSpot } from "../src/fair-value/live.mjs";
import { createSerializedWriteQueue } from "../src/execution/write-queue.mjs";
import { minimumMintAmount, validateMintAmount } from "../src/inventory-lifecycle/index.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const CONFIRM = args.includes("--confirm");
const CLAIM_SWEEP_ONLY = args.includes("--claim-sweep");
const RESUME_ARG = args.find((arg) => arg.startsWith("--resume="));
const RESUME_PATH = RESUME_ARG ? RESUME_ARG.slice("--resume=".length) : null;
const MAX_WAIT_SEC = Number(process.env.SETTLEMENT_MAX_WAIT_SEC || 600);
const POLL_MS = Number(process.env.SETTLEMENT_POLL_MS || 5_000);
const MIN_HEADROOM_SEC = Number(process.env.SETTLEMENT_MIN_HEADROOM_SEC || 90);
const MIN_STT_WEI = 10n ** 15n;
const STATE_DIR = "runtime/state";

function jsonSafe(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function log(label, details = undefined) {
  console.log(`${label}${details === undefined ? "" : ` ${typeof details === "string" ? details : jsonSafe(details)}`}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireFinite(value, label) {
  if (!Number.isFinite(Number(value))) throw new SettlementLifecycleError("INVALID_DATA", `${label} is not finite`);
  return Number(value);
}

function parseResumeState(path) {
  return readFile(path, "utf8").then((text) => {
    const parsed = JSON.parse(text);
    assertSecretFree(parsed);
    const revive = (value, key = "") => {
      if (Array.isArray(value)) return value.map((item) => revive(item, key));
      if (!value || typeof value !== "object") {
        if ((key.endsWith("Raw") || key === "gasWei") && (typeof value === "string" || typeof value === "number")) return BigInt(String(value));
        return value;
      }
      return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, revive(child, childKey)]));
    };
    return revive(parsed);
  });
}

function stateFilename(sessionId) {
  return `${STATE_DIR}/settlement-session-${sessionId}.json`;
}

async function saveState(path, state) {
  assertSecretFree(state);
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(path, jsonSafe(state), "utf8");
}

function txSummary(result) {
  const receipt = result?.receipt;
  return {
    hash: result?.hash ? String(result.hash) : null,
    status: receipt?.status ?? null,
    blockNumber: receipt?.blockNumber === undefined ? null : String(receipt.blockNumber),
    gasUsed: receipt?.gasUsed === undefined ? null : String(receipt.gasUsed),
    effectiveGasPrice: receipt?.effectiveGasPrice === undefined ? null : String(receipt.effectiveGasPrice),
    gasWei: receipt?.gasUsed !== undefined && receipt?.effectiveGasPrice !== undefined
      ? String(receipt.gasUsed * receipt.effectiveGasPrice)
      : null,
  };
}

function assertReceipt(result, label) {
  if (!result?.hash || !result?.receipt) throw new SettlementLifecycleError("TX_UNCONFIRMED", `${label} did not return a confirmed SDK receipt`);
  if (result.receipt.status !== "success") throw new SettlementLifecycleError("TX_REVERTED", `${label} receipt status is ${result.receipt.status}`);
  return txSummary(result);
}

function addEvent(state, name, details = {}) {
  if (!SETTLEMENT_EVENTS.includes(name)) throw new SettlementLifecycleError("EVENT", `unsupported settlement event ${name}`);
  const event = {
    name,
    atLocalMs: Date.now(),
    chainNowSec: state.lastChainTime?.chainNowSec ?? null,
    blockNumber: state.lastChainTime?.blockNumber ?? null,
    details,
  };
  state.events.push(event);
  log(name, details);
}

function updateChainTime(state, chainTime) {
  state.lastChainTime = chainTime;
}

function ownerFor(exchange) {
  const owner = process.env.OPERATOR_ADDRESS || exchange.walletAddress;
  if (!owner) throw new SettlementLifecycleError("ENVIRONMENT", "OPERATOR_ADDRESS is required");
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new SettlementLifecycleError("ENVIRONMENT", "OPERATOR_ADDRESS is not a valid address");
  if (!DRY_RUN && exchange.walletAddress && exchange.walletAddress.toLowerCase() !== owner.toLowerCase()) {
    throw new SettlementLifecycleError("ENVIRONMENT", "OPERATOR_ADDRESS does not match the existing disposable signer");
  }
  return owner;
}

async function scanClaimSweep(exchange, owner) {
  const rows = await exchange.client.listBinaryMarkets({ status: "Finalized", asset: "BTC", limit: 200 });
  const entries = [];
  const errors = [];
  for (const row of rows) {
    if (!row?.marketId) continue;
    try {
      const onchain = await exchange.client.getMarketOnchain(row.marketId);
      const balances = await readBalances(exchange, onchain, owner);
      const entry = buildFinalizedClaimSweepEntry({ row, onchain, yesRaw: balances.yesRaw, noRaw: balances.noRaw });
      if (entry.claimableOutcomes.length || entry.warnings.length) entries.push({ ...entry, symbol: row.symbol ?? null, intervalSec: row.intervalSec ?? null });
    } catch (error) {
      errors.push({ marketId: row.marketId, warning: error?.message || String(error) });
    }
  }
  return { scanned: rows.length, entries, errors };
}

function printClaimSweep(sweep) {
  log("CLAIM_SWEEP", { scanned: sweep.scanned, claimable: sweep.entries, errors: sweep.errors.slice(0, 5) });
}

async function ensureNoActiveOrders(exchange, owner) {
  const indexed = await exchange.client.getOpenOrders(owner, { limit: 1000 });
  if (indexed.length) throw new SettlementLifecycleError("ACTIVE_ORDERS_EXIST", `refusing settlement while ${indexed.length} operator order row(s) are visible`);
}

async function chooseMarket(exchange, chainTime) {
  return discoverShortBtcMarket(exchange, {
    chainNowSec: chainTime.chainNowSec,
    minHeadroomSec: MIN_HEADROOM_SEC,
    requireShort: true,
  });
}

async function createFreshSession(exchange, owner, statePath) {
  const chainTime = await readChainTime(exchange);
  const selected = await chooseMarket(exchange, chainTime);
  const row = selected.row;
  const onchain = selected.onchain;
  const decimals = requireFinite(onchain.decimals ?? row.baseDecimals ?? row.quoteDecimals, "market decimals");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new SettlementLifecycleError("DECIMALS", `unsupported market decimals ${decimals}`);
  const spot = await fetchSpot(exchange, "BTC", { nowSec: chainTime.chainNowSec });
  const reference = await fetchReference(exchange, { marketId: selected.marketId, strike: row.strike, spot: spot.price });
  if (!(reference.price > 0) || !Number.isFinite(reference.price)) throw new SettlementLifecycleError("REFERENCE", "selected market has no usable opening reference");
  const params = await exchange.client.getBinaryBookParams(onchain.pool);
  const mintAmountRaw = minimumMintAmount({ lotSizeRaw: params.lotSize, minQuantityRaw: params.minQuantity });
  validateMintAmount({ amountRaw: mintAmountRaw, lotSizeRaw: params.lotSize, minQuantityRaw: params.minQuantity });
  const baseline = await readBalances(exchange, onchain, owner);
  const orders = await readVerifiedOrders(exchange, onchain, owner, selected.marketId, decimals);
  if (orders.count) throw new SettlementLifecycleError("ACTIVE_ORDERS_EXIST", "selected market has active orders at baseline");
  if (baseline.sttRaw < MIN_STT_WEI) throw new SettlementLifecycleError("FUNDING", `native balance is below ${MIN_STT_WEI} wei floor`);
  if (baseline.collateralRaw < mintAmountRaw) throw new SettlementLifecycleError("FUNDING", `collateral balance ${baseline.collateralRaw} is below mint amount ${mintAmountRaw}`);
  if (baseline.yesRaw !== 0n || baseline.noRaw !== 0n) throw new SettlementLifecycleError("INVENTORY_NOT_CLEAN", "selected market already has outcome inventory; refusing to mix it with the controlled mint");
  const operatorApprovalPreexisting = await readOperatorApproval(exchange, onchain, owner);
  const sessionId = `${Date.now()}-${selected.marketId.slice(-8)}`;
  const state = {
    schema: "villa-settlement-session-v1",
    sessionId,
    model: "villa-settlement-v1",
    owner,
    market: {
      marketId: selected.marketId,
      symbol: row.symbol ?? `BTC-${selected.intervalSec}s`,
      asset: row.asset ?? "BTC",
      intervalSec: selected.intervalSec,
      expirySec: selected.expirySec,
      pool: onchain.pool,
      marketAddress: onchain.marketAddress,
      outcomeToken: onchain.outcomeToken,
      yesId: onchain.yesId,
      noId: onchain.noId,
      collateral: onchain.collateral,
      decimals,
      reference: { price: reference.price, source: reference.kind, scaleExponent10: reference.scaleExponent10 },
      spot: { price: spot.price, timestampSec: spot.tSec, priceAgeSec: spot.priceAgeSec, sourceAgeSec: spot.sourceAgeSec },
    },
    mint: {
      amountRaw: mintAmountRaw,
      lotSizeRaw: params.lotSize,
      minQuantityRaw: params.minQuantity,
      tickSizeRaw: params.tickSize,
      baseline,
      afterMint: null,
      transaction: null,
    },
    operatorApprovalPreexisting,
    settlement: { state: "TRADING", resolution: null, winningOutcome: null, payoutNumerators: null, normalMarketPresence: null, historicalRediscoveryBefore: null, historicalRediscoveryAfter: null },
    redemptions: [],
    events: [],
    lastChainTime: chainTime,
    warnings: operatorApprovalPreexisting ? [] : ["SDK_REDEEM_MAY_SEND_ONE_TIME_ERC6909_OPERATOR_APPROVAL_BEFORE_REDEEM"],
  };
  addEvent(state, "SETTLEMENT_SESSION_STARTED", {
    marketId: selected.marketId,
    intervalSec: selected.intervalSec,
    expirySec: selected.expirySec,
    secondsLeft: selected.secondsLeft,
    referenceSource: reference.kind,
    operatorApprovalPreexisting,
  });
  await saveState(statePath, state);
  return { state, selected, params };
}

async function refreshSelected(exchange, state) {
  const chainTime = await readChainTime(exchange);
  updateChainTime(state, chainTime);
  const onchain = await exchange.client.getMarketOnchain(state.market.marketId);
  state.market.pool = onchain.pool;
  state.market.marketAddress = onchain.marketAddress;
  state.market.outcomeToken = onchain.outcomeToken;
  state.market.yesId = onchain.yesId;
  state.market.noId = onchain.noId;
  state.market.collateral = onchain.collateral;
  return { chainTime, onchain };
}

async function mintControlledSet(exchange, owner, statePath, state, selected) {
  const fresh = await refreshSelected(exchange, state);
  if (Number(fresh.onchain.status) !== ONCHAIN_STATUS.Trading || fresh.onchain.isResolved || fresh.onchain.isVoided) {
    throw new SettlementLifecycleError("MARKET_STATE", "selected market left Trading before the controlled mint");
  }
  if (Number(fresh.onchain.expiry) - fresh.chainTime.chainNowSec < MIN_HEADROOM_SEC) throw new SettlementLifecycleError("MARKET_STATE", "selected market lost required chain-time headroom before mint");
  const queue = createSerializedWriteQueue((_label, operation) => operation());
  const result = await queue.enqueue("mint-complete-set", () => exchange.trader.mintSet({ pool: fresh.onchain.pool, amount: state.mint.amountRaw }));
  const transaction = assertReceipt(result, "mintSet");
  state.mint.transaction = transaction;
  state.mint.afterMint = await readBalances(exchange, fresh.onchain, owner);
  const mintReadback = verifyMintReadback({ baseline: state.mint.baseline, afterMint: state.mint.afterMint, mintAmountRaw: state.mint.amountRaw });
  state.mint.readback = mintReadback;
  addEvent(state, "COMPLETE_SET_MINTED", { transaction, amountRaw: state.mint.amountRaw, readback: mintReadback });
  await saveState(statePath, state);
  return fresh.onchain;
}

async function watchForTerminal(exchange, statePath, state, maxWaitSec) {
  const startedMs = Date.now();
  let lastState = "TRADING";
  while ((Date.now() - startedMs) / 1000 < maxWaitSec) {
    const { chainTime, onchain } = await refreshSelected(exchange, state);
    const marketState = classifyMarketState({ status: Number(onchain.status), isResolved: onchain.isResolved, isVoided: onchain.isVoided, finalized: onchain.finalized });
    if (marketState.state !== lastState) {
      if (marketState.state === "LOCKED") addEvent(state, "MARKET_LOCKED", { status: Number(onchain.status) });
      if (marketState.state === "SETTLING") addEvent(state, "MARKET_SETTLING", { status: Number(onchain.status) });
      if (marketState.state === "RESOLVED") addEvent(state, "MARKET_RESOLVED", { winningOutcome: onchain.winningOutcome, status: Number(onchain.status) });
      if (marketState.state === "VOIDED") addEvent(state, "MARKET_VOIDED", { status: Number(onchain.status) });
      lastState = marketState.state;
      state.settlement.state = marketState.state;
      state.settlement.resolution = marketState.resolution;
      state.settlement.winningOutcome = marketState.resolution === "RESOLVED" ? onchain.winningOutcome : null;
      state.settlement.observedAt = chainTime;
      await saveState(statePath, state);
    }
    if (marketState.redeemable) return { chainTime, onchain, marketState };
    await sleep(POLL_MS);
  }
  state.settlement.state = "SETTLEMENT_PENDING";
  state.settlement.pendingAt = state.lastChainTime;
  state.warnings.push("SETTLEMENT_PENDING_NO_REDEEMABLE_STATE_WITHIN_BOUND");
  await saveState(statePath, state);
  return null;
}

async function redeemSettled(exchange, owner, statePath, state, selected) {
  const snapshot = await readSettlementSnapshot(exchange, selected, owner);
  state.settlement.state = snapshot.resolution.state;
  state.settlement.resolution = snapshot.resolution.resolution;
  state.settlement.winningOutcome = snapshot.resolution.resolution === "RESOLVED" ? snapshot.onchain.winningOutcome : null;
  if (snapshot.orders.count) throw new SettlementLifecycleError("ACTIVE_ORDERS_EXIST", "active orders exist before redemption");
  if (!state.mint.afterMint) throw new SettlementLifecycleError("SESSION_STATE", "restart state has no confirmed mint readback");
  const payoutNumerators = await readPayoutNumerators(exchange, snapshot.onchain);
  state.settlement.payoutNumerators = payoutNumerators;
  const priorRedemptions = [...state.redemptions];
  const alreadyRedeemed = {
    yes: priorRedemptions.some((record) => record.outcomeIdx === 0),
    no: priorRedemptions.some((record) => record.outcomeIdx === 1),
  };
  const plan = buildLiveRedemptionPlan({ selected: { ...selected, onchain: snapshot.onchain }, snapshot, payoutNumerators, owned: { yesRaw: state.mint.amountRaw, noRaw: state.mint.amountRaw }, alreadyRedeemed });
  state.settlement.plan = plan;
  addEvent(state, "REDEEM_PLANNED", { resolution: plan.resolution, winningOutcome: plan.winningOutcome, legs: plan.legs });
  await saveState(statePath, state);
  const queue = createSerializedWriteQueue((_label, operation) => operation());
  for (const leg of plan.legs.filter((candidate) => candidate.action === "REDEEM")) {
    const before = await readBalances(exchange, snapshot.onchain, owner);
    if (before[leg.outcomeIdx === 0 ? "yesRaw" : "noRaw"] < leg.amountRaw) throw new SettlementLifecycleError("BALANCE_RACE", `${leg.outcome} balance is below the planned redeem amount`);
    addEvent(state, "REDEEM_SUBMITTED", { outcome: leg.outcome, outcomeIdx: leg.outcomeIdx, amountRaw: leg.amountRaw });
    const result = await queue.enqueue(`redeem-${leg.outcome}`, () => exchange.trader.redeem({
      marketId: state.market.marketId,
      market: snapshot.onchain.marketAddress,
      outcomeToken: snapshot.onchain.outcomeToken,
      outcomeIdx: leg.outcomeIdx,
      amount: leg.amountRaw,
      autoApprove: true,
    }));
    const transaction = assertReceipt(result, `redeem ${leg.outcome}`);
    const after = await readBalances(exchange, snapshot.onchain, owner);
    const payoutRaw = after.collateralRaw - before.collateralRaw;
    if (payoutRaw < 0n) throw new SettlementLifecycleError("PAYOUT_VERIFY", `${leg.outcome} redemption reduced collateral`);
    const record = { outcome: leg.outcome, outcomeIdx: leg.outcomeIdx, amountRaw: leg.amountRaw, expectedPayoutRaw: leg.expectedPayoutRaw, actualPayoutRaw: payoutRaw, before, after, transaction };
    state.redemptions.push(record);
    addEvent(state, "REDEEM_CONFIRMED", record);
    await saveState(statePath, state);
  }
  const final = await readBalances(exchange, snapshot.onchain, owner);
  const actualPayoutRaw = state.redemptions.reduce((sum, record) => sum + record.actualPayoutRaw, 0n);
  const expectedPayoutRaw = priorRedemptions.reduce((sum, record) => sum + record.expectedPayoutRaw, 0n) + plan.totalExpectedPayoutRaw;
  const receiptGasWei = state.redemptions.reduce((sum, record) => sum + BigInt(record.transaction.gasWei ?? 0), 0n);
  const reconciliation = reconcilePayout({
    baselineCollateralRaw: state.mint.baseline.collateralRaw,
    afterMintCollateralRaw: state.mint.afterMint.collateralRaw,
    finalCollateralRaw: final.collateralRaw,
    mintAmountRaw: state.mint.amountRaw,
    expectedPayoutRaw,
    actualPayoutRaw,
    baselineSttRaw: state.mint.baseline.sttRaw,
    finalSttRaw: final.sttRaw,
    receiptGasWei,
  });
  if (!reconciliation.payoutExact) throw new SettlementLifecycleError("PAYOUT_VERIFY", `actual payout ${actualPayoutRaw} differs from expected ${expectedPayoutRaw}`);
  state.settlement.reconciliation = reconciliation;
  state.settlement.finalBalances = final;
  state.settlement.losingSideBehavior = plan.resolution === "RESOLVED" ? "PRESERVED_ZERO_VALUE_POSITION_NOT_CLAIMABLE_BY_CURRENT_SDK" : "BOTH_VOID_SIDES_REDEEMED";
  addEvent(state, "PAYOUT_RECONCILED", reconciliation);
  const afterOrders = await readVerifiedOrders(exchange, snapshot.onchain, owner, state.market.marketId, state.market.decimals);
  if (afterOrders.count) throw new SettlementLifecycleError("ACTIVE_ORDERS_EXIST", "active orders remain after redemption");
  const winnerIdx = plan.winningOutcome;
  const winnerBalance = winnerIdx === null ? 0n : final[winnerIdx === 0 ? "yesRaw" : "noRaw"];
  if (winnerBalance !== 0n) throw new SettlementLifecycleError("REDEEM_VERIFY", "claimable winning outcome balance remains after redemption");
  addEvent(state, "SETTLEMENT_SESSION_CLEAN", {
    activeOrders: afterOrders.count,
    claimableOutcomeBalancesCleared: true,
    residualLosingOutcomeRaw: plan.resolution === "RESOLVED" ? final[winnerIdx === 0 ? "noRaw" : "yesRaw"] : 0n,
    residualMeaning: state.settlement.losingSideBehavior,
  });
  await saveState(statePath, state);
  return { snapshot, plan, final, reconciliation };
}

async function main() {
  if (DRY_RUN === CONFIRM) throw new SettlementLifecycleError("USAGE", "choose exactly one of --dry-run or --confirm");
  if (RESUME_PATH && DRY_RUN === false && !CONFIRM) throw new SettlementLifecycleError("USAGE", "a wet resume requires --confirm");
  if (!DRY_RUN && !CONFIRM) throw new SettlementLifecycleError("USAGE", "no write path enabled; use --dry-run or --confirm");
  if (!Number.isFinite(MAX_WAIT_SEC) || MAX_WAIT_SEC <= 0 || !Number.isFinite(POLL_MS) || POLL_MS <= 0) throw new SettlementLifecycleError("USAGE", "SETTLEMENT_MAX_WAIT_SEC and SETTLEMENT_POLL_MS must be positive");

  const exchange = createSettlementExchange({ dryRun: DRY_RUN });
  const owner = ownerFor(exchange);
  const sweep = await scanClaimSweep(exchange, owner);
  printClaimSweep(sweep);
  if (CLAIM_SWEEP_ONLY) {
    log("CLAIM_SWEEP_RESULT", { ok: sweep.errors.length === 0, noWrites: true, entries: sweep.entries });
    return;
  }
  if (sweep.entries.some((entry) => entry.claimableOutcomes?.length)) {
    throw new SettlementLifecycleError("PREEXISTING_CLAIMS", "claim sweep found nonzero redeemable settled outcome inventory; refusing to mix a new lifecycle session");
  }
  const activeInventory = await scanActiveBtcInventory(exchange, owner);
  log("ACTIVE_BTC_INVENTORY", activeInventory);
  if (activeInventory.errors.length) throw new SettlementLifecycleError("ACTIVE_INVENTORY_AMBIGUOUS", `active BTC inventory scan had ${activeInventory.errors.length} unreadable market(s)`);
  if (activeInventory.entries.length) throw new SettlementLifecycleError("ACTIVE_STATE_NOT_CLEAN", "active BTC markets already contain operator outcome inventory or active orders; refusing to mix a new settlement proof");
  await ensureNoActiveOrders(exchange, owner);

  if (RESUME_PATH) {
    if (!existsSync(RESUME_PATH)) throw new SettlementLifecycleError("SESSION_STATE", `resume state does not exist: ${RESUME_PATH}`);
    const state = await parseResumeState(RESUME_PATH);
    if (!state.market?.marketId || !state.mint?.afterMint) throw new SettlementLifecycleError("SESSION_STATE", "resume state is missing the market identity or confirmed mint");
    const selected = { marketId: state.market.marketId, row: { marketId: state.market.marketId, symbol: state.market.symbol, asset: "BTC", intervalSec: state.market.intervalSec }, onchain: { pool: state.market.pool, marketAddress: state.market.marketAddress, outcomeToken: state.market.outcomeToken, yesId: BigInt(state.market.yesId), noId: BigInt(state.market.noId), collateral: state.market.collateral, decimals: state.market.decimals }, intervalSec: state.market.intervalSec, expirySec: state.market.expirySec };
    const terminal = await watchForTerminal(exchange, RESUME_PATH, state, MAX_WAIT_SEC);
    if (!terminal) {
      log("SETTLEMENT_PENDING", { statePath: RESUME_PATH, preservedPair: true, noWorkaround: true });
      return;
    }
    await redeemSettled(exchange, owner, RESUME_PATH, state, selected);
    return;
  }

  const statePath = stateFilename(`${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  const session = await createFreshSession(exchange, owner, statePath);
  log("mode", DRY_RUN ? "dry-run (read-only; no transaction sent)" : "bounded settlement proof (mint + expiry watch + redeem; no orders)");
  log("session", { statePath, market: session.state.market, baseline: session.state.mint.baseline, mintAmountRaw: session.state.mint.amountRaw });
  if (DRY_RUN) {
    log("DRY_RUN_PLAN", { sequence: ["verify Trading", "mint complete set", "hold through expiry", "observe resolved/voided", "redeem explicit outcome index", "reconcile payout"], noWrites: true, modelInput: "not an order-book midpoint" });
    return;
  }

  await mintControlledSet(exchange, owner, statePath, session.state, session.selected);
  const terminal = await watchForTerminal(exchange, statePath, session.state, MAX_WAIT_SEC);
  if (!terminal) {
    log("SETTLEMENT_PENDING", { statePath, preservedPair: true, noWorkaround: true });
    return;
  }
  session.state.settlement.normalMarketPresence = await checkNormalMarketPresence(exchange, session.state.market.marketId);
  session.state.settlement.historicalRediscoveryBefore = await waitForHistoricalRediscovery(exchange, session.state.market.marketId, { attempts: 2, delayMs: 500 });
  await saveState(statePath, session.state);
  const selectedForRedeem = { ...session.selected, onchain: terminal.onchain };
  await redeemSettled(exchange, owner, statePath, session.state, selectedForRedeem);
  session.state.settlement.historicalRediscoveryAfter = await waitForHistoricalRediscovery(exchange, session.state.market.marketId, { attempts: 8, delayMs: 1_000 });
  if (!session.state.settlement.historicalRediscoveryAfter.found) throw new SettlementLifecycleError("FINALIZED_DISCOVERY", "settled market was not rediscovered through finalized history after redeem");
  await saveState(statePath, session.state);
  log("RESULT", { ok: true, statePath, marketId: session.state.market.marketId, resolution: session.state.settlement.resolution, reconciliation: session.state.settlement.reconciliation, historicalRediscovery: session.state.settlement.historicalRediscoveryAfter, transactions: [session.state.mint.transaction, ...session.state.redemptions.map((record) => record.transaction)] });
}

let exchange;
try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(`SETTLEMENT ${DRY_RUN ? "DRY-RUN " : ""}REFUSED: ${error?.message || error}`);
  process.exitCode = 1;
} finally {
  try { await exchange?.destroy?.(); } catch { /* SDK close is optional; process exit closes it. */ }
}
