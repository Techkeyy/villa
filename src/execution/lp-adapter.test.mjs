import assert from "node:assert/strict";
import test from "node:test";
import { decodeFunctionData } from "viem";
import {
  ERC20_BALANCE_ABI,
  ERC6909_BALANCE_ABI,
  LP_ADAPTER_FORBIDDEN_OPERATIONS,
  LP_EXECUTION_ADAPTER_VERSION,
  LP_EXECUTION_MODE,
  VILLA_ACCOUNT_OPERATOR_ABI,
  VILLA_ACCOUNT_READ_ABI,
  VILLA_POOL_READ_ABI,
  createLpExecutionAdapter,
  createViemLpAccountReader,
} from "./lp-adapter.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN = "0x4444444444444444444444444444444444444444";
const POOL = "0x5555555555555555555555555555555555555555";

function readerFixture(calls = []) {
  return {
    async readAccountIdentity(input) {
      calls.push(["identity", input]);
      return { account: input.account, owner: OWNER, operator: OPERATOR, collateralToken: TOKEN, outcomeToken: TOKEN, binaryModule: TOKEN, binarySettlement: TOKEN, maxOrderQuantity: 1000n, maxOrderCollateral: 1000n };
    },
    async readCapital(input) {
      calls.push(["capital", input]);
      return { account: input.account, directCollateralRaw: 2_000_000n, vaultRaw: 0n, collateralAvailableRaw: 2_000_000n, marketId: input.marketId ?? null, pool: POOL };
    },
    async readOutcomeInventory(input) {
      calls.push(["inventory", input]);
      return { account: input.account, marketId: input.marketId, yesRaw: 1000n, noRaw: 1000n };
    },
    async readOrders(input) {
      calls.push(["orders", input]);
      return { account: input.account, marketId: input.marketId, status: "VERIFIED", orders: [] };
    },
  };
}

function adapter(options = {}) {
  return createLpExecutionAdapter({ account: ACCOUNT, owner: OWNER, operator: OPERATOR, reader: readerFixture(), ...options });
}

test("adapter keeps signer, VillaAccount, and LP owner distinct", () => {
  const value = adapter();
  assert.equal(value.adapterVersion, LP_EXECUTION_ADAPTER_VERSION);
  assert.equal(value.executionMode, LP_EXECUTION_MODE);
  assert.equal(value.account, ACCOUNT);
  assert.equal(value.owner, OWNER);
  assert.equal(value.operator, OPERATOR);
  assert.throws(() => adapter({ owner: ACCOUNT }), { code: "IDENTITY_COLLISION" });
  assert.throws(() => adapter({ operator: ACCOUNT }), { code: "IDENTITY_COLLISION" });
});

test("account reads remain account-scoped across capital, inventory, positions, and orders", async () => {
  const calls = [];
  const value = createLpExecutionAdapter({ account: ACCOUNT, owner: OWNER, operator: OPERATOR, reader: readerFixture(calls) });
  const state = await value.readAccountState({ marketId: MARKET });
  assert.equal(state.account, ACCOUNT);
  assert.equal(state.identity.account, ACCOUNT);
  assert.equal(state.capital.account, ACCOUNT);
  assert.equal(state.inventory.account, ACCOUNT);
  assert.equal(state.orders.account, ACCOUNT);
  assert.equal(state.positions.account, ACCOUNT);
  assert.ok(calls.slice(1).every(([, input]) => input.account === ACCOUNT));
});

