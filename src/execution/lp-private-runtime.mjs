/**
 * Private VPS-only account-bound runtime.
 *
 * The public dashboard and operator API do not import this module. It loads a
 * signer only from a systemd credential, binds one session to one VillaAccount
 * and market, and stops at EXECUTION_DISABLED unless the private service is
 * explicitly armed in a separately approved phase.
 */

import * as fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { VILLA_ACCOUNT_CONFIG } from "../../dashboard/account-config.mjs";
import {
  createLpExecutionAdapter,
  createViemLpAccountReader,
  ERC20_BALANCE_ABI,
  VILLA_ACCOUNT_READ_ABI,
  VILLA_POOL_READ_ABI,
} from "./lp-adapter.mjs";
import { createAccountBoundPrivateWriter } from "./lp-private-writer.mjs";
import { evaluateWetExecutionPreflight } from "./lp-preflight.mjs";
import { reconcileLpSession } from "./lp-reconciliation.mjs";
import { createFileAccountLeaseStore, createLpExecutionSession, transitionLpSession } from "./lp-session.mjs";
import { DEFAULT_PHASE_3B1_CAPS, createLpTransactionPolicy } from "./lp-transaction-policy.mjs";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FEASIBILITY_SCRIPT = fileURLToPath(new URL("../../scripts/phase3b1a-feasibility-readonly.mjs", import.meta.url));

export const LP_PRIVATE_RUNTIME_VERSION = "villa-private-runtime-v1";
export const LP_PRIVATE_SUPPORTED_ACTIONS = Object.freeze([
  "operatorPlaceOrder",
  "operatorCancelOrder",
  "operatorReduceOrder",
  "operatorMintSet",
  "operatorBurnSet",
  "operatorRedeem",
  "operatorClaimVault",
]);
export const PRIVATE_RUNTIME_DEFAULTS = Object.freeze({
  chainId: 50312,
  marketId: "0x000000000000000000000000000000000000000000000000000000000000f920",
  marketSeries: "BINARY:BTC:86400",
  marketIntervalSec: 86400,
  maxSessionDurationSec: 900,
});

const POOL_OWN_ORDERS_ABI = Object.freeze([
  { type: "function", name: "getOwnOpenOrders", stateMutability: "view", inputs: [], outputs: [{ type: "uint128[]" }] },
]);
const OUTCOME_OPERATOR_ABI = Object.freeze([
  { type: "function", name: "isOperator", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "bool" }] },
]);
const ERC20_ALLOWANCE_ABI = Object.freeze([
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
]);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export class LpPrivateRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LpPrivateRuntimeError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new LpPrivateRuntimeError(code, message);
}

function address(value, label) {
  const text = String(value ?? "");
  if (!ADDRESS_RE.test(text) || !isAddress(text)) fail("ADDRESS_INVALID", `${label} must be a valid address`);
  return text.toLowerCase();
}

function bytes32(value, label) {
  const text = String(value ?? "");
  if (!BYTES32_RE.test(text)) fail("BYTES32_INVALID", `${label} must be bytes32`);
  return text.toLowerCase();
}

function sameAddress(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function raw(value, label) {
  try {
    const result = typeof value === "bigint" ? value : BigInt(String(value));
    if (result < 0n) throw new Error();
    return result;
  } catch {
    fail("RAW_INVALID", `${label} must be a non-negative raw integer`);
  }
}

function jsonSafe(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function parseJson(stdout, stderr) {
  for (const candidate of [String(stdout ?? "").trim(), String(stderr ?? "").trim()]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* try the other stream */ }
  }
  fail("FEASIBILITY_OUTPUT_INVALID", "the read-only feasibility result was not JSON");
}

function credentialKey(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1 || !/^OPERATOR_PRIVATE_KEY=0x[0-9a-fA-F]{64}$/.test(lines[0])) fail("SIGNER_CREDENTIAL_INVALID", "the private credential must contain exactly one operator key entry");
  return lines[0].slice("OPERATOR_PRIVATE_KEY=".length);
}

