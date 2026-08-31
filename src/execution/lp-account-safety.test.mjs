import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_VILLA_OPERATOR,
  HISTORICAL_PHASE_2_ACCOUNT,
  HISTORICAL_PHASE_2_OWNER,
  validateDisposableLpAccount,
} from "./lp-account-safety.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const OTHER_OPERATOR = "0x5555555555555555555555555555555555555555";

test("disposable LP identity is Shannon-scoped and uses the canonical operator", () => {
  const result = validateDisposableLpAccount({ account: ACCOUNT, owner: OWNER });
  assert.equal(result.disposable, true);
  assert.equal(result.account, ACCOUNT);
  assert.equal(result.owner, OWNER);
  assert.equal(result.operator, CANONICAL_VILLA_OPERATOR);
  assert.equal(result.historicalFixtureExcluded, true);
});

test("the Phase 2 account and owner cannot be reused", () => {
  assert.throws(() => validateDisposableLpAccount({ account: HISTORICAL_PHASE_2_ACCOUNT, owner: OWNER }), { code: "HISTORICAL_ACCOUNT_DENIED" });
  assert.throws(() => validateDisposableLpAccount({ account: ACCOUNT, owner: HISTORICAL_PHASE_2_OWNER }), { code: "HISTORICAL_OWNER_DENIED" });
});

test("account, owner, operator, chain, and operator address are all bounded", () => {
  assert.throws(() => validateDisposableLpAccount({ account: ACCOUNT, owner: OWNER, chainId: 1 }), { code: "CHAIN_UNSUPPORTED" });
  assert.throws(() => validateDisposableLpAccount({ account: ACCOUNT, owner: OWNER, operator: OTHER_OPERATOR }), { code: "OPERATOR_NOT_CANONICAL" });
  assert.throws(() => validateDisposableLpAccount({ account: OWNER, owner: OWNER }), { code: "IDENTITY_COLLISION" });
});
