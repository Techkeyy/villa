import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeFunctionData } from "viem";
import { VILLA_ACCOUNT_CONFIG } from "../../dashboard/account-config.mjs";
import { createLpExecutionAdapter, VILLA_ACCOUNT_OPERATOR_ABI } from "./lp-adapter.mjs";
import { createFileAccountLeaseStore } from "./lp-session.mjs";
import {
  LP_REDEEM_CLEANUP_SCOPE,
  deriveRedeemClaim,
  parsePrivateLpRedeemCleanupArgs,
  runPrivateLpRedeemCleanup,
} from "./lp-private-redeem-cleanup.mjs";

const ACCOUNT = LP_REDEEM_CLEANUP_SCOPE.account;
const OWNER = LP_REDEEM_CLEANUP_SCOPE.owner;
const OPERATOR = LP_REDEEM_CLEANUP_SCOPE.operator;
const MARKET = LP_REDEEM_CLEANUP_SCOPE.marketId;
const POOL = "0x1111111111111111111111111111111111111111";
const OUTCOME = "0x2222222222222222222222222222222222222222";
const MODULE = "0x3333333333333333333333333333333333333333";
const SETTLEMENT = "0x4444444444444444444444444444444444444444";
const MARKET_CONTRACT = "0x5555555555555555555555555555555555555555";
const TX_HASH = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function makeFixture({ enabled = false, simulateRedeem = null, alreadyRedeemed = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "villa-redeem-test-"));
  const journalPath = path.join(directory, "transactions.json");
  const records = [{
    hash: LP_REDEEM_CLEANUP_SCOPE.priorMintHash,
    sessionId: "prior-mint",
    action: "MINT_COMPLETE_SET",
    account: ACCOUNT,
    marketId: MARKET,
    amountRaw: "1000",
    state: "CONFIRMED",
    receiptStatus: 1,
    receiptBlock: "122",
  }];
  if (alreadyRedeemed) records.push({
    hash: TX_HASH,
    sessionId: "prior-redeem",
    action: "REDEEM_RESOLVED",
    account: ACCOUNT,
    marketId: MARKET,
    amountRaw: "1000",
    state: "CONFIRMED",
    receiptStatus: 1,
    receiptBlock: "123",
  });
  fs.writeFileSync(journalPath, JSON.stringify({
    version: "villa-private-account-writer-v1",
    nextNonce: 0,
    sequence: 1,
    halted: false,
    records,
  }));
  const leaseStore = createFileAccountLeaseStore({ directory, leaseDurationMs: 30_000 });
  let redeemed = alreadyRedeemed;
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
    readMarket: async ({ account, marketId }) => ({
      account,
      marketId: MARKET,
      collateral: identity.collateralToken,
      market: MARKET_CONTRACT,
      pool: POOL,
      yesId: 11n,
      noId: 12n,
      tradingStart: 1n,
      expiry: 1_000n,
    }),
    readCapital: async ({ account, marketId }) => ({
      account,
      collateralToken: identity.collateralToken,
      directCollateralRaw: redeemed ? 1_002_000n : 1_001_000n,
      vaultRaw: 0n,
      marketId,
      pool: POOL,
    }),
    readOutcomeInventory: async ({ account, marketId }) => ({
      account,
      marketId: MARKET,
      yesId: 11n,
      noId: 12n,
      yesRaw: 1_000n,
      noRaw: redeemed ? 0n : 1_000n,
    }),
    readOrders: async ({ account, marketId }) => ({ account, marketId: MARKET, status: "VERIFIED", orders: [] }),
  };
  const adapter = createLpExecutionAdapter({
    account: ACCOUNT,
    owner: OWNER,
    operator: OPERATOR,
    reader,
    sessionId: "phase3b1b2.3-test",
  });
  const publicClient = {
    getChainId: async () => 50312,
    getBytecode: async () => "0x6000",
    getBlock: async () => ({ timestamp: 2_000n }),
    getTransactionCount: async () => 0,
    readContract: async ({ functionName }) => functionName === "allowance" ? 0n : true,
    simulateContract: async (request) => {
      simulations += 1;
      if (simulateRedeem) return simulateRedeem(request);
      return { request };
    },
    getTransaction: async ({ hash }) => {
      const functionName = hash === LP_REDEEM_CLEANUP_SCOPE.priorMintHash ? "operatorMintSet" : "operatorRedeem";
      const args = functionName === "operatorMintSet" ? [MARKET, 1_000n] : [MARKET, 1, 1_000n];
      return {
        from: OPERATOR,
        to: ACCOUNT,
        chainId: 50312,
        input: encodeFunctionData({ abi: VILLA_ACCOUNT_OPERATOR_ABI, functionName, args }),
      };
    },
    getTransactionReceipt: async () => ({ status: 1, blockNumber: 123n }),
  };
  const walletClient = {
    writeContract: async ({ functionName, args }) => {
      assert.equal(functionName, "operatorRedeem");
      assert.deepEqual(args, [MARKET, 1n, 1_000n]);
      walletWrites += 1;
      redeemed = true;
      return TX_HASH;
    },
    waitForTransactionReceipt: async ({ hash }) => {
      assert.equal(hash, TX_HASH);
      return { status: 1, blockNumber: 123n };
    },
  };
  const env = {
    VILLA_EXECUTION_ENABLED: enabled ? "true" : "false",
    VILLA_EXECUTION_MODE: "WET",
    VILLA_ENGINE_ACCOUNT: ACCOUNT,
    VILLA_ENGINE_OWNER: OWNER,
    VILLA_ENGINE_OPERATOR: OPERATOR,
    VILLA_ENGINE_CHAIN_ID: "50312",
    VILLA_ENGINE_MARKET_ID: MARKET,
    VILLA_ENGINE_SESSION_ID: "phase3b1b2.3-test",
    VILLA_WRITER_JOURNAL: journalPath,
    VILLA_LEASE_DIR: directory,
  };
  const dependencies = {
    adapter,
    reader,
    publicClient,
    walletClient,
    leaseStore,
    signerInfo: { address: OPERATOR, signer: { address: OPERATOR } },
    accountMarket: {
      account: ACCOUNT,
      marketId: MARKET,
      collateral: VILLA_ACCOUNT_CONFIG.collateralToken,
      market: MARKET_CONTRACT,
      pool: POOL,
      yesId: 11n,
      noId: 12n,
      tradingStart: 1n,
      expiry: 1_000n,
    },
    settlement: { status: 4, isResolved: true, isVoided: false, payoutNumerators: [0n, 10_000_000n] },
    protocol: { marketApproved: true, moduleOperator: true, poolOperator: true, collateralAllowance: 0n },
    chainNowSec: 2_000,
    bytecode: "0x6000",
  };
  return {
    env,
    args: { confirmRedeem: true },
    dependencies,
    directory,
    get walletWrites() { return walletWrites; },
    get simulations() { return simulations; },
  };
}

