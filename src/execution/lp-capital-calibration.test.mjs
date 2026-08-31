import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PHASE_3B1_CAPS } from "./lp-transaction-policy.mjs";
import { calibrationCandidatesRaw, compareLockedCaps, deriveCapitalEquation, evaluateCapitalCandidate, PHASE_3B1A4_BASELINE_CAPITAL_RAW } from "./lp-capital-calibration.mjs";
import { createProjectedEvaluator, evaluateCapitalAtSnapshot } from "./lp-feasibility-simulation.mjs";
import { evaluateLpExecutionReadiness } from "./lp-readiness.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const MARKET_ID = `0x${"ab".repeat(32)}`;

function fixtureShadow() {
  return {
    account: ACCOUNT,
    owner: OWNER,
    operator: OPERATOR,
    riskSnapshot: {
      chainTime: { chainNowSec: 1_000, observationAgeSec: 0, localNowMs: 1_000_000, observedAtLocalMs: 1_000_000, clockOffsetSec: 0 },
      feed: { price: 100_000, timestampSec: 1_000, sourceAgeSec: 0 },
      market: { status: 1, expirySec: 2_000, reference: { status: "VALID", source: "strike", scaleExponent10: 0 } },
      fairValue: { valid: true, pUp: 0.5, pDown: 0.5, confidence: 0.9, dataQualityStatus: "HIGH", modelVersion: "fixture", realizedVolPerSqrtSec: 0.001, timeRemainingSec: 1_000, referenceSource: "strike" },
      inventory: { yes: 0, no: 0 }, openOrdersStatus: "VERIFIED", openOrders: [],
      capital: { collateralAvailable: 1, capitalAtRisk: 0, accountingStatus: "PARTIAL" }, gas: { nativeBalance: 1 }, drawdown: { status: "UNAVAILABLE" },
    },
    openOrders: { orders: [] },
    market: { marketId: MARKET_ID, status: "Trading", series: "BINARY:BTC:300", current: true, expirySec: 2_000, decimals: 6, minimumOrderRaw: "1000", grid: { decimals: 6, oneRaw: "1000000", tickSizeRaw: "1000", lotSizeRaw: "1000", minQuantityRaw: "1000" }, book: { bids: [[0.49, 1]], asks: [[0.51, 1]] } },
  };
}

test("deposit minimum remains independent from the strategy capital equation", async () => {
  const { MIN_DEPOSIT_RAW } = await import("../../dashboard/account-config.mjs");
  assert.equal(MIN_DEPOSIT_RAW, 1_000_000n);
  const equation = deriveCapitalEquation({ collateralReserveRaw: 1_000_000n, minimumMintRaw: 1_000n, inventoryRequiredRaw: 1_000n, currentInventoryRaw: 0n, mintSellFeasible: true });
  assert.equal(equation.mathematicalMinimumRaw, 1_001_000n);
  assert.equal(MIN_DEPOSIT_RAW < equation.mathematicalMinimumRaw, true);
});

test("the exact reserve plus minimum mint is the mathematical MINT+SELL floor", () => {
  const equation = deriveCapitalEquation({ collateralReserveRaw: 1_000_000n, minimumMintRaw: 1_000n, inventoryRequiredRaw: 1_000n, currentInventoryRaw: 0n, mintSellFeasible: true });
  assert.equal(equation.paths.mintSell.requiredCapitalRaw, 1_001_000n);
  assert.equal(equation.paths.mintSell.components.roundingRaw, 0n);
  assert.equal(equation.paths.mintSell.components.dreamDexReservedCollateralRaw, 0n);
});

test("BUY-only includes exact ceil order escrow and can be compared with MINT+SELL", () => {
  const equation = deriveCapitalEquation({ collateralReserveRaw: 1_000_000n, minimumMintRaw: 1_000n, buyPriceRaw: 499_999n, buyQuantityRaw: 1_000n, buyFeasible: true, mintSellFeasible: true });
  assert.equal(equation.paths.buyOnly.components.buyOrderCollateralRaw, 500n);
  assert.equal(equation.paths.buyOnly.requiredCapitalRaw, 1_000_500n);
  assert.equal(equation.mathematicalMinimumRaw, 1_000_500n);
});

test("six-decimal candidates are exact and the candidate below the floor fails", () => {
  const candidates = calibrationCandidatesRaw();
  assert.equal(candidates[0].raw, 1_001_000n);
  assert.equal(candidates[1].raw, 1_002_000n);
  const below = evaluateCapitalCandidate({ capitalRaw: 1_000_999n, mathematicalMinimumRaw: 1_001_000n, recommendedCapitalRaw: 1_002_000n, strategyFeasible: true, currentCapsNonCapitalPass: true });
  assert.equal(below.mathematicalPass, false);
  assert.ok(below.reasons.includes("BELOW_MATHEMATICAL_FLOOR"));
  const exact = evaluateCapitalCandidate({ capitalRaw: 1_001_000n, mathematicalMinimumRaw: 1_001_000n, recommendedCapitalRaw: 1_002_000n, strategyFeasible: true, currentCapsNonCapitalPass: true });
  assert.equal(exact.mathematicalPass, true);
  assert.equal(exact.recommendedPass, false);
});

