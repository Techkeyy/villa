import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadPrivateSigner } from "./lp-private-runtime.mjs";
import { createAccountBoundPrivateWriter } from "./lp-private-writer.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function session(operator = OPERATOR) {
  return { account: ACCOUNT, operator, owner: OWNER, sessionId: "private-writer-test", currentMarketId: MARKET, leaseId: "lease-private-writer-test" };
}

function lease(operator = OPERATOR) {
  return { held: true, account: ACCOUNT, operator, owner: OWNER, sessionId: "private-writer-test", leaseId: "lease-private-writer-test" };
}

function plan(functionName = "operatorMintSet", action = "MINT_COMPLETE_SET", txIndex = 0) {
  return {
    functionName,
    args: [MARKET, 1000n],
    broadcast: false,
    to: ACCOUNT,
    destination: ACCOUNT,
    account: ACCOUNT,
    orderOwner: ACCOUNT,
    owner: OWNER,
    signer: OPERATOR,
    chainId: 50312,
    intent: { intentId: `intent-${txIndex}`, sessionId: "private-writer-test", account: ACCOUNT, owner: OWNER, operator: OPERATOR, chainId: 50312, marketId: MARKET, action, txIndex },
  };
}

function policy() {
  return { validate: () => ({ allowed: true }) };
}

function tempFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "villa-private-writer-"));
  return { directory, journalPath: path.join(directory, "transactions.json") };
}

test("credential loader derives the expected public address without exposing key text", () => {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const loaded = loadPrivateSigner({ credentialsDirectory: "ignored", expectedOperator: account.address, readFile: () => `OPERATOR_PRIVATE_KEY=${privateKey}\n` });
  assert.equal(loaded.address, account.address.toLowerCase());
  assert.equal(loaded.credentialPath, path.join("ignored", "operator-key"));
  assert.equal(Object.prototype.hasOwnProperty.call(loaded, "privateKey"), false);
});

test("disabled execution rejects writer creation before any wallet client invocation", () => {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  assert.throws(() => createAccountBoundPrivateWriter({
    session: session(account.address),
    policy: policy(),
    signer: account,
    publicClient: { simulateContract: async () => ({ request: {} }) },
    walletClient: { writeContract: async () => { throw new Error("must not run"); } },
    executionEnabled: false,
    readLatestNonce: async () => 1,
    readPendingNonce: async () => 1,
  }), { code: "EXECUTION_DISABLED" });
});

test("private writer accepts typed VILLA intents and derives the only account target", async () => {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const calls = [];
  const { journalPath } = tempFile();
  const writer = createAccountBoundPrivateWriter({
    session: session(account.address),
    lease: lease(account.address),
    policy: policy(),
    signer: account,
    publicClient: {
      async simulateContract(request) {
        calls.push(["simulate", request]);
        return { request: { address: request.address, abi: request.abi, functionName: request.functionName, args: request.args, value: 0n } };
      },
    },
    walletClient: {
      chain: { id: 50312 },
      async writeContract(request) {
        calls.push(["write", request]);
        return "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      },
      async waitForTransactionReceipt() { return { status: "success", blockNumber: 9n }; },
    },
    executionEnabled: true,
    readLatestNonce: async () => 4,
    readPendingNonce: async () => 4,
    journalPath,
  });
  const result = await writer.enqueue({ ...plan(), signer: account.address });
  assert.equal(result.state, "CONFIRMED");
  const write = calls.find(([kind]) => kind === "write")[1];
  assert.equal(write.address, ACCOUNT);
  assert.equal(write.value, 0n);
  assert.equal(write.functionName, "operatorMintSet");
  assert.deepEqual(write.args, [MARKET, 1000n]);
  assert.equal("sendTransaction" in writer, false);
  assert.equal("writeContract" in writer, false);
  assert.equal(JSON.parse(fs.readFileSync(journalPath, "utf8")).records[0].receiptBlock, "9");
});

test("receipt timeout falls back to an authoritative public receipt once", async () => {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const { journalPath } = tempFile();
  let fallbackReads = 0;
  const writer = createAccountBoundPrivateWriter({
    session: session(account.address),
    lease: lease(account.address),
    policy: policy(),
    signer: account,
    publicClient: {
      async simulateContract(request) { return { request }; },
    },
    walletClient: {
      chain: { id: 50312 },
      async writeContract() { return "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; },
      async waitForTransactionReceipt() { throw Object.assign(new Error("wallet wait timed out"), { code: "TIMEOUT" }); },
    },
    executionEnabled: true,
    readLatestNonce: async () => 4,
    readPendingNonce: async () => 4,
    readReceipt: async () => { fallbackReads += 1; return { status: "success", blockNumber: 10n }; },
    journalPath,
  });
  const result = await writer.enqueue({ ...plan(), signer: account.address });
  assert.equal(result.state, "CONFIRMED");
  assert.equal(result.receiptBlock, "10");
  assert.equal(fallbackReads, 1);
  assert.equal(writer.getState().halted, false);
});
test("unsupported function and arbitrary transaction-shaped input are rejected before simulation", async () => {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  let simulations = 0;
  const writer = createAccountBoundPrivateWriter({
    session: session(account.address),
    lease: lease(account.address),
    policy: policy(),
    signer: account,
    publicClient: { async simulateContract() { simulations += 1; return { request: {} }; } },
    walletClient: { chain: { id: 50312 }, async writeContract() { return "0xknown"; }, async waitForTransactionReceipt() { return { status: 1 }; } },
    executionEnabled: true,
    readLatestNonce: async () => 1,
    readPendingNonce: async () => 1,
  });
  await assert.rejects(() => writer.enqueue({ to: ACCOUNT, data: "0x1234", value: 0n }), { code: "INTENT_REQUIRED" });
  await assert.rejects(() => writer.enqueue(plan("withdraw", "WITHDRAW", 0)), { code: "INTENT_REQUIRED" });
  assert.equal(simulations, 0);
});

test("latest/pending nonce conflict halts before a second wallet invocation", async () => {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  let reads = 0;
  let writes = 0;
  const writer = createAccountBoundPrivateWriter({
    session: session(account.address),
    lease: lease(account.address),
    policy: policy(),
    signer: account,
    publicClient: { async simulateContract(request) { return { request }; } },
    walletClient: {
      chain: { id: 50312 },
      async writeContract() { writes += 1; return `0x${String(writes).padStart(64, "0")}`; },
      async waitForTransactionReceipt() { return { status: 1 }; },
    },
    executionEnabled: true,
    readLatestNonce: async () => { reads += 1; return reads === 1 ? 2 : 4; },
    readPendingNonce: async () => reads === 1 ? 2 : 4,
  });
  await writer.enqueue(plan());
  await assert.rejects(() => writer.enqueue(plan("operatorBurnSet", "BURN_COMPLETE_SET", 1)), { code: "NONCE_CONFLICT" });
  assert.equal(writes, 1);
  assert.equal(writer.getState().halted, true);
});
