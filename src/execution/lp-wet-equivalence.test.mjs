import assert from "node:assert/strict";
import test from "node:test";
import { createLpExecutionAdapter } from "./lp-adapter.mjs";
import { buildLpShadowPlan } from "./lp-shadow.mjs";
import { createLpExecutionSession } from "./lp-session.mjs";
import { createLpTransactionPolicy } from "./lp-transaction-policy.mjs";

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

test("SHADOW and future WET use the same policy-prepared account plan object", () => {
  const session = createLpExecutionSession({ sessionId: "session-equivalence", account: ACCOUNT, owner: OWNER, operator: OPERATOR, marketSeries: "BTC 5m", currentMarketId: MARKET, riskPolicyVersion: "villa-risk-v1", createdAt: 1000 });
  const adapter = createLpExecutionAdapter({ account: ACCOUNT, owner: OWNER, operator: OPERATOR, reader, sessionId: session.sessionId });
  const policy = createLpTransactionPolicy({ session, now: () => 1000 });
  const accountState = { account: ACCOUNT, inventory: { account: ACCOUNT, marketId: MARKET, yes: 0, no: 0 }, orders: { account: ACCOUNT, orders: [] }, capital: { account: ACCOUNT, collateralAvailable: 500_000 } };
  const result = buildLpShadowPlan({
    adapter,
    accountState,
    readinessInput: {
      chain: { id: 50312 },
      account: { owner: OWNER, operator: OPERATOR, runtimeVerified: true },
      owner: { verified: true },
      operator: { configuredAddress: OPERATOR, signerAddress: OPERATOR },
      market: { marketId: MARKET, valid: true, current: true, currentMarketId: MARKET },
      permissions: { requiresMarketApproval: false, requiresProtocolApproval: false },
      capital: { collateralRaw: 500_000n },
      riskLimits: { valid: true },
      risk: { state: "ALLOW" },
      executionConfig: { mode: "SHADOW", minimumCollateralRaw: 1n },
    },
    market: { marketId: MARKET },
    decision: { state: "ALLOW", fairValue: 0.5 },
    quotePlan: { plan: "QUOTE", fairValue: 0.5, bid: { enabled: true, action: "BUY_YES", targetPriceRaw: 400_000n, targetQuantityRaw: 1_000n }, ask: { enabled: false, skipReason: "NO_INVENTORY" } },
    orderExpiryNs: 2_000n,
    transactionPolicy: policy,
    txIndexStart: 0,
    createdAtMs: 1000,
  });
  assert.equal(result.actions.length, 1);
  const plan = result.actions[0];
  assert.equal(policy.validate(plan, { nowMs: 1000 }).allowed, true);
  const wetQueueInput = plan;
  assert.strictEqual(wetQueueInput, result.actions[0]);
  assert.equal(wetQueueInput.broadcast, false);
  assert.equal(wetQueueInput.to, ACCOUNT);
  assert.equal(wetQueueInput.orderOwner, ACCOUNT);
  assert.equal(wetQueueInput.signer, OPERATOR);
});
