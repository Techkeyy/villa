// Only availability failures are retried. Malformed prices, scope mismatches,
// unknown order state and genuine safety decisions are not classified here.
const PRICE_AVAILABILITY = new Set(["MISSING_SPOT", "STALE_SOURCE", "MISSING_VOL_HISTORY"]);
const TRANSPORT_AVAILABILITY = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "CHAIN_TIME_READ_FAILED"]);
export function transientReadWait(error) {
  if (PRICE_AVAILABILITY.has(error?.code)) return "WAITING_FOR_FRESH_PRICE";
  if (TRANSPORT_AVAILABILITY.has(error?.code) || ["HttpRequestError", "TimeoutError"].includes(error?.name)) return "WAITING_FOR_QUOTE";
  return null;
}
export async function readUntilAvailable({ read, stopped, onWait, delay }) {
  while (!stopped()) {
    try { return { stopped: false, value: await read() }; }
    catch (error) {
      const state = transientReadWait(error);
      if (!state) throw error;
      await onWait(state, error.code ?? error.name);
      if (!stopped()) await delay();
    }
  }
  return { stopped: true, value: null };
}
