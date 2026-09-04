import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../contracts/VillaAccount.sol", import.meta.url), "utf8");

test("account has no generic call or arbitrary withdrawal destination", () => {
  assert.equal(/function\s+call\s*\(/.test(source), false);
  assert.equal(/function\s+execute\s*\(/.test(source), false);
  assert.match(source, /function withdraw\(uint256 amount\) external onlyOwner/);
  assert.equal(source.includes('abi.encodeWithSignature("transfer(address,uint256)", owner, amount)'), true);
  assert.doesNotMatch(source, /operatorWithdraw|operatorTransfer|operatorCall/);
});

test("operator surface remains the explicit EC action set and includes autonomous prepareMarket", () => {
  for (const method of [
    "prepareMarket",
    "operatorPlaceOrder",
    "operatorCancelOrder",
    "operatorReduceOrder",
    "operatorMintSet",
    "operatorBurnSet",
    "operatorRedeem",
    "operatorClaimVault",
  ]) assert.match(source, new RegExp(`function ${method}\\(`), method);
  for (const forbidden of ["operatorSetOperator", "operatorSetMarketApproval", "operatorTransferOwnership", "operatorRecoverUnsupportedToken"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.match(source, /address\(0\),\s*0,\s*userData/);
});

test("fallback rejects native value and unknown selectors", () => {
  assert.match(source, /receive\(\) external payable[\s\S]*revert NativeNotAccepted/);
  assert.match(source, /fallback\(\) external payable[\s\S]*revert NativeNotAccepted/);
});

test("autonomous trading circuit breaker is owner-only and gates order placement/minting", () => {
  assert.match(source, /function setAutonomousTrading\(bool enabled\) external onlyOwner/);
  assert.match(source, /if \(!autonomousTradingEnabled\) revert AutonomousTradingDisabled\(\);/);
  assert.match(source, /uint8 public constant accountVersion = 2;/);
  assert.match(source, /function revokeOperator\(\) external onlyOwner[\s\S]*autonomousTradingEnabled = false;/);
});

test("aggregate and mint exposure are current authoritative on-chain state", () => {
  assert.match(source, /uint256 public maxAggregateExposure;/);
  assert.match(source, /uint256 public maxMintExposure;/);
  assert.doesNotMatch(source, /uint256 public aggregateExposure;/);
  assert.doesNotMatch(source, /uint256 public mintExposure;/);
  assert.match(source, /function currentOperatorExposure\(\) public view returns/);
  assert.match(source, /function currentMintExposure\(\) public view returns/);
  assert.match(source, /function aggregateExposure\(\) external view returns/);
  assert.match(source, /function mintExposure\(\) external view returns/);
  assert.match(source, /getOwnOpenOrders()/);
  assert.match(source, /getOrder\(uint128 orderId\)/);
  assert.match(source, /booksEmpty()/);
  assert.match(source, /_marketExposure/);
  assert.doesNotMatch(source, /_consumeExposure/);
  assert.match(source, /function setRiskLimits\(uint256 maxAggregateExposure_, uint256 maxMintExposure_\)\s+external\s+onlyOwner/);
  assert.match(source, /revert ExposureLimitExceeded\(\)/);
  assert.match(source, /revert MintLimitExceeded\(\)/);
});

test("owner retains only bounded cleanup authority after operator revocation", () => {
  for (const method of ["operatorCancelOrder", "operatorReduceOrder", "operatorBurnSet", "operatorRedeem", "operatorClaimVault"]) {
    assert.match(source, new RegExp(`function ${method}\\([\\s\\S]*?onlyOwnerOrOperator`), method);
  }
  assert.match(source, /modifier onlyOwnerOrOperator\(\)/);
});

test("market actions are gated by prepared markets and current binding", () => {
  assert.match(source, /mapping\(bytes32 marketId => bool prepared\) public preparedMarkets;/);
  assert.match(source, /function _prepareMarket\(bytes32 marketId\) internal/);
  assert.match(source, /params\.market != record\.market/);
  assert.match(source, /params\.yesId != record\.yesId/);
  assert.match(source, /params\.noId != record\.noId/);
  assert.match(source, /params\.finalized/);
});
