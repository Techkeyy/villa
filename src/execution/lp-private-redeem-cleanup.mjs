/**
 * Private, one-shot settlement cleanup for the confirmed f920 residual.
 *
 * This module intentionally has one write path: the account-bound
 * operatorRedeem for the authoritative winning outcome. It has no market
 * discovery, mint, order, burn, vault claim, withdrawal, or retry path.
 */

import * as fs from "node:fs";
import path from "node:path";
import { createPublicClient, createWalletClient, http, isAddress } from "viem";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { VILLA_ACCOUNT_CONFIG } from "../../dashboard/account-config.mjs";
import {
  createLpExecutionAdapter,
  createViemLpAccountReader,
  VILLA_ACCOUNT_READ_ABI,
  VILLA_ACCOUNT_MARKET_ABI,
  VILLA_ACCOUNT_OPERATOR_ABI,
} from "./lp-adapter.mjs";
import {
  PAYOUT_DENOMINATOR_RAW,
  classifyMarketState,
  payoutForOutcome,
} from "../settlement/index.mjs";
import { loadPrivateSigner } from "./lp-private-runtime.mjs";
import { createAccountBoundPrivateWriter } from "./lp-private-writer.mjs";
import { reconcileDurableJournal } from "./lp-recovery.mjs";
import { createFileAccountLeaseStore, createLpExecutionSession, transitionLpSession, attachLease } from "./lp-session.mjs";
import { DEFAULT_PHASE_3B1_CAPS, createLpTransactionPolicy } from "./lp-transaction-policy.mjs";

export const LP_PRIVATE_REDEEM_CLEANUP_VERSION = "villa-private-redeem-cleanup-v1";
export const LP_REDEEM_CLEANUP_SCOPE = Object.freeze({
  chainId: 50312,
  account: "0x3a46446a30f945d390a41dAab0D390fBEf3d2cF2".toLowerCase(),
  owner: "0xefe0412781d3c1e7888b2db9deeca3037542494d".toLowerCase(),
  operator: "0xaf4ee6c0c6ff6337f4c4f07b87c8343df73e8d37".toLowerCase(),
  marketId: "0x000000000000000000000000000000000000000000000000000000000000f920",
  marketSeries: "BINARY:BTC:86400",
  outcomeIdx: 1,
  amountRaw: 1_000n,
  collateralRawBefore: 1_001_000n,
  priorMintHash: "0xbe4803335f4ddb6aa64625086bf087c7ed5f309e7b818efd6e09cd75f7026ef0",
});

const MARKET_SETTLEMENT_ABI = Object.freeze([
  { type: "function", name: "status", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "isResolved", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "isVoided", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "payoutNumerators", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] },
]);
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

export class LpPrivateRedeemCleanupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LpPrivateRedeemCleanupError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new LpPrivateRedeemCleanupError(code, message);
}

function normalizedAddress(value, label) {
  const text = String(value ?? "");
  if (!ADDRESS_RE.test(text) || !isAddress(text)) fail("ADDRESS_INVALID", label + " must be a valid address");
  return text.toLowerCase();
}

function normalizedBytes32(value, label) {
  const text = String(value ?? "");
  if (!BYTES32_RE.test(text)) fail("BYTES32_INVALID", label + " must be bytes32");
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
    fail("RAW_INVALID", label + " must be a non-negative raw integer");
  }
}

