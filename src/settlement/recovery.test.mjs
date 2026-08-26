import assert from "node:assert/strict";
import test from "node:test";
import {
  ORGANIC_FILL_RECOVERY_VERSION,
  RECOVERY_CLASSIFICATIONS,
  buildOrganicFillRecoveryPlan,
  buildResidualRegistry,
  executeRecoveryRedeems,
  reconcileOrganicFillPayout,
  validateHistoricalResidualToken,
} from "./recovery.mjs";

const A = `0x${"a".repeat(64)}`;
const B = `0x${"b".repeat(64)}`;
const OLD = `0x${"c".repeat(64)}`;
const YES_A = 101n;
const NO_A = 102n;

function organicCase(marketId = A, expectedWinningOutcome = 1) {
  return { kind: "ORGANIC_FILL", marketId, fillOrderId: `order-${marketId.slice(-4)}`, filledQuantityRaw: 1000n, expectedWinningOutcome };
}

function observation(marketId = A, { winningOutcome = 1, yesRaw = 0n, noRaw = 1000n, vector = winningOutcome === 0 ? [10_000_000n, 0n] : [0n, 10_000_000n], yesId = YES_A, noId = NO_A } = {}) {
  return {
    marketId,
    row: { marketId, asset: "BTC", intervalSec: 300, expiry: 1000 },
    onchain: { status: 4, isResolved: true, isVoided: false, finalized: true, winningOutcome, expiry: 1000, yesId, noId },
    balances: { yesRaw, noRaw, collateralRaw: 1_000_000n, sttRaw: 5_000_000n },
    payoutNumerators: vector,
    orders: { count: 0 },
  };
}

test("organic fill residual becomes claimable settled inventory", () => {
  const plan = buildOrganicFillRecoveryPlan({ cases: [organicCase()], observations: [observation()] });
  assert.equal(plan.model, ORGANIC_FILL_RECOVERY_VERSION);
  assert.equal(plan.claimable[0].classification, RECOVERY_CLASSIFICATIONS.CLAIMABLE_SETTLED_INVENTORY);
  assert.equal(plan.claimable[0].claim.outcome, "NO");
});

test("winning NO residual is explicitly redeemable", () => {
  const plan = buildOrganicFillRecoveryPlan({ cases: [organicCase()], observations: [observation()] });
  assert.equal(plan.entries[0].claim.outcomeIdx, 1);
  assert.equal(plan.entries[0].claim.amountRaw, 1000n);
});

test("winning YES residual follows the same explicit path", () => {
  const plan = buildOrganicFillRecoveryPlan({ cases: [organicCase(B, 0)], observations: [observation(B, { winningOutcome: 0, yesRaw: 1000n, noRaw: 0n, yesId: 201n, noId: 202n })] });
  assert.equal(plan.claimable[0].claim.outcome, "YES");
  assert.equal(plan.claimable[0].claim.expectedPayoutRaw, 1000n);
});

test("losing residual is skipped as the known zero-value classification", () => {
  const oldCase = { kind: "KNOWN_RESIDUAL", marketId: OLD, expectedWinningOutcome: 0, residualOutcomeIdx: 1, residualTokenId: 302n };
  const plan = buildOrganicFillRecoveryPlan({ cases: [oldCase], observations: [observation(OLD, { winningOutcome: 0, yesRaw: 0n, noRaw: 1000n, yesId: 301n, noId: 302n })] });
  assert.equal(plan.entries[0].classification, RECOVERY_CLASSIFICATIONS.KNOWN_ZERO_VALUE_SETTLED_RESIDUAL);
  assert.equal(plan.entries[0].skipReason, "KNOWN_ZERO_VALUE_SETTLED_RESIDUAL");
  assert.equal(plan.transactionCount, 0);
});

test("claim plan separates markets by exact marketId", () => {
  const plan = buildOrganicFillRecoveryPlan({ cases: [organicCase(A), organicCase(B)], observations: [observation(A), observation(B)] });
  assert.deepEqual(plan.claimable.map((entry) => entry.marketId), [A, B]);
});

test("one market payout vector cannot be reused for another", () => {
  assert.throws(() => buildOrganicFillRecoveryPlan({ cases: [organicCase(A), organicCase(B)], observations: [observation(A), observation(B, { vector: [10_000_000n, 0n] })] }), (error) => error.code === "WINNER_MISMATCH");
});

test("zero balance is skipped", () => {
  const plan = buildOrganicFillRecoveryPlan({ cases: [organicCase()], observations: [observation(A, { noRaw: 0n })] });
  assert.equal(plan.entries[0].action, "SKIP");
  assert.equal(plan.entries[0].skipReason, "ZERO_BALANCE");
});

