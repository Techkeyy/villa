import assert from "node:assert/strict";
import test from "node:test";
import { AccountClientError, accountCall, tokenCall } from "../../dashboard/account-client.mjs";
import { MIN_DEPOSIT_RAW, MIN_DEPOSIT_TUSDC, MIN_TOP_UP_RAW, VILLA_ACCOUNT_CONFIG, VILLA_CHAIN, ZERO_ADDRESS } from "../../dashboard/account-config.mjs";
import { evaluateVerifiedOwnerAccountReadiness, isVerifiedOwnerAccountReady } from "../../dashboard/account-readiness.mjs";
import { createAddLiquidityHandler, parseLiquidityAmount, runAddLiquidity } from "../../dashboard/liquidity-flow.mjs";

const OWNER = "0xCc67779F8eDb2C80DC665775C5597657C512FE1A".toLowerCase();
const ACCOUNT = "0xFc9dbf0a8468aA56799b4e23B1EBe936426eE30b".toLowerCase();
const WALLET_START = 500_000_000n;

function harness({ allowanceStart = 0n, sendFailure = null, initialAccountBalance = 0n, rawInput = "1.00" } = {}) {
  let walletBalance = WALLET_START;
  let accountBalance = initialAccountBalance;
  let allowance = allowanceStart;
  const calls = [];
  const stages = [];
  const debug = [];
  const reads = { wallet: 0, account: 0, allowance: 0 };

  const account = () => ({
    address: ACCOUNT,
    owner: OWNER,
    operator: ZERO_ADDRESS,
    collateralToken: VILLA_ACCOUNT_CONFIG.collateralToken.toLowerCase(),
    outcomeToken: VILLA_ACCOUNT_CONFIG.outcomeToken.toLowerCase(),
    binaryModule: VILLA_ACCOUNT_CONFIG.binaryModule.toLowerCase(),
    binarySettlement: VILLA_ACCOUNT_CONFIG.binarySettlement.toLowerCase(),
    balance: accountBalance,
    verification: "VERIFIED",
  });

  const dependencies = {
    getChainId: async () => VILLA_CHAIN.id,
    readAccount: async (_provider, address, _artifact, owner) => {
      assert.equal(address, ACCOUNT);
      assert.equal(owner, OWNER);
      reads.account += 1;
      return account();
    },
    readTokenBalance: async () => {
      reads.wallet += 1;
      return walletBalance;
    },
    readAllowance: async () => {
      reads.allowance += 1;
      return allowance;
    },
    sendTransaction: async (_provider, transaction, update) => {
      calls.push(transaction);
      const isApproval = transaction.to.toLowerCase() === VILLA_ACCOUNT_CONFIG.collateralToken.toLowerCase();
      const phase = isApproval ? "approval" : "deposit";
      update("WAITING_FOR_WALLET");
      if (sendFailure && sendFailure === phase) throw new AccountClientError("WALLET_REJECTED", `${phase} rejected`);
      update("SUBMITTED", `0x${phase}`);
      update("SUCCESS", `0x${phase}`);
      const raw = BigInt(`0x${transaction.data.slice(-64)}`);
      if (isApproval) allowance = raw;
      else {
        walletBalance -= raw;
        accountBalance += raw;
      }
      return { hash: `0x${phase}`, receipt: { status: "0x1" } };
    },
  };

  return {
    provider: { request: async () => null },
    owner: OWNER,
    currentAccountAddress: ACCOUNT,
    account: { address: ACCOUNT, owner: OWNER, operator: ZERO_ADDRESS, verification: "VERIFIED" },
    accountArtifact: { runtimeBytecode: "0x6000" },
    rawInput,
    chainId: VILLA_CHAIN.id,
    busy: false,
    transactionStatus: "IDLE",
    chainStatus: "SHANNON",
    discoveryStatus: "DISCOVERED",
    setNetworkState: (chainId) => chainId === VILLA_CHAIN.id,
    onStage: (stage) => stages.push(stage),
    onTransactionUpdate: () => {},
    onDebug: (event, details) => debug.push({ event, details }),
    dependencies,
    calls,
    stages,
    debug,
    reads,
    get walletBalance() { return walletBalance; },
    get accountBalance() { return accountBalance; },
    get allowance() { return allowance; },
  };
}

