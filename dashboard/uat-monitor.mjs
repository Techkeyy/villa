import { formatRawExact } from "./account-client.mjs";

const UNAVAILABLE = "Not available yet — the engine has not produced this observation.";
const ACTIVE_STATES = new Set(["STARTING", "RUNNING", "REDUCE_ONLY", "STOPPING", "PAUSED", "SETTLEMENT_READY", "SETTLING"]);

function node(id) {
  return document.getElementById(id);
}

function value(id, text) {
  const target = node(id);
  if (target) target.textContent = text;
}

function display(valueToFormat, fallback = UNAVAILABLE) {
  return valueToFormat === null || valueToFormat === undefined || valueToFormat === "" ? fallback : String(valueToFormat);
}

function rawText(raw, suffix = " tUSDC") {
  if (raw === null || raw === undefined || raw === "") return UNAVAILABLE;
  try { return formatRawExact(BigInt(raw)) + suffix; } catch { return UNAVAILABLE; }
}

function signedRawText(raw) {
  if (raw === null || raw === undefined || raw === "") return "P&L unavailable — reconciliation has not completed.";
  try {
    const amount = BigInt(raw);
    const sign = amount < 0n ? "-" : amount > 0n ? "+" : "";
    return sign + formatRawExact(amount < 0n ? -amount : amount) + " tUSDC";
  } catch {
    return "P&L unavailable — reconciliation has not completed.";
  }
}

function probability(valueToFormat) {
  if (valueToFormat === null || valueToFormat === undefined || valueToFormat === "") return UNAVAILABLE;
  const number = Number(valueToFormat);
  if (!Number.isFinite(number)) return UNAVAILABLE;
  return (number <= 1 ? number * 100 : number).toFixed(2) + "%";
}

function timeRemaining(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return UNAVAILABLE;
  const valueInSeconds = Math.max(0, Math.floor(Number(seconds)));
  if (valueInSeconds >= 3600) return Math.floor(valueInSeconds / 3600) + "h " + Math.floor((valueInSeconds % 3600) / 60) + "m";
  if (valueInSeconds >= 60) return Math.floor(valueInSeconds / 60) + "m " + (valueInSeconds % 60) + "s";
  return valueInSeconds + "s";
}

function intervalText(seconds) {
  const valueInSeconds = Number(seconds);
  if (!Number.isFinite(valueInSeconds) || valueInSeconds <= 0) return UNAVAILABLE;
  if (valueInSeconds >= 3600) return valueInSeconds / 3600 + "h";
  return valueInSeconds / 60 + "m";
}

function activityItems(snapshot, result) {
  const items = Array.isArray(snapshot?.activity) && snapshot.activity.length
    ? snapshot.activity
    : Array.isArray(result?.activity) ? result.activity : [];
  return items.filter((item) => item && typeof item === "object" && item.message).slice(-60);
}

export function formatActivityLabel(item) {
  if (!item || typeof item !== "object") return UNAVAILABLE;
  return String(item.message);
}

export function formatActivityTime(item) {
  const timestamp = Number(item?.atMs);
  if (!Number.isFinite(timestamp)) return "";
  return new Date(timestamp).toLocaleTimeString([], { hour12: false });
}

