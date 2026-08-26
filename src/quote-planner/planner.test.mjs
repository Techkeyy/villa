import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_QUOTE_CONFIG,
  QUOTE_PLANNER_VERSION,
  decimalToRaw,
  planQuotes,
} from "./index.mjs";

const GRID = Object.freeze({
  decimals: 6,
  oneRaw: "1000000",
  tickSizeRaw: "1000",
  lotSizeRaw: "1000",
  minQuantityRaw: "1000",
});

const FAIR = Object.freeze({
  modelVersion: "villa-fv-v1",
  pUp: 0.6,
  pDown: 0.4,
  confidence: 0.9,
  dataQualityStatus: "HIGH",
  realizedVolPerSqrtSec: 0.0001,
  timeRemainingSec: 120,
});

const GOVERNOR = Object.freeze({
  state: "ALLOW",
  permissions: { allowedActions: ["BUY_YES", "SELL_YES"] },
  sizeMultiplier: 1,
  directionalRiskCapacity: 10,
  limits: { directionalExposureHard: 10, grossExposureHard: 20 },
  triggeredRules: [],
  warnings: [],
});

const BASE = Object.freeze({
  fairValue: FAIR,
  governor: GOVERNOR,
  inventory: { yes: 5, no: 5 },
  pendingOrders: [],
  book: { bestBidRaw: "550000", bestAskRaw: "650000" },
  grid: GRID,
  capital: { collateralAvailable: 100, collateralReserve: 1 },
  market: { marketId: "btc-5m", timeRemainingSec: 120 },
  quote: { baseQuantityRaw: "1000000" },
});

function input(overrides = {}) {
  return {
    ...BASE,
    ...overrides,
    fairValue: { ...BASE.fairValue, ...(overrides.fairValue ?? {}) },
    governor: { ...BASE.governor, ...(overrides.governor ?? {}), permissions: { ...BASE.governor.permissions, ...(overrides.governor?.permissions ?? {}) }, limits: { ...BASE.governor.limits, ...(overrides.governor?.limits ?? {}) } },
    inventory: { ...BASE.inventory, ...(overrides.inventory ?? {}) },
    book: { ...BASE.book, ...(overrides.book ?? {}) },
    market: { ...BASE.market, ...(overrides.market ?? {}) },
    capital: { ...BASE.capital, ...(overrides.capital ?? {}) },
    quote: { ...BASE.quote, ...(overrides.quote ?? {}) },
  };
}

function enabledSides(result) {
  return { bid: result.bid.enabled, ask: result.ask.enabled };
}

