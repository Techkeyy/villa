/**
 * Binary Event Contract exposure math.
 *
 * YES and NO are separate outcome-token balances. One YES + one NO is a
 * complete set and is not directional. The signed directional balance is
 * D = YES - NO: positive D is UP exposure and negative D is DOWN exposure.
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
const ORDER_ACTIONS = Object.freeze(["BUY_YES", "SELL_YES", "BUY_NO", "SELL_NO"]);

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
    directionalBalance: yes - no,
    directionalUp,
    directionalDown,
    grossOutcome: yes + no,
    directionalTotal: directionalUp + directionalDown,
  };
}

function directionalStress(directionalBalance, pendingDelta) {
  const postFillBalance = directionalBalance + pendingDelta;
  return {
    pendingDelta,
    postFillBalance,
    directionalUp: Math.max(postFillBalance, 0),
    directionalDown: Math.max(-postFillBalance, 0),
  };
}

/**
 * Return the signed directional change for one filled binary order.
 *
 * The mapping is verified against the Event Contract representation used by
 * VILLA: YES is the UP token and NO is the DOWN token. Buying a token adds it
 * to the corresponding balance; selling a token removes it.
 */
export function directionalDeltaForOrder(order = {}, label = "order") {
  if (!order || !OUTCOMES.has(order.outcome) || !SIDES.has(order.side)) {
    throw new ExposureError("EXPOSURE_INVALID", `${label} has an unsupported outcome or side`);
  }
  const remainingQty = quantity(order.remainingQty, `${label}.remainingQty`);
  const action = `${order.side}_${order.outcome}`;
  const unitDelta = action === "BUY_YES" || action === "SELL_NO" ? 1 : -1;
  return {
    action,
    outcome: order.outcome,
    side: order.side,
    remainingQty,
    unitDelta,
    delta: unitDelta * remainingQty,
  };
}

/**
 * Describe what a reduce-only planner may do from the current inventory.
 *
 * A reducing order may move D toward zero, but never through zero. The
 * quantity cap is therefore the absolute current directional balance.
 */
export function reduceOnlyPolicy(directionalBalance) {
  if (!Number.isFinite(directionalBalance)) {
    throw new ExposureError("EXPOSURE_INVALID", "directionalBalance must be finite");
  }
  if (directionalBalance > 0) {
    return {
      currentDirectionalBalance: directionalBalance,
      permittedDirection: "DOWN",
      permittedActions: ["SELL_YES", "BUY_NO"],
      maxQuantityBeforeNeutral: directionalBalance,
      riskIncreasingActions: ["BUY_YES", "SELL_NO"],
      overshootRule: "REJECT_OR_CAP_AT_NEUTRAL",
    };
  }
  if (directionalBalance < 0) {
    return {
      currentDirectionalBalance: directionalBalance,
      permittedDirection: "UP",
      permittedActions: ["BUY_YES", "SELL_NO"],
      maxQuantityBeforeNeutral: -directionalBalance,
      riskIncreasingActions: ["SELL_YES", "BUY_NO"],
      overshootRule: "REJECT_OR_CAP_AT_NEUTRAL",
    };
  }
  return {
    currentDirectionalBalance: 0,
    permittedDirection: null,
    permittedActions: [],
    maxQuantityBeforeNeutral: 0,
    riskIncreasingActions: [...ORDER_ACTIONS],
    overshootRule: "REJECT_OR_CAP_AT_NEUTRAL",
  };
}

/**
 * Assess one proposed action against the current directional balance without
 * executing it. This is the pure contract a future planner can use to reject
 * or cap a reduce-only order before it is combined with the resting-order
 * stress calculation.
 */
export function assessReduceOnlyOrder(directionalBalance, order) {
  const policy = reduceOnlyPolicy(directionalBalance);
  const parsed = directionalDeltaForOrder(order);
  const proposedDirectionalBalance = directionalBalance + parsed.delta;
  const actionPermitted = policy.permittedActions.includes(parsed.action);
  const overshootsNeutral = actionPermitted
    && directionalBalance !== 0
    && proposedDirectionalBalance !== 0
    && Math.sign(proposedDirectionalBalance) !== Math.sign(directionalBalance);
  const maxPermittedQuantity = actionPermitted ? policy.maxQuantityBeforeNeutral : 0;
  const safeQuantity = Math.min(parsed.remainingQty, maxPermittedQuantity);
  return {
    action: parsed.action,
    requestedQuantity: parsed.remainingQty,
    delta: parsed.delta,
    proposedDirectionalBalance,
    permitted: actionPermitted && !overshootsNeutral,
    overshootsNeutral,
    maxPermittedQuantity,
    safeQuantity,
    safeDirectionalBalance: directionalBalance + parsed.unitDelta * safeQuantity,
    permittedDirection: policy.permittedDirection,
  };
}

