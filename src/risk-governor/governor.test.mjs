import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RISK_CONFIG,
  assessReduceOnlyOrder,
  calculateBinaryExposure,
  calculateBinaryExposureWithAdditionalOrder,
  directionalDeltaForOrder,
  evaluateRisk,
  RISK_GOVERNOR_VERSION,
} from "./index.mjs";

const FAIR = Object.freeze({
  modelVersion: "villa-fv-v1",
  pUp: 0.6,
  pDown: 0.4,
  confidence: 0.95,
  dataQualityStatus: "HIGH",
  referenceSource: "strike",
  realizedVolPerSqrtSec: 0.0001,
});

const BASE = Object.freeze({
  fairValue: FAIR,
  chainTime: {
    chainNowSec: 1_000,
    observationAgeSec: 1,
    blockNumber: 22,
    localNowMs: 1_000_000,
    observedAtLocalMs: 999_000,
    clockOffsetSec: 0,
  },
  feed: { price: 78_500, timestampSec: 999, sourceAgeSec: 2 },
  market: {
    status: 1,
    expirySec: 1_300,
    reference: { status: "VALID", source: "strike", scaleExponent10: 2 },
  },
  inventory: { yes: 0, no: 0 },
  openOrdersStatus: "VERIFIED",
  openOrders: [],
  capital: { collateralAvailable: 100, capitalAtRisk: 0 },
  gas: { nativeBalance: 1 },
  drawdown: { status: "AVAILABLE", ratio: 0 },
});

function snapshot(overrides = {}) {
  return {
    ...BASE,
    ...overrides,
    fairValue: { ...BASE.fairValue, ...(overrides.fairValue ?? {}) },
    chainTime: { ...BASE.chainTime, ...(overrides.chainTime ?? {}) },
    feed: { ...BASE.feed, ...(overrides.feed ?? {}) },
    market: {
      ...BASE.market,
      ...(overrides.market ?? {}),
      reference: { ...BASE.market.reference, ...(overrides.market?.reference ?? {}) },
    },
    inventory: { ...BASE.inventory, ...(overrides.inventory ?? {}) },
    capital: { ...BASE.capital, ...(overrides.capital ?? {}) },
    gas: { ...BASE.gas, ...(overrides.gas ?? {}) },
    drawdown: overrides.drawdown === undefined ? BASE.drawdown : overrides.drawdown,
  };
}

function decisionSignature(result) {
  return {
    state: result.state,
    permissions: result.permissions,
    cancelExisting: result.cancelExisting,
    maxAdditionalExposure: result.maxAdditionalExposure,
    sizeMultiplier: result.sizeMultiplier,
    primaryReasonCode: result.primaryReasonCode,
    triggeredRules: result.triggeredRules,
    warnings: result.warnings,
  };
}

describe("villa-risk-v1 healthy boundary", () => {
  it("allows a complete healthy snapshot", () => {
    const result = evaluateRisk(snapshot());
    assert.equal(result.governorVersion, RISK_GOVERNOR_VERSION);
    assert.equal(result.state, "ALLOW");
    assert.equal(result.primaryReasonCode, "NONE");
    assert.equal(result.cancelExisting, false);
    assert.deepEqual(result.permissions.allowedActions, ["BUY_YES", "SELL_YES", "BUY_NO", "SELL_NO"]);
  });

  it("is deterministic for identical input", () => {
    assert.deepEqual(evaluateRisk(snapshot()), evaluateRisk(snapshot()));
  });

  it("does not use a book/model comparison field", () => {
    const a = evaluateRisk(snapshot({ bookComparison: { midpoint: 0.1, difference: 0.5 } }));
    const b = evaluateRisk(snapshot({ bookComparison: { midpoint: 0.9, difference: -0.3 } }));
    assert.deepEqual(decisionSignature(a), decisionSignature(b));
  });

  it("keeps a normal high volatility observation from halting by itself", () => {
    const result = evaluateRisk(snapshot({ fairValue: { realizedVolPerSqrtSec: 0.01 } }));
    assert.equal(result.state, "ALLOW");
  });

  it("does not let local clock offset change the decision", () => {
    const normal = evaluateRisk(snapshot());
    const offset = evaluateRisk(snapshot({
      chainTime: { localNowMs: 2_000_000, observedAtLocalMs: 1_999_000, clockOffsetSec: -600 },
    }));
    assert.deepEqual(decisionSignature(normal), decisionSignature(offset));
    assert.equal(offset.authoritativeTime.chainNowSec, 1_000);
    assert.equal(offset.authoritativeTime.timeRemainingSec, 300);
  });

  it("allows exactly the configured expiry headroom", () => {
    const result = evaluateRisk(snapshot({ market: { expirySec: 1_030 } }));
    assert.equal(result.state, "ALLOW");
  });
});

