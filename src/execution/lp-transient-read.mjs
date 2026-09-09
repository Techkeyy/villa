// Only availability failures are retried. Malformed prices, scope mismatches,
// unknown order state and genuine safety decisions are not classified here.
const PRICE_AVAILABILITY = new Set(["MISSING_SPOT", "STALE_SOURCE", "MISSING_VOL_HISTORY"]);
const TRANSPORT_AVAILABILITY = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EAI_AGAIN", "ENOTFOUND", "FETCH_FAILED", "NETWORK_ERROR", "RPC_TRANSPORT", "HTTP_REQUEST_FAILED", "CHAIN_TIME_READ_FAILED"]);
const TRANSPORT_NAMES = new Set(["HttpRequestError", "TimeoutError", "FetchError", "NetworkError"]);
const TRANSPORT_TEXT = /fetch failed|network request|socket hang up|connection reset|connection refused|timed? out|request failed|econnreset|econnrefused|enetunreach|eai_again|enotfound/i;
export const DEFAULT_RPC_WAIT_MAX_MS = 120_000;

export function isTransientRpcTransportError(error) {
  const code = String(error?.code ?? "").toUpperCase();
  const name = String(error?.name ?? "");
  const detail = String(error?.message ?? "") + " " + String(error?.details ?? "");
  return TRANSPORT_AVAILABILITY.has(code) || TRANSPORT_NAMES.has(name) || TRANSPORT_TEXT.test(detail);
}

export function transientReadWait(error, { transportState = "WAITING_FOR_QUOTE" } = {}) {
  if (PRICE_AVAILABILITY.has(error?.code)) return "WAITING_FOR_FRESH_PRICE";
  if (isTransientRpcTransportError(error)) return transportState;
  return null;
}

export async function readUntilAvailable({ read, stopped, onWait, delay, transportState = "WAITING_FOR_QUOTE", maxWaitMs = null, now = () => Date.now() }) {
  const startedAt = now();
  let attempts = 0;
  while (!stopped()) {
    try { return { stopped: false, value: await read() }; }
    catch (error) {
      const state = transientReadWait(error, { transportState });
      if (!state) throw error;
      attempts += 1;
      const elapsedMs = Math.max(0, now() - startedAt);
      await onWait(state, error.code ?? error.name, { attempt: attempts, elapsedMs, error });
      if (stopped()) break;
      if (Number.isFinite(maxWaitMs) && elapsedMs >= maxWaitMs) {
        const timeout = new Error("RPC availability safety timeout");
        timeout.code = "RPC_SAFETY_TIMEOUT";
        timeout.attempts = attempts;
        timeout.elapsedMs = elapsedMs;
        timeout.cause = error;
        throw timeout;
      }
      await delay();
    }
  }
  return { stopped: true, value: null };
}