async function execute(options = {}) {
  const context = harness(options);
  const result = await runAddLiquidity(context);
  return { context, result };
}

test("the real rediscovered zero-collateral account is ready for owner deposits before authorization", async () => {
  const context = harness();
  assert.equal(isVerifiedOwnerAccountReady(context), true);
  assert.equal(context.account.operator, ZERO_ADDRESS);
  const errors = [];
  const handler = createAddLiquidityHandler({
    getContext: () => context,
    isReady: isVerifiedOwnerAccountReady,
    onDebug: context.onDebug,
    onError: (error) => errors.push(error),
    onSuccess: () => {},
  });
  const result = await handler();
  assert.equal(result.amount, MIN_DEPOSIT_RAW);
  assert.equal(errors.length, 0);
  assert.equal(context.calls.length, 2);
});

test("verified identity remains ready after a normal post-discovery balance refresh", () => {
  const context = harness();
  const before = evaluateVerifiedOwnerAccountReadiness(context);
  const refreshed = {
    ...context,
    walletBalance: WALLET_START,
    account: { ...context.account, balance: 0n },
  };
  const after = evaluateVerifiedOwnerAccountReadiness(refreshed);
  assert.equal(before.ready, true);
  assert.equal(after.ready, true);
  assert.equal(after.snapshot.accountAddress, ACCOUNT);
  assert.equal(after.snapshot.accountOwner, OWNER);
  assert.equal(after.snapshot.accountCurrent, true);
  assert.equal(refreshed.account.address, context.account.address);
  assert.equal(refreshed.account.owner, context.account.owner);
  assert.equal(refreshed.account.operator, context.account.operator);
  assert.equal(refreshed.account.verification, context.account.verification);
});

test("Phase 2 minimum deposit is exact and rejects unsafe inputs", () => {
  assert.equal(MIN_DEPOSIT_TUSDC, "1.00");
  assert.equal(parseLiquidityAmount("1.00"), MIN_DEPOSIT_RAW);
  assert.equal(parseLiquidityAmount("1.000000"), MIN_DEPOSIT_RAW);
  for (const value of ["0", "0.000000", "0.999999"]) {
    assert.throws(() => parseLiquidityAmount(value), (error) => error.code === "MIN_DEPOSIT");
  }
  for (const value of ["-1", "1.0000001", "1e3", "NaN", "", "  "]) {
    assert.throws(() => parseLiquidityAmount(value), (error) => error.code === "INVALID_AMOUNT");
  }
  assert.throws(() => parseLiquidityAmount("500.00", 499_999_999n), (error) => error.code === "INSUFFICIENT_FUNDS");
});

test("initially unfunded accounts cannot bypass the 1.00 tUSDC minimum with a small deposit", () => {
  assert.throws(() => parseLiquidityAmount("0.002", WALLET_START, 0n), (error) => error.code === "MIN_DEPOSIT");
  assert.equal(parseLiquidityAmount("1.00", WALLET_START, 0n), MIN_DEPOSIT_RAW);
});

test("funded accounts accept exact 0.001 and 0.002 tUSDC top-ups", () => {
  assert.equal(parseLiquidityAmount("0.001", WALLET_START, MIN_DEPOSIT_RAW), MIN_TOP_UP_RAW);
  assert.equal(parseLiquidityAmount("0.002", WALLET_START, MIN_DEPOSIT_RAW), 2_000n);
  assert.throws(() => parseLiquidityAmount("0", WALLET_START, MIN_DEPOSIT_RAW), (error) => error.code === "MIN_TOP_UP");
});

