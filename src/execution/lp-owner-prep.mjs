/**
 * Owner-only market preparation boundary for Phase 3B1A.
 *
 * This module prepares public, unsigned Rabby requests. It has no wallet,
 * private-key, signer, RPC writer, or broadcast dependency. Engine policy
 * deliberately cannot use these owner-only requests as operator plans.
 */

import { encodeFunctionData, isAddress } from "viem";
import { CANONICAL_VILLA_OPERATOR, validateDisposableLpAccount } from "./lp-account-safety.mjs";
import { DEFAULT_PHASE_3B1_CAPS } from "./lp-transaction-policy.mjs";
import { LP_MARKET_SERIES, LP_MARKET_MIN_HEADROOM_SEC } from "./lp-market-selection.mjs";

export const LP_OWNER_PREP_VERSION = "villa-lp-owner-prep-v1";
export const OWNER_PREP_MIN_HEADROOM_SEC = LP_MARKET_MIN_HEADROOM_SEC;
export const PHASE_3B1_GAS_TX_COUNT = Number(DEFAULT_PHASE_3B1_CAPS.MAX_TX_COUNT);
export const PHASE_3B1_GAS_LIMIT_PER_TX = 1_000_000n;
export const PHASE_3B1_GAS_MARGIN_BPS = 2_500n;

export const VILLA_ACCOUNT_OWNER_PREP_ABI = Object.freeze([
  { type: "function", name: "setMarketApproval", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "bytes32" }, { name: "approved", type: "bool" }], outputs: [] },
  { type: "function", name: "prepareMarket", stateMutability: "nonpayable", inputs: [{ name: "marketId", type: "bytes32" }], outputs: [] },
]);

export const OUTCOME_OPERATOR_PREP_ABI = Object.freeze([
  { type: "function", name: "setOperator", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "approved", type: "bool" }], outputs: [{ type: "bool" }] },
]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

function normalizedAddress(value, label) {
  const text = String(value ?? "");
  if (!ADDRESS_RE.test(text) || !isAddress(text)) throw new Error(`${label} must be a valid address`);
  return text.toLowerCase();
}

function normalizedMarketId(value) {
  const text = String(value ?? "");
  return BYTES32_RE.test(text) ? text.toLowerCase() : null;
}

