import assert from "node:assert/strict";
import test from "node:test";
import {
  buildOwnerMarketPreparation,
  calculateGasReserve,
  evaluatePostOwnerPreparation,
} from "./lp-owner-prep.mjs";
import { CANONICAL_VILLA_OPERATOR, HISTORICAL_PHASE_2_ACCOUNT } from "./lp-account-safety.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN = "0x3333333333333333333333333333333333333333";
const MODULE = "0x4444444444444444444444444444444444444444";
const POOL = "0x5555555555555555555555555555555555555555";

function market(overrides = {}) {
  return {
    marketId: MARKET,
    series: "BINARY:BTC:300",
    current: true,
    status: "Trading",
    pool: POOL,
    poolFinalized: false,
    expirySec: 2_000,
    grid: { tickSizeRaw: "1000", lotSizeRaw: "1000", minQuantityRaw: "1000" },
    minimumOrderRaw: "1000",
    book: { bids: [[0.55, 200]], asks: [[0.65, 200]] },
    ...overrides,
  };
}

function quote(overrides = {}) {
  return {
    plan: "ACTIVE",
    marketId: MARKET,
    governor: { state: "ALLOW", allowedActions: ["BUY_YES", "SELL_YES"] },
    bid: { enabled: true, action: "BUY_YES", targetPriceRaw: "500000", targetQuantityRaw: "1000" },
    ask: { enabled: true, action: "SELL_YES", targetPriceRaw: "600000", targetQuantityRaw: "1000" },
    ...overrides,
  };
}

function permissions(overrides = {}) {
  return { marketApproved: false, protocolPrepared: false, moduleOperator: false, poolOperator: false, outcomeToken: TOKEN, binaryModule: MODULE, collateralAllowanceRaw: "0", ...overrides };
}

function prepare(overrides = {}) {
  return buildOwnerMarketPreparation({ account: ACCOUNT, owner: OWNER, operator: CANONICAL_VILLA_OPERATOR, chainId: 50312, market: market(overrides.market), chainNowSec: 1_800, permissions: permissions(overrides.permissions), quotePlan: overrides.quotePlan ?? quote(), quoteExecution: overrides.quoteExecution ?? { postOnly: true, orderType: 3, policyValid: true }, projectedSequence: overrides.projectedSequence ?? null, marketSeries: overrides.marketSeries, minimumHeadroomSec: overrides.minimumHeadroomSec });
}

test("market approval missing is identified and produces the exact owner request", () => {
  const result = prepare();
  assert.equal(result.status, "READY");
  assert.equal(result.permissions.marketApproved, false);
  assert.equal(result.requests[0].functionName, "setMarketApproval");
  assert.equal(result.requests[0].selector, "0xccb658f7");
  assert.deepEqual(result.requests[0].args, [MARKET, true]);
  assert.equal(result.requests[0].to, ACCOUNT.toLowerCase());
  assert.equal(result.requests[0].from, OWNER.toLowerCase());
  assert.equal(result.requests[0].sign, false);
  assert.equal(result.requests[0].broadcast, false);
});

test("protocol approval missing is identified and uses only the minimum internal approvals", () => {
  const result = prepare({ permissions: permissions({ marketApproved: true }) });
  assert.equal(result.status, "READY");
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].functionName, "prepareMarket");
  assert.equal(result.requests[0].selector, "0x057e80da");
  assert.equal(result.protocolApproval.method, "setOperator(address,bool)");
  assert.equal(result.protocolApproval.selector, "0x558a7297");
  assert.deepEqual(result.protocolApproval.approvals, [{ spender: POOL.toLowerCase(), approved: true }, { spender: MODULE.toLowerCase(), approved: true }]);
  assert.equal(result.permissions.requiredPersistentCollateralAllowanceRaw, "0");
  assert.equal(result.permissions.collateralAllowanceRaw, "0");
});

test("a prepared market emits no redundant owner transaction", () => {
  const result = prepare({ permissions: permissions({ marketApproved: true, protocolPrepared: true, moduleOperator: true, poolOperator: true }) });
  assert.equal(result.status, "READY");
  assert.deepEqual(result.requests, []);
});

test("stale or under-120-second markets invalidate preparation", () => {
  const stale = prepare({ market: { expirySec: 1_919 } });
  assert.equal(stale.status, "BLOCKED");
  assert.ok(stale.blockers.some((item) => item.code === "HEADROOM_INSUFFICIENT"));
  assert.deepEqual(stale.requests, []);
});

test("NO_QUOTE invalidates preparation and cannot request owner approval", () => {
  const result = prepare({ quotePlan: quote({ plan: "NO_QUOTE", bid: { enabled: false }, ask: { enabled: false } }) });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.blockers.some((item) => item.code === "NO_QUOTE"));
  assert.ok(result.blockers.some((item) => item.code === "NO_POST_ONLY_ORDER"));
  assert.deepEqual(result.requests, []);
});