test("the top-up parser preserves raw precision and checks wallet balance", () => {
  assert.throws(() => parseLiquidityAmount("0.0000001", WALLET_START, MIN_DEPOSIT_RAW), (error) => error.code === "INVALID_AMOUNT");
  assert.throws(() => parseLiquidityAmount("-0.001", WALLET_START, MIN_DEPOSIT_RAW), (error) => error.code === "INVALID_AMOUNT");
  assert.throws(() => parseLiquidityAmount("0.002", 1_999n, MIN_DEPOSIT_RAW), (error) => error.code === "INSUFFICIENT_FUNDS");
});

test("funded-account top-up uses the same exact finite amount for approval and deposit", async () => {
  const { context, result } = await execute({ initialAccountBalance: MIN_DEPOSIT_RAW, rawInput: "0.002" });
  assert.equal(result.amount, 2_000n);
  assert.equal(context.calls.length, 2);
  assert.deepEqual(context.calls[0], {
    from: OWNER,
    to: VILLA_ACCOUNT_CONFIG.collateralToken.toLowerCase(),
    data: tokenCall.approve(ACCOUNT, 2_000n),
  });
  assert.deepEqual(context.calls[1], {
    from: OWNER,
    to: ACCOUNT,
    data: accountCall.deposit(2_000n),
  });
  assert.equal(context.accountBalance, 1_002_000n);
});

test("rediscovered owner/account state uses exact raw approval and deposit amounts", async () => {
  const { context, result } = await execute();
  assert.equal(result.amount, 1_000_000n);
  assert.equal(context.calls.length, 2);
  assert.deepEqual(context.calls[0], {
    from: OWNER,
    to: VILLA_ACCOUNT_CONFIG.collateralToken.toLowerCase(),
    data: tokenCall.approve(ACCOUNT, 1_000_000n),
  });
  assert.deepEqual(context.calls[1], {
    from: OWNER,
    to: ACCOUNT,
    data: accountCall.deposit(1_000_000n),
  });
  assert.equal(context.walletBalance, WALLET_START - 1_000_000n);
  assert.equal(context.accountBalance, 1_000_000n);
});

test("sufficient existing allowance skips approval and deposits once", async () => {
  const context = harness({ allowanceStart: MIN_DEPOSIT_RAW });
  const result = await runAddLiquidity(context);
  assert.equal(result.amount, MIN_DEPOSIT_RAW);
  assert.equal(context.calls.length, 1);
  assert.equal(context.calls[0].to, ACCOUNT);
  assert.ok(context.debug.some(({ event }) => event === "approval_skipped"));
});

test("approval success proceeds to deposit and refreshes wallet/account balances", async () => {
  const context = harness();
  const updates = [];
  context.onTransactionUpdate = (...update) => updates.push(update);
  await runAddLiquidity(context);
  assert.deepEqual(context.stages, ["PREPARING", "APPROVAL_READY", "APPROVAL_CONFIRMING", "DEPOSIT_READY", "DEPOSIT_CONFIRMING"]);
  assert.deepEqual(updates.map(([, , phase]) => phase), ["approval", "approval", "approval", "deposit", "deposit", "deposit"]);
  assert.equal(context.reads.wallet, 2);
  assert.equal(context.reads.account, 2);
  assert.equal(context.reads.allowance, 2);
});

test("approval rejection produces an error and never sends deposit", async () => {
  const context = harness({ sendFailure: "approval" });
  await assert.rejects(() => runAddLiquidity(context), (error) => error.code === "WALLET_REJECTED");
  assert.equal(context.calls.length, 1);
  assert.equal(context.calls[0].to.toLowerCase(), VILLA_ACCOUNT_CONFIG.collateralToken.toLowerCase());
});

test("deposit rejection is visible to the caller after approval", async () => {
  const context = harness({ allowanceStart: MIN_DEPOSIT_RAW, sendFailure: "deposit" });
  const errors = [];
  const handler = createAddLiquidityHandler({
    getContext: () => context,
    onError: (error) => errors.push(error),
  });
  const result = await handler();
  assert.equal(result.error.code, "WALLET_REJECTED");
  assert.equal(errors[0].code, "WALLET_REJECTED");
  assert.equal(context.calls.length, 1);
  assert.equal(context.calls[0].to, ACCOUNT);
});

