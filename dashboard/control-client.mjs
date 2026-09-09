const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class ControlClientError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = "ControlClientError";
    this.code = code;
    this.status = status;
  }
}

export const CONTROL_STOP_TERMINAL_STATES = Object.freeze([
  "STOPPED",
  "STOPPED_CLEAN",
  "STOPPED_SETTLEMENT_PENDING",
  "SETTLEMENT_READY",
  "SETTLED",
  "WITHDRAWABLE",
  "ERROR",
]);

export const CONTROL_ACTIVE_STATES = Object.freeze([
  "STARTING",
  "RUNNING",
  "PAUSED",
  "STOPPING",
  "SETTLEMENT_READY",
  "SETTLING",
  "WAITING_FOR_QUOTE",
  "WAITING_FOR_FRESH_PRICE",
]);

const WAITING_CONTROL_STAGES = new Set(["WAITING_FOR_QUOTE", "WAITING_FOR_FRESH_PRICE"]);

export function controlTransactionView({ state = "STOPPED", payload = null, session = null, snapshot = null, result = null } = {}) {
  const rawState = String(state || payload?.state || session?.state || "STOPPED").toUpperCase();
  const normalized = normalizeControlState(rawState);
  const stageCode = String(payload?.stage?.code ?? snapshot?.stage?.code ?? session?.stage?.code ?? "").toUpperCase();
  const effective = WAITING_CONTROL_STAGES.has(stageCode) && ["STARTING", "RUNNING", "PAUSED"].includes(normalized) ? stageCode : normalized;
  const error = payload?.error ?? result?.error ?? (result?.status === "ERROR" ? result : null);
  if (effective === "STARTING") return { status: "CONFIRMING", title: "Starting strategy", copy: "The account-bound engine is progressing through live preflight stages.", detail: "No transaction hash yet." };
  if (effective === "RUNNING") return { status: "RUNNING", title: "Strategy active", copy: "The account-bound engine is evaluating market, risk, inventory, and quotes.", detail: "No transaction hash is required for the control state." };
  if (effective === "WAITING_FOR_QUOTE") return { status: "WAITING", title: "Waiting for a safe quote", copy: "No new risk is being added while the planner waits for a safe quote.", detail: "The engine will reevaluate on its normal cycle." };
  if (effective === "WAITING_FOR_FRESH_PRICE") return { status: "WAITING", title: "Waiting for fresh market data", copy: "No new risk is being added while price freshness is unavailable.", detail: "The engine will reevaluate when fresh data returns." };
  if (effective === "STOPPING") return { status: "STOPPING", title: "Stopping strategy", copy: "New risk is stopped while the account-bound cleanup completes.", detail: "Cleanup remains account-scoped." };
  if (effective === "SETTLING") return { status: "SETTLING", title: "Settling strategy", copy: "The account-bound settlement path is reconciling the exact market.", detail: "No browser transaction is being requested." };
  if (effective === "STOPPED_SETTLEMENT_PENDING" || effective === "SETTLEMENT_READY") return { status: effective, title: "Settlement pending", copy: "The session is waiting for the market settlement lifecycle to complete.", detail: "No withdrawal was attempted." };
  if (effective === "STOPPED_CLEAN" || (effective === "STOPPED" && (result || session?.stoppedAt))) return { status: "SUCCESS", title: "Strategy stopped cleanly", copy: "The account-bound session completed its cleanup path.", detail: "No transaction hash is required for the terminal control state." };
  if (effective === "SETTLED" || effective === "WITHDRAWABLE") return { status: "SUCCESS", title: effective === "SETTLED" ? "Settlement complete" : "Strategy withdrawable", copy: "The account-bound value lifecycle is complete.", detail: "Withdrawal remains a separate owner action." };
  if (effective === "ERROR") return { status: "FAILED", title: "Strategy failed", copy: String(error?.message ?? result?.reason ?? "The private UAT session failed."), detail: String(error?.code ?? result?.code ?? "UAT_SESSION_FAILED") };
  return null;
}

export function normalizeControlState(value) {
  const state = String(value || "STOPPED").toUpperCase();
  return state === "STOPPED_CLEAN" ? "STOPPED" : state;
}

export function controlStateOf(payload) {
  return String(payload?.state || payload?.session?.state || "STOPPED").toUpperCase();
}

export function reconcileControlPayload(payload, previous = {}) {
  const terminalCandidate = (value) => {
    const candidate = String(value || "").toUpperCase();
    return CONTROL_STOP_TERMINAL_STATES.includes(candidate) ? candidate : null;
  };
  const outerState = String(payload?.state || "").toUpperCase();
  const sessionState = String(payload?.session?.state || "").toUpperCase();
  const activeStateReported = CONTROL_ACTIVE_STATES.includes(outerState) || CONTROL_ACTIVE_STATES.includes(sessionState);
  const terminalState = terminalCandidate(payload?.session?.state) ?? terminalCandidate(payload?.state) ?? (activeStateReported ? null : terminalCandidate(payload?.result?.status));
  const rawState = terminalState ?? controlStateOf(payload);
  const state = normalizeControlState(rawState);
  const active = terminalState ? false : CONTROL_ACTIVE_STATES.includes(rawState);
  const terminal = Boolean(terminalState);
  const result = payload?.result ?? (terminal && state !== "ERROR" ? previous.result ?? null : null);

  if (terminal && !active) {
    return Object.freeze({
      state,
      session: payload?.session ?? null,
      snapshot: payload?.snapshot ?? null,
      result,
      active: false,
      authoritative: true,
    });
  }

  return Object.freeze({
    state,
    session: payload?.session ?? previous.session ?? null,
    snapshot: payload?.snapshot ?? previous.snapshot ?? null,
    result: payload?.result ?? previous.result ?? null,
    active,
    authoritative: true,
  });
}

