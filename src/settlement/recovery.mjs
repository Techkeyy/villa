/**
 * Pure recovery decisions for organic-fill settlement claims.
 *
 * This module knows only the exact market cases supplied by the recovery
 * caller and already-read observations. It does not discover markets, read
 * the chain, access a wallet, or decide whether a new position should exist.
 */

import {
  SettlementLifecycleError,
  buildRedemptionPlan,
  classifyMarketState,
  outcomeName,
  payoutForOutcome,
} from "./index.mjs";

export const ORGANIC_FILL_RECOVERY_VERSION = "villa-organic-fill-recovery-v1";

export const RECOVERY_CLASSIFICATIONS = Object.freeze({
  ACTIVE_MARKET_INVENTORY: "ACTIVE_MARKET_INVENTORY",
  CLAIMABLE_SETTLED_INVENTORY: "CLAIMABLE_SETTLED_INVENTORY",
  ALREADY_REDEEMED: "ALREADY_REDEEMED",
  ZERO_BALANCE: "ZERO_BALANCE",
  KNOWN_ZERO_VALUE_SETTLED_RESIDUAL: "KNOWN_ZERO_VALUE_SETTLED_RESIDUAL",
  UNKNOWN: "UNKNOWN",
});

function fail(code, message) {
  throw new SettlementLifecycleError(code, message);
}

function positiveRaw(value, label) {
  let result;
  try { result = typeof value === "bigint" ? value : BigInt(String(value)); } catch { fail("INVALID_RAW", `${label} must be a positive integer`); }
  if (result <= 0n) fail("INVALID_RAW", `${label} must be a positive integer`);
  return result;
}

function nonNegativeRaw(value, label) {
  let result;
  try { result = typeof value === "bigint" ? value : BigInt(String(value)); } catch { fail("INVALID_RAW", `${label} must be a non-negative integer`); }
  if (result < 0n) fail("INVALID_RAW", `${label} must be a non-negative integer`);
  return result;
}

function exactMarketId(value, label = "marketId") {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail("INVALID_MARKET_ID", `${label} must be a 32-byte market id`);
  return value;
}

