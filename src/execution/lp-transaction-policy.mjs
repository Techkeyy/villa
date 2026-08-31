/**
 * Central allowlist and deterministic intent boundary for future wet writes.
 *
 * A caller supplies an unsigned plan from the account adapter. This module
 * verifies the exact VillaAccount target, selector, arguments, identities,
 * market, intent age, and bounded-cycle caps before a writer can see it.
 */

import { encodeFunctionData, isAddress } from "viem";
import { VILLA_ACCOUNT_OPERATOR_ABI } from "./lp-adapter.mjs";
import { LP_SESSION_VERSION, assertLpSessionScope } from "./lp-session.mjs";

export const LP_TRANSACTION_POLICY_VERSION = "villa-lp-tx-policy-v1";
export const LP_INTENT_VERSION = "villa-lp-intent-v1";
export const LP_ALLOWED_ACCOUNT_OPERATIONS = Object.freeze([
  "operatorPlaceOrder",
  "operatorCancelOrder",
  "operatorReduceOrder",
  "operatorMintSet",
  "operatorBurnSet",
  "operatorRedeem",
  "operatorClaimVault",
]);
export const LP_DENIED_OPERATIONS = Object.freeze([
  "withdraw",
  "transferOwnership",
  "setOperator",
  "revokeOperator",
  "setMarketApproval",
  "prepareMarket",
  "revokeMarketApprovals",
  "recoverUnsupportedToken",
  "arbitraryCall",
  "transferTo",
]);

// Shannon tUSDC uses six decimal raw units. These are hard upper bounds for
// the first wet cycle, not targets. A later phase may only lower them.
export const DEFAULT_PHASE_3B1_CAPS = Object.freeze({
  MAX_ACCOUNT_CAPITAL: 1_000_000n,
  MAX_ORDER_NOTIONAL: 250_000n,
  MAX_OPEN_ORDERS: 2,
  MAX_PENDING_EXPOSURE: 250_000n,
  MAX_MINT_AMOUNT: 250_000n,
  MAX_SESSION_DURATION_SEC: 900,
  MAX_TX_COUNT: 12,
});

const OPERATION_ACTIONS = Object.freeze({
  operatorPlaceOrder: "PLACE_ORDER",
  operatorCancelOrder: "CANCEL_ORDER",
  operatorReduceOrder: "REDUCE_ORDER",
  operatorMintSet: "MINT_COMPLETE_SET",
  operatorBurnSet: "BURN_COMPLETE_SET",
  operatorRedeem: "REDEEM_RESOLVED",
  operatorClaimVault: "CLAIM_VAULT_CREDIT",
});

export class LpTransactionPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LpTransactionPolicyError";
    this.code = code;
  }
}

function normalizedAddress(value, label) {
  const text = String(value ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(text) || !isAddress(text)) throw new LpTransactionPolicyError("ADDRESS_INVALID", `${label} must be a valid address`);
  return text.toLowerCase();
}

