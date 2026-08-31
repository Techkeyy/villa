/**
 * Explicit, dependency-injected one-cycle coordinator for the future wet
 * account-bound engine.
 *
 * It has no wallet, signer, RPC writer, loop, rollover, restart, or daemon
 * dependency. SHADOW is the default. A WET call is possible only when the
 * caller supplies every dependency, an explicit --one-cycle request, fresh
 * facts, executionEnabled=true, and a policy-backed writer.
 */

import { DEFAULT_PHASE_3B1_CAPS } from "./lp-transaction-policy.mjs";
import { CANONICAL_VILLA_OPERATOR } from "./lp-account-safety.mjs";

export const LP_ONE_CYCLE_VERSION = "villa-lp-one-cycle-v1";

export class LpOneCycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LpOneCycleError";
    this.code = code;
  }
}

function disabled(reason, extra = {}) {
  return Object.freeze({ version: LP_ONE_CYCLE_VERSION, status: "REFUSED", broadcast: false, writes: 0, reason, ...extra });
}

function assertOneCycleRequest(request = {}) {
  if (request.oneCycle !== true) throw new LpOneCycleError("ONE_CYCLE_REQUIRED", "the bounded runner requires an explicit one-cycle request");
  if (request.loop === true || request.daemon === true || request.rollover === true || request.restart === true) throw new LpOneCycleError("ONE_CYCLE_ONLY", "loop, daemon, restart, and rollover are not available in the bounded runner");
}

function assertFreshFacts(facts) {
  if (!facts || facts.fresh !== true) throw new LpOneCycleError("FRESH_PREFLIGHT_REQUIRED", "one-cycle execution requires a fresh preflight fact set");
}

function assertScope(request, facts) {
  const session = facts?.session;
  if (!session || typeof session.sessionId !== "string" || !session.account) throw new LpOneCycleError("SESSION_REQUIRED", "a specific account-bound session is required");
  if (!request.sessionId) throw new LpOneCycleError("SESSION_REQUIRED", "one-cycle execution requires a specific sessionId");
  if (!request.account) throw new LpOneCycleError("ACCOUNT_REQUIRED", "one-cycle execution requires a specific VillaAccount");
  if (request.sessionId !== session.sessionId) throw new LpOneCycleError("SESSION_SCOPE_MISMATCH", "requested session does not match the fresh session");
  if (String(request.account).toLowerCase() !== String(session.account).toLowerCase()) throw new LpOneCycleError("ACCOUNT_SCOPE_MISMATCH", "requested account does not match the fresh session");
}

