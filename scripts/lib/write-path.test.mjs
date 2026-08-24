import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toRaw,
  fromRaw,
  snapDownRaw,
  isOnGrid,
  minValidQuantity,
  selectRestingBuyPrice,
  buyEscrow,
  hasExpiryHeadroom,
  rejectMarket,
  compareCandidates,
  orderExpireNs,
  assertSufficientStt,
  assertSufficientCollateral,
  isPostOnlyWouldCross,
  WritePathError,
} from "./write-path.mjs";

const DEC = 6;
const ONE = 10n ** BigInt(DEC);
const TICK = 1000n; // 0.001
const LOT = 1000n;

describe("toRaw / fromRaw", () => {
  it("round-trips 6-decimal amounts", () => {
    assert.equal(toRaw("1.5", DEC), 1_500_000n);
    assert.equal(fromRaw(1_500_000n, DEC), "1.5");
    assert.equal(toRaw(0.001, DEC), TICK);
  });
  it("rejects extra fractional digits", () => {
    assert.throws(() => toRaw("1.1234567", DEC), WritePathError);
  });
});

describe("grid", () => {
  it("snaps down to the tick", () => {
    assert.equal(snapDownRaw(2501n, TICK), 2000n);
    assert.ok(isOnGrid(2000n, TICK));
    assert.equal(isOnGrid(2501n, TICK), false);
  });
  it("minValidQuantity is at least lot and minQuantity", () => {
    assert.equal(minValidQuantity({ lotSize: LOT, minQuantity: LOT }), LOT);
    assert.equal(minValidQuantity({ lotSize: LOT, minQuantity: 2500n }), 3000n);
  });
});

describe("selectRestingBuyPrice", () => {
  it("parks below the bid and does not reach the ask", () => {
    const bid = toRaw("0.259", DEC);
    const ask = toRaw("0.286", DEC);
    const px = selectRestingBuyPrice({ bestBid: bid, bestAsk: ask, tickSize: TICK, one: ONE });
    assert.ok(isOnGrid(px, TICK));
    assert.ok(px < bid);
    assert.ok(px < ask);
    assert.ok(px > 0n);
  });
  it("uses a deep price on an empty book", () => {
    const px = selectRestingBuyPrice({ tickSize: TICK, one: ONE });
    assert.ok(px < ONE);
    assert.ok(isOnGrid(px, TICK));
  });
  it("throws WOULD_CROSS when the only valid tick would take the ask", () => {
    assert.throws(
      () =>
        selectRestingBuyPrice({
          bestAsk: TICK,
          tickSize: TICK,
          one: ONE,
        }),
      (e) => e instanceof WritePathError && e.code === "WOULD_CROSS",
    );
  });
  it("pulls a too-high candidate under the ask", () => {
    const ask = toRaw("0.05", DEC);
    const bid = toRaw("0.20", DEC);
    const px = selectRestingBuyPrice({ bestBid: bid, bestAsk: ask, tickSize: TICK, one: ONE });
    assert.ok(px < ask);
  });
});

describe("buyEscrow", () => {
  it("matches ceil(qty * price / one)", () => {
    const qty = LOT;
    const price = toRaw("0.05", DEC);
    assert.equal(buyEscrow(qty, price, ONE), 50n);
  });
});

describe("expiry / market selection", () => {
  it("rejects short intervals and thin headroom", () => {
    const now = 1_000_000;
    assert.equal(
      rejectMarket({ asset: "ETH", intervalSec: 900, expirySec: now + 500, status: 1, nowSec: now })?.reject.includes("BTC"),
      true,
    );
    assert.equal(
      rejectMarket({ asset: "BTC", intervalSec: 60, expirySec: now + 500, status: 1, nowSec: now })?.reject.includes("interval"),
      true,
    );
    assert.equal(
      rejectMarket({ asset: "BTC", intervalSec: 300, expirySec: now + 10, status: 1, nowSec: now })?.reject.includes("headroom"),
      true,
    );
    assert.equal(
      rejectMarket({ asset: "BTC", intervalSec: 300, expirySec: now + 10, status: 2, nowSec: now })?.reject.includes("status"),
      true,
    );
    assert.equal(
      rejectMarket({ asset: "BTC", intervalSec: 300, expirySec: now + 180, status: 1, nowSec: now }),
      null,
    );
    assert.equal(hasExpiryHeadroom(now + 119, now, 120), false);
    assert.equal(hasExpiryHeadroom(now + 120, now, 120), true);
  });
  it("prefers longer intervals then more time left", () => {
    const now = 0;
    const a = { intervalSec: 300, expirySec: 1000, nowSec: now };
    const b = { intervalSec: 900, expirySec: 400, nowSec: now };
    assert.ok(compareCandidates(a, b) > 0);
  });
  it("caps order expiry at market expiry", () => {
    const ns = orderExpireNs({ nowSec: 100, marketExpirySec: 200, lifetimeSec: 300 });
    assert.equal(ns, 198n * 1_000_000_000n);
  });
});

describe("balances", () => {
  it("refuses insufficient STT and tUSDC without sending", () => {
    assert.throws(() => assertSufficientStt(0n, 1n), (e) => e.code === "INSUFFICIENT_STT");
    assert.throws(() => assertSufficientCollateral(10n, 11n), (e) => e.code === "INSUFFICIENT_TUSDC");
    assert.doesNotThrow(() => assertSufficientStt(5n, 5n));
    assert.doesNotThrow(() => assertSufficientCollateral(11n, 11n));
  });
});

describe("PostOnlyWouldCross", () => {
  it("detects the named revert", () => {
    assert.equal(isPostOnlyWouldCross({ errorName: "PostOnlyWouldCross" }), true);
    assert.equal(isPostOnlyWouldCross({ message: "boom" }), false);
  });
});
