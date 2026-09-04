import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { decodeFunctionData, encodeFunctionData, isAddress } from "viem";

import { VILLA_ACCOUNT_CONFIG, VILLA_SELECTORS } from "../../dashboard/account-config.mjs";
import {
  VILLA_ACCOUNT_READ_ABI,
  VILLA_ACCOUNT_OPERATOR_ABI,
  createLpExecutionAdapter,
  createViemLpAccountReader,
} from "./lp-adapter.mjs";
import {
  createLpTransactionPolicy,
  validateTransactionPlan,
  DEFAULT_PHASE_3B1_CAPS,
  LP_ALLOWED_ACCOUNT_OPERATIONS,
  LP_DENIED_OPERATIONS,
} from "./lp-transaction-policy.mjs";
import { createLpExecutionSession, transitionLpSession } from "./lp-session.mjs";
import { evaluateLpExecutionReadiness } from "./lp-readiness.mjs";
import { evaluateWetExecutionPreflight } from "./lp-preflight.mjs";

const ARTIFACT_PATH = new URL("../../dashboard/villa-account-artifact.json", import.meta.url);
const artifact = JSON.parse(await fs.readFile(ARTIFACT_PATH, "utf8"));

const OWNER = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0xaf4ee6c0c6ff6337f4c4f07b87c8343df73e8d37";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const ACCOUNT = "0x1111111111111111111111111111111111111111";
const COLLATERAL_TOKEN = VILLA_ACCOUNT_CONFIG.collateralToken.toLowerCase();
const OUTCOME_TOKEN = VILLA_ACCOUNT_CONFIG.outcomeToken.toLowerCase();
const BINARY_MODULE = VILLA_ACCOUNT_CONFIG.binaryModule.toLowerCase();
const BINARY_SETTLEMENT = VILLA_ACCOUNT_CONFIG.binarySettlement.toLowerCase();

const MARKET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const POOL_A = "0x5555555555555555555555555555555555555555";
const MARKET_B_SUCCESSOR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const POOL_B = "0x6666666666666666666666666666666666666666";

test("V2 Artifact: bytecode and ABI metadata integrity", () => {
  assert.equal(artifact.contract, "VillaAccount");
  assert.equal(artifact.schema, "villa-browser-account-artifact-v2");
  assert.equal(artifact.chainId, 50312);
  assert.ok(artifact.runtimeBytecode.length > 100);
  assert.ok(artifact.creationBytecode.length > 100);
  assert.ok(artifact.runtimeImmutableReferences.length >= 20);

  // Check ABI presence
  const abiFunctions = artifact.abi.filter((item) => item.type === "function").map((item) => item.name);
  assert.ok(abiFunctions.includes("autonomousTradingEnabled"));
  assert.ok(abiFunctions.includes("setAutonomousTrading"));
  assert.ok(abiFunctions.includes("preparedMarkets"));
  assert.ok(abiFunctions.includes("prepareMarket"));
  assert.ok(abiFunctions.includes("approvedMarkets")); // backward compat
  assert.ok(abiFunctions.includes("withdraw"));
  assert.ok(abiFunctions.includes("deposit"));
  assert.ok(abiFunctions.includes("setOperator"));
  assert.ok(abiFunctions.includes("revokeOperator"));
  assert.ok(abiFunctions.includes("operatorPlaceOrder"));
  assert.ok(abiFunctions.includes("operatorMintSet"));
  assert.ok(abiFunctions.includes("operatorBurnSet"));
  assert.ok(abiFunctions.includes("operatorCancelOrder"));
  assert.ok(abiFunctions.includes("operatorReduceOrder"));
  assert.ok(abiFunctions.includes("operatorRedeem"));
  assert.ok(abiFunctions.includes("operatorClaimVault"));
  assert.ok(abiFunctions.includes("ownerClaimVault"));
  assert.ok(abiFunctions.includes("recoverUnsupportedToken"));
});

