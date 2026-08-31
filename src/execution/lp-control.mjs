/**
 * Account-bound START/PAUSE/STOP orchestration for the future wet engine.
 * This module owns state transitions and cleanup semantics; the caller injects
 * the policy-approved writer and fresh reconciliation reads.
 */

import { LP_SESSION_STATES, assertLpSessionScope, transitionLpSession } from "./lp-session.mjs";
import { evaluateWetExecutionPreflight } from "./lp-preflight.mjs";
import { assertReconciledForLeaseRelease } from "./lp-reconciliation.mjs";

export const LP_CONTROL_VERSION = "villa-lp-control-v1";

export class LpControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LpControlError";
    this.code = code;
  }
}
function accountOf(order) {
  return order?.account ?? order?.owner ?? null;
}
function ensureTrackedOrder(order, session) {
  assertLpSessionScope(session, { account: accountOf(order), marketId: order?.marketId });
  if (!order?.orderId) throw new LpControlError("ORDER_INVALID", "tracked order id is required");
}

export function createLpSessionController({
  session,
  leaseStore,
  lease,
  preflight = evaluateWetExecutionPreflight,
  cancelOrder = null,
  burnCompleteSet = null,
  reconcile,
  now = () => Date.now(),
} = {}) {
  if (!session || !leaseStore || !lease) throw new LpControlError("CONTROL_INVALID", "session and account lease are required");
  if (typeof reconcile !== "function") throw new LpControlError("RECONCILIATION_REQUIRED", "fresh reconciliation callback is required");
  let current = session;
  let heldLease = lease;
  let lastReconciliation = null;

  function state() {
    return Object.freeze({
      version: LP_CONTROL_VERSION,
      session: current,
      lease: heldLease,
      lastReconciliation,
      writesBlocked: ["CREATED", "PREFLIGHT", "PAUSED", "STOPPING", "STOPPED", "ERROR"].includes(current.state),
    });
  }

  function move(next) {
    current = transitionLpSession(current, next, { atMs: now() });
  }

  async function start(facts = {}) {
    if (!["CREATED", "PAUSED", "ERROR"].includes(current.state)) throw new LpControlError("SESSION_ALREADY_ACTIVE", `cannot start from ${current.state}`);
    heldLease = leaseStore.assertHeld(current, { atMs: now() });
    move("PREFLIGHT");
    const result = preflight({ ...facts, session: current, lease: { ...heldLease, held: true }, nowMs: now() });
    if (!result.allowed) {
      move("ERROR");
      return Object.freeze({ started: false, result, ...state() });
    }
    move("RUNNING");
    return Object.freeze({ started: true, result, ...state() });
  }

  async function pause({ openOrders = [] } = {}) {
    if (current.state !== "RUNNING") throw new LpControlError("SESSION_NOT_RUNNING", `cannot pause from ${current.state}`);
    for (const order of openOrders) ensureTrackedOrder(order, current);
    move("PAUSED");
    if (openOrders.length > 0 && typeof cancelOrder !== "function") {
      move("ERROR");
      throw new LpControlError("CANCEL_HANDLER_REQUIRED", "PAUSE cannot safely cancel tracked orders without a writer");
    }
    try {
      for (const order of openOrders) await cancelOrder(order);
    } catch (error) {
      move("ERROR");
      throw new LpControlError("PAUSE_CLEANUP_FAILED", error?.message ?? "PAUSE could not cancel tracked orders");
    }
    return state();
  }

  async function resume(facts = {}) {
    if (current.state !== "PAUSED") throw new LpControlError("SESSION_NOT_PAUSED", `cannot resume from ${current.state}`);
    return start(facts);
  }

  async function stop({ openOrders = [], burnAmountRaw = 0n, marketId = current.currentMarketId } = {}) {
    if (["STOPPED"].includes(current.state)) return state();
    if (!["RUNNING", "PAUSED", "ERROR", "PREFLIGHT"].includes(current.state)) throw new LpControlError("STOP_INVALID", `cannot stop from ${current.state}`);
    for (const order of openOrders) ensureTrackedOrder(order, current);
    move("STOPPING");
    if (openOrders.length > 0 && typeof cancelOrder !== "function") {
      move("ERROR");
      throw new LpControlError("CANCEL_HANDLER_REQUIRED", "STOP cannot safely cancel tracked orders without a writer");
    }
    try {
      for (const order of openOrders) await cancelOrder(order);
      if (burnAmountRaw > 0n) {
        if (typeof burnCompleteSet !== "function") throw new LpControlError("BURN_HANDLER_REQUIRED", "paired cleanup requires an explicit burn writer");
        await burnCompleteSet({ marketId, amountRaw: burnAmountRaw });
      }
      lastReconciliation = await reconcile({ phase: "STOP", session: current, marketId });
      assertReconciledForLeaseRelease(lastReconciliation);
      move("STOPPED");
      leaseStore.release(current, { reconciled: true, atMs: now() });
      heldLease = null;
      return state();
    } catch (error) {
      if (current.state !== "ERROR") move("ERROR");
      if (error instanceof LpControlError) throw error;
      throw new LpControlError("STOP_RECONCILIATION_FAILED", error?.message ?? "STOP could not prove a safe terminal state");
    }
  }

  return Object.freeze({
    start,
    pause,
    resume,
    stop,
    getState: state,
    get session() { return current; },
    get allowedStates() { return LP_SESSION_STATES; },
  });
}
