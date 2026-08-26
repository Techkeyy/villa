/**
 * Bounded Phase 4B execution verifier.
 *
 * A wet run is one explicit, serialized session:
 *   read -> fair value/risk/plan -> optional one-lot mint -> re-read
 *   -> post-only ASK -> reconcile -> re-plan -> post-only BID -> reconcile
 *   -> cancel only this session's orders -> burn only the temporary paired set.
 *
 * This is not a market-making loop. It never takes liquidity, intentionally
 * crosses, settles, redeems, or sends a compensating trade after a fill.
 * `--dry-run` exercises the same read and decision assembly without a signer.
 */
import {
  ContractRevertError,
  ORDER_TYPE,
  SOMNIA_TESTNET_ADDRESSES,
  SOMNIA_TESTNET_PRICE_FEED,
  SomniaMarkets,
} from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, http, isAddress } from "viem";
import { randomUUID } from "node:crypto";
import { DEFAULT_RISK_CONFIG } from "../src/risk-governor/index.mjs";
import { createReadOnlyExchange, readChainTime } from "../src/risk-governor/live.mjs";
import {
  burnableMintedAmount,
  expectedBalancesAfterMint,
  safeOrderExpiryNs,
  validateMintAmount,
} from "../src/inventory-lifecycle/index.mjs";
import {
  DEFAULT_EXECUTION_POLICY,
  classifyOrderReconciliation,
  createExecutionSession,
  preflightOrder,
  recordExecutionEvent,
  targetFromPlan,
  trackCreatedOrder,
} from "../src/execution/policy.mjs";
import { createSerializedWriteQueue } from "../src/execution/write-queue.mjs";
import {
  assembleLivePipeline,
  discoverCleanBtcMarket,
  readRawAccountState,
  readTargetOpenOrders,
  simulateMintPipeline,
} from "../src/execution/live.mjs";
import { isPostOnlyWouldCross, minValidQuantity } from "./lib/write-path.mjs";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run") || process.env.DRY === "1";
const CONFIRM = args.has("--confirm") || process.env.VILLA_CONFIRM_QUOTE_CYCLE === "1";
const RPC_URL = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const INDEXER_URL = process.env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = process.env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws";
const MIN_INTERVAL_SEC = 300;
const MIN_HEADROOM_SEC = 600;
const MIN_STT_WEI = 10n ** 15n;
const POLL_MS = 400;
const POLL_ATTEMPTS = 25;

class QuoteCycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QuoteCycleError";
    this.code = code;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonSafe(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function hashOf(result) {
  return result?.hash === undefined ? null : String(result.hash);
}

function writeResultSummary(result) {
  return { hash: hashOf(result), orderId: result?.orderId === undefined ? null : String(result.orderId) };
}

function marketSummary(selected) {
  return {
    symbol: selected.market.symbol,
    marketId: selected.market.info.marketId,
    intervalSec: selected.intervalSec,
    pool: selected.onchain.pool,
    status: Number(selected.onchain.status),
    expirySec: Number(selected.expirySec),
    secondsLeft: Math.floor(selected.secondsLeft),
  };
}

function decisionSummary(pipeline) {
  return {
    fairValue: {
      modelVersion: pipeline.snapshot.fairValue.modelVersion,
      pUp: pipeline.snapshot.fairValue.pUp,
      pDown: pipeline.snapshot.fairValue.pDown,
      confidence: pipeline.snapshot.fairValue.confidence,
      dataQualityStatus: pipeline.snapshot.fairValue.dataQualityStatus,
      referenceSource: pipeline.snapshot.fairValue.referenceSource,
      underlying: pipeline.snapshot.fairValue.currentUnderlyingPrice,
      reference: pipeline.snapshot.fairValue.referencePrice,
      timeRemainingSec: pipeline.snapshot.fairValue.timeRemainingSec,
      realizedVolPerSqrtSec: pipeline.snapshot.fairValue.realizedVolPerSqrtSec,
    },
    governor: {
      state: pipeline.decision.state,
      primaryReasonCode: pipeline.decision.primaryReasonCode,
      allowedActions: pipeline.decision.permissions.allowedActions,
      sizeMultiplier: pipeline.decision.sizeMultiplier,
      warnings: pipeline.decision.warnings,
    },
    plan: {
      state: pipeline.plan.plan,
      bid: {
        enabled: pipeline.plan.bid.enabled,
        action: pipeline.plan.bid.action,
        priceRaw: pipeline.plan.bid.targetPriceRaw,
        quantityRaw: pipeline.plan.bid.targetQuantityRaw,
        skipReason: pipeline.plan.bid.skipReason,
      },
      ask: {
        enabled: pipeline.plan.ask.enabled,
        action: pipeline.plan.ask.action,
        priceRaw: pipeline.plan.ask.targetPriceRaw,
        quantityRaw: pipeline.plan.ask.targetQuantityRaw,
        skipReason: pipeline.plan.ask.skipReason,
      },
      midpointComparisonOnly: pipeline.midpoint,
      warnings: pipeline.plan.warnings,
      reasonCodes: pipeline.plan.reasonCodes,
    },
  };
}

function createExchange() {
  if (DRY) return createReadOnlyExchange();
  const privateKey = process.env.OPERATOR_PRIVATE_KEY;
  if (!privateKey) throw new QuoteCycleError("ENVIRONMENT", "OPERATOR_PRIVATE_KEY is unset; preserve the existing .env");
  return new SomniaMarkets({
    indexerUrl: INDEXER_URL,
    chain: somniaShannon,
    wsRpcUrl: WS_RPC_URL,
    addresses: SOMNIA_TESTNET_ADDRESSES,
    priceFeed: SOMNIA_TESTNET_PRICE_FEED,
    privateKey,
  });
}

function verifyOwner(exchange) {
  const owner = process.env.OPERATOR_ADDRESS || exchange.walletAddress;
  if (!owner || !isAddress(owner)) throw new QuoteCycleError("ENVIRONMENT", "OPERATOR_ADDRESS or the derived signer address is required");
  if (!DRY && exchange.walletAddress && exchange.walletAddress.toLowerCase() !== owner.toLowerCase()) {
    throw new QuoteCycleError("ENVIRONMENT", "OPERATOR_ADDRESS does not match the wallet derived from OPERATOR_PRIVATE_KEY");
  }
  return owner;
}

function assert(condition, code, message) {
  if (!condition) throw new QuoteCycleError(code, message);
}

function plannerSideSummary(side) {
  return {
    enabled: side.enabled,
    action: side.action,
    priceRaw: side.targetPriceRaw,
    quantityRaw: side.targetQuantityRaw,
    skipReason: side.skipReason,
  };
}

function preflightInput(pipeline, target, side, owner, capRaw) {
  return {
    nowMs: Date.now(),
    capturedAtMs: pipeline.capturedAtMs,
    chainNowSec: pipeline.chainTime.chainNowSec,
    market: {
      status: Number(pipeline.market.onchain.status),
      expirySec: Number(pipeline.market.onchain.expiry),
    },
    feed: pipeline.snapshot.feed,
    openOrdersStatus: pipeline.snapshot.openOrdersStatus,
    governor: pipeline.decision,
    sidePlan: pipeline.plan[side],
    intent: {
      action: target.action,
      priceRaw: target.plannerPriceRaw,
      quantityRaw: target.quantityRaw,
      owner,
    },
    verificationCapRaw: capRaw,
    grid: pipeline.plannerInput.grid,
    book: pipeline.plannerInput.book,
    availableYesRaw: pipeline.rawState.yesRaw,
    collateralAvailableRaw: pipeline.rawState.collateralRaw,
    collateralReserveRaw: pipeline.plannerInput.capital.collateralReserveRaw,
  };
}

async function readIndexedOrder(exchange, owner, pipeline, orderId) {
  try {
    const rows = await exchange.client.getOpenOrders(owner, { pool: pipeline.market.onchain.pool, limit: 1000 });
    const row = rows.find((candidate) => String(candidate.orderId) === String(orderId));
    if (!row) return null;
    const side = String(row.side).startsWith("BUY_") ? "BUY" : String(row.side).startsWith("SELL_") ? "SELL" : null;
    if (!side) return { side: null, remainingQtyRaw: null };
    return {
      side,
      // The client indexer row is already in raw base/outcome units. The
      // normalized risk read converts this field to human units separately;
      // do not scale raw quantity a second time here.
      remainingQtyRaw: String(row.quantityRemaining),
    };
  } catch {
    return null;
  }
}

async function readHistoryRow(exchange, owner, pipeline, orderId) {
  try {
    const rows = await exchange.client.getOrders(owner, { pool: pipeline.market.onchain.pool, limit: 1000 });
    const row = rows.find((candidate) => String(candidate.orderId) === String(orderId));
    if (!row) return null;
    return {
      status: row.status ?? null,
      filledRaw: String(row.filledQuantity ?? "0"),
      remainingRaw: String(row.quantityRemaining ?? "0"),
    };
  } catch {
    return null;
  }
}

async function reconcileOrder(exchange, owner, pipeline, expected, { cancelRequested = false } = {}) {
  let last = null;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const onchain = await exchange.client.getOrderOnchain(pipeline.market.onchain.pool, BigInt(expected.orderId)).catch(() => null);
    const indexed = await readIndexedOrder(exchange, owner, pipeline, expected.orderId);
    const history = onchain ? null : await readHistoryRow(exchange, owner, pipeline, expected.orderId);
    const fillsRaw = BigInt(history?.filledRaw ?? 0);
    let classification = classifyOrderReconciliation({ expected, onchain, indexed, cancelRequested, fillsRaw });
    if (!onchain && history && classification === "UNKNOWN") {
      const remaining = BigInt(history.remainingRaw);
      if (fillsRaw >= BigInt(expected.quantityRaw)) classification = "FILLED";
      else if (fillsRaw > 0n && remaining < BigInt(expected.quantityRaw)) classification = "PARTIALLY_FILLED";
    }
    last = { classification, onchain, indexed, history, fillsRaw, attempt };
    if (["RESTING", "FILLED", "PARTIALLY_FILLED", "CANCELLED"].includes(classification)) return last;
    await sleep(POLL_MS);
  }
  throw new QuoteCycleError("ORDER_RECONCILIATION_UNKNOWN", `order ${expected.orderId} could not be reconciled after ${POLL_ATTEMPTS} attempts${last ? ` (${last.classification})` : ""}`);
}