test("V2 Account Boundary: Absolute Owner Custody & Denied Actions", () => {
  // 1. Withdraw function has NO destination argument (cannot send to arbitrary address)
  const withdrawFn = artifact.abi.find((item) => item.type === "function" && item.name === "withdraw");
  assert.deepEqual(withdrawFn.inputs.map((i) => i.name), ["amount"]);

  // 2. Denied operations are blocked in transaction policy
  for (const op of LP_DENIED_OPERATIONS) {
    assert.ok(!LP_ALLOWED_ACCOUNT_OPERATIONS.includes(op), `${op} must be denied in operator policy`);
  }

  // 3. Operator allowlist includes prepareMarket and trading methods only
  assert.ok(LP_ALLOWED_ACCOUNT_OPERATIONS.includes("prepareMarket"));
  assert.ok(LP_ALLOWED_ACCOUNT_OPERATIONS.includes("operatorPlaceOrder"));
  assert.ok(LP_ALLOWED_ACCOUNT_OPERATIONS.includes("operatorMintSet"));
  assert.ok(LP_ALLOWED_ACCOUNT_OPERATIONS.includes("operatorBurnSet"));
  assert.ok(LP_ALLOWED_ACCOUNT_OPERATIONS.includes("operatorCancelOrder"));
  assert.ok(LP_ALLOWED_ACCOUNT_OPERATIONS.includes("operatorReduceOrder"));
  assert.ok(LP_ALLOWED_ACCOUNT_OPERATIONS.includes("operatorRedeem"));
  assert.ok(LP_ALLOWED_ACCOUNT_OPERATIONS.includes("operatorClaimVault"));
});

test("V2 Adapter: readAccountIdentity resolves autonomousTradingEnabled and state", async () => {
  const publicClient = {
    async readContract(request) {
      if (request.functionName === "accountVersion") return 2;
      if (request.functionName === "owner") return OWNER;
      if (request.functionName === "operator") return OPERATOR;
      if (request.functionName === "autonomousTradingEnabled") return true;
      if (request.functionName === "collateralToken") return COLLATERAL_TOKEN;
      if (request.functionName === "outcomeToken") return OUTCOME_TOKEN;
      if (request.functionName === "binaryModule") return BINARY_MODULE;
      if (request.functionName === "binarySettlement") return BINARY_SETTLEMENT;
      if (request.functionName === "maxOrderQuantity") return 1_000_000n;
      if (request.functionName === "maxOrderCollateral") return 500_000n;
      if (request.functionName === "maxAggregateExposure") return 1_000_000n;
      if (request.functionName === "maxMintExposure") return 1_000_000n;
      if (request.functionName === "aggregateExposure") return 0n;
      if (request.functionName === "mintExposure") return 0n;
      if (request.functionName === "balanceOf") return 1_000_000n;
      if (request.functionName === "getWithdrawableBalance") return 0n;
      if (request.functionName === "markets") return { collateral: COLLATERAL_TOKEN, market: POOL_A, pool: POOL_A, yesId: 101n, noId: 102n, tradingStart: 100n, expiry: 9000n };
      throw new Error(`unexpected call: ${request.functionName}`);
    },
  };

  const reader = createViemLpAccountReader({ publicClient });
  const identity = await reader.readAccountIdentity({ account: ACCOUNT });
  assert.equal(identity.account, ACCOUNT);
  assert.equal(identity.owner, OWNER);
  assert.equal(identity.operator, OPERATOR);
  assert.equal(identity.autonomousTradingEnabled, true);
  assert.equal(identity.accountVersion, 2);
  assert.equal(identity.collateralToken, COLLATERAL_TOKEN);
  assert.equal(identity.maxOrderQuantity, 1_000_000n);
  assert.equal(identity.maxOrderCollateral, 500_000n);

  const adapter = createLpExecutionAdapter({
    account: ACCOUNT,
    owner: OWNER,
    operator: OPERATOR,
    reader,
    sessionId: "test-uat-v2",
  });

  // Prepare market write plan creation
  const prepPlan = adapter.prepareMarket({ marketId: MARKET_A });
  assert.equal(prepPlan.operation, "PREPARE_MARKET");
  assert.equal(prepPlan.functionName, "prepareMarket");
  assert.equal(prepPlan.to, ACCOUNT);
  assert.deepEqual(prepPlan.args, [MARKET_A]);

  // Place order plan creation
  const orderPlan = adapter.placeOrder({
    marketId: MARKET_A,
    kind: 1, // SELL_YES
    priceRaw: 600_000n,
    quantityRaw: 100_000n,
    expireTimestampNs: 9999999999n,
  });
  assert.equal(orderPlan.operation, "PLACE_ORDER");
  assert.equal(orderPlan.functionName, "operatorPlaceOrder");
  assert.equal(orderPlan.to, ACCOUNT);
});

