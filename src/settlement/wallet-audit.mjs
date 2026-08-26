/**
 * Pure wallet outcome-inventory classification for the final hygiene audit.
 *
 * The live adapter supplies indexer rows, direct chain state, balances, and
 * payout vectors. This module never discovers markets, reads a wallet, or
 * decides to place an order. A nonzero outcome is either tied to a live
 * market, a settled winning claim, a settled zero-value loser, a paired live
 * set, or UNKNOWN; UNKNOWN is intentionally visible and fail-closed.
 */

import {
  PAYOUT_DENOMINATOR_RAW,
  SettlementLifecycleError,
  classifyMarketState,
  outcomeName,
  payoutForOutcome,
} from "./index.mjs";

export const WALLET_AUDIT_VERSION = "villa-wallet-hygiene-v1";

export const WALLET_INVENTORY_CLASSIFICATIONS = Object.freeze({
  ACTIVE_MARKET_INVENTORY: "ACTIVE_MARKET_INVENTORY",
  CLAIMABLE_SETTLED_INVENTORY: "CLAIMABLE_SETTLED_INVENTORY",
  KNOWN_ZERO_VALUE_SETTLED_RESIDUAL: "KNOWN_ZERO_VALUE_SETTLED_RESIDUAL",
  ALREADY_REDEEMED: "ALREADY_REDEEMED",
  PAIRED_BURNABLE_INVENTORY: "PAIRED_BURNABLE_INVENTORY",
  UNKNOWN: "UNKNOWN",
});

function fail(code, message) {
  throw new SettlementLifecycleError(code, message);
}

function exactMarketId(value, label = "marketId") {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    fail("INVALID_MARKET_ID", `${label} must be a 32-byte market id`);
  }
  return value;
}