function sameId(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function balanceFor(observation, outcomeIdx) {
  return outcomeIdx === 0
    ? nonNegativeRaw(observation.balances?.yesRaw, "balances.yesRaw")
    : nonNegativeRaw(observation.balances?.noRaw, "balances.noRaw");
}

function payoutVector(value) {
  if (!Array.isArray(value) || value.length !== 2 || value.some((item) => typeof item !== "bigint" || item < 0n)) {
    fail("INVALID_PAYOUT_VECTOR", "payoutNumerators must contain two non-negative raw integers");
  }
  return value;
}

function validateCase(item, index) {
  exactMarketId(item?.marketId, `cases[${index}].marketId`);
  if (typeof item?.kind !== "string" || !["ORGANIC_FILL", "KNOWN_RESIDUAL"].includes(item.kind)) fail("INVALID_CASE", `cases[${index}].kind is unsupported`);
  if (item.kind === "ORGANIC_FILL") {
    if (typeof item.fillOrderId !== "string" || item.fillOrderId.trim() === "") fail("INVALID_CASE", `cases[${index}].fillOrderId is required`);
    positiveRaw(item.filledQuantityRaw, `cases[${index}].filledQuantityRaw`);
  }
  if (item.expectedWinningOutcome !== 0 && item.expectedWinningOutcome !== 1) fail("INVALID_CASE", `cases[${index}].expectedWinningOutcome must be 0 or 1`);
  if (item.residualOutcomeIdx !== undefined && item.residualOutcomeIdx !== 0 && item.residualOutcomeIdx !== 1) fail("INVALID_CASE", `cases[${index}].residualOutcomeIdx must be 0 or 1`);
  return item;
}

export function validateRecoveryCases(cases = []) {
  if (!Array.isArray(cases) || cases.length === 0) fail("INVALID_CASES", "at least one exact recovery case is required");
  const seen = new Set();
  return cases.map((item, index) => {
    const checked = validateCase(item, index);
    const id = checked.marketId.toLowerCase();
    if (seen.has(id)) fail("DUPLICATE_MARKET", `recovery cases repeat market ${checked.marketId}`);
    seen.add(id);
    return {
      ...checked,
      marketId: exactMarketId(checked.marketId),
      filledQuantityRaw: checked.kind === "ORGANIC_FILL" ? positiveRaw(checked.filledQuantityRaw, `cases[${index}].filledQuantityRaw`) : null,
    };
  });
}

export function validateHistoricalResidualToken({ tokenId, yesId, noId } = {}) {
  if (tokenId === undefined || tokenId === null) fail("UNKNOWN_HISTORICAL_TOKEN", "historical residual token id is missing");
  const token = String(tokenId);
  if (token === String(yesId)) return { outcomeIdx: 0, outcome: "YES" };
  if (token === String(noId)) return { outcomeIdx: 1, outcome: "NO" };
  fail("UNKNOWN_HISTORICAL_TOKEN", `historical token ${token} is not one of the exact market outcome ids`);
}

function validateObservation(item, observation) {
  const id = exactMarketId(item.marketId);
  if (!observation || !sameId(observation.marketId, id)) fail("MARKET_ID_MISMATCH", `observation does not match exact market ${id}`);
  if (!observation.row || !sameId(observation.row.marketId, id)) fail("INDEXER_MARKET_MISMATCH", `finalized row does not match exact market ${id}`);
  if (observation.row.asset && String(observation.row.asset).toUpperCase() !== "BTC") fail("MARKET_MISMATCH", `${id} is not a BTC market`);
  if (observation.row.status && String(observation.row.status).toUpperCase() !== "FINALIZED") fail("HISTORICAL_STATE_INVALID", `${id} was not returned as finalized history`);
  if (observation.row.intervalSec !== undefined && Math.round(Number(observation.row.intervalSec)) !== 300) fail("MARKET_MISMATCH", `${id} is not a 300-second market`);
  const onchain = observation.onchain;
  if (!onchain || Number(onchain.status) < 0) fail("CHAIN_STATE_INVALID", `${id} has unusable on-chain state`);
  const marketState = classifyMarketState({ status: Number(onchain.status), isResolved: onchain.isResolved, isVoided: onchain.isVoided, finalized: onchain.finalized });
  if (!marketState.redeemable) fail("NOT_REDEEMABLE", `${id} is ${marketState.state}, not settled`);
  if (observation.orders && Number(observation.orders.count ?? observation.orders.length ?? 0) !== 0) fail("ACTIVE_ORDERS_EXIST", `${id} has active orders`);
  if (!onchain.yesId || !onchain.noId) fail("OUTCOME_IDS_MISSING", `${id} is missing exact outcome ids`);
  nonNegativeRaw(observation.balances?.yesRaw, "balances.yesRaw");
  nonNegativeRaw(observation.balances?.noRaw, "balances.noRaw");
  nonNegativeRaw(observation.balances?.collateralRaw, "balances.collateralRaw");
  nonNegativeRaw(observation.balances?.sttRaw, "balances.sttRaw");
  const vector = payoutVector(observation.payoutNumerators);
  if (observation.row.expiry !== undefined && onchain.expiry !== undefined && Number(observation.row.expiry) !== Number(onchain.expiry)) fail("EXPIRY_MISMATCH", `${id} indexer and chain expiry disagree`);
  if (observation.row.winningOutcome !== undefined && marketState.resolution === "RESOLVED" && Number(observation.row.winningOutcome) !== Number(onchain.winningOutcome)) fail("WINNER_MISMATCH", `${id} indexer and chain winner disagree`);
  return { id, onchain, marketState, vector };
}

function priorRedeemed(redeemedMarketIds, id) {
  return new Set((redeemedMarketIds ?? []).map((value) => String(value).toLowerCase())).has(id.toLowerCase());
}

function classifyEntry(item, observation, basePlan, checked, redeemed) {
  const winningIdx = basePlan.winningOutcome;
  if (winningIdx !== item.expectedWinningOutcome) fail("WINNER_MISMATCH", `${item.marketId} winner does not match the recovered evidence`);

  if (item.kind === "KNOWN_RESIDUAL") {
    const residualIdx = item.residualOutcomeIdx;
    const residualToken = residualIdx === 0 ? observation.onchain.yesId : observation.onchain.noId;
    const tokenCheck = validateHistoricalResidualToken({ tokenId: item.residualTokenId ?? residualToken, yesId: observation.onchain.yesId, noId: observation.onchain.noId });
    if (tokenCheck.outcomeIdx !== residualIdx) fail("RESIDUAL_MISMATCH", `${item.marketId} residual outcome does not match the exact token`);
    const residualRaw = balanceFor(observation, residualIdx);
    const residualLeg = basePlan.legs[residualIdx];
    const residualPayout = payoutForOutcome({ amountRaw: residualRaw || 1n, outcomeIdx: residualIdx, resolution: basePlan.resolution, winningOutcome: winningIdx, payoutNumerators: checked.vector });
    if (residualRaw === 0n || residualPayout !== 0n || residualLeg.action !== "SKIP") fail("RESIDUAL_CLASSIFICATION", `${item.marketId} is not the known zero-value residual expected by the recovery case`);
    return {
      classification: RECOVERY_CLASSIFICATIONS.KNOWN_ZERO_VALUE_SETTLED_RESIDUAL,
      action: "SKIP",
      skipReason: "KNOWN_ZERO_VALUE_SETTLED_RESIDUAL",
      claim: residualLeg,
    };
  }

  const winnerLeg = basePlan.legs[winningIdx];
  if (redeemed && winnerLeg.amountRaw > 0n) fail("REDEEM_STATE_CONFLICT", `${item.marketId} was recorded redeemed but still has winning balance`);
  if (winnerLeg.action === "REDEEM") {
    if (winnerLeg.amountRaw > item.filledQuantityRaw) fail("BALANCE_EXCEEDS_FILL", `${item.marketId} winning balance exceeds the recovered fill quantity`);
    return { classification: RECOVERY_CLASSIFICATIONS.CLAIMABLE_SETTLED_INVENTORY, action: "REDEEM", skipReason: null, claim: winnerLeg };
  }
  return {
    classification: redeemed ? RECOVERY_CLASSIFICATIONS.ALREADY_REDEEMED : RECOVERY_CLASSIFICATIONS.ZERO_BALANCE,
    action: "SKIP",
    skipReason: redeemed ? "ALREADY_REDEEMED" : "ZERO_BALANCE",
    claim: winnerLeg,
  };
}

/** Build a deterministic, market-separated claim plan from verified observations. */
export function buildOrganicFillRecoveryPlan({ cases = [], observations = [], redeemedMarketIds = [] } = {}) {
  const normalizedCases = validateRecoveryCases(cases);
  if (!Array.isArray(observations)) fail("INVALID_OBSERVATIONS", "observations must be an array");
  const byMarket = new Map();
  for (const observation of observations) {
    const id = exactMarketId(observation?.marketId, "observations.marketId").toLowerCase();
    if (byMarket.has(id)) fail("DUPLICATE_OBSERVATION", `observation repeats market ${observation.marketId}`);
    byMarket.set(id, observation);
  }

  const entries = normalizedCases.map((item) => {
    const observation = byMarket.get(item.marketId.toLowerCase());
    const checked = validateObservation(item, observation);
    const balances = {
      yesRaw: nonNegativeRaw(observation.balances.yesRaw, "balances.yesRaw"),
      noRaw: nonNegativeRaw(observation.balances.noRaw, "balances.noRaw"),
    };
    const basePlan = buildRedemptionPlan({
      marketId: item.marketId,
      resolution: checked.marketState.resolution,
      winningOutcome: checked.marketState.resolution === "RESOLVED" ? checked.onchain.winningOutcome : undefined,
      payoutNumerators: checked.vector,
      held: balances,
      outcomeIds: { yes: checked.onchain.yesId, no: checked.onchain.noId },
      alreadyRedeemed: { yes: false, no: false },
    });
    const classified = classifyEntry(item, observation, basePlan, checked, priorRedeemed(redeemedMarketIds, item.marketId));
    return {
      marketId: item.marketId,
      kind: item.kind,
      fillOrderId: item.fillOrderId ?? null,
      filledQuantityRaw: item.filledQuantityRaw,
      intervalSec: observation.row.intervalSec === undefined ? 300 : Number(observation.row.intervalSec),
      expirySec: observation.onchain.expiry === undefined ? Number(observation.row.expiry) : Number(observation.onchain.expiry),
      outcomeTokenIds: { yes: String(checked.onchain.yesId), no: String(checked.onchain.noId) },
      resolution: checked.marketState.resolution,
      winningOutcome: basePlan.winningOutcome,
      payoutNumerators: checked.vector,
      balances,
      collateralRaw: nonNegativeRaw(observation.balances.collateralRaw, "balances.collateralRaw"),
      sttRaw: nonNegativeRaw(observation.balances.sttRaw, "balances.sttRaw"),
      ...classified,
      warnings: [...basePlan.warnings],
    };
  });

  return {
    model: ORGANIC_FILL_RECOVERY_VERSION,
    entries,
    claimable: entries.filter((entry) => entry.action === "REDEEM"),
    skipped: entries.filter((entry) => entry.action === "SKIP"),
    totalExpectedPayoutRaw: entries.filter((entry) => entry.action === "REDEEM").reduce((sum, entry) => sum + entry.claim.expectedPayoutRaw, 0n),
    transactionCount: entries.filter((entry) => entry.action === "REDEEM").length,
  };
}

/** Build an explicit residual registry without deleting historical evidence. */
export function buildResidualRegistry(plan) {
  if (!plan || !Array.isArray(plan.entries)) fail("INVALID_PLAN", "recovery plan entries are required");
  return plan.entries.map((entry) => ({
    marketId: entry.marketId,
    classification: entry.classification,
    outcomeBalances: { ...entry.balances },
    winningOutcome: entry.winningOutcome,
    claimAction: entry.action,
    claimOutcome: entry.claim?.outcome ?? outcomeName(entry.residualOutcomeIdx ?? entry.winningOutcome),
  }));
}

/** Reconcile a confirmed claim without mixing collateral and native gas. */
export function reconcileOrganicFillPayout({ entry, before, after, actualPayoutRaw, receiptGasWei = 0n } = {}) {
  if (!entry || entry.action !== "REDEEM") fail("INVALID_RECONCILIATION", "only a redeemable recovery entry can be reconciled");
  const expected = nonNegativeRaw(entry.claim.expectedPayoutRaw, "expectedPayoutRaw");
  const actual = nonNegativeRaw(actualPayoutRaw, "actualPayoutRaw");
  const gas = nonNegativeRaw(receiptGasWei, "receiptGasWei");
  const beforeCollateral = nonNegativeRaw(before?.collateralRaw, "before.collateralRaw");
  const afterCollateral = nonNegativeRaw(after?.collateralRaw, "after.collateralRaw");
  const beforeStt = nonNegativeRaw(before?.sttRaw, "before.sttRaw");
  const afterStt = nonNegativeRaw(after?.sttRaw, "after.sttRaw");
  const winnerKey = entry.winningOutcome === 0 ? "yesRaw" : "noRaw";
  const winnerAfter = nonNegativeRaw(after?.[winnerKey], `after.${winnerKey}`);
  if (actual !== expected) fail("PAYOUT_VERIFY", `${entry.marketId} actual payout differs from the market-specific expected payout`);
  if (winnerAfter !== 0n) fail("REDEEM_VERIFY", `${entry.marketId} winning balance was not cleared`);
  return {
    marketId: entry.marketId,
    outcome: entry.claim.outcome,
    outcomeIdx: entry.claim.outcomeIdx,
    amountRaw: entry.claim.amountRaw,
    expectedPayoutRaw: expected,
    actualPayoutRaw: actual,
    payoutDifferenceRaw: actual - expected,
    payoutExact: true,
    collateralDeltaRaw: afterCollateral - beforeCollateral,
    nativeBalanceDeltaWei: afterStt - beforeStt,
    receiptGasWei: gas,
    gasMeasuredSeparately: true,
    winningBalanceCleared: true,
  };
}

/** Execute claim entries strictly in caller order through one queue. */
export async function executeRecoveryRedeems(entries, { queue, execute } = {}) {
  if (!queue || typeof queue.enqueue !== "function") fail("QUEUE_REQUIRED", "recovery redeems require the serialized writer queue");
  if (typeof execute !== "function") fail("EXECUTOR_REQUIRED", "recovery redeem executor is required");
  const results = [];
  for (const entry of entries.filter((item) => item.action === "REDEEM")) {
    results.push(await queue.enqueue(`redeem:${entry.marketId}:${entry.claim.outcome}`, () => execute(entry)));
  }
  return results;
}