test("V2 Autonomous Market Rollover: Policy validates autonomous preparation and execution of successor market without owner tx", () => {
  const session = createLpExecutionSession({
    sessionId: "uat-session-rollover-1",
    account: ACCOUNT,
    owner: OWNER,
    operator: OPERATOR,
    chainId: 50312,
    marketSeries: "BINARY:BTC:300",
    currentMarketId: MARKET_B_SUCCESSOR,
    riskPolicyVersion: "governor-v1",
    executionMode: "WET",
    createdAt: Date.now(),
  });
  const preflightSession = transitionLpSession(session, "PREFLIGHT");
  const runningSession = transitionLpSession(preflightSession, "RUNNING");
  const policy = createLpTransactionPolicy({ session: runningSession, caps: DEFAULT_PHASE_3B1_CAPS });

  const reader = {
    async readAccountIdentity() {
      return { account: ACCOUNT, owner: OWNER, operator: OPERATOR, accountVersion: 2, version: 2, autonomousTradingEnabled: true, collateralToken: COLLATERAL_TOKEN, outcomeToken: OUTCOME_TOKEN, binaryModule: BINARY_MODULE, binarySettlement: BINARY_SETTLEMENT, maxOrderQuantity: 1_000_000n, maxOrderCollateral: 500_000n, maxAggregateExposure: 1_000_000n, maxMintExposure: 1_000_000n, aggregateExposure: 0n, mintExposure: 0n };
    },
    async readCapital() { return { account: ACCOUNT, directCollateralRaw: 1_000_000n, vaultRaw: 0n }; },
    async readOutcomeInventory() { return { account: ACCOUNT, marketId: MARKET_B_SUCCESSOR, yesRaw: 0n, noRaw: 0n }; },
    async readOrders() { return { account: ACCOUNT, marketId: MARKET_B_SUCCESSOR, status: "VERIFIED", orders: [] }; },
  };

  const adapter = createLpExecutionAdapter({
    account: ACCOUNT,
    owner: OWNER,
    operator: OPERATOR,
    reader,
    sessionId: runningSession.sessionId,
  });

  // Step 1: Autonomous prepareMarket for successor market B
  const prepPlan = adapter.prepareMarket({ marketId: MARKET_B_SUCCESSOR });
  const preparedPrep = policy.prepare(prepPlan, { txIndex: 0, createdAt: Date.now() });
  const prepValidation = policy.validate(preparedPrep, { nowMs: Date.now() });
  assert.equal(prepValidation.allowed, true);
  assert.equal(prepValidation.action, "PREPARE_MARKET");

  // Step 2: Autonomous mintCompleteSet on market B
  const mintPlan = adapter.mintCompleteSet({ marketId: MARKET_B_SUCCESSOR, amountRaw: 100_000n });
  const preparedMint = policy.prepare(mintPlan, { txIndex: 1, createdAt: Date.now() });
  const mintValidation = policy.validate(preparedMint, { nowMs: Date.now() });
  assert.equal(mintValidation.allowed, true);
  assert.equal(mintValidation.action, "MINT_COMPLETE_SET");

  // Step 3: Autonomous order placement on market B
  const orderPlan = adapter.placeOrder({
    marketId: MARKET_B_SUCCESSOR,
    kind: 1,
    priceRaw: 550_000n,
    quantityRaw: 100_000n,
    expireTimestampNs: 1800000000000000000n,
  });
  const preparedOrder = policy.prepare(orderPlan, { txIndex: 2, createdAt: Date.now() });
  const orderValidation = policy.validate(preparedOrder, { nowMs: Date.now() });
  assert.equal(orderValidation.allowed, true);
  assert.equal(orderValidation.action, "PLACE_ORDER");
});

test("V2 Preflight: Autonomous trading accounts pass preflight without manual market approval", () => {
  const session = createLpExecutionSession({
    sessionId: "uat-session-v2-preflight",
    account: ACCOUNT,
    owner: OWNER,
    operator: OPERATOR,
    chainId: 50312,
    marketSeries: "BINARY:BTC:300",
    currentMarketId: MARKET_A,
    riskPolicyVersion: "governor-v1",
    executionMode: "WET",
    createdAt: Date.now(),
  });
  const preflightSession = transitionLpSession(session, "PREFLIGHT");

  const preflight = evaluateWetExecutionPreflight({
    nowMs: Date.now(),
    session: preflightSession,
    lease: { held: true, account: ACCOUNT, sessionId: preflightSession.sessionId },
    chain: { id: 50312 },
    executionEnabled: true,
    account: { address: ACCOUNT, owner: OWNER, operator: OPERATOR, runtimeVerified: true },
    owner: { address: OWNER, verified: true },
    operator: { configuredAddress: OPERATOR, signerAddress: OPERATOR },
    capital: { collateralRaw: 1_000_000n },
    market: { marketId: MARKET_A, series: "BINARY:BTC:300", status: 1, valid: true, current: true, currentMarketId: MARKET_A },
    orders: { status: "VERIFIED", orders: [], account: ACCOUNT },
    inventory: { status: "VERIFIED", yesRaw: 0n, noRaw: 0n, account: ACCOUNT },
    reconciliation: { status: "RECONCILED", safeToStart: true, pendingTransactions: 0, unknownTransactions: 0, unknownOrders: 0 },
    permissions: {
      requiresMarketApproval: false, // V2 autonomous trading
      marketApproved: false, // Not yet approved by owner
      requiresProtocolApproval: false,
      protocolPrepared: false,
    },
    riskLimits: { valid: true },
    risk: { state: "ALLOW" },
    executionConfig: { mode: "WET", minimumCollateralRaw: 1n, sessionActive: false },
    caps: DEFAULT_PHASE_3B1_CAPS,
  });

  assert.equal(preflight.allowed, true);
  assert.deepEqual(preflight.reasons, []);
});

