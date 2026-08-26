/**
 * Pure settlement lifecycle decisions for VILLA.
 *
 * This module deliberately has no SDK, RPC, indexer, wallet, clock, or
 * environment dependency.  The live adapter supplies already-read values;
 * this layer decides whether a market is redeemable, which explicit outcome
 * indices are claimable, and how the raw-value reconciliation is labelled.
 */

export const SETTLEMENT_LIFECYCLE_VERSION = "villa-settlement-v1";
export const PAYOUT_DENOMINATOR_RAW = 10_000_000n;

export const ONCHAIN_STATUS = Object.freeze({
  Listed: 0,
  Trading: 1,
  Locked: 2,
  Settling: 3,
  Resolved: 4,
  Voided: 5,
});

export const SETTLEMENT_EVENTS = Object.freeze([
  "SETTLEMENT_SESSION_STARTED",
  "COMPLETE_SET_MINTED",
  "MARKET_LOCKED",
  "MARKET_SETTLING",
  "MARKET_RESOLVED",
  "MARKET_VOIDED",
  "REDEEM_PLANNED",
  "REDEEM_SUBMITTED",
  "REDEEM_CONFIRMED",
  "PAYOUT_RECONCILED",
  "SETTLEMENT_SESSION_CLEAN",
]);

export class SettlementLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SettlementLifecycleError";
    this.code = code;
  }
}

function requireFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SettlementLifecycleError("INVALID_NUMBER", `${label} must be a finite number`);
  }
  return value;
}

function nonNegativeRaw(value, label) {
  if (typeof value !== "bigint" || value < 0n) {
    throw new SettlementLifecycleError("INVALID_RAW", `${label} must be a non-negative bigint`);
  }
  return value;
}

function positiveRaw(value, label) {
  nonNegativeRaw(value, label);
  if (value === 0n) throw new SettlementLifecycleError("INVALID_RAW", `${label} must be positive`);
  return value;
}

function marketId(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SettlementLifecycleError("INVALID_MARKET_ID", "marketId is required");
  }
  return value;
}

export function outcomeName(outcomeIdx) {
  if (outcomeIdx === 0) return "YES";
  if (outcomeIdx === 1) return "NO";
  throw new SettlementLifecycleError("INVALID_OUTCOME_INDEX", "outcomeIdx must be explicit 0 (YES) or 1 (NO)");
}

export function normalizeOutcomeIndex(value, label = "outcomeIdx") {
  if (value !== 0 && value !== 1) {
    throw new SettlementLifecycleError("INVALID_OUTCOME_INDEX", `${label} must be explicit 0 (YES) or 1 (NO)`);
  }
  return value;
}

export function normalizeResolution(value) {
  const resolution = String(value ?? "").toUpperCase();
  if (resolution !== "RESOLVED" && resolution !== "VOIDED") {
    throw new SettlementLifecycleError("NOT_REDEEMABLE", "settlement resolution must be RESOLVED or VOIDED");
  }
  return resolution;
}

function statusNumber(status) {
  if (typeof status === "number" && Number.isInteger(status)) return status;
  if (typeof status === "string" && Object.hasOwn(ONCHAIN_STATUS, status)) return ONCHAIN_STATUS[status];
  if (status === "Finalized") return null;
  throw new SettlementLifecycleError("INVALID_STATUS", `unsupported market status ${String(status)}`);
}

/**
 * The chain flags/status are authoritative.  `Finalized` is an indexer label,
 * not an additional on-chain enum value, and cannot by itself establish a
 * winner or void payout.
 */
export function classifyMarketState({ status, isResolved = false, isVoided = false, finalized = false } = {}) {
  if (typeof isResolved !== "boolean" || typeof isVoided !== "boolean" || typeof finalized !== "boolean") {
    throw new SettlementLifecycleError("INVALID_STATE", "settlement flags must be boolean");
  }
  if (isResolved && isVoided) {
    throw new SettlementLifecycleError("CONTRADICTORY_STATE", "market cannot be both resolved and voided");
  }
  const numeric = statusNumber(status);
  if (numeric !== null && (numeric < 0 || numeric > 5)) {
    throw new SettlementLifecycleError("INVALID_STATUS", `unsupported on-chain status ${numeric}`);
  }

  if (isVoided || numeric === ONCHAIN_STATUS.Voided) {
    return { state: "VOIDED", resolution: "VOIDED", redeemable: true, authority: "ONCHAIN" };
  }
  if (isResolved || numeric === ONCHAIN_STATUS.Resolved) {
    return { state: "RESOLVED", resolution: "RESOLVED", redeemable: true, authority: "ONCHAIN" };
  }
  if (finalized || status === "Finalized") {
    return { state: "FINALIZED", resolution: null, redeemable: false, authority: "INDEXER_ONLY" };
  }
  const state = Object.entries(ONCHAIN_STATUS).find(([, value]) => value === numeric)?.[0];
  return { state: state?.toUpperCase() ?? "UNKNOWN", resolution: null, redeemable: false, authority: "ONCHAIN" };
}

