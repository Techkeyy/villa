import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { AccountClientError, accountCall } from "../../dashboard/account-client.mjs";
import { VILLA_ACCOUNT_CONFIG, VILLA_CHAIN, ZERO_ADDRESS } from "../../dashboard/account-config.mjs";
import { accountReadinessSnapshot, evaluateVerifiedOwnerAccountReadiness, isStrategyCapitalReady, isVerifiedOwnerAccountReady } from "../../dashboard/account-readiness.mjs";
import { createAuthorizationHandler, runAuthorization } from "../../dashboard/authorization-flow.mjs";

const OWNER = "0xCc67779F8eDb2C80DC665775C5597657C512FE1A".toLowerCase();
const ACCOUNT = "0xFc9dbf0a8468aA56799b4e23B1EBe936426eE30b".toLowerCase();
const OPERATOR = VILLA_ACCOUNT_CONFIG.operator.toLowerCase();

test("strategy control requires reserve plus the venue-minimum complete-set mint", () => {
  assert.equal(isStrategyCapitalReady({ account: { balance: 1_000_000n } }), false);
  assert.equal(isStrategyCapitalReady({ account: { balance: 1_001_000n } }), true);
  assert.equal(isStrategyCapitalReady({ account: { balance: 1_001_000 } }), false);
});

function harness({
  owner = OWNER,
  provider = { request: async () => null },
  operator = OPERATOR,
  accountOperator = ZERO_ADDRESS,
  chainId = VILLA_CHAIN.id,
  discoveryStatus = "DISCOVERED",
  verification = "VERIFIED",
  currentAccountAddress = ACCOUNT,
  sendFailure = null,
} = {}) {
  let currentOperator = accountOperator;
  const calls = [];
  const stages = [];
  const updates = [];
  const debug = [];
  const account = () => ({
    address: ACCOUNT,
    owner: OWNER,
    operator: currentOperator,
    balance: 0n,
    verification,
  });
  const context = {
    provider,
    owner,
    currentAccountAddress,
    account: account(),
    accountArtifact: { runtimeBytecode: "0x6000" },
    operator,
    chainId,
    chainStatus: chainId === VILLA_CHAIN.id ? "SHANNON" : "WRONG_NETWORK",
    discoveryStatus,
    transactionStatus: "IDLE",
    busy: false,
    onStage: (stage, hash = "") => stages.push([stage, hash]),
    onTransactionUpdate: (state, hash = "") => updates.push([state, hash]),
    onDebug: (event, details) => debug.push({ event, details }),
    dependencies: {
      getChainId: async () => chainId,
      readAccount: async () => account(),
      sendTransaction: async (_provider, transaction, update) => {
        calls.push(transaction);
        update("WAITING_FOR_WALLET");
        if (sendFailure) throw new AccountClientError(sendFailure, "The wallet request was cancelled.");
        update("SUBMITTED", "0xauth");
        update("SUCCESS", "0xauth");
        currentOperator = OPERATOR;
        return { hash: "0xauth", receipt: { status: "0x1" } };
      },
    },
  };
  return {
    context,
    calls,
    stages,
    updates,
    debug,
    get currentOperator() { return currentOperator; },
  };
}

function handlerFor(fixture, overrides = {}) {
  return createAuthorizationHandler({
    getContext: () => fixture.context,
    isReady: isVerifiedOwnerAccountReady,
    onDebug: fixture.context.onDebug,
    ...overrides,
  });
}

test("canonical readiness accepts the exact rediscovered owner account before authorization", () => {
  const fixture = harness({ accountOperator: ZERO_ADDRESS });
  const snapshot = accountReadinessSnapshot(fixture.context);
  assert.deepEqual(snapshot, {
    connected: true,
    wallet: OWNER,
    chainId: VILLA_CHAIN.id,
    discovery: "DISCOVERED",
    accountAddress: ACCOUNT,
    accountOwner: OWNER,
    accountVerified: true,
    currentOwner: OWNER,
    currentAccountAddress: ACCOUNT,
    networkCorrect: true,
    accountCurrent: true,
    reasons: [],
    ready: true,
  });
  const evaluation = evaluateVerifiedOwnerAccountReadiness({ ...fixture.context, currentAccountAddress: "" });
  assert.equal(evaluation.ready, false);
  assert.deepEqual(evaluation.reasons, ["ACCOUNT_NOT_CURRENT"]);
  assert.deepEqual(evaluation.snapshot, {
    connected: true,
    wallet: OWNER,
    chainId: VILLA_CHAIN.id,
    discovery: "DISCOVERED",
    accountAddress: ACCOUNT,
    accountOwner: OWNER,
    accountVerified: true,
    currentOwner: OWNER,
    currentAccountAddress: "",
    networkCorrect: true,
    accountCurrent: false,
  });
  assert.equal(isVerifiedOwnerAccountReady({ ...fixture.context, account: { ...fixture.context.account, operator: OPERATOR } }), true);
  for (const patch of [
    { owner: "" },
    { chainStatus: "WRONG_NETWORK" },
    { discoveryStatus: "DISCOVERING" },
    { account: { ...fixture.context.account, verification: "UNVERIFIED" } },
    { account: { ...fixture.context.account, owner: "0x1111111111111111111111111111111111111111" } },
    { currentAccountAddress: "0x1111111111111111111111111111111111111111" },
  ]) assert.equal(isVerifiedOwnerAccountReady({ ...fixture.context, ...patch }), false);
});

