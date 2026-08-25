import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scaleRawToSpot, resolveReference, ReferenceError } from "./reference.mjs";

describe("scaleRawToSpot", () => {
  it("maps a live-shaped BTC strike onto spot (cents)", () => {
    const spot = 78434.515;
    const scaled = scaleRawToSpot("7845797", spot);
    assert.ok(scaled !== null);
    assert.ok(Math.abs(scaled.price - 78457.97) < 1e-6);
    assert.equal(scaled.scaleExponent10, 2);
    assert.ok(scaled.logDistance < Math.log(2));
  });

  it("maps a live-shaped opening raw the same way", () => {
    const scaled = scaleRawToSpot("7842383", 78434.515);
    assert.ok(scaled !== null);
    assert.ok(Math.abs(scaled.price - 78423.83) < 1e-6);
  });

  it("refuses a raw value more than 2x from spot at every scale", () => {
    assert.equal(scaleRawToSpot("1", 78434), null);
    assert.equal(scaleRawToSpot("0", 78434), null);
    assert.equal(scaleRawToSpot("", 78434), null);
  });
});

describe("resolveReference", () => {
  it("uses explicit strike when non-zero", () => {
    const r = resolveReference({ strike: "7845797", spot: 78434.515 });
    assert.equal(r.kind, "strike");
    assert.ok(Math.abs(r.price - 78457.97) < 1e-6);
    assert.equal(r.scaleExponent10, 2);
  });

  it("requires opening price when strike is 0", () => {
    assert.throws(
      () => resolveReference({ strike: "0", spot: 78434.515 }),
      (e) => e instanceof ReferenceError && e.code === "MISSING_OPENING",
    );
    const r = resolveReference({ strike: "0", openingRaw: "7842383", spot: 78434.515 });
    assert.equal(r.kind, "opening");
    assert.ok(Math.abs(r.price - 78423.83) < 1e-6);
    assert.equal(r.scaleExponent10, 2);
  });

  it("does not parse question text — there is no question argument", () => {
    assert.equal(resolveReference.length, 1);
    const r = resolveReference({
      strike: "249265",
      spot: 2492.65,
      question: "will ETH close above its opening price of something invented",
    });
    assert.equal(r.kind, "strike");
    assert.ok(Math.abs(r.price - 2492.65) < 1e-6);
  });

  it("rejects non-integer raw scaling instead of silently parsing decimals", () => {
    assert.equal(scaleRawToSpot("78457.97", 78434.515), null);
  });

  it("rejects invalid spot before resolving a reference", () => {
    assert.throws(() => resolveReference({ strike: "1", spot: 0 }), (e) => e instanceof ReferenceError && e.code === "NO_SPOT");
  });
});
