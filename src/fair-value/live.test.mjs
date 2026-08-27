import { it } from "node:test";
import assert from "node:assert/strict";
import { fetchVolFromPriceHistory } from "./live.mjs";

it("refreshes the chain clock after history before validating future observations", async () => {
  const newestFirst = Array.from({ length: 13 }, (_, index) => ({
    price: 100 + (12 - index) * 0.1,
    blockTimestamp: 1000 - index * 5,
  }));
  const exchange = {
    client: {
      fetchPriceHistory: async () => newestFirst,
      getViemClient: () => ({ getBlock: async () => ({ timestamp: 1005, number: 42n }) }),
    },
  };
  const result = await fetchVolFromPriceHistory(exchange, "BTC", {
    nowSec: 990,
    refreshChainTime: true,
    minReturns: 12,
    minElapsedSec: 60,
    maxAgeSec: 180,
    maxGapSec: 180,
  });
  assert.equal(result.chainNowSec, 1005);
  assert.equal(result.chainBlockNumber, 42);
  assert.equal(result.lastTSec, 1000);
});