export function telemetryView({ state = "STOPPED", session = null, snapshot = null, result = null } = {}) {
  const normalized = String(state || session?.state || "STOPPED").toUpperCase();
  const market = snapshot?.market ?? {};
  const strategy = snapshot?.strategy ?? {};
  const risk = snapshot?.riskGovernor ?? {};
  const inventory = snapshot?.inventoryState ?? {};
  const capital = snapshot?.capitalState ?? {};
  const health = snapshot?.health ?? {};
  const fairValue = strategy.fairValue ?? {};
  const book = strategy.bestBidRaw !== undefined || strategy.bestAskRaw !== undefined
    ? rawText(strategy.bestBidRaw, "") + " / " + rawText(strategy.bestAskRaw, "")
    : UNAVAILABLE;
  const quote = strategy.priceRaw !== undefined || strategy.sizeRaw !== undefined
    ? display(strategy.side, "") + " · " + rawText(strategy.priceRaw, "") + " · " + rawText(strategy.sizeRaw, "")
    : UNAVAILABLE;
  const activity = activityItems(snapshot, result);
  return {
    state: normalized,
    visible: normalized !== "STOPPED" || Boolean(snapshot) || Boolean(result),
    active: ACTIVE_STATES.has(normalized),
    stage: snapshot?.stage?.label ?? session?.stage?.label ?? (normalized === "STARTING" ? "Starting" : ""),
    marketAsset: display(market.asset, "Asset not available yet."),
    marketTitle: display(market.title, "Title not available yet."),
    marketInterval: intervalText(market.intervalSec),
    marketId: display(market.marketId ?? snapshot?.marketId ?? session?.currentMarketId, "Selected at Start"),
    marketTimeRemaining: timeRemaining(market.timeRemainingSec ?? snapshot?.timeRemainingSec),
    marketStatus: display(market.status, "Not available yet"),
    fairValue: fairValue.pUp === undefined && fairValue.pDown === undefined ? UNAVAILABLE : "YES " + probability(fairValue.pUp) + " / NO " + probability(fairValue.pDown),
    confidence: probability(fairValue.confidence),
    book,
    quote,
    quoteSide: display(strategy.side),
    quoteSize: rawText(strategy.sizeRaw),
    quotePostOnly: strategy.postOnly === undefined ? UNAVAILABLE : strategy.postOnly ? "Yes" : "No",
    orders: Array.isArray(snapshot?.openOrders) ? String(snapshot.openOrders.length) : "0",
    orderAction: display(snapshot?.lastAction ?? result?.reason, "No action recorded yet."),
    fills: Array.isArray(snapshot?.fills) ? String(snapshot.fills.length) : display(result?.fills, UNAVAILABLE),
    freeYes: rawText(inventory.freeYesRaw ?? snapshot?.yesRaw),
    escrowedYes: rawText(inventory.escrowedYesRaw, ""),
    freeNo: rawText(inventory.freeNoRaw ?? snapshot?.noRaw),
    escrowedNo: rawText(inventory.escrowedNoRaw, ""),
    governor: display(risk.state ?? snapshot?.risk, "Not available yet"),
    exposure: rawText(risk.currentAggregateExposureRaw, "") + " / " + rawText(risk.maxAggregateExposureRaw, ""),
    mintExposure: rawText(risk.currentMintExposureRaw, "") + " / " + rawText(risk.maxMintExposureRaw, ""),
    freeCapital: rawText(capital.freeRaw ?? snapshot?.collateralRaw),
    deployedCapital: rawText(capital.deployedRaw ?? snapshot?.deployedRaw),
    claimable: rawText(capital.claimableRaw),
    pendingCapital: rawText(capital.pendingRaw),
    pnl: snapshot?.pnl ? signedRawText(snapshot.pnl.raw) : result?.pnl ? signedRawText(result.pnl.raw) : "P&L unavailable — reconciliation has not completed.",
    heartbeat: display(health.heartbeat),
    lease: display(health.lease),
    lastUpdate: health.lastUpdateAt ? new Date(Number(health.lastUpdateAt)).toLocaleTimeString([], { hour12: false }) : snapshot?.lastEngineUpdateAt ? new Date(Number(snapshot.lastEngineUpdateAt)).toLocaleTimeString([], { hour12: false }) : UNAVAILABLE,
    process: display(health.processState, normalized === "STOPPED" ? "STOPPED" : "Not available yet"),
    sessionId: display(snapshot?.advanced?.sessionId ?? session?.sessionId, "Not assigned yet"),
    advancedMarket: display(snapshot?.advanced?.currentMarketId ?? snapshot?.marketId, "Not selected yet"),
    advancedBlock: display(snapshot?.advanced?.chainBlockNumber, "Not available yet"),
    advancedTx: Array.isArray(snapshot?.advanced?.transactionHashes) ? snapshot.advanced.transactionHashes : [],
    activity,
    copy: ACTIVE_STATES.has(normalized)
      ? "Live values are read from the account-bound engine. Stop blocks new risk before scoped cleanup."
      : result
        ? "The session ended with the recorded result. Withdrawals remain an owner-signed account action."
        : "Start uses the verified owner wallet and the private account-bound engine. No operator wallet is needed in the browser.",
  };
}

