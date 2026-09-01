import {
  classifyWalletError,
  providerLabel,
  sanitizeProviderReason,
  selectRabbyProvider,
} from "./owner-wallet-discovery.mjs";

const OWNER = "0xefe0412781d3c1e7888b2db9deeca3037542494d";
const CHAIN_ID = "0xc488";
const SHANNON_CHAIN = {
  chainId: CHAIN_ID,
  chainName: "Somnia Shannon Testnet",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: ["https://dream-rpc.somnia.network"],
};
const state = { current: null, wallet: null, provider: null, providerName: "", providerEventsAttached: false, busy: false, walletErrorCode: null, walletErrorReason: "", readSequence: 0 };
const walletDiscovery = { announced: [], requestSent: false, handlerReached: false };
window.__VILLA_OWNER_WIZARD__ = Object.freeze({ buildId: "phase3b1b1-owner-prep-v2", localhostOnly: true, executionEnabled: false });

const $ = (id) => document.getElementById(id);
const show = (id, visible) => $(id)?.toggleAttribute("hidden", !visible);
const lower = (value) => String(value ?? "").toLowerCase();
const formatRaw = (value) => value === null || value === undefined ? "-" : `${(Number(value) / 1_000_000).toFixed(3)} tUSDC`;
const formatNumber = (value, digits = 4) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "-";
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function setStatus(title, copy, tone = "info") {
  $("status-title").textContent = title;
  $("status-copy").textContent = copy;
  $("status").dataset.tone = tone;
}

function stageLabel(stage) {
  return ({ WAITING_FOR_MARKET: "WAITING FOR MARKET", REVIEW: "APPROVE MARKET", APPROVAL_CONFIRMING: "REVALIDATING", PREPARE_REVIEW: "PREPARE MARKET", PREPARE_CONFIRMING: "FINAL PREFLIGHT", BLOCKED: "BLOCKED" })[stage] || stage;
}

function renderDiagnostics() {
  const labels = walletDiscovery.announced.map((entry) => providerLabel(entry));
  if ($("wallet-eip6963")) $("wallet-eip6963").textContent = labels.length ? labels.join(", ") : "None";
  if ($("wallet-provider-name")) $("wallet-provider-name").textContent = state.providerName || "None";
  if ($("wallet-account")) $("wallet-account").textContent = state.wallet?.address || "None";
  if ($("wallet-chain")) $("wallet-chain").textContent = state.wallet?.chainId || "None";
  if ($("wallet-handler")) $("wallet-handler").textContent = walletDiscovery.handlerReached ? "yes" : "no";
}

function renderReview(review, stage) {
  const visible = Boolean(review);
  show("review-panel", visible);
  if (!visible) return;
  $("market-id").textContent = review.marketId || "-";
  $("headroom").textContent = review.headroomSec === null ? "-" : `${Math.max(0, Math.floor(review.headroomSec))}s remaining`;
  $("expiry").textContent = review.expirySec ? new Date(Number(review.expirySec) * 1000).toISOString() : "-";
  $("spot").textContent = formatNumber(review.spot, 3);
  $("strike").textContent = formatNumber(review.strike, 3);
  $("fair-value").textContent = review.fairValue === null || review.fairValue === undefined ? "-" : `${(Number(review.fairValue) * 100).toFixed(2)}% YES`;
  $("confidence").textContent = review.confidence === null || review.confidence === undefined ? "-" : `${(Number(review.confidence) * 100).toFixed(1)}%`;
  const quote = review.quote || {};
  $("quote").textContent = `${quote.action || "-"} at ${formatRaw(quote.priceRaw).replace(" tUSDC", "")} · ${formatRaw(quote.quantityRaw)}`;
  $("planned-path").textContent = review.plannedPath === "A" ? "A · BUY_YES → cancel → reconcile" : review.plannedPath === "B" ? "B · mint → SELL_YES → cancel → burn" : "-";
  $("planned-mint").textContent = formatRaw(review.plannedMintRaw);
  const actionReady = (stage === "REVIEW" || stage === "PREPARE_REVIEW") && Boolean(review.action) && state.wallet?.ok === true && !state.busy;
  $("action-button").disabled = !actionReady;
  $("action-button").textContent = stage === "PREPARE_REVIEW" ? "Prepare this market" : "Approve this market";
  $("action-help").textContent = actionReady ? "Your wallet will open for this exact call." : stage === "APPROVAL_CONFIRMING" || stage === "PREPARE_CONFIRMING" ? "Waiting for the confirmed receipt." : "Connect the authorized Rabby wallet before this action is available.";
  if (stage === "REVIEW") $("review-heading").textContent = `Fresh ${review.intervalLabel || "BTC market"}`;
  if (stage === "PREPARE_REVIEW") $("review-heading").textContent = "Action 1 confirmed. Prepare protocol approvals.";
}

