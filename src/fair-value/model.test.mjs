import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { phi } from "./math.mjs";
import {
  DATA_QUALITY_LIMITS,
  FAIR_VALUE_MODEL_VERSION,
  FairValueError,
  estimateFairValue,
} from "./model.mjs";

const SIGMA = 0.000689 / Math.sqrt(60);
const VOL = Object.freeze({
  sigmaPerSqrtSec: SIGMA,
  returns: 36,
  elapsedSec: 180,
  maxGapSec: 5,
  maxAbsLogReturn: 0.001,
  outlierRatio: 1.5,
});

function input(overrides = {}) {
  return {
    currentUnderlyingPrice: 78_400,
    referencePrice: 78_400,
    timeRemainingSec: 130,
    volatility: { ...VOL },
    dataQuality: {
      priceAgeSec: 2,
      referenceSource: "strike",
    },
    ...overrides,
  };
}

describe("phi", () => {
  it("is 0.5 at zero and monotone", () => {
    assert.ok(Math.abs(phi(0) - 0.5) < 1e-7);
    assert.ok(phi(-2) < phi(-1));
    assert.ok(phi(-1) < phi(0));
    assert.ok(phi(0) < phi(1));
    assert.ok(phi(3) > 0.998);
  });
});

describe("villa-fv-v1 qualitative behavior", () => {
  it("is neutral exactly at the reference while time remains", () => {
    const r = estimateFairValue(input());
    assert.equal(r.modelVersion, FAIR_VALUE_MODEL_VERSION);
    assert.equal(r.pUp, 0.5);
    assert.equal(r.pDown, 0.5);
    assert.ok(r.confidence > 0.5, "data quality is not the same thing as pUp certainty");
  });

  it("moves above 0.5 slightly above reference and below 0.5 slightly below", () => {
    const above = estimateFairValue(input({ currentUnderlyingPrice: 78_450 }));
    const below = estimateFairValue(input({ currentUnderlyingPrice: 78_350 }));
    assert.ok(above.pUp > 0.5);
    assert.ok(below.pUp < 0.5);
  });

  it("approaches the correct extreme for strongly above/below prices near expiry", () => {
    const above = estimateFairValue(input({ currentUnderlyingPrice: 80_000, timeRemainingSec: 8 }));
    const below = estimateFairValue(input({ currentUnderlyingPrice: 76_800, timeRemainingSec: 8 }));
    assert.ok(above.pUp > 0.999, `pUp=${above.pUp}`);
    assert.ok(below.pUp < 0.001, `pUp=${below.pUp}`);
  });

  it("higher volatility moves a non-neutral estimate toward uncertainty", () => {
    const calm = estimateFairValue(input({ currentUnderlyingPrice: 78_650, timeRemainingSec: 600 }));
    const wild = estimateFairValue(input({
      currentUnderlyingPrice: 78_650,
      timeRemainingSec: 600,
      volatility: { ...VOL, sigmaPerSqrtSec: SIGMA * 4 },
    }));
    assert.ok(Math.abs(wild.pUp - 0.5) < Math.abs(calm.pUp - 0.5));
  });

  it("shorter remaining time increases certainty in the direction of moneyness", () => {
    const aboveLong = estimateFairValue(input({ currentUnderlyingPrice: 78_650, timeRemainingSec: 600 }));
    const aboveShort = estimateFairValue(input({ currentUnderlyingPrice: 78_650, timeRemainingSec: 8 }));
    const belowLong = estimateFairValue(input({ currentUnderlyingPrice: 78_150, timeRemainingSec: 600 }));
    const belowShort = estimateFairValue(input({ currentUnderlyingPrice: 78_150, timeRemainingSec: 8 }));
    assert.ok(aboveShort.pUp > aboveLong.pUp);
    assert.ok(belowShort.pUp < belowLong.pUp);
  });

  it("settles discretely at exactly zero time", () => {
    assert.equal(estimateFairValue(input({ currentUnderlyingPrice: 78_400, timeRemainingSec: 0 })).pUp, 1);
    assert.equal(estimateFairValue(input({ currentUnderlyingPrice: 78_399, timeRemainingSec: 0 })).pUp, 0);
  });

  it("is monotone in current price", () => {
    const prices = [78_000, 78_200, 78_400, 78_600, 78_800];
    const values = prices.map((currentUnderlyingPrice) => estimateFairValue(input({ currentUnderlyingPrice })).pUp);
    for (let i = 1; i < values.length; i += 1) assert.ok(values[i] >= values[i - 1]);
  });

  it("stays bounded and sums to one", () => {
    for (const currentUnderlyingPrice of [70_000, 78_400, 90_000]) {
      const r = estimateFairValue(input({ currentUnderlyingPrice }));
      assert.ok(r.pUp >= 0 && r.pUp <= 1);
      assert.ok(r.pDown >= 0 && r.pDown <= 1);
      assert.ok(Math.abs(r.pUp + r.pDown - 1) < 1e-15);
    }
  });

  it("is deterministic for identical inputs", () => {
    assert.deepEqual(estimateFairValue(input({ currentUnderlyingPrice: 78_650 })), estimateFairValue(input({ currentUnderlyingPrice: 78_650 })));
  });

  it("does not read an extra book midpoint field", () => {
    const a = estimateFairValue(input({ currentUnderlyingPrice: 78_650 }));
    const b = estimateFairValue(input({ currentUnderlyingPrice: 78_650, bookMid: 0.22 }));
    assert.equal(a.pUp, b.pUp);
  });
});

