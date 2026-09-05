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

test("systemd bridge recovers only the matching owner/account session after restart", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "villa-uat-recovery-"));
  const sessionId = "uat-1234567890-abcdef12";
  const statusPath = path.join(directory, sessionId + ".json");
  await fs.writeFile(statusPath, JSON.stringify({
    version: "villa-uat-state-v1",
    updatedAt: Date.now(),
    state: "RUNNING",
    session: { sessionId, account: ACCOUNT, owner: OWNER, operator: OPERATOR },
  }));
  const commands = [];
  const commandRunner = (command, args, _options, callback) => {
    commands.push({ command, args });
    if (args[0] === "stop") {
      void fs.writeFile(statusPath, JSON.stringify({
        version: "villa-uat-state-v1",
        updatedAt: Date.now() + 1,
        state: "STOPPED_SETTLEMENT_PENDING",
        session: { sessionId, account: ACCOUNT, owner: OWNER, operator: OPERATOR },
      })).then(() => callback(null));
    } else callback(null);
  };
  const control = createUatAccountControl({
    env: env({ VILLA_UAT_LAUNCH_MODE: "systemd", VILLA_ACCOUNT_EXECUTION_ENABLED: "true", VILLA_UAT_STATE_DIRECTORY: directory }),
    commandRunner,
    pollMs: 1,
    readyTimeoutMs: 500,
  });
  try {
    const recovered = await control.getState({ caller: OWNER });
    assert.equal(recovered.state, "RUNNING");
    assert.equal(recovered.session.sessionId, sessionId);
    await assert.rejects(() => control.getState({ caller: "0x1111111111111111111111111111111111111111" }), { code: "OWNER_SCOPE_MISMATCH" });
    const stopped = await control.stop({ caller: OWNER });
    assert.equal(stopped.state, "STOPPED_SETTLEMENT_PENDING");
    assert.deepEqual(commands.map((entry) => entry.args), [["stop", sessionId]]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("systemd Start reattaches the matching owner/account session without creating a duplicate unit", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "villa-uat-reattach-"));
  const sessionId = "uat-1234567891-abcdef12";
  await fs.writeFile(path.join(directory, `${sessionId}.json`), JSON.stringify({
    version: "villa-uat-state-v1",
    updatedAt: Date.now(),
    state: "RUNNING",
    session: { sessionId, account: ACCOUNT, owner: OWNER, operator: OPERATOR, startedAt: 1234567891 },
  }));
  const commands = [];
  const control = createUatAccountControl({
    env: env({ VILLA_UAT_LAUNCH_MODE: "systemd", VILLA_ACCOUNT_EXECUTION_ENABLED: "true", VILLA_UAT_STATE_DIRECTORY: directory }),
    commandRunner: (command, args, _options, callback) => { commands.push({ command, args }); callback(null); },
    pollMs: 1,
    readyTimeoutMs: 500,
  });
  try {
    const first = await control.start({ caller: OWNER });
    const second = await control.start({ caller: OWNER });
    assert.equal(first.state, "RUNNING");
    assert.equal(first.session.sessionId, sessionId);
    assert.equal(second.session.sessionId, sessionId);
    assert.deepEqual(commands, []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("systemd Start ignores foreign status and never reattaches another account or owner", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "villa-uat-foreign-"));
  const foreignAccountId = "uat-1234567892-abcdef12";
  const foreignOwnerId = "uat-1234567893-abcdef12";
  await Promise.all([
    fs.writeFile(path.join(directory, `${foreignAccountId}.json`), JSON.stringify({
      updatedAt: Date.now() + 2,
      state: "RUNNING",
      session: { sessionId: foreignAccountId, account: "0x1111111111111111111111111111111111111111", owner: OWNER, operator: OPERATOR },
    })),
    fs.writeFile(path.join(directory, `${foreignOwnerId}.json`), JSON.stringify({
      updatedAt: Date.now() + 1,
      state: "RUNNING",
      session: { sessionId: foreignOwnerId, account: ACCOUNT, owner: "0x2222222222222222222222222222222222222222", operator: OPERATOR },
    })),
  ]);
  const commands = [];
  const control = createUatAccountControl({
    env: env({ VILLA_UAT_LAUNCH_MODE: "systemd", VILLA_ACCOUNT_EXECUTION_ENABLED: "true", VILLA_UAT_STATE_DIRECTORY: directory }),
    commandRunner: (_command, args, _options, callback) => {
      commands.push(args);
      const sessionId = args[1];
      void fs.writeFile(path.join(directory, `${sessionId}.json`), JSON.stringify({
        updatedAt: Date.now() + 3,
        state: "RUNNING",
        session: { sessionId, account: ACCOUNT, owner: OWNER, operator: OPERATOR },
      })).then(() => callback(null));
    },
    pollMs: 1,
    readyTimeoutMs: 500,
  });
  try {
    await assert.rejects(() => control.start({ caller: "0x3333333333333333333333333333333333333333" }), { code: "OWNER_SCOPE_MISMATCH" });
    const started = await control.start({ caller: OWNER });
    assert.notEqual(started.session.sessionId, foreignAccountId);
    assert.notEqual(started.session.sessionId, foreignOwnerId);
    assert.equal(commands.length, 1);
    assert.equal(commands[0][0], "start");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("systemd Start rejects an active status that changes account or owner scope", async () => {
  for (const mismatch of [
    { account: "0x1111111111111111111111111111111111111111", owner: OWNER },
    { account: ACCOUNT, owner: "0x2222222222222222222222222222222222222222" },
  ]) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "villa-uat-scope-mismatch-"));
    const commands = [];
    let statusPath;
    const control = createUatAccountControl({
      env: env({ VILLA_UAT_LAUNCH_MODE: "systemd", VILLA_ACCOUNT_EXECUTION_ENABLED: "true", VILLA_UAT_STATE_DIRECTORY: directory }),
      commandRunner: (_command, args, _options, callback) => {
        commands.push(args);
        const sessionId = args[1];
        statusPath = path.join(directory, `${sessionId}.json`);
        void fs.writeFile(statusPath, JSON.stringify({
          updatedAt: Date.now(),
          state: "RUNNING",
          session: { sessionId, account: ACCOUNT, owner: OWNER, operator: OPERATOR },
        })).then(() => callback(null));
      },
      pollMs: 1,
      readyTimeoutMs: 500,
    });
    try {
      const started = await control.start({ caller: OWNER });
      await fs.writeFile(statusPath, JSON.stringify({
        updatedAt: Date.now() + 1,
        state: "RUNNING",
        session: { sessionId: started.session.sessionId, account: mismatch.account, owner: mismatch.owner, operator: OPERATOR },
      }));
      await assert.rejects(() => control.start({ caller: OWNER }), { code: "UAT_SESSION_RECONCILIATION_REQUIRED" });
      assert.equal(commands.length, 1);
      assert.equal((await control.getState({ caller: OWNER })).error.code, "UAT_STATUS_SCOPE_MISMATCH");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

test("systemd Start requires scoped reconciliation for an errored session and does not create a unit", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "villa-uat-error-"));
  const sessionId = "uat-1234567894-abcdef12";
  await fs.writeFile(path.join(directory, `${sessionId}.json`), JSON.stringify({
    version: "villa-uat-state-v1",
    updatedAt: Date.now(),
    state: "ERROR",
    session: { sessionId, account: ACCOUNT, owner: OWNER, operator: OPERATOR },
    error: { code: "RECEIPT_TIMEOUT", message: "requires reconciliation" },
  }));
  const commands = [];
  const control = createUatAccountControl({
    env: env({ VILLA_UAT_LAUNCH_MODE: "systemd", VILLA_ACCOUNT_EXECUTION_ENABLED: "true", VILLA_UAT_STATE_DIRECTORY: directory }),
    commandRunner: (command, args, _options, callback) => { commands.push({ command, args }); callback(null); },
  });
  try {
    await assert.rejects(() => control.start({ caller: OWNER }), { code: "UAT_SESSION_RECONCILIATION_REQUIRED" });
    assert.deepEqual(commands, []);
    assert.equal((await control.getState({ caller: OWNER })).state, "ERROR");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("12. same-owner/account recovery reconciles the errored session without creating a duplicate trading unit", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "villa-uat-scoped-recover-"));
  const sessionId = "uat-1234567895-abcdef12";
  const statusPath = path.join(directory, `${sessionId}.json`);
  await fs.writeFile(statusPath, JSON.stringify({
    updatedAt: Date.now() - 1000,
    state: "ERROR",
    session: { sessionId, account: ACCOUNT, owner: OWNER, operator: OPERATOR },
    error: { code: "ACCOUNT_LEASE_LOST", message: "recovery required" },
  }));
  const commands = [];
  const control = createUatAccountControl({
    env: env({ VILLA_UAT_LAUNCH_MODE: "systemd", VILLA_ACCOUNT_EXECUTION_ENABLED: "true", VILLA_UAT_STATE_DIRECTORY: directory }),
    commandRunner: (_command, args, _options, callback) => {
      commands.push(args);
      if (args[0] !== "recover") { callback(new Error("unexpected command")); return; }
      void fs.writeFile(statusPath, JSON.stringify({
        updatedAt: Date.now() + 1,
        state: "STOPPED_CLEAN",
        session: { sessionId, account: ACCOUNT, owner: OWNER, operator: OPERATOR },
        result: { status: "STOPPED_CLEAN", reason: "EXPIRED_SESSION_RECOVERED" },
      })).then(() => callback(null));
    },
    pollMs: 1,
    readyTimeoutMs: 500,
    recoveryTimeoutMs: 500,
  });
  try {
    await assert.rejects(() => control.recover({ caller: "0x1111111111111111111111111111111111111111" }), { code: "OWNER_SCOPE_MISMATCH" });
    const recovered = await control.recover({ caller: OWNER });
    assert.equal(recovered.state, "STOPPED_CLEAN");
    assert.deepEqual(commands, [["recover", sessionId]]);
    assert.equal(commands.some(([action]) => action === "start"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("systemd start failure clears active session, resets state to STOPPED, and allows fresh start retry", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "villa-uat-start-fail-"));
  let failNextStart = true;
  const commandAttempts = [];
  const commandRunner = (_command, args, _options, callback) => {
    commandAttempts.push(args);
    const [action, sessionId] = args;
    if (action === "start" && failNextStart) {
      const err = new Error("systemctl start failed: exit 1");
      err.code = 1;
      callback(err);
      return;
    }
    if (action === "start") {
      const statePath = path.join(directory, `${sessionId}.json`);
      const state = { state: "RUNNING", session: { sessionId, account: ACCOUNT, owner: OWNER, operator: OPERATOR } };
      void fs.writeFile(statePath, JSON.stringify(state)).then(() => callback(null));
      return;
    }
    callback(null);
  };

  const control = createUatAccountControl({
    env: env({ VILLA_UAT_LAUNCH_MODE: "systemd", VILLA_UAT_STATE_DIRECTORY: directory }),
    commandRunner,
    pollMs: 1,
    readyTimeoutMs: 500,
  });

  // 1. Initial failed start throws the original error
  await assert.rejects(() => control.start({ caller: OWNER }), (err) => {
    assert.equal(err.code, "UAT_SERVICE_COMMAND_FAILED");
    assert.equal(err.message, "The private UAT service command failed.");
    return true;
  });

  // 2. State returns to STOPPED and activeSessionId is cleared (session is null)
  const stateAfterFail = await control.getState({ caller: OWNER });
  assert.equal(stateAfterFail.state, "STOPPED");
  assert.equal(stateAfterFail.session, null);

  // 3. Subsequent Start is allowed to perform fresh preflight and succeeds
  failNextStart = false;
  const started = await control.start({ caller: OWNER });
  assert.equal(started.state, "RUNNING");
  assert.ok(started.session?.sessionId);
  assert.notEqual(started.session?.sessionId, commandAttempts[0][1]);

  await fs.rm(directory, { recursive: true, force: true });
});
