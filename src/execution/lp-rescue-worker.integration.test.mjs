import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { createAccountLeaseStore } from "./lp-session.mjs";
import { VILLA_ACCOUNT_CONFIG } from "../../dashboard/account-config.mjs";

// Execute the actual worker entry point. External I/O, signing and the typed
// transaction boundary are mocked; governor, planner, preflight, heartbeat and
// cleanup run. Separate writer/policy suites cover transaction validation.
// No private signer, real wallet client, network, or production state is used.
const account = "0x1111111111111111111111111111111111111111";
const owner = "0x2222222222222222222222222222222222222222";
const operator = "0x3333333333333333333333333333333333333333";
const marketId = "0x" + "aa".repeat(32);
const pool = "0x4444444444444444444444444444444444444444";
const entry = new URL("../../scripts/lp-account-session.mjs", import.meta.url);
const workerTest = (name, options, fn) => test(name, { ...options, skip: typeof vm.SourceTextModule !== "function" ? "Run with --experimental-vm-modules for worker integration" : false }, fn);

async function runWorker(mode) {
  const messages = [], writes = [], handlers = new Map();
  const leases = createAccountLeaseStore();
  let reads = 0, yesRaw = 0n, noRaw = 0n, orders = [];
  const fakeProcess = {
    env: { VILLA_UAT_SESSION_EXECUTION: "true", VILLA_ACCOUNT_EXECUTION_ENABLED: "true", VILLA_EXECUTION_MODE: "WET", VILLA_ENGINE_SESSION_ID: "uat-1000-aaaaaaaa", VILLA_ENGINE_OWNER: owner, VILLA_ENGINE_ACCOUNT: account, VILLA_ENGINE_OPERATOR: operator },
    on(name, fn) { handlers.set(name, fn); }, once(name, fn) { handlers.set(name, fn); },
    send(message) { messages.push(message); }, exit(code) { this.exitCode = code; }, exitCode: 0,
  };
  const stop = () => handlers.get("message")?.({ type: "stop", reason: "OWNER_STOP" });
  const identity = { account, owner, operator, accountVersion: 2, version: 2, autonomousTradingEnabled: true,
    collateralToken: VILLA_ACCOUNT_CONFIG.collateralToken, outcomeToken: VILLA_ACCOUNT_CONFIG.outcomeToken,
    binaryModule: VILLA_ACCOUNT_CONFIG.binaryModule, binarySettlement: VILLA_ACCOUNT_CONFIG.binarySettlement,
    maxOrderQuantity: 1000n, maxOrderCollateral: 1000n, maxAggregateExposure: 1000000n, maxMintExposure: 1000000n, aggregateExposure: 0n, mintExposure: 0n };
  const accountState = () => ({ account, owner, operator, identity,
    capital: { account, directCollateralRaw: 55000000n, vaultRaw: 0n },
    inventory: { account, marketId, yesId: 11n, noId: 12n, yesRaw, noRaw },
    orders: { account, marketId, status: "VERIFIED", orders: structuredClone(orders) },
  });
  const adapter = {
    readAccountIdentity: async () => identity,
    readAccountState: async () => accountState(),
    readMarket: async () => ({ marketId, market: pool, pool, yesId: 11n, noId: 12n }),
    prepareMarket: (args) => ({ action: "prepare", ...args }),
    mintCompleteSet: (args) => ({ action: "mint", ...args }),
    placeOrder: (args) => ({ ...args, action: "place" }),
    cancelOrder: (args) => ({ action: "cancel", ...args }),
    burnCompleteSet: (args) => ({ action: "burn", ...args }),
  };
  const publicClient = { readContract: async ({ functionName }) => {
    if (["preparedMarkets", "approvedMarkets", "isOperator"].includes(functionName)) return true;
    if (functionName === "allowance") return 0n;
    if (functionName === "status") return 1;
    if (["isResolved", "isVoided"].includes(functionName)) return false;
    if (functionName === "payoutNumerators") return [0n, 0n];
    throw new Error("unexpected contract read " + functionName);
  } };
  const chainTime = { chainNowSec: 1000, observationAgeSec: 0, blockNumber: 1, localNowMs: 1000000, observedAtLocalMs: 1000000, clockOffsetSec: 0 };
  const exchange = { client: { getBinaryBookParams: async () => ({ minQuantity: 1000n, lotSize: 1000n, tickSize: 1000n }) },
    fetchOrderBook: async () => mode === "empty" ? { bids: [], asks: [] } : { bids: [[0.5, 1]], asks: [[0.7, 1]] }, close: async () => {},
  };
  const live = async () => {
    reads += 1;
    if (["missing-fresh", "stop-missing"].includes(mode) && reads === 1) {
      if (mode === "stop-missing") stop();
      throw Object.assign(new Error("no price observation"), { code: "MISSING_SPOT" });
    }
    if (mode === "empty" && reads === 2) stop();
    if (mode === "stop-on-fresh" && reads === 2) stop();
    const stale = ["stale-fresh", "stop-on-fresh"].includes(mode) && reads === 1;
    return { snapshot: {
      fairValue: { modelVersion: "villa-fv-v1", pUp: 0.6, pDown: 0.4, confidence: 0.95, dataQualityStatus: "HIGH", referenceSource: "strike", realizedVolPerSqrtSec: 0.0001 },
      chainTime, feed: { price: 78500, timestampSec: stale ? 980 : 999, sourceAgeSec: 2 },
      market: { status: 1, expirySec: 2000, reference: { status: "VALID", source: "strike", scaleExponent10: 2 } },
      inventory: { yes: Number(yesRaw) / 1000000, no: Number(noRaw) / 1000000 }, openOrdersStatus: "VERIFIED", openOrders: [],
      capital: { collateralAvailable: 55, capitalAtRisk: 0 }, gas: { nativeBalance: mode === "halt" ? 0 : 1 }, drawdown: { status: "AVAILABLE", ratio: 0 },
    }, context: { marketId, market: { info: { intervalSec: 300, baseDecimals: 6, asset: "BTC" }, outcomes: [{ label: "YES", symbol: "BTC/YES" }] }, onchain: { expiry: 2000, pool, status: 1, isResolved: false, isVoided: false } } };
  };
  const overrides = {
    "viem": { createPublicClient: () => publicClient, createWalletClient: () => ({}) },
    "@somnia-chain/markets-sdk": { SomniaMarkets: class { constructor() { return exchange; } } },
    "../src/execution/lp-private-runtime.mjs": { loadPrivateSigner: () => ({ address: operator, signer: { address: operator } }) },
    "../src/execution/lp-session.mjs": { createFileAccountLeaseStore: () => leases },
    "../src/risk-governor/live.mjs": { collectRiskSnapshot: live, readChainTime: async () => { if (writes.includes("place")) stop(); return chainTime; } },
    "../src/execution/lp-adapter.mjs": { createViemLpAccountReader: () => ({}), createLpExecutionAdapter: () => adapter },
    "../src/execution/lp-transaction-policy.mjs": { createLpTransactionPolicy: () => ({ prepare: (plan) => plan, validate: () => ({ allowed: true }) }) },
    "../src/execution/lp-private-writer.mjs": { createAccountBoundPrivateWriter: () => ({ close() {}, enqueue: async (plan) => {
      writes.push(plan.action);
      if (plan.action === "mint") { yesRaw += plan.amountRaw; noRaw += plan.amountRaw; }
      if (plan.action === "place") { yesRaw -= plan.quantityRaw; orders = [{ owner: account, marketId, orderId: 1n, isBid: false, quantityRemainingRaw: plan.quantityRaw, priceRaw: plan.priceRaw }]; }
      if (plan.action === "cancel") { yesRaw += orders[0].quantityRemainingRaw; orders = []; }
      if (plan.action === "burn") { yesRaw -= plan.amountRaw; noRaw -= plan.amountRaw; }
      return { state: "CONFIRMED", hash: "mock-" + writes.length };
    } }) },
  };
  const context = vm.createContext({ process: fakeProcess, console, Date, setTimeout: (fn, ms) => setTimeout(fn, ms === 5000 ? 0 : ms), clearTimeout });
  const modules = new Map();
  async function dependency(specifier) {
    if (modules.has(specifier)) return modules.get(specifier);
    const location = specifier.startsWith(".") ? new URL(specifier, entry).href : specifier;
    const exports = { ...await import(location), ...overrides[specifier] };
    const module = new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
    modules.set(specifier, module);
    await module.link(() => { throw new Error("unexpected synthetic dependency"); });
    await module.evaluate();
    return module;
  }
  const source = new vm.SourceTextModule(await fs.readFile(entry, "utf8"), { context, identifier: entry.href, importModuleDynamically: dependency });
  await source.link(dependency);
  await source.evaluate({ timeout: 10000 });
  return { messages, writes, reads, lease: leases.get(account), exitCode: fakeProcess.exitCode };
}