/**
 * Compute current and conservative worst-case binary exposure.
 *
 * Directional stress is one-sided and does not optimistically net opposing
 * orders. For the UP stress, every pending order with a positive D delta is
 * assumed to fill and negative-delta orders are ignored. For the DOWN stress,
 * the inverse is used. This evaluates every order capable of changing
 * inventory and does not assume that a SELL is favorable or that only one
 * order fills.
 *
 * Gross inventory and collateral remain separate concepts. Gross outcome
 * stress assumes all pending BUYs fill and no SELL is needed to increase
 * gross inventory; directional stress additionally captures SELL orders that
 * can break complete sets and create residual exposure.
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
    const parsed = directionalDeltaForOrder(order, `openOrders[${index}]`);
    if (parsed.action === "BUY_YES") buyYes += parsed.remainingQty;
    if (parsed.action === "BUY_NO") buyNo += parsed.remainingQty;
    if (parsed.action === "SELL_YES") sellYes += parsed.remainingQty;
    if (parsed.action === "SELL_NO") sellNo += parsed.remainingQty;
  }

  if ([buyYes, buyNo, sellYes, sellNo].some((value) => !Number.isFinite(value))) {
    throw new ExposureError("EXPOSURE_INVALID", "open-order quantity total is not finite");
  }
  const current = summarize(yes, no);
  const positivePendingDelta = buyYes + sellNo;
  const negativePendingDelta = sellYes + buyNo;
  if (![positivePendingDelta, negativePendingDelta, yes + buyYes, no + buyNo].every(Number.isFinite)) {
    throw new ExposureError("EXPOSURE_INVALID", "derived exposure total is not finite");
  }
  const worstUpStress = directionalStress(current.directionalBalance, positivePendingDelta);
  const worstDownStress = directionalStress(current.directionalBalance, -negativePendingDelta);

  // BUYs are the gross-inventory and collateral stress. SELL fills are
  // separately represented by worstUpStress/worstDownStress above.
  const grossStress = summarize(yes + buyYes, no + buyNo);
  const worstCase = {
    ...grossStress,
    directionalBalance: null,
    directionalUp: worstUpStress.directionalUp,
    directionalDown: worstDownStress.directionalDown,
    directionalTotal: worstUpStress.directionalUp + worstDownStress.directionalDown,
  };
  return {
    current,
    worstCase,
    directionalStress: {
      worstUp: worstUpStress,
      worstDown: worstDownStress,
    },
    pendingRiskIncrease: {
      directionalUp: positivePendingDelta,
      directionalDown: negativePendingDelta,
      positiveDelta: positivePendingDelta,
      negativeDelta: negativePendingDelta,
      yes: buyYes,
      no: buyNo,
      grossOutcome: buyYes + buyNo,
    },
    reduceOnlyPolicy: reduceOnlyPolicy(current.directionalBalance),
    openOrderSummary: {
      count: input.openOrders.length,
      buyYes,
      buyNo,
      sellYes,
      sellNo,
      positiveDirectionalDelta: positivePendingDelta,
      negativeDirectionalDelta: negativePendingDelta,
      totalRemaining: buyYes + buyNo + sellYes + sellNo,
    },
  };
}

/**
 * Recalculate the same conservative stress after appending one proposed
 * action. The helper is pure and does not imply that the action will be sent.
 */
export function calculateBinaryExposureWithAdditionalOrder(input = {}, proposedOrder) {
  if (!Array.isArray(input.openOrders)) {
    throw new ExposureError("EXPOSURE_INVALID", "openOrders must be an array");
  }
  return calculateBinaryExposure({
    ...input,
    openOrders: [...input.openOrders, proposedOrder],
  });
}