export function resolutionFromOnchain(onchain = {}) {
  const state = classifyMarketState(onchain);
  if (!state.redeemable) {
    throw new SettlementLifecycleError("NOT_REDEEMABLE", `market state ${state.state} is not redeemable`);
  }
  return state.resolution;
}

export function completeSetExposure({ yesRaw, noRaw }) {
  nonNegativeRaw(yesRaw, "yesRaw");
  nonNegativeRaw(noRaw, "noRaw");
  return {
    completeSetsRaw: yesRaw < noRaw ? yesRaw : noRaw,
    directionalDeltaRaw: yesRaw - noRaw,
  };
}

function payoutVector(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length !== 2) {
    throw new SettlementLifecycleError("INVALID_PAYOUT_VECTOR", "payoutNumerators must contain exactly YES and NO values");
  }
  return value.map((item, index) => {
    nonNegativeRaw(item, `payoutNumerators[${index}]`);
    if (item > PAYOUT_DENOMINATOR_RAW) throw new SettlementLifecycleError("INVALID_PAYOUT_VECTOR", "payout numerator exceeds denominator");
    return item;
  });
}

function winnerFromVector(vector) {
  if (!vector || (vector[0] === 0n && vector[1] === 0n)) return undefined;
  if (vector[0] === vector[1]) return undefined;
  return vector[0] > vector[1] ? 0 : 1;
}

/** Calculate a protocol-denominated payout without converting through floats. */
export function payoutForOutcome({ amountRaw, outcomeIdx, resolution, winningOutcome, payoutNumerators, settlementFeeBps = 0n } = {}) {
  positiveRaw(amountRaw, "amountRaw");
  normalizeOutcomeIndex(outcomeIdx);
  const normalizedResolution = normalizeResolution(resolution);
  const vector = payoutVector(payoutNumerators);
  const denominator = PAYOUT_DENOMINATOR_RAW;

  if (normalizedResolution === "VOIDED") {
    const numerator = vector?.[outcomeIdx] ?? denominator / 2n;
    return (amountRaw * numerator) / denominator;
  }

  const vectorWinner = winnerFromVector(vector);
  const winner = winningOutcome === undefined ? vectorWinner : normalizeOutcomeIndex(winningOutcome, "winningOutcome");
  if (winner === undefined) throw new SettlementLifecycleError("MISSING_WINNER", "resolved market has no unambiguous winning outcome");
  if (vector && vectorWinner !== undefined && vectorWinner !== winner) {
    throw new SettlementLifecycleError("WINNER_MISMATCH", "winningOutcome disagrees with payoutNumerators");
  }
  if (vector) return (amountRaw * vector[outcomeIdx]) / denominator;

  if (typeof settlementFeeBps !== "bigint" || settlementFeeBps < 0n || settlementFeeBps > 10_000n) {
    throw new SettlementLifecycleError("INVALID_FEE", "settlementFeeBps must be between 0 and 10000 bps");
  }
  return outcomeIdx === winner ? (amountRaw * (10_000n - settlementFeeBps)) / 10_000n : 0n;
}

function heldForOutcome(held, idx) {
  const raw = idx === 0 ? held?.yesRaw : held?.noRaw;
  return nonNegativeRaw(raw, idx === 0 ? "held.yesRaw" : "held.noRaw");
}

function ownedForOutcome(owned, held, idx) {
  const raw = owned === undefined ? heldForOutcome(held, idx) : idx === 0 ? owned?.yesRaw : owned?.noRaw;
  return nonNegativeRaw(raw, idx === 0 ? "owned.yesRaw" : "owned.noRaw");
}