test("a valid projected mint sequence may authorize owner preparation even when current plan is NO_QUOTE", () => {
  const result = prepare({
    quotePlan: quote({ plan: "NO_QUOTE", bid: { enabled: false }, ask: { enabled: false } }),
    quoteExecution: { postOnly: true, orderType: 3, policyValid: false },
    projectedSequence: { valid: true, quotePlan: quote({ plan: "ONE_SIDED", ask: { enabled: false } }), quoteExecution: { postOnly: true, orderType: 3, policyValid: true }, minimumMintRaw: "1000", recommendedPath: "B", reasons: [] },
  });
  assert.equal(result.status, "READY");
  assert.equal(result.quote.plan, "ONE_SIDED");
  assert.equal(result.quote.projected, true);
  assert.equal(result.requests[0].functionName, "setMarketApproval");
});

test("an invalid projected sequence keeps owner preparation blocked and emits no request", () => {
  const result = prepare({
    quotePlan: quote({ plan: "NO_QUOTE", bid: { enabled: false }, ask: { enabled: false } }),
    quoteExecution: { postOnly: true, orderType: 3, policyValid: false },
    projectedSequence: { valid: false, quotePlan: null, quoteExecution: { postOnly: true, orderType: 3, policyValid: false }, reasons: [{ code: "RISK_HALTED" }] },
  });
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.blockers.some((item) => item.code === "PROJECTED_SEQUENCE_INVALID"));
  assert.deepEqual(result.requests, []);
});

test("a real post-only quote permits fresh owner preparation", () => {
  const result = prepare();
  assert.equal(result.status, "READY");
  assert.equal(result.quote.postOnly, true);
  assert.deepEqual(result.quote.enabledSides.map((item) => item.name), ["bid", "ask"]);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].functionName, "setMarketApproval");
});

test("owner preparation supports the BTC 15m series with its higher initial gate", () => {
  const result = prepare({ market: { series: "BINARY:BTC:900", expirySec: 2_500 }, marketSeries: "BINARY:BTC:900", minimumHeadroomSec: 600 });
  assert.equal(result.status, "READY");
  assert.equal(result.market.series, "BINARY:BTC:900");
  assert.equal(result.market.headroomSec, 700);
  assert.equal(result.requests[0].functionName, "setMarketApproval");
});

test("gas reserve uses bounded transaction count and explicit margin", () => {
  const result = calculateGasReserve({ currentBalanceWei: 200_000_000_000_000_000n, gasPriceWei: 6_000_000_000n, minReserveWei: 100_000_000_000_000_000n });
  assert.equal(result.gasCostPerTxWei, 6_000_000_000_000_000n);
  assert.equal(result.boundedTestBudgetWei, 72_000_000_000_000_000n);
  assert.equal(result.marginWei, 18_000_000_000_000_000n);
  assert.equal(result.recommendedReserveWei, 190_000_000_000_000_000n);
  assert.equal(result.shortfallWei, 0n);
  const short = calculateGasReserve({ currentBalanceWei: 100_000_000_000_000_000n, gasPriceWei: 6_000_000_000n, minReserveWei: 100_000_000_000_000_000n });
  assert.equal(short.shortfallWei, 90_000_000_000_000_000n);
});

test("owner preparation cannot sign or broadcast automatically", () => {
  const result = prepare();
  for (const request of result.requests) {
    assert.equal(request.sign, false);
    assert.equal(request.broadcast, false);
    assert.equal(request.requiresHumanWalletApproval, true);
    assert.equal(Object.hasOwn(request, "privateKey"), false);
  }
});

test("successful owner preparation leaves only signer and execution blockers", () => {
  const result = evaluatePostOwnerPreparation({
    marketApproved: true,
    protocolPrepared: true,
    riskState: "ALLOW",
    riskReasons: [],
    gasBalanceWei: 200_000_000_000_000_000n,
    minimumGasReserveWei: 100_000_000_000_000_000n,
    quotePlan: quote(),
    signerInstalled: false,
    executionEnabled: false,
  });
  assert.equal(result.pass, true);
  assert.deepEqual(result.blockers, ["SIGNER_NOT_INSTALLED", "EXECUTION_DISABLED"]);
});

test("Phase 2 historical account remains excluded", () => {
  assert.throws(() => buildOwnerMarketPreparation({ account: HISTORICAL_PHASE_2_ACCOUNT, owner: OWNER, operator: CANONICAL_VILLA_OPERATOR, market: market(), chainNowSec: 1_800, permissions: permissions(), quotePlan: quote() }), { code: "HISTORICAL_ACCOUNT_DENIED" });
});

test("dry preparation leaves the disposable account facts unchanged", () => {
  const facts = { market: market(), permissions: permissions(), quotePlan: quote() };
  const before = structuredClone(facts);
  prepare(facts);
  assert.deepEqual(facts, before);
});
