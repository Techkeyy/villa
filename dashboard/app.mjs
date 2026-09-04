import {
  AccountClientError,
  accountCall,
  actionTransaction,
  buildDeploymentData,
  createDiscoveryDeadline,
  deploymentTransaction,
  DISCOVERY_TIMEOUT_MS,
  discoverAccount,
  ensureShannon,
  formatAmount,
  formatRawExact,
  getChainId,
  loadAccountArtifacts,
  loadArtifact,
  normalizeAddress,
  parseAmount,
  readAccount,
  readAllowance,
  readTokenBalance,
  request,
  sendTransaction,
  tokenCall,
} from "./account-client.mjs";
import { MIN_INITIAL_DEPOSIT_RAW, MIN_STRATEGY_CAPITAL_RAW, MIN_TOP_UP_RAW, PHASE_3B1_MAX_ACCOUNT_CAPITAL_RAW, VILLA_ACCOUNT_CONFIG, VILLA_CHAIN, ZERO_ADDRESS } from "./account-config.mjs";
import { deriveWalletStatus, renderAccountJourney } from "./account-journey.mjs";
import { createAddLiquidityHandler, runAddLiquidity } from "./liquidity-flow.mjs";
import { evaluateVerifiedOwnerAccountReadiness, isStrategyCapitalReady, isVerifiedOwnerAccountReady } from "./account-readiness.mjs";
import { createAuthorizationHandler, runAuthorization } from "./authorization-flow.mjs";
import { ControlClientError, createAccountControlClient } from "./control-client.mjs";
import { ensureUatMonitor, renderUatMonitor } from "./uat-monitor.mjs";

const page = document.body.dataset.route || window.location.pathname.replace(/\/+$/, "") || "/";
const ACCOUNT_HINT_PREFIX = "villa.account.owner.";

let provider = null;
let controlClient = null;
let accountArtifact = null;
let accountArtifacts = null;
let walletInitialized = false;
let proofInitialized = false;
let refreshGeneration = 0;
let accountRefreshInFlight = null;
let refreshQueued = false;
let controlPollTimer = null;
let appState = {
  walletStatus: "DISCONNECTED",
  chainStatus: "UNKNOWN",
  discoveryStatus: "IDLE",
  controlState: "STOPPED",
  controlBusy: false,
  account: null,
  accounts: [],
  walletBalance: 0n,
  transactionStatus: "IDLE",
  controlSnapshot: null,
  controlResult: null,
  controlSession: null,
  owner: "",
  currentAccountAddress: "",
  chainId: null,
  error: null,
  busy: false,
};

const DEBUG_ENABLED = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);

if (DEBUG_ENABLED) {
  window.__VILLA_BUILD__ = Object.freeze({
    phase: "phase2-discovery-reset",
    renderer: "account-journey-v2",
    buildId: "account-bound-release-v1",
  });
  if (!window.__VILLA_BUILD_LOGGED__) {
    window.__VILLA_BUILD_LOGGED__ = true;
    console.info("[VILLA] account-journey-v2 loaded");
  }
}

function debugDiscovery(event, details = {}) {
  if (!DEBUG_ENABLED) return;
  const debug = window.__VILLA_DEBUG__ ||= {
    wallet: "",
    chainId: null,
    discoveryState: "IDLE",
    discoveryJob: null,
    discoverySource: "",
    lastDiscoveryError: "",
    events: [],
  };
  const entry = { at: new Date().toISOString(), event, ...details };
  debug.events.push(entry);
  if (debug.events.length > 40) debug.events.shift();
  if (Object.hasOwn(details, "wallet")) debug.wallet = details.wallet;
  if (Object.hasOwn(details, "chainId")) debug.chainId = details.chainId;
  if (Object.hasOwn(details, "discoveryJob")) debug.discoveryJob = details.discoveryJob;
  if (Object.hasOwn(details, "discoverySource")) debug.discoverySource = details.discoverySource;
  if (Object.hasOwn(details, "lastDiscoveryError")) debug.lastDiscoveryError = details.lastDiscoveryError;
  if (Object.hasOwn(details, "state")) debug.discoveryState = details.state;
  try { console.debug(`[VILLA] ${event}`, details); } catch {
    // Console diagnostics are optional and must never affect the UI.
  }
}

function debugLiquidity(event, details = {}) {
  if (!DEBUG_ENABLED) return;
  const debug = window.__VILLA_LIQUIDITY_DEBUG__ ||= { events: [] };
  const entry = { at: new Date().toISOString(), event, ...details };
  debug.events.push(entry);
  if (debug.events.length > 60) debug.events.shift();
  try { console.debug(`[VILLA] ${event}`, details); } catch {
    // Console diagnostics are optional and must never affect the UI.
  }
}

function debugAuthorization(event, details = {}) {
  if (!DEBUG_ENABLED) return;
  const debug = window.__VILLA_AUTHORIZATION_DEBUG__ ||= { events: [] };
  const entry = { at: new Date().toISOString(), event, ...details };
  debug.events.push(entry);
  if (debug.events.length > 40) debug.events.shift();
  try { console.debug(`[VILLA] ${event}`, details); } catch {
    // Console diagnostics are optional and must never affect the UI.
  }
}

function publishReadinessDebug(state) {
  if (!DEBUG_ENABLED) return;
  window.__VILLA_READINESS_DEBUG__ = evaluateVerifiedOwnerAccountReadiness(state);
}

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

const formatStrategyAmount = (raw) => formatAmount(raw, 6, 3);

function sessionMarket(session) {
  const series = String(session?.marketSeries ?? "");
  const match = /^BINARY:([^:]+):(\d+)$/.exec(series);
  return match ? { asset: match[1], intervalSec: Number(match[2]) } : null;
}

function strategyMarketLabel() {
  const session = appState.controlSession;
  if (!session || !["RUNNING", "PAUSED", "STOPPING", "ERROR", "STOPPED_SETTLEMENT_PENDING", "SETTLEMENT_READY", "SETTLING", "SETTLED"].includes(String(session.state || appState.controlState).toUpperCase())) {
    return "Selected automatically at Start";
  }
  const market = sessionMarket(session);
  if (!market) return session.currentMarketId ? "Market · " + shorten(session.currentMarketId) : "Selected automatically at Start";
  return formatMarket(market) + (session.currentMarketId ? " · " + shorten(session.currentMarketId) : "");
}
const formatProbability = (value) => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : "Unavailable";

function element(id) {
  return document.getElementById(id);
}

function toggle(id, visible) {
  element(id)?.toggleAttribute("hidden", !visible);
}

function text(id, value) {
  const target = element(id);
  if (target) target.textContent = value;
}

function syncButtonDisabled(target, disabled) {
  if (!target) return;
  const isBlocked = Boolean(disabled);
  target.disabled = isBlocked;
  if (isBlocked) {
    target.setAttribute("disabled", "");
  } else {
    target.removeAttribute("disabled");
  }
}

function setMessage(id, message = "", tone = "warning") {
  const target = element(id);
  if (!target) return;
  target.textContent = message;
  target.dataset.tone = tone;
}

function setAppNotice(message = "") {
  toggle("app-notice", Boolean(message));
  text("app-notice-text", message);
}

