/**
 * Read-only proof for the owner-provisioned Phase 3B1A VillaAccount.
 *
 * This script never loads dotenv, creates a wallet, reads a private key, or
 * exposes a write method. It verifies the public chain state and the supplied
 * provisioning receipts directly against Shannon.
 */

import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, http } from "viem";
import { readFile } from "node:fs/promises";
import { VILLA_ACCOUNT_CONFIG } from "../dashboard/account-config.mjs";
import { runtimeBytecodeMatches } from "../dashboard/account-client.mjs";
import {
  ERC20_BALANCE_ABI,
  VILLA_ACCOUNT_MARKET_ABI,
  VILLA_ACCOUNT_READ_ABI,
} from "../src/execution/lp-adapter.mjs";

const ACCOUNT = "0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2";
const OWNER = "0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d";
const OPERATOR = "0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37";
const EXPECTED_COLLATERAL_RAW = 1_000_000n;
const EXPECTED_BLOCKS = Object.freeze({
  create: 475881176n,
  approve: 475881408n,
  deposit: 475881510n,
  authorize: 475881664n,
});
const OUTCOME_OPERATOR_ABI = Object.freeze([
  { type: "function", name: "isOperator", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "bool" }] },
]);
const ERC20_ALLOWANCE_ABI = Object.freeze([
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] },
]);
const VILLA_POOL_PARAMS_ABI = Object.freeze([
  { type: "function", name: "getBinaryPoolParams", stateMutability: "view", inputs: [], outputs: [{ name: "params", type: "tuple", components: [{ name: "collateralToken", type: "address" }, { name: "market", type: "address" }, { name: "outcomeToken", type: "address" }, { name: "yesId", type: "uint256" }, { name: "noId", type: "uint256" }, { name: "oneCollateral", type: "uint256" }, { name: "setBacking", type: "uint256" }, { name: "feeRecipient", type: "address" }, { name: "makerFeeBpsTimes1k", type: "uint256" }, { name: "takerFeeBpsTimes1k", type: "uint256" }, { name: "maxBuilderFeeBpsTimes1k", type: "uint256" }, { name: "settlementFeeBpsTimes1k", type: "uint256" }, { name: "settlement", type: "address" }, { name: "marketNonce", type: "uint64" }, { name: "finalized", type: "bool" }] }] },
]);
const VILLA_POOL_ORDERS_ABI = Object.freeze([
  { type: "function", name: "getOwnOpenOrders", stateMutability: "view", inputs: [], outputs: [{ name: "orderIds", type: "uint128[]" }] },
]);
const PROVISIONING_TXS = Object.freeze({
  create: "0x274ced1d57933de5c1c85ebb80f0537c44b6c65e2027f849f52d2ecbf0b9c164",
  approve: "0x5d79ebe5a5900e3769e31b8b6269d9dee912452ec5de59d2bce81ede0b688166",
  deposit: "0xb1c514af5b550a9a0d150051efb715bd48383dc0140226ead3f71ce90bfc548b",
  authorize: "0x91c9a7d3e5ab40efdac31c7152908cce0e971ce9eca13f2baf2ef935da5171e3",
});

const RPC_URL = process.env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl || "https://dream-rpc.somnia.network";
const publicClient = createPublicClient({ chain: somniaShannon, transport: http(RPC_URL, { timeout: 15_000 }) });
const artifact = await fetchArtifact();

function normalizeAddress(value) {
  return String(value ?? "").toLowerCase();
}

function assertEqual(actual, expected, label) {
  if (normalizeAddress(actual) !== normalizeAddress(expected)) throw new Error(`${label} mismatch: ${actual} != ${expected}`);
}

function parseMarketId() {
  const argument = process.argv.find((value) => value.startsWith("--market-id="));
  const value = argument?.slice("--market-id=".length) || process.env.MARKET_ID || null;
  if (value === null) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("--market-id must be a bytes32 market id");
  return value.toLowerCase();
}

