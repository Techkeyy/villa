/**
 * Bounded Phase 6A autonomous session runner.
 *
 * The runner coordinates existing fair-value, governor, quote, execution,
 * inventory, settlement, and rollover adapters. It is intentionally bounded:
 * the wet command requires --confirm, uses one serialized writer queue, and
 * exits after the configured market/session limits.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ORDER_TYPE } from "@somnia-chain/markets-sdk";
import { evaluateRisk, DEFAULT_RISK_CONFIG } from "../src/risk-governor/index.mjs";
import { planQuotes } from "../src/quote-planner/index.mjs";
import { buyEscrowRaw, targetFromPlan } from "../src/execution/policy.mjs";
import {
  DEFAULT_ORCHESTRATOR_CONFIG,
  OrchestratorError,
  assertCommittedCollateralCap,
  assertExposureCap,
  assertProvisioningCap,
  assertRestingOrderCap,
  closeMarket,
  createOrchestratorState,
  deriveCycleActions,
  emitEvent,
  incrementReplacementBudget,
  incrementTransactionBudget,
  initializeMarket,
  journalFromState,
  pairedInventory,
  recordBurn,
  recordCycle,
  recordGas,
  recordMint,
  recordOrderOutcome,
  recordSettlementPosition,
  restoreOrchestratorState,
  sessionElapsed,
  setClean,
  setFailed,
  setSessionLimitReached,
  setWaitingForMarket,
  setWaitingForSuccessor,
  shouldStopQuoting,
  validateOrchestratorConfig,
} from "../src/orchestrator/index.mjs";
import {
  ORCHESTRATOR_POST_ONLY_ATTEMPTS,
  assembleOrchestratorPipeline,
  burnPaired,
  cancelOrder,
  createOrchestratorExchange,
  discoverConfiguredMarket,
  discoverConfiguredSuccessor,
  mintMinimum,
  ownerForExchange,
  placePostOnly,
  readAccount,
  readChainTime,
  readSettlementCheck,
  reconcileOrder,
  scanConfiguredActiveOrders,
  targetForPipeline,
  temporaryBurnAmount,
  traderFor,
  verificationQuantity,
} from "../src/orchestrator/live.mjs";
import { isExecutionEnabled } from "../src/operator/config.mjs";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const CONFIRM = args.has("--confirm") || process.env.VILLA_CONFIRM_BOUNDED === "1";
const JOURNAL_PATH = resolve(process.env.VILLA_JOURNAL_PATH || "runtime/state/villa-loop-v1.json");

const CONTROL = {
  stopRequested: false,
  stopReason: null,
  pauseRequested: false,
  pauseApplied: false,
};

function requestStop(reason = "OPERATOR_STOP") {
  CONTROL.stopRequested = true;
  CONTROL.stopReason = String(reason || "OPERATOR_STOP");
}

if (typeof process.on === "function") {
  process.on("message", (message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "pause") CONTROL.pauseRequested = true;
    if (message.type === "resume") CONTROL.pauseRequested = false;
    if (message.type === "stop") requestStop(message.reason);
  });
  process.on("SIGINT", () => requestStop("OPERATOR_STOP"));
  process.on("SIGTERM", () => requestStop("OPERATOR_STOP"));
}

function boundedOverride(name, fallback) {
  const value = [...args].find((item) => item.startsWith(`--${name}=`));
  if (!value) return fallback;
  const parsed = Number(value.slice(name.length + 3));
  if (!Number.isFinite(parsed) || parsed <= 0) throw new OrchestratorError("ARGUMENTS", `--${name} must be positive`);
  return parsed;
}

const CONFIG = validateOrchestratorConfig({
  ...DEFAULT_ORCHESTRATOR_CONFIG,
  maxSessionDurationSec: Math.min(DEFAULT_ORCHESTRATOR_CONFIG.maxSessionDurationSec, Math.floor(boundedOverride("max-session-sec", DEFAULT_ORCHESTRATOR_CONFIG.maxSessionDurationSec))),
  maxMarkets: Math.min(DEFAULT_ORCHESTRATOR_CONFIG.maxMarkets, Math.floor(boundedOverride("max-markets", DEFAULT_ORCHESTRATOR_CONFIG.maxMarkets))),
  maxRestingOrders: Math.min(DEFAULT_ORCHESTRATOR_CONFIG.maxRestingOrders, Math.floor(boundedOverride("max-orders", DEFAULT_ORCHESTRATOR_CONFIG.maxRestingOrders))),
  maxDirectionalExposureHuman: Math.min(DEFAULT_ORCHESTRATOR_CONFIG.maxDirectionalExposureHuman, boundedOverride("max-directional", DEFAULT_ORCHESTRATOR_CONFIG.maxDirectionalExposureHuman)),
  maxProvisionedCollateralHuman: Math.min(DEFAULT_ORCHESTRATOR_CONFIG.maxProvisionedCollateralHuman, boundedOverride("max-allocation", DEFAULT_ORCHESTRATOR_CONFIG.maxProvisionedCollateralHuman)),
  maxCommittedCollateralHuman: Math.min(DEFAULT_ORCHESTRATOR_CONFIG.maxCommittedCollateralHuman, boundedOverride("max-allocation", DEFAULT_ORCHESTRATOR_CONFIG.maxCommittedCollateralHuman)),
  maxTotalProvisionedCollateralHuman: Math.min(DEFAULT_ORCHESTRATOR_CONFIG.maxTotalProvisionedCollateralHuman, boundedOverride("max-allocation", DEFAULT_ORCHESTRATOR_CONFIG.maxTotalProvisionedCollateralHuman)),
});

function jsonSafe(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function assert(condition, code, message) {
  if (!condition) throw new OrchestratorError(code, message);
}

function shortEvent(event) {
  const facts = event.facts ?? {};
  const summary = { event: event.type, sequence: event.sequence, atChainSec: event.atChainSec };
  for (const key of ["marketId", "side", "action", "orderId", "reason", "state", "plan", "amountRaw", "classification", "status", "transactionCount", "reconciliationAuthority"]) {
    if (facts[key] !== undefined) summary[key] = facts[key];
  }
  if (event.type === "FAIR_VALUE_UPDATED" && facts.fairValue) summary.fairValue = {
    pUp: facts.fairValue.pUp,
    confidence: facts.fairValue.confidence,
    timeRemainingSec: facts.fairValue.timeRemainingSec,
  };
  if (event.type === "QUOTE_PLAN_UPDATED" && facts.plan) summary.plan = facts.plan;
  console.log(jsonSafe(summary));
}

async function persist(state) {
  await mkdir(dirname(JOURNAL_PATH), { recursive: true });
  await writeFile(JOURNAL_PATH, jsonSafe(journalFromState(state)) + "\n", "utf8");
}

async function loadJournal() {
  try { return JSON.parse(await readFile(JOURNAL_PATH, "utf8")); } catch { return null; }
}

async function main() {
  if (!DRY && !CONFIRM) throw new OrchestratorError("CONFIRM_REQUIRED", "wet bounded orchestration requires --confirm or VILLA_CONFIRM_BOUNDED=1");
  if (!DRY && !isExecutionEnabled(process.env)) throw new OrchestratorError("EXECUTION_DISABLED", "VILLA execution is disabled; set VILLA_EXECUTION_ENABLED=true only during an explicitly approved wet phase");
  if (DRY && CONFIRM) throw new OrchestratorError("ARGUMENTS", "use either --dry-run or --confirm");

  const exchange = createOrchestratorExchange({ dryRun: DRY });
  const owner = ownerForExchange(exchange, process.env, { dryRun: DRY });
  const queue = DRY ? null : (await import("../src/execution/write-queue.mjs")).createSerializedWriteQueue(async (_label, operation) => operation());
  let state;
  let printedEvents = 0;
  let current = null;
  let sessionInitialSttRaw = null;
  let sessionInitialCollateralRaw = null;
  let finalAccount = null;
  let lastSettlementCheck = null;
  let dryVirtualOrderNumber = 0;
  let successorFrom = null;

  const adopt = async (next) => {
    state = next;
    for (const event of state.events.slice(printedEvents)) shortEvent(event);
    printedEvents = state.events.length;
    await persist(state);
  };

  const emit = async (type, facts = {}, chainNowSec = null) => {
    await adopt(emitEvent(state, type, facts, chainNowSec));
  };

  const reserveTransaction = async () => {
    await adopt(incrementTransactionBudget(state));
  };

  const write = async (label, operation) => {
    await reserveTransaction();
    return queue.enqueue(label, operation);
  };

  const readFreshPipeline = async () => {
    assert(current?.selected, "MARKET_SCOPE_INVALID", "no current market is initialized");
    if (DRY) {
      const fresh = await assembleOrchestratorPipeline(exchange, current.selected, owner, { knownOrderIds: current.sessionOrderIds, knownOrders: current.sessionOrders });
      current.dryPipeline = refreshDryPipeline(fresh);
      return current.dryPipeline;
    }
    const pipeline = await assembleOrchestratorPipeline(exchange, current.selected, owner, { knownOrderIds: current.sessionOrderIds, knownOrders: current.sessionOrders });
    if (pipeline.context.marketId.toLowerCase() !== current.selected.marketId.toLowerCase()) throw new OrchestratorError("MARKET_SCOPE_MISMATCH", "fresh pipeline changed market identity");
    if (pipeline.snapshot.openOrdersStatus !== "VERIFIED") throw new OrchestratorError("OPEN_ORDER_STATE_INVALID", "current-session open orders are not verified");
    const known = new Set(current.orders.map((order) => String(order.orderId)));
    const unknown = pipeline.snapshot.openOrders.filter((order) => !known.has(String(order.id)));
    if (unknown.length) throw new OrchestratorError("UNMANAGED_ORDER", `current market has ${unknown.length} order(s) not owned by this session`);
    assertRestingOrderCap(current.orders, CONFIG);
    assertExposureCap({ yesRaw: pipeline.rawState.yesRaw, noRaw: pipeline.rawState.noRaw, decimals: pipeline.context.decimals, config: CONFIG });
    current.pipeline = pipeline;
    return pipeline;
  };

  const accountAt = async (pipeline) => readAccount(exchange, pipeline, owner);

  const recordInitialCapital = async (pipeline) => {
    if (sessionInitialSttRaw !== null) return;
    sessionInitialSttRaw = pipeline.rawState.sttRaw;
    sessionInitialCollateralRaw = pipeline.rawState.collateralRaw;
    state.accounting.initialSttRaw = sessionInitialSttRaw;
    state.accounting.initialCollateralRaw = sessionInitialCollateralRaw;
    await persist(state);
  };

  const reconcileTrackedOrders = async (pipeline) => {
    for (const expected of [...current.orders]) {
      let evidence = await reconcileOrder(exchange, owner, pipeline, expected, { attempts: CONFIG.maxReadRetries + 1 });
      if (evidence.classification === "RESTING" && evidence.onchain && evidence.onchain.quantityRemaining < BigInt(expected.quantityRaw)) {
        evidence = { ...evidence, classification: "PARTIALLY_FILLED", fillsRaw: BigInt(expected.quantityRaw) - evidence.onchain.quantityRemaining };
      }
      if (evidence.classification === "PARTIALLY_FILLED" && evidence.onchain && evidence.onchain.quantityRemaining > 0n) {
        await emit("ORDER_PARTIALLY_FILLED", { marketId: current.selected.marketId, orderId: expected.orderId, filledRaw: String(evidence.fillsRaw), remainingRaw: String(evidence.onchain.quantityRemaining) }, pipeline.chainTime.chainNowSec);
        const cancelled = await write(`cancel:partial:${expected.orderId}`, () => traderFor(exchange).cancelOrder({ pool: expected.pool, orderId: BigInt(expected.orderId) }));
        await emit("ORDER_CANCELLED", { marketId: current.selected.marketId, orderId: expected.orderId, reason: "PARTIAL_FILL_REMAINDER", txHash: String(cancelled.hash ?? "") }, pipeline.chainTime.chainNowSec);
        evidence = await reconcileOrder(exchange, owner, pipeline, expected, { cancelRequested: true, attempts: CONFIG.maxReadRetries + 1 });
      }
      if (evidence.classification === "FILLED" || evidence.classification === "PARTIALLY_FILLED") {
        await adopt(recordOrderOutcome(state, expected, evidence.classification, { filledRaw: String(evidence.fillsRaw), remainingRaw: String(evidence.onchain?.quantityRemaining ?? evidence.history?.remainingRaw ?? "0") }, pipeline.chainTime.chainNowSec));
        current.orders = current.orders.filter((order) => String(order.orderId) !== String(expected.orderId));
      } else if (evidence.classification === "CANCELLED") {
        await adopt(recordOrderOutcome(state, expected, "CANCELLED", { filledRaw: String(evidence.fillsRaw) }, pipeline.chainTime.chainNowSec));
        current.orders = current.orders.filter((order) => String(order.orderId) !== String(expected.orderId));
      }
    }
    return pipeline;
  };

  const cancelAll = async (pipeline, reason) => {
    if (DRY) {
      for (const expected of [...current.orders]) {
        await adopt(recordOrderOutcome(state, expected, "CANCELLED", { dryRun: true, reason }, pipeline.chainTime.chainNowSec));
      }
      current.orders = [];
      return;
    }
    for (const expected of [...current.orders]) {
      await reserveTransaction();
      const result = await cancelOrder(exchange, queue, pipeline, owner, expected);
      if (result.submitted) {
        await emit("ORDER_CANCELLED", { marketId: current.selected.marketId, orderId: expected.orderId, reason, txHash: String(result.receipt?.hash ?? "") }, pipeline.chainTime.chainNowSec);
      }
      const classification = result.evidence.classification === "PARTIALLY_FILLED" || result.evidence.classification === "FILLED" ? result.evidence.classification : "CANCELLED";
      await adopt(recordOrderOutcome(state, expected, classification, { filledRaw: String(result.evidence.fillsRaw), remainingRaw: String(result.evidence.onchain?.quantityRemaining ?? result.evidence.history?.remainingRaw ?? "0"), reason }, pipeline.chainTime.chainNowSec));
      current.orders = current.orders.filter((order) => String(order.orderId) !== String(expected.orderId));
    }
    assert(current.orders.length === 0, "CLEANUP_BLOCKED", "current-session order list was not emptied after cancellation");
  };

  const simulateMint = (pipeline, amountRaw) => {
    const simulated = structuredClone(pipeline);
    const units = Number(amountRaw) / 10 ** simulated.context.decimals;
    simulated.rawState = { ...simulated.rawState, collateralRaw: simulated.rawState.collateralRaw - amountRaw, yesRaw: simulated.rawState.yesRaw + amountRaw, noRaw: simulated.rawState.noRaw + amountRaw };
    simulated.snapshot = { ...simulated.snapshot, inventory: { ...simulated.snapshot.inventory, yes: simulated.snapshot.inventory.yes + units, no: simulated.snapshot.inventory.no + units }, capital: { ...simulated.snapshot.capital, collateralAvailable: simulated.snapshot.capital.collateralAvailable - units } };
    simulated.plannerInput = { ...simulated.plannerInput, inventory: { ...simulated.plannerInput.inventory, yesRaw: String(simulated.rawState.yesRaw), noRaw: String(simulated.rawState.noRaw), yesAvailableRaw: String(simulated.rawState.yesRaw) }, capital: { ...simulated.plannerInput.capital, collateralAvailableRaw: String(simulated.rawState.collateralRaw) } };
    simulated.decision = evaluateRisk(simulated.snapshot, DEFAULT_RISK_CONFIG);
    simulated.plan = planQuotes(simulated.plannerInput);
    return simulated;
  };

  const addVirtualOrders = (pipeline) => {
    let refreshed = pipeline;
    const virtualOrders = current.orders.map((order) => ({
      id: String(order.orderId),
      outcome: "YES",
      side: order.action === "SELL_YES" ? "SELL" : "BUY",
      remainingQty: Number(order.quantityRaw) / 10 ** refreshed.context.decimals,
      remainingQtyRaw: String(order.quantityRaw),
      priceYes: Number(order.priceRaw) / 10 ** refreshed.context.decimals,
    }));
    if (virtualOrders.length) {
      refreshed = {
        ...refreshed,
        snapshot: { ...refreshed.snapshot, openOrders: [...refreshed.snapshot.openOrders, ...virtualOrders], openOrdersStatus: "VERIFIED" },
        plannerInput: { ...refreshed.plannerInput, pendingOrders: virtualOrders },
      };
      refreshed.plan = planQuotes(refreshed.plannerInput);
    }
    return refreshed;
  };

  const refreshDryPipeline = (pipeline) => addVirtualOrders(current.mintedRaw > 0n ? simulateMint(pipeline, current.mintedRaw) : pipeline);

  const provisionMinimum = async (pipeline) => {
    const amountRaw = verificationQuantity(pipeline);
    const perMarketRaw = current.mintedRaw;
    const totalRaw = Object.values(state.temporaryMintByMarket).reduce((sum, item) => sum + BigInt(item), 0n);
    assertProvisioningCap({ amountRaw, decimals: pipeline.context.decimals, perMarketProvisionedRaw: perMarketRaw, totalProvisionedRaw: totalRaw, config: CONFIG });
    assert(pipeline.rawState.collateralRaw >= amountRaw, "CAPITAL_CAP", "tUSDC is below the one-lot temporary mint");
    if (DRY) {
      current.mintedRaw += amountRaw;
      current.dryPipeline = addVirtualOrders(simulateMint(pipeline, amountRaw));
      await adopt(recordMint(state, amountRaw, { dryRun: true }, pipeline.chainTime.chainNowSec));
      await emit("INVENTORY_RECONCILED", { marketId: current.selected.marketId, stage: "after_hypothetical_mint", yesRaw: String(current.dryPipeline.rawState.yesRaw), noRaw: String(current.dryPipeline.rawState.noRaw) }, pipeline.chainTime.chainNowSec);
      return;
    }
    await reserveTransaction();
    const result = await mintMinimum(exchange, queue, pipeline, amountRaw);
    current.mintedRaw += amountRaw;
    await adopt(recordMint(state, amountRaw, { txHash: String(result.hash ?? "") }, pipeline.chainTime.chainNowSec));
    const refreshed = await readFreshPipeline();
    assert(refreshed.rawState.yesRaw >= pipeline.rawState.yesRaw + amountRaw && refreshed.rawState.noRaw >= pipeline.rawState.noRaw + amountRaw, "MINT_VERIFY", "complete-set mint did not produce the expected current-market balances");
    await emit("INVENTORY_RECONCILED", { marketId: current.selected.marketId, stage: "after_mint", yesRaw: String(refreshed.rawState.yesRaw), noRaw: String(refreshed.rawState.noRaw) }, refreshed.chainTime.chainNowSec);
  };

  const placeSide = async (side, pipeline) => {
    const fresh = DRY && current.dryPipeline ? current.dryPipeline : await readFreshPipeline();
    const capRaw = verificationQuantity(fresh);
    const target = targetForPipeline(fresh, side, capRaw);
    if (!target.enabled) {
      await emit("NO_QUOTE", { marketId: current.selected.marketId, side, reason: target.reason }, fresh.chainTime.chainNowSec);
      return false;
    }
    const buyEscrow = target.action === "BUY_YES" ? buyEscrowRaw({ priceRaw: target.plannerPriceRaw, quantityRaw: target.quantityRaw, oneRaw: 10n ** BigInt(fresh.context.decimals) }) : 0n;
    assertCommittedCollateralCap({ mintRaw: current.mintedRaw, buyEscrowRaw: buyEscrow, decimals: fresh.context.decimals, config: CONFIG });
    if (DRY) {
      dryVirtualOrderNumber += 1;
      const expected = { orderId: `dry-${dryVirtualOrderNumber}`, marketId: current.selected.marketId, pool: fresh.market.onchain.pool, action: target.action, side, priceRaw: target.plannerPriceRaw, quantityRaw: target.quantityRaw, createdChainSec: fresh.chainTime.chainNowSec };
      current.orders.push(expected);
      current.dryPipeline = addVirtualOrders(fresh);
      await emit("ORDER_SUBMITTED", { marketId: expected.marketId, side, action: expected.action, orderId: expected.orderId, priceRaw: String(expected.priceRaw), quantityRaw: String(expected.quantityRaw), postOnly: true, dryRun: true }, fresh.chainTime.chainNowSec);
      await emit("ORDER_RESTING", { marketId: expected.marketId, orderId: expected.orderId, dryRun: true }, fresh.chainTime.chainNowSec);
      return true;
    }
    for (let attempt = 1; attempt <= ORCHESTRATOR_POST_ONLY_ATTEMPTS; attempt += 1) {
      await reserveTransaction();
      const result = await placePostOnly(exchange, queue, fresh, owner, side, capRaw, CONFIG);
      if (result.skipped && result.retryable && attempt < ORCHESTRATOR_POST_ONLY_ATTEMPTS) {
        await emit("NO_QUOTE", { marketId: current.selected.marketId, side, reason: result.reason, retry: attempt }, fresh.chainTime.chainNowSec);
        pipeline = await readFreshPipeline();
        continue;
      }
      if (result.skipped) {
        await emit("NO_QUOTE", { marketId: current.selected.marketId, side, reason: result.reason }, fresh.chainTime.chainNowSec);
        return false;
      }
      const expected = result.expected;
      current.sessionOrders.push(expected);
      await emit("ORDER_SUBMITTED", { marketId: expected.marketId, side, action: expected.action, orderId: expected.orderId, priceRaw: String(expected.priceRaw), quantityRaw: String(expected.quantityRaw), expireTimestampNs: String(expected.expireTimestampNs), postOnly: true, txHash: String(result.placed?.hash ?? "") }, fresh.chainTime.chainNowSec);
      if (result.evidence.classification === "RESTING") {
        current.orders.push(expected);
        current.sessionOrderIds.push(expected.orderId);
        assertRestingOrderCap(current.orders, CONFIG);
        await emit("ORDER_RESTING", { marketId: expected.marketId, orderId: expected.orderId }, fresh.chainTime.chainNowSec);
      } else {
        await adopt(recordOrderOutcome(state, expected, result.evidence.classification, { filledRaw: String(result.evidence.fillsRaw), remainingRaw: String(result.evidence.onchain?.quantityRemaining ?? "0") }, fresh.chainTime.chainNowSec));
      }
      return true;
    }
    return false;
  };

  const cleanupCurrentMarket = async (pipeline, reason) => {
    await emit("MARKET_STOPPING", { marketId: current.selected.marketId, reason }, pipeline.chainTime.chainNowSec);
    if (current.orders.length) await cancelAll(pipeline, reason);
    const finalBeforeBurn = DRY && current.dryPipeline ? current.dryPipeline.rawState : await accountAt(await readFreshPipeline());
    const paired = temporaryBurnAmount({ baseline: current.baseline, current: finalBeforeBurn, mintedRaw: current.mintedRaw });
    if (paired > 0n) {
      if (DRY) {
        current.mintedRaw -= paired;
        await adopt(recordBurn(state, paired, { dryRun: true }, pipeline.chainTime.chainNowSec));
      } else {
        await reserveTransaction();
        const result = await burnPaired(exchange, queue, pipeline, paired);
        current.mintedRaw -= paired;
        await adopt(recordBurn(state, paired, { txHash: String(result.hash ?? "") }, pipeline.chainTime.chainNowSec));
      }
    }
    let postCleanup = DRY && current.dryPipeline ? current.dryPipeline.rawState : await accountAt(await readFreshPipeline());
    if (DRY && paired > 0n) {
      postCleanup = { ...postCleanup, collateralRaw: postCleanup.collateralRaw + paired, yesRaw: postCleanup.yesRaw - paired, noRaw: postCleanup.noRaw - paired };
      current.dryPipeline = { ...current.dryPipeline, rawState: postCleanup, snapshot: { ...current.dryPipeline.snapshot, inventory: { ...current.dryPipeline.snapshot.inventory, yes: current.dryPipeline.snapshot.inventory.yes - Number(paired) / 10 ** current.dryPipeline.context.decimals, no: current.dryPipeline.snapshot.inventory.no - Number(paired) / 10 ** current.dryPipeline.context.decimals } } };
    }
    current.finalAccount = postCleanup;
    const pairedAfter = pairedInventory({ yesRaw: postCleanup.yesRaw, noRaw: postCleanup.noRaw });
    if (pairedAfter.directionalResidualRaw !== 0n || pairedAfter.pairedRaw > 0n) {
      await adopt(recordSettlementPosition(state, { marketId: current.selected.marketId, status: "PENDING_SETTLEMENT", yesRaw: postCleanup.yesRaw, noRaw: postCleanup.noRaw, directionalResidualRaw: pairedAfter.directionalResidualRaw }, pipeline.chainTime.chainNowSec));
    }
    if (!DRY) {
      const active = await scanConfiguredActiveOrders(exchange, owner);
      assert(active.length === 0, "CLEANUP_VERIFY", "active configured-series orders remain after market cleanup");
    }
    await adopt(recordCycle(state, { chainNowSec: pipeline.chainTime.chainNowSec, pipeline: { ...pipeline, plan: { plan: "NO_QUOTE", bid: {}, ask: {} }, decision: pipeline.decision, inventory: postCleanup }, orders: [] }));
    return postCleanup;
  };

  const waitForTerminal = async () => {
    const first = await readChainTime(exchange, { retries: CONFIG.maxReadRetries });
    if (CONTROL.stopRequested) return { chain: first, onchain: await exchange.client.getMarketOnchain(current.selected.marketId), terminalObserved: false, sessionLimit: true };
    const remaining = Number(current?.selected?.expirySec ?? first.chainNowSec) - first.chainNowSec;
    const wallBoundMs = Math.min(CONFIG.maxSessionDurationSec * 1000, Math.max(120_000, (remaining + 30) * 1000));
    const deadline = Date.now() + wallBoundMs;
    while (Date.now() < deadline) {
      const chain = await readChainTime(exchange, { retries: CONFIG.maxReadRetries });
      const onchain = await exchange.client.getMarketOnchain(current.selected.marketId);
      if (Number(onchain.status) !== 1 || onchain.isResolved || onchain.isVoided) return { chain, onchain };
      if (CONTROL.stopRequested) return { chain, onchain, terminalObserved: false, sessionLimit: true };
      await sleep(CONFIG.pollIntervalSec * 1000);
    }
    throw new OrchestratorError("TERMINAL_TIMEOUT", "market did not leave Trading inside the bounded terminal observation");
  };

  const runSettlementCheck = async (chainNowSec) => {
    lastSettlementCheck = await readSettlementCheck(exchange, owner);
    const residual = lastSettlementCheck.knownResidual;
    if (residual?.knownResidual?.length) {
      await adopt(recordSettlementPosition(state, { marketId: residual.marketId, status: residual.knownResidual[0].classification, labels: residual.labels }, chainNowSec));
    }
  };

  const runMarket = async () => {
    while (true) {
      const chain = await readChainTime(exchange, { retries: CONFIG.maxReadRetries });
      const elapsed = sessionElapsed({ startedChainSec: state.startedChainSec, chainNowSec: chain.chainNowSec, config: CONFIG });
      const pipeline = await readFreshPipeline();
      if (CONTROL.stopRequested) {
        await cleanupCurrentMarket(pipeline, CONTROL.stopReason);
        return { chain, onchain: pipeline.market.onchain, terminalObserved: false, sessionLimit: true };
      }
      if (CONTROL.pauseRequested) {
        if (!CONTROL.pauseApplied) {
          if (current.orders.length) await cancelAll(pipeline, "OPERATOR_PAUSE");
          await emit("SESSION_PAUSED", { marketId: current.selected.marketId, reason: "OPERATOR_PAUSE", newQuotes: "DISABLED", restingOrders: 0 }, pipeline.chainTime.chainNowSec);
          CONTROL.pauseApplied = true;
        }
        await sleep(CONFIG.pollIntervalSec * 1000);
        continue;
      }
      if (CONTROL.pauseApplied) {
        await emit("SESSION_RESUMED", { marketId: current.selected.marketId, reason: "OPERATOR_RESUME" }, pipeline.chainTime.chainNowSec);
        CONTROL.pauseApplied = false;
      }
      if (!DRY) await reconcileTrackedOrders(pipeline);
      const before = state;
      await adopt(recordCycle(state, { chainNowSec: pipeline.chainTime.chainNowSec, pipeline, orders: current.orders }));
      const stop = shouldStopQuoting({ chainNowSec: pipeline.chainTime.chainNowSec, expirySec: pipeline.market.onchain.expiry, config: CONFIG });
      if (elapsed.exceeded || stop.stop || Number(pipeline.market.onchain.status) !== 1) {
        await cleanupCurrentMarket(pipeline, elapsed.exceeded ? "SESSION_DURATION_CAP" : stop.reason ?? "MARKET_NOT_TRADING");
        if (elapsed.exceeded && !stop.stop && Number(pipeline.market.onchain.status) === 1) return { chain, onchain: pipeline.market.onchain, terminalObserved: false, sessionLimit: true };
        return { ...(await waitForTerminal()), terminalObserved: true, sessionLimit: false };
      }
      if (pipeline.decision.state === "HALT") {
        await emit("SESSION_HALTED", { marketId: current.selected.marketId, recoverable: true, reason: pipeline.decision.primaryReasonCode }, pipeline.chainTime.chainNowSec);
        if (current.orders.length) await cancelAll(pipeline, "GOVERNOR_HALT");
        await sleep(CONFIG.pollIntervalSec * 1000);
        continue;
      }
      if (pipeline.plan.plan === "NO_QUOTE") await emit("NO_QUOTE", { marketId: current.selected.marketId, reasonCodes: pipeline.plan.reasonCodes }, pipeline.chainTime.chainNowSec);
      const actions = deriveCycleActions({
        plan: pipeline.plan,
        governor: pipeline.decision,
        inventory: { yesRaw: pipeline.rawState.yesRaw, noRaw: pipeline.rawState.noRaw },
        minQuantityRaw: pipeline.params.minQuantity,
        currentOrders: current.orders,
        previousPlan: before.previousPlan,
        previousGovernor: before.previousGovernor,
        previousInventory: before.previousInventory,
        chainNowSec: pipeline.chainTime.chainNowSec,
        expirySec: Number(pipeline.market.onchain.expiry),
        oldestOrderChainSec: current.orders.length ? Math.min(...current.orders.map((order) => Number(order.createdChainSec ?? pipeline.chainTime.chainNowSec))) : null,
        tickSizeRaw: pipeline.params.tickSize,
        quantityCapRaw: verificationQuantity(pipeline),
        config: CONFIG,
      });
      if (actions.actions.some((action) => action.type === "MINT_MINIMUM")) {
        if (current.mintedRaw === 0n && pipeline.rawState.yesRaw < BigInt(pipeline.params.minQuantity)) await provisionMinimum(pipeline);
        else await emit("INVENTORY_RECONCILED", { marketId: current.selected.marketId, stage: "mint_skipped_adequate_inventory", yesRaw: String(pipeline.rawState.yesRaw) }, pipeline.chainTime.chainNowSec);
        await sleep(250);
        continue;
      }
      const cancel = actions.actions.find((action) => action.type === "CANCEL_ALL");
      if (cancel && current.orders.length) {
        if (!["EXPIRY_HEADROOM", "GOVERNOR_HALT", "NO_QUOTE", "SESSION_DURATION_CAP"].includes(cancel.reason)) {
          if (state.caps.orderReplacements >= CONFIG.maxOrderReplacements) {
            await emit("SESSION_HALTED", { marketId: current.selected.marketId, recoverable: false, reason: "REQUOTE_BUDGET_EXHAUSTED" }, pipeline.chainTime.chainNowSec);
            await cleanupCurrentMarket(pipeline, "REQUOTE_BUDGET_EXHAUSTED");
            return { ...(await waitForTerminal()), terminalObserved: true, sessionLimit: false };
          }
          await adopt(incrementReplacementBudget(state));
        }
        await cancelAll(pipeline, cancel.reason);
      }
      for (const action of actions.actions.filter((item) => item.type === "PLACE")) {
        await placeSide(action.side, pipeline);
        if (current.orders.length >= CONFIG.maxRestingOrders) break;
      }
      await runSettlementCheck(pipeline.chainTime.chainNowSec);
      console.log(jsonSafe({ snapshot: { marketId: current.selected.marketId, timeRemainingSec: pipeline.decision.authoritativeTime.timeRemainingSec, pUp: pipeline.snapshot.fairValue.pUp, confidence: pipeline.snapshot.fairValue.confidence, governor: pipeline.decision.state, plan: pipeline.plan.plan, restingOrders: current.orders.length, inventory: { yesRaw: pipeline.rawState.yesRaw, noRaw: pipeline.rawState.noRaw }, capital: { collateralRaw: pipeline.rawState.collateralRaw }, lifecycle: state.state } }));
      await sleep(CONFIG.pollIntervalSec * 1000);
    }
  };

  try {
    const firstChain = await readChainTime(exchange, { retries: CONFIG.maxReadRetries });
    const existingJournal = args.has("--resume") ? await loadJournal() : null;
    state = existingJournal
      ? restoreOrchestratorState(existingJournal, { state: "WAITING_FOR_MARKET", activeOrderIds: [], startedChainSec: firstChain.chainNowSec })
      : createOrchestratorState({ sessionId: `villa-6a-${Date.now()}-${randomUUID().slice(0, 8)}`, config: CONFIG, startedChainSec: firstChain.chainNowSec });
    printedEvents = 0;
    await adopt(state);
    console.log(jsonSafe({ mode: DRY ? "DRY_RUN" : "WET", orchestratorVersion: CONFIG.version, series: CONFIG.series, caps: CONFIG, zeroTransactionMode: DRY }));
    if (existingJournal) await emit("SESSION_STARTED", { resumed: true, chainTruthOverridesJournal: true }, firstChain.chainNowSec);

    while (state.marketsInitialized < CONFIG.maxMarkets) {
      if (CONTROL.stopRequested) {
        await adopt(setSessionLimitReached(state, CONTROL.stopReason, { operatorRequested: true }, firstChain.chainNowSec));
        break;
      }
      const elapsed = sessionElapsed({ startedChainSec: state.startedChainSec, chainNowSec: (await readChainTime(exchange, { retries: CONFIG.maxReadRetries })).chainNowSec, config: CONFIG });
      if (elapsed.exceeded) { await adopt(setSessionLimitReached(state, "SESSION_DURATION_CAP", { elapsedSec: elapsed.elapsedSec }, firstChain.chainNowSec)); break; }
      const chain = await readChainTime(exchange, { retries: CONFIG.maxReadRetries });
      const discovery = successorFrom
        ? await discoverConfiguredSuccessor(exchange, successorFrom, chain.chainNowSec)
        : await discoverConfiguredMarket(exchange, owner, chain.chainNowSec, { minHeadroomSec: CONFIG.minDiscoveryHeadroomSec });
      await emit("MARKET_DISCOVERY_STARTED", { series: CONFIG.series, query: discovery.query, candidates: discovery.candidatesConsidered ?? discovery.rowsReturned ?? 0, rejected: discovery.rejected?.length ?? 0 }, chain.chainNowSec);
      const selected = discovery.selected;
      if (!selected) {
        if (state.currentMarket) await adopt(setWaitingForSuccessor(state, { reason: "NO_VALID_SUCCESSOR", configuredSeries: CONFIG.series }, chain.chainNowSec));
        else await adopt(setWaitingForMarket(state, { reason: "CONFIGURED_SERIES_UNAVAILABLE", configuredSeries: CONFIG.series }, chain.chainNowSec));
        await sleep(CONFIG.pollIntervalSec * 1000);
        continue;
      }
      const pipeline = await assembleOrchestratorPipeline(exchange, selected, owner);
      current = { selected, pipeline, baseline: pipeline.rawState, mintedRaw: 0n, orders: [], sessionOrders: [], sessionOrderIds: [], dryPipeline: null, finalAccount: null };
      successorFrom = null;
      await recordInitialCapital(pipeline);
      await adopt(initializeMarket(state, pipeline.marketContext, pipeline.chainTime.chainNowSec));
      if (pipeline.snapshot.openOrdersStatus !== "VERIFIED" || pipeline.snapshot.openOrders.length) throw new OrchestratorError("ACTIVE_ORDERS_EXIST", "new market did not start with a verified empty current-session order set");
      await runSettlementCheck(pipeline.chainTime.chainNowSec);
      const terminal = await runMarket();
      finalAccount = current.finalAccount ?? (DRY && current?.dryPipeline ? current.dryPipeline.rawState : await accountAt(current.pipeline));
      successorFrom = current.selected;
      await adopt(closeMarket(state, { chainNowSec: terminal.chain.chainNowSec, status: terminal.terminalObserved ? (terminal.onchain.isVoided ? "VOIDED" : "RESOLVED") : "SESSION_DURATION_LIMIT", inventory: { yesRaw: finalAccount.yesRaw, noRaw: finalAccount.noRaw }, openOrders: current.orders }));
      current = null;
      if (terminal.sessionLimit) { await adopt(setSessionLimitReached(state, "SESSION_DURATION_CAP", { terminalObserved: false }, terminal.chain.chainNowSec)); break; }
      if (state.marketsInitialized >= CONFIG.maxMarkets) { await adopt(setSessionLimitReached(state, "MARKET_COUNT_CAP", { maxMarkets: CONFIG.maxMarkets }, terminal.chain.chainNowSec)); break; }
      const after = sessionElapsed({ startedChainSec: state.startedChainSec, chainNowSec: terminal.chain.chainNowSec, config: CONFIG });
      if (after.exceeded) { await adopt(setSessionLimitReached(state, "SESSION_DURATION_CAP", { elapsedSec: after.elapsedSec }, terminal.chain.chainNowSec)); break; }
    }

    const finalChain = await readChainTime(exchange, { retries: CONFIG.maxReadRetries });
    const active = await scanConfiguredActiveOrders(exchange, owner);
    if (active.length) throw new OrchestratorError("FINAL_ACTIVE_ORDERS", "configured-series active orders remain at session end");
    if (state.accounting.initialSttRaw !== null) {
      if (finalAccount) {
        state.accounting.finalSttRaw = finalAccount.sttRaw;
        state.accounting.finalCollateralRaw = finalAccount.collateralRaw;
        const gasDelta = finalAccount.sttRaw < state.accounting.initialSttRaw ? state.accounting.initialSttRaw - finalAccount.sttRaw : 0n;
        state = recordGas(state, gasDelta, finalChain.chainNowSec);
      }
    }
    await adopt(setClean(state, { finalActiveOrders: 0, transactions: state.caps.transactionsUsed, settlementRecords: state.settlementRecords.length }, finalChain.chainNowSec));
    console.log(jsonSafe({
      RESULT: "PASS",
      mode: DRY ? "DRY_RUN" : "WET",
      orchestratorVersion: CONFIG.version,
      series: CONFIG.series,
      marketsInitialized: state.marketsInitialized,
      marketsVisited: state.marketsVisited,
      transactionCount: state.caps.transactionsUsed,
      orderReplacements: state.caps.orderReplacements,
      finalActiveOrders: 0,
      settlementRecords: state.settlementRecords,
      accounting: state.accounting,
      journal: JOURNAL_PATH,
      transactionsSent: DRY ? "NO" : state.caps.transactionsUsed === 0 ? "NO" : "YES (bounded and reconciled)",
    }));
  } catch (error) {
    if (current && !DRY) {
      try {
        if (current.orders.length) await cancelAll(current.pipeline, "SESSION_FAILURE");
        const account = await accountAt(await readFreshPipeline());
        const paired = temporaryBurnAmount({ baseline: current.baseline, current: account, mintedRaw: current.mintedRaw });
        if (paired > 0n) {
          await reserveTransaction();
          await burnPaired(exchange, queue, current.pipeline, paired);
          current.mintedRaw -= paired;
          await adopt(recordBurn(state, paired, { failureCleanup: true }, current.pipeline.chainTime.chainNowSec));
        }
        const active = await scanConfiguredActiveOrders(exchange, owner);
        if (active.length) throw new OrchestratorError("FAILURE_CLEANUP_BLOCKED", "active configured-series orders remain after failure cleanup");
      } catch (cleanupError) {
        try { await adopt(emitEvent(state, "INVENTORY_RECONCILED", { failureCleanupError: cleanupError?.message ?? String(cleanupError) }, state.startedChainSec)); } catch { /* preserve original failure */ }
      }
    }
    if (state) {
      try { await adopt(setFailed(state, error?.code ?? "SESSION_FAILED", { message: error?.message ?? String(error) }, state.startedChainSec)); } catch { /* preserve the original failure */ }
    }
    throw error;
  } finally {
    queue?.close();
    await exchange.close?.().catch(() => undefined);
  }
}

try {
  await main();
} catch (error) {
  console.error(`VILLA BOUNDED ${DRY ? "DRY-RUN " : ""}REFUSED: ${error?.code ? `${error.code}: ` : ""}${error?.message || error}`);
  process.exitCode = 1;
}
