import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { encodeFunctionData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { VILLA_ACCOUNT_OPERATOR_ABI, createLpExecutionAdapter } from "./lp-adapter.mjs";
import { runPrivateLpOneShotEntry } from "./lp-private-runtime-entry.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const TEST_SIGNER_KEY = generatePrivateKey();
const OPERATOR = privateKeyToAccount(TEST_SIGNER_KEY).address;
const MARKET = "0x000000000000000000000000000000000000000000000000000000000000f920";
const POOL = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
const MODULE = "0x6666666666666666666666666666666666666666";
const TX_HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function fixtureAdapter(sessionId) {
  const reader = {
    async readAccountIdentity({ account }) { return { account, owner: OWNER, operator: OPERATOR, collateralToken: TOKEN, outcomeToken: TOKEN, binaryModule: MODULE, binarySettlement: TOKEN, maxOrderQuantity: 1000n, maxOrderCollateral: 1000n }; },
    async readCapital({ account, marketId }) { return { account, directCollateralRaw: 1_001_000n, vaultRaw: 0n, marketId, pool: POOL }; },
    async readOutcomeInventory({ account, marketId }) { return { account, marketId, yesRaw: 1000n, noRaw: 1000n }; },
    async readOrders({ account, marketId }) { return { account, marketId, status: "VERIFIED", orders: [] }; },
    async readMarket({ account, marketId }) { return { account, marketId, collateral: TOKEN, market: TOKEN, pool: POOL, yesId: 1n, noId: 2n, tradingStart: 1n, expiry: 9_000_000_000n }; },
  };
  const base = createLpExecutionAdapter({ account: ACCOUNT, owner: OWNER, operator: OPERATOR, reader, sessionId });
  return Object.freeze({ ...base, readMarket: (input = {}) => reader.readMarket({ ...input, account: ACCOUNT }) });
}

function feasibility() {
  return {
    result: "PASS",
    account: ACCOUNT,
    owner: OWNER,
    operator: OPERATOR,
    market: { marketId: MARKET, series: "BINARY:BTC:86400", intervalSec: 86400, expirySec: 9_000_000_000, headroomSec: 8_000_000 },
    shadow: {
      result: "PASS",
      account: ACCOUNT,
      owner: OWNER,
      operator: OPERATOR,
      market: { onchain: { pool: POOL } },
      risk: { state: "ALLOW", governorVersion: "risk-test" },
      riskSnapshot: { market: { status: 1 } },
      quotePlan: { ask: { enabled: true, action: "SELL_YES", targetPriceRaw: "29000", targetQuantityRaw: "1000" } },
    },
  };
}

function accountState() {
  return {
    account: ACCOUNT,
    owner: OWNER,
    operator: OPERATOR,
    identity: { account: ACCOUNT, owner: OWNER, operator: OPERATOR, collateralToken: TOKEN, outcomeToken: TOKEN, binaryModule: MODULE, binarySettlement: TOKEN, maxOrderQuantity: 1000n, maxOrderCollateral: 1000n },
    capital: { account: ACCOUNT, directCollateralRaw: 1_001_000n, vaultRaw: 0n, marketId: MARKET, pool: POOL },
    inventory: { account: ACCOUNT, marketId: MARKET, yesRaw: 1000n, noRaw: 1000n },
    orders: { account: ACCOUNT, marketId: MARKET, status: "VERIFIED", orders: [] },
  };
}

test("private runtime dry recovery reconciles confirmed mint and never plans a duplicate", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "villa-runtime-recovery-"));
  const journalPath = path.join(directory, "transactions.json");
  fs.writeFileSync(journalPath, JSON.stringify({
    version: "villa-private-account-writer-v1",
    nextNonce: 124,
    sequence: 1,
    halted: true,
    records: [{ hash: TX_HASH, intentId: "phase3b1b2-wet-f920-20260902-1:0", sessionId: "phase3b1b2-wet-f920-20260902-1", action: "MINT_COMPLETE_SET", account: ACCOUNT, marketId: MARKET, nonce: 123, state: "UNKNOWN", createdAt: 1, updatedAt: 1, receiptBlock: null, receiptStatus: null }],
  }));
  const publicClient = {
    async getTransaction() {
      return { from: OPERATOR, to: ACCOUNT, chainId: 50312, input: encodeFunctionData({ abi: VILLA_ACCOUNT_OPERATOR_ABI, functionName: "operatorMintSet", args: [MARKET, 1000n] }) };
    },
    async getTransactionReceipt() { return { status: "success", blockNumber: 477312009n }; },
    async readContract(request) {
      if (request.functionName === "approvedMarkets") return true;
      if (request.functionName === "isOperator") return true;
      if (request.functionName === "allowance") return 0n;
      throw new Error("unexpected contract read");
    },
    async getBytecode() { return "0x6000"; },
  };
  const sessionId = "phase3b1b2-wet-f920-20260902-1";
  let released = false;
  const result = await runPrivateLpOneShotEntry({
    env: {
      VILLA_ENGINE_ACCOUNT: ACCOUNT,
      VILLA_ENGINE_OWNER: OWNER,
      VILLA_ENGINE_OPERATOR: OPERATOR,
      VILLA_ENGINE_CHAIN_ID: "50312",
      VILLA_ENGINE_MARKET_ID: MARKET,
      VILLA_ENGINE_MARKET_SERIES: "BINARY:BTC:86400",
      VILLA_ENGINE_MARKET_INTERVAL_SEC: "86400",
      VILLA_ENGINE_SESSION_ID: sessionId,
      VILLA_EXECUTION_MODE: "WET",
      VILLA_EXECUTION_ENABLED: "false",
      CREDENTIALS_DIRECTORY: "private-test",
      VILLA_WRITER_JOURNAL: journalPath,
    },
    args: { oneCycle: true, account: ACCOUNT, sessionId, marketId: MARKET },
    dependencies: {
      publicClient,
      exchange: { async close() {} },
      adapter: fixtureAdapter(sessionId),
      accountState: accountState(),
      feasibility: feasibility(),
      readCredential: () => "OPERATOR_PRIVATE_KEY=" + TEST_SIGNER_KEY + "\n",
      leaseStore: {
        acquire(session) { return { leaseId: "lease-recovery-test", held: true, account: session.account, owner: session.owner, operator: session.operator, sessionId: session.sessionId }; },
        release() { released = true; },
      },
    },
  });
  assert.equal(result.result, "RECOVERY_READY");
  assert.equal(result.recovery.mint, "ALREADY_CONFIRMED");
  assert.equal(result.recovery.skippedMint, true);
  assert.equal(result.recovery.nextAction, "PLACE_ORDER");
  assert.equal(result.broadcast, false);
  assert.equal(result.writes, 0);
  assert.equal(result.broadcastAttempts, 0);
  assert.deepEqual(result.planActions.map((item) => item.functionName), ["operatorPlaceOrder", "operatorCancelOrder", "operatorBurnSet"]);
  assert.equal(released, true);
  const reconciled = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  assert.equal(reconciled.records[0].state, "CONFIRMED");
  assert.equal(reconciled.records[0].amountRaw, "1000");
  assert.equal(reconciled.records[0].receiptBlock, "477312009");
});
