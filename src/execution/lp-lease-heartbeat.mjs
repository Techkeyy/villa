/** Renewable authority for one exact owner/account/operator/session lease. */

export const LP_LEASE_DURATION_MS = 30_000;
export const LP_LEASE_HEARTBEAT_INTERVAL_MS = 10_000;

export class LpLeaseHeartbeatError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = "LpLeaseHeartbeatError";
    this.code = code;
    this.cause = cause;
  }
}

export function createLeaseHeartbeat({
  leaseStore,
  session,
  lease,
  leaseDurationMs = LP_LEASE_DURATION_MS,
  intervalMs = LP_LEASE_HEARTBEAT_INTERVAL_MS,
  schedule = setInterval,
  cancel = clearInterval,
  onFailure = () => undefined,
} = {}) {
  if (!leaseStore || typeof leaseStore.heartbeat !== "function" || typeof leaseStore.assertHeld !== "function") {
    throw new LpLeaseHeartbeatError("LEASE_STORE_REQUIRED", "a renewable account lease store is required");
  }
  if (!session || !lease || session.leaseId !== lease.leaseId) {
    throw new LpLeaseHeartbeatError("LEASE_SCOPE_MISMATCH", "heartbeat requires the exact attached session lease");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs * 2 > leaseDurationMs) {
    throw new LpLeaseHeartbeatError("HEARTBEAT_INTERVAL_INVALID", "heartbeat interval must be no more than half the lease TTL");
  }

  const authority = {
    ...lease,
    held: true,
    failureCode: null,
    failureMessage: null,
  };
  let timer = null;
  let failure = null;
  let renewing = false;

  function lose(error) {
    if (failure) return failure;
    failure = new LpLeaseHeartbeatError(
      error?.code ?? "LEASE_HEARTBEAT_FAILED",
      error?.message ?? "the account lease heartbeat failed",
      error,
    );
    authority.held = false;
    authority.state = "LOST";
    authority.failureCode = failure.code;
    authority.failureMessage = failure.message;
    try { onFailure(failure); } catch { /* failure reporting cannot restore authority */ }
    return failure;
  }

  function assertHealthy() {
    if (failure || authority.held !== true) throw failure ?? new LpLeaseHeartbeatError("ACCOUNT_LEASE_REQUIRED", "the account lease is no longer held");
    try {
      const held = leaseStore.assertHeld(session);
      Object.assign(authority, held, { held: true });
      return authority;
    } catch (error) {
      throw lose(error);
    }
  }

  function renewNow() {
    if (failure || authority.held !== true) throw failure ?? new LpLeaseHeartbeatError("ACCOUNT_LEASE_REQUIRED", "the account lease is no longer held");
    try {
      const renewed = leaseStore.heartbeat(session);
      Object.assign(authority, renewed, { held: true, failureCode: null, failureMessage: null });
      return authority;
    } catch (error) {
      throw lose(error);
    }
  }

  function tick() {
    if (renewing || failure) return;
    renewing = true;
    try { renewNow(); } finally { renewing = false; }
  }

  function start() {
    if (timer || failure) return;
    timer = schedule(() => {
      try { tick(); } catch { /* onFailure made the loss visible and fail-closed */ }
    }, intervalMs);
    timer?.unref?.();
  }

  function stop() {
    if (timer) cancel(timer);
    timer = null;
  }

  return Object.freeze({
    authority,
    intervalMs,
    leaseDurationMs,
    start,
    stop,
    renewNow,
    assertHealthy,
    getState: () => Object.freeze({ healthy: !failure && authority.held === true, failure, heartbeatAt: authority.heartbeatAt, expiresAt: authority.expiresAt }),
  });
}
