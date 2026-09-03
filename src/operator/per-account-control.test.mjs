import assert from "node:assert/strict";
import test from "node:test";
import { AccountControlError } from "./account-control.mjs";
import { createPerAccountControl } from "./per-account-control.mjs";

const OPERATOR = "0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37";
const OWNER_A = "0x1111111111111111111111111111111111111111";
const OWNER_B = "0x2222222222222222222222222222222222222222";
const ACCOUNT_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACCOUNT_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_OPERATOR = "0x3333333333333333333333333333333333333333";

function identity(owner, account, operator = OPERATOR) {
  return { owner, account, operator, runtimeVerified: true, onChain: true };
}

function fixture({ accountExecutionEnabled = true, verify = null, initialState = "STOPPED" } = {}) {
  const created = [];
  const control = createPerAccountControl({
    env: { OPERATOR_ADDRESS: OPERATOR, VILLA_EXECUTION_ENABLED: "false", VILLA_ACCOUNT_EXECUTION_ENABLED: accountExecutionEnabled ? "true" : "false", VILLA_UAT_EXECUTION_ENABLED: "false" },
    accountVerifier: verify ?? (async ({ caller, account }) => {
      if (account === ACCOUNT_A && caller === OWNER_A) return identity(OWNER_A, ACCOUNT_A);
      if (account === ACCOUNT_B && caller === OWNER_B) return identity(OWNER_B, ACCOUNT_B);
      throw new AccountControlError("OWNER_SCOPE_MISMATCH", "account does not belong to this wallet", 403);
    }),
    controlFactory: ({ env }) => {
      let state = initialState;
      const entry = { env, calls: [] };
      created.push(entry);
      const session = () => ({ sessionId: `session-${env.VILLA_ENGINE_ACCOUNT.slice(-4)}`, account: env.VILLA_ENGINE_ACCOUNT, owner: env.VILLA_ENGINE_OWNER, operator: env.VILLA_ENGINE_OPERATOR, state });
      entry.control = {
        async getState() { return { state, session: state === "STOPPED" ? null : session(), safety: { signerInBrowser: false, arbitraryRelay: false, withdrawViaControl: false } }; },
        async start() { entry.calls.push("start"); state = "RUNNING"; return { state, session: session() }; },
        async stop() { entry.calls.push("stop"); state = "STOPPED"; return { state, session: session() }; },
        async settle() { entry.calls.push("settle"); state = "SETTLED"; return { state, session: session() }; },
        async pause() { entry.calls.push("pause"); state = "PAUSED"; return { state, session: session() }; },
        async resume() { entry.calls.push("resume"); state = "RUNNING"; return { state, session: session() }; },
      };
      return entry.control;
    },
  });
  return { control, created };
}

test("two owners receive isolated account-bound sessions and lifecycle controls", async () => {
  const { control, created } = fixture();
  const [stateA, stateB] = await Promise.all([
    control.getState({ caller: OWNER_A, account: ACCOUNT_A }),
    control.getState({ caller: OWNER_B, account: ACCOUNT_B }),
  ]);
  assert.equal(stateA.identity.account, ACCOUNT_A);
  assert.equal(stateB.identity.account, ACCOUNT_B);
  await Promise.all([
    control.start({ caller: OWNER_A, account: ACCOUNT_A }),
    control.start({ caller: OWNER_B, account: ACCOUNT_B }),
  ]);
  const [runningA, runningB] = await Promise.all([
    control.getState({ caller: OWNER_A, account: ACCOUNT_A }),
    control.getState({ caller: OWNER_B, account: ACCOUNT_B }),
  ]);
  assert.equal(runningA.session.account, ACCOUNT_A);
  assert.equal(runningB.session.account, ACCOUNT_B);
  assert.deepEqual(created.map((entry) => [entry.env.VILLA_ENGINE_OWNER, entry.env.VILLA_ENGINE_ACCOUNT]), [[OWNER_A, ACCOUNT_A], [OWNER_B, ACCOUNT_B]]);
  await control.stop({ caller: OWNER_A, account: ACCOUNT_A });
  await control.settle({ caller: OWNER_B, account: ACCOUNT_B });
  assert.deepEqual(created.map((entry) => entry.calls), [["start", "stop"], ["start", "settle"]]);
});

