/**
 * Pure Phase 3A START preflight for one LP account.
 *
 * This evaluator does not read the chain and does not broadcast. Callers must
 * supply freshly verified facts from the selected VillaAccount and market.
 */

import { isAddress } from "viem";
import { LP_EXECUTION_MODE, SHANNON_CHAIN_ID, ZERO_ADDRESS } from "./lp-adapter.mjs";

export const LP_READINESS_VERSION = "villa-lp-readiness-v1";

export const LP_READINESS_REASONS = Object.freeze([
  "CHAIN_UNSUPPORTED",
  "ACCOUNT_NOT_SELECTED",
  "ACCOUNT_RUNTIME_UNVERIFIED",
  "OWNER_NOT_VERIFIED",
  "OWNER_MISMATCH",
  "OPERATOR_NOT_AUTHORIZED",
  "OPERATOR_CONFIG_INVALID",
  "SIGNER_MISMATCH",
  "SECURITY_ERROR",
  "MARKET_NOT_SELECTED",
  "MARKET_INVALID",
  "STALE_MARKET_ID",
  "MARKET_NOT_APPROVED",
  "PROTOCOL_APPROVAL_MISSING",
  "INSUFFICIENT_CAPITAL",
  "RISK_LIMITS_INVALID",
  "RISK_HALTED",
  "ENGINE_SESSION_ACTIVE",
  "EXECUTION_MODE_INVALID",
]);

function normalized(value) {
  const text = String(value ?? "");
  return /^0x[0-9a-fA-F]{40}$/.test(text) && isAddress(text) ? text.toLowerCase() : "";
}

function same(left, right) {
  return Boolean(normalized(left) && normalized(right) && normalized(left) === normalized(right));
}

function raw(value) {
  try {
    const result = typeof value === "bigint" ? value : BigInt(String(value));
    return result >= 0n ? result : null;
  } catch {
    return null;
  }
}

function add(reasons, code) {
  if (!reasons.includes(code)) reasons.push(code);
}

function chainIdOf(chain) {
  return Number(chain?.id ?? chain?.chainId ?? chain);
}

/** Evaluate every required fact before an account-specific engine session. */
export function evaluateLpExecutionReadiness(input = {}) {
  const reasons = [];
  const account = input.account ?? {};
  const owner = input.owner ?? {};
  const operator = input.operator ?? {};
  const market = input.market ?? null;
  const permissions = input.permissions ?? {};
  const executionConfig = input.executionConfig ?? {};
  const signerAddress = operator.signerAddress ?? input.signerAddress ?? operator.address;
  const configuredOperator = operator.configuredAddress ?? operator.address;
  const actualOperator = account.operator ?? input.accountOperator;
  const accountAddress = account.address ?? (typeof input.account === "string" ? input.account : null);
  const ownerAddress = owner.address ?? (typeof input.owner === "string" ? input.owner : null);
  const accountOwner = account.owner ?? input.accountOwner;
  const marketId = market?.marketId ?? null;

  if (chainIdOf(input.chain) !== SHANNON_CHAIN_ID) add(reasons, "CHAIN_UNSUPPORTED");
  if (!normalized(accountAddress)) add(reasons, "ACCOUNT_NOT_SELECTED");
  if (account.runtimeVerified !== true) add(reasons, "ACCOUNT_RUNTIME_UNVERIFIED");
  if (owner.verified !== true) add(reasons, "OWNER_NOT_VERIFIED");
  if (!normalized(ownerAddress) || (accountOwner && !same(ownerAddress, accountOwner))) add(reasons, "OWNER_MISMATCH");
  if (!normalized(configuredOperator)) add(reasons, "OPERATOR_CONFIG_INVALID");
  if (!same(actualOperator, configuredOperator) || same(actualOperator, ZERO_ADDRESS)) add(reasons, "OPERATOR_NOT_AUTHORIZED");
  if (!same(signerAddress, configuredOperator)) add(reasons, "SIGNER_MISMATCH");
  if (input.securityError || account.securityError) add(reasons, "SECURITY_ERROR");

  if (!market) add(reasons, "MARKET_NOT_SELECTED");
  else {
    if (market.valid !== true || market.current !== true) add(reasons, "MARKET_INVALID");
    if (market.currentMarketId && String(market.currentMarketId).toLowerCase() !== String(marketId).toLowerCase()) add(reasons, "STALE_MARKET_ID");
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(marketId ?? ""))) add(reasons, "MARKET_INVALID");
  }
  if (permissions.requiresMarketApproval !== false && permissions.marketApproved !== true) add(reasons, "MARKET_NOT_APPROVED");
  if (permissions.requiresProtocolApproval !== false && permissions.protocolPrepared !== true) add(reasons, "PROTOCOL_APPROVAL_MISSING");

  const capital = raw(input.capital?.collateralRaw ?? input.capital?.directCollateralRaw ?? input.capital?.collateralAvailableRaw);
  const minimum = raw(executionConfig.minimumCollateralRaw ?? executionConfig.minCollateralRaw ?? 0n);
  if (capital === null || minimum === null || capital <= minimum) add(reasons, "INSUFFICIENT_CAPITAL");
  if (input.riskLimits?.valid !== true && input.riskLimitsValid !== true) add(reasons, "RISK_LIMITS_INVALID");
  if (input.risk?.state === "HALT" || input.riskDecision?.state === "HALT") add(reasons, "RISK_HALTED");
  if (executionConfig.sessionActive === true || Number(executionConfig.activeSessionCount ?? 0) > 0) add(reasons, "ENGINE_SESSION_ACTIVE");
  const allowedExecutionModes = Array.isArray(input.allowedExecutionModes) && input.allowedExecutionModes.length
    ? input.allowedExecutionModes
    : [LP_EXECUTION_MODE];
  if (!allowedExecutionModes.includes(executionConfig.mode ?? LP_EXECUTION_MODE)) add(reasons, "EXECUTION_MODE_INVALID");

  return Object.freeze({
    version: LP_READINESS_VERSION,
    ready: reasons.length === 0,
    reasons: Object.freeze(reasons),
    chainId: chainIdOf(input.chain),
    account: normalized(accountAddress),
    owner: normalized(ownerAddress),
    operator: normalized(configuredOperator),
    signer: normalized(signerAddress),
    marketId: typeof marketId === "string" ? marketId.toLowerCase() : null,
    orderOwner: normalized(accountAddress),
    broadcastDisabled: true,
  });
}
