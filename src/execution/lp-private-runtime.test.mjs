import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createLpExecutionAdapter } from "./lp-adapter.mjs";
import { runPrivateLpOneShotEntry } from "./lp-private-runtime-entry.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const MARKET = "0x000000000000000000000000000000000000000000000000000000000000f920";
const POOL = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
const MODULE = "0x6666666666666666666666666666666666666666";

function fixtureAdapter(sessionId, operator) {
  const reader = {
    async readAccountIdentity({ account }) { return { account, owner: OWNER, operator, collateralToken: TOKEN, outcomeToken: TOKEN, binaryModule: MODULE, binarySettlement: TOKEN, maxOrderQuantity: 1000n, maxOrderCollateral: 1000n }; },
    async readCapital({ account, marketId }) { return { account, directCollateralRaw: 1_002_000n, vaultRaw: 0n, marketId, pool: POOL }; },
    async readOutcomeInventory({ account, marketId }) { return { account, marketId, yesRaw: 0n, noRaw: 0n }; },
    async readOrders({ account, marketId }) { return { account, marketId, status: "VERIFIED", orders: [] }; },
    async readMarket({ account, marketId }) { return { account, marketId, collateral: TOKEN, market: TOKEN, pool: POOL, yesId: 1n, noId: 2n, tradingStart: 1n, expiry: 9_000_000_000n }; },
  };
  const adapter = createLpExecutionAdapter({ account: ACCOUNT, owner: OWNER, operator, reader, sessionId });
  return Object.freeze({ ...adapter, readMarket: (input) => reader.readMarket({ ...input, account: ACCOUNT }) });
}

function feasibility(operator) {
  return {
    result: "PASS",
    account: ACCOUNT,
    owner: OWNER,
    operator,
    market: { marketId: MARKET, series: "BINARY:BTC:86400", intervalSec: 86400, expirySec: 9_000_000_000, headroomSec: 8_000_000 },
    mintSearch: { smallestViableMintRaw: "1000" },
    sellAfterMint: { viable: true, quotePlan: { ask: { enabled: true, action: "SELL_YES", targetPriceRaw: "29000", targetQuantityRaw: "1000" } } },
    recommendation: { path: "B" },
    shadow: { result: "PASS", account: ACCOUNT, owner: OWNER, operator, market: { onchain: { pool: POOL } }, risk: { state: "ALLOW", governorVersion: "risk-test" }, riskSnapshot: { market: { status: 1 } } },
  };
}

test("private runtime dry one-shot reaches the writer boundary with zero broadcasts", async () => {
  const privateKey = generatePrivateKey();
  const signer = privateKeyToAccount(privateKey);
  const journalPath = path.join(os.tmpdir(), `villa-private-runtime-test-${process.pid}.json`);
  const operator = signer.address;
  const sessionId = "dry-runtime-test";
  const adapter = fixtureAdapter(sessionId, operator);
  const identity = { account: ACCOUNT, owner: OWNER, operator, collateralToken: TOKEN, outcomeToken: TOKEN, binaryModule: MODULE, binarySettlement: TOKEN, maxOrderQuantity: 1000n, maxOrderCollateral: 1000n };
  const accountState = { account: ACCOUNT, owner: OWNER, operator, identity, capital: { account: ACCOUNT, directCollateralRaw: 1_002_000n, vaultRaw: 0n, marketId: MARKET, pool: POOL }, inventory: { account: ACCOUNT, marketId: MARKET, yesRaw: 0n, noRaw: 0n }, orders: { account: ACCOUNT, marketId: MARKET, status: "VERIFIED", orders: [] } };
  const publicClient = {
    async readContract(request) { if (request.functionName === "approvedMarkets") return true; if (request.functionName === "isOperator") return true; if (request.functionName === "allowance") return 0n; throw new Error(`unexpected ${request.functionName}`); },
    async getBytecode() { return "0x6000"; },
  };
  let released = false;
  const result = await runPrivateLpOneShotEntry({
    env: { VILLA_ENGINE_ACCOUNT: ACCOUNT, VILLA_ENGINE_OWNER: OWNER, VILLA_ENGINE_OPERATOR: operator, VILLA_ENGINE_CHAIN_ID: "50312", VILLA_ENGINE_MARKET_ID: MARKET, VILLA_ENGINE_MARKET_SERIES: "BINARY:BTC:86400", VILLA_ENGINE_MARKET_INTERVAL_SEC: "86400", VILLA_ENGINE_SESSION_ID: sessionId, VILLA_EXECUTION_MODE: "WET", VILLA_EXECUTION_ENABLED: "false", CREDENTIALS_DIRECTORY: "private-test", VILLA_WRITER_JOURNAL: journalPath },
    args: { oneCycle: true, account: ACCOUNT, sessionId, marketId: MARKET },
    dependencies: {
      publicClient,
      exchange: { async close() {} },
      adapter,
      accountState,
      feasibility: feasibility(operator),
      readCredential: () => `OPERATOR_PRIVATE_KEY=${privateKey}\n`,
      leaseStore: { acquire() { return { leaseId: "lease-test", account: ACCOUNT, owner: OWNER, operator, sessionId }; }, release() { released = true; } },
    },
  });
  assert.equal(result.result, "DRY_READY");
  assert.deepEqual(result.preflight.blockers, ["EXECUTION_DISABLED"]);
  assert.equal(result.broadcastAttempts, 0);
  assert.equal(result.writes, 0);
  assert.deepEqual(result.planActions.map((item) => item.functionName), ["operatorMintSet", "operatorPlaceOrder", "operatorCancelOrder", "operatorBurnSet"]);
  assert.equal(released, true);
});
