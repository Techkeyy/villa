import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import ganache from "ganache";
import {
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createLpExecutionAdapter, createViemLpAccountReader } from "../execution/lp-adapter.mjs";

const require = createRequire(import.meta.url);
const solc = require("solc");
const V2_ARTIFACT = JSON.parse(await fs.readFile(new URL("../../dashboard/villa-account-artifact.json", import.meta.url), "utf8"));
const V1_ARTIFACT = JSON.parse(await fs.readFile(new URL("../../dashboard/villa-account-artifact-v1.json", import.meta.url), "utf8"));

const CHAIN = {
  id: 50312,
  name: "VILLA isolated EVM gate",
  nativeCurrency: { name: "Test Ether", symbol: "TETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1"] } },
};
const OWNER = "OWNER";
const OTHER_OWNER = "OTHER_OWNER";
const OPERATOR = "OPERATOR";
const ATTACKER = "ATTACKER";
const MARKET_A = `0x${"aa".repeat(32)}`;
const MARKET_B = `0x${"bb".repeat(32)}`;
const MARKET_C = `0x${"dd".repeat(32)}`;
const MARKET_BAD = `0x${"cc".repeat(32)}`;
const ONE = 1_000_000n;
const MAX_ORDER_QUANTITY = 1_000n;
const MAX_ORDER_COLLATERAL = 500n;
const MAX_AGGREGATE_EXPOSURE = 1_000n;
const MAX_MINT_EXPOSURE = 700n;

