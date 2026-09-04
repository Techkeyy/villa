import { createUatAccountControl } from "./uat-control-runtime.mjs";
import { AccountControlError } from "./account-control.mjs";
import { createOnChainAccountVerifier } from "./account-binding.mjs";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function address(value, label) {
  const text = String(value ?? "");
  if (!ADDRESS_RE.test(text)) throw new AccountControlError("ACCOUNT_SCOPE_INVALID", `${label} must be a valid address`, 400);
  return text.toLowerCase();
}

function same(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function scopeKey(owner, account) {
  return `${owner.toLowerCase()}:${account.toLowerCase()}`;
}

function safeIdentity(identity) {
  const accountVersion = Number(identity.accountVersion ?? identity.version ?? 0) || null;
  return {
    account: identity.account,
    owner: identity.owner,
    operator: identity.operator,
    accountVersion,
    version: accountVersion,
    autonomousTradingEnabled: accountVersion === 2 && identity.autonomousTradingEnabled === true,
    operatorAuthorized: identity.operatorAuthorized !== false,
    runtimeVerified: identity.runtimeVerified === true,
    onChain: identity.onChain === true,
  };
}

function safeState(identity, publicEnabled, reason = "ACCOUNT_EXECUTION_DISABLED") {
  const reasons = publicEnabled ? [reason] : ["PUBLIC_CONTROL_PLANE_DISABLED", reason];
  return Object.freeze({
    version: "villa-account-control-per-user-v1",
    state: "STOPPED",
    executionEnabled: false,
    identity: Object.freeze(safeIdentity(identity)),
    session: null,
    readiness: Object.freeze({ allowed: false, reasons: Object.freeze(reasons), preflight: null }),
    safety: Object.freeze({
      publicEnabled: publicEnabled === true,
      executionEnabled: false,
      signerInBrowser: false,
      arbitraryRelay: false,
      withdrawViaControl: false,
      accountScope: "verified-owner-account",
      privateService: false,
    }),
    controls: Object.freeze({ canStart: false, canPause: false, canResume: false, canStop: false, canSettle: false }),
  });
}

function withoutLegacyAllowlist(state, identity) {
  const { accountAllowlisted: _legacy, ...safety } = state?.safety ?? {};
  return Object.freeze({
    ...state,
    version: "villa-account-control-per-user-v1",
    identity: Object.freeze(safeIdentity(identity)),
    safety: Object.freeze({ ...safety, accountScope: "verified-owner-account" }),
  });
}

function hasActiveSession(state) {
  return Boolean(state?.session) && [
    "STARTING",
    "RUNNING",
    "PAUSED",
    "STOPPING",
    "ERROR",
    "STOPPED_SETTLEMENT_PENDING",
    "SETTLEMENT_READY",
    "SETTLING",
  ].includes(String(state?.state ?? "").toUpperCase());
}

function requireV2(identity) {
  if (Number(identity?.accountVersion ?? identity?.version) !== 2) {
    throw new AccountControlError("ACCOUNT_VERSION_UNSUPPORTED", "V1 VillaAccounts cannot enter autonomous execution", 409);
  }
}

/**
 * Registry keyed by authenticated owner + verified VillaAccount. No owner or
 * account is selected from process-wide environment variables. Each active
 * account receives an isolated private bridge instance.
 */
export function createPerAccountControl({
  env = process.env,
  accountVerifier = createOnChainAccountVerifier({ env }),
  controlFactory = createUatAccountControl,
  controlOptions = {},
  publicEnabled = env.VILLA_PUBLIC_ACCOUNT_CONTROL_ENABLED !== "false",
  accountExecutionEnabled = env.VILLA_ACCOUNT_EXECUTION_ENABLED === "true",
} = {}) {
  if (typeof accountVerifier !== "function") throw new AccountControlError("ACCOUNT_VERIFIER_INVALID", "an on-chain account verifier is required", 500);
  const controls = new Map();
  const operator = String(env.VILLA_ENGINE_OPERATOR || env.OPERATOR_ADDRESS || "").toLowerCase();

  async function resolve({ caller, account, requireOperator = true } = {}) {
    const owner = address(caller, "authenticated owner");
    const target = address(account, "VillaAccount");
    let identity;
    try {
      identity = await accountVerifier({ caller: owner, account: target, operator, requireOperator });
    } catch (error) {
      if (error instanceof AccountControlError) throw error;
      throw new AccountControlError("ACCOUNT_VERIFICATION_UNAVAILABLE", "The VILLA account could not be verified on Shannon.", 503, { cause: error?.code ?? "READ_FAILED" });
    }
    if (!identity || !same(identity.owner, owner) || !same(identity.account, target)) throw new AccountControlError("OWNER_SCOPE_MISMATCH", "The authenticated wallet is not the owner of this VillaAccount.", 403);
    const operatorAuthorized = identity.operatorAuthorized !== false && (!operator || !identity.operator || same(identity.operator, operator));
    if (requireOperator && !operatorAuthorized) throw new AccountControlError("OPERATOR_NOT_AUTHORIZED", "The canonical VILLA operator is not authorized for this VillaAccount.", 403);
    return Object.freeze({ ...identity, owner, account: target, operator: operator || identity.operator, operatorAuthorized });
  }

  async function resolveForStop({ caller, account } = {}) {
    return resolve({ caller, account, requireOperator: false });
  }

  function getControl(identity) {
    const key = scopeKey(identity.owner, identity.account);
    let entry = controls.get(key);
    if (!entry) {
      const controlEnv = {
        ...env,
        VILLA_ENGINE_OWNER: identity.owner,
        VILLA_ENGINE_ACCOUNT: identity.account,
        VILLA_ENGINE_OPERATOR: operator || identity.operator,
        VILLA_ACCOUNT_EXECUTION_ENABLED: "true",
      };
      const control = controlFactory({ env: controlEnv, ...controlOptions });
      entry = { identity, control };
      controls.set(key, entry);
    }
    return entry.control;
  }

  async function getState({ caller, account } = {}) {
    let identity;
    try {
      identity = await resolve({ caller, account });
    } catch (error) {
      if (!(error instanceof AccountControlError) || error.code !== "OPERATOR_NOT_AUTHORIZED") throw error;
      identity = await resolveForStop({ caller, account });
    }
    if (identity.accountVersion === 1) return safeState(identity, publicEnabled, "ACCOUNT_VERSION_UNSUPPORTED");
    const current = withoutLegacyAllowlist(await getControl(identity).getState({ caller: identity.owner }), identity);
    if (hasActiveSession(current) || accountExecutionEnabled) return current;
    return safeState(identity, publicEnabled);
  }

  async function start({ caller, account } = {}) {
    const identity = await resolve({ caller, account });
    requireV2(identity);
    if (!publicEnabled) throw new AccountControlError("PUBLIC_CONTROL_PLANE_DISABLED", "public account control is disabled by release policy", 423);
    if (!accountExecutionEnabled) throw new AccountControlError("ACCOUNT_EXECUTION_DISABLED", "account execution is disabled; no account writer was started", 423);
    return getControl(identity).start({ caller: identity.owner });
  }

  async function stop({ caller, account } = {}) {
    const identity = await resolveForStop({ caller, account });
    if (identity.accountVersion === 1) return safeState(identity, publicEnabled, "ACCOUNT_VERSION_UNSUPPORTED");
    const control = getControl(identity);
    const current = await control.getState({ caller: identity.owner });
    if (hasActiveSession(current)) return withoutLegacyAllowlist(await control.stop({ caller: identity.owner }), identity);
    return safeState(identity, publicEnabled);
  }

  async function settle({ caller, account } = {}) {
    const identity = await resolve({ caller, account });
    requireV2(identity);
    if (!accountExecutionEnabled) throw new AccountControlError("ACCOUNT_EXECUTION_DISABLED", "account execution is disabled; no settlement writer was started", 423);
    return getControl(identity).settle({ caller: identity.owner });
  }

  async function pause({ caller, account } = {}) {
    const identity = await resolve({ caller, account });
    requireV2(identity);
    if (!accountExecutionEnabled) return getState({ caller, account });
    return getControl(identity).pause({ caller: identity.owner });
  }

  async function resume({ caller, account } = {}) {
    const identity = await resolve({ caller, account });
    requireV2(identity);
    if (!publicEnabled) throw new AccountControlError("PUBLIC_CONTROL_PLANE_DISABLED", "public account control is disabled by release policy", 423);
    if (!accountExecutionEnabled) throw new AccountControlError("ACCOUNT_EXECUTION_DISABLED", "account execution is disabled; no account writer was started", 423);
    return getControl(identity).resume({ caller: identity.owner });
  }

  return Object.freeze({ getState, start, stop, settle, pause, resume });
}
