/**
 * Private, one-shot cleanup for the confirmed f920 complete-set residual.
 *
 * This module intentionally has no market discovery, quote, mint, order,
 * cancel, redeem, withdrawal, or rollover path. It can only prepare and send
 * the exact account-bound operatorBurnSet required by Phase 3B1B2.2.
 */

import * as fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { VILLA_ACCOUNT_CONFIG } from "../../dashboard/account-config.mjs";
import {
  createLpExecutionAdapter,
  createViemLpAccountReader,
  VILLA_ACCOUNT_READ_ABI,
  VILLA_ACCOUNT_OPERATOR_ABI,
} from "./lp-adapter.mjs";
import { loadPrivateSigner } from "./lp-private-runtime.mjs";
import { createAccountBoundPrivateWriter } from "./lp-private-writer.mjs";
import { reconcileDurableJournal } from "./lp-recovery.mjs";
import { createFileAccountLeaseStore, createLpExecutionSession, transitionLpSession, attachLease } from "./lp-session.mjs";
import { DEFAULT_PHASE_3B1_CAPS, createLpTransactionPolicy } from "./lp-transaction-policy.mjs";

export const LP_PRIVATE_CLEANUP_VERSION = "villa-private-cleanup-v1";
export const LP_CLEANUP_SCOPE = Object.freeze({
  chainId: 50312,
  account: "0x3a46446a30f945d390a41daab0d390fbef3d2cf2",
  owner: "0xefe0412781d3c1e7888b2db9deeca3037542494d",
  operator: "0xaf4ee6c0c6ff6337f4c4f07b87c8343df73e8d37",
  marketId: "0x000000000000000000000000000000000000000000000000000000000000f920",
  marketSeries: "BINARY:BTC:86400",
  amountRaw: 1000n,
  collateralRawBefore: 1001000n,
  collateralRawAfter: 1002000n,
  priorMintHash: "0xbe4803335f4ddb6aa64625086bf087c7ed5f309e7b818efd6e09cd75f7026ef0",
});

const OUTCOME_OPERATOR_ABI = Object.freeze([
  { type: "function", name: "isOperator", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "bool" }] },
]);
const ERC20_ALLOWANCE_ABI = Object.freeze([
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
]);
const POOL_OWN_ORDERS_ABI = Object.freeze([
  { type: "function", name: "getOwnOpenOrders", stateMutability: "view", inputs: [], outputs: [{ type: "uint128[]" }] },
]);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export class LpPrivateCleanupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LpPrivateCleanupError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new LpPrivateCleanupError(code, message);
}

function normalizedAddress(value, label) {
  const text = String(value ?? "");
  if (!ADDRESS_RE.test(text) || !isAddress(text)) fail("ADDRESS_INVALID", `${label} must be a valid address`);
  return text.toLowerCase();
}

function normalizedBytes32(value, label) {
  const text = String(value ?? "");
  if (!BYTES32_RE.test(text)) fail("BYTES32_INVALID", `${label} must be bytes32`);
  return text.toLowerCase();
}

