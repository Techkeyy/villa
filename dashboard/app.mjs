import {
  AccountClientError,
  accountCall,
  actionTransaction,
  buildDeploymentData,
  deploymentTransaction,
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
import { VILLA_ACCOUNT_CONFIG, VILLA_CHAIN, ZERO_ADDRESS } from "./account-config.mjs";

const page = window.location.pathname.replace(/\/+$/, "") || "/";
const ACCOUNT_HINT_PREFIX = "villa.account.owner.";

let provider = null;
let currentOwner = "";
let currentAccount = null;
let accountArtifact = null;
let walletInitialized = false;
let proofInitialized = false;
let actionBusy = false;

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
  if (error?.code === "WALLET_MISSING") return "Install or unlock a compatible wallet to continue.";
  if (error?.code === "WRONG_CODE") return "That address is not a verified VILLA account. Capital actions are paused.";
  if (error?.code === "WRONG_OWNER") return "This account belongs to another wallet. Capital actions are paused.";
  if (error?.code === "DISCOVERY_UNAVAILABLE") return "VILLA could not read your account history. Your funds are safe. Retry when Shannon is available.";
  if (error?.code === "NETWORK_UNKNOWN") return "Somnia Shannon is not available in this wallet yet.";
  if (error?.code === "RPC_ERROR") return "The wallet or network could not complete that request. Your funds are safe.";
  if (error?.code === "INVALID_AMOUNT") return error.message;
  if (error?.code === "INSUFFICIENT_FUNDS") return "That amount is larger than the balance available in your wallet.";
  return error?.message || "The action could not be completed. Your funds are safe.";
}

function showTransaction(state, title, copy, detail = "") {
  toggle("transaction-panel", true);
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
  toggle("wallet-disconnected", !connected);
  toggle("wallet-connected", connected);
}

function resetAccountView() {
  currentAccount = null;
  toggle("account-loading", false);
  toggle("account-empty", false);
  toggle("account-workspace", false);
  toggle("wrong-network", false);
  toggle("transaction-panel", false);
}

function setNetworkState(chainId) {
  const correct = chainId === VILLA_CHAIN.id;
  toggle("wrong-network", !correct);
  text("network-status", correct ? "SHANNON TESTNET" : "WRONG NETWORK");
  text("wallet-state", correct ? "WALLET CONNECTED" : "SWITCH NETWORK");
  const status = element("network-status");
  if (status) status.className = `status-pill ${correct ? "status-safe" : "status-preview"}`;
  return correct;
}

function setBusy(busy) {
  actionBusy = busy;
  document.querySelectorAll("#account-workspace button, #create-account, #switch-network").forEach((button) => {
    if (button.id === "start-villa") return;
    button.disabled = busy;
  });
}

function updateWorkspace(account, walletBalance) {
  currentAccount = account;
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
  toggle("authorize-villa", !authorized && !unexpectedOperator);
  toggle("revoke-villa", authorized);

  const ready = authorized && allocated > 0n;
  const readiness = element("readiness-status");
  if (readiness) {
    readiness.className = `status-pill ${ready ? "status-safe" : "status-preview"}`;
    readiness.textContent = ready ? "READY" : "SETUP REQUIRED";
  }
  text("readiness-title", ready ? "Liquidity setup complete." : "Complete account setup first.");
  text("readiness-copy", ready ? "Your account is ready for the next integration phase. Automated execution remains disabled here." : "Add liquidity and authorize VILLA before the workspace can be marked ready.");
  element("add-liquidity")?.removeAttribute("disabled");
  element("withdraw-capital")?.removeAttribute("disabled");
  text("capital-status", "ACCOUNT READY");
}