export function controlStateAfterPollFailure(previousState) {
  return CONTROL_ACTIVE_STATES.includes(normalizeControlState(previousState)) ? "RECONNECTING" : normalizeControlState(previousState);
}

export async function waitForControlStop(readState, { delayMs = 1_000, maxAttempts = 30, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onState = () => undefined } = {}) {
  if (typeof readState !== "function") throw new TypeError("readState must be a function");
  let payload = null;
  let state = "STOPPING";
  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 0) await sleep(delayMs);
    payload = await readState();
    state = controlStateOf(payload);
    onState(payload, state);
    if (CONTROL_STOP_TERMINAL_STATES.includes(state)) return { complete: true, payload, state };
  }
  return { complete: false, payload, state };
}

function address(value) {
  const text = String(value ?? "");
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text : null;
}

function safeOrigin(value) {
  if (!value) throw new ControlClientError("CONTROL_UNAVAILABLE", "The account control service is not configured.");
  let parsed;
  try { parsed = new URL(value); } catch { throw new ControlClientError("CONTROL_UNAVAILABLE", "The account control service is not configured."); }
  const local = LOCAL_HOSTS.has(window.location.hostname);
  if (!((parsed.protocol === "https:") || (local && parsed.protocol === "http:"))) {
    throw new ControlClientError("CONTROL_UNAVAILABLE", "The account control service must use HTTPS.");
  }
  return parsed.origin;
}

async function jsonRequest(fetchImpl, url, options = {}) {
  let response;
  try { response = await fetchImpl(url, { cache: "no-store", ...options }); } catch (error) {
    throw new ControlClientError("CONTROL_UNAVAILABLE", "The account control service could not be reached.", 0, error);
  }
  let body = {};
  try { body = await response.json(); } catch { /* an empty error body is handled below */ }
  if (!response.ok) {
    throw new ControlClientError(body.code || "CONTROL_REQUEST_FAILED", body.error || "The account control request was refused.", response.status);
  }
  return body;
}

function postOptions(body, token = "") {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  };
}

export function createAccountControlClient({ fetchImpl = (...args) => fetch(...args), provider, ownerProvider = () => "", accountProvider = () => "" } = {}) {
  let engineOrigin = null;
  let token = "";
  let tokenOwner = "";
  let tokenExpiresAt = 0;
  const tokenRefreshSkewMs = 5_000;

  async function loadConfig() {
    const config = await jsonRequest(fetchImpl, "/api/operator-config");
    engineOrigin = safeOrigin(config.engineApiUrl);
    return config;
  }

  async function authenticate(owner = ownerProvider()) {
    const normalizedOwner = address(owner);
    if (!normalizedOwner || !provider?.request) throw new ControlClientError("OWNER_REQUIRED", "Connect the wallet before using strategy controls.");
    if (!engineOrigin) await loadConfig();
    if (token && tokenOwner.toLowerCase() === normalizedOwner.toLowerCase() && (!tokenExpiresAt || tokenExpiresAt > Date.now() + tokenRefreshSkewMs)) return token;
    const nonce = await jsonRequest(fetchImpl, `${engineOrigin}/account/auth/nonce`, postOptions({ address: normalizedOwner }));
    let signature;
    try {
      signature = await provider.request({ method: "personal_sign", params: [nonce.message, normalizedOwner] });
    } catch (error) {
      throw new ControlClientError(error?.code === 4001 ? "WALLET_REJECTED" : "SIGNATURE_FAILED", error?.code === 4001 ? "The wallet signature was cancelled. Nothing changed." : "The wallet signature could not be completed.", 0);
    }
    const verified = await jsonRequest(fetchImpl, `${engineOrigin}/account/auth/verify`, postOptions({ ...nonce, signature }));
    token = String(verified.token || "");
    tokenOwner = normalizedOwner;
    tokenExpiresAt = Number(verified.expiresAt) || 0;
    if (!token) throw new ControlClientError("AUTH_FAILED", "The account control service did not return a session.");
    return token;
  }

  function selectedAccount(value = accountProvider()) {
    const normalized = address(value);
    if (!normalized) throw new ControlClientError("ACCOUNT_REQUIRED", "Verify your VILLA account before using strategy controls.");
    return normalized;
  }

  async function state(accountAddress = accountProvider()) {
    const account = selectedAccount(accountAddress);
    const url = () => `${engineOrigin}/account/state?account=${encodeURIComponent(account)}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await authenticate();
      try {
        return await jsonRequest(fetchImpl, url(), { headers: { Authorization: `Bearer ${token}` } });
      } catch (error) {
        const expired = error instanceof ControlClientError && (error.status === 401 || error.code === "SESSION_REQUIRED" || error.code === "NONCE_INVALID");
        if (!expired || attempt > 0) throw error;
        clear();
      }
    }
    throw new ControlClientError("SESSION_REQUIRED", "Connect your owner wallet to continue.");
  }

  async function command(action, accountAddress = accountProvider()) {
    const owner = ownerProvider();
    await authenticate(owner);
    if (!["start", "stop", "settle"].includes(action)) throw new ControlClientError("CONTROL_ACTION_INVALID", "That strategy action is not available.");
    return jsonRequest(fetchImpl, `${engineOrigin}/account/session/${action}`, postOptions({ account: selectedAccount(accountAddress) }, token));
  }

  function clear() {
    token = "";
    tokenOwner = "";
    tokenExpiresAt = 0;
  }

  return Object.freeze({ loadConfig, authenticate, state, start: (accountAddress) => command("start", accountAddress), stop: (accountAddress) => command("stop", accountAddress), settle: (accountAddress) => command("settle", accountAddress), clear });
}