function metric(label, id, extra = "") {
  const quote = String.fromCharCode(34);
  return "<div class=" + quote + "metric " + extra + quote + "><span>" + label + "</span><strong id=" + quote + id + quote + ">" + UNAVAILABLE + "</strong></div>";
}

export function ensureUatMonitor() {
  if (!node("session-monitor")) {
    const strategy = node("strategy");
    const html = "<section class=\\x27panel session-monitor\\x27 id=\\x27session-monitor\\x27 hidden aria-labelledby=\\x27session-monitor-title\\x27><div class=\\x27panel-topline\\x27><div><p class=\\x27panel-label\\x27>LIVE SESSION</p><h3 id=\\x27session-monitor-title\\x27>Account-bound strategy monitor</h3></div><span class=\\x27status-pill status-preview\\x27 id=\\x27session-monitor-state\\x27>STOPPED</span></div><div class=\\x27monitor-stage\\x27 id=\\x27monitor-stage\\x27></div><div class=\\x27telemetry-section\\x27><p class=\\x27panel-label\\x27>MARKET</p><div class=\\x27metric-grid strategy-monitor-grid\\x27>" + metric("Asset", "monitor-market-asset") + metric("Title", "monitor-market-title") + metric("Interval", "monitor-market-interval") + metric("Market ID", "monitor-market-id") + metric("Time remaining", "monitor-headroom") + metric("State", "monitor-market-state") + "</div></div><div class=\\x27telemetry-section\\x27><p class=\\x27panel-label\\x27>STRATEGY</p><div class=\\x27metric-grid strategy-monitor-grid\\x27>" + metric("Fair value YES / NO", "monitor-fair-value") + metric("Confidence", "monitor-confidence") + metric("Best bid / ask", "monitor-book") + metric("Current quote", "monitor-quote") + metric("Side", "monitor-quote-side") + metric("Size", "monitor-quote-size") + metric("Post-only", "monitor-post-only") + "</div></div><div class=\\x27telemetry-section\\x27><p class=\\x27panel-label\\x27>ORDERS</p><div class=\\x27metric-grid strategy-monitor-grid\\x27>" + metric("Open orders", "monitor-orders") + metric("Last action", "monitor-order-action") + metric("Fills", "monitor-fills") + "</div></div><div class=\\x27telemetry-section\\x27><p class=\\x27panel-label\\x27>INVENTORY</p><div class=\\x27metric-grid strategy-monitor-grid\\x27>" + metric("Free YES", "monitor-free-yes") + metric("Escrowed YES", "monitor-escrowed-yes") + metric("Free NO", "monitor-free-no") + metric("Escrowed NO", "monitor-escrowed-no") + "</div></div><div class=\\x27telemetry-section\\x27><p class=\\x27panel-label\\x27>RISK GOVERNOR</p><div class=\\x27metric-grid strategy-monitor-grid\\x27>" + metric("Governor", "monitor-governor") + metric("Aggregate / max", "monitor-exposure") + metric("Mint / max", "monitor-mint-exposure") + "</div></div><div class=\\x27telemetry-section\\x27><p class=\\x27panel-label\\x27>CAPITAL</p><div class=\\x27metric-grid strategy-monitor-grid\\x27>" + metric("Free", "monitor-free-capital") + metric("Deployed", "deployed-balance") + metric("Claimable", "monitor-claimable") + metric("Pending settlement", "pending-settlement-balance") + "</div></div><div class=\\x27telemetry-section\\x27><p class=\\x27panel-label\\x27>SESSION HEALTH</p><div class=\\x27metric-grid strategy-monitor-grid\\x27>" + metric("Heartbeat", "monitor-heartbeat") + metric("Lease", "monitor-lease") + metric("Last engine update", "monitor-last-update") + metric("Process", "monitor-process") + "</div></div><div class=\\x27telemetry-section\\x27><p class=\\x27panel-label\\x27>ACTIVITY</p><ol id=\\x27monitor-activity\\x27 class=\\x27activity-feed\\x27></ol></div><details class=\\x27advanced\\x27 id=\\x27monitor-advanced\\x27><summary>Advanced session data</summary><div class=\\x27metric-grid strategy-monitor-grid\\x27>" + metric("Session ID", "monitor-session-id") + metric("Market ID", "monitor-advanced-market") + metric("Chain block", "monitor-advanced-block") + metric("Transactions", "monitor-advanced-tx") + "</div></details><p class=\\x27helper\\x27 id=\\x27monitor-copy\\x27></p></section>";
    strategy?.insertAdjacentHTML("beforeend", html);
  }
  const monitorGrid = document.querySelector("#session-monitor .strategy-monitor-grid");
  if (monitorGrid && !node("deployed-balance")) {
    const deployed = [...monitorGrid.querySelectorAll(".metric")].find((item) => item.querySelector("span")?.textContent === "Deployed");
    if (deployed?.querySelector("strong")) deployed.querySelector("strong").id = "deployed-balance";
  }
}