workerTest("worker empty book -> RUNNING/WAITING -> owner Stop before mint -> clean released session", { timeout: 30000 }, async () => {
  const result = await runWorker("empty");
  assert.equal(result.exitCode, 0, JSON.stringify(result.messages.filter(m => m.type === "error")));
  assert.deepEqual(result.writes, []);
  assert.equal(result.lease, null);
  assert.ok(result.messages.some(m => m.state === "RUNNING" && m.stage?.code === "WAITING_FOR_QUOTE"));
  assert.equal(result.messages.at(-1).state, "STOPPED_CLEAN");
});
workerTest("worker stale price -> wait -> fresh data -> quote -> Stop and clean", { timeout: 15000 }, async () => {
  const result = await runWorker("stale-fresh");
  assert.equal(result.exitCode, 0, JSON.stringify(result.messages.filter(m => m.type === "error")));
  assert.ok(result.messages.some(m => m.state === "RUNNING" && m.stage?.code === "WAITING_FOR_FRESH_PRICE"));
  assert.deepEqual(result.writes, ["mint", "place", "cancel", "burn"]);
  assert.equal(result.lease, null);
  assert.equal(result.messages.at(-1).state, "STOPPED_CLEAN");
});
workerTest("worker fresh quote preserves initial execution and Stop path", { timeout: 15000 }, async () => {
  const result = await runWorker("fresh");
  assert.equal(result.exitCode, 0, JSON.stringify(result.messages.filter(m => m.type === "error")));
  assert.deepEqual(result.writes, ["mint", "place", "cancel", "burn"]);
  assert.equal(result.lease, null);
});
workerTest("worker genuine gas HALT remains terminal without writes", { timeout: 15000 }, async () => {
  const result = await runWorker("halt");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.writes, []);
  assert.ok(result.messages.some(m => m.type === "error" && m.code === "PROJECTED_RISK_HALT"));
});
workerTest("Stop arriving during fresh-data reevaluation does not mint or place", { timeout: 15000 }, async () => {
  const result = await runWorker("stop-on-fresh");
  assert.equal(result.exitCode, 0, JSON.stringify(result.messages.filter(m => m.type === "error")));
  assert.deepEqual(result.writes, []);
  assert.equal(result.lease, null);
  assert.equal(result.messages.at(-1).state, "STOPPED_CLEAN");
  assert.equal(result.messages.find(m => m.type === "result").result.ordersPlaced, 0);
});
workerTest("worker missing upstream price waits then resumes without premature failure", { timeout: 15000 }, async () => {
  const result = await runWorker("missing-fresh");
  assert.equal(result.exitCode, 0, JSON.stringify(result.messages.filter(m => m.type === "error")));
  assert.ok(result.messages.some(m => m.state === "RUNNING" && m.stage?.code === "WAITING_FOR_FRESH_PRICE"));
  assert.deepEqual(result.writes, ["mint", "place", "cancel", "burn"]);
});
workerTest("Stop during initial missing price exits without writer or lease", { timeout: 15000 }, async () => {
  const result = await runWorker("stop-missing");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.writes, []);
  assert.equal(result.lease, null);
  assert.equal(result.messages.at(-1).state, "STOPPED");
});
