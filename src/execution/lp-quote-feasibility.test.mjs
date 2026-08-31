import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRisk } from "../risk-governor/index.mjs";
import { planQuotes } from "../quote-planner/index.mjs";
import { DEFAULT_PHASE_3B1_CAPS } from "./lp-transaction-policy.mjs";
import { evaluateMintCandidate, findSmallestViableMint, generateMintCandidates, projectLpState, recommendQuotePath, validateProjectedQuote } from "./lp-quote-feasibility.mjs";

const MARKET = {
  marketId: `0x${"ab".repeat(32)}`,
  status: "Trading",
  expirySec: 2_000,
  minimumOrderRaw: "1000",
  grid: { decimals: 6, oneRaw: "1000000", tickSizeRaw: "1000", lotSizeRaw: "1000", minQuantityRaw: "1000" },
  book: { bids: [[0.49, 1]], asks: [[0.51, 1]] },
};

function snapshot({ collateral = 1.2, yes = 0, no = 0 } = {}) {
  return {
    chainTime: { chainNowSec: 1_000, observationAgeSec: 0, localNowMs: 1_000_000, observedAtLocalMs: 1_000_000, clockOffsetSec: 0 },
    feed: { price: 100_000, timestampSec: 1_000, sourceAgeSec: 0 },
    market: { status: 1, expirySec: 2_000, reference: { status: "VALID", source: "strike", scaleExponent10: 0 } },
    fairValue: { valid: true, pUp: 0.5, pDown: 0.5, confidence: 0.9, dataQualityStatus: "HIGH", modelVersion: "test", realizedVolPerSqrtSec: 0.001, timeRemainingSec: 1_000, referenceSource: "strike" },
    inventory: { yes, no },
    openOrdersStatus: "VERIFIED",
    openOrders: [],
    capital: { collateralAvailable: collateral, capitalAtRisk: 0 },
    gas: { nativeBalance: 1 },
    drawdown: { status: "UNAVAILABLE" },
  };
}

function evaluatedState({ collateral = 1.2, yes = 0, no = 0 } = {}) {
  const riskDecision = evaluateRisk(snapshot({ collateral, yes, no }));
  const input = {
    fairValue: snapshot({ collateral, yes, no }).fairValue,
    governor: { state: riskDecision.state, permissions: riskDecision.permissions, sizeMultiplier: riskDecision.sizeMultiplier, triggeredRules: riskDecision.triggeredRules, warnings: riskDecision.warnings, reduceOnlyPolicy: riskDecision.reduceOnlyPolicy, directionalRiskCapacity: 10, limits: { directionalExposureHard: 10, grossExposureHard: 20 } },
    inventory: { yes, no },
    pendingOrders: [],
    book: { bestBidRaw: "490000", bestAskRaw: "510000" },
    grid: MARKET.grid,
    capital: { collateralAvailable: collateral, collateralReserve: 1 },
    market: { marketId: MARKET.marketId, timeRemainingSec: 1_000 },
    quote: { baseQuantityRaw: "5000" },
  };
  return { riskDecision, quotePlan: planQuotes(input) };
}

test("projected mint adds exact YES and NO while reducing collateral", () => {
  const result = projectLpState({ collateralRaw: 1_000_000n, yesRaw: 25n, noRaw: 30n, mintAmountRaw: 1_000n });
  assert.deepEqual({ collateralRaw: result.collateralRaw, yesRaw: result.yesRaw, noRaw: result.noRaw, mintAmountRaw: result.mintAmountRaw }, { collateralRaw: 999_000n, yesRaw: 1_025n, noRaw: 1_030n, mintAmountRaw: 1_000n });
  assert.equal(result.projected, true);
  assert.deepEqual(result.source, { collateralRaw: 1_000_000n, yesRaw: 25n, noRaw: 30n });
});

test("zero inventory can produce a BUY feasibility when reserve headroom exists", () => {
  const result = evaluatedState({ collateral: 1.2, yes: 0, no: 0 });
  assert.equal(result.riskDecision.state, "ALLOW");
  assert.equal(result.quotePlan.bid.enabled, true);
  assert.equal(result.quotePlan.ask.enabled, false);
  assert.equal(result.quotePlan.ask.skipReason, "NO_SELL_INVENTORY");
});

test("SELL feasibility requires YES inventory", () => {
  const empty = evaluatedState({ collateral: 1.2, yes: 0, no: 0 });
  const funded = evaluatedState({ collateral: 1.2, yes: 0.01, no: 0.01 });
  assert.equal(empty.quotePlan.ask.enabled, false);
  assert.equal(empty.quotePlan.ask.skipReason, "NO_SELL_INVENTORY");
  assert.equal(funded.quotePlan.ask.enabled, true);
});