describe("villa-risk-v1 data gates", () => {
  it("halts an invalid probability", () => {
    const result = evaluateRisk(snapshot({ fairValue: { pUp: 1.1, pDown: -0.1 } }));
    assert.equal(result.state, "HALT");
    assert.equal(result.primaryReasonCode, "FAIR_VALUE_INVALID");
  });

  it("halts a probability pair that does not sum to one", () => {
    const result = evaluateRisk(snapshot({ fairValue: { pUp: 0.6, pDown: 0.5 } }));
    assert.equal(result.primaryReasonCode, "FAIR_VALUE_INVALID");
  });

  it("halts an explicitly refused fair value", () => {
    const result = evaluateRisk(snapshot({ fairValue: { valid: false } }));
    assert.equal(result.primaryReasonCode, "FAIR_VALUE_INVALID");
  });

  it("halts low model confidence", () => {
    const result = evaluateRisk(snapshot({ fairValue: { confidence: 0.74 } }));
    assert.equal(result.primaryReasonCode, "MODEL_CONFIDENCE_LOW");
  });

  it("halts LOW data quality even if the numeric confidence was inconsistent", () => {
    const result = evaluateRisk(snapshot({ fairValue: { dataQualityStatus: "LOW", confidence: 0.9 } }));
    assert.equal(result.primaryReasonCode, "MODEL_DATA_QUALITY_LOW");
  });

  it("halts missing chain time", () => {
    const result = evaluateRisk(snapshot({ chainTime: { chainNowSec: undefined, observationAgeSec: undefined } }));
    assert.ok(result.triggeredRules.includes("CHAIN_TIME_INVALID"));
    assert.equal(result.state, "HALT");
  });

  it("halts stale chain time", () => {
    const result = evaluateRisk(snapshot({ chainTime: { observationAgeSec: 16 } }));
    assert.equal(result.primaryReasonCode, "CHAIN_TIME_STALE");
  });

  it("halts missing price and timestamp", () => {
    const result = evaluateRisk(snapshot({ feed: { price: undefined, timestampSec: undefined } }));
    assert.equal(result.primaryReasonCode, "PRICE_INVALID");
  });

  it("halts a stale price by chain timestamp", () => {
    const result = evaluateRisk(snapshot({ feed: { timestampSec: 984 } }));
    assert.equal(result.primaryReasonCode, "PRICE_STALE");
  });

  it("halts a materially future price timestamp", () => {
    const result = evaluateRisk(snapshot({ feed: { timestampSec: 1_006 } }));
    assert.equal(result.primaryReasonCode, "PRICE_TIMESTAMP_FUTURE");
  });

  it("halts a non-monotonic feed observation", () => {
    const result = evaluateRisk(snapshot({ feed: { timestampStatus: "NON_MONOTONIC" } }));
    assert.equal(result.primaryReasonCode, "PRICE_TIMESTAMP_NON_MONOTONIC");
  });

  it("halts a stale upstream source age", () => {
    const result = evaluateRisk(snapshot({ feed: { sourceAgeSec: 61 } }));
    assert.equal(result.primaryReasonCode, "PRICE_STALE");
  });

  it("halts a market that is not Trading", () => {
    const result = evaluateRisk(snapshot({ market: { status: 2 } }));
    assert.equal(result.primaryReasonCode, "MARKET_NOT_TRADING");
  });

  it("halts a malformed market status", () => {
    const result = evaluateRisk(snapshot({ market: { status: "unknown" } }));
    assert.equal(result.primaryReasonCode, "MARKET_STATUS_INVALID");
  });

  it("halts an expired market", () => {
    const result = evaluateRisk(snapshot({ market: { expirySec: 999 } }));
    assert.equal(result.primaryReasonCode, "MARKET_EXPIRED");
  });

  it("halts a market below expiry headroom", () => {
    const result = evaluateRisk(snapshot({ market: { expirySec: 1_029 } }));
    assert.equal(result.primaryReasonCode, "EXPIRY_TOO_CLOSE");
  });

  it("halts a missing reference", () => {
    const result = evaluateRisk(snapshot({ market: { reference: { status: "MISSING" } } }));
    assert.equal(result.primaryReasonCode, "REFERENCE_INVALID");
  });

  it("halts an ambiguous reference", () => {
    const result = evaluateRisk(snapshot({ market: { reference: { status: "AMBIGUOUS" } } }));
    assert.equal(result.primaryReasonCode, "REFERENCE_AMBIGUOUS");
  });

  it("halts unsupported reference scaling", () => {
    const result = evaluateRisk(snapshot({ market: { reference: { status: "UNSUPPORTED" } } }));
    assert.equal(result.primaryReasonCode, "REFERENCE_SCALING_UNSUPPORTED");
  });

  it("halts an invalid reference exponent", () => {
    const result = evaluateRisk(snapshot({ market: { reference: { scaleExponent10: 19 } } }));
    assert.equal(result.primaryReasonCode, "REFERENCE_SCALING_UNSUPPORTED");
  });

  it("halts an ambiguous open-order read", () => {
    const result = evaluateRisk(snapshot({ openOrdersStatus: "AMBIGUOUS" }));
    assert.equal(result.primaryReasonCode, "OPEN_ORDER_STATE_INVALID");
  });

  it("halts missing capital accounting fields", () => {
    const result = evaluateRisk(snapshot({ capital: { collateralAvailable: 100, capitalAtRisk: undefined } }));
    assert.equal(result.primaryReasonCode, "INVALID_STATE");
  });

  it("halts missing gas state", () => {
    const result = evaluateRisk(snapshot({ gas: { nativeBalance: undefined } }));
    assert.equal(result.primaryReasonCode, "INVALID_STATE");
  });
});

