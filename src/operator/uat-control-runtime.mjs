/**
 * One-account private UAT control bridge.
 *
 * The production launcher starts a root-owned systemd template as the
 * private `villa-engine` user. The public API never receives the signer or
 * the systemd credential directory. A process launcher remains injectable for
 * unit tests only.
 */

import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AccountControlError } from "./account-control.mjs";
import { createOperatorAuth } from "./auth.mjs";

const DEFAULT_WORKER = fileURLToPath(new URL("../../scripts/lp-account-session.mjs", import.meta.url));
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SESSION_RE = /^uat-\d+-[0-9a-f]{8}$/;
const SERVICE_WRAPPER = "/usr/local/libexec/villa-uat-control";
const RECOVERABLE_STATES = new Set(["STARTING", "RUNNING", "PAUSED", "STOPPING", "ERROR", "STOPPED_SETTLEMENT_PENDING", "SETTLEMENT_READY", "SETTLING"]);
const REATTACHABLE_STATES = new Set(["STARTING", "RUNNING", "PAUSED", "STOPPING", "STOPPED_SETTLEMENT_PENDING", "SETTLEMENT_READY", "SETTLING"]);

function normalizeAddress(value, label) {
  const text = String(value ?? "");
  if (!ADDRESS_RE.test(text)) throw new AccountControlError("UAT_CONFIG_INVALID", `${label} is not a valid address`, 500);
  return text.toLowerCase();
}

function sameAddress(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function publicSession(session) {
  if (!session) return null;
  return {
    sessionId: session.sessionId ?? null,
    account: session.account ?? null,
    owner: session.owner ?? null,
    operator: session.operator ?? null,
    marketSeries: session.marketSeries ?? null,
    currentMarketId: session.currentMarketId ?? null,
    state: session.state ?? null,
    startedAt: session.startedAt ?? null,
    stoppedAt: session.stoppedAt ?? null,
  };
}

function safeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  return {
    marketId: snapshot.marketId ?? null,
    intervalSec: snapshot.intervalSec ?? null,
    timeRemainingSec: snapshot.timeRemainingSec ?? null,
    risk: snapshot.risk ?? null,
    quote: snapshot.quote ?? null,
    collateralRaw: snapshot.collateralRaw ?? null,
    fills: Array.isArray(snapshot.fills) ? snapshot.fills : null,
    deployedRaw: snapshot.deployedRaw ?? null,
    openOrders: Array.isArray(snapshot.openOrders) ? snapshot.openOrders : [],
    yesRaw: snapshot.yesRaw ?? null,
    noRaw: snapshot.noRaw ?? null,
    pendingSettlement: snapshot.pendingSettlement ?? null,
    lastAction: snapshot.lastAction ?? null,
    pnl: snapshot.pnl ?? null,
  };
}

function stripSignerEnvironment(env) {
  const childEnv = { ...env };
  for (const name of ["OPERATOR_PRIVATE_KEY", "TAKER_PRIVATE_KEY", "PRIVATE_KEY", "WALLET_SEED", "MNEMONIC"]) delete childEnv[name];
  return childEnv;
}

function commandPromise(commandRunner, command, args) {
  return new Promise((resolve, reject) => {
    commandRunner(command, args, { windowsHide: true }, (error) => {
      if (error) reject(new AccountControlError("UAT_SERVICE_COMMAND_FAILED", "The private UAT service command failed.", 503));
      else resolve();
    });
  });
}

