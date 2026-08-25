/**
 * Binary Event Contract exposure math.
 *
 * YES and NO are separate outcome-token balances. One YES + one NO is a
 * complete set and is not directional. Only the residual after pairing is
 * directional: YES minus NO is UP exposure; NO minus YES is DOWN exposure.
 */

export class ExposureError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExposureError";
    this.code = code;
  }
}

const OUTCOMES = new Set(["YES", "NO"]);
const SIDES = new Set(["BUY", "SELL"]);

function quantity(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new ExposureError("EXPOSURE_INVALID", `${name} must be finite and >= 0`);
  }
  return value;
}

function summarize(yes, no) {
  const completeSets = Math.min(yes, no);
  const directionalUp = Math.max(yes - no, 0);
  const directionalDown = Math.max(no - yes, 0);
  return {
    yes,
    no,
    completeSets,
    directionalUp,
    directionalDown,
    grossOutcome: yes + no,
    directionalTotal: directionalUp + directionalDown,
  };
}
/**
 * Compute current and conservative worst-case binary exposure.
 *
 * A pending BUY is assumed to fill in full while pending SELLs are assumed not
 * to fill. This is intentionally conservative for a risk gate: a sell can
 * reduce exposure, but an unfilled sell cannot protect us. Every open order is
 * still represented in `openOrderSummary`, and malformed order data fails
 * closed instead of being discarded.
 */
export function calculateBinaryExposure(input = {}) {
  const yes = quantity(input.yes, "inventory.yes");
  const no = quantity(input.no, "inventory.no");
  if (!Array.isArray(input.openOrders)) {
    throw new ExposureError("EXPOSURE_INVALID", "openOrders must be an array");
  }

  let buyYes = 0;
  let buyNo = 0;
  let sellYes = 0;
  let sellNo = 0;
  for (const [index, order] of input.openOrders.entries()) {
    if (!order || !OUTCOMES.has(order.outcome) || !SIDES.has(order.side)) {
      throw new ExposureError("EXPOSURE_INVALID", `openOrders[${index}] has an unsupported outcome or side`);
    }
    const remainingQty = quantity(order.remainingQty, `openOrders[${index}].remainingQty`);
    if (order.side === "BUY" && order.outcome === "YES") buyYes += remainingQty;
    if (order.side === "BUY" && order.outcome === "NO") buyNo += remainingQty;
    if (order.side === "SELL" && order.outcome === "YES") sellYes += remainingQty;
    if (order.side === "SELL" && order.outcome === "NO") sellNo += remainingQty;
  }

  const current = summarize(yes, no);
  const worstCase = summarize(yes + buyYes, no + buyNo);
  return {
    current,
    worstCase,
    pendingRiskIncrease: {
      yes: buyYes,
      no: buyNo,
      grossOutcome: buyYes + buyNo,
    },
    openOrderSummary: {
      count: input.openOrders.length,
      buyYes,
      buyNo,
      sellYes,
      sellNo,
      totalRemaining: buyYes + buyNo + sellYes + sellNo,
    },
  };
}