function alreadyRedeemedFor(alreadyRedeemed, idx) {
  if (alreadyRedeemed === undefined) return false;
  if (typeof alreadyRedeemed === "object" && alreadyRedeemed !== null) {
    const value = idx === 0 ? alreadyRedeemed.yes : alreadyRedeemed.no;
    return value === true || value === "true";
  }
  throw new SettlementLifecycleError("INVALID_REDEEM_STATE", "alreadyRedeemed must be an object of YES/NO booleans");
}

/**
 * Build an explicit, idempotent redemption plan.  Losing resolved tokens are
 * intentionally SKIP legs: the current protocol/SDK only redeems winning
 * tokens, while a void redeems both outcomes at half collateral.
 */
export function buildRedemptionPlan({
  marketId: id,
  resolution,
  winningOutcome,
  payoutNumerators,
  settlementFeeBps = 0n,
  held,
  owned,
  outcomeIds = {},
  alreadyRedeemed,
} = {}) {
  const normalizedMarketId = marketId(id);
  const normalizedResolution = normalizeResolution(resolution);
  const vector = payoutVector(payoutNumerators);
  const vectorWinner = winnerFromVector(vector);
  let winner;
  if (normalizedResolution === "RESOLVED") {
    winner = winningOutcome === undefined ? vectorWinner : normalizeOutcomeIndex(winningOutcome, "winningOutcome");
    if (winner === undefined) throw new SettlementLifecycleError("MISSING_WINNER", "resolved redemption plan needs an explicit winner or one-hot payout vector");
    if (vectorWinner !== undefined && vectorWinner !== winner) throw new SettlementLifecycleError("WINNER_MISMATCH", "winningOutcome disagrees with payoutNumerators");
  }

  const legs = [0, 1].map((idx) => {
    const heldRaw = heldForOutcome(held, idx);
    const ownedRaw = ownedForOutcome(owned, held, idx);
    const outcome = outcomeName(idx);
    const outcomeId = outcomeIds[idx === 0 ? "yes" : "no"];
    if (outcomeId !== undefined) positiveRaw(outcomeId, `${outcome} outcomeId`);
    if (ownedRaw > heldRaw) throw new SettlementLifecycleError("OWNERSHIP_MISMATCH", `${outcome} owned amount exceeds visible balance`);
    const already = alreadyRedeemedFor(alreadyRedeemed, idx);
    const amountRaw = ownedRaw < heldRaw ? ownedRaw : heldRaw;
    let action = "REDEEM";
    let skipReason = null;
    if (already) {
      action = "SKIP";
      skipReason = "ALREADY_REDEEMED";
    } else if (normalizedResolution === "RESOLVED" && idx !== winner) {
      action = "SKIP";
      skipReason = "LOSING_OUTCOME_ZERO_PAYOUT";
    } else if (amountRaw === 0n) {
      action = "SKIP";
      skipReason = "ZERO_BALANCE";
    }
    const expectedPayoutRaw = action === "REDEEM"
      ? payoutForOutcome({ amountRaw, outcomeIdx: idx, resolution: normalizedResolution, winningOutcome: winner, payoutNumerators: vector, settlementFeeBps })
      : 0n;
    return {
      outcome,
      outcomeIdx: idx,
      outcomeId: outcomeId === undefined ? null : outcomeId,
      heldRaw,
      ownedRaw,
      amountRaw,
      action,
      skipReason,
      expectedPayoutRaw,
    };
  });

  return {
    model: SETTLEMENT_LIFECYCLE_VERSION,
    marketId: normalizedMarketId,
    resolution: normalizedResolution,
    winningOutcome: winner ?? null,
    legs,
    redeemableOutcomes: legs.filter((leg) => leg.action === "REDEEM").map((leg) => leg.outcome),
    totalExpectedPayoutRaw: legs.reduce((sum, leg) => sum + leg.expectedPayoutRaw, 0n),
    warnings: normalizedResolution === "RESOLVED" && legs.some((leg) => leg.skipReason === "LOSING_OUTCOME_ZERO_PAYOUT" && leg.heldRaw > 0n)
      ? ["LOSING_OUTCOME_REMAINS_AS_ZERO_VALUE_POSITION"]
      : [],
  };
}

