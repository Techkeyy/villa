import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PHASE_3B1_CAPS,
  LP_ALLOWED_ACCOUNT_OPERATIONS,
  LP_TRANSACTION_POLICY_VERSION,
  createLpTransactionPolicy,
  createTransactionIntent,
  validateTransactionPlan,
} from "./lp-transaction-policy.mjs";
import { createLpExecutionAdapter } from "./lp-adapter.mjs";
import { createLpExecutionSession } from "./lp-session.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x4444444444444444444444444444444444444444";
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const reader = {
  readAccountIdentity: async ({ account }) => ({ account, owner: OWNER, operator: OPERATOR, collateralToken: TOKEN, outcomeToken: TOKEN, binaryModule: TOKEN, binarySettlement: TOKEN, maxOrderQuantity: 1_000_000n, maxOrderCollateral: 1_000_000n }),
  readCapital: async ({ account }) => ({ account, directCollateralRaw: 500_000n }),
  readOutcomeInventory: async ({ account, marketId }) => ({ account, marketId, yesRaw: 0n, noRaw: 0n }),
  readOrders: async ({ account, marketId }) => ({ account, marketId, status: "VERIFIED", orders: [] }),
};

function session() {
  return createLpExecutionSession({ sessionId: "session-policy", account: ACCOUNT, owner: OWNER, operator: OPERATOR, marketSeries: "BTC 5m", currentMarketId: MARKET, riskPolicyVersion: "villa-risk-v1", createdAt: 1000 });
}

function adapter() {
  return createLpExecutionAdapter({ account: ACCOUNT, owner: OWNER, operator: OPERATOR, reader });
}

function prepared(functionName, args, extras = {}) {
  const value = adapter();
  const plan = value[{
    operatorPlaceOrder: "placeOrder",
    operatorCancelOrder: "cancelOrder",
    operatorReduceOrder: "reduceOrder",
    operatorMintSet: "mintCompleteSet",
    operatorBurnSet: "burnCompleteSet",
    operatorRedeem: "redeemResolved",
    operatorClaimVault: "claimVault",
  }[functionName]](args);
  return createLpTransactionPolicy({ session: session(), now: () => 1000 }).prepare({ ...plan, ...extras }, { txIndex: 0, createdAt: 1000 });
}

test("policy accepts only the exact account operator methods from VillaAccount.sol", () => {
  const plans = [
    prepared("operatorPlaceOrder", { marketId: MARKET, action: "BUY_YES", priceRaw: 500_000n, quantityRaw: 1_000n, expireTimestampNs: 2_000n }),
    prepared("operatorCancelOrder", { marketId: MARKET, orderId: 7n }),
    prepared("operatorReduceOrder", { marketId: MARKET, orderId: 7n, newQuantityRemaining: 500n }),
    prepared("operatorMintSet", { marketId: MARKET, amountRaw: 1_000n }),
    prepared("operatorBurnSet", { marketId: MARKET, amountRaw: 1_000n }),
    prepared("operatorRedeem", { marketId: MARKET, outcomeIdx: 0, amountRaw: 1_000n }),
    prepared("operatorClaimVault", { marketId: MARKET, amountRaw: 1_000n }),
  ];
  assert.deepEqual(plans.map((plan) => createLpTransactionPolicy({ session: session(), now: () => 1000 }).validate(plan).allowed), [true, true, true, true, true, true, true]);
  assert.deepEqual(LP_ALLOWED_ACCOUNT_OPERATIONS, plans.map((plan) => plan.functionName));
});

test("withdraw, owner/operator mutation, arbitrary calldata, and unknown destinations are rejected", () => {
  const policy = createLpTransactionPolicy({ session: session(), now: () => 1000 });
  const base = prepared("operatorCancelOrder", { marketId: MARKET, orderId: 7n });
  assert.equal(policy.validate({ ...base, functionName: "withdraw", args: [1n], data: "0x3cc50b45" }).code, "OPERATION_DENIED");
  assert.equal(policy.validate({ ...base, functionName: "setOperator", args: [OPERATOR], data: "0xdeadbeef" }).code, "OPERATION_DENIED");
  assert.equal(policy.validate({ ...base, functionName: "unknown", args: [], data: "0xdeadbeef" }).code, "OPERATION_DENIED");
  assert.equal(policy.validate({ ...base, destination: OWNER }).code, "DESTINATION_DENIED");
  assert.equal(policy.validate({ ...base, to: OPERATOR }).code, "DESTINATION_DENIED");
  assert.equal(policy.validate({ ...base, data: "0xdeadbeef" }).code, "CALLDATA_MISMATCH");
});

