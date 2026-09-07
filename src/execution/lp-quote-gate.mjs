/**
 * Classify the projected quote before the account-bound writer is reached.
 * A temporary lack of a safe quote is a normal waiting condition; risk or
 * planner invariant failures remain fail-closed.
 */

const SAFE_RISK_STATES = new Set(["ALLOW", "REDUCE_ONLY"]);
const QUOTE_PLANS = new Set(["ACTIVE", "ONE_SIDED", "NO_QUOTE"]);

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
