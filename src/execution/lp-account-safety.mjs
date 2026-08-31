/**
 * Identity guard for the first disposable LP account.
 *
 * The Phase 2 fixture is historical evidence only. This module makes that
 * exclusion executable before a session can be assembled for a wet review.
 * It accepts public addresses only; it never handles wallet exports or keys.
 */

import { isAddress } from "viem";
import { SHANNON_CHAIN_ID, ZERO_ADDRESS } from "./lp-adapter.mjs";

export const LP_ACCOUNT_SAFETY_VERSION = "villa-lp-account-safety-v1";
export const HISTORICAL_PHASE_2_ACCOUNT = "0xFc9dbf0a8468aA56799b4e23B1EBe936426eE30b".toLowerCase();
export const HISTORICAL_PHASE_2_OWNER = "0xCc67779F8eDb2C80DC665775C5597657C512FE1A".toLowerCase();
export const CANONICAL_VILLA_OPERATOR = "0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37".toLowerCase();

export class LpAccountSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LpAccountSafetyError";
    this.code = code;
  }
}

function address(value, label) {
  const text = String(value ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(text) || !isAddress(text)) {
    throw new LpAccountSafetyError("ADDRESS_INVALID", `${label} must be a valid address`);
  }
  return text.toLowerCase();
}

function same(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

/** Validate the public identity tuple for a new disposable Shannon LP. */
export function validateDisposableLpAccount({
  account,
  owner,
  operator = CANONICAL_VILLA_OPERATOR,
  chainId = SHANNON_CHAIN_ID,
  historicalAccount = HISTORICAL_PHASE_2_ACCOUNT,
  historicalOwner = HISTORICAL_PHASE_2_OWNER,
} = {}) {
  const accountAddress = address(account, "VillaAccount");
  const ownerAddress = address(owner, "disposable LP owner");
  const operatorAddress = address(operator, "VILLA operator");
  if (Number(chainId) !== SHANNON_CHAIN_ID) throw new LpAccountSafetyError("CHAIN_UNSUPPORTED", `disposable LP must use Shannon chain ${SHANNON_CHAIN_ID}`);
  if (same(accountAddress, ZERO_ADDRESS) || same(ownerAddress, ZERO_ADDRESS) || same(operatorAddress, ZERO_ADDRESS)) throw new LpAccountSafetyError("ZERO_IDENTITY", "disposable LP identities cannot be the zero address");
  if (same(accountAddress, ownerAddress) || same(accountAddress, operatorAddress) || same(ownerAddress, operatorAddress)) throw new LpAccountSafetyError("IDENTITY_COLLISION", "VillaAccount, owner, and operator must remain distinct");
  if (same(accountAddress, historicalAccount)) throw new LpAccountSafetyError("HISTORICAL_ACCOUNT_DENIED", "the Phase 2 fixture account is excluded from Phase 3B1A");
  if (same(ownerAddress, historicalOwner)) throw new LpAccountSafetyError("HISTORICAL_OWNER_DENIED", "the Phase 2 fixture owner is excluded from disposable LP provisioning");
  if (!same(operatorAddress, CANONICAL_VILLA_OPERATOR)) throw new LpAccountSafetyError("OPERATOR_NOT_CANONICAL", "the disposable LP must authorize the canonical VILLA operator");
  return Object.freeze({
    version: LP_ACCOUNT_SAFETY_VERSION,
    disposable: true,
    historicalFixtureExcluded: true,
    account: accountAddress,
    owner: ownerAddress,
    operator: operatorAddress,
    chainId: SHANNON_CHAIN_ID,
  });
}

export function assertDisposableLpAccount(value, options = {}) {
  return validateDisposableLpAccount({ ...value, ...options });
}
