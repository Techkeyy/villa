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
    address public immutable collateralToken;
    address public immutable outcomeToken;
    constructor(address collateral_, address outcome_) { collateralToken = collateral_; outcomeToken = outcome_; }
    function configure(bytes32 id, address market_, address pool_, uint256 yesId_, uint256 noId_) external {
        markets[id] = MarketRecord(1, 2, 0, collateralToken, 0, bytes32(0), address(0), msg.sender, market_, pool_, yesId_, noId_, 1, 9_999_999);
    }
    function redeem(uint32, bytes32, bytes32 id, uint8 outcomeIdx, uint256 amount) external {
        MarketRecord memory record = markets[id];
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
    struct Order { address owner; uint8 kind; uint256 price; uint256 quantity; uint256 remaining; uint256 collateralHeld; }
    BinaryPoolParams private params;
    mapping(uint128 => Order) public orders;
    uint128 public nextOrderId = 1;
    constructor(address collateral_, address outcome_, address market_, address settlement_, uint256 yesId_, uint256 noId_) {
        params = BinaryPoolParams(collateral_, market_, outcome_, yesId_, noId_, 1_000_000, 1_000_000, address(0), 0, 0, 0, 0, settlement_, 1, false);
    }
    function getBinaryPoolParams() external view returns (BinaryPoolParams memory) { return params; }
    function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64, uint8, uint8, address, uint96, uint64)
        external payable returns (bool success, uint128 id)
    {
        uint256 held = kind == 0
            ? (quantity * price + params.oneCollateral - 1) / params.oneCollateral
            : kind == 2
                ? (quantity * (params.oneCollateral - price) + params.oneCollateral - 1) / params.oneCollateral
                : 0;
        if (held > 0) MockERC20(params.collateralToken).transferFrom(msg.sender, address(this), held);
        id = nextOrderId++;
        orders[id] = Order(msg.sender, kind, price, quantity, quantity, held);
        return (true, id);
    }
    function cancelOrder(uint128 id) external {
        Order storage order = orders[id]; require(order.owner == msg.sender, "ORDER_OWNER"); require(order.remaining > 0, "CLOSED");
        order.remaining = 0;
        if (order.collateralHeld > 0) { uint256 held = order.collateralHeld; order.collateralHeld = 0; MockERC20(params.collateralToken).transfer(msg.sender, held); }
    }
    function reduceOrder(uint128 id, uint256 newRemaining) external {
        Order storage order = orders[id]; require(order.owner == msg.sender, "ORDER_OWNER"); require(newRemaining > 0 && newRemaining < order.remaining, "REDUCE");
        order.remaining = newRemaining;
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
        Order storage order = orders[id]; require(order.remaining > 0, "CLOSED");
        uint256 quantity = order.remaining; order.remaining = 0;
        if (order.kind == 1) {
            MockOutcome(params.outcomeToken).burn(order.owner, params.yesId, quantity);
            MockERC20(params.collateralToken).mint(order.owner, quantity * order.price / params.oneCollateral);
        } else if (order.kind == 3) {
            MockOutcome(params.outcomeToken).burn(order.owner, params.noId, quantity);
            MockERC20(params.collateralToken).mint(order.owner, quantity * (params.oneCollateral - order.price) / params.oneCollateral);
        }
    }
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
  const hash = await wallet.writeContract({ address, abi, functionName, args, account: wallet.account, chain: CHAIN });
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
  const badMarket = await deploy(owner, publicClient, MOCKS.MockMarket);
  const settlement = await deploy(owner, publicClient, MOCKS.MockSettlement);
  const module = await deploy(owner, publicClient, MOCKS.MockModule, [collateral, outcome]);
  const poolA = await deploy(owner, publicClient, MOCKS.MockPool, [collateral, outcome, marketContractA, settlement, 101n, 102n]);
  const poolB = await deploy(owner, publicClient, MOCKS.MockPool, [collateral, outcome, marketContractB, settlement, 201n, 202n]);
  await write(owner, publicClient, module, MOCKS.MockModule.abi, "configure", [MARKET_A, marketContractA, poolA, 101n, 102n]);
  await write(owner, publicClient, module, MOCKS.MockModule.abi, "configure", [MARKET_B, marketContractB, poolB, 201n, 202n]);
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
  return { server, publicClient, owner, otherOwner, operator, attacker, collateral, outcome, module, poolA, poolB, accountA, accountB, legacy, marketContractA, marketContractB, badMarket };
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
  await scenario(8, "owner disables autonomy", OTHER_OWNER, "setAutonomousTrading(false)", "SUCCESS", () => write(context.otherOwner, publicClient, accountB, V2_ARTIFACT.abi, "setAutonomousTrading", [false]));
  await scenario(9, "autonomy-off operator cannot prepare", OPERATOR, "prepareMarket(MARKET_B)", "REVERT", () => simulateRevert(publicClient, operator, accountB, V2_ARTIFACT.abi, "prepareMarket", [MARKET_B]), true);
  await scenario(10, "autonomy-off operator cannot place", OPERATOR, "operatorPlaceOrder(MARKET_A,2,600000,1)", "REVERT", () => simulateRevert(publicClient, operator, accountB, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_A, 2, 600_000n, 1n, 9_000_000n, 3, 0n]), true);
  await scenario(11, "autonomy-off operator cannot mint", OPERATOR, "operatorMintSet(MARKET_A,1)", "REVERT", () => simulateRevert(publicClient, operator, accountB, V2_ARTIFACT.abi, "operatorMintSet", [MARKET_A, 1n]), true);

  await scenario(12, "repeated minting stops at the lifetime mint budget", OPERATOR, "operatorMintSet(A,400); operatorMintSet(A,300); operatorMintSet(A,1)", "REVERT", async () => {
    await write(operator, publicClient, accountA, V2_ARTIFACT.abi, "operatorMintSet", [MARKET_A, 400n]);
    await write(operator, publicClient, accountA, V2_ARTIFACT.abi, "operatorMintSet", [MARKET_A, 300n]);
    await simulateRevert(publicClient, operator, accountA, V2_ARTIFACT.abi, "operatorMintSet", [MARKET_A, 1n]);
  }, true);
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
    await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_A, 0, 500_000n, 1_000n, 9_000_000n, 3, 0n]);
    await write(operator, publicClient, accountB, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_A, 0, 500_000n, 1_000n, 9_000_000n, 3, 0n]);
    await simulateRevert(publicClient, operator, accountB, V2_ARTIFACT.abi, "operatorPlaceOrder", [MARKET_B, 2, 500_000n, 1n, 9_000_000n, 3, 0n]);
  }, true);

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
    await write(owner, publicClient, accountA, V2_ARTIFACT.abi, "operatorCancelOrder", [MARKET_A, secondOrderId]);
    assert.equal(await publicClient.readContract({ address: poolA, abi: MOCKS.MockPool.abi, functionName: "open", args: [secondOrderId] }), 0n);
  });
  await scenario(28, "owner can burn, redeem, claim vault, and withdraw after revocation", OWNER, "operatorBurnSet; operatorRedeem; operatorClaimVault; withdraw", "SUCCESS", async () => {
    await write(owner, publicClient, accountA, V2_ARTIFACT.abi, "operatorBurnSet", [MARKET_A, 600n]);
    await write(owner, publicClient, accountA, V2_ARTIFACT.abi, "operatorRedeem", [MARKET_A, 0, 50n]);
    await write(owner, publicClient, poolA, MOCKS.MockPool.abi, "seedVault", [100n]);
    await write(owner, publicClient, accountA, V2_ARTIFACT.abi, "operatorClaimVault", [MARKET_A, 100n]);
    await write(owner, publicClient, accountA, V2_ARTIFACT.abi, "withdraw", [1n]);
    assert.equal(await publicClient.readContract({ address: collateral, abi: MOCKS.MockERC20.abi, functionName: "balanceOf", args: [owner.account.address] }), 1n);
  });

  assert.equal(results.length, 28);
  console.log(JSON.stringify({ gate: "VILLAACCOUNT_V2_REAL_EVM", scenarios: results }));
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
  assert.equal(accountBBalance, 9_000n);
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
