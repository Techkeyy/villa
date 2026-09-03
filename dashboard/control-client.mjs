const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class ControlClientError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = "ControlClientError";
    this.code = code;
    this.status = status;
  }
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

export function createAccountControlClient({ fetchImpl = (...args) => fetch(...args), provider, ownerProvider = () => "" } = {}) {
  let engineOrigin = null;
  let token = "";
  let tokenOwner = "";

  async function loadConfig() {
    const config = await jsonRequest(fetchImpl, "/api/operator-config");
    engineOrigin = safeOrigin(config.engineApiUrl);
    return config;
  }

  async function authenticate(owner = ownerProvider()) {
    const normalizedOwner = address(owner);
    if (!normalizedOwner || !provider?.request) throw new ControlClientError("OWNER_REQUIRED", "Connect the wallet before using strategy controls.");
    if (!engineOrigin) await loadConfig();
    if (token && tokenOwner.toLowerCase() === normalizedOwner.toLowerCase()) return token;
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
    if (!token) throw new ControlClientError("AUTH_FAILED", "The account control service did not return a session.");
    return token;
  }

  async function state() {
    await authenticate();
    return jsonRequest(fetchImpl, `${engineOrigin}/account/state`, { headers: { Authorization: `Bearer ${token}` } });
  }

  async function command(action) {
    const owner = ownerProvider();
    await authenticate(owner);
    if (!["start", "stop", "settle"].includes(action)) throw new ControlClientError("CONTROL_ACTION_INVALID", "That strategy action is not available.");
    return jsonRequest(fetchImpl, `${engineOrigin}/account/session/${action}`, postOptions({}, token));
  }

  function clear() {
    token = "";
    tokenOwner = "";
  }

  return Object.freeze({ loadConfig, authenticate, state, start: () => command("start"), stop: () => command("stop"), settle: () => command("settle"), clear });
}