function sameId(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function raw(value, label) {
  try {
    const result = typeof value === "bigint" ? value : BigInt(String(value));
    if (result < 0n) throw new Error("negative");
    return result;
  } catch {
    fail("INVALID_RAW", `${label} must be a non-negative integer`);
  }
}

function payoutVector(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  try {
    const vector = value.map((item, index) => raw(item, `payoutNumerators[${index}]`));
    if (vector.some((item) => item > PAYOUT_DENOMINATOR_RAW)) return null;
    return vector;
  } catch {
    return null;
  }
}

function rowMarketId(row) {
  return row?.marketId ?? row?.id ?? row?.info?.marketId ?? row?.market?.id ?? null;
}

function balanceAt(balances, outcomeIdx) {
  return outcomeIdx === 0 ? raw(balances?.yesRaw, "balances.yesRaw") : raw(balances?.noRaw, "balances.noRaw");
}

function validateObservation(observation) {
  if (!observation || typeof observation !== "object") return { reason: "MISSING_CHAIN_OBSERVATION" };
  let id;
  try {
    id = exactMarketId(observation.marketId);
  } catch (error) {
    return { reason: error.message };
  }
  if (!observation.row || !sameId(rowMarketId(observation.row), id)) return { reason: "INDEXER_MARKET_MISMATCH" };
  if (!observation.onchain || !sameId(observation.onchain.marketId ?? id, id)) return { reason: "ONCHAIN_MARKET_MISMATCH" };
  if (observation.row.asset !== undefined && String(observation.row.asset).toUpperCase() === "") return { reason: "INDEXER_ASSET_INVALID" };
  if (observation.onchain.yesId === undefined || observation.onchain.noId === undefined) return { reason: "OUTCOME_IDS_MISSING" };
  let state;
  try {
    state = classifyMarketState({
      status: Number(observation.onchain.status),
      isResolved: observation.onchain.isResolved,
      isVoided: observation.onchain.isVoided,
      finalized: observation.onchain.finalized,
    });
  } catch (error) {
    return { reason: error.message };
  }
  const vector = payoutVector(observation.payoutNumerators);
  if (state.redeemable && !vector) return { reason: "PAYOUT_VECTOR_UNAVAILABLE" };
  let yesRaw;
  let noRaw;
  try {
    yesRaw = balanceAt(observation.balances, 0);
    noRaw = balanceAt(observation.balances, 1);
  } catch (error) {
    return { reason: error.message };
  }
  const ordersCount = observation.orders?.count;
  if (ordersCount !== undefined && (!Number.isInteger(Number(ordersCount)) || Number(ordersCount) < 0)) {
    return { reason: "OPEN_ORDER_STATE_INVALID" };
  }
  return { id, state, vector: vector ?? [0n, 0n], yesRaw, noRaw };
}

function classifyOutcome({ observation, checked, outcomeIdx, balanceRaw, indexedPosition }) {
  const outcome = outcomeName(outcomeIdx);
  const exactToken = outcomeIdx === 0 ? observation.onchain.yesId : observation.onchain.noId;
  if (!indexedPosition) {
    return {
      marketId: checked.id,
      outcome,
      outcomeIdx,
      tokenId: String(exactToken),
      balanceRaw,
      classification: WALLET_INVENTORY_CLASSIFICATIONS.UNKNOWN,
      reason: "INDEXER_POSITION_MISSING",
    };
  }
  if (String(indexedPosition.tokenId) !== String(exactToken)) {
    return {
      marketId: checked.id,
      outcome,
      outcomeIdx,
      tokenId: String(indexedPosition.tokenId),
      balanceRaw,
      classification: WALLET_INVENTORY_CLASSIFICATIONS.UNKNOWN,
      reason: "TOKEN_ID_MISMATCH",
    };
  }
  if (raw(indexedPosition.balance, `indexed ${outcome} balance`) !== balanceRaw) {
    return {
      marketId: checked.id,
      outcome,
      outcomeIdx,
      tokenId: String(exactToken),
      balanceRaw,
      classification: WALLET_INVENTORY_CLASSIFICATIONS.UNKNOWN,
      reason: "INDEXER_CHAIN_BALANCE_MISMATCH",
    };
  }

  if (checked.state.resolution === "RESOLVED") {
    const winnerIdx = checked.vector[0] > checked.vector[1] ? 0 : checked.vector[1] > checked.vector[0] ? 1 : null;
    if (winnerIdx === null || (observation.onchain.winningOutcome !== undefined && Number(observation.onchain.winningOutcome) !== winnerIdx)) {
      return {
        marketId: checked.id,
        outcome,
        outcomeIdx,
        tokenId: String(exactToken),
        balanceRaw,
        classification: WALLET_INVENTORY_CLASSIFICATIONS.UNKNOWN,
        reason: "RESOLUTION_VECTOR_INVALID",
      };
    }
    const isWinner = outcomeIdx === winnerIdx;
    return {
      marketId: checked.id,
      outcome,
      outcomeIdx,
      tokenId: String(exactToken),
      balanceRaw,
      classification: isWinner
        ? WALLET_INVENTORY_CLASSIFICATIONS.CLAIMABLE_SETTLED_INVENTORY
        : WALLET_INVENTORY_CLASSIFICATIONS.KNOWN_ZERO_VALUE_SETTLED_RESIDUAL,
      action: isWinner ? "REDEEM" : "SKIP",
      expectedPayoutRaw: isWinner
        ? payoutForOutcome({
          amountRaw: balanceRaw,
          outcomeIdx,
          resolution: "RESOLVED",
          winningOutcome: winnerIdx,
          payoutNumerators: checked.vector,
        })
        : 0n,
      reason: isWinner ? null : "LOSING_OUTCOME_ZERO_PAYOUT",
    };
  }
  if (checked.state.resolution === "VOIDED") {
    return {
      marketId: checked.id,
      outcome,
      outcomeIdx,
      tokenId: String(exactToken),
      balanceRaw,
      classification: WALLET_INVENTORY_CLASSIFICATIONS.CLAIMABLE_SETTLED_INVENTORY,
      action: "REDEEM",
      expectedPayoutRaw: payoutForOutcome({ amountRaw: balanceRaw, outcomeIdx, resolution: "VOIDED", payoutNumerators: checked.vector }),
      reason: null,
    };
  }
  if (checked.state.state === "TRADING") {
    return {
      marketId: checked.id,
      outcome,
      outcomeIdx,
      tokenId: String(exactToken),
      balanceRaw,
      classification: WALLET_INVENTORY_CLASSIFICATIONS.ACTIVE_MARKET_INVENTORY,
      action: "HOLD",
      expectedPayoutRaw: null,
      reason: null,
    };
  }
  return {
    marketId: checked.id,
    outcome,
    outcomeIdx,
    tokenId: String(exactToken),
    balanceRaw,
    classification: WALLET_INVENTORY_CLASSIFICATIONS.UNKNOWN,
    reason: `UNSUPPORTED_MARKET_STATE_${checked.state.state}`,
  };
}

/**
 * Classify every nonzero direct balance against the indexed position list.
 * A direct nonzero balance missing from the indexer is UNKNOWN rather than
 * silently discarded. Equal YES/NO live balances are labelled paired-burnable
 * on both outcome entries so each nonzero token remains visible.
 */
export function buildWalletInventoryAudit({ positions = [], observations = [] } = {}) {
  if (!Array.isArray(positions) || !Array.isArray(observations)) fail("INVALID_AUDIT_INPUT", "positions and observations must be arrays");
  const observationById = new Map();
  for (const observation of observations) {
    const id = exactMarketId(observation?.marketId, "observations.marketId").toLowerCase();
    if (observationById.has(id)) fail("DUPLICATE_OBSERVATION", `observation repeats market ${observation.marketId}`);
    observationById.set(id, observation);
  }
  const positionsByMarket = new Map();
  for (const position of positions) {
    const id = exactMarketId(position?.market?.id ?? position?.marketId, "positions.marketId").toLowerCase();
    const outcomeIdx = position?.outcomeIndex;
    if (outcomeIdx !== 0 && outcomeIdx !== 1) fail("INVALID_OUTCOME_INDEX", `position for ${id} has an invalid outcome index`);
    const list = positionsByMarket.get(id) ?? [];
    if (list.some((item) => item.outcomeIndex === outcomeIdx)) fail("DUPLICATE_POSITION", `${id} repeats outcome ${outcomeIdx}`);
    list.push(position);
    positionsByMarket.set(id, list);
  }

  const marketIds = new Set([...observationById.keys(), ...positionsByMarket.keys()]);
  const entries = [];
  const markets = [];
  for (const id of [...marketIds].sort()) {
    const observation = observationById.get(id);
    const marketPositions = positionsByMarket.get(id) ?? [];
    const checked = validateObservation(observation);
    if (checked.reason) {
      for (const position of marketPositions.filter((item) => raw(item.balance, "position.balance") > 0n)) {
        entries.push({ marketId: id, outcomeIdx: position.outcomeIndex, outcome: outcomeName(position.outcomeIndex), tokenId: String(position.tokenId), balanceRaw: raw(position.balance, "position.balance"), classification: WALLET_INVENTORY_CLASSIFICATIONS.UNKNOWN, reason: checked.reason });
      }
      markets.push({ marketId: id, classification: WALLET_INVENTORY_CLASSIFICATIONS.UNKNOWN, reason: checked.reason });
      continue;
    }
    const positionByOutcome = new Map(marketPositions.map((position) => [position.outcomeIndex, position]));
    const balances = [checked.yesRaw, checked.noRaw];
    const marketEntries = [];
    for (const outcomeIdx of [0, 1]) {
      if (balances[outcomeIdx] === 0n) {
        if (positionByOutcome.has(outcomeIdx) && raw(positionByOutcome.get(outcomeIdx).balance, "position.balance") !== 0n) {
          marketEntries.push({ marketId: id, outcomeIdx, outcome: outcomeName(outcomeIdx), tokenId: String(positionByOutcome.get(outcomeIdx).tokenId), balanceRaw: balances[outcomeIdx], classification: WALLET_INVENTORY_CLASSIFICATIONS.UNKNOWN, reason: "INDEXER_CHAIN_BALANCE_MISMATCH" });
        }
        continue;
      }
      marketEntries.push(classifyOutcome({ observation, checked, outcomeIdx, balanceRaw: balances[outcomeIdx], indexedPosition: positionByOutcome.get(outcomeIdx) }));
    }
    if (checked.state.state === "TRADING" && checked.yesRaw > 0n && checked.yesRaw === checked.noRaw && marketEntries.length === 2 && marketEntries.every((entry) => entry.classification === WALLET_INVENTORY_CLASSIFICATIONS.ACTIVE_MARKET_INVENTORY)) {
      for (const entry of marketEntries) {
        entry.classification = WALLET_INVENTORY_CLASSIFICATIONS.PAIRED_BURNABLE_INVENTORY;
        entry.action = "BURN_SET";
        entry.completeSetsRaw = checked.yesRaw;
      }
    }
    entries.push(...marketEntries);
    markets.push({ marketId: id, state: checked.state.state, resolution: checked.state.resolution, yesRaw: checked.yesRaw, noRaw: checked.noRaw, classifications: [...new Set(marketEntries.map((entry) => entry.classification))] });
  }
  const unknown = entries.filter((entry) => entry.classification === WALLET_INVENTORY_CLASSIFICATIONS.UNKNOWN);
  return {
    model: WALLET_AUDIT_VERSION,
    entries,
    markets,
    unknownCount: unknown.length,
    claimable: entries.filter((entry) => entry.classification === WALLET_INVENTORY_CLASSIFICATIONS.CLAIMABLE_SETTLED_INVENTORY),
    active: entries.filter((entry) => [WALLET_INVENTORY_CLASSIFICATIONS.ACTIVE_MARKET_INVENTORY, WALLET_INVENTORY_CLASSIFICATIONS.PAIRED_BURNABLE_INVENTORY].includes(entry.classification)),
    zeroValueResiduals: entries.filter((entry) => entry.classification === WALLET_INVENTORY_CLASSIFICATIONS.KNOWN_ZERO_VALUE_SETTLED_RESIDUAL),
  };
}

/** Verify an exact claim before a writer is allowed to submit it. */
export function assertExactClaimableEntry(entry, { marketId, outcomeIdx, amountRaw } = {}) {
  if (!entry || entry.classification !== WALLET_INVENTORY_CLASSIFICATIONS.CLAIMABLE_SETTLED_INVENTORY || entry.action !== "REDEEM") fail("CLAIM_NOT_ALLOWED", "only a claimable settled inventory entry can be redeemed");
  if (!sameId(entry.marketId, exactMarketId(marketId, "claim.marketId")) || entry.outcomeIdx !== outcomeIdx || entry.balanceRaw !== raw(amountRaw, "claim.amountRaw")) fail("CLAIM_SCOPE_MISMATCH", "claim does not match the exact audited market, outcome, and balance");
  return true;
}

/** Exact post-receipt reconciliation for a wallet hygiene claim. */
export function reconcileWalletClaim({ entry, before, after, actualPayoutRaw, receiptGasWei = 0n } = {}) {
  if (!entry || entry.action !== "REDEEM") fail("INVALID_RECONCILIATION", "only a redeemable entry can be reconciled");
  const expected = raw(entry.expectedPayoutRaw, "expectedPayoutRaw");
  const actual = raw(actualPayoutRaw, "actualPayoutRaw");
  const gas = raw(receiptGasWei, "receiptGasWei");
  const beforeCollateral = raw(before?.collateralRaw, "before.collateralRaw");
  const afterCollateral = raw(after?.collateralRaw, "after.collateralRaw");
  const beforeStt = raw(before?.sttRaw, "before.sttRaw");
  const afterStt = raw(after?.sttRaw, "after.sttRaw");
  const winnerKey = entry.outcomeIdx === 0 ? "yesRaw" : "noRaw";
  const afterWinner = raw(after?.[winnerKey], `after.${winnerKey}`);
  if (actual !== expected) fail("PAYOUT_VERIFY", "actual payout differs from exact expected payout");
  if (afterWinner !== 0n) fail("CLAIM_NOT_CLEARED", "winning balance was not cleared");
  return {
    marketId: entry.marketId,
    outcome: entry.outcome,
    outcomeIdx: entry.outcomeIdx,
    amountRaw: entry.balanceRaw,
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

export { PAYOUT_DENOMINATOR_RAW };
