import {
  abbreviate,
  formatProbability,
  formatPrice,
  formatRaw,
  formatRawPrice,
  formatTimeRemaining,
  projectDashboard,
} from "/presenter.mjs";

const content = document.querySelector('[data-state="content"]');
const loading = document.querySelector('[data-state="loading"]');
const errorState = document.querySelector('[data-state="error"]');
const errorTitle = document.querySelector('[data-field="error-title"]');
const errorText = document.querySelector('[data-field="error"]');
const announcer = document.querySelector('[data-field="announcer"]');
const params = new URLSearchParams(window.location.search);
let mode = params.get("mode") === "operator" ? "operator" : params.get("mode") === "replay" ? "replay" : "landing";
let scene = params.get("scene") || "quote";
let engineApiUrl = null;
let authSession = null;
let operatorState = null;
let operatorConfig = {
  version: "villa-operator-config-v1",
  series: "BTC 5m",
  capitalAllocationHuman: 0.001,
  maxDirectionalExposureHuman: 0.001,
  maxRestingOrders: 2,
  maxMarkets: 3,
  maxSessionDurationSec: 720,
};
let pollTimer = null;

function all(selector) {
  return [...document.querySelectorAll(selector)];
}

function field(name) {
  return document.querySelector(`[data-field="${name}"]`);
}

function setField(name, value) {
  const element = field(name);
  if (element) element.textContent = value ?? "Unavailable";
}

