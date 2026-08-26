/**
 * Phase 6A.1: recover the two exact organic-fill winning positions.
 *
 * Dry mode is read-only. Wet mode requires --confirm, performs a complete
 * all-case preflight, and redeems only the two known claimable market ids in
 * sequence through one serialized queue. It never mints, places orders, or
 * selects a new market.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAddress } from "viem";
import {
  SettlementLifecycleError,
  assertSecretFree,
} from "../src/settlement/index.mjs";
import {
  buildFinalizedClaimSweepEntry,
  createSettlementExchange,
  readBalances,
  readChainTime,
  readOperatorApproval,
  readPayoutNumerators,
  readVerifiedOrders,
  scanFinalizedBtcClaimSweep,
} from "../src/settlement/live.mjs";
import {
  buildOrganicFillRecoveryPlan,
  buildResidualRegistry,
  executeRecoveryRedeems,
  ORGANIC_FILL_RECOVERY_VERSION,
  reconcileOrganicFillPayout,
} from "../src/settlement/recovery.mjs";
import { createSerializedWriteQueue } from "../src/execution/write-queue.mjs";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const CONFIRM = args.has("--confirm");
const JOURNAL_PATH = process.env.VILLA_RECOVERY_JOURNAL || "runtime/state/organic-fill-recovery-v1.json";
const FINALIZED_LIMIT = 200;

export const ORGANIC_FILL_CASES = Object.freeze([
  Object.freeze({
    kind: "ORGANIC_FILL",
    marketId: "0x000000000000000000000000000000000000000000000000000000000000a3dd",
    fillOrderId: "55340232221128713213",
    filledQuantityRaw: 1000n,
    expectedWinningOutcome: 1,
    source: "Phase 6A wet evidence",
  }),
  Object.freeze({
    kind: "ORGANIC_FILL",
    marketId: "0x000000000000000000000000000000000000000000000000000000000000a3e9",
    fillOrderId: "18446744073709615271",
    filledQuantityRaw: 1000n,
    expectedWinningOutcome: 1,
    source: "Phase 6A wet evidence",
  }),
  Object.freeze({
    kind: "KNOWN_RESIDUAL",
    marketId: "0x000000000000000000000000000000000000000000000000000000000000a00b",
    expectedWinningOutcome: 0,
    residualOutcomeIdx: 1,
    source: "Phase 5A settlement evidence",
  }),
]);

function jsonSafe(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function log(label, details = undefined) {
  console.log(`${label}${details === undefined ? "" : ` ${typeof details === "string" ? details : jsonSafe(details)}`}`);
}

function ownerFromEnv(exchange) {
  const owner = process.env.OPERATOR_ADDRESS || exchange.walletAddress;
  if (!owner || !isAddress(owner)) throw new SettlementLifecycleError("ENVIRONMENT", "OPERATOR_ADDRESS is required; preserve the existing .env");
  if (exchange.walletAddress && exchange.walletAddress.toLowerCase() !== owner.toLowerCase()) throw new SettlementLifecycleError("ENVIRONMENT", "OPERATOR_ADDRESS does not match the existing signer wallet");
  return owner;
}

function txSummary(result) {
  if (!result?.hash || !result?.receipt || result.receipt.status !== "success") throw new SettlementLifecycleError("TX_UNCONFIRMED", "redeem did not return a successful SDK receipt");
  const receipt = result.receipt;
  const gasWei = receipt.gasUsed !== undefined && receipt.effectiveGasPrice !== undefined ? receipt.gasUsed * receipt.effectiveGasPrice : 0n;
  return { hash: String(result.hash), status: receipt.status, blockNumber: receipt.blockNumber === undefined ? null : String(receipt.blockNumber), gasUsed: receipt.gasUsed === undefined ? null : String(receipt.gasUsed), effectiveGasPrice: receipt.effectiveGasPrice === undefined ? null : String(receipt.effectiveGasPrice), gasWei: String(gasWei) };
}

function addEvent(state, type, facts = {}, chainNowSec = null) {
  state.journalRevision += 1;
  state.events.push({ sequence: state.events.length + 1, type, atChainSec: chainNowSec, facts });
  return state;
}

async function saveState(state) {
  assertSecretFree(state);
  await mkdir("runtime/state", { recursive: true });
  await writeFile(JOURNAL_PATH, jsonSafe(state) + "\n", "utf8");
}

async function readPreviousState() {
  if (!existsSync(JOURNAL_PATH)) return null;
  const parsed = JSON.parse(await readFile(JOURNAL_PATH, "utf8"));
  assertSecretFree(parsed);
  return parsed;
}

function priorRedeemedIds(previous) {
  return (previous?.claims ?? []).filter((claim) => claim.reconciled === true).map((claim) => claim.marketId);
}

async function finalizedRows(exchange) {
  return exchange.client.listBinaryMarkets({ asset: "BTC", status: "Finalized", limit: FINALIZED_LIMIT });
}

async function readExactObservation(exchange, owner, item, rows) {
  let row = rows.find((candidate) => String(candidate.marketId ?? candidate.info?.marketId ?? "").toLowerCase() === item.marketId.toLowerCase());
  let historicalDiscovery = true;
  let onchain;
  if (!row && item.kind === "KNOWN_RESIDUAL") {
    // The documented Phase 5A residual can age out of the bounded latest
    // finalized page. Its exact market id and direct chain state remain the
    // authoritative identity; record the page miss rather than guessing.
    onchain = await exchange.client.getMarketOnchain(item.marketId);
    row = { marketId: item.marketId, asset: "BTC", intervalSec: 300, expiry: onchain.expiry, symbol: null };
    historicalDiscovery = false;
  }
  if (!row) throw new SettlementLifecycleError("HISTORICAL_DISCOVERY", `${item.marketId} was not found in finalized BTC history`);
  onchain ??= await exchange.client.getMarketOnchain(item.marketId);
  const balances = await readBalances(exchange, onchain, owner);
  const orders = await readVerifiedOrders(exchange, onchain, owner, item.marketId, onchain.decimals);
  const payoutNumerators = await readPayoutNumerators(exchange, onchain);
  return {
    marketId: item.marketId,
    row: { marketId: row.marketId, asset: row.asset ?? "BTC", intervalSec: row.intervalSec ?? row.info?.intervalSec, expiry: row.expiry ?? row.info?.expiry, symbol: row.symbol ?? null },
    onchain,
    balances,
    orders,
    payoutNumerators,
    historicalDiscovery,
  };
}

async function targetedClaimSweep(exchange, owner, cases) {
  const rows = await finalizedRows(exchange);
  const observations = [];
  for (const item of cases) observations.push(await readExactObservation(exchange, owner, item, rows));
  return { rows, observations };
}

function createState({ chainTime, owner, observations, plan, operatorApproval, previous }) {
  const first = observations[0]?.balances;
  const state = {
    schema: "villa-organic-fill-recovery-v1",
    model: ORGANIC_FILL_RECOVERY_VERSION,
    sessionId: `organic-fill-recovery-${Date.now()}`,
    owner,
    cases: ORGANIC_FILL_CASES.map((item) => ({ marketId: item.marketId, kind: item.kind, fillOrderId: item.fillOrderId ?? null, filledQuantityRaw: item.filledQuantityRaw ?? null, expectedWinningOutcome: item.expectedWinningOutcome, residualOutcomeIdx: item.residualOutcomeIdx ?? null })),
    preflight: { chainTime, operatorApproval, initialSttRaw: first?.sttRaw ?? null, initialCollateralRaw: first?.collateralRaw ?? null, totalExpectedPayoutRaw: plan.totalExpectedPayoutRaw, transactionCount: plan.transactionCount },
    residualRegistry: buildResidualRegistry(plan),
    claims: previous?.claims ?? [],
    redemptions: previous?.redemptions ?? [],
    events: previous?.events ?? [],
    journalRevision: Number(previous?.journalRevision ?? 0),
    final: null,
  };
  return state;
}

function outputPlan(plan) {
  return {
    model: plan.model,
    totalExpectedPayoutRaw: plan.totalExpectedPayoutRaw,
    transactionCount: plan.transactionCount,
    entries: plan.entries.map((entry) => ({
      marketId: entry.marketId,
      kind: entry.kind,
      intervalSec: entry.intervalSec,
      expirySec: entry.expirySec,
      fillOrderId: entry.fillOrderId,
      filledQuantityRaw: entry.filledQuantityRaw,
      resolution: entry.resolution,
      winningOutcome: entry.winningOutcome,
      balances: entry.balances,
      outcomeTokenIds: entry.outcomeTokenIds,
      classification: entry.classification,
      action: entry.action,
      claim: entry.claim,
      warnings: entry.warnings,
    })),
  };
}

async function main() {
  if (DRY_RUN === CONFIRM) throw new SettlementLifecycleError("USAGE", "choose exactly one of --dry-run or --confirm");
  const exchange = createSettlementExchange({ dryRun: DRY_RUN });
  try {
    const owner = ownerFromEnv(exchange);
    const previous = await readPreviousState();
    const chainTime = await readChainTime(exchange);
    const operatorApproval = await readOperatorApproval(exchange, { outcomeToken: (await exchange.client.getMarketOnchain(ORGANIC_FILL_CASES[0].marketId)).outcomeToken }, owner);
    if (!operatorApproval && CONFIRM) throw new SettlementLifecycleError("OPERATOR_APPROVAL", "ERC-6909 operator approval is not already present; refusing an unplanned setup write");
    const beforeSweep = await scanFinalizedBtcClaimSweep(exchange, owner, { limit: FINALIZED_LIMIT });
    log("PRE_CLAIM_SWEEP", { scanned: beforeSweep.scanned, entries: beforeSweep.entries, errors: beforeSweep.errors });
    if (beforeSweep.errors.length) throw new SettlementLifecycleError("CLAIM_SWEEP", `pre-claim sweep had ${beforeSweep.errors.length} unreadable row(s)`);
    const { observations } = await targetedClaimSweep(exchange, owner, ORGANIC_FILL_CASES);
    const plan = buildOrganicFillRecoveryPlan({ cases: ORGANIC_FILL_CASES, observations, redeemedMarketIds: priorRedeemedIds(previous) });
    const state = createState({ chainTime, owner, observations, plan, operatorApproval, previous });
    for (const entry of plan.entries) addEvent(state, entry.kind === "ORGANIC_FILL" ? "ORGANIC_FILL_POSITION_TRACKED" : "KNOWN_RESIDUAL_CLASSIFIED", { marketId: entry.marketId, fillOrderId: entry.fillOrderId, filledQuantityRaw: entry.filledQuantityRaw, classification: entry.classification, balance: entry.balances, resolution: entry.resolution, winningOutcome: entry.winningOutcome }, chainTime.chainNowSec);
    for (const entry of plan.claimable) addEvent(state, "CLAIMABLE_POSITION_FOUND", { marketId: entry.marketId, outcome: entry.claim.outcome, amountRaw: entry.claim.amountRaw, expectedPayoutRaw: entry.claim.expectedPayoutRaw }, chainTime.chainNowSec);
    addEvent(state, "REDEEM_PLANNED", { totalExpectedPayoutRaw: plan.totalExpectedPayoutRaw, transactionCount: plan.transactionCount, marketIds: plan.claimable.map((entry) => entry.marketId) }, chainTime.chainNowSec);
    log("RECOVERY_PLAN", outputPlan(plan));
    if (DRY_RUN) {
      log("DRY_RUN", { noWrites: true, currentSttRaw: observations[0]?.balances.sttRaw ?? null, currentCollateralRaw: observations[0]?.balances.collateralRaw ?? null, operatorApproval });
      return;
    }
    await saveState(state);

    const queue = createSerializedWriteQueue((_label, operation) => operation());
    const redeemed = await executeRecoveryRedeems(plan.entries, {
      queue,
      execute: async (entry) => {
        const freshRows = await finalizedRows(exchange);
        const freshObservation = await readExactObservation(exchange, owner, ORGANIC_FILL_CASES.find((item) => item.marketId.toLowerCase() === entry.marketId.toLowerCase()), freshRows);
        const freshPlan = buildOrganicFillRecoveryPlan({ cases: [ORGANIC_FILL_CASES.find((item) => item.marketId.toLowerCase() === entry.marketId.toLowerCase())], observations: [freshObservation], redeemedMarketIds: priorRedeemedIds(state) });
        const freshEntry = freshPlan.entries[0];
        if (freshEntry.action !== "REDEEM" || freshEntry.claim.amountRaw !== entry.claim.amountRaw || freshEntry.winningOutcome !== entry.winningOutcome) throw new SettlementLifecycleError("REDEEM_PREFLIGHT_CHANGED", `${entry.marketId} changed before redeem`);
        addEvent(state, "REDEEM_SUBMITTED", { marketId: freshEntry.marketId, outcome: freshEntry.claim.outcome, outcomeIdx: freshEntry.claim.outcomeIdx, amountRaw: freshEntry.claim.amountRaw }, (await readChainTime(exchange)).chainNowSec);
        await saveState(state);
        const result = await exchange.trader.redeem({ marketId: freshEntry.marketId, market: freshObservation.onchain.marketAddress, outcomeToken: freshObservation.onchain.outcomeToken, outcomeIdx: freshEntry.claim.outcomeIdx, amount: freshEntry.claim.amountRaw, autoApprove: true });
        const transaction = txSummary(result);
        const after = await readBalances(exchange, freshObservation.onchain, owner);
        const actualPayoutRaw = after.collateralRaw - freshObservation.balances.collateralRaw;
        const reconciliation = reconcileOrganicFillPayout({ entry: freshEntry, before: freshObservation.balances, after, actualPayoutRaw, receiptGasWei: BigInt(transaction.gasWei) });
        const record = { marketId: freshEntry.marketId, outcome: freshEntry.claim.outcome, outcomeIdx: freshEntry.claim.outcomeIdx, amountRaw: freshEntry.claim.amountRaw, transaction, before: freshObservation.balances, after, reconciliation, reconciled: true };
        state.redemptions.push(record);
        state.claims = [...(state.claims ?? []).filter((claim) => claim.marketId.toLowerCase() !== record.marketId.toLowerCase()), { marketId: record.marketId, status: "ALREADY_REDEEMED", reconciled: true, transactionHash: transaction.hash, amountRaw: record.amountRaw }];
        state.residualRegistry = state.residualRegistry.map((residual) => residual.marketId.toLowerCase() === record.marketId.toLowerCase() ? { ...residual, classification: "ALREADY_REDEEMED", claimAction: "CLEARED", outcomeBalances: { yesRaw: after.yesRaw, noRaw: after.noRaw } } : residual);
        addEvent(state, "REDEEM_CONFIRMED", { marketId: record.marketId, transaction, outcome: record.outcome, amountRaw: record.amountRaw }, null);
        addEvent(state, "ORGANIC_FILL_PAYOUT_RECONCILED", { marketId: record.marketId, reconciliation }, null);
        addEvent(state, "CLAIMABLE_POSITION_CLEARED", { marketId: record.marketId, winningBalanceRaw: 0n }, null);
        await saveState(state);
        return record;
      },
    });
    const afterSweep = await scanFinalizedBtcClaimSweep(exchange, owner, { limit: FINALIZED_LIMIT });
    const targetIds = new Set(ORGANIC_FILL_CASES.map((item) => item.marketId.toLowerCase()));
    const remainingTargetClaims = afterSweep.entries.filter((entry) => targetIds.has(String(entry.marketId).toLowerCase()) && entry.claimableOutcomes?.length);
    if (remainingTargetClaims.length) throw new SettlementLifecycleError("CLAIM_NOT_CLEARED", "a managed winning residual remains claimable after redeem");
    const finalChainTime = await readChainTime(exchange);
    const finalBalances = await readBalances(exchange, (await exchange.client.getMarketOnchain(ORGANIC_FILL_CASES[0].marketId)), owner);
    state.final = { chainTime: finalChainTime, finalSttRaw: finalBalances.sttRaw, finalCollateralRaw: finalBalances.collateralRaw, afterSweep, activeTargetClaims: remainingTargetClaims, transactionCount: redeemed.length, noNewOrdersOrMints: true };
    addEvent(state, "SETTLEMENT_RECOVERY_CLEAN", { transactionCount: redeemed.length, remainingTargetClaims: 0, afterSweepEntries: afterSweep.entries }, finalChainTime.chainNowSec);
    await saveState(state);
    log("POST_CLAIM_SWEEP", { scanned: afterSweep.scanned, entries: afterSweep.entries, errors: afterSweep.errors });
    log("RESULT", { ok: true, model: ORGANIC_FILL_RECOVERY_VERSION, statePath: JOURNAL_PATH, owner, redemptions: redeemed, final: state.final });
  } finally {
    try { await exchange.destroy?.(); } catch { /* optional SDK close */ }
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(`ORGANIC FILL RECOVERY ${DRY_RUN ? "DRY-RUN " : ""}REFUSED: ${error?.message || error}`);
  process.exitCode = 1;
}
