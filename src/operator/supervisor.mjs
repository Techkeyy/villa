import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isExecutionEnabled, operatorConfigToRunnerArgs, safeOperatorConfig, validateOperatorConfig } from "./config.mjs";

export const OPERATOR_STATES = Object.freeze([
  "STOPPED",
  "STARTING",
  "WATCHING",
  "QUOTING",
  "NO_QUOTE",
  "REDUCE_ONLY",
  "HALTED",
  "PAUSED",
  "ROLLING_OVER",
  "SETTLING",
  "STOPPING",
  "ERROR",
]);

export class OperatorControlError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "OperatorControlError";
    this.code = code;
    this.status = status;
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runnerScript = resolve(root, "scripts/villa-bounded.mjs");

function publicRecord(record) {
  if (!record || typeof record !== "object") return null;
  if (record.snapshot) {
    return {
      snapshot: {
        marketId: record.snapshot.marketId ?? null,
        timeRemainingSec: record.snapshot.timeRemainingSec ?? null,
        pUp: record.snapshot.pUp ?? null,
        confidence: record.snapshot.confidence ?? null,
        governor: record.snapshot.governor ?? null,
        plan: record.snapshot.plan ?? null,
        restingOrders: Number(record.snapshot.restingOrders ?? 0),
        inventory: record.snapshot.inventory ?? null,
        capital: record.snapshot.capital ?? null,
        lifecycle: record.snapshot.lifecycle ?? null,
      },
    };
  }
  if (record.event) {
    const facts = record.facts ?? {};
    return {
      event: String(record.event),
      sequence: record.sequence ?? null,
      atChainSec: record.atChainSec ?? null,
      marketId: facts.marketId ?? null,
      state: facts.state ?? null,
      reason: facts.reason ?? facts.reasonCode ?? null,
      orderId: facts.orderId ?? null,
      classification: facts.classification ?? null,
    };
  }
  if (record.RESULT) return { result: String(record.RESULT), mode: record.mode ?? null, transactionsSent: record.transactionsSent ?? null };
  if (record.mode) return { mode: String(record.mode), orchestratorVersion: record.orchestratorVersion ?? null, series: record.series?.key ?? null };
  return null;
}

function activityFromRecord(record, at = Date.now()) {
  const safe = publicRecord(record);
  if (!safe) return null;
  const type = safe.event ?? safe.result ?? (safe.snapshot ? "SNAPSHOT" : "ENGINE_STARTED");
  return { id: randomUUID(), at, type, ...safe };
}

function stateFromSnapshot(snapshot, current) {
  if (!snapshot || ["PAUSED", "STOPPING", "ERROR"].includes(current)) return current;
  if (snapshot.governor === "HALT") return "HALTED";
  if (snapshot.governor === "REDUCE_ONLY") return "REDUCE_ONLY";
  if (snapshot.plan === "NO_QUOTE") return "NO_QUOTE";
  if (Number(snapshot.restingOrders) > 0) return "QUOTING";
  return "WATCHING";
}

function stateFromEvent(event, current) {
  switch (event) {
    case "SESSION_PAUSED": return "PAUSED";
    case "SESSION_RESUMED": return "WATCHING";
    case "SESSION_HALTED": return "HALTED";
    case "MARKET_STOPPING": return "STOPPING";
    case "MARKET_CLOSED":
    case "SUCCESSOR_WAIT": return "ROLLING_OVER";
    case "SETTLEMENT_POSITION_TRACKED":
    case "REDEEM_CONFIRMED": return "SETTLING";
    case "SESSION_STARTED":
    case "MARKET_DISCOVERY_STARTED":
    case "MARKET_INITIALIZED": return "WATCHING";
    default: return current;
  }
}

