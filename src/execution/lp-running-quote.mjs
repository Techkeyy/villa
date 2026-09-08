/** Pure running-session quote lifecycle decision. No RPC, signer, or policy side effects. */

export function decideRunningQuote({ readiness, currentOrder = null, desiredAsk = null } = {}) {
  const disposition = String(readiness?.disposition ?? "");
  if (disposition === "FAIL_CLOSED") {
    return Object.freeze({ action: currentOrder ? "HALT_CANCEL" : "HALT", state: "HALTED", reasonCode: readiness?.reasonCode ?? "QUOTE_GATE_FAILED" });
  }
  if (disposition === "WAITING_FOR_FRESH_PRICE" || disposition === "WAITING_FOR_QUOTE") {
    return Object.freeze({ action: currentOrder ? "CANCEL" : "WAIT", state: disposition, reasonCode: readiness?.reasonCode ?? disposition });
  }
  if (disposition !== "EXECUTE" || !desiredAsk?.targetPriceRaw || !desiredAsk?.targetQuantityRaw) {
    return Object.freeze({ action: currentOrder ? "HALT_CANCEL" : "HALT", state: "HALTED", reasonCode: "QUOTE_DECISION_INVALID" });
  }
  if (!currentOrder) return Object.freeze({ action: "PLACE", state: "RUNNING", reasonCode: "NO_RESTING_ORDER" });
  const samePrice = String(currentOrder.priceRaw) === String(desiredAsk.targetPriceRaw);
  const sameQuantity = String(currentOrder.quantityRemainingRaw ?? currentOrder.quantityRaw) === String(desiredAsk.targetQuantityRaw);
  if (samePrice && sameQuantity && currentOrder.isBid === false) {
    return Object.freeze({ action: "KEEP", state: "RUNNING", reasonCode: "HYSTERESIS_HOLDS" });
  }
  return Object.freeze({ action: "REPLACE", state: "RUNNING", reasonCode: "MEANINGFUL_PLAN_CHANGE" });
}