async function fetchArtifact() {
  return JSON.parse(await readFile(new URL("../dashboard/villa-account-artifact.json", import.meta.url), "utf8"));
}

async function readProvisioningReceipts() {
  const entries = {};
  for (const [label, hash] of Object.entries(PROVISIONING_TXS)) {
    const [receipt, transaction] = await Promise.all([
      publicClient.getTransactionReceipt({ hash }),
      publicClient.getTransaction({ hash }),
    ]);
    if (receipt.status !== "success") throw new Error(`${label} receipt is not successful`);
    if (receipt.blockNumber !== EXPECTED_BLOCKS[label]) throw new Error(`${label} block mismatch: ${receipt.blockNumber} != ${EXPECTED_BLOCKS[label]}`);
    if (normalizeAddress(transaction.from) !== normalizeAddress(OWNER)) throw new Error(`${label} was not sent by the disposable owner`);
    entries[label] = {
      hash,
      blockNumber: receipt.blockNumber.toString(),
      status: receipt.status,
      from: transaction.from,
    };
  }
  return entries;
}

const marketId = parseMarketId();
const block = await publicClient.getBlock();
const [owner, operator, collateralToken, outcomeToken, binaryModule, binarySettlement, maxOrderQuantity, maxOrderCollateral, directCollateralRaw, code] = await Promise.all([
  publicClient.readContract({ address: ACCOUNT, abi: VILLA_ACCOUNT_READ_ABI, functionName: "owner" }),
  publicClient.readContract({ address: ACCOUNT, abi: VILLA_ACCOUNT_READ_ABI, functionName: "operator" }),
  publicClient.readContract({ address: ACCOUNT, abi: VILLA_ACCOUNT_READ_ABI, functionName: "collateralToken" }),
  publicClient.readContract({ address: ACCOUNT, abi: VILLA_ACCOUNT_READ_ABI, functionName: "outcomeToken" }),
  publicClient.readContract({ address: ACCOUNT, abi: VILLA_ACCOUNT_READ_ABI, functionName: "binaryModule" }),
  publicClient.readContract({ address: ACCOUNT, abi: VILLA_ACCOUNT_READ_ABI, functionName: "binarySettlement" }),
  publicClient.readContract({ address: ACCOUNT, abi: VILLA_ACCOUNT_READ_ABI, functionName: "maxOrderQuantity" }),
  publicClient.readContract({ address: ACCOUNT, abi: VILLA_ACCOUNT_READ_ABI, functionName: "maxOrderCollateral" }),
  publicClient.readContract({ address: VILLA_ACCOUNT_CONFIG.collateralToken, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [ACCOUNT] }),
  publicClient.getBytecode({ address: ACCOUNT }),
]);

assertEqual(owner, OWNER, "owner");
assertEqual(operator, OPERATOR, "operator");
assertEqual(collateralToken, VILLA_ACCOUNT_CONFIG.collateralToken, "collateralToken");
assertEqual(outcomeToken, VILLA_ACCOUNT_CONFIG.outcomeToken, "outcomeToken");
assertEqual(binaryModule, VILLA_ACCOUNT_CONFIG.binaryModule, "binaryModule");
assertEqual(binarySettlement, VILLA_ACCOUNT_CONFIG.binarySettlement, "binarySettlement");
if (directCollateralRaw !== EXPECTED_COLLATERAL_RAW) throw new Error(`collateral mismatch: ${directCollateralRaw} != ${EXPECTED_COLLATERAL_RAW}`);
if (maxOrderQuantity !== VILLA_ACCOUNT_CONFIG.initialMaxOrderQuantity) throw new Error(`maxOrderQuantity mismatch: ${maxOrderQuantity}`);
if (maxOrderCollateral !== VILLA_ACCOUNT_CONFIG.initialMaxOrderCollateral) throw new Error(`maxOrderCollateral mismatch: ${maxOrderCollateral}`);
if (!code || !runtimeBytecodeMatches(code, artifact.runtimeBytecode, artifact.runtimeImmutableReferences)) throw new Error("VillaAccount runtime bytecode does not match the verified artifact");

