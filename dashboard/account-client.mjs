import { VILLA_ACCOUNT_CONFIG, VILLA_CHAIN, VILLA_SELECTORS, ZERO_ADDRESS, ZERO_TOPIC } from "./account-config.mjs";

export class AccountClientError extends Error {
  constructor(code, message, detail = "") {
    super(message);
    this.name = "AccountClientError";
    this.code = code;
    this.detail = detail;
  }
}

export function normalizeAddress(value) {
  const text = String(value ?? "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text.toLowerCase() : "";
}

export function isAddress(value) {
  return Boolean(normalizeAddress(value));
}

function word(value) {
  const text = String(value).replace(/^0x/, "");
  return text.padStart(64, "0");
}

export function encodeAddress(value) {
  const address = normalizeAddress(value);
  if (!address) throw new AccountClientError("INVALID_ADDRESS", "That wallet address is not valid.");
  return word(address);
}

export function encodeUint(value) {
  const numeric = BigInt(value);
  if (numeric < 0n) throw new AccountClientError("INVALID_AMOUNT", "Amount must be positive.");
  return word(numeric.toString(16));
}

export function encodeCall(selector, args = []) {
  return `${selector}${args.join("")}`;
}

export function decodeAddress(result) {
  const text = String(result ?? "").replace(/^0x/, "");
  if (text.length < 64) throw new AccountClientError("BAD_CHAIN_RESPONSE", "The network returned an incomplete account response.");
  return normalizeAddress(`0x${text.slice(-40)}`);
}

export function decodeUint(result) {
  const text = String(result ?? "0x0").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]+$/.test(text)) throw new AccountClientError("BAD_CHAIN_RESPONSE", "The network returned an invalid amount.");
  return BigInt(`0x${text || "0"}`);
}

export function parseAmount(value, decimals = 6) {
  const text = String(value ?? "").trim();
  const pattern = new RegExp(`^(?:0|[1-9]\\d*)(?:\\.\\d{1,${decimals}})?$`);
  if (!pattern.test(text) || /[eE]/.test(text)) {
    throw new AccountClientError("INVALID_AMOUNT", `Enter a positive ${VILLA_ACCOUNT_CONFIG.collateralSymbol} amount with up to ${decimals} decimal places.`);
  }
  const [whole, fraction = ""] = text.split(".");
  const raw = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals));
  if (raw <= 0n) throw new AccountClientError("INVALID_AMOUNT", "Enter an amount greater than zero.");
  return raw;
}

export function formatAmount(raw, decimals = 6, places = 2) {
  const value = BigInt(raw ?? 0);
  const unit = 10n ** BigInt(decimals);
  const whole = value / unit;
  const fraction = (value % unit).toString().padStart(decimals, "0");
  return `${whole}.${fraction.slice(0, places).padEnd(places, "0")}`;
}