function renderWallet() {
  const wallet = state.wallet;
  if (!wallet) $("wallet-state").textContent = "Wallet not checked.";
  else if (wallet.ok) $("wallet-state").textContent = `Owner connected on Shannon: ${wallet.address}`;
  else $("wallet-state").textContent = wallet.reason || state.walletErrorCode || "Wallet is not ready.";
  renderDiagnostics();
}

function renderOutcome(current) {
  const showOutcome = current.stage === "FINAL_PREFLIGHT" || current.stage === "BLOCKED";
  show("outcome-panel", showOutcome);
  if (!showOutcome) return;
  const final = current.final || {};
  const blockers = Array.isArray(final.blockers) ? final.blockers : (current.blockers || []).map((item) => item.code || item);
  $("outcome-title").textContent = current.stage === "FINAL_PREFLIGHT" && blockers.length === 1 && blockers[0] === "EXECUTION_DISABLED" ? "Owner preparation complete" : "Owner preparation stopped";
  $("outcome-copy").textContent = current.stage === "FINAL_PREFLIGHT" ? "The local final handoff is blocked only by EXECUTION_DISABLED. Do not start a wet session." : current.message || "No owner action is available.";
  $("blockers").innerHTML = blockers.map((item) => `<li>${String(item)}</li>`).join("");
  $("hashes").innerHTML = [current.tx1Hash ? `Action 1 receipt: <span class="hash">${current.tx1Hash}</span>` : "", current.tx2Hash ? `Action 2 receipt: <span class="hash">${current.tx2Hash}</span>` : ""].filter(Boolean).join("<br />");
}

function render(current) {
  state.current = current;
  $("stage").textContent = stageLabel(current.stage);
  if (current.stage === "WAITING_FOR_MARKET") {
    const walletConnected = current.walletContext?.connected === true || state.wallet?.ok === true;
    setStatus(walletConnected ? "WAITING_FOR_MARKET" : "Waiting for wallet connection", current.message || (walletConnected ? "The authorized owner wallet is connected. Looking for a fresh BTC market." : "Connect the authorized Rabby wallet before fresh-market discovery."));
  }
  else if (current.stage === "REVIEW") setStatus("Fresh market ready for review", "Check the exact market facts and connect the authorized owner wallet before approving.", "safe");
  else if (current.stage === "PREPARE_REVIEW") setStatus("Action 1 confirmed", "The market was revalidated immediately. Review the second exact owner call.", "safe");
  else if (current.stage === "APPROVAL_CONFIRMING" || current.stage === "PREPARE_CONFIRMING") setStatus("Waiting for receipt", "Keep Rabby and this tab open. No next action is shown until the receipt is confirmed.");
  else if (current.stage === "FINAL_PREFLIGHT") setStatus("Final preflight reached", "Execution is disabled. The wizard stops here.", "safe");
  else setStatus("Owner preparation stopped", current.message || "No owner action is available.", "warning");
  renderReview(current.review, current.stage);
  renderOutcome(current);
  renderWallet();
  if (state.walletErrorCode) renderWalletErrorStatus();
}

