const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export const TERMINAL_BINDING_CLEAR_STATES = Object.freeze(["STOPPED_CLEAN", "SETTLED", "WITHDRAWABLE"]);

function sameAddress(left, right) {
  return ADDRESS_RE.test(String(left ?? "")) && ADDRESS_RE.test(String(right ?? ""))
    && String(left).toLowerCase() === String(right).toLowerCase();
}

function zero(value) {
  try { return BigInt(String(value)) === 0n; } catch { return false; }
}

export function evaluateTerminalBindingClear({ sessionId, owner, account, status, unitsInactive = false, leaseAbsent = false, admission = null, accountState = null } = {}) {
  const state = String(status?.state ?? "").toUpperCase();
  if (!TERMINAL_BINDING_CLEAR_STATES.includes(state)) return { eligible: false, code: "SESSION_NOT_TERMINAL" };
  const session = status?.session;
  if (session?.sessionId !== sessionId || !sameAddress(session?.owner, owner) || !sameAddress(session?.account, account)) {
    return { eligible: false, code: "BINDING_SCOPE_MISMATCH" };
  }
  if (!unitsInactive) return { eligible: false, code: "SESSION_UNIT_ACTIVE_OR_UNKNOWN" };
  if (!leaseAbsent) return { eligible: false, code: "LEASE_ACTIVE_OR_UNKNOWN" };
  if (admission !== null) return { eligible: false, code: "GLOBAL_ADMISSION_NOT_FREE" };
  if (!accountState || accountState.orders?.status !== "VERIFIED" || !Array.isArray(accountState.orders.orders) || accountState.orders.orders.length !== 0) {
    return { eligible: false, code: "ORDERS_UNKNOWN_OR_PRESENT" };
  }
  if (!zero(accountState.inventory?.yesRaw) || !zero(accountState.inventory?.noRaw)) return { eligible: false, code: "INVENTORY_PRESENT_OR_UNKNOWN" };
  if (!zero(accountState.identity?.aggregateExposure) || !zero(accountState.identity?.mintExposure)) return { eligible: false, code: "EXPOSURE_PRESENT_OR_UNKNOWN" };
  if (!zero(accountState.capital?.vaultRaw)) return { eligible: false, code: "VAULT_VALUE_PRESENT_OR_UNKNOWN" };
  if (status?.snapshot?.pendingSettlement || status?.result?.pendingSettlement || status?.result?.settlement?.state === "STOPPED_SETTLEMENT_PENDING") {
    return { eligible: false, code: "SETTLEMENT_PENDING" };
  }
  return { eligible: true, code: "TERMINAL_CLEAN" };
}