function setHtml(name, value) {
  const element = field(name);
  if (element) element.innerHTML = value;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statusClass(value) {
  return String(value ?? "").toLowerCase().replaceAll(" ", "_");
}

function setStatus(name, text, tone = "") {
  const element = field(name);
  if (!element) return;
  element.textContent = text;
  element.className = `form-status ${tone}`.trim();
}

function humanAmount(value, digits = 4) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toFixed(digits)} tUSDC` : "Unavailable";
}

function stateCopy(state, live = false) {
  if (!live) return "A verified session you can inspect without sending commands.";
  return {
    STOPPED: "VILLA is stopped. Review the next bounded session before starting.",
    STARTING: "VILLA is starting and checking the configured BTC 5m market.",
    WATCHING: "VILLA is watching market data within the configured session.",
    QUOTING: "VILLA is quoting within the configured safety bounds.",
    NO_QUOTE: "No safe quote is available under the current market conditions.",
    REDUCE_ONLY: "VILLA is reducing directional risk and will not add new risk.",
    HALTED: "The Risk Governor has halted new quoting. Review the reason below.",
    PAUSED: "New quotes are paused. Session-owned orders have been cancelled.",
    ROLLING_OVER: "The current market is closed and VILLA is finding its successor.",
    SETTLING: "VILLA is tracking settlement and capital recovery.",
    STOPPING: "VILLA is stopping new quotes and completing safe cleanup.",
    ERROR: "The private engine needs attention. No new quote is allowed.",
  }[state] ?? "The private engine state is being read.";
}

function operatorEnvelope(state) {
  if (state?.readOnly) return state.readOnly;
  const live = state?.snapshot ?? {};
  const modelUp = finite(live.pUp);
  const inventory = live.inventory ?? {};
  return {
    mode: "LIVE",
    source: "Private engine state",
    evidence: null,
    snapshot: {
      system: { state: state?.state ?? "STOPPED", network: "Somnia Shannon", walletAddress: null, currentSeries: "BINARY:BTC:300", orchestratorVersion: "villa-loop-v1" },
      market: { marketId: live.marketId, asset: "BTC", intervalSec: 300, timeRemainingSec: live.timeRemainingSec, status: "Trading", reference: null, currentUnderlying: null },
      model: { pUp: modelUp, pDown: modelUp === null ? null : 1 - modelUp, confidence: finite(live.confidence), volatility: null, fairValueModelVersion: "villa-fv-v1" },
      bookQuotes: { dreamdex: { bestBid: null, bestAsk: null }, villa: { targetBid: null, targetAsk: null, restingBid: null, restingAsk: null, bidQuantity: null, askQuantity: null }, quotePlanVersion: "villa-quote-v1" },
      risk: { action: live.governor ?? null, triggeredReasons: live.governor === "HALT" ? ["GOVERNOR_HALT"] : [] },
      inventory: { currentMarketYes: inventory.yesRaw ?? null, currentMarketNo: inventory.noRaw ?? null, completeSets: null, directionalExposure: null, classifications: ["CURRENT_MARKET_ONLY"] },
      activity: { events: [] },
      lifecycle: { currentMarket: live.marketId ?? null, rolloverState: live.lifecycle ?? null, settlementClaims: [], historicalResiduals: [] },
      accounting: {},
    },
  };
}

function setModeChrome() {
  const landing = mode === "landing";
  const live = mode === "operator";
  const landingPage = document.querySelector('[data-page="landing"]');
  const cockpitPage = document.querySelector('[data-page="cockpit"]');
  if (landingPage) landingPage.hidden = !landing;
  if (cockpitPage) cockpitPage.hidden = landing;
  for (const element of all("[data-landing-only]")) element.hidden = !landing;
  for (const element of all("[data-cockpit-only]")) element.hidden = landing;
  setField("access-mode", live ? "OPERATOR" : "PUBLIC DEMO");
  for (const element of all("[data-public]")) element.hidden = live;
  const gate = document.querySelector(".operator-gate");
  if (gate) gate.hidden = !live;
  const review = document.querySelector(".operator-review");
  if (review) review.hidden = !(live && authSession);
  const controls = document.querySelector(".operator-controls");
  if (controls) controls.hidden = !(live && authSession);
}

function updateConnection(status, detail, tone = "") {
  setField("connection-status", status);
  setField("connection-detail", detail);
  const dot = field("connection-dot");
  if (dot) dot.style.background = tone === "error" ? "var(--danger)" : tone === "success" ? "var(--up)" : "var(--accent)";
}

function renderRisk(view) {
  const risk = view.risk ?? {};
  const action = risk.action ?? "UNAVAILABLE";
  const label = risk.label ?? action;
  const badge = field("risk-badge");
  if (badge) {
    badge.textContent = label;
    badge.className = `governor-badge ${action === "HALT" ? "halt" : action === "REDUCE_ONLY" ? "reduce" : action === "ALLOW" ? "allow" : "noquote"}`;
  }
  setField("risk-action", label);
  setField("risk-summary", risk.reasonText ?? "No decision available.");
  setField("risk-reason-text", risk.reasonText ?? "No decision available.");
  setHtml("risk-checks", (risk.checks ?? []).map((check) => `<div class="risk-check ${check.state.toLowerCase()}"><span>${escapeHtml(check.label)}</span><em>${escapeHtml(check.state)}</em></div>`).join(""));
}

function renderQuotes(view) {
  const quote = view.quotes ?? {};
  for (const side of [quote.bid, quote.ask]) {
    if (!side) continue;
    const key = side.side;
    setField(`${key}-price`, side.priceRaw === null ? "Unavailable" : formatRawPrice(side.priceRaw));
    setField(`${key}-qty`, side.quantityRaw === null ? "Unavailable" : formatRaw(side.quantityRaw, 6, 4));
    const status = field(`${key}-state`);
    if (status) {
      status.textContent = String(side.state ?? "NO_QUOTE").replaceAll("_", " ");
      status.className = `quote-state ${statusClass(side.state)}`;
    }
  }
  setField("quote-summary", quote.twoSided ? "Two-sided liquidity is resting" : quote.oneSided ? "One-sided liquidity is intentional" : view.state?.key === "HALTED" ? "Quoting disabled by Risk Governor" : "No active quote");
  const dot = field("quote-dot");
  if (dot) dot.style.background = quote.twoSided ? "var(--up)" : quote.oneSided ? "var(--warning)" : view.state?.key === "HALTED" ? "var(--danger)" : "var(--down)";
}

function renderTimeline(view, liveActivity = []) {
  const events = liveActivity.length ? liveActivity.slice(0, 8).map((item) => ({
    timeLabel: item.at ? new Date(item.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "Now",
    label: String(item.type ?? "Engine event").replaceAll("_", " ").toLowerCase(),
    tone: String(item.type ?? "").includes("HALT") || String(item.type ?? "").includes("ERROR") ? "halt" : String(item.type ?? "").includes("FILL") ? "fill" : "neutral",
  })) : view.timeline ?? [];
  if (!events.length) {
    setHtml("timeline", '<p class="empty-copy">Waiting for the first engine event.</p>');
    return;
  }
  setHtml("timeline", events.map((event) => `<div class="timeline-item ${escapeHtml(event.tone)}"><time>${escapeHtml(event.timeLabel)}</time><span class="timeline-dot" aria-hidden="true"></span><strong>${escapeHtml(event.label)}</strong></div>`).join(""));
}

function renderSettlement(view) {
  const claims = view.lifecycle?.claims ?? [];
  const residuals = view.lifecycle?.residuals ?? [];
  const rows = [];
  for (const claim of claims) rows.push(`<div class="settlement-row"><div class="settlement-main"><strong>${escapeHtml(abbreviate(claim.marketId))} · ${escapeHtml(claim.outcome ?? "claim")}</strong><span>${escapeHtml(claim.status ?? "RECORDED")}</span></div><small>${escapeHtml(formatRaw(claim.amountRaw, 6, 4))} received, payout ${escapeHtml(formatRaw(claim.payoutRaw, 6, 4))}</small></div>`);
  for (const residual of residuals) rows.push(`<div class="settlement-row residual"><div class="settlement-main"><strong>${escapeHtml(abbreviate(residual.marketId))} · ${escapeHtml(residual.outcome ?? "residual")}</strong><span>ZERO VALUE</span></div><small>Settled, excluded from active inventory</small></div>`);
  setHtml("settlement", rows.length ? rows.join("") : '<p class="empty-copy">No claimable positions are recorded.</p>');
  setField("settlement-summary", rows.length ? `${rows.length} settlement record${rows.length === 1 ? "" : "s"} recorded.` : "No claimable positions recorded.");
}

function renderEvidence(envelope) {
  const panel = field("evidence-panel");
  const evidence = envelope?.evidence;
  if (!panel || !evidence) {
    if (panel) panel.hidden = true;
    return;
  }
  panel.hidden = false;
  setField("evidence-title", evidence.title);
  setField("evidence-note", evidence.note);
  const facts = (evidence.facts ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const fills = (evidence.fills ?? []).map((fill) => `<div class="evidence-fill"><strong>${escapeHtml(abbreviate(fill.marketId))}</strong><br>${escapeHtml(fill.action)} · ${escapeHtml(formatRaw(fill.quantityRaw, 6, 4))} · ${escapeHtml(fill.result)}</div>`).join("");
  const txs = (evidence.transactions ?? []).map((hash) => `<div class="hash-line"><code>${escapeHtml(abbreviate(hash, 10, 8))}</code><button class="copy-button" data-copy="${escapeHtml(hash)}" type="button">Copy</button></div>`).join("");
  setHtml("evidence-facts", `<div class="evidence-block"><h3>What was recorded</h3><ul>${facts || "<li>No extra facts</li>"}</ul></div>`);
  setHtml("evidence-fills", evidence.fills?.length ? `<div class="evidence-block"><h3>External fills</h3>${fills}</div>` : "");
  setHtml("evidence-txs", evidence.transactions?.length ? `<div class="evidence-block"><h3>Transactions to inspect</h3>${txs}</div>` : "");
}

function renderDashboard(view, envelope) {
  const snapshot = view.snapshot ?? {};
  const market = snapshot.market ?? {};
  const live = view.mode === "LIVE";
  const operatorLabel = live ? operatorState?.state ?? "WATCHING" : "REPLAY";
  const projectedState = live ? operatorLabel : "REPLAY";
  setField("mode-kicker", live ? "OPERATOR / PRIVATE ENGINE" : "DEMO / VERIFIED REPLAY");
  setField("engine-state", projectedState);
  const engineBadge = field("engine-state");
  if (engineBadge) engineBadge.className = `state-badge ${statusClass(projectedState)}`;
  setField("series", view.marketLabel || "BTC 5m");
  setField("market-label", view.marketLabel || "BTC 5m");
  setField("state-headline", projectedState);
  setField("state-copy", stateCopy(operatorLabel, live));
  setField("state", projectedState);
  setField("state-explanation", stateCopy(operatorLabel, live));
  setField("market-id", abbreviate(market.marketId));
  setField("market-name", `${view.marketLabel || "BTC 5m"} Event Contract`);
  setField("time-left", formatTimeRemaining(market.timeRemainingSec));
  setField("market-status", market.status ?? "Unavailable");
  setField("underlying", finite(market.currentUnderlying) === null ? "Unavailable" : `$${formatPrice(market.currentUnderlying)}`);
  setField("reference", finite(market.reference) === null ? "Reference unavailable" : `Reference $${formatPrice(market.reference)}`);
  const fair = view.fair ?? {};
  setField("villa-fair", formatProbability(fair.pUp));
  setField("p-up", formatProbability(fair.pUp));
  setField("p-down", formatProbability(fair.pDown));
  setField("dex-mid", view.midpoint === null || view.midpoint === undefined ? "Unavailable" : formatProbability(view.midpoint));
  const difference = fair.pUp !== null && fair.pUp !== undefined && view.midpoint !== null && view.midpoint !== undefined ? (fair.pUp - view.midpoint) * 100 : null;
  setField("difference", difference === null ? "Unavailable" : `${difference >= 0 ? "+" : ""}${difference.toFixed(1)} pp`);
  const probabilityFill = field("probability-fill");
  if (probabilityFill) probabilityFill.style.width = `${fair.pUp === null || fair.pUp === undefined ? 50 : Math.min(100, Math.max(0, fair.pUp * 100))}%`;
  setField("model-version", fair.version ?? "villa-fv-v1");
  setField("confidence", fair.confidence === null || fair.confidence === undefined ? "Unavailable" : `${(fair.confidence * 100).toFixed(1)}%`);
  setField("volatility", fair.volatility === null || fair.volatility === undefined ? "Unavailable" : `${fair.volatility.toExponential(3)} /sqrt(s)`);
  const distance = finite(market.currentUnderlying) !== null && finite(market.reference) !== null ? (market.currentUnderlying / market.reference - 1) * 100 : null;
  setField("distance", distance === null ? "Unavailable" : `${distance >= 0 ? "+" : ""}${distance.toFixed(2)}%`);
  renderRisk(view);
  renderQuotes(view);
  setField("yes-inventory", view.exposure?.yes === null || view.exposure?.yes === undefined ? "Unavailable" : view.exposure.yes.toFixed(4));
  setField("no-inventory", view.exposure?.no === null || view.exposure?.no === undefined ? "Unavailable" : view.exposure.no.toFixed(4));
  setField("complete-sets", view.exposure?.completeSets === null || view.exposure?.completeSets === undefined ? "Unavailable" : view.exposure.completeSets.toFixed(4));
  setField("exposure-direction", view.exposure?.direction ?? "NEUTRAL");
  setField("exposure-value", view.exposure?.directional === null || view.exposure?.directional === undefined ? "Unavailable" : view.exposure.directional.toFixed(6));
  const marker = field("exposure-marker");
  if (marker) marker.style.left = `${view.exposure?.directional === null || view.exposure?.directional === undefined ? 50 : Math.min(90, Math.max(10, 50 + Math.tanh(view.exposure.directional * 1000) * 40))}%`;
  setField("inventory-class", view.exposure?.classifications?.length ? "Current market only" : "No current inventory");
  setField("lifecycle-label", view.lifecycle?.state ? String(view.lifecycle.state).replaceAll("_", " ") : "Unavailable");
  setField("previous-market", abbreviate(view.lifecycle?.previous));
  setField("previous-state", view.lifecycle?.previous ? "Settled or closed" : "No previous market recorded");
  setField("current-market", abbreviate(view.lifecycle?.current));
  setField("current-state", view.lifecycle?.state ? String(view.lifecycle.state).replaceAll("_", " ") : "Unavailable");
  setField("next-market", view.lifecycle?.next ?? "Waiting");
  setField("tusdc", formatRaw(snapshot.accounting?.tUSDC, 6, 6, "tUSDC"));
  setField("stt", formatRaw(snapshot.accounting?.STT, 18, 6, "STT"));
  setField("pnl-state", snapshot.accounting?.pnlState ?? "PNL_UNAVAILABLE");
  setField("source", live ? "Private engine read, no signer data" : view.source);
  const liveActivity = live ? operatorState?.activity ?? [] : [];
  renderTimeline(view, liveActivity);
  renderSettlement(view);
  renderEvidence(envelope);
  const activeOrders = live ? Number(operatorState?.snapshot?.restingOrders ?? 0) : (view.quotes?.bid?.enabled ? 2 : 0);
  setField("active-orders", live ? String(activeOrders) : activeOrders ? "2 recorded" : "Recorded");
  setField("directional-exposure", view.exposure?.directional === null || view.exposure?.directional === undefined ? "Unavailable" : view.exposure.directional.toFixed(6));
  setField("capital-allowed", live ? humanAmount(operatorConfig.capitalAllocationHuman) : "Recorded evidence");
  setField("capital-deployed", live ? "Not tracked yet" : "Recorded");
  renderScenes(view);
}

function renderScenes(view) {
  const container = field("scenes");
  if (!container) return;
  if (view.mode !== "REPLAY") {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  for (const button of all("[data-scene]")) {
    const active = button.dataset.scene === view.scene;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function fillOperatorConfig(config) {
  operatorConfig = { ...operatorConfig, ...(config ?? {}) };
  const values = {
    "capital-allocation": operatorConfig.capitalAllocationHuman,
    "directional-limit": operatorConfig.maxDirectionalExposureHuman,
    "resting-orders": operatorConfig.maxRestingOrders,
    "market-windows": operatorConfig.maxMarkets,
    "runtime-limit": Math.round(operatorConfig.maxSessionDurationSec / 60),
  };
  for (const [id, value] of Object.entries(values)) {
    const input = document.getElementById(id);
    if (input) input.value = String(value);
  }
  setField("review-allocated", humanAmount(operatorConfig.capitalAllocationHuman));
  setField("review-exposure", operatorConfig.maxDirectionalExposureHuman.toFixed(6));
  setField("review-orders", String(operatorConfig.maxRestingOrders));
  setField("review-runtime", `${Math.round(operatorConfig.maxSessionDurationSec / 60)} minutes`);
}

function readOperatorConfig() {
  const value = (id) => Number(document.getElementById(id)?.value);
  return {
    version: "villa-operator-config-v1",
    series: "BTC 5m",
    capitalAllocationHuman: value("capital-allocation"),
    maxDirectionalExposureHuman: value("directional-limit"),
    maxRestingOrders: value("resting-orders"),
    maxMarkets: value("market-windows"),
    maxSessionDurationSec: value("runtime-limit") * 60,
  };
}

function renderReview(view, executionEnabled = null) {
  const snapshot = view?.snapshot ?? {};
  const halted = view?.risk?.action === "HALT";
  setField("review-available", formatRaw(snapshot.accounting?.tUSDC, 6, 4, "tUSDC"));
  setField("review-fair", formatProbability(view?.fair?.pUp));
  setField("review-midpoint", view?.midpoint === null || view?.midpoint === undefined ? "Unavailable" : formatProbability(view.midpoint));
  setField("review-risk", view?.risk?.label ?? "Unavailable");
  const risk = field("review-risk");
  if (risk) risk.className = view?.risk?.action === "HALT" ? "risk-halt" : view?.risk?.action === "ALLOW" ? "risk-allow" : "";
  const note = field("review-note");
  if (note) {
    note.textContent = executionEnabled === false ? "Execution disabled" : "Safe defaults loaded";
    note.className = `review-note${executionEnabled === false ? " execution-disabled" : ""}`;
  }
  if (executionEnabled === false) {
    setStatus("control-feedback", "Execution is disabled. START will be refused safely. No writer or order can start.", "error");
  } else if (halted) {
    setStatus("control-feedback", `Risk Governor HALT: ${view.risk.reasonText} Resolve the live safety condition before starting.`, "error");
  } else {
    setStatus("control-feedback", "", "");
  }
}

function controlsForState(state) {
  const controls = state?.controls ?? {};
  const preflightRisk = operatorState?.readOnly?.snapshot?.risk?.action;
  const startBlocked = preflightRisk === "HALT";
  for (const button of all('[data-action="start"]')) { button.hidden = !controls.canStart; button.disabled = !controls.canStart || startBlocked; }
  for (const button of all('[data-action="pause"]')) { button.hidden = !controls.canPause; button.disabled = !controls.canPause; }
  for (const button of all('[data-action="resume"]')) { button.hidden = !controls.canResume; button.disabled = !controls.canResume; }
  for (const button of all('[data-action="stop"]')) { button.hidden = !controls.canStop; button.disabled = !controls.canStop; }
  for (const button of all('[data-action="emergency-cancel"]')) { button.hidden = !controls.canEmergencyCancel; button.disabled = !controls.canEmergencyCancel; }
  const copy = startBlocked
    ? "Risk Governor HALT prevents a new session. Resolve the live safety condition before starting."
    : state?.executionEnabled === false
      ? "Execution is disabled. START will be refused safely; no writer or order can be created."
    : stateCopy(state?.state ?? "STOPPED", true);
  setField("controls-copy", copy);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  let body = {};
  try { body = await response.json(); } catch { /* response is reported below */ }
  if (!response.ok) throw new Error(body.error ?? `Request failed with status ${response.status}.`);
  return body;
}

async function fetchPublicSnapshot() {
  return fetchJson(`/api/snapshot?mode=replay&scene=${encodeURIComponent(scene)}`);
}

async function fetchOperator(path, options = {}) {
  if (!engineApiUrl) throw new Error("Operator service is not connected. Set VILLA_ENGINE_API_URL on the Vercel project.");
  const headers = new Headers(options.headers ?? {});
  headers.set("Content-Type", "application/json");
  if (authSession?.token) headers.set("Authorization", `Bearer ${authSession.token}`);
  return fetchJson(`${engineApiUrl.replace(/\/$/, "")}${path}`, { ...options, headers });
}

async function loadEngineConfig() {
  const config = await fetchJson("/api/operator-config");
  engineApiUrl = config.engineApiUrl;
}

function showReadError(title, message) {
  loading.hidden = true;
  content.hidden = true;
  errorState.hidden = false;
  errorTitle.textContent = title;
  errorText.textContent = message;
}

async function loadPublicMode() {
  const envelope = await fetchPublicSnapshot();
  const view = projectDashboard(envelope.snapshot, envelope);
  operatorState = null;
  renderDashboard(view, envelope);
  updateConnection("Demo mode ready", "Inspect verified activity before connecting a wallet.");
  setField("next-action", "Review verified session");
  setField("announcer", `Verified replay ${scene} ready.`);
}

async function loadLandingMode() {
  operatorState = null;
  setField("announcer", "VILLA product overview ready.");
}

async function loadOperatorPreview() {
  const envelope = await fetchPublicSnapshot();
  const view = projectDashboard(envelope.snapshot, envelope);
  renderDashboard(view, envelope);
  setField("engine-state", "CONNECT");
  const badge = field("engine-state");
  if (badge) badge.className = "state-badge starting";
  setField("state-headline", "CONNECT WALLET");
  setField("state-copy", "Connect the authorized wallet to inspect and control the private engine.");
  setField("state", "CONNECT");
  setField("state-explanation", "Operator access is not authenticated.");
  updateConnection("Operator access required", engineApiUrl ? "Sign a message to enter the control room." : "The private engine URL is not configured yet.", "error");
  setField("next-action", "Connect the authorized wallet");
}

async function loadOperatorState() {
  const state = await fetchOperator("/state");
  operatorState = state;
  const envelope = operatorEnvelope(state);
  const view = projectDashboard(envelope.snapshot, envelope);
  renderDashboard(view, envelope);
  renderReview(projectDashboard((state.readOnly ?? envelope).snapshot ?? {}, state.readOnly ?? envelope), state.executionEnabled);
  fillOperatorConfig(state.config);
  controlsForState(state);
  updateConnection("Operator authenticated", `Wallet ${abbreviate(authSession.operatorAddress)}. Private engine state is connected.`, "success");
  setField("next-action", state.state === "STOPPED" ? "Review and start a session" : stateCopy(state.state, true));
  setField("announcer", `Operator state ${state.state}.`);
}

async function load() {
  setModeChrome();
  loading.hidden = false;
  errorState.hidden = true;
  content.hidden = true;
  try {
    if (mode === "landing") {
      await loadLandingMode();
      loading.hidden = true;
      setModeChrome();
      return;
    }
    if (mode === "operator") {
      await loadEngineConfig();
      if (authSession) await loadOperatorState();
      else await loadOperatorPreview();
    } else {
      await loadPublicMode();
    }
    loading.hidden = true;
    content.hidden = false;
    setModeChrome();
  } catch (error) {
    if (mode === "operator" && !authSession) {
      try {
        await loadOperatorPreview();
        loading.hidden = true;
        content.hidden = false;
        setModeChrome();
        setStatus("auth-status", error?.message ?? "Operator service is not ready.", "error");
      } catch (previewError) {
        showReadError("Operator service unavailable", previewError?.message ?? "The private operator service could not be reached.");
      }
      return;
    }
    if (authSession && /status 401|Connect the authorized operator wallet/i.test(error?.message ?? "")) {
      authSession = null;
      setModeChrome();
    }
    showReadError(mode === "operator" ? "Operator state unavailable" : "Replay read unavailable", error?.message ?? "The dashboard could not read the current state.");
    setField("announcer", "Dashboard read failed.");
  }
}

function startPolling() {
  window.clearInterval(pollTimer);
  pollTimer = authSession && mode === "operator" ? window.setInterval(() => loadOperatorState().catch(() => undefined), 5000) : null;
}

async function enterOperatorMode() {
  mode = "operator";
  window.history.replaceState({}, "", `${window.location.pathname}?mode=operator`);
  await load();
}

async function enterReplayMode() {
  mode = "replay";
  authSession = null;
  operatorState = null;
  window.clearInterval(pollTimer);
  window.history.replaceState({}, "", `${window.location.pathname}?mode=replay&scene=${encodeURIComponent(scene)}`);
  await load();
}

async function enterLandingMode() {
  mode = "landing";
  authSession = null;
  operatorState = null;
  window.clearInterval(pollTimer);
  window.history.replaceState({}, "", window.location.pathname);
  await load();
}

async function connectWallet() {
  setStatus("auth-status", "Checking wallet connection...", "");
  try {
    await loadEngineConfig();
    if (!engineApiUrl) throw new Error("Operator service is not connected. Set VILLA_ENGINE_API_URL on the Vercel project.");
    if (!window.ethereum?.request) throw new Error("No browser wallet was found. Install a wallet to continue.");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const address = accounts?.[0];
    if (!address) throw new Error("No wallet address was returned.");
    const issued = await fetchOperator("/auth/nonce", { method: "POST", body: JSON.stringify({ address }) });
    setStatus("auth-status", "Confirm wallet ownership in your wallet...", "");
    const signature = await window.ethereum.request({ method: "personal_sign", params: [issued.message, address] });
    const session = await fetchOperator("/auth/verify", { method: "POST", body: JSON.stringify({ ...issued, signature }) });
    authSession = session;
    setStatus("auth-status", "Wallet ownership confirmed.", "success");
    await loadOperatorState();
    loading.hidden = true;
    content.hidden = false;
    setModeChrome();
    startPolling();
  } catch (error) {
    const message = error?.message ?? "Wallet connection did not complete.";
    setStatus("auth-status", message.includes("User rejected") || message.includes("denied") ? "Signature not completed. No transaction was sent." : message, "error");
    updateConnection("Operator access required", message, "error");
  }
}

async function safeDefaults() {
  fillOperatorConfig({
    version: "villa-operator-config-v1",
    series: "BTC 5m",
    capitalAllocationHuman: 0.001,
    maxDirectionalExposureHuman: 0.001,
    maxRestingOrders: 2,
    maxMarkets: 3,
    maxSessionDurationSec: 720,
  });
  setStatus("control-feedback", "Safe defaults restored. Review the live values, then start.", "success");
}

async function control(action) {
  const feedback = action === "start" ? "control-feedback" : "control-status";
  setStatus(feedback, "Sending control request...", "");
  try {
    if (action === "start") {
      const form = document.querySelector(".config-fields");
      if (!form?.checkValidity()) {
        form?.reportValidity();
        setStatus(feedback, "Review the highlighted configuration value.", "error");
        return;
      }
    }
    const paths = { start: "/session/start", pause: "/session/pause", resume: "/session/resume", stop: "/session/stop", "emergency-cancel": "/orders/cancel-all" };
    const options = { method: "POST" };
    if (action === "start") options.body = JSON.stringify({ config: readOperatorConfig() });
    const state = await fetchOperator(paths[action], options);
    operatorState = state;
    const envelope = operatorEnvelope(state);
    renderDashboard(projectDashboard(envelope.snapshot, envelope), envelope);
    renderReview(projectDashboard((state.readOnly ?? envelope).snapshot ?? {}, state.readOnly ?? envelope), state.executionEnabled);
    fillOperatorConfig(state.config);
    controlsForState(state);
    setStatus(feedback, action === "start" ? "Start accepted. VILLA is checking the market." : `${action.replaceAll("-", " ")} accepted.`, "success");
    startPolling();
  } catch (error) {
    setStatus(feedback, error?.message ?? "The control request failed. The current engine state is unchanged.", "error");
    if (action === "start" && authSession) await loadOperatorState().catch(() => undefined);
  }
}

document.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "operator-open") { await enterOperatorMode(); return; }
  if (action === "replay-open") { await enterReplayMode(); return; }
  if (action === "landing-open") { await enterLandingMode(); return; }
  if (action === "connect") { await connectWallet(); return; }
  if (action === "retry") { await load(); return; }
  if (action === "safe-defaults") { await safeDefaults(); return; }
  if (["start", "pause", "resume", "stop"].includes(action)) { await control(action); return; }
  if (action === "emergency-cancel") {
    if (window.confirm("Cancel all VILLA session-owned orders and stop the engine? This does not liquidate unmatched inventory.")) await control(action);
    return;
  }
  const sceneButton = event.target.closest("[data-scene]");
  if (sceneButton && mode === "replay") {
    scene = sceneButton.dataset.scene;
    window.history.replaceState({}, "", `${window.location.pathname}?scene=${encodeURIComponent(scene)}`);
    await load();
    return;
  }
  const copy = event.target.closest("[data-copy]");
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      copy.textContent = "Copied";
      announcer.textContent = "Value copied.";
      window.setTimeout(() => { copy.textContent = "Copy"; }, 1200);
    } catch {
      announcer.textContent = "Copy was unavailable in this browser.";
    }
  }
});

await load();
startPolling();