describe("binary inventory and pending-order exposure", () => {
  it("uses the verified signed deltas for all four binary order actions", () => {
    const order = (side, outcome, remainingQty = 2) => directionalDeltaForOrder({ side, outcome, remainingQty });
    assert.equal(order("BUY", "YES").delta, 2);
    assert.equal(order("SELL", "YES").delta, -2);
    assert.equal(order("BUY", "NO").delta, -2);
    assert.equal(order("SELL", "NO").delta, 2);
  });

  it("treats matched YES and NO as complete sets, not directional exposure", () => {
    const exposure = calculateBinaryExposure({ yes: 8, no: 8, openOrders: [] });
    assert.equal(exposure.current.completeSets, 8);
    assert.equal(exposure.current.directionalUp, 0);
    assert.equal(exposure.current.directionalDown, 0);
    const result = evaluateRisk(snapshot({ inventory: { yes: 8, no: 8 } }));
    assert.equal(result.state, "ALLOW");
  });

  it("sees a balanced inventory SELL_YES as potential DOWN exposure", () => {
    const exposure = calculateBinaryExposure({
      yes: 10,
      no: 10,
      openOrders: [{ outcome: "YES", side: "SELL", remainingQty: 5 }],
    });
    assert.equal(exposure.current.completeSets, 10);
    assert.equal(exposure.current.directionalBalance, 0);
    assert.equal(exposure.directionalStress.worstDown.postFillBalance, -5);
    assert.equal(exposure.worstCase.directionalDown, 5);
  });

  it("sees a balanced inventory SELL_NO as potential UP exposure", () => {
    const exposure = calculateBinaryExposure({
      yes: 10,
      no: 10,
      openOrders: [{ outcome: "NO", side: "SELL", remainingQty: 5 }],
    });
    assert.equal(exposure.directionalStress.worstUp.postFillBalance, 5);
    assert.equal(exposure.worstCase.directionalUp, 5);
  });

  it("counts BUY_YES and BUY_NO from a balanced inventory in opposite stress directions", () => {
    const up = calculateBinaryExposure({ yes: 10, no: 10, openOrders: [{ outcome: "YES", side: "BUY", remainingQty: 4 }] });
    const down = calculateBinaryExposure({ yes: 10, no: 10, openOrders: [{ outcome: "NO", side: "BUY", remainingQty: 4 }] });
    assert.equal(up.worstCase.directionalUp, 4);
    assert.equal(down.worstCase.directionalDown, 4);
  });

  it("accumulates multiple pending BUY_YES orders in worst-case UP exposure", () => {
    const exposure = calculateBinaryExposure({
      yes: 0,
      no: 0,
      openOrders: [
        { outcome: "YES", side: "BUY", remainingQty: 3 },
        { outcome: "YES", side: "BUY", remainingQty: 4 },
      ],
    });
    assert.equal(exposure.worstCase.directionalUp, 7);
  });

  it("accumulates multiple pending SELL_NO orders in worst-case UP exposure", () => {
    const exposure = calculateBinaryExposure({
      yes: 10,
      no: 10,
      openOrders: [
        { outcome: "NO", side: "SELL", remainingQty: 2 },
        { outcome: "NO", side: "SELL", remainingQty: 3 },
      ],
    });
    assert.equal(exposure.worstCase.directionalUp, 5);
  });

  it("accumulates mixed BUY_YES and SELL_NO in the same UP-risk direction", () => {
    const exposure = calculateBinaryExposure({
      yes: 10,
      no: 10,
      openOrders: [
        { outcome: "YES", side: "BUY", remainingQty: 2 },
        { outcome: "NO", side: "SELL", remainingQty: 3 },
      ],
    });
    assert.equal(exposure.pendingRiskIncrease.directionalUp, 5);
    assert.equal(exposure.worstCase.directionalUp, 5);
  });

  it("accumulates mixed BUY_NO and SELL_YES in the same DOWN-risk direction", () => {
    const exposure = calculateBinaryExposure({
      yes: 10,
      no: 10,
      openOrders: [
        { outcome: "NO", side: "BUY", remainingQty: 2 },
        { outcome: "YES", side: "SELL", remainingQty: 3 },
      ],
    });
    assert.equal(exposure.pendingRiskIncrease.directionalDown, 5);
    assert.equal(exposure.worstCase.directionalDown, 5);
  });

  it("does not net opposing pending orders into a falsely neutral stress case", () => {
    const exposure = calculateBinaryExposure({
      yes: 0,
      no: 0,
      openOrders: [
        { outcome: "YES", side: "BUY", remainingQty: 8 },
        { outcome: "NO", side: "BUY", remainingQty: 8 },
      ],
    });
    assert.equal(exposure.worstCase.directionalUp, 8);
    assert.equal(exposure.worstCase.directionalDown, 8);
  });

  it("can project one proposed order together with every resting order", () => {
    const projected = calculateBinaryExposureWithAdditionalOrder({
      yes: 5,
      no: 0,
      openOrders: [{ outcome: "YES", side: "BUY", remainingQty: 2 }],
    }, { outcome: "NO", side: "SELL", remainingQty: 3 });
    assert.equal(projected.worstCase.directionalUp, 10);
    assert.equal(projected.openOrderSummary.count, 2);
  });

  it("reports a YES residual as UP exposure", () => {
    const exposure = calculateBinaryExposure({ yes: 9, no: 4, openOrders: [] });
    assert.equal(exposure.current.completeSets, 4);
    assert.equal(exposure.current.directionalUp, 5);
    assert.equal(exposure.current.directionalDown, 0);
  });

  it("reports a NO residual as DOWN exposure", () => {
    const exposure = calculateBinaryExposure({ yes: 4, no: 9, openOrders: [] });
    assert.equal(exposure.current.directionalUp, 0);
    assert.equal(exposure.current.directionalDown, 5);
  });

  it("counts a risk-increasing BUY in worst-case exposure", () => {
    const result = evaluateRisk(snapshot({
      inventory: { yes: 5, no: 0 },
      openOrders: [{ outcome: "YES", side: "BUY", remainingQty: 4 }],
    }));
    assert.equal(result.exposure.worstCase.directionalUp, 9);
    assert.equal(result.state, "REDUCE_ONLY");
    assert.deepEqual(result.permissions.allowedActions, ["SELL_YES", "BUY_NO"]);
  });

  it("does not assume a pending SELL will reduce worst-case exposure", () => {
    const result = evaluateRisk(snapshot({
      inventory: { yes: 8, no: 0 },
      openOrders: [{ outcome: "YES", side: "SELL", remainingQty: 8 }],
    }));
    assert.equal(result.exposure.worstCase.directionalUp, 8);
    assert.equal(result.state, "REDUCE_ONLY");
  });

  it("lets an existing SELL independently reach the soft and hard boundaries", () => {
    const exposureOnlyConfig = { ...DEFAULT_RISK_CONFIG, grossExposureHard: 100 };
    const soft = evaluateRisk(snapshot({
      inventory: { yes: 10, no: 10 },
      openOrders: [{ outcome: "YES", side: "SELL", remainingQty: 7 }],
    }), exposureOnlyConfig);
    const hard = evaluateRisk(snapshot({
      inventory: { yes: 10, no: 10 },
      openOrders: [{ outcome: "YES", side: "SELL", remainingQty: 10 }],
    }), exposureOnlyConfig);
    assert.equal(soft.state, "REDUCE_ONLY");
    assert.equal(soft.exposure.worstCase.directionalDown, 7);
    assert.equal(hard.primaryReasonCode, "DIRECTIONAL_EXPOSURE_HARD");
  });

  it("lets an existing BUY independently reach the soft and hard boundaries", () => {
    const soft = evaluateRisk(snapshot({
      openOrders: [{ outcome: "YES", side: "BUY", remainingQty: 7 }],
    }));
    const hard = evaluateRisk(snapshot({
      openOrders: [{ outcome: "YES", side: "BUY", remainingQty: 10 }],
    }));
    assert.equal(soft.state, "REDUCE_ONLY");
    assert.equal(hard.primaryReasonCode, "DIRECTIONAL_EXPOSURE_HARD");
  });

  it("caps a +5 UP reduce-only SELL_YES at three units without crossing neutral", () => {
    const three = assessReduceOnlyOrder(5, { outcome: "YES", side: "SELL", remainingQty: 3 });
    const five = assessReduceOnlyOrder(5, { outcome: "YES", side: "SELL", remainingQty: 5 });
    const eight = assessReduceOnlyOrder(5, { outcome: "YES", side: "SELL", remainingQty: 8 });
    assert.equal(three.permitted, true);
    assert.equal(three.safeDirectionalBalance, 2);
    assert.equal(five.permitted, true);
    assert.equal(five.safeDirectionalBalance, 0);
    assert.equal(eight.permitted, false);
    assert.equal(eight.maxPermittedQuantity, 5);
    assert.equal(eight.safeQuantity, 5);
    assert.equal(eight.safeDirectionalBalance, 0);
  });

  it("applies the inverse reduce-only cap to a -5 DOWN balance", () => {
    const three = assessReduceOnlyOrder(-5, { outcome: "YES", side: "BUY", remainingQty: 3 });
    const five = assessReduceOnlyOrder(-5, { outcome: "NO", side: "SELL", remainingQty: 5 });
    const eight = assessReduceOnlyOrder(-5, { outcome: "YES", side: "BUY", remainingQty: 8 });
    assert.equal(three.permitted, true);
    assert.equal(three.safeDirectionalBalance, -2);
    assert.equal(five.safeDirectionalBalance, 0);
    assert.equal(eight.permitted, false);
    assert.equal(eight.maxPermittedQuantity, 5);
  });

  it("does not classify a risk-increasing action as reduce-only", () => {
    const result = assessReduceOnlyOrder(5, { outcome: "YES", side: "BUY", remainingQty: 1 });
    assert.equal(result.permitted, false);
    assert.equal(result.maxPermittedQuantity, 0);
  });

  it("exposes no reduce-only action when current directional balance is neutral", () => {
    const exposure = calculateBinaryExposure({ yes: 10, no: 10, openOrders: [] });
    assert.deepEqual(exposure.reduceOnlyPolicy.permittedActions, []);
    assert.equal(exposure.reduceOnlyPolicy.maxQuantityBeforeNeutral, 0);
  });

  it("does not grant reduce-only permission to cross neutral when pending risk triggers it", () => {
    const result = evaluateRisk(snapshot({
      openOrders: [{ outcome: "YES", side: "BUY", remainingQty: 7 }],
    }));
    assert.equal(result.state, "REDUCE_ONLY");
    assert.deepEqual(result.permissions.allowedActions, []);
    assert.equal(result.permissions.allowReduceOnly, false);
  });

  it("halts at the hard directional exposure limit", () => {
    const result = evaluateRisk(snapshot({ inventory: { yes: 10, no: 0 } }));
    assert.equal(result.primaryReasonCode, "DIRECTIONAL_EXPOSURE_HARD");
    assert.equal(result.cancelExisting, true);
    assert.equal(result.permissions.allowedActions.length, 0);
  });

  it("warns and reduces size before the soft boundary", () => {
    const result = evaluateRisk(snapshot({ inventory: { yes: 6, no: 0 } }));
    assert.equal(result.state, "ALLOW");
    assert.equal(result.sizeMultiplier, 0.5);
    assert.ok(result.warnings.includes("DIRECTIONAL_EXPOSURE_WARNING"));
  });

  it("uses reduce-only at the soft boundary", () => {
    const result = evaluateRisk(snapshot({ inventory: { yes: 7, no: 0 } }));
    assert.equal(result.state, "REDUCE_ONLY");
    assert.equal(result.primaryReasonCode, "DIRECTIONAL_EXPOSURE_SOFT");
    assert.equal(result.maxAdditionalExposure.directionalUp, 0);
  });

  it("halts hard gross exposure even when it is directionally matched", () => {
    const result = evaluateRisk(snapshot({ inventory: { yes: 10, no: 10 } }));
    assert.ok(result.triggeredRules.includes("GROSS_EXPOSURE_HARD"));
    assert.equal(result.state, "HALT");
  });

  it("rejects negative inventory instead of treating it as a short", () => {
    const result = evaluateRisk(snapshot({ inventory: { yes: -1, no: 0 } }));
    assert.ok(result.triggeredRules.includes("EXPOSURE_INVALID"));
    assert.equal(result.state, "HALT");
  });

  it("rejects malformed open-order side", () => {
    const result = evaluateRisk(snapshot({ openOrders: [{ outcome: "YES", side: "MAYBE", remainingQty: 1 }] }));
    assert.equal(result.primaryReasonCode, "EXPOSURE_INVALID");
  });
});

