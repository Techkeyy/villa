import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildDeploymentData,
  decodeAddress,
  discoverAccount,
  encodeAddress,
  encodeConstructorArgs,
  encodeTopicAddress,
  actionTransaction,
  accountCall,
  ensureShannon,
  formatAmount,
  normalizeAddress,
  runtimeBytecodeMatches,
  maskImmutableReferences,
  parseAmount,
  readAccount,
  tokenCall,
} from "../../dashboard/account-client.mjs";
import { VILLA_ACCOUNT_CONFIG, VILLA_CHAIN, VILLA_SELECTORS, ZERO_ADDRESS, ZERO_TOPIC } from "../../dashboard/account-config.mjs";

const artifact = JSON.parse(fs.readFileSync(new URL("../../dashboard/villa-account-artifact.json", import.meta.url), "utf8"));

test("amount parsing is exact and rejects unsafe numeric input", () => {
  assert.equal(parseAmount("25"), 25_000_000n);
  assert.equal(parseAmount("0.000001"), 1n);
  assert.equal(parseAmount("25.50"), 25_500_000n);
  assert.equal(formatAmount(25_500_000n), "25.50");
  for (const value of ["0", "-1", "1.0000001", "1e3", "NaN", "Infinity", "0.1e2", ""]) {
    assert.throws(() => parseAmount(value), /amount/i, value);
  }
});

test("addresses and constructor encoding stay fixed to the audited config", () => {
  const owner = "0xCAecf98CD369D57e4e6c0f332C31815C192b7a81";
  assert.equal(normalizeAddress(owner), owner.toLowerCase());
  assert.equal(encodeAddress(owner).length, 64);
  assert.equal(encodeConstructorArgs({ owner }).length, 8 * 64);
  const data = buildDeploymentData(artifact, owner);
  assert.equal(data.slice(0, 2), "0x");
  assert.equal(data.slice(2, 2 + artifact.creationBytecode.length - 2), artifact.creationBytecode.slice(2));
  assert.match(data, new RegExp(`${encodeAddress(owner)}${encodeAddress(ZERO_ADDRESS)}`));
  assert.equal(VILLA_CHAIN.id, 50312);
  assert.equal(VILLA_ACCOUNT_CONFIG.collateralDecimals, 6);
  assert.equal(VILLA_ACCOUNT_CONFIG.operator.length, 42);
  assert.match(data, new RegExp(`${encodeAddress(VILLA_ACCOUNT_CONFIG.collateralToken)}${encodeAddress(VILLA_ACCOUNT_CONFIG.outcomeToken)}${encodeAddress(VILLA_ACCOUNT_CONFIG.binaryModule)}${encodeAddress(VILLA_ACCOUNT_CONFIG.binarySettlement)}`));
});

test("capital and authorization calls remain owner-scoped and destination-free", () => {
  const owner = "0xcaecf98cd369d57e4e6c0f332c31815c192b7a81";
  const account = "0xe78bd09d6869e450e66a49d1d3beebbfa75fb0cd";
  const amount = 25_000_000n;
  assert.deepEqual(actionTransaction(owner, account, accountCall.deposit(amount)), {
    from: owner,
    to: account,
    data: accountCall.deposit(amount),
  });
  assert.match(tokenCall.approve(account, amount), /^0x095ea7b3/);
  assert.match(accountCall.setOperator(VILLA_ACCOUNT_CONFIG.operator), /^0xb3ab15fb/);
  assert.match(accountCall.revokeOperator(), /^0xb674759c/);
  assert.equal(accountCall.withdraw(amount).length, 2 + 8 + 64);
  assert.doesNotMatch(accountCall.withdraw(amount), new RegExp(owner.slice(2)));
});

