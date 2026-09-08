import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPublicClient, http } from "viem";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { VILLA_CHAIN } from "../dashboard/account-config.mjs";
import { createOnChainAccountVerifier } from "../src/operator/account-binding.mjs";
import { persistUatState } from "../src/operator/uat-state.mjs";
import { createViemLpAccountReader } from "../src/execution/lp-adapter.mjs";
import { classifyRecoveryRoute, LEGACY_AMBIGUOUS_CLASSIFICATION, SIGNER_FREE_PREMARKET_ROUTE, validateSignerFreePreMarketEvidence } from "../src/execution/lp-session-recovery.mjs";
import { createFileGlobalExecutionAdmission } from "../src/execution/lp-global-admission.mjs";

const execFileAsync = promisify(execFile);
const SOCKET_PATH = process.env.VILLA_UAT_BROKER_SOCKET || "/run/villa-uat-broker/control.sock";
const BINDING_DIR = "/run/villa-uat-bindings";
const STATUS_DIR = "/run/villa-uat-status";
const PRIVATE_STATE_ROOT = "/var/lib/villa-engine";
const GLOBAL_ADMISSION_FILE = String(process.env.VILLA_GLOBAL_EXECUTION_ADMISSION_FILE || `${PRIVATE_STATE_ROOT}/global-execution-admission.json`);
const SESSION_RE = /^uat-[0-9]+-[0-9a-f]{8}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ACTIONS = new Set(["start", "stop", "settle", "recover"]);
const CANONICAL_OPERATOR = "0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37";
const READONLY_RPC_URL = String(process.env.RPC_URL || VILLA_CHAIN.rpcUrl).trim();
const READONLY_CLIENT = createPublicClient({ chain: somniaShannon, transport: http(READONLY_RPC_URL, { timeout: 15_000 }) });
const READONLY_READER = createViemLpAccountReader({ publicClient: READONLY_CLIENT });
const verifyAccount = createOnChainAccountVerifier({ env: { ...process.env, VILLA_ENGINE_OPERATOR: CANONICAL_OPERATOR }, publicClient: READONLY_CLIENT, identityReader: READONLY_READER });
const globalAdmission = createFileGlobalExecutionAdmission({ filePath: GLOBAL_ADMISSION_FILE });

function validAddress(value) {
  return ADDRESS_RE.test(String(value ?? ""));
}

function response(socket, body) {
  socket.end(`${JSON.stringify(body)}\n`);
}

function fail(socket, code, error) {
  response(socket, { ok: false, code, error });
}

function bindingPath(sessionId) {
  return path.join(BINDING_DIR, `${sessionId}.env`);
}

function statusPath(sessionId) {
  return path.join(STATUS_DIR, `${sessionId}.json`);
}

function privateStatePath(sessionId) {
  return path.join(PRIVATE_STATE_ROOT, `uat-${sessionId}`, "session.json");
}

function provenancePath(sessionId) { return path.join(PRIVATE_STATE_ROOT, `uat-${sessionId}`, "provenance.json"); }

function journalPath(sessionId) {
  return path.join(PRIVATE_STATE_ROOT, `uat-${sessionId}`, "transactions.json");
}

function leasePath(sessionId, account) {
  return path.join(PRIVATE_STATE_ROOT, `uat-${sessionId}`, `${account.toLowerCase()}.lease.json`);
}

async function readJson(file, label) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    throw new Error(`the exact ${label} is unavailable or invalid`);
  }
}

async function readPreMarketJournal(sessionId, { required = false } = {}) {
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(journalPath(sessionId), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") { if (required) throw new Error("the new-session transaction journal is unavailable"); return { pending: 0, unknown: 0, reverted: 0, records: [] }; }
    throw new Error("the exact transaction journal is unavailable or invalid");
  }
  if (payload?.version !== "villa-private-account-writer-v1" || payload.initializedBeforeWrite !== true || !Array.isArray(payload.records) || payload.halted === true) {
    throw new Error("the exact transaction journal is not cleanly empty");
  }
  return {
    pending: payload.records.filter((record) => record?.state === "PENDING").length,
    unknown: payload.records.filter((record) => record?.state === "UNKNOWN").length,
    reverted: payload.records.filter((record) => record?.state === "REVERTED").length,
    records: payload.records,
  };
}

