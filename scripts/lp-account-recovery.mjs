/** Private one-shot recovery for one authenticated, expired UAT session. */

import fs from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { VILLA_ACCOUNT_CONFIG } from "../dashboard/account-config.mjs";
import { normalizeJsonBoundary, persistPrivateUatState, persistUatState } from "../src/operator/uat-state.mjs";
import { createLpExecutionAdapter, createViemLpAccountReader, VILLA_ACCOUNT_READ_ABI } from "../src/execution/lp-adapter.mjs";
import { createAccountBoundPrivateWriter } from "../src/execution/lp-private-writer.mjs";
import { createFileAccountLeaseStore, createLpExecutionSession, transitionLpSession, attachLease } from "../src/execution/lp-session.mjs";
import { createLeaseHeartbeat, LP_LEASE_DURATION_MS, LP_LEASE_HEARTBEAT_INTERVAL_MS } from "../src/execution/lp-lease-heartbeat.mjs";
import { validateExpiredSessionRecovery, recoveryActions } from "../src/execution/lp-session-recovery.mjs";
import { reconcileDurableJournal } from "../src/execution/lp-recovery.mjs";
import { DEFAULT_PHASE_3B1_CAPS, createLpTransactionPolicy } from "../src/execution/lp-transaction-policy.mjs";
import { loadPrivateSigner } from "../src/execution/lp-private-runtime.mjs";
import { assessSessionSettlement, classifySessionPnl } from "../src/settlement/session-lifecycle.mjs";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SESSION_RE = /^uat-\d+-[0-9a-f]{8}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const OWN_ORDERS_ABI = Object.freeze([{ type: "function", name: "getOwnOpenOrders", stateMutability: "view", inputs: [], outputs: [{ type: "uint128[]" }] }]);
const SETTLEMENT_ABI = Object.freeze([
  { type: "function", name: "status", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "isResolved", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "isVoided", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "payoutNumerators", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] },
]);

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function same(left, right) { return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase(); }
function address(value, label) { const text = String(value ?? ""); if (!ADDRESS_RE.test(text)) fail("RECOVERY_SCOPE_INVALID", `${label} is invalid`); return text.toLowerCase(); }
function raw(value, label) { try { const result = BigInt(String(value ?? 0)); if (result < 0n) throw new Error(); return result; } catch { fail("RECOVERY_VALUE_INVALID", `${label} is invalid`); } }
function readJson(file, label) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { fail("RECOVERY_STATE_UNREADABLE", `${label} is unreadable`); } }
function send(env, message) {
  persistPrivateUatState(env.VILLA_UAT_PRIVATE_STATE_FILE, message);
  persistUatState(env.VILLA_UAT_STATUS_FILE ?? env.VILLA_UAT_STATE_FILE, message);
  if (typeof process.send === "function") process.send(normalizeJsonBoundary(message));
}

function configFromEnv(env) {
  if (env.VILLA_UAT_RECOVERY_EXECUTION !== "true" || env.VILLA_ACCOUNT_EXECUTION_ENABLED !== "true") fail("RECOVERY_DISABLED", "private account recovery is not enabled for this unit");
  if (env.VILLA_EXECUTION_ENABLED !== "false" || env.VILLA_UAT_EXECUTION_ENABLED !== "false") fail("EXECUTION_FLAG_INVALID", "global execution flags must remain disabled during recovery");
  if (!SESSION_RE.test(String(env.VILLA_ENGINE_SESSION_ID ?? ""))) fail("RECOVERY_SCOPE_INVALID", "session id is invalid");
  return Object.freeze({
    owner: address(env.VILLA_ENGINE_OWNER, "owner"),
    account: address(env.VILLA_ENGINE_ACCOUNT, "VillaAccount"),
    operator: address(env.VILLA_ENGINE_OPERATOR, "operator"),
    sessionId: String(env.VILLA_ENGINE_SESSION_ID),
    chainId: 50312,
  });
}

async function closeExchange(exchange) {
  if (!exchange?.close) return;
  await Promise.race([exchange.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 500))]);
}

async function readSettlement(publicClient, market) {
  const [status, isResolved, isVoided, payoutNumerators] = await Promise.all([
    publicClient.readContract({ address: market, abi: SETTLEMENT_ABI, functionName: "status" }),
    publicClient.readContract({ address: market, abi: SETTLEMENT_ABI, functionName: "isResolved" }),
    publicClient.readContract({ address: market, abi: SETTLEMENT_ABI, functionName: "isVoided" }),
    publicClient.readContract({ address: market, abi: SETTLEMENT_ABI, functionName: "payoutNumerators" }),
  ]);
  return { status: Number(status), isResolved: Boolean(isResolved), isVoided: Boolean(isVoided), payoutNumerators: payoutNumerators.map((value) => raw(value, "payout numerator")) };
}