function brokerPromise(socketPath, action, sessionId, owner, account) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let body = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new AccountControlError("UAT_BROKER_TIMEOUT", "The private account broker did not respond in time.", 503)), 15_000);
    socket.on("connect", () => {
      const request = { action, sessionId, owner, account };
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      body += String(chunk);
      if (body.length > 16 * 1024) {
        clearTimeout(timer);
        finish(new AccountControlError("UAT_BROKER_INVALID", "The private account broker returned an invalid response.", 503));
        return;
      }
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        const response = JSON.parse(body.slice(0, newline));
        if (response?.ok !== true) throw new AccountControlError(String(response?.code ?? "UAT_BROKER_FAILED"), String(response?.error ?? "The private account broker refused the operation."), 503);
        finish(null);
      } catch (error) {
        finish(error instanceof AccountControlError ? error : new AccountControlError("UAT_BROKER_INVALID", "The private account broker returned an invalid response.", 503));
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      finish(new AccountControlError("UAT_BROKER_UNAVAILABLE", "The private account broker could not be reached.", 503, { cause: error?.code ?? "SOCKET_ERROR" }));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create the private-worker bridge. `spawnImpl` and `commandRunner` are
 * injectable so the boundary can be tested without a signer, VPS, or chain
 * write. Production uses `VILLA_UAT_LAUNCH_MODE=systemd`.
 */
export function createUatAccountControl({
  env = process.env,
  workerPath = DEFAULT_WORKER,
  spawnImpl = spawn,
  commandRunner = execFile,
  readyTimeoutMs = 30_000,
  pollMs = 250,
} = {}) {
  const owner = normalizeAddress(env.VILLA_ENGINE_OWNER, "VILLA_ENGINE_OWNER");
  const account = normalizeAddress(env.VILLA_ENGINE_ACCOUNT, "VILLA_ENGINE_ACCOUNT");
  const operator = normalizeAddress(env.VILLA_ENGINE_OPERATOR ?? env.OPERATOR_ADDRESS, "VILLA_ENGINE_OPERATOR");
  const enabled = env.VILLA_ACCOUNT_EXECUTION_ENABLED !== undefined
    ? env.VILLA_ACCOUNT_EXECUTION_ENABLED === "true"
    : env.VILLA_UAT_EXECUTION_ENABLED === "true";
  const launchMode = String(env.VILLA_UAT_LAUNCH_MODE ?? "systemd").toLowerCase();
  if (!enabled) throw new AccountControlError("UAT_CONFIG_INVALID", "UAT execution is not enabled", 500);
  if (!["systemd", "process"].includes(launchMode)) throw new AccountControlError("UAT_CONFIG_INVALID", "UAT launch mode is invalid", 500);

  const credentialsDirectory = String(env.VILLA_ENGINE_CREDENTIALS_DIRECTORY ?? env.CREDENTIALS_DIRECTORY ?? "");
  const stateDirectory = String(env.VILLA_UAT_STATUS_DIRECTORY ?? env.VILLA_UAT_STATE_DIRECTORY ?? "/run/villa-uat-status");
  const brokerSocket = String(env.VILLA_UAT_BROKER_SOCKET ?? (process.platform === "linux" && launchMode === "systemd" ? "/run/villa-uat-broker/control.sock" : ""));
  if (launchMode === "process" && !credentialsDirectory) throw new AccountControlError("UAT_CONFIG_INVALID", "a private engine credential directory is required for process launch", 500);
  if (launchMode === "systemd" && !stateDirectory) throw new AccountControlError("UAT_CONFIG_INVALID", "a private UAT state directory is required for systemd launch", 500);

  let child = null;
  let activeSessionId = null;
  let state = "STOPPED";
  let session = null;
  let snapshot = null;
  let result = null;
  let lastError = null;
  let readyPromise = null;

  function assertCaller(caller) {
    if (!sameAddress(caller, owner)) throw new AccountControlError("OWNER_SCOPE_MISMATCH", "the authenticated wallet is not the approved UAT owner", 403);
  }

  function stateFile(sessionId) {
    return path.join(stateDirectory, `${sessionId}.json`);
  }

  function serviceCommand(action, sessionId) {
    if (!["start", "stop", "settle"].includes(action) || !SESSION_RE.test(String(sessionId))) {
      throw new AccountControlError("UAT_SERVICE_SCOPE_INVALID", "the private UAT service operation is outside the fixed scope", 403);
    }
    const args = [action, sessionId];
    if (brokerSocket) return brokerPromise(brokerSocket, action, sessionId, owner, account);
    return commandPromise(commandRunner, SERVICE_WRAPPER, args);

  }

  function publicState() {
    return Object.freeze({
      version: "villa-account-control-uat-v3",
      state,
      session: publicSession(session),
      snapshot: safeSnapshot(snapshot),
      result,
      error: lastError,
      readiness: Object.freeze({ allowed: enabled && state === "STOPPED", reasons: enabled ? (state === "ERROR" ? ["UAT_SESSION_ERROR"] : []) : ["UAT_EXECUTION_DISABLED"] }),
      safety: Object.freeze({
        publicEnabled: enabled,
        executionEnabled: enabled && Boolean(child || activeSessionId) && ["STARTING", "RUNNING", "PAUSED", "STOPPING", "SETTLEMENT_READY", "SETTLING"].includes(state),
        signerInBrowser: false,
        arbitraryRelay: false,
        withdrawViaControl: false,
        accountScope: "verified-owner-account",
        privateService: launchMode === "systemd",
      }),
      controls: Object.freeze({
        canStart: enabled && state === "STOPPED",
        canPause: launchMode === "process" && Boolean(child) && state === "RUNNING",
        canResume: launchMode === "process" && Boolean(child) && state === "PAUSED",
        canStop: Boolean(child || activeSessionId) && ["STARTING", "RUNNING", "PAUSED", "ERROR", "STOPPING"].includes(state),
        canSettle: enabled && launchMode === "systemd" && Boolean(activeSessionId) && ["STOPPED_SETTLEMENT_PENDING", "SETTLEMENT_READY"].includes(state),
      }),
    });
  }

  function applyExternal(external) {
    if (!external || typeof external !== "object") return false;
    if (external.session) session = { ...session, ...external.session };
    if (Object.hasOwn(external, "snapshot")) snapshot = safeSnapshot(external.snapshot);
    if (Object.hasOwn(external, "result")) result = external.result;
    if (external.error) lastError = { code: String(external.error.code ?? "UAT_SESSION_FAILED"), message: String(external.error.message ?? "The private UAT session failed.") };
    if (external.state) state = String(external.state).toUpperCase();
    if (["STOPPED", "STOPPED_CLEAN", "SETTLED", "WITHDRAWABLE"].includes(state)) activeSessionId = null;
    return true;
  }

  async function syncExternal() {
    if (launchMode !== "systemd" || !activeSessionId) return;
    try {
      const content = await fs.readFile(stateFile(activeSessionId), "utf8");
      const external = JSON.parse(content);
      if (external?.session?.sessionId !== activeSessionId
        || !sameAddress(external?.session?.owner, owner)
        || !sameAddress(external?.session?.account, account)) {
        state = "ERROR";
        lastError = { code: "UAT_STATUS_SCOPE_MISMATCH", message: "The private UAT status does not match the authenticated owner/account session." };
        return;
      }
      applyExternal(external);
    } catch {
      // A missing file during service startup is not a successful session.
    }
  }

  async function recoverExternal() {
    if (launchMode !== "systemd" || activeSessionId) return;
    let names;
    try {
      names = await fs.readdir(stateDirectory);
    } catch {
      return;
    }
    const candidates = [];
    for (const name of names) {
      const sessionId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!SESSION_RE.test(sessionId)) continue;
      try {
        const external = JSON.parse(await fs.readFile(path.join(stateDirectory, name), "utf8"));
        const recoveredSession = external?.session;
        const recoveredState = String(external?.state ?? "").toUpperCase();
        if (!RECOVERABLE_STATES.has(recoveredState)
          || !recoveredSession
          || recoveredSession.sessionId !== sessionId
          || !sameAddress(recoveredSession.owner, owner)
          || !sameAddress(recoveredSession.account, account)) continue;
        candidates.push({ external, updatedAt: Number(external.updatedAt) || 0 });
      } catch {
        // Ignore malformed or foreign status files. Recovery is fail-closed.
      }
    }
    candidates.sort((left, right) => right.updatedAt - left.updatedAt);
    if (!candidates[0]) return;
    activeSessionId = candidates[0].external.session.sessionId;
    applyExternal(candidates[0].external);
  }

  function handleMessage(message, resolveReady, rejectReady) {
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") {
      session = { ...(message.session ?? {}), state: "RUNNING", startedAt: Date.now() };
      state = "RUNNING";
      lastError = null;
      resolveReady(publicState());
      return;
    }
    if (message.type === "state") {
      state = String(message.state ?? state).toUpperCase();
      if (message.session) session = { ...session, ...message.session, state };
      return;
    }
    if (message.type === "snapshot") {
      snapshot = safeSnapshot(message.snapshot);
      return;
    }
    if (message.type === "result") {
      result = message.result ?? null;
      if (message.session) session = { ...session, ...message.session };
      return;
    }
    if (message.type === "error") {
      const error = new AccountControlError(String(message.code ?? "UAT_SESSION_FAILED"), String(message.message ?? "The private UAT session failed."), 409);
      lastError = { code: error.code, message: error.message };
      state = "ERROR";
      rejectReady(error);
    }
  }

  function handleExit(code, signal) {
    const hadChild = Boolean(child);
    child = null;
    readyPromise = null;
    if (!hadChild) return;
    if (code === 0) {
      if (["STARTING", "RUNNING", "PAUSED", "STOPPING"].includes(state)) {
        state = "STOPPED";
        if (session) session = { ...session, state: "STOPPED", stoppedAt: Date.now() };
      }
    } else if (state !== "ERROR") {
      state = "ERROR";
      lastError = { code: "UAT_WORKER_EXITED", message: signal ? "The private UAT session stopped before cleanup completed." : "The private UAT session exited unexpectedly." };
    }
  }

  async function waitForSystemdReady(sessionId) {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      await syncExternal();
      if (state === "RUNNING") return publicState();
      if (state === "ERROR") throw new AccountControlError(lastError?.code ?? "UAT_SESSION_FAILED", lastError?.message ?? "The private UAT session failed.", 409);
      await delay(pollMs);
    }
    throw new AccountControlError("UAT_START_TIMEOUT", "the private UAT session did not complete its preflight in time", 503);
  }

  async function waitForSettlement(sessionId) {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      await syncExternal();
      if (["SETTLED", "STOPPED_SETTLEMENT_PENDING"].includes(state)) return publicState();
      if (state === "ERROR") throw new AccountControlError(lastError?.code ?? "SETTLEMENT_FAILED", lastError?.message ?? "The private settlement worker failed.", 409);
      await delay(pollMs);
    }
    throw new AccountControlError("SETTLEMENT_TIMEOUT", "the private settlement worker did not finish in time", 503);
  }

  async function start({ caller = null } = {}) {
    assertCaller(caller);
    if (!enabled) throw new AccountControlError("ACCOUNT_EXECUTION_DISABLED", "account execution is not enabled for this deployment", 423);
    if (launchMode === "systemd") {
      await recoverExternal();
      await syncExternal();
    }
    if ((child || activeSessionId) && REATTACHABLE_STATES.has(state)) return publicState();
    if (state === "ERROR") {
      throw new AccountControlError("UAT_SESSION_RECONCILIATION_REQUIRED", "The existing UAT session is errored and requires owner/account-scoped reconciliation before Start can retry.", 409);
    }
    if (child || activeSessionId || state !== "STOPPED") throw new AccountControlError("SESSION_ALREADY_ACTIVE", "VILLA already has an active UAT session");
    const sessionId = `uat-${Date.now()}-${randomUUID().slice(0, 8)}`;
    activeSessionId = sessionId;
    session = { sessionId, account, owner, operator, state: "STARTING" };
    state = "STARTING";
    snapshot = null;
    result = null;
    lastError = null;

    if (launchMode === "systemd") {
      try {
        await serviceCommand("start", sessionId);
        return await waitForSystemdReady(sessionId);
      } catch (error) {
        activeSessionId = null;
        state = "STOPPED";
        session = null;
        throw error;
      }
    }

    const childEnv = {
      ...stripSignerEnvironment(env),
      VILLA_ENGINE_OWNER: owner,
      VILLA_ENGINE_ACCOUNT: account,
      VILLA_ENGINE_OPERATOR: operator,
      VILLA_ENGINE_SESSION_ID: sessionId,
      VILLA_UAT_SESSION_EXECUTION: "true",
      VILLA_EXECUTION_ENABLED: "false",
      VILLA_ACCOUNT_EXECUTION_ENABLED: "true",
      VILLA_EXECUTION_MODE: "WET",
      CREDENTIALS_DIRECTORY: credentialsDirectory,
    };
    child = spawnImpl(process.execPath, [workerPath], { env: childEnv, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let resolveReady;
    let rejectReady;
    readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const timeout = setTimeout(() => rejectReady(new AccountControlError("UAT_START_TIMEOUT", "the private UAT session did not complete its preflight in time", 503)), readyTimeoutMs);
    child.on("message", (message) => handleMessage(message, resolveReady, rejectReady));
    child.once("exit", handleExit);
    child.once("error", (error) => {
      lastError = { code: "UAT_WORKER_ERROR", message: "The private UAT session could not start." };
      state = "ERROR";
      rejectReady(new AccountControlError("UAT_WORKER_ERROR", error?.message || "The private UAT session could not start.", 503));
    });
    try {
      return await readyPromise;
    } catch (error) {
      clearTimeout(timeout);
      if (child) child.kill("SIGTERM");
      child = null;
      activeSessionId = null;
      state = "ERROR";
      throw error;
    } finally {
      clearTimeout(timeout);
      readyPromise = null;
    }
  }

  async function stop({ caller = null } = {}) {
    assertCaller(caller);
    if (launchMode === "systemd") {
      await recoverExternal();
      await syncExternal();
      if (!activeSessionId) return publicState();
      state = "STOPPING";
      await serviceCommand("stop", activeSessionId);
      await syncExternal();
      return publicState();
    }
    if (!child) return publicState();
    state = "STOPPING";
    child.send({ type: "stop", reason: "OWNER_STOP" });
    return publicState();
  }

  async function settle({ caller = null } = {}) {
    assertCaller(caller);
    if (launchMode !== "systemd") throw new AccountControlError("SETTLEMENT_PRIVATE_SERVICE_REQUIRED", "settlement requires the private systemd service boundary", 503);
    await recoverExternal();
    await syncExternal();
    if (!activeSessionId) throw new AccountControlError("SETTLEMENT_SESSION_REQUIRED", "there is no stopped UAT session to settle", 409);
    if (!["STOPPED_SETTLEMENT_PENDING", "SETTLEMENT_READY"].includes(state)) throw new AccountControlError("SETTLEMENT_NOT_READY", "the account session is not ready for settlement", 409);
    state = "SETTLING";
    try {
      await serviceCommand("settle", activeSessionId);
    } catch (error) {
      state = "ERROR";
      lastError = { code: error?.code ?? "UAT_SETTLEMENT_SERVICE_FAILED", message: error?.message ?? "The private settlement service could not start." };
      throw error;
    }
    return waitForSettlement(activeSessionId);
  }

  async function pause({ caller = null } = {}) {
    assertCaller(caller);
    if (launchMode !== "process" || !child || state !== "RUNNING") throw new AccountControlError("SESSION_NOT_RUNNING", "VILLA is not running", 409);
    state = "PAUSED";
    child.send({ type: "pause", reason: "OWNER_PAUSE" });
    return publicState();
  }

  async function resume({ caller = null } = {}) {
    assertCaller(caller);
    if (launchMode !== "process" || !child || state !== "PAUSED") throw new AccountControlError("SESSION_NOT_PAUSED", "VILLA is not paused", 409);
    state = "RUNNING";
    child.send({ type: "resume", reason: "OWNER_RESUME" });
    return publicState();
  }

  return Object.freeze({
    auth: createOperatorAuth({ authorizedAddress: owner }),
    getState: async ({ caller = null } = {}) => { assertCaller(caller); await recoverExternal(); await syncExternal(); return publicState(); },
    start,
    stop,
    settle,
    pause,
    resume,
  });
}
