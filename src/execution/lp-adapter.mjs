/**
 * Phase 3A per-LP execution boundary.
 *
 * This module deliberately has no wallet, private key, SDK trader, or
 * broadcast method. It reads one VillaAccount and constructs unsigned calls
 * whose `to` address is always that account. The existing fair-value, risk,
 * quote, inventory, settlement, and rollover layers remain above this seam.
 */

import { encodeFunctionData, isAddress } from "viem";

export const LP_EXECUTION_ADAPTER_VERSION = "villa-lp-adapter-v1";
export const LP_EXECUTION_MODE = "SHADOW";
export const SHANNON_CHAIN_ID = 50312;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT64_MAX = (1n << 64n) - 1n;

export const VILLA_ACCOUNT_READ_ABI = Object.freeze([
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "operator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "collateralToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "outcomeToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "binaryModule", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "binarySettlement", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "maxOrderQuantity", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "maxOrderCollateral", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approvedMarkets", stateMutability: "view", inputs: [{ name: "marketId", type: "bytes32" }], outputs: [{ type: "bool" }] },
]);

export const VILLA_ACCOUNT_OPERATOR_ABI = Object.freeze([
  { type: "function", name: "operatorPlaceOrder", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "bytes32" }, { name: "kind", type: "uint8" }, { name: "price", type: "uint256" }, { name: "quantity", type: "uint256" }, { name: "expireTimestampNs", type: "uint64" }, { name: "orderType", type: "uint8" }, { name: "userData", type: "uint64" }], outputs: [{ name: "success", type: "bool" }, { name: "orderId", type: "uint128" }] },
  { type: "function", name: "operatorCancelOrder", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "bytes32" }, { name: "orderId", type: "uint128" }], outputs: [] },
  { type: "function", name: "operatorReduceOrder", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "bytes32" }, { name: "orderId", type: "uint128" }, { name: "newQuantityRemaining", type: "uint256" }], outputs: [] },
  { type: "function", name: "operatorMintSet", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "bytes32" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "operatorBurnSet", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "bytes32" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "operatorRedeem", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "bytes32" }, { name: "outcomeIdx", type: "uint8" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "operatorClaimVault", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "bytes32" }, { name: "amount", type: "uint256" }], outputs: [] },
]);

export const ERC20_BALANCE_ABI = Object.freeze([
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
]);

export const ERC6909_BALANCE_ABI = Object.freeze([
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "id", type: "uint256" }], outputs: [{ type: "uint256" }] },
]);

export const VILLA_ACCOUNT_MARKET_ABI = Object.freeze([
  { type: "function", name: "markets", stateMutability: "view", inputs: [{ name: "marketId", type: "bytes32" }], outputs: [
    { name: "oracleQuestionId", type: "uint256" }, { name: "outcomeSlotCount", type: "uint8" }, { name: "voidPolicy", type: "uint8" }, { name: "collateral", type: "address" },
    { name: "originOperatorId", type: "uint32" }, { name: "originVenueId", type: "bytes32" }, { name: "oracleAdapter", type: "address" }, { name: "creator", type: "address" },
    { name: "market", type: "address" }, { name: "pool", type: "address" }, { name: "yesId", type: "uint256" }, { name: "noId", type: "uint256" },
    { name: "tradingStart", type: "uint64" }, { name: "expiry", type: "uint64" },
  ] },
]);

export const VILLA_POOL_READ_ABI = Object.freeze([
  { type: "function", name: "getWithdrawableBalance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getOrder", stateMutability: "view", inputs: [{ name: "orderId", type: "uint128" }], outputs: [{ name: "order", type: "tuple", components: [{ name: "orderId", type: "uint128" }, { name: "isBid", type: "bool" }, { name: "owner", type: "address" }, { name: "userData", type: "uint64" }, { name: "price", type: "uint256" }, { name: "fullQuantity", type: "uint256" }, { name: "quantityRemaining", type: "uint256" }, { name: "expireTimestampNs", type: "uint64" }] }] },
]);

