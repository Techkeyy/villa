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
  return {
    account: identity.account,
    owner: identity.owner,
    operator: identity.operator,
    runtimeVerified: identity.runtimeVerified === true,
    onChain: identity.onChain === true,
  };
}

function safeState(identity, publicEnabled) {
  return Object.freeze({
    version: "villa-account-control-per-user-v1",
    state: "STOPPED",
    executionEnabled: false,
    identity: Object.freeze(safeIdentity(identity)),
    session: null,
    readiness: Object.freeze({ allowed: false, reasons: Object.freeze(publicEnabled ? ["EXECUTION_DISABLED"] : ["PUBLIC_CONTROL_PLANE_DISABLED", "EXECUTION_DISABLED"]), preflight: null }),
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
  executionEnabled = env.VILLA_EXECUTION_ENABLED === "true" && env.VILLA_UAT_EXECUTION_ENABLED === "true",
} = {}) {
  if (typeof accountVerifier !== "function") throw new AccountControlError("ACCOUNT_VERIFIER_INVALID", "an on-chain account verifier is required", 500);
  const controls = new Map();
  const operator = String(env.VILLA_ENGINE_OPERATOR || env.OPERATOR_ADDRESS || "").toLowerCase();

  async function resolve({ caller, account } = {}) {
    const owner = address(caller, "authenticated owner");
    const target = address(account, "VillaAccount");
    let identity;
    try {
      identity = await accountVerifier({ caller: owner, account: target, operator });
    } catch (error) {
      if (error instanceof AccountControlError) throw error;
      throw new AccountControlError("ACCOUNT_VERIFICATION_UNAVAILABLE", "The VILLA account could not be verified on Shannon.", 503, { cause: error?.code ?? "READ_FAILED" });
    }
    if (!identity || !same(identity.owner, owner) || !same(identity.account, target)) throw new AccountControlError("OWNER_SCOPE_MISMATCH", "The authenticated wallet is not the owner of this VillaAccount.", 403);
    if (operator && identity.operator && !same(identity.operator, operator)) throw new AccountControlError("OPERATOR_NOT_AUTHORIZED", "The canonical VILLA operator is not authorized for this VillaAccount.", 403);
    return Object.freeze({ ...identity, owner, account: target });
  }

  function getControl(identity) {
    const key = scopeKey(identity.owner, identity.account);
    let entry = controls.get(key);
    if (!entry) {
      const controlEnv = { ...env, VILLA_ENGINE_OWNER: identity.owner, VILLA_ENGINE_ACCOUNT: identity.account, VILLA_ENGINE_OPERATOR: identity.operator };
      const control = controlFactory({ env: controlEnv, ...controlOptions });
      entry = { identity, control };
      controls.set(key, entry);
    }
    return entry.control;
  }

  async function getState({ caller, account } = {}) {
    const identity = await resolve({ caller, account });
    if (!executionEnabled) return safeState(identity, publicEnabled);
    return withoutLegacyAllowlist(await getControl(identity).getState({ caller: identity.owner }), identity);
  }

  async function start({ caller, account } = {}) {
    const identity = await resolve({ caller, account });
    if (!publicEnabled) throw new AccountControlError("PUBLIC_CONTROL_PLANE_DISABLED", "public account control is disabled by release policy", 423);
    if (!executionEnabled) throw new AccountControlError("EXECUTION_DISABLED", "execution is disabled; no account writer was started", 423);
    return getControl(identity).start({ caller: identity.owner });
  }

  async function stop({ caller, account } = {}) {
    const identity = await resolve({ caller, account });
    if (!executionEnabled) return safeState(identity, publicEnabled);
    return getControl(identity).stop({ caller: identity.owner });
  }

  async function settle({ caller, account } = {}) {
    const identity = await resolve({ caller, account });
    if (!executionEnabled) throw new AccountControlError("EXECUTION_DISABLED", "execution is disabled; no settlement writer was started", 423);
    return getControl(identity).settle({ caller: identity.owner });
  }

  async function pause({ caller, account } = {}) {
    const identity = await resolve({ caller, account });
    if (!executionEnabled) return safeState(identity, publicEnabled);
    return getControl(identity).pause({ caller: identity.owner });
  }

  async function resume({ caller, account } = {}) {
    const identity = await resolve({ caller, account });
    if (!publicEnabled) throw new AccountControlError("PUBLIC_CONTROL_PLANE_DISABLED", "public account control is disabled by release policy", 423);
    if (!executionEnabled) throw new AccountControlError("EXECUTION_DISABLED", "execution is disabled; no account writer was started", 423);
    return getControl(identity).resume({ caller: identity.owner });
  }

  return Object.freeze({ getState, start, stop, settle, pause, resume });
}