function renderWalletErrorStatus() {
  const code = state.walletErrorCode;
  const reason = state.walletErrorReason;
  const copy = code === "WRONG_OWNER_ACCOUNT"
    ? "Wrong wallet. Switch Rabby to the disposable VILLA owner."
    : code === "WRONG_NETWORK"
      ? reason || "Switch Rabby to Somnia Shannon, chain 50312, before continuing."
      : code === "NETWORK_SWITCH_REJECTED"
        ? "Rabby did not switch networks. Approve the Shannon network request to continue."
        : code === "RABBY_NOT_FOUND"
          ? "Rabby was not found through EIP-6963 or the legacy injected wallet list."
          : code === "WALLET_REQUEST_REJECTED"
            ? "The wallet request was rejected. Click Connect owner wallet to try again."
            : code === "CONNECTED"
              ? "The authorized owner wallet is on Somnia Shannon. Fresh-market discovery may now begin."
              : reason || "The wallet provider could not be used.";
  const title = code === "PROVIDER_CONNECTION_FAILED" && reason ? `${code}: ${reason}` : code;
  setStatus(title, copy, code === "CONNECTED" ? "safe" : "warning");
}

function setWalletFailure(code, reason = "") {
  state.walletErrorCode = code;
  state.walletErrorReason = sanitizeProviderReason(reason);
  state.wallet = { ok: false, address: state.wallet?.address || "", chainId: state.wallet?.chainId || "", reason: code };
  renderWallet();
  renderWalletErrorStatus();
  renderReview(state.current?.review, state.current?.stage);
}

function clearWalletFailure() {
  state.walletErrorCode = null;
  state.walletErrorReason = "";
}

function announceProvider(event) {
  const detail = event?.detail || {};
  const provider = detail.provider;
  if (!provider || typeof provider.request !== "function" || walletDiscovery.announced.some((entry) => entry.provider === provider)) return;
  walletDiscovery.announced.push({ provider, info: detail.info || {} });
  renderDiagnostics();
}

window.addEventListener("eip6963:announceProvider", announceProvider);
window.dispatchEvent(new Event("eip6963:requestProvider"));
walletDiscovery.requestSent = true;

function legacyProviders() {
  const injected = window.ethereum;
  if (Array.isArray(injected?.providers)) return injected.providers.map((provider) => ({ provider }));
  return injected ? [{ provider: injected }] : [];
}

async function discoverRabbyProvider() {
  if (!walletDiscovery.requestSent) {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    walletDiscovery.requestSent = true;
  }
  await wait(120);
  const selected = selectRabbyProvider({ announced: walletDiscovery.announced, legacy: legacyProviders() });
  if (!selected) throw Object.assign(new Error("Rabby was not found"), { walletCode: "RABBY_NOT_FOUND" });
  state.provider = selected.provider;
  state.providerName = providerLabel(selected);
  attachProviderEvents(selected.provider);
  renderDiagnostics();
  return selected.provider;
}

function attachProviderEvents(provider) {
  if (state.provider === provider && state.providerEventsAttached) return;
  state.providerEventsAttached = true;
  provider.on?.("accountsChanged", (accounts) => { void handleAccountsChanged(accounts); });
  provider.on?.("chainChanged", (chainId) => { void handleChainChanged(chainId); });
}

function walletError(code, reason) {
  return Object.assign(new Error(sanitizeProviderReason(reason)), { walletCode: code, originalError: reason });
}

async function requestWallet(provider, method, params = [], context = "connection") {
  if (!provider?.request) throw walletError("RABBY_NOT_FOUND", new Error("Rabby provider is unavailable"));
  try {
    return await provider.request({ method, params });
  } catch (error) {
    throw walletError(classifyWalletError(error, context), error);
  }
}

