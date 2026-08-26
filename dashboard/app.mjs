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
const errorText = document.querySelector('[data-field="error"]');
const announcer = document.querySelector('[data-field="announcer"]');
const params = new URLSearchParams(window.location.search);
let mode = params.get("mode") === "live" ? "live" : "replay";
let scene = params.get("scene") || "quote";
let lastEnvelope = null;

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

function rawPriceOrUnavailable(value) {
  return value === null || value === undefined ? "Unavailable" : formatRawPrice(value);
}

function statusClass(value) {
  return String(value ?? "").toLowerCase().replaceAll(" ", "_");
}

function renderRisk(view) {
  const risk = view.risk;
  const badge = field("risk-action");
  const action = risk.action ?? "UNAVAILABLE";
  if (badge) {
    badge.textContent = risk.label;
    badge.className = `governor-badge ${action === "HALT" ? "halt" : action === "REDUCE_ONLY" ? "reduce" : action === "ALLOW" ? "allow" : "noquote"}`;
  }
  setField("risk-reason-code", risk.reasonCode ?? "NONE");
  setField("risk-reason-text", risk.reasonText);
  setHtml("risk-checks", risk.checks.map((check) => `<div class="risk-check ${check.state.toLowerCase()}"><span>${escapeHtml(check.label)}</span><em>${escapeHtml(check.state)}</em></div>`).join(""));
}

function renderQuotes(view) {
  const quote = view.quotes;
  for (const side of [quote.bid, quote.ask]) {
    const key = side.side;
    setField(`${key}-price`, rawPriceOrUnavailable(side.priceRaw));
    setField(`${key}-qty`, side.quantityRaw === null ? "Unavailable" : formatRaw(side.quantityRaw, 6, 4));
    const status = field(`${key}-state`);
    if (status) {
      status.textContent = side.state.replaceAll("_", " ");
      status.className = `quote-state ${statusClass(side.state)}`;
    }
  }
  setField("best-bid", rawPriceOrUnavailable(quote.bestBid));
  setField("best-ask", rawPriceOrUnavailable(quote.bestAsk));
  setField("quote-summary", quote.twoSided ? "Two-sided liquidity is resting" : quote.oneSided ? "One-sided liquidity is intentional" : view.state.key === "HALTED" ? "Quoting disabled by Risk Governor" : "No active quote");
  const dot = field("quote-dot");
  if (dot) dot.style.background = quote.twoSided ? "var(--up)" : quote.oneSided ? "var(--warning)" : view.state.key === "HALTED" ? "var(--danger)" : "var(--down)";
}

function renderTimeline(view) {
  if (!view.timeline.length) {
    setHtml("timeline", '<p class="empty-copy">No structured session events are attached to this read.</p>');
    return;
  }
  setHtml("timeline", view.timeline.map((event) => `<div class="timeline-item ${escapeHtml(event.tone)}"><time>${escapeHtml(event.timeLabel)}</time><span class="timeline-dot" aria-hidden="true"></span><strong>${escapeHtml(event.label)}</strong></div>`).join(""));
}

function renderWhy(view) {
  if (!view.why.length) {
    setHtml("why-list", '<p class="empty-copy">No movement explanation is available for this snapshot.</p>');
    return;
  }
  setHtml("why-list", view.why.map((item) => `<div class="why-item ${escapeHtml(item.tone)}"><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></div>`).join(""));
}

function renderLifecycle(view) {
  const lifecycle = view.lifecycle;
  setField("lifecycle-label", lifecycle.state ? String(lifecycle.state).replaceAll("_", " ") : "Unavailable");
  setField("previous-market", abbreviate(lifecycle.previous));
  setField("previous-state", lifecycle.previous ? "Settled or closed" : "No previous market recorded");
  setField("current-market", abbreviate(lifecycle.current));
  setField("current-state", lifecycle.state ? String(lifecycle.state).replaceAll("_", " ") : "Unavailable");
  setField("next-market", lifecycle.next ?? "Waiting");
}