export class LpExecutionAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LpExecutionAdapterError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new LpExecutionAdapterError(code, message);
}

function address(value, label) {
  const text = String(value ?? "");
  if (!ADDRESS_RE.test(text) || !isAddress(text)) fail("ADDRESS_INVALID", `${label} must be a valid address`);
  return text.toLowerCase();
}

function bytes32(value, label) {
  const text = String(value ?? "");
  if (!BYTES32_RE.test(text)) fail("BYTES32_INVALID", `${label} must be a 32-byte hex value`);
  return text.toLowerCase();
}

function raw(value, label, { positive = false, max = null } = {}) {
  let result;
  try {
    result = typeof value === "bigint" ? value : BigInt(String(value));
  } catch {
    fail("RAW_INVALID", `${label} must be an integer raw value`);
  }
  if (result < 0n || (positive && result === 0n) || (max !== null && result > max)) fail("RAW_INVALID", `${label} is outside its allowed range`);
  return result;
}

function sameAddress(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function freezePlan(plan) {
  Object.freeze(plan.args);
  Object.freeze(plan);
  return plan;
}

function scopedReadResult(result, account, label) {
  if (!result || !sameAddress(result.account, account)) fail("ACCOUNT_SCOPE_MISMATCH", `${label} returned data for a different account`);
  return result;
}

function orderKind({ kind, action } = {}) {
  if (kind !== undefined) return Number(raw(kind, "kind", { max: 3n }));
  const map = { BUY_YES: 0, BUY_NO: 1, SELL_YES: 2, SELL_NO: 3 };
  if (map[String(action)] === undefined) fail("ORDER_INVALID", "kind or a supported binary action is required");
  return map[String(action)];
}

function accountMarketId(input) {
  return bytes32(input?.marketId, "marketId");
}

function readContract(publicClient, request) {
  if (!publicClient || typeof publicClient.readContract !== "function") fail("READER_INVALID", "publicClient.readContract is required");
  return publicClient.readContract(request);
}

/** Build a read-only viem reader. `listOpenOrderIds` is intentionally injected
 * because the SDK/indexer order listing is an integration concern, not a
 * permission to use the signer wallet as the portfolio identity. */
export function createViemLpAccountReader({ publicClient, listOpenOrderIds = null } = {}) {
  if (!publicClient || typeof publicClient.readContract !== "function") fail("READER_INVALID", "a read-only publicClient is required");

  async function readAccountIdentity({ account }) {
    const target = address(account, "account");
    const names = ["owner", "operator", "collateralToken", "outcomeToken", "binaryModule", "binarySettlement", "maxOrderQuantity", "maxOrderCollateral"];
    const values = await Promise.all(names.map((functionName) => readContract(publicClient, { address: target, abi: VILLA_ACCOUNT_READ_ABI, functionName })));
    return {
      account: target,
      owner: address(values[0], "account owner"),
      operator: address(values[1], "account operator"),
      collateralToken: address(values[2], "collateral token"),
      outcomeToken: address(values[3], "outcome token"),
      binaryModule: address(values[4], "binary module"),
      binarySettlement: address(values[5], "binary settlement"),
      maxOrderQuantity: raw(values[6], "maxOrderQuantity"),
      maxOrderCollateral: raw(values[7], "maxOrderCollateral"),
    };
  }

  async function readMarket({ account, marketId, identity = null }) {
    const target = address(account, "account");
    const id = accountMarketId({ marketId });
    const currentIdentity = identity ?? await readAccountIdentity({ account: target });
    const result = await readContract(publicClient, { address: currentIdentity.binaryModule, abi: VILLA_ACCOUNT_MARKET_ABI, functionName: "markets", args: [id] });
    const field = (name, index) => result?.[name] ?? result?.[index];
    const pool = address(field("pool", 9), "market pool");
    return {
      account: target,
      marketId: id,
      collateral: address(field("collateral", 3), "market collateral"),
      market: address(field("market", 8), "market contract"),
      pool,
      yesId: raw(field("yesId", 10), "YES token id"),
      noId: raw(field("noId", 11), "NO token id"),
      tradingStart: raw(field("tradingStart", 12), "market trading start"),
      expiry: raw(field("expiry", 13), "market expiry"),
    };
  }

  async function readCapital({ account, marketId = null, identity = null } = {}) {
    const target = address(account, "account");
    const currentIdentity = identity ?? await readAccountIdentity({ account: target });
    const directCollateralRaw = raw(await readContract(publicClient, { address: currentIdentity.collateralToken, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [target] }), "direct collateral");
    let market = null;
    let vaultRaw = null;
    if (marketId !== null && marketId !== undefined) {
      market = await readMarket({ account: target, marketId, identity: currentIdentity });
      vaultRaw = raw(await readContract(publicClient, { address: market.pool, abi: VILLA_POOL_READ_ABI, functionName: "getWithdrawableBalance", args: [target, currentIdentity.collateralToken] }), "pool vault credit");
    }
    return { account: target, collateralToken: currentIdentity.collateralToken, directCollateralRaw, vaultRaw, marketId: market?.marketId ?? null, pool: market?.pool ?? null };
  }

  async function readOutcomeInventory({ account, marketId, identity = null, market = null } = {}) {
    const target = address(account, "account");
    const currentIdentity = identity ?? await readAccountIdentity({ account: target });
    const currentMarket = market ?? await readMarket({ account: target, marketId, identity: currentIdentity });
    const [yesRaw, noRaw] = await Promise.all([
      readContract(publicClient, { address: currentIdentity.outcomeToken, abi: ERC6909_BALANCE_ABI, functionName: "balanceOf", args: [target, currentMarket.yesId] }),
      readContract(publicClient, { address: currentIdentity.outcomeToken, abi: ERC6909_BALANCE_ABI, functionName: "balanceOf", args: [target, currentMarket.noId] }),
    ]);
    return { account: target, marketId: currentMarket.marketId, yesId: currentMarket.yesId, noId: currentMarket.noId, yesRaw: raw(yesRaw, "YES inventory"), noRaw: raw(noRaw, "NO inventory") };
  }

  async function readOrders({ account, marketId, identity = null, market = null } = {}) {
    const target = address(account, "account");
    const currentIdentity = identity ?? await readAccountIdentity({ account: target });
    const currentMarket = market ?? await readMarket({ account: target, marketId, identity: currentIdentity });
    if (typeof listOpenOrderIds !== "function") return { account: target, marketId: currentMarket.marketId, status: "UNAVAILABLE", orders: [], warning: "open-order listing was not supplied" };
    const ids = await listOpenOrderIds({ account: target, pool: currentMarket.pool, marketId: currentMarket.marketId });
    const orders = [];
    for (const item of ids ?? []) {
      const orderId = raw(item, "order id");
      const result = await readContract(publicClient, { address: currentMarket.pool, abi: VILLA_POOL_READ_ABI, functionName: "getOrder", args: [orderId] });
      const field = (name, index) => result?.[name] ?? result?.[index];
      const orderOwner = address(field("owner", 2), "order owner");
      if (!sameAddress(orderOwner, target)) fail("ORDER_SCOPE_MISMATCH", `order ${orderId} is not owned by the VillaAccount`);
      orders.push({ account: target, marketId: currentMarket.marketId, orderId, owner: orderOwner, isBid: Boolean(field("isBid", 1)), priceRaw: raw(field("price", 4), "order price"), quantityRemainingRaw: raw(field("quantityRemaining", 6), "remaining order quantity"), expireTimestampNs: raw(field("expireTimestampNs", 7), "order expiry") });
    }
    return { account: target, marketId: currentMarket.marketId, status: "VERIFIED", orders };
  }

  return Object.freeze({ readAccountIdentity, readMarket, readCapital, readOutcomeInventory, readOrders });
}

/**
 * Create an adapter for exactly one LP account. It returns unsigned shadow
 * plans. There is intentionally no method capable of broadcasting one.
 */
export function createLpExecutionAdapter({ account, owner, operator, chain = SHANNON_CHAIN_ID, reader, executionMode = LP_EXECUTION_MODE, sessionId = null } = {}) {
  const accountAddress = address(account, "VillaAccount");
  const ownerAddress = address(owner, "LP owner");
  const operatorAddress = address(operator, "VILLA operator");
  const chainId = typeof chain === "object" ? Number(chain.id ?? chain.chainId) : Number(chain);
  if (chainId !== SHANNON_CHAIN_ID) fail("CHAIN_UNSUPPORTED", `Phase 3A requires Shannon chain ${SHANNON_CHAIN_ID}`);
  if (sameAddress(accountAddress, ownerAddress) || sameAddress(accountAddress, operatorAddress) || sameAddress(ownerAddress, operatorAddress)) fail("IDENTITY_COLLISION", "signer, VillaAccount, and LP owner must remain distinct identities");
  if (executionMode !== LP_EXECUTION_MODE) fail("SHADOW_ONLY", "Phase 3A adapter only supports EXECUTION_MODE=SHADOW");
  if (!reader || typeof reader.readAccountIdentity !== "function" || typeof reader.readCapital !== "function" || typeof reader.readOutcomeInventory !== "function" || typeof reader.readOrders !== "function") fail("READER_INVALID", "account-scoped read methods are required");

  const scopedContext = (input = {}) => ({ ...input, account: accountAddress });
  const readIdentity = async () => scopedReadResult(await reader.readAccountIdentity({ account: accountAddress }), accountAddress, "account identity");

  async function readMarket(input = {}) {
    if (typeof reader.readMarket !== "function") fail("READER_INVALID", "market read method is required");
    return scopedReadResult(await reader.readMarket(scopedContext(input)), accountAddress, "account market");
  }

  async function readCapital(input = {}) {
    return scopedReadResult(await reader.readCapital(scopedContext(input)), accountAddress, "capital");
  }

  async function readOutcomeInventory(input = {}) {
    return scopedReadResult(await reader.readOutcomeInventory(scopedContext(input)), accountAddress, "outcome inventory");
  }

  async function readOrders(input = {}) {
    return scopedReadResult(await reader.readOrders(scopedContext(input)), accountAddress, "orders");
  }

  async function readPositions(input = {}) {
    const [inventory, orders] = await Promise.all([readOutcomeInventory(input), readOrders(input)]);
    return { account: accountAddress, marketId: inventory.marketId, inventory, orders: orders.orders, orderStatus: orders.status };
  }

  async function readAccountState(input = {}) {
    const identity = await readIdentity();
    const capital = await readCapital({ ...input, identity });
    const inventory = input.marketId === undefined || input.marketId === null ? null : await readOutcomeInventory({ ...input, identity });
    const orders = input.marketId === undefined || input.marketId === null ? { account: accountAddress, marketId: null, status: "NOT_SELECTED", orders: [] } : await readOrders({ ...input, identity });
    return { account: accountAddress, owner: ownerAddress, operator: operatorAddress, identity, capital, inventory, orders, positions: inventory ? { account: accountAddress, marketId: inventory.marketId, inventory, orders: orders.orders, orderStatus: orders.status } : null };
  }

  function writePlan(operation, functionName, args, extra = {}) {
    const plan = {
      adapterVersion: LP_EXECUTION_ADAPTER_VERSION,
      executionMode: LP_EXECUTION_MODE,
      broadcast: false,
      chainId,
      sessionId,
      operation,
      functionName,
      to: accountAddress,
      destination: accountAddress,
      value: 0n,
      args,
      data: encodeFunctionData({ abi: VILLA_ACCOUNT_OPERATOR_ABI, functionName, args }),
      signer: operatorAddress,
      account: accountAddress,
      orderOwner: accountAddress,
      owner: ownerAddress,
      ...extra,
    };
    return freezePlan(plan);
  }

  function placeOrder({ marketId, kind, action, priceRaw, quantityRaw, expireTimestampNs, orderType = 3, userData = 0n } = {}) {
    const normalizedKind = orderKind({ kind, action });
    const price = raw(priceRaw, "order price", { positive: true });
    const quantity = raw(quantityRaw, "order quantity", { positive: true });
    const expiry = raw(expireTimestampNs, "order expiry", { positive: true, max: UINT64_MAX });
    const type = raw(orderType, "order type", { max: 3n });
    const data = raw(userData, "order userData", { max: UINT64_MAX });
    return writePlan("PLACE_ORDER", "operatorPlaceOrder", [accountMarketId({ marketId }), normalizedKind, price, quantity, expiry, type, data], { action: action ?? ["BUY_YES", "BUY_NO", "SELL_YES", "SELL_NO"][normalizedKind], marketId: accountMarketId({ marketId }) });
  }

  function cancelOrder({ marketId, orderId } = {}) {
    return writePlan("CANCEL_ORDER", "operatorCancelOrder", [accountMarketId({ marketId }), raw(orderId, "order id")], { marketId: accountMarketId({ marketId }), orderId: raw(orderId, "order id") });
  }

  function reduceOrder({ marketId, orderId, newQuantityRemaining } = {}) {
    return writePlan("REDUCE_ORDER", "operatorReduceOrder", [accountMarketId({ marketId }), raw(orderId, "order id"), raw(newQuantityRemaining, "new remaining quantity", { positive: true })], { marketId: accountMarketId({ marketId }), orderId: raw(orderId, "order id") });
  }

  function mintCompleteSet({ marketId, amountRaw } = {}) {
    return writePlan("MINT_COMPLETE_SET", "operatorMintSet", [accountMarketId({ marketId }), raw(amountRaw, "mint amount", { positive: true })], { marketId: accountMarketId({ marketId }), amountRaw: raw(amountRaw, "mint amount", { positive: true }) });
  }

  function burnCompleteSet({ marketId, amountRaw } = {}) {
    return writePlan("BURN_COMPLETE_SET", "operatorBurnSet", [accountMarketId({ marketId }), raw(amountRaw, "burn amount", { positive: true })], { marketId: accountMarketId({ marketId }), amountRaw: raw(amountRaw, "burn amount", { positive: true }) });
  }

  function redeemResolved({ marketId, outcomeIdx, amountRaw } = {}) {
    return writePlan("REDEEM_RESOLVED", "operatorRedeem", [accountMarketId({ marketId }), raw(outcomeIdx, "outcome index", { max: 1n }), raw(amountRaw, "redeem amount", { positive: true })], { marketId: accountMarketId({ marketId }), outcomeIdx: raw(outcomeIdx, "outcome index", { max: 1n }) });
  }

  function claimVault({ marketId, amountRaw } = {}) {
    return writePlan("CLAIM_VAULT_CREDIT", "operatorClaimVault", [accountMarketId({ marketId }), raw(amountRaw, "vault claim amount", { positive: true })], { marketId: accountMarketId({ marketId }), amountRaw: raw(amountRaw, "vault claim amount", { positive: true }), custodyEffect: "CREDIT_ACCOUNT_ONLY" });
  }

  return Object.freeze({
    adapterVersion: LP_EXECUTION_ADAPTER_VERSION,
    executionMode: LP_EXECUTION_MODE,
    chainId,
    account: accountAddress,
    owner: ownerAddress,
    operator: operatorAddress,
    readAccountIdentity: readIdentity,
    readMarket,
    readCapital,
    readOutcomeInventory,
    readOrders,
    readPositions,
    readAccountState,
    placeOrder,
    cancelOrder,
    reduceOrder,
    mintCompleteSet,
    burnCompleteSet,
    redeemResolved,
    claimVault,
  });
}

export const LP_ADAPTER_FORBIDDEN_OPERATIONS = Object.freeze(["withdraw", "arbitraryCall", "transferTo", "setOwner", "setOperator"]);