export function buildClaimSweepEntry(input = {}) {
  const plan = buildRedemptionPlan(input);
  return {
    marketId: plan.marketId,
    resolution: plan.resolution,
    winningOutcome: plan.winningOutcome,
    claimableOutcomes: plan.redeemableOutcomes,
    amountsRaw: plan.legs.filter((leg) => leg.action === "REDEEM").map((leg) => ({ outcome: leg.outcome, amountRaw: leg.amountRaw })),
    warnings: plan.warnings,
  };
}

/** Exact mint-side guard used before the live adapter can continue. */
export function reconcileMintBalances({ baseline, afterMint, mintAmountRaw }) {
  positiveRaw(mintAmountRaw, "mintAmountRaw");
  for (const [label, value] of [["baseline.collateralRaw", baseline?.collateralRaw], ["afterMint.collateralRaw", afterMint?.collateralRaw]]) nonNegativeRaw(value, label);
  for (const [label, value] of [["baseline.yesRaw", baseline?.yesRaw], ["baseline.noRaw", baseline?.noRaw], ["afterMint.yesRaw", afterMint?.yesRaw], ["afterMint.noRaw", afterMint?.noRaw]]) nonNegativeRaw(value, label);
  const yesDelta = afterMint.yesRaw - baseline.yesRaw;
  const noDelta = afterMint.noRaw - baseline.noRaw;
  const collateralDebitRaw = baseline.collateralRaw - afterMint.collateralRaw;
  if (yesDelta !== mintAmountRaw || noDelta !== mintAmountRaw) throw new SettlementLifecycleError("MINT_VERIFY", "complete-set mint did not add the exact YES and NO amount");
  if (collateralDebitRaw !== mintAmountRaw) throw new SettlementLifecycleError("MINT_VERIFY", "complete-set mint did not debit exact collateral");
  return { yesDeltaRaw: yesDelta, noDeltaRaw: noDelta, collateralDebitRaw, directionalDeltaRaw: yesDelta - noDelta };
}

/** Reconcile collateral and native gas as separate ledgers. */
export function reconcilePayout({
  baselineCollateralRaw,
  afterMintCollateralRaw,
  finalCollateralRaw,
  mintAmountRaw,
  expectedPayoutRaw,
  actualPayoutRaw,
  baselineSttRaw,
  finalSttRaw,
  receiptGasWei = 0n,
} = {}) {
  for (const [label, value] of [["baselineCollateralRaw", baselineCollateralRaw], ["afterMintCollateralRaw", afterMintCollateralRaw], ["finalCollateralRaw", finalCollateralRaw], ["mintAmountRaw", mintAmountRaw], ["expectedPayoutRaw", expectedPayoutRaw], ["actualPayoutRaw", actualPayoutRaw], ["baselineSttRaw", baselineSttRaw], ["finalSttRaw", finalSttRaw], ["receiptGasWei", receiptGasWei]]) nonNegativeRaw(value, label);
  return {
    collateralDebitedRaw: baselineCollateralRaw - afterMintCollateralRaw,
    collateralReturnedRaw: finalCollateralRaw - afterMintCollateralRaw,
    finalCollateralDeltaRaw: finalCollateralRaw - baselineCollateralRaw,
    expectedPayoutRaw,
    actualPayoutRaw,
    payoutDifferenceRaw: actualPayoutRaw - expectedPayoutRaw,
    payoutExact: actualPayoutRaw === expectedPayoutRaw,
    nativeBalanceDeltaWei: finalSttRaw - baselineSttRaw,
    receiptGasWei,
    gasMeasuredSeparately: true,
  };
}

export function historicalMarketMatches(row, id) {
  return Boolean(row?.marketId && typeof id === "string" && row.marketId.toLowerCase() === id.toLowerCase());
}

export function authoritativeResolution({ onchain, indexerStatus, indexerWinningOutcome } = {}) {
  const state = classifyMarketState(onchain);
  return {
    ...state,
    indexerStatus: indexerStatus ?? null,
    indexerWinningOutcome: indexerWinningOutcome ?? null,
    conflict: Boolean(indexerStatus && String(indexerStatus).toUpperCase() !== state.state),
  };
}

export function assertSecretFree(value) {
  const visit = (item, path = "root") => {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (/(private|secret|mnemonic|seed|password)/i.test(key)) throw new SettlementLifecycleError("SECRET_LEAK", `secret-like field at ${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };
  visit(value);
  return true;
}