function renderSettlement(view) {
  const claims = view.lifecycle.claims;
  const residuals = view.lifecycle.residuals;
  const rows = [];
  for (const claim of claims) {
    rows.push(`<div class="settlement-row"><div class="settlement-main"><strong>${escapeHtml(abbreviate(claim.marketId))} · ${escapeHtml(claim.outcome ?? "claim")}</strong><span>${escapeHtml(claim.status ?? "RECORDED")}</span></div><small>${escapeHtml(formatRaw(claim.amountRaw, 6, 4))} received, payout ${escapeHtml(formatRaw(claim.payoutRaw, 6, 4))}${claim.transactionHash ? ` · <button class="copy-button" data-copy="${escapeHtml(claim.transactionHash)}" type="button">Copy tx</button>` : ""}</small></div>`);
  }
  for (const residual of residuals) {
    rows.push(`<div class="settlement-row residual"><div class="settlement-main"><strong>${escapeHtml(abbreviate(residual.marketId))} · ${escapeHtml(residual.outcome ?? "residual")}</strong><span>ZERO VALUE</span></div><small>Settled · zero-value residual, excluded from active inventory</small></div>`);
  }
  setHtml("settlement", rows.length ? rows.join("") : '<p class="empty-copy">No claimable positions are recorded.</p>');
}