test("recommended buffered value passes the strategy floor but current cap remains a separate fail", () => {
  const result = evaluateCapitalCandidate({ capitalRaw: 1_002_000n, mathematicalMinimumRaw: 1_001_000n, recommendedCapitalRaw: 1_002_000n, currentCapitalCapRaw: PHASE_3B1A4_BASELINE_CAPITAL_RAW, strategyFeasible: true, currentCapsNonCapitalPass: true, path: "B" });
  assert.equal(result.mathematicalPass, true);
  assert.equal(result.recommendedPass, true);
  assert.equal(result.currentCapitalPass, false);
  assert.equal(result.currentCapsPass, false);
  assert.equal(result.proposedReplacementCapPass, true);
  assert.ok(result.reasons.includes("ACCOUNT_CAPITAL_CAP"));
});

test("the activated bounded cap is inclusive and rejects one raw unit above it", () => {
  const exact = evaluateCapitalCandidate({ capitalRaw: DEFAULT_PHASE_3B1_CAPS.MAX_ACCOUNT_CAPITAL, mathematicalMinimumRaw: 1_001_000n, recommendedCapitalRaw: 1_002_000n, strategyFeasible: true, currentCapsNonCapitalPass: true });
  const above = evaluateCapitalCandidate({ capitalRaw: DEFAULT_PHASE_3B1_CAPS.MAX_ACCOUNT_CAPITAL + 1n, mathematicalMinimumRaw: 1_001_000n, recommendedCapitalRaw: 1_002_000n, strategyFeasible: true, currentCapsNonCapitalPass: true });
  assert.equal(exact.currentCapitalPass, true);
  assert.equal(above.currentCapitalPass, false);
  assert.ok(above.reasons.includes("ACCOUNT_CAPITAL_CAP"));
});

test("locked non-capital caps cannot drift during calibration", () => {
  const comparison = compareLockedCaps(DEFAULT_PHASE_3B1_CAPS);
  assert.equal(comparison.pass, true);
  assert.deepEqual(comparison.differences, []);
  assert.equal(compareLockedCaps({ ...DEFAULT_PHASE_3B1_CAPS, MAX_TX_COUNT: 13 }).pass, false);
});

test("capital simulation is pure and never mutates its inputs", () => {
  const input = { capitalRaw: 1_002_000n, mathematicalMinimumRaw: 1_001_000n, recommendedCapitalRaw: 1_002_000n, strategyFeasible: true, currentCapsNonCapitalPass: true };
  const copy = { ...input };
  const result = evaluateCapitalCandidate(input);
  assert.deepEqual(input, copy);
  assert.equal(result.capitalRaw, 1_002_000n);
});

test("fixture comparison prefers bounded MINT+SELL when VillaAccount order limits reject BUY-only", () => {
  const shadow = fixtureShadow();
  const evaluator = createProjectedEvaluator({ shadow, market: shadow.market, decimals: 6, account: ACCOUNT, owner: OWNER, operator: OPERATOR, accountMaxOrderQuantityRaw: 1_000n, accountMaxOrderCollateralRaw: 1_000n });
  const result = evaluateCapitalAtSnapshot({ evaluator, collateralRaw: 1_002_000n, yesRaw: 0n, noRaw: 0n, minimumMintRaw: 1_000n });
  assert.equal(result.buyOnly.feasible, false);
  assert.ok(result.buyOnly.reasons.includes("ACCOUNT_ORDER_QUANTITY_LIMIT"));
  assert.equal(result.mintSell.feasible, true);
  assert.equal(result.minimumMintRaw, 1_000n);
  assert.equal(result.postMintCollateralRaw, 1_001_000n);
  assert.deepEqual(result.mintSell.evaluation.sequence.actions.map((action) => action.functionName), ["operatorMintSet", "operatorPlaceOrder", "operatorCancelOrder", "operatorBurnSet"]);
  assert.equal(result.mintSell.evaluation.sequence.valid, true);
});

test("fixture proves the exact boundary passes risk only at 1.001 and 1.00 remains strategy-unready", () => {
  const shadow = fixtureShadow();
  const evaluator = createProjectedEvaluator({ shadow, market: shadow.market, decimals: 6, account: ACCOUNT, owner: OWNER, operator: OPERATOR, accountMaxOrderQuantityRaw: 1_000n, accountMaxOrderCollateralRaw: 1_000n });
  const exact = evaluateCapitalAtSnapshot({ evaluator, collateralRaw: 1_001_000n, yesRaw: 0n, noRaw: 0n, minimumMintRaw: 1_000n });
  const below = evaluateCapitalAtSnapshot({ evaluator, collateralRaw: 1_000_000n, yesRaw: 0n, noRaw: 0n, minimumMintRaw: 1_000n });
  assert.equal(exact.mintSell.risk, "ALLOW");
  assert.equal(exact.mintSell.feasible, true);
  assert.equal(below.mintSell.risk, "HALT");
  assert.equal(below.mintSell.feasible, false);
  const readiness = evaluateLpExecutionReadiness({ chain: { id: 50312 }, account: { address: ACCOUNT, owner: OWNER, operator: OPERATOR, runtimeVerified: true }, owner: { address: OWNER, verified: true }, operator: { configuredAddress: OPERATOR, signerAddress: OPERATOR }, market: { marketId: MARKET_ID, currentMarketId: MARKET_ID, valid: true, current: true }, permissions: { requiresMarketApproval: false, requiresProtocolApproval: false }, capital: { collateralRaw: 1_000_000n }, riskLimits: { valid: true }, risk: { state: "ALLOW" }, executionConfig: { mode: "SHADOW", minimumCollateralRaw: 1_000_000n } });
  assert.ok(readiness.reasons.includes("INSUFFICIENT_CAPITAL"));
});
