import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeFunctionData } from "viem";
import { VILLA_ACCOUNT_CONFIG } from "../../dashboard/account-config.mjs";
import { createLpExecutionAdapter, VILLA_ACCOUNT_OPERATOR_ABI } from "./lp-adapter.mjs";
import { createFileAccountLeaseStore } from "./lp-session.mjs";
import { LP_CLEANUP_SCOPE, parsePrivateCleanupArgs, runPrivateLpCleanup } from "./lp-private-cleanup.mjs";

const ACCOUNT = LP_CLEANUP_SCOPE.account;
const OWNER = LP_CLEANUP_SCOPE.owner;
const OPERATOR = LP_CLEANUP_SCOPE.operator;
const MARKET = LP_CLEANUP_SCOPE.marketId;
const POOL = "0x1111111111111111111111111111111111111111";
const OUTCOME = "0x2222222222222222222222222222222222222222";
const MODULE = "0x3333333333333333333333333333333333333333";
const SETTLEMENT = "0x4444444444444444444444444444444444444444";
const TX_HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION = "phase3b1b2.2-test";

function makeFixture({ enabled = false, simulateBurn = null } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "villa-cleanup-test-"));
  const journalPath = path.join(directory, "transactions.json");
  fs.writeFileSync(journalPath, JSON.stringify({ version: "villa-private-account-writer-v1", nextNonce: 0, sequence: 1, halted: false, records: [{ hash: LP_CLEANUP_SCOPE.priorMintHash, sessionId: "prior-mint", action: "MINT_COMPLETE_SET", account: ACCOUNT, marketId: MARKET, amountRaw: "1000", state: "CONFIRMED", receiptStatus: 1, receiptBlock: "122" }] }));
  const leaseStore = createFileAccountLeaseStore({ directory, leaseDurationMs: 30_000 });
  let burned = false;
  let walletWrites = 0;
  let simulations = 0;
  const identity = {
    account: ACCOUNT,
    owner: OWNER,
    operator: OPERATOR,
    collateralToken: VILLA_ACCOUNT_CONFIG.collateralToken,
    outcomeToken: OUTCOME,
    binaryModule: MODULE,
    binarySettlement: SETTLEMENT,
    maxOrderQuantity: 1_000_000n,
    maxOrderCollateral: 1_000_000n,
  };
  const reader = {
    readAccountIdentity: async () => ({ ...identity }),
    readMarket: async ({ account, marketId }) => ({ account, marketId: MARKET, collateral: identity.collateralToken, market: "0x5555555555555555555555555555555555555555", pool: POOL, yesId: 11n, noId: 12n, tradingStart: 1n, expiry: 1_000n }),
    readCapital: async ({ account, marketId }) => ({ account, collateralToken: identity.collateralToken, directCollateralRaw: burned ? 1_002_000n : 1_001_000n, vaultRaw: 0n, marketId, pool: POOL }),
    readOutcomeInventory: async ({ account, marketId }) => ({ account, marketId: MARKET, yesId: 11n, noId: 12n, yesRaw: burned ? 0n : 1_000n, noRaw: burned ? 0n : 1_000n }),
    readOrders: async ({ account, marketId }) => ({ account, marketId: MARKET, status: "VERIFIED", orders: [] }),
  };
  const adapter = createLpExecutionAdapter({ account: ACCOUNT, owner: OWNER, operator: OPERATOR, reader, sessionId: SESSION });
  const publicClient = {
    getBytecode: async () => "0x6000",
    getBlock: async () => ({ timestamp: 2_000n }),
    getTransactionCount: async () => 0,
    readContract: async ({ functionName }) => functionName === "allowance" ? 0n : true,
    simulateContract: async (request) => {
      simulations += 1;
      if (simulateBurn) return simulateBurn(request);
      return { request };
    },
    getTransaction: async ({ hash }) => {
      const functionName = hash === LP_CLEANUP_SCOPE.priorMintHash ? "operatorMintSet" : "operatorBurnSet";
      const args = functionName === "operatorMintSet" ? [MARKET, 1_000n] : [MARKET, 1_000n];
      return { from: OPERATOR, to: ACCOUNT, chainId: 50312, input: encodeFunctionData({ abi: VILLA_ACCOUNT_OPERATOR_ABI, functionName, args }) };
    },
    getTransactionReceipt: async () => ({ status: 1, blockNumber: 123n }),
  };
  const walletClient = {
    writeContract: async ({ functionName, args }) => {
      assert.equal(functionName, "operatorBurnSet");
      assert.deepEqual(args, [MARKET, 1_000n]);
      walletWrites += 1;
      burned = true;
      return TX_HASH;
    },
    waitForTransactionReceipt: async ({ hash }) => {
      assert.equal(hash, TX_HASH);
      return { status: 1, blockNumber: 123n };
    },
  };
  const exchange = { client: { getMarketOnchain: async () => ({ marketId: MARKET, pool: POOL, status: 4, isResolved: true, isVoided: false, expiry: 1_000n }) }, close: async () => undefined };
  const env = {
    VILLA_EXECUTION_ENABLED: enabled ? "true" : "false",
    VILLA_EXECUTION_MODE: "WET",
    VILLA_ENGINE_ACCOUNT: ACCOUNT,
    VILLA_ENGINE_OWNER: OWNER,
    VILLA_ENGINE_OPERATOR: OPERATOR,
    VILLA_ENGINE_CHAIN_ID: "50312",
    VILLA_ENGINE_MARKET_ID: MARKET,
    VILLA_ENGINE_SESSION_ID: SESSION,
    VILLA_WRITER_JOURNAL: journalPath,
    VILLA_LEASE_DIR: directory,
  };
  const dependencies = { adapter, reader, publicClient, walletClient, exchange, leaseStore, signerInfo: { address: OPERATOR, signer: { address: OPERATOR } }, chainNowSec: 2_000 };
  return { env, args: { confirmCleanup: true }, dependencies, directory, get walletWrites() { return walletWrites; }, get simulations() { return simulations; }, get burned() { return burned; } };
}

