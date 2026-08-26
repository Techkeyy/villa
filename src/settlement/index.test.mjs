import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ONCHAIN_STATUS,
  PAYOUT_DENOMINATOR_RAW,
  SETTLEMENT_LIFECYCLE_VERSION,
  SettlementLifecycleError,
  assertSecretFree,
  authoritativeResolution,
  buildClaimSweepEntry,
  buildRedemptionPlan,
  classifyMarketState,
  completeSetExposure,
  historicalMarketMatches,
  normalizeOutcomeIndex,
  payoutForOutcome,
  reconcileMintBalances,
  reconcilePayout,
} from "./index.mjs";

const ID = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HELD = { yesRaw: 1_000n, noRaw: 1_000n };

describe("villa-settlement-v1 pure lifecycle decisions", () => {
  it("does not redeem a Trading market", () => {
    assert.equal(classifyMarketState({ status: ONCHAIN_STATUS.Trading }).redeemable, false);
  });

  it("does not redeem a Locked market", () => {
    assert.equal(classifyMarketState({ status: ONCHAIN_STATUS.Locked }).redeemable, false);
  });

  it("does not redeem a Settling market", () => {
    assert.equal(classifyMarketState({ status: ONCHAIN_STATUS.Settling }).redeemable, false);
  });

  it("plans only YES for a resolved YES market", () => {
    const plan = buildRedemptionPlan({ marketId: ID, resolution: "RESOLVED", winningOutcome: 0, held: HELD });
    assert.deepEqual(plan.redeemableOutcomes, ["YES"]);
    assert.equal(plan.legs[0].expectedPayoutRaw, 1_000n);
  });

  it("plans only NO for a resolved NO market", () => {
    const plan = buildRedemptionPlan({ marketId: ID, resolution: "RESOLVED", winningOutcome: 1, held: HELD });
    assert.deepEqual(plan.redeemableOutcomes, ["NO"]);
    assert.equal(plan.legs[1].expectedPayoutRaw, 1_000n);
  });

  it("plans both sides for a voided market", () => {
    const plan = buildRedemptionPlan({ marketId: ID, resolution: "VOIDED", held: HELD });
    assert.deepEqual(plan.redeemableOutcomes, ["YES", "NO"]);
    assert.equal(plan.totalExpectedPayoutRaw, 1_000n);
  });

  it("reports zero directional exposure for a complete set", () => {
    assert.deepEqual(completeSetExposure(HELD), { completeSetsRaw: 1_000n, directionalDeltaRaw: 0n });
  });

  it("skips the resolved losing outcome instead of attempting a zero payout", () => {
    const plan = buildRedemptionPlan({ marketId: ID, resolution: "RESOLVED", winningOutcome: 0, held: HELD });
    assert.equal(plan.legs[1].action, "SKIP");
    assert.equal(plan.legs[1].skipReason, "LOSING_OUTCOME_ZERO_PAYOUT");
  });

  it("does not need or parse the market question", () => {
    const plan = buildRedemptionPlan({ marketId: ID, resolution: "VOIDED", held: HELD, question: "arbitrary text" });
    assert.equal(plan.marketId, ID);
  });

  it("keys the plan by marketId rather than a recycled pool", () => {
    const plan = buildRedemptionPlan({ marketId: ID, resolution: "VOIDED", held: HELD, pool: "0xpool" });
    assert.equal(plan.marketId, ID);
    assert.equal(Object.hasOwn(plan, "pool"), false);
  });

  it("skips a zero YES balance", () => {
    const plan = buildRedemptionPlan({ marketId: ID, resolution: "VOIDED", held: { yesRaw: 0n, noRaw: 1_000n } });
    assert.equal(plan.legs[0].skipReason, "ZERO_BALANCE");
  });

  it("skips an outcome already recorded as redeemed", () => {
    const plan = buildRedemptionPlan({ marketId: ID, resolution: "VOIDED", held: HELD, alreadyRedeemed: { yes: true, no: false } });
    assert.equal(plan.legs[0].skipReason, "ALREADY_REDEEMED");
    assert.deepEqual(plan.redeemableOutcomes, ["NO"]);
  });

  it("recognizes nonzero YES inventory in a claim sweep", () => {
    const entry = buildClaimSweepEntry({ marketId: ID, resolution: "RESOLVED", winningOutcome: 0, held: { yesRaw: 12n, noRaw: 0n } });
    assert.deepEqual(entry.claimableOutcomes, ["YES"]);
  });

  it("recognizes nonzero NO inventory in a claim sweep", () => {
    const entry = buildClaimSweepEntry({ marketId: ID, resolution: "RESOLVED", winningOutcome: 1, held: { yesRaw: 0n, noRaw: 12n } });
    assert.deepEqual(entry.claimableOutcomes, ["NO"]);
  });

  it("keeps both nonzero sides claimable on a void", () => {
    const entry = buildClaimSweepEntry({ marketId: ID, resolution: "VOIDED", held: { yesRaw: 12n, noRaw: 8n } });
    assert.deepEqual(entry.claimableOutcomes, ["YES", "NO"]);
  });

  it("never plans more than the visible held balance", () => {
    const plan = buildRedemptionPlan({ marketId: ID, resolution: "VOIDED", held: { yesRaw: 100n, noRaw: 100n }, owned: { yesRaw: 40n, noRaw: 55n } });
    assert.equal(plan.legs[0].amountRaw, 40n);
    assert.equal(plan.legs[1].amountRaw, 55n);
  });

  it("rejects an implicit or invalid outcome index", () => {
    assert.throws(() => normalizeOutcomeIndex(2), { code: "INVALID_OUTCOME_INDEX" });
    assert.throws(() => normalizeOutcomeIndex(undefined), { code: "INVALID_OUTCOME_INDEX" });
  });

  it("fails closed for an unknown resolution", () => {
    assert.throws(() => buildRedemptionPlan({ marketId: ID, resolution: "TRADING", held: HELD }), { code: "NOT_REDEEMABLE" });
  });

  it("retains identity when a normal live list omits a settled market", () => {
    assert.equal(historicalMarketMatches({ marketId: ID }, ID), true);
    assert.equal(historicalMarketMatches({ marketId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, ID), false);
  });

  it("reconciles a restart read before proposing redemption", () => {
    const read = reconcileMintBalances({
      baseline: { collateralRaw: 10_000n, yesRaw: 0n, noRaw: 0n },
      afterMint: { collateralRaw: 9_000n, yesRaw: 1_000n, noRaw: 1_000n },
      mintAmountRaw: 1_000n,
    });
    assert.equal(read.directionalDeltaRaw, 0n);
  });

  it("rejects secret-like session fields", () => {
    assert.throws(() => assertSecretFree({ sessionId: "safe", privateKey: "never" }), { code: "SECRET_LEAK" });
  });

  it("contains no order-placement path in the pure source contract", async () => {
    const source = await (await import("node:fs/promises")).readFile(new URL("./index.mjs", import.meta.url), "utf8");
    assert.equal(/placeOrder|cancelOrder|mintSet|burnSet/.test(source), false);
  });

  it("produces a structured dry claim sweep entry without writes", () => {
    const entry = buildClaimSweepEntry({ marketId: ID, resolution: "VOIDED", held: { yesRaw: 1n, noRaw: 2n } });
    assert.deepEqual(Object.keys(entry), ["marketId", "resolution", "winningOutcome", "claimableOutcomes", "amountsRaw", "warnings"]);
  });

  it("is idempotent after both void balances are cleared", () => {
    const plan = buildRedemptionPlan({ marketId: ID, resolution: "VOIDED", held: { yesRaw: 0n, noRaw: 0n } });
    assert.deepEqual(plan.redeemableOutcomes, []);
  });

  it("calculates a resolved payout from the protocol vector exactly", () => {
    assert.equal(payoutForOutcome({ amountRaw: 1_000n, outcomeIdx: 0, resolution: "RESOLVED", payoutNumerators: [9_998_000n, 0n] }), 999n);
  });

  it("keeps native gas accounting separate from collateral payout", () => {
    const result = reconcilePayout({ baselineCollateralRaw: 10_000n, afterMintCollateralRaw: 9_000n, finalCollateralRaw: 9_999n, mintAmountRaw: 1_000n, expectedPayoutRaw: 999n, actualPayoutRaw: 999n, baselineSttRaw: 100_000n, finalSttRaw: 99_900n, receiptGasWei: 100n });
    assert.equal(result.payoutExact, true);
    assert.equal(result.nativeBalanceDeltaWei, -100n);
    assert.equal(result.receiptGasWei, 100n);
  });

  it("prefers on-chain flags over a stale indexer terminal label", () => {
    const result = authoritativeResolution({ onchain: { status: ONCHAIN_STATUS.Trading, isResolved: false, isVoided: false }, indexerStatus: "Finalized" });
    assert.equal(result.state, "TRADING");
    assert.equal(result.redeemable, false);
    assert.equal(result.conflict, true);
  });

  it("uses an explicit YES/NO mapping", () => {
    const plan = buildRedemptionPlan({ marketId: ID, resolution: "VOIDED", held: HELD, outcomeIds: { yes: 11n, no: 12n } });
    assert.equal(plan.legs[0].outcomeIdx, 0);
    assert.equal(plan.legs[0].outcome, "YES");
    assert.equal(plan.legs[1].outcomeIdx, 1);
    assert.equal(plan.legs[1].outcome, "NO");
  });

  it("has an explicit model version", () => {
    assert.equal(SETTLEMENT_LIFECYCLE_VERSION, "villa-settlement-v1");
  });

  it("is deterministic for identical settlement input", () => {
    const input = { marketId: ID, resolution: "VOIDED", held: HELD, outcomeIds: { yes: 11n, no: 12n } };
    assert.deepEqual(buildRedemptionPlan(input), buildRedemptionPlan(input));
  });
});