async function refreshAccount() {
  if (!provider || !currentOwner) return;
  const chainId = await getChainId(provider);
  if (!setNetworkState(chainId)) {
    resetAccountView();
    return;
  }
  toggle("account-loading", true);
  toggle("account-empty", false);
  toggle("account-workspace", false);
  try {
    accountArtifact ??= await loadArtifact();
    const result = await discoverAccount(provider, currentOwner, accountArtifact, readHint(currentOwner));
    if (!result.account) {
      resetAccountView();
      toggle("account-empty", true);
      return;
    }
    writeHint(currentOwner, result.account.address);
    const walletBalance = await readTokenBalance(provider, currentOwner);
    updateWorkspace(result.account, walletBalance);
    toggle("account-loading", false);
    toggle("account-workspace", true);
    setMessage("capital-message", "");
    setMessage("withdraw-message", "");
    setMessage("authorization-message", "");
  } catch (error) {
    resetAccountView();
    setAppNotice(humanError(error));
    setMessage("wallet-message", humanError(error));
  } finally {
    toggle("account-loading", false);
  }
}

async function connectWallet(accounts = null) {
  provider = window.ethereum;
  if (!provider?.request) throw new AccountClientError("WALLET_MISSING", "Install or unlock a compatible wallet to continue.");
  const selected = accounts || await request(provider, "eth_requestAccounts");
  const owner = normalizeAddress(selected?.[0]);
  if (!owner) throw new AccountClientError("INVALID_OWNER", "The wallet did not return a valid account.");
  currentOwner = owner;
  setConnected(true);
  text("wallet-address", shorten(owner));
  setMessage("wallet-message", "");
  setAppNotice("");
  await refreshAccount();
}

function disconnectWallet() {
  currentOwner = "";
  currentAccount = null;
  setConnected(false);
  resetAccountView();
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
  if (actionBusy) return;
  setBusy(true);
  setMessage("network-message", "");
  try {
    showTransaction("WAITING_FOR_WALLET", "Switching network", "Confirm the Somnia Shannon network in your wallet.");
    await ensureShannon(provider);
    showTransaction("SUCCESS", "Network ready", "Your wallet is now on Somnia Shannon.");
    await refreshAccount();
  } catch (error) {
    setMessage("network-message", humanError(error));
    showActionError("network-message", error);
  } finally {
    setBusy(false);
  }
}

async function handleCreateAccount() {
  if (actionBusy || !provider || !currentOwner) return;
  setBusy(true);
  setMessage("create-message", "");
  try {
    const chainId = await getChainId(provider);
    if (!setNetworkState(chainId)) throw new AccountClientError("WRONG_NETWORK", "Switch to Somnia Shannon before creating your account.");
    accountArtifact ??= await loadArtifact();
    const data = buildDeploymentData(accountArtifact, currentOwner);
    const { hash, receipt } = await sendTransaction(provider, deploymentTransaction(currentOwner, data), actionUpdate);
    const accountAddress = normalizeAddress(receipt?.contractAddress);
    if (!accountAddress) throw new AccountClientError("BAD_CHAIN_RESPONSE", "The account deployment confirmed without an account address.", hash);
    showTransaction("CONFIRMING", "Verifying your VILLA account", "Checking code, owner, token wiring, and initial permissions on-chain.", hash);
    const account = await readAccount(provider, accountAddress, accountArtifact, currentOwner);
    if (account.operator !== ZERO_ADDRESS) throw new AccountClientError("UNEXPECTED_OPERATOR", "The new account did not start with automation disabled.", hash);
    writeHint(currentOwner, account.address);
    const walletBalance = await readTokenBalance(provider, currentOwner);
    updateWorkspace(account, walletBalance);
    toggle("account-empty", false);
    toggle("account-workspace", true);
    showTransaction("SUCCESS", "VILLA account created", "Your account is verified and starts with VILLA automation unauthorized.", hash);
    setMessage("create-message", "Account created and verified.", "safe");
  } catch (error) {
    showActionError("create-message", error);
  } finally {
    setBusy(false);
  }
}

