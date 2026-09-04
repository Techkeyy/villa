import { VILLA_ACCOUNT_CONFIG, VILLA_CHAIN, VILLA_SELECTORS, ZERO_ADDRESS, ZERO_TOPIC } from "./account-config.mjs";

export class AccountClientError extends Error {
  constructor(code, message, detail = "") {
    super(message);
    this.name = "AccountClientError";
    this.code = code;
    this.detail = detail;
  }
}

export const DISCOVERY_TIMEOUT_MS = 8_000;
const RPC_LOG_CHUNK_SIZE = 1_000n;
const RPC_LOG_MAX_BLOCKS = 2_000n;

function timeoutError(detail = "discovery") {
  return new AccountClientError(
    "DISCOVERY_TIMEOUT",
    "Account discovery timed out. Retry when Shannon is available.",
    detail,
  );
}

function withTimeout(promise, timeoutMs, detail) {
  const delay = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DISCOVERY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError(detail)), delay);
    Promise.resolve(promise).then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function createDiscoveryDeadline(timeoutMs = DISCOVERY_TIMEOUT_MS, onDebug = () => {}) {
  const delay = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DISCOVERY_TIMEOUT_MS;
  const startedAt = Date.now();
  const deadlineAt = startedAt + delay;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let currentOperation = "discovery";
  let expired = false;
  let rejectDeadline;
  const deadlinePromise = new Promise((_, reject) => { rejectDeadline = reject; });
  const expire = () => {
    if (expired) return;
    expired = true;
    controller?.abort();
    const error = timeoutError(`Total discovery deadline exceeded during ${currentOperation}.`);
    try { onDebug("timeout_firing", { timeoutMs: delay, operation: currentOperation }); } catch {
      // Diagnostics must never change discovery behavior.
    }
    rejectDeadline(error);
  };
  const timer = setTimeout(expire, delay);
  const remaining = (detail = "discovery") => {
    currentOperation = detail || currentOperation;
    const value = deadlineAt - Date.now();
    if (value <= 0) {
      expire();
      throw timeoutError(`Total discovery deadline exceeded during ${currentOperation}.`);
    }
    return value;
  };
  const race = (promise, detail = "discovery") => {
    remaining(detail);
    return Promise.race([Promise.resolve(promise), deadlinePromise]);
  };
  return {
    signal: controller?.signal,
    startedAt,
    deadlineAt,
    remaining,
    race,
    cancel() {
      clearTimeout(timer);
    },
  };
}

function withDeadline(promise, deadline, detail) {
  return deadline ? deadline.race(promise, detail) : withTimeout(promise, DISCOVERY_TIMEOUT_MS, detail);
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  try {
    return await withTimeout(fetch(url, { cache: "no-store", ...(controller ? { signal: controller.signal } : {}) }), timeoutMs, `GET ${url}`);
  } catch (error) {
    if (error?.code === "DISCOVERY_TIMEOUT") controller?.abort();
    throw error;
  }
}

async function fetchWithDeadline(url, deadline) {
  if (!deadline) return fetchWithTimeout(url, DISCOVERY_TIMEOUT_MS);
  return withDeadline(fetch(url, { cache: "no-store", signal: deadline.signal }), deadline, `GET ${url}`);
}

function describeError(error) {
  const code = error?.code ? `${error.code}: ` : "";
  return `${code}${error?.detail || error?.message || String(error)}`;
}

