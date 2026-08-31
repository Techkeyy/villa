/**
 * Shared read-only simulation helpers for Phase 3B1A.3 and 3B1A.4.
 *
 * The helpers consume one already-collected public snapshot and perform all
 * candidate work in memory. They do not create a signer, read a private key,
 * call a wallet, or broadcast a plan.
 */

import { evaluateRisk } from "../risk-governor/index.mjs";
import { DEFAULT_RISK_CONFIG } from "../risk-governor/config.mjs";
import { planQuotes, decimalToRaw } from "../quote-planner/index.mjs";
import { createLpExecutionAdapter } from "./lp-adapter.mjs";
import { buildLpShadowPlan } from "./lp-shadow.mjs";
import { createLpExecutionSession, transitionLpSession } from "./lp-session.mjs";
import { LP_MARKET_SERIES } from "./lp-market-selection.mjs";
import { DEFAULT_PHASE_3B1_CAPS, createLpTransactionPolicy } from "./lp-transaction-policy.mjs";
import { validateProjectedQuote, projectLpState } from "./lp-quote-feasibility.mjs";
import { deriveCapitalEquation } from "./lp-capital-calibration.mjs";

const ONE_RAW_6 = 1_000_000n;

function raw(value, label, { positive = false } = {}) {
  let result;
  try { result = typeof value === "bigint" ? value : BigInt(String(value)); } catch { throw new Error(`${label} must be an integer raw value`); }
  if (result < 0n || (positive && result === 0n)) throw new Error(`${label} must be ${positive ? "positive" : "non-negative"}`);
  return result;
}

