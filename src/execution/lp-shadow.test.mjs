import assert from "node:assert/strict";
import test from "node:test";
import { createLpExecutionAdapter } from "./lp-adapter.mjs";
import { buildAccountBoundEngineInput, buildLpShadowPlan } from "./lp-shadow.mjs";

const ACCOUNT_A = "0x1111111111111111111111111111111111111111";
const OWNER_A = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const ACCOUNT_B = "0x6666666666666666666666666666666666666666";
const OWNER_B = "0x7777777777777777777777777777777777777777";
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function reader(account, owner) {
  return {
    async readAccountIdentity(input) { return { account: input.account, owner, operator: OPERATOR }; },
    async readCapital(input) { return { account: input.account, collateralAvailableRaw: 2_000_000n, collateralRaw: 2_000_000n, marketId: input.marketId ?? null }; },
    async readOutcomeInventory(input) { return { account: input.account, marketId: input.marketId, yes: 2, no: 2, yesRaw: 2_000_000n, noRaw: 2_000_000n }; },
    async readOrders(input) { return { account: input.account, marketId: input.marketId, status: "VERIFIED", orders: [] }; },
  };
}

function makeAdapter(account, owner) {
  return createLpExecutionAdapter({ account, owner, operator: OPERATOR, reader: reader(account, owner) });
}

function readiness() {
  return {
    chain: { id: 50312 },
    account: { runtimeVerified: true, operator: OPERATOR },
    owner: { verified: true },
    operator: { configuredAddress: OPERATOR, signerAddress: OPERATOR },
    market: { marketId: MARKET, currentMarketId: MARKET, valid: true, current: true },
    permissions: { marketApproved: true, protocolPrepared: true },
    capital: { collateralRaw: 2_000_000n },
    riskLimits: { valid: true },
    executionConfig: { mode: "SHADOW", minimumCollateralRaw: 1_000_000n },
  };
}

const DECISION = { state: "ALLOW", fairValue: { pUp: 0.6, pDown: 0.4, confidence: 0.9, dataQualityStatus: "HIGH", realizedVolPerSqrtSec: 0.0001, timeRemainingSec: 120 } };
const QUOTE_PLAN = { plan: "ACTIVE", fairValue: DECISION.fairValue, bid: { enabled: true, action: "BUY_YES", targetPriceRaw: "500000", targetQuantityRaw: "1000" }, ask: { enabled: true, action: "SELL_YES", targetPriceRaw: "600000", targetQuantityRaw: "1000" } };

function accountState(account, collateralAvailable = 2) {
  return { account, capital: { collateralAvailable, collateralRaw: BigInt(Math.round(collateralAvailable * 1_000_000)) }, inventory: { account, yes: 2, no: 2, yesRaw: 2_000_000n, noRaw: 2_000_000n }, orders: { account, status: "VERIFIED", orders: [] } };
}

test("shadow plan uses existing decision and quote plan but targets the account", () => {
  const adapter = makeAdapter(ACCOUNT_A, OWNER_A);
  const result = buildLpShadowPlan({ adapter, accountState: accountState(ACCOUNT_A), readinessInput: readiness(), market: { marketId: MARKET }, decision: DECISION, quotePlan: QUOTE_PLAN, orderExpiryNs: 123n });
  assert.equal(result.executionMode, "SHADOW");
  assert.equal(result.broadcast, false);
  assert.equal(result.account, ACCOUNT_A);
  assert.equal(result.owner, OWNER_A);
  assert.equal(result.operator, OPERATOR);
  assert.equal(result.actions.length, 2);
  assert.ok(result.actions.every((action) => action.to === ACCOUNT_A && action.orderOwner === ACCOUNT_A && action.signer === OPERATOR && action.broadcast === false));
});

