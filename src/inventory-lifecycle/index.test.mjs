import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INVENTORY_LIFECYCLE_VERSION,
  burnableMintedAmount,
  committedSellQuantityRaw,
  completeSetExposure,
  expectedBalancesAfterMint,
  isPostOnlySellSafe,
  lifecycleEconomics,
  minimumMintAmount,
  safeOrderExpiryNs,
  selectRestingSellPrice,
  sellCapacityRaw,
  validateMintAmount,
} from "./index.mjs";

const GRID = { oneRaw: 1_000_000n, tickSizeRaw: 1_000n, lotSizeRaw: 1_000n, minQuantityRaw: 1_000n };

describe("villa-inventory-v1 pure lifecycle math", () => {
  it("selects the smallest lot-aligned mint amount", () => {
    assert.equal(minimumMintAmount({ lotSizeRaw: 1_000n, minQuantityRaw: 1_500n }), 2_000n);
    assert.equal(validateMintAmount({ amountRaw: 2_000n, lotSizeRaw: 1_000n, minQuantityRaw: 1_500n }), 2_000n);
  });

  it("projects equal YES and NO mint balance increases", () => {
    assert.deepEqual(expectedBalancesAfterMint({ baselineYesRaw: 3_000n, baselineNoRaw: 5_000n, amountRaw: 2_000n }), { yesRaw: 5_000n, noRaw: 7_000n });
  });

  it("keeps complete sets separate from directional D", () => {
    assert.deepEqual(completeSetExposure({ yesRaw: 8_000n, noRaw: 5_000n }), { completeSetsRaw: 5_000n, directionalDeltaRaw: 3_000n });
    assert.deepEqual(completeSetExposure({ yesRaw: 5_000n, noRaw: 5_000n }), { completeSetsRaw: 5_000n, directionalDeltaRaw: 0n });
  });

  it("subtracts committed SELL_YES quantity from sell capacity", () => {
    const orders = [{ outcome: "YES", side: "SELL", remainingQtyRaw: 2_500n }, { outcome: "NO", side: "SELL", remainingQtyRaw: 9_000n }];
    assert.equal(committedSellQuantityRaw(orders), 2_500n);
    assert.equal(sellCapacityRaw({ yesRaw: 8_000n, committedSellRaw: 2_500n, lotSizeRaw: 1_000n }), 5_000n);
  });

  it("parks an ask above the bid and on the price grid", () => {
    const price = selectRestingSellPrice({ ...GRID, bestBidRaw: 600_000n, bestAskRaw: 650_000n, parkTicks: 10 });
    assert.equal(price, 610_000n);
    assert.equal(isPostOnlySellSafe({ ...GRID, priceRaw: price, bestBidRaw: 600_000n, bestAskRaw: 650_000n }), true);
  });

  it("joins a valid ask when a wide park would reach it", () => {
    assert.equal(selectRestingSellPrice({ ...GRID, bestBidRaw: 600_000n, bestAskRaw: 605_000n, parkTicks: 10 }), 605_000n);
    assert.equal(isPostOnlySellSafe({ ...GRID, priceRaw: 605_000n, bestBidRaw: 600_000n, bestAskRaw: 605_000n }), true);
  });

  it("fails closed when no non-crossing tick exists", () => {
    assert.throws(() => selectRestingSellPrice({ ...GRID, bestBidRaw: 600_000n, bestAskRaw: 600_000n }), { code: "WOULD_CROSS" });
  });

  it("handles an empty book deterministically", () => {
    const a = selectRestingSellPrice({ ...GRID });
    const b = selectRestingSellPrice({ ...GRID });
    assert.equal(a, 500_000n);
    assert.equal(a, b);
  });

  it("caps an order expiry at market expiry with safety slack", () => {
    assert.equal(safeOrderExpiryNs({ chainNowSec: 100, marketExpirySec: 250, lifetimeSec: 300, safetySec: 2 }), 248_000_000_000n);
  });

  it("requires future chain-time expiry", () => {
    assert.throws(() => safeOrderExpiryNs({ chainNowSec: 100, marketExpirySec: 101, lifetimeSec: 300, safetySec: 2 }), { code: "EXPIRY" });
  });

  it("burns only the controlled minted increment", () => {
    assert.equal(burnableMintedAmount({ baselineYesRaw: 9_000n, baselineNoRaw: 7_000n, currentYesRaw: 11_000n, currentNoRaw: 9_000n, mintedAmountRaw: 2_000n }), 2_000n);
  });

  it("refuses an incomplete or directionally altered set", () => {
    assert.throws(() => burnableMintedAmount({ baselineYesRaw: 0n, baselineNoRaw: 0n, currentYesRaw: 2_000n, currentNoRaw: 1_000n, mintedAmountRaw: 2_000n }), { code: "INCOMPLETE_SET" });
  });

  it("does not hide an over-committed sell", () => {
    assert.throws(() => sellCapacityRaw({ yesRaw: 1_000n, committedSellRaw: 2_000n, lotSizeRaw: 1_000n }), { code: "SELL_COMMITMENT_EXCEEDS_BALANCE" });
    assert.equal(sellCapacityRaw({ yesRaw: 0n, committedSellRaw: 2_000n, lotSizeRaw: 1_000n, balanceIncludesCommitted: false }), 0n);
  });

  it("rejects invalid mint grid values", () => {
    assert.throws(() => validateMintAmount({ amountRaw: 1_500n, lotSizeRaw: 1_000n, minQuantityRaw: 1_000n }), { code: "LOT" });
  });

  it("records collateral debit and return without inventing fees", () => {
    assert.deepEqual(lifecycleEconomics({ collateralBeforeRaw: 100_000n, collateralAfterMintRaw: 98_000n, collateralFinalRaw: 100_000n, mintAmountRaw: 2_000n }), {
      collateralDebitedRaw: 2_000n,
      collateralReturnedRaw: 2_000n,
      finalDifferenceRaw: 0n,
      expectedMintDebitRaw: 2_000n,
    });
  });

  it("has an explicit version and remains deterministic", () => {
    assert.equal(INVENTORY_LIFECYCLE_VERSION, "villa-inventory-v1");
    const input = { ...GRID, bestBidRaw: 450_000n, bestAskRaw: 550_000n, parkTicks: 5 };
    assert.equal(selectRestingSellPrice(input), selectRestingSellPrice(input));
  });
});