async function scanCandidateOrders(exchange, candidates, owner) {
  const result = [];
  for (const candidate of candidates) {
    const ids = await exchange.client.getOwnOpenOrdersOnchain(candidate.onchain.pool, owner);
    if (ids.length) result.push({ marketId: candidate.market.info.marketId, symbol: candidate.market.symbol, ids: ids.map(String) });
  }
  return result;
}

async function verifyMint(exchange, publicClient, pipeline, owner, baseline, amountRaw) {
  const state = await readRawAccountState(exchange, publicClient, pipeline.context, owner);
  const expected = expectedBalancesAfterMint({ baselineYesRaw: baseline.yesRaw, baselineNoRaw: baseline.noRaw, amountRaw });
  assert(state.yesRaw === expected.yesRaw, "MINT_VERIFY", "YES did not increase by the exact mint amount");
  assert(state.noRaw === expected.noRaw, "MINT_VERIFY", "NO did not increase by the exact mint amount");
  assert(baseline.collateralRaw - state.collateralRaw === amountRaw, "MINT_VERIFY", "collateral debit did not equal the exact mint amount");
  return state;
}

async function main() {
  if (!DRY && !CONFIRM) {
    throw new QuoteCycleError("CONFIRM_REQUIRED", "wet quote execution is disabled unless --confirm or VILLA_CONFIRM_QUOTE_CYCLE=1 is supplied");
  }
  if (DRY && CONFIRM) throw new QuoteCycleError("ARGUMENTS", "use either --dry-run or --confirm, not both");

  const exchange = createExchange();
  const owner = verifyOwner(exchange);
  const publicClient = createPublicClient({ chain: somniaShannon, transport: http(RPC_URL) });
  const queue = DRY ? null : createSerializedWriteQueue(async (_label, operation) => operation());
  let session = null;
  let selected = null;
  let discovered = null;
  let initial = null;
  let latest = null;
  let baseline = null;
  let minted = false;
  let filledObserved = false;
  let mintAmountRaw = null;

  const emit = (type, facts = {}) => {
    session = recordExecutionEvent(session, type, facts, Date.now());
    console.log(jsonSafe({ event: type, sessionId: session.sessionId, facts }));
  };

  const safeReadPipeline = async () => {
    latest = await assembleLivePipeline(exchange, { selected, owner, publicClient });
    if (session && latest.context.marketId.toLowerCase() !== session.marketId.toLowerCase()) {
      throw new QuoteCycleError("MARKET_ID_CHANGED", "live re-read changed market identity; refusing to reuse the session");
    }
    emit("FAIR_VALUE_RISK_QUOTE_ASSEMBLED", decisionSummary(latest));
    emit("GOVERNOR_DECISION", { state: latest.decision.state, primaryReasonCode: latest.decision.primaryReasonCode, allowedActions: latest.decision.permissions.allowedActions, warnings: latest.decision.warnings });
    emit("QUOTE_PLANNED", { plan: latest.plan.plan, bid: plannerSideSummary(latest.plan.bid), ask: plannerSideSummary(latest.plan.ask), midpointComparisonOnly: latest.midpoint });
    return latest;
  };

  const cancelSessionOrders = async () => {
    if (DRY || !session?.createdOrders.length) return;
    for (const expected of session.createdOrders) {
      const active = await exchange.client.getOrderOnchain(expected.pool, BigInt(expected.orderId)).catch(() => null);
      if (!active || active.quantityRemaining <= 0n) {
        const evidence = await reconcileOrder(exchange, owner, latest, expected, { cancelRequested: true });
        if (evidence.classification === "FILLED" || evidence.classification === "PARTIALLY_FILLED") filledObserved = true;
        emit("ORDER_RECONCILED", { orderId: expected.orderId, classification: evidence.classification, cancelRequested: false, fillsRaw: evidence.fillsRaw });
        continue;
      }
      emit("ORDER_CANCEL_REQUESTED", { orderId: expected.orderId, action: expected.action });
      const result = await queue.enqueue(`cancel:${expected.orderId}`, () => exchange.trader.cancelOrder({ pool: expected.pool, orderId: BigInt(expected.orderId) }));
      emit("ORDER_CANCEL_SUBMITTED", { orderId: expected.orderId, ...writeResultSummary(result) });
      const evidence = await reconcileOrder(exchange, owner, latest, expected, { cancelRequested: true });
      if (evidence.classification === "FILLED" || evidence.classification === "PARTIALLY_FILLED") filledObserved = true;
      if (evidence.classification !== "CANCELLED") throw new QuoteCycleError("CANCEL_RECONCILIATION", `exact order ${expected.orderId} was not reconciled as cancelled`);
      emit("ORDER_CANCELLED", { orderId: expected.orderId, fillsRaw: evidence.fillsRaw });
    }
  };

  const burnTemporarySet = async () => {
    if (DRY || !minted || !session?.mintedTemporaryRaw) return null;
    const state = await readRawAccountState(exchange, publicClient, latest.context, owner);
    const targetOrders = await readTargetOpenOrders(exchange, latest, owner);
    if (targetOrders.orders.length) throw new QuoteCycleError("CLEANUP_BLOCKED", "refusing burn while target-market open orders remain");
    const burnAmount = burnableMintedAmount({
      baselineYesRaw: baseline.yesRaw,
      baselineNoRaw: baseline.noRaw,
      currentYesRaw: state.yesRaw,
      currentNoRaw: state.noRaw,
      mintedAmountRaw: session.mintedTemporaryRaw,
    });
    const result = await queue.enqueue("burnSet", () => exchange.trader.burnSet({ pool: latest.market.onchain.pool, amount: burnAmount }));
    minted = false;
    emit("INVENTORY_BURNED", { amountRaw: burnAmount, ...writeResultSummary(result), fillObserved: filledObserved, distinction: "complete-set burn; not settlement redemption" });
    return result;
  };

  try {
    const chainTime = await readChainTime(exchange);
    discovered = await discoverCleanBtcMarket(exchange, owner, chainTime.chainNowSec, { minIntervalSec: MIN_INTERVAL_SEC, minHeadroomSec: MIN_HEADROOM_SEC });
    selected = discovered.selected;
    initial = await assembleLivePipeline(exchange, { selected, owner, publicClient });
    latest = initial;
    const verificationCapRaw = minValidQuantity(initial.params);
    mintAmountRaw = verificationCapRaw;
    validateMintAmount({ amountRaw: mintAmountRaw, lotSizeRaw: initial.params.lotSize, minQuantityRaw: initial.params.minQuantity });
    session = createExecutionSession({
      sessionId: `villa-4b-${Date.now()}-${randomUUID().slice(0, 8)}`,
      marketId: selected.market.info.marketId,
      verificationCapRaw,
      maxOrders: DEFAULT_EXECUTION_POLICY.maxOrders,
    });
    emit("SESSION_STARTED", { mode: DRY ? "DRY_RUN" : "WET", adapterVersion: session.version, maxOrders: session.maxOrders, verificationCapRaw });
    emit("MARKET_SELECTED", { ...marketSummary(selected), chainTimeSec: chainTime.chainNowSec, localObservedAtMs: chainTime.observedAtLocalMs, clockOffsetSec: chainTime.clockOffsetSec, candidatesChecked: discovered.candidates.length });
    baseline = initial.rawState;
    const baselineOrders = await readTargetOpenOrders(exchange, initial, owner);
    assert(baselineOrders.orders.length === 0, "ACTIVE_ORDERS_EXIST", "selected market was not clean at the baseline read");
    emit("BASELINE_RECORDED", {
      chainTime: initial.chainTime,
      sttRaw: baseline.sttRaw,
      collateralRaw: baseline.collateralRaw,
      yesRaw: baseline.yesRaw,
      noRaw: baseline.noRaw,
      targetOpenOrders: baselineOrders.orders.length,
      model: decisionSummary(initial).fairValue,
      governor: decisionSummary(initial).governor,
    });
    emit("FAIR_VALUE_RISK_QUOTE_ASSEMBLED", decisionSummary(initial));

    if (initial.decision.state === "HALT" || initial.plan.plan === "NO_QUOTE") {
      emit("SESSION_HALTED", { reason: initial.decision.primaryReasonCode, governor: initial.decision.state, plan: initial.plan.plan });
      return;
    }
    assert(baseline.sttRaw >= MIN_STT_WEI || DRY, "FUNDING", `native balance is below the ${MIN_STT_WEI} wei safety floor`);

    const needsMint = !initial.plan.ask.enabled && initial.plan.ask.skipReason === "NO_SELL_INVENTORY";
    if (needsMint) {
      emit("INVENTORY_REQUIREMENT", { reason: "planner requires YES inventory for the ASK", amountRaw: mintAmountRaw, lotSizeRaw: initial.params.lotSize, minQuantityRaw: initial.params.minQuantity, capIsQuantityOnly: true });
      assert(baseline.collateralRaw >= mintAmountRaw || DRY, "FUNDING", "collateral is below the temporary one-lot mint amount");
      if (DRY) {
        const simulated = simulateMintPipeline(initial, mintAmountRaw);
        const simulatedPipeline = {
          ...initial,
          snapshot: simulated.snapshot,
          decision: simulated.decision,
          plannerInput: simulated.plannerInput,
          plan: simulated.plan,
          rawState: {
            ...initial.rawState,
            collateralRaw: initial.rawState.collateralRaw - mintAmountRaw,
            yesRaw: initial.rawState.yesRaw + mintAmountRaw,
            noRaw: initial.rawState.noRaw + mintAmountRaw,
          },
        };
        emit("DRY_MINT_SIMULATED", { amountRaw: mintAmountRaw, expectedYesRaw: simulatedPipeline.rawState.yesRaw, expectedNoRaw: simulatedPipeline.rawState.noRaw, expectedCollateralRaw: simulatedPipeline.rawState.collateralRaw, ...decisionSummary(simulatedPipeline) });
        latest = simulatedPipeline;
      } else {
        // Mint is a write too: refresh the complete decision immediately
        // before it, and refuse if the baseline facts moved or the ask no
        // longer needs inventory.
        const preMint = await safeReadPipeline();
        assert(preMint.decision.state === "ALLOW" && preMint.plan.plan !== "NO_QUOTE", "MINT_PREFLIGHT", "mint preflight is no longer ALLOW with a usable plan");
        assert(preMint.plan.ask.enabled === false && preMint.plan.ask.skipReason === "NO_SELL_INVENTORY", "MINT_PREFLIGHT", "mint is no longer required by the fresh planner");
        assert(preMint.snapshot.openOrdersStatus === "VERIFIED" && preMint.snapshot.openOrders.length === 0, "MINT_PREFLIGHT", "target open-order state changed before mint");
        assert(preMint.rawState.collateralRaw === baseline.collateralRaw && preMint.rawState.yesRaw === baseline.yesRaw && preMint.rawState.noRaw === baseline.noRaw, "MINT_PREFLIGHT", "account balances changed before mint");
        assert(preMint.rawState.collateralRaw >= mintAmountRaw, "FUNDING", "fresh collateral read is below the temporary one-lot mint amount");
        latest = preMint;
        const result = await queue.enqueue("mintSet", () => exchange.trader.mintSet({ pool: selected.onchain.pool, amount: mintAmountRaw }));
        minted = true;
        session = { ...session, mintedTemporaryRaw: mintAmountRaw };
        emit("INVENTORY_MINTED", { amountRaw: mintAmountRaw, ...writeResultSummary(result) });
        const afterMint = await verifyMint(exchange, publicClient, initial, owner, baseline, mintAmountRaw);
        emit("INVENTORY_RECONCILED", { stage: "after_mint", collateralRaw: afterMint.collateralRaw, yesRaw: afterMint.yesRaw, noRaw: afterMint.noRaw });
        latest = await safeReadPipeline();
      }
    }

    if (latest.decision.state === "HALT" || latest.plan.plan === "NO_QUOTE") {
      emit("SESSION_HALTED", { stage: "after_inventory", reason: latest.decision.primaryReasonCode, governor: latest.decision.state, plan: latest.plan.plan });
      if (!DRY) await cancelSessionOrders();
      if (!DRY) await burnTemporarySet();
      return;
    }

    if (DRY) {
      const intended = [];
      for (const side of ["ask", "bid"]) {
        const target = targetFromPlan(latest.plan, side, session.verificationCapRaw);
        if (!target.enabled) {
          intended.push({ side, status: "SKIP", reason: target.reason });
          continue;
        }
        const gate = preflightOrder(preflightInput(latest, target, side, owner, session.verificationCapRaw), DEFAULT_EXECUTION_POLICY);
        intended.push({ side, status: gate.allowed ? "WOULD_POST" : "REFUSED", action: target.action, priceRaw: target.plannerPriceRaw, quantityRaw: target.quantityRaw, reason: gate.reason ?? null, code: gate.code ?? null });
      }
      emit("DRY_RUN_PLAN", { text: "DRY RUN — ZERO TRANSACTIONS", writes: ["mintSet (if required)", "post-only ASK", "re-read/re-plan", "post-only BID (if permitted)", "cancel exact session orders", "burn temporary complete set"], targets: intended, midpointComparisonOnly: latest.midpoint });
      console.log("DRY RUN — ZERO TRANSACTIONS");
      return;
    }

    const placeOne = async (side) => {
      for (let attempt = 1; attempt <= DEFAULT_EXECUTION_POLICY.maxPostOnlyRetries; attempt += 1) {
        const pipeline = await safeReadPipeline();
        if (pipeline.decision.state === "HALT" || pipeline.plan.plan === "NO_QUOTE") {
          emit("ORDER_SKIPPED", { side, reason: pipeline.decision.primaryReasonCode, governor: pipeline.decision.state, plan: pipeline.plan.plan });
          return null;
        }
        const target = targetFromPlan(pipeline.plan, side, session.verificationCapRaw);
        if (!target.enabled) {
          emit("ORDER_SKIPPED", { side, reason: target.reason, plannerSide: plannerSideSummary(pipeline.plan[side]) });
          return null;
        }
        assert(target.quantityRaw <= target.plannerQuantityRaw, "CAP_BREACH", "verification cap increased or changed planner quantity");
        assert(target.plannerPriceRaw === BigInt(pipeline.plan[side].targetPriceRaw), "PRICE_BREACH", "execution changed the planner price");
        const gate = preflightOrder(preflightInput(pipeline, target, side, owner, session.verificationCapRaw), DEFAULT_EXECUTION_POLICY);
        if (!gate.allowed) {
          emit("ORDER_PREFLIGHT_REFUSED", { side, attempt, code: gate.code, reason: gate.reason });
          if (["POST_ONLY_WOULD_CROSS", "DECISION_STALE"].includes(gate.code) && attempt < DEFAULT_EXECUTION_POLICY.maxPostOnlyRetries) continue;
          return null;
        }
        const expiryNs = safeOrderExpiryNs({ chainNowSec: pipeline.chainTime.chainNowSec, marketExpirySec: Number(pipeline.market.onchain.expiry), lifetimeSec: 300, safetySec: 2 });
        const expected = {
          orderId: null,
          pool: pipeline.market.onchain.pool,
          action: target.action,
          priceRaw: target.plannerPriceRaw,
          quantityRaw: target.quantityRaw,
        };
        emit("ORDER_PREFLIGHT_ALLOWED", { side, attempt, action: target.action, priceRaw: target.plannerPriceRaw, quantityRaw: target.quantityRaw, escrowRaw: gate.escrowRaw, timeRemainingSec: gate.timeRemainingSec, expireTimestampNs: expiryNs });
        let placed;
        try {
          placed = await queue.enqueue(`place:${side}`, () => exchange.trader.placeOrder({
            pool: expected.pool,
            side: expected.action,
            price: target.plannerPriceRaw,
            quantity: target.quantityRaw,
            outcomeToken: pipeline.market.onchain.outcomeToken,
            yesId: pipeline.market.onchain.yesId,
            noId: pipeline.market.onchain.noId,
            orderType: ORDER_TYPE.POST_ONLY,
            expireTimestampNs: expiryNs,
          }));
        } catch (err) {
          const cross = err instanceof ContractRevertError && isPostOnlyWouldCross(err);
          emit("ORDER_WRITE_REFUSED", { side, attempt, code: cross ? "POST_ONLY_WOULD_CROSS" : (err?.errorName || err?.name || "WRITE_FAILED"), retryable: cross && attempt < DEFAULT_EXECUTION_POLICY.maxPostOnlyRetries });
          if (cross && attempt < DEFAULT_EXECUTION_POLICY.maxPostOnlyRetries) continue;
          throw err;
        }
        if (placed?.fills?.length) filledObserved = true;
        if (placed?.orderId === undefined) {
          if (placed?.fills?.length) throw new QuoteCycleError("UNEXPECTED_FILL", "post-only placement returned fills without a resting order id");
          throw new QuoteCycleError("ORDER_ID_MISSING", "successful placement returned no order id");
        }
        expected.orderId = String(placed.orderId);
        session = trackCreatedOrder(session, expected);
        emit("ORDER_SUBMITTED", { side, action: expected.action, orderId: expected.orderId, priceRaw: expected.priceRaw, quantityRaw: expected.quantityRaw, postOnly: true, ...writeResultSummary(placed) });
        const evidence = await reconcileOrder(exchange, owner, pipeline, expected);
        if (evidence.classification === "FILLED" || evidence.classification === "PARTIALLY_FILLED") filledObserved = true;
        emit(evidence.classification === "RESTING" ? "ORDER_RESTING" : "ORDER_RECONCILED", { side, orderId: expected.orderId, classification: evidence.classification, onchain: Boolean(evidence.onchain), indexer: Boolean(evidence.indexed), fillsRaw: evidence.fillsRaw, remainingRaw: evidence.onchain?.quantityRemaining ?? evidence.history?.remainingRaw ?? null });
        if (evidence.classification === "FILLED" || evidence.classification === "PARTIALLY_FILLED") throw new QuoteCycleError("UNEXPECTED_FILL", `${expected.action} unexpectedly filled; no compensating trade will be sent`);
        return { pipeline, expected, evidence };
      }
      return null;
    };

    const first = await placeOne("ask");
    if (filledObserved) throw new QuoteCycleError("UNEXPECTED_FILL", "unexpected fill observed during the first bounded quote");
    if (first) {
      latest = await safeReadPipeline();
      emit("STATE_REVALIDATED_AFTER_FIRST_ORDER", { governor: latest.decision.state, reason: latest.decision.primaryReasonCode, plan: latest.plan.plan, openOrdersStatus: latest.snapshot.openOrdersStatus, openOrders: latest.snapshot.openOrders.length });
    }
    if (!filledObserved && latest.decision.state !== "HALT" && latest.plan.plan !== "NO_QUOTE") {
      await placeOne("bid");
    } else {
      emit("SECOND_ORDER_SKIPPED", { reason: filledObserved ? "FILL_OBSERVED" : latest.decision.primaryReasonCode, governor: latest.decision.state, plan: latest.plan.plan });
    }

    await cancelSessionOrders();
    const finalBeforeBurn = await readRawAccountState(exchange, publicClient, latest.context, owner);
    emit("INVENTORY_RECONCILED", { stage: "before_cleanup_burn", collateralRaw: finalBeforeBurn.collateralRaw, yesRaw: finalBeforeBurn.yesRaw, noRaw: finalBeforeBurn.noRaw, fillObserved: filledObserved });
    if (minted) {
      try {
        await burnTemporarySet();
      } catch (err) {
        if (err?.name === "InventoryLifecycleError" && err.code === "INCOMPLETE_SET") {
          emit("INVENTORY_UNMATCHED_PRESERVED", { code: err.code, reason: err.message, yesRaw: finalBeforeBurn.yesRaw, noRaw: finalBeforeBurn.noRaw });
        } else throw err;
      }
    }
    const finalState = await readRawAccountState(exchange, publicClient, latest.context, owner);
    const finalOrders = await readTargetOpenOrders(exchange, latest, owner);
    const remainingAcrossCandidates = await scanCandidateOrders(exchange, discovered.candidates, owner);
    assert(finalOrders.orders.length === 0, "CLEANUP_VERIFY", "target market still has open orders after exact cleanup");
    assert(remainingAcrossCandidates.length === 0, "CLEANUP_VERIFY", "an active order remains in a current BTC candidate market");
    if (!filledObserved && !minted) {
      assert(finalState.yesRaw === baseline.yesRaw && finalState.noRaw === baseline.noRaw && finalState.collateralRaw === baseline.collateralRaw, "BALANCE_VERIFY", "final balances changed without a controlled mint or observed fill");
    }
    emit("SESSION_CLEAN", { final: { sttRaw: finalState.sttRaw, collateralRaw: finalState.collateralRaw, yesRaw: finalState.yesRaw, noRaw: finalState.noRaw }, targetOpenOrders: finalOrders.orders.length, activeCandidateMarkets: remainingAcrossCandidates.length, fillObserved: filledObserved, transactionCount: session.events.filter((event) => ["INVENTORY_MINTED", "ORDER_SUBMITTED", "ORDER_CANCEL_SUBMITTED", "INVENTORY_BURNED"].includes(event.type)).length });
    console.log("PASS quote cycle: bounded post-only quote session reconciled and cleaned");
  } catch (err) {
    if (!DRY && session) {
      try { await cancelSessionOrders(); } catch (cleanupErr) { console.error(`CLEANUP WARNING: ${cleanupErr?.message || cleanupErr}`); }
      if (filledObserved && latest) {
        try {
          latest = await safeReadPipeline();
          emit("FILL_RISK_REEVALUATED", { governor: latest.decision.state, reason: latest.decision.primaryReasonCode, plan: latest.plan.plan, openOrdersStatus: latest.snapshot.openOrdersStatus });
        } catch (reevalErr) {
          console.error(`FILL REEVALUATION WARNING: ${reevalErr?.message || reevalErr}`);
        }
      }
      if (minted) {
        try { await burnTemporarySet(); } catch (cleanupErr) { console.error(`BURN WARNING: ${cleanupErr?.message || cleanupErr}`); }
      }
    }
    throw err;
  } finally {
    queue?.close();
    await exchange.close?.().catch(() => undefined);
  }
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error(`QUOTE CYCLE ${DRY ? "DRY-RUN " : ""}REFUSED: ${err?.code ? `${err.code}: ` : ""}${err?.message || err}`);
  exitCode = 1;
}
// The SDK may retain a transport handle after close(); this is a bounded
// one-shot verifier, so terminate only after all awaited cleanup completes.
process.exit(exitCode);