function renderEvidence(envelope) {
  const panel = field("evidence-panel");
  const evidence = envelope.evidence;
  if (!panel || !evidence) {
    if (panel) panel.hidden = true;
    return;
  }
  panel.hidden = false;
  setField("evidence-title", evidence.title);
  setField("evidence-note", evidence.note);
  const facts = (evidence.facts ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const fills = (evidence.fills ?? []).map((fill) => `<div class="evidence-fill"><strong>${escapeHtml(abbreviate(fill.marketId))}</strong><br>${escapeHtml(fill.action)} · ${escapeHtml(formatRaw(fill.quantityRaw, 6, 4))} · ${escapeHtml(fill.result)}<br><span class="comparison-note">order ${escapeHtml(fill.orderId)}</span></div>`).join("");
  const txs = (evidence.transactions ?? []).map((hash) => `<div class="hash-line"><code>${escapeHtml(abbreviate(hash, 10, 8))}</code><button class="copy-button" data-copy="${escapeHtml(hash)}" type="button">Copy</button></div>`).join("");
  setHtml("evidence-facts", `<div class="evidence-block"><h3>What was recorded</h3><ul>${facts || "<li>No extra facts</li>"}</ul></div>`);
  setHtml("evidence-fills", evidence.fills?.length ? `<div class="evidence-block"><h3>External fills</h3>${fills}</div>` : "");
  setHtml("evidence-txs", evidence.transactions?.length ? `<div class="evidence-block"><h3>Transactions to inspect</h3>${txs}</div>` : "");
}

function renderScenes(view) {
  const container = field("scenes");
  if (!container) return;
  if (view.mode !== "REPLAY") {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  container.hidden = false;
  const labels = { quote: "Quote proof", rollover: "Rollover proof", settlement: "Settlement proof" };
  container.innerHTML = Object.entries(labels).map(([key, label]) => `<button type="button" class="scene-button ${view.scene === key ? "active" : ""}" data-scene="${key}" aria-pressed="${view.scene === key}">${label}</button>`).join("");
}

function render(view, envelope) {
  const snapshot = view.snapshot;
  const state = view.state;
  const market = snapshot.market ?? {};
  const fair = view.fair;
  setField("mode", view.modeLabel);
  setField("mode-copy", view.mode === "REPLAY" ? "RECORDED PROOF" : "READ ONLY");
  setField("series", view.marketLabel);
  setField("market-label", view.marketLabel);
  setField("market-id", abbreviate(market.marketId));
  setField("wallet", abbreviate(snapshot.system?.walletAddress));
  setField("contract", snapshot.contractVersion);
  setField("state", state.label);
  const stateBadge = field("state");
  if (stateBadge) stateBadge.className = `state-badge ${state.tone}`;
  setField("lifecycle-state", snapshot.lifecycle?.rolloverState ? String(snapshot.lifecycle.rolloverState).replaceAll("_", " ") : "Unavailable");
  setField("underlying", finite(market.currentUnderlying) === null ? "Unavailable" : `$${formatPrice(market.currentUnderlying)}`);
  setField("reference", finite(market.reference) === null ? "Unavailable" : `$${formatPrice(market.reference)}`);
  setField("time-left", formatTimeRemaining(market.timeRemainingSec));
  setField("market-status", market.status ?? "Unavailable");
  setField("villa-fair", formatProbability(fair.pUp));
  setField("dex-mid", formatProbability(view.midpoint));
  const difference = fair.pUp !== null && view.midpoint !== null ? (fair.pUp - view.midpoint) * 100 : null;
  setField("difference", difference === null ? "Unavailable" : `${difference >= 0 ? "+" : ""}${difference.toFixed(1)} pp`);
  setField("p-up", formatProbability(fair.pUp));
  setField("p-down", formatProbability(fair.pDown));
  const probabilityFill = field("probability-fill");
  if (probabilityFill) probabilityFill.style.width = `${fair.pUp === null ? 50 : Math.min(100, Math.max(0, fair.pUp * 100))}%`;
  setField("confidence", fair.confidence === null ? "Unavailable" : `${(fair.confidence * 100).toFixed(1)}%`);
  setField("volatility", fair.volatility === null ? "Unavailable" : `${fair.volatility.toExponential(3)} /√s`);
  const distance = finite(market.currentUnderlying) !== null && finite(market.reference) !== null ? (market.currentUnderlying / market.reference - 1) * 100 : null;
  setField("distance", distance === null ? "Unavailable" : `${distance >= 0 ? "+" : ""}${distance.toFixed(2)}%`);
  setField("z-score", "Not exposed");
  setField("model-version", fair.version ?? "Unavailable");
  renderQuotes(view);
  renderRisk(view);
  setField("yes-inventory", view.exposure.yes === null ? "Unavailable" : view.exposure.yes.toFixed(4));
  setField("no-inventory", view.exposure.no === null ? "Unavailable" : view.exposure.no.toFixed(4));
  setField("complete-sets", view.exposure.completeSets === null ? "Unavailable" : view.exposure.completeSets.toFixed(4));
  setField("exposure-direction", view.exposure.direction);
  setField("exposure-value", view.exposure.directional === null ? "unavailable" : view.exposure.directional.toFixed(6));
  const marker = field("exposure-marker");
  if (marker) marker.style.left = `${view.exposure.directional === null ? 50 : Math.min(90, Math.max(10, 50 + Math.tanh(view.exposure.directional * 1000) * 40))}%`;
  const classes = view.exposure.classifications.filter((item) => item !== "KNOWN_ZERO_VALUE_SETTLED_RESIDUAL");
  setField("inventory-class", classes.length ? "Current market classification" : "No residuals included");
  renderWhy(view);
  renderLifecycle(view);
  renderTimeline(view);
  renderSettlement(view);
  setField("tusdc", formatRaw(snapshot.accounting?.tUSDC, 6, 6, "tUSDC"));
  setField("stt", formatRaw(snapshot.accounting?.STT, 18, 6, "STT"));
  setField("pnl-state", snapshot.accounting?.pnlState ?? "PNL_UNAVAILABLE");
  setField("source", view.source);
  renderEvidence(envelope);
  renderScenes(view);
  const modeButton = document.querySelector('[data-action="mode"]');
  if (modeButton) {
    modeButton.textContent = view.mode === "REPLAY" ? "Use live read" : "Use replay";
    modeButton.setAttribute("aria-pressed", String(view.mode === "LIVE"));
  }
}

async function load() {
  loading.hidden = false;
  errorState.hidden = true;
  content.hidden = true;
  try {
    const response = await fetch(`/api/snapshot?mode=${encodeURIComponent(mode)}&scene=${encodeURIComponent(scene)}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "The dashboard adapter returned an error.");
    lastEnvelope = payload;
    const view = projectDashboard(payload.snapshot, payload);
    render(view, payload);
    loading.hidden = true;
    content.hidden = false;
    announcer.textContent = `${view.modeLabel} dashboard ready. ${view.state.label}.`;
  } catch (error) {
    loading.hidden = true;
    errorState.hidden = false;
    errorText.textContent = error?.message ?? "The dashboard read failed.";
    announcer.textContent = "Dashboard read failed.";
  }
}

document.addEventListener("click", async (event) => {
  const modeButton = event.target.closest('[data-action="mode"]');
  if (modeButton) {
    mode = mode === "replay" ? "live" : "replay";
    await load();
    return;
  }
  const retry = event.target.closest('[data-action="retry"]');
  if (retry) {
    await load();
    return;
  }
  const sceneButton = event.target.closest("[data-scene]");
  if (sceneButton) {
    scene = sceneButton.dataset.scene;
    await load();
    return;
  }
  const copy = event.target.closest("[data-copy]");
  if (copy) {
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      copy.textContent = "Copied";
      announcer.textContent = "Value copied.";
      window.setTimeout(() => { copy.textContent = copy.classList.contains("hash-line") ? "Copy" : "Copy"; }, 1200);
    } catch {
      announcer.textContent = "Copy was unavailable in this browser.";
    }
  }
});

await load();

if (mode === "live") window.setInterval(load, 15_000);