function humanError(error) {
  if (error?.code === "WALLET_REJECTED") return "The wallet request was cancelled. Nothing changed.";
  if (error?.code === "WALLET_MISSING") return "Wallet connection is unavailable. Reconnect your wallet.";
  if (error?.code === "WRONG_CODE") return "A candidate account failed verification. Capital actions are paused for safety.";
  if (error?.code === "UNVERIFIED_CANDIDATE") return "VILLA found a contract associated with this wallet, but could not verify it as a valid VILLA account. Creating another account is disabled until verification succeeds.";
  if (error?.code === "WRONG_OWNER") return "This account belongs to another wallet. Capital actions are paused.";
  if (error?.code === "DISCOVERY_UNAVAILABLE") return "Account lookup unavailable. VILLA could not verify this wallet's account. Creating another account is disabled until verification succeeds.";
  if (error?.code === "DISCOVERY_TIMEOUT") return "Account lookup timed out. Creating another account is disabled until verification succeeds.";
  if (error?.code === "NETWORK_UNKNOWN") return "Somnia Shannon is not available in this wallet yet.";
  if (error?.code === "WRONG_NETWORK") return "Switch to Somnia Shannon.";
  if (error?.code === "RPC_ERROR") return "The wallet or network could not complete that request. Your funds are safe.";
  if (error?.code === "MIN_DEPOSIT") return error.message;
  if (error?.code === "MIN_TOP_UP") return error.message;
  if (error?.code === "CAPITAL_BELOW_STRATEGY_FLOOR") return "Add at least " + formatRawExact(MIN_STRATEGY_CAPITAL_RAW) + " tUSDC before starting the bounded strategy.";
  if (error?.code === "ACCOUNT_STATE_INVALID") return error.message;
  if (error?.code === "ACTION_BUSY") return "A liquidity action is already in progress. Please wait.";
  if (error?.code === "ACCOUNT_NOT_READY") return "Your VILLA account is not ready. Refresh account verification and try again.";
  if (error?.code === "CONTROL_UNAVAILABLE") return "The safe strategy control service is unavailable. Your account and funds are unchanged.";
  if (error?.code === "PUBLIC_CONTROL_PLANE_DISABLED") return "Strategy control is not enabled for this public release. Your account and funds are unchanged.";
  if (error?.code === "EXECUTION_DISABLED") return "Safe mode is active. No strategy session or writer was started.";
  if (error?.code === "SESSION_REQUIRED") return "Connect your owner wallet to continue.";
  if (error?.code === "ACCOUNT_PREFLIGHT_BLOCKED") return "The account preflight did not pass. No strategy session was started.";
  if (error?.code === "SIGNATURE_FAILED") return "The wallet signature could not be completed. Nothing changed.";
  if (error?.code === "OPERATOR_UNAVAILABLE") return "VILLA operator configuration is unavailable. Retry.";
  if (error?.code === "INVALID_OWNER") return "Connect your wallet before adding liquidity.";
  if (error?.code === "INVALID_AMOUNT") return error.message;
  if (error?.code === "INSUFFICIENT_FUNDS") return "Your wallet does not have enough tUSDC.";
  return error?.message || "The action could not be completed. Your funds are safe.";
}

function showTransaction(state, title, copy, detail = "") {
  setAppState({ transactionStatus: state });
  text("transaction-state", state);
  text("transaction-title", title);
  text("transaction-copy", copy);
  text("transaction-detail", detail || "No transaction hash yet.");
  const pill = element("transaction-state");
  if (pill) {
    pill.className = "status-pill";
    pill.classList.add(state === "SUCCESS" ? "status-safe" : state === "FAILED" ? "status-error" : "status-preview");
  }
}

function actionUpdate(state, hash = "") {
  if (state === "WAITING_FOR_WALLET") showTransaction(state, "Waiting for your wallet", "Review the VILLA action in your wallet, then confirm if it looks right.", "");
  if (state === "SUBMITTED") showTransaction(state, "Transaction submitted", "Shannon received the transaction. Waiting for confirmation.", hash);
  if (state === "CONFIRMING") showTransaction(state, "Confirming on Shannon", "The transaction is being checked on-chain. Keep this tab open.", hash);
  if (state === "SUCCESS") showTransaction(state, "Transaction confirmed", "The account state was verified on-chain.", hash);
}

function showActionError(formId, error) {
  const detail = error?.detail || error?.message || String(error);
  showTransaction("FAILED", "Nothing changed", humanError(error), detail);
  setMessage(formId, humanError(error));
}

function requireVerifiedOwnerAction(formId, action) {
  if (appState.busy) {
    showActionError(formId, new AccountClientError("ACTION_BUSY", `A transaction is already pending. Please wait before ${action}.`));
    return false;
  }
  if (!provider?.request) {
    showActionError(formId, new AccountClientError("WALLET_MISSING", "Wallet connection is unavailable. Reconnect your wallet."));
    return false;
  }
  if (!isVerifiedOwnerAccountReady(appState)) {
    showActionError(formId, new AccountClientError("ACCOUNT_NOT_READY", `Your VILLA account is not ready. Refresh account verification before ${action}.`));
    return false;
  }
  return true;
}

function hintKey(owner) {
  return `${ACCOUNT_HINT_PREFIX}${normalizeAddress(owner)}`;
}

function readHint(owner) {
  try {
    return localStorage.getItem(hintKey(owner)) || "";
  } catch {
    return "";
  }
}

function writeHint(owner, account) {
  try {
    localStorage.setItem(hintKey(owner), account);
  } catch {
    // On-chain discovery remains authoritative if browser storage is unavailable.
  }
}

function setConnected(connected) {
  if (!connected) {
    setAppState({
      owner: "",
      currentAccountAddress: "",
      chainId: null,
      chainStatus: "UNKNOWN",
      discoveryStatus: "IDLE",
      controlState: "STOPPED",
      controlBusy: false,
      account: null,
      accounts: [],
      walletBalance: 0n,
      transactionStatus: "IDLE",
      error: null,
    });
  } else {
    setAppState({});
  }
  debugDiscovery("wallet_state_assignment", { wallet: connected ? appState.owner : "", connected, walletState: appState.walletStatus });
}

function setDiscoveryState(state) {
  const normalized = ["IDLE", "DISCOVERING", "NO_ACCOUNT", "DISCOVERED", "DISCOVERY_ERROR", "SECURITY_ERROR"].includes(state) ? state : "IDLE";
  debugDiscovery("discovery_state_assignment", { state: normalized });
  return setAppState({
    discoveryStatus: normalized,
    error: ["DISCOVERY_ERROR", "SECURITY_ERROR"].includes(normalized) ? appState.error : null,
  });
}

function setAppState(patch) {
  appState = { ...appState, ...patch };
  appState.walletStatus = deriveWalletStatus(appState);
  publishReadinessDebug(appState);
  const rendered = renderAccountJourney(document, appState);
  debugDiscovery("final_render_state", {
    state: rendered.discoveryState,
    walletState: rendered.walletStatus,
    visiblePanels: rendered.visiblePanels,
  });
  return rendered;
}

function accountReadyForControl() {
  return Boolean(appState.account)
    && isVerifiedOwnerAccountReady(appState)
    && isStrategyCapitalReady(appState)
    && appState.account.operator === normalizeAddress(VILLA_ACCOUNT_CONFIG.operator)
    && appState.account.balance > 0n;
}