const receipts = await readProvisioningReceipts();
let marketProof = null;
if (marketId) {
  const market = await publicClient.readContract({ address: binaryModule, abi: VILLA_ACCOUNT_MARKET_ABI, functionName: "markets", args: [marketId] });
  const field = (name, index) => market?.[name] ?? market?.[index];
  const pool = field("pool", 9);
  const [approved, poolParams, moduleOperator, poolOperator, allowance] = await Promise.all([
    publicClient.readContract({ address: ACCOUNT, abi: VILLA_ACCOUNT_READ_ABI, functionName: "approvedMarkets", args: [marketId] }),
    publicClient.readContract({ address: pool, abi: VILLA_POOL_PARAMS_ABI, functionName: "getBinaryPoolParams" }),
    publicClient.readContract({ address: outcomeToken, abi: OUTCOME_OPERATOR_ABI, functionName: "isOperator", args: [ACCOUNT, binaryModule] }),
    publicClient.readContract({ address: outcomeToken, abi: OUTCOME_OPERATOR_ABI, functionName: "isOperator", args: [ACCOUNT, pool] }),
    publicClient.readContract({ address: collateralToken, abi: ERC20_ALLOWANCE_ABI, functionName: "allowance", args: [ACCOUNT, pool] }),
  ]);
  const poolField = (name, index) => poolParams?.[name] ?? poolParams?.[index];
  const poolWiringMatches = normalizeAddress(poolField("collateralToken", 0)) === normalizeAddress(collateralToken)
    && normalizeAddress(poolField("outcomeToken", 2)) === normalizeAddress(outcomeToken)
    && normalizeAddress(poolField("settlement", 12)) === normalizeAddress(binarySettlement)
    && normalizeAddress(poolField("market", 1)) === normalizeAddress(field("market", 8))
    && String(poolField("yesId", 3)) === String(field("yesId", 10))
    && String(poolField("noId", 4)) === String(field("noId", 11))
    ;
  if (!poolWiringMatches) throw new Error("current pool asset wiring does not match the VillaAccount immutable wiring");
  const orderIds = await publicClient.readContract({ address: pool, abi: VILLA_POOL_ORDERS_ABI, functionName: "getOwnOpenOrders", account: ACCOUNT });
  marketProof = {
    marketId,
    pool,
    approved,
    protocolPrepared: moduleOperator && poolOperator,
    outcomeOperator: { binaryModule: moduleOperator, pool: poolOperator },
    collateralAllowanceRaw: allowance.toString(),
    poolWiring: "VERIFIED",
    poolFinalized: Boolean(poolField("finalized", 14)),
    openOrderIds: orderIds.map((id) => String(id)),
  };
}

console.log(JSON.stringify({
  result: "PASS",
  chainId: 50312,
  blockNumber: block.number?.toString?.() ?? null,
  chainNowSec: block.timestamp.toString(),
  account: ACCOUNT,
  owner: OWNER,
  operator: OPERATOR,
  identity: { owner, operator, collateralToken, outcomeToken, binaryModule, binarySettlement, maxOrderQuantity: maxOrderQuantity.toString(), maxOrderCollateral: maxOrderCollateral.toString() },
  collateral: { token: collateralToken, raw: directCollateralRaw.toString(), human: "1.00 tUSDC" },
  runtime: { verified: true, runtimeBytes: (code.length - 2) / 2, artifact: artifact.schema },
  provisioningReceipts: receipts,
  market: marketProof,
  signer: { installed: false, privateKeyRead: false },
  writes: { broadcast: false, transactionsSentByThisProbe: 0 },
}, null, 2));