function numeric(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label} must be finite`);
  return result;
}

function unique(values) {
  return [...new Set(values)];
}

function governorInput(decision) {
  return {
    state: decision.state,
    permissions: decision.permissions,
    sizeMultiplier: decision.sizeMultiplier,
    triggeredRules: decision.triggeredRules,
    warnings: decision.warnings,
    reduceOnlyPolicy: decision.reduceOnlyPolicy,
    directionalRiskCapacity: DEFAULT_RISK_CONFIG.directionalExposureHard,
    limits: { directionalExposureHard: DEFAULT_RISK_CONFIG.directionalExposureHard, grossExposureHard: DEFAULT_RISK_CONFIG.grossExposureHard },
  };
}

function pendingOrdersForPlanner(shadow, oneRaw) {
  return (shadow.openOrders?.orders ?? []).map((order) => ({
    outcome: "YES",
    side: order.isBid === true ? "BUY" : "SELL",
    remainingQty: Number(raw(order.quantityRemainingRaw ?? order.remainingQtyRaw ?? 0n, "pending order quantity")) / Number(oneRaw),
  }));
}

function plannerInput({ snapshot, decision, market, state, decimals, shadow }) {
  const oneRaw = 10n ** BigInt(decimals);
  const grid = market.grid;
  const book = market.book ?? { bids: [], asks: [] };
  const minimum = raw(grid.minQuantityRaw, "grid minimum");
  const lot = raw(grid.lotSizeRaw, "grid lot");
  const pendingOrders = pendingOrdersForPlanner(shadow, oneRaw);
  return {
    fairValue: snapshot.fairValue,
    governor: governorInput(decision),
    inventory: { yesRaw: state.yesRaw.toString(), noRaw: state.noRaw.toString(), yesAvailableRaw: state.yesRaw.toString() },
    pendingOrders,
    book: { bestBidRaw: book.bids?.[0] ? decimalToRaw(String(book.bids[0][0]), decimals).toString() : null, bestAskRaw: book.asks?.[0] ? decimalToRaw(String(book.asks[0][0]), decimals).toString() : null, empty: !book.bids?.length && !book.asks?.length },
    grid: { decimals, oneRaw: oneRaw.toString(), tickSizeRaw: String(grid.tickSizeRaw), lotSizeRaw: String(grid.lotSizeRaw), minQuantityRaw: String(grid.minQuantityRaw) },
    capital: { collateralAvailableRaw: state.collateralRaw.toString(), collateralReserveRaw: oneRaw.toString(), collateralReserve: DEFAULT_RISK_CONFIG.minCollateralReserve },
    market: { marketId: market.marketId, timeRemainingSec: decision.authoritativeTime.timeRemainingSec },
    quote: { baseQuantityRaw: (minimum > lot * 5n ? minimum : lot * 5n).toString() },
  };
}

function mockReader() {
  return { readAccountIdentity: async () => ({}), readCapital: async () => ({}), readOutcomeInventory: async () => ({}), readOrders: async () => ({}) };
}

/** Validate a simulated unsigned path using the unchanged transaction policy. */
export function validateUnsignedSequence({ account, owner, operator, market, state, decision, quotePlan, mintAmountRaw, decimals, caps = DEFAULT_PHASE_3B1_CAPS }) {
  const includesMint = mintAmountRaw > 0n;
  if (decision.state === "HALT" || quotePlan?.plan === "NO_QUOTE") return { valid: false, reasons: ["SEQUENCE_PRECONDITION_INVALID"], actions: [] };
  const adapter = createLpExecutionAdapter({ account, owner, operator, reader: mockReader() });
  const createdAtMs = Date.now();
  const session = transitionLpSession(createLpExecutionSession({ sessionId: `phase3b1a-calibration-${market.marketId.slice(-8)}`, account, owner, operator, marketSeries: LP_MARKET_SERIES, currentMarketId: market.marketId, riskPolicyVersion: decision.governorVersion, executionMode: "WET", createdAt: createdAtMs }), "PREFLIGHT", { atMs: createdAtMs });
  const policy = createLpTransactionPolicy({ session, caps, now: () => createdAtMs });
  const one = 10n ** BigInt(decimals);
  const accountState = {
    account,
    owner,
    operator,
    capital: { collateralAvailable: Number(state.collateralRaw) / Number(one), collateralAvailableRaw: state.collateralRaw },
    inventory: { account, yes: Number(state.yesRaw) / Number(one), no: Number(state.noRaw) / Number(one), yesRaw: state.yesRaw, noRaw: state.noRaw },
    orders: { account, status: "VERIFIED", orders: [] },
  };
  const readinessInput = {
    chain: { id: 50312 },
    account: { address: account, owner, operator, runtimeVerified: true },
    owner: { address: owner, verified: true },
    operator: { configuredAddress: operator, signerAddress: operator },
    market: { marketId: market.marketId, series: LP_MARKET_SERIES, currentMarketId: market.marketId, valid: true, current: true },
    permissions: { requiresMarketApproval: false, marketApproved: true, requiresProtocolApproval: false, protocolPrepared: true },
    capital: { collateralRaw: state.collateralRaw },
    riskLimits: { valid: true },
    risk: { state: decision.state },
    executionConfig: { mode: "SHADOW", minimumCollateralRaw: 0n, sessionActive: false },
  };
  const rawShadow = buildLpShadowPlan({ adapter, accountState, readinessInput, market: { marketId: market.marketId }, decision, quotePlan, orderExpiryNs: BigInt(Math.max(1, Math.floor(numeric(market.expirySec, "market expiry") - 2))) * 1_000_000_000n, transactionPolicy: null });
  const quoteAction = rawShadow.actions[0];
  if (!quoteAction) return { valid: false, reasons: ["QUOTE_ACTION_MISSING"], actions: [] };
  const plans = includesMint
    ? [adapter.mintCompleteSet({ marketId: market.marketId, amountRaw: mintAmountRaw }), quoteAction, adapter.cancelOrder({ marketId: market.marketId, orderId: 0n }), adapter.burnCompleteSet({ marketId: market.marketId, amountRaw: mintAmountRaw })]
    : [quoteAction, adapter.cancelOrder({ marketId: market.marketId, orderId: 0n })];
  const actions = [];
  const reasons = [];
  for (const [index, plan] of plans.entries()) {
    try {
      const prepared = policy.prepare(plan, { txIndex: index, createdAt: createdAtMs });
      const validation = policy.validate(prepared, { nowMs: createdAtMs });
      actions.push({ functionName: prepared.functionName, txIndex: index, allowed: validation.allowed, code: validation.code ?? null });
      if (!validation.allowed) reasons.push(validation.code ?? "POLICY_REJECTED");
    } catch (error) {
      reasons.push(error?.code ?? "POLICY_EXCEPTION");
    }
  }
  return { valid: reasons.length === 0, reasons: unique(reasons), actions };
}

function restrictQuotePlan(quotePlan, sideName) {
  const selected = quotePlan?.[sideName];
  const disabled = (side) => ({ ...side, enabled: false, targetPriceRaw: null, targetQuantityRaw: null, collateralRequiredRaw: null, projectedExposure: null });
  if (!selected?.enabled) return { ...quotePlan, plan: "NO_QUOTE", bid: disabled(quotePlan?.bid ?? {}), ask: disabled(quotePlan?.ask ?? {}) };
  return { ...quotePlan, plan: "ONE_SIDED", bid: sideName === "bid" ? selected : disabled(quotePlan?.bid ?? {}), ask: sideName === "ask" ? selected : disabled(quotePlan?.ask ?? {}) };
}

function openOrderCollateralRaw(shadow, oneRaw) {
  let total = 0n;
  for (const order of shadow.openOrders?.orders ?? []) {
    if (order.isBid !== true && !String(order.side ?? "").startsWith("BUY")) continue;
    const price = raw(order.priceRaw ?? 0n, "open order price");
    const quantity = raw(order.quantityRemainingRaw ?? order.remainingQtyRaw ?? 0n, "open order quantity");
    total += (price * quantity + oneRaw - 1n) / oneRaw;
  }
  return total;
}

export function createProjectedEvaluator({ shadow, market, decimals, account, owner, operator, accountMaxOrderQuantityRaw = null, accountMaxOrderCollateralRaw = null, caps = DEFAULT_PHASE_3B1_CAPS } = {}) {
  const baseSnapshot = shadow.riskSnapshot;
  const one = 10n ** BigInt(decimals);
  const pendingCount = shadow.openOrders?.orders?.length ?? 0;
  const pendingExposureRaw = (shadow.openOrders?.orders ?? []).reduce((sum, order) => sum + raw(order.quantityRemainingRaw ?? order.remainingQtyRaw ?? 0n, "pending exposure"), 0n);

  function evaluateState(state, sideName, mintAmountRaw = 0n) {
    const snapshot = {
      ...baseSnapshot,
      inventory: { yes: Number(state.yesRaw) / Number(one), no: Number(state.noRaw) / Number(one) },
      openOrdersStatus: "VERIFIED",
      openOrders: shadow.openOrders?.orders ?? [],
      capital: { ...baseSnapshot.capital, collateralAvailable: Number(state.collateralRaw) / Number(one), capitalAtRisk: 0, accountingStatus: "PARTIAL" },
    };
    const riskDecision = evaluateRisk(snapshot, DEFAULT_RISK_CONFIG);
    const rawQuotePlan = planQuotes(plannerInput({ snapshot, decision: riskDecision, market, state, decimals, shadow }));
    const quotePlan = restrictQuotePlan(rawQuotePlan, sideName);
    const sequence = validateUnsignedSequence({ account, owner, operator, market, state, decision: riskDecision, quotePlan, mintAmountRaw, decimals, caps });
    const quoteExecution = { orderType: 3, postOnly: true, policyValid: sequence.valid };
    const quoteValidation = validateProjectedQuote({ riskDecision, quotePlan, quoteExecution, market, pendingOrderCount: pendingCount, pendingExposureRaw, accountMaxOrderQuantityRaw, accountMaxOrderCollateralRaw, caps });
    return { state, snapshot, riskDecision, rawQuotePlan, quotePlan, quoteExecution, quoteValidation, sequence, sequencePolicyValid: sequence.valid };
  }

  return Object.freeze({ evaluateState, pendingCount, pendingExposureRaw, dreamDexReservedCollateralRaw: openOrderCollateralRaw(shadow, one), oneRaw: one, decimals });
}

function pathResult(evaluation, sideName) {
  const side = evaluation.quotePlan?.[sideName];
  const reasons = [
    ...(evaluation.quoteValidation?.reasons ?? []).map((item) => item.code ?? item),
    ...(evaluation.sequence?.reasons ?? []),
  ];
  const feasible = evaluation.riskDecision?.state !== "HALT" && side?.enabled === true && evaluation.quoteValidation?.valid === true && evaluation.sequencePolicyValid === true;
  if (!feasible && reasons.length === 0) reasons.push("PATH_NOT_FEASIBLE");
  return Object.freeze({
    feasible,
    side: sideName,
    action: side?.action ?? null,
    priceRaw: side?.targetPriceRaw ?? null,
    quantityRaw: side?.targetQuantityRaw ?? null,
    collateralRequiredRaw: side?.collateralRequiredRaw ?? "0",
    pendingExposureRaw: evaluation.quoteValidation?.pendingExposureRaw ?? String(evaluation.quoteValidation?.pendingExposureRaw ?? 0),
    risk: evaluation.riskDecision?.state ?? null,
    quote: evaluation.quotePlan?.plan ?? "NO_QUOTE",
    capsPass: feasible,
    reasons: Object.freeze(unique(reasons)),
    evaluation,
  });
}

/** Simulate one candidate balance against both bounded proof paths. */
export function evaluateCapitalAtSnapshot({ evaluator, collateralRaw, yesRaw, noRaw, minimumMintRaw, currentCapitalCapRaw = DEFAULT_PHASE_3B1_CAPS.MAX_ACCOUNT_CAPITAL, recommendedCapitalRaw = null } = {}) {
  const capital = raw(collateralRaw, "candidate capital");
  const yes = raw(yesRaw, "YES inventory");
  const no = raw(noRaw, "NO inventory");
  const minimumMint = raw(minimumMintRaw, "minimum mint", { positive: true });
  const zero = projectLpState({ collateralRaw: capital, yesRaw: yes, noRaw: no, mintAmountRaw: 0n });
  const buyEvaluation = evaluator.evaluateState(zero, "bid", 0n);
  const buy = pathResult(buyEvaluation, "bid");
  const buyPriceRaw = buy.priceRaw === null ? null : raw(buy.priceRaw, "BUY price", { positive: true });
  const buyQuantityRaw = buy.quantityRaw === null ? 0n : raw(buy.quantityRaw, "BUY quantity");
  // The bounded B path deliberately starts at the venue minimum mint. The
  // planner then sizes SELL to the projected inventory, so no larger mint is
  // assumed before the quote has been evaluated.
  const effectiveMintAmount = minimumMint;
  const minted = projectLpState({ collateralRaw: capital, yesRaw: yes, noRaw: no, mintAmountRaw: effectiveMintAmount });
  const sellEvaluation = evaluator.evaluateState(minted, "ask", effectiveMintAmount);
  const sell = pathResult(sellEvaluation, "ask");
  const equation = deriveCapitalEquation({
    decimals: evaluator.decimals,
    collateralReserveRaw: evaluator.oneRaw,
    minimumMintRaw: effectiveMintAmount,
    buyPriceRaw,
    buyQuantityRaw,
    dreamDexReservedCollateralRaw: evaluator.dreamDexReservedCollateralRaw,
    buyFeasible: buy.feasible,
    mintSellFeasible: sell.feasible,
    inventoryRequiredRaw: sell.quantityRaw === null ? effectiveMintAmount : raw(sell.quantityRaw, "SELL inventory requirement", { positive: true }),
    currentInventoryRaw: yes,
  });
  const reasons = unique([...buy.reasons, ...sell.reasons]);
  const currentCapitalPass = capital <= raw(currentCapitalCapRaw, "current capital cap");
  const nonCapitalCapsPass = buy.feasible || sell.feasible;
  return Object.freeze({
    capitalRaw: capital,
    postMintCollateralRaw: minted.collateralRaw,
    minimumMintRaw: effectiveMintAmount,
    risk: { buy: buy.risk, mintSell: sell.risk },
    bid: buy,
    ask: sell,
    buyOnly: buy,
    mintSell: sell,
    equation,
    pendingExposureRaw: sell.pendingExposureRaw ?? buy.pendingExposureRaw,
    currentCapitalPass,
    nonCapitalCapsPass,
    currentCapsPass: currentCapitalPass && nonCapitalCapsPass,
    strategyFeasible: buy.feasible || sell.feasible,
    reasons: Object.freeze(reasons),
    recommendedCapitalRaw,
  });
}