test("already-redeemed balance is skipped idempotently", () => {
  const plan = buildOrganicFillRecoveryPlan({ cases: [organicCase()], observations: [observation(A, { noRaw: 0n })], redeemedMarketIds: [A] });
  assert.equal(plan.entries[0].classification, RECOVERY_CLASSIFICATIONS.ALREADY_REDEEMED);
  assert.equal(plan.entries[0].skipReason, "ALREADY_REDEEMED");
});

test("expected payout is calculated in exact raw units", () => {
  const plan = buildOrganicFillRecoveryPlan({ cases: [organicCase()], observations: [observation(A, { vector: [0n, 9_500_000n] })] });
  assert.equal(plan.totalExpectedPayoutRaw, 950n);
});

test("successful reconciliation requires the winner to clear", () => {
  const entry = buildOrganicFillRecoveryPlan({ cases: [organicCase()], observations: [observation()] }).entries[0];
  const result = reconcileOrganicFillPayout({ entry, before: { collateralRaw: 1_000_000n, sttRaw: 5_000_000n }, after: { collateralRaw: 1_001_000n, sttRaw: 4_999_000n, yesRaw: 0n, noRaw: 0n }, actualPayoutRaw: 1000n, receiptGasWei: 1000n });
  assert.equal(result.winningBalanceCleared, true);
  assert.equal(result.collateralDeltaRaw, 1000n);
});

test("cleared claim is not planned again", () => {
  const plan = buildOrganicFillRecoveryPlan({ cases: [organicCase()], observations: [observation(A, { noRaw: 0n })], redeemedMarketIds: [A] });
  assert.equal(plan.claimable.length, 0);
  assert.equal(plan.transactionCount, 0);
});

test("residual registry classification is deterministic", () => {
  const plan = buildOrganicFillRecoveryPlan({ cases: [organicCase()], observations: [observation()] });
  assert.deepEqual(buildResidualRegistry(plan)[0], { marketId: A, classification: "CLAIMABLE_SETTLED_INVENTORY", outcomeBalances: { yesRaw: 0n, noRaw: 1000n }, winningOutcome: 1, claimAction: "REDEEM", claimOutcome: "NO" });
});

test("unknown historical token fails closed", () => {
  assert.throws(() => validateHistoricalResidualToken({ tokenId: 999n, yesId: 1n, noId: 2n }), (error) => error.code === "UNKNOWN_HISTORICAL_TOKEN");
});

test("redeems execute strictly through the supplied queue", async () => {
  const calls = [];
  const queue = { enqueue: async (label, operation) => { calls.push(`${label}:start`); const value = await operation(); calls.push(`${label}:end`); return value; } };
  const entries = [{ action: "REDEEM", marketId: A, claim: { outcome: "NO" } }, { action: "REDEEM", marketId: B, claim: { outcome: "NO" } }];
  await executeRecoveryRedeems(entries, { queue, execute: async (entry) => { calls.push(`${entry.marketId}:write`); return entry.marketId; } });
  assert.deepEqual(calls, [`redeem:${A}:NO:start`, `${A}:write`, `redeem:${A}:NO:end`, `redeem:${B}:NO:start`, `${B}:write`, `redeem:${B}:NO:end`]);
});

test("gas accounting remains separate from collateral economics", () => {
  const entry = buildOrganicFillRecoveryPlan({ cases: [organicCase()], observations: [observation()] }).entries[0];
  const result = reconcileOrganicFillPayout({ entry, before: { collateralRaw: 1_000_000n, sttRaw: 5_000_000n }, after: { collateralRaw: 1_001_000n, sttRaw: 4_999_000n, noRaw: 0n }, actualPayoutRaw: 1000n, receiptGasWei: 123n });
  assert.equal(result.collateralDeltaRaw, 1000n);
  assert.equal(result.nativeBalanceDeltaWei, -1000n);
  assert.equal(result.receiptGasWei, 123n);
  assert.equal(result.gasMeasuredSeparately, true);
});

test("duplicate cases and mismatched observations fail closed", () => {
  assert.throws(() => buildOrganicFillRecoveryPlan({ cases: [organicCase(A), organicCase(A)], observations: [observation()] }), (error) => error.code === "DUPLICATE_MARKET");
  assert.throws(() => buildOrganicFillRecoveryPlan({ cases: [organicCase(A)], observations: [observation(B)] }), (error) => error.code === "MARKET_ID_MISMATCH");
});