test("market-scoped inventory keeps a finalized f920 residual out of a fresh market", async () => {
  const f920 = `0x${"0".repeat(60)}f920`;
  const fresh = `0x${"0".repeat(60)}abcd`;
  const marketRecords = new Map([
    [f920, { collateral: TOKEN, market: TOKEN, pool: POOL, yesId: 11n, noId: 12n, tradingStart: 1n, expiry: 999n }],
    [fresh, { collateral: TOKEN, market: TOKEN, pool: POOL, yesId: 21n, noId: 22n, tradingStart: 1n, expiry: 999n }],
  ]);
  const identityValues = { owner: OWNER, operator: OPERATOR, collateralToken: TOKEN, outcomeToken: TOKEN, binaryModule: TOKEN, binarySettlement: TOKEN, maxOrderQuantity: 1000n, maxOrderCollateral: 1000n };
  const publicClient = {
    async readContract(request) {
      if (identityValues[request.functionName] !== undefined) return identityValues[request.functionName];
      if (request.functionName === "markets") return marketRecords.get(request.args[0]);
      if (request.functionName === "balanceOf") return String(request.args[1]) === "11" ? 1000n : 0n;
      throw new Error(`unexpected read ${request.functionName}`);
    },
  };
  const reader = createViemLpAccountReader({ publicClient });
  const historical = await reader.readOutcomeInventory({ account: ACCOUNT, marketId: f920 });
  const current = await reader.readOutcomeInventory({ account: ACCOUNT, marketId: fresh });
  assert.deepEqual({ yesRaw: historical.yesRaw, noRaw: historical.noRaw, yesId: historical.yesId, noId: historical.noId }, { yesRaw: 1000n, noRaw: 0n, yesId: 11n, noId: 12n });
  assert.deepEqual({ yesRaw: current.yesRaw, noRaw: current.noRaw, yesId: current.yesId, noId: current.noId }, { yesRaw: 0n, noRaw: 0n, yesId: 21n, noId: 22n });
});
test("mismatched reader data fails closed", async () => {
  const badReader = readerFixture();
  badReader.readCapital = async () => ({ account: OWNER, directCollateralRaw: 1n });
  const value = createLpExecutionAdapter({ account: ACCOUNT, owner: OWNER, operator: OPERATOR, reader: badReader });
  await assert.rejects(() => value.readCapital(), { code: "ACCOUNT_SCOPE_MISMATCH" });
});

test("place-order plan targets the VillaAccount and identifies the signer separately", () => {
  const value = adapter();
  const plan = value.placeOrder({ marketId: MARKET, action: "BUY_YES", priceRaw: 500_000n, quantityRaw: 1000n, expireTimestampNs: 123n });
  const decoded = decodeFunctionData({ abi: VILLA_ACCOUNT_OPERATOR_ABI, data: plan.data });
  assert.equal(plan.to, ACCOUNT);
  assert.equal(plan.orderOwner, ACCOUNT);
  assert.equal(plan.signer, OPERATOR);
  assert.equal(plan.owner, OWNER);
  assert.equal(plan.broadcast, false);
  assert.equal(plan.functionName, "operatorPlaceOrder");
  assert.equal(decoded.functionName, "operatorPlaceOrder");
  assert.equal(decoded.args[0], MARKET);
  assert.equal(decoded.args[1], 0);
  assert.equal(decoded.args[2], 500_000n);
});

test("all engine write intents use explicit VillaAccount methods only", () => {
  const value = adapter();
  const plans = [
    value.placeOrder({ marketId: MARKET, action: "SELL_YES", priceRaw: 600_000n, quantityRaw: 1000n, expireTimestampNs: 123n }),
    value.cancelOrder({ marketId: MARKET, orderId: 7n }),
    value.reduceOrder({ marketId: MARKET, orderId: 7n, newQuantityRemaining: 500n }),
    value.mintCompleteSet({ marketId: MARKET, amountRaw: 1000n }),
    value.burnCompleteSet({ marketId: MARKET, amountRaw: 1000n }),
    value.redeemResolved({ marketId: MARKET, outcomeIdx: 0, amountRaw: 1000n }),
    value.claimVault({ marketId: MARKET, amountRaw: 1000n }),
  ];
  assert.deepEqual(plans.map((plan) => plan.functionName), ["operatorPlaceOrder", "operatorCancelOrder", "operatorReduceOrder", "operatorMintSet", "operatorBurnSet", "operatorRedeem", "operatorClaimVault"]);
  assert.ok(plans.every((plan) => plan.to === ACCOUNT && plan.orderOwner === ACCOUNT && plan.broadcast === false && plan.value === 0n));
  assert.ok(LP_ADAPTER_FORBIDDEN_OPERATIONS.every((name) => !(name in value)));
  assert.ok(plans.every((plan) => !plan.args.some((arg) => typeof arg === "string" && /^0x[0-9a-fA-F]{40}$/.test(arg) && arg.toLowerCase() === OPERATOR.toLowerCase())));
});