export function createDefaultRunner({ config, env, onRecord, onError, onExit }) {
  if (!isExecutionEnabled(env)) {
    throw new OperatorControlError("EXECUTION_DISABLED", "VILLA execution is disabled. No writer was started and no order can be sent.", 423);
  }
  const child = fork(runnerScript, operatorConfigToRunnerArgs(config), {
    cwd: root,
    env: { ...env },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdoutBuffer = "";
  const readStdout = (chunk) => {
    stdoutBuffer += String(chunk);
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { onRecord(JSON.parse(line)); } catch { /* runner diagnostics stay private */ }
    }
  };
  child.stdout?.on("data", readStdout);
  child.stderr?.on("data", () => onError?.());
  child.once("error", () => onError?.());
  child.once("exit", (code, signal) => onExit?.({ code, signal }));
  return {
    send(type, reason = null) {
      if (!child.connected) throw new OperatorControlError("ENGINE_DISCONNECTED", "The private engine is no longer connected.", 503);
      child.send({ type, reason });
    },
    kill() {
      child.kill("SIGTERM");
    },
    pid: child.pid,
  };
}

export function createEngineSupervisor({
  env = process.env,
  now = () => Date.now(),
  runnerFactory = createDefaultRunner,
  readOnlyReader = null,
} = {}) {
  let state = "STOPPED";
  let updatedAt = now();
  let sessionId = null;
  let config = safeOperatorConfig();
  let runner = null;
  let lastError = null;
  let snapshot = null;
  let activity = [];
  let requestedStop = null;
  let readOnlyCache = null;
  let readOnlyCacheAt = Number.NEGATIVE_INFINITY;
  let readOnlyCacheError = null;

  function setState(next) {
    if (!OPERATOR_STATES.includes(next)) throw new OperatorControlError("STATE_INVALID", `unsupported operator state ${next}`, 500);
    state = next;
    updatedAt = now();
  }

  function addActivity(record) {
    const item = activityFromRecord(record, now());
    if (!item) return;
    activity = [...activity, item].slice(-60);
    if (record.snapshot) {
      snapshot = item.snapshot;
      setState(stateFromSnapshot(snapshot, state));
    }
    if (record.event) setState(stateFromEvent(record.event, state));
    updatedAt = now();
  }

  function fail(message = "The private engine reported an error.") {
    lastError = { code: "ENGINE_ERROR", message };
    setState("ERROR");
  }

  function onRunnerExit({ code, signal }) {
    runner = null;
    if (code === 0) {
      lastError = null;
      setState("STOPPED");
      addActivity({ RESULT: "STOPPED", mode: requestedStop ? requestedStop.reason : "COMPLETED" });
    } else {
      fail(signal ? "The private engine stopped before cleanup completed." : "The private engine exited with an error. Check private service logs.");
    }
    requestedStop = null;
  }

  async function readOnly() {
    if (!readOnlyReader) return { snapshot: null, error: null };
    if (now() - readOnlyCacheAt < 5_000) return { snapshot: readOnlyCache, error: readOnlyCacheError };
    try {
      const envelope = await Promise.race([
        Promise.resolve().then(() => readOnlyReader()),
        new Promise((_, reject) => setTimeout(() => reject(new Error("read timed out")), 4_000)),
      ]);
      readOnlyCache = envelope;
      readOnlyCacheError = null;
    } catch {
      readOnlyCache = null;
      readOnlyCacheError = "Live read unavailable. Check the private engine's public read connections.";
    }
    readOnlyCacheAt = now();
    return { snapshot: readOnlyCache, error: readOnlyCacheError };
  }

  async function getState() {
    const live = await readOnly();
    return {
      state,
      sessionId,
      updatedAt,
      config,
      executionEnabled: isExecutionEnabled(env),
      snapshot,
      readOnly: live.snapshot,
      readOnlyError: live.error,
      lastError,
      activity: [...activity].reverse(),
      controls: {
        canStart: state === "STOPPED" || state === "ERROR",
        canPause: Boolean(runner) && !["PAUSED", "STOPPING", "ERROR"].includes(state),
        canResume: Boolean(runner) && state === "PAUSED",
        canStop: Boolean(runner) && state !== "STOPPING",
        canEmergencyCancel: Boolean(runner) && state !== "STOPPING",
      },
    };
  }

  async function assertStartAllowed() {
    const live = await readOnly();
    const risk = live.snapshot?.snapshot?.risk ?? {};
    if (risk.action !== "HALT") return;
    const reason = Array.isArray(risk.triggeredReasons) && risk.triggeredReasons.length
      ? ` Reason: ${risk.triggeredReasons[0]}.`
      : "";
    throw new OperatorControlError(
      "RISK_GOVERNOR_HALTED",
      `Risk Governor HALT prevents a new session.${reason} Resolve the live safety condition before starting.`,
      409,
    );
  }

  async function start(input = {}) {
    if (runner || !["STOPPED", "ERROR"].includes(state)) {
      throw new OperatorControlError("SESSION_ALREADY_ACTIVE", "VILLA already has an active session.");
    }
    const nextConfig = validateOperatorConfig(input);
    if (!isExecutionEnabled(env)) {
      addActivity({ event: "CONTROL_START_REFUSED", facts: { reason: "EXECUTION_DISABLED" } });
      throw new OperatorControlError("EXECUTION_DISABLED", "VILLA execution is disabled. No writer was started and no order can be sent.", 423);
    }
    await assertStartAllowed();
    config = nextConfig;
    sessionId = `operator-${randomUUID()}`;
    lastError = null;
    snapshot = null;
    activity = [];
    requestedStop = null;
    setState("STARTING");
    addActivity({ event: "CONTROL_START_REQUESTED", facts: { series: nextConfig.series } });
    try {
      runner = await runnerFactory({
        config: nextConfig,
        env,
        onRecord: addActivity,
        onError: () => fail("The private engine reported an error. Check private service logs."),
        onExit: onRunnerExit,
      });
    } catch (error) {
      runner = null;
      fail("The private engine could not be started. Check the private service configuration.");
      throw new OperatorControlError("ENGINE_START_FAILED", error?.message || "The private engine could not be started.", 503);
    }
    return getState();
  }

  function requireRunner() {
    if (!runner) throw new OperatorControlError("ENGINE_NOT_RUNNING", "VILLA is not running.");
    return runner;
  }

  async function pause() {
    const active = requireRunner();
    if (state === "PAUSED") return getState();
    if (state === "STOPPING") throw new OperatorControlError("ENGINE_STOPPING", "VILLA is already stopping.");
    active.send("pause", "OPERATOR_PAUSE");
    addActivity({ event: "CONTROL_PAUSE_REQUESTED", facts: { reason: "OPERATOR_PAUSE" } });
    return getState();
  }

  async function resume() {
    const active = requireRunner();
    if (state !== "PAUSED") throw new OperatorControlError("SESSION_NOT_PAUSED", "VILLA is not paused.");
    active.send("resume", "OPERATOR_RESUME");
    addActivity({ event: "CONTROL_RESUME_REQUESTED", facts: { reason: "OPERATOR_RESUME" } });
    return getState();
  }

  async function stop(reason = "OPERATOR_STOP") {
    const active = requireRunner();
    if (state === "STOPPING") return getState();
    requestedStop = { reason };
    setState("STOPPING");
    addActivity({ event: "CONTROL_STOP_REQUESTED", facts: { reason } });
    active.send("stop", reason);
    return getState();
  }

  async function emergencyCancelAll() {
    return stop("EMERGENCY_CANCEL_ALL");
  }

  function getConfig() {
    return { version: config.version, series: config.series, config, safeDefaults: safeOperatorConfig(), executionEnabled: isExecutionEnabled(env) };
  }

  return Object.freeze({
    start,
    pause,
    resume,
    stop,
    emergencyCancelAll,
    getState,
    getConfig,
    getActivity: () => [...activity].reverse(),
  });
}