export function formatRawExact(raw, decimals = 6) {
  const value = BigInt(raw ?? 0);
  const unit = 10n ** BigInt(decimals);
  const whole = value / unit;
  const fraction = (value % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

export function encodeTopicAddress(value) {
  return `0x${encodeAddress(value)}`;
}

export function encodeConstructorArgs({ owner, operator = ZERO_ADDRESS }) {
  return [
    encodeAddress(owner),
    encodeAddress(operator),
    encodeAddress(VILLA_ACCOUNT_CONFIG.collateralToken),
    encodeAddress(VILLA_ACCOUNT_CONFIG.outcomeToken),
    encodeAddress(VILLA_ACCOUNT_CONFIG.binaryModule),
    encodeAddress(VILLA_ACCOUNT_CONFIG.binarySettlement),
    encodeUint(VILLA_ACCOUNT_CONFIG.initialMaxOrderQuantity),
    encodeUint(VILLA_ACCOUNT_CONFIG.initialMaxOrderCollateral),
  ].join("");
}

export function buildDeploymentData(artifact, owner) {
  if (!artifact?.creationBytecode?.startsWith("0x")) throw new AccountClientError("ARTIFACT_MISSING", "The verified VILLA account implementation is unavailable.");
  return `${artifact.creationBytecode}${encodeConstructorArgs({ owner })}`;
}

export async function request(provider, method, params = []) {
  if (!provider?.request) throw new AccountClientError("WALLET_MISSING", "Install or unlock a compatible wallet to continue.");
  try {
    return await provider.request({ method, params });
  } catch (error) {
    const code = Number(error?.code);
    if (code === 4001) throw new AccountClientError("WALLET_REJECTED", "The wallet request was cancelled.", error?.message || "");
    if (code === 4902) throw new AccountClientError("NETWORK_UNKNOWN", "Somnia Shannon is not available in this wallet.", error?.message || "");
    throw new AccountClientError("RPC_ERROR", "The wallet or network could not complete that request.", error?.message || String(error));
  }
}

export async function readCall(provider, to, data) {
  const result = await request(provider, "eth_call", [{ to, data }, "latest"]);
  if (typeof result !== "string") throw new AccountClientError("BAD_CHAIN_RESPONSE", "The network returned an invalid read response.");
  return result;
}

export async function getChainId(provider) {
  const result = await request(provider, "eth_chainId");
  return Number.parseInt(String(result), 16);
}

export async function ensureShannon(provider) {
  const current = await getChainId(provider);
  if (current === VILLA_CHAIN.id) return { switched: false, chainId: current };
  try {
    await request(provider, "wallet_switchEthereumChain", [{ chainId: VILLA_CHAIN.idHex }]);
  } catch (error) {
    if (error.code !== "NETWORK_UNKNOWN") throw error;
    await request(provider, "wallet_addEthereumChain", [{
      chainId: VILLA_CHAIN.idHex,
      chainName: VILLA_CHAIN.name,
      nativeCurrency: VILLA_CHAIN.nativeCurrency,
      rpcUrls: [VILLA_CHAIN.rpcUrl],
    }]);
    await request(provider, "wallet_switchEthereumChain", [{ chainId: VILLA_CHAIN.idHex }]);
  }
  return { switched: true, chainId: await getChainId(provider) };
}

async function bytecodeSha256(bytecode) {
  if (!globalThis.crypto?.subtle) throw new AccountClientError("ARTIFACT_INVALID", "This browser cannot verify the VILLA account implementation.");
  const bytes = new Uint8Array(String(bytecode).slice(2).match(/.{2}/g).map((pair) => Number.parseInt(pair, 16)));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function loadArtifact() {
  const response = await fetch(VILLA_ACCOUNT_CONFIG.artifactPath, { cache: "no-store" });
  if (!response.ok) throw new AccountClientError("ARTIFACT_MISSING", "The verified VILLA account implementation could not be loaded.");
  const artifact = await response.json();
  if (artifact?.schema !== "villa-browser-account-artifact-v1"
    || artifact.chainId !== VILLA_CHAIN.id
    || !/^0x[0-9a-f]+$/i.test(String(artifact.creationBytecode || ""))
    || !/^0x[0-9a-f]+$/i.test(String(artifact.runtimeBytecode || ""))) {
    throw new AccountClientError("ARTIFACT_INVALID", "The VILLA account implementation failed its integrity check.");
  }
  const [creationSha256, runtimeSha256] = await Promise.all([
    bytecodeSha256(artifact.creationBytecode),
    bytecodeSha256(artifact.runtimeBytecode),
  ]);
  if (creationSha256 !== VILLA_ACCOUNT_CONFIG.artifactCreationSha256
    || runtimeSha256 !== VILLA_ACCOUNT_CONFIG.artifactRuntimeSha256) {
    throw new AccountClientError("ARTIFACT_INVALID", "The VILLA account implementation failed its audited bytecode check.");
  }
  return artifact;
}

export async function readTokenBalance(provider, wallet) {
  return decodeUint(await readCall(provider, VILLA_ACCOUNT_CONFIG.collateralToken, encodeCall(VILLA_SELECTORS.tokenBalanceOf, [encodeAddress(wallet)])));
}

export async function readAllowance(provider, owner, spender) {
  return decodeUint(await readCall(provider, VILLA_ACCOUNT_CONFIG.collateralToken, encodeCall(VILLA_SELECTORS.allowance, [encodeAddress(owner), encodeAddress(spender)])));
}

export async function readAccount(provider, accountAddress, artifact, expectedOwner = "") {
  const account = normalizeAddress(accountAddress);
  if (!account) throw new AccountClientError("INVALID_ACCOUNT", "The account address is not valid.");
  if (await getChainId(provider) !== VILLA_CHAIN.id) {
    throw new AccountClientError("WRONG_NETWORK", "Switch to Somnia Shannon before using this account.");
  }
  const code = await request(provider, "eth_getCode", [account, "latest"]);
  const expectedRuntime = String(artifact?.runtimeBytecode || "").toLowerCase();
  if (!expectedRuntime || String(code).toLowerCase() !== expectedRuntime) {
    throw new AccountClientError("WRONG_CODE", "This address is not a verified VILLA account.");
  }
  const owner = decodeAddress(await readCall(provider, account, VILLA_SELECTORS.owner));
  const operator = decodeAddress(await readCall(provider, account, VILLA_SELECTORS.operator));
  const collateralToken = decodeAddress(await readCall(provider, account, VILLA_SELECTORS.collateralToken));
  const outcomeToken = decodeAddress(await readCall(provider, account, VILLA_SELECTORS.outcomeToken));
  const binaryModule = decodeAddress(await readCall(provider, account, VILLA_SELECTORS.binaryModule));
  const binarySettlement = decodeAddress(await readCall(provider, account, VILLA_SELECTORS.binarySettlement));
  if (collateralToken !== normalizeAddress(VILLA_ACCOUNT_CONFIG.collateralToken)) {
    throw new AccountClientError("WRONG_WIRING", "This account is not wired to the verified Shannon collateral token.");
  }
  if (outcomeToken !== normalizeAddress(VILLA_ACCOUNT_CONFIG.outcomeToken)
    || binaryModule !== normalizeAddress(VILLA_ACCOUNT_CONFIG.binaryModule)
    || binarySettlement !== normalizeAddress(VILLA_ACCOUNT_CONFIG.binarySettlement)) {
    throw new AccountClientError("WRONG_WIRING", "This account is not wired to the verified Shannon market contracts.");
  }
  if (expectedOwner && owner !== normalizeAddress(expectedOwner)) {
    throw new AccountClientError("WRONG_OWNER", "This VILLA account belongs to a different wallet.");
  }
  const balance = decodeUint(await readCall(provider, account, encodeCall(VILLA_SELECTORS.tokenBalanceOf, [encodeAddress(account)])));
  return { address: account, owner, operator, collateralToken, outcomeToken, binaryModule, binarySettlement, balance, code };
}

async function indexedAccountLogs(owner) {
  const query = new URLSearchParams({
    module: "logs",
    action: "getLogs",
    fromBlock: "0",
    toBlock: "latest",
    topic0: VILLA_ACCOUNT_CONFIG.discoveryEventTopic,
    topic1: ZERO_TOPIC,
    topic2: encodeTopicAddress(owner),
    topic0_1_opr: "and",
    topic0_2_opr: "and",
    topic1_2_opr: "and",
  });
  const response = await fetch(`${VILLA_ACCOUNT_CONFIG.discoveryApiUrl}?${query}`, { cache: "no-store" });
  if (!response.ok) throw new AccountClientError("DISCOVERY_UNAVAILABLE", "The read-only account index is unavailable.");
  const body = await response.json();
  if (body?.status !== "1" || !Array.isArray(body.result)) throw new AccountClientError("DISCOVERY_UNAVAILABLE", "The read-only account index returned no usable result.", body?.message || "");
  return body.result;
}

export async function discoverAccount(provider, owner, artifact, hint = "") {
  const normalizedOwner = normalizeAddress(owner);
  if (!normalizedOwner) throw new AccountClientError("INVALID_OWNER", "Connect a valid wallet to find your account.");
  const candidates = [];
  const addCandidate = (value) => {
    const candidate = normalizeAddress(value);
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };
  addCandidate(hint);
  try {
    const logs = await indexedAccountLogs(normalizedOwner);
    for (const log of Array.isArray(logs) ? logs : []) addCandidate(log?.address);
  } catch (error) {
    try {
      const logs = await request(provider, "eth_getLogs", [{
        fromBlock: "0x0",
        toBlock: "latest",
        topics: [VILLA_ACCOUNT_CONFIG.discoveryEventTopic, ZERO_TOPIC, encodeTopicAddress(normalizedOwner)],
      }]);
      for (const log of Array.isArray(logs) ? logs : []) addCandidate(log?.address);
    } catch (fallbackError) {
      if (!candidates.length) throw new AccountClientError("DISCOVERY_UNAVAILABLE", "Your account history could not be read yet. Retry when the network is available.", fallbackError?.message || error?.message || "");
    }
  }
  for (const candidate of candidates.reverse()) {
    try {
      return { account: await readAccount(provider, candidate, artifact, normalizedOwner), source: candidate === normalizeAddress(hint) ? "verified wallet hint" : "verified on-chain ownership event" };
    } catch {
      // A matching event is only a candidate until runtime code, wiring, and owner are verified.
    }
  }
  return { account: null, source: "no verified on-chain account found" };
}

export async function sendTransaction(provider, transaction, update = () => {}) {
  update("WAITING_FOR_WALLET");
  const hash = await request(provider, "eth_sendTransaction", [transaction]);
  update("SUBMITTED", hash);
  let receipt = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    receipt = await request(provider, "eth_getTransactionReceipt", [hash]);
    if (receipt) break;
    update("CONFIRMING", hash);
  }
  if (!receipt) throw new AccountClientError("CONFIRMATION_TIMEOUT", "The transaction is still pending. Refresh to check its confirmed state.", hash);
  if (String(receipt.status).toLowerCase() !== "0x1") throw new AccountClientError("TX_REVERTED", "The transaction was rejected by the network.", hash);
  return { hash, receipt };
}

export function actionTransaction(from, to, data) {
  return { from: normalizeAddress(from), to: normalizeAddress(to), data };
}

export function deploymentTransaction(from, data) {
  return { from: normalizeAddress(from), data };
}

export const accountCall = {
  owner: () => VILLA_SELECTORS.owner,
  operator: () => VILLA_SELECTORS.operator,
  deposit: (amount) => encodeCall(VILLA_SELECTORS.deposit, [encodeUint(amount)]),
  withdraw: (amount) => encodeCall(VILLA_SELECTORS.withdraw, [encodeUint(amount)]),
  setOperator: (operator) => encodeCall(VILLA_SELECTORS.setOperator, [encodeAddress(operator)]),
  revokeOperator: () => VILLA_SELECTORS.revokeOperator,
};

export const tokenCall = {
  approve: (account, amount) => encodeCall(VILLA_SELECTORS.approve, [encodeAddress(account), encodeUint(amount)]),
};