function controlStateLabel(state) {
  return ({ STARTING: "Preparing", RUNNING: "Running", PAUSED: "Paused", STOPPING: "Stopping", ERROR: "Needs attention", STOPPED: "Ready to start", STOPPED_CLEAN: "Stopped", STOPPED_SETTLEMENT_PENDING: "Settlement pending", SETTLEMENT_READY: "Settlement ready", SETTLING: "Settling", SETTLED: "Settled", WITHDRAWABLE: "Withdrawable" })[state] || "Ready to start";
}

function renderControlControls() {
  ensureUatMonitor();
  const state = appState.controlState || "STOPPED";
  const strategyButtons = document.querySelector(".strategy-buttons");
  if (strategyButtons && !element("settle-villa")) {
    const settle = document.createElement("button");
    settle.className = "button button-secondary";
    settle.id = "settle-villa";
    settle.type = "button";
    settle.textContent = "Settle";
    settle.addEventListener("click", handleSettleStrategy);
    strategyButtons.append(settle);
  }
  const active = ["STARTING", "RUNNING", "PAUSED", "STOPPING", "SETTLEMENT_READY", "SETTLING"].includes(state);
  const stoppable = active || state === "ERROR";
  const ready = accountReadyForControl();
  const start = element("start-villa");
  const settle = element("settle-villa");
  const stop = element("stop-villa");
  const status = element("control-plane-status");
  text("strategy-market", strategyMarketLabel());
  text("control-state", controlStateLabel(state));
  if (start) syncButtonDisabled(start, !ready || appState.busy || appState.controlBusy || active);
  const settlementReady = ["STOPPED_SETTLEMENT_PENDING", "SETTLEMENT_READY"].includes(state);
  toggle("settle-villa", settlementReady);
  if (settle) syncButtonDisabled(settle, appState.busy || appState.controlBusy || state === "SETTLING");
  toggle("stop-villa", stoppable);
  if (stop) syncButtonDisabled(stop, appState.busy || appState.controlBusy || state === "STOPPING");
  if (status) {
    status.className = `status-pill ${active ? "status-safe" : "status-preview"}`;
    status.textContent = active ? state : state === "ERROR" ? "ATTENTION" : "ACCOUNT-BOUND CONTROL";
  }
  text("control-plane-copy", "Start and Stop use the wallet-authenticated, account-bound control plane. The browser never signs engine transactions. Account execution is deployment-gated and only verified owner-bound sessions can start.");
}

function controlClientForWallet() {
  controlClient ??= createAccountControlClient({ provider, ownerProvider: () => appState.owner, accountProvider: () => appState.currentAccountAddress });
  return controlClient;
}

function clearControlPoll() {
  if (controlPollTimer) clearTimeout(controlPollTimer);
  controlPollTimer = null;
}

function scheduleControlPoll() {
  clearControlPoll();
  const active = ["STARTING", "RUNNING", "PAUSED", "STOPPING", "SETTLEMENT_READY", "SETTLING"].includes(String(appState.controlState || "").toUpperCase());
  if (!active || !provider || !appState.owner) return;
  controlPollTimer = setTimeout(() => { void refreshControlState(); }, 5_000);
}

async function refreshControlState() {
  if (!provider || !appState.owner || !appState.currentAccountAddress || !controlClient) return;
  try {
    const payload = await controlClient.state();
    const state = String(payload?.state || payload?.session?.state || "STOPPED").toUpperCase();
    const session = payload?.session || appState.controlSession;
    appState = { ...appState, controlState: state, controlSession: session, controlSnapshot: payload?.snapshot ?? appState.controlSnapshot, controlResult: payload?.result ?? appState.controlResult, controlBusy: false };
    renderControlControls();
    renderUatMonitor({ state, session, snapshot: appState.controlSnapshot, result: appState.controlResult });
    renderLiveCapital(appState.controlSnapshot);
    if (["STARTING", "RUNNING", "PAUSED", "STOPPING", "SETTLEMENT_READY", "SETTLING"].includes(state)) scheduleControlPoll(); else clearControlPoll();
  } catch (error) {
    if (["STARTING", "RUNNING", "PAUSED", "STOPPING", "SETTLEMENT_READY", "SETTLING"].includes(String(appState.controlState || "").toUpperCase())) {
      setMessage("control-message", error?.message || "Live session status is temporarily unavailable.");
      scheduleControlPoll();
    }
  }
}
function renderLiveCapital(snapshot) {
  if (!snapshot) return;
  try {
    if (snapshot.collateralRaw !== null && snapshot.collateralRaw !== undefined) text("available-balance", `${formatRawExact(BigInt(snapshot.collateralRaw))} tUSDC`);
    if (snapshot.deployedRaw !== null && snapshot.deployedRaw !== undefined) text("deployed-balance", `${formatRawExact(BigInt(snapshot.deployedRaw))} tUSDC`);
    text("pending-settlement-balance", snapshot.pendingSettlement ? `${formatRawExact(BigInt(snapshot.yesRaw ?? 0))} tUSDC` : "0.000 tUSDC");
  } catch {
    // A malformed public snapshot never replaces the verified account balance.
  }
}
function setControlView(state, copy = "", result = null) {
  const session = result?.session ?? (result?.marketSeries || result?.currentMarketId ? result : null);
  appState = { ...appState, controlState: String(state || "STOPPED").toUpperCase(), controlBusy: false, controlSession: session || appState.controlSession, controlSnapshot: result?.snapshot ?? appState.controlSnapshot, controlResult: result?.result ?? appState.controlResult };
  renderControlControls();
  renderUatMonitor({ state: appState.controlState, session: appState.controlSession, snapshot: appState.controlSnapshot, result: appState.controlResult });
  scheduleControlPoll();
  renderLiveCapital(appState.controlSnapshot);
  if (copy) setMessage("control-message", copy, state === "ERROR" ? "warning" : "safe");
}

async function handleStartStrategy() {
  if (appState.busy || appState.controlBusy) return;
  if (!accountReadyForControl()) {
    const error = new AccountClientError("ACCOUNT_NOT_READY", "Your VILLA account is not ready.");
    showActionError("control-message", error);
    return;
  }
  appState = { ...appState, controlBusy: true };
  renderControlControls();
  setBusy(true);
  setMessage("control-message", "");
  showTransaction("READY", "Preparing strategy", "The control plane will authenticate this owner wallet and run the account-bound preflight.");
  try {
    const result = await controlClientForWallet().start();
    const nextState = String(result.state || "RUNNING").toUpperCase();
    setControlView(nextState, "Strategy control accepted.", result);
    showTransaction("SUCCESS", "Strategy control accepted", "The account-bound control plane returned a safe session state.");
  } catch (error) {
    setControlView("STOPPED");
    showActionError("control-message", error instanceof ControlClientError ? error : new ControlClientError("CONTROL_REQUEST_FAILED", error?.message || "The strategy control request failed."));
  } finally {
    setBusy(false);
    renderControlControls();
  }
}

async function handleStopStrategy() {
  if (appState.busy || appState.controlBusy) return;
  appState = { ...appState, controlBusy: true };
  renderControlControls();
  setBusy(true);
  setMessage("control-message", "");
  showTransaction("READY", "Stopping strategy", "New expansion will stop before the account-bound cleanup path runs.");
  try {
    const result = await controlClientForWallet().stop();
    setControlView(String(result.state || "STOPPED").toUpperCase(), "Strategy stopped. Capital remains in your VILLA account.", result);
    showTransaction("SUCCESS", "Strategy stopped", "The control plane stopped the session. Withdrawal remains a separate owner action.");
  } catch (error) {
    setControlView(appState.controlState === "STOPPING" ? "STOPPING" : "ERROR");
    showActionError("control-message", error instanceof ControlClientError ? error : new ControlClientError("CONTROL_REQUEST_FAILED", error?.message || "The strategy stop request failed."));
  } finally {
    setBusy(false);
    renderControlControls();
  }
}

