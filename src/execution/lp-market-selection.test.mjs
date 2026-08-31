import assert from "node:assert/strict";
import test from "node:test";
import { LP_MARKET_SERIES, selectCurrentBtc5mMarket } from "./lp-market-selection.mjs";

const MARKET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MARKET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function candidate(marketId, overrides = {}) {
  return {
    row: { marketId, marketType: "BINARY", asset: "BTC", intervalSec: 300, strike: "100", venueId: "venue" },
    onchain: { status: 1, expiry: 2_000, pool: "0x4444444444444444444444444444444444444444" },
    grid: { tickSizeRaw: "1000", lotSizeRaw: "1000", minQuantityRaw: "1000" },
    book: { bids: [], asks: [] },
    reference: { price: 100, source: "test" },
    minimumOrderRaw: "1000",
    ...overrides,
  };
}

test("selects a live current BTC 5m market from verified facts, never a hardcoded id", () => {
  const result = selectCurrentBtc5mMarket({ chainNowSec: 1_000, candidates: [candidate(MARKET_B, { expirySec: 2_200 }), candidate(MARKET_A)] });
  assert.equal(result.selected.marketId, MARKET_A);
  assert.equal(result.selected.series, LP_MARKET_SERIES);
  assert.equal(result.selected.status, "Trading");
  assert.equal(result.selected.minimumOrderRaw, "1000");
  assert.ok(result.selected.grid && result.selected.book && result.selected.reference);
});

test("stale, locked, wrong-series, and incomplete markets are rejected", () => {
  const result = selectCurrentBtc5mMarket({ chainNowSec: 1_000, minHeadroomSec: 120, candidates: [
    candidate(MARKET_A, { expirySec: 1_100 }),
    candidate(MARKET_B, { onchain: { status: 2, expiry: 2_000 } }),
    candidate("0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", { row: { marketId: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", asset: "ETH", intervalSec: 300 } }),
    candidate("0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", { reference: undefined }),
  ] });
  assert.equal(result.selected, null);
  assert.deepEqual(result.rejected.map((item) => item.code), ["HEADROOM_INSUFFICIENT", "MARKET_NOT_TRADING", "SERIES_MISMATCH", "FACT_MISSING"]);
});

test("a Trading row with a finalized pool is rejected as unwritable", () => {
  const result = selectCurrentBtc5mMarket({ chainNowSec: 1_000, candidates: [candidate(MARKET_A, { poolFinalized: true })] });
  assert.equal(result.selected, null);
  assert.equal(result.rejected[0].code, "POOL_FINALIZED");
});

test("market ids are supplied by candidates and invalid ids do not pass", () => {
  const result = selectCurrentBtc5mMarket({ chainNowSec: 1_000, candidates: [candidate("historical-market")] });
  assert.equal(result.selected, null);
  assert.equal(result.rejected[0].code, "MARKET_ID_INVALID");
});
