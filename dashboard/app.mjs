const page = window.location.pathname.replace(/\/+$/, "") || "/";

const escapeHtml = (value) => String(value ?? "Unavailable")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const shorten = (value) => {
  const text = String(value ?? "");
  return text.length > 13 ? `${text.slice(0, 7)}...${text.slice(-4)}` : text || "Unavailable";
};

const formatMarket = (market = {}) => {
  const asset = market.asset ? String(market.asset).toUpperCase() : "Market";
  const interval = Number(market.intervalSec);
  if (!Number.isFinite(interval)) return asset;
  if (interval % 3600 === 0) return `${asset} ${interval / 3600}h`;
  if (interval % 60 === 0) return `${asset} ${interval / 60}m`;
  return `${asset} ${interval}s`;
};

const formatProbability = (value) => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : "Unavailable";

function showPage() {
  const requested = page === "/app" ? "app" : page === "/proof" ? "proof" : "landing";
  document.querySelectorAll("[data-page]").forEach((element) => {
    const active = element.dataset.page === requested;
    element.hidden = !active;
  });
  document.body.dataset.page = requested;
  if (requested === "app") initWallet();
  if (requested === "proof") initProof();
}

function setWalletState(connected, address = "") {
  document.querySelector('[data-connect-state="disconnected"]')?.toggleAttribute("hidden", connected);
  document.querySelector('[data-connect-state="connected"]')?.toggleAttribute("hidden", !connected);
  const addressElement = document.querySelector("#wallet-address");
  if (addressElement) addressElement.textContent = shorten(address);
}

async function requestAccounts(method) {
  if (!window.ethereum?.request) throw new Error("No compatible wallet was found in this browser.");
  const accounts = await window.ethereum.request({ method });
  return Array.isArray(accounts) ? accounts : [];
}

function initWallet() {
  const connect = document.querySelector("#connect-wallet");
  const message = document.querySelector("#wallet-message");
  const provider = window.ethereum;
  const restore = async () => {
    if (!provider?.request) return;
    try {
      const accounts = await requestAccounts("eth_accounts");
      if (accounts[0]) setWalletState(true, accounts[0]);
    } catch { /* A passive restore should never block onboarding. */ }
  };
  restore();
  connect?.addEventListener("click", async () => {
    if (message) message.textContent = "";
    if (!provider?.request) {
      if (message) message.textContent = "Install or unlock a compatible wallet to continue.";
      return;
    }
    connect.disabled = true;
    connect.textContent = "Connecting...";
    try {
      const accounts = await requestAccounts("eth_requestAccounts");
      if (!accounts[0]) throw new Error("The wallet did not return an account.");
      setWalletState(true, accounts[0]);
    } catch (error) {
      if (message) message.textContent = error?.message || "Wallet connection was cancelled.";
    } finally {
      connect.disabled = false;
      connect.textContent = "Connect wallet";
    }
  }, { once: true });
  provider?.on?.("accountsChanged", (accounts) => setWalletState(Boolean(accounts?.[0]), accounts?.[0] || ""));
}

function renderProof(payload) {
  const snapshot = payload?.snapshot ?? {};
  const evidence = payload?.evidence ?? {};
  const facts = Array.isArray(evidence.facts) ? evidence.facts : [];
  const transactions = Array.isArray(evidence.transactions) ? evidence.transactions : [];
  const events = Array.isArray(snapshot.activity?.events) ? snapshot.activity.events : [];
  const state = snapshot.system?.state || "Unavailable";
  const risk = snapshot.risk?.action || "Unavailable";
  const market = formatMarket(snapshot.market);
  const factsMarkup = facts.length ? facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("") : "<li>No recorded facts for this scene.</li>";
  const eventMarkup = events.length ? events.map((event) => `<li><strong>${escapeHtml(event.type)}</strong><br /><span>${escapeHtml(event.facts?.reason || event.facts?.action || "Recorded checkpoint")}</span></li>`).join("") : "<li>No event timeline retained.</li>";
  const txMarkup = transactions.length ? transactions.map((hash) => `<li class="transaction">${escapeHtml(hash)}</li>`).join("") : "<li>No transaction hashes were retained for this replay.</li>";
  return `<section class="proof-overview"><div class="panel"><p class="panel-label">${escapeHtml(payload.mode || "REPLAY")}</p><h2>${escapeHtml(evidence.title || "Recorded evidence")}</h2><p>${escapeHtml(evidence.note || payload.source || "Read-only replay evidence.")}</p></div><div class="panel proof-source"><strong>Recorded source</strong><span>${escapeHtml(payload.source || "Local verification record")}</span><br /><br /><strong>Snapshot</strong><span>${escapeHtml(market)} · ${escapeHtml(state)} · Risk ${escapeHtml(risk)}</span></div></section><section class="evidence-grid"><section class="panel"><p class="panel-label">WHAT WAS VERIFIED</p><h2>Evidence facts</h2><ul class="evidence-list">${factsMarkup}</ul></section><section class="panel"><p class="panel-label">LIFECYCLE</p><h2>Recorded checkpoints</h2><ul class="evidence-list">${eventMarkup}</ul></section><section class="panel"><p class="panel-label">TRANSACTIONS</p><h2>Reference hashes</h2><ul class="evidence-list">${txMarkup}</ul></section><section class="panel"><p class="panel-label">BOUNDARY</p><h2>Read only</h2><p class="empty-copy">This page reads a local evidence envelope. It does not connect to the engine, request a signature, place an order, or send a blockchain transaction.</p></section></section>`;
}

function initProof() {
  const button = document.querySelector("#load-proof");
  const select = document.querySelector("#proof-scene");
  const result = document.querySelector("#proof-result");
  const message = document.querySelector("#proof-message");
  const load = async () => {
    button.disabled = true;
    button.textContent = "Loading...";
    if (message) message.textContent = "";
    try {
      const response = await fetch(`/api/snapshot?mode=replay&scene=${encodeURIComponent(select.value)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Replay unavailable (${response.status}).`);
      result.innerHTML = renderProof(await response.json());
    } catch (error) {
      result.innerHTML = `<section class="panel empty-proof"><p class="panel-label">REPLAY ERROR</p><h2>Evidence is unavailable.</h2><p>${escapeHtml(error?.message || "Try again.")}</p></section>`;
      if (message) message.textContent = "The replay could not be loaded.";
    } finally {
      button.disabled = false;
      button.textContent = "Load replay";
    }
  };
  button?.addEventListener("click", load);
  load();
}

showPage();