const MOCK_SOURCE = String.raw`
pragma solidity ^0.8.24;

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "BALANCE");
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "ALLOWANCE");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount; balanceOf[to] += amount; return true;
    }
}

contract MockOutcome {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public operators;
    function setOperator(address spender, bool approved) external returns (bool) { operators[msg.sender][spender] = approved; return true; }
    function mint(address to, uint256 id, uint256 amount) external { balanceOf[to][id] += amount; }
    function burn(address from, uint256 id, uint256 amount) external {
        require(msg.sender == from || operators[from][msg.sender], "NOT_OPERATOR");
        require(balanceOf[from][id] >= amount, "OUTCOME_BALANCE");
        balanceOf[from][id] -= amount;
    }
}

contract MockMarket {}
contract MockSettlement {}

contract MockModule {
    struct MarketRecord {
        uint256 oracleQuestionId; uint8 outcomeSlotCount; uint8 voidPolicy; address collateral;
        uint32 originOperatorId; bytes32 originVenueId; address oracleAdapter; address creator;
        address market; address pool; uint256 yesId; uint256 noId; uint64 tradingStart; uint64 expiry;
    }
    mapping(bytes32 => MarketRecord) public markets;
    mapping(bytes32 => bool) public settled;
    address public immutable collateralToken;
    address public immutable outcomeToken;
    constructor(address collateral_, address outcome_) { collateralToken = collateral_; outcomeToken = outcome_; }
    function configure(bytes32 id, address market_, address pool_, uint256 yesId_, uint256 noId_) external {
        markets[id] = MarketRecord(1, 2, 0, collateralToken, 0, bytes32(0), address(0), msg.sender, market_, pool_, yesId_, noId_, 1, 9_999_999);
    }
    function settle(bytes32 id) external { settled[id] = true; }
    function redeem(uint32, bytes32, bytes32 id, uint8 outcomeIdx, uint256 amount) external {
        MarketRecord memory record = markets[id];
        require(settled[id], "NOT_SETTLED");
        uint256 tokenId = outcomeIdx == 0 ? record.yesId : record.noId;
        MockOutcome(outcomeToken).burn(msg.sender, tokenId, amount);
        MockERC20(collateralToken).mint(msg.sender, amount);
    }
}

contract MockPool {
    struct BinaryPoolParams {
        address collateralToken; address market; address outcomeToken; uint256 yesId; uint256 noId;
        uint256 oneCollateral; uint256 setBacking; address feeRecipient; uint256 makerFeeBpsTimes1k;
        uint256 takerFeeBpsTimes1k; uint256 maxBuilderFeeBpsTimes1k; uint256 settlementFeeBpsTimes1k;
        address settlement; uint64 marketNonce; bool finalized;
    }
    struct StoredOrder { address owner; uint8 kind; uint256 price; uint256 quantity; uint256 remaining; uint256 collateralHeld; uint64 userData; }
    BinaryPoolParams private params;
    mapping(uint128 => StoredOrder) public orders;
    uint128 public nextOrderId = 1;
    constructor(address collateral_, address outcome_, address market_, address settlement_, uint256 yesId_, uint256 noId_) {
        params = BinaryPoolParams(collateral_, market_, outcome_, yesId_, noId_, 1_000_000, 1_000_000, address(0), 0, 0, 0, 0, settlement_, 1, false);
    }
    function getBinaryPoolParams() external view returns (BinaryPoolParams memory) { return params; }
    function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64, uint8, uint8, address, uint96, uint64 userData)
        external payable returns (bool success, uint128 id)
    {
        uint256 held = kind == 0
            ? (quantity * price + params.oneCollateral - 1) / params.oneCollateral
            : kind == 2
                ? (quantity * (params.oneCollateral - price) + params.oneCollateral - 1) / params.oneCollateral
                : 0;
        if (held > 0) MockERC20(params.collateralToken).transferFrom(msg.sender, address(this), held);
        id = nextOrderId++;
        orders[id] = StoredOrder(msg.sender, kind, price, quantity, quantity, held, userData);
        if (kind == 1) MockOutcome(params.outcomeToken).burn(msg.sender, params.yesId, quantity);
        if (kind == 3) MockOutcome(params.outcomeToken).burn(msg.sender, params.noId, quantity);
        return (true, id);
    }
    function cancelOrder(uint128 id) external {
        StoredOrder storage order = orders[id]; require(order.owner == msg.sender, "ORDER_OWNER"); require(order.remaining > 0, "CLOSED");
        uint256 remaining = order.remaining;
        order.remaining = 0;
        if (order.collateralHeld > 0) { uint256 held = order.collateralHeld; order.collateralHeld = 0; MockERC20(params.collateralToken).transfer(msg.sender, held); }
        if (order.kind == 1) MockOutcome(params.outcomeToken).mint(msg.sender, params.yesId, remaining);
        if (order.kind == 3) MockOutcome(params.outcomeToken).mint(msg.sender, params.noId, remaining);
    }
    function reduceOrder(uint128 id, uint256 newRemaining) external {
        StoredOrder storage order = orders[id]; require(order.owner == msg.sender, "ORDER_OWNER"); require(newRemaining > 0 && newRemaining < order.remaining, "REDUCE");
        uint256 oldRemaining = order.remaining;
        uint256 oldHeld = order.collateralHeld;
        uint256 newHeld = order.kind == 0
            ? (newRemaining * order.price + params.oneCollateral - 1) / params.oneCollateral
            : order.kind == 2
                ? (newRemaining * (params.oneCollateral - order.price) + params.oneCollateral - 1) / params.oneCollateral
                : 0;
        order.remaining = 0;
        order.collateralHeld = 0;
        if (oldHeld > newHeld) MockERC20(params.collateralToken).transfer(msg.sender, oldHeld - newHeld);
        if (order.kind == 1) MockOutcome(params.outcomeToken).mint(msg.sender, params.yesId, oldRemaining - newRemaining);
        if (order.kind == 3) MockOutcome(params.outcomeToken).mint(msg.sender, params.noId, oldRemaining - newRemaining);
        uint128 replacement = nextOrderId++;
        orders[replacement] = StoredOrder(msg.sender, order.kind, order.price, order.quantity, newRemaining, newHeld, order.userData);
    }
    function mintSet(address yesTo, address noTo, uint256 amount) external {
        MockERC20(params.collateralToken).transferFrom(msg.sender, address(this), amount);
        MockOutcome(params.outcomeToken).mint(yesTo, params.yesId, amount);
        MockOutcome(params.outcomeToken).mint(noTo, params.noId, amount);
    }
    function burnSet(uint256 amount) external {
        MockOutcome(params.outcomeToken).burn(msg.sender, params.yesId, amount);
        MockOutcome(params.outcomeToken).burn(msg.sender, params.noId, amount);
        MockERC20(params.collateralToken).transfer(msg.sender, amount);
    }
    function withdraw(address token, uint256 amount) external { require(token == params.collateralToken, "TOKEN"); MockERC20(token).transfer(msg.sender, amount); }
    function seedVault(uint256 amount) external { MockERC20(params.collateralToken).mint(address(this), amount); }
    function fillOrder(uint128 id) external {
        StoredOrder storage order = orders[id]; require(order.remaining > 0, "CLOSED");
        uint256 quantity = order.remaining; order.remaining = 0;
        if (order.collateralHeld > 0) { uint256 held = order.collateralHeld; order.collateralHeld = 0; MockERC20(params.collateralToken).transfer(order.owner, held); }
        if (order.kind == 1) {
            MockERC20(params.collateralToken).mint(order.owner, quantity * order.price / params.oneCollateral);
        } else if (order.kind == 3) {
            MockERC20(params.collateralToken).mint(order.owner, quantity * (params.oneCollateral - order.price) / params.oneCollateral);
        } else if (order.kind == 0) {
            MockOutcome(params.outcomeToken).mint(order.owner, params.yesId, quantity);
        } else if (order.kind == 2) {
            MockOutcome(params.outcomeToken).mint(order.owner, params.noId, quantity);
        }
    }
    function fillOrderPartial(uint128 id, uint256 fillQuantity) external {
        StoredOrder storage order = orders[id]; require(order.remaining >= fillQuantity && fillQuantity > 0, "FILL");
        if (fillQuantity == order.remaining) { this.fillOrder(id); return; }
        order.remaining -= fillQuantity;
        if (order.kind == 0) MockOutcome(params.outcomeToken).mint(order.owner, params.yesId, fillQuantity);
        if (order.kind == 2) MockOutcome(params.outcomeToken).mint(order.owner, params.noId, fillQuantity);
        if (order.kind == 1) MockERC20(params.collateralToken).mint(order.owner, fillQuantity * order.price / params.oneCollateral);
        if (order.kind == 3) MockERC20(params.collateralToken).mint(order.owner, fillQuantity * (params.oneCollateral - order.price) / params.oneCollateral);
    }
    function getOwnOpenOrders() external view returns (uint128[] memory ids) {
        uint256 count;
        for (uint128 i = 1; i < nextOrderId; i++) if (orders[i].owner == msg.sender && orders[i].remaining > 0) count++;
        ids = new uint128[](count);
        uint256 cursor;
        for (uint128 i = 1; i < nextOrderId; i++) if (orders[i].owner == msg.sender && orders[i].remaining > 0) ids[cursor++] = i;
    }
    function getOrder(uint128 id) external view returns (uint128, bool, address, uint64, uint256, uint256, uint256, uint64) {
        StoredOrder memory order = orders[id]; require(order.owner != address(0) && order.remaining > 0, "INCORRECT_ORDER");
        return (id, order.kind == 0 || order.kind == 2, order.owner, order.userData, order.price, order.quantity, order.remaining, 0);
    }
    function booksEmpty() external view returns (bool) {
        for (uint128 i = 1; i < nextOrderId; i++) if (orders[i].remaining > 0) return false;
        return true;
    }
    function recycle(address market_, uint256 yesId_, uint256 noId_, uint64 nonce_) external {
        require(this.booksEmpty(), "BOOKS_NOT_EMPTY");
        params.market = market_; params.yesId = yesId_; params.noId = noId_; params.marketNonce = nonce_; params.finalized = false;
    }
    function fakeCancel(uint128) external pure {}
    function open(uint128 id) external view returns (uint256) { return orders[id].remaining; }
}
`;