describe("units and model guards", () => {
  it("uses seconds with per-square-root-second volatility", () => {
    const correct = estimateFairValue(input({ currentUnderlyingPrice: 78_650, timeRemainingSec: 15 * 60 }));
    const minutesMistakenForSeconds = estimateFairValue(input({ currentUnderlyingPrice: 78_650, timeRemainingSec: 15 }));
    assert.notEqual(correct.pUp, minutesMistakenForSeconds.pUp);
  });

  it("catches a per-minute volatility passed as per-square-root-second", () => {
    const correct = estimateFairValue(input({ currentUnderlyingPrice: 78_650, timeRemainingSec: 600 }));
    const wrong = estimateFairValue(input({
      currentUnderlyingPrice: 78_650,
      timeRemainingSec: 600,
      volatility: { ...VOL, sigmaPerSqrtSec: 0.000689 },
    }));
    assert.notEqual(correct.pUp, wrong.pUp);
  });

  it("refuses a remaining move that looks like mixed units", () => {
    assert.throws(
      () => estimateFairValue(input({
        timeRemainingSec: 900,
        volatility: { ...VOL, sigmaPerSqrtSec: 0.5 },
      })),
      (err) => err instanceof FairValueError && err.code === "UNIT_MISMATCH",
    );
  });

  it("keeps the quality thresholds explicit", () => {
    assert.equal(DATA_QUALITY_LIMITS.minVolReturns, 12);
    assert.equal(DATA_QUALITY_LIMITS.maxPriceAgeSec, 15);
  });
});

describe("fail-closed input handling", () => {
  it("rejects missing, zero, negative, and non-finite references", () => {
    assert.throws(() => estimateFairValue(input({ referencePrice: undefined })), FairValueError);
    assert.throws(() => estimateFairValue(input({ referencePrice: 0 })), FairValueError);
    assert.throws(() => estimateFairValue(input({ referencePrice: -1 })), FairValueError);
    assert.throws(() => estimateFairValue(input({ referencePrice: Number.NaN })), FairValueError);
  });

  it("rejects missing/invalid current price", () => {
    assert.throws(() => estimateFairValue(input({ currentUnderlyingPrice: 0 })), FairValueError);
    assert.throws(() => estimateFairValue(input({ currentUnderlyingPrice: Number.POSITIVE_INFINITY })), FairValueError);
  });

  it("rejects expired time", () => {
    assert.throws(
      () => estimateFairValue(input({ timeRemainingSec: -1 })),
      (err) => err instanceof FairValueError && err.code === "EXPIRED",
    );
  });

  it("rejects stale price data rather than returning neutral", () => {
    assert.throws(
      () => estimateFairValue(input({ dataQuality: { priceAgeSec: 16, referenceSource: "strike" } })),
      (err) => err instanceof FairValueError && err.code === "STALE_PRICE",
    );
  });

  it("rejects insufficient volatility history and zero volatility", () => {
    assert.throws(
      () => estimateFairValue(input({ volatility: { ...VOL, returns: 11 } })),
      (err) => err instanceof FairValueError && err.code === "INSUFFICIENT_VOL",
    );
    assert.throws(
      () => estimateFairValue(input({ volatility: { ...VOL, sigmaPerSqrtSec: 0 } })),
      (err) => err instanceof FairValueError && err.code === "NO_VOL",
    );
  });

  it("rejects unsupported reference sources", () => {
    assert.throws(
      () => estimateFairValue(input({ dataQuality: { priceAgeSec: 1, referenceSource: "guessed" } })),
      (err) => err instanceof FairValueError && err.code === "BAD_REFERENCE_SOURCE",
    );
  });
});
