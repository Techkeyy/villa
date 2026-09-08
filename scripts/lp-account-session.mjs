/**
 * Private, account-bound manual-UAT session worker.
 *
 * This process is started only by the owner-allowlisted UAT control plane.
 * It dynamically selects one live BTC binary market, runs the existing
 * account-bound preflight and typed writer, then monitors and safely cleans
 * up one bounded session. It never accepts transaction targets or calldata
 * from the API or browser.
 */

import { normalizeJsonBoundary, persistPrivateUatState, persistUatState } from "../src/operator/uat-state.mjs";
import { createPublicClient, http } from "viem";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { VILLA_ACCOUNT_CONFIG } from "../dashboard/account-config.mjs";
import { estimateFairValue } from "../src/fair-value/model.mjs";
import { fetchReference, fetchSpot, fetchVolFromPriceHistory } from "../src/fair-value/live.mjs";
import { evaluateRisk, DEFAULT_RISK_CONFIG } from "../src/risk-governor/index.mjs";
import { readChainTime, collectRiskSnapshot } from "../src/risk-governor/live.mjs";
import { decimalToRaw, planQuotes } from "../src/quote-planner/index.mjs";
import {
  createLpExecutionAdapter,
  createViemLpAccountReader,
  ERC20_BALANCE_ABI,
  VILLA_ACCOUNT_READ_ABI,
} from "../src/execution/lp-adapter.mjs";
import { createAccountBoundPrivateWriter } from "../src/execution/lp-private-writer.mjs";
import { createExecutionProvenance, initializeDurableJournal, persistExecutionProvenance, readExecutionProvenance } from "../src/execution/lp-execution-provenance.mjs";
import { createFileGlobalExecutionAdmission, LP_GLOBAL_ADMISSION_HEARTBEAT_MS } from "../src/execution/lp-global-admission.mjs";
import { evaluateWetExecutionPreflight } from "../src/execution/lp-preflight.mjs";
import { reconcileLpSession } from "../src/execution/lp-reconciliation.mjs";
import { attachLease, createFileAccountLeaseStore, createLpExecutionSession, transitionLpSession } from "../src/execution/lp-session.mjs";
import { createLeaseHeartbeat, LP_LEASE_DURATION_MS, LP_LEASE_HEARTBEAT_INTERVAL_MS } from "../src/execution/lp-lease-heartbeat.mjs";
import { assessProjectedQuote, buildPriceFreshnessTelemetry } from "../src/execution/lp-quote-gate.mjs";
import { decideRunningQuote } from "../src/execution/lp-running-quote.mjs";
import { readQuoteBook, planAvailableBook } from "../src/execution/lp-book-readiness.mjs";
import { readUntilAvailable } from "../src/execution/lp-transient-read.mjs";
import { DEFAULT_PHASE_3B1_CAPS, createLpTransactionPolicy, evaluateStrategyCapital } from "../src/execution/lp-transaction-policy.mjs";
import { loadPrivateSigner } from "../src/execution/lp-private-runtime.mjs";
import { assessSessionSettlement, classifySessionPnl } from "../src/settlement/session-lifecycle.mjs";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const SESSION_RE = /^uat-\d+-[0-9a-f]{8}$/;
const POLL_MS = 5_000;
const MIN_HEADROOM_SEC = 120;
const EXCHANGE_CLOSE_TIMEOUT_MS = 2_000;
// Manual-UAT safety boundary only. The persistent production orchestrator must
// roll markets without requiring an owner restart and does not inherit this cap.
const MAX_SESSION_SEC = 900;
const OPERATOR_ABI = Object.freeze([{ type: "function", name: "isOperator", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "bool" }] }]);
const ALLOWANCE_ABI = Object.freeze([{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] }]);
const OWN_ORDERS_ABI = Object.freeze([{ type: "function", name: "getOwnOpenOrders", stateMutability: "view", inputs: [], outputs: [{ type: "uint128[]" }] }]);
const SETTLEMENT_ABI = Object.freeze([
  { type: "function", name: "status", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "isResolved", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "isVoided", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "payoutNumerators", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] },
]);

const runtimeTelemetry = {
  stage: null,
  activity: [],
  lastEngineUpdateAt: null,
  txHashes: [],
};

function recordActivity(type, message, details = {}) {
  const atMs = Date.now();
  const entry = { atMs, type, message, ...details };
  runtimeTelemetry.activity = [...runtimeTelemetry.activity, entry].slice(-60);
  runtimeTelemetry.lastEngineUpdateAt = atMs;
  return entry;
}

function setRuntimeStage(code, label, state, session = null) {
  runtimeTelemetry.stage = { code, label, atMs: Date.now() };
  recordActivity("STAGE", label, { stage: code });
  send({ type: "state", state, session });
}

function rememberWrite(action, result) {
  const hash = result?.hash ?? result?.transactionHash ?? null;
  if (hash) {
    runtimeTelemetry.txHashes = [...runtimeTelemetry.txHashes, { action, hash: String(hash) }].slice(-60);
  }
  return result;
}

