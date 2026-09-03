import assert from "node:assert/strict";
import test from "node:test";
import { createLpExecutionSession } from "../execution/lp-session.mjs";
import {
  assessSessionSettlement,
  buildSettlementClaimIntent,
  classifySessionPnl,
} from "./session-lifecycle.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const IDS = { yes: 11n, no: 12n };
const ONE = 1_000n;
const ZERO = [0n, 0n];

function session() {
  return createLpExecutionSession({
    sessionId: "session-settlement",
    account: ACCOUNT,
    owner: OWNER,
    operator: OPERATOR,
    marketSeries: "BINARY:BTC:300",
    currentMarketId: MARKET,
    riskPolicyVersion: "villa-risk-v1",
    createdAt: 1_000,
  });
}

function market(status, extra = {}) {
  return { status, isResolved: status === 4, isVoided: status === 5, ...extra };
}

function assess(overrides = {}) {
  return assessSessionSettlement({
    session: session(),
    account: ACCOUNT,
    owner: OWNER,
    marketId: MARKET,
    onchain: market(4),
    held: { yesRaw: ONE, noRaw: ONE },
    owned: { yesRaw: ONE, noRaw: ONE },
    orders: { status: "VERIFIED", orders: [] },
    payoutNumerators: [10_000_000n, 0n],
    outcomeIds: IDS,
    ...overrides,
  });
}

test("resolved YES winner creates only the winning claim", () => {
  const result = assess();
  assert.equal(result.state, "SETTLEMENT_READY");
  assert.deepEqual(result.plan.redeemableOutcomes, ["YES"]);
  assert.equal(result.plan.legs[1].skipReason, "LOSING_OUTCOME_ZERO_PAYOUT");
});

test("resolved NO winner creates only the NO claim", () => {
  const result = assess({ onchain: market(4), payoutNumerators: [0n, 10_000_000n] });
  assert.equal(result.state, "SETTLEMENT_READY");
  assert.deepEqual(result.plan.redeemableOutcomes, ["NO"]);
});

test("voided market follows the protocol's two-outcome payout semantics", () => {
  const result = assess({ onchain: market(5), payoutNumerators: [5_000_000n, 5_000_000n] });
  assert.equal(result.state, "SETTLEMENT_READY");
  assert.deepEqual(result.plan.redeemableOutcomes, ["YES", "NO"]);
});

test("unresolved inventory remains settlement pending", () => {
  const result = assess({ onchain: market(3) });
  assert.equal(result.state, "STOPPED_SETTLEMENT_PENDING");
  assert.equal(result.reason, "MARKET_NOT_REDEEMABLE");
});

test("losing residual is settled but remains explicitly accounted as zero-value", () => {
  const result = assess({ owned: { yesRaw: 0n, noRaw: ONE }, payoutNumerators: [10_000_000n, 0n] });
  assert.equal(result.state, "SETTLED");
  assert.equal(result.plan.warnings.length, 1);
});

test("partial inventory is scoped to the exact session market", () => {
  const result = assess({ owned: { yesRaw: 400n, noRaw: 0n } });
  assert.equal(result.plan.legs[0].amountRaw, 400n);
  assert.equal(result.plan.legs[1].action, "SKIP");
});

test("already redeemed claims are idempotently skipped", () => {
  const result = assess({ alreadyRedeemed: { yes: true, no: true } });
  assert.equal(result.state, "SETTLED");
  assert.deepEqual(result.plan.redeemableOutcomes, []);
});

test("unknown transaction or open order blocks settlement", () => {
  assert.equal(assess({ unknownTransactions: 1 }).state, "SETTLEMENT_BLOCKED");
  assert.equal(assess({ orders: { status: "VERIFIED", orders: [{ orderId: 7 }] } }).reason, "OPEN_ORDER_STATE_UNKNOWN");
});

test("wrong account, wrong market, and cross-session claims fail closed", () => {
  assert.throws(() => assess({ account: "0x4444444444444444444444444444444444444444" }), { code: "ACCOUNT_SCOPE_MISMATCH" });
  assert.throws(() => assess({ marketId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }), { code: "MARKET_SCOPE_MISMATCH" });
  assert.throws(() => buildSettlementClaimIntent({ session: session(), account: "0x4444444444444444444444444444444444444444", marketId: MARKET, outcomeIdx: 0, amountRaw: ONE }), { code: "ACCOUNT_SCOPE_MISMATCH" });
});

test("resolved after the application was closed can be assessed from fresh chain state", () => {
  const result = assess({ onchain: market(4, { isResolved: true }), owned: { yesRaw: ONE, noRaw: 0n } });
  assert.equal(result.state, "SETTLEMENT_READY");
});

test("P&L stays pending until inventory is cleared and uses integer raw units", () => {
  assert.equal(classifySessionPnl({ startingValueRaw: 1_002_000n, endingValueRaw: 1_002_000n, pendingValueRaw: ONE }).status, "PENDING_UNREALIZED");
  assert.equal(classifySessionPnl({ startingValueRaw: 1_002_000n, endingValueRaw: 1_003_000n }).status, "REALIZED_PROFIT");
  assert.equal(classifySessionPnl({ startingValueRaw: 1_002_000n, endingValueRaw: 1_001_000n }).status, "REALIZED_LOSS");
  assert.equal(classifySessionPnl({ startingValueRaw: 1_002_000n, endingValueRaw: 1_002_000n, pendingValueRaw: 0n }).status, "BREAK_EVEN");
  assert.deepEqual(ZERO, [0n, 0n]);
});
