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
  getChainId,
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
import { MIN_DEPOSIT_RAW, VILLA_ACCOUNT_CONFIG, VILLA_CHAIN, ZERO_ADDRESS } from "./account-config.mjs";
import { deriveWalletStatus, renderAccountJourney } from "./account-journey.mjs";
import { createAddLiquidityHandler, runAddLiquidity } from "./liquidity-flow.mjs";
import { evaluateVerifiedOwnerAccountReadiness, isVerifiedOwnerAccountReady } from "./account-readiness.mjs";
import { createAuthorizationHandler, runAuthorization } from "./authorization-flow.mjs";

const page = window.location.pathname.replace(/\/+$/, "") || "/";
const ACCOUNT_HINT_PREFIX = "villa.account.owner.";

let provider = null;
let accountArtifact = null;
let walletInitialized = false;
let proofInitialized = false;
let refreshGeneration = 0;
let accountRefreshInFlight = null;
let refreshQueued = false;
let appState = {
  walletStatus: "DISCONNECTED",
  chainStatus: "UNKNOWN",
  discoveryStatus: "IDLE",
  account: null,
  transactionStatus: "IDLE",
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
    buildId: "phase2-readiness-runtime-fix",
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
  if (error?.code === "ACTION_BUSY") return "A liquidity action is already in progress. Please wait.";
  if (error?.code === "ACCOUNT_NOT_READY") return "Your VILLA account is not ready. Refresh account verification and try again.";
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
      account: null,
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

function resetAccountView() {
  setAppState({
    account: null,
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
    ...(correct ? {} : { account: null, currentAccountAddress: "" }),
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
    button.disabled = busy;
  });
}

function updateWorkspace(account, walletBalance) {
  const readinessEvaluation = evaluateVerifiedOwnerAccountReadiness({ ...appState, account });
  const accountReady = readinessEvaluation.ready;
  publishReadinessDebug({ ...appState, account });
  debugLiquidity("account_readiness_check", readinessEvaluation);
  const allocated = account.balance;
  const authorized = account.operator === normalizeAddress(VILLA_ACCOUNT_CONFIG.operator);
  const unexpectedOperator = account.operator !== ZERO_ADDRESS && !authorized;
  text("account-address", shorten(account.address));
  text("account-owner", shorten(account.owner));
  text("account-verification", "Owner verified");
  text("wallet-balance", `${formatAmount(walletBalance)} tUSDC`);
  text("allocated-balance", `${formatAmount(allocated)} tUSDC`);
  text("available-balance", `${formatAmount(allocated)} tUSDC`);
  text("withdrawable-balance", `${formatAmount(allocated)} tUSDC`);
  text("withdrawable-inline", `${formatAmount(allocated)} tUSDC`);
  text("strategy-allocated", `${formatAmount(allocated)} tUSDC`);
  text("advanced-account", account.address);
  text("advanced-operator", VILLA_ACCOUNT_CONFIG.operator);

  const authStatus = element("authorization-status");
  if (authStatus) {
    authStatus.className = `status-pill ${authorized ? "status-safe" : "status-preview"}`;
    authStatus.textContent = authorized ? "AUTHORIZED" : unexpectedOperator ? "UNRECOGNIZED" : "NOT AUTHORIZED";
  }
  text("authorization-copy", authorized
    ? "VILLA can perform approved liquidity actions. Only your wallet can withdraw."
    : unexpectedOperator
      ? "This account has a different automation address. VILLA actions are paused until you review it."
      : "VILLA is not authorized to use this account.");
  toggle("authorize-villa", accountReady && !authorized && !unexpectedOperator);
  toggle("revoke-villa", accountReady && authorized);

  const ready = accountReady && authorized && allocated > 0n;
  const readinessStatus = element("readiness-status");
  if (readinessStatus) {
    readinessStatus.className = `status-pill ${ready ? "status-safe" : "status-preview"}`;
    readinessStatus.textContent = ready ? "READY" : "SETUP REQUIRED";
  }
  text("readiness-title", ready ? "Liquidity setup complete." : "Complete account setup first.");
  text("readiness-copy", ready ? "Your account is ready for the next integration phase. Automated execution remains disabled here." : "Add liquidity and authorize VILLA before the workspace can be marked ready.");
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
}

function showDiscoveryError(error) {
  const discoveryStatus = error?.code === "UNVERIFIED_CANDIDATE" ? "SECURITY_ERROR" : "DISCOVERY_ERROR";
  setAppState({ account: null, currentAccountAddress: "", discoveryStatus, transactionStatus: "IDLE", error });
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
    if (!walletContextIsCurrent(owner, generation)) return;
    const result = await discoverAccount(provider, owner, accountArtifact, readHint(owner), { deadline, onDebug });
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
    setAppState({ account: result.account, currentAccountAddress: result.account.address, discoveryStatus: "DISCOVERED", error: null });
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
    setAppState({ discoveryStatus: "IDLE", account: null, currentAccountAddress: "", error });
    try {
      setNetworkState(await getChainId(provider));
    } catch {
      // Keep the actionable wrong-network panel visible when the wallet cannot answer.
      setAppState({ chainStatus: "WRONG_NETWORK", chainId: null, discoveryStatus: "IDLE", account: null, currentAccountAddress: "" });
    }
  } finally {
    setBusy(false);
  }
}