function cleanup(fixture) {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

test("cleanup parser requires explicit confirmation and rejects generic writes", () => {
  assert.equal(parsePrivateCleanupArgs([]).confirmCleanup, false);
  assert.throws(() => parsePrivateCleanupArgs(["--confirm-cleanup", "--place-order=anything"]), { code: "ARBITRARY_TRANSACTION_ARGUMENT" });
});

test("dry cleanup proves exact scope and simulation without a writer call", async () => {
  const fixture = makeFixture();
  try {
    const result = await runPrivateLpCleanup(fixture);
    assert.equal(result.result, "CLEANUP_READY");
    assert.equal(result.broadcast, false);
    assert.equal(result.writes, 0);
    assert.equal(result.action, "operatorBurnSet");
    assert.equal(result.amountRaw, 1_000n);
    assert.equal(fixture.walletWrites, 0);
    assert.equal(fixture.simulations, 2);
    assert.equal(fixture.dependencies.leaseStore.has(ACCOUNT), false);
  } finally {
    cleanup(fixture);
  }
});

test("enabled cleanup broadcasts exactly one confirmed account-bound burn and reconciles zero inventory", async () => {
  const fixture = makeFixture({ enabled: true });
  try {
    const result = await runPrivateLpCleanup(fixture);
    assert.equal(result.result, "COMPLETED");
    assert.equal(result.broadcast, true);
    assert.equal(result.writes, 1);
    assert.equal(result.burn.hash, TX_HASH);
    assert.equal(result.burn.receiptStatus, 1);
    assert.equal(result.final.collateralRaw, 1_002_000n);
    assert.equal(result.final.yesRaw, 0n);
    assert.equal(result.final.noRaw, 0n);
    assert.equal(result.final.openOrders, 0);
    assert.equal(fixture.walletWrites, 1);
    assert.equal(fixture.dependencies.leaseStore.has(ACCOUNT), false);
  } finally {
    cleanup(fixture);
  }
});

test("burn simulation failure blocks before the writer and leaves the lease unheld", async () => {
  const fixture = makeFixture({ enabled: true, simulateBurn: () => { throw Object.assign(new Error("execution reverted: market state"), { code: "SIMULATION_REVERT" }); } });
  try {
    await assert.rejects(() => runPrivateLpCleanup(fixture), { code: "SIMULATION_REVERT" });
    assert.equal(fixture.walletWrites, 0);
    assert.equal(fixture.dependencies.leaseStore.has(ACCOUNT), false);
  } finally {
    cleanup(fixture);
  }
});

test("MarketNotCurrent simulation is reported as a burn-unavailable protocol block", async () => {
  const fixture = makeFixture({ enabled: true, simulateBurn: () => { throw new Error("execution reverted with selector 0xe45efb5f"); } });
  try {
    await assert.rejects(() => runPrivateLpCleanup(fixture), { code: "BURN_UNAVAILABLE" });
    assert.equal(fixture.walletWrites, 0);
  } finally {
    cleanup(fixture);
  }
});

test("cleanup source contains no normal mint/order/redeem operation path", () => {
  const source = fs.readFileSync(new URL("./lp-private-cleanup.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /operatorMintSet|operatorPlaceOrder|operatorCancelOrder|operatorRedeem|operatorClaimVault/);
  assert.match(source, /operatorBurnSet/);
});
