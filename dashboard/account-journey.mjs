export const DISCOVERY_STATES = Object.freeze([
  "IDLE",
  "DISCOVERING",
  "NO_ACCOUNT",
  "DISCOVERED",
  "DISCOVERY_ERROR",
  "SECURITY_ERROR",
]);

export const WALLET_STATES = Object.freeze([
  "DISCONNECTED",
  "CONNECTED_WRONG_NETWORK",
  "CONNECTED_DISCOVERING",
  "CONNECTED_NO_ACCOUNT",
  "CONNECTED_ACCOUNT",
  "CONNECTED_ERROR",
  "CONNECTED_SECURITY_ERROR",
]);

const ACCOUNT_PANELS = Object.freeze([
  "account-loading",
  "account-empty",
  "account-workspace",
  "account-error",
]);

const PANEL_BY_DISCOVERY = Object.freeze({
  DISCOVERING: "account-loading",
  NO_ACCOUNT: "account-empty",
  DISCOVERED: "account-workspace",
  DISCOVERY_ERROR: "account-error",
  SECURITY_ERROR: "account-error",
});

function normalizeDiscoveryStatus(status) {
  return DISCOVERY_STATES.includes(status) ? status : "IDLE";
}

export function deriveWalletStatus({ owner = "", chainStatus = "UNKNOWN", discoveryStatus = "IDLE" } = {}) {
  if (!owner) return "DISCONNECTED";
  if (chainStatus === "WRONG_NETWORK") return "CONNECTED_WRONG_NETWORK";
  if (discoveryStatus === "NO_ACCOUNT") return "CONNECTED_NO_ACCOUNT";
  if (discoveryStatus === "DISCOVERED") return "CONNECTED_ACCOUNT";
  if (discoveryStatus === "SECURITY_ERROR") return "CONNECTED_SECURITY_ERROR";
  if (discoveryStatus === "DISCOVERY_ERROR") return "CONNECTED_ERROR";
  return "CONNECTED_DISCOVERING";
}

function safeAddressLabel(owner) {
  const address = String(owner ?? "");
  return address.length > 13 ? `${address.slice(0, 7)}...${address.slice(-4)}` : address || "Wallet connected";
}

function setHidden(document, id, hidden) {
  document.getElementById(id)?.toggleAttribute("hidden", hidden);
}

function setText(document, id, value) {
  const target = document.getElementById(id);
  if (target) target.textContent = value;
}

function setButtonDisabled(document, id, disabled) {
  const target = document.getElementById(id);
  if (target) target.disabled = disabled;
}

export function renderAccountJourney(document, appState = {}) {
  const state = normalizeDiscoveryStatus(appState.discoveryStatus);
  const walletStatus = deriveWalletStatus({ ...appState, discoveryStatus: state });
  const connected = walletStatus !== "DISCONNECTED";
  const wrongNetwork = walletStatus === "CONNECTED_WRONG_NETWORK";
  const onShannon = appState.chainStatus === "SHANNON";
  const activeDiscovery = connected && onShannon && !wrongNetwork ? state : "IDLE";
  const activePanel = PANEL_BY_DISCOVERY[activeDiscovery] || "";
  const visiblePanels = [];

  setHidden(document, "wallet-disconnected", connected);
  setHidden(document, "wallet-connected", !connected);
  setHidden(document, "wrong-network", !wrongNetwork);

  for (const id of ACCOUNT_PANELS) {
    const visible = id === activePanel;
    setHidden(document, id, !visible);
    if (visible) visiblePanels.push(id);
  }

  setHidden(document, "transaction-panel", !connected || !appState.account || appState.transactionStatus === "IDLE");
  setText(document, "wallet-address", safeAddressLabel(appState.owner));
  setText(document, "network-status", wrongNetwork ? "WRONG NETWORK" : onShannon ? "SHANNON TESTNET" : "CHECKING NETWORK");
  setText(document, "wallet-state", wrongNetwork ? "SWITCH TO SHANNON" : onShannon ? "WALLET CONNECTED" : "CHECKING NETWORK");
  setText(document, "account-error-title", activeDiscovery === "SECURITY_ERROR" ? "Account verification blocked" : "Account lookup unavailable");
  setText(document, "account-error-copy", activeDiscovery === "SECURITY_ERROR"
    ? "VILLA found a contract associated with this wallet, but could not verify it as a valid VILLA account."
    : "VILLA could not verify whether this wallet already has a liquidity account. Creating another account is disabled until verification succeeds.");

  const networkStatus = document.getElementById("network-status");
  if (networkStatus) networkStatus.className = `status-pill ${onShannon && !wrongNetwork ? "status-safe" : "status-preview"}`;
  const walletState = document.getElementById("wallet-state");
  if (walletState) walletState.className = `status-pill ${onShannon && !wrongNetwork ? "status-safe" : "status-preview"}`;

  const busy = Boolean(appState.busy);
  setButtonDisabled(document, "switch-network", !wrongNetwork || busy);
  setButtonDisabled(document, "retry-account", !["DISCOVERY_ERROR", "SECURITY_ERROR"].includes(activeDiscovery) || busy);
  setButtonDisabled(document, "create-account", activeDiscovery !== "NO_ACCOUNT" || busy);

  const connectedElement = document.getElementById("wallet-connected");
  if (connectedElement) {
    connectedElement.dataset.walletState = walletStatus;
    connectedElement.dataset.discoveryState = activeDiscovery;
  }

  if (visiblePanels.length > 1 && typeof window !== "undefined" && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)) {
    console.warn("[VILLA] account journey invariant violated", visiblePanels);
  }

  return Object.freeze({ walletStatus, discoveryState: activeDiscovery, visiblePanels });
}

export function accountJourneyPanelIds() {
  return [...ACCOUNT_PANELS];
}