function sameAddress(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function sameId(left, right) {
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

function assertNoSignerEnvironment(env) {
  for (const name of ["OPERATOR_PRIVATE_KEY", "TAKER_PRIVATE_KEY", "PRIVATE_KEY", "WALLET_SEED", "MNEMONIC"]) {
    if (env?.[name]) fail("SIGNER_ENV_FORBIDDEN", `${name} must not be supplied to the cleanup runtime environment`);
  }
}

function cleanupConfig(env, args) {
  assertNoSignerEnvironment(env);
  const account = normalizedAddress(env.VILLA_ENGINE_ACCOUNT ?? args.account, "VillaAccount");
  const owner = normalizedAddress(env.VILLA_ENGINE_OWNER, "LP owner");
  const operator = normalizedAddress(env.VILLA_ENGINE_OPERATOR ?? env.OPERATOR_ADDRESS, "VILLA operator");
  const marketId = normalizedBytes32(env.VILLA_ENGINE_MARKET_ID ?? args.marketId, "marketId");
  const sessionId = String(env.VILLA_ENGINE_SESSION_ID ?? args.sessionId ?? "");
  const chainId = Number(env.VILLA_ENGINE_CHAIN_ID ?? LP_CLEANUP_SCOPE.chainId);
  if (account !== LP_CLEANUP_SCOPE.account || owner !== LP_CLEANUP_SCOPE.owner || operator !== LP_CLEANUP_SCOPE.operator || marketId !== LP_CLEANUP_SCOPE.marketId) {
    fail("CLEANUP_SCOPE_MISMATCH", "cleanup is restricted to the canonical owner, VillaAccount, operator, and f920 market");
  }
  if (chainId !== LP_CLEANUP_SCOPE.chainId) fail("CHAIN_SCOPE_MISMATCH", "cleanup is restricted to Somnia Shannon 50312");
  if (!sessionId) fail("SESSION_REQUIRED", "a specific cleanup session id is required");
  if (args.account && !sameAddress(args.account, account)) fail("ACCOUNT_SCOPE_MISMATCH", "CLI account differs from the canonical cleanup account");
  if (args.marketId && normalizedBytes32(args.marketId, "CLI marketId") !== marketId) fail("MARKET_SCOPE_MISMATCH", "CLI market differs from f920");
  if (args.sessionId && args.sessionId !== sessionId) fail("SESSION_SCOPE_MISMATCH", "CLI session differs from the cleanup session");
  return Object.freeze({ account, owner, operator, marketId, chainId, sessionId, marketSeries: LP_CLEANUP_SCOPE.marketSeries });
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

async function closeExchange(exchange) {
  if (!exchange || typeof exchange.close !== "function") return;
  await Promise.race([exchange.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 500))]);
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

function marketIsExpiredAndResolved({ market, chainNowSec }) {
  const expiry = raw(market?.expiry, "market expiry");
  const status = Number(market?.status);
  const resolved = Boolean(market?.isResolved) || status === 4 || status === 5;
  return resolved && expiry <= BigInt(chainNowSec);
}

function preflightSummary({ config, signerAddress, accountState, protocol, market, chainNowSec }) {
  return {
    account: config.account,
    owner: config.owner,
    operator: config.operator,
    signer: signerAddress,
    chainId: config.chainId,
    marketId: config.marketId,
    marketStatus: Number(market.status),
    marketResolved: Boolean(market.isResolved) || [4, 5].includes(Number(market.status)),
    marketExpiry: raw(market.expiry, "market expiry"),
    chainNowSec,
    capitalRaw: accountState.capital.directCollateralRaw,
    vaultRaw: accountState.capital.vaultRaw,
    yesRaw: accountState.inventory.yesRaw,
    noRaw: accountState.inventory.noRaw,
    openOrders: accountState.orders.orders.length,
    unknownTx: 0,
    unknownOrders: 0,
    marketApproved: protocol.marketApproved,
    moduleOperator: protocol.moduleOperator,
    poolOperator: protocol.poolOperator,
    collateralAllowanceRaw: protocol.collateralAllowance,
    burnAmountRaw: LP_CLEANUP_SCOPE.amountRaw,
    simulation: "PASS",
  };
}

async function readChainNowSec(publicClient, dependencies) {
  if (dependencies.chainNowSec !== undefined) return Number(dependencies.chainNowSec);
  const block = await publicClient.getBlock({ blockTag: "latest" });
  return Number(block.timestamp);
}

async function validateCleanupPreflight({ config, signerInfo, publicClient, exchange, adapter, journal, dependencies }) {
  if (journal.pending > 0 || journal.unknown > 0) fail("RESTART_RECONCILIATION_REQUIRED", "an unresolved transaction remains in the durable journal");
  if (journal.reverted > 0) fail("REVERTED_TRANSACTION", "a previous transaction reverted and requires director review");
  const priorMint = journal.records.filter((record) => record.state === "CONFIRMED" && record.action === "MINT_COMPLETE_SET" && sameId(record.hash, LP_CLEANUP_SCOPE.priorMintHash));
  if (priorMint.length !== 1 || raw(priorMint[0].amountRaw, "prior mint amount") !== LP_CLEANUP_SCOPE.amountRaw) fail("MINT_PROVENANCE_MISMATCH", "the exact confirmed f920 mint provenance was not reconciled");

  const accountState = dependencies.accountState ?? await adapter.readAccountState({ marketId: config.marketId });
  const observedChainId = dependencies.chainId ?? (typeof publicClient.getChainId === "function" ? await publicClient.getChainId() : config.chainId);
  if (Number(observedChainId) !== config.chainId) fail("CHAIN_SCOPE_MISMATCH", "authoritative RPC chain is not Somnia Shannon 50312");
  if (!sameAddress(accountState.identity.owner, config.owner) || !sameAddress(accountState.identity.operator, config.operator)) fail("ACCOUNT_IDENTITY_MISMATCH", "VillaAccount owner/operator does not match the cleanup scope");
  if (!sameAddress(accountState.identity.collateralToken, VILLA_ACCOUNT_CONFIG.collateralToken)) fail("COLLATERAL_CONFIG_MISMATCH", "VillaAccount collateral token differs from trusted Shannon configuration");
  if (raw(accountState.capital.directCollateralRaw, "direct collateral") !== LP_CLEANUP_SCOPE.collateralRawBefore || raw(accountState.capital.vaultRaw ?? 0n, "vault credit") !== 0n) fail("CAPITAL_MISMATCH", "collateral is not the expected 1,001,000 raw cleanup pre-state");
  if (raw(accountState.inventory.yesRaw, "YES inventory") !== LP_CLEANUP_SCOPE.amountRaw || raw(accountState.inventory.noRaw, "NO inventory") !== LP_CLEANUP_SCOPE.amountRaw || !sameId(accountState.inventory.marketId, config.marketId)) fail("INVENTORY_SCOPE_MISMATCH", "the exact paired f920 inventory was not observed");
  if (accountState.orders.status !== "VERIFIED" || accountState.orders.orders.length !== 0) fail("OPEN_ORDER_STATE_UNKNOWN", "the account does not have a verified empty order set");
  const bytecode = dependencies.bytecode ?? await publicClient.getBytecode({ address: config.account });
  if (!bytecode || bytecode === "0x") fail("ACCOUNT_RUNTIME_UNVERIFIED", "the bound VillaAccount has no deployed runtime bytecode");

  const accountMarket = dependencies.accountMarket ?? await adapter.readMarket({ marketId: config.marketId, identity: accountState.identity });
  if (raw(accountState.inventory.yesId, "inventory YES token") !== raw(accountMarket.yesId, "market YES token") || raw(accountState.inventory.noId, "inventory NO token") !== raw(accountMarket.noId, "market NO token")) fail("INVENTORY_TOKEN_SCOPE_MISMATCH", "paired inventory token IDs do not match the exact f920 market");
  const chainMarket = dependencies.marketOnchain ?? await exchange.client.getMarketOnchain(config.marketId);
  if (!chainMarket || !sameId(chainMarket.marketId ?? config.marketId, config.marketId)) fail("MARKET_SCOPE_MISMATCH", "authoritative market read does not match f920");
  if (!sameAddress(accountMarket.pool, chainMarket.pool)) fail("MARKET_POOL_MISMATCH", "VillaAccount market pool differs from authoritative market pool");
  const chainNowSec = await readChainNowSec(publicClient, dependencies);
  if (!marketIsExpiredAndResolved({ market: chainMarket, chainNowSec })) fail("MARKET_NOT_RESOLVED", "f920 is not currently both expired and resolved");
  const protocol = dependencies.protocol ?? await readProtocolState({ publicClient, account: config.account, identity: accountState.identity, marketId: config.marketId, pool: accountMarket.pool });
  if (!protocol.marketApproved || !protocol.moduleOperator || !protocol.poolOperator) fail("PROTOCOL_APPROVAL_MISSING", "required account-bound market/operator approvals are not present");
  if (protocol.collateralAllowance !== 0n) fail("COLLATERAL_ALLOWANCE_PRESENT", "cleanup requires zero collateral allowance to the target pool");

  const simulationRequest = {
    account: signerInfo.signer,
    address: config.account,
    abi: VILLA_ACCOUNT_OPERATOR_ABI,
    functionName: "operatorBurnSet",
    args: [config.marketId, LP_CLEANUP_SCOPE.amountRaw],
    value: 0n,
  };
  let simulation;
  try {
    simulation = dependencies.simulateBurn
      ? await dependencies.simulateBurn(simulationRequest)
      : await publicClient.simulateContract(simulationRequest);
  } catch (error) {
    if (String(error?.message ?? error).includes("0xe45efb5f")) fail("BURN_UNAVAILABLE", "operatorBurnSet simulation reverted with MarketNotCurrent() (0xe45efb5f): the f920 pool is finalized, so _currentPool rejects the burn");
    throw error;
  }
  return { accountState, accountMarket, chainMarket, protocol, chainNowSec, simulation, summary: preflightSummary({ config, signerAddress: signerInfo.address, accountState, protocol, market: chainMarket, chainNowSec }) };
}

async function readPostBurnState({ adapter, config }) {
  const accountState = await adapter.readAccountState({ marketId: config.marketId });
  if (accountState.orders.status !== "VERIFIED" || accountState.orders.orders.length !== 0) fail("POST_BURN_ORDERS_NOT_EMPTY", "post-burn account-owned orders are not verified empty");
  return accountState;
}

export async function runPrivateLpCleanup({ env = process.env, args = {}, dependencies = {} } = {}) {
  const config = cleanupConfig(env, args);
  if (args.confirmCleanup !== true) fail("CLEANUP_CONFIRM_REQUIRED", "the cleanup entrypoint requires --confirm-cleanup");
  if (env.VILLA_EXECUTION_MODE !== undefined && String(env.VILLA_EXECUTION_MODE).toUpperCase() !== "WET") fail("MODE_INVALID", "cleanup requires VILLA_EXECUTION_MODE=WET");
  const executionEnabled = env.VILLA_EXECUTION_ENABLED === "true";
  const signerInfo = dependencies.signerInfo ?? loadPrivateSigner({ credentialsDirectory: env.CREDENTIALS_DIRECTORY, expectedOperator: config.operator, readFile: dependencies.readCredential ?? ((file) => fs.readFileSync(file, "utf8")) });
  const publicClient = dependencies.publicClient ?? createPublicClient({ chain: somniaShannon, transport: http(env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl, { timeout: 15_000 }) });
  const exchange = dependencies.exchange ?? createExchange({ account: config.account, env });
  const reader = dependencies.reader ?? createAccountReader(publicClient, config.account);
  const baseAdapter = dependencies.adapter ?? createLpExecutionAdapter({ account: config.account, owner: config.owner, operator: config.operator, reader, sessionId: config.sessionId });
  const adapter = typeof baseAdapter.readMarket === "function"
    ? baseAdapter
    : Object.freeze({ ...baseAdapter, readMarket: (input = {}) => reader.readMarket({ ...input, account: config.account }) });
  const journalPath = env.VILLA_WRITER_JOURNAL || path.join(env.VILLA_STATE_DIR || "/var/lib/villa-engine", "transactions.json");
  const leaseStore = dependencies.leaseStore ?? createFileAccountLeaseStore({ directory: env.VILLA_LEASE_DIR || env.VILLA_STATE_DIR || "/var/lib/villa-engine", leaseDurationMs: 30_000 });
  let activeSession = null;
  let lease = null;
  let writer = null;
  let safeToReleaseLease = false;
  try {
    let journal = await reconcileDurableJournal({ journalPath, publicClient, config });
    await validateCleanupPreflight({ config, signerInfo, publicClient, exchange, adapter, journal, dependencies });
    const sessionBase = createLpExecutionSession({ sessionId: config.sessionId, account: config.account, owner: config.owner, operator: config.operator, chainId: config.chainId, marketSeries: config.marketSeries, currentMarketId: config.marketId, riskPolicyVersion: "villa-cleanup-only-v1", executionMode: "WET", createdAt: Date.now(), maxSessionDurationSec: DEFAULT_PHASE_3B1_CAPS.MAX_SESSION_DURATION_SEC });
    const session = transitionLpSession(sessionBase, "PREFLIGHT");
    const existingLease = leaseStore.get(config.account);
    if (existingLease && Number(existingLease.expiresAt) > Date.now()) fail("ACCOUNT_LEASE_HELD", "an active account lease already exists");
    lease = leaseStore.acquire(session, { reconciled: true });
    activeSession = attachLease(session, lease);

    journal = await reconcileDurableJournal({ journalPath, publicClient, config });
    const finalPreflight = await validateCleanupPreflight({ config, signerInfo, publicClient, exchange, adapter, journal, dependencies });
    const policy = createLpTransactionPolicy({ session: activeSession, caps: DEFAULT_PHASE_3B1_CAPS, now: () => activeSession.createdAt });
    const plan = adapter.burnCompleteSet({ marketId: config.marketId, amountRaw: LP_CLEANUP_SCOPE.amountRaw });
    const prepared = policy.prepare(plan, { txIndex: 0, createdAt: activeSession.createdAt });
    const validation = policy.validate(prepared, { nowMs: activeSession.createdAt });
    if (!validation.allowed) fail(validation.code ?? "POLICY_DENIED", validation.reason ?? "cleanup burn was denied by policy");

    if (!executionEnabled) {
      safeToReleaseLease = true;
      return { version: LP_PRIVATE_CLEANUP_VERSION, result: "CLEANUP_READY", code: "EXECUTION_DISABLED", broadcast: false, writes: 0, signer: { verified: true, address: signerInfo.address }, sessionId: config.sessionId, marketId: config.marketId, preflight: finalPreflight.summary, action: "operatorBurnSet", amountRaw: LP_CLEANUP_SCOPE.amountRaw, plan: { functionName: prepared.functionName, destination: prepared.destination, broadcast: prepared.broadcast }, final: { collateralRaw: finalPreflight.accountState.capital.directCollateralRaw, yesRaw: finalPreflight.accountState.inventory.yesRaw, noRaw: finalPreflight.accountState.inventory.noRaw, openOrders: finalPreflight.accountState.orders.orders.length }, execution: "DISABLED" };
    }

    activeSession = transitionLpSession(activeSession, "RUNNING");
    const walletClient = dependencies.walletClient ?? createWalletClient({ account: signerInfo.signer, chain: somniaShannon, transport: http(env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl, { timeout: 15_000 }) });
    writer = createAccountBoundPrivateWriter({ session: activeSession, lease: { ...lease, held: true }, policy, signer: signerInfo.signer, publicClient, walletClient, executionEnabled: true, readLatestNonce: async () => publicClient.getTransactionCount({ address: signerInfo.address, blockTag: "latest" }), readPendingNonce: async () => publicClient.getTransactionCount({ address: signerInfo.address, blockTag: "pending" }), readReceipt: async (hash) => publicClient.getTransactionReceipt({ hash }), journalPath });
    const record = await writer.enqueue(prepared);
    if (record.state !== "CONFIRMED") fail("BURN_NOT_CONFIRMED", "cleanup burn did not return an authoritative confirmed receipt");
    const after = await readPostBurnState({ adapter, config });
    const finalJournal = await reconcileDurableJournal({ journalPath, publicClient, config });
    if (finalJournal.pending > 0 || finalJournal.unknown > 0) fail("POST_BURN_RECONCILIATION_REQUIRED", "post-burn journal is not authoritatively reconciled");
    safeToReleaseLease = true;
    return { version: LP_PRIVATE_CLEANUP_VERSION, result: "COMPLETED", code: "CLEANUP_BURN_CONFIRMED", broadcast: true, writes: 1, signer: { verified: true, address: signerInfo.address }, sessionId: config.sessionId, marketId: config.marketId, preflight: finalPreflight.summary, action: "operatorBurnSet", amountRaw: LP_CLEANUP_SCOPE.amountRaw, burn: { hash: record.hash, state: record.state, receiptStatus: record.receiptStatus, receiptBlock: record.receiptBlock }, final: { collateralRaw: after.capital.directCollateralRaw, vaultRaw: after.capital.vaultRaw, yesRaw: after.inventory.yesRaw, noRaw: after.inventory.noRaw, openOrders: after.orders.orders.length }, execution: "TEMPORARILY_ARMED_THEN_DISABLED" };
  } finally {
    if (lease && activeSession && safeToReleaseLease) {
      const stopping = activeSession.state === "RUNNING" ? transitionLpSession(activeSession, "STOPPING") : activeSession;
      const stopped = transitionLpSession(stopping, "STOPPED");
      try { leaseStore.release(stopped, { reconciled: true }); } catch { /* preserve a lease if another process changed it */ }
    }
    if (writer) writer.close();
    await closeExchange(exchange);
  }
}

export function serializePrivateCleanupResult(value) {
  return jsonSafe(value);
}

export function parsePrivateCleanupArgs(argv = process.argv.slice(2)) {
  const result = { confirmCleanup: argv.includes("--confirm-cleanup"), account: null, sessionId: null, marketId: null };
  for (const arg of argv) {
    if (arg.startsWith("--account=")) result.account = arg.slice("--account=".length);
    if (arg.startsWith("--session-id=")) result.sessionId = arg.slice("--session-id=".length);
    if (arg.startsWith("--market-id=")) result.marketId = arg.slice("--market-id=".length);
    if (["--to", "--data", "--calldata", "--raw", "--private-key", "--seed", "--mnemonic", "--sendTransaction", "--writeContract", "--broadcast", "--relay", "--redeem", "--withdraw", "--place-order", "--mint"].some((forbidden) => arg === forbidden || arg.startsWith(`${forbidden}=`))) fail("ARBITRARY_TRANSACTION_ARGUMENT", "generic or non-cleanup transaction arguments are not accepted");
  }
  return result;
}
