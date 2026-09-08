/**
 * Classify the projected quote before the account-bound writer is reached.
 * A temporary lack of a safe quote is a normal waiting condition; risk or
 * planner invariant failures remain fail-closed.
 */

const SAFE_RISK_STATES = new Set(["ALLOW", "REDUCE_ONLY"]);
const QUOTE_PLANS = new Set(["ACTIVE", "ONE_SIDED", "NO_QUOTE"]);

/** A stale price cannot conceal a second, nonrecoverable HALT reason. */
export function isTransientPriceHalt(decision = {}) {
  return decision.state === "HALT"
    && decision.primaryReasonCode === "PRICE_STALE"
    && (decision.triggeredRules === undefined || (Array.isArray(decision.triggeredRules)
      && decision.triggeredRules.every((reason) => reason === "PRICE_STALE")));
}

export function buildPriceFreshnessTelemetry({
  snapshot = {},
  decision = {},
  lastFreshPriceTimestampSec = null,
  maxPriceAgeSec = null,
  maxSourceAgeSec = null,
} = {}) {
  const chainNowSec = Number(snapshot.chainTime?.chainNowSec);
  const priceTimestampSec = Number(snapshot.feed?.timestampSec);
  const feedAgeSec = Number.isFinite(chainNowSec) && Number.isFinite(priceTimestampSec)
    ? Math.max(0, chainNowSec - priceTimestampSec)
    : null;
  const sourceAgeSec = snapshot.feed?.sourceAgeSec === undefined || snapshot.feed?.sourceAgeSec === null
    ? null
    : Number(snapshot.feed.sourceAgeSec);
  const normalizedSourceAgeSec = Number.isFinite(sourceAgeSec) ? sourceAgeSec : null;
  const stale = decision.primaryReasonCode === "PRICE_STALE"
    || (Array.isArray(decision.triggeredRules) && decision.triggeredRules.includes("PRICE_STALE"));
  const nextLastFreshPriceTimestampSec = !stale && Number.isFinite(priceTimestampSec)
    ? priceTimestampSec
    : lastFreshPriceTimestampSec;
  return Object.freeze({
    feedAgeSec,
    sourceAgeSec: normalizedSourceAgeSec,
    priceTimestampSec: Number.isFinite(priceTimestampSec) ? priceTimestampSec : null,
    freshnessThresholds: Object.freeze({ maxFeedAgeSec: maxPriceAgeSec, maxSourceAgeSec }),
    lastFreshPriceTimestampSec: nextLastFreshPriceTimestampSec,
  });
}
export function assessProjectedQuote({ projectedDecision = {}, quotePlan = {} } = {}) {
  const projectedState = String(projectedDecision.state ?? "");
  const plan = String(quotePlan.plan ?? "");
  const ask = quotePlan.ask ?? null;
  const askEnabled = ask?.enabled === true;
  const askAction = ask?.action ?? null;

  if (!SAFE_RISK_STATES.has(projectedState) && projectedState !== "HALT") {
    return Object.freeze({
      disposition: "FAIL_CLOSED",
      reasonCode: "PROJECTED_RISK_STATE_INVALID",
      message: `the live projected risk state is invalid: ${projectedState || "MISSING"}`,
    });
  }
  if (projectedState === "HALT") {
    if (isTransientPriceHalt(projectedDecision)) {
      return Object.freeze({
        disposition: "WAITING_FOR_FRESH_PRICE",
        reasonCode: "PRICE_STALE",
        message: "the live projected price is stale; waiting for fresh price data",
      });
    }
    return Object.freeze({
      disposition: "FAIL_CLOSED",
      reasonCode: "PROJECTED_RISK_HALT",
      message: `the live projected risk decision is HALT${projectedDecision.primaryReasonCode ? `: ${projectedDecision.primaryReasonCode}` : ""}`,
    });
  }
  if (!QUOTE_PLANS.has(plan)) {
    return Object.freeze({
      disposition: "FAIL_CLOSED",
      reasonCode: "QUOTE_PLAN_INVALID",
      message: `the live quote planner returned an invalid plan: ${plan || "MISSING"}`,
    });
  }
  if (plan === "NO_QUOTE") {
    return Object.freeze({ disposition: "WAITING_FOR_QUOTE", reasonCode: "NO_QUOTE", message: "the live quote planner has no safe quote at this instant" });
  }
  if (!ask) {
    return Object.freeze({ disposition: "FAIL_CLOSED", reasonCode: "QUOTE_ASK_INVALID", message: "the live quote planner returned no ask side" });
  }
  if (!askEnabled) {
    return Object.freeze({ disposition: "WAITING_FOR_QUOTE", reasonCode: "ASK_DISABLED", message: "the live SELL_YES ask is intentionally disabled" });
  }
  if (askAction !== "SELL_YES") {
    return Object.freeze({
      disposition: "FAIL_CLOSED",
      reasonCode: "QUOTE_ACTION_MISMATCH",
      message: `the live projected ask action is ${askAction ?? "MISSING"}; expected SELL_YES`,
    });
  }
  return Object.freeze({ disposition: "EXECUTE", reasonCode: "SELL_YES_READY", message: "the live projected SELL_YES quote is valid" });
}
