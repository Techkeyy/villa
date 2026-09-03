import { formatRawExact } from "./account-client.mjs";

function node(id) {
  return document.getElementById(id);
}

function value(id, text) {
  const target = node(id);
  if (target) target.textContent = text;
}

function rawText(raw) {
  if (raw === null || raw === undefined || raw === "") return "Unavailable";
  try { return `${formatRawExact(BigInt(raw))} tUSDC`; } catch { return "Unavailable"; }
}

function signedRawText(raw) {
  if (raw === null || raw === undefined || raw === "") return "Pending / not realized";
  try {
    const amount = BigInt(raw);
    const sign = amount < 0n ? "-" : amount > 0n ? "+" : "";
    return `${sign}${formatRawExact(amount < 0n ? -amount : amount)} tUSDC`;
  } catch { return "Pending / not realized"; }
}

function findMetric(label, id) {
  const metrics = [...document.querySelectorAll("#capital .metric")];
  const metric = metrics.find((item) => item.querySelector("span")?.textContent?.trim() === label);
  if (!metric) return null;
  const strong = metric.querySelector("strong");
  if (strong && id) strong.id = id;
  return strong;
}

export function ensureUatMonitor() {
  if (!node("session-monitor")) {
    const strategy = node("strategy");
    strategy?.insertAdjacentHTML("beforeend", `<section class="panel session-monitor" id="session-monitor" hidden aria-labelledby="session-monitor-title"><div class="panel-topline"><div><p class="panel-label">LIVE SESSION</p><h3 id="session-monitor-title">Account-bound strategy monitor</h3></div><span class="status-pill status-preview" id="session-monitor-state">STOPPED</span></div><div class="metric-grid strategy-monitor-grid"><div class="metric"><span>Market</span><strong id="monitor-market">Selected at Start</strong></div><div class="metric"><span>Time remaining</span><strong id="monitor-headroom">Unavailable</strong></div><div class="metric"><span>Risk controls</span><strong id="monitor-risk">Unavailable</strong></div><div class="metric"><span>Quote</span><strong id="monitor-quote">Unavailable</strong></div><div class="metric"><span>Open orders</span><strong id="monitor-orders">0</strong></div><div class="metric"><span>YES / NO</span><strong id="monitor-inventory">0 / 0</strong></div><div class="metric"><span>Settlement</span><strong id="monitor-settlement">None pending</strong></div><div class="metric"><span>Latest action</span><strong id="monitor-action">No session yet</strong></div><div class="metric"><span>P&amp;L</span><strong id="monitor-pnl">Pending / not realized</strong></div></div><p class="helper" id="monitor-copy">Start uses the verified owner wallet and the private account-bound engine. No operator wallet is needed in the browser.</p></section>`);
  }
  const monitorGrid = document.querySelector("#session-monitor .strategy-monitor-grid");
  if (monitorGrid && !node("monitor-fills")) {
    monitorGrid.insertAdjacentHTML("beforeend", '<div class="metric"><span>Fills</span><strong id="monitor-fills">Unavailable</strong></div>');
  }
  findMetric("Deployed", "deployed-balance");
  findMetric("Pending settlement", "pending-settlement-balance");
}

export function renderUatMonitor({ state = "STOPPED", session = null, snapshot = null, result = null } = {}) {
  ensureUatMonitor();
  const normalized = String(state || session?.state || "STOPPED").toUpperCase();
  const visible = normalized !== "STOPPED" || Boolean(snapshot) || Boolean(result);
  const panel = node("session-monitor");
  panel?.toggleAttribute("hidden", !visible);
  const active = ["STARTING", "RUNNING", "PAUSED", "STOPPING", "SETTLEMENT_READY", "SETTLING"].includes(normalized);
  const pill = node("session-monitor-state");
  if (pill) {
    pill.className = `status-pill ${active ? "status-safe" : normalized === "ERROR" ? "status-error" : "status-preview"}`;
    pill.textContent = normalized;
  }
  const marketId = snapshot?.marketId || session?.currentMarketId || "";
  const interval = Number(snapshot?.intervalSec ?? 0);
  const intervalText = interval > 0 ? `${interval >= 3600 ? `${interval / 3600}h` : `${interval / 60}m`} · ` : "";
  value("monitor-market", marketId ? `${intervalText}${marketId.slice(0, 8)}…${marketId.slice(-4)}` : "Selected at Start");
  value("monitor-headroom", snapshot?.timeRemainingSec === null || snapshot?.timeRemainingSec === undefined ? "Unavailable" : `${Math.max(0, Math.floor(Number(snapshot.timeRemainingSec)))}s`);
  value("monitor-risk", snapshot?.risk ? String(snapshot.risk) : "Unavailable");
  value("monitor-quote", snapshot?.quote ? (typeof snapshot.quote === "string" ? snapshot.quote : snapshot.quote.plan === "NO_QUOTE" ? "NO_QUOTE" : "Valid") : "Unavailable");
  value("monitor-orders", String(Array.isArray(snapshot?.openOrders) ? snapshot.openOrders.length : 0));
  value("monitor-fills", Array.isArray(snapshot?.fills) ? String(snapshot.fills.length) : result?.fills ? String(result.fills) : "Unavailable");
  value("monitor-inventory", `${rawText(snapshot?.yesRaw).replace(" tUSDC", "")} / ${rawText(snapshot?.noRaw).replace(" tUSDC", "")}`);
  value("monitor-settlement", snapshot?.pendingSettlement ? "Pending / unresolved" : result?.settlement?.resolution?.resolution ? String(result.settlement.resolution.resolution) : normalized === "SETTLED" ? "Settled" : "None pending");
  value("monitor-action", snapshot?.lastAction ? String(snapshot.lastAction) : result?.reason ? String(result.reason) : "No session yet");
  value("monitor-pnl", snapshot?.pnl ? signedRawText(snapshot.pnl.raw) : result?.pnl ? signedRawText(result.pnl.raw) : "Pending / not realized");
  value("deployed-balance", snapshot?.deployedRaw === null || snapshot?.deployedRaw === undefined ? "0.000 tUSDC" : rawText(snapshot.deployedRaw));
  value("pending-settlement-balance", snapshot?.pendingSettlement ? rawText(snapshot.yesRaw) : "0.000 tUSDC");
  value("monitor-copy", active ? "Live values are read from the account-bound session. Stop blocks new expansion before scoped cleanup." : result ? "The session ended with the recorded result above. Withdrawals remain a separate owner-signed account action." : "Start uses the verified owner wallet and the private account-bound engine. No operator wallet is needed in the browser.");
}