test("account verification isolates owners and rejects mismatched immutable wiring", async () => {
  const owner = "0xcaecf98cd369d57e4e6c0f332c31815c192b7a81";
  const otherOwner = "0x1111111111111111111111111111111111111111";
  const account = "0xe78bd09d6869e450e66a49d1d3beebbfa75fb0cd";
  const runtimeBytecode = "0x6001600055";
  const addressResult = (value) => `0x${"0".repeat(24)}${value.slice(2)}`;
  const uintResult = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
  let balanceTarget = "";
  const provider = {
    async request({ method, params }) {
      if (method === "eth_chainId") return VILLA_CHAIN.idHex;
      if (method === "eth_getCode") return runtimeBytecode;
      if (method !== "eth_call") throw new Error(`unexpected method ${method}`);
      const selector = params[0].data.slice(0, 10);
      if (selector === VILLA_SELECTORS.owner) return addressResult(owner);
      if (selector === VILLA_SELECTORS.operator) return addressResult(ZERO_ADDRESS);
      if (selector === VILLA_SELECTORS.collateralToken) return addressResult(VILLA_ACCOUNT_CONFIG.collateralToken);
      if (selector === VILLA_SELECTORS.outcomeToken) return addressResult(VILLA_ACCOUNT_CONFIG.outcomeToken);
      if (selector === VILLA_SELECTORS.binaryModule) return addressResult(VILLA_ACCOUNT_CONFIG.binaryModule);
      if (selector === VILLA_SELECTORS.binarySettlement) return addressResult(VILLA_ACCOUNT_CONFIG.binarySettlement);
      if (selector === VILLA_SELECTORS.tokenBalanceOf) {
        balanceTarget = params[0].to;
        return uintResult(25_000_000n);
      }
      throw new Error(`unexpected selector ${selector}`);
    },
  };
  const accountData = await readAccount(provider, account, { runtimeBytecode }, owner);
  assert.equal(accountData.owner, owner);
  assert.equal(accountData.balance, 25_000_000n);
  assert.equal(balanceTarget.toLowerCase(), VILLA_ACCOUNT_CONFIG.collateralToken.toLowerCase());
  await assert.rejects(() => readAccount(provider, account, { runtimeBytecode }, otherOwner), /different wallet/i);
  const wrongWiringProvider = { ...provider, request: async (request) => {
    const result = await provider.request(request);
    if (request.method === "eth_call" && request.params[0].data.startsWith(VILLA_SELECTORS.binaryModule)) return addressResult(otherOwner);
    return result;
  } };
  await assert.rejects(() => readAccount(wrongWiringProvider, account, { runtimeBytecode }, owner), /wired/i);
});

test("runtime identity masks only compiler immutable slots and preserves logic checks", () => {
  const runtimeTemplate = `0x${"00".repeat(64)}`;
  const references = [{ start: 8, length: 20 }];
  const deployedRuntime = `0x${"00".repeat(8)}${"11".repeat(20)}${"00".repeat(36)}`;
  assert.notEqual(deployedRuntime, runtimeTemplate);
  assert.equal(runtimeBytecodeMatches(deployedRuntime, runtimeTemplate, references), true);
  assert.equal(maskImmutableReferences(deployedRuntime, references), maskImmutableReferences(runtimeTemplate, references));
  assert.equal(runtimeBytecodeMatches(`0xaa${deployedRuntime.slice(4)}`, runtimeTemplate, references), false);
});

test("normalized runtime acceptance still rejects wrong immutable protocol wiring", async () => {
  const owner = "0xcaecf98cd369d57e4e6c0f332c31815c192b7a81";
  const account = "0xe78bd09d6869e450e66a49d1d3beebbfa75fb0cd";
  const runtimeTemplate = `0x${"00".repeat(64)}`;
  const runtimeImmutableReferences = [{ start: 8, length: 20 }];
  const deployedRuntime = `0x${"00".repeat(8)}${"11".repeat(20)}${"00".repeat(36)}`;
  const addressResult = (value) => `0x${"0".repeat(24)}${value.slice(2)}`;
  const provider = {
    async request({ method, params }) {
      if (method === "eth_chainId") return VILLA_CHAIN.idHex;
      if (method === "eth_getCode") return deployedRuntime;
      if (method !== "eth_call") throw new Error(`unexpected method ${method}`);
      const selector = params[0].data.slice(0, 10);
      if (selector === VILLA_SELECTORS.owner) return addressResult(owner);
      if (selector === VILLA_SELECTORS.operator) return addressResult(ZERO_ADDRESS);
      if (selector === VILLA_SELECTORS.collateralToken) return addressResult("0x1111111111111111111111111111111111111111");
      if (selector === VILLA_SELECTORS.outcomeToken) return addressResult(VILLA_ACCOUNT_CONFIG.outcomeToken);
      if (selector === VILLA_SELECTORS.binaryModule) return addressResult(VILLA_ACCOUNT_CONFIG.binaryModule);
      if (selector === VILLA_SELECTORS.binarySettlement) return addressResult(VILLA_ACCOUNT_CONFIG.binarySettlement);
      throw new Error(`unexpected selector ${selector}`);
    },
  };
  await assert.rejects(
    () => readAccount(provider, account, { runtimeBytecode: runtimeTemplate, runtimeImmutableReferences }, owner),
    (error) => error.code === "WRONG_WIRING",
  );
});