function sameAddress(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function bytes32(value, label) {
  const text = String(value ?? "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(text)) throw new LpTransactionPolicyError("BYTES32_INVALID", `${label} must be bytes32`);
  return text.toLowerCase();
}

function raw(value, label, { positive = false } = {}) {
  let result;
  try { result = typeof value === "bigint" ? value : BigInt(String(value)); } catch { throw new LpTransactionPolicyError("RAW_INVALID", `${label} must be an integer raw value`); }
  if (result < 0n || (positive && result === 0n)) throw new LpTransactionPolicyError("RAW_INVALID", `${label} is outside its allowed range`);
  return result;
}

function finite(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new LpTransactionPolicyError("TIME_INVALID", `${label} must be a non-negative finite number`);
  return parsed;
}

function integer(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new LpTransactionPolicyError("INTEGER_INVALID", `${label} must be a non-negative integer`);
  return parsed;
}

function normalizedCaps(caps = {}) {
  const value = { ...DEFAULT_PHASE_3B1_CAPS, ...(caps ?? {}) };
  for (const key of Object.keys(DEFAULT_PHASE_3B1_CAPS)) {
    if (typeof DEFAULT_PHASE_3B1_CAPS[key] === "bigint") {
      value[key] = raw(value[key], key, { positive: true });
      if (value[key] > DEFAULT_PHASE_3B1_CAPS[key]) throw new LpTransactionPolicyError("CAP_EXCEEDED", `${key} cannot exceed the Phase 3B1 hard cap`);
    } else {
      value[key] = integer(value[key], key);
      if (value[key] > DEFAULT_PHASE_3B1_CAPS[key]) throw new LpTransactionPolicyError("CAP_EXCEEDED", `${key} cannot exceed the Phase 3B1 hard cap`);
    }
  }
  if (value.MAX_OPEN_ORDERS < 1 || value.MAX_TX_COUNT < 1 || value.MAX_SESSION_DURATION_SEC < 1) throw new LpTransactionPolicyError("CAP_INVALID", "cycle caps must be positive");
  return Object.freeze(value);
}

export const normalizePhase3B1Caps = normalizedCaps;

function actionForPlan(plan) {
  const action = OPERATION_ACTIONS[plan?.functionName];
  if (!action) throw new LpTransactionPolicyError("OPERATION_DENIED", "operation is not in the VillaAccount operator allowlist");
  return action;
}

function planFacts(plan) {
  const args = plan?.args;
  if (!Array.isArray(args)) throw new LpTransactionPolicyError("PLAN_INVALID", "plan args are required");
  const action = actionForPlan(plan);
  const market = bytes32(args[0], "plan marketId");
  switch (plan.functionName) {
    case "operatorPlaceOrder":
      return {
        action,
        marketId: market,
        kind: integer(args[1], "order kind"),
        priceRaw: raw(args[2], "order price", { positive: true }),
        amountRaw: raw(args[3], "order quantity", { positive: true }),
        expirationNs: raw(args[4], "order expiration", { positive: true }),
        side: ["BUY_YES", "BUY_NO", "SELL_YES", "SELL_NO"][integer(args[1], "order kind")],
      };
    case "operatorCancelOrder":
      return { action, marketId: market, orderId: raw(args[1], "order id") };
    case "operatorReduceOrder":
      return { action, marketId: market, orderId: raw(args[1], "order id"), amountRaw: raw(args[2], "new remaining quantity", { positive: true }) };
    case "operatorMintSet":
      return { action, marketId: market, amountRaw: raw(args[1], "mint amount", { positive: true }) };
    case "operatorBurnSet":
      return { action, marketId: market, amountRaw: raw(args[1], "burn amount", { positive: true }) };
    case "operatorRedeem":
      return { action, marketId: market, outcomeIdx: integer(args[1], "outcome index"), amountRaw: raw(args[2], "redeem amount", { positive: true }) };
    case "operatorClaimVault":
      return { action, marketId: market, amountRaw: raw(args[1], "vault claim amount", { positive: true }) };
    default:
      throw new LpTransactionPolicyError("OPERATION_DENIED", "operation is not in the VillaAccount operator allowlist");
  }
}

function expectedData(plan) {
  try {
    return encodeFunctionData({ abi: VILLA_ACCOUNT_OPERATOR_ABI, functionName: plan.functionName, args: plan.args });
  } catch {
    throw new LpTransactionPolicyError("CALLDATA_INVALID", "plan calldata cannot be encoded by the audited VillaAccount ABI");
  }
}

function intentValue(value, label) {
  if (value === null || value === undefined) return null;
  return raw(value, label);
}

export function createTransactionIntent({
  session,
  action,
  marketId: selectedMarketId,
  amountRaw = null,
  priceRaw = null,
  side = null,
  expirationNs = null,
  destination,
  txIndex,
  createdAt,
} = {}) {
  if (!session || session.version !== LP_SESSION_VERSION) throw new LpTransactionPolicyError("SESSION_INVALID", "a Phase 3 session is required");
  assertLpSessionScope(session, { marketId: selectedMarketId });
  if (!Object.values(OPERATION_ACTIONS).includes(action)) throw new LpTransactionPolicyError("ACTION_INVALID", "intent action is not allowlisted");
  const destinationAddress = normalizedAddress(destination, "intent destination");
  if (!sameAddress(destinationAddress, session.account)) throw new LpTransactionPolicyError("DESTINATION_DENIED", "intent destination must be the VillaAccount");
  const index = integer(txIndex, "intent txIndex");
  return Object.freeze({
    version: LP_INTENT_VERSION,
    sessionId: session.sessionId,
    account: session.account,
    owner: session.owner,
    operator: session.operator,
    chainId: session.chainId,
    marketId: bytes32(selectedMarketId, "intent marketId"),
    action,
    amountRaw: intentValue(amountRaw, "intent amount"),
    priceRaw: intentValue(priceRaw, "intent price"),
    side: side === null ? null : String(side),
    expirationNs: intentValue(expirationNs, "intent expiration"),
    destination: destinationAddress,
    policyVersion: LP_TRANSACTION_POLICY_VERSION,
    txIndex: index,
    createdAt: finite(createdAt, "intent createdAt"),
  });
}

export function createIntentFromPlan(plan, { session, txIndex, createdAt } = {}) {
  const facts = planFacts(plan);
  return createTransactionIntent({
    session,
    action: facts.action,
    marketId: facts.marketId,
    amountRaw: facts.amountRaw ?? null,
    priceRaw: facts.priceRaw ?? null,
    side: facts.side ?? null,
    expirationNs: facts.expirationNs ?? null,
    destination: plan.destination ?? plan.to,
    txIndex,
    createdAt,
  });
}

function reject(code, reason, extra = {}) {
  return { allowed: false, code, reason, ...extra };
}

export function validateTransactionPlan(plan, { session, caps = DEFAULT_PHASE_3B1_CAPS, nowMs, maxIntentAgeMs = 30_000 } = {}) {
  let effectiveCaps;
  try { effectiveCaps = normalizedCaps(caps); } catch (error) { return reject(error.code ?? "CAP_INVALID", error.message); }
  if (!session || session.version !== LP_SESSION_VERSION) return reject("SESSION_INVALID", "a Phase 3 session is required");
  if (!plan || typeof plan !== "object") return reject("PLAN_INVALID", "transaction plan is required");
  if (plan.policyVersion !== LP_TRANSACTION_POLICY_VERSION) return reject("POLICY_INVALID", "unsupported transaction policy version");
  let facts;
  try { facts = planFacts(plan); } catch (error) { return reject(error.code ?? "PLAN_INVALID", error.message); }
  if (!sameAddress(plan.to, session.account) || !sameAddress(plan.destination, session.account)) return reject("DESTINATION_DENIED", "transaction target and destination must be the selected VillaAccount");
  if (!sameAddress(plan.account, session.account) || !sameAddress(plan.orderOwner, session.account)) return reject("ACCOUNT_SCOPE_MISMATCH", "plan portfolio identity must be the selected VillaAccount");
  if (!sameAddress(plan.owner, session.owner)) return reject("OWNER_SCOPE_MISMATCH", "plan owner does not match the session");
  if (!sameAddress(plan.signer, session.operator)) return reject("SIGNER_MISMATCH", "plan signer does not match the authorized operator");
  if (Number(plan.chainId) !== session.chainId) return reject("CHAIN_SCOPE_MISMATCH", "plan chain does not match the session");
  if (plan.marketId !== undefined && bytes32(plan.marketId, "plan marketId") !== facts.marketId) return reject("MARKET_SCOPE_MISMATCH", "plan market metadata differs from calldata");
  if (plan.broadcast !== false) return reject("BROADCAST_BOUNDARY", "plans must remain unsigned until the single wet writer boundary");
  if (plan.value !== 0n && String(plan.value) !== "0") return reject("VALUE_DENIED", "VillaAccount operator calls cannot transfer native value");
  if (String(plan.data).toLowerCase() !== expectedData(plan).toLowerCase()) return reject("CALLDATA_MISMATCH", "calldata does not match the audited function and arguments");
  if (facts.marketId !== session.currentMarketId) return reject("MARKET_SCOPE_MISMATCH", "plan market differs from the session market");
  const intent = plan.intent;
  if (!intent || intent.version !== LP_INTENT_VERSION) return reject("INTENT_REQUIRED", "every write requires a deterministic intent envelope");
  if (intent.policyVersion !== LP_TRANSACTION_POLICY_VERSION) return reject("POLICY_INVALID", "intent policy version does not match");
  if (intent.sessionId !== session.sessionId || !sameAddress(intent.account, session.account) || !sameAddress(intent.owner, session.owner) || !sameAddress(intent.operator, session.operator) || Number(intent.chainId) !== session.chainId || intent.marketId !== facts.marketId || intent.destination !== session.account || intent.action !== facts.action) return reject("INTENT_SCOPE_MISMATCH", "intent identity, market, action, or destination differs from the session");
  const now = finite(nowMs, "nowMs");
  const ageMs = now - finite(intent.createdAt, "intent.createdAt");
  if (ageMs < 0 || ageMs > maxIntentAgeMs) return reject("INTENT_STALE", `intent age ${ageMs}ms exceeds ${maxIntentAgeMs}ms`, { ageMs });
  if (integer(intent.txIndex, "intent txIndex") >= effectiveCaps.MAX_TX_COUNT) return reject("TX_COUNT_CAP", "transaction count exceeds the bounded cycle cap");

  if (intent.amountRaw !== null && raw(intent.amountRaw, "intent amount") !== (facts.amountRaw ?? 0n)) return reject("INTENT_AMOUNT_MISMATCH", "intent amount differs from calldata");
  if (intent.priceRaw !== null && raw(intent.priceRaw, "intent price") !== (facts.priceRaw ?? 0n)) return reject("INTENT_PRICE_MISMATCH", "intent price differs from calldata");
  if (intent.expirationNs !== null && raw(intent.expirationNs, "intent expiration") !== (facts.expirationNs ?? 0n)) return reject("INTENT_EXPIRATION_MISMATCH", "intent expiration differs from calldata");
  if (intent.side !== null && intent.side !== facts.side) return reject("INTENT_SIDE_MISMATCH", "intent side differs from calldata");

  if (plan.accountCapitalRaw !== undefined && raw(plan.accountCapitalRaw, "account capital") > effectiveCaps.MAX_ACCOUNT_CAPITAL) return reject("ACCOUNT_CAPITAL_CAP", "account capital exceeds the first-cycle hard cap");
  if (facts.action === "PLACE_ORDER") {
    if (facts.kind > 3 || facts.priceRaw <= 0n || facts.priceRaw >= 1_000_000n) return reject("ORDER_INVALID", "order is outside the Shannon binary order range");
    if (facts.amountRaw > effectiveCaps.MAX_ORDER_NOTIONAL) return reject("ORDER_NOTIONAL_CAP", "order quantity exceeds the first-cycle notional cap");
    if (Number(plan.openOrderCount ?? 0) >= effectiveCaps.MAX_OPEN_ORDERS) return reject("OPEN_ORDER_CAP", "open-order count exceeds the first-cycle cap");
    if (raw(plan.pendingExposureRaw ?? 0n, "pending exposure") + facts.amountRaw > effectiveCaps.MAX_PENDING_EXPOSURE) return reject("PENDING_EXPOSURE_CAP", "pending exposure exceeds the first-cycle cap");
  }
  if (["MINT_COMPLETE_SET", "BURN_COMPLETE_SET"].includes(facts.action) && facts.amountRaw > effectiveCaps.MAX_MINT_AMOUNT) return reject("MINT_CAP", "complete-set amount exceeds the first-cycle cap");
  if (facts.action === "REDEEM_RESOLVED" && facts.outcomeIdx > 1) return reject("OUTCOME_INVALID", "outcome index must be YES or NO");
  return { allowed: true, policyVersion: LP_TRANSACTION_POLICY_VERSION, action: facts.action, marketId: facts.marketId, ageMs, caps: effectiveCaps };
}

export function createLpTransactionPolicy({ session, caps = DEFAULT_PHASE_3B1_CAPS, now = () => Date.now(), maxIntentAgeMs = 30_000 } = {}) {
  if (!session || session.version !== LP_SESSION_VERSION) throw new LpTransactionPolicyError("SESSION_INVALID", "a Phase 3 session is required");
  const effectiveCaps = normalizedCaps(caps);
  function prepare(plan, { txIndex, createdAt = now() } = {}) {
    const policyVersion = LP_TRANSACTION_POLICY_VERSION;
    const destination = plan.destination ?? plan.to;
    const intent = plan.intent ?? createIntentFromPlan({ ...plan, destination }, { session, txIndex, createdAt });
    return Object.freeze({ ...plan, policyVersion, chainId: session.chainId, sessionId: session.sessionId, destination, intent });
  }
  function validate(plan, { nowMs = now() } = {}) {
    return validateTransactionPlan(plan, { session, caps: effectiveCaps, nowMs, maxIntentAgeMs });
  }
  return Object.freeze({ version: LP_TRANSACTION_POLICY_VERSION, caps: effectiveCaps, prepare, validate });
}

export function policySelector(functionName, args) {
  if (!LP_ALLOWED_ACCOUNT_OPERATIONS.includes(functionName)) throw new LpTransactionPolicyError("OPERATION_DENIED", "function is not allowlisted");
  return expectedData({ functionName, args }).slice(0, 10).toLowerCase();
}