async function main() {
  const env = process.env;
  const config = configFromEnv(env);
  const stored = readJson(env.VILLA_UAT_PRIVATE_STATE_FILE, "private session state");
  const marketId = String(stored?.session?.currentMarketId ?? "").toLowerCase();
  if (!BYTES32_RE.test(marketId) || stored?.session?.sessionId !== config.sessionId || !same(stored?.session?.owner, config.owner) || !same(stored?.session?.account, config.account) || !same(stored?.session?.operator, config.operator)) fail("RECOVERY_SCOPE_MISMATCH", "private state is not bound to this exact owner/account/session");
  const publicClient = createPublicClient({ chain: somniaShannon, transport: http(env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl, { timeout: 15_000 }) });
  const exchange = new SomniaMarkets({ account: config.account, indexerUrl: env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql", chain: somniaShannon, wsRpcUrl: env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws", addresses: SOMNIA_TESTNET_ADDRESSES, priceFeed: SOMNIA_TESTNET_PRICE_FEED });
  const leaseStore = createFileAccountLeaseStore({ directory: env.VILLA_LEASE_DIR || env.VILLA_STATE_DIR, leaseDurationMs: LP_LEASE_DURATION_MS });
  const journalPath = env.VILLA_WRITER_JOURNAL;
  const reader = createViemLpAccountReader({ publicClient, listOpenOrderIds: async ({ pool }) => publicClient.readContract({ address: pool, abi: OWN_ORDERS_ABI, functionName: "getOwnOpenOrders", account: config.account }) });
  const adapter = createLpExecutionAdapter({ account: config.account, owner: config.owner, operator: config.operator, reader, sessionId: config.sessionId });
  let session = null;
  let heartbeat = null;
  let writer = null;
  let released = false;
  try {
    const identity = await adapter.readAccountIdentity();
    if (identity.accountVersion !== 2 || !same(identity.owner, config.owner) || !same(identity.operator, config.operator)
      || !same(identity.collateralToken, VILLA_ACCOUNT_CONFIG.collateralToken) || !same(identity.outcomeToken, VILLA_ACCOUNT_CONFIG.outcomeToken)
      || !same(identity.binaryModule, VILLA_ACCOUNT_CONFIG.binaryModule) || !same(identity.binarySettlement, VILLA_ACCOUNT_CONFIG.binarySettlement)) fail("RECOVERY_ACCOUNT_INVALID", "VillaAccount identity or canonical wiring is not trusted");
    const accountMarket = await adapter.readMarket({ marketId, identity });
    let accountState = await adapter.readAccountState({ marketId });
    let journal = await reconcileDurableJournal({ journalPath, publicClient, config: { ...config, marketId } });
    const base = createLpExecutionSession({ sessionId: config.sessionId, account: config.account, owner: config.owner, operator: config.operator, chainId: config.chainId, marketSeries: String(stored.session.marketSeries || "BINARY:BTC:UAT"), currentMarketId: marketId, riskPolicyVersion: "villa-expired-session-recovery-v1", executionMode: "WET", createdAt: Date.now(), maxSessionDurationSec: DEFAULT_PHASE_3B1_CAPS.MAX_SESSION_DURATION_SEC });
    session = transitionLpSession(base, "PREFLIGHT");
    const expiredLease = leaseStore.get(config.account);
    const provenance = validateExpiredSessionRecovery({ session, stored, expiredLease, journal, accountState });
    const lease = leaseStore.recoverExpired(session, { expectedLeaseId: expiredLease.leaseId });
    session = attachLease(session, lease);
    heartbeat = createLeaseHeartbeat({ leaseStore, session, lease, leaseDurationMs: LP_LEASE_DURATION_MS, intervalMs: LP_LEASE_HEARTBEAT_INTERVAL_MS, onFailure: (error) => send(env, { type: "error", code: "ACCOUNT_LEASE_LOST", message: `Recovery lease heartbeat failed; no further writes are allowed. ${error.message}` }) });
    heartbeat.start();
    const policy = createLpTransactionPolicy({ session, caps: DEFAULT_PHASE_3B1_CAPS });
    const walletClient = createWalletClient({ account: loadPrivateSigner({ credentialsDirectory: env.CREDENTIALS_DIRECTORY, expectedOperator: config.operator }).signer, chain: somniaShannon, transport: http(env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl, { timeout: 15_000 }) });
    const signer = walletClient.account;
    session = transitionLpSession(session, "RUNNING");
    writer = createAccountBoundPrivateWriter({ session, lease: heartbeat.authority, policy, signer, publicClient, walletClient, executionEnabled: true, readLatestNonce: () => publicClient.getTransactionCount({ address: signer.address, blockTag: "latest" }), readPendingNonce: () => publicClient.getTransactionCount({ address: signer.address, blockTag: "pending" }), readReceipt: (hash) => publicClient.getTransactionReceipt({ hash }), journalPath });
    let txIndex = provenance.nextTxIndex;
    const writes = [];
    const enqueue = async (plan, context = {}) => {
      heartbeat.renewNow();
      const prepared = policy.prepare({ ...plan, accountCapitalRaw: accountState.capital.directCollateralRaw, ...context }, { txIndex, createdAt: Date.now() });
      txIndex += 1;
      const result = await writer.enqueue(prepared);
      if (result.state !== "CONFIRMED") fail("RECOVERY_WRITE_UNCONFIRMED", "recovery write was not authoritatively confirmed");
      writes.push({ action: prepared.intent.action, hash: result.hash, receiptBlock: result.receiptBlock });
      return result;
    };
    session = transitionLpSession(session, "STOPPING");
    send(env, { type: "state", state: "STOPPING", session });
    send(env, { type: "snapshot", snapshot: { ...stored.snapshot, lastAction: "expired_session_recovery" } });

    let actions = recoveryActions({ session, provenance, accountState });
    for (const orderId of actions.cancelOrderIds) {
      const order = accountState.orders.orders.find((item) => raw(item.orderId, "order id") === orderId);
      await enqueue(adapter.cancelOrder({ marketId, orderId }), { openOrderCount: accountState.orders.orders.length, pendingExposureRaw: order?.quantityRemainingRaw ?? 0n });
    }
    accountState = await adapter.readAccountState({ marketId });
    if (accountState.orders.status !== "VERIFIED" || accountState.orders.orders.length !== 0) fail("RECOVERY_CANCEL_INCOMPLETE", "account orders did not reconcile empty after scoped cancellation");
    actions = recoveryActions({ session, provenance, accountState });
    if (actions.burnAmountRaw > 0n) await enqueue(adapter.burnCompleteSet({ marketId, amountRaw: actions.burnAmountRaw }));
    accountState = await adapter.readAccountState({ marketId });
    actions = recoveryActions({ session, provenance, accountState });
    if (actions.claimVaultRaw > 0n) await enqueue(adapter.claimVault({ marketId, amountRaw: actions.claimVaultRaw }));
    accountState = await adapter.readAccountState({ marketId });
    journal = await reconcileDurableJournal({ journalPath, publicClient, config: { ...config, marketId } });
    if (journal.pending > 0 || journal.unknown > 0) fail("RECOVERY_TRANSACTION_UNKNOWN", "recovery journal is not authoritative after reconciliation");
    const onchainSettlement = await readSettlement(publicClient, accountMarket.market);
    const settlement = assessSessionSettlement({ session, account: config.account, owner: config.owner, marketId, onchain: onchainSettlement, held: provenance.trackedInventory, owned: accountState.inventory, orders: accountState.orders, pendingTransactions: journal.pending, unknownTransactions: journal.unknown, payoutNumerators: onchainSettlement.payoutNumerators, outcomeIds: { yes: accountMarket.yesId, no: accountMarket.noId } });
    if (settlement.state === "SETTLEMENT_BLOCKED") fail(settlement.reason, "recovery settlement state is blocked");
    const finalState = settlement.state === "SETTLED"
      ? "STOPPED_CLEAN"
      : settlement.state === "SETTLEMENT_READY"
        ? "STOPPED_SETTLEMENT_PENDING"
        : settlement.state;
    session = transitionLpSession(session, finalState, { atMs: Date.now() });
    leaseStore.release(session, { reconciled: true });
    heartbeat.authority.held = false;
    heartbeat.stop();
    released = true;
    const startingValueRaw = raw(stored.snapshot?.startingValueRaw ?? stored.snapshot?.collateralRaw, "starting value");
    const pendingValueRaw = finalState === "STOPPED_SETTLEMENT_PENDING" ? null : 0n;
    const finalValueRaw = accountState.capital.directCollateralRaw + (accountState.capital.vaultRaw ?? 0n);
    const pnl = classifySessionPnl({ startingValueRaw, endingValueRaw: finalValueRaw, pendingValueRaw });
    const snapshot = { marketId, collateralRaw: accountState.capital.directCollateralRaw, vaultRaw: accountState.capital.vaultRaw, yesRaw: accountState.inventory.yesRaw, noRaw: accountState.inventory.noRaw, openOrders: [], pendingSettlement: finalState === "STOPPED_SETTLEMENT_PENDING" ? { status: "PENDING_UNRESOLVED_MARKET" } : null, settlement, lastAction: "expired_session_reconciled", pnl };
    send(env, { type: "snapshot", snapshot });
    send(env, { type: "result", session, result: { status: finalState, reason: "EXPIRED_SESSION_RECOVERED", writes, settlement, finalValueRaw, pendingSettlement: finalState === "STOPPED_SETTLEMENT_PENDING" } });
    send(env, { type: "state", state: finalState, session });
  } catch (error) {
    send(env, { type: "error", code: error?.code ?? "SESSION_RECOVERY_FAILED", message: error?.message ?? "The scoped session recovery failed." });
    process.exitCode = 1;
  } finally {
    heartbeat?.stop?.();
    writer?.close?.();
    await closeExchange(exchange);
    if (!released && heartbeat) heartbeat.authority.held = false;
  }
}

await main();