export function renderUatMonitor({ state = "STOPPED", session = null, snapshot = null, result = null } = {}) {
  ensureUatMonitor();
  const view = telemetryView({ state, session, snapshot, result });
  const panel = node("session-monitor");
  panel?.toggleAttribute("hidden", !view.visible);
  const pill = node("session-monitor-state");
  if (pill) {
    pill.className = "status-pill " + (view.active ? "status-safe" : view.state === "ERROR" ? "status-error" : "status-preview");
    pill.textContent = view.state;
  }
  value("monitor-stage", view.stage);
  value("monitor-market-asset", view.marketAsset);
  value("monitor-market-title", view.marketTitle);
  value("monitor-market-interval", view.marketInterval);
  value("monitor-market-id", view.marketId);
  value("monitor-headroom", view.marketTimeRemaining);
  value("monitor-market-state", view.marketStatus);
  value("monitor-fair-value", view.fairValue);
  value("monitor-confidence", view.confidence);
  value("monitor-book", view.book);
  value("monitor-quote", view.quote);
  value("monitor-quote-side", view.quoteSide);
  value("monitor-quote-size", view.quoteSize);
  value("monitor-post-only", view.quotePostOnly);
  value("monitor-orders", view.orders);
  value("monitor-order-action", view.orderAction);
  value("monitor-fills", view.fills);
  value("monitor-free-yes", view.freeYes);
  value("monitor-escrowed-yes", view.escrowedYes);
  value("monitor-free-no", view.freeNo);
  value("monitor-escrowed-no", view.escrowedNo);
  value("monitor-governor", view.governor);
  value("monitor-exposure", view.exposure);
  value("monitor-mint-exposure", view.mintExposure);
  value("monitor-free-capital", view.freeCapital);
  value("deployed-balance", view.deployedCapital);
  value("monitor-claimable", view.claimable);
  value("pending-settlement-balance", view.pendingCapital);
  value("monitor-heartbeat", view.heartbeat);
  value("monitor-lease", view.lease);
  value("monitor-last-update", view.lastUpdate);
  value("monitor-process", view.process);
  value("monitor-session-id", view.sessionId);
  value("monitor-advanced-market", view.advancedMarket);
  value("monitor-advanced-block", view.advancedBlock);
  value("monitor-advanced-tx", view.advancedTx.length ? view.advancedTx.map((item) => item.action + ": " + item.hash).join(" · ") : UNAVAILABLE);
  value("monitor-copy", view.copy);
  const feed = node("monitor-activity");
  if (feed) {
    feed.replaceChildren(...view.activity.map((item) => {
      const entry = document.createElement("li");
      const time = document.createElement("time");
      time.textContent = formatActivityTime(item);
      const message = document.createElement("span");
      message.textContent = formatActivityLabel(item);
      entry.append(time, message);
      return entry;
    }));
  }
}