test("invalid or stale-shaped order inputs are rejected before a plan exists", () => {
  const value = adapter();
  assert.throws(() => value.placeOrder({ marketId: "stale", action: "BUY_YES", priceRaw: 1n, quantityRaw: 1n, expireTimestampNs: 1n }), { code: "BYTES32_INVALID" });
  assert.throws(() => value.placeOrder({ marketId: MARKET, action: "BUY_YES", priceRaw: 0n, quantityRaw: 1n, expireTimestampNs: 1n }), { code: "RAW_INVALID" });
  assert.throws(() => value.redeemResolved({ marketId: MARKET, outcomeIdx: 2, amountRaw: 1n }), { code: "RAW_INVALID" });
});

test("viem reader passes VillaAccount to on-chain token reads, never the signer", async () => {
  const calls = [];
  const identityValues = { owner: OWNER, operator: OPERATOR, collateralToken: TOKEN, outcomeToken: TOKEN, binaryModule: TOKEN, binarySettlement: TOKEN, maxOrderQuantity: 1000n, maxOrderCollateral: 1000n };
  const publicClient = {
    async readContract(request) {
      calls.push(request);
      if (identityValues[request.functionName] !== undefined) return identityValues[request.functionName];
      if (request.functionName === "balanceOf") return 0n;
      throw new Error(`unexpected read ${request.functionName}`);
    },
  };
  const reader = createViemLpAccountReader({ publicClient });
  const result = await reader.readCapital({ account: ACCOUNT });
  assert.equal(result.account, ACCOUNT);
  const balanceCall = calls.find((request) => request.functionName === "balanceOf");
  assert.deepEqual(balanceCall.args, [ACCOUNT]);
  assert.ok(calls.filter((request) => request.address === ACCOUNT).length >= 8);
  assert.equal(ERC20_BALANCE_ABI.length > 0, true);
  assert.equal(ERC6909_BALANCE_ABI.length > 0, true);
  assert.equal(VILLA_ACCOUNT_READ_ABI.length > 0, true);
  assert.equal(VILLA_POOL_READ_ABI.length > 0, true);
});

test("viem reader rejects an order whose on-chain owner is not the account", async () => {
  const publicClient = {
    async readContract(request) {
      if (request.functionName === "owner") return OWNER;
      if (request.functionName === "operator") return OPERATOR;
      if (request.functionName === "collateralToken" || request.functionName === "outcomeToken" || request.functionName === "binaryModule" || request.functionName === "binarySettlement") return TOKEN;
      if (request.functionName === "maxOrderQuantity" || request.functionName === "maxOrderCollateral") return 1000n;
      if (request.functionName === "markets") return { collateral: TOKEN, market: TOKEN, pool: POOL, yesId: 1n, noId: 2n, tradingStart: 1n, expiry: 999n };
      if (request.functionName === "getOrder") return { orderId: 1n, isBid: true, owner: OWNER, price: 500_000n, quantityRemaining: 1000n, expireTimestampNs: 100n };
      throw new Error(`unexpected read ${request.functionName}`);
    },
  };
  const reader = createViemLpAccountReader({ publicClient, listOpenOrderIds: async () => [1n] });
  await assert.rejects(() => reader.readOrders({ account: ACCOUNT, marketId: MARKET }), { code: "ORDER_SCOPE_MISMATCH" });
});

test("shadow adapter has no wallet or broadcast dependency", () => {
  const value = adapter();
  assert.equal("broadcast" in value, false);
  assert.equal("sendTransaction" in value, false);
  assert.equal("writeContract" in value, false);
});

test("adapter exposes no owner withdrawal, arbitrary call, or permission mutation", () => {
  const value = adapter();
  for (const forbidden of ["withdraw", "arbitraryCall", "transferTo", "setOwner", "setOperator"]) {
    assert.equal(typeof value[forbidden], "undefined", forbidden);
  }
});