describe("capital, gas, drawdown, and emergency rules", () => {
  it("halts capital at its hard limit", () => {
    const result = evaluateRisk(snapshot({ capital: { collateralAvailable: 100, capitalAtRisk: 100 } }));
    assert.equal(result.primaryReasonCode, "CAPITAL_LIMIT_HARD");
  });

  it("halts when collateral reserve is below policy", () => {
    const result = evaluateRisk(snapshot({ capital: { collateralAvailable: 0.99, capitalAtRisk: 0 } }));
    assert.ok(result.triggeredRules.includes("COLLATERAL_RESERVE_LOW"));
    assert.equal(result.state, "HALT");
  });

  it("halts when native gas reserve is below policy", () => {
    const result = evaluateRisk(snapshot({ gas: { nativeBalance: 0.099 } }));
    assert.equal(result.primaryReasonCode, "GAS_RESERVE_LOW");
  });

  it("warns on drawdown without inventing an accounting value", () => {
    const result = evaluateRisk(snapshot({ drawdown: { status: "AVAILABLE", ratio: 0.03 } }));
    assert.equal(result.state, "ALLOW");
    assert.equal(result.sizeMultiplier, 0.5);
    assert.ok(result.warnings.includes("DRAWDOWN_WARNING"));
  });

  it("halts at the drawdown hard stop", () => {
    const result = evaluateRisk(snapshot({ drawdown: { status: "AVAILABLE", ratio: 0.05 } }));
    assert.equal(result.primaryReasonCode, "DRAWDOWN_HARD_STOP");
    assert.equal(result.cancelExisting, true);
  });

  it("makes unavailable drawdown explicit when the optional boundary is used", () => {
    const result = evaluateRisk(snapshot({ drawdown: { status: "UNAVAILABLE" } }));
    assert.equal(result.state, "ALLOW");
    assert.ok(result.warnings.includes("DRAWDOWN_UNACCOUNTED"));
    const strict = evaluateRisk(snapshot({ drawdown: { status: "UNAVAILABLE" } }), {
      ...DEFAULT_RISK_CONFIG,
      requireDrawdownAccounting: true,
    });
    assert.equal(strict.primaryReasonCode, "DRAWDOWN_INVALID");
  });

  it("halts an explicitly configured emergency volatility", () => {
    const result = evaluateRisk(
      snapshot({ fairValue: { realizedVolPerSqrtSec: 0.011 } }),
      { ...DEFAULT_RISK_CONFIG, maxEmergencyVolatilityPerSqrtSec: 0.01 },
    );
    assert.equal(result.primaryReasonCode, "VOLATILITY_EMERGENCY");
  });
});

describe("configuration and output contract", () => {
  it("rejects an unversioned configuration", () => {
    const result = evaluateRisk(snapshot(), { ...DEFAULT_RISK_CONFIG, version: "villa-risk-v0" });
    assert.equal(result.state, "HALT");
    assert.equal(result.primaryReasonCode, "CONFIG_INVALID");
  });

  it("returns authoritative chain-time and exposure facts", () => {
    const result = evaluateRisk(snapshot());
    assert.equal(result.authoritativeTime.chainNowSec, 1_000);
    assert.equal(result.authoritativeTime.timeRemainingSec, 300);
    assert.equal(result.exposure.current.completeSets, 0);
    assert.equal(result.exposure.worstCase.grossOutcome, 0);
    assert.equal(result.configurationVersion, "villa-risk-v1");
  });

  it("keeps a halt recommendation separate from execution", () => {
    const result = evaluateRisk(snapshot({ market: { status: 2 } }));
    assert.equal(result.cancelExisting, true);
    assert.equal(result.permissions.allowedActions.length, 0);
    assert.equal(result.exposure.current.grossOutcome, 0);
  });
});
