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
import { MIN_STRATEGY_CAPITAL_RAW, VILLA_ACCOUNT_CONFIG } from "../dashboard/account-config.mjs";
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
import { evaluateWetExecutionPreflight } from "../src/execution/lp-preflight.mjs";
import { reconcileLpSession } from "../src/execution/lp-reconciliation.mjs";
import { attachLease, createFileAccountLeaseStore, createLpExecutionSession, transitionLpSession } from "../src/execution/lp-session.mjs";
import { createLeaseHeartbeat, LP_LEASE_DURATION_MS, LP_LEASE_HEARTBEAT_INTERVAL_MS } from "../src/execution/lp-lease-heartbeat.mjs";
import { DEFAULT_PHASE_3B1_CAPS, createLpTransactionPolicy } from "../src/execution/lp-transaction-policy.mjs";
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

function send(message) {
  persistPrivateUatState(process.env.VILLA_UAT_PRIVATE_STATE_FILE, message);
  persistUatState(process.env.VILLA_UAT_STATUS_FILE ?? process.env.VILLA_UAT_STATE_FILE, message);
  if (typeof process.send === "function") process.send(normalizeJsonBoundary(message));
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
  return Object.freeze({
    owner: address(env.VILLA_ENGINE_OWNER, "LP owner"),
    account: address(env.VILLA_ENGINE_ACCOUNT, "VillaAccount"),
    operator: address(env.VILLA_ENGINE_OPERATOR ?? env.OPERATOR_ADDRESS, "VILLA operator"),
    sessionId: String(env.VILLA_ENGINE_SESSION_ID ?? ""),
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

function publicAccountSnapshot(accountState, marketId, intervalSec, lastAction, pnl = null, trackedInventory = null, startingValueRaw = null, settlement = null) {
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
  };
}

async function main() {
  const env = process.env;
  const config = configFromEnv(env);
  if (!config.sessionId) fail("SESSION_REQUIRED", "a private UAT session id is required");
  send({ type: "state", state: "STARTING", session: { sessionId: config.sessionId, account: config.account, owner: config.owner, operator: config.operator } });
  const signerInfo = loadPrivateSigner({ credentialsDirectory: env.CREDENTIALS_DIRECTORY, expectedOperator: config.operator });
  const publicClient = createPublicClient({ chain: somniaShannon, transport: http(env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl, { timeout: 15_000 }) });
  const exchange = new SomniaMarkets({ account: config.account, indexerUrl: env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql", chain: somniaShannon, wsRpcUrl: env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws", addresses: SOMNIA_TESTNET_ADDRESSES, priceFeed: SOMNIA_TESTNET_PRICE_FEED });
  const leaseStore = createFileAccountLeaseStore({ directory: env.VILLA_LEASE_DIR || env.VILLA_STATE_DIR || "/var/lib/villa-engine", leaseDurationMs: 30_000 });
  const journalPath = env.VILLA_WRITER_JOURNAL || `${env.VILLA_STATE_DIR || "/var/lib/villa-engine"}/transactions.json`;
  const reader = createViemLpAccountReader({ publicClient, listOpenOrderIds: async ({ pool }) => publicClient.readContract({ address: pool, abi: OWN_ORDERS_ABI, functionName: "getOwnOpenOrders", account: config.account }) });
  const adapter = createLpExecutionAdapter({ account: config.account, owner: config.owner, operator: config.operator, reader, sessionId: config.sessionId });
  const stopSignal = { requested: false, reason: null, paused: false };
  const requestStop = (reason) => {
    if (!stopSignal.requested) { stopSignal.requested = true; stopSignal.reason = reason; }
  };
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

  const emitSnapshot = (lastAction, pnl = null) => {
    if (accountState && selected) send({ type: "snapshot", snapshot: publicAccountSnapshot(accountState, selected.marketId, selected.intervalSec, lastAction, pnl, trackedInventory, startingValueRaw, settlement) });
  };
  const readAccount = (marketId) => adapter.readAccountState({ marketId });
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
    const chainTime = await readChainTime(exchange);
    const live = await collectRiskSnapshot(exchange, { owner: config.account, gasAddress: config.operator, chainTime, minHeadroomSec: MIN_HEADROOM_SEC });
    const marketInfo = live.context.market;
    const marketId = bytes32(live.context.marketId, "selected marketId");
    const intervalSec = Number(marketInfo.info?.intervalSec ?? marketInfo.intervalSec);
    if (!Number.isSafeInteger(intervalSec) || intervalSec < 1) fail("MARKET_INVALID", "selected BTC market interval is invalid");
    selected = { marketId, intervalSec, expirySec: Number(live.context.onchain.expiry), series: `BINARY:BTC:${intervalSec}`, pool: live.context.onchain.pool, book: null };
    if (live.context.onchain.isResolved || live.context.onchain.isVoided || Number(live.context.onchain.status) !== 1) fail("MARKET_NOT_TRADING", "the selected BTC market is not Trading");
    const yesSymbol = marketInfo.outcomes?.find((outcome) => outcome.label === "YES")?.symbol;
    if (!yesSymbol) fail("BOOK_UNAVAILABLE", "the selected BTC market has no YES outcome");
    selected.book = await exchange.fetchOrderBook(yesSymbol, 5);
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
    if (initialCollateralRaw > DEFAULT_PHASE_3B1_CAPS.MAX_ACCOUNT_CAPITAL) fail("ACCOUNT_CAPITAL_CAP", "account capital exceeds the bounded cap");
    const accountMarket = await adapter.readMarket({ marketId: selected.marketId, identity });
    if (!same(accountMarket.pool, selected.pool)) fail("MARKET_POOL_MISMATCH", "the account market pool does not match the live market");
    const protocol = await readProtocol(selected.marketId, selected.pool, identity);
    if (!identity.autonomousTradingEnabled) {
      if (!protocol.marketApproved) fail("MARKET_NOT_APPROVED", "the selected live market has not been approved by the owner");
      if (!protocol.moduleOperator || !protocol.poolOperator) fail("PROTOCOL_APPROVAL_MISSING", "the selected live market is not prepared by the owner");
    }
    if (protocol.collateralAllowance !== 0n) fail("COLLATERAL_ALLOWANCE_PRESENT", "the selected pool has a nonzero collateral allowance");

    const initialDecision = evaluateRisk(live.snapshot, DEFAULT_RISK_CONFIG);
    const basePlanner = plannerInput({ snapshot: live.snapshot, decision: initialDecision, market: selected, accountState, params, decimals });
    const mintAmountRaw = raw(params.minQuantity, "minimum mint amount");
    if (mintAmountRaw > DEFAULT_PHASE_3B1_CAPS.MAX_MINT_AMOUNT || mintAmountRaw > identity.maxOrderCollateral || mintAmountRaw >= initialCollateralRaw) fail("MINT_CAP", "the live minimum mint is outside the bounded account policy");
    if (initialCollateralRaw < MIN_STRATEGY_CAPITAL_RAW) fail("CAPITAL_BELOW_STRATEGY_FLOOR", "the VillaAccount needs at least 1.001 tUSDC for the reserve plus venue-minimum complete-set mint");
    const projected = projectedPlannerInput({ snapshot: live.snapshot, decision: initialDecision, market: selected, accountState, params, decimals, mintAmountRaw });
    const quotePlan = planQuotes(projected.input);
    const ask = quotePlan.ask;
    if (projected.projectedDecision.state !== "ALLOW" || quotePlan.plan === "NO_QUOTE" || !ask?.enabled || ask.action !== "SELL_YES") fail("NO_VALID_QUOTE", "the live projected SELL_YES plan is not valid");
    if (raw(ask.targetQuantityRaw, "quote quantity") > DEFAULT_PHASE_3B1_CAPS.MAX_ORDER_NOTIONAL || raw(ask.targetQuantityRaw, "quote quantity") > identity.maxOrderQuantity) fail("ORDER_CAP", "the live quote exceeds the account or policy cap");

    const sessionBase = createLpExecutionSession({ sessionId: config.sessionId, account: config.account, owner: config.owner, operator: config.operator, chainId: 50312, marketSeries: selected.series, currentMarketId: selected.marketId, riskPolicyVersion: projected.projectedDecision.governorVersion, executionMode: "WET", createdAt: Date.now(), maxSessionDurationSec: MAX_SESSION_SEC });
    session = transitionLpSession(sessionBase, "PREFLIGHT");
    lease = leaseStore.acquire(session);
    session = attachLease(session, lease);
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
    const reconciliation = reconcileLpSession({ session, accountState: accountForPreflight, market: { marketId: selected.marketId, series: selected.series }, orders: accountState.orders, inventory: { ...accountState.inventory, status: "VERIFIED" }, transactions: [], risk: { state: projected.projectedDecision.state } });
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
      riskLimits: { valid: true }, risk: { state: projected.projectedDecision.state }, executionConfig: { mode: "WET", minimumCollateralRaw: 1n, sessionActive: false }, caps: DEFAULT_PHASE_3B1_CAPS,
    });
    if (!preflight.allowed || !reconciliation.safeToStart) fail("ACCOUNT_PREFLIGHT_BLOCKED", `the fresh account preflight did not pass: ${(preflight.reasons ?? []).join(",") || reconciliation.reasons.join(",")}`);
    const policy = createLpTransactionPolicy({ session, caps: DEFAULT_PHASE_3B1_CAPS });
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
    writer = createAccountBoundPrivateWriter({ session, lease: leaseHeartbeat.authority, policy, signer: signerInfo.signer, publicClient, walletClient, executionEnabled: true, readLatestNonce: () => publicClient.getTransactionCount({ address: signerInfo.address, blockTag: "latest" }), readPendingNonce: () => publicClient.getTransactionCount({ address: signerInfo.address, blockTag: "pending" }), readReceipt: (hash) => publicClient.getTransactionReceipt({ hash }), journalPath });
    send({ type: "ready", session: { sessionId: session.sessionId, account: session.account, owner: session.owner, operator: session.operator, marketSeries: session.marketSeries, currentMarketId: session.currentMarketId } });
    send({ type: "state", state: "RUNNING", session });
    emitSnapshot("preflight_passed");

    if (identity.autonomousTradingEnabled && (!protocol.marketPrepared || !protocol.moduleOperator || !protocol.poolOperator)) {
      const prepPlan = adapter.prepareMarket({ marketId: selected.marketId });
      await enqueue(prepPlan);
      emitSnapshot("market_prepared");
    }

    const mintPlan = adapter.mintCompleteSet({ marketId: selected.marketId, amountRaw: mintAmountRaw });
    await enqueue(mintPlan);
    send({ type: "state", state: "RUNNING", session });
    accountState = await readAccount(selected.marketId);
    if (accountState.inventory.yesRaw < mintAmountRaw || accountState.inventory.noRaw < mintAmountRaw) fail("MINT_RECONCILIATION_FAILED", "mint did not reconcile to the account");
    trackedInventory = { yesRaw: mintAmountRaw, noRaw: mintAmountRaw, marketId: selected.marketId, yesId: accountMarket.yesId, noId: accountMarket.noId };
    emitSnapshot("mint_confirmed");

    const quantityRaw = raw(ask.targetQuantityRaw, "quote quantity");
    const priceRaw = raw(ask.targetPriceRaw, "quote price");
    const expiryNs = raw(Math.max(1, Math.floor(selected.expirySec - 2)), "order expiry") * 1_000_000_000n;
    const placePlan = adapter.placeOrder({ marketId: selected.marketId, action: "SELL_YES", priceRaw, quantityRaw, expireTimestampNs: expiryNs, orderType: 3, userData: 0n });
    await enqueue(placePlan, { openOrderCount: 0, pendingExposureRaw: quantityRaw });
    accountState = await readAccount(selected.marketId);
    if (accountState.orders.status !== "VERIFIED" || accountState.orders.orders.length !== 1) fail("PLACE_RECONCILIATION_FAILED", "the bounded SELL_YES order did not reconcile");
    emitSnapshot("sell_yes_posted");

    const cleanup = async (reason) => {
      session = transitionLpSession(session, "STOPPING");
      send({ type: "state", state: "STOPPING", session });
      accountState = await readAccount(selected.marketId);
      for (const order of accountState.orders.orders) {
        if (!same(order.owner, config.account) || !same(order.marketId, selected.marketId)) fail("ORDER_SCOPE_MISMATCH", "cleanup encountered an order outside the session scope");
        await enqueue(adapter.cancelOrder({ marketId: selected.marketId, orderId: order.orderId }), { openOrderCount: 1, pendingExposureRaw: order.quantityRemainingRaw });
      }
      accountState = await readAccount(selected.marketId);
      if (accountState.orders.orders.length !== 0) fail("CANCEL_RECONCILIATION_FAILED", "account orders did not reconcile empty");
      const burnAmountRaw = accountState.inventory.yesRaw < accountState.inventory.noRaw ? accountState.inventory.yesRaw : accountState.inventory.noRaw;
      if (burnAmountRaw > 0n) await enqueue(adapter.burnCompleteSet({ marketId: selected.marketId, amountRaw: burnAmountRaw }));
      accountState = await readAccount(selected.marketId);
      const onchainSettlement = await readSettlement(accountMarket.market);
      settlement = assessSessionSettlement({ session, account: config.account, owner: config.owner, marketId: selected.marketId, onchain: onchainSettlement, held: trackedInventory, owned: accountState.inventory, orders: accountState.orders, payoutNumerators: onchainSettlement.payoutNumerators, outcomeIds: { yes: accountMarket.yesId, no: accountMarket.noId } });
      if (settlement.state === "SETTLEMENT_BLOCKED") fail(settlement.reason, "settlement is blocked until account orders and transactions are authoritative");
      const pendingValueRaw = settlement.state === "STOPPED_SETTLEMENT_PENDING" ? null : 0n;
      const finalValueRaw = accountState.capital.directCollateralRaw + (accountState.capital.vaultRaw ?? 0n);
      const pnl = classifySessionPnl({ startingValueRaw, endingValueRaw: finalValueRaw, pendingValueRaw });
      const pending = pendingValueRaw === null;
      emitSnapshot(reason, pnl);
      session = transitionLpSession(session, settlement.state === "STOPPED_CLEAN" ? "STOPPED_CLEAN" : settlement.state, { atMs: Date.now() });
      leaseStore.release(session, { reconciled: true });
      leaseHeartbeat.authority.held = false;
      leaseHeartbeat.stop();
      send({ type: "result", session, result: { status: session.state, reason, pnl, startingValueRaw, finalValueRaw, pendingValueRaw, ordersPlaced: 1, fills: pending ? "UNRESOLVED_OR_FILLED" : "NONE_CONFIRMED", marketId: selected.marketId, intervalSec: selected.intervalSec, pendingSettlement: pending, settlement } });
      send({ type: "state", state: session.state, session });
    };

    while (!stopSignal.requested) {
      const chain = await readChainTime(exchange);
      accountState = await readAccount(selected.marketId);
      const timeRemainingSec = selected.expirySec - chain.chainNowSec;
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
    leaseHeartbeat?.stop?.();
    writer?.close?.();
    await closeExchangeBounded(exchange);
  }
}

await main();
process.exit(process.exitCode ?? 0);