test("mint candidates are bounded by both policy cap and VillaAccount mint limit", () => {
  const candidates = generateMintCandidates({ minimumAmountRaw: 1_000n, maximumAmountRaw: DEFAULT_PHASE_3B1_CAPS.MAX_MINT_AMOUNT, stepRaw: 1_000n });
  assert.equal(candidates[0], 1_000n);
  assert.equal(candidates.at(-1), 250_000n);
  assert.equal(candidates.length, 250);
  const rejected = evaluateMintCandidate({ collateralRaw: 1_000_000n, yesRaw: 0n, noRaw: 0n, mintAmountRaw: 2_000n, minimumMintRaw: 1_000n, accountMaxOrderCollateralRaw: 1_000n, evaluateProjectedState: () => ({ riskDecision: { state: "ALLOW", permissions: { allowedActions: ["SELL_YES"] } }, quotePlan: { plan: "ONE_SIDED", ask: { enabled: true, action: "SELL_YES", targetPriceRaw: "500000", targetQuantityRaw: "1000", projectedExposure: { worstCase: { directionalUp: 1, directionalDown: 1, grossOutcome: 1 } } }, bid: { enabled: false } }, quoteExecution: { postOnly: true, orderType: 3 }, sequencePolicyValid: false }) });
  assert.equal(rejected.viable, false);
  assert.ok(rejected.reasons.some((item) => item.code === "ACCOUNT_MINT_LIMIT"));
});

test("projected quote validation enforces post-only, venue grid, risk, and pending caps", () => {
  const { riskDecision, quotePlan } = evaluatedState({ collateral: 1.2, yes: 0.01, no: 0.01 });
  const valid = validateProjectedQuote({ riskDecision, quotePlan, quoteExecution: { postOnly: true, orderType: 3, policyValid: true }, market: MARKET });
  assert.equal(valid.valid, true);
  const invalid = validateProjectedQuote({ riskDecision, quotePlan: { ...quotePlan, bid: { ...quotePlan.bid, targetPriceRaw: "510000" } }, quoteExecution: { postOnly: true, orderType: 3, policyValid: true }, market: MARKET });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.reasons.some((item) => item.code === "POST_ONLY_WOULD_CROSS"));
  const capped = validateProjectedQuote({ riskDecision, quotePlan, quoteExecution: { postOnly: true, orderType: 3, policyValid: true }, market: MARKET, pendingExposureRaw: 250_000n });
  assert.equal(capped.valid, false);
  assert.ok(capped.reasons.some((item) => item.code === "PENDING_EXPOSURE_CAP"));
  const riskCapped = validateProjectedQuote({ riskDecision, quotePlan: { ...quotePlan, bid: { ...quotePlan.bid, projectedExposure: { worstCase: { directionalUp: 10, directionalDown: 1, grossOutcome: 1 } } } }, quoteExecution: { postOnly: true, orderType: 3, policyValid: true }, market: MARKET });
  assert.equal(riskCapped.valid, false);
  assert.ok(riskCapped.reasons.some((item) => item.code === "RISK_HEADROOM"));
});

test("smallest viable mint is deterministic and unnecessary mint loses to BUY path", () => {
  const candidates = [1_000n, 2_000n, 3_000n];
  const found = findSmallestViableMint(candidates, (amount) => ({ viable: amount === 2_000n, mintAmountRaw: amount.toString() }));
  assert.equal(found.mintAmountRaw, "2000");
  assert.equal(recommendQuotePath({ buyWithoutMint: { viable: true }, sellAfterMint: found }).path, "A");
});

test("a collateral-reserve halt fails closed even when a hypothetical inventory would enable SELL", () => {
  const result = evaluateMintCandidate({ collateralRaw: 1_000_000n, yesRaw: 0n, noRaw: 0n, mintAmountRaw: 1_000n, minimumMintRaw: 1_000n, accountMaxOrderCollateralRaw: 1_000n, evaluateProjectedState: (state) => {
    const projected = evaluatedState({ collateral: Number(state.collateralRaw) / 1_000_000, yes: Number(state.yesRaw) / 1_000_000, no: Number(state.noRaw) / 1_000_000 });
    return { riskDecision: projected.riskDecision, quotePlan: projected.quotePlan, quoteExecution: { postOnly: true, orderType: 3, policyValid: false }, sequencePolicyValid: false };
  } });
  assert.equal(result.viable, false);
  assert.ok(result.reasons.some((item) => item.code === "RISK_HALTED"));
  assert.ok(result.reasons.some((item) => item.code === "PROJECTED_SEQUENCE_INVALID"));
});