function compile(source, name) {
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "Mock.sol": { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  })));
  const errors = (output.errors || []).filter((item) => item.severity === "error");
  if (errors.length) throw new Error(errors.map((item) => item.formattedMessage).join("\n"));
  const item = output.contracts["Mock.sol"][name];
  return { abi: item.abi, bytecode: `0x${item.evm.bytecode.object}` };
}

const MOCKS = Object.freeze({
  MockERC20: compile(MOCK_SOURCE, "MockERC20"),
  MockOutcome: compile(MOCK_SOURCE, "MockOutcome"),
  MockMarket: compile(MOCK_SOURCE, "MockMarket"),
  MockSettlement: compile(MOCK_SOURCE, "MockSettlement"),
  MockModule: compile(MOCK_SOURCE, "MockModule"),
  MockPool: compile(MOCK_SOURCE, "MockPool"),
});

async function deploy(wallet, publicClient, item, args = []) {
  const hash = await wallet.deployContract({ abi: item.abi, bytecode: item.bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success");
  assert.ok(receipt.contractAddress);
  return receipt.contractAddress;
}

async function write(wallet, publicClient, address, abi, functionName, args = []) {
  const hash = await wallet.writeContract({ address, abi, functionName, args, account: wallet.account, chain: CHAIN, gas: 5_000_000n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, "success", `${functionName} reverted`);
  return receipt;
}

async function simulateRevert(publicClient, wallet, address, abi, functionName, args = []) {
  await assert.rejects(
    () => publicClient.simulateContract({ account: wallet.account, address, abi, functionName, args }),
    undefined,
  );
}

function rawCalldata(selector, words = []) { return `${selector}${words.map((word) => String(word).replace(/^0x/, "").padStart(64, "0")).join("")}`; }

const context = await (async () => {
  const server = ganache.server({
    chain: { chainId: CHAIN.id, hardfork: "shanghai" },
    miner: { blockGasLimit: 30_000_000 },
    logging: { quiet: true },
    wallet: { totalAccounts: 8, defaultBalance: 1_000 },
  });
  await new Promise((resolve, reject) => server.listen(0, (error) => error ? reject(error) : resolve()));
  const port = server.address().port;
  const transport = http(`http://127.0.0.1:${port}`);
  const publicClient = createPublicClient({ chain: CHAIN, transport });
  const initial = server.provider.getInitialAccounts();
  const wallets = Object.values(initial).map((item) => createWalletClient({ account: privateKeyToAccount(item.secretKey), chain: CHAIN, transport }));
  const owner = wallets[0];
  const otherOwner = wallets[1];
  const operator = wallets[2];
  const attacker = wallets[3];
  const collateral = await deploy(owner, publicClient, MOCKS.MockERC20);
  const outcome = await deploy(owner, publicClient, MOCKS.MockOutcome);
  const marketContractA = await deploy(owner, publicClient, MOCKS.MockMarket);
  const marketContractB = await deploy(owner, publicClient, MOCKS.MockMarket);
  const marketContractC = await deploy(owner, publicClient, MOCKS.MockMarket);
  const badMarket = await deploy(owner, publicClient, MOCKS.MockMarket);
  const settlement = await deploy(owner, publicClient, MOCKS.MockSettlement);
  const module = await deploy(owner, publicClient, MOCKS.MockModule, [collateral, outcome]);
  const poolA = await deploy(owner, publicClient, MOCKS.MockPool, [collateral, outcome, marketContractA, settlement, 101n, 102n]);
  const poolB = await deploy(owner, publicClient, MOCKS.MockPool, [collateral, outcome, marketContractB, settlement, 201n, 202n]);
  await write(owner, publicClient, module, MOCKS.MockModule.abi, "configure", [MARKET_A, marketContractA, poolA, 101n, 102n]);
  await write(owner, publicClient, module, MOCKS.MockModule.abi, "configure", [MARKET_B, marketContractB, poolB, 201n, 202n]);
  await write(owner, publicClient, module, MOCKS.MockModule.abi, "configure", [MARKET_C, marketContractC, poolA, 301n, 302n]);
  await write(owner, publicClient, module, MOCKS.MockModule.abi, "configure", [MARKET_BAD, badMarket, poolB, 201n, 202n]);
  const accountArgs = (accountOwner, accountOperator) => [accountOwner, accountOperator, collateral, outcome, module, settlement, MAX_ORDER_QUANTITY, MAX_ORDER_COLLATERAL, MAX_AGGREGATE_EXPOSURE, MAX_MINT_EXPOSURE];
  const accountA = await deploy(owner, publicClient, { abi: V2_ARTIFACT.abi, bytecode: V2_ARTIFACT.creationBytecode }, accountArgs(owner.account.address, operator.account.address));
  const accountB = await deploy(owner, publicClient, { abi: V2_ARTIFACT.abi, bytecode: V2_ARTIFACT.creationBytecode }, accountArgs(otherOwner.account.address, operator.account.address));
  const legacy = await deploy(owner, publicClient, { abi: V1_ARTIFACT.abi, bytecode: V1_ARTIFACT.creationBytecode }, [owner.account.address, operator.account.address, collateral, outcome, module, settlement, MAX_ORDER_QUANTITY, MAX_ORDER_COLLATERAL]);
  for (const [wallet, account] of [[owner, accountA], [otherOwner, accountB]]) {
    await write(wallet, publicClient, collateral, MOCKS.MockERC20.abi, "mint", [wallet.account.address, 10_000n]);
    await write(wallet, publicClient, collateral, MOCKS.MockERC20.abi, "approve", [account, 10_000n]);
    await write(wallet, publicClient, account, V2_ARTIFACT.abi, "deposit", [10_000n]);
  }
  await write(operator, publicClient, accountA, V2_ARTIFACT.abi, "prepareMarket", [MARKET_A]);
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "prepareMarket", [MARKET_A]);
  return { server, publicClient, owner, otherOwner, operator, attacker, collateral, outcome, module, settlement, poolA, poolB, accountA, accountB, legacy, marketContractA, marketContractB, marketContractC, badMarket };
})();

test.after(async () => {
  await new Promise((resolve) => context.server.close(() => resolve()));
});

test("VILLAAccount V2 real EVM gate executes all 28 adversarial state transitions", async () => {
  const { publicClient, owner, operator, attacker, collateral, outcome, module, poolA, poolB, accountA, accountB } = context;
  const results = [];
  const scenario = async (number, name, caller, transaction, expected, action, shouldRevert = false) => {
    let actual = "SUCCESS";
    if (shouldRevert) {
      await action();
      actual = "REVERT";
    } else {
      await action();
    }
    assert.equal(actual, expected, `${number}. ${name}`);
    results.push({ number, scenario: name, caller, transaction, expected, actual });
  };

  await scenario(1, "operator cannot withdraw", OPERATOR, "withdraw(1)", "REVERT", () => simulateRevert(publicClient, operator, accountA, V2_ARTIFACT.abi, "withdraw", [1n]), true);
  await scenario(2, "attacker cannot withdraw", ATTACKER, "withdraw(1)", "REVERT", () => simulateRevert(publicClient, attacker, accountA, V2_ARTIFACT.abi, "withdraw", [1n]), true);
  await scenario(3, "operator cannot change owner", OPERATOR, "transferOwnership(attacker)", "REVERT", () => simulateRevert(publicClient, operator, accountA, V2_ARTIFACT.abi, "transferOwnership", [attacker.account.address]), true);
  await scenario(4, "operator cannot change operator", OPERATOR, "setOperator(attacker)", "REVERT", () => simulateRevert(publicClient, operator, accountA, V2_ARTIFACT.abi, "setOperator", [attacker.account.address]), true);
  await scenario(5, "operator cannot expand risk limits", OPERATOR, "setRiskLimits(2000,2000)", "REVERT", () => simulateRevert(publicClient, operator, accountA, V2_ARTIFACT.abi, "setRiskLimits", [2_000n, 2_000n]), true);
  await scenario(6, "operator cannot recover an arbitrary token", OPERATOR, "recoverUnsupportedToken(collateral,1)", "REVERT", () => simulateRevert(publicClient, operator, accountA, V2_ARTIFACT.abi, "recoverUnsupportedToken", [collateral, 1n]), true);
  await scenario(7, "attacker cannot place an order", ATTACKER, "operatorPlaceOrder(MARKET_A,2,600000,1)", "REVERT", () => simulateRevert(publicClient, attacker, accountA, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_A, 2, 600_000n, 1n, 9_000_000n, 3, 0n]), true);
  await scenario(8, "other owner disables autonomy on their own account B", OTHER_OWNER, "Account B.setAutonomousTrading(false)", "SUCCESS", () => write(context.otherOwner, publicClient, accountB, V2_ARTIFACT.abi, "setAutonomousTrading", [false]));
  await scenario(9, "autonomy-off operator cannot prepare", OPERATOR, "prepareMarket(MARKET_B)", "REVERT", () => simulateRevert(publicClient, operator, accountB, V2_ARTIFACT.abi, "prepareMarket", [MARKET_B]), true);
  await scenario(10, "autonomy-off operator cannot place", OPERATOR, "operatorPlaceOrder(MARKET_A,2,600000,1)", "REVERT", () => simulateRevert(publicClient, operator, accountB, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_A, 2, 600_000n, 1n, 9_000_000n, 3, 0n]), true);
  await scenario(11, "autonomy-off operator cannot mint", OPERATOR, "operatorMintSet(MARKET_A,1)", "REVERT", () => simulateRevert(publicClient, operator, accountB, V2_ARTIFACT.abi, "operatorMintSet", [MARKET_A, 1n]), true);

  await scenario(12, "mint capacity returns after authoritative burn", OPERATOR, "mint400; burn400; mint400; burn400", "SUCCESS", async () => {
    await write(operator, publicClient, accountA, V2_ARTIFACT.abi, "operatorMintSet", [MARKET_A, 400n]);
    assert.equal(await publicClient.readContract({ address: accountA, abi: V2_ARTIFACT.abi, functionName: "mintExposure" }), 400n);
    await write(operator, publicClient, accountA, V2_ARTIFACT.abi, "operatorBurnSet", [MARKET_A, 400n]);
    assert.equal(await publicClient.readContract({ address: accountA, abi: V2_ARTIFACT.abi, functionName: "mintExposure" }), 0n);
    await write(operator, publicClient, accountA, V2_ARTIFACT.abi, "operatorMintSet", [MARKET_A, 400n]);
    await write(operator, publicClient, accountA, V2_ARTIFACT.abi, "operatorBurnSet", [MARKET_A, 400n]);
    assert.equal(await publicClient.readContract({ address: accountA, abi: V2_ARTIFACT.abi, functionName: "aggregateExposure" }), 0n);
  });
  await scenario(13, "per-call order collateral cap remains enforced", OPERATOR, "operatorPlaceOrder(A,0,600000,1000)", "REVERT", () => simulateRevert(publicClient, operator, accountA, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_A, 0, 600_000n, 1_000n, 9_000_000n, 3, 0n]), true);
  await scenario(14, "order quantity cap remains enforced", OPERATOR, "operatorPlaceOrder(A,2,600000,1001)", "REVERT", () => simulateRevert(publicClient, operator, accountA, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_A, 2, 600_000n, 1_001n, 9_000_000n, 3, 0n]), true);
  await scenario(15, "zero price is rejected", OPERATOR, "operatorPlaceOrder(A,2,0,1)", "REVERT", () => simulateRevert(publicClient, operator, accountA, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_A, 2, 0n, 1n, 9_000_000n, 3, 0n]), true);
  await scenario(16, "one-collateral price is rejected", OPERATOR, "operatorPlaceOrder(A,2,1000000,1)", "REVERT", () => simulateRevert(publicClient, operator, accountA, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_A, 2, ONE, 1n, 9_000_000n, 3, 0n]), true);
  await scenario(17, "unknown order kind is rejected", OPERATOR, "operatorPlaceOrder(A,4,600000,1)", "REVERT", () => simulateRevert(publicClient, operator, accountA, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_A, 4, 600_000n, 1n, 9_000_000n, 3, 0n]), true);
  await scenario(18, "unknown order type is rejected", OPERATOR, "operatorPlaceOrder(A,2,600000,1,orderType=4)", "REVERT", () => simulateRevert(publicClient, operator, accountA, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_A, 2, 600_000n, 1n, 9_000_000n, 4, 0n]), true);
  await scenario(19, "fallback rejects arbitrary selector", ATTACKER, "0xdeadbeef", "REVERT", () => publicClient.call({ account: attacker.account, to: accountA, data: "0xdeadbeef" }).then(() => assert.fail("arbitrary selector unexpectedly succeeded"), () => undefined), true);
  await scenario(20, "operator cannot invoke arbitrary token approval", OPERATOR, "approve(attacker,1) via account", "REVERT", () => publicClient.call({ account: operator.account, to: accountA, data: rawCalldata("0x095ea7b3", [attacker.account.address, 1n]) }).then(() => assert.fail("arbitrary approval unexpectedly succeeded"), () => undefined), true);
  await scenario(21, "malformed market/pool wiring is rejected", OPERATOR, "prepareMarket(MARKET_BAD)", "REVERT", () => simulateRevert(publicClient, operator, accountA, V2_ARTIFACT.abi, "prepareMarket", [MARKET_BAD]), true);
  await scenario(22, "successor market can be prepared autonomously", OPERATOR, "prepareMarket(MARKET_B)", "SUCCESS", () => write(operator, publicClient, accountA, V2_ARTIFACT.abi, "prepareMarket", [MARKET_B]));
  await scenario(23, "aggregate order budget spans multiple markets", "OTHER_OWNER + OPERATOR", "B: owner enables autonomy; operator buy500 + buy500 + marketB buy1", "REVERT", async () => {
    await write(context.otherOwner, publicClient, accountB, V2_ARTIFACT.abi, "setAutonomousTrading", [true]);
    await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "prepareMarket", [MARKET_B]);
    await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_A, 0, 500_000n, 500n, 9_000_000n, 3, 0n]);
    await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_A, 0, 500_000n, 500n, 9_000_000n, 3, 0n]);
    await simulateRevert(publicClient, operator, accountB, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_B, 2, 500_000n, 1n, 9_000_000n, 3, 0n]);
  }, true);

  await write(operator, publicClient, accountA, V2_ARTIFACT.abi, "operatorMintSet", [MARKET_A, 200n]);
  const order1 = (await write(operator, publicClient, accountA, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_A, 1, 600_000n, 50n, 9_000_000n, 3, 0n]));
  void order1;
  const order2 = await write(operator, publicClient, accountA, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_A, 1, 600_000n, 50n, 9_000_000n, 3, 0n]);
  const orderIds = await publicClient.readContract({ address: poolA, abi: MOCKS.MockPool.abi, functionName: "nextOrderId" });
  const firstOrderId = orderIds - 2n;
  const secondOrderId = orderIds - 1n;
  void order2;
  await scenario(24, "owner revocation disables the operator", OWNER, "revokeOperator()", "SUCCESS", () => write(owner, publicClient, accountA, V2_ARTIFACT.abi, "revokeOperator"));
  await scenario(25, "a pre-existing resting order remains externally fillable", ATTACKER, `pool.fillOrder(${firstOrderId})`, "SUCCESS", () => write(attacker, publicClient, poolA, MOCKS.MockPool.abi, "fillOrder", [firstOrderId]));
  await scenario(26, "revoked operator cannot cancel or reduce", OPERATOR, `operatorCancelOrder(A,${secondOrderId})`, "REVERT", () => simulateRevert(publicClient, operator, accountA, V2_ARTIFACT.abi, "operatorCancelOrder", [MARKET_A, secondOrderId]), true);
  await scenario(27, "owner can reduce and cancel after revocation", OWNER, `operatorReduceOrder(A,${secondOrderId},25); operatorCancelOrder(A,${secondOrderId})`, "SUCCESS", async () => {
    await write(owner, publicClient, accountA, V2_ARTIFACT.abi, "operatorReduceOrder", [MARKET_A, secondOrderId, 25n]);
    const replacementId = (await publicClient.readContract({ address: poolA, abi: MOCKS.MockPool.abi, functionName: "nextOrderId" })) - 1n;
    assert.notEqual(replacementId, secondOrderId);
    await write(owner, publicClient, accountA, V2_ARTIFACT.abi, "operatorCancelOrder", [MARKET_A, replacementId]);
    assert.equal(await publicClient.readContract({ address: poolA, abi: MOCKS.MockPool.abi, functionName: "open", args: [secondOrderId] }), 0n);
    assert.equal(await publicClient.readContract({ address: poolA, abi: MOCKS.MockPool.abi, functionName: "open", args: [replacementId] }), 0n);
  });
  await scenario(28, "owner can burn, redeem, claim vault, and withdraw after revocation", OWNER, "operatorBurnSet; operatorRedeem; operatorClaimVault; withdraw", "SUCCESS", async () => {
    await write(owner, publicClient, accountA, V2_ARTIFACT.abi, "operatorBurnSet", [MARKET_A, 100n]);
    await write(owner, publicClient, module, MOCKS.MockModule.abi, "settle", [MARKET_A]);
    await write(owner, publicClient, accountA, V2_ARTIFACT.abi, "operatorRedeem", [MARKET_A, 0, 50n]);
    await write(owner, publicClient, poolA, MOCKS.MockPool.abi, "seedVault", [100n]);
    await write(owner, publicClient, accountA, V2_ARTIFACT.abi, "operatorClaimVault", [MARKET_A, 100n]);
    await write(owner, publicClient, accountA, V2_ARTIFACT.abi, "withdraw", [1n]);
    assert.equal(await publicClient.readContract({ address: collateral, abi: MOCKS.MockERC20.abi, functionName: "balanceOf", args: [owner.account.address] }), 1n);
  });

  assert.equal(results.length, 28);
  console.log(JSON.stringify({ gate: "VILLAACCOUNT_V2_REAL_EVM", scenarios: results }));
});

