/**
 * Compose existing VILLA decisions with one account-bound adapter in SHADOW
 * mode. This is a plan-only seam: it never calls a wallet or a writer.
 */

import { evaluateRisk } from "../risk-governor/index.mjs";
import { planQuotes } from "../quote-planner/index.mjs";
import { LP_EXECUTION_MODE } from "./lp-adapter.mjs";
import { evaluateLpExecutionReadiness } from "./lp-readiness.mjs";

export const LP_SHADOW_PLAN_VERSION = "villa-lp-shadow-v1";

function accountMatches(value, account) {
  return String(value ?? "").toLowerCase() === String(account ?? "").toLowerCase();
}

function assertAccountState(adapter, accountState) {
  if (!accountState || !accountMatches(accountState.account, adapter.account)) throw new Error("ACCOUNT_SCOPE_MISMATCH: engine state is not for the selected VillaAccount");
  if (accountState.inventory?.account && !accountMatches(accountState.inventory.account, adapter.account)) throw new Error("ACCOUNT_SCOPE_MISMATCH: inventory is not for the selected VillaAccount");
  if (accountState.orders?.account && !accountMatches(accountState.orders.account, adapter.account)) throw new Error("ACCOUNT_SCOPE_MISMATCH: orders are not for the selected VillaAccount");
  for (const order of accountState.orders?.orders ?? []) {
    if (order.owner && !accountMatches(order.owner, adapter.account)) throw new Error("ORDER_SCOPE_MISMATCH: pending order is not owned by the selected VillaAccount");
  }
}

export function buildAccountBoundEngineInput({ adapter, accountState, riskInput = null, quoteInput = null } = {}) {
  assertAccountState(adapter, accountState);
  const accountRiskInput = riskInput ? {
    ...riskInput,
    inventory: { ...(riskInput.inventory ?? {}), yes: accountState.inventory?.yes ?? 0, no: accountState.inventory?.no ?? 0 },
    openOrders: accountState.orders?.orders ?? [],
    capital: { ...(riskInput.capital ?? {}), collateralAvailable: accountState.capital?.collateralAvailable ?? riskInput.capital?.collateralAvailable ?? 0 },
    account: adapter.account,
  } : null;
  const accountQuoteInput = quoteInput ? {
    ...quoteInput,
    inventory: { ...(quoteInput.inventory ?? {}), ...(accountState.inventory ?? {}) },
    pendingOrders: accountState.orders?.orders ?? [],
    capital: { ...(quoteInput.capital ?? {}), ...(accountState.capital?.planner ?? {}) },
    account: adapter.account,
  } : null;
  return { riskInput: accountRiskInput, quoteInput: accountQuoteInput };
}

/**
 * Build an account-bound plan from the already-tested engine pipeline. If
 * decision/quotePlan are omitted, the existing pure risk and quote modules are
 * invoked with account-scoped inputs supplied by the caller.
 */
export function buildLpShadowPlan({ adapter, accountState, readinessInput, market, decision = null, quotePlan = null, riskConfig, riskInput = null, quoteInput = null, orderExpiryNs, orderType = 3, userData = 0n, transactionPolicy = null, txIndexStart = 0, createdAtMs = null } = {}) {
  if (!adapter || adapter.executionMode !== LP_EXECUTION_MODE) throw new Error("SHADOW_ONLY: a SHADOW LP adapter is required");
  const inputs = buildAccountBoundEngineInput({ adapter, accountState, riskInput, quoteInput });
  const resolvedDecision = decision ?? (inputs.riskInput ? evaluateRisk(inputs.riskInput, riskConfig) : null);
  const resolvedQuotePlan = quotePlan ?? (inputs.quoteInput ? planQuotes(inputs.quoteInput) : null);
  const readiness = evaluateLpExecutionReadiness({ ...readinessInput, account: { ...(readinessInput?.account ?? {}), address: adapter.account }, owner: { ...(readinessInput?.owner ?? {}), address: adapter.owner }, operator: { ...(readinessInput?.operator ?? {}), configuredAddress: adapter.operator, signerAddress: adapter.operator }, chain: readinessInput?.chain ?? adapter.chainId, executionConfig: { mode: LP_EXECUTION_MODE, ...(readinessInput?.executionConfig ?? {}) } });
  const actions = [];
  if (readiness.ready && resolvedDecision?.state !== "HALT" && resolvedQuotePlan?.plan !== "NO_QUOTE") {
    if (resolvedQuotePlan?.bid?.enabled) actions.push(adapter.placeOrder({ marketId: market.marketId, action: resolvedQuotePlan.bid.action, priceRaw: resolvedQuotePlan.bid.targetPriceRaw, quantityRaw: resolvedQuotePlan.bid.targetQuantityRaw, expireTimestampNs: orderExpiryNs, orderType, userData }));
    if (resolvedQuotePlan?.ask?.enabled) actions.push(adapter.placeOrder({ marketId: market.marketId, action: resolvedQuotePlan.ask.action, priceRaw: resolvedQuotePlan.ask.targetPriceRaw, quantityRaw: resolvedQuotePlan.ask.targetQuantityRaw, expireTimestampNs: orderExpiryNs, orderType, userData }));
  }
  const preparedActions = transactionPolicy
    ? actions.map((plan, index) => transactionPolicy.prepare(plan, { txIndex: txIndexStart + index, createdAt: createdAtMs ?? (() => { throw new Error("createdAtMs is required for deterministic transaction intents"); })() }))
    : actions;
  if (transactionPolicy) {
    for (const plan of preparedActions) {
      const validation = transactionPolicy.validate(plan, { nowMs: createdAtMs });
      if (!validation.allowed) throw new Error(`${validation.code}: ${validation.reason}`);
    }
  }
  return Object.freeze({
    version: LP_SHADOW_PLAN_VERSION,
    executionMode: LP_EXECUTION_MODE,
    broadcast: false,
    account: adapter.account,
    owner: adapter.owner,
    operator: adapter.operator,
    orderOwner: adapter.account,
    marketId: market?.marketId ?? null,
    readiness,
    fairValue: resolvedDecision?.fairValue ?? resolvedQuotePlan?.fairValue ?? null,
    risk: resolvedDecision,
    quotePlan: resolvedQuotePlan,
    actions: Object.freeze(preparedActions),
  });
}

export { assertAccountState };
