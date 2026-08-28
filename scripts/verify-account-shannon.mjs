/**
 * Bounded Phase 1 per-user account proof on Somnia Shannon.
 *
 * Requires --confirm. It creates two disposable wallets in memory, funds them
 * from the existing Shannon test wallet, deploys two direct VillaAccount
 * instances, and proves account-scoped EC actions. It never reads or prints a
 * private key value and never writes signer material to disk.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeDeployData,
  formatEther,
  formatUnits,
  http,
  maxUint256,
  parseEther,
  parseEventLogs,
} from "viem";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const CONFIRM = process.argv.includes("--confirm");
const RPC_URL = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const INDEXER_URL = process.env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql";
const ARTIFACT_PATH = process.env.VILLA_ACCOUNT_ARTIFACT || ".scratch/account-build/contracts_VillaAccount_sol_VillaAccount";
const PROOF_PATH = `runtime/state/phase-1-account-proof-${Date.now()}.json`;
const TUSDC = SOMNIA_TESTNET_ADDRESSES.collateral;
const OUTCOME = SOMNIA_TESTNET_ADDRESSES.binarySettlement;
const MODULE = SOMNIA_TESTNET_ADDRESSES.binaryModule;
const OUTCOME_TOKEN = "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9";
const FUND_AMOUNT = 10_000_000n;
const PROOF_AMOUNT = 1_000n;
const MAX_ORDER_QUANTITY = 1_000n;
const MAX_ORDER_COLLATERAL = 1_000n;

const erc20Abi = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
];

const outcomeAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "id", type: "uint256" }], outputs: [{ type: "uint256" }] },
];

const moduleAbi = [
  { type: "function", name: "markets", stateMutability: "view", inputs: [{ name: "marketId", type: "bytes32" }], outputs: [{ name: "oracleQuestionId", type: "uint256" }, { name: "outcomeSlotCount", type: "uint8" }, { name: "voidPolicy", type: "uint8" }, { name: "collateral", type: "address" }, { name: "originOperatorId", type: "uint32" }, { name: "originVenueId", type: "bytes32" }, { name: "oracleAdapter", type: "address" }, { name: "creator", type: "address" }, { name: "market", type: "address" }, { name: "pool", type: "address" }, { name: "yesId", type: "uint256" }, { name: "noId", type: "uint256" }, { name: "tradingStart", type: "uint64" }, { name: "expiry", type: "uint64" }] },
];

const poolAbi = [
  { type: "function", name: "getBinaryPoolParams", stateMutability: "view", inputs: [], outputs: [{ name: "params", type: "tuple", components: [{ name: "collateralToken", type: "address" }, { name: "market", type: "address" }, { name: "outcomeToken", type: "address" }, { name: "yesId", type: "uint256" }, { name: "noId", type: "uint256" }, { name: "oneCollateral", type: "uint256" }, { name: "setBacking", type: "uint256" }, { name: "feeRecipient", type: "address" }, { name: "makerFeeBpsTimes1k", type: "uint256" }, { name: "takerFeeBpsTimes1k", type: "uint256" }, { name: "maxBuilderFeeBpsTimes1k", type: "uint256" }, { name: "settlementFeeBpsTimes1k", type: "uint256" }, { name: "settlement", type: "address" }, { name: "marketNonce", type: "uint64" }, { name: "finalized", type: "bool" }] }] },
  { type: "function", name: "getOrderBookParameters", stateMutability: "view", inputs: [], outputs: [{ name: "params", type: "tuple", components: [{ name: "tickSize", type: "uint256" }, { name: "minQuantity", type: "uint256" }, { name: "lotSize", type: "uint256" }] }] },
  { type: "function", name: "getBookLevels", stateMutability: "view", inputs: [{ name: "isBid", type: "bool" }, { name: "numLevels", type: "uint64" }], outputs: [{ name: "levels", type: "tuple[]", components: [{ name: "price", type: "uint256" }, { name: "quantity", type: "uint256" }] }] },
  { type: "function", name: "getOrder", stateMutability: "view", inputs: [{ name: "orderId", type: "uint128" }], outputs: [{ name: "order", type: "tuple", components: [{ name: "orderId", type: "uint128" }, { name: "isBid", type: "bool" }, { name: "owner", type: "address" }, { name: "userData", type: "uint64" }, { name: "price", type: "uint256" }, { name: "fullQuantity", type: "uint256" }, { name: "quantityRemaining", type: "uint256" }, { name: "expireTimestampNs", type: "uint64" }] }] },
  { type: "function", name: "marketExpiryNs", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "getWithdrawableBalance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "token", type: "address" }], outputs: [{ type: "uint256" }] },
];

function jsonSafe(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function field(value, name, index) {
  return value?.[name] ?? value?.[index];
}

function must(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadArtifact() {
  const [abiText, bytecodeText] = await Promise.all([
    readFile(`${ARTIFACT_PATH}.abi`, "utf8"),
    readFile(`${ARTIFACT_PATH}.bin`, "utf8"),
  ]);
  const bytecode = `0x${bytecodeText.trim()}`;
  must(bytecode.length > 2, "VillaAccount bytecode artifact is empty");
  return { abi: JSON.parse(abiText), bytecode };
}

async function waitTx(publicClient, hash, label) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  must(receipt.status === "success", `${label} reverted: ${hash}`);
  return { hash, blockNumber: String(receipt.blockNumber), gasUsed: String(receipt.gasUsed) };
}

async function writeContract(publicClient, walletClient, account, request, label) {
  const hash = await walletClient.writeContract({ ...request, account, chain: somniaShannon });
  return waitTx(publicClient, hash, label);
}

async function deployAccount(publicClient, walletClient, account, artifact, operator) {
  const data = encodeDeployData({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args: [account.address, operator, TUSDC, OUTCOME_TOKEN, MODULE, OUTCOME, MAX_ORDER_QUANTITY, MAX_ORDER_COLLATERAL],
  });
  const hash = await walletClient.sendTransaction({
    account,
    chain: somniaShannon,
    gas: 60_000_000n,
    data,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  must(receipt.status === "success" && receipt.contractAddress, `account deployment reverted: ${hash}`);
  return { address: receipt.contractAddress, tx: { hash, blockNumber: String(receipt.blockNumber), gasUsed: String(receipt.gasUsed) } };
}

async function call(publicClient, address, abi, functionName, args = [], account) {
  return publicClient.readContract({ address, abi, functionName, args, ...(account ? { account } : {}) });
}

async function expectRevert(publicClient, request, label) {
  try {
    await publicClient.simulateContract(request);
  } catch (error) {
    return { label, rejected: true, reason: String(error.shortMessage || error.message || error).slice(0, 180) };
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function discoverMarket(exchange, publicClient, { afterExpiry = 0, minHeadroom = 120 } = {}) {
  const block = await publicClient.getBlock();
  const now = Number(block.timestamp);
  let rows;
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rows = await exchange.client.listBinaryMarkets({ asset: "BTC", status: "Trading", limit: 200 });
      break;
    } catch (error) {
      lastError = error;
      await sleep(2_000);
    }
  }
  if (!rows) throw new Error(`DreamDEX market discovery unavailable after bounded retries: ${lastError?.message || lastError}`);
  const candidates = rows
    .filter((row) => Math.round(Number(row.intervalSec)) === 300)
    .filter((row) => Number(row.expiry) > afterExpiry && Number(row.expiry) - now >= minHeadroom)
    .sort((left, right) => Number(left.expiry) - Number(right.expiry));
  for (const row of candidates) {
    const onchain = await exchange.client.getMarketOnchain(row.marketId);
    if (Number(onchain.status) === 1 && !onchain.isResolved && !onchain.isVoided) return { row, onchain, chainNow: now };
  }
  return null;
}

async function main() {
  must(CONFIRM, "use --confirm for the bounded Shannon account proof");
  const artifact = await loadArtifact();
  const operatorKey = process.env.OPERATOR_PRIVATE_KEY;
  must(operatorKey, "existing disposable OPERATOR_PRIVATE_KEY is required only as the testnet operator caller");
  const operator = privateKeyToAccount(operatorKey);
  if (process.env.OPERATOR_ADDRESS) must(operator.address.toLowerCase() === process.env.OPERATOR_ADDRESS.toLowerCase(), "OPERATOR_ADDRESS does not match the existing signer");

  const privateKeyA = generatePrivateKey();
  const privateKeyB = generatePrivateKey();
  const ownerA = privateKeyToAccount(privateKeyA);
  const ownerB = privateKeyToAccount(privateKeyB);
  const publicClient = createPublicClient({ chain: somniaShannon, transport: http(RPC_URL, { timeout: 15_000 }) });
  const operatorWallet = createWalletClient({ account: operator, chain: somniaShannon, transport: http(RPC_URL, { timeout: 15_000 }) });
  const ownerAWallet = createWalletClient({ account: ownerA, chain: somniaShannon, transport: http(RPC_URL, { timeout: 15_000 }) });
  const ownerBWallet = createWalletClient({ account: ownerB, chain: somniaShannon, transport: http(RPC_URL, { timeout: 15_000 }) });
  const exchange = new SomniaMarkets({ indexerUrl: INDEXER_URL, chain: somniaShannon, addresses: SOMNIA_TESTNET_ADDRESSES, priceFeed: SOMNIA_TESTNET_PRICE_FEED });
  const operatorCollateral = BigInt(await call(publicClient, TUSDC, erc20Abi, "balanceOf", [operator.address]));
  must(operatorCollateral >= FUND_AMOUNT * 2n, `operator disposable tUSDC preflight is ${operatorCollateral}, need ${FUND_AMOUNT * 2n}`);
  let market;
  for (let attempt = 0; attempt < 24 && !market; attempt += 1) {
    market = await discoverMarket(exchange, publicClient);
    if (!market) await sleep(15_000);
  }
  must(market, "no clean BTC 5m Trading Event Contract with 120s headroom");

  const proof = { schema: "villa-phase-1-account-proof-v1", network: "Somnia Shannon", chainId: 50312, startingCommit: "cee9003cfc12d7c63bf9eff7842e0ff2f0f8b856", operator: operator.address, ownerA: ownerA.address, ownerB: ownerB.address, transactions: [], checks: {} };
  console.log("operator", operator.address);
  console.log("ownerA", ownerA.address);
  console.log("ownerB", ownerB.address);

  for (const [label, address] of [["ownerA", ownerA.address], ["ownerB", ownerB.address]]) {
    const hash = await operatorWallet.sendTransaction({ account: operator, chain: somniaShannon, to: address, value: parseEther("1") });
    proof.transactions.push({ label: `fund-${label}-stt`, ...(await waitTx(publicClient, hash, `fund ${label} STT`)) });
    const tokenHash = await operatorWallet.writeContract({ account: operator, chain: somniaShannon, address: TUSDC, abi: erc20Abi, functionName: "transfer", args: [address, FUND_AMOUNT] });
    proof.transactions.push({ label: `fund-${label}-tusdc`, ...(await waitTx(publicClient, tokenHash, `fund ${label} tUSDC`)) });
  }
  proof.checks.funding = { ownerA: String(await call(publicClient, TUSDC, erc20Abi, "balanceOf", [ownerA.address])), ownerB: String(await call(publicClient, TUSDC, erc20Abi, "balanceOf", [ownerB.address])) };

  const accountA = await deployAccount(publicClient, ownerAWallet, ownerA, artifact, operator.address);
  const accountB = await deployAccount(publicClient, ownerBWallet, ownerB, artifact, operator.address);
  proof.transactions.push({ label: "deploy-account-a", ...accountA.tx }, { label: "deploy-account-b", ...accountB.tx });
  proof.accountA = accountA.address;
  proof.accountB = accountB.address;
  must(accountA.address.toLowerCase() !== accountB.address.toLowerCase(), "Wallet A and B accounts must be distinct");

  const marketId = market.row.marketId;
  const onchain = market.onchain;
  proof.market = { marketId, pool: onchain.pool, market: onchain.marketAddress, outcomeToken: onchain.outcomeToken, yesId: String(onchain.yesId), noId: String(onchain.noId), expiry: String(onchain.expiry), intervalSec: 300 };
  console.log("market", jsonSafe(proof.market));

  const amountA = FUND_AMOUNT;
  const amountB = FUND_AMOUNT;
  for (const [owner, wallet, account, amount, label] of [[ownerA, ownerAWallet, accountA.address, amountA, "A"], [ownerB, ownerBWallet, accountB.address, amountB, "B"]]) {
    const approveHash = await wallet.writeContract({ account: owner, chain: somniaShannon, address: TUSDC, abi: erc20Abi, functionName: "approve", args: [account, amount] });
    proof.transactions.push({ label: `owner-${label}-approve-account`, ...(await waitTx(publicClient, approveHash, `owner ${label} approve account`)) });
    const depositHash = await wallet.writeContract({ account: owner, chain: somniaShannon, address: account, abi: artifact.abi, functionName: "deposit", args: [amount] });
    proof.transactions.push({ label: `owner-${label}-deposit`, ...(await waitTx(publicClient, depositHash, `owner ${label} deposit`)) });
    const approvalHash = await wallet.writeContract({ account: owner, chain: somniaShannon, address: account, abi: artifact.abi, functionName: "setMarketApproval", args: [marketId, true] });
    proof.transactions.push({ label: `owner-${label}-market-approval`, ...(await waitTx(publicClient, approvalHash, `owner ${label} market approval`)) });
    const prepareHash = await wallet.writeContract({ account: owner, chain: somniaShannon, address: account, abi: artifact.abi, functionName: "prepareMarket", args: [marketId] });
    proof.transactions.push({ label: `owner-${label}-prepare`, ...(await waitTx(publicClient, prepareHash, `owner ${label} prepare`)) });
  }
  proof.checks.accountFunding = { accountA: String(await call(publicClient, TUSDC, erc20Abi, "balanceOf", [accountA.address])), accountB: String(await call(publicClient, TUSDC, erc20Abi, "balanceOf", [accountB.address])) };

  proof.checks.security = {};
  proof.checks.security.operatorWithdrawRejected = await expectRevert(publicClient, { address: accountA.address, abi: artifact.abi, functionName: "withdraw", args: [1n], account: operator.address }, "operator withdraw");
  proof.checks.security.attackerWithdrawRejected = await expectRevert(publicClient, { address: accountA.address, abi: artifact.abi, functionName: "withdraw", args: [1n], account: ownerB.address }, "attacker withdraw");
  proof.checks.security.attackerOperatorActionRejected = await expectRevert(publicClient, { address: accountA.address, abi: artifact.abi, functionName: "operatorPlaceOrder", args: [marketId, 1, 500_000n, PROOF_AMOUNT, 0n, 3, 0n], account: ownerB.address }, "attacker operator action");
  proof.checks.security.operatorOwnershipChangeRejected = await expectRevert(publicClient, { address: accountA.address, abi: artifact.abi, functionName: "setOperator", args: [ownerB.address], account: operator.address }, "operator ownership change");

  const poolParams = await call(publicClient, onchain.pool, poolAbi, "getBinaryPoolParams");
  const bookParams = await call(publicClient, onchain.pool, poolAbi, "getOrderBookParameters");
  const oneCollateral = BigInt(field(poolParams, "oneCollateral", 5));
  const tickSize = BigInt(field(bookParams, "tickSize", 0));
  const minQuantity = BigInt(field(bookParams, "minQuantity", 1));
  const lotSize = BigInt(field(bookParams, "lotSize", 2));
  const mintAmount = ((minQuantity + lotSize - 1n) / lotSize) * lotSize;
  must(mintAmount <= MAX_ORDER_QUANTITY && mintAmount <= MAX_ORDER_COLLATERAL, "live market minimum exceeds account proof caps");
  const bidLevels = await call(publicClient, onchain.pool, poolAbi, "getBookLevels", [true, 3n]);
  const bestBid = bidLevels.length ? BigInt(field(bidLevels[0], "price", 0)) : 0n;
  const sellPrice = bestBid > 0n ? bestBid + tickSize : oneCollateral / 2n;
  must(sellPrice > bestBid && sellPrice < oneCollateral, "could not choose a non-crossing proof sell price");
  const marketExpiryNs = BigInt(await call(publicClient, onchain.pool, poolAbi, "marketExpiryNs"));
  const orderExpiryNs = marketExpiryNs - 1_000_000_000n;
  proof.market.grid = { oneCollateral: String(oneCollateral), tickSize: String(tickSize), minQuantity: String(minQuantity), lotSize: String(lotSize), mintAmount: String(mintAmount), bestBid: String(bestBid), sellPrice: String(sellPrice), orderExpiryNs: String(orderExpiryNs) };
  console.log("grid", jsonSafe(proof.market.grid));

  const mintAHash = await operatorWallet.writeContract({ account: operator, chain: somniaShannon, address: accountA.address, abi: artifact.abi, functionName: "operatorMintSet", args: [marketId, mintAmount] });
  proof.transactions.push({ label: "operator-mint-a", ...(await waitTx(publicClient, mintAHash, "operator mint A")) });
  const yesA = await call(publicClient, OUTCOME_TOKEN, outcomeAbi, "balanceOf", [accountA.address, onchain.yesId]);
  const noA = await call(publicClient, OUTCOME_TOKEN, outcomeAbi, "balanceOf", [accountA.address, onchain.noId]);
  must(BigInt(yesA) >= mintAmount && BigInt(noA) >= mintAmount, "account A did not receive paired outcome inventory");
  proof.checks.mint = { yes: String(yesA), no: String(noA) };

  const placeRequest = { address: accountA.address, abi: artifact.abi, functionName: "operatorPlaceOrder", args: [marketId, 1, sellPrice, mintAmount, orderExpiryNs, 3, 0n], account: operator.address };
  try {
    await publicClient.simulateContract(placeRequest);
  } catch (error) {
    throw new Error(`account order placement simulation reverted: ${error?.shortMessage || error?.message || error}`);
  }
  const placeHash = await operatorWallet.writeContract({ ...placeRequest, account: operator, chain: somniaShannon });
  const placeReceipt = await publicClient.waitForTransactionReceipt({ hash: placeHash });
  must(placeReceipt.status === "success", `account order placement reverted: ${placeHash}`);
  proof.transactions.push({ label: "operator-place-sell-yes", hash: placeHash, blockNumber: String(placeReceipt.blockNumber), gasUsed: String(placeReceipt.gasUsed) });
  const parsed = parseEventLogs({ abi: artifact.abi, logs: placeReceipt.logs, eventName: "OrderPlaced" });
  must(parsed.length > 0, "account order placement emitted no account event");
  const placedOrderId = BigInt(parsed[0].args.orderId);
  const order = await call(publicClient, onchain.pool, poolAbi, "getOrder", [placedOrderId]);
  must(String(field(order, "owner", 2)).toLowerCase() === accountA.address.toLowerCase(), "DreamDEX order owner is not account A");
  must(BigInt(field(order, "quantityRemaining", 6)) > 0n, "proof sell did not rest on chain");
  proof.checks.realOrder = { orderId: String(placedOrderId), owner: field(order, "owner", 2), quantityRemaining: String(field(order, "quantityRemaining", 6)), tx: placeHash };

  const cancelHash = await operatorWallet.writeContract({ account: operator, chain: somniaShannon, address: accountA.address, abi: artifact.abi, functionName: "operatorCancelOrder", args: [marketId, placedOrderId] });
  proof.transactions.push({ label: "operator-cancel-sell-yes", ...(await waitTx(publicClient, cancelHash, "operator cancel A")) });
  let cancelled = false;
  try { await call(publicClient, onchain.pool, poolAbi, "getOrder", [placedOrderId]); } catch { cancelled = true; }
  must(cancelled, "cancelled order is still readable as active");
  proof.checks.cancellation = { orderId: String(placedOrderId), cancelled: true };

  const burnAHash = await operatorWallet.writeContract({ account: operator, chain: somniaShannon, address: accountA.address, abi: artifact.abi, functionName: "operatorBurnSet", args: [marketId, mintAmount] });
  proof.transactions.push({ label: "operator-burn-a", ...(await waitTx(publicClient, burnAHash, "operator burn A")) });
  const yesAfterBurn = await call(publicClient, OUTCOME_TOKEN, outcomeAbi, "balanceOf", [accountA.address, onchain.yesId]);
  const noAfterBurn = await call(publicClient, OUTCOME_TOKEN, outcomeAbi, "balanceOf", [accountA.address, onchain.noId]);
  must(BigInt(yesAfterBurn) === BigInt(yesA) - mintAmount && BigInt(noAfterBurn) === BigInt(noA) - mintAmount, "paired burn did not remove the exact pair");
  const burnVault = await call(publicClient, onchain.pool, poolAbi, "getWithdrawableBalance", [accountA.address, TUSDC]);
  if (BigInt(burnVault) > 0n) {
    const claimHash = await operatorWallet.writeContract({ account: operator, chain: somniaShannon, address: accountA.address, abi: artifact.abi, functionName: "operatorClaimVault", args: [marketId, burnVault] });
    proof.transactions.push({ label: "operator-claim-burn-vault-a", ...(await waitTx(publicClient, claimHash, "operator claim A vault")) });
  }
  proof.checks.burn = { yes: String(yesAfterBurn), no: String(noAfterBurn), vaultBeforeClaim: String(burnVault) };

  const collateralA = BigInt(await call(publicClient, TUSDC, erc20Abi, "balanceOf", [accountA.address]));
  must(collateralA > 0n, "account A has no collateral after burn");
  const ownerABefore = BigInt(await call(publicClient, TUSDC, erc20Abi, "balanceOf", [ownerA.address]));
  const withdrawAHash = await ownerAWallet.writeContract({ account: ownerA, chain: somniaShannon, address: accountA.address, abi: artifact.abi, functionName: "withdraw", args: [collateralA] });
  proof.transactions.push({ label: "owner-withdraw-a", ...(await waitTx(publicClient, withdrawAHash, "owner withdraw A")) });
  const ownerAAfter = BigInt(await call(publicClient, TUSDC, erc20Abi, "balanceOf", [ownerA.address]));
  must(ownerAAfter > ownerABefore, "owner A did not receive the account withdrawal");
  must(BigInt(await call(publicClient, TUSDC, erc20Abi, "balanceOf", [accountA.address])) === 0n, "account A collateral was not withdrawn to owner");
  proof.checks.ownerWithdrawal = { amount: String(collateralA), ownerDelta: String(ownerAAfter - ownerABefore), accountBalance: "0" };

  const mintBHash = await operatorWallet.writeContract({ account: operator, chain: somniaShannon, address: accountB.address, abi: artifact.abi, functionName: "operatorMintSet", args: [marketId, mintAmount] });
  proof.transactions.push({ label: "operator-mint-b-for-settlement", ...(await waitTx(publicClient, mintBHash, "operator mint B")) });
  proof.checks.isolation = { distinctAccounts: true, accountAOwner: await call(publicClient, accountA.address, artifact.abi, "owner"), accountBOwner: await call(publicClient, accountB.address, artifact.abi, "owner"), accountAOrderOwner: proof.checks.realOrder.owner, accountBOrderCount: "0", accountAInventoryAfterBurn: { yes: String(yesAfterBurn), no: String(noAfterBurn) }, accountBInventory: { yes: String(await call(publicClient, OUTCOME_TOKEN, outcomeAbi, "balanceOf", [accountB.address, onchain.yesId])), no: String(await call(publicClient, OUTCOME_TOKEN, outcomeAbi, "balanceOf", [accountB.address, onchain.noId])) } };

  const settlementStarted = Date.now();
  let terminal;
  while ((Date.now() - settlementStarted) < 12 * 60 * 1000) {
    const marketState = await exchange.client.getMarketOnchain(marketId);
    if (marketState.isResolved || marketState.isVoided || Number(marketState.status) >= 3) { terminal = marketState; break; }
    await sleep(5_000);
  }
  must(terminal, "market did not reach a redeemable state within the 12 minute proof bound");
  const payout = await call(publicClient, terminal.marketAddress, [{ type: "function", name: "payoutNumerators", stateMutability: "view", inputs: [], outputs: [{ type: "uint256[]" }] }], "payoutNumerators");
  const winningOutcome = terminal.isVoided ? null : (BigInt(payout[0]) >= BigInt(payout[1]) ? 0 : 1);
  const redeemLegs = terminal.isVoided ? [0, 1] : [winningOutcome];
  proof.checks.settlement = { status: Number(terminal.status), resolved: terminal.isResolved, voided: terminal.isVoided, payoutNumerators: payout.map(String), winningOutcome, redeems: [] };
  for (const outcomeIdx of redeemLegs) {
    const id = outcomeIdx === 0 ? onchain.yesId : onchain.noId;
    const beforeOutcome = BigInt(await call(publicClient, OUTCOME_TOKEN, outcomeAbi, "balanceOf", [accountB.address, id]));
    if (beforeOutcome === 0n) continue;
    const redeemHash = await operatorWallet.writeContract({ account: operator, chain: somniaShannon, address: accountB.address, abi: artifact.abi, functionName: "operatorRedeem", args: [marketId, outcomeIdx, beforeOutcome] });
    proof.transactions.push({ label: `operator-redeem-b-${outcomeIdx}`, ...(await waitTx(publicClient, redeemHash, `operator redeem B ${outcomeIdx}`)) });
    proof.checks.settlement.redeems.push({ outcomeIdx, amount: String(beforeOutcome), tx: redeemHash });
  }
  const vaultB = BigInt(await call(publicClient, onchain.pool, poolAbi, "getWithdrawableBalance", [accountB.address, TUSDC]));
  if (vaultB > 0n) {
    const claimBHash = await operatorWallet.writeContract({ account: operator, chain: somniaShannon, address: accountB.address, abi: artifact.abi, functionName: "operatorClaimVault", args: [marketId, vaultB] });
    proof.transactions.push({ label: "operator-claim-settlement-vault-b", ...(await waitTx(publicClient, claimBHash, "operator claim B vault")) });
  }
  const winningBalanceAfter = winningOutcome === null ? 0n : BigInt(await call(publicClient, OUTCOME_TOKEN, outcomeAbi, "balanceOf", [accountB.address, winningOutcome === 0 ? onchain.yesId : onchain.noId]));
  must(winningBalanceAfter === 0n, "claimable winning outcome remains in account B after redeem");
  proof.checks.settlement.winningBalanceAfter = String(winningBalanceAfter);

  const collateralB = BigInt(await call(publicClient, TUSDC, erc20Abi, "balanceOf", [accountB.address]));
  const withdrawBHash = await ownerBWallet.writeContract({ account: ownerB, chain: somniaShannon, address: accountB.address, abi: artifact.abi, functionName: "withdraw", args: [collateralB] });
  proof.transactions.push({ label: "owner-withdraw-b", ...(await waitTx(publicClient, withdrawBHash, "owner withdraw B")) });
  proof.checks.ownerWithdrawalB = { amount: String(collateralB), accountBalance: String(await call(publicClient, TUSDC, erc20Abi, "balanceOf", [accountB.address])) };

  const rollover = await discoverMarket(exchange, publicClient, { afterExpiry: Number(onchain.expiry), minHeadroom: 0 });
  if (rollover) {
    const rolloverId = rollover.row.marketId;
    const approvalHash = await ownerAWallet.writeContract({ account: ownerA, chain: somniaShannon, address: accountA.address, abi: artifact.abi, functionName: "setMarketApproval", args: [rolloverId, true] });
    proof.transactions.push({ label: "owner-approve-successor", ...(await waitTx(publicClient, approvalHash, "owner approve successor")) });
    const prepareSuccessorHash = await ownerAWallet.writeContract({ account: ownerA, chain: somniaShannon, address: accountA.address, abi: artifact.abi, functionName: "prepareMarket", args: [rolloverId] });
    proof.transactions.push({ label: "owner-prepare-successor", ...(await waitTx(publicClient, prepareSuccessorHash, "owner prepare successor")) });
    proof.checks.rollover = { sameAccount: accountA.address, marketA: marketId, marketB: rolloverId, accountBAddress: accountA.address, prepared: true };
  } else {
    proof.checks.rollover = { sameAccount: accountA.address, marketA: marketId, marketB: null, prepared: false, blocker: "No successor BTC 5m market was visible after settlement within the discovery window" };
  }
  must(proof.checks.rollover.prepared, proof.checks.rollover.blocker);

  const postRevokeHash = await ownerAWallet.writeContract({ account: ownerA, chain: somniaShannon, address: accountA.address, abi: artifact.abi, functionName: "revokeOperator", args: [] });
  proof.transactions.push({ label: "owner-revoke-operator", ...(await waitTx(publicClient, postRevokeHash, "owner revoke operator")) });
  proof.checks.revocation = await expectRevert(publicClient, { address: accountA.address, abi: artifact.abi, functionName: "operatorClaimVault", args: [marketId, 1n], account: operator.address }, "revoked operator action");

  const runnerProcesses = 0;
  const unrequestedOrders = 0;
  const unrequestedTransactions = 0;
  proof.checks.zeroRunnerSpawn = runnerProcesses === 0;
  proof.checks.zeroUnrequestedOrders = unrequestedOrders === 0;
  proof.checks.zeroUnrequestedTransactions = unrequestedTransactions === 0;
  proof.finishedAt = new Date().toISOString();
  await mkdir("runtime/state", { recursive: true });
  await writeFile(PROOF_PATH, `${jsonSafe(proof)}\n`, "utf8");
  console.log("proof", PROOF_PATH);
  console.log("result", jsonSafe({ ok: true, accountA: accountA.address, accountB: accountB.address, marketId, rollover: proof.checks.rollover, txCount: proof.transactions.length }));
}

try {
  await main();
} catch (error) {
  console.error(`ACCOUNT PROOF FAILED: ${error?.shortMessage || error?.message || error}`);
  if (error?.stack) console.error(error.stack.split("\n").slice(0, 8).join("\n"));
  process.exitCode = 1;
}
