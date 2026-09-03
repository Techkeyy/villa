import fs from "node:fs";
import path from "node:path";

const PRIVATE_FIELD_RE = /private.?key|signer|mnemonic|seed|credential|secret|password/i;

function publicValue(value, depth = 0) {
  if (depth > 8) return null;
  if (typeof value === "bigint" || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => publicValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_FIELD_RE.test(key)).map(([key, item]) => [key, publicValue(item, depth + 1)]));
}

function jsonSafe(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function safeMessage(message) {
  if (!message || typeof message !== "object") return {};
  const allowed = {};
  if (message.snapshot && typeof message.snapshot === "object") allowed.snapshot = publicValue(message.snapshot);
  if (message.type === "state" || message.type === "ready") {
    allowed.state = message.type === "ready" ? "RUNNING" : String(message.state ?? "STARTING").toUpperCase();
    if (message.session && typeof message.session === "object") allowed.session = publicValue(message.session);
  }
  if (message.type === "snapshot" && message.snapshot && typeof message.snapshot === "object") allowed.snapshot = publicValue(message.snapshot);
  if (message.type === "result") {
    allowed.result = publicValue(message.result ?? null);
    if (message.session && typeof message.session === "object") allowed.session = publicValue(message.session);
    if (!allowed.state) allowed.state = "STOPPED";
  }
  if (message.type === "error") {
    allowed.state = "ERROR";
    allowed.error = { code: String(message.code ?? "UAT_SESSION_FAILED"), message: String(message.message ?? "The private UAT session failed.") };
  }
  return allowed;
}

function writeState(file, message, fileMode) {
  const target = String(file ?? "");
  if (!target) return;
  try {
    let document = {};
    try { document = JSON.parse(fs.readFileSync(target, "utf8")); } catch { /* first update */ }
    document = publicValue({ version: "villa-uat-state-v1", ...document, ...safeMessage(message), updatedAt: Date.now() });
    const temporary = `${target}.tmp-${process.pid}`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, jsonSafe(document), { mode: fileMode });
    fs.chmodSync(temporary, fileMode);
    fs.renameSync(temporary, target);
  } catch {
    // State reporting is best effort and must never change the write path.
  }
}

/** Persist a sanitized status snapshot for the public API; never persist an environment or signer. */
export function persistUatState(file, message) {
  writeState(file, message, 0o640);
}

/** Persist the same sanitized lifecycle facts in the private engine state tree. */
export function persistPrivateUatState(file, message) {
  writeState(file, message, 0o600);
}