test("V2 Adversarial Safety: Hostile plans and out-of-scope targets are strictly rejected", () => {
  const session = createLpExecutionSession({
    sessionId: "uat-session-adversarial",
    account: ACCOUNT,
    owner: OWNER,
    operator: OPERATOR,
    chainId: 50312,
    marketSeries: "BINARY:BTC:300",
    currentMarketId: MARKET_A,
    riskPolicyVersion: "governor-v1",
    executionMode: "WET",
    createdAt: Date.now(),
  });
  const preflightSession = transitionLpSession(session, "PREFLIGHT");
  const runningSession = transitionLpSession(preflightSession, "RUNNING");
  const policy = createLpTransactionPolicy({ session: runningSession, caps: DEFAULT_PHASE_3B1_CAPS });

  // 1. Plan targeting attacker contract
  const hostileTargetPlan = {
    adapterVersion: "villa-lp-adapter-v1",
    executionMode: "SHADOW",
    broadcast: false,
    chainId: 50312,
    sessionId: runningSession.sessionId,
    operation: "PLACE_ORDER",
    functionName: "operatorPlaceOrder",
    to: ATTACKER,
    destination: ATTACKER,
    value: 0n,
    args: [MARKET_A, 0, 500_000n, 100_000n, 999999n, 3, 0n],
    data: encodeFunctionData({ abi: VILLA_ACCOUNT_OPERATOR_ABI, functionName: "operatorPlaceOrder", args: [MARKET_A, 0, 500_000n, 100_000n, 999999n, 3, 0n] }),
    signer: OPERATOR,
    account: ACCOUNT,
    orderOwner: ACCOUNT,
    owner: OWNER,
  };
  assert.throws(
    () => policy.prepare(hostileTargetPlan, { txIndex: 0, createdAt: Date.now() }),
    { code: "DESTINATION_DENIED" }
  );

  // 2. Plan attempting to send native funds
  const hostileValuePlan = {
    ...hostileTargetPlan,
    to: ACCOUNT,
    destination: ACCOUNT,
    value: 1000n,
  };
  const preparedHostileValue = policy.prepare(hostileValuePlan, { txIndex: 0, createdAt: Date.now() });
  const v2 = policy.validate(preparedHostileValue, { nowMs: Date.now() });
  assert.equal(v2.allowed, false);
  assert.equal(v2.code, "VALUE_DENIED");

  // 3. Plan attempting out-of-market trade
  const staleMarketPlan = {
    ...hostileTargetPlan,
    to: ACCOUNT,
    destination: ACCOUNT,
    args: [MARKET_B_SUCCESSOR, 0, 500_000n, 100_000n, 999999n, 3, 0n],
    data: encodeFunctionData({ abi: VILLA_ACCOUNT_OPERATOR_ABI, functionName: "operatorPlaceOrder", args: [MARKET_B_SUCCESSOR, 0, 500_000n, 100_000n, 999999n, 3, 0n] }),
  };
  assert.throws(
    () => policy.prepare(staleMarketPlan, { txIndex: 0, createdAt: Date.now() }),
    { code: "MARKET_SCOPE_MISMATCH" }
  );

  // 4. Plan exceeding max order notional cap
  const excessiveNotionalPlan = {
    ...hostileTargetPlan,
    to: ACCOUNT,
    destination: ACCOUNT,
    args: [MARKET_A, 0, 500_000n, 500_000n, 999999n, 3, 0n], // 500k exceeds 250k notional cap
    data: encodeFunctionData({ abi: VILLA_ACCOUNT_OPERATOR_ABI, functionName: "operatorPlaceOrder", args: [MARKET_A, 0, 500_000n, 500_000n, 999999n, 3, 0n] }),
  };
  const preparedExcessive = policy.prepare(excessiveNotionalPlan, { txIndex: 0, createdAt: Date.now() });
  const v4 = policy.validate(preparedExcessive, { nowMs: Date.now() });
  assert.equal(v4.allowed, false);
  assert.equal(v4.code, "ORDER_NOTIONAL_CAP");
});