async function handleSettleStrategy() {
  if (appState.busy || appState.controlBusy) return;
  appState = { ...appState, controlBusy: true };
  renderControlControls();
  setBusy(true);
  setMessage("control-message", "");
  showTransaction("READY", "Settling strategy", "The private account-bound settlement path is checking the exact market and claims.");
  try {
    const result = await controlClientForWallet().settle();
    const nextState = String(result.state || "SETTLED").toUpperCase();
    setControlView(nextState, nextState === "SETTLED" ? "Settlement confirmed. You can withdraw from your VILLA account." : "Settlement remains pending until the market is resolved.", result);
    showTransaction(nextState === "SETTLED" ? "SUCCESS" : "CONFIRMING", nextState === "SETTLED" ? "Settlement confirmed" : "Settlement pending", nextState === "SETTLED" ? "The account-bound settlement state was verified." : "No claim was sent while the market remained unresolved.");
  } catch (error) {
    setControlView("ERROR");
    showActionError("control-message", error instanceof ControlClientError ? error : new ControlClientError("CONTROL_REQUEST_FAILED", error?.message || "The settlement request failed."));
  } finally {
    setBusy(false);
    renderControlControls();
  }
}
function resetAccountView() {
  setAppState({
    account: null,
    accounts: [],
    walletBalance: 0n,
    currentAccountAddress: "",
    discoveryStatus: "IDLE",
    transactionStatus: "IDLE",
    error: null,
  });
}

function setNetworkState(chainId) {
  const correct = chainId === VILLA_CHAIN.id;
  setAppState({
    chainId,
    chainStatus: correct ? "SHANNON" : "WRONG_NETWORK",
    discoveryStatus: correct ? appState.discoveryStatus : "IDLE",
    ...(correct ? {} : { account: null, accounts: [], walletBalance: 0n, currentAccountAddress: "" }),
    error: null,
  });
  debugDiscovery("chain_id_observed", { chainId, networkCorrect: correct });
  return correct;
}

function walletContextIsCurrent(owner, generation) {
  const current = generation === refreshGeneration && appState.owner === owner;
  if (!current) debugDiscovery("stale_context_invalidation", {
    discoveryJob: generation,
    wallet: owner,
    currentWallet: appState.owner,
    currentGeneration: refreshGeneration,
  });
  return current;
}

function setBusy(busy) {
  setAppState({ busy });
  document.querySelectorAll("#account-workspace button, #create-account, #switch-network, #retry-account").forEach((button) => {
    if (button.id === "start-villa") return;
    syncButtonDisabled(button, busy);
  });
  renderAccountJourney(document, appState);
  renderControlControls();
}

function accountVersionOf(account) {
  return Number(account?.accountVersion ?? account?.version ?? 0);
}

function currentAccounts() {
  if (Array.isArray(appState.accounts) && appState.accounts.length) return appState.accounts;
  return appState.account ? [appState.account] : [];
}

function mergeAccount(updated) {
  const address = normalizeAddress(updated?.address);
  return [...currentAccounts().filter((account) => normalizeAddress(account?.address) !== address), updated]
    .sort((left, right) => accountVersionOf(right) - accountVersionOf(left));
}

function renderAccountSelector(accounts, account) {
  const selector = element("account-selector");
  if (!selector) return;
  selector.replaceChildren();
  for (const candidate of accounts) {
    const option = document.createElement("option");
    option.value = candidate.address;
    option.textContent = `V${accountVersionOf(candidate)} ${accountVersionOf(candidate) === 1 ? "legacy" : "autonomous"} · ${shorten(candidate.address)}`;
    selector.append(option);
  }
  selector.value = account?.address || "";
  toggle("account-selector-wrap", accounts.length > 1);
}

function renderMigrationPanel(accounts, account) {
  const v1 = accounts.find((candidate) => accountVersionOf(candidate) === 1);
  const v2 = accounts.find((candidate) => accountVersionOf(candidate) === 2);
  toggle("account-migration", Boolean(v1));
  if (!v1) return;
  text("migration-v1-address", shorten(v1.address));
  text("migration-v1-balance", formatStrategyAmount(v1.balance));
  text("migration-v2-status", v2 ? "V2 VERIFIED" : "V2 AVAILABLE");
  text("migration-copy", v2
    ? "V2 is verified as the preferred autonomous target. V1 remains visible, owner-controlled, and available for recovery."
    : "V1 remains funded and intact. Create and verify an empty V2 before deciding whether to migrate funds.");
  const create = element("create-v2-account");
  if (create) syncButtonDisabled(create, appState.busy || Boolean(v2) || !account);
}

