/**
 * Pure operator-facing projections for the Phase 6B cockpit.
 *
 * This module only reads the stable dashboard contract. It does not fetch data,
 * decide whether to trade, or change any backend state.
 */

export const DASHBOARD_PRESENTATION_VERSION = "villa-dashboard-ui-v1";

const RISK_REASON_COPY = Object.freeze({
  NONE: "All configured safety gates are clear.",
  MODEL_CONFIDENCE_LOW: "Model data quality is below the configured confidence floor.",
  MODEL_DATA_QUALITY_LOW: "The underlying observations are not strong enough to quote.",
  PRICE_STALE: "The underlying price feed is stale.",
  MARKET_NOT_TRADING: "The Event Contract is no longer trading.",
  EXPIRY_TOO_CLOSE: "There is not enough time left for a safe quote.",
  MARKET_EXPIRED: "The Event Contract has expired.",
  EXPOSURE_HARD: "Directional exposure reached its hard limit.",
  DIRECTIONAL_EXPOSURE_HARD: "Directional exposure reached its hard limit.",
  GROSS_EXPOSURE_HARD: "Gross outcome exposure reached its hard limit.",
  INSUFFICIENT_COLLATERAL: "Available collateral cannot support another quote.",
  GAS_LOW: "The native gas balance is below the configured reserve.",
  GAS_UNAVAILABLE: "The native gas balance could not be verified.",
  CAPITAL_ACCOUNTING_PARTIAL: "Capital accounting is partial, so sizing stays bounded.",
  DRAWDOWN_UNACCOUNTED: "Drawdown accounting is not available yet.",
  NO_SELL_INVENTORY: "There is no free YES inventory for an ask.",
  POST_ONLY_CONSTRAINT: "The post-only grid leaves no safe price on this side.",
  MIN_QUANTITY_UNMET: "The calculated size is below the venue minimum.",
  GOVERNOR_HALT: "The Risk Governor has disabled new risk.",
});

const IMPORTANT_EVENT_TYPES = new Set([
  "MARKET_INITIALIZED",
  "MARKET_CONTEXT_STARTED",
  "FAIR_VALUE_UPDATED",
  "ROLLOVER_FAIR_VALUE_CALCULATED",
  "GOVERNOR_STATE_CHANGED",
  "ROLLOVER_GOVERNOR_EVALUATED",
  "QUOTE_PLAN_UPDATED",
  "ROLLOVER_QUOTE_PLANNED",
  "NO_QUOTE",
  "INVENTORY_MINTED",
  "ORDER_RESTING",
  "ORDER_FILLED",
  "ORDER_PARTIALLY_FILLED",
  "ORDER_CANCELLED",
  "INVENTORY_RECONCILED",
  "MARKET_STOPPING",
  "MARKET_CLOSED",
  "CURRENT_MARKET_NO_LONGER_TRADING",
  "SUCCESSOR_READY",
  "SUCCESSOR_WAIT",
  "WAITING_FOR_SUCCESSOR",
  "SETTLEMENT_POSITION_TRACKED",
  "ORGANIC_FILL_POSITION_TRACKED",
  "KNOWN_RESIDUAL_CLASSIFIED",
  "CLAIMABLE_POSITION_FOUND",
  "REDEEM_CONFIRMED",
  "A3CF_REDEEM_CONFIRMED",
  "PAYOUT_RECONCILED",
  "ORGANIC_FILL_PAYOUT_RECONCILED",
  "A3CF_PAYOUT_RECONCILED",
  "WALLET_HYGIENE_CLEAN",
  "SESSION_CLEAN",
  "SESSION_HALTED",
]);