function jsonSafe(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function assertNoSignerEnvironment(env) {
  for (const name of ["OPERATOR_PRIVATE_KEY", "TAKER_PRIVATE_KEY", "PRIVATE_KEY", "WALLET_SEED", "MNEMONIC"]) {
    if (env?.[name]) fail("SIGNER_ENV_FORBIDDEN", name + " must not be supplied to the redeem cleanup runtime environment");
  }
}

function redeemConfig(env, args) {
  assertNoSignerEnvironment(env);
  const account = normalizedAddress(env.VILLA_ENGINE_ACCOUNT ?? args.account, "VillaAccount");
  const owner = normalizedAddress(env.VILLA_ENGINE_OWNER, "LP owner");
  const operator = normalizedAddress(env.VILLA_ENGINE_OPERATOR ?? env.OPERATOR_ADDRESS, "VILLA operator");
  const marketId = normalizedBytes32(env.VILLA_ENGINE_MARKET_ID ?? args.marketId, "marketId");
  const sessionId = String(env.VILLA_ENGINE_SESSION_ID ?? args.sessionId ?? "");
  const chainId = Number(env.VILLA_ENGINE_CHAIN_ID ?? LP_REDEEM_CLEANUP_SCOPE.chainId);
  if (account !== LP_REDEEM_CLEANUP_SCOPE.account || owner !== LP_REDEEM_CLEANUP_SCOPE.owner || operator !== LP_REDEEM_CLEANUP_SCOPE.operator || marketId !== LP_REDEEM_CLEANUP_SCOPE.marketId) {
    fail("REDEEM_SCOPE_MISMATCH", "cleanup is restricted to the canonical owner, VillaAccount, operator, and f920 market");
  }
  if (chainId !== LP_REDEEM_CLEANUP_SCOPE.chainId) fail("CHAIN_SCOPE_MISMATCH", "cleanup is restricted to Somnia Shannon 50312");
  if (!sessionId) fail("SESSION_REQUIRED", "a specific redeem cleanup session id is required");
  if (args.account && !sameAddress(args.account, account)) fail("ACCOUNT_SCOPE_MISMATCH", "CLI account differs from the canonical cleanup account");
  if (args.marketId && normalizedBytes32(args.marketId, "CLI marketId") !== marketId) fail("MARKET_SCOPE_MISMATCH", "CLI market differs from f920");
  if (args.sessionId && args.sessionId !== sessionId) fail("SESSION_SCOPE_MISMATCH", "CLI session differs from the redeem cleanup session");
  return Object.freeze({ account, owner, operator, marketId, chainId, sessionId, marketSeries: LP_REDEEM_CLEANUP_SCOPE.marketSeries });
}

function createAccountReader(publicClient, account) {
  return createViemLpAccountReader({
    publicClient,
    listOpenOrderIds: async ({ pool }) => publicClient.readContract({ address: pool, abi: POOL_OWN_ORDERS_ABI, functionName: "getOwnOpenOrders", account }),
  });
}

function createAccountMarketReader(publicClient) {
  return async ({ account, marketId, identity }) => {
    const record = await publicClient.readContract({ address: identity.binaryModule, abi: VILLA_ACCOUNT_MARKET_ABI, functionName: "markets", args: [marketId] });
    const field = (name, index) => record?.[name] ?? record?.[index];
    return {
      account,
      marketId,
      collateral: normalizedAddress(field("collateral", 3), "market collateral"),
      market: normalizedAddress(field("market", 8), "market contract"),
      pool: normalizedAddress(field("pool", 9), "market pool"),
      yesId: raw(field("yesId", 10), "YES token id"),
      noId: raw(field("noId", 11), "NO token id"),
      tradingStart: raw(field("tradingStart", 12), "market trading start"),
      expiry: raw(field("expiry", 13), "market expiry"),
    };
  };
}

function normalizedPayoutVector(value) {
  if (!Array.isArray(value) || value.length !== 2) fail("PAYOUT_VECTOR_INVALID", "authoritative payoutNumerators must contain exactly YES and NO values");
  const vector = value.map((item, index) => raw(item, "payoutNumerators[" + index + "]"));
  if (vector.some((item) => item > PAYOUT_DENOMINATOR_RAW)) fail("PAYOUT_VECTOR_INVALID", "payout numerator exceeds the protocol denominator");
  return vector;
}

export function deriveRedeemClaim({ status, isResolved, isVoided, payoutNumerators, yesRaw, noRaw } = {}) {
  const lifecycle = classifyMarketState({ status: Number(status), isResolved: Boolean(isResolved), isVoided: Boolean(isVoided), finalized: false });
  if (!lifecycle.redeemable) fail("MARKET_NOT_REDEEMABLE", "authoritative market state " + lifecycle.state + " is not redeemable");
  const vector = normalizedPayoutVector(payoutNumerators);
  const yes = raw(yesRaw, "YES inventory");
  const no = raw(noRaw, "NO inventory");
  if (lifecycle.resolution === "RESOLVED") {
    if (vector[0] + vector[1] !== PAYOUT_DENOMINATOR_RAW || vector[0] === vector[1]) fail("RESOLUTION_VECTOR_INVALID", "resolved market payout vector is not an unambiguous full settlement");
    const winnerIdx = vector[0] > vector[1] ? 0 : 1;
    const balances = [yes, no];
    const amountRaw = balances[winnerIdx];
    if (amountRaw === 0n) fail("CLAIM_EMPTY", "the resolved winning outcome balance is already zero");
    return {
      lifecycle,
      vector,
      winnerIdx,
      outcomeIdx: winnerIdx,
      amountRaw,
      redeemableYesValueRaw: payoutForOutcome({ amountRaw: yes || 1n, outcomeIdx: 0, resolution: "RESOLVED", winningOutcome: winnerIdx, payoutNumerators: vector }),
      redeemableNoValueRaw: payoutForOutcome({ amountRaw: no || 1n, outcomeIdx: 1, resolution: "RESOLVED", winningOutcome: winnerIdx, payoutNumerators: vector }),
    };
  }
  const redeemableYesValueRaw = payoutForOutcome({ amountRaw: yes || 1n, outcomeIdx: 0, resolution: "VOIDED", payoutNumerators: vector });
  const redeemableNoValueRaw = payoutForOutcome({ amountRaw: no || 1n, outcomeIdx: 1, resolution: "VOIDED", payoutNumerators: vector });
  const outcomeIdx = redeemableNoValueRaw > 0n && no > 0n ? 1 : redeemableYesValueRaw > 0n && yes > 0n ? 0 : null;
  if (outcomeIdx === null) fail("CLAIM_EMPTY", "the voided market has no positive redeemable outcome balance");
  return { lifecycle, vector, winnerIdx: null, outcomeIdx, amountRaw: outcomeIdx === 1 ? no : yes, redeemableYesValueRaw, redeemableNoValueRaw };
}

async function readSettlement({ publicClient, marketAddress, dependencies }) {
  if (dependencies.settlement) return dependencies.settlement;
  const [status, isResolved, isVoided, payoutNumerators] = await Promise.all([
    publicClient.readContract({ address: marketAddress, abi: MARKET_SETTLEMENT_ABI, functionName: "status" }),
    publicClient.readContract({ address: marketAddress, abi: MARKET_SETTLEMENT_ABI, functionName: "isResolved" }),
    publicClient.readContract({ address: marketAddress, abi: MARKET_SETTLEMENT_ABI, functionName: "isVoided" }),
    publicClient.readContract({ address: marketAddress, abi: MARKET_SETTLEMENT_ABI, functionName: "payoutNumerators" }),
  ]);
  return { status: Number(status), isResolved: Boolean(isResolved), isVoided: Boolean(isVoided), payoutNumerators: normalizedPayoutVector(payoutNumerators) };
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

function summary({ config, signerAddress, accountState, protocol, settlement, claim, accountMarket, chainNowSec }) {
  return {
    account: config.account,
    owner: config.owner,
    operator: config.operator,
    signer: signerAddress,
    chainId: config.chainId,
    marketId: config.marketId,
    marketStatus: Number(settlement.status),
    resolution: settlement.isVoided ? "VOIDED" : settlement.isResolved ? "RESOLVED" : "NOT_REDEEMABLE",
    winningOutcome: claim.winnerIdx,
    payoutNumerators: claim.vector,
    marketExpiry: accountMarket.expiry,
    chainNowSec,
    capitalRaw: accountState.capital.directCollateralRaw,
    vaultRaw: accountState.capital.vaultRaw,
    yesRaw: accountState.inventory.yesRaw,
    noRaw: accountState.inventory.noRaw,
    openOrders: accountState.orders.orders.length,
    marketApproved: protocol.marketApproved,
    moduleOperator: protocol.moduleOperator,
    poolOperator: protocol.poolOperator,
    collateralAllowanceRaw: protocol.collateralAllowance,
    redeemOutcomeIdx: claim.outcomeIdx,
    redeemAmountRaw: claim.amountRaw,
    redeemableYesValueRaw: claim.redeemableYesValueRaw,
    redeemableNoValueRaw: claim.redeemableNoValueRaw,
    expectedCollateralReturnRaw: claim.redeemableYesValueRaw + claim.redeemableNoValueRaw,
    simulation: "PASS",
  };
}

async function readChainNowSec(publicClient, dependencies) {
  if (dependencies.chainNowSec !== undefined) return Number(dependencies.chainNowSec);
  const block = await publicClient.getBlock({ blockTag: "latest" });
  return Number(block.timestamp);
}

async function validateRedeemPreflight({ config, signerInfo, publicClient, adapter, journal, dependencies }) {
  if (journal.pending > 0 || journal.unknown > 0) fail("RESTART_RECONCILIATION_REQUIRED", "an unresolved transaction remains in the durable journal");
  if (journal.reverted > 0) fail("REVERTED_TRANSACTION", "a previous transaction reverted and requires director review");
  const priorMint = journal.records.filter((record) => record.state === "CONFIRMED" && record.action === "MINT_COMPLETE_SET" && sameId(record.hash, LP_REDEEM_CLEANUP_SCOPE.priorMintHash));
  if (priorMint.length !== 1 || raw(priorMint[0].amountRaw, "prior mint amount") !== LP_REDEEM_CLEANUP_SCOPE.amountRaw) fail("MINT_PROVENANCE_MISMATCH", "the exact confirmed f920 mint provenance was not reconciled");
  const redeemRecords = journal.records.filter((record) => record.action === "REDEEM_RESOLVED");
  if (redeemRecords.length > 0) fail("REDEEM_ALREADY_RECORDED", "a prior f920 redemption is already recorded; duplicate redemption is denied");
  if (journal.records.some((record) => record.action !== "MINT_COMPLETE_SET")) fail("PRIOR_TRANSACTION_PRESENT", "only the confirmed prior f920 mint may precede this one-shot cleanup");

  const accountState = dependencies.accountState ?? await adapter.readAccountState({ marketId: config.marketId });
  const observedChainId = dependencies.chainId ?? (typeof publicClient.getChainId === "function" ? await publicClient.getChainId() : config.chainId);
  if (Number(observedChainId) !== config.chainId) fail("CHAIN_SCOPE_MISMATCH", "authoritative RPC chain is not Somnia Shannon 50312");
  if (!sameAddress(accountState.identity.owner, config.owner) || !sameAddress(accountState.identity.operator, config.operator)) fail("ACCOUNT_IDENTITY_MISMATCH", "VillaAccount owner/operator does not match the cleanup scope");
  if (!sameAddress(accountState.identity.collateralToken, VILLA_ACCOUNT_CONFIG.collateralToken)) fail("COLLATERAL_CONFIG_MISMATCH", "VillaAccount collateral token differs from trusted Shannon configuration");
  if (raw(accountState.capital.directCollateralRaw, "direct collateral") !== LP_REDEEM_CLEANUP_SCOPE.collateralRawBefore || raw(accountState.capital.vaultRaw ?? 0n, "vault credit") !== 0n) fail("CAPITAL_MISMATCH", "collateral is not the expected 1,001,000 raw cleanup pre-state");
  if (raw(accountState.inventory.yesRaw, "YES inventory") !== LP_REDEEM_CLEANUP_SCOPE.amountRaw || raw(accountState.inventory.noRaw, "NO inventory") !== LP_REDEEM_CLEANUP_SCOPE.amountRaw || !sameId(accountState.inventory.marketId, config.marketId)) fail("INVENTORY_SCOPE_MISMATCH", "the exact paired f920 inventory was not observed");
  if (accountState.orders.status !== "VERIFIED" || accountState.orders.orders.length !== 0) fail("OPEN_ORDER_STATE_UNKNOWN", "the account does not have a verified empty order set");
  const bytecode = dependencies.bytecode ?? await publicClient.getBytecode({ address: config.account });
  if (!bytecode || bytecode === "0x") fail("ACCOUNT_RUNTIME_UNVERIFIED", "the bound VillaAccount has no deployed runtime bytecode");

  const accountMarket = dependencies.accountMarket ?? await adapter.readMarket({ marketId: config.marketId, identity: accountState.identity });
  if (!sameAddress(accountMarket.collateral, accountState.identity.collateralToken)) fail("MARKET_COLLATERAL_MISMATCH", "f920 market collateral differs from the account collateral");
  const settlement = await readSettlement({ publicClient, marketAddress: accountMarket.market, dependencies });
  const chainNowSec = await readChainNowSec(publicClient, dependencies);
  if (accountMarket.expiry > BigInt(chainNowSec)) fail("MARKET_NOT_EXPIRED", "f920 has not reached its authoritative expiry");
  const claim = deriveRedeemClaim({ ...settlement, yesRaw: accountState.inventory.yesRaw, noRaw: accountState.inventory.noRaw });
  if (claim.lifecycle.authority !== "ONCHAIN") fail("SETTLEMENT_AUTHORITY_INVALID", "settlement state is not authoritative on-chain state");
  if (claim.outcomeIdx !== LP_REDEEM_CLEANUP_SCOPE.outcomeIdx || claim.amountRaw !== LP_REDEEM_CLEANUP_SCOPE.amountRaw) fail("CLAIM_SCOPE_MISMATCH", "the exact f920 winning NO claim was not observed");
  if (settlement.isResolved !== true || settlement.isVoided === true || claim.winnerIdx !== LP_REDEEM_CLEANUP_SCOPE.outcomeIdx) fail("SETTLEMENT_RESULT_MISMATCH", "f920 is not the expected resolved NO settlement");

  const protocol = dependencies.protocol ?? await readProtocolState({ publicClient, account: config.account, identity: accountState.identity, marketId: config.marketId, pool: accountMarket.pool });
  if (!protocol.marketApproved || !protocol.moduleOperator) fail("PROTOCOL_APPROVAL_MISSING", "required account-bound market/module approvals are not present");
  if (protocol.collateralAllowance !== 0n) fail("COLLATERAL_ALLOWANCE_PRESENT", "redeem cleanup requires zero collateral allowance to the f920 pool");

  const simulationRequest = {
    account: signerInfo.signer,
    address: config.account,
    abi: VILLA_ACCOUNT_OPERATOR_ABI,
    functionName: "operatorRedeem",
    args: [config.marketId, claim.outcomeIdx, claim.amountRaw],
    value: 0n,
  };
  const simulation = dependencies.simulateRedeem
    ? await dependencies.simulateRedeem(simulationRequest)
    : await publicClient.simulateContract(simulationRequest);
  return { accountState, accountMarket, settlement, claim, protocol, chainNowSec, simulation, summary: summary({ config, signerAddress: signerInfo.address, accountState, protocol, settlement, claim, accountMarket, chainNowSec }) };
}

async function readPostRedeemState({ adapter, config }) {
  const accountState = await adapter.readAccountState({ marketId: config.marketId });
  if (accountState.orders.status !== "VERIFIED" || accountState.orders.orders.length > 0) fail("POST_REDEEM_ORDERS_NOT_EMPTY", "post-redeem account-owned orders are not verified empty");
  return accountState;
}

export async function runPrivateLpRedeemCleanup({ env = process.env, args = {}, dependencies = {} } = {}) {
  const config = redeemConfig(env, args);
  if (args.confirmRedeem !== true) fail("REDEEM_CONFIRM_REQUIRED", "the redeem entrypoint requires --confirm-redeem");
  if (env.VILLA_EXECUTION_MODE !== undefined && String(env.VILLA_EXECUTION_MODE).toUpperCase() !== "WET") fail("MODE_INVALID", "redeem cleanup requires VILLA_EXECUTION_MODE=WET");
  const executionEnabled = env.VILLA_EXECUTION_ENABLED === "true";
  const signerInfo = dependencies.signerInfo ?? loadPrivateSigner({ credentialsDirectory: env.CREDENTIALS_DIRECTORY, expectedOperator: config.operator, readFile: dependencies.readCredential ?? ((file) => fs.readFileSync(file, "utf8")) });
  const publicClient = dependencies.publicClient ?? createPublicClient({ chain: somniaShannon, transport: http(env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl, { timeout: 15_000 }) });
  const reader = dependencies.reader ?? createAccountReader(publicClient, config.account);
  const baseAdapter = dependencies.adapter ?? createLpExecutionAdapter({ account: config.account, owner: config.owner, operator: config.operator, reader, sessionId: config.sessionId });
  const accountMarketReader = dependencies.marketReader ?? createAccountMarketReader(publicClient);
  const adapter = typeof baseAdapter.readMarket === "function"
    ? baseAdapter
    : Object.freeze({ ...baseAdapter, readMarket: (input = {}) => accountMarketReader({ ...input, account: config.account }) });
  const journalPath = env.VILLA_WRITER_JOURNAL || path.join(env.VILLA_STATE_DIR || "/var/lib/villa-engine", "transactions.json");
  const leaseStore = dependencies.leaseStore ?? createFileAccountLeaseStore({ directory: env.VILLA_LEASE_DIR || env.VILLA_STATE_DIR || "/var/lib/villa-engine", leaseDurationMs: 30_000 });
  let activeSession = null;
  let lease = null;
  let writer = null;
  let safeToReleaseLease = false;
  try {
    let journal = await reconcileDurableJournal({ journalPath, publicClient, config });
    await validateRedeemPreflight({ config, signerInfo, publicClient, adapter, journal, dependencies });
    const sessionBase = createLpExecutionSession({ sessionId: config.sessionId, account: config.account, owner: config.owner, operator: config.operator, chainId: config.chainId, marketSeries: config.marketSeries, currentMarketId: config.marketId, riskPolicyVersion: "villa-redeem-only-v1", executionMode: "WET", createdAt: Date.now(), maxSessionDurationSec: DEFAULT_PHASE_3B1_CAPS.MAX_SESSION_DURATION_SEC });
    const session = transitionLpSession(sessionBase, "PREFLIGHT");
    const existingLease = leaseStore.get(config.account);
    if (existingLease && Number(existingLease.expiresAt) > Date.now()) fail("ACCOUNT_LEASE_HELD", "an active account lease already exists");
    lease = leaseStore.acquire(session);
    activeSession = attachLease(session, lease);

    journal = await reconcileDurableJournal({ journalPath, publicClient, config });
    const finalPreflight = await validateRedeemPreflight({ config, signerInfo, publicClient, adapter, journal, dependencies });
    const policy = createLpTransactionPolicy({ session: activeSession, caps: DEFAULT_PHASE_3B1_CAPS, now: () => activeSession.createdAt });
    const plan = adapter.redeemResolved({ marketId: config.marketId, outcomeIdx: finalPreflight.claim.outcomeIdx, amountRaw: finalPreflight.claim.amountRaw });
    const prepared = policy.prepare(plan, { txIndex: 0, createdAt: activeSession.createdAt });
    const validation = policy.validate(prepared, { nowMs: activeSession.createdAt });
    if (!validation.allowed) fail(validation.code ?? "POLICY_DENIED", validation.reason ?? "redeem cleanup was denied by policy");
    if (!sameAddress(prepared.to, config.account) || !sameAddress(prepared.destination, config.account) || prepared.value !== 0n || prepared.broadcast !== false) fail("ACCOUNT_BOUNDARY_FAILURE", "redeem plan is not fixed to the VillaAccount with zero native value");

    if (!executionEnabled) {
      safeToReleaseLease = true;
      return {
        version: LP_PRIVATE_REDEEM_CLEANUP_VERSION,
        result: "REDEEM_READY",
        code: "EXECUTION_DISABLED",
        broadcast: false,
        writes: 0,
        signer: { verified: true, address: signerInfo.address },
        sessionId: config.sessionId,
        marketId: config.marketId,
        preflight: finalPreflight.summary,
        action: "operatorRedeem",
        outcomeIdx: finalPreflight.claim.outcomeIdx,
        amountRaw: finalPreflight.claim.amountRaw,
        expectedCollateralReturnRaw: finalPreflight.claim.redeemableYesValueRaw + finalPreflight.claim.redeemableNoValueRaw,
        plan: { functionName: prepared.functionName, destination: prepared.destination, broadcast: prepared.broadcast, value: prepared.value },
        final: { collateralRaw: finalPreflight.accountState.capital.directCollateralRaw, yesRaw: finalPreflight.accountState.inventory.yesRaw, noRaw: finalPreflight.accountState.inventory.noRaw, openOrders: finalPreflight.accountState.orders.orders.length },
        execution: "DISABLED",
      };
    }

    activeSession = transitionLpSession(activeSession, "RUNNING");
    const walletClient = dependencies.walletClient ?? createWalletClient({ account: signerInfo.signer, chain: somniaShannon, transport: http(env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl, { timeout: 15_000 }) });
    writer = createAccountBoundPrivateWriter({
      session: activeSession,
      lease: { ...lease, held: true },
      policy,
      signer: signerInfo.signer,
      publicClient,
      walletClient,
      executionEnabled: true,
      readLatestNonce: async () => publicClient.getTransactionCount({ address: signerInfo.address, blockTag: "latest" }),
      readPendingNonce: async () => publicClient.getTransactionCount({ address: signerInfo.address, blockTag: "pending" }),
      readReceipt: async (hash) => publicClient.getTransactionReceipt({ hash }),
      journalPath,
    });
    const record = await writer.enqueue(prepared);
    if (record.state !== "CONFIRMED") fail("REDEEM_NOT_CONFIRMED", "cleanup redeem did not return an authoritative confirmed receipt");
    const after = await readPostRedeemState({ adapter, config });
    const finalJournal = await reconcileDurableJournal({ journalPath, publicClient, config });
    if (finalJournal.pending > 0 || finalJournal.unknown > 0) fail("POST_REDEEM_RECONCILIATION_REQUIRED", "post-redeem journal is not authoritatively reconciled");
    safeToReleaseLease = true;
    return {
      version: LP_PRIVATE_REDEEM_CLEANUP_VERSION,
      result: "COMPLETED",
      code: "REDEEM_CONFIRMED",
      broadcast: true,
      writes: 1,
      signer: { verified: true, address: signerInfo.address },
      sessionId: config.sessionId,
      marketId: config.marketId,
      preflight: finalPreflight.summary,
      action: "operatorRedeem",
      outcomeIdx: finalPreflight.claim.outcomeIdx,
      amountRaw: finalPreflight.claim.amountRaw,
      expectedCollateralReturnRaw: finalPreflight.claim.redeemableYesValueRaw + finalPreflight.claim.redeemableNoValueRaw,
      redeem: { hash: record.hash, nonce: record.nonce, state: record.state, receiptStatus: record.receiptStatus, receiptBlock: record.receiptBlock },
      final: { collateralRaw: after.capital.directCollateralRaw, vaultRaw: after.capital.vaultRaw, yesRaw: after.inventory.yesRaw, noRaw: after.inventory.noRaw, openOrders: after.orders.orders.length },
      execution: "TEMPORARILY_ARMED_THEN_DISABLED",
    };
  } finally {
    if (lease && activeSession && safeToReleaseLease) {
      const stopping = activeSession.state === "RUNNING" ? transitionLpSession(activeSession, "STOPPING") : activeSession;
      const stopped = transitionLpSession(stopping, "STOPPED");
      try { leaseStore.release(stopped, { reconciled: true }); } catch { /* preserve a lease if another process changed it */ }
    }
    if (writer) writer.close();
  }
}

export function serializePrivateLpRedeemCleanupResult(value) {
  return jsonSafe(value);
}

export function parsePrivateLpRedeemCleanupArgs(argv = process.argv.slice(2)) {
  const result = { confirmRedeem: argv.includes("--confirm-redeem"), account: null, sessionId: null, marketId: null };
  for (const arg of argv) {
    if (arg.startsWith("--account=")) result.account = arg.slice("--account=".length);
    if (arg.startsWith("--session-id=")) result.sessionId = arg.slice("--session-id=".length);
    if (arg.startsWith("--market-id=")) result.marketId = arg.slice("--market-id=".length);
    if (["--to", "--data", "--calldata", "--raw", "--private-key", "--seed", "--mnemonic", "--sendTransaction", "--writeContract", "--broadcast", "--relay", "--mint", "--burn", "--order", "--place-order", "--cancel-order", "--withdraw", "--claim-vault", "--new-market"].some((forbidden) => arg === forbidden || arg.startsWith(forbidden + "="))) {
      fail("ARBITRARY_TRANSACTION_ARGUMENT", "generic or non-redeem transaction arguments are not accepted");
    }
  }
  return result;
}