function sameAddress(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function assertWetFacts(facts) {
  const session = facts.session;
  const lease = facts.lease;
  if (!lease?.held || !sameAddress(lease.account, session.account) || lease.sessionId !== session.sessionId) throw new LpOneCycleError("ACCOUNT_LEASE_REQUIRED", "the named account lease is not held by this session");
  if (!sameAddress(session.operator, CANONICAL_VILLA_OPERATOR)) throw new LpOneCycleError("OPERATOR_NOT_CANONICAL", "the session operator is not the canonical VILLA operator");
  if (!sameAddress(facts.operator?.signerAddress, session.operator)) throw new LpOneCycleError("SIGNER_MISMATCH", "the fresh signer identity does not match the session operator");
  if (!sameAddress(facts.account?.operator ?? facts.accountOperator, session.operator)) throw new LpOneCycleError("OPERATOR_NOT_AUTHORIZED", "the fresh VillaAccount operator is not the session operator");
  if (!facts.market || String(facts.market.marketId ?? "").toLowerCase() !== String(session.currentMarketId ?? "").toLowerCase() || String(facts.market.series ?? "") !== String(session.marketSeries ?? "")) throw new LpOneCycleError("MARKET_SCOPE_MISMATCH", "the fresh market is not the exact session market");
}

function assertPlans(plans, caps) {
  if (!Array.isArray(plans)) throw new LpOneCycleError("PLAN_INVALID", "one-cycle plan must return an array");
  if (plans.length > Number(caps.MAX_TX_COUNT)) throw new LpOneCycleError("TX_COUNT_CAP", "one-cycle plan exceeds the transaction cap");
  for (const plan of plans) {
    if (!plan || plan.broadcast !== false) throw new LpOneCycleError("BROADCAST_BOUNDARY", "every prepared one-cycle plan must remain broadcast=false before the writer boundary");
  }
}

/**
 * Run exactly one account-bound cycle. `buildPlans` returns policy-prepared
 * plans. In SHADOW mode no writer is even consulted.
 */
export async function runLpOneCycle({
  request = {},
  mode = "SHADOW",
  executionEnabled = false,
  facts = null,
  readFreshFacts = null,
  preflight,
  buildPlans,
  validatePlan = null,
  writer = null,
  caps = DEFAULT_PHASE_3B1_CAPS,
  onEvent = () => undefined,
} = {}) {
  try {
    assertOneCycleRequest(request);
    const normalizedMode = String(mode).toUpperCase();
    if (!["SHADOW", "WET"].includes(normalizedMode)) throw new LpOneCycleError("MODE_INVALID", "one-cycle mode must be SHADOW or WET");
    let fresh;
    try {
      fresh = typeof readFreshFacts === "function" ? await readFreshFacts() : facts;
    } catch {
      throw new LpOneCycleError("FRESH_FACTS_UNAVAILABLE", "fresh chain/venue facts could not be acquired");
    }
    assertFreshFacts(fresh);
    assertScope(request, fresh);
    if (normalizedMode === "WET") assertWetFacts(fresh);
    if (typeof buildPlans !== "function") throw new LpOneCycleError("PLAN_BUILDER_REQUIRED", "one-cycle plan builder is required");
    const plans = await buildPlans(fresh);
    assertPlans(plans, caps);
    if (typeof validatePlan !== "function") throw new LpOneCycleError("POLICY_REQUIRED", "the central transaction policy is required for every one-cycle plan");
    for (const plan of plans) {
      const validation = await validatePlan(plan);
      if (!validation?.allowed) throw new LpOneCycleError(validation?.code ?? "POLICY_DENIED", validation?.reason ?? "transaction policy denied the one-cycle plan");
    }

    if (normalizedMode === "SHADOW") {
      onEvent({ event: "LP_ONE_CYCLE_SHADOW", sessionId: fresh.session.sessionId, account: fresh.session.account, broadcast: false, atMs: Date.now() });
      return Object.freeze({ version: LP_ONE_CYCLE_VERSION, status: "SHADOW", broadcast: false, writes: 0, sessionId: fresh.session.sessionId, account: fresh.session.account, plans: Object.freeze(plans) });
    }
    if (executionEnabled !== true) return disabled("EXECUTION_DISABLED", { sessionId: fresh.session.sessionId, account: fresh.session.account, plans: Object.freeze(plans) });
    if (typeof preflight !== "function") throw new LpOneCycleError("PREFLIGHT_REQUIRED", "fresh wet preflight is required before the writer");
    const result = await preflight({ ...fresh, executionEnabled: true });
    if (!result?.allowed) return disabled("PREFLIGHT_DENIED", { sessionId: fresh.session.sessionId, account: fresh.session.account, reasons: result?.reasons ?? [], plans: Object.freeze(plans) });
    if (!writer || typeof writer.enqueue !== "function") throw new LpOneCycleError("WRITER_REQUIRED", "the single serialized writer is required after preflight");
    const records = [];
    for (const plan of plans) records.push(await writer.enqueue(plan));
    onEvent({ event: "LP_ONE_CYCLE_COMPLETE", sessionId: fresh.session.sessionId, account: fresh.session.account, broadcast: true, atMs: Date.now() });
    return Object.freeze({ version: LP_ONE_CYCLE_VERSION, status: "COMPLETED", broadcast: true, writes: records.length, sessionId: fresh.session.sessionId, account: fresh.session.account, records: Object.freeze(records) });
  } catch (error) {
    if (error instanceof LpOneCycleError) return disabled(error.code, { message: error.message });
    throw error;
  }
}
