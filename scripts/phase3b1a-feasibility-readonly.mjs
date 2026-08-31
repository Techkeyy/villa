/**
 * Phase 3B1A.3 read-only post-mint feasibility gate.
 *
 * It consumes one fresh phase3b1a-shadow-readonly result, then evaluates
 * hypothetical account balances in memory. No wallet, signer, RPC writer, or
 * transaction broadcaster is imported or invoked here.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { evaluateRisk, DEFAULT_RISK_CONFIG } from "../src/risk-governor/index.mjs";
import { planQuotes, decimalToRaw } from "../src/quote-planner/index.mjs";
import { createLpExecutionAdapter } from "../src/execution/lp-adapter.mjs";
import { buildLpShadowPlan } from "../src/execution/lp-shadow.mjs";
import { createLpExecutionSession, transitionLpSession } from "../src/execution/lp-session.mjs";
import { LP_MARKET_SERIES } from "../src/execution/lp-market-selection.mjs";
import { DEFAULT_PHASE_3B1_CAPS, createLpTransactionPolicy } from "../src/execution/lp-transaction-policy.mjs";
import { evaluateMintCandidate, generateMintCandidates, LP_QUOTE_FEASIBILITY_VERSION, projectLpState, recommendQuotePath, validateProjectedQuote } from "../src/execution/lp-quote-feasibility.mjs";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHADOW_SCRIPT = fileURLToPath(new URL("./phase3b1a-shadow-readonly.mjs", import.meta.url));
const jsonSafe = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, null, 2);

function withoutSignerSecrets(env) {
  const safe = { ...env };
  delete safe.OPERATOR_PRIVATE_KEY;
  delete safe.TAKER_PRIVATE_KEY;
  delete safe.PRIVATE_KEY;
  return safe;
}

async function readFreshShadow() {
  let result;
  try {
    result = await execFileAsync(process.execPath, [SHADOW_SCRIPT], { cwd: ROOT, env: withoutSignerSecrets(process.env), maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
  const output = `${String(result.stdout ?? "").trim()}\n${String(result.stderr ?? "").trim()}`.trim();
  try { return JSON.parse(output); } catch { throw new Error(`shadow output was not JSON: ${output.slice(-1000)}`); }
}

function raw(value, label) {
  try {
    const result = typeof value === "bigint" ? value : BigInt(String(value));
    if (result < 0n) throw new Error();
    return result;
  } catch { throw new Error(`${label} must be a non-negative raw integer`); }
}

function numeric(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label} must be finite`);
  return result;
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

function plannerInput({ snapshot, decision, market, state, decimals }) {
  const oneRaw = 10n ** BigInt(decimals);
  const grid = market.grid;
  const book = market.book ?? { bids: [], asks: [] };
  const bestBidRaw = book.bids?.[0] ? decimalToRaw(String(book.bids[0][0]), decimals).toString() : null;
  const bestAskRaw = book.asks?.[0] ? decimalToRaw(String(book.asks[0][0]), decimals).toString() : null;
  const minimum = raw(grid.minQuantityRaw, "grid minimum");
  const lot = raw(grid.lotSizeRaw, "grid lot");
  return {
    fairValue: snapshot.fairValue,
    governor: governorInput(decision),
    inventory: { yesRaw: state.yesRaw.toString(), noRaw: state.noRaw.toString(), yesAvailableRaw: state.yesRaw.toString() },
    pendingOrders: [],
    book: { bestBidRaw, bestAskRaw, empty: !book.bids?.length && !book.asks?.length },
    grid: { decimals, oneRaw: oneRaw.toString(), tickSizeRaw: String(grid.tickSizeRaw), lotSizeRaw: String(grid.lotSizeRaw), minQuantityRaw: String(grid.minQuantityRaw) },
    capital: { collateralAvailableRaw: state.collateralRaw.toString(), collateralReserveRaw: oneRaw.toString(), collateralReserve: DEFAULT_RISK_CONFIG.minCollateralReserve },
    market: { marketId: market.marketId, timeRemainingSec: decision.authoritativeTime.timeRemainingSec },
    quote: { baseQuantityRaw: (minimum > lot * 5n ? minimum : lot * 5n).toString() },
  };
}

function mockReader() {
  return {
    readAccountIdentity: async () => ({}),
    readCapital: async () => ({}),
    readOutcomeInventory: async () => ({}),
    readOrders: async () => ({}),
  };
}

function restrictQuotePlan(quotePlan, sideName) {
  const selected = quotePlan?.[sideName];
  const disabled = (side) => ({ ...side, enabled: false, targetPriceRaw: null, targetQuantityRaw: null, collateralRequiredRaw: null, projectedExposure: null });
  if (!selected?.enabled) return { ...quotePlan, plan: "NO_QUOTE", bid: disabled(quotePlan?.bid ?? {}), ask: disabled(quotePlan?.ask ?? {}) };
  return { ...quotePlan, plan: "ONE_SIDED", bid: sideName === "bid" ? selected : disabled(quotePlan?.bid ?? {}), ask: sideName === "ask" ? selected : disabled(quotePlan?.ask ?? {}) };
}

function validateUnsignedSequence({ account, owner, operator, market, state, decision, quotePlan, mintAmountRaw, decimals, accountMaxOrderCollateralRaw }) {
  const includesMint = mintAmountRaw > 0n;
  if (decision.state === "HALT" || quotePlan?.plan === "NO_QUOTE" || (includesMint && mintAmountRaw > accountMaxOrderCollateralRaw)) return { valid: false, reasons: ["SEQUENCE_PRECONDITION_INVALID"], actions: [] };
  const adapter = createLpExecutionAdapter({ account, owner, operator, reader: mockReader() });
  const createdAtMs = Date.now();
  const session = transitionLpSession(createLpExecutionSession({ sessionId: `phase3b1a-feasibility-${market.marketId.slice(-8)}`, account, owner, operator, marketSeries: LP_MARKET_SERIES, currentMarketId: market.marketId, riskPolicyVersion: decision.governorVersion, executionMode: "WET", createdAt: createdAtMs }), "PREFLIGHT", { atMs: createdAtMs });
  const policy = createLpTransactionPolicy({ session, caps: DEFAULT_PHASE_3B1_CAPS, now: () => createdAtMs });
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
    ? [
      adapter.mintCompleteSet({ marketId: market.marketId, amountRaw: mintAmountRaw }),
      quoteAction,
      adapter.cancelOrder({ marketId: market.marketId, orderId: 0n }),
      adapter.burnCompleteSet({ marketId: market.marketId, amountRaw: mintAmountRaw }),
    ]
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
  return { valid: reasons.length === 0, reasons, actions };
}

function projectedEvaluation({ shadow, state, market, decimals, account, owner, operator, accountMaxOrderQuantityRaw, accountMaxOrderCollateralRaw, mintAmountRaw, sideName }) {
  const baseSnapshot = shadow.riskSnapshot;
  const one = 10n ** BigInt(decimals);
  const snapshot = {
    ...baseSnapshot,
    inventory: { yes: Number(state.yesRaw) / Number(one), no: Number(state.noRaw) / Number(one) },
    openOrdersStatus: "VERIFIED",
    openOrders: [],
    capital: { ...baseSnapshot.capital, collateralAvailable: Number(state.collateralRaw) / Number(one), capitalAtRisk: 0, accountingStatus: "PARTIAL" },
  };
  const riskDecision = evaluateRisk(snapshot, DEFAULT_RISK_CONFIG);
  const quotePlan = restrictQuotePlan(planQuotes(plannerInput({ snapshot, decision: riskDecision, market, state, decimals })), sideName);
  const sequence = validateUnsignedSequence({ account, owner, operator, market, state, decision: riskDecision, quotePlan, mintAmountRaw, decimals, accountMaxOrderCollateralRaw });
  const quoteExecution = { orderType: 3, postOnly: true, policyValid: sequence.valid };
  return { riskDecision, quotePlan, quoteExecution, sequencePolicyValid: sequence.valid, sequence, snapshot, market, accountMaxOrderQuantityRaw, accountMaxOrderCollateralRaw };
}

const shadow = await readFreshShadow();
if (shadow.result !== "PASS") {
  console.log(jsonSafe({ result: "BLOCKED", stage: "FRESH_MARKET_DISCOVERY", reason: shadow.reason ?? "fresh shadow did not produce an eligible market", shadow }));
  process.exit(2);
}

const account = shadow.account;
const owner = shadow.owner;
const operator = shadow.operator;
const market = shadow.market;
const decimals = Number(shadow.riskSnapshot?.market?.decimals ?? market.grid?.decimals ?? 6);
const collateralRaw = raw(shadow.capital?.collateralAvailableRaw ?? (shadow.riskSnapshot.capital.collateralAvailable === undefined ? 0 : Math.round(Number(shadow.riskSnapshot.capital.collateralAvailable) * 10 ** decimals)), "collateral balance");
const yesRaw = raw(shadow.inventory.yesRaw, "YES balance");
const noRaw = raw(shadow.inventory.noRaw, "NO balance");
const baseState = projectLpState({ collateralRaw, yesRaw, noRaw, mintAmountRaw: 0n });
const accountMaxOrderQuantityRaw = raw(shadow.accountLimits.maxOrderQuantityRaw, "VillaAccount maxOrderQuantity");
const accountMaxOrderCollateralRaw = raw(shadow.accountLimits.maxOrderCollateralRaw, "VillaAccount maxOrderCollateral");
const minimumMintRaw = raw(market.minimumOrderRaw ?? market.grid.minQuantityRaw, "venue minimum mint");
const candidates = generateMintCandidates({ minimumAmountRaw: minimumMintRaw, maximumAmountRaw: DEFAULT_PHASE_3B1_CAPS.MAX_MINT_AMOUNT, stepRaw: minimumMintRaw });

const evaluate = (mintAmountRaw) => evaluateMintCandidate({ collateralRaw, yesRaw, noRaw, mintAmountRaw, minimumMintRaw, accountMaxOrderQuantityRaw, accountMaxOrderCollateralRaw, caps: DEFAULT_PHASE_3B1_CAPS, evaluateProjectedState: (state) => projectedEvaluation({ shadow, state, market, decimals, account, owner, operator, accountMaxOrderQuantityRaw, accountMaxOrderCollateralRaw, mintAmountRaw: raw(mintAmountRaw, "mint amount"), sideName: "ask" }) });
const zeroEvaluation = projectedEvaluation({ shadow, state: baseState, market, decimals, account, owner, operator, accountMaxOrderQuantityRaw, accountMaxOrderCollateralRaw, mintAmountRaw: 0n, sideName: "bid" });
const zeroValidation = validateProjectedQuote({ riskDecision: zeroEvaluation.riskDecision, quotePlan: zeroEvaluation.quotePlan, quoteExecution: zeroEvaluation.quoteExecution, market, accountMaxOrderQuantityRaw, accountMaxOrderCollateralRaw, caps: DEFAULT_PHASE_3B1_CAPS });
const buyWithoutMint = Object.freeze({
  viable: zeroEvaluation.riskDecision.state !== "HALT" && zeroEvaluation.quotePlan.plan !== "NO_QUOTE" && zeroEvaluation.quotePlan.bid?.enabled === true && zeroEvaluation.sequencePolicyValid && zeroValidation.valid,
  state: baseState,
  riskDecision: zeroEvaluation.riskDecision,
  quotePlan: zeroEvaluation.quotePlan,
  quoteExecution: zeroEvaluation.quoteExecution,
  sequence: zeroEvaluation.sequence,
  reasons: zeroValidation.reasons,
});
const evaluatedCandidates = candidates.map(evaluate);
const smallestViable = evaluatedCandidates.find((item) => item.viable) ?? null;
const sellAfterMint = smallestViable && smallestViable.quotePlan?.ask?.enabled === true ? smallestViable : null;
const recommendation = recommendQuotePath({ buyWithoutMint, sellAfterMint });
const structurallyBlocked = evaluatedCandidates.length > 0 && evaluatedCandidates.every((item) => item.reasons.some((entry) => ["RISK_HALTED", "ACCOUNT_MINT_LIMIT", "MINT_CAP"].includes(entry.code))) && evaluatedCandidates.some((item) => item.reasons.some((entry) => entry.code === "RISK_HALTED"));
const verdict = buyWithoutMint.viable || sellAfterMint?.viable === true ? "1.00 tUSDC IS SUFFICIENT" : structurallyBlocked ? "1.00 tUSDC IS STRUCTURALLY INSUFFICIENT" : "FEASIBILITY DEPENDS ON LIVE BOOK STATE";
const oneRaw = 10n ** BigInt(decimals);
const minimumProposedCapitalRaw = oneRaw + minimumMintRaw;

console.log(jsonSafe({
  result: "PASS",
  version: LP_QUOTE_FEASIBILITY_VERSION,
  shadow,
  account,
  owner,
  operator,
  market: { marketId: market.marketId, expirySec: market.expirySec, headroomSec: shadow.risk.authoritativeTime.timeRemainingSec, grid: market.grid, minimumOrderRaw: minimumMintRaw, book: market.book },
  priorNoQuote: { plan: shadow.quotePlan.plan, reasonCodes: shadow.quotePlan.reasonCodes, bid: shadow.quotePlan.bid?.reasonCodes ?? [], ask: shadow.quotePlan.ask?.reasonCodes ?? [] },
  circularDependency: { detected: shadow.quotePlan.plan === "NO_QUOTE" && shadow.inventory.yesRaw === "0" && shadow.inventory.noRaw === "0", explanation: "pre-mint quote planning cannot create a BUY because collateral must remain at the reserve, and cannot create a SELL because YES inventory is zero" },
  buyWithoutMint,
  sellAfterMint,
  mintSearch: { candidateCount: candidates.length, minimumMintRaw, maximumMintRaw: DEFAULT_PHASE_3B1_CAPS.MAX_MINT_AMOUNT, accountMaxOrderCollateralRaw, smallestViableMintRaw: smallestViable?.mintAmountRaw ?? null, viableCount: evaluatedCandidates.filter((item) => item.viable).length },
  sampleCandidates: evaluatedCandidates.filter((_item, index) => index === 0 || index === evaluatedCandidates.length - 1 || _item.viable).slice(0, 5),
  recommendation,
  verdict,
  minimumProposedCapital: { raw: minimumProposedCapitalRaw, tUSDC: Number(minimumProposedCapitalRaw) / Number(oneRaw), route: "B minimal mint then SELL", note: "lower bound before fees or an operational buffer; hard cap was not changed" },
  policy: { caps: DEFAULT_PHASE_3B1_CAPS, noWrites: true, noSigner: true, noBroadcast: true },
}));