async function handleCreateAccount() {
  if (appState.busy || !provider || !appState.owner) return;
  setBusy(true);
  setMessage("create-message", "");
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
    if (account.operator !== ZERO_ADDRESS) throw new AccountClientError("UNEXPECTED_OPERATOR", "The new account did not start with automation disabled.", hash);
    writeHint(appState.owner, account.address);
    const walletBalance = await readTokenBalance(provider, appState.owner);
    setAppState({ account, currentAccountAddress: account.address, discoveryStatus: "DISCOVERED", error: null });
    updateWorkspace(account, walletBalance);
    showTransaction("SUCCESS", "VILLA account created", "Your account is verified and starts with VILLA automation unauthorized.", hash);
    setMessage("create-message", "Account created and verified.", "safe");
  } catch (error) {
    showActionError("create-message", error);
  } finally {
    setBusy(false);
  }
}

function showLiquidityStage(stage, amount = 0n, hash = "") {
  const value = amount ? formatAmount(amount) : "the requested";
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
    accountArtifact,
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
    setAppState({ account: accountAfter, currentAccountAddress: accountAfter.address, discoveryStatus: "DISCOVERED", error: null });
    updateWorkspace(accountAfter, walletAfter);
    showTransaction("SUCCESS", "Liquidity added", `${formatAmount(amount)} tUSDC is now held by your VILLA account.`, hash);
    setMessage("capital-message", `Liquidity added: ${formatAmount(amount)} tUSDC.`, "safe");
    element("amount-to-use").value = "";
  },
});

const handleAuthorize = createAuthorizationHandler({
  getContext: () => ({
    provider,
    owner: appState.owner,
    account: appState.account,
    currentAccountAddress: appState.currentAccountAddress,
    accountArtifact,
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
    setAppState({ account: accountAfter, currentAccountAddress: accountAfter.address, discoveryStatus: "DISCOVERED", error: null });
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
    const verified = await readAccount(provider, appState.account.address, accountArtifact, appState.owner);
    if (verified.operator !== normalizeAddress(VILLA_ACCOUNT_CONFIG.operator)) throw new AccountClientError("NOT_AUTHORIZED", "VILLA is not the current operator.");
    showTransaction("READY", "Revoke VILLA automation", "This stops new VILLA actions for this account. No strategy session is active in Phase 2.");
    const result = await sendTransaction(provider, actionTransaction(appState.owner, appState.account.address, accountCall.revokeOperator()), actionUpdate);
    showTransaction("CONFIRMING", "Verifying revocation", "Checking that the account operator is now zero.", result.hash);
    const after = await readAccount(provider, appState.account.address, accountArtifact, appState.owner);
    if (after.operator !== ZERO_ADDRESS) throw new AccountClientError("REVOCATION_MISMATCH", "The account operator was not revoked.", result.hash);
    setAppState({ account: after, currentAccountAddress: after.address, discoveryStatus: "DISCOVERED", error: null });
    updateWorkspace(after, await readTokenBalance(provider, appState.owner));
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
    const verified = await readAccount(provider, appState.account.address, accountArtifact, appState.owner);
    if (amount > verified.balance) throw new AccountClientError("INSUFFICIENT_FUNDS", "That amount is larger than the available capital in your VILLA account.");
    const walletBefore = await readTokenBalance(provider, appState.owner);
    showTransaction("READY", "Withdraw to your wallet", `Your account will return ${formatAmount(amount)} tUSDC to this connected owner wallet.`);
    const result = await sendTransaction(provider, actionTransaction(appState.owner, appState.account.address, accountCall.withdraw(amount)), actionUpdate);
    showTransaction("CONFIRMING", "Verifying your withdrawal", "Checking the account decrease, wallet increase, and owner on-chain.", result.hash);
    const walletAfter = await readTokenBalance(provider, appState.owner);
    const after = await readAccount(provider, appState.account.address, accountArtifact, appState.owner);
    if (walletAfter - walletBefore !== amount || verified.balance - after.balance !== amount) throw new AccountClientError("BALANCE_MISMATCH", "The withdrawal did not reconcile to the exact amount. No success was recorded.", result.hash);
    setAppState({ account: after, currentAccountAddress: after.address, discoveryStatus: "DISCOVERED", error: null });
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
  element("create-account")?.addEventListener("click", handleCreateAccount);
  element("add-liquidity")?.addEventListener("click", handleAddLiquidity);
  element("authorize-villa")?.addEventListener("click", handleAuthorize);
  element("revoke-villa")?.addEventListener("click", handleRevoke);
  element("withdraw-capital")?.addEventListener("click", handleWithdraw);
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
  const requested = page === "/app" ? "app" : page === "/proof" ? "proof" : "landing";
  text("minimum-deposit", formatAmount(MIN_DEPOSIT_RAW));
  document.querySelectorAll("[data-page]").forEach((pageElement) => {
    pageElement.hidden = pageElement.dataset.page !== requested;
  });
  document.body.dataset.page = requested;
  if (requested === "app") initWallet();
  if (requested === "proof") initProof();
}

showPage();