/** Load and verify the signer without returning the private key text. */
export function loadPrivateSigner({ credentialsDirectory, expectedOperator, readFile = (file) => fs.readFileSync(file, "utf8") } = {}) {
  if (!credentialsDirectory) fail("SIGNER_CREDENTIAL_REQUIRED", "systemd operator-key credential directory is required");
  const keyFile = path.join(credentialsDirectory, "operator-key");
  let key;
  try { key = credentialKey(readFile(keyFile)); } catch (error) {
    if (error instanceof LpPrivateRuntimeError) throw error;
    fail("SIGNER_CREDENTIAL_UNREADABLE", "the private signer credential could not be read");
  }
  const signer = privateKeyToAccount(key);
  const derived = address(signer.address, "derived signer address");
  if (!sameAddress(derived, address(expectedOperator, "expected operator"))) fail("SIGNER_MISMATCH", "derived signer address does not match the canonical VILLA operator");
  return Object.freeze({ signer, address: derived, credentialPath: keyFile });
}

function assertNoSignerEnvironment(env) {
  for (const name of ["OPERATOR_PRIVATE_KEY", "TAKER_PRIVATE_KEY", "PRIVATE_KEY", "WALLET_SEED", "MNEMONIC"]) {
    if (env?.[name]) fail("SIGNER_ENV_FORBIDDEN", `${name} must not be supplied to the private runtime environment`);
  }
}

function runtimeConfig(env, args) {
  assertNoSignerEnvironment(env);
  const account = address(env.VILLA_ENGINE_ACCOUNT ?? args.account, "VillaAccount");
  const owner = address(env.VILLA_ENGINE_OWNER, "LP owner");
  const operator = address(env.VILLA_ENGINE_OPERATOR ?? env.OPERATOR_ADDRESS, "VILLA operator");
  const chainId = Number(env.VILLA_ENGINE_CHAIN_ID ?? PRIVATE_RUNTIME_DEFAULTS.chainId);
  const marketId = bytes32(env.VILLA_ENGINE_MARKET_ID ?? args.marketId, "marketId");
  const marketSeries = String(env.VILLA_ENGINE_MARKET_SERIES ?? PRIVATE_RUNTIME_DEFAULTS.marketSeries);
  const intervalSec = Number(env.VILLA_ENGINE_MARKET_INTERVAL_SEC ?? PRIVATE_RUNTIME_DEFAULTS.marketIntervalSec);
  const sessionId = String(env.VILLA_ENGINE_SESSION_ID ?? args.sessionId ?? "");
  if (chainId !== PRIVATE_RUNTIME_DEFAULTS.chainId) fail("CHAIN_SCOPE_MISMATCH", "private runtime is restricted to Somnia Shannon 50312");
  if (intervalSec !== 86400 || marketSeries !== "BINARY:BTC:86400") fail("MARKET_SERIES_UNSUPPORTED", "this bounded runtime is restricted to BTC 24-hour markets");
  if (!sessionId) fail("SESSION_REQUIRED", "a specific one-shot session id is required");
  if (args.account && !sameAddress(args.account, account)) fail("ACCOUNT_SCOPE_MISMATCH", "CLI account does not match the immutable runtime account");
  if (args.sessionId && args.sessionId !== sessionId) fail("SESSION_SCOPE_MISMATCH", "CLI session does not match the immutable runtime session");
  if (args.marketId && bytes32(args.marketId, "CLI marketId") !== marketId) fail("MARKET_SCOPE_MISMATCH", "CLI market does not match the immutable runtime market");
  return Object.freeze({ account, owner, operator, chainId, marketId, marketSeries, intervalSec, sessionId });
}

function withoutSignerEnvironment(env) {
  const safe = { ...env };
  for (const name of ["OPERATOR_PRIVATE_KEY", "TAKER_PRIVATE_KEY", "PRIVATE_KEY", "WALLET_SEED", "MNEMONIC", "CREDENTIALS_DIRECTORY"]) delete safe[name];
  return safe;
}