function send(message) {
  const now = Date.now();
  runtimeTelemetry.lastEngineUpdateAt ??= now;
  const enriched = {
    ...message,
    ...(runtimeTelemetry.stage ? { stage: runtimeTelemetry.stage } : {}),
    activity: runtimeTelemetry.activity,
    lastEngineUpdateAt: runtimeTelemetry.lastEngineUpdateAt,
  };
  persistPrivateUatState(process.env.VILLA_UAT_PRIVATE_STATE_FILE, enriched);
  persistUatState(process.env.VILLA_UAT_STATUS_FILE ?? process.env.VILLA_UAT_STATE_FILE, enriched);
  if (typeof process.send === "function") process.send(normalizeJsonBoundary(enriched));
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function address(value, label) {
  const text = String(value ?? "");
  if (!ADDRESS_RE.test(text)) fail("UAT_SCOPE_INVALID", `${label} is invalid`);
  return text.toLowerCase();
}

function bytes32(value, label) {
  const text = String(value ?? "");
  if (!BYTES32_RE.test(text)) fail("UAT_SCOPE_INVALID", `${label} is invalid`);
  return text.toLowerCase();
}

function same(left, right) { return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase(); }
function raw(value, label) {
  try { const result = typeof value === "bigint" ? value : BigInt(String(value)); if (result < 0n) throw new Error(); return result; } catch { fail("RAW_INVALID", `${label} is invalid`); }
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function closeExchangeBounded(exchange, timeoutMs = EXCHANGE_CLOSE_TIMEOUT_MS) {
  let timeout;
  try {
    await Promise.race([
      Promise.resolve().then(() => exchange.close()).catch(() => undefined),
      new Promise((resolve) => { timeout = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function configFromEnv(env) {
  if (env.VILLA_UAT_SESSION_EXECUTION !== "true") fail("UAT_EXECUTION_DISABLED", "the private UAT session flag is not enabled");
  if (env.VILLA_ACCOUNT_EXECUTION_ENABLED !== "true") fail("ACCOUNT_EXECUTION_DISABLED", "the private account session execution flag is disabled");
  if (String(env.VILLA_EXECUTION_MODE ?? "WET").toUpperCase() !== "WET") fail("MODE_INVALID", "the private UAT session requires WET mode");
  if (!SESSION_RE.test(String(env.VILLA_ENGINE_SESSION_ID ?? ""))) fail("SESSION_INVALID", "the private session id is invalid");
  const stateDir = String(env.VILLA_STATE_DIR || `/var/lib/villa-engine/uat-${env.VILLA_ENGINE_SESSION_ID}`);
  return Object.freeze({
    owner: address(env.VILLA_ENGINE_OWNER, "LP owner"),
    account: address(env.VILLA_ENGINE_ACCOUNT, "VillaAccount"),
    operator: address(env.VILLA_ENGINE_OPERATOR ?? env.OPERATOR_ADDRESS, "VILLA operator"),
    sessionId: String(env.VILLA_ENGINE_SESSION_ID ?? ""),
    stateDir,
    provenancePath: String(env.VILLA_EXECUTION_PROVENANCE_FILE ?? `${stateDir}/provenance.json`),
    globalAdmissionFile: String(env.VILLA_GLOBAL_EXECUTION_ADMISSION_FILE ?? "/var/lib/villa-engine/global-execution-admission.json"),
    globalAdmissionId: String(env.VILLA_EXECUTION_ADMISSION_ID ?? ""),
    requireGlobalAdmission: env.VILLA_REQUIRE_GLOBAL_ADMISSION === "true",
  });
}

function plannerInput({ snapshot, decision, market, accountState, params, decimals }) {
  const oneRaw = 10n ** BigInt(decimals);
  const bestBidRaw = market.book?.bids?.[0] ? decimalToRaw(String(market.book.bids[0][0]), decimals).toString() : null;
  const bestAskRaw = market.book?.asks?.[0] ? decimalToRaw(String(market.book.asks[0][0]), decimals).toString() : null;
  const baseQuantityRaw = params.minQuantity > params.lotSize * 5n ? params.minQuantity : params.lotSize * 5n;
  return {
    fairValue: snapshot.fairValue,
    governor: {
      state: decision.state,
      permissions: decision.permissions,
      sizeMultiplier: decision.sizeMultiplier,
      triggeredRules: decision.triggeredRules,
      warnings: decision.warnings,
      reduceOnlyPolicy: decision.reduceOnlyPolicy,
      directionalRiskCapacity: DEFAULT_RISK_CONFIG.directionalExposureHard,
      limits: { directionalExposureHard: DEFAULT_RISK_CONFIG.directionalExposureHard, grossExposureHard: DEFAULT_RISK_CONFIG.grossExposureHard },
    },
    inventory: {
      yesRaw: accountState.inventory.yesRaw.toString(),
      noRaw: accountState.inventory.noRaw.toString(),
      yesAvailableRaw: accountState.inventory.yesRaw.toString(),
    },
    pendingOrders: accountState.orders.orders,
    book: { bestBidRaw, bestAskRaw, empty: bestBidRaw === null && bestAskRaw === null },
    grid: { decimals, oneRaw: oneRaw.toString(), tickSizeRaw: params.tickSize.toString(), lotSizeRaw: params.lotSize.toString(), minQuantityRaw: params.minQuantity.toString() },
    capital: { collateralAvailableRaw: accountState.capital.directCollateralRaw.toString(), collateralReserveRaw: oneRaw.toString(), collateralReserve: DEFAULT_RISK_CONFIG.minCollateralReserve },
    market: { marketId: market.marketId, timeRemainingSec: decision.authoritativeTime.timeRemainingSec },
    quote: { baseQuantityRaw: baseQuantityRaw.toString() },
  };
}

function projectedPlannerInput({ snapshot, decision, market, accountState, params, decimals, mintAmountRaw }) {
  const one = 10n ** BigInt(decimals);
  const projected = {
    ...accountState,
    capital: { ...accountState.capital, directCollateralRaw: accountState.capital.directCollateralRaw - mintAmountRaw },
    inventory: { ...accountState.inventory, yesRaw: accountState.inventory.yesRaw + mintAmountRaw, noRaw: accountState.inventory.noRaw + mintAmountRaw },
    orders: { ...accountState.orders, orders: [] },
  };
  const projectedSnapshot = {
    ...snapshot,
    inventory: { yes: Number(projected.inventory.yesRaw) / Number(one), no: Number(projected.inventory.noRaw) / Number(one) },
    openOrdersStatus: "VERIFIED",
    openOrders: [],
    capital: { ...snapshot.capital, collateralAvailable: Number(projected.capital.directCollateralRaw) / Number(one), capitalAtRisk: 0, accountingStatus: "PARTIAL" },
  };
  const projectedDecision = evaluateRisk(projectedSnapshot, DEFAULT_RISK_CONFIG);
  return { projected, projectedSnapshot, projectedDecision, input: plannerInput({ snapshot: projectedSnapshot, decision: projectedDecision, market, accountState: projected, params, decimals }) };
}

function publicAccountSnapshot(accountState, marketId, intervalSec, lastAction, pnl = null, trackedInventory = null, startingValueRaw = null, settlement = null, telemetry = {}) {
  const yesRaw = accountState.inventory.yesRaw;
  const noRaw = accountState.inventory.noRaw;
  return {
    marketId,
    intervalSec,
    collateralRaw: accountState.capital.directCollateralRaw,
    deployedRaw: yesRaw < noRaw ? yesRaw : noRaw,
    openOrders: accountState.orders.orders.map((order) => ({ orderId: order.orderId, owner: order.owner, isBid: order.isBid, quantityRemainingRaw: order.quantityRemainingRaw, priceRaw: order.priceRaw })),
    fills: Array.isArray(accountState.fills) ? accountState.fills : null,
    yesRaw,
    noRaw,
    trackedYesRaw: trackedInventory?.yesRaw ?? null,
    trackedNoRaw: trackedInventory?.noRaw ?? null,
    startingValueRaw,
    pendingSettlement: settlement?.state === "STOPPED_SETTLEMENT_PENDING" ? { status: "PENDING_UNRESOLVED_MARKET" } : null,
    settlement,
    lastAction,
    pnl,
    pnlStatus: pnl ? (settlement?.state === "STOPPED_SETTLEMENT_PENDING" ? "PENDING" : "REALIZED") : "UNAVAILABLE",
    pnlReason: pnl ? null : "Realized P&L is only computable after the session reconciles.",
    market: telemetry.market ?? null,
    strategy: telemetry.strategy ?? null,
    riskGovernor: telemetry.riskGovernor ?? null,
    inventoryState: telemetry.inventoryState ?? null,
    capitalState: telemetry.capitalState ?? null,
    health: telemetry.health ?? null,
    stage: runtimeTelemetry.stage,
    activity: runtimeTelemetry.activity,
    lastEngineUpdateAt: runtimeTelemetry.lastEngineUpdateAt,
    advanced: {
      sessionId: telemetry.sessionId ?? null,
      currentMarketId: marketId,
      chainBlockNumber: telemetry.chainBlockNumber ?? null,
      transactionHashes: runtimeTelemetry.txHashes,
    },
  };
}

function waitingQuoteState(disposition) {
  if (disposition === "WAITING_FOR_FRESH_PRICE") {
    return {
      stageCode: "WAITING_FOR_FRESH_PRICE",
      label: "Waiting for fresh price",
      message: "Waiting for fresh price",
      snapshotAction: "waiting_for_fresh_price",
    };
  }
  return {
    stageCode: "WAITING_FOR_QUOTE",
    label: "Waiting for quote",
    message: "Waiting for a safe quote",
    snapshotAction: "waiting_for_quote",
  };
}

async function main() {
  const env = process.env;
  const config = configFromEnv(env);
  if (!config.sessionId) fail("SESSION_REQUIRED", "a private UAT session id is required");
  if (config.requireGlobalAdmission && !config.globalAdmissionId) fail("GLOBAL_ADMISSION_REQUIRED", "a durable global execution admission is required");
  const bootSession = { sessionId: config.sessionId, account: config.account, owner: config.owner, operator: config.operator };
  setRuntimeStage("VERIFYING_ACCOUNT", "Verifying account", "STARTING", bootSession);
  const signerInfo = loadPrivateSigner({ credentialsDirectory: env.CREDENTIALS_DIRECTORY, expectedOperator: config.operator });
  const publicClient = createPublicClient({ chain: somniaShannon, transport: http(env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl, { timeout: 15_000 }) });
  const exchange = new SomniaMarkets({ account: config.account, indexerUrl: env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql", chain: somniaShannon, wsRpcUrl: env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws", addresses: SOMNIA_TESTNET_ADDRESSES, priceFeed: SOMNIA_TESTNET_PRICE_FEED });
  const leaseStore = createFileAccountLeaseStore({ directory: env.VILLA_LEASE_DIR || config.stateDir, leaseDurationMs: 30_000 });
  const journalPath = env.VILLA_WRITER_JOURNAL || `${config.stateDir}/transactions.json`;
  const reader = createViemLpAccountReader({ publicClient, listOpenOrderIds: async ({ pool }) => publicClient.readContract({ address: pool, abi: OWN_ORDERS_ABI, functionName: "getOwnOpenOrders", account: config.account }) });
  const adapter = createLpExecutionAdapter({ account: config.account, owner: config.owner, operator: config.operator, reader, sessionId: config.sessionId });
  const stopSignal = { requested: false, reason: null, paused: false };
  const requestStop = (reason) => {
    if (!stopSignal.requested) { stopSignal.requested = true; stopSignal.reason = reason; }
  };
  const admissionStore = createFileGlobalExecutionAdmission({ filePath: config.globalAdmissionFile });
  let admissionClaim = null;
  let admissionHeartbeat = null;
  if (config.globalAdmissionId) {
    admissionClaim = admissionStore.adopt({ admissionId: config.globalAdmissionId, session: bootSession, role: "strategy" });
    admissionHeartbeat = setInterval(() => {
      try { admissionClaim = admissionStore.heartbeat({ admissionId: admissionClaim.admissionId, session: bootSession }); }
      catch (error) { requestStop("GLOBAL_ADMISSION_LOST"); recordActivity("ADMISSION", "Global execution admission lost", { reasonCode: error?.code ?? "GLOBAL_ADMISSION_LOST" }); }
    }, LP_GLOBAL_ADMISSION_HEARTBEAT_MS);
  }
  process.on("message", (message) => {
    if (message?.type === "stop") requestStop(String(message.reason || "OWNER_STOP"));
    if (message?.type === "pause") stopSignal.paused = true;
    if (message?.type === "resume") stopSignal.paused = false;
  });
  process.once("SIGTERM", () => requestStop("SERVICE_STOP"));
  process.once("SIGINT", () => requestStop("SERVICE_STOP"));
  let writer = null;
  let lease = null;
  let leaseHeartbeat = null;
  let leaseFailure = null;
  let session = null;
  let txIndex = 0;
  let initialCollateralRaw = null;
  let selected = null;
  let accountState = null;
  let trackedInventory = null;
  let startingValueRaw = null;
  let settlement = null;
  let latestChainTime = null;
  let latestDecision = null;
  let latestFairValue = null;
  let lastFreshPriceTimestampSec = null;
  let strategyTelemetry = null;
  let ordersPlaced = 0;

  const buildTelemetry = (processState = "RUNNING") => {
    const orders = accountState?.orders?.orders ?? [];
    const identity = accountState?.identity ?? {};
    const yesEscrowedRaw = orders.filter((order) => order.isBid === false).reduce((total, order) => total + raw(order.quantityRemainingRaw, "order quantity"), 0n);
    const chainNowSec = Number(latestChainTime?.chainNowSec ?? 0);
    const risk = latestDecision ? {
      state: latestDecision.state,
      triggeredRules: latestDecision.triggeredRules ?? [],
      warnings: latestDecision.warnings ?? [],
      reason: latestDecision.explanations?.[0]?.message ?? "No risk rule triggered.",
      currentAggregateExposureRaw: identity.aggregateExposure ?? null,
      maxAggregateExposureRaw: identity.maxAggregateExposure ?? null,
      currentMintExposureRaw: identity.mintExposure ?? null,
      maxMintExposureRaw: identity.maxMintExposure ?? identity.maxMintAmount ?? null,
    } : null;
    const leaseState = leaseHeartbeat?.getState?.() ?? null;
    return {
      market: selected ? {
        asset: selected.asset ?? "BTC",
        title: selected.title ?? null,
        intervalSec: selected.intervalSec,
        marketId: selected.marketId,
        timeRemainingSec: selected.expirySec - chainNowSec,
        status: selected.marketStatus ?? "Trading",
        expirySec: selected.expirySec,
      } : null,
      strategy: strategyTelemetry,
      riskGovernor: risk,
      inventoryState: accountState ? {
        freeYesRaw: accountState.inventory.yesRaw,
        escrowedYesRaw: yesEscrowedRaw,
        freeNoRaw: accountState.inventory.noRaw,
        escrowedNoRaw: 0n,
      } : null,
      capitalState: accountState ? {
        freeRaw: accountState.capital.directCollateralRaw,
        deployedRaw: accountState.inventory.yesRaw < accountState.inventory.noRaw ? accountState.inventory.yesRaw : accountState.inventory.noRaw,
        claimableRaw: accountState.capital.vaultRaw ?? 0n,
        pendingRaw: settlement?.state === "STOPPED_SETTLEMENT_PENDING" ? null : 0n,
      } : null,
      health: {
        processState,
        heartbeat: leaseState ? (leaseState.healthy ? "HEALTHY" : "LOST") : "NOT_STARTED",
        lease: leaseState ? (leaseState.healthy ? "HELD" : "LOST") : "NOT_STARTED",
        heartbeatAt: leaseState?.heartbeatAt ?? null,
        leaseExpiresAt: leaseState?.expiresAt ?? null,
        lastUpdateAt: runtimeTelemetry.lastEngineUpdateAt,
      },
      sessionId: session?.sessionId ?? config.sessionId,
      chainBlockNumber: latestChainTime?.blockNumber ?? null,
    };
  };

  const emitSnapshot = (lastAction, pnl = null, processState = "RUNNING") => {
    if (accountState && selected) {
      send({ type: "snapshot", snapshot: publicAccountSnapshot(accountState, selected.marketId, selected.intervalSec, lastAction, pnl, trackedInventory, startingValueRaw, settlement, buildTelemetry(processState)) });
    }
  };
  const readAccount = (marketId) => adapter.readAccountState({ marketId });
  const readLive = (options) => readUntilAvailable({
    read: () => collectRiskSnapshot(exchange, { ...options, deferSourceFreshnessToGovernor: true }),
    stopped: () => stopSignal.requested,
    onWait: (state, reasonCode) => {
      const waiting = waitingQuoteState(state);
      strategyTelemetry = { ...strategyTelemetry, status: state, reasonCode };
      setRuntimeStage(state, waiting.label, "RUNNING", session ?? bootSession);
      emitSnapshot(waiting.snapshotAction);
      if (session && Date.now() - session.createdAt >= MAX_SESSION_SEC * 1000) requestStop("SESSION_DURATION_CAP");
    },
    delay: () => sleep(POLL_MS),
  });
  const readProtocol = async (marketId, pool, identity) => {
    let marketPrepared = false;
    try {
      marketPrepared = Boolean(await publicClient.readContract({ address: config.account, abi: VILLA_ACCOUNT_READ_ABI, functionName: "preparedMarkets", args: [marketId] }));
    } catch {
      marketPrepared = Boolean(await publicClient.readContract({ address: config.account, abi: VILLA_ACCOUNT_READ_ABI, functionName: "approvedMarkets", args: [marketId] }));
    }
    const [moduleOperator, poolOperator, collateralAllowance] = await Promise.all([
      publicClient.readContract({ address: identity.outcomeToken, abi: OPERATOR_ABI, functionName: "isOperator", args: [config.account, identity.binaryModule] }),
      publicClient.readContract({ address: identity.outcomeToken, abi: OPERATOR_ABI, functionName: "isOperator", args: [config.account, pool] }),
      publicClient.readContract({ address: identity.collateralToken, abi: ALLOWANCE_ABI, functionName: "allowance", args: [config.account, pool] }),
    ]);
    return { marketApproved: marketPrepared, marketPrepared, moduleOperator: Boolean(moduleOperator), poolOperator: Boolean(poolOperator), collateralAllowance: raw(collateralAllowance, "collateral allowance") };
  };
  const readSettlement = async (marketAddress) => {
    const [status, isResolved, isVoided, payoutNumerators] = await Promise.all([
      publicClient.readContract({ address: marketAddress, abi: SETTLEMENT_ABI, functionName: "status" }),
      publicClient.readContract({ address: marketAddress, abi: SETTLEMENT_ABI, functionName: "isResolved" }),
      publicClient.readContract({ address: marketAddress, abi: SETTLEMENT_ABI, functionName: "isVoided" }),
      publicClient.readContract({ address: marketAddress, abi: SETTLEMENT_ABI, functionName: "payoutNumerators" }),
    ]);
    return { status: Number(status), isResolved: Boolean(isResolved), isVoided: Boolean(isVoided), payoutNumerators: payoutNumerators.map((item, index) => raw(item, "payoutNumerators[" + index + "]")) };
  };

  try {
    setRuntimeStage("DISCOVERING_MARKET", "Discovering market", "STARTING", bootSession);
    const chainTime = await readChainTime(exchange);
    latestChainTime = chainTime;
    const initialRead = await readLive({ owner: config.account, gasAddress: config.operator, minHeadroomSec: MIN_HEADROOM_SEC });
    if (initialRead.stopped) {
      // No session lease or transaction writer has been created at this point.
      // This says only that this attempt stopped, not that the whole account
      // has been reconciled or that historical balances are zero.
      const stoppedSession = { ...bootSession, state: "STOPPED", currentMarketId: null, leaseId: null };
      send({ type: "result", session: stoppedSession, result: { status: "STOPPED", reason: "STOPPED_BEFORE_EXECUTION", writes: [] } });
      setRuntimeStage("STOPPED", "Session stopped before execution", "STOPPED", stoppedSession);
      return;
    }
    const live = initialRead.value;
    latestFairValue = live.snapshot.fairValue ?? null;
    const marketInfo = live.context.market;
    const marketId = bytes32(live.context.marketId, "selected marketId");
    const intervalSec = Number(marketInfo.info?.intervalSec ?? marketInfo.intervalSec);
    if (!Number.isSafeInteger(intervalSec) || intervalSec < 1) fail("MARKET_INVALID", "selected BTC market interval is invalid");
    selected = {
      marketId,
      intervalSec,
      expirySec: Number(live.context.onchain.expiry),
      series: "BINARY:BTC:" + intervalSec,
      pool: live.context.onchain.pool,
      book: null,
      asset: marketInfo.info?.asset ?? "BTC",
      title: marketInfo.info?.title ?? marketInfo.info?.question ?? null,
      marketStatus: live.context.onchain.isResolved ? "Resolved" : live.context.onchain.isVoided ? "Voided" : Number(live.context.onchain.status) === 1 ? "Trading" : "Locked",
    };
    if (live.context.onchain.isResolved || live.context.onchain.isVoided || Number(live.context.onchain.status) !== 1) fail("MARKET_NOT_TRADING", "the selected BTC market is not Trading");
    const yesSymbol = marketInfo.outcomes?.find((outcome) => outcome.label === "YES")?.symbol;
    if (!yesSymbol) fail("BOOK_UNAVAILABLE", "the selected BTC market has no YES outcome");
    selected.book = await readQuoteBook(() => exchange.fetchOrderBook(yesSymbol, 5));
    const params = await exchange.client.getBinaryBookParams(selected.pool);
    const decimals = Number(marketInfo.info.baseDecimals ?? marketInfo.info.quoteDecimals);
    const identity = await adapter.readAccountIdentity({ account: config.account });
    if (identity.accountVersion !== 2 || identity.version !== 2) fail("ACCOUNT_VERSION_UNSUPPORTED", "V1 VillaAccounts cannot enter autonomous execution");
    if (!same(identity.owner, config.owner) || !same(identity.operator, config.operator)) fail("ACCOUNT_IDENTITY_MISMATCH", "the VillaAccount owner or operator does not match the UAT scope");
    if (!same(identity.collateralToken, VILLA_ACCOUNT_CONFIG.collateralToken) || !same(identity.outcomeToken, VILLA_ACCOUNT_CONFIG.outcomeToken) || !same(identity.binaryModule, VILLA_ACCOUNT_CONFIG.binaryModule) || !same(identity.binarySettlement, VILLA_ACCOUNT_CONFIG.binarySettlement)) fail("ACCOUNT_WIRING_MISMATCH", "the VillaAccount wiring does not match the trusted Shannon configuration");
    accountState = await readAccount(selected.marketId);
    if (accountState.orders.status !== "VERIFIED" || accountState.orders.orders.length !== 0) fail("OPEN_ORDER_STATE_UNKNOWN", "the account does not have a verified empty order state");
    if (accountState.inventory.yesRaw !== 0n || accountState.inventory.noRaw !== 0n) fail("INVENTORY_NOT_EMPTY", "the selected market already has inventory outside this session");
    initialCollateralRaw = accountState.capital.directCollateralRaw;
    startingValueRaw = initialCollateralRaw + (accountState.capital.vaultRaw ?? 0n);
    if (initialCollateralRaw <= 0n) fail("CAPITAL_INVALID", "the VillaAccount has zero collateral available");
    const capitalPolicy = evaluateStrategyCapital(initialCollateralRaw);
    if (!capitalPolicy.allowed) fail(capitalPolicy.code, capitalPolicy.message);
    const accountMarket = await adapter.readMarket({ marketId: selected.marketId, identity });
    if (!same(accountMarket.pool, selected.pool)) fail("MARKET_POOL_MISMATCH", "the account market pool does not match the live market");
    const protocol = await readProtocol(selected.marketId, selected.pool, identity);
    if (!identity.autonomousTradingEnabled) {
      if (!protocol.marketApproved) fail("MARKET_NOT_APPROVED", "the selected live market has not been approved by the owner");
      if (!protocol.moduleOperator || !protocol.poolOperator) fail("PROTOCOL_APPROVAL_MISSING", "the selected live market is not prepared by the owner");
    }
    if (protocol.collateralAllowance !== 0n) fail("COLLATERAL_ALLOWANCE_PRESENT", "the selected pool has a nonzero collateral allowance");

    setRuntimeStage("CHECKING_RISK", "Checking risk", "STARTING", bootSession);
    const initialDecision = evaluateRisk(live.snapshot, DEFAULT_RISK_CONFIG);
    latestDecision = initialDecision;
    const basePlanner = plannerInput({ snapshot: live.snapshot, decision: initialDecision, market: selected, accountState, params, decimals });
    const mintAmountRaw = raw(params.minQuantity, "minimum mint amount");
    if (mintAmountRaw > DEFAULT_PHASE_3B1_CAPS.MAX_MINT_AMOUNT || mintAmountRaw > identity.maxOrderCollateral || mintAmountRaw >= initialCollateralRaw) fail("MINT_CAP", "the live minimum mint is outside the bounded account policy");
    const projected = projectedPlannerInput({ snapshot: live.snapshot, decision: initialDecision, market: selected, accountState, params, decimals, mintAmountRaw });
    setRuntimeStage("BUILDING_QUOTE", "Building quote", "STARTING", bootSession);
    let quotePlan = planAvailableBook(projected.input, selected.book, planQuotes);
    let ask = quotePlan.ask;
    let quoteReadiness = assessProjectedQuote({ projectedDecision: projected.projectedDecision, quotePlan });
    const initialPriceFreshness = buildPriceFreshnessTelemetry({
      snapshot: live.snapshot,
      decision: projected.projectedDecision,
      lastFreshPriceTimestampSec,
      maxPriceAgeSec: DEFAULT_RISK_CONFIG.maxPriceAgeSec,
      maxSourceAgeSec: DEFAULT_RISK_CONFIG.maxSourceAgeSec,
    });
    lastFreshPriceTimestampSec = initialPriceFreshness.lastFreshPriceTimestampSec;
    strategyTelemetry = {
      fairValue: latestFairValue,
      bestBidRaw: projected.input.book.bestBidRaw,
      bestAskRaw: projected.input.book.bestAskRaw,
      side: "SELL_YES",
      priceRaw: ask?.targetPriceRaw ?? null,
      sizeRaw: ask?.targetQuantityRaw ?? null,
      plannedPriceRaw: ask?.targetPriceRaw ?? null,
      plannedQuantityRaw: ask?.targetQuantityRaw ?? null,
      projectedDecisionState: projected.projectedDecision.state ?? null,
      quotePlan: quotePlan.plan ?? null,
      askEnabled: ask?.enabled ?? null,
      askAction: ask?.action ?? null,
      reasonCode: quoteReadiness.reasonCode,
      priceFreshness: initialPriceFreshness,
      postOnly: true,
      status: quoteReadiness.disposition === "EXECUTE" ? "PLANNED" : quoteReadiness.disposition === "FAIL_CLOSED" ? "FAIL_CLOSED" : quoteReadiness.disposition,
    };
    if (quoteReadiness.disposition === "FAIL_CLOSED") fail(quoteReadiness.reasonCode, quoteReadiness.message);
    let quoteReady = quoteReadiness.disposition === "EXECUTE";
    if (quoteReady && (raw(ask.targetQuantityRaw, "quote quantity") > DEFAULT_PHASE_3B1_CAPS.MAX_ORDER_NOTIONAL || raw(ask.targetQuantityRaw, "quote quantity") > identity.maxOrderQuantity)) fail("ORDER_CAP", "the live quote exceeds the account or policy cap");

    const sessionBase = createLpExecutionSession({ sessionId: config.sessionId, account: config.account, owner: config.owner, operator: config.operator, chainId: 50312, marketSeries: selected.series, currentMarketId: selected.marketId, riskPolicyVersion: projected.projectedDecision.governorVersion, executionMode: "WET", createdAt: Date.now(), maxSessionDurationSec: MAX_SESSION_SEC });
    session = transitionLpSession(sessionBase, "PREFLIGHT");
    send({ type: "state", state: "STARTING", session });
    lease = leaseStore.acquire(session);
    session = attachLease(session, lease);

    const existingProvenance = readExecutionProvenance(config.provenancePath, { session });
    const provenance = existingProvenance ?? createExecutionProvenance({ session, marketIdentity: { marketId: selected.marketId, pool: selected.pool, series: selected.series }, executionAdmission: admissionClaim, lease, journalPath, executionStage: "PREFLIGHT" });
    persistExecutionProvenance({ provenancePath: config.provenancePath, provenance });
    initializeDurableJournal({ journalPath, session, provenancePath: config.provenancePath });
    send({ type: "state", state: "STARTING", session });
    leaseHeartbeat = createLeaseHeartbeat({
      leaseStore,
      session,
      lease,
      leaseDurationMs: LP_LEASE_DURATION_MS,
      intervalMs: LP_LEASE_HEARTBEAT_INTERVAL_MS,
      onFailure: (error) => {
        leaseFailure = error;
        requestStop("LEASE_HEARTBEAT_FAILED");
        send({ type: "error", code: "ACCOUNT_LEASE_LOST", message: `Lease heartbeat failed; new risk is disabled and scoped recovery is required. ${error.message}` });
      },
    });
    leaseHeartbeat.start();
    const accountForPreflight = { account: config.account, owner: config.owner, operator: config.operator, capital: accountState.capital, inventory: accountState.inventory, orders: accountState.orders };
    const admissionRisk = { ...projected.projectedDecision, waitState: quoteReadiness.disposition };
    const reconciliation = reconcileLpSession({ session, accountState: accountForPreflight, market: { marketId: selected.marketId, series: selected.series }, orders: accountState.orders, inventory: { ...accountState.inventory, status: "VERIFIED" }, transactions: [], risk: admissionRisk });
    const preflight = evaluateWetExecutionPreflight({
      nowMs: Date.now(), session, lease: leaseHeartbeat.authority, chain: { id: 50312 }, executionEnabled: true,
      account: { address: config.account, owner: config.owner, operator: config.operator, runtimeVerified: true }, owner: { address: config.owner, verified: true }, operator: { configuredAddress: config.operator, signerAddress: signerInfo.address }, capital: { collateralRaw: initialCollateralRaw },
      market: { marketId: selected.marketId, series: selected.series, status: 1, valid: true, current: true, currentMarketId: selected.marketId }, orders: accountState.orders, inventory: { ...accountState.inventory, status: "VERIFIED" }, reconciliation,
      permissions: {
        requiresMarketApproval: !identity.autonomousTradingEnabled,
        marketApproved: protocol.marketApproved,
        requiresProtocolApproval: !identity.autonomousTradingEnabled,
        protocolPrepared: protocol.moduleOperator && protocol.poolOperator,
      },
      riskLimits: { valid: true }, risk: admissionRisk, executionConfig: { mode: "WET", minimumCollateralRaw: 1n, sessionActive: false }, caps: DEFAULT_PHASE_3B1_CAPS,
    });
    if (!preflight.allowed || !reconciliation.safeToStart) fail("ACCOUNT_PREFLIGHT_BLOCKED", `the fresh account preflight did not pass: ${(preflight.reasons ?? []).join(",") || reconciliation.reasons.join(",")}`);
    const policy = createLpTransactionPolicy({ session, caps: DEFAULT_PHASE_3B1_CAPS });
    setRuntimeStage("STARTING_STRATEGY", "Starting strategy", "STARTING", session);
    const enqueue = async (plan, { openOrderCount = 0, pendingExposureRaw = 0n } = {}) => {
      leaseHeartbeat.renewNow();
      const prepared = policy.prepare({ ...plan, accountCapitalRaw: initialCollateralRaw, openOrderCount, pendingExposureRaw }, { txIndex, createdAt: Date.now() });
      const validation = policy.validate(prepared, { nowMs: Date.now() });
      if (!validation.allowed) fail(validation.code ?? "POLICY_DENIED", validation.reason ?? "the bounded policy refused the action");
      txIndex += 1;
      return writer.enqueue(prepared);
    };
    const walletClient = (await import("viem")).createWalletClient({ account: signerInfo.signer, chain: somniaShannon, transport: http(env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl, { timeout: 15_000 }) });
    session = transitionLpSession(session, "RUNNING");
    writer = createAccountBoundPrivateWriter({ session, lease: leaseHeartbeat.authority, policy, signer: signerInfo.signer, publicClient, walletClient, executionEnabled: true, readLatestNonce: () => publicClient.getTransactionCount({ address: signerInfo.address, blockTag: "latest" }), readPendingNonce: () => publicClient.getTransactionCount({ address: signerInfo.address, blockTag: "pending" }), readReceipt: (hash) => publicClient.getTransactionReceipt({ hash }), journalPath, provenancePath: config.provenancePath, requireProvenance: true, executionAdmission: { store: admissionStore, admissionId: admissionClaim?.admissionId, session: bootSession }, requireGlobalAdmission: config.requireGlobalAdmission });
    send({ type: "ready", session: { sessionId: session.sessionId, account: session.account, owner: session.owner, operator: session.operator, marketSeries: session.marketSeries, currentMarketId: session.currentMarketId } });
    setRuntimeStage("RUNNING", "Strategy running", "RUNNING", session);
    recordActivity("SESSION", "Session started", { sessionId: session.sessionId });
    send({ type: "state", state: "RUNNING", session });
    emitSnapshot("preflight_passed");

    const executeQuote = async (quoteAsk) => {
      if (stopSignal.requested || stopSignal.paused) return false;
      if (identity.autonomousTradingEnabled && (!protocol.marketPrepared || !protocol.moduleOperator || !protocol.poolOperator)) {
        const prepResult = await enqueue(adapter.prepareMarket({ marketId: selected.marketId }));
        rememberWrite("prepareMarket", prepResult);
        recordActivity("CHAIN_WRITE", "Market prepared", { txHash: prepResult?.hash ?? prepResult?.transactionHash ?? null, marketId: selected.marketId });
        emitSnapshot("market_prepared");
      } else {
        recordActivity("MARKET", "Market already prepared", { marketId: selected.marketId });
      }
      if (stopSignal.requested || stopSignal.paused) return false;
      const mintResult = await enqueue(adapter.mintCompleteSet({ marketId: selected.marketId, amountRaw: mintAmountRaw }));
      rememberWrite("mintCompleteSet", mintResult);
      recordActivity("CHAIN_WRITE", "Minted complete set", { txHash: mintResult?.hash ?? mintResult?.transactionHash ?? null, amountRaw: mintAmountRaw });
      send({ type: "state", state: "RUNNING", session });
      accountState = await readAccount(selected.marketId);
      if (accountState.inventory.yesRaw < mintAmountRaw || accountState.inventory.noRaw < mintAmountRaw) fail("MINT_RECONCILIATION_FAILED", "mint did not reconcile to the account");
      trackedInventory = { yesRaw: mintAmountRaw, noRaw: mintAmountRaw, marketId: selected.marketId, yesId: accountMarket.yesId, noId: accountMarket.noId };
      emitSnapshot("mint_confirmed");
      if (stopSignal.requested || stopSignal.paused) return false;
      const quantityRaw = raw(quoteAsk.targetQuantityRaw, "quote quantity");
      const priceRaw = raw(quoteAsk.targetPriceRaw, "quote price");
      const expiryNs = raw(Math.max(1, Math.floor(selected.expirySec - 2)), "order expiry") * 1_000_000_000n;
      const placeResult = await enqueue(adapter.placeOrder({ marketId: selected.marketId, action: "SELL_YES", priceRaw, quantityRaw, expireTimestampNs: expiryNs, orderType: 3, userData: 0n }), { openOrderCount: 0, pendingExposureRaw: quantityRaw });
      rememberWrite("placeOrder", placeResult);
      ordersPlaced += 1;
      recordActivity("CHAIN_WRITE", "Order placed", { txHash: placeResult?.hash ?? placeResult?.transactionHash ?? null, orderId: null, side: "SELL_YES" });
      strategyTelemetry = { ...strategyTelemetry, status: "POSTED" };
      accountState = await readAccount(selected.marketId);
      if (accountState.orders.status !== "VERIFIED" || accountState.orders.orders.length !== 1) fail("PLACE_RECONCILIATION_FAILED", "the bounded SELL_YES order did not reconcile");
      emitSnapshot("sell_yes_posted");
      return true;
    };

    if (quoteReady) {
      quoteReady = await executeQuote(ask);
    } else {
      const waiting = waitingQuoteState(quoteReadiness.disposition);
      setRuntimeStage(waiting.stageCode, waiting.label, "RUNNING", session);
      recordActivity("QUOTE", waiting.message, {
        projectedDecisionState: projected.projectedDecision.state ?? null,
        quotePlan: quotePlan.plan ?? null,
        askEnabled: ask?.enabled ?? null,
        askAction: ask?.action ?? null,
        reasonCode: quoteReadiness.reasonCode,
      });
      send({ type: "state", state: "RUNNING", session });
      emitSnapshot(waiting.snapshotAction);
    }

    const reevaluateWaitingQuote = async () => {
      if (quoteReady || stopSignal.requested || stopSignal.paused) return;
      const nextChain = await readChainTime(exchange);
      latestChainTime = nextChain;
      const nextRead = await readLive({
        owner: config.account,
        gasAddress: config.operator,
        deferSourceFreshnessToGovernor: true,
        market: { market: marketInfo, onchain: live.context.onchain },
      });
      if (nextRead.stopped || stopSignal.requested) return;
      const nextLive = nextRead.value;
      if (!same(nextLive.context.marketId, selected.marketId)) fail("MARKET_CHANGED", "the selected market changed while waiting for a quote");
      latestFairValue = nextLive.snapshot.fairValue ?? null;
      latestDecision = evaluateRisk(nextLive.snapshot, DEFAULT_RISK_CONFIG);
      accountState = await readAccount(selected.marketId);
      if (accountState.orders.status !== "VERIFIED" || accountState.orders.orders.length !== 0 || accountState.inventory.yesRaw !== 0n || accountState.inventory.noRaw !== 0n) fail("ACCOUNT_STATE_CHANGED", "the account changed while waiting for a quote");
      selected.book = await readQuoteBook(() => exchange.fetchOrderBook(yesSymbol, 5));
      const nextProjected = projectedPlannerInput({ snapshot: nextLive.snapshot, decision: latestDecision, market: selected, accountState, params, decimals, mintAmountRaw });
      quotePlan = planAvailableBook(nextProjected.input, selected.book, planQuotes);
      ask = quotePlan.ask;
      quoteReadiness = assessProjectedQuote({ projectedDecision: nextProjected.projectedDecision, quotePlan });
      const nextPriceFreshness = buildPriceFreshnessTelemetry({
        snapshot: nextLive.snapshot,
        decision: nextProjected.projectedDecision,
        lastFreshPriceTimestampSec,
        maxPriceAgeSec: DEFAULT_RISK_CONFIG.maxPriceAgeSec,
        maxSourceAgeSec: DEFAULT_RISK_CONFIG.maxSourceAgeSec,
      });
      lastFreshPriceTimestampSec = nextPriceFreshness.lastFreshPriceTimestampSec;
      strategyTelemetry = {
        ...strategyTelemetry,
        fairValue: latestFairValue,
        bestBidRaw: nextProjected.input.book.bestBidRaw,
        bestAskRaw: nextProjected.input.book.bestAskRaw,
        priceRaw: ask?.targetPriceRaw ?? null,
        sizeRaw: ask?.targetQuantityRaw ?? null,
        plannedPriceRaw: ask?.targetPriceRaw ?? null,
        plannedQuantityRaw: ask?.targetQuantityRaw ?? null,
        projectedDecisionState: nextProjected.projectedDecision.state ?? null,
        quotePlan: quotePlan.plan ?? null,
        askEnabled: ask?.enabled ?? null,
        askAction: ask?.action ?? null,
        reasonCode: quoteReadiness.reasonCode,
        priceFreshness: nextPriceFreshness,
        status: quoteReadiness.disposition === "EXECUTE" ? "PLANNED" : quoteReadiness.disposition === "FAIL_CLOSED" ? "FAIL_CLOSED" : quoteReadiness.disposition,
      };
      if (quoteReadiness.disposition === "FAIL_CLOSED") fail(quoteReadiness.reasonCode, quoteReadiness.message);
      if (quoteReadiness.disposition === "WAITING_FOR_QUOTE" || quoteReadiness.disposition === "WAITING_FOR_FRESH_PRICE") {
        const waiting = waitingQuoteState(quoteReadiness.disposition);
        setRuntimeStage(waiting.stageCode, waiting.label, "RUNNING", session);
        recordActivity("QUOTE", waiting.message, {
          projectedDecisionState: nextProjected.projectedDecision.state ?? null,
          quotePlan: quotePlan.plan ?? null,
          askEnabled: ask?.enabled ?? null,
          askAction: ask?.action ?? null,
          reasonCode: quoteReadiness.reasonCode,
        });
        emitSnapshot(waiting.snapshotAction);
        return;
      }
      if (raw(ask.targetQuantityRaw, "quote quantity") > DEFAULT_PHASE_3B1_CAPS.MAX_ORDER_NOTIONAL || raw(ask.targetQuantityRaw, "quote quantity") > identity.maxOrderQuantity) fail("ORDER_CAP", "the live quote exceeds the account or policy cap");
      setRuntimeStage("RUNNING", "Strategy running", "RUNNING", session);
      quoteReady = await executeQuote(ask);
    };

    const reevaluateRunningQuote = async () => {
      if (!quoteReady || stopSignal.requested || stopSignal.paused) return;
      const nextChain = await readChainTime(exchange);
      latestChainTime = nextChain;
      const nextRead = await readLive({
        owner: config.account,
        gasAddress: config.operator,
        deferSourceFreshnessToGovernor: true,
        market: { market: marketInfo, onchain: live.context.onchain },
      });
      if (nextRead.stopped || stopSignal.requested) return;
      const nextLive = nextRead.value;
      if (!same(nextLive.context.marketId, selected.marketId)) fail("MARKET_CHANGED", "the selected market changed while monitoring a quote");
      latestFairValue = nextLive.snapshot.fairValue ?? null;
      latestDecision = evaluateRisk(nextLive.snapshot, DEFAULT_RISK_CONFIG);
      accountState = await readAccount(selected.marketId);
      if (accountState.orders.status !== "VERIFIED" || accountState.orders.orders.length > 1) fail("ACCOUNT_STATE_CHANGED", "the account order state is not authoritatively bounded to this session");
      selected.book = await readQuoteBook(() => exchange.fetchOrderBook(yesSymbol, 5));
      const nextInput = plannerInput({ snapshot: nextLive.snapshot, decision: latestDecision, market: selected, accountState, params, decimals });
      quotePlan = planAvailableBook(nextInput, selected.book, planQuotes);
      ask = quotePlan.ask;
      quoteReadiness = assessProjectedQuote({ projectedDecision: latestDecision, quotePlan });
      const nextPriceFreshness = buildPriceFreshnessTelemetry({
        snapshot: nextLive.snapshot,
        decision: latestDecision,
        lastFreshPriceTimestampSec,
        maxPriceAgeSec: DEFAULT_RISK_CONFIG.maxPriceAgeSec,
        maxSourceAgeSec: DEFAULT_RISK_CONFIG.maxSourceAgeSec,
      });
      lastFreshPriceTimestampSec = nextPriceFreshness.lastFreshPriceTimestampSec;
      strategyTelemetry = {
        ...strategyTelemetry,
        fairValue: latestFairValue,
        bestBidRaw: nextInput.book.bestBidRaw,
        bestAskRaw: nextInput.book.bestAskRaw,
        priceRaw: ask?.targetPriceRaw ?? null,
        sizeRaw: ask?.targetQuantityRaw ?? null,
        plannedPriceRaw: ask?.targetPriceRaw ?? null,
        plannedQuantityRaw: ask?.targetQuantityRaw ?? null,
        projectedDecisionState: latestDecision.state ?? null,
        quotePlan: quotePlan.plan ?? null,
        askEnabled: ask?.enabled ?? null,
        askAction: ask?.action ?? null,
        reasonCode: quoteReadiness.reasonCode,
        priceFreshness: nextPriceFreshness,
        status: quoteReadiness.disposition,
      };
      const currentOrder = accountState.orders.orders[0] ?? null;
      const cycle = decideRunningQuote({ readiness: quoteReadiness, currentOrder, desiredAsk: ask });
      recordActivity("MONITORING", "Reevaluated market, risk, inventory, and quote", {
        projectedDecisionState: latestDecision.state ?? null,
        quotePlan: quotePlan.plan ?? null,
        askEnabled: ask?.enabled ?? null,
        askAction: ask?.action ?? null,
        reasonCode: cycle.reasonCode,
        decision: cycle.action,
      });
      if (cycle.action === "HALT" || cycle.action === "HALT_CANCEL") {
        requestStop(quoteReadiness.reasonCode || cycle.reasonCode);
        return;
      }
      if (cycle.action === "CANCEL" || cycle.action === "WAIT") {
        if (currentOrder) {
          const cancelResult = await enqueue(adapter.cancelOrder({ marketId: selected.marketId, orderId: currentOrder.orderId }), { openOrderCount: 1, pendingExposureRaw: currentOrder.quantityRemainingRaw });
          rememberWrite("cancelOrder", cancelResult);
          recordActivity("CHAIN_WRITE", "Protective quote cancellation", { txHash: cancelResult?.hash ?? cancelResult?.transactionHash ?? null, orderId: currentOrder.orderId, reasonCode: cycle.reasonCode });
          accountState = await readAccount(selected.marketId);
          if (accountState.orders.status !== "VERIFIED" || accountState.orders.orders.length !== 0) fail("CANCEL_RECONCILIATION_FAILED", "protective quote cancellation did not reconcile empty");
        }
        const waiting = waitingQuoteState(cycle.state);
        setRuntimeStage(waiting.stageCode, waiting.label, "RUNNING", session);
        emitSnapshot(waiting.snapshotAction);
        return;
      }
      if (cycle.action === "KEEP") {
        setRuntimeStage("RUNNING", "Strategy running", "RUNNING", session);
        emitSnapshot("quote_kept");
        return;
      }
      if (cycle.action === "REPLACE") {
        const cancelResult = await enqueue(adapter.cancelOrder({ marketId: selected.marketId, orderId: currentOrder.orderId }), { openOrderCount: 1, pendingExposureRaw: currentOrder.quantityRemainingRaw });
        rememberWrite("cancelOrder", cancelResult);
        recordActivity("CHAIN_WRITE", "Quote cancelled for reprice", { txHash: cancelResult?.hash ?? cancelResult?.transactionHash ?? null, orderId: currentOrder.orderId });
        accountState = await readAccount(selected.marketId);
        if (accountState.orders.status !== "VERIFIED" || accountState.orders.orders.length !== 0) fail("CANCEL_RECONCILIATION_FAILED", "quote reprice cancellation did not reconcile empty");
      }
      if (cycle.action === "PLACE" || cycle.action === "REPLACE") {
        if (stopSignal.requested || stopSignal.paused) return;
        if (!ask || ask.enabled !== true || ask.action !== "SELL_YES") fail("QUOTE_ACTION_MISMATCH", "the running quote action is not SELL_YES");
        if (raw(ask.targetQuantityRaw, "quote quantity") > DEFAULT_PHASE_3B1_CAPS.MAX_ORDER_NOTIONAL || raw(ask.targetQuantityRaw, "quote quantity") > identity.maxOrderQuantity) fail("ORDER_CAP", "the live quote exceeds the account or policy cap");
        const quantityRaw = raw(ask.targetQuantityRaw, "quote quantity");
        const priceRaw = raw(ask.targetPriceRaw, "quote price");
        const expiryNs = raw(Math.max(1, Math.floor(selected.expirySec - 2)), "order expiry") * 1_000_000_000n;
        const placeResult = await enqueue(adapter.placeOrder({ marketId: selected.marketId, action: "SELL_YES", priceRaw, quantityRaw, expireTimestampNs: expiryNs, orderType: 3, userData: 0n }), { openOrderCount: 0, pendingExposureRaw: quantityRaw });
        rememberWrite("placeOrder", placeResult);
        ordersPlaced += 1;
        recordActivity("CHAIN_WRITE", "Quote placed after reevaluation", { txHash: placeResult?.hash ?? placeResult?.transactionHash ?? null, side: "SELL_YES", reasonCode: cycle.reasonCode });
        accountState = await readAccount(selected.marketId);
        if (accountState.orders.status !== "VERIFIED" || accountState.orders.orders.length !== 1) fail("PLACE_RECONCILIATION_FAILED", "the reevaluated SELL_YES order did not reconcile");
        strategyTelemetry = { ...strategyTelemetry, status: "POSTED" };
        emitSnapshot(cycle.action === "REPLACE" ? "quote_replaced" : "quote_placed");
      }
    };


    const cleanup = async (reason) => {
      session = transitionLpSession(session, "STOPPING");
      setRuntimeStage("BLOCKING_NEW_RISK", "Blocking new risk", "STOPPING", session);
      accountState = await readAccount(selected.marketId);
      recordActivity("CLEANUP", "Cancelling open orders", { count: accountState.orders.orders.length });
      for (const order of accountState.orders.orders) {
        if (!same(order.owner, config.account) || !same(order.marketId, selected.marketId)) fail("ORDER_SCOPE_MISMATCH", "cleanup encountered an order outside the session scope");
        const cancelResult = await enqueue(adapter.cancelOrder({ marketId: selected.marketId, orderId: order.orderId }), { openOrderCount: 1, pendingExposureRaw: order.quantityRemainingRaw });
        rememberWrite("cancelOrder", cancelResult);
        recordActivity("CHAIN_WRITE", "Order cancelled", { txHash: cancelResult?.hash ?? cancelResult?.transactionHash ?? null, orderId: order.orderId });
      }
      accountState = await readAccount(selected.marketId);
      if (accountState.orders.orders.length !== 0) fail("CANCEL_RECONCILIATION_FAILED", "account orders did not reconcile empty");
      recordActivity("RECONCILIATION", "Orders reconciled empty", { liveOrders: 0 });
      const burnAmountRaw = accountState.inventory.yesRaw < accountState.inventory.noRaw ? accountState.inventory.yesRaw : accountState.inventory.noRaw;
      if (burnAmountRaw > 0n) {
        setRuntimeStage("BURNING_INVENTORY", "Burning paired inventory", "STOPPING", session);
        const burnResult = await enqueue(adapter.burnCompleteSet({ marketId: selected.marketId, amountRaw: burnAmountRaw }));
        rememberWrite("burnCompleteSet", burnResult);
        recordActivity("CHAIN_WRITE", "Paired inventory burned", { txHash: burnResult?.hash ?? burnResult?.transactionHash ?? null, amountRaw: burnAmountRaw });
      }
      accountState = await readAccount(selected.marketId);
      recordActivity("RECONCILIATION", "Inventory reconciled", { yesRaw: accountState.inventory.yesRaw, noRaw: accountState.inventory.noRaw });
      setRuntimeStage("CHECKING_SETTLEMENT", "Checking settlement", "STOPPING", session);
      const onchainSettlement = await readSettlement(accountMarket.market);
      settlement = assessSessionSettlement({ session, account: config.account, owner: config.owner, marketId: selected.marketId, onchain: onchainSettlement, held: trackedInventory, owned: accountState.inventory, orders: accountState.orders, payoutNumerators: onchainSettlement.payoutNumerators, outcomeIds: { yes: accountMarket.yesId, no: accountMarket.noId } });
      if (settlement.state === "SETTLEMENT_BLOCKED") fail(settlement.reason, "settlement is blocked until account orders and transactions are authoritative");
      const pendingValueRaw = settlement.state === "STOPPED_SETTLEMENT_PENDING" ? null : 0n;
      const finalValueRaw = accountState.capital.directCollateralRaw + (accountState.capital.vaultRaw ?? 0n);
      const pnl = classifySessionPnl({ startingValueRaw, endingValueRaw: finalValueRaw, pendingValueRaw });
      const pending = pendingValueRaw === null;
      emitSnapshot(reason, pnl, "STOPPING");
      setRuntimeStage("RELEASING_SESSION", "Releasing session lease", "STOPPING", session);
      session = transitionLpSession(session, settlement.state === "STOPPED_CLEAN" ? "STOPPED_CLEAN" : settlement.state, { atMs: Date.now() });
      leaseStore.release(session, { reconciled: true });
      leaseHeartbeat.authority.held = false;
      leaseHeartbeat.stop();
      if (admissionClaim) { admissionStore.release({ admissionId: admissionClaim.admissionId, session: bootSession }); admissionClaim = null; }
      runtimeTelemetry.stage = { code: "STOPPED", label: "Session stopped", atMs: Date.now() };
      recordActivity("SESSION", "Session stopped", { state: session.state, reason });
      send({ type: "result", session, result: { status: session.state, reason, pnl, startingValueRaw, finalValueRaw, pendingValueRaw, ordersPlaced, fills: pending ? "UNRESOLVED_OR_FILLED" : "NONE_CONFIRMED", marketId: selected.marketId, intervalSec: selected.intervalSec, pendingSettlement: pending, settlement } });
      send({ type: "state", state: session.state, session });
    };

    while (!stopSignal.requested) {
      const chain = await readChainTime(exchange);
      latestChainTime = chain;
      accountState = await readAccount(selected.marketId);
      if (quoteReady) await reevaluateRunningQuote();
      else await reevaluateWaitingQuote();
      const timeRemainingSec = selected.expirySec - chain.chainNowSec;
      if (!runtimeTelemetry.activity.some((item) => item.type === "MONITORING")) recordActivity("MONITORING", "Monitoring live order book and account state", { timeRemainingSec });
      emitSnapshot(stopSignal.paused ? "paused" : "monitoring");
      if (timeRemainingSec <= MIN_HEADROOM_SEC || Date.now() - Number(session.createdAt) >= MAX_SESSION_SEC * 1000) {
        stopSignal.requested = true;
        stopSignal.reason = timeRemainingSec <= MIN_HEADROOM_SEC ? "MARKET_HEADROOM" : "SESSION_DURATION_CAP";
      }
      if (stopSignal.requested) break;
      await sleep(POLL_MS);
    }
    if (leaseFailure) fail("ACCOUNT_LEASE_LOST", "lease renewal failed; the worker stopped all new writes and requires scoped recovery");
    await cleanup(stopSignal.reason || "OWNER_STOP");
  } catch (error) {
    const lostLease = leaseHeartbeat?.getState?.().healthy === false;
    send({ type: "error", code: lostLease ? "ACCOUNT_LEASE_LOST" : (error?.code ?? "UAT_SESSION_FAILED"), message: lostLease ? "Lease authority was lost; no further writes are allowed and owner/account-scoped recovery is required." : (error?.message ?? "The private UAT session failed.") });
    process.exitCode = 1;
  } finally {
    if (admissionHeartbeat) clearInterval(admissionHeartbeat);
    if (admissionClaim && (!writer || writer.getState?.().writeAuthorityReached !== true)) { try { admissionStore.release({ admissionId: admissionClaim.admissionId, session: bootSession }); } catch { /* preserve a claim when liveness is uncertain */ } }
    leaseHeartbeat?.stop?.();
    writer?.close?.();
    await closeExchangeBounded(exchange);
  }
}

await main();
process.exit(process.exitCode ?? 0);