function updateWorkspace(account, walletBalance) {
  const readinessEvaluation = evaluateVerifiedOwnerAccountReadiness({ ...appState, account });
  const accountReady = readinessEvaluation.ready;
  publishReadinessDebug({ ...appState, account });
  debugLiquidity("account_readiness_check", readinessEvaluation);
  const allocated = account.balance;
  const funded = allocated > 0n;
  const accountVersion = accountVersionOf(account);
  const isV2 = accountVersion === 2;
  const strategyCapitalReady = isStrategyCapitalReady({ account });
  const authorized = account.operator === normalizeAddress(VILLA_ACCOUNT_CONFIG.operator);
  const unexpectedOperator = account.operator !== ZERO_ADDRESS && !authorized;
  text("account-address", shorten(account.address));
  text("account-owner", shorten(account.owner));
  text("account-version", `VillaAccount V${accountVersion || "?"}`);
  text("account-verification", isV2 ? "Owner verified · V2" : "Owner verified · V1 legacy");
  text("wallet-balance", `${formatAmount(walletBalance)} tUSDC`);
  text("allocated-balance", `${formatStrategyAmount(allocated)} tUSDC`);
  text("available-balance", `${formatStrategyAmount(allocated)} tUSDC`);
  text("withdrawable-balance", `${formatAmount(allocated)} tUSDC`);
  text("withdrawable-inline", `${formatAmount(allocated)} tUSDC`);
  text("strategy-allocated", `${formatStrategyAmount(allocated)} tUSDC`);
  text("minimum-deposit-label", funded ? "Minimum top-up" : "Minimum initial deposit");
  text("minimum-deposit", formatRawExact(funded ? MIN_TOP_UP_RAW : MIN_INITIAL_DEPOSIT_RAW));
  toggle("phase3b1-diagnostics", DEBUG_ENABLED && funded);
  if (DEBUG_ENABLED && funded) {
    text("phase3b1-target", `${formatRawExact(PHASE_3B1_MAX_ACCOUNT_CAPITAL_RAW)} tUSDC`);
    const additional = PHASE_3B1_MAX_ACCOUNT_CAPITAL_RAW > allocated ? PHASE_3B1_MAX_ACCOUNT_CAPITAL_RAW - allocated : 0n;
    text("phase3b1-additional", `${formatRawExact(additional)} tUSDC`);
    text("phase3b1-strategy-floor", `${formatRawExact(MIN_STRATEGY_CAPITAL_RAW)} tUSDC`);
  }
  text("advanced-account", account.address);
  text("advanced-operator", VILLA_ACCOUNT_CONFIG.operator);
  const accounts = currentAccounts();
  renderAccountSelector(accounts, account);
  renderMigrationPanel(accounts, account);

  const authStatus = element("authorization-status");
  if (authStatus) {
    authStatus.className = `status-pill ${authorized ? "status-safe" : "status-preview"}`;
    authStatus.textContent = authorized ? "AUTHORIZED" : unexpectedOperator ? "UNRECOGNIZED" : "NOT AUTHORIZED";
  }
  text("authorization-copy", !isV2
    ? "This is a V1 VillaAccount. V1 cannot run bounded autonomous trading, but it remains owner-controlled and withdrawable. Create and verify an empty V2 before moving any funds."
    : authorized
      ? "Your wallet is verified. VILLA uses a private account-bound operator for approved DreamDEX liquidity actions. Only your wallet can withdraw."
      : unexpectedOperator
        ? "This account has a different automation address. VILLA actions are paused until you review it."
        : "VILLA is not authorized to use this account.");
  toggle("authorize-villa", isV2 && accountReady && !authorized && !unexpectedOperator);
  toggle("revoke-villa", accountReady && authorized);

  const ready = isV2 && accountReady && authorized && strategyCapitalReady;
  const readinessStatus = element("readiness-status");
  if (readinessStatus) {
    readinessStatus.className = `status-pill ${ready ? "status-safe" : "status-preview"}`;
    readinessStatus.textContent = ready ? "READY" : "SETUP REQUIRED";
  }
  text("readiness-title", !isV2 ? "V1 remains recoverable." : ready ? "Liquidity setup complete." : !strategyCapitalReady ? "Add strategy capital first." : "Complete account setup first.");
  text("readiness-copy", !isV2
    ? "V1 remains funded and recoverable. Create and verify an empty V2 before deciding whether to migrate funds."
    : ready ? "Your account is ready. Start asks the constrained control plane to run a fresh account-bound preflight."
      : !strategyCapitalReady ? "Add at least " + formatRawExact(MIN_STRATEGY_CAPITAL_RAW) + " tUSDC so the reserve remains intact after the venue-minimum complete-set mint."
        : "Add liquidity and authorize VILLA before the workspace can be marked ready.");
  const capitalStatus = element("capital-status");
  if (capitalStatus) {
    capitalStatus.className = `status-pill ${accountReady ? "status-safe" : "status-preview"}`;
    capitalStatus.textContent = accountReady ? "ACCOUNT READY" : "SETUP REQUIRED";
  }
  const canManageCapital = accountReady && !appState.busy;
  if (canManageCapital) {
    element("add-liquidity")?.removeAttribute("disabled");
    element("withdraw-capital")?.removeAttribute("disabled");
  } else {
    element("add-liquidity")?.setAttribute("disabled", "");
    element("withdraw-capital")?.setAttribute("disabled", "");
  }
  renderControlControls();
}

function showDiscoveryError(error) {
  const discoveryStatus = error?.code === "UNVERIFIED_CANDIDATE" ? "SECURITY_ERROR" : "DISCOVERY_ERROR";
  setAppState({ account: null, accounts: [], walletBalance: 0n, currentAccountAddress: "", discoveryStatus, transactionStatus: "IDLE", error });
  debugDiscovery("discovery_error", { lastDiscoveryError: error?.code || "UNKNOWN" });
  setAppNotice("");
  setMessage("wallet-message", "");
  setMessage("account-error-message", error?.code === "UNVERIFIED_CANDIDATE"
    ? "Account verification was blocked. Retry after checking the connected wallet and network."
    : error?.code === "DISCOVERY_TIMEOUT"
      ? "The lookup timed out. Retry when Shannon is available."
      : "The last lookup could not complete. Retry when Shannon is available.");
}

async function runAccountRefresh(owner, generation) {
  resetAccountView();
  const onDebug = (event, details = {}) => debugDiscovery(event, { discoveryJob: generation, ...details });
  const deadline = createDiscoveryDeadline(DISCOVERY_TIMEOUT_MS, onDebug);
  onDebug("discovery_job_start", { wallet: owner });
  try {
    const chainId = await getChainId(provider, { deadline });
    if (!walletContextIsCurrent(owner, generation)) return;
    if (!setNetworkState(chainId)) {
      setAppNotice("");
      setMessage("network-message", "Switch networks to continue.");
      return;
    }
    setDiscoveryState("DISCOVERING");
    accountArtifact ??= await loadArtifact({ deadline });
    accountArtifacts ??= await loadAccountArtifacts({ deadline });
    if (!walletContextIsCurrent(owner, generation)) return;
    const result = await discoverAccount(provider, owner, accountArtifacts, readHint(owner), { deadline, onDebug });
    onDebug("discovery_result", { discoveryKind: result.kind, discoverySource: result.source, accountFound: Boolean(result.account) });
    if (!walletContextIsCurrent(owner, generation)) return;
    if (result.kind === "ERROR") {
      showDiscoveryError(result.error);
      return;
    }
    if (result.kind === "NO_ACCOUNT") {
      setDiscoveryState("NO_ACCOUNT");
      return;
    }
    if (result.kind === "SECURITY_ERROR") {
      showDiscoveryError(result.error);
      return;
    }
    writeHint(owner, result.account.address);
    const walletBalance = await readTokenBalance(provider, owner, { deadline });
    if (!walletContextIsCurrent(owner, generation)) return;
    const accounts = Array.isArray(result.accounts) ? result.accounts : [result.account];
    setAppState({ account: result.account, accounts, walletBalance, currentAccountAddress: result.account.address, discoveryStatus: "DISCOVERED", error: null });
    updateWorkspace(result.account, walletBalance);
    setMessage("capital-message", "");
    setMessage("withdraw-message", "");
    setMessage("authorization-message", "");
  } catch (error) {
    if (!walletContextIsCurrent(owner, generation)) return;
    onDebug("discovery_failed", { lastDiscoveryError: error?.code || "UNKNOWN" });
    showDiscoveryError(error);
  } finally {
    deadline.cancel();
    onDebug("discovery_job_end", { finalState: appState.discoveryStatus, walletState: appState.walletStatus });
  }
}

function refreshAccount() {
  if (!provider || !appState.owner) return Promise.resolve();
  const owner = appState.owner;
  const generation = ++refreshGeneration;
  if (accountRefreshInFlight) {
    refreshQueued = true;
    resetAccountView();
    return accountRefreshInFlight;
  }

  const run = runAccountRefresh(owner, generation);
  let settled;
  settled = run.finally(() => {
    if (accountRefreshInFlight === settled) accountRefreshInFlight = null;
    if (refreshQueued) {
      refreshQueued = false;
      if (provider && appState.owner) void refreshAccount();
    }
  });
  accountRefreshInFlight = settled;
  return settled;
}