function emitDebug(onDebug, event, details = {}) {
  try { onDebug?.(event, details); } catch {
    // Diagnostics must never change discovery behavior.
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

export function parseAmount(value, decimals = 6, options = {}) {
  const text = String(value ?? "").trim();
  const pattern = new RegExp(`^(?:0|[1-9]\\d*)(?:\\.\\d{1,${decimals}})?$`);
  if (!pattern.test(text) || /[eE]/.test(text)) {
    throw new AccountClientError("INVALID_AMOUNT", `Enter a positive ${VILLA_ACCOUNT_CONFIG.collateralSymbol} amount with up to ${decimals} decimal places.`);
  }
  const [whole, fraction = ""] = text.split(".");
  const raw = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals));
  if (raw <= 0n && !options.allowZero) throw new AccountClientError("INVALID_AMOUNT", "Enter an amount greater than zero.");
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
    encodeUint(VILLA_ACCOUNT_CONFIG.initialMaxAggregateExposure),
    encodeUint(VILLA_ACCOUNT_CONFIG.initialMaxMintExposure),
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

export async function readCall(provider, to, data, options = {}) {
  const result = await withDeadline(request(provider, "eth_call", [{ to, data }, "latest"]), options.deadline, `eth_call ${to}`);
  if (typeof result !== "string") throw new AccountClientError("BAD_CHAIN_RESPONSE", "The network returned an invalid read response.");
  return result;
}

export async function getChainId(provider, options = {}) {
  const result = await withDeadline(request(provider, "eth_chainId"), options.deadline, "eth_chainId");
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

function isBytecode(value) {
  return /^0x(?:[0-9a-f]{2})+$/i.test(String(value || ""));
}

export function maskImmutableReferences(bytecode, references = []) {
  const normalized = String(bytecode || "").toLowerCase();
  if (!isBytecode(normalized)) throw new AccountClientError("ARTIFACT_INVALID", "The VILLA account runtime bytecode is invalid.");
  const chars = normalized.slice(2).split("");
  const byteLength = chars.length / 2;
  for (const reference of references) {
    const start = Number(reference?.start);
    const length = Number(reference?.length);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length <= 0 || start + length > byteLength) {
      throw new AccountClientError("ARTIFACT_INVALID", "The VILLA account immutable references are invalid.");
    }
    chars.fill("0", start * 2, (start + length) * 2);
  }
  return `0x${chars.join("")}`;
}

export function runtimeBytecodeMatches(actualBytecode, expectedBytecode, references = []) {
  const actual = String(actualBytecode || "").toLowerCase();
  const expected = String(expectedBytecode || "").toLowerCase();
  if (!isBytecode(actual) || !isBytecode(expected) || actual.length !== expected.length) return false;
  if (actual === expected) return true;
  if (!Array.isArray(references) || references.length === 0) return false;
  try {
    return maskImmutableReferences(actual, references) === maskImmutableReferences(expected, references);
  } catch {
    return false;
  }
}

export async function loadArtifact(options = {}) {
  const deadline = options.deadline;
  const response = await fetchWithDeadline(VILLA_ACCOUNT_CONFIG.artifactPath, deadline);
  if (!response.ok) throw new AccountClientError("ARTIFACT_MISSING", "The verified VILLA account implementation could not be loaded.");
  const artifact = await withDeadline(response.json(), deadline, "VILLA account artifact response body");
  if (artifact?.schema !== "villa-browser-account-artifact-v2"
    || Number(artifact.accountVersion) !== 2
    || artifact.chainId !== VILLA_CHAIN.id
    || !isBytecode(artifact.creationBytecode)
    || !isBytecode(artifact.runtimeBytecode)
    || !Array.isArray(artifact.runtimeImmutableReferences)
    || artifact.runtimeImmutableReferences.length === 0) {
    throw new AccountClientError("ARTIFACT_INVALID", "The VILLA account implementation failed its integrity check.");
  }
  try {
    maskImmutableReferences(artifact.runtimeBytecode, artifact.runtimeImmutableReferences);
  } catch {
    throw new AccountClientError("ARTIFACT_INVALID", "The VILLA account implementation failed its immutable-reference check.");
  }
  const [creationSha256, runtimeSha256] = await withDeadline(Promise.all([
    bytecodeSha256(artifact.creationBytecode),
    bytecodeSha256(artifact.runtimeBytecode),
  ]), deadline, "VILLA account artifact integrity");
  if (creationSha256 !== VILLA_ACCOUNT_CONFIG.artifactCreationSha256
    || runtimeSha256 !== VILLA_ACCOUNT_CONFIG.artifactRuntimeSha256) {
    throw new AccountClientError("ARTIFACT_INVALID", "The VILLA account implementation failed its audited bytecode check.");
  }
  return artifact;
}

export async function loadLegacyArtifact(options = {}) {
  const deadline = options.deadline;
  const response = await fetchWithDeadline(VILLA_ACCOUNT_CONFIG.legacyArtifactPath, deadline);
  if (!response.ok) throw new AccountClientError("ARTIFACT_MISSING", "The legacy VILLA account implementation could not be loaded.");
  const artifact = await withDeadline(response.json(), deadline, "legacy VILLA account artifact response body");
  if (artifact?.schema !== "villa-browser-account-artifact-v2"
    || artifact.chainId !== VILLA_CHAIN.id
    || !isBytecode(artifact.creationBytecode)
    || !isBytecode(artifact.runtimeBytecode)
    || !Array.isArray(artifact.runtimeImmutableReferences)
    || artifact.runtimeImmutableReferences.length === 0) {
    throw new AccountClientError("ARTIFACT_INVALID", "The legacy VILLA account implementation failed its integrity check.");
  }
  const [creationSha256, runtimeSha256] = await withDeadline(Promise.all([
    bytecodeSha256(artifact.creationBytecode),
    bytecodeSha256(artifact.runtimeBytecode),
  ]), deadline, "legacy VILLA account artifact integrity");
  if (creationSha256 !== VILLA_ACCOUNT_CONFIG.legacyV1CreationSha256
    || runtimeSha256 !== VILLA_ACCOUNT_CONFIG.legacyV1RuntimeSha256) {
    throw new AccountClientError("ARTIFACT_INVALID", "The legacy VILLA account implementation failed its audited bytecode check.");
  }
  return { ...artifact, accountVersion: 1 };
}

export async function loadAccountArtifacts(options = {}) {
  const [v2, v1] = await Promise.all([
    loadArtifact(options),
    loadLegacyArtifact(options),
  ]);
  return Object.freeze([v2, v1]);
}

export async function readTokenBalance(provider, wallet, options = {}) {
  return decodeUint(await readCall(provider, VILLA_ACCOUNT_CONFIG.collateralToken, encodeCall(VILLA_SELECTORS.tokenBalanceOf, [encodeAddress(wallet)]), options));
}

export async function readAllowance(provider, owner, spender) {
  return decodeUint(await readCall(provider, VILLA_ACCOUNT_CONFIG.collateralToken, encodeCall(VILLA_SELECTORS.allowance, [encodeAddress(owner), encodeAddress(spender)])));
}

export async function readAccount(provider, accountAddress, artifact, expectedOwner = "", options = {}) {
  const account = normalizeAddress(accountAddress);
  if (!account) throw new AccountClientError("INVALID_ACCOUNT", "The account address is not valid.");
  if (await getChainId(provider, options) !== VILLA_CHAIN.id) {
    throw new AccountClientError("WRONG_NETWORK", "Switch to Somnia Shannon before using this account.");
  }
  const code = await withDeadline(request(provider, "eth_getCode", [account, "latest"]), options.deadline, `eth_getCode ${account}`);
  const artifacts = Array.isArray(artifact) ? artifact : [artifact];
  const matchedArtifact = artifacts.find((candidate) => runtimeBytecodeMatches(code, candidate?.runtimeBytecode, candidate?.runtimeImmutableReferences));
  if (!matchedArtifact) {
    throw new AccountClientError("WRONG_CODE", "This address is not a verified VILLA account.");
  }
  const owner = decodeAddress(await readCall(provider, account, VILLA_SELECTORS.owner, options));
  const operator = decodeAddress(await readCall(provider, account, VILLA_SELECTORS.operator, options));
  const collateralToken = decodeAddress(await readCall(provider, account, VILLA_SELECTORS.collateralToken, options));
  const outcomeToken = decodeAddress(await readCall(provider, account, VILLA_SELECTORS.outcomeToken, options));
  const accountVersion = Number(matchedArtifact.accountVersion);
  if (accountVersion !== 1 && accountVersion !== 2) {
    throw new AccountClientError("ARTIFACT_INVALID", "The matched VILLA account artifact has no explicit version.");
  }
  let autonomousTradingEnabled = accountVersion === 2;
  try {
    const result = await readCall(provider, account, VILLA_SELECTORS.autonomousTradingEnabled, options);
    autonomousTradingEnabled = decodeUint(result) !== 0n;
  } catch {
    // V1 accounts do not expose the V2 autonomous-trading circuit breaker.
    autonomousTradingEnabled = false;
  }
  const binaryModule = decodeAddress(await readCall(provider, account, VILLA_SELECTORS.binaryModule, options));
  const binarySettlement = decodeAddress(await readCall(provider, account, VILLA_SELECTORS.binarySettlement, options));
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
  const balance = await readTokenBalance(provider, account, options);
  return { address: account, owner, operator, accountVersion, version: accountVersion, autonomousTradingEnabled: accountVersion === 2 && autonomousTradingEnabled, collateralToken, outcomeToken, binaryModule, binarySettlement, balance, code, verification: "VERIFIED" };
}

function classifyExplorerBody(body) {
  if (body?.status === "0" && Array.isArray(body.result) && body.result.length === 0 && /no logs found/i.test(String(body.message || ""))) return "NO_LOGS";
  if (body?.status === "1" && Array.isArray(body.result)) return body.result.length ? "MATCHING_LOGS" : "EMPTY_LOGS";
  if (body?.status === "0") return "API_ERROR";
  return "MALFORMED";
}

async function indexedAccountLogs(owner, deadline, onDebug) {
  const topic2 = encodeTopicAddress(owner);
  const query = new URLSearchParams({
    module: "logs",
    action: "getLogs",
    fromBlock: "0",
    toBlock: "latest",
    topic0: VILLA_ACCOUNT_CONFIG.discoveryEventTopic,
    topic1: ZERO_TOPIC,
    topic2,
    topic0_1_opr: "and",
    topic0_2_opr: "and",
    topic1_2_opr: "and",
  });
  const url = `${VILLA_ACCOUNT_CONFIG.discoveryApiUrl}?${query}`;
  emitDebug(onDebug, "explorer_request_start", {
    owner,
    fromBlock: "0",
    toBlock: "latest",
    topic0: VILLA_ACCOUNT_CONFIG.discoveryEventTopic,
    topic1: ZERO_TOPIC,
    topic2,
  });
  let response;
  try {
    response = await fetchWithDeadline(url, deadline);
  } catch (error) {
    emitDebug(onDebug, "explorer_request_end", { httpStatus: null, bodyClassification: error?.code === "DISCOVERY_TIMEOUT" ? "TIMEOUT" : "REQUEST_ERROR" });
    throw error;
  }
  if (!response.ok) {
    emitDebug(onDebug, "explorer_request_end", { httpStatus: response.status, bodyClassification: "HTTP_ERROR" });
    throw new AccountClientError("DISCOVERY_UNAVAILABLE", "The read-only account index is unavailable.", `Explorer returned HTTP ${response.status}.`);
  }
  let body;
  try {
    body = await withDeadline(response.json(), deadline, "Explorer response body");
  } catch (error) {
    emitDebug(onDebug, "explorer_request_end", { httpStatus: response.status, bodyClassification: error?.code === "DISCOVERY_TIMEOUT" ? "TIMEOUT" : "MALFORMED" });
    throw error;
  }
  const classification = classifyExplorerBody(body);
  emitDebug(onDebug, "explorer_request_end", { httpStatus: response.status, bodyClassification: classification, logCount: Array.isArray(body?.result) ? body.result.length : null });
  if (classification === "NO_LOGS") return [];
  if (classification !== "MATCHING_LOGS") throw new AccountClientError("DISCOVERY_UNAVAILABLE", "The read-only account index returned no usable result.", body?.message || "");
  return body.result;
}

function blockTag(value) {
  return `0x${value.toString(16)}`;
}

async function rpcAccountLogs(provider, owner, deadline, onDebug) {
  emitDebug(onDebug, "rpc_fallback_start", { owner, maxBlocks: RPC_LOG_MAX_BLOCKS.toString(), chunkSize: RPC_LOG_CHUNK_SIZE.toString() });
  try {
    const headResult = await withDeadline(request(provider, "eth_blockNumber"), deadline, "eth_blockNumber");
    let head;
    try {
      head = BigInt(headResult);
    } catch {
      throw new AccountClientError("BAD_CHAIN_RESPONSE", "The network returned an invalid block number.", String(headResult));
    }
    if (head < 0n) throw new AccountClientError("BAD_CHAIN_RESPONSE", "The network returned an invalid block number.", String(headResult));

    const first = head > RPC_LOG_MAX_BLOCKS - 1n ? head - (RPC_LOG_MAX_BLOCKS - 1n) : 0n;
    const logs = [];
    let chunks = 0;
    for (let from = first; from <= head; from += RPC_LOG_CHUNK_SIZE) {
      const to = from + RPC_LOG_CHUNK_SIZE - 1n < head ? from + RPC_LOG_CHUNK_SIZE - 1n : head;
      const result = await withDeadline(request(provider, "eth_getLogs", [{
        fromBlock: blockTag(from),
        toBlock: blockTag(to),
        topics: [VILLA_ACCOUNT_CONFIG.discoveryEventTopic, ZERO_TOPIC, encodeTopicAddress(owner)],
      }]), deadline, `eth_getLogs ${blockTag(from)}-${blockTag(to)}`);
      if (!Array.isArray(result)) throw new AccountClientError("BAD_CHAIN_RESPONSE", "The network returned an invalid account history response.");
      logs.push(...result);
      chunks += 1;
    }
    if (first > 0n && logs.length === 0) {
      throw new AccountClientError(
        "DISCOVERY_UNAVAILABLE",
        "The wallet RPC cannot prove full account history without an index.",
        `eth_getLogs scanned ${blockTag(first)}-${blockTag(head)} only; direct deployments have no registry.`,
      );
    }
    emitDebug(onDebug, "rpc_fallback_end", { result: "success", scannedFrom: blockTag(first), scannedTo: blockTag(head), chunks, logCount: logs.length });
    return logs;
  } catch (error) {
    emitDebug(onDebug, "rpc_fallback_end", { result: error?.code === "DISCOVERY_TIMEOUT" ? "TIMEOUT" : "ERROR", errorCode: error?.code || "UNKNOWN" });
    throw error;
  }
}

export async function discoverAccount(provider, owner, artifact, hint = "", options = {}) {
  const normalizedOwner = normalizeAddress(owner);
  if (!normalizedOwner) {
    const error = new AccountClientError("INVALID_OWNER", "Connect a valid wallet to find your account.");
    return { kind: "ERROR", error };
  }
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DISCOVERY_TIMEOUT_MS;
  const onDebug = typeof options.onDebug === "function" ? options.onDebug : () => {};
  const ownsDeadline = !options.deadline;
  const deadline = options.deadline || createDiscoveryDeadline(timeoutMs, onDebug);
  const candidates = [];
  const verificationFailures = [];
  const addCandidate = (value) => {
    const candidate = normalizeAddress(value);
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };
  addCandidate(hint);
  emitDebug(onDebug, "discovery_start", { owner: normalizedOwner, hasHint: Boolean(normalizeAddress(hint)) });
  try {
    try {
      const logs = await indexedAccountLogs(normalizedOwner, deadline, onDebug);
      for (const log of Array.isArray(logs) ? logs : []) addCandidate(log?.address);
    } catch (explorerError) {
      if (explorerError?.code === "DISCOVERY_TIMEOUT") throw explorerError;
      try {
        const logs = await rpcAccountLogs(provider, normalizedOwner, deadline, onDebug);
        for (const log of Array.isArray(logs) ? logs : []) addCandidate(log?.address);
      } catch (fallbackError) {
        if (fallbackError?.code === "DISCOVERY_TIMEOUT") throw fallbackError;
        if (!candidates.length) {
          const explorerDetail = describeError(explorerError);
          const fallbackDetail = describeError(fallbackError);
          throw new AccountClientError(
            "DISCOVERY_UNAVAILABLE",
            "Your account history could not be read yet. Retry when the network is available.",
            `Explorer: ${explorerDetail}; RPC: ${fallbackDetail}`,
          );
        }
      }
    }
    for (const candidate of candidates.reverse()) {
      try {
        const account = await readAccount(provider, candidate, artifact, normalizedOwner, { deadline });
        const source = candidate === normalizeAddress(hint) ? "verified wallet hint" : "verified on-chain ownership event";
        emitDebug(onDebug, "discovery_complete", { source, accountFound: true });
        return { kind: "DISCOVERED", account, source };
      } catch (error) {
        if (error?.code === "DISCOVERY_TIMEOUT") throw error;
        verificationFailures.push({ candidate, code: error?.code || "VERIFICATION_FAILED" });
      }
    }
    if (verificationFailures.length) {
      const firstFailure = verificationFailures[0];
      const error = new AccountClientError(
        "UNVERIFIED_CANDIDATE",
        "VILLA found a contract associated with this wallet, but could not verify it as a valid VILLA account.",
        `Candidate ${firstFailure.candidate} failed ${firstFailure.code}.`,
      );
      emitDebug(onDebug, "discovery_complete", {
        source: "candidate verification failed",
        accountFound: false,
        errorCode: error.code,
        failedCandidateCount: verificationFailures.length,
      });
      return {
        kind: "SECURITY_ERROR",
        account: null,
        source: "candidate verification failed",
        candidate: firstFailure.candidate,
        failures: verificationFailures,
        error,
      };
    }
    emitDebug(onDebug, "discovery_complete", { source: "no verified on-chain account found", accountFound: false });
    return { kind: "NO_ACCOUNT", account: null, source: "no verified on-chain account found" };
  } catch (error) {
    emitDebug(onDebug, "discovery_complete", { source: "error", accountFound: false, errorCode: error?.code || "UNKNOWN" });
    return { kind: "ERROR", error };
  } finally {
    if (ownsDeadline) deadline.cancel();
  }
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
