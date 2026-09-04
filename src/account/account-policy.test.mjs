import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_ROLES, OPERATOR_ACTIONS, OWNER_ACTIONS, accountActionAllowed, operatorOrderAllowed } from "./account-policy.mjs";

test("only owner has custody and configuration actions", () => {
  for (const action of OWNER_ACTIONS) {
    assert.equal(accountActionAllowed(ACCOUNT_ROLES.OWNER, action), true, action);
    if (action !== "prepareMarket") {
      assert.equal(accountActionAllowed(ACCOUNT_ROLES.OPERATOR, action), false, action);
    }
    assert.equal(accountActionAllowed(ACCOUNT_ROLES.ATTACKER, action), false, action);
  }
});

test("operator surface is explicit and excludes withdrawal/configuration", () => {
  for (const action of OPERATOR_ACTIONS) assert.equal(accountActionAllowed(ACCOUNT_ROLES.OPERATOR, action), true, action);
  for (const forbidden of ["withdraw", "deposit", "transferOwnership", "setOperator", "setMarketApproval", "recoverUnsupportedToken", "call", "transfer"]) {
    assert.equal(accountActionAllowed(ACCOUNT_ROLES.OPERATOR, forbidden), false, forbidden);
  }
});

test("operator order gate fails closed on stale, unapproved, or revoked state", () => {
  const base = { marketApproved: true, currentMarket: true, operatorSet: true, kind: 0, orderType: 3, price: 500_000, quantity: 1_000, oneCollateral: 1_000_000, maxQuantity: 1_000, maxCollateral: 800 };
  assert.equal(operatorOrderAllowed(base), true);
  assert.equal(operatorOrderAllowed({ ...base, marketApproved: false }), false);
  assert.equal(operatorOrderAllowed({ ...base, currentMarket: false }), false);
  assert.equal(operatorOrderAllowed({ ...base, operatorSet: false }), false);
  assert.equal(operatorOrderAllowed({ ...base, autonomousTradingEnabled: false }), false);
});

test("operator order gate enforces explicit kind, type, quantity, and collateral caps", () => {
  const base = { marketApproved: true, currentMarket: true, operatorSet: true, kind: 0, orderType: 3, price: 500_000, quantity: 1_000, oneCollateral: 1_000_000, maxQuantity: 1_000, maxCollateral: 800 };
  for (const kind of [-1, 4]) assert.equal(operatorOrderAllowed({ ...base, kind }), false);
  for (const orderType of [-1, 4]) assert.equal(operatorOrderAllowed({ ...base, orderType }), false);
  assert.equal(operatorOrderAllowed({ ...base, quantity: 1_001 }), false);
  assert.equal(operatorOrderAllowed({ ...base, price: 0 }), false);
  assert.equal(operatorOrderAllowed({ ...base, price: 1_000_000 }), false);
  assert.equal(operatorOrderAllowed({ ...base, price: 900_000 }), false);
  assert.equal(operatorOrderAllowed({ ...base, kind: 1, price: 900_000 }), true);
  assert.equal(operatorOrderAllowed({ ...base, kind: 2, price: 900_000 }), true);
});

test("attacker cannot use any declared account action", () => {
  for (const action of [...OWNER_ACTIONS, ...OPERATOR_ACTIONS]) assert.equal(accountActionAllowed(ACCOUNT_ROLES.ATTACKER, action), false, action);
});
