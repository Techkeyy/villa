/**
 * Pure, backend-owned dashboard data contract.
 *
 * The frontend will consume this shape in Phase 6B. It contains facts already
 * produced by the backend layers and never computes PnL or makes a trading
 * decision. Raw monetary quantities are strings so the contract is JSON-safe.
 */

import { SettlementLifecycleError, assertSecretFree } from "../settlement/index.mjs";

export const DASHBOARD_DATA_CONTRACT_VERSION = "villa-dashboard-v1";
export const PNL_UNAVAILABLE = "PNL_UNAVAILABLE";

const RISK_ACTIONS = new Set(["ALLOW", "REDUCE_ONLY", "HALT"]);

function fail(code, message) {
  throw new SettlementLifecycleError(code, message);
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function optionalRaw(value, label) {
  if (value === null || value === undefined) return null;
  try {
    const result = typeof value === "bigint" ? value : BigInt(String(value));
    if (result < 0n) throw new Error("negative");
    return result.toString();
  } catch {
    fail("DASHBOARD_RAW_INVALID", `${label} must be a non-negative raw integer or null`);
  }
}

function optionalNumber(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) fail("DASHBOARD_NUMBER_INVALID", `${label} must be finite or null`);
  return value;
}

function optionalBoolean(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "boolean") fail("DASHBOARD_BOOLEAN_INVALID", `${label} must be boolean or null`);
  return value;
}

function eventFacts(events) {
  if (!Array.isArray(events)) fail("DASHBOARD_EVENTS_INVALID", "activity.events must be an array");
  return events.map((event) => ({
    type: String(event?.type ?? "UNKNOWN"),
    sequence: event?.sequence === undefined ? null : Number(event.sequence),
    atChainSec: optionalNumber(event?.atChainSec, "activity event chain time"),
    facts: objectOrEmpty(event?.facts ?? event?.details),
  }));
}

/** Map backend facts into the stable Phase 6B dashboard shape. */
export function buildDashboardSnapshot(input = {}) {
  assertSecretFree(input);
  const system = objectOrEmpty(input.system);
  const market = objectOrEmpty(input.market);
  const model = objectOrEmpty(input.model);
  const book = objectOrEmpty(input.bookQuotes ?? input.book);
  const risk = objectOrEmpty(input.risk);
  const inventory = objectOrEmpty(input.inventory);
  const lifecycle = objectOrEmpty(input.lifecycle);
  const accounting = objectOrEmpty(input.accounting);
  if (risk.action !== undefined && !RISK_ACTIONS.has(risk.action)) fail("DASHBOARD_RISK_INVALID", "risk.action must be ALLOW, REDUCE_ONLY, or HALT");

  const result = {
    contractVersion: DASHBOARD_DATA_CONTRACT_VERSION,
    generatedAtChainSec: optionalNumber(input.generatedAtChainSec, "generatedAtChainSec"),
    system: {
      state: system.state ?? (system.running === true ? "RUNNING" : system.running === false ? "STOPPED" : null),
      network: system.network ?? null,
      walletAddress: system.walletAddress ?? null,
      currentSeries: system.currentSeries ?? null,
      orchestratorVersion: system.orchestratorVersion ?? null,
    },
    market: {
      marketId: market.marketId ?? null,
      asset: market.asset ?? null,
      intervalSec: optionalNumber(market.intervalSec, "market.intervalSec"),
      reference: market.reference ?? null,
      currentUnderlying: optionalNumber(market.currentUnderlying, "market.currentUnderlying"),
      expiry: optionalNumber(market.expiry, "market.expiry"),
      timeRemainingSec: optionalNumber(market.timeRemainingSec, "market.timeRemainingSec"),
      status: market.status ?? null,
    },
    model: {
      pUp: optionalNumber(model.pUp, "model.pUp"),
      pDown: optionalNumber(model.pDown, "model.pDown"),
      confidence: optionalNumber(model.confidence, "model.confidence"),
      volatility: optionalNumber(model.volatility ?? model.realizedVolPerSqrtSec, "model.volatility"),
      fairValueModelVersion: model.fairValueModelVersion ?? model.modelVersion ?? null,
    },
    bookQuotes: {
      dreamdex: {
        bestBid: optionalRaw(book.dreamdex?.bestBid ?? book.bestBid, "bookQuotes.dreamdex.bestBid"),
        bestAsk: optionalRaw(book.dreamdex?.bestAsk ?? book.bestAsk, "bookQuotes.dreamdex.bestAsk"),
      },
      villa: {
        targetBid: optionalRaw(book.villa?.targetBid ?? book.targetBid, "bookQuotes.villa.targetBid"),
        targetAsk: optionalRaw(book.villa?.targetAsk ?? book.targetAsk, "bookQuotes.villa.targetAsk"),
        restingBid: optionalRaw(book.villa?.restingBid ?? book.restingBid, "bookQuotes.villa.restingBid"),
        restingAsk: optionalRaw(book.villa?.restingAsk ?? book.restingAsk, "bookQuotes.villa.restingAsk"),
        bidQuantity: optionalRaw(book.villa?.bidQuantity ?? book.bidQuantity, "bookQuotes.villa.bidQuantity"),
        askQuantity: optionalRaw(book.villa?.askQuantity ?? book.askQuantity, "bookQuotes.villa.askQuantity"),
      },
      quotePlanVersion: book.quotePlanVersion ?? null,
    },
    risk: {
      action: risk.action ?? null,
      triggeredReasons: Array.isArray(risk.triggeredReasons) ? [...risk.triggeredReasons] : [],
      exposure: risk.exposure ?? null,
      capacity: risk.capacity ?? risk.riskCapacity ?? null,
      collateral: risk.collateral ?? null,
      gas: risk.gas ?? null,
    },
    inventory: {
      currentMarketYes: optionalRaw(inventory.currentMarketYes ?? inventory.yesRaw, "inventory.currentMarketYes"),
      currentMarketNo: optionalRaw(inventory.currentMarketNo ?? inventory.noRaw, "inventory.currentMarketNo"),
      completeSets: optionalRaw(inventory.completeSets ?? inventory.completeSetsRaw, "inventory.completeSets"),
      directionalExposure: inventory.directionalExposure ?? null,
      classifications: Array.isArray(inventory.classifications) ? [...inventory.classifications] : [],
    },
    activity: { events: eventFacts(input.activity?.events ?? input.events ?? []) },
    lifecycle: {
      currentMarket: lifecycle.currentMarket ?? market.marketId ?? null,
      previousMarket: lifecycle.previousMarket ?? null,
      rolloverState: lifecycle.rolloverState ?? null,
      settlementClaims: lifecycle.settlementClaims ?? [],
      historicalResiduals: lifecycle.historicalResiduals ?? [],
    },
    accounting: {
      tUSDC: optionalRaw(accounting.tUSDC ?? accounting.tusdcRaw ?? accounting.collateralRaw, "accounting.tUSDC"),
      STT: optionalRaw(accounting.STT ?? accounting.sttRaw, "accounting.STT"),
      knownCollateralMovement: accounting.knownCollateralMovement ?? null,
      pnlState: PNL_UNAVAILABLE,
      pnl: null,
    },
  };
  return result;
}