test("chain reads verify exact runtime, owner, and trusted operator before UI state", () => {
  const source = fs.readFileSync(new URL("../../dashboard/account-client.mjs", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../../dashboard/app.mjs", import.meta.url), "utf8");
  assert.match(source, /eth_getCode/);
  assert.match(source, /artifact\?\.runtimeBytecode/);
  assert.match(source, /artifactCreationSha256/);
  assert.match(source, /artifactRuntimeSha256/);
  assert.match(source, /runtimeImmutableReferences/);
  assert.match(source, /runtimeBytecodeMatches/);
  assert.match(source, /SHA-256/);
  assert.match(source, /expectedOwner/);
  assert.match(source, /eth_getLogs/);
  assert.match(source, /indexedAccountLogs/);
  assert.match(source, /discoveryEventTopic/);
  assert.match(source, /VILLA_SELECTORS\.outcomeToken/);
  assert.match(source, /VILLA_SELECTORS\.binaryModule/);
  assert.match(source, /VILLA_SELECTORS\.binarySettlement/);
  assert.match(source, /VILLA_CHAIN\.id/);
  assert.match(source, /kind: "NO_ACCOUNT"/);
  assert.match(source, /kind: "DISCOVERED"/);
  assert.match(source, /kind: "SECURITY_ERROR"/);
  assert.match(source, /kind: "ERROR"/);
  assert.match(app, /readAccount\(provider, appState\.account\.address/);
  assert.match(app, /SECURITY_ERROR/);
  assert.doesNotMatch(app, /URLSearchParams|searchParams\.get\(["']account/);
  assert.match(app, /accountsChanged/);
  assert.match(app, /chainChanged/);
  assert.match(app, /unexpectedOperator/);
  assert.match(app, /withdraw-capital/);
  assert.match(app, /start-villa["'][^>]*disabled/);
  assert.match(app, /WAITING_FOR_WALLET/);
  assert.match(app, /SUBMITTED/);
  assert.match(app, /CONFIRMING/);
  assert.match(app, /SUCCESS/);
  assert.match(app, /FAILED/);
});

test("Shannon network switching verifies the target chain and adds unknown networks", async () => {
  let chainId = "0x1";
  let switchAttempts = 0;
  const calls = [];
  const provider = {
    async request({ method, params }) {
      calls.push({ method, params });
      if (method === "eth_chainId") return chainId;
      if (method === "wallet_switchEthereumChain") {
        switchAttempts += 1;
        if (switchAttempts === 1) throw { code: 4902, message: "unknown chain" };
        chainId = VILLA_CHAIN.idHex;
        return null;
      }
      if (method === "wallet_addEthereumChain") return null;
      throw new Error(`unexpected method ${method}`);
    },
  };

  const result = await ensureShannon(provider);
  assert.deepEqual(result, { switched: true, chainId: VILLA_CHAIN.id });
  assert.deepEqual(calls.map(({ method }) => method), [
    "eth_chainId",
    "wallet_switchEthereumChain",
    "wallet_addEthereumChain",
    "wallet_switchEthereumChain",
    "eth_chainId",
  ]);
  assert.deepEqual(calls[2].params[0], {
    chainId: VILLA_CHAIN.idHex,
    chainName: VILLA_CHAIN.name,
    nativeCurrency: VILLA_CHAIN.nativeCurrency,
    rpcUrls: [VILLA_CHAIN.rpcUrl],
  });
});

test("rejected network switching returns a stable wallet error without adding a chain", async () => {
  const methods = [];
  const provider = {
    async request({ method }) {
      methods.push(method);
      if (method === "eth_chainId") return "0x1";
      throw { code: 4001, message: "user rejected" };
    },
  };

  await assert.rejects(() => ensureShannon(provider), (error) => error.code === "WALLET_REJECTED");
  assert.deepEqual(methods, ["eth_chainId", "wallet_switchEthereumChain"]);
});

test("wrong-network UI keeps switching actionable and gates account discovery", () => {
  const app = fs.readFileSync(new URL("../../dashboard/app.mjs", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../../dashboard/index.html", import.meta.url), "utf8");
  const wrongNetworkBranch = app.indexOf('if (!setNetworkState(chainId))');
  const discoveryCall = app.indexOf("discoverAccount(");
  assert.ok(wrongNetworkBranch >= 0 && wrongNetworkBranch < discoveryCall, "wrong network must return before discovery");
  assert.match(app, /setAppState\(\{[\s\S]*chainStatus: "WRONG_NETWORK"/);
  assert.match(app, /discoveryStatus: "IDLE"/);
  assert.doesNotMatch(app, /toggle\("account-loading", false\)/);
  assert.match(app, /ensureShannon\(provider\)[\s\S]*await refreshAccount\(\)/);
  assert.match(app, /ownerAtStart !== appState\.owner/);
  assert.match(html, /id="switch-network"[^>]*>Switch to Shannon<\/button>/);
  assert.doesNotMatch(html, /id="switch-network"[^>]*disabled/);
});

test("Explorer no-logs response is a genuine no-account result", async () => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { message: "No logs found", result: [], status: "0" };
    },
  });
  const provider = {
    async request() {
      providerCalls += 1;
      throw new Error("RPC fallback must not run for a valid empty index result");
    },
  };
  try {
    const result = await discoverAccount(provider, "0x1111111111111111111111111111111111111111", artifact);
    assert.deepEqual(result, { kind: "NO_ACCOUNT", account: null, source: "no verified on-chain account found" });
    assert.equal(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("real-style owner discovery encodes the indexed owner topic exactly", async () => {
  const originalFetch = globalThis.fetch;
  const owner = "0xCAECF98CD369D57E4E6C0F332C31815C192B7A81";
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = new URL(url);
    return {
      ok: true,
      async json() {
        return { message: "No logs found", result: [], status: "0" };
      },
    };
  };
  try {
    await discoverAccount({ request: async () => { throw new Error("RPC fallback must not run"); } }, owner, artifact);
    assert.equal(requestedUrl.searchParams.get("topic0"), VILLA_ACCOUNT_CONFIG.discoveryEventTopic);
    assert.equal(requestedUrl.searchParams.get("topic1"), ZERO_TOPIC);
    assert.equal(requestedUrl.searchParams.get("topic2"), encodeTopicAddress(owner));
    assert.equal(requestedUrl.searchParams.get("fromBlock"), "0");
    assert.equal(requestedUrl.searchParams.get("toBlock"), "latest");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Explorer failure uses a bounded RPC fallback and still verifies candidates", async () => {
  const originalFetch = globalThis.fetch;
  const owner = "0xcaecf98cd369d57e4e6c0f332c31815c192b7a81";
  const account = "0xe78bd09d6869e450e66a49d1d3beebbfa75fb0cd";
  const addressResult = (value) => `0x${"0".repeat(24)}${value.slice(2)}`;
  const uintResult = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
  const calls = [];
  globalThis.fetch = async () => { throw new Error("Explorer unavailable"); };
  const provider = {
    async request({ method, params }) {
      calls.push({ method, params });
      if (method === "eth_blockNumber") return "0x7d0";
      if (method === "eth_chainId") return VILLA_CHAIN.idHex;
      if (method === "eth_getLogs") {
        return params[0].fromBlock === "0x3e9" ? [{ address: account }] : [];
      }
      if (method === "eth_getCode") return artifact.runtimeBytecode;
      if (method !== "eth_call") throw new Error(`unexpected method ${method}`);
      const selector = params[0].data.slice(0, 10);
      if (selector === VILLA_SELECTORS.owner) return addressResult(owner);
      if (selector === VILLA_SELECTORS.operator) return addressResult(ZERO_ADDRESS);
      if (selector === VILLA_SELECTORS.collateralToken) return addressResult(VILLA_ACCOUNT_CONFIG.collateralToken);
      if (selector === VILLA_SELECTORS.outcomeToken) return addressResult(VILLA_ACCOUNT_CONFIG.outcomeToken);
      if (selector === VILLA_SELECTORS.binaryModule) return addressResult(VILLA_ACCOUNT_CONFIG.binaryModule);
      if (selector === VILLA_SELECTORS.binarySettlement) return addressResult(VILLA_ACCOUNT_CONFIG.binarySettlement);
      if (selector === VILLA_SELECTORS.tokenBalanceOf) return uintResult(25_000_000n);
      throw new Error(`unexpected selector ${selector}`);
    },
  };
  try {
    const result = await discoverAccount(provider, owner, artifact);
    assert.equal(result.kind, "DISCOVERED");
    assert.equal(result.account.address, account);
    assert.equal(result.source, "verified on-chain ownership event");
    const logCalls = calls.filter(({ method }) => method === "eth_getLogs");
    assert.equal(logCalls.length, 2);
    assert.deepEqual(logCalls.map(({ params }) => [params[0].fromBlock, params[0].toBlock]), [["0x1", "0x3e8"], ["0x3e9", "0x7d0"]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a discovered but unverified candidate is a security error, never a no-account result", async () => {
  const originalFetch = globalThis.fetch;
  const owner = "0xcaecf98cd369d57e4e6c0f332c31815c192b7a81";
  const account = "0xfc9dbf0a8468aa56799b4e23b1ebe936426ee30b";
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { status: "1", result: [{ address: account }] };
    },
  });
  const provider = {
    async request({ method }) {
      if (method === "eth_chainId") return VILLA_CHAIN.idHex;
      if (method === "eth_getCode") return "0x6000";
      throw new Error(`unexpected method ${method}`);
    },
  };
  try {
    const result = await discoverAccount(provider, owner, artifact);
    assert.equal(result.kind, "SECURITY_ERROR");
    assert.equal(result.error.code, "UNVERIFIED_CANDIDATE");
    assert.equal(result.candidate, account);
    assert.notEqual(result.kind, "NO_ACCOUNT");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an invalid candidate does not hide a later valid owner account", async () => {
  const originalFetch = globalThis.fetch;
  const owner = "0xcaecf98cd369d57e4e6c0f332c31815c192b7a81";
  const validAccount = "0xe78bd09d6869e450e66a49d1d3beebbfa75fb0cd";
  const invalidAccount = "0xfc9dbf0a8468aa56799b4e23b1ebe936426ee30b";
  const addressResult = (value) => `0x${"0".repeat(24)}${value.slice(2)}`;
  const uintResult = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { status: "1", result: [{ address: validAccount }, { address: invalidAccount }] };
    },
  });
  const provider = {
    async request({ method, params }) {
      if (method === "eth_chainId") return VILLA_CHAIN.idHex;
      if (method === "eth_getCode") return params[0] === validAccount ? artifact.runtimeBytecode : "0x6000";
      if (method !== "eth_call") throw new Error(`unexpected method ${method}`);
      const selector = params[0].data.slice(0, 10);
      if (selector === VILLA_SELECTORS.owner) return addressResult(owner);
      if (selector === VILLA_SELECTORS.operator) return addressResult(ZERO_ADDRESS);
      if (selector === VILLA_SELECTORS.collateralToken) return addressResult(VILLA_ACCOUNT_CONFIG.collateralToken);
      if (selector === VILLA_SELECTORS.outcomeToken) return addressResult(VILLA_ACCOUNT_CONFIG.outcomeToken);
      if (selector === VILLA_SELECTORS.binaryModule) return addressResult(VILLA_ACCOUNT_CONFIG.binaryModule);
      if (selector === VILLA_SELECTORS.binarySettlement) return addressResult(VILLA_ACCOUNT_CONFIG.binarySettlement);
      if (selector === VILLA_SELECTORS.tokenBalanceOf) return uintResult(0);
      throw new Error(`unexpected selector ${selector}`);
    },
  };
  try {
    const result = await discoverAccount(provider, owner, artifact);
    assert.equal(result.kind, "DISCOVERED");
    assert.equal(result.account.address, validAccount);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discovery timeout settles to an explicit error with no indefinite request", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  const provider = { request: () => new Promise(() => {}) };
  try {
    const result = await discoverAccount(provider, "0x1111111111111111111111111111111111111111", artifact, "", { timeoutMs: 5 });
    assert.equal(result.kind, "ERROR");
    assert.equal(result.error.code, "DISCOVERY_TIMEOUT");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hanging RPC fallback settles at the same total discovery deadline", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Explorer unavailable"); };
  const provider = {
    request({ method }) {
      if (method === "eth_blockNumber") return new Promise(() => {});
      throw new Error(`unexpected method ${method}`);
    },
  };
  try {
    const result = await discoverAccount(provider, "0x1111111111111111111111111111111111111111", artifact, "", { timeoutMs: 10 });
    assert.equal(result.kind, "ERROR");
    assert.equal(result.error.code, "DISCOVERY_TIMEOUT");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a hanging candidate verification read cannot keep discovery pending", async () => {
  const originalFetch = globalThis.fetch;
  const account = "0xe78bd09d6869e450e66a49d1d3beebbfa75fb0cd";
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { status: "1", result: [{ address: account }] };
    },
  });
  const provider = {
    request({ method }) {
      if (method === "eth_chainId") return VILLA_CHAIN.idHex;
      if (method === "eth_getCode") return new Promise(() => {});
      throw new Error(`unexpected method ${method}`);
    },
  };
  try {
    const result = await discoverAccount(provider, "0xcaecf98cd369d57e4e6c0f332c31815c192b7a81", artifact, "", { timeoutMs: 10 });
    assert.equal(result.kind, "ERROR");
    assert.equal(result.error.code, "DISCOVERY_TIMEOUT");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discovery UI has explicit stable states, retry, and stale-refresh coalescing", () => {
  const app = fs.readFileSync(new URL("../../dashboard/app.mjs", import.meta.url), "utf8");
  const journey = fs.readFileSync(new URL("../../dashboard/account-journey.mjs", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../../dashboard/index.html", import.meta.url), "utf8");
  assert.match(app, /setDiscoveryState\("DISCOVERING"\)/);
  assert.match(app, /discoveryStatus: "DISCOVERED"/);
  assert.match(app, /setDiscoveryState\("NO_ACCOUNT"\)/);
  assert.match(app, /const discoveryStatus = error\?\.code === "UNVERIFIED_CANDIDATE" \? "SECURITY_ERROR" : "DISCOVERY_ERROR"/);
  assert.match(app, /SECURITY_ERROR/);
  assert.match(app, /accountRefreshInFlight/);
  assert.match(app, /refreshQueued/);
  assert.match(app, /createDiscoveryDeadline\(DISCOVERY_TIMEOUT_MS/);
  assert.match(app, /renderAccountJourney\(document, appState\)/);
  assert.match(app, /let appState = \{/);
  assert.doesNotMatch(app, /That address is not a verified VILLA account/);
  assert.match(app, /A candidate account failed verification/);
  assert.match(journey, /export function renderAccountJourney/);
  assert.match(journey, /account journey invariant violated/);
  assert.match(app, /window\.__VILLA_DEBUG__/);
  assert.match(app, /discoverySource/);
  assert.match(app, /final_render_state/);
  assert.doesNotMatch(app, /toggle\("account-(loading|empty|workspace|error)"/);
  assert.doesNotMatch(app, /toggle\("wrong-network"/);
  assert.match(app, /retry-account/);
  assert.match(app, /setAppState\(\{ account: null, currentAccountAddress: "", discoveryStatus,/);
  assert.match(app, /if \(accountRefreshInFlight\) \{\s+refreshQueued = true/);
  assert.match(app, /generation === refreshGeneration && appState\.owner === owner/);
  assert.match(app, /stale_context_invalidation/);
  assert.match(app, /accountsChanged/);
  assert.match(app, /chainChanged/);
  assert.match(app, /text\("wallet-address", shorten\(owner\)\)/);
  const connectWallet = app.slice(app.indexOf("async function connectWallet"), app.indexOf("function disconnectWallet"));
  assert.ok(connectWallet.indexOf("wallet_address_missing") >= 0 && connectWallet.indexOf("wallet_address_missing") < connectWallet.indexOf("await refreshAccount()"), "missing wallet address must prevent discovery");
  const accountError = html.match(/<section class="panel account-error"[\s\S]*?<\/section>/)?.[0] || "";
  assert.match(accountError, /id="account-error"[\s\S]*Account lookup unavailable[\s\S]*Creating another account is disabled until verification succeeds\.[\s\S]*id="retry-account"/);
  assert.doesNotMatch(accountError, /id="create-account"/);
});
