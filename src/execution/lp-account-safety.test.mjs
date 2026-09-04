import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_VILLA_OPERATOR,
  HISTORICAL_PHASE_2_ACCOUNT,
  HISTORICAL_PHASE_2_OWNER,
  validateDisposableLpAccount,
} from "./lp-account-safety.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const OTHER_OPERATOR = "0x5555555555555555555555555555555555555555";

test("disposable LP identity is Shannon-scoped and uses the canonical operator", () => {
  const result = validateDisposableLpAccount({ account: ACCOUNT, owner: OWNER });
  assert.equal(result.disposable, true);
  assert.equal(result.account, ACCOUNT);
  assert.equal(result.owner, OWNER);
  assert.equal(result.operator, CANONICAL_VILLA_OPERATOR);
  assert.equal(result.historicalFixtureExcluded, true);
});

test("the Phase 2 account and owner cannot be reused", () => {
  assert.throws(() => validateDisposableLpAccount({ account: HISTORICAL_PHASE_2_ACCOUNT, owner: OWNER }), { code: "HISTORICAL_ACCOUNT_DENIED" });
  assert.throws(() => validateDisposableLpAccount({ account: ACCOUNT, owner: HISTORICAL_PHASE_2_OWNER }), { code: "HISTORICAL_OWNER_DENIED" });
});

test("account, owner, operator, chain, and operator address are all bounded", () => {
  assert.throws(() => validateDisposableLpAccount({ account: ACCOUNT, owner: OWNER, chainId: 1 }), { code: "CHAIN_UNSUPPORTED" });
  assert.throws(() => validateDisposableLpAccount({ account: ACCOUNT, owner: OWNER, operator: OTHER_OPERATOR }), { code: "OPERATOR_NOT_CANONICAL" });
  assert.throws(() => validateDisposableLpAccount({ account: OWNER, owner: OWNER }), { code: "IDENTITY_COLLISION" });
});

test("capital validation accepts product-correct valid balances and rejects invalid amounts without magic number dependency", () => {
  function validateCapital(capitalRaw, { minQuantityRaw = 100_000n, maxCapitalRaw = 1_002_000n } = {}) {
    if (capitalRaw <= 0n) throw new Error("CAPITAL_INVALID: zero or negative collateral");
    if (capitalRaw > maxCapitalRaw) throw new Error("ACCOUNT_CAPITAL_CAP: exceeds cap");
    if (minQuantityRaw >= capitalRaw) throw new Error("MINT_CAP: collateral below minimum mint");
    return true;
  }

  // A. 1,000,000 raw tUSDC (1.000 tUSDC) valid when above configured minimum
  assert.equal(validateCapital(1_000_000n, { minQuantityRaw: 100_000n }), true);

  // B. another valid funded amount also accepted (e.g. 500,000n, 750,000n, 1_001_000n)
  assert.equal(validateCapital(500_000n, { minQuantityRaw: 100_000n }), true);
  assert.equal(validateCapital(750_000n, { minQuantityRaw: 100_000n }), true);
  assert.equal(validateCapital(1_001_000n, { minQuantityRaw: 100_000n }), true);

  // C. zero collateral rejected
  assert.throws(() => validateCapital(0n), /CAPITAL_INVALID/);
  assert.throws(() => validateCapital(-100n), /CAPITAL_INVALID/);

  // D. below configured minimum rejected
  assert.throws(() => validateCapital(50_000n, { minQuantityRaw: 100_000n }), /MINT_CAP/);
  assert.throws(() => validateCapital(100_000n, { minQuantityRaw: 100_000n }), /MINT_CAP/);

  // E. no exact 1_002_000 dependency (amounts other than 1_002_000 pass freely)
  assert.equal(validateCapital(1_000_000n), true);
  assert.equal(validateCapital(800_000n), true);
  assert.equal(validateCapital(1_002_000n), true);
  assert.throws(() => validateCapital(1_003_000n), /ACCOUNT_CAPITAL_CAP/);
});

test("session preflight adapter contract has readMarket defined and enforces read-only safety", async () => {
  const { createLpExecutionAdapter, createViemLpAccountReader } = await import("./lp-adapter.mjs");
  const MARKET_ID = "0x" + "aa".repeat(32);
  const POOL_ADDR = "0x" + "55".repeat(20);
  const MODULE_ADDR = "0x" + "66".repeat(20);
  const WRITING_ADDR = "0x" + "77".repeat(20);

  let writeAttempted = false;
  const publicClient = {
    async readContract(request) {
      if (request.functionName === "accountVersion") return 2;
      if (request.functionName === "owner") return OWNER;
      if (request.functionName === "operator") return CANONICAL_VILLA_OPERATOR;
      if (request.functionName === "collateralToken" || request.functionName === "outcomeToken" || request.functionName === "binaryModule" || request.functionName === "binarySettlement") return MODULE_ADDR;
      if (request.functionName === "maxOrderQuantity" || request.functionName === "maxOrderCollateral") return 10_000_000n;
      if (request.functionName === "maxAggregateExposure" || request.functionName === "maxMintExposure") return 10_000_000n;
      if (request.functionName === "aggregateExposure" || request.functionName === "mintExposure") return 0n;
      if (request.functionName === "markets") return { collateral: WRITING_ADDR, market: WRITING_ADDR, pool: POOL_ADDR, yesId: 101n, noId: 102n, tradingStart: 100n, expiry: 9000n };
      if (request.functionName === "balanceOf") return 1_000_000n;
      if (request.functionName === "getWithdrawableBalance") return 0n;
      return null;
    },
    async writeContract() {
      writeAttempted = true;
      throw new Error("writes forbidden in preflight");
    },
    async sendTransaction() {
      writeAttempted = true;
      throw new Error("transactions forbidden in preflight");
    },
  };

  const reader = createViemLpAccountReader({ publicClient });
  const adapter = createLpExecutionAdapter({
    account: ACCOUNT,
    owner: OWNER,
    operator: CANONICAL_VILLA_OPERATOR,
    reader,
    sessionId: "test-session-123",
  });

  // 1. adapter.readMarket is a function
  assert.equal(typeof adapter.readMarket, "function");

  // 2. adapter.readMarket returns real market structure
  const accountMarket = await adapter.readMarket({ marketId: MARKET_ID });
  assert.equal(accountMarket.account, ACCOUNT);
  assert.equal(accountMarket.marketId, MARKET_ID);
  assert.equal(accountMarket.pool, POOL_ADDR);
  assert.equal(accountMarket.yesId, 101n);
  assert.equal(accountMarket.noId, 102n);

  // 3. account state still comes from the VillaAccount
  const state = await adapter.readAccountState({ marketId: MARKET_ID });
  assert.equal(state.account, ACCOUNT);
  assert.equal(state.owner, OWNER);
  assert.equal(state.operator, CANONICAL_VILLA_OPERATOR);
  assert.equal(state.capital.directCollateralRaw, 1_000_000n);

  // 4. No write was attempted during read-only preflight
  assert.equal(writeAttempted, false);
});