describe("villa-quote-v1 baseline and governor permissions", () => {
  it("produces two-sided quotes for healthy neutral inventory", () => {
    const result = planQuotes(input());
    assert.equal(result.plannerVersion, QUOTE_PLANNER_VERSION);
    assert.equal(result.plan, "ACTIVE");
    assert.deepEqual(enabledSides(result), { bid: true, ask: true });
  });

  it("halts all quotes and preserves governor reasons", () => {
    const result = planQuotes(input({ governor: { state: "HALT", permissions: { allowedActions: [] }, triggeredRules: ["PRICE_STALE"], warnings: ["DRAWDOWN_UNACCOUNTED"] } }));
    assert.equal(result.plan, "NO_QUOTE");
    assert.deepEqual(enabledSides(result), { bid: false, ask: false });
    assert.deepEqual(result.governor.triggeredRules, ["PRICE_STALE"]);
    assert.ok(result.reasonCodes.includes("GOVERNOR_HALT"));
  });

  it("in REDUCE_ONLY long UP plans only a capped YES ask", () => {
    const result = planQuotes(input({
      inventory: { yes: 8, no: 3 },
      governor: { state: "REDUCE_ONLY", sizeMultiplier: 0, permissions: { allowedActions: ["SELL_YES"] } },
    }));
    assert.deepEqual(enabledSides(result), { bid: false, ask: true });
    assert.ok(result.ask.targetQuantity <= 5);
    assert.equal(result.bid.skipReason, "ACTION_NOT_PERMITTED");
  });

  it("in REDUCE_ONLY long DOWN plans only a YES bid", () => {
    const result = planQuotes(input({
      inventory: { yes: 3, no: 8 },
      governor: { state: "REDUCE_ONLY", sizeMultiplier: 0, permissions: { allowedActions: ["BUY_YES"] } },
    }));
    assert.deepEqual(enabledSides(result), { bid: true, ask: false });
    assert.equal(result.ask.skipReason, "ACTION_NOT_PERMITTED");
  });

  it("does not quote directionally when REDUCE_ONLY inventory is neutral", () => {
    const result = planQuotes(input({ governor: { state: "REDUCE_ONLY", sizeMultiplier: 0, permissions: { allowedActions: [] } } }));
    assert.equal(result.plan, "NO_QUOTE");
    assert.ok(result.reasonCodes.includes("NO_REDUCE_ONLY_DIRECTION"));
  });

  it("does not allow a reduce-only order to cross neutral", () => {
    const result = planQuotes(input({
      inventory: { yes: 5.5, no: 5 },
      quote: { baseQuantityRaw: "1000000" },
      governor: { state: "REDUCE_ONLY", sizeMultiplier: 0, permissions: { allowedActions: ["SELL_YES"] } },
    }));
    assert.equal(result.ask.targetQuantity, 0.5);
  });
});

describe("villa-quote-v1 independent center and adaptive width", () => {
  it("keeps a fair value of 0.5 centered symmetrically", () => {
    const result = planQuotes(input({ fairValue: { pUp: 0.5, pDown: 0.5 }, book: { empty: true, bestBidRaw: null, bestAskRaw: null } }));
    assert.equal(result.center.fairCenter, 0.5);
    assert.equal(result.center.effectiveCenter, 0.5);
    assert.equal(result.bid.targetPriceRaw, result.ask.targetPriceRaw === null ? null : String(1_000_000 - Number(result.ask.targetPriceRaw)));
  });

  it("keeps the returned probabilities bounded and complementary", () => {
    const result = planQuotes(input());
    assert.ok(result.fairValue.pUp >= 0 && result.fairValue.pUp <= 1);
    assert.ok(result.fairValue.pDown >= 0 && result.fairValue.pDown <= 1);
    assert.ok(Math.abs(result.fairValue.pUp + result.fairValue.pDown - 1) < 1e-15);
  });

  it("skews the effective center down for long UP and up for long DOWN", () => {
    const neutral = planQuotes(input());
    const longUp = planQuotes(input({ inventory: { yes: 8, no: 3 } }));
    const longDown = planQuotes(input({ inventory: { yes: 3, no: 8 } }));
    assert.ok(longUp.center.effectiveCenter < neutral.center.effectiveCenter);
    assert.ok(longDown.center.effectiveCenter > neutral.center.effectiveCenter);
    assert.equal(neutral.center.inventorySkew, 0);
  });

  it("applies stronger bounded skew as directional inventory grows", () => {
    const small = planQuotes(input({ inventory: { yes: 6, no: 5 } }));
    const large = planQuotes(input({ inventory: { yes: 9, no: 5 } }));
    const extreme = planQuotes(input({ inventory: { yes: 100, no: 0 } }));
    assert.ok(Math.abs(large.center.inventorySkew) > Math.abs(small.center.inventorySkew));
    assert.ok(Math.abs(extreme.center.inventorySkew) <= DEFAULT_QUOTE_CONFIG.maxInventorySkew);
  });

  it("widens with higher volatility without changing fair probability", () => {
    const calm = planQuotes(input());
    const wild = planQuotes(input({ fairValue: { realizedVolPerSqrtSec: 0.01 } }));
    assert.ok(wild.spread.finalHalfSpread > calm.spread.finalHalfSpread);
    assert.equal(wild.fairValue.pUp, calm.fairValue.pUp);
  });

  it("widens and reduces size with lower confidence", () => {
    const high = planQuotes(input());
    const low = planQuotes(input({ fairValue: { confidence: 0.76, dataQualityStatus: "MEDIUM" } }));
    assert.ok(low.spread.finalHalfSpread > high.spread.finalHalfSpread);
    assert.ok(low.size.finalMultiplier < high.size.finalMultiplier);
  });

  it("widens and reduces size near expiry while governor still allows", () => {
    const normal = planQuotes(input());
    const near = planQuotes(input({ fairValue: { timeRemainingSec: 10 }, market: { timeRemainingSec: 10 } }));
    assert.ok(near.spread.finalHalfSpread > normal.spread.finalHalfSpread);
    assert.ok(near.size.finalMultiplier < normal.size.finalMultiplier);
  });

  it("lets a governor expiry HALT override an otherwise usable plan", () => {
    const result = planQuotes(input({ fairValue: { timeRemainingSec: 10 }, market: { timeRemainingSec: 10 }, governor: { state: "HALT", permissions: { allowedActions: [] }, triggeredRules: ["EXPIRY_TOO_CLOSE"] } }));
    assert.equal(result.plan, "NO_QUOTE");
    assert.ok(result.governor.triggeredRules.includes("EXPIRY_TOO_CLOSE"));
  });
});