async function readWalletContext(provider, requestAccounts = false, allowNetworkSwitch = false) {
  const accounts = await requestWallet(provider, requestAccounts ? "eth_requestAccounts" : "eth_accounts", [], "connection");
  const address = accounts?.[0] || "";
  if (lower(address) !== OWNER) throw walletError("WRONG_OWNER_ACCOUNT", new Error("the connected account is not the disposable VILLA owner"));
  let chainId = await requestWallet(provider, "eth_chainId", [], "connection");
  if (lower(chainId) !== CHAIN_ID) {
    if (!allowNetworkSwitch) throw walletError("WRONG_NETWORK", new Error("Switch Rabby to Somnia Shannon, chain 50312, before continuing."));
    try {
      await requestWallet(provider, "wallet_switchEthereumChain", [{ chainId: CHAIN_ID }], "switch");
    } catch (error) {
      if (error.walletCode !== "NETWORK_NOT_CONFIGURED") throw error;
      try {
        await requestWallet(provider, "wallet_addEthereumChain", [SHANNON_CHAIN], "add");
        await requestWallet(provider, "wallet_switchEthereumChain", [{ chainId: CHAIN_ID }], "switch");
      } catch (addError) {
        if (addError.walletCode === "NETWORK_SWITCH_REJECTED") throw addError;
        throw walletError("WRONG_NETWORK", new Error("Rabby does not know Somnia Shannon. Add chain 50312 manually, then retry."));
      }
    }
    chainId = await requestWallet(provider, "eth_chainId", [], "connection");
  }
  if (lower(chainId) !== CHAIN_ID) throw walletError("WRONG_NETWORK", new Error("Switch Rabby to Somnia Shannon, chain 50312, before continuing."));
  return { address, chainId };
}

async function post(path, body = null) {
  const response = await fetch(path, { method: "POST", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload.error || "The local owner gate rejected the action."), { state: payload.state });
  return payload;
}

async function invalidateServer() {
  try { return await post("/api/invalidate"); } catch { return null; }
}

async function authorizeWalletContext(context) {
  await invalidateServer();
  const payload = await post("/api/wallet-connected", { address: context.address, chainId: 50312 });
  clearWalletFailure();
  state.wallet = { ok: true, address: context.address, chainId: context.chainId, reason: "" };
  renderWallet();
  await loadState(true);
  return payload;
}

async function inspectWallet(provider = state.provider) {
  const context = await readWalletContext(provider, false);
  state.wallet = { ok: true, address: context.address, chainId: context.chainId, reason: "" };
  clearWalletFailure();
  renderWallet();
  return context;
}

async function connectWallet() {
  walletDiscovery.handlerReached = true;
  renderDiagnostics();
  const button = $("connect-wallet");
  if (state.busy) return;
  state.busy = true;
  if (button) button.disabled = true;
  clearWalletFailure();
  setStatus("CONNECTING", "Select the disposable VILLA owner in Rabby, then approve the Shannon network request.");
  try {
    const provider = await discoverRabbyProvider();
    const context = await readWalletContext(provider, true, true);
    await invalidateServer();
    await authorizeWalletContext(context);
  } catch (error) {
    const code = error.walletCode || classifyWalletError(error, "connection");
    setWalletFailure(code === "NETWORK_NOT_CONFIGURED" ? "WRONG_NETWORK" : code, error);
    await invalidateServer();
  } finally {
    state.busy = false;
    if (button) button.disabled = false;
    renderReview(state.current?.review, state.current?.stage);
  }
}

async function handleAccountsChanged(accounts) {
  const address = accounts?.[0] || "";
  await invalidateServer();
  if (lower(address) !== OWNER) {
    setWalletFailure("WRONG_OWNER_ACCOUNT", new Error("Wrong wallet. Switch Rabby to the disposable VILLA owner."));
    await loadState();
    return;
  }
  try {
    const context = await inspectWallet(state.provider);
    await authorizeWalletContext(context);
  } catch (error) {
    setWalletFailure(error.walletCode || "PROVIDER_CONNECTION_FAILED", error);
  }
}

