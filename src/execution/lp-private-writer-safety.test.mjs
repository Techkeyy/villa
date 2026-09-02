import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createAccountBoundPrivateWriter } from "./lp-private-writer.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const MARKET = "0x000000000000000000000000000000000000000000000000000000000000f920";

function createPlan(operator) {
  return { functionName: "operatorBurnSet", args: [MARKET, 1000n], broadcast: false, to: ACCOUNT, destination: ACCOUNT, account: ACCOUNT, orderOwner: ACCOUNT, owner: OWNER, signer: operator, chainId: 50312, intent: { sessionId: "writer-safety", account: ACCOUNT, owner: OWNER, operator, chainId: 50312, marketId: MARKET, action: "BURN_COMPLETE_SET", txIndex: 0 } };
}

function common(privateKey, overrides = {}) {
  const signer = privateKeyToAccount(privateKey);
  return { session: { account: ACCOUNT, owner: OWNER, operator: signer.address, sessionId: "writer-safety", currentMarketId: MARKET, leaseId: "lease-writer-safety" }, lease: { held: true, account: ACCOUNT, owner: OWNER, operator: signer.address, sessionId: "writer-safety", leaseId: "lease-writer-safety" }, policy: { validate: () => ({ allowed: true }) }, signer, publicClient: { async simulateContract(request) { return { request }; } }, walletClient: { chain: { id: 50312 }, async writeContract() { return "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; }, async waitForTransactionReceipt() { return { status: 1, blockNumber: 12n }; } }, executionEnabled: true, readLatestNonce: async () => 1, readPendingNonce: async () => 1, ...overrides };
}

test("writer requires an immutable session before any wallet call", () => {
  const privateKey = generatePrivateKey();
  let simulations = 0;
  const base = common(privateKey, {
    session: null,
    lease: null,
    publicClient: { async simulateContract() { simulations += 1; return { request: {} }; } },
  });
  assert.throws(() => createAccountBoundPrivateWriter(base), { code: "SESSION_REQUIRED" });
  assert.equal(simulations, 0);
});

test("writer requires a held session-bound lease before simulation or broadcast", () => {
  const privateKey = generatePrivateKey();
  let simulations = 0;
  const base = common(privateKey, {
    lease: null,
    publicClient: { async simulateContract() { simulations += 1; return { request: {} }; } },
  });
  assert.throws(() => createAccountBoundPrivateWriter(base), { code: "ACCOUNT_LEASE_REQUIRED" });
  assert.equal(simulations, 0);
});


test("lease expiry blocks a queued action before simulation or broadcast", async () => {
  const privateKey = generatePrivateKey();
  let now = 100;
  let simulations = 0;
  const base = common(privateKey, {
    now: () => now,
    publicClient: { async simulateContract() { simulations += 1; return { request: {} }; } },
  });
  base.lease = { ...base.lease, expiresAt: 200 };
  const writer = createAccountBoundPrivateWriter(base);
  now = 201;
  await assert.rejects(() => writer.enqueue(createPlan(privateKeyToAccount(privateKey).address)), { code: "ACCOUNT_LEASE_REQUIRED" });
  assert.equal(simulations, 0);
});


test("reverted receipt is terminal and is never retried", async () => {
  const privateKey = generatePrivateKey();
  const writer = createAccountBoundPrivateWriter(common(privateKey, { walletClient: { chain: { id: 50312 }, async writeContract() { return "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; }, async waitForTransactionReceipt() { return { status: 0, blockNumber: 13n }; } } }));
  const result = await writer.enqueue(createPlan(privateKeyToAccount(privateKey).address));
  assert.equal(result.state, "REVERTED");
  assert.equal(writer.getState().halted, false);
});

test("unknown receipt halts the writer and prevents another write", async () => {
  const privateKey = generatePrivateKey();
  let writes = 0;
  const writer = createAccountBoundPrivateWriter(common(privateKey, { walletClient: { chain: { id: 50312 }, async writeContract() { writes += 1; return "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"; }, async waitForTransactionReceipt() { throw Object.assign(new Error("receipt timeout"), { code: "RECEIPT_TIMEOUT" }); } } }));
  await assert.rejects(() => writer.enqueue(createPlan(privateKeyToAccount(privateKey).address)), { code: "UNKNOWN" });
  assert.equal(writes, 1);
  assert.equal(writer.getState().halted, true);
  await assert.rejects(() => writer.enqueue(createPlan(privateKeyToAccount(privateKey).address)), { code: "WRITER_HALTED" });
});

test("a restarted writer marks persisted PENDING work UNKNOWN and blocks recovery", () => {
  const privateKey = generatePrivateKey();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "villa-private-restart-"));
  const journalPath = path.join(directory, "transactions.json");
  fs.writeFileSync(journalPath, JSON.stringify({ version: "villa-private-account-writer-v1", nextNonce: 1, sequence: 1, halted: false, records: [{ hash: "0xknown", intentId: "writer-safety:0", sessionId: "writer-safety", action: "BURN_COMPLETE_SET", account: ACCOUNT, marketId: MARKET, nonce: 1, state: "PENDING", createdAt: 1, updatedAt: 1 }] }));
  const writer = createAccountBoundPrivateWriter(common(privateKey, { journalPath }));
  assert.equal(writer.getState().halted, true);
  assert.equal(writer.getRecord("0xknown").state, "UNKNOWN");
  assert.equal(writer.getRecord("0xknown").errorCode, "RESTART_RECONCILIATION_REQUIRED");
});

test("signer mismatch fails closed at private writer creation", () => {
  const privateKey = generatePrivateKey();
  const otherKey = generatePrivateKey();
  assert.throws(() => createAccountBoundPrivateWriter({ ...common(privateKey), signer: privateKeyToAccount(otherKey) }), { code: "SIGNER_MISMATCH" });
});