async function assertUnitInactive(unit) {
  let state;
  try {
    ({ stdout: state } = await execFileAsync("/usr/bin/systemctl", ["show", "-p", "ActiveState", "--value", unit], { windowsHide: true }));
  } catch {
    throw new Error("the exact session unit state is unavailable");
  }
  if (!["inactive", "failed"].includes(String(state).trim())) throw new Error("the exact session has an active or transitioning systemd unit");
}

async function assertNoLease(sessionId, account) {
  try {
    await fs.lstat(leasePath(sessionId, account));
    throw new Error("the exact pre-market session has a lease file");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

async function readPreMarketAccountState(account) {
  const identity = await READONLY_READER.readAccountIdentity({ account });
  const capital = await READONLY_READER.readCapital({ account, identity, marketId: null });
  return {
    account,
    identity,
    capital,
    inventory: null,
    positions: null,
    orders: { account, marketId: null, status: "NOT_SELECTED", orders: [] },
  };
}

async function reconcileSignerFreePreMarket(sessionId, owner, account, provenance = null) {
  const status = await readJson(statusPath(sessionId), "public status");
  const stored = await readJson(privateStatePath(sessionId), "private session state");
  if (!provenance) throw new Error("legacy ambiguous sessions cannot use signer-free reconciliation");
  const session = { sessionId, owner, account, operator: CANONICAL_OPERATOR, currentMarketId: status?.session?.currentMarketId };
  const route = classifyRecoveryRoute({ session, stored, provenance });
  if (route !== SIGNER_FREE_PREMARKET_ROUTE) throw new Error("the exact session is not eligible for signer-free reconciliation");
  await assertUnitInactive(`villa-engine-uat@${sessionId}.service`);
  await assertUnitInactive(`villa-engine-uat-recover@${sessionId}.service`);
  await assertNoLease(sessionId, account);
  const journal = await readPreMarketJournal(sessionId, { required: true });
  const accountState = await readPreMarketAccountState(account);
  const preflight = validateSignerFreePreMarketEvidence({ session, stored, status, provenance, expiredLease: null, journal, accountState, activeUnit: false });
  const finalSession = { ...status.session, sessionId, owner, account, operator: CANONICAL_OPERATOR, currentMarketId: null, leaseId: null, state: "STOPPED_CLEAN" };
  persistUatState(statusPath(sessionId), {
    type: "snapshot",
    snapshot: {
      ...status.snapshot,
      marketId: null,
      collateralRaw: accountState.capital.directCollateralRaw,
      vaultRaw: accountState.capital.vaultRaw ?? 0n,
      yesRaw: 0n,
      noRaw: 0n,
      openOrders: [],
      pendingSettlement: null,
      lastAction: "preflight_failure_reconciled",
    },
  });
  persistUatState(statusPath(sessionId), {
    type: "result",
    session: finalSession,
    result: {
      status: "STOPPED_CLEAN",
      reason: "PREFLIGHT_FAILURE_RECONCILED",
      classification: preflight.classification,
      writes: [],
      finalValueRaw: preflight.capitalRaw,
      pendingSettlement: false,
    },
  });
  persistUatState(statusPath(sessionId), { type: "state", state: "STOPPED_CLEAN", session: finalSession });
  await fs.rm(bindingPath(sessionId), { force: false });
}

async function assertExistingBinding(sessionId, owner, account) {
  let content;
  try {
    content = await fs.readFile(bindingPath(sessionId), "utf8");
  } catch {
    throw new Error("the session binding does not exist");
  }
  const values = Object.fromEntries(content.split(/\r?\n/).filter(Boolean).map((line) => line.split("=")));
  if (!validAddress(values.VILLA_ENGINE_OWNER) || !validAddress(values.VILLA_ENGINE_ACCOUNT)
    || values.VILLA_ENGINE_SESSION_ID !== sessionId
    || values.VILLA_ENGINE_OWNER.toLowerCase() !== owner.toLowerCase()
    || values.VILLA_ENGINE_ACCOUNT.toLowerCase() !== account.toLowerCase()) throw new Error("the session binding scope does not match");
}

async function writeBinding(sessionId, owner, account, admission = null) {
  await fs.mkdir(BINDING_DIR, { recursive: true, mode: 0o750 });
  const temporary = path.join(BINDING_DIR, `.${sessionId}.${process.pid}`);
  const content = `VILLA_ENGINE_OWNER=${owner}\nVILLA_ENGINE_ACCOUNT=${account}\nVILLA_ENGINE_SESSION_ID=${sessionId}\n${admission ? `VILLA_EXECUTION_ADMISSION_ID=${admission.admissionId}\nVILLA_GLOBAL_EXECUTION_ADMISSION_FILE=${GLOBAL_ADMISSION_FILE}\nVILLA_REQUIRE_GLOBAL_ADMISSION=true\n` : ""}`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await fs.link(temporary, bindingPath(sessionId));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function attachAdmissionToBinding(sessionId, owner, account, admission) {
  const file = bindingPath(sessionId);
  const content = await fs.readFile(file, "utf8");
  const expected = `VILLA_ENGINE_OWNER=${owner}\nVILLA_ENGINE_ACCOUNT=${account}\nVILLA_ENGINE_SESSION_ID=${sessionId}\n`;
  if (!content.startsWith(expected)) throw new Error("the session binding scope does not match");
  const temporary = path.join(BINDING_DIR, `.${sessionId}.admission.${process.pid}`);
  await fs.writeFile(temporary, `${expected}VILLA_EXECUTION_ADMISSION_ID=${admission.admissionId}\nVILLA_GLOBAL_EXECUTION_ADMISSION_FILE=${GLOBAL_ADMISSION_FILE}\nVILLA_REQUIRE_GLOBAL_ADMISSION=true\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, file);
}

async function runSystemd(action, sessionId) {
  const unit = action === "settle"
    ? `villa-engine-uat-settle@${sessionId}.service`
    : action === "recover"
      ? `villa-engine-uat-recover@${sessionId}.service`
      : `villa-engine-uat@${sessionId}.service`;
  if (action === "recover") {
    try {
      await execFileAsync("/usr/bin/systemctl", ["is-active", "--quiet", `villa-engine-uat@${sessionId}.service`], { windowsHide: true });
      throw new Error("the original session worker is still active");
    } catch (error) {
      if (error?.message === "the original session worker is still active") throw error;
      if (Number(error?.code) !== 3) throw error;
    }
    await execFileAsync("/usr/bin/systemctl", ["start", "--wait", unit], { windowsHide: true });
    return;
  }
  if (action === "stop") {
    await execFileAsync("/usr/bin/systemctl", ["stop", "--no-block", unit], { windowsHide: true });
    return;
  }
  const verb = action === "settle" ? "start" : action;
  await execFileAsync("/usr/bin/systemctl", [verb, unit], { windowsHide: true });
}

function admissionUnit(admission) {
  const sessionId = admission?.session?.sessionId;
  if (admission?.role === "settlement") return `villa-engine-uat-settle@${sessionId}.service`;
  if (admission?.role === "recovery") return `villa-engine-uat-recover@${sessionId}.service`;
  return `villa-engine-uat@${sessionId}.service`;
}

async function admissionLiveness(admission) {
  const unit = admissionUnit(admission);
  try {
    await execFileAsync("/usr/bin/systemctl", ["is-active", "--quiet", unit], { windowsHide: true });
    return true;
  } catch (error) {
    if (Number(error?.code) !== 3) return null;
  }
  try {
    const { stdout = "" } = await execFileAsync("/usr/bin/pgrep", ["-a", "-f", "/opt/villa-private-runtime/scripts/lp-account-"], { windowsHide: true });
    const lines = String(stdout).split(String.fromCharCode(10)).filter(Boolean);
    if (lines.some((line) => line.includes(admission.session.sessionId))) return true;
    if (lines.length > 0) return null;
  } catch (error) {
    if (Number(error?.code) !== 1) return null;
  }
  let status;
  try { status = await readJson(statusPath(admission.session.sessionId), "public status"); } catch { return null; }
  if (status?.session?.sessionId !== admission.session.sessionId
    || String(status.session.owner ?? "").toLowerCase() !== admission.session.owner
    || String(status.session.account ?? "").toLowerCase() !== admission.session.account) return null;
  if (["STOPPED", "STOPPED_CLEAN", "SETTLED", "WITHDRAWABLE", "ERROR"].includes(status?.state)) return false;
  if (["STARTING", "RUNNING", "STOPPING", "CHECKING_SETTLEMENT"].includes(status?.state)) return true;
  return null;
}

async function claimAdmission(session, role) {
  const exact = { sessionId: session.sessionId, owner: session.owner, account: session.account, operator: CANONICAL_OPERATOR };
  const existing = globalAdmission.get();
  if (existing) {
    const live = await admissionLiveness(existing);
    if (live === true) throw Object.assign(new Error("VILLA is currently running another strategy. Try again shortly."), { code: "GLOBAL_EXECUTION_BUSY" });
    if (live !== false) throw Object.assign(new Error("the shared execution admission cannot be safely reconciled yet"), { code: "GLOBAL_ADMISSION_LIVENESS_UNKNOWN" });
    globalAdmission.reconcileStale({ admissionId: existing.admissionId, session: existing.session, isActive: () => false });
  }
  return globalAdmission.claim({ session: exact, role });
}

function monitorGlobalAdmission(admission) {
  const timer = setInterval(async () => {
    try {
      const current = globalAdmission.get();
      if (!current || current.admissionId !== admission.admissionId) { clearInterval(timer); return; }
      const live = await admissionLiveness(current);
      if (live === false) {
        globalAdmission.reconcileStale({ admissionId: current.admissionId, session: current.session, isActive: () => false });
        clearInterval(timer);
      }
    } catch { /* retain the claim when liveness is not authoritative */ }
  }, 5_000);
  timer.unref?.();
  return timer;
}
async function readPreflightReconciledStatus(sessionId, owner, account) {
  try {
    const document = JSON.parse(await fs.readFile(statusPath(sessionId), "utf8"));
    const session = document?.session;
    return document?.state === "STOPPED_CLEAN"
      && document?.result?.reason === "PREFLIGHT_FAILURE_RECONCILED"
      && session?.sessionId === sessionId
      && validAddress(session?.owner)
      && validAddress(session?.account)
      && session.owner.toLowerCase() === owner.toLowerCase()
      && session.account.toLowerCase() === account.toLowerCase();
  } catch {
    return false;
  }
}

async function clearPreflightBinding(sessionId, owner, account) {
  if (!await readPreflightReconciledStatus(sessionId, owner, account)) {
    throw new Error("pre-market recovery did not produce the exact reconciled terminal state");
  }
  await fs.rm(bindingPath(sessionId), { force: false });
}

async function handle(socket, raw) {
  let request;
  try { request = JSON.parse(raw); } catch { fail(socket, "BROKER_REQUEST_INVALID", "the broker request is not valid JSON"); return; }
  const keys = Object.keys(request ?? {}).sort();
  if (keys.join(",") !== "account,action,owner,sessionId") { fail(socket, "BROKER_SCOPE_INVALID", "the broker accepts only a typed action and owner/account scope"); return; }
  const { action, sessionId, owner, account } = request;
  if (!ACTIONS.has(action) || !SESSION_RE.test(String(sessionId)) || !validAddress(owner) || !validAddress(account)) {
    fail(socket, "BROKER_SCOPE_INVALID", "the broker request is outside the fixed account-session scope");
    return;
  }
  try {
    let admission = null;
    let handedOff = false;
    if (action === "start" || action === "settle" || action === "recover") await verifyAccount({ caller: owner, account, requireOperator: true });
    let alreadyReconciled = false;
    if (action === "start") {
      admission = await claimAdmission({ sessionId, owner, account }, "strategy");
      await writeBinding(sessionId, owner.toLowerCase(), account.toLowerCase(), admission);
    }
    else {
      try {
        await assertExistingBinding(sessionId, owner, account);
      } catch (error) {
        if (action !== "recover" || !await readPreflightReconciledStatus(sessionId, owner, account)) throw error;
        alreadyReconciled = true;
      }
    }
    if (!alreadyReconciled) {
      if (action === "recover") {
        const status = await readJson(statusPath(sessionId), "public status");
        const stored = await readJson(privateStatePath(sessionId), "private session state");
        let provenance = null;
        try { provenance = JSON.parse(await fs.readFile(provenancePath(sessionId), "utf8")); } catch { /* missing provenance is explicitly legacy ambiguous */ }
        const route = classifyRecoveryRoute({ session: { ...status.session, sessionId, owner, account, operator: CANONICAL_OPERATOR }, stored, provenance });
        if (route === SIGNER_FREE_PREMARKET_ROUTE) await reconcileSignerFreePreMarket(sessionId, owner, account, provenance);
        else if (route === LEGACY_AMBIGUOUS_CLASSIFICATION) throw new Error("legacy ambiguous sessions cannot be recovered automatically");
        else {
          admission = await claimAdmission({ sessionId, owner, account }, "recovery");
          await attachAdmissionToBinding(sessionId, owner, account, admission);
          handedOff = true;
          await runSystemd(action, sessionId);
          await clearPreflightBinding(sessionId, owner, account);
        }
      } else {
        if (action === "settle") {
          admission = await claimAdmission({ sessionId, owner, account }, "settlement");
          await attachAdmissionToBinding(sessionId, owner, account, admission);
        }
        handedOff = true;
        await runSystemd(action, sessionId);
      }
    }
    if (admission) monitorGlobalAdmission(admission);
    response(socket, { ok: true });
  } catch (error) {
    if (admission && !handedOff) { try { globalAdmission.release({ admissionId: admission.admissionId, session: { sessionId, owner, account, operator: CANONICAL_OPERATOR } }); } catch { /* preserve a claim if its state is uncertain */ } }
    console.error(`[villa-uat-broker] action=${action} sessionId=${sessionId} code=${error?.code || "ERROR"} message=${error?.message || String(error)}`);
    if (["GLOBAL_EXECUTION_BUSY", "GLOBAL_ADMISSION_LIVENESS_UNKNOWN", "GLOBAL_ADMISSION_STALE"].includes(error?.code)) { fail(socket, error.code, error.message); return; }
    fail(socket, "BROKER_OPERATION_FAILED", "the root account broker refused the operation");
  }
}

async function main() {
  await fs.mkdir(path.dirname(SOCKET_PATH), { recursive: true, mode: 0o750 });
  try { await fs.unlink(SOCKET_PATH); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const server = net.createServer((socket) => {
    let body = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024) { socket.destroy(); return; }
      const newline = body.indexOf("\n");
      if (newline >= 0) {
        const first = body.slice(0, newline);
        body = "";
        void handle(socket, first);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(SOCKET_PATH, resolve); });
  await fs.chmod(SOCKET_PATH, 0o660);
  process.once("SIGTERM", () => server.close(() => process.exit(0)));
  process.once("SIGINT", () => server.close(() => process.exit(0)));
}

await main();