test("not-ready account produces no planned writes", () => {
  const adapter = makeAdapter(ACCOUNT_A, OWNER_A);
  const result = buildLpShadowPlan({ adapter, accountState: accountState(ACCOUNT_A, 0), readinessInput: { ...readiness(), account: { operator: "0x0000000000000000000000000000000000000000" }, capital: { collateralRaw: 0n } }, market: { marketId: MARKET }, decision: DECISION, quotePlan: QUOTE_PLAN, orderExpiryNs: 123n });
  assert.equal(result.readiness.ready, false);
  assert.equal(result.actions.length, 0);
});

test("risk inputs are rebuilt from one account and isolate two LPs", () => {
  const adapterA = makeAdapter(ACCOUNT_A, OWNER_A);
  const adapterB = makeAdapter(ACCOUNT_B, OWNER_B);
  const stateA = accountState(ACCOUNT_A, 2);
  const stateB = accountState(ACCOUNT_B, 9);
  stateA.orders.orders.push({ owner: ACCOUNT_A, orderId: "a", outcome: "YES", side: "BUY", remainingQty: 1 });
  stateB.orders.orders.push({ owner: ACCOUNT_B, orderId: "b", outcome: "YES", side: "SELL", remainingQty: 4 });
  const a = buildAccountBoundEngineInput({ adapter: adapterA, accountState: stateA, riskInput: { inventory: {}, capital: {}, openOrders: [] } });
  const b = buildAccountBoundEngineInput({ adapter: adapterB, accountState: stateB, riskInput: { inventory: {}, capital: {}, openOrders: [] } });
  assert.equal(a.riskInput.account, ACCOUNT_A);
  assert.equal(b.riskInput.account, ACCOUNT_B);
  assert.equal(a.riskInput.capital.collateralAvailable, 2);
  assert.equal(b.riskInput.capital.collateralAvailable, 9);
  assert.deepEqual(a.riskInput.openOrders.map((order) => order.orderId), ["a"]);
  assert.deepEqual(b.riskInput.openOrders.map((order) => order.orderId), ["b"]);
  assert.notEqual(a.riskInput.account, b.riskInput.account);
});

test("an account mismatch cannot cross LP risk or order state", () => {
  const adapter = makeAdapter(ACCOUNT_A, OWNER_A);
  assert.throws(() => buildLpShadowPlan({ adapter, accountState: accountState(ACCOUNT_B), readinessInput: readiness(), market: { marketId: MARKET }, decision: DECISION, quotePlan: QUOTE_PLAN, orderExpiryNs: 123n }), /ACCOUNT_SCOPE_MISMATCH/);
});

test("halted risk or no-quote plan remains a zero-action shadow plan", () => {
  const adapter = makeAdapter(ACCOUNT_A, OWNER_A);
  const halted = buildLpShadowPlan({ adapter, accountState: accountState(ACCOUNT_A), readinessInput: readiness(), market: { marketId: MARKET }, decision: { ...DECISION, state: "HALT" }, quotePlan: QUOTE_PLAN, orderExpiryNs: 123n });
  const empty = buildLpShadowPlan({ adapter, accountState: accountState(ACCOUNT_A), readinessInput: readiness(), market: { marketId: MARKET }, decision: DECISION, quotePlan: { ...QUOTE_PLAN, plan: "NO_QUOTE", bid: { enabled: false }, ask: { enabled: false } }, orderExpiryNs: 123n });
  assert.equal(halted.actions.length, 0);
  assert.equal(empty.actions.length, 0);
});

test("successor rollover keeps the same account while changing only market identity", () => {
  const adapter = makeAdapter(ACCOUNT_A, OWNER_A);
  const successor = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const result = buildLpShadowPlan({
    adapter,
    accountState: accountState(ACCOUNT_A),
    readinessInput: { ...readiness(), market: { marketId: successor, currentMarketId: successor, valid: true, current: true } },
    market: { marketId: successor },
    decision: DECISION,
    quotePlan: QUOTE_PLAN,
    orderExpiryNs: 456n,
  });
  assert.equal(result.account, ACCOUNT_A);
  assert.equal(result.marketId, successor);
  assert.ok(result.actions.every((action) => action.account === ACCOUNT_A && action.orderOwner === ACCOUNT_A));
  assert.ok(result.actions.every((action) => action.args[0] === successor));
});