describe("villa-quote-v1 inventory, collateral, and grid safety", () => {
  it("keeps a bid at least one tick below a live best ask", () => {
    const result = planQuotes(input({ book: { bestBidRaw: "550000", bestAskRaw: "580000" } }));
    if (result.bid.enabled) assert.ok(BigInt(result.bid.targetPriceRaw) <= 579000n);
  });

  it("keeps an ask at least one tick above a live best bid", () => {
    const result = planQuotes(input({ book: { bestBidRaw: "620000", bestAskRaw: "650000" } }));
    if (result.ask.enabled) assert.ok(BigInt(result.ask.targetPriceRaw) >= 621000n);
  });

  it("returns raw prices and quantities as stable decimal strings", () => {
    const result = planQuotes(input());
    assert.match(result.bid.targetPriceRaw, /^\d+$/);
    assert.match(result.bid.targetQuantityRaw, /^\d+$/);
    assert.match(result.ask.targetPriceRaw, /^\d+$/);
    assert.match(result.ask.targetQuantityRaw, /^\d+$/);
  });

  it("refuses an invalid lot/minimum relationship", () => {
    const result = planQuotes(input({ grid: { ...GRID, minQuantityRaw: "1500" } }));
    assert.equal(result.plan, "NO_QUOTE");
    assert.ok(result.reasonCodes.includes("GRID_INVALID"));
  });

  it("requires real YES inventory for the ask", () => {
    const result = planQuotes(input({ inventory: { yes: 0, no: 5 } }));
    assert.equal(result.bid.enabled, true);
    assert.equal(result.ask.enabled, false);
    assert.equal(result.ask.skipReason, "NO_SELL_INVENTORY");
  });

  it("caps the bid by available collateral after reserve", () => {
    const result = planQuotes(input({ capital: { collateralAvailable: 1.2, collateralReserve: 1 } }));
    assert.equal(result.bid.enabled, true);
    assert.ok(result.bid.targetQuantity < 0.7);
    assert.equal(result.ask.enabled, true);
  });

  it("rounds quantity down to lot and refuses below minimum", () => {
    const rounded = planQuotes(input({ quote: { baseQuantityRaw: "1555" } }));
    assert.equal(rounded.bid.targetQuantityRaw, "1000");
    const tooSmall = planQuotes(input({ quote: { baseQuantityRaw: "999" } }));
    assert.equal(tooSmall.bid.enabled, false);
    assert.equal(tooSmall.bid.skipReason, "MIN_QUANTITY_UNMET");
  });

  it("floors bids and ceils asks to exact price ticks", () => {
    const result = planQuotes(input({ fairValue: { pUp: 0.601234, pDown: 0.398766 }, book: { empty: true, bestBidRaw: null, bestAskRaw: null } }));
    assert.equal(Number(result.bid.targetPriceRaw) % 1000, 0);
    assert.equal(Number(result.ask.targetPriceRaw) % 1000, 0);
    assert.ok(result.bid.targetPrice < result.ask.targetPrice);
  });

  it("keeps both enabled targets strictly separated", () => {
    const result = planQuotes(input({ book: { empty: true, bestBidRaw: null, bestAskRaw: null } }));
    assert.ok(result.bid.targetPriceRaw < result.ask.targetPriceRaw);
  });

  it("does not force an impossible post-only bid or ask", () => {
    const bidImpossible = planQuotes(input({ book: { bestBidRaw: null, bestAskRaw: "1000" } }));
    assert.equal(bidImpossible.bid.enabled, false);
    assert.equal(bidImpossible.bid.skipReason, "POST_ONLY_CONSTRAINT");
    const askImpossible = planQuotes(input({ book: { bestBidRaw: "999000", bestAskRaw: null } }));
    assert.equal(askImpossible.ask.enabled, false);
    assert.equal(askImpossible.ask.skipReason, "POST_ONLY_CONSTRAINT");
  });

  it("refuses off-grid raw book values instead of floating them", () => {
    const result = planQuotes(input({ book: { bestBidRaw: "550001" } }));
    assert.equal(result.plan, "NO_QUOTE");
    assert.ok(result.reasonCodes.includes("BOOK_INVALID"));
  });

  it("keeps fair probability unchanged when the comparison book changes", () => {
    const a = planQuotes(input({ book: { bestBidRaw: "550000", bestAskRaw: "650000" } }));
    const b = planQuotes(input({ book: { bestBidRaw: "200000", bestAskRaw: "300000" } }));
    assert.equal(a.fairValue.pUp, b.fairValue.pUp);
  });

  it("uses exact decimal-to-raw conversion for units", () => {
    assert.equal(decimalToRaw("0.123456", 6), 123456n);
    assert.equal(decimalToRaw("0.1234567", 6, "floor"), 123456n);
    assert.equal(decimalToRaw("0.1234561", 6, "ceil"), 123457n);
  });
});

