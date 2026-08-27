/**
 * Bounded, read-only successor-market rollover verifier.
 *
 * It observes one short BTC Event Contract until it leaves Trading, closes
 * only the market-scoped context, discovers a later same-series window from
 * the SDK, and assembles the existing fair-value/governor/quote pipeline for
 * that new context.  No signer or state-changing client is imported.
 */

import { randomUUID } from "node:crypto";
import {
  ROLLOVER_STATES,
  acceptSuccessor,
  closeCurrentMarket,
  createRolloverState,
  evaluateSuccessor,
  initializeSuccessor,
  inventoryForMarket,
  recordSuccessorSearch,
  stateScopeAudit,
  verifySuccessorCandidate,
} from "../src/rollover/index.mjs";
import {
  ROLLOVER_MAX_OBSERVATION_SEC,
  ROLLOVER_POLL_INTERVAL_MS,
  assembleSuccessorPipeline,
  createReadOnlyExchange,
  discoverCurrentShortBtc,
  discoverSuccessor,
  readChainTime,
  readKnownHistoricalResidual,
  readOpenOrders,
  resolveLiveMarketContext,
} from "../src/rollover/live.mjs";

const DEFAULT_MAX_WAIT_SEC = ROLLOVER_MAX_OBSERVATION_SEC;
const DEFAULT_POLL_MS = ROLLOVER_POLL_INTERVAL_MS;
const DEFAULT_DISCOVERY_RETRIES = Math.ceil(DEFAULT_MAX_WAIT_SEC * 2);

function argument(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value === undefined ? fallback : value.slice(prefix.length);
}

function positiveNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be positive`);
  return parsed;
}

const MAX_WAIT_SEC = positiveNumber(argument("max-wait-sec", process.env.ROLLOVER_MAX_WAIT_SEC || DEFAULT_MAX_WAIT_SEC), "max-wait-sec");
const POLL_MS = positiveNumber(argument("poll-ms", process.env.ROLLOVER_POLL_MS || DEFAULT_POLL_MS), "poll-ms");
const MAX_DISCOVERY_RETRIES = Math.max(1, Math.floor(positiveNumber(argument("max-discovery-retries", process.env.ROLLOVER_MAX_DISCOVERY_RETRIES || DEFAULT_DISCOVERY_RETRIES), "max-discovery-retries")));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonSafe(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
}

function print(label, value = undefined) {
  console.log(`${label}${value === undefined ? "" : ` ${typeof value === "string" ? value : jsonSafe(value)}`}`);
}

function marketSummary(context) {
  return {
    marketId: context.marketId,
    symbol: context.symbol,
    series: context.series,
    intervalSec: context.intervalSec,
    expirySec: context.expirySec,
    status: context.status,
    pool: context.pool,
    venueId: context.venueId,
    yesId: context.yesId,
    noId: context.noId,
    reference: context.reference,
  };
}

function fairSummary(fair) {
  return {
    modelVersion: fair?.modelVersion ?? null,
    pUp: fair?.pUp ?? null,
    pDown: fair?.pDown ?? null,
    confidence: fair?.confidence ?? null,
    dataQualityStatus: fair?.dataQualityStatus ?? null,
    currentUnderlyingPrice: fair?.currentUnderlyingPrice ?? null,
    referencePrice: fair?.referencePrice ?? null,
    referenceSource: fair?.referenceSource ?? null,
    distanceFromReference: fair?.distanceFromReference ?? null,
    timeRemainingSec: fair?.timeRemainingSec ?? null,
    realizedVolPerSqrtSec: fair?.realizedVolPerSqrtSec ?? null,
    z: fair?.z ?? null,
    warnings: fair?.warnings ?? [],
  };
}

function governorSummary(decision) {
  return {
    state: decision?.state ?? null,
    primaryReasonCode: decision?.primaryReasonCode ?? null,
    allowedActions: decision?.permissions?.allowedActions ?? [],
    sizeMultiplier: decision?.sizeMultiplier ?? null,
    triggeredRules: decision?.triggeredRules ?? [],
    warnings: decision?.warnings ?? [],
  };
}

function planSummary(plan) {
  return {
    plan: plan?.plan ?? null,
    marketId: plan?.marketId ?? null,
    bid: plan?.bid ? { enabled: plan.bid.enabled, action: plan.bid.action, targetPriceRaw: plan.bid.targetPriceRaw, targetQuantityRaw: plan.bid.targetQuantityRaw, reasonCodes: plan.bid.reasonCodes } : null,
    ask: plan?.ask ? { enabled: plan.ask.enabled, action: plan.ask.action, targetPriceRaw: plan.ask.targetPriceRaw, targetQuantityRaw: plan.ask.targetQuantityRaw, reasonCodes: plan.ask.reasonCodes } : null,
    reasonCodes: plan?.reasonCodes ?? [],
    warnings: plan?.warnings ?? [],
  };
}

async function waitForCurrentToStop(exchange, context, owner, deadlineMs) {
  const startedAtMs = Date.now();
  let polls = 0;
  while (Date.now() <= deadlineMs) {
    const chainTime = await readChainTimeWithRetry(exchange);
    const onchain = await exchange.client.getMarketOnchain(context.marketId);
    polls += 1;
    const trading = Number(onchain.status) === 1 && !onchain.isResolved && !onchain.isVoided;
    if (!trading) {
      const openOrderRead = await readOpenOrders(exchange, onchain, owner, context.marketId, context.decimals);
      if (openOrderRead.status !== "VERIFIED") throw new Error(`A open-order state is ${openOrderRead.status}: ${openOrderRead.warning || "unusable read"}`);
      return {
        chainTime,
        onchain,
        openOrderRead,
        polls,
        durationMs: Date.now() - startedAtMs,
      };
    }
    await sleep(POLL_MS);
  }
  throw new Error(`A remained Trading beyond the ${Math.round((deadlineMs - startedAtMs) / 1000)}s observation bound`);
}

async function discoverCurrent(exchange, deadlineMs) {
  let attempts = 0;
  let last = null;
  while (Date.now() <= deadlineMs) {
    const chainTime = await readChainTimeWithRetry(exchange);
    last = await discoverCurrentShortBtc(exchange, chainTime.chainNowSec);
    attempts += 1;
    if (last.selected) return { ...last, attempts, chainTime };
    await sleep(POLL_MS);
  }
  throw new Error(`no clean short BTC Market A was found before the bound; attempts=${attempts}, last=${jsonSafe(last)}`);
}

async function discoverNext(exchange, state, currentContext, deadlineMs) {
  let attempts = 0;
  let last = null;
  while (Date.now() <= deadlineMs && attempts < MAX_DISCOVERY_RETRIES) {
    const chainTime = await readChainTimeWithRetry(exchange);
    last = await discoverSuccessor(exchange, currentContext, chainTime.chainNowSec);
    attempts += 1;
    state = recordSuccessorSearch(state, {
      attempt: attempts,
      query: last.query,
      rowsReturned: last.rowsReturned,
      durationMs: last.durationMs,
      chainNowSec: chainTime.chainNowSec,
      rejectedCount: last.rejected.length,
    });
    if (last.selection.state === ROLLOVER_STATES.SUCCESSOR_FOUND) {
      state = acceptSuccessor(state, last.selection, {
        attempt: attempts,
        query: last.query,
        durationMs: last.durationMs,
      });
      return { state, result: last, chainTime, attempts };
    }
    if (last.selection.state === ROLLOVER_STATES.HALTED) {
      state = acceptSuccessor(state, last.selection, { attempt: attempts, query: last.query });
      throw new Error(`successor selection halted with ${last.selection.code}`);
    }
    state = acceptSuccessor(state, last.selection, { attempt: attempts, query: last.query });
    if (Date.now() <= deadlineMs) await sleep(POLL_MS);
  }
  throw new Error(`no successor was confirmed before the bound; attempts=${attempts}, last=${jsonSafe(last)}`);
}

async function readChainTimeWithRetry(exchange, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await readChainTime(exchange);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(Math.min(POLL_MS, 1_000));
    }
  }
  throw new Error(`chain-time read failed after ${attempts} attempts: ${lastError?.message || lastError}`);
}

async function main() {
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + MAX_WAIT_SEC * 1000;
  const exchange = createReadOnlyExchange();
  const owner = exchange.walletAddress || process.env.OPERATOR_ADDRESS;
  if (!owner) throw new Error("read-only operator address is unavailable");

  try {
    print("VILLA BOUNDED ROLLOVER VERIFIER");
    print("Mode", "READ_ONLY");
    print("Bound", { maxWaitSec: MAX_WAIT_SEC, pollMs: POLL_MS, maxDiscoveryRetries: MAX_DISCOVERY_RETRIES });

    const selectedA = await discoverCurrent(exchange, deadlineMs);
    const aContext = await resolveLiveMarketContext(exchange, selectedA.selected, selectedA.chainTime);
    const sessionId = `rollover-${randomUUID()}`;
    let state = createRolloverState({
      sessionId,
      currentContext: aContext,
      walletState: { owner },
      strategyState: { name: "villa-bounded-rollover", series: aContext.series.key },
    });
    print("MARKET_CONTEXT_STARTED", { sessionId, market: marketSummary(aContext), discovery: { query: selectedA.query, rowsReturned: selectedA.rowsReturned, durationMs: selectedA.durationMs, attempts: selectedA.attempts } });

    const stopped = await waitForCurrentToStop(exchange, aContext, owner, deadlineMs);
    state = closeCurrentMarket(state, {
      chainNowSec: stopped.chainTime.chainNowSec,
      status: Number(stopped.onchain.status),
      openOrderIds: stopped.openOrderRead.orders.map((order) => order.id),
    });
    print("CURRENT_MARKET_NO_LONGER_TRADING", {
      marketId: aContext.marketId,
      chainNowSec: stopped.chainTime.chainNowSec,
      status: Number(stopped.onchain.status),
      resolved: Boolean(stopped.onchain.isResolved),
      voided: Boolean(stopped.onchain.isVoided),
      openOrders: stopped.openOrderRead,
      stopObservationMs: stopped.durationMs,
      polls: stopped.polls,
    });

    const successorSearch = await discoverNext(exchange, state, aContext, deadlineMs);
    state = successorSearch.state;
    const selectedB = successorSearch.result.selection.selected;
    const bChainTime = await readChainTimeWithRetry(exchange);
    const latestBOnchain = await exchange.client.getMarketOnchain(selectedB.marketId);
    const verifiedB = verifySuccessorCandidate({ current: aContext, candidate: selectedB.market, onchain: latestBOnchain, chainNowSec: bChainTime.chainNowSec });
    if (!verifiedB.verified) throw new Error(`B failed final on-chain verification: ${verifiedB.code}`);
    const bSelection = { ...selectedB, onchain: latestBOnchain, expirySec: Number(latestBOnchain.expiry) };
    const bContext = await resolveLiveMarketContext(exchange, bSelection, bChainTime);
    state = initializeSuccessor(state, bContext);
    print("SUCCESSOR_CONFIRMED", {
      market: marketSummary(bContext),
      discovery: {
        query: successorSearch.result.query,
        rowsReturned: successorSearch.result.rowsReturned,
        durationMs: successorSearch.result.durationMs,
        attempts: successorSearch.attempts,
        candidateCount: successorSearch.result.candidates.length,
        rejectedCount: successorSearch.result.rejected.length,
      },
      firstSuccessorAppearanceChainSec: successorSearch.chainTime.chainNowSec,
      observedOverlapSec: Math.max(0, stopped.chainTime.chainNowSec - successorSearch.chainTime.chainNowSec),
      stopToSuccessorMs: Date.now() - startedAtMs,
    });

    const pipeline = await assembleSuccessorPipeline(exchange, bSelection, bChainTime, owner);
    const effectiveBChainTime = pipeline.chainTime ?? bChainTime;
    if (pipeline.context.marketId.toLowerCase() !== bContext.marketId.toLowerCase()) throw new Error("B pipeline context is not bound to the selected market");
    print("B_PIPELINE_ASSEMBLED", { marketId: pipeline.context.marketId, openOrderStatus: pipeline.openOrderRead.status, plan: pipeline.plan.plan });
    const historicalResidual = await readKnownHistoricalResidual(exchange, owner);
    print("HISTORICAL_RESIDUAL_READ", { marketId: historicalResidual.marketId, labels: historicalResidual.labels, warning: historicalResidual.warning ?? null });
    const crossMarketBalances = {
      [pipeline.inventory.yesId]: pipeline.inventory.yesRaw,
      [pipeline.inventory.noId]: pipeline.inventory.noRaw,
    };
    if (historicalResidual.yesId) crossMarketBalances[historicalResidual.yesId] = historicalResidual.yesRaw;
    if (historicalResidual.noId) crossMarketBalances[historicalResidual.noId] = historicalResidual.noRaw;
    const crossMarketInventory = inventoryForMarket({
      marketId: bContext.marketId,
      yesId: pipeline.inventory.yesId,
      noId: pipeline.inventory.noId,
      balancesByTokenId: crossMarketBalances,
    });
    if (crossMarketInventory.yesRaw !== 0n || crossMarketInventory.noRaw !== 0n) throw new Error("B inventory is not zero after exact market-id filtering");
    const finalOrders = await exchange.client.getOpenOrders(owner, { limit: 1000 });
    if (finalOrders.length !== 0) throw new Error(`active operator orders remain after rollover: ${finalOrders.length}`);
    const evaluation = evaluateSuccessor(state, {
      reference: pipeline.context.reference,
      fairValue: pipeline.snapshot.fairValue,
      riskDecision: pipeline.decision,
      quotePlan: pipeline.plan,
      inventory: pipeline.inventory,
      pendingOrders: pipeline.snapshot.openOrders,
      chainNowSec: effectiveBChainTime.chainNowSec,
      decisionSnapshotId: `${bContext.marketId}:${effectiveBChainTime.blockNumber ?? "unknown"}`,
    });
    state = evaluation;
    const scope = stateScopeAudit(state);
    print("MARKET_CONTEXT_INITIALIZED", { market: marketSummary(bContext), marketScope: scope.market, walletScope: scope.wallet, strategyScope: scope.strategy, settlementHistoryMarketIds: scope.settlementHistoryMarketIds });
    print("ROLLOVER_PIPELINE", {
      reference: pipeline.context.reference,
      fairValue: fairSummary(pipeline.snapshot.fairValue),
      governor: governorSummary(pipeline.decision),
      quotePlan: planSummary(pipeline.plan),
      inventory: pipeline.inventory,
      openOrders: pipeline.openOrderRead,
      book: pipeline.bookSummary,
      bookWarning: pipeline.bookWarning,
      oldResidual: historicalResidual,
      crossMarketInventory,
      finalActiveOrderCount: finalOrders.length,
    });
    print("ROLLOVER_RESULT", {
      state: state.state,
      ready: state.state === ROLLOVER_STATES.SUCCESSOR_READY,
      halted: state.state === ROLLOVER_STATES.HALTED,
      haltReason: state.haltReason,
      events: state.events,
      timing: {
        currentDiscoveryMs: selectedA.durationMs,
        currentStopObservationMs: stopped.durationMs,
        successorDiscoveryMs: successorSearch.result.durationMs,
        observedOverlapSec: Math.max(0, stopped.chainTime.chainNowSec - successorSearch.chainTime.chainNowSec),
        stopToSuccessorMs: Date.now() - startedAtMs,
      },
      activeOrderCount: finalOrders.length,
      transactionCount: 0,
      stateScopeAudit: scope,
    });
    print("Transactions sent", "NO");
    return state;
  } finally {
    await exchange.close().catch(() => undefined);
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(`ROLLOVER REFUSED: ${error?.stack || error?.message || error}`);
  process.exit(1);
}
