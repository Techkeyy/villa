import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createUatAccountControl } from "./uat-control-runtime.mjs";

const OWNER = "0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d";
const ACCOUNT = "0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2";
const OPERATOR = "0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37";

function env(extra = {}) {
  return {
    VILLA_ENGINE_OWNER: OWNER,
    VILLA_ENGINE_ACCOUNT: ACCOUNT,
    VILLA_ENGINE_OPERATOR: OPERATOR,
    VILLA_UAT_EXECUTION_ENABLED: "true",
    VILLA_UAT_LAUNCH_MODE: "process",
    CREDENTIALS_DIRECTORY: "/private/credential-dir",
    OPERATOR_PRIVATE_KEY: "must-not-cross-the-bridge",
    ...extra,
  };
}

test("process UAT bridge is owner-scoped and strips signer environment", async () => {
  let child;
  const control = createUatAccountControl({
    env: env(),
    spawnImpl: (_command, _args, options) => {
      child = new EventEmitter();
      child.connected = true;
      child.send = (message) => { child.lastMessage = message; };
      child.kill = () => undefined;
      child.spawnOptions = options;
      return child;
    },
  });

  await assert.rejects(() => control.getState({ caller: "0x1111111111111111111111111111111111111111" }), { code: "OWNER_SCOPE_MISMATCH" });
  const startedPromise = control.start({ caller: OWNER });
  assert.equal(child.spawnOptions.env.OPERATOR_PRIVATE_KEY, undefined);
  assert.equal(child.spawnOptions.env.VILLA_ENGINE_ACCOUNT, ACCOUNT.toLowerCase());
  child.emit("message", { type: "ready", session: { sessionId: "uat-test", account: ACCOUNT, owner: OWNER, operator: OPERATOR } });
  const started = await startedPromise;
  assert.equal(started.state, "RUNNING");
  assert.equal(started.safety.signerInBrowser, false);
  assert.equal(started.safety.arbitraryRelay, false);
  assert.equal(started.safety.withdrawViaControl, false);
  await control.stop({ caller: OWNER });
  assert.deepEqual(child.lastMessage, { type: "stop", reason: "OWNER_STOP" });
});

test("systemd UAT bridge uses only the fixed wrapper and settles the same session", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "villa-uat-test-"));
  const commands = [];
  const commandPaths = [];
  let statePath = "";
  const commandRunner = (command, args, _options, callback) => {
    commands.push(args);
    commandPaths.push(command);
    const [action, sessionId] = args;
    statePath = path.join(directory, `${sessionId}.json`);
    const state = action === "start" ? { state: "RUNNING", session: { sessionId, account: ACCOUNT, owner: OWNER, operator: OPERATOR } } : action === "stop" ? { state: "STOPPED_SETTLEMENT_PENDING", session: { sessionId, account: ACCOUNT, owner: OWNER, operator: OPERATOR } } : { state: "SETTLED", session: { sessionId, account: ACCOUNT, owner: OWNER, operator: OPERATOR } };
    void fs.writeFile(statePath, JSON.stringify(state)).then(() => callback(null));
  };
  const control = createUatAccountControl({ env: env({ VILLA_UAT_LAUNCH_MODE: "systemd", VILLA_UAT_STATE_DIRECTORY: directory }), commandRunner, pollMs: 1, readyTimeoutMs: 500 });
  const started = await control.start({ caller: OWNER });
  assert.equal(started.state, "RUNNING");
  assert.equal(started.safety.privateService, true);
  assert.deepEqual(commandPaths, ["/usr/local/libexec/villa-uat-control"]);
  assert.match(commands[0][1], /^uat-\d+-[0-9a-f]{8}$/);
  assert.equal(commands[0][0], "start");
  assert.equal(commands[0].length, 2);
  await control.stop({ caller: OWNER });
  assert.equal((await control.getState({ caller: OWNER })).state, "STOPPED_SETTLEMENT_PENDING");
  assert.equal((await control.getState({ caller: OWNER })).controls.canSettle, true);
  const settled = await control.settle({ caller: OWNER });
  assert.equal(settled.state, "SETTLED");
  assert.equal(commands.length, 3);
  assert.deepEqual(commandPaths, ["/usr/local/libexec/villa-uat-control", "/usr/local/libexec/villa-uat-control", "/usr/local/libexec/villa-uat-control"]);
  assert.equal(commands[1][0], "stop");
  assert.equal(commands[2][0], "settle");
  assert.equal(commands[2][1], commands[0][1]);
  await fs.rm(directory, { recursive: true, force: true });
  assert.ok(statePath);
});