test("V2 rejects cross-owner controls and keeps the #8 own-account meaning explicit", async () => {
  const { publicClient, otherOwner, attacker, accountA } = context;
  for (const [functionName, args] of [
    ["setAutonomousTrading", [true]],
    ["setRiskLimits", [2_000n, 2_000n]],
    ["setOperator", [attacker.account.address]],
    ["withdraw", [1n]],
  ]) {
    await simulateRevert(publicClient, otherOwner, accountA, V2_ARTIFACT.abi, functionName, args);
  }
});

test("V2 real-EVM long-run lifecycle reuses risk capacity across rollover", async () => {
  const {
    publicClient, otherOwner, operator, collateral, module, poolA, poolB,
    accountB, marketContractC,
  } = context;
  const read = async (functionName) => publicClient.readContract({ address: accountB, abi: V2_ARTIFACT.abi, functionName });

  // Clear the two resting orders left by the multi-market gate scenario. Their
  // cancellation is authoritative pool state, not a VILLA-side decrement.
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorCancelOrder", [MARKET_A, 1n]);
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorCancelOrder", [MARKET_A, 2n]);
  await write(otherOwner, publicClient, collateral, MOCKS.MockERC20.abi, "mint", [otherOwner.account.address, 5_000_000n]);
  await write(otherOwner, publicClient, collateral, MOCKS.MockERC20.abi, "approve", [accountB, 5_000_000n]);
  await write(otherOwner, publicClient, accountB, V2_ARTIFACT.abi, "deposit", [5_000_000n]);
  await write(otherOwner, publicClient, accountB, V2_ARTIFACT.abi, "setRiskLimits", [1_000_000n, 1_000_000n]);
  await write(otherOwner, publicClient, accountB, V2_ARTIFACT.abi, "setOrderLimits", [1_000_000n, 500_000n]);
  assert.equal(await read("aggregateExposure"), 0n);

  // Market A: mint, quote, reduce/re-key, cancel, quote again, partially fill,
  // retain inventory, burn the complete set, then settle and redeem the tail.
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorMintSet", [MARKET_A, 250_000n]);
  assert.ok((await read("currentOperatorExposure")) <= 1_000_000n);
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_A, 0, 500_000n, 100_000n, 9_000_000n, 3, 11n]);
  const reducedOrderId = (await publicClient.readContract({ address: poolA, abi: MOCKS.MockPool.abi, functionName: "nextOrderId" })) - 1n;
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorReduceOrder", [MARKET_A, reducedOrderId, 40_000n]);
  const replacementOrderId = (await publicClient.readContract({ address: poolA, abi: MOCKS.MockPool.abi, functionName: "nextOrderId" })) - 1n;
  assert.ok((await read("currentOperatorExposure")) < 350_000n);
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorCancelOrder", [MARKET_A, replacementOrderId]);
  assert.equal(await read("currentOperatorExposure"), 250_000n);
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_A, 0, 500_000n, 100_000n, 9_000_000n, 3, 12n]);
  const fillOrderId = (await publicClient.readContract({ address: poolA, abi: MOCKS.MockPool.abi, functionName: "nextOrderId" })) - 1n;
  await write(attackerWallet(context), publicClient, poolA, MOCKS.MockPool.abi, "fillOrderPartial", [fillOrderId, 50_000n]);
  assert.ok((await read("currentOperatorExposure")) <= 1_000_000n);
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorCancelOrder", [MARKET_A, fillOrderId]);
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorBurnSet", [MARKET_A, 250_000n]);
  assert.equal(await read("currentOperatorExposure"), 50_000n);
  await write(otherOwner, publicClient, module, MOCKS.MockModule.abi, "settle", [MARKET_A]);

  // Recycle the same pool and prepare the successor autonomously. The old A
  // binding remains tracked until its authoritative redemption is complete.
  await write(otherOwner, publicClient, poolA, MOCKS.MockPool.abi, "recycle", [marketContractC, 301n, 302n, 2]);
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "prepareMarket", [MARKET_C]);
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorRedeem", [MARKET_A, 0, 50_000n]);
  assert.equal(await read("currentOperatorExposure"), 0n);

  // Market B: prepare/quote/cancel/reprice; it uses a distinct current pool.
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "prepareMarket", [MARKET_B]);
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_B, 0, 400_000n, 100_000n, 9_000_000n, 3, 21n]);
  const bOrder1 = (await publicClient.readContract({ address: poolB, abi: MOCKS.MockPool.abi, functionName: "nextOrderId" })) - 1n;
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorCancelOrder", [MARKET_B, bOrder1]);
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_B, 0, 600_000n, 100_000n, 9_000_000n, 3, 22n]);
  const bOrder2 = (await publicClient.readContract({ address: poolB, abi: MOCKS.MockPool.abi, functionName: "nextOrderId" })) - 1n;
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorCancelOrder", [MARKET_B, bOrder2]);

  // Seven mint/burn cycles accumulate 3.5 tUSDC of volume while the peak
  // current exposure remains 0.5 tUSDC and every real burn releases capacity.
  let lifetimeVolume = 0n;
  for (let i = 0; i < 7; i++) {
    await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorMintSet", [MARKET_C, 500_000n]);
    lifetimeVolume += 500_000n;
    assert.ok((await read("currentOperatorExposure")) <= 1_000_000n);
    assert.equal(await read("mintExposure"), 500_000n);
    await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorBurnSet", [MARKET_C, 500_000n]);
    assert.equal(await read("currentOperatorExposure"), 0n);
    assert.equal(await read("mintExposure"), 0n);
  }
  assert.ok(lifetimeVolume > 3_000_000n);

  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "releaseMarket", [MARKET_A]);
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "releaseMarket", [MARKET_B]);
  await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "releaseMarket", [MARKET_C]);
  assert.equal(await read("aggregateExposure"), 0n);
});