test("verified owner authorization prepares the exact setOperator transaction without broadcasting", async () => {
  const fixture = harness();
  const result = await runAuthorization(fixture.context);
  assert.equal(result.alreadyAuthorized, false);
  assert.deepEqual(fixture.calls, [{
    from: OWNER,
    to: ACCOUNT,
    data: accountCall.setOperator(OPERATOR),
  }]);
  assert.deepEqual(fixture.stages.map(([stage]) => stage), ["READY", "CONFIRMING"]);
  assert.deepEqual(fixture.updates.map(([state]) => state), ["WAITING_FOR_WALLET", "SUBMITTED", "SUCCESS"]);
  assert.equal(fixture.currentOperator, OPERATOR);
  assert.ok(fixture.debug.some(({ event }) => event === "authorize_prepare"));
});

test("Authorize VILLA click fires and reaches preparation for the exact verified state", async () => {
  const fixture = harness();
  const errors = [];
  const result = await handlerFor(fixture, {
    onError: (error) => errors.push(error),
    onSuccess: () => {},
  })();
  assert.equal(result.alreadyAuthorized, false);
  assert.equal(errors.length, 0);
  assert.equal(fixture.calls.length, 1);
  assert.ok(fixture.debug.some(({ event }) => event === "authorize_click"));
  assert.ok(fixture.debug.some(({ event }) => event === "authorize_prepare"));
});

test("missing operator address produces a visible authorization error", async () => {
  const fixture = harness({ operator: "" });
  const errors = [];
  const result = await handlerFor(fixture, { onError: (error) => errors.push(error) })();
  assert.equal(result.error.code, "OPERATOR_UNAVAILABLE");
  assert.equal(errors.length, 1);
  assert.equal(fixture.calls.length, 0);
  assert.ok(fixture.debug.some(({ event, details }) => event === "authorize_blocked_reason" && details.reason === "OPERATOR_UNAVAILABLE"));
});

test("wrong network and missing provider produce visible authorization errors", async () => {
  const wrongNetwork = harness({ chainId: 1 });
  const wrongErrors = [];
  const wrongResult = await handlerFor(wrongNetwork, { onError: (error) => wrongErrors.push(error) })();
  assert.equal(wrongResult.error.code, "WRONG_NETWORK");
  assert.equal(wrongErrors.length, 1);
  assert.equal(wrongNetwork.calls.length, 0);

  const noProvider = harness({ provider: null });
  const providerErrors = [];
  const providerResult = await handlerFor(noProvider, { onError: (error) => providerErrors.push(error) })();
  assert.equal(providerResult.error.code, "WALLET_MISSING");
  assert.equal(providerErrors.length, 1);
  assert.equal(noProvider.calls.length, 0);
});

test("wallet rejection is returned visibly and never becomes a silent no-op", async () => {
  const fixture = harness({ sendFailure: "WALLET_REJECTED" });
  const errors = [];
  const result = await handlerFor(fixture, { onError: (error) => errors.push(error) })();
  assert.equal(result.error.code, "WALLET_REJECTED");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /cancelled/i);
  assert.equal(fixture.calls.length, 1);
  assert.ok(fixture.debug.some(({ event }) => event === "authorize_error"));
  assert.ok(fixture.debug.some(({ event }) => event === "authorize_blocked_reason"));
});

test("busy authorization clicks are visibly blocked and do not duplicate work", async () => {
  const fixture = harness();
  fixture.context.busy = true;
  let runs = 0;
  const errors = [];
  const result = await handlerFor(fixture, {
    run: async () => { runs += 1; },
    onError: (error) => errors.push(error),
  })();
  assert.equal(result.error.code, "ACTION_BUSY");
  assert.equal(runs, 0);
  assert.equal(errors.length, 1);
  assert.ok(fixture.debug.some(({ event, details }) => event === "authorize_blocked_reason" && details.reason === "BUSY"));
});

test("authorization preflight has no silent return branch", async () => {
  const cases = [
    [harness({ provider: null }), "WALLET_MISSING"],
    [harness({ owner: "" }), "ACCOUNT_NOT_READY"],
    [harness({ currentAccountAddress: "0x1111111111111111111111111111111111111111" }), "ACCOUNT_NOT_READY"],
    [harness({ chainId: 1 }), "WRONG_NETWORK"],
    [harness({ operator: "" }), "OPERATOR_UNAVAILABLE"],
  ];
  for (const [fixture, expectedCode] of cases) {
    const errors = [];
    const result = await handlerFor(fixture, { onError: (error) => errors.push(error) })();
    assert.equal(result.error.code, expectedCode);
    assert.equal(errors.length, 1);
    assert.ok(fixture.debug.some(({ event }) => event === "authorize_click"));
    assert.ok(fixture.debug.some(({ event }) => event === "authorize_blocked_reason"));
  }
});

test("ACCOUNT READY and owner-action eligibility consume one readiness truth", () => {
  const app = fs.readFileSync(new URL("../../dashboard/app.mjs", import.meta.url), "utf8");
  const fixture = harness({ accountOperator: ZERO_ADDRESS });
  assert.equal(isVerifiedOwnerAccountReady(fixture.context), true);
  assert.match(app, /const accountReady = readinessEvaluation\.ready/);
  assert.match(app, /capitalStatus\.textContent = accountReady \? "ACCOUNT READY"/);
  assert.match(app, /isReady: \(context\) => isVerifiedOwnerAccountReady\(context\)/);
  assert.match(app, /const canManageCapital = accountReady && !appState\.busy/);
  assert.doesNotMatch(fs.readFileSync(new URL("../../dashboard/account-readiness.mjs", import.meta.url), "utf8"), /operator/);
});