test("an authenticated owner cannot control another owner's VillaAccount", async () => {
  const { control } = fixture();
  await assert.rejects(() => control.start({ caller: OWNER_A, account: ACCOUNT_B }), { code: "OWNER_SCOPE_MISMATCH" });
  await assert.rejects(() => control.stop({ caller: OWNER_A, account: ACCOUNT_B }), { code: "OWNER_SCOPE_MISMATCH" });
  await assert.rejects(() => control.settle({ caller: OWNER_A, account: ACCOUNT_B }), { code: "OWNER_SCOPE_MISMATCH" });
});

test("invalid accounts and accounts without canonical operator authorization fail closed", async () => {
  const invalid = fixture({ verify: async () => { throw new AccountControlError("ACCOUNT_INVALID", "not a verified VillaAccount", 403); } });
  await assert.rejects(() => invalid.control.getState({ caller: OWNER_A, account: ACCOUNT_A }), { code: "ACCOUNT_INVALID" });
  const unauthorized = fixture({ verify: async ({ caller, account }) => identity(caller, account, OTHER_OPERATOR) });
  await assert.rejects(() => unauthorized.control.start({ caller: OWNER_A, account: ACCOUNT_A }), { code: "OPERATOR_NOT_AUTHORIZED" });
});

test("account gate off verifies the selected account but never starts a writer", async () => {
  const { control, created } = fixture({ accountExecutionEnabled: false });
  const state = await control.getState({ caller: OWNER_A, account: ACCOUNT_A });
  assert.equal(state.identity.account, ACCOUNT_A);
  assert.deepEqual(state.readiness.reasons, ["ACCOUNT_EXECUTION_DISABLED"]);
  await assert.rejects(() => control.start({ caller: OWNER_A, account: ACCOUNT_A }), { code: "ACCOUNT_EXECUTION_DISABLED" });
  assert.equal(created.length, 1);
});

test("account Start uses its own gate while the legacy global and UAT gates remain false", async () => {
  const { control, created } = fixture();
  await control.start({ caller: OWNER_A, account: ACCOUNT_A });
  assert.deepEqual(created[0].calls, ["start"]);
  assert.equal(created[0].env.VILLA_EXECUTION_ENABLED, "false");
  assert.equal(created[0].env.VILLA_ACCOUNT_EXECUTION_ENABLED, "true");
  assert.equal(created[0].env.VILLA_UAT_EXECUTION_ENABLED, "false");
});

test("Stop reaches an active account session even when new account execution is disabled", async () => {
  const { control, created } = fixture({ accountExecutionEnabled: false, initialState: "RUNNING" });
  const before = await control.getState({ caller: OWNER_A, account: ACCOUNT_A });
  assert.equal(before.state, "RUNNING");
  const after = await control.stop({ caller: OWNER_A, account: ACCOUNT_A });
  assert.equal(after.state, "STOPPED");
  assert.deepEqual(created[0].calls, ["stop"]);
});

test("owner can Stop a recovered session after operator authorization is revoked", async () => {
  const verify = async ({ caller, account }) => identity(caller, account, OTHER_OPERATOR);
  const { control, created } = fixture({ accountExecutionEnabled: false, initialState: "RUNNING", verify });
  const state = await control.getState({ caller: OWNER_A, account: ACCOUNT_A });
  assert.equal(state.state, "RUNNING");
  assert.equal(state.identity.operatorAuthorized, false);
  await control.stop({ caller: OWNER_A, account: ACCOUNT_A });
  assert.deepEqual(created[0].calls, ["stop"]);
});