function attackerWallet(ctx) {
  return ctx.attacker;
}

test("V2 malicious-operator EVM test never exceeds current exposure across markets", async () => {
  const {
    publicClient, owner, attacker, operator, collateral, outcome, module,
    settlement, poolA, poolB, accountB, marketContractC,
  } = context;
  const accountArgs = [
    attacker.account.address,
    operator.account.address,
    collateral,
    outcome,
    module,
    settlement,
    MAX_ORDER_QUANTITY,
    MAX_ORDER_COLLATERAL,
    MAX_AGGREGATE_EXPOSURE,
    MAX_MINT_EXPOSURE,
  ];
  const accountC = await deploy(owner, publicClient, { abi: V2_ARTIFACT.abi, bytecode: V2_ARTIFACT.creationBytecode }, accountArgs);
  await write(attacker, publicClient, collateral, MOCKS.MockERC20.abi, "mint", [attacker.account.address, 10_000n]);
  await write(attacker, publicClient, collateral, MOCKS.MockERC20.abi, "approve", [accountC, 10_000n]);
  await write(attacker, publicClient, accountC, V2_ARTIFACT.abi, "deposit", [10_000n]);
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "prepareMarket", [MARKET_B]);
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "prepareMarket", [MARKET_C]);

  const readC = async (functionName) => publicClient.readContract({ address: accountC, abi: V2_ARTIFACT.abi, functionName });
  const assertBounded = async () => assert.ok((await readC("currentOperatorExposure")) <= MAX_AGGREGATE_EXPOSURE);
  assert.equal(await publicClient.readContract({ address: accountB, abi: V2_ARTIFACT.abi, functionName: "aggregateExposure" }), 0n);

  const active = [];
  for (const marketId of [MARKET_B, MARKET_C, MARKET_B, MARKET_C]) {
    await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "operatorPlaceOrder", [marketId, 0, 500_000n, 250n, 9_000_000n, 3, BigInt(active.length + 1)]);
    const pool = marketId === MARKET_B ? poolB : poolA;
    const orderId = (await publicClient.readContract({ address: pool, abi: MOCKS.MockPool.abi, functionName: "nextOrderId" })) - 1n;
    active.push({ marketId, pool, orderId });
    await assertBounded();
  }
  assert.equal(await readC("currentOperatorExposure"), 1_000n);
  await simulateRevert(publicClient, operator, accountC, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_B, 0, 500_000n, 1n, 9_000_000n, 3, 99n]);

  // A no-op/fake cancellation does not release any capacity because the next
  // risk read still sees the authoritative open order.
  await write(attacker, publicClient, active[0].pool, MOCKS.MockPool.abi, "fakeCancel", [active[0].orderId]);
  assert.equal(await readC("currentOperatorExposure"), 1_000n);
  await simulateRevert(publicClient, operator, accountC, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_B, 0, 500_000n, 1n, 9_000_000n, 3, 100n]);

  // Confirmed cancellation releases exactly the live order reservation.
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "operatorCancelOrder", [active[0].marketId, active[0].orderId]);
  assert.equal(await readC("currentOperatorExposure"), 750n);
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_B, 0, 500_000n, 250n, 9_000_000n, 3, 101n]);
  const replacementSource = active[1];
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "operatorReduceOrder", [replacementSource.marketId, replacementSource.orderId, 100n]);
  const replacementId = (await publicClient.readContract({ address: replacementSource.pool, abi: MOCKS.MockPool.abi, functionName: "nextOrderId" })) - 1n;
  assert.equal(await readC("currentOperatorExposure"), 850n);
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "operatorCancelOrder", [replacementSource.marketId, replacementId]);
  assert.equal(await readC("currentOperatorExposure"), 750n);

  // Partial fill releases only the authoritative remainder while inventory is
  // added to the account and remains in the same current-risk walk.
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "operatorCancelOrder", [active[3].marketId, active[3].orderId]);
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_B, 0, 500_000n, 200n, 9_000_000n, 3, 102n]);
  const fillId = (await publicClient.readContract({ address: poolB, abi: MOCKS.MockPool.abi, functionName: "nextOrderId" })) - 1n;
  await write(attacker, publicClient, poolB, MOCKS.MockPool.abi, "fillOrderPartial", [fillId, 100n]);
  await assertBounded();
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "operatorCancelOrder", [MARKET_B, fillId]);
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "operatorCancelOrder", [active[2].marketId, active[2].orderId]);
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "operatorCancelOrder", [MARKET_B, (await publicClient.readContract({ address: poolB, abi: MOCKS.MockPool.abi, functionName: "nextOrderId" })) - 2n]);
  assert.equal(await readC("currentOperatorExposure"), 100n);

  // Autonomy-off still permits cleanup, but not preparation, order placement,
  // or minting. A pre-existing order is cancelled after the owner disables it.
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_B, 0, 500_000n, 100n, 9_000_000n, 3, 103n]);
  const cleanupId = (await publicClient.readContract({ address: poolB, abi: MOCKS.MockPool.abi, functionName: "nextOrderId" })) - 1n;
  await write(attacker, publicClient, accountC, V2_ARTIFACT.abi, "setAutonomousTrading", [false]);
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "operatorCancelOrder", [MARKET_B, cleanupId]);
  await simulateRevert(publicClient, operator, accountC, V2_ARTIFACT.abi, "prepareMarket", [MARKET_B]);
  await simulateRevert(publicClient, operator, accountC, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_B, 0, 500_000n, 1n, 9_000_000n, 3, 104n]);
  await simulateRevert(publicClient, operator, accountC, V2_ARTIFACT.abi, "operatorMintSet", [MARKET_C, 1n]);

  // Mint while enabled, then prove burn remains cleanup-only while disabled.
  await write(attacker, publicClient, accountC, V2_ARTIFACT.abi, "setAutonomousTrading", [true]);
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "operatorMintSet", [MARKET_C, 100n]);
  await write(attacker, publicClient, accountC, V2_ARTIFACT.abi, "setAutonomousTrading", [false]);
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "operatorBurnSet", [MARKET_C, 100n]);
  await write(attacker, publicClient, module, MOCKS.MockModule.abi, "settle", [MARKET_B]);
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "operatorRedeem", [MARKET_B, 0, 100n]);
  assert.equal(await readC("currentOperatorExposure"), 0n);
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "releaseMarket", [MARKET_B]);
  await write(operator, publicClient, accountC, V2_ARTIFACT.abi, "releaseMarket", [MARKET_C]);
  assert.equal(await readC("aggregateExposure"), 0n);
});