test("diagnostics cover click inputs, provider/account state, allowance, approval, deposit, and errors", async () => {
  const context = harness();
  const handler = createAddLiquidityHandler({ getContext: () => context, onDebug: context.onDebug, onSuccess: () => {} });
  await handler();
  const events = context.debug.map(({ event }) => event);
  for (const event of [
    "add_liquidity_click",
    "amount_parsed",
    "chain_request_start",
    "chain_request_result",
    "account_verified",
    "allowance_request_start",
    "allowance_request_result",
    "approval_request_start",
    "approval_request_result",
    "deposit_request_start",
    "deposit_request_result",
  ]) assert.ok(events.includes(event), event);
});

test("the click handler is attached and actually invokes the transaction flow", async () => {
  let invoked = 0;
  const listeners = new Map();
  const button = {
    addEventListener(type, callback) { listeners.set(type, callback); },
    async click() { return listeners.get("click")(); },
  };
  const handler = createAddLiquidityHandler({
    getContext: () => ({ provider: { request: async () => null }, owner: OWNER, account: { address: ACCOUNT }, rawInput: "1.00", busy: false }),
    run: async () => { invoked += 1; return { amount: MIN_DEPOSIT_RAW }; },
    onSuccess: () => {},
  });
  button.addEventListener("click", handler);
  await button.click();
  assert.equal(invoked, 1);
});

test("missing provider produces a visible error instead of a silent return", async () => {
  const messages = [];
  const handler = createAddLiquidityHandler({
    getContext: () => ({ provider: null, owner: OWNER, account: { address: ACCOUNT }, rawInput: "1.00", busy: false }),
    onError: (error) => messages.push(error.message),
  });
  const result = await handler();
  assert.equal(result.error.code, "WALLET_MISSING");
  assert.deepEqual(messages, ["Wallet connection is unavailable. Reconnect your wallet."]);
});

test("busy, missing owner, and missing account preflight branches all render errors", async () => {
  const cases = [
    [{ provider: { request: async () => null }, owner: OWNER, account: { address: ACCOUNT }, rawInput: "1.00", busy: true }, "ACTION_BUSY"],
    [{ provider: { request: async () => null }, owner: "", account: { address: ACCOUNT }, rawInput: "1.00", busy: false }, "INVALID_OWNER"],
    [{ provider: { request: async () => null }, owner: OWNER, account: null, rawInput: "1.00", busy: false }, "ACCOUNT_NOT_READY"],
  ];
  for (const [context, expectedCode] of cases) {
    const errors = [];
    const handler = createAddLiquidityHandler({ getContext: () => context, onError: (error) => errors.push(error) });
    const result = await handler();
    assert.equal(result.error.code, expectedCode);
    assert.equal(errors.length, 1);
  }
});

test("duplicate clicks are blocked while the real flow is busy", async () => {
  let runs = 0;
  let busy = true;
  const errors = [];
  const handler = createAddLiquidityHandler({
    getContext: () => ({ provider: { request: async () => null }, owner: OWNER, account: { address: ACCOUNT }, rawInput: "1.00", busy }),
    run: async () => { runs += 1; },
    setBusy: (value) => { busy = value; },
    onError: (error) => errors.push(error),
  });
  const result = await handler();
  assert.equal(result.error.code, "ACTION_BUSY");
  assert.equal(runs, 0);
  assert.equal(errors.length, 1);
});

test("flow errors call the visible error callback and always release busy state", async () => {
  let busy = false;
  const errors = [];
  const handler = createAddLiquidityHandler({
    getContext: () => ({ provider: { request: async () => null }, owner: OWNER, account: { address: ACCOUNT }, rawInput: "1.00", busy }),
    run: async () => { throw new AccountClientError("RPC_ERROR", "read failed"); },
    setBusy: (value) => { busy = value; },
    onError: (error) => errors.push(error),
  });
  const result = await handler();
  assert.equal(result.error.code, "RPC_ERROR");
  assert.equal(errors.length, 1);
  assert.equal(busy, false);
});