const REASON_GROUPS = Object.freeze({
  market: new Set(["MARKET_NOT_TRADING", "MARKET_STATUS_INVALID", "MARKET_ID_MISMATCH"]),
  feed: new Set(["PRICE_STALE", "MISSING_SPOT", "BAD_SPOT_AGE", "STALE_SOURCE", "MODEL_DATA_QUALITY_LOW"]),
  confidence: new Set(["MODEL_CONFIDENCE_LOW", "FAIR_VALUE_INVALID"]),
  expiry: new Set(["MARKET_EXPIRED", "EXPIRY_INVALID", "EXPIRY_TOO_CLOSE"]),
  exposure: new Set(["EXPOSURE_HARD", "DIRECTIONAL_EXPOSURE_HARD", "GROSS_EXPOSURE_HARD", "DIRECTIONAL_EXPOSURE_WARNING"]),
  collateral: new Set(["INSUFFICIENT_COLLATERAL", "CAPITAL_AT_RISK_HARD", "CAPITAL_ACCOUNTING_PARTIAL"]),
  gas: new Set(["GAS_LOW", "GAS_UNAVAILABLE"]),
});

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function rawNumber(value, decimals = 6) {
  if (value === null || value === undefined) return null;
  try {
    const raw = BigInt(String(value));
    return Number(raw) / 10 ** decimals;
  } catch {
    return null;
  }
}