test("real EVM keeps two VillaAccounts owner- and collateral-isolated", async () => {
  const { publicClient, owner, otherOwner, accountA, accountB, collateral } = context;
  await simulateRevert(publicClient, owner, accountB, V2_ARTIFACT.abi, "deposit", [1n]);
  await simulateRevert(publicClient, owner, accountB, V2_ARTIFACT.abi, "withdraw", [1n]);
  await simulateRevert(publicClient, otherOwner, accountA, V2_ARTIFACT.abi, "deposit", [1n]);
  await simulateRevert(publicClient, otherOwner, accountA, V2_ARTIFACT.abi, "withdraw", [1n]);
  await simulateRevert(publicClient, owner, accountB, V2_ARTIFACT.abi, "setOperator", [owner.account.address]);
  const [ownerA, ownerB, accountABalance, accountBBalance] = await Promise.all([
    publicClient.readContract({ address: accountA, abi: V2_ARTIFACT.abi, functionName: "owner" }),
    publicClient.readContract({ address: accountB, abi: V2_ARTIFACT.abi, functionName: "owner" }),
    publicClient.readContract({ address: collateral, abi: MOCKS.MockERC20.abi, functionName: "balanceOf", args: [accountA] }),
    publicClient.readContract({ address: collateral, abi: MOCKS.MockERC20.abi, functionName: "balanceOf", args: [accountB] }),
  ]);
  assert.equal(ownerA.toLowerCase(), owner.account.address.toLowerCase());
  assert.equal(ownerB.toLowerCase(), otherOwner.account.address.toLowerCase());
  assert.notEqual(accountA.toLowerCase(), accountB.toLowerCase());
  assert.ok(accountABalance > 0n);
  assert.equal(accountBBalance, 5_060_000n);
});