async function handleAddLiquidity() {
  if (actionBusy || !currentAccount || !currentOwner) return;
  setBusy(true);
  setMessage("capital-message", "");
  try {
    const amount = parseAmount(element("amount-to-use")?.value);
    const chainId = await getChainId(provider);
    if (!setNetworkState(chainId)) throw new AccountClientError("WRONG_NETWORK", "Switch to Somnia Shannon before adding liquidity.");
    const verified = await readAccount(provider, currentAccount.address, accountArtifact, currentOwner);
    const walletBefore = await readTokenBalance(provider, currentOwner);
    if (amount > walletBefore) throw new AccountClientError("INSUFFICIENT_FUNDS", "That amount is larger than the balance available in your wallet.");
    const accountBefore = verified.balance;
    const allowance = await readAllowance(provider, currentOwner, currentAccount.address);
    if (allowance < amount) {
      showTransaction("READY", "Approve exact tUSDC amount", `Your wallet will approve ${formatAmount(amount)} tUSDC for this account only.`);
      const approval = await sendTransaction(provider, actionTransaction(currentOwner, VILLA_ACCOUNT_CONFIG.collateralToken, tokenCall.approve(currentAccount.address, amount)), actionUpdate);
      showTransaction("CONFIRMING", "Checking the approval", "Verifying the exact allowance before deposit.", approval.hash);
      const allowanceAfter = await readAllowance(provider, currentOwner, currentAccount.address);
      if (allowanceAfter < amount) throw new AccountClientError("APPROVAL_MISMATCH", "The exact tUSDC approval could not be verified.", approval.hash);
    }
    showTransaction("READY", "Deposit into your VILLA account", `Your wallet will deposit ${formatAmount(amount)} tUSDC into your verified account.`);
    const deposit = await sendTransaction(provider, actionTransaction(currentOwner, currentAccount.address, accountCall.deposit(amount)), actionUpdate);
    showTransaction("CONFIRMING", "Verifying your liquidity", "Checking the wallet decrease, account increase, owner, and operator on-chain.", deposit.hash);
    const walletAfter = await readTokenBalance(provider, currentOwner);
    const accountAfter = await readAccount(provider, currentAccount.address, accountArtifact, currentOwner);
    if (walletBefore - walletAfter !== amount || accountAfter.balance - accountBefore !== amount) throw new AccountClientError("BALANCE_MISMATCH", "The deposit did not reconcile to the exact amount. No success was recorded.", deposit.hash);
    updateWorkspace(accountAfter, walletAfter);
    showTransaction("SUCCESS", "Liquidity added", `${formatAmount(amount)} tUSDC is now held by your VILLA account.`, deposit.hash);
    setMessage("capital-message", `Liquidity added: ${formatAmount(amount)} tUSDC.`, "safe");
    element("amount-to-use").value = "";
  } catch (error) {
    showActionError("capital-message", error);
  } finally {
    setBusy(false);
  }
}

async function handleAuthorize() {
  if (actionBusy || !currentAccount || !currentOwner) return;
  setBusy(true);
  setMessage("authorization-message", "");
  try {
    const verified = await readAccount(provider, currentAccount.address, accountArtifact, currentOwner);
    if (verified.operator === normalizeAddress(VILLA_ACCOUNT_CONFIG.operator)) {
      updateWorkspace(verified, await readTokenBalance(provider, currentOwner));
      setMessage("authorization-message", "VILLA is already authorized.", "safe");
      return;
    }
    if (verified.operator !== ZERO_ADDRESS) throw new AccountClientError("UNEXPECTED_OPERATOR", "This account has a different operator. VILLA will not overwrite it.");
    showTransaction("READY", "Authorize VILLA", "VILLA may use this account for approved DreamDEX liquidity actions. VILLA cannot withdraw your funds.");
    const result = await sendTransaction(provider, actionTransaction(currentOwner, currentAccount.address, accountCall.setOperator(VILLA_ACCOUNT_CONFIG.operator)), actionUpdate);
    showTransaction("CONFIRMING", "Verifying VILLA authorization", "Checking the operator address on-chain.", result.hash);
    const after = await readAccount(provider, currentAccount.address, accountArtifact, currentOwner);
    if (after.operator !== normalizeAddress(VILLA_ACCOUNT_CONFIG.operator)) throw new AccountClientError("AUTHORIZATION_MISMATCH", "Authorization was not set to the trusted VILLA operator.", result.hash);
    updateWorkspace(after, await readTokenBalance(provider, currentOwner));
    showTransaction("SUCCESS", "VILLA authorized", "VILLA can perform approved liquidity actions. Only your wallet can withdraw.", result.hash);
    setMessage("authorization-message", "VILLA authorization confirmed.", "safe");
  } catch (error) {
    showActionError("authorization-message", error);
  } finally {
    setBusy(false);
  }
}

