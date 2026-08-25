import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { realizedVolPerSqrtSec, perMinuteToPerSqrtSec, VolError } from "./vol.mjs";

function ticksFromReturns(startPrice, startT, dts, returns) {
  const out = [{ price: startPrice, tSec: startT }];
  let p = startPrice;
  let t = startT;
  for (let i = 0; i < returns.length; i++) {
    t += dts[i];
    p = p * Math.exp(returns[i]);
    out.push({ price: p, tSec: t });
  }
  return out;
}

describe("realizedVolPerSqrtSec", () => {
  it("recovers sigma from known log returns / elapsed", () => {
    const r = 0.001;
    const dt = 60;
    const n = 20;
    const ticks = ticksFromReturns(78000, 1_000_000, Array(n).fill(dt), Array(n).fill(r));
    const v = realizedVolPerSqrtSec(ticks, { minReturns: 10, nowSec: 1_000_000 + n * dt });
    const expected = Math.sqrt((n * r * r) / (n * dt));
    assert.ok(Math.abs(v.sigmaPerSqrtSec - expected) < 1e-12);
    assert.equal(v.returns, n);
    assert.equal(v.elapsedSec, n * dt);
    assert.equal(v.maxGapSec, dt);
    assert.ok(v.outlierRatio >= 1);
  });

  it("ignores duplicate timestamps so repeated oracle blocks do not pad n", () => {
    const ticks = [
      { price: 100, tSec: 0 },
      { price: 101, tSec: 10 },
      { price: 101, tSec: 10 },
      { price: 102, tSec: 20 },
    ];
    const v = realizedVolPerSqrtSec(ticks, { minReturns: 2, maxAgeSec: 100, nowSec: 20 });
    assert.equal(v.returns, 2);
    assert.equal(v.elapsedSec, 20);
  });

  it("rejects unordered, stale, and too-short series", () => {
    assert.throws(
      () => realizedVolPerSqrtSec([{ price: 1, tSec: 2 }, { price: 1, tSec: 1 }], { minReturns: 1 }),
      (e) => e instanceof VolError && e.code === "UNORDERED",
    );
    const ticks = ticksFromReturns(100, 0, Array(15).fill(1), Array(15).fill(0.001));
    assert.throws(
      () => realizedVolPerSqrtSec(ticks, { minReturns: 12, maxAgeSec: 5, nowSec: 1000 }),
      (e) => e.code === "STALE",
    );
    assert.throws(() => realizedVolPerSqrtSec(ticks.slice(0, 5), { minReturns: 12 }), (e) => e.code === "TOO_FEW");
  });

  it("rejects malformed ticks and oversized observation gaps", () => {
    assert.throws(
      () => realizedVolPerSqrtSec([{ price: 100, tSec: 0 }, { price: Number.NaN, tSec: 1 }], { minReturns: 1 }),
      (e) => e instanceof VolError && e.code === "BAD_TICK",
    );
    const ticks = ticksFromReturns(100, 0, [10, 10, 10], [0.001, -0.001, 0.001]);
    assert.throws(
      () => realizedVolPerSqrtSec(ticks, { minReturns: 3, maxGapSec: 5 }),
      (e) => e instanceof VolError && e.code === "GAP",
    );
  });

  it("can require minimum elapsed coverage separately from return count", () => {
    const ticks = ticksFromReturns(100, 0, Array(12).fill(1), Array(12).fill(0.001));
    assert.throws(
      () => realizedVolPerSqrtSec(ticks, { minReturns: 12, minElapsedSec: 60 }),
      (e) => e instanceof VolError && e.code === "TOO_FEW",
    );
  });

  it("flat prices with positive dt throw ZERO rather than inventing vol", () => {
    const ticks = Array.from({ length: 20 }, (_, i) => ({ price: 50, tSec: i * 10 }));
    assert.throws(() => realizedVolPerSqrtSec(ticks, { minReturns: 12, nowSec: 190 }), (e) => e.code === "ZERO");
  });
});

describe("perMinuteToPerSqrtSec", () => {
  it("divides by sqrt(60), not by 60", () => {
    const perMin = 0.000689;
    const a = perMinuteToPerSqrtSec(perMin);
    assert.equal(a, perMin / Math.sqrt(60));
    assert.notEqual(a, perMin / 60);
  });
});