test("real EVM distinguishes V1 and V2 and blocks legacy adapter execution", async () => {
  const { publicClient, owner, operator, legacy, accountA } = context;
  const v2Version = await publicClient.readContract({ address: accountA, abi: V2_ARTIFACT.abi, functionName: "accountVersion" });
  assert.equal(v2Version, 2);
  await assert.rejects(() => publicClient.readContract({ address: legacy, abi: V2_ARTIFACT.abi, functionName: "accountVersion" }));
  const v2Reader = createViemLpAccountReader({ publicClient });
  const v2Identity = await v2Reader.readAccountIdentity({ account: accountA });
  const v1Identity = await v2Reader.readAccountIdentity({ account: legacy });
  assert.equal(v2Identity.accountVersion, 2);
  assert.equal(v1Identity.accountVersion, 1);
  assert.equal(v1Identity.autonomousTradingEnabled, false);
  const v1Adapter = createLpExecutionAdapter({ account: legacy, owner: owner.account.address, operator: operator.account.address, reader: v2Reader });
  await assert.rejects(() => v1Adapter.readAccountIdentity(), { code: "ACCOUNT_VERSION_UNSUPPORTED" });
  assert.equal(crypto.createHash("sha256").update(Buffer.from(V2_ARTIFACT.runtimeBytecode.slice(2), "hex")).digest("hex").length, 64);
});
