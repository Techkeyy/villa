/**
 * Safe execution-event projection. This is an allowlist, not a best-effort
 * string scrubber: unknown fields are dropped before a record reaches logs.
 */

export const LP_LOGGING_VERSION = "villa-lp-safe-logging-v1";
const ALLOWED_FIELDS = new Set([
  "version", "event", "sessionId", "account", "owner", "operator", "chainId",
  "marketId", "action", "operation", "txHash", "orderId", "state", "status",
  "reason", "code", "broadcast", "sequence", "nonce", "atMs", "durationMs",
]);

function primitive(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  return undefined;
}

/** Return only non-secret, public operational facts suitable for logs. */
export function safeLpLogEvent(event = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("log event must be an object");
  const output = { version: LP_LOGGING_VERSION };
  for (const [key, value] of Object.entries(event)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    const normalized = primitive(value);
    if (normalized !== undefined) output[key] = normalized;
  }
  return Object.freeze(output);
}

export function safeLpLogJson(event = {}) {
  return JSON.stringify(safeLpLogEvent(event));
}