async function connectWallet(accounts = null) {
  provider = window.ethereum;
  if (!provider?.request) throw new AccountClientError("WALLET_MISSING", "Install or unlock a compatible wallet to continue.");
  const selected = accounts ? await accounts : await request(provider, "eth_requestAccounts");
  const owner = normalizeAddress(selected?.[0]);
  if (!owner) {
    debugDiscovery("wallet_address_missing");
    throw new AccountClientError("INVALID_OWNER", "The wallet did not return a valid account.");
  }
  if (appState.owner && appState.owner !== owner) {
    refreshGeneration += 1;
    resetAccountView();
  }
  appState = {
    ...appState,
    owner,
    chainId: null,
    chainStatus: "UNKNOWN",
    discoveryStatus: "IDLE",
    account: null,
    accounts: [],
    walletBalance: 0n,
    controlSession: null,
    controlSnapshot: null,
    controlResult: null,
    currentAccountAddress: "",
    transactionStatus: "IDLE",
    error: null,
  };
  setConnected(true);
  debugDiscovery("wallet_connected", { wallet: owner });
  text("wallet-address", shorten(owner));
  setMessage("wallet-message", "");
  setAppNotice("");
  await refreshAccount();
}

function disconnectWallet() {
  refreshGeneration += 1;
  refreshQueued = false;
  clearControlPoll();
  controlClient?.clear();
  setConnected(false);
  setMessage("wallet-message", "Wallet view disconnected. Your wallet remains in control.", "safe");
}

async function handleConnect() {
  const button = element("connect-wallet");
  if (button) { button.disabled = true; button.textContent = "Connecting..."; }
  try {
    await connectWallet();
  } catch (error) {
    setMessage("wallet-message", humanError(error));
  } finally {
    if (button) { button.disabled = false; button.textContent = "Connect wallet"; }
  }
}

async function handleSwitchNetwork() {
  if (appState.busy || !provider || !appState.owner) return;
  const ownerAtStart = appState.owner;
  setBusy(true);
  setMessage("network-message", "");
  try {
    showTransaction("WAITING_FOR_WALLET", "Switching network", "Confirm the Somnia Shannon network in your wallet.");
    const result = await ensureShannon(provider);
    if (ownerAtStart !== appState.owner) return;
    if (result.chainId !== VILLA_CHAIN.id) throw new AccountClientError("WRONG_NETWORK", "Switch to Somnia Shannon before continuing.");
    showTransaction("SUCCESS", "Network ready", "Your wallet is now on Somnia Shannon.");
    await refreshAccount();
  } catch (error) {
    if (ownerAtStart !== appState.owner) return;
    setMessage("network-message", humanError(error));
    showActionError("network-message", error);
    setAppState({ discoveryStatus: "IDLE", account: null, accounts: [], walletBalance: 0n, currentAccountAddress: "", error });
    try {
      setNetworkState(await getChainId(provider));
    } catch {
      // Keep the actionable wrong-network panel visible when the wallet cannot answer.
      setAppState({ chainStatus: "WRONG_NETWORK", chainId: null, discoveryStatus: "IDLE", account: null, accounts: [], walletBalance: 0n, currentAccountAddress: "" });
    }
  } finally {
    setBusy(false);
  }
}

async function handleCreateV2Account() {
  if (appState.busy || !provider || !appState.owner) return;
  if (currentAccounts().some((account) => accountVersionOf(account) === 2)) {
    showActionError("create-v2-message", new AccountClientError("ACCOUNT_EXISTS", "A verified V2 account is already available for this owner."));
    return;
  }
  const messageId = currentAccounts().some((account) => accountVersionOf(account) === 1) ? "create-v2-message" : "create-message";
  setBusy(true);
  setMessage(messageId, "");
  try {
    const chainId = await getChainId(provider);
    if (!setNetworkState(chainId)) throw new AccountClientError("WRONG_NETWORK", "Switch to Somnia Shannon before creating your account.");
    accountArtifact ??= await loadArtifact();
    const data = buildDeploymentData(accountArtifact, appState.owner);
    const { hash, receipt } = await sendTransaction(provider, deploymentTransaction(appState.owner, data), actionUpdate);
    const accountAddress = normalizeAddress(receipt?.contractAddress);
    if (!accountAddress) throw new AccountClientError("BAD_CHAIN_RESPONSE", "The account deployment confirmed without an account address.", hash);
    showTransaction("CONFIRMING", "Verifying your VILLA account", "Checking code, owner, token wiring, and initial permissions on-chain.", hash);
    const account = await readAccount(provider, accountAddress, accountArtifact, appState.owner);
    if (accountVersionOf(account) !== 2) throw new AccountClientError("ACCOUNT_VERSION_MISMATCH", "The new account did not match the verified V2 implementation.", hash);
    if (account.operator !== ZERO_ADDRESS) throw new AccountClientError("UNEXPECTED_OPERATOR", "The new account did not start with automation disabled.", hash);
    const accounts = mergeAccount(account);
    writeHint(appState.owner, account.address);
    const walletBalance = await readTokenBalance(provider, appState.owner);
    setAppState({ account, accounts, walletBalance, currentAccountAddress: account.address, discoveryStatus: "DISCOVERED", error: null });
    updateWorkspace(account, walletBalance);
    showTransaction("SUCCESS", "V2 VILLA account created", "Your wallet deployed and verified V2. VILLA automation remains unauthorized.", hash);
    setMessage(messageId, currentAccounts().some((candidate) => accountVersionOf(candidate) === 1)
      ? "V2 created and verified. V1 remains unchanged and owner-withdrawable."
      : "V2 account created and verified.", "safe");
  } catch (error) {
    showActionError(messageId, error);
  } finally {
    setBusy(false);
  }
}

function handleSelectAccount(event) {
  if (appState.busy) return;
  const selectedAddress = normalizeAddress(event?.target?.value);
  const selected = currentAccounts().find((candidate) => normalizeAddress(candidate?.address) === selectedAddress);
  if (!selected) return;
  clearControlPoll();
  controlClient?.clear();
  setAppState({ account: selected, currentAccountAddress: selected.address, controlState: "STOPPED", controlBusy: false, controlSession: null, controlSnapshot: null, controlResult: null, error: null });
  updateWorkspace(selected, appState.walletBalance ?? 0n);
}

function showLiquidityStage(stage, amount = 0n, hash = "") {
  const value = amount ? formatRawExact(amount) : "the requested";
  if (stage === "PREPARING") showTransaction("READY", "Preparing liquidity", "Checking the amount, network, account, and wallet balance.");
  if (stage === "APPROVAL_READY") showTransaction("READY", `Approve ${value} tUSDC`, "Your wallet will approve this exact amount for your VILLA account only.");
  if (stage === "APPROVAL_CONFIRMING") showTransaction("CONFIRMING", "Waiting for approval", "Verifying the exact allowance before deposit.", hash);
  if (stage === "DEPOSIT_READY") showTransaction("READY", `Deposit ${value} tUSDC`, "Your wallet will deposit this amount into your verified VILLA account.");
  if (stage === "DEPOSIT_CONFIRMING") showTransaction("CONFIRMING", "Waiting for deposit", "Checking the wallet decrease, account increase, owner, and operator on-chain.", hash);
}

function liquidityTransactionUpdate(state, hash = "", phase = "deposit") {
  const label = phase === "approval" ? "approval" : "deposit";
  if (state === "WAITING_FOR_WALLET") showTransaction(state, `Waiting for ${label}`, `Review the exact ${label} request in your wallet, then confirm if it looks right.`);
  if (state === "SUBMITTED") showTransaction(state, `${label[0].toUpperCase()}${label.slice(1)} submitted`, `Shannon received the ${label} request. Waiting for confirmation.`, hash);
  if (state === "CONFIRMING") showTransaction(state, `Waiting for ${label}`, `The ${label} transaction is being checked on-chain. Keep this tab open.`, hash);
  if (state === "SUCCESS") showTransaction(state, `${label[0].toUpperCase()}${label.slice(1)} confirmed`, `The ${label} was confirmed on Shannon.`, hash);
}

