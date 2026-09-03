/**
 * General account-bound settlement worker.
 *
 * This process is started only by the owner-authenticated private bridge for
 * a previously stopped session. It accepts no market, account, destination,
 * calldata, or amount from the public API. Every claim is derived from fresh
 * on-chain state and the session's exact market inventory.
 */

import fs from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { VILLA_ACCOUNT_CONFIG } from "../dashboard/account-config.mjs";
import { createLpExecutionAdapter, createViemLpAccountReader } from "../src/execution/lp-adapter.mjs";
import { createAccountBoundPrivateWriter } from "../src/execution/lp-private-writer.mjs";
import { reconcileDurableJournal } from "../src/execution/lp-recovery.mjs";
import { createFileAccountLeaseStore, createLpExecutionSession, transitionLpSession, attachLease } from "../src/execution/lp-session.mjs";
import { DEFAULT_PHASE_3B1_CAPS, createLpTransactionPolicy } from "../src/execution/lp-transaction-policy.mjs";
import { loadPrivateSigner } from "../src/execution/lp-private-runtime.mjs";
import { assessSessionSettlement, classifySessionPnl } from "../src/settlement/session-lifecycle.mjs";
import { persistPrivateUatState, persistUatState } from "../src/operator/uat-state.mjs";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SESSION_RE = /^uat-\d+-[0-9a-f]{8}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const SERIES_RE = /^BINARY:[A-Z0-9_-]+:\d+$/;
const SETTLEMENT_ABI = Object.freeze([
  { type: "function", name: "status", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "isResolved", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "isVoided", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "payoutNumerators", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] },
]);
const ORDERS_ABI = Object.freeze([{ type: "function", name: "getOwnOpenOrders", stateMutability: "view", inputs: [], outputs: [{ type: "uint128[]" }] }]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function address(value, label) {
  const text = String(value ?? "");
  if (!ADDRESS_RE.test(text)) fail("SETTLEMENT_SCOPE_INVALID", label + " is invalid");
  return text.toLowerCase();
}

function bytes32(value, label) {
  const text = String(value ?? "");
  if (!BYTES32_RE.test(text)) fail("SETTLEMENT_SCOPE_INVALID", label + " is invalid");
  return text.toLowerCase();
}

function same(left, right) { return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase(); }
function raw(value, label) {
  try {
    const result = typeof value === "bigint" ? value : BigInt(String(value));
    if (result < 0n) throw new Error();
    return result;
  } catch {
    fail("SETTLEMENT_RAW_INVALID", label + " is invalid");
  }
}

function readState(file) {
  if (!file || !fs.existsSync(file)) fail("SESSION_STATE_MISSING", "the stopped session state is unavailable");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { fail("SESSION_STATE_CORRUPT", "the stopped session state is unreadable"); }
}

function configFromEnv(env) {
  if (env.VILLA_UAT_SETTLEMENT_EXECUTION !== "true") fail("SETTLEMENT_EXECUTION_DISABLED", "the private settlement flag is not enabled");
  if (env.VILLA_EXECUTION_ENABLED !== "true") fail("EXECUTION_DISABLED", "settlement execution is disabled");
  if (String(env.VILLA_EXECUTION_MODE ?? "WET").toUpperCase() !== "WET") fail("MODE_INVALID", "settlement requires WET mode");
  if (!SESSION_RE.test(String(env.VILLA_ENGINE_SESSION_ID ?? ""))) fail("SESSION_INVALID", "settlement session id is invalid");
  return Object.freeze({
    owner: address(env.VILLA_ENGINE_OWNER, "LP owner"),
    account: address(env.VILLA_ENGINE_ACCOUNT, "VillaAccount"),
    operator: address(env.VILLA_ENGINE_OPERATOR ?? env.OPERATOR_ADDRESS, "VILLA operator"),
    sessionId: String(env.VILLA_ENGINE_SESSION_ID ?? ""),
    stateFile: String(env.VILLA_UAT_PRIVATE_STATE_FILE ?? env.VILLA_UAT_STATE_FILE ?? ""),
  });
}

function send(env, message) {
  persistPrivateUatState(env.VILLA_UAT_PRIVATE_STATE_FILE, message);
  persistUatState(env.VILLA_UAT_STATUS_FILE ?? env.VILLA_UAT_STATE_FILE, message);
  if (typeof process.send === "function") process.send(message);
}

async function readSettlement(publicClient, marketAddress) {
  const [status, isResolved, isVoided, payoutNumerators] = await Promise.all([
    publicClient.readContract({ address: marketAddress, abi: SETTLEMENT_ABI, functionName: "status" }),
    publicClient.readContract({ address: marketAddress, abi: SETTLEMENT_ABI, functionName: "isResolved" }),
    publicClient.readContract({ address: marketAddress, abi: SETTLEMENT_ABI, functionName: "isVoided" }),
    publicClient.readContract({ address: marketAddress, abi: SETTLEMENT_ABI, functionName: "payoutNumerators" }),
  ]);
  return { status: Number(status), isResolved: Boolean(isResolved), isVoided: Boolean(isVoided), payoutNumerators: payoutNumerators.map((value, index) => raw(value, "payoutNumerators[" + index + "]")) };
}

function sessionFromState(config, stored) {
  const session = stored?.session;
  if (!session) fail("SESSION_STATE_MISSING", "the stopped session has no public session identity");
  if (String(session.sessionId) !== config.sessionId) fail("SESSION_SCOPE_MISMATCH", "the requested settlement session does not match persisted state");
  if (!same(session.account, config.account) || !same(session.owner, config.owner) || !same(session.operator, config.operator)) fail("SESSION_SCOPE_MISMATCH", "persisted session identity differs from the configured account");
  const marketId = bytes32(session.currentMarketId ?? stored.snapshot?.marketId, "session marketId");
  const marketSeries = String(session.marketSeries ?? "");
  if (!SERIES_RE.test(marketSeries)) fail("SERIES_SCOPE_MISMATCH", "settlement requires a valid binary session series");
  const tracked = stored.snapshot?.trackedYesRaw === null || stored.snapshot?.trackedYesRaw === undefined || stored.snapshot?.trackedNoRaw === null || stored.snapshot?.trackedNoRaw === undefined
    ? null
    : { yesRaw: raw(stored.snapshot.trackedYesRaw, "tracked YES inventory"), noRaw: raw(stored.snapshot.trackedNoRaw, "tracked NO inventory") };
  if (!tracked) fail("SESSION_INVENTORY_MISSING", "exact session inventory was not persisted; settlement is blocked");
  const startingValueRaw = stored.snapshot?.startingValueRaw;
  if (startingValueRaw === null || startingValueRaw === undefined) fail("SESSION_BASELINE_MISSING", "exact session value baseline was not persisted; settlement is blocked");
  return { session, marketId, marketSeries, tracked, startingValueRaw: raw(startingValueRaw, "starting session value") };
}

async function main() {
  const env = process.env;
  const config = configFromEnv(env);
  if (!config.sessionId || !config.stateFile) fail("SESSION_REQUIRED", "a settlement session and state file are required");
  const stored = readState(config.stateFile);
  const restored = sessionFromState(config, stored);
  const publicClient = createPublicClient({ chain: somniaShannon, transport: http(env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl, { timeout: 15_000 }) });
  const reader = createViemLpAccountReader({ publicClient, listOpenOrderIds: async ({ pool }) => publicClient.readContract({ address: pool, abi: ORDERS_ABI, functionName: "getOwnOpenOrders", account: config.account }) });
  const adapter = createLpExecutionAdapter({ account: config.account, owner: config.owner, operator: config.operator, reader, sessionId: config.sessionId });
  const identity = await adapter.readAccountIdentity({ account: config.account });
  if (!same(identity.owner, config.owner) || !same(identity.operator, config.operator)) fail("ACCOUNT_IDENTITY_MISMATCH", "the VillaAccount owner or operator differs from the settlement scope");
  if (!same(identity.collateralToken, VILLA_ACCOUNT_CONFIG.collateralToken) || !same(identity.outcomeToken, VILLA_ACCOUNT_CONFIG.outcomeToken) || !same(identity.binaryModule, VILLA_ACCOUNT_CONFIG.binaryModule) || !same(identity.binarySettlement, VILLA_ACCOUNT_CONFIG.binarySettlement)) fail("ACCOUNT_WIRING_MISMATCH", "the VillaAccount wiring differs from trusted Shannon configuration");
  const accountMarket = await adapter.readMarket({ marketId: restored.marketId, identity });
  const accountState = await adapter.readAccountState({ marketId: restored.marketId });
  const settlementOnchain = await readSettlement(publicClient, accountMarket.market);
  const journalPath = env.VILLA_WRITER_JOURNAL || `${env.VILLA_STATE_DIR || "/var/lib/villa-engine"}/transactions.json`;
  const journal = await reconcileDurableJournal({ journalPath, publicClient, config: { account: config.account, operator: config.operator, marketId: restored.marketId, chainId: 50312 } });
  if (journal.pending > 0 || journal.unknown > 0) fail("RESTART_RECONCILIATION_REQUIRED", "an unknown or pending transaction must be reconciled before settlement");
  if (journal.reverted > 0) fail("REVERTED_TRANSACTION", "a prior transaction reverted and requires director review");
  const alreadyRedeemed = {
    yes: journal.records.some((record) => record.action === "REDEEM_RESOLVED" && Number(record.outcomeIdx ?? -1) === 0 && record.state === "CONFIRMED"),
    no: journal.records.some((record) => record.action === "REDEEM_RESOLVED" && Number(record.outcomeIdx ?? -1) === 1 && record.state === "CONFIRMED"),
  };
  let settlement = assessSessionSettlement({
    session: { ...restored.session, currentMarketId: restored.marketId },
    account: config.account,
    owner: config.owner,
    marketId: restored.marketId,
    onchain: settlementOnchain,
    held: restored.tracked,
    owned: accountState.inventory,
    orders: accountState.orders,
    payoutNumerators: settlementOnchain.payoutNumerators,
    outcomeIds: { yes: accountMarket.yesId, no: accountMarket.noId },
    alreadyRedeemed,
  });
  const currentValueRaw = accountState.capital.directCollateralRaw + (accountState.capital.vaultRaw ?? 0n);
  if (settlement.state === "SETTLEMENT_BLOCKED") fail(settlement.reason, "settlement is blocked until account orders and transactions are authoritative");
  if (settlement.state === "STOPPED_SETTLEMENT_PENDING") {
    send(env, { type: "state", state: "STOPPED_SETTLEMENT_PENDING", session: { ...restored.session, state: "STOPPED_SETTLEMENT_PENDING" }, snapshot: { marketId: restored.marketId, intervalSec: Number(String(restored.marketSeries).split(":").pop()), collateralRaw: accountState.capital.directCollateralRaw, yesRaw: accountState.inventory.yesRaw, noRaw: accountState.inventory.noRaw, trackedYesRaw: restored.tracked.yesRaw, trackedNoRaw: restored.tracked.noRaw, startingValueRaw: restored.startingValueRaw, pendingSettlement: { status: "PENDING_UNRESOLVED_MARKET" }, settlement, lastAction: "settlement_pending" }, result: { status: "STOPPED_SETTLEMENT_PENDING", marketId: restored.marketId, settlement } });
    return;
  }
  if (settlement.state === "SETTLED") {
    const pnl = classifySessionPnl({ startingValueRaw: restored.startingValueRaw, endingValueRaw: currentValueRaw });
    send(env, { type: "result", session: { ...restored.session, state: "SETTLED" }, result: { status: "SETTLED", marketId: restored.marketId, settlement, startingValueRaw: restored.startingValueRaw, finalValueRaw: currentValueRaw, pendingValueRaw: 0n, pnl } });
    send(env, { type: "state", state: "SETTLED", session: { ...restored.session, state: "SETTLED" }, snapshot: { marketId: restored.marketId, intervalSec: Number(String(restored.marketSeries).split(":").pop()), collateralRaw: accountState.capital.directCollateralRaw, yesRaw: accountState.inventory.yesRaw, noRaw: accountState.inventory.noRaw, trackedYesRaw: restored.tracked.yesRaw, trackedNoRaw: restored.tracked.noRaw, startingValueRaw: restored.startingValueRaw, pendingSettlement: null, settlement, pnl, lastAction: "already_settled" } });
    return;
  }
  const sessionBase = createLpExecutionSession({ sessionId: config.sessionId, account: config.account, owner: config.owner, operator: config.operator, chainId: 50312, marketSeries: restored.marketSeries, currentMarketId: restored.marketId, riskPolicyVersion: "villa-risk-v1", executionMode: "WET", createdAt: Date.now(), maxSessionDurationSec: DEFAULT_PHASE_3B1_CAPS.MAX_SESSION_DURATION_SEC });
  const preflightSession = transitionLpSession(sessionBase, "PREFLIGHT");
  const leaseStore = createFileAccountLeaseStore({ directory: env.VILLA_LEASE_DIR || env.VILLA_STATE_DIR || "/var/lib/villa-engine", leaseDurationMs: 30_000 });
  const lease = leaseStore.acquire(preflightSession, { reconciled: true });
  let writer = null;
  try {
    const signerInfo = loadPrivateSigner({ credentialsDirectory: env.CREDENTIALS_DIRECTORY, expectedOperator: config.operator });
    const policy = createLpTransactionPolicy({ session: preflightSession, caps: DEFAULT_PHASE_3B1_CAPS });
    const readySession = transitionLpSession(preflightSession, "SETTLEMENT_READY");
    const running = transitionLpSession(readySession, "SETTLING");
    const walletClient = createWalletClient({ account: signerInfo.signer, chain: somniaShannon, transport: http(env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl, { timeout: 15_000 }) });
    writer = createAccountBoundPrivateWriter({ session: running, lease: { ...lease, held: true }, policy, signer: signerInfo.signer, publicClient, walletClient, executionEnabled: true, readLatestNonce: () => publicClient.getTransactionCount({ address: signerInfo.address, blockTag: "latest" }), readPendingNonce: () => publicClient.getTransactionCount({ address: signerInfo.address, blockTag: "pending" }), readReceipt: (hash) => publicClient.getTransactionReceipt({ hash }), journalPath });
    send(env, { type: "state", state: "SETTLING", session: { ...restored.session, state: "SETTLING" }, snapshot: { marketId: restored.marketId, intervalSec: Number(String(restored.marketSeries).split(":").pop()), collateralRaw: accountState.capital.directCollateralRaw, yesRaw: accountState.inventory.yesRaw, noRaw: accountState.inventory.noRaw, trackedYesRaw: restored.tracked.yesRaw, trackedNoRaw: restored.tracked.noRaw, startingValueRaw: restored.startingValueRaw, pendingSettlement: null, settlement, lastAction: "settlement_submitting" } });
    let txIndex = 0;
    for (const leg of settlement.plan.legs.filter((item) => item.action === "REDEEM")) {
      const plan = adapter.redeemResolved({ marketId: restored.marketId, outcomeIdx: leg.outcomeIdx, amountRaw: leg.amountRaw });
      const prepared = policy.prepare({ ...plan, accountCapitalRaw: accountState.capital.directCollateralRaw }, { txIndex, createdAt: Date.now() });
      const validation = policy.validate(prepared, { nowMs: Date.now() });
      if (!validation.allowed) fail(validation.code ?? "POLICY_DENIED", validation.reason ?? "the settlement claim was denied by policy");
      const record = await writer.enqueue(prepared);
      if (record.state !== "CONFIRMED") fail("REDEEM_NOT_CONFIRMED", "settlement did not return an authoritative receipt");
      txIndex += 1;
    }
    const after = await adapter.readAccountState({ marketId: restored.marketId });
    settlement = assessSessionSettlement({ session: { ...restored.session, currentMarketId: restored.marketId }, account: config.account, owner: config.owner, marketId: restored.marketId, onchain: await readSettlement(publicClient, accountMarket.market), held: restored.tracked, owned: after.inventory, orders: after.orders, payoutNumerators: (await readSettlement(publicClient, accountMarket.market)).payoutNumerators, outcomeIds: { yes: accountMarket.yesId, no: accountMarket.noId }, alreadyRedeemed: { yes: true, no: true } });
    if (settlement.state !== "SETTLED") fail("POST_SETTLEMENT_RECONCILIATION_FAILED", "settlement claims did not clear or account for the exact session inventory");
    const finalValueRaw = after.capital.directCollateralRaw + (after.capital.vaultRaw ?? 0n);
    const pnl = classifySessionPnl({ startingValueRaw: restored.startingValueRaw, endingValueRaw: finalValueRaw });
    const terminalSession = { ...restored.session, state: "SETTLED", stoppedAt: Date.now() };
    leaseStore.release({ ...running, state: "SETTLED" }, { reconciled: true });
    send(env, { type: "result", session: terminalSession, result: { status: "SETTLED", marketId: restored.marketId, settlement, startingValueRaw: restored.startingValueRaw, finalValueRaw, pendingValueRaw: 0n, pnl } });
    send(env, { type: "state", state: "SETTLED", session: terminalSession, snapshot: { marketId: restored.marketId, intervalSec: Number(String(restored.marketSeries).split(":").pop()), collateralRaw: after.capital.directCollateralRaw, yesRaw: after.inventory.yesRaw, noRaw: after.inventory.noRaw, trackedYesRaw: restored.tracked.yesRaw, trackedNoRaw: restored.tracked.noRaw, startingValueRaw: restored.startingValueRaw, pendingSettlement: null, settlement, pnl, lastAction: "settlement_confirmed" } });
  } finally {
    writer?.close?.();
    if (writer === null) {
      try { leaseStore.release(preflightSession, { reconciled: true }); } catch { /* retain a lease if setup failed before a safe terminal state */ }
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith("lp-account-settlement.mjs")) {
  main().catch((error) => {
    send(process.env, { type: "error", code: error?.code ?? "SETTLEMENT_FAILED", message: error?.message ?? "The private settlement worker failed." });
    process.exitCode = 1;
  });
}