function sameAddress(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function raw(value, label, { positive = false } = {}) {
  try {
    const result = typeof value === "bigint" ? value : BigInt(String(value));
    if (result < 0n || (positive && result === 0n)) throw new Error();
    return result;
  } catch {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function finite(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label} must be finite`);
  return result;
}

function unique(values) {
  return [...new Set(values)];
}

function blocker(code, reason) {
  return { code, reason };
}

function readSideRaw(side, name) {
  if (!side?.enabled) return null;
  try { return raw(side[name], name, { positive: true }); } catch { return null; }
}

function validateQuotePlan({ quotePlan, quoteExecution, projectedSequence = null, market, chainNowSec, caps = DEFAULT_PHASE_3B1_CAPS } = {}) {
  // A current NO_QUOTE is not silently bypassed. It may only be replaced by
  // a projected plan when the complete mint -> quote -> cancel -> reconcile
  // -> burn sequence has already passed the separate feasibility gate.
  const usingProjected = projectedSequence?.valid === true;
  const effectiveQuotePlan = usingProjected ? projectedSequence.quotePlan : quotePlan;
  const effectiveQuoteExecution = usingProjected ? projectedSequence.quoteExecution : quoteExecution;
  const reasons = [];
  if (projectedSequence && projectedSequence.valid !== true) reasons.push(blocker("PROJECTED_SEQUENCE_INVALID", "the planning-only mint sequence did not pass every cap, risk, venue, and policy gate"));
  if (!effectiveQuotePlan || effectiveQuotePlan.plan === "NO_QUOTE") reasons.push(blocker("NO_QUOTE", usingProjected ? "the projected shadow quote plan is NO_QUOTE" : "the current shadow quote plan is NO_QUOTE"));
  if (effectiveQuotePlan?.governor?.state === "HALT") reasons.push(blocker("RISK_HALTED", "the Risk Governor did not permit a quote"));
  if (effectiveQuotePlan?.marketId && !sameAddress(effectiveQuotePlan.marketId, market?.marketId)) reasons.push(blocker("MARKET_SCOPE_MISMATCH", "the quote belongs to a different market"));
  if (effectiveQuoteExecution?.postOnly !== true || Number(effectiveQuoteExecution?.orderType) !== 3) reasons.push(blocker("POST_ONLY_NOT_PROVEN", "the quote was not proven to use the bounded post-only order type"));
  if (effectiveQuoteExecution?.policyValid !== true) reasons.push(blocker("POLICY_QUOTE_NOT_PROVEN", "the account-bound transaction policy did not validate an executable quote"));

  const grid = market?.grid ?? {};
  let tickSize;
  let lotSize;
  let minimum;
  try {
    tickSize = raw(grid.tickSizeRaw ?? grid.tickSize, "tick size", { positive: true });
    lotSize = raw(grid.lotSizeRaw ?? grid.lotSize, "lot size", { positive: true });
    minimum = raw(market.minimumOrderRaw ?? grid.minQuantityRaw ?? grid.minQuantity, "minimum order", { positive: true });
  } catch {
    reasons.push(blocker("VENUE_GRID_INVALID", "tick, lot, and minimum order facts were not verified"));
  }

  const remaining = finite(market?.expirySec, "market expiry") - finite(chainNowSec, "chain time");
  if (remaining < OWNER_PREP_MIN_HEADROOM_SEC) reasons.push(blocker("HEADROOM_INSUFFICIENT", `market has only ${Math.floor(remaining)}s before owner approval`));
  if (market?.poolFinalized === true) reasons.push(blocker("POOL_FINALIZED", "the selected market pool is finalized"));
  if (market?.status !== undefined && String(market.status).toLowerCase() !== "trading" && Number(market.status) !== 1) reasons.push(blocker("MARKET_NOT_TRADING", "the selected market is not Trading"));

  const sides = [];
  for (const name of ["bid", "ask"]) {
    const side = effectiveQuotePlan?.[name];
    if (!side?.enabled) continue;
    const price = readSideRaw(side, "targetPriceRaw");
    const quantity = readSideRaw(side, "targetQuantityRaw");
    if (price === null || quantity === null) {
      reasons.push(blocker("QUOTE_SIDE_INVALID", `${name} is enabled without a positive raw price and quantity`));
      continue;
    }
    if (tickSize && price % tickSize !== 0n) reasons.push(blocker("PRICE_OFF_GRID", `${name} price is not on the venue tick grid`));
    if (lotSize && quantity % lotSize !== 0n) reasons.push(blocker("QUANTITY_OFF_GRID", `${name} quantity is not on the venue lot grid`));
    if (minimum && quantity < minimum) reasons.push(blocker("MIN_QUANTITY_UNMET", `${name} quantity is below the venue minimum`));
    if (price <= 0n || price >= 1_000_000n) reasons.push(blocker("PRICE_INVALID", `${name} price is outside the binary price range`));
    if (quantity > BigInt(caps.MAX_ORDER_NOTIONAL)) reasons.push(blocker("ORDER_NOTIONAL_CAP", `${name} quantity exceeds the bounded order-notional cap`));
    const bestBid = market?.book?.bids?.[0]?.[0];
    const bestAsk = market?.book?.asks?.[0]?.[0];
    const comparison = side.action?.startsWith("BUY") ? bestAsk : bestBid;
    if (comparison !== undefined && comparison !== null) {
      const comparisonRaw = raw(Math.round(Number(comparison) * 1_000_000), "book price");
      if (side.action?.startsWith("BUY") && price >= comparisonRaw) reasons.push(blocker("POST_ONLY_WOULD_CROSS", `${name} would cross the live best ask`));
      if (side.action?.startsWith("SELL") && price <= comparisonRaw) reasons.push(blocker("POST_ONLY_WOULD_CROSS", `${name} would cross the live best bid`));
    }
    if (!Array.isArray(effectiveQuotePlan?.governor?.allowedActions) || !effectiveQuotePlan.governor.allowedActions.includes(side.action)) reasons.push(blocker("RISK_ACTION_NOT_ALLOWED", `${name} action is not in the current governor permission set`));
    sides.push({ name, action: side.action, priceRaw: price.toString(), quantityRaw: quantity.toString() });
  }
  if (sides.length === 0) reasons.push(blocker("NO_POST_ONLY_ORDER", "the selected quote plan has no enabled post-only order"));
  return { reasons, sides };
}

function unsignedOwnerRequest({ account, owner, marketId, functionName, args, operation, why }) {
  const data = encodeFunctionData({ abi: VILLA_ACCOUNT_OWNER_PREP_ABI, functionName, args });
  return Object.freeze({
    operation,
    from: owner,
    to: account,
    chainId: 50312,
    value: 0n,
    functionName,
    selector: data.slice(0, 10).toLowerCase(),
    args: Object.freeze([...args]),
    data,
    sign: false,
    broadcast: false,
    requiresHumanWalletApproval: true,
    why,
    marketId,
  });
}

/** Calculate a bounded reserve without a signer or a funding action. */
export function calculateGasReserve({ currentBalanceWei = 0n, gasPriceWei, minReserveWei = 0n, gasLimitPerTx = PHASE_3B1_GAS_LIMIT_PER_TX, txCount = PHASE_3B1_GAS_TX_COUNT, marginBps = PHASE_3B1_GAS_MARGIN_BPS } = {}) {
  const current = raw(currentBalanceWei, "current STT balance");
  const price = raw(gasPriceWei, "gas price", { positive: true });
  const minimum = raw(minReserveWei, "minimum reserve");
  const limit = raw(gasLimitPerTx, "gas limit", { positive: true });
  const count = Number(txCount);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("txCount must be a positive safe integer");
  const margin = raw(marginBps, "gas margin");
  if (margin > 10_000n) throw new Error("gas margin cannot exceed 10000 bps");
  const perTx = price * limit;
  const budget = perTx * BigInt(count);
  const marginWei = (budget * margin + 9_999n) / 10_000n;
  const recommended = minimum + budget + marginWei;
  return Object.freeze({
    currentBalanceWei: current,
    gasPriceWei: price,
    gasLimitPerTx: limit,
    txCount: count,
    gasCostPerTxWei: perTx,
    boundedTestBudgetWei: budget,
    marginWei,
    minimumReserveWei: minimum,
    recommendedReserveWei: recommended,
    shortfallWei: recommended > current ? recommended - current : 0n,
    fundedEnough: current >= recommended,
  });
}

/**
 * Build exact owner preparation requests from a fresh market and quote.
 * A blocked result always contains zero requests.
 */
export function buildOwnerMarketPreparation({
  account,
  owner,
  operator = CANONICAL_VILLA_OPERATOR,
  chainId = 50312,
  market,
  chainNowSec,
  permissions = {},
  quotePlan,
  quoteExecution = { postOnly: true, orderType: 3, policyValid: false },
  projectedSequence = null,
  caps = DEFAULT_PHASE_3B1_CAPS,
} = {}) {
  const identity = validateDisposableLpAccount({ account, owner, operator, chainId });
  const normalizedAccount = identity.account;
  const normalizedOwner = identity.owner;
  const marketId = normalizedMarketId(market?.marketId);
  const reasons = [];
  if (!marketId) reasons.push(blocker("MARKET_ID_INVALID", "fresh market id must be bytes32"));
  if (market?.series !== LP_MARKET_SERIES) reasons.push(blocker("MARKET_SERIES_MISMATCH", `market must be ${LP_MARKET_SERIES}`));
  if (market?.current === false) reasons.push(blocker("STALE_MARKET", "the selected market is not current"));
  const quote = validateQuotePlan({ quotePlan, quoteExecution, projectedSequence, market: { ...market, marketId }, chainNowSec, caps });
  reasons.push(...quote.reasons);

  const marketApproved = permissions.marketApproved === true;
  const moduleOperator = permissions.moduleOperator === true;
  const poolOperator = permissions.poolOperator === true;
  const protocolPrepared = permissions.protocolPrepared === true || (moduleOperator && poolOperator);
  const pool = normalizedAddress(market?.pool, "market pool");
  const outcomeToken = normalizedAddress(permissions.outcomeToken, "outcome token");
  const binaryModule = normalizedAddress(permissions.binaryModule, "binary module");
  const expirySec = finite(market?.expirySec, "market expiry");
  const remaining = expirySec - finite(chainNowSec, "chain time");
  if (remaining < OWNER_PREP_MIN_HEADROOM_SEC) reasons.push(blocker("HEADROOM_INSUFFICIENT", `market has only ${Math.floor(remaining)}s before owner approval`));
  const uniqueReasons = unique(reasons.map((item) => item.code)).map((code) => reasons.find((item) => item.code === code));
  const requests = [];
  // The second request is deliberately withheld until a fresh invocation sees
  // the first owner transaction on-chain. prepareMarket would otherwise be a
  // known revert while approvedMarkets[marketId] is still false.
  if (uniqueReasons.length === 0 && !marketApproved) requests.push(unsignedOwnerRequest({ account: normalizedAccount, owner: normalizedOwner, marketId, functionName: "setMarketApproval", args: [marketId, true], operation: "MARKET_APPROVAL", why: "Owner-only market-specific approval enables this fresh BTC 5m market." }));
  else if (uniqueReasons.length === 0 && !protocolPrepared) requests.push(unsignedOwnerRequest({ account: normalizedAccount, owner: normalizedOwner, marketId, functionName: "prepareMarket", args: [marketId], operation: "PROTOCOL_APPROVAL", why: "Owner-only preparation asks the VillaAccount to set only the derived pool and fixed binary-module outcome-token operators." }));
  return Object.freeze({
    version: LP_OWNER_PREP_VERSION,
    status: uniqueReasons.length === 0 ? "READY" : "BLOCKED",
    blockers: Object.freeze(uniqueReasons),
    identity,
    market: Object.freeze({ marketId, pool, expirySec, headroomSec: remaining, series: market?.series ?? null }),
    quote: Object.freeze({ plan: (projectedSequence?.valid === true ? projectedSequence.quotePlan : quotePlan)?.plan ?? null, postOnly: (projectedSequence?.valid === true ? projectedSequence.quoteExecution : quoteExecution)?.postOnly === true, orderType: Number((projectedSequence?.valid === true ? projectedSequence.quoteExecution : quoteExecution)?.orderType ?? -1), policyValid: (projectedSequence?.valid === true ? projectedSequence.quoteExecution : quoteExecution)?.policyValid === true, enabledSides: Object.freeze(quote.sides), projected: projectedSequence?.valid === true }),
    projectedSequence: projectedSequence ? Object.freeze({ valid: projectedSequence.valid === true, minimumMintRaw: projectedSequence.minimumMintRaw ?? null, recommendedPath: projectedSequence.recommendedPath ?? null, reasons: Object.freeze((projectedSequence.reasons ?? []).map((item) => item?.code ?? item)) }) : null,
    permissions: Object.freeze({ marketApproved, protocolPrepared, moduleOperator, poolOperator, outcomeToken, binaryModule, collateralAllowanceRaw: String(permissions.collateralAllowanceRaw ?? "0"), requiredPersistentCollateralAllowanceRaw: "0" }),
    protocolApproval: Object.freeze({ target: outcomeToken, method: "setOperator(address,bool)", selector: encodeFunctionData({ abi: OUTCOME_OPERATOR_PREP_ABI, functionName: "setOperator", args: [pool, true] }).slice(0, 10).toLowerCase(), approvals: Object.freeze([{ spender: pool, approved: true }, { spender: binaryModule, approved: true }]), invokedBy: normalizedAccount, via: "VillaAccount.prepareMarket(bytes32)" }),
    requests: Object.freeze(requests),
    broadcast: false,
  });
}

/** Check the intended post-owner-preparation state before signer installation. */
export function evaluatePostOwnerPreparation({ marketApproved, protocolPrepared, riskState, riskReasons = [], gasBalanceWei = null, minimumGasReserveWei = null, staleMarket = false, unknownState = false, quotePlan = null, signerInstalled = false, executionEnabled = false } = {}) {
  const blockers = [];
  if (marketApproved !== true) blockers.push("MARKET_NOT_APPROVED");
  if (protocolPrepared !== true) blockers.push("PROTOCOL_APPROVAL_MISSING");
  if (riskState === "HALT") blockers.push("RISK_HALTED", ...riskReasons);
  if (gasBalanceWei !== null && minimumGasReserveWei !== null && raw(gasBalanceWei, "gas balance") < raw(minimumGasReserveWei, "minimum gas reserve")) blockers.push("GAS_RESERVE_LOW");
  if (staleMarket) blockers.push("STALE_MARKET");
  if (unknownState) blockers.push("UNKNOWN_STATE");
  if (!quotePlan || quotePlan.plan === "NO_QUOTE") blockers.push("NO_QUOTE");
  if (signerInstalled !== true) blockers.push("SIGNER_NOT_INSTALLED");
  if (executionEnabled !== true) blockers.push("EXECUTION_DISABLED");
  const uniqueBlockers = unique(blockers);
  const intendedOnly = uniqueBlockers.every((code) => code === "SIGNER_NOT_INSTALLED" || code === "EXECUTION_DISABLED");
  return Object.freeze({ pass: intendedOnly, blockers: Object.freeze(uniqueBlockers) });
}