export function abbreviate(value, head = 6, tail = 4) {
  if (value === null || value === undefined || value === "") return "Unavailable";
  const text = String(value);
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

export function formatProbability(value, digits = 1) {
  const n = finite(value);
  return n === null ? "Unavailable" : `${(clamp(n) * 100).toFixed(digits)}%`;
}

export function formatPrice(value, digits = 2) {
  const n = finite(value);
  return n === null ? "Unavailable" : n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatRaw(value, decimals = 6, digits = 4, unit = "") {
  const n = rawNumber(value, decimals);
  if (n === null || !Number.isFinite(n)) return "Unavailable";
  const text = n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
  return unit ? `${text} ${unit}` : text;
}

export function formatRawPrice(value, decimals = 6) {
  const n = rawNumber(value, decimals);
  return n === null || !Number.isFinite(n) ? "Unavailable" : `${(n * 100).toFixed(2)}%`;
}

export function formatTimeRemaining(value) {
  const n = finite(value);
  if (n === null) return "Unavailable";
  if (n <= 0) return "Expired";
  if (n < 60) return `${Math.ceil(n)}s`;
  const minutes = Math.floor(n / 60);
  const seconds = Math.floor(n % 60);
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatChainTime(value) {
  const n = finite(value);
  if (n === null) return "Recorded";
  return new Date(n * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function marketLabel(market = {}) {
  const asset = market.asset ? String(market.asset).toUpperCase() : "Market";
  const interval = finite(market.intervalSec);
  if (interval === null) return asset;
  if (interval % 3600 === 0) return `${asset} ${interval / 3600}h`;
  if (interval % 60 === 0) return `${asset} ${interval / 60}m`;
  return `${asset} ${interval}s`;
}

export function riskReasonCopy(code) {
  return RISK_REASON_COPY[String(code)] ?? "A configured safety rule needs attention.";
}

export function stateProjection(snapshot = {}) {
  const risk = snapshot.risk ?? {};
  const book = snapshot.bookQuotes?.villa ?? {};
  const lifecycle = String(snapshot.lifecycle?.rolloverState ?? "").toUpperCase();
  if (risk.action === "HALT") return { key: "HALTED", label: "HALTED", tone: "halt" };
  if (risk.action === "REDUCE_ONLY") return { key: "REDUCE_ONLY", label: "REDUCE ONLY", tone: "reduce" };
  if (["WAITING_FOR_SUCCESSOR", "WAITING", "ROLLING"].includes(lifecycle)) return { key: "ROLLING", label: "ROLLING", tone: "rolling" };
  if (book.restingBid !== null || book.restingAsk !== null || book.targetBid !== null || book.targetAsk !== null) return { key: "QUOTING", label: "QUOTING", tone: "allow" };
  if (risk.action === "ALLOW" && snapshot.market?.status && String(snapshot.market.status).toLowerCase() !== "finalized") return { key: "NO_QUOTE", label: "NO QUOTE", tone: "noquote" };
  if (snapshot.system?.state === "STOPPED") return { key: "STOPPED", label: "STOPPED", tone: "stopped" };
  return { key: "WATCHING", label: "WATCHING", tone: "watching" };
}

function latestFillForSide(events, side) {
  const wanted = side === "bid" ? ["BUY_YES", "BUY"] : ["SELL_YES", "SELL"];
  return [...(events ?? [])].reverse().find((event) => {
    if (!["ORDER_FILLED", "ORDER_PARTIALLY_FILLED"].includes(event?.type)) return false;
    const facts = event.facts ?? {};
    return wanted.includes(String(facts.action ?? facts.side ?? "").toUpperCase());
  }) ?? null;
}

export function quoteSide(snapshot = {}, side) {
  const book = snapshot.bookQuotes?.villa ?? {};
  const isBid = side === "bid";
  const restingRaw = isBid ? book.restingBid : book.restingAsk;
  const targetRaw = isBid ? book.targetBid : book.targetAsk;
  const quantityRaw = isBid ? book.bidQuantity : book.askQuantity;
  const fill = latestFillForSide(snapshot.activity?.events, side);
  let state = "NO_QUOTE";
  if (restingRaw !== null && restingRaw !== undefined) state = "RESTING";
  else if (targetRaw !== null && targetRaw !== undefined) state = "TARGET";
  else if (fill) state = "FILLED";
  else if (snapshot.risk?.action === "HALT") state = "DISABLED";
  return {
    side,
    label: isBid ? "VILLA bid" : "VILLA ask",
    action: isBid ? "BUY_YES" : "SELL_YES",
    state,
    enabled: ["RESTING", "TARGET"].includes(state),
    priceRaw: restingRaw ?? targetRaw ?? null,
    quantityRaw: quantityRaw ?? null,
    fill,
  };
}

export function quoteProjection(snapshot = {}) {
  const bid = quoteSide(snapshot, "bid");
  const ask = quoteSide(snapshot, "ask");
  const bestBid = snapshot.bookQuotes?.dreamdex?.bestBid ?? null;
  const bestAsk = snapshot.bookQuotes?.dreamdex?.bestAsk ?? null;
  const midRaw = bestBid !== null && bestAsk !== null ? (BigInt(bestBid) + BigInt(bestAsk)) / 2n : null;
  return {
    bid,
    ask,
    bestBid,
    bestAsk,
    midpoint: midRaw === null ? null : rawNumber(midRaw.toString()),
    oneSided: bid.enabled !== ask.enabled,
    twoSided: bid.enabled && ask.enabled,
  };
}

export function exposureProjection(snapshot = {}) {
  const inventory = snapshot.inventory ?? {};
  const directional = finite(inventory.directionalExposure);
  const yes = rawNumber(inventory.currentMarketYes);
  const no = rawNumber(inventory.currentMarketNo);
  const direction = directional === null || Math.abs(directional) < 1e-12 ? "NEUTRAL" : directional > 0 ? "UP" : "DOWN";
  return {
    yes,
    no,
    completeSets: rawNumber(inventory.completeSets),
    directional,
    direction,
    isNeutral: direction === "NEUTRAL",
    classifications: [...(inventory.classifications ?? [])],
  };
}

function reasons(snapshot) {
  const values = snapshot.risk?.triggeredReasons ?? [];
  return [...new Set(values.map(String).filter((code) => code !== "NONE"))];
}

export function riskChecks(snapshot = {}) {
  const triggered = new Set(reasons(snapshot));
  return Object.entries(REASON_GROUPS).map(([key, group]) => {
    const match = [...triggered].find((code) => group.has(code));
    const state = match ? "BLOCKED" : key === "market" && String(snapshot.market?.status ?? "").toLowerCase() === "finalized" ? "BLOCKED" : "CLEAR";
    return { key, label: key[0].toUpperCase() + key.slice(1), state, reason: match ?? null };
  });
}

export function riskProjection(snapshot = {}) {
  const action = snapshot.risk?.action ?? null;
  const codes = reasons(snapshot);
  const primary = codes[0] ?? null;
  return {
    action,
    label: action === "REDUCE_ONLY" ? "REDUCE ONLY" : action ?? "Unavailable",
    reasonCode: primary,
    reasonText: primary ? riskReasonCopy(primary) : action === "ALLOW" ? "All configured safety gates are clear." : "No decision available.",
    checks: riskChecks(snapshot),
    warnings: codes.filter((code) => code.endsWith("WARNING") || code.endsWith("UNACCOUNTED") || code.endsWith("PARTIAL")),
  };
}

function factText(event) {
  const facts = event?.facts ?? {};
  const pUp = finite(facts.pUp);
  const amount = facts.amountRaw ?? facts.filledQuantityRaw ?? facts.quantityRaw;
  const action = facts.action ?? facts.side;
  switch (event?.type) {
    case "MARKET_INITIALIZED":
    case "MARKET_CONTEXT_STARTED":
    case "MARKET_CONTEXT_INITIALIZED": return "Market initialized";
    case "FAIR_VALUE_UPDATED":
    case "ROLLOVER_FAIR_VALUE_CALCULATED": return pUp === null ? "VILLA fair value updated" : `VILLA fair → ${formatProbability(pUp)} UP`;
    case "GOVERNOR_STATE_CHANGED":
    case "ROLLOVER_GOVERNOR_EVALUATED": return `Risk Governor → ${facts.state ?? "updated"}${facts.reason ? ` · ${facts.reason}` : ""}`;
    case "QUOTE_PLAN_UPDATED":
    case "ROLLOVER_QUOTE_PLANNED": return `Quotes recalculated${facts.plan ? ` · ${facts.plan}` : ""}`;
    case "NO_QUOTE": return `No quote${facts.reason ? ` · ${facts.reason}` : ""}`;
    case "INVENTORY_MINTED": return amount ? `Complete set provisioned · ${formatRaw(amount)}` : "Complete set provisioned";
    case "ORDER_RESTING": return `${action === "SELL_YES" || facts.side === "ask" ? "ASK" : "BID"} resting`;
    case "ORDER_FILLED":
    case "ORDER_PARTIALLY_FILLED": return `Order filled · ${action ?? "order"}${amount ? ` · ${formatRaw(amount)}` : ""}`;
    case "ORDER_CANCELLED": return "Tracked order cancelled";
    case "INVENTORY_RECONCILED": return "Inventory reconciled";
    case "MARKET_STOPPING": return "Market stopping";
    case "MARKET_CLOSED":
    case "CURRENT_MARKET_NO_LONGER_TRADING": return "Market closed";
    case "SUCCESSOR_READY": return "Successor market detected";
    case "SUCCESSOR_WAIT":
    case "WAITING_FOR_SUCCESSOR": return "Waiting for successor";
    case "ORGANIC_FILL_POSITION_TRACKED": return `External fill recorded · ${facts.balance?.noRaw ? "NO residual" : "position tracked"}`;
    case "KNOWN_RESIDUAL_CLASSIFIED": return "Settled zero-value residual retained";
    case "CLAIMABLE_POSITION_FOUND": return `Settlement claim found · ${facts.outcome ?? "outcome"}`;
    case "REDEEM_CONFIRMED":
    case "A3CF_REDEEM_CONFIRMED": return `Redeem confirmed · ${facts.outcome ?? "outcome"}`;
    case "PAYOUT_RECONCILED":
    case "ORGANIC_FILL_PAYOUT_RECONCILED":
    case "A3CF_PAYOUT_RECONCILED": return "Payout reconciled";
    case "WALLET_HYGIENE_CLEAN": return "Wallet hygiene clean";
    case "SESSION_CLEAN": return "Session clean";
    case "SESSION_HALTED": return `Session halted${facts.reason ? ` · ${facts.reason}` : ""}`;
    default: return String(event?.type ?? "Event").replaceAll("_", " ").toLowerCase();
  }
}

export function importantEvents(events = [], limit = 10) {
  const usable = events.filter((event) => IMPORTANT_EVENT_TYPES.has(String(event?.type)));
  const selected = usable.length > limit ? usable.slice(-limit) : usable;
  return selected.map((event) => ({
    ...event,
    label: factText(event),
    timeLabel: formatChainTime(event.atChainSec),
    tone: String(event.type).includes("HALT") || String(event.type).includes("RESIDUAL") ? "halt" : String(event.type).includes("FILL") ? "fill" : "neutral",
  }));
}

export function whyMessages(snapshot = {}) {
  const events = importantEvents(snapshot.activity?.events ?? [], 4);
  const risk = riskProjection(snapshot);
  const messages = [];
  if (snapshot.model?.pUp !== null && snapshot.model?.pUp !== undefined) {
    const above = finite(snapshot.market?.currentUnderlying) !== null && finite(snapshot.market?.reference) !== null && snapshot.market.currentUnderlying >= snapshot.market.reference;
    messages.push({ title: above ? "BTC is above reference" : "BTC is below reference", detail: `VILLA fair is ${formatProbability(snapshot.model.pUp)} UP using the underlying feed and model inputs.`, tone: "accent" });
  }
  if (risk.reasonCode) messages.push({ title: `${risk.action ?? "Risk"} · ${risk.reasonCode}`, detail: risk.reasonText, tone: risk.action === "HALT" ? "halt" : "warning" });
  for (const event of events.slice(-2)) messages.push({ title: event.label, detail: event.timeLabel === "Recorded" ? "Recorded structured evidence" : `Observed at ${event.timeLabel} chain time.`, tone: event.tone });
  return messages.slice(0, 4);
}

export function lifecycleProjection(snapshot = {}) {
  const lifecycle = snapshot.lifecycle ?? {};
  return {
    current: lifecycle.currentMarket ?? snapshot.market?.marketId ?? null,
    previous: lifecycle.previousMarket ?? null,
    next: lifecycle.rolloverState === "WAITING_FOR_SUCCESSOR" || lifecycle.rolloverState === "WAITING" ? "Waiting" : lifecycle.rolloverState === "SUCCESSOR_READY" ? "Ready" : null,
    state: lifecycle.rolloverState ?? null,
    claims: lifecycle.settlementClaims ?? [],
    residuals: lifecycle.historicalResiduals ?? [],
  };
}

export function projectDashboard(snapshot = {}, envelope = {}) {
  const bookMidpoint = quoteProjection(snapshot).midpoint;
  const comparisonMidpoint = finite(envelope.comparisonOnly?.midpoint);
  return {
    mode: envelope.mode ?? "LIVE",
    modeLabel: envelope.mode === "REPLAY" ? "REPLAY" : "LIVE",
    source: envelope.source ?? "dashboard contract",
    scene: envelope.scene ?? null,
    state: stateProjection(snapshot),
    marketLabel: marketLabel(snapshot.market),
    fair: {
      pUp: finite(snapshot.model?.pUp),
      pDown: finite(snapshot.model?.pDown),
      confidence: finite(snapshot.model?.confidence),
      volatility: finite(snapshot.model?.volatility),
      version: snapshot.model?.fairValueModelVersion ?? null,
    },
    midpoint: comparisonMidpoint ?? bookMidpoint,
    quotes: quoteProjection(snapshot),
    exposure: exposureProjection(snapshot),
    risk: riskProjection(snapshot),
    timeline: importantEvents(snapshot.activity?.events ?? []),
    why: whyMessages(snapshot),
    lifecycle: lifecycleProjection(snapshot),
    evidence: envelope.evidence ?? null,
    snapshot,
  };
}
