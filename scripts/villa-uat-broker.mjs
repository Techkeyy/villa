import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createOnChainAccountVerifier } from "../src/operator/account-binding.mjs";

const execFileAsync = promisify(execFile);
const SOCKET_PATH = process.env.VILLA_UAT_BROKER_SOCKET || "/run/villa-uat-broker/control.sock";
const BINDING_DIR = "/run/villa-uat-bindings";
const SESSION_RE = /^uat-[0-9]+-[0-9a-f]{8}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ACTIONS = new Set(["start", "stop", "settle", "recover"]);
const verifyAccount = createOnChainAccountVerifier({ env: { ...process.env, VILLA_ENGINE_OPERATOR: "0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37" } });

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

async function writeBinding(sessionId, owner, account) {
  await fs.mkdir(BINDING_DIR, { recursive: true, mode: 0o750 });
  const temporary = path.join(BINDING_DIR, `.${sessionId}.${process.pid}`);
  const content = `VILLA_ENGINE_OWNER=${owner}\nVILLA_ENGINE_ACCOUNT=${account}\nVILLA_ENGINE_SESSION_ID=${sessionId}\n`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await fs.link(temporary, bindingPath(sessionId));
  } finally {
    await fs.rm(temporary, { force: true });
  }
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
    await execFileAsync("/usr/bin/systemctl", ["start", "--no-block", unit], { windowsHide: true });
    return;
  }
  if (action === "stop") {
    await execFileAsync("/usr/bin/systemctl", ["stop", "--no-block", unit], { windowsHide: true });
    return;
  }
  const verb = action === "settle" ? "start" : action;
  await execFileAsync("/usr/bin/systemctl", [verb, unit], { windowsHide: true });
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
    if (action === "start" || action === "settle" || action === "recover") await verifyAccount({ caller: owner, account, requireOperator: true });
    if (action === "start") await writeBinding(sessionId, owner.toLowerCase(), account.toLowerCase());
    else await assertExistingBinding(sessionId, owner, account);
    await runSystemd(action, sessionId);
    response(socket, { ok: true });
  } catch (error) {
    console.error(`[villa-uat-broker] action=${action} sessionId=${sessionId} code=${error?.code || "ERROR"} message=${error?.message || String(error)}`);
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