const handleAddLiquidity = createAddLiquidityHandler({
  getContext: () => ({
    provider,
    owner: appState.owner,
    account: appState.account,
    currentAccountAddress: appState.currentAccountAddress,
    accountArtifact: accountArtifacts ?? accountArtifact,
    rawInput: element("amount-to-use")?.value ?? "",
    chainId: appState.chainId,
    chainStatus: appState.chainStatus,
    discoveryStatus: appState.discoveryStatus,
    busy: appState.busy,
    transactionStatus: appState.transactionStatus,
    setNetworkState,
    onStage: showLiquidityStage,
    onTransactionUpdate: liquidityTransactionUpdate,
    onDebug: debugLiquidity,
    runAddLiquidity,
  }),
  run: (context) => runAddLiquidity(context),
  isReady: (context) => isVerifiedOwnerAccountReady(context),
  setBusy,
  onStart: () => setMessage("capital-message", ""),
  onDebug: debugLiquidity,
  onError: (error) => showActionError("capital-message", error),
  onSuccess: ({ amount, walletAfter, accountAfter, hash }) => {
    const accounts = mergeAccount(accountAfter);
    setAppState({ account: accountAfter, accounts, walletBalance: walletAfter, currentAccountAddress: accountAfter.address, discoveryStatus: "DISCOVERED", error: null });
    updateWorkspace(accountAfter, walletAfter);
    showTransaction("SUCCESS", "Liquidity added", `${formatRawExact(amount)} tUSDC is now held by your VILLA account.`, hash);
    setMessage("capital-message", `Liquidity added: ${formatRawExact(amount)} tUSDC.`, "safe");
    element("amount-to-use").value = "";
  },
});

const handleAuthorize = createAuthorizationHandler({
  getContext: () => ({
    provider,
    owner: appState.owner,
    account: appState.account,
    currentAccountAddress: appState.currentAccountAddress,
    accountArtifact: accountArtifacts ?? accountArtifact,
    operator: VILLA_ACCOUNT_CONFIG.operator,
    chainId: appState.chainId,
    chainStatus: appState.chainStatus,
    discoveryStatus: appState.discoveryStatus,
    transactionStatus: appState.transactionStatus,
    busy: appState.busy,
    onStage: (stage, hash = "") => {
      if (stage === "READY") showTransaction("READY", "Authorize VILLA", "VILLA may use this account for approved DreamDEX liquidity actions. VILLA cannot withdraw your funds.");
      if (stage === "CONFIRMING") showTransaction("CONFIRMING", "Verifying VILLA authorization", "Checking the operator address on-chain.", hash);
    },
    onTransactionUpdate: actionUpdate,
  }),
  run: (context) => runAuthorization(context),
  isReady: (context) => isVerifiedOwnerAccountReady(context),
  setBusy,
  onStart: () => setMessage("authorization-message", ""),
  onDebug: debugAuthorization,
  onError: (error) => showActionError("authorization-message", error),
  onSuccess: async ({ alreadyAuthorized, accountAfter, hash }) => {
    const walletBalance = await readTokenBalance(provider, appState.owner);
    const accounts = mergeAccount(accountAfter);
    setAppState({ account: accountAfter, accounts, walletBalance, currentAccountAddress: accountAfter.address, discoveryStatus: "DISCOVERED", error: null });
    updateWorkspace(accountAfter, walletBalance);
    if (alreadyAuthorized) {
      setMessage("authorization-message", "VILLA is already authorized.", "safe");
      return;
    }
    showTransaction("SUCCESS", "VILLA authorized", "VILLA can perform approved DreamDEX liquidity actions. Only your wallet can withdraw.", hash);
    setMessage("authorization-message", "VILLA authorization confirmed.", "safe");
  },
});

async function handleRevoke() {
  if (!requireVerifiedOwnerAction("authorization-message", "revoking VILLA")) return;
  setBusy(true);
  setMessage("authorization-message", "");
  try {
    const verified = await readAccount(provider, appState.account.address, accountArtifacts ?? accountArtifact, appState.owner);
    if (verified.operator !== normalizeAddress(VILLA_ACCOUNT_CONFIG.operator)) throw new AccountClientError("NOT_AUTHORIZED", "VILLA is not the current operator.");
    showTransaction("READY", "Revoke VILLA automation", "This stops new VILLA actions for this account. No strategy session is active in this release.");
    const result = await sendTransaction(provider, actionTransaction(appState.owner, appState.account.address, accountCall.revokeOperator()), actionUpdate);
    showTransaction("CONFIRMING", "Verifying revocation", "Checking that the account operator is now zero.", result.hash);
    const after = await readAccount(provider, appState.account.address, accountArtifacts ?? accountArtifact, appState.owner);
    if (after.operator !== ZERO_ADDRESS) throw new AccountClientError("REVOCATION_MISMATCH", "The account operator was not revoked.", result.hash);
    const walletBalance = await readTokenBalance(provider, appState.owner);
    setAppState({ account: after, accounts: mergeAccount(after), walletBalance, currentAccountAddress: after.address, discoveryStatus: "DISCOVERED", error: null });
    updateWorkspace(after, walletBalance);
    showTransaction("SUCCESS", "VILLA revoked", "VILLA can no longer act for this account.", result.hash);
    setMessage("authorization-message", "VILLA revocation confirmed.", "safe");
  } catch (error) {
    showActionError("authorization-message", error);
  } finally {
    setBusy(false);
  }
}

async function handleWithdraw() {
  if (!requireVerifiedOwnerAction("withdraw-message", "withdrawing capital")) return;
  setBusy(true);
  setMessage("withdraw-message", "");
  try {
    const amount = parseAmount(element("withdraw-amount")?.value);
    const verified = await readAccount(provider, appState.account.address, accountArtifacts ?? accountArtifact, appState.owner);
    if (amount > verified.balance) throw new AccountClientError("INSUFFICIENT_FUNDS", "That amount is larger than the available capital in your VILLA account.");
    const walletBefore = await readTokenBalance(provider, appState.owner);
    showTransaction("READY", "Withdraw to your wallet", `Your account will return ${formatAmount(amount)} tUSDC to this connected owner wallet.`);
    const result = await sendTransaction(provider, actionTransaction(appState.owner, appState.account.address, accountCall.withdraw(amount)), actionUpdate);
    showTransaction("CONFIRMING", "Verifying your withdrawal", "Checking the account decrease, wallet increase, and owner on-chain.", result.hash);
    const walletAfter = await readTokenBalance(provider, appState.owner);
    const after = await readAccount(provider, appState.account.address, accountArtifacts ?? accountArtifact, appState.owner);
    if (walletAfter - walletBefore !== amount || verified.balance - after.balance !== amount) throw new AccountClientError("BALANCE_MISMATCH", "The withdrawal did not reconcile to the exact amount. No success was recorded.", result.hash);
    setAppState({ account: after, accounts: mergeAccount(after), walletBalance: walletAfter, currentAccountAddress: after.address, discoveryStatus: "DISCOVERED", error: null });
    updateWorkspace(after, walletAfter);
    showTransaction("SUCCESS", "Capital withdrawn", `${formatAmount(amount)} tUSDC returned to your connected wallet.`, result.hash);
    setMessage("withdraw-message", `Withdrawn: ${formatAmount(amount)} tUSDC.`, "safe");
    element("withdraw-amount").value = "";
  } catch (error) {
    showActionError("withdraw-message", error);
  } finally {
    setBusy(false);
  }
}