describe("villa-quote-v1 pending exposure stress", () => {
  it("does not treat a pending SELL as collateral for a new bid", () => {
    const result = planQuotes(input({ inventory: { yes: 5, no: 5 }, pendingOrders: [{ outcome: "YES", side: "SELL", remainingQty: 4 }] }));
    assert.equal(result.bid.enabled, true);
    assert.ok(result.bid.projectedExposure.worstCase.directionalDown >= 0);
  });

  it("does not treat a pending BUY as inventory for a new ask", () => {
    const result = planQuotes(input({ inventory: { yes: 0, no: 5 }, pendingOrders: [{ outcome: "YES", side: "BUY", remainingQty: 5 }] }));
    assert.equal(result.ask.enabled, false);
    assert.equal(result.ask.skipReason, "NO_SELL_INVENTORY");
  });

  it("existing BUY_YES reduces future UP headroom", () => {
    const result = planQuotes(input({ pendingOrders: [{ outcome: "YES", side: "BUY", remainingQty: 9.5 }] }));
    assert.ok(result.bid.targetQuantity < 0.7);
  });

  it("existing SELL_YES reduces future DOWN headroom", () => {
    const result = planQuotes(input({ inventory: { yes: 10, no: 5 }, pendingOrders: [{ outcome: "YES", side: "SELL", remainingQty: 4 }] }));
    assert.ok(result.ask.targetQuantity <= 0.7);
  });

  it("does not optimistically net opposing pending orders", () => {
    const result = planQuotes(input({ pendingOrders: [
      { outcome: "YES", side: "BUY", remainingQty: 9.5 },
      { outcome: "YES", side: "SELL", remainingQty: 9.5 },
    ] }));
    assert.ok(result.bid.targetQuantity === null || result.bid.targetQuantity < 0.7);
    assert.ok(result.ask.targetQuantity === null || result.ask.targetQuantity < 0.7);
  });

  it("projects a proposed bid together with existing pending risk", () => {
    const safe = planQuotes(input({ pendingOrders: [{ outcome: "YES", side: "BUY", remainingQty: 8 }], quote: { baseQuantityRaw: "1000000" } }));
    assert.equal(safe.bid.enabled, true);
    assert.ok(safe.bid.projectedExposure.worstCase.directionalUp < 10);
  });

  it("projects a proposed ask together with existing pending risk", () => {
    const safe = planQuotes(input({ inventory: { yes: 10, no: 5 }, pendingOrders: [{ outcome: "YES", side: "SELL", remainingQty: 8 }], quote: { baseQuantityRaw: "1000000" } }));
    assert.equal(safe.ask.enabled, true);
    assert.ok(safe.ask.projectedExposure.worstCase.directionalDown < 10);
  });

  it("keeps balanced complete sets but recognizes a new YES ask as directional stress", () => {
    const result = planQuotes(input({ inventory: { yes: 5, no: 5 }, quote: { baseQuantityRaw: "1000000" } }));
    assert.equal(result.exposure.current.completeSets, 5);
    assert.ok(result.ask.projectedExposure.worstCase.directionalDown > 0);
  });

  it("is deterministic for identical normalized input", () => {
    assert.deepEqual(planQuotes(input()), planQuotes(input()));
  });
});

