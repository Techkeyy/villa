/** The pre-wet denial drill required before a signer can be considered. */

export const LP_FAILURE_DRILL_VERSION = "villa-lp-failure-drill-v1";
export const LP_FAILURE_DRILL_CASES = Object.freeze([
  Object.freeze({ id: "A", name: "missing signer", expected: "SIGNER_MISMATCH" }),
  Object.freeze({ id: "B", name: "mismatched signer", expected: "SIGNER_MISMATCH" }),
  Object.freeze({ id: "C", name: "operator revoked", expected: "OPERATOR_NOT_AUTHORIZED" }),
  Object.freeze({ id: "D", name: "market locked", expected: "MARKET_NOT_TRADING" }),
  Object.freeze({ id: "E", name: "lease held by another session", expected: "ACCOUNT_LEASE_NOT_HELD" }),
  Object.freeze({ id: "F", name: "capital or order cap exceeded", expected: "ACCOUNT_CAPITAL_CAP" }),
  Object.freeze({ id: "G", name: "unknown pending transaction", expected: "UNKNOWN_TRANSACTION" }),
  Object.freeze({ id: "H", name: "stale intent", expected: "INTENT_STALE" }),
  Object.freeze({ id: "I", name: "policy rejection", expected: "OPERATION_DENIED" }),
  Object.freeze({ id: "J", name: "RPC timeout or unknown read", expected: "OPEN_ORDER_STATE_UNKNOWN" }),
]);

export function summarizeFailureDrill(results = []) {
  return Object.freeze({
    version: LP_FAILURE_DRILL_VERSION,
    cases: Object.freeze(results.map((result) => Object.freeze({
      id: result.id,
      denied: result.denied === true,
      reason: result.reason ?? result.code ?? null,
    }))),
    passed: results.length === LP_FAILURE_DRILL_CASES.length && results.every((result) => result.denied === true),
  });
}