async function handleChainChanged(chainId) {
  await invalidateServer();
  if (lower(chainId) !== CHAIN_ID) {
    setWalletFailure("WRONG_NETWORK", new Error("Switch Rabby to Somnia Shannon, chain 50312, before continuing."));
    await loadState();
    return;
  }
  try {
    const context = await inspectWallet(state.provider);
    await authorizeWalletContext(context);
  } catch (error) {
    setWalletFailure(error.walletCode || "PROVIDER_CONNECTION_FAILED", error);
  }
}

async function loadState(force = false) {
  if (!force && state.busy && state.current?.stage === "WAITING_FOR_MARKET") return;
  const requestId = ++state.readSequence;
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    const current = await response.json();
    if (requestId !== state.readSequence) return;
    render(current);
  } catch (error) {
    setStatus("Local read unavailable", sanitizeProviderReason(error), "error");
  }
}

function renderTransactionReview(transaction) {
  $("tx-from").textContent = transaction.from;
  $("tx-to").textContent = transaction.to;
  $("tx-method").textContent = transaction.functionName === "setMarketApproval" ? "setMarketApproval(bytes32,bool)" : "prepareMarket(bytes32)";
  $("tx-market").textContent = transaction.marketId;
  show("wallet-review-panel", true);
}

async function performOwnerAction() {
  const current = state.current;
  if (!current || state.busy) return;
  const action = current.stage === "PREPARE_REVIEW" ? "prepare" : "approve";
  state.busy = true;
  $("action-button").disabled = true;
  try {
    const context = await inspectWallet(state.provider);
    if (!state.wallet?.ok) throw new Error("Authorized owner wallet and Shannon network are required.");
    await post("/api/wallet-connected", { address: context.address, chainId: 50312 });
    const payload = await post(`/api/action/${action}`);
    const transaction = payload.walletTransaction;
    renderTransactionReview(transaction);
    setStatus("Review in Rabby", "Confirm only this fixed owner call in your wallet. VILLA never signs automatically.");
    const chainId = await requestWallet(state.provider, "eth_chainId");
    const accounts = await requestWallet(state.provider, "eth_accounts");
    if (lower(chainId) !== CHAIN_ID || lower(accounts?.[0]) !== OWNER) throw new Error("Wallet account or network changed before submission.");
    const txHash = await requestWallet(state.provider, "eth_sendTransaction", [{ from: transaction.from, to: transaction.to, data: transaction.data, value: "0x0" }]);
    render({ ...state.current, stage: action === "approve" ? "APPROVAL_CONFIRMING" : "PREPARE_CONFIRMING", message: "Waiting for the confirmed owner receipt." });
    const receipt = await post(`/api/receipt/${action}`, { txHash });
    render(receipt);
    show("wallet-review-panel", false);
  } catch (error) {
    try { await post(`/api/failure/${action}`); } catch { /* preserve the original local error */ }
    if (error.state) render(error.state); else { setStatus("No owner action submitted", sanitizeProviderReason(error), "warning"); await loadState(); }
  } finally {
    state.busy = false;
    if (state.current) render(state.current);
  }
}

$("connect-wallet")?.addEventListener("click", connectWallet);
$("action-button")?.addEventListener("click", performOwnerAction);

(async () => {
  try {
    const provider = await discoverRabbyProvider();
    const context = await inspectWallet(provider);
    await authorizeWalletContext(context);
  } catch (error) {
    const code = error.walletCode || classifyWalletError(error, "connection");
    setWalletFailure(code === "NETWORK_NOT_CONFIGURED" ? "WRONG_NETWORK" : code, error);
    await invalidateServer();
    await loadState();
  }
})();

renderDiagnostics();
loadState();
setInterval(loadState, 4_000);