describe("villa-quote-v1 fail-closed behavior and bounds", () => {
  it("refuses a missing governor exposure hard limit", () => {
    const base = input();
    const result = planQuotes({ ...base, governor: { ...base.governor, limits: null } });
    assert.equal(result.plan, "NO_QUOTE");
    assert.ok(result.reasonCodes.includes("INPUT_INVALID"));
  });

  it("refuses a negative inventory rather than planning a synthetic short", () => {
    const result = planQuotes(input({ inventory: { yes: -1, no: 0 } }));
    assert.equal(result.plan, "NO_QUOTE");
    assert.ok(result.reasonCodes.includes("INPUT_INVALID"));
  });

  it("refuses expired or invalid fair-value inputs", () => {
    assert.equal(planQuotes(input({ market: { timeRemainingSec: 0 } })).plan, "NO_QUOTE");
    assert.ok(planQuotes(input({ fairValue: { pUp: 1.1, pDown: -0.1 } })).reasonCodes.includes("FAIR_VALUE_INVALID"));
    assert.ok(planQuotes(input({ fairValue: { valid: false } })).reasonCodes.includes("FAIR_VALUE_INVALID"));
  });

  it("keeps outputs within the probability grid for fair values near 0 and 1", () => {
    const low = planQuotes(input({ fairValue: { pUp: 0.000001, pDown: 0.999999 }, book: { empty: true, bestBidRaw: null, bestAskRaw: null } }));
    const high = planQuotes(input({ fairValue: { pUp: 0.999999, pDown: 0.000001 }, book: { empty: true, bestBidRaw: null, bestAskRaw: null } }));
    for (const result of [low, high]) {
      for (const side of [result.bid, result.ask]) if (side.enabled) {
        assert.ok(Number(side.targetPriceRaw) >= 1000 && Number(side.targetPriceRaw) <= 999000);
      }
    }
  });

  it("never invents a sell balance from a missing inventory field", () => {
    const result = planQuotes(input({ inventory: { yes: undefined, no: 0 } }));
    assert.equal(result.plan, "NO_QUOTE");
    assert.equal(result.ask.enabled, false);
  });

  it("never enables an action disallowed by the governor", () => {
    const result = planQuotes(input({ governor: { permissions: { allowedActions: ["SELL_YES"] } } }));
    assert.equal(result.bid.enabled, false);
    assert.equal(result.ask.enabled, true);
  });
});