function initWallet() {
  if (walletInitialized) return;
  walletInitialized = true;
  provider = window.ethereum;
  element("connect-wallet")?.addEventListener("click", handleConnect);
  element("disconnect-wallet")?.addEventListener("click", disconnectWallet);
  element("switch-network")?.addEventListener("click", handleSwitchNetwork);
  element("refresh-account")?.addEventListener("click", () => refreshAccount().catch((error) => showActionError("wallet-message", error)));
  element("retry-account")?.addEventListener("click", () => refreshAccount().catch((error) => showActionError("account-error-message", error)));
  element("create-account")?.addEventListener("click", handleCreateV2Account);
  element("create-v2-account")?.addEventListener("click", handleCreateV2Account);
  element("account-selector")?.addEventListener("change", handleSelectAccount);
  element("add-liquidity")?.addEventListener("click", handleAddLiquidity);
  element("authorize-villa")?.addEventListener("click", handleAuthorize);
  element("revoke-villa")?.addEventListener("click", handleRevoke);
  element("withdraw-capital")?.addEventListener("click", handleWithdraw);
  element("start-villa")?.addEventListener("click", handleStartStrategy);
  element("stop-villa")?.addEventListener("click", handleStopStrategy);
  element("amount-to-use")?.addEventListener("input", () => setMessage("capital-message", ""));
  element("withdraw-amount")?.addEventListener("input", () => setMessage("withdraw-message", ""));
  provider?.on?.("accountsChanged", (accounts) => {
    if (!accounts?.[0]) disconnectWallet();
    else connectWallet(accounts).catch((error) => showActionError("wallet-message", error));
  });
  provider?.on?.("chainChanged", () => refreshAccount().catch((error) => showActionError("network-message", error)));
  if (provider?.request) connectWallet(request(provider, "eth_accounts")).catch(() => {
    // A passive restore should not make a disconnected wallet look broken.
  });
  renderControlControls();
}

function renderProof(payload) {
  const snapshot = payload?.snapshot ?? {};
  const evidence = payload?.evidence ?? {};
  const facts = Array.isArray(evidence.facts) ? evidence.facts : [];
  const transactions = Array.isArray(evidence.transactions) ? evidence.transactions : [];
  const transactionLabels = Array.isArray(evidence.transactionLabels) ? evidence.transactionLabels : [];
  const steps = Array.isArray(evidence.steps) ? evidence.steps : [];
  const identity = evidence.identity ?? {};
  const events = Array.isArray(snapshot.activity?.events) ? snapshot.activity.events : [];
  const state = snapshot.system?.state || "Unavailable";
  const risk = snapshot.risk?.action || "Unavailable";
  const market = formatMarket(snapshot.market);
  const factsMarkup = facts.length ? facts.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("") : "<li>No recorded facts for this scene.</li>";
  const stepsMarkup = steps.length ? steps.map((step, index) => `<li><strong>${String(index + 1).padStart(2, "0")}</strong><span>${escapeHtml(step)}</span></li>`).join("") : "<li>No plain-language journey was retained for this scene.</li>";
  const eventMarkup = events.length ? events.map((event) => `<li><strong>${escapeHtml(event.type)}</strong><br /><span>${escapeHtml(event.facts?.reason || event.facts?.action || "Recorded checkpoint")}</span></li>`).join("") : "<li>No event timeline retained.</li>";
  const txMarkup = transactions.length ? transactions.map((hash, index) => `<li class="transaction"><strong>${escapeHtml(transactionLabels[index] || `Transaction ${index + 1}`)}</strong><br />${escapeHtml(hash)}</li>`).join("") : "<li>No transaction hashes were retained for this replay.</li>";
  const identityMarkup = identity.account ? `<section class="panel proof-identity"><p class="panel-label">OWNERSHIP BOUNDARY</p><h2>Capital and order owner</h2><div class="identity-compare"><div><span>VillaAccount</span><strong>${escapeHtml(identity.account)}</strong><small>Owns the capital and the DreamDEX order</small></div><div><span>VILLA operator</span><strong>${escapeHtml(identity.operator || "Unavailable")}</strong><small>Separate signer allowed to execute approved actions</small></div></div><p class="identity-owner">Owner wallet: <span>${escapeHtml(identity.owner || "Unavailable")}</span></p></section>` : "";
  return `<section class="proof-overview"><div class="panel"><p class="panel-label">${escapeHtml(payload.mode || "REPLAY")}</p><h2>${escapeHtml(evidence.title || "Recorded evidence")}</h2><p>${escapeHtml(evidence.note || payload.source || "Read-only replay evidence.")}</p></div><div class="panel proof-source"><strong>Recorded source</strong><span>${escapeHtml(payload.source || "Local verification record")}</span><br /><br /><strong>Snapshot</strong><span>${escapeHtml(market)} · ${escapeHtml(state)} · Risk ${escapeHtml(risk)}</span></div></section>${identityMarkup}<section class="proof-steps panel"><p class="panel-label">THE JOURNEY</p><h2>What happened, in plain language</h2><ol class="proof-step-list">${stepsMarkup}</ol></section><section class="evidence-grid"><section class="panel"><p class="panel-label">WHAT WAS VERIFIED</p><h2>Evidence facts</h2><ul class="evidence-list">${factsMarkup}</ul></section><section class="panel"><p class="panel-label">LIFECYCLE</p><h2>Recorded checkpoints</h2><ul class="evidence-list">${eventMarkup}</ul></section><section class="panel"><p class="panel-label">TRANSACTIONS</p><h2>Reference hashes</h2><ul class="evidence-list">${txMarkup}</ul></section><section class="panel"><p class="panel-label">BOUNDARY</p><h2>Read only</h2><p class="empty-copy">This page reads a local evidence envelope. It does not connect to the engine, request a signature, place an order, or send a blockchain transaction.</p></section></section>`;
}

function initProof() {
  if (proofInitialized) return;
  proofInitialized = true;
  const button = element("load-proof");
  const select = element("proof-scene");
  const result = element("proof-result");
  const message = element("proof-message");
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
  select?.addEventListener("change", load);
  load();
}

function showPage() {
  const requested = page === "app" || page === "/app" ? "app" : page === "proof" || page === "/proof" ? "proof" : "landing";
  text("minimum-deposit", formatRawExact(MIN_INITIAL_DEPOSIT_RAW));
  document.querySelectorAll("[data-page]").forEach((pageElement) => {
    pageElement.hidden = pageElement.dataset.page !== requested;
  });
  document.body.dataset.page = requested;
  if (requested === "app") {
    document.querySelector(".page-app .lede")?.replaceChildren(document.createTextNode("Connect your wallet, review your VillaAccount, and start one bounded account-bound session. The private VILLA operator stays on the engine service; no operator wallet is needed in the browser."));
    document.querySelector("#control-plane-copy")?.replaceChildren(document.createTextNode("Start and Stop use the wallet-authenticated, account-bound control plane. The browser never signs engine transactions. Account execution is deployment-gated and only verified owner-bound sessions can start."));
  }
  if (requested === "app") initWallet();
  if (requested === "proof") initProof();
}

showPage();
