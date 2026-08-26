/**
 * Pure complete-set inventory and controlled SELL-path helpers.
 *
 * This module deliberately has no SDK, RPC, indexer, wallet, clock, or
 * environment dependency. The live verifier supplies already-read raw values
 * and uses these functions to decide what is safe to request.
 */

export const INVENTORY_LIFECYCLE_VERSION = "villa-inventory-v1";

export class InventoryLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InventoryLifecycleError";
    this.code = code;
  }
}

function positiveInteger(value, label) {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new InventoryLifecycleError("INVALID_RAW", `${label} must be a positive bigint`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (typeof value !== "bigint" || value < 0n) {
    throw new InventoryLifecycleError("INVALID_RAW", `${label} must be a non-negative bigint`);
  }
  return value;
}

function snapUp(raw, step) {
  return ((raw + step - 1n) / step) * step;
}

function snapDown(raw, step) {
  return (raw / step) * step;
}

function validateGrid({ oneRaw, tickSizeRaw, lotSizeRaw, minQuantityRaw }) {
  positiveInteger(oneRaw, "oneRaw");
  positiveInteger(tickSizeRaw, "tickSizeRaw");
  positiveInteger(lotSizeRaw, "lotSizeRaw");
  positiveInteger(minQuantityRaw, "minQuantityRaw");
  if (tickSizeRaw >= oneRaw) throw new InventoryLifecycleError("INVALID_GRID", "tickSizeRaw must be less than oneRaw");
  const minOrderQuantityRaw = snapUp(minQuantityRaw > lotSizeRaw ? minQuantityRaw : lotSizeRaw, lotSizeRaw);
  return { oneRaw, tickSizeRaw, lotSizeRaw, minQuantityRaw, minOrderQuantityRaw };
}

/** Smallest complete-set amount that can also satisfy the book's lot/minimum. */
export function minimumMintAmount({ lotSizeRaw, minQuantityRaw }) {
  positiveInteger(lotSizeRaw, "lotSizeRaw");
  positiveInteger(minQuantityRaw, "minQuantityRaw");
  return snapUp(minQuantityRaw > lotSizeRaw ? minQuantityRaw : lotSizeRaw, lotSizeRaw);
}

/** Validate that a mint amount is usable for the subsequent SELL test. */
export function validateMintAmount({ amountRaw, lotSizeRaw, minQuantityRaw }) {
  positiveInteger(amountRaw, "amountRaw");
  positiveInteger(lotSizeRaw, "lotSizeRaw");
  positiveInteger(minQuantityRaw, "minQuantityRaw");
  if (amountRaw % lotSizeRaw !== 0n) throw new InventoryLifecycleError("LOT", "mint amount is not lot aligned");
  if (amountRaw < minQuantityRaw) throw new InventoryLifecycleError("MIN_QUANTITY", "mint amount is below the SELL minimum");
  return amountRaw;
}

export function expectedBalancesAfterMint({ baselineYesRaw, baselineNoRaw, amountRaw }) {
  nonNegativeInteger(baselineYesRaw, "baselineYesRaw");
  nonNegativeInteger(baselineNoRaw, "baselineNoRaw");
  positiveInteger(amountRaw, "amountRaw");
  return {
    yesRaw: baselineYesRaw + amountRaw,
    noRaw: baselineNoRaw + amountRaw,
  };
}

export function balanceDelta({ beforeRaw, afterRaw, label = "balance" }) {
  nonNegativeInteger(beforeRaw, `${label}.beforeRaw`);
  nonNegativeInteger(afterRaw, `${label}.afterRaw`);
  if (afterRaw < beforeRaw) throw new InventoryLifecycleError("BALANCE_DECREASED", `${label} decreased unexpectedly`);
  return afterRaw - beforeRaw;
}

export function completeSetExposure({ yesRaw, noRaw }) {
  nonNegativeInteger(yesRaw, "yesRaw");
  nonNegativeInteger(noRaw, "noRaw");
  return {
    completeSetsRaw: yesRaw < noRaw ? yesRaw : noRaw,
    directionalDeltaRaw: yesRaw - noRaw,
  };
}

/**
 * Existing open SELL_YES quantity is a commitment against the visible token
 * balance. It is not netted away merely because the order may later cancel.
 */
export function committedSellQuantityRaw(openOrders, { outcome = "YES" } = {}) {
  if (!Array.isArray(openOrders)) throw new InventoryLifecycleError("OPEN_ORDERS_INVALID", "openOrders must be an array");
  return openOrders.reduce((sum, order, index) => {
    if (!order || order.outcome !== outcome || order.side !== "SELL") return sum;
    const raw = order.remainingQtyRaw ?? order.quantityRemainingRaw;
    if (typeof raw !== "bigint" || raw < 0n) {
      throw new InventoryLifecycleError("OPEN_ORDERS_INVALID", `openOrders[${index}] has no valid raw remaining quantity`);
    }
    return sum + raw;
  }, 0n);
}

export function sellCapacityRaw({ yesRaw, committedSellRaw, lotSizeRaw, balanceIncludesCommitted = true }) {
  nonNegativeInteger(yesRaw, "yesRaw");
  nonNegativeInteger(committedSellRaw, "committedSellRaw");
  positiveInteger(lotSizeRaw, "lotSizeRaw");
  if (balanceIncludesCommitted) {
    if (committedSellRaw > yesRaw) throw new InventoryLifecycleError("SELL_COMMITMENT_EXCEEDS_BALANCE", "committed SELL_YES quantity exceeds visible YES balance");
    return snapDown(yesRaw - committedSellRaw, lotSizeRaw);
  }
  return snapDown(yesRaw, lotSizeRaw);
}

/** Select a strictly non-crossing YES-terms ask on the exact tick grid. */
export function selectRestingSellPrice({ bestBidRaw, bestAskRaw, oneRaw, tickSizeRaw, parkTicks = 10 }) {
  const grid = validateGrid({ oneRaw, tickSizeRaw, lotSizeRaw: 1n, minQuantityRaw: 1n });
  if (!Number.isInteger(parkTicks) || parkTicks < 1) throw new InventoryLifecycleError("INVALID_PRICE", "parkTicks must be a positive integer");
  for (const [value, label] of [[bestBidRaw, "bestBidRaw"], [bestAskRaw, "bestAskRaw"]]) {
    if (value !== undefined && value !== null && (typeof value !== "bigint" || value <= 0n || value >= oneRaw || value % tickSizeRaw !== 0n)) {
      throw new InventoryLifecycleError("INVALID_BOOK", `${label} is missing, out of bounds, or off tick grid`);
    }
  }

  let candidate;
  if (bestBidRaw !== undefined && bestBidRaw !== null) {
    candidate = bestBidRaw + BigInt(parkTicks) * tickSizeRaw;
    if (bestAskRaw !== undefined && bestAskRaw !== null && candidate >= bestAskRaw) candidate = bestAskRaw;
    if (candidate >= oneRaw) candidate = oneRaw - tickSizeRaw;
  } else if (bestAskRaw !== undefined && bestAskRaw !== null) {
    candidate = bestAskRaw;
  } else {
    candidate = snapUp(oneRaw / 2n, tickSizeRaw);
    if (candidate >= oneRaw) candidate = oneRaw - tickSizeRaw;
  }

  if (candidate <= 0n || candidate >= oneRaw || candidate % tickSizeRaw !== 0n) {
    throw new InventoryLifecycleError("INVALID_PRICE", "no valid tick-aligned ask price exists");
  }
  if (bestBidRaw !== undefined && bestBidRaw !== null && candidate <= bestBidRaw) {
    throw new InventoryLifecycleError("WOULD_CROSS", "calculated SELL_YES price would cross the best bid");
  }
  return candidate;
}

export function isPostOnlySellSafe({ priceRaw, bestBidRaw, bestAskRaw, oneRaw, tickSizeRaw }) {
  validateGrid({ oneRaw, tickSizeRaw, lotSizeRaw: 1n, minQuantityRaw: 1n });
  positiveInteger(priceRaw, "priceRaw");
  if (priceRaw >= oneRaw || priceRaw % tickSizeRaw !== 0n) return false;
  if (bestBidRaw !== undefined && bestBidRaw !== null && priceRaw <= bestBidRaw) return false;
  // An ask may join an existing ask; only the bid side is a crossing concern.
  if (bestAskRaw !== undefined && bestAskRaw !== null && bestAskRaw <= 0n) return false;
  return true;
}

export function safeOrderExpiryNs({ chainNowSec, marketExpirySec, lifetimeSec = 300, safetySec = 2 }) {
  if (!Number.isFinite(chainNowSec) || !Number.isFinite(marketExpirySec) || !Number.isFinite(lifetimeSec) || !Number.isFinite(safetySec)) {
    throw new InventoryLifecycleError("INVALID_TIME", "chain and expiry times must be finite");
  }
  const wanted = Math.floor(chainNowSec) + Math.floor(lifetimeSec);
  const cap = Math.floor(marketExpirySec) - Math.floor(safetySec);
  const expirySec = Math.min(wanted, cap);
  if (expirySec <= Math.floor(chainNowSec)) throw new InventoryLifecycleError("EXPIRY", "market expiry is too close for a future order expiry");
  return BigInt(expirySec) * 1_000_000_000n;
}

/** Burn only the newly minted complete-set increment, never baseline inventory. */
export function burnableMintedAmount({ baselineYesRaw, baselineNoRaw, currentYesRaw, currentNoRaw, mintedAmountRaw }) {
  nonNegativeInteger(baselineYesRaw, "baselineYesRaw");
  nonNegativeInteger(baselineNoRaw, "baselineNoRaw");
  nonNegativeInteger(currentYesRaw, "currentYesRaw");
  nonNegativeInteger(currentNoRaw, "currentNoRaw");
  positiveInteger(mintedAmountRaw, "mintedAmountRaw");
  const yesDelta = balanceDelta({ beforeRaw: baselineYesRaw, afterRaw: currentYesRaw, label: "YES" });
  const noDelta = balanceDelta({ beforeRaw: baselineNoRaw, afterRaw: currentNoRaw, label: "NO" });
  const amount = yesDelta < noDelta ? yesDelta : noDelta;
  if (amount < mintedAmountRaw) throw new InventoryLifecycleError("INCOMPLETE_SET", `only ${amount} raw complete sets remain from the controlled mint`);
  return mintedAmountRaw;
}

export function lifecycleEconomics({ collateralBeforeRaw, collateralAfterMintRaw, collateralFinalRaw, mintAmountRaw }) {
  nonNegativeInteger(collateralBeforeRaw, "collateralBeforeRaw");
  nonNegativeInteger(collateralAfterMintRaw, "collateralAfterMintRaw");
  nonNegativeInteger(collateralFinalRaw, "collateralFinalRaw");
  positiveInteger(mintAmountRaw, "mintAmountRaw");
  return {
    collateralDebitedRaw: collateralBeforeRaw - collateralAfterMintRaw,
    collateralReturnedRaw: collateralFinalRaw - collateralAfterMintRaw,
    finalDifferenceRaw: collateralFinalRaw - collateralBeforeRaw,
    expectedMintDebitRaw: mintAmountRaw,
  };
}