async function handleRevoke() {
  if (actionBusy || !currentAccount || !currentOwner) return;
  setBusy(true);
  setMessage("authorization-message", "");
  try {
    const verified = await readAccount(provider, currentAccount.address, accountArtifact, currentOwner);
    if (verified.operator !== normalizeAddress(VILLA_ACCOUNT_CONFIG.operator)) throw new AccountClientError("NOT_AUTHORIZED", "VILLA is not the current operator.");
    showTransaction("READY", "Revoke VILLA automation", "This stops new VILLA actions for this account. No strategy session is active in Phase 2.");
    const result = await sendTransaction(provider, actionTransaction(currentOwner, currentAccount.address, accountCall.revokeOperator()), actionUpdate);
    showTransaction("CONFIRMING", "Verifying revocation", "Checking that the account operator is now zero.", result.hash);
    const after = await readAccount(provider, currentAccount.address, accountArtifact, currentOwner);
    if (after.operator !== ZERO_ADDRESS) throw new AccountClientError("REVOCATION_MISMATCH", "The account operator was not revoked.", result.hash);
    updateWorkspace(after, await readTokenBalance(provider, currentOwner));
    showTransaction("SUCCESS", "VILLA revoked", "VILLA can no longer act for this account.", result.hash);
    setMessage("authorization-message", "VILLA revocation confirmed.", "safe");
  } catch (error) {
    showActionError("authorization-message", error);
  } finally {
    setBusy(false);
  }
}

async function handleWithdraw() {
  if (actionBusy || !currentAccount || !currentOwner) return;
  setBusy(true);
  setMessage("withdraw-message", "");
  try {
    const amount = parseAmount(element("withdraw-amount")?.value);
    const verified = await readAccount(provider, currentAccount.address, accountArtifact, currentOwner);
    if (amount > verified.balance) throw new AccountClientError("INSUFFICIENT_FUNDS", "That amount is larger than the available capital in your VILLA account.");
    const walletBefore = await readTokenBalance(provider, currentOwner);
    showTransaction("READY", "Withdraw to your wallet", `Your account will return ${formatAmount(amount)} tUSDC to this connected owner wallet.`);
    const result = await sendTransaction(provider, actionTransaction(currentOwner, currentAccount.address, accountCall.withdraw(amount)), actionUpdate);
    showTransaction("CONFIRMING", "Verifying your withdrawal", "Checking the account decrease, wallet increase, and owner on-chain.", result.hash);
    const walletAfter = await readTokenBalance(provider, currentOwner);
    const after = await readAccount(provider, currentAccount.address, accountArtifact, currentOwner);
    if (walletAfter - walletBefore !== amount || verified.balance - after.balance !== amount) throw new AccountClientError("BALANCE_MISMATCH", "The withdrawal did not reconcile to the exact amount. No success was recorded.", result.hash);
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
  document.querySelectorAll("[data-page]").forEach((pageElement) => {
    pageElement.hidden = pageElement.dataset.page !== requested;
  });
  document.body.dataset.page = requested;
  if (requested === "app") initWallet();
  if (requested === "proof") initProof();
}

showPage();