test("intent and plan identities, market, selector, amount, and expiry must match exactly", () => {
  const policy = createLpTransactionPolicy({ session: session(), now: () => 1000 });
  const base = prepared("operatorPlaceOrder", { marketId: MARKET, action: "BUY_YES", priceRaw: 500_000n, quantityRaw: 1_000n, expireTimestampNs: 2_000n });
  assert.equal(policy.validate({ ...base, account: OWNER }).code, "ACCOUNT_SCOPE_MISMATCH");
  assert.equal(policy.validate({ ...base, signer: OWNER }).code, "SIGNER_MISMATCH");
  assert.equal(policy.validate({ ...base, chainId: 1 }).code, "CHAIN_SCOPE_MISMATCH");
  assert.equal(policy.validate({ ...base, marketId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }).code, "MARKET_SCOPE_MISMATCH");
  const mutatedArgs = [...base.args];
  mutatedArgs[3] = 2_000n;
  const mutated = { ...base, args: mutatedArgs, data: adapter().placeOrder({ marketId: MARKET, action: "BUY_YES", priceRaw: 500_000n, quantityRaw: 2_000n, expireTimestampNs: 2_000n }).data };
  assert.equal(policy.validate(mutated).code, "INTENT_AMOUNT_MISMATCH");
  const stale = createLpTransactionPolicy({ session: session(), now: () => 100_000 }).validate(base);
  assert.equal(stale.code, "INTENT_STALE");
});

test("hard caps reject oversized order, exposure, mint, transaction index, and raised policy caps", () => {
  const policy = createLpTransactionPolicy({ session: session(), now: () => 1000 });
  const oversized = prepared("operatorPlaceOrder", { marketId: MARKET, action: "BUY_YES", priceRaw: 500_000n, quantityRaw: DEFAULT_PHASE_3B1_CAPS.MAX_ORDER_NOTIONAL + 1n, expireTimestampNs: 2_000n });
  assert.equal(policy.validate(oversized).code, "ORDER_NOTIONAL_CAP");
  const exposure = prepared("operatorPlaceOrder", { marketId: MARKET, action: "BUY_YES", priceRaw: 500_000n, quantityRaw: 1_000n, expireTimestampNs: 2_000n }, { pendingExposureRaw: DEFAULT_PHASE_3B1_CAPS.MAX_PENDING_EXPOSURE });
  assert.equal(policy.validate(exposure).code, "PENDING_EXPOSURE_CAP");
  const mint = prepared("operatorMintSet", { marketId: MARKET, amountRaw: DEFAULT_PHASE_3B1_CAPS.MAX_MINT_AMOUNT + 1n });
  assert.equal(policy.validate(mint).code, "MINT_CAP");
  const txIndex = createLpTransactionPolicy({ session: session(), now: () => 1000 }).prepare(adapter().cancelOrder({ marketId: MARKET, orderId: 1n }), { txIndex: DEFAULT_PHASE_3B1_CAPS.MAX_TX_COUNT, createdAt: 1000 });
  assert.equal(policy.validate(txIndex).code, "TX_COUNT_CAP");
  assert.throws(() => createLpTransactionPolicy({ session: session(), caps: { MAX_OPEN_ORDERS: 3 } }), { code: "CAP_EXCEEDED" });
});

test("account capital is checked against the actual hard-cap field", () => {
  const policy = createLpTransactionPolicy({ session: session(), now: () => 1000 });
  const base = prepared("operatorCancelOrder", { marketId: MARKET, orderId: 7n }, { accountCapitalRaw: DEFAULT_PHASE_3B1_CAPS.MAX_ACCOUNT_CAPITAL + 1n });
  assert.equal(policy.validate(base).code, "ACCOUNT_CAPITAL_CAP");
});

test("the Phase 3B1 account-cap boundary is inclusive and integer exact", () => {
  const policy = createLpTransactionPolicy({ session: session(), now: () => 1000 });
  const exact = prepared("operatorCancelOrder", { marketId: MARKET, orderId: 7n }, { accountCapitalRaw: DEFAULT_PHASE_3B1_CAPS.MAX_ACCOUNT_CAPITAL });
  const above = prepared("operatorCancelOrder", { marketId: MARKET, orderId: 7n }, { accountCapitalRaw: DEFAULT_PHASE_3B1_CAPS.MAX_ACCOUNT_CAPITAL + 1n });
  assert.equal(policy.validate(exact).allowed, true);
  assert.equal(policy.validate(above).code, "ACCOUNT_CAPITAL_CAP");
});

test("intent construction rejects a destination outside the VillaAccount", () => {
  assert.throws(() => createTransactionIntent({ session: session(), action: "CANCEL_ORDER", marketId: MARKET, destination: OWNER, txIndex: 0, createdAt: 1000 }), { code: "DESTINATION_DENIED" });
});

test("a plan cannot skip the deterministic intent envelope", () => {
  const value = adapter().cancelOrder({ marketId: MARKET, orderId: 1n });
  const result = validateTransactionPlan({ ...value, policyVersion: LP_TRANSACTION_POLICY_VERSION, chainId: 50312, destination: ACCOUNT }, { session: session(), nowMs: 1000 });
  assert.equal(result.code, "INTENT_REQUIRED");
});
