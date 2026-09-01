/**
 * Optional account-bound control-plane seam.
 *
 * This module prepares the authenticated Start/Stop integration without
 * arming the public product. The existing lp-control session controller owns
 * account-scoped writes and cleanup; this seam owns caller binding, the
 * explicit public/execution gates, and a safe browser-facing state shape.
 */

import { isAddress } from "viem";
import { evaluateWetExecutionPreflight } from "../execution/lp-preflight.mjs";

export const ACCOUNT_CONTROL_VERSION = "villa-account-control-v1";
export const ACCOUNT_CONTROL_STATES = Object.freeze(["STOPPED", "STARTING", "RUNNING", "PAUSED", "STOPPING", "ERROR"]);

export class AccountControlError extends Error {
  constructor(code, message, status = 409, details = null) {
    super(message);
    this.name = "AccountControlError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function addressKey(value) {
  const text = String(value ?? "");
  return /^0x[0-9a-fA-F]{40}$/.test(text) && isAddress(text) ? text.toLowerCase() : null;
}

function sessionOf(sessionController) {
  return sessionController?.getState?.().session ?? sessionController?.session ?? null;
}

function publicState(sessionState) {
  if (["RUNNING", "PAUSED", "STOPPING", "ERROR"].includes(sessionState)) return sessionState;
  return "STOPPED";
}

function activeState(state) {
  return ["PREFLIGHT", "RUNNING", "PAUSED", "STOPPING"].includes(state);
}

export function createAccountBoundControlPlane({
  sessionController,
  factsReader = async () => ({}),
  preflight = evaluateWetExecutionPreflight,
  publicEnabled = false,
  executionEnabled = false,
} = {}) {
  if (!sessionController || typeof sessionController.start !== "function" || typeof sessionController.stop !== "function") {
    throw new AccountControlError("CONTROL_INVALID", "an account-bound session controller is required", 500);
  }
  if (typeof factsReader !== "function" || typeof preflight !== "function") {
    throw new AccountControlError("CONTROL_INVALID", "account facts and preflight callbacks are required", 500);
  }

  async function evaluate(caller = null) {
    const session = sessionOf(sessionController);
    let facts;
    try {
      facts = await factsReader();
    } catch (error) {
      throw new AccountControlError("FACTS_UNAVAILABLE", "fresh account control facts are unavailable", 503, { cause: error?.code ?? "READ_FAILED" });
    }
    const owner = addressKey(facts?.owner?.address ?? facts?.owner?.owner ?? session?.owner);
    if (caller !== null) {
      if (!owner || addressKey(caller) !== owner) throw new AccountControlError("OWNER_SCOPE_MISMATCH", "the authenticated wallet is not the owner of this VillaAccount", 403);
    }
    const result = preflight({ ...facts, session, executionEnabled });
    const reasons = [...(result?.reasons ?? [])];
    if (!publicEnabled) reasons.push("PUBLIC_CONTROL_PLANE_DISABLED");
    if (!executionEnabled && !reasons.includes("EXECUTION_DISABLED")) reasons.push("EXECUTION_DISABLED");
    return { facts: { ...facts, session }, session, result, reasons: [...new Set(reasons)], owner };
  }

  async function getState({ caller = null } = {}) {
    const evaluated = await evaluate(caller);
    const sessionState = evaluated.session?.state ?? "STOPPED";
    return Object.freeze({
      version: ACCOUNT_CONTROL_VERSION,
      state: publicState(sessionState),
      session: evaluated.session ? {
        sessionId: evaluated.session.sessionId ?? null,
        account: evaluated.session.account ?? null,
        owner: evaluated.session.owner ?? null,
        operator: evaluated.session.operator ?? null,
        marketSeries: evaluated.session.marketSeries ?? null,
        currentMarketId: evaluated.session.currentMarketId ?? null,
        state: sessionState,
      } : null,
      readiness: Object.freeze({
        allowed: evaluated.reasons.length === 0,
        reasons: Object.freeze(evaluated.reasons),
        preflight: evaluated.result ?? null,
      }),
      safety: Object.freeze({
        publicEnabled: publicEnabled === true,
        executionEnabled: executionEnabled === true,
        signerInBrowser: false,
        arbitraryRelay: false,
        withdrawViaControl: false,
      }),
      controls: Object.freeze({
        canStart: evaluated.reasons.length === 0 && sessionState === "CREATED",
        canPause: sessionState === "RUNNING",
        canResume: sessionState === "PAUSED",
        canStop: activeState(sessionState) || sessionState === "ERROR",
      }),
    });
  }

  async function start({ caller = null } = {}) {
    const evaluated = await evaluate(caller);
    if (!publicEnabled) throw new AccountControlError("ACCOUNT_WET_PROOF_PENDING", "public Start is disabled until the account-bound wet proof passes", 423);
    if (!executionEnabled) throw new AccountControlError("EXECUTION_DISABLED", "execution is disabled; no account writer was started", 423);
    if (evaluated.reasons.length > 0) throw new AccountControlError("ACCOUNT_PREFLIGHT_BLOCKED", "account preflight did not pass", 409, { reasons: evaluated.reasons });
    return sessionController.start(evaluated.facts);
  }

  async function pause({ caller = null, openOrders = [] } = {}) {
    const evaluated = await evaluate(caller);
    const trustedOrders = evaluated.facts.cleanup?.openOrders ?? [];
    void openOrders;
    return sessionController.pause({ openOrders: trustedOrders });
  }

  async function resume({ caller = null } = {}) {
    const evaluated = await evaluate(caller);
    if (!publicEnabled) throw new AccountControlError("ACCOUNT_WET_PROOF_PENDING", "public Resume is disabled until the account-bound wet proof passes", 423);
    if (!executionEnabled) throw new AccountControlError("EXECUTION_DISABLED", "execution is disabled; no account writer was started", 423);
    if (evaluated.reasons.length > 0) throw new AccountControlError("ACCOUNT_PREFLIGHT_BLOCKED", "account preflight did not pass", 409, { reasons: evaluated.reasons });
    return sessionController.resume(evaluated.facts);
  }

  async function stop({ caller = null, openOrders = [], burnAmountRaw = 0n, marketId } = {}) {
    const evaluated = await evaluate(caller);
    const cleanup = evaluated.facts.cleanup ?? {};
    void openOrders;
    void burnAmountRaw;
    void marketId;
    return sessionController.stop({
      openOrders: cleanup.openOrders ?? [],
      burnAmountRaw: cleanup.burnAmountRaw ?? 0n,
      marketId: cleanup.marketId ?? evaluated.session?.currentMarketId,
    });
  }

  return Object.freeze({ getState, start, pause, resume, stop });
}
