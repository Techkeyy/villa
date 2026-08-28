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

test("operator surface remains the explicit EC action set", () => {
  for (const method of [
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
  assert.match(source, /address\(0\),\s*0,\s*userData/);
});

test("fallback rejects native value and unknown selectors", () => {
  assert.match(source, /receive\(\) external payable[\s\S]*revert NativeNotAccepted/);
  assert.match(source, /fallback\(\) external payable[\s\S]*revert NativeNotAccepted/);
});

test("market actions are visibly gated by owner approval and current binding", () => {
  assert.match(source, /function _requireApproved\(bytes32 marketId\) internal view/);
  assert.match(source, /function _currentPoolAndUnit\(bytes32 marketId\) internal view/);
  assert.match(source, /params\.market != record\.market/);
  assert.match(source, /params\.finalized/);
});