function cleanup(fixture) {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

test("redeem parser requires explicit confirmation and rejects generic writes", () => {
  assert.equal(parsePrivateLpRedeemCleanupArgs([]).confirmRedeem, false);
  assert.throws(() => parsePrivateLpRedeemCleanupArgs(["--confirm-redeem", "--withdraw=1000"]), { code: "ARBITRARY_TRANSACTION_ARGUMENT" });
});

test("resolved payout vector selects the NO claim and exact expected return", () => {
  const claim = deriveRedeemClaim({
    status: 4,
    isResolved: true,
    isVoided: false,
    payoutNumerators: [0n, 10_000_000n],
    yesRaw: 1_000n,
    noRaw: 1_000n,
  });
  assert.equal(claim.outcomeIdx, 1);
  assert.equal(claim.amountRaw, 1_000n);
  assert.equal(claim.redeemableYesValueRaw, 0n);
  assert.equal(claim.redeemableNoValueRaw, 1_000n);
});

test("voided settlement remains distinct and derives its vector payout", () => {
  const claim = deriveRedeemClaim({
    status: 5,
    isResolved: false,
    isVoided: true,
    payoutNumerators: [5_000_000n, 5_000_000n],
    yesRaw: 1_000n,
    noRaw: 1_000n,
  });
  assert.equal(claim.lifecycle.resolution, "VOIDED");
  assert.equal(claim.outcomeIdx, 1);
  assert.equal(claim.redeemableYesValueRaw, 500n);
  assert.equal(claim.redeemableNoValueRaw, 500n);
});

test("dry redeem proves exact account-bound plan and simulation without a writer call", async () => {
  const fixture = makeFixture();
  try {
    const result = await runPrivateLpRedeemCleanup(fixture);
    assert.equal(result.result, "REDEEM_READY");
    assert.equal(result.broadcast, false);
    assert.equal(result.writes, 0);
    assert.equal(result.action, "operatorRedeem");
    assert.equal(result.outcomeIdx, 1);
    assert.equal(result.expectedCollateralReturnRaw, 1_000n);
    assert.equal(fixture.walletWrites, 0);
    assert.equal(fixture.simulations, 2);
    assert.equal(fixture.dependencies.leaseStore.has(ACCOUNT), false);
  } finally {
    cleanup(fixture);
  }
});

test("enabled redeem broadcasts exactly one transaction and reconciles chain truth", async () => {
  const fixture = makeFixture({ enabled: true });
  try {
    const result = await runPrivateLpRedeemCleanup(fixture);
    assert.equal(result.result, "COMPLETED");
    assert.equal(result.broadcast, true);
    assert.equal(result.writes, 1);
    assert.equal(result.redeem.hash, TX_HASH);
    assert.equal(result.redeem.receiptStatus, 1);
    assert.equal(result.final.collateralRaw, 1_002_000n);
    assert.equal(result.final.yesRaw, 1_000n);
    assert.equal(result.final.noRaw, 0n);
    assert.equal(fixture.walletWrites, 1);
    assert.equal(fixture.dependencies.leaseStore.has(ACCOUNT), false);
  } finally {
    cleanup(fixture);
  }
});

test("simulation failure blocks before the writer", async () => {
  const fixture = makeFixture({
    enabled: true,
    simulateRedeem: () => { throw Object.assign(new Error("execution reverted: claim unavailable"), { code: "SIMULATION_REVERT" }); },
  });
  try {
    await assert.rejects(() => runPrivateLpRedeemCleanup(fixture), { code: "SIMULATION_REVERT" });
    assert.equal(fixture.walletWrites, 0);
    assert.equal(fixture.dependencies.leaseStore.has(ACCOUNT), false);
  } finally {
    cleanup(fixture);
  }
});

test("duplicate redemption provenance is denied before simulation", async () => {
  const fixture = makeFixture({ alreadyRedeemed: true });
  try {
    await assert.rejects(() => runPrivateLpRedeemCleanup(fixture), { code: "REDEEM_ALREADY_RECORDED" });
    assert.equal(fixture.walletWrites, 0);
    assert.equal(fixture.simulations, 0);
  } finally {
    cleanup(fixture);
  }
});

test("redeem cleanup source contains no alternate write operation path", () => {
  const source = fs.readFileSync(new URL("./lp-private-redeem-cleanup.mjs", import.meta.url), "utf8");
  assert.match(source, /operatorRedeem/);
  assert.doesNotMatch(source, /operatorMintSet|operatorPlaceOrder|operatorCancelOrder|operatorBurnSet|operatorClaimVault|withdraw\(/);
});
