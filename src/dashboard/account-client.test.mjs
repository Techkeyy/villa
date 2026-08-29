import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildDeploymentData,
  decodeAddress,
  encodeAddress,
  encodeConstructorArgs,
  actionTransaction,
  accountCall,
  formatAmount,
  normalizeAddress,
  parseAmount,
  readAccount,
  tokenCall,
} from "../../dashboard/account-client.mjs";
import { VILLA_ACCOUNT_CONFIG, VILLA_CHAIN, VILLA_SELECTORS, ZERO_ADDRESS } from "../../dashboard/account-config.mjs";

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
      if (selector === VILLA_SELECTORS.tokenBalanceOf) return uintResult(25_000_000n);
      throw new Error(`unexpected selector ${selector}`);
    },
  };
  const accountData = await readAccount(provider, account, { runtimeBytecode }, owner);
  assert.equal(accountData.owner, owner);
  assert.equal(accountData.balance, 25_000_000n);
  await assert.rejects(() => readAccount(provider, account, { runtimeBytecode }, otherOwner), /different wallet/i);
  const wrongWiringProvider = { ...provider, request: async (request) => {
    const result = await provider.request(request);
    if (request.method === "eth_call" && request.params[0].data.startsWith(VILLA_SELECTORS.binaryModule)) return addressResult(otherOwner);
    return result;
  } };
  await assert.rejects(() => readAccount(wrongWiringProvider, account, { runtimeBytecode }, owner), /wired/i);
});

test("chain reads verify exact runtime, owner, and trusted operator before UI state", () => {
  const source = fs.readFileSync(new URL("../../dashboard/account-client.mjs", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../../dashboard/app.mjs", import.meta.url), "utf8");
  assert.match(source, /eth_getCode/);
  assert.match(source, /artifact\?\.runtimeBytecode/);
  assert.match(source, /artifactCreationSha256/);
  assert.match(source, /artifactRuntimeSha256/);
  assert.match(source, /SHA-256/);
  assert.match(source, /expectedOwner/);
  assert.match(source, /eth_getLogs/);
  assert.match(source, /indexedAccountLogs/);
  assert.match(source, /discoveryEventTopic/);
  assert.match(source, /VILLA_SELECTORS\.outcomeToken/);
  assert.match(source, /VILLA_SELECTORS\.binaryModule/);
  assert.match(source, /VILLA_SELECTORS\.binarySettlement/);
  assert.match(source, /VILLA_CHAIN\.id/);
  assert.match(app, /readAccount\(provider, currentAccount\.address/);
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