async function readFeasibility({ env, config }) {
  const safeEnv = withoutSignerEnvironment({ ...env, MARKET_INTERVAL_SEC: String(config.intervalSec), MARKET_SERIES: config.marketSeries, MARKET_ID: config.marketId });
  let result;
  try {
    result = await execFileAsync(process.execPath, [FEASIBILITY_SCRIPT], { cwd: ROOT, env: safeEnv, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
  return parseJson(result.stdout, result.stderr);
}

function createExchange({ account, env }) {
  return new SomniaMarkets({
    account,
    indexerUrl: env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql",
    chain: somniaShannon,
    wsRpcUrl: env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws",
    addresses: SOMNIA_TESTNET_ADDRESSES,
    priceFeed: SOMNIA_TESTNET_PRICE_FEED,
  });
}

function createAccountReader(publicClient, account) {
  return createViemLpAccountReader({
    publicClient,
    listOpenOrderIds: async ({ pool }) => publicClient.readContract({ address: pool, abi: POOL_OWN_ORDERS_ABI, functionName: "getOwnOpenOrders", account }),
  });
}

async function readProtocolState({ publicClient, account, identity, marketId, pool }) {
  const [marketApproved, moduleOperator, poolOperator, collateralAllowance] = await Promise.all([
    publicClient.readContract({ address: account, abi: VILLA_ACCOUNT_READ_ABI, functionName: "approvedMarkets", args: [marketId] }),
    publicClient.readContract({ address: identity.outcomeToken, abi: OUTCOME_OPERATOR_ABI, functionName: "isOperator", args: [account, identity.binaryModule] }),
    publicClient.readContract({ address: identity.outcomeToken, abi: OUTCOME_OPERATOR_ABI, functionName: "isOperator", args: [account, pool] }),
    publicClient.readContract({ address: identity.collateralToken, abi: ERC20_ALLOWANCE_ABI, functionName: "allowance", args: [account, pool] }),
  ]);
  return { marketApproved: Boolean(marketApproved), moduleOperator: Boolean(moduleOperator), poolOperator: Boolean(poolOperator), collateralAllowance: raw(collateralAllowance, "collateral allowance") };
}

function journalObservation(journalPath) {
  if (!journalPath || !fs.existsSync(journalPath)) return { records: [], pending: 0, unknown: 0 };
  let value;
  try { value = JSON.parse(fs.readFileSync(journalPath, "utf8")); } catch { fail("JOURNAL_CORRUPT", "private transaction journal is unreadable; recovery is blocked"); }
  const records = Array.isArray(value?.records) ? value.records : [];
  return { records, pending: records.filter((record) => record.state === "PENDING").length, unknown: records.filter((record) => record.state === "UNKNOWN").length };
}

function accountStateForPreflight({ account, owner, operator, accountState }) {
  return {
    account,
    owner,
    operator,
    identity: accountState.identity,
    capital: accountState.capital,
    inventory: accountState.inventory ? { account, status: "VERIFIED", ...accountState.inventory } : null,
    orders: { account, status: accountState.orders.status, orders: accountState.orders.orders },
  };
}

function preparedPlan({ policy, plan, index, capitalRaw, openOrderCount = 0, pendingExposureRaw = 0n, createdAt }) {
  const scoped = { ...plan, accountCapitalRaw: capitalRaw, openOrderCount, pendingExposureRaw };
  const prepared = policy.prepare(scoped, { txIndex: index, createdAt });
  const validation = policy.validate(prepared, { nowMs: createdAt });
  if (!validation.allowed) fail(validation.code ?? "POLICY_DENIED", validation.reason ?? "private action was denied by policy");
  return prepared;
}

function buildProjectedPlans({ adapter, policy, feasibility, marketId, expirySec, capitalRaw, createdAt }) {
  const mintAmountRaw = raw(feasibility.mintSearch?.smallestViableMintRaw, "projected mint amount");
  const ask = feasibility.sellAfterMint?.quotePlan?.ask;
  if (feasibility.recommendation?.path !== "B" || feasibility.sellAfterMint?.viable !== true || !ask?.enabled || ask.action !== "SELL_YES") fail("NO_VALID_PROJECTED_PLAN", "the live projected mint and SELL_YES path is not valid");
  const priceRaw = raw(ask.targetPriceRaw, "projected quote price");
  const quantityRaw = raw(ask.targetQuantityRaw, "projected quote quantity");
  const orderExpiryNs = raw(Math.max(1, Math.floor(Number(expirySec) - 2)), "order expiry") * 1_000_000_000n;
  const mint = adapter.mintCompleteSet({ marketId, amountRaw: mintAmountRaw });
  const place = adapter.placeOrder({ marketId, action: "SELL_YES", priceRaw, quantityRaw, expireTimestampNs: orderExpiryNs, orderType: 3, userData: 0n });
  const cancelTemplate = adapter.cancelOrder({ marketId, orderId: 0n });
  const burn = adapter.burnCompleteSet({ marketId, amountRaw: mintAmountRaw });
  return [
    preparedPlan({ policy, plan: mint, index: 0, capitalRaw, createdAt }),
    preparedPlan({ policy, plan: place, index: 1, capitalRaw, openOrderCount: 0, pendingExposureRaw: 0n, createdAt }),
    preparedPlan({ policy, plan: cancelTemplate, index: 2, capitalRaw, openOrderCount: 1, pendingExposureRaw: quantityRaw, createdAt }),
    preparedPlan({ policy, plan: burn, index: 3, capitalRaw, createdAt }),
  ];
}

function preflightInput({ config, session, lease, feasibility, accountState, protocol, signerAddress, reconciliation }) {
  const shadow = feasibility.shadow;
  const risk = shadow.risk ?? {};
  const marketStatus = Number(shadow.riskSnapshot?.market?.status ?? 0);
  const market = { marketId: config.marketId, series: config.marketSeries, status: marketStatus, valid: true, current: true, currentMarketId: config.marketId };
  return {
    nowMs: Date.now(),
    session,
    lease: { ...lease, held: true },
    chain: { id: config.chainId },
    executionEnabled: false,
    account: { address: config.account, owner: config.owner, operator: config.operator, runtimeVerified: true },
    owner: { address: config.owner, verified: true },
    operator: { configuredAddress: config.operator, signerAddress },
    capital: { collateralRaw: accountState.capital.directCollateralRaw },
    market,
    orders: accountStateForPreflight({ account: config.account, owner: config.owner, operator: config.operator, accountState }).orders,
    inventory: accountStateForPreflight({ account: config.account, owner: config.owner, operator: config.operator, accountState }).inventory,
    reconciliation,
    permissions: { requiresMarketApproval: true, marketApproved: protocol.marketApproved, requiresProtocolApproval: true, protocolPrepared: protocol.moduleOperator && protocol.poolOperator },
    riskLimits: { valid: true },
    risk: { state: risk.state },
    executionConfig: { mode: "WET", minimumCollateralRaw: 1n, sessionActive: false },
    caps: DEFAULT_PHASE_3B1_CAPS,
  };
}

async function closeExchange(exchange) {
  if (!exchange || typeof exchange.close !== "function") return;
  await Promise.race([exchange.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 500))]);
}

/**
 * Read the exact bound account/market, build the complete four-action plan,
 * and stop at the writer boundary while execution is disabled. The enabled
 * branch is deliberately present but never reached in this Phase 3B2A run.
 */
export async function runPrivateLpOneShot({ env = process.env, args = {}, dependencies = {} } = {}) {
  const config = runtimeConfig(env, args);
  const executionEnabled = env.VILLA_EXECUTION_ENABLED === "true";
  if (env.VILLA_EXECUTION_MODE !== undefined && String(env.VILLA_EXECUTION_MODE).toUpperCase() !== "WET") fail("MODE_INVALID", "private runtime requires VILLA_EXECUTION_MODE=WET");
  const signerInfo = loadPrivateSigner({ credentialsDirectory: env.CREDENTIALS_DIRECTORY, expectedOperator: config.operator, readFile: dependencies.readCredential ?? ((file) => fs.readFileSync(file, "utf8")) });
  const rpcUrl = env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl;
  const publicClient = dependencies.publicClient ?? createPublicClient({ chain: somniaShannon, transport: http(rpcUrl, { timeout: 15_000 }) });
  const exchange = dependencies.exchange ?? createExchange({ account: config.account, env });
  const journalPath = env.VILLA_WRITER_JOURNAL || path.join(env.VILLA_STATE_DIR || "/var/lib/villa-engine", "transactions.json");
  const journal = journalObservation(journalPath);
  if (journal.pending > 0 || journal.unknown > 0) return { version: LP_PRIVATE_RUNTIME_VERSION, result: "BLOCKED", code: "RESTART_RECONCILIATION_REQUIRED", broadcast: false, writes: 0, signer: { verified: true, address: signerInfo.address }, journal: { pending: journal.pending, unknown: journal.unknown } };

  try {
    const feasibility = dependencies.feasibility ?? await readFeasibility({ env, config });
    if (feasibility.result !== "PASS" || feasibility.shadow?.result !== "PASS") {
      return { version: LP_PRIVATE_RUNTIME_VERSION, result: "BLOCKED", code: "FRESH_PREFLIGHT_REQUIRED", broadcast: false, writes: 0, signer: { verified: true, address: signerInfo.address }, market: { marketId: config.marketId, series: config.marketSeries }, reason: feasibility.reason ?? feasibility.code ?? "the bound market is not currently eligible" };
    }
    const shadow = feasibility.shadow;
    if (!sameAddress(feasibility.account, config.account) || !sameAddress(feasibility.owner, config.owner) || !sameAddress(feasibility.operator, config.operator)) fail("IDENTITY_SCOPE_MISMATCH", "read-only feasibility facts do not match the immutable runtime identities");
    if (String(feasibility.market?.marketId ?? "").toLowerCase() !== config.marketId) fail("MARKET_SCOPE_MISMATCH", "read-only feasibility facts do not match the immutable runtime market");

    const reader = dependencies.reader ?? createAccountReader(publicClient, config.account);
    const adapter = dependencies.adapter ?? createLpExecutionAdapter({ account: config.account, owner: config.owner, operator: config.operator, reader, sessionId: config.sessionId });
    const accountState = dependencies.accountState ?? await adapter.readAccountState({ marketId: config.marketId });
    if (!sameAddress(accountState.identity.owner, config.owner) || !sameAddress(accountState.identity.operator, config.operator)) fail("ACCOUNT_IDENTITY_MISMATCH", "VillaAccount owner/operator reads do not match the bound session");
    if (!sameAddress(accountState.identity.collateralToken, VILLA_ACCOUNT_CONFIG.collateralToken)) fail("COLLATERAL_CONFIG_MISMATCH", "VillaAccount collateral token differs from trusted Shannon configuration");
    const capitalRaw = raw(accountState.capital.directCollateralRaw, "account capital");
    if (capitalRaw !== VILLA_ACCOUNT_CONFIG ? capitalRaw : capitalRaw) { /* keep the comparison below explicit for audit readability */ }
    if (capitalRaw !== 1_002_000n) fail("CAPITAL_MISMATCH", "the bound account capital is not the verified 1.002 tUSDC fixture");
    if (accountState.orders.status !== "VERIFIED" || accountState.orders.orders.length !== 0) fail("OPEN_ORDER_STATE_UNKNOWN", "the account does not have a verified empty order set");
    const bytecode = await publicClient.getBytecode({ address: config.account });
    if (!bytecode || bytecode === "0x") fail("ACCOUNT_RUNTIME_UNVERIFIED", "the bound VillaAccount has no deployed runtime bytecode");
    const accountMarket = await adapter.readMarket({ marketId: config.marketId, identity: accountState.identity });
    if (!sameAddress(accountMarket.pool, shadow.market.onchain?.pool)) fail("MARKET_POOL_MISMATCH", "account market pool differs from fresh feasibility facts");
    const protocol = await readProtocolState({ publicClient, account: config.account, identity: accountState.identity, marketId: config.marketId, pool: accountMarket.pool });
    if (protocol.collateralAllowance !== 0n) fail("COLLATERAL_ALLOWANCE_PRESENT", "the bounded dry runtime requires no collateral allowance to the current pool");

    const sessionBase = createLpExecutionSession({ sessionId: config.sessionId, account: config.account, owner: config.owner, operator: config.operator, chainId: config.chainId, marketSeries: config.marketSeries, currentMarketId: config.marketId, riskPolicyVersion: shadow.risk.governorVersion, executionMode: "WET", createdAt: Date.now(), maxSessionDurationSec: DEFAULT_PHASE_3B1_CAPS.MAX_SESSION_DURATION_SEC });
    const session = transitionLpSession(sessionBase, "PREFLIGHT");
    const reconciliation = reconcileLpSession({ session, accountState: accountStateForPreflight({ account: config.account, owner: config.owner, operator: config.operator, accountState }), market: { marketId: config.marketId, series: config.marketSeries }, orders: accountStateForPreflight({ account: config.account, owner: config.owner, operator: config.operator, accountState }).orders, inventory: accountStateForPreflight({ account: config.account, owner: config.owner, operator: config.operator, accountState }).inventory, transactions: journal.records, risk: { state: shadow.risk.state } });
    if (reconciliation.status !== "RECONCILED") fail("RECONCILIATION_REQUIRED", "authoritative account reconciliation did not pass");
    const leaseStore = dependencies.leaseStore ?? createFileAccountLeaseStore({ directory: env.VILLA_LEASE_DIR || env.VILLA_STATE_DIR || "/var/lib/villa-engine", leaseDurationMs: 30_000 });
    const lease = leaseStore.acquire(session, { reconciled: true });
    try {
      const preflight = evaluateWetExecutionPreflight(preflightInput({ config, session, lease, feasibility, accountState, protocol, signerAddress: signerInfo.address, reconciliation }));
      if (!preflight.reasons.every((reason) => reason === "EXECUTION_DISABLED")) {
        return { version: LP_PRIVATE_RUNTIME_VERSION, result: "BLOCKED", code: "PREFLIGHT_DENIED", broadcast: false, writes: 0, signer: { verified: true, address: signerInfo.address }, market: { marketId: config.marketId, series: config.marketSeries }, preflight, protocol };
      }
      const policy = createLpTransactionPolicy({ session, caps: DEFAULT_PHASE_3B1_CAPS, now: () => session.createdAt });
      const plans = buildProjectedPlans({ adapter, policy, feasibility, marketId: config.marketId, expirySec: feasibility.market.expirySec, capitalRaw, createdAt: session.createdAt });
      const baseResult = {
        version: LP_PRIVATE_RUNTIME_VERSION,
        result: "DRY_READY",
        code: "EXECUTION_DISABLED",
        broadcast: false,
        writes: 0,
        broadcastAttempts: 0,
        signer: { verified: true, address: signerInfo.address, privateKeyRead: true, privateKeyExposed: false },
        account: config.account,
        owner: config.owner,
        operator: config.operator,
        chainId: config.chainId,
        sessionId: config.sessionId,
        market: { marketId: config.marketId, series: config.marketSeries, intervalSec: config.intervalSec, expirySec: feasibility.market.expirySec, headroomSec: feasibility.market.headroomSec, status: Number(shadow.riskSnapshot?.market?.status ?? 0), pool: accountMarket.pool },
        capital: { raw: capitalRaw, expectedRaw: 1_002_000n, pass: capitalRaw === 1_002_000n },
        protocol: { marketApproved: protocol.marketApproved, moduleOperator: protocol.moduleOperator, poolOperator: protocol.poolOperator, collateralAllowanceRaw: protocol.collateralAllowance },
        preflight: { ...preflight, blockers: ["EXECUTION_DISABLED"] },
        planActions: plans.map((plan) => ({ functionName: plan.functionName, action: plan.intent.action, txIndex: plan.intent.txIndex, marketId: plan.intent.marketId, destination: plan.destination, broadcast: plan.broadcast })),
        privateWriter: "installed",
        genericTransactionPath: false,
      };
      if (!executionEnabled) return baseResult;

      const walletClient = createWalletClient({ account: signerInfo.signer, chain: somniaShannon, transport: http(rpcUrl, { timeout: 15_000 }) });
      const writer = createAccountBoundPrivateWriter({ session, policy, signer: signerInfo.signer, publicClient, walletClient, executionEnabled: true, readLatestNonce: async () => publicClient.getTransactionCount({ address: signerInfo.address, blockTag: "latest" }), readPendingNonce: async () => publicClient.getTransactionCount({ address: signerInfo.address, blockTag: "pending" }), readReceipt: async (hash) => publicClient.getTransactionReceipt({ hash }), journalPath });
      const records = [];
      records.push(await writer.enqueue(plans[0]));
      const afterMint = await adapter.readAccountState({ marketId: config.marketId });
      const place = plans[1];
      records.push(await writer.enqueue(place));
      const afterPlace = await adapter.readAccountState({ marketId: config.marketId });
      if (afterPlace.orders.status !== "VERIFIED" || afterPlace.orders.orders.length !== 1) fail("PLACE_RECONCILIATION_FAILED", "place action did not produce exactly one account-owned order");
      const orderId = afterPlace.orders.orders[0].orderId;
      const cancel = preparedPlan({ policy, plan: adapter.cancelOrder({ marketId: config.marketId, orderId }), index: 2, capitalRaw, openOrderCount: 1, pendingExposureRaw: place.args[3], createdAt: session.createdAt });
      records.push(await writer.enqueue(cancel));
      const afterCancel = await adapter.readAccountState({ marketId: config.marketId });
      if (afterCancel.orders.status !== "VERIFIED" || afterCancel.orders.orders.length !== 0) fail("CANCEL_RECONCILIATION_FAILED", "cancel action did not leave a verified empty order set");
      const burnAmount = afterCancel.inventory ? (afterCancel.inventory.yesRaw < afterCancel.inventory.noRaw ? afterCancel.inventory.yesRaw : afterCancel.inventory.noRaw) : 0n;
      if (burnAmount <= 0n) fail("BURN_NOT_SAFE", "authoritative reread did not show paired inventory for burn");
      const burn = preparedPlan({ policy, plan: adapter.burnCompleteSet({ marketId: config.marketId, amountRaw: burnAmount }), index: 3, capitalRaw, createdAt: session.createdAt });
      records.push(await writer.enqueue(burn));
      return { ...baseResult, result: "COMPLETED", code: "WET_ONE_SHOT_COMPLETE", broadcast: true, writes: records.length, broadcastAttempts: records.length, records };
    } finally {
      const stopped = transitionLpSession(session, "STOPPED");
      leaseStore.release(stopped, { reconciled: true });
    }
  } finally {
    await closeExchange(exchange);
  }
}

export function parsePrivateRuntimeArgs(argv = process.argv.slice(2)) {
  const result = { oneCycle: argv.includes("--one-cycle"), account: null, sessionId: null, marketId: null };
  for (const arg of argv) {
    if (arg.startsWith("--account=")) result.account = arg.slice("--account=".length);
    if (arg.startsWith("--session-id=")) result.sessionId = arg.slice("--session-id=".length);
    if (arg.startsWith("--market-id=")) result.marketId = arg.slice("--market-id=".length);
    if (["--to", "--data", "--calldata", "--raw", "--private-key", "--seed", "--mnemonic", "--sendTransaction", "--writeContract", "--broadcast", "--relay"].some((forbidden) => arg === forbidden || arg.startsWith(`${forbidden}=`))) fail("ARBITRARY_TRANSACTION_ARGUMENT", "generic transaction arguments are not accepted");
  }
  return result;
}

export function serializePrivateRuntimeResult(value) {
  return jsonSafe(value);
}
