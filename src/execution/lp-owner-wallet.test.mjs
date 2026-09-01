import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  classifyWalletError,
  dedupeProviderEntries,
  isRabbyProvider,
  sanitizeProviderReason,
  selectRabbyProvider,
  walletContext,
} from "../../scripts/lib/owner-wallet-discovery.mjs";

const provider = (name, flags = {}) => ({ request: async () => [], ...flags, name });

test("EIP-6963 selects Rabby by metadata and never silently selects another wallet", () => {
  const rabby = provider("Rabby", { isRabby: true });
  const other = provider("Other Wallet");
  const selected = selectRabbyProvider({
    announced: [{ provider: other, info: { name: "Other Wallet", rdns: "wallet.other" } }, { provider: rabby, info: { name: "Rabby", rdns: "io.rabby" } }],
  });
  assert.equal(selected.provider, rabby);
  assert.equal(selectRabbyProvider({ announced: [{ provider: other, info: { name: "Other Wallet" } }] }), null);
  assert.equal(isRabbyProvider({ provider: rabby, info: {} }), true);
});

test("legacy provider fallback supports window.ethereum.providers without mutation", () => {
  const rabby = provider("Injected", { isRabbyWallet: true });
  const other = provider("Other");
  const selected = selectRabbyProvider({ legacy: [{ provider: other }, { provider: rabby }] });
  assert.equal(selected.provider, rabby);
  assert.equal(dedupeProviderEntries([{ provider: rabby }, { provider: rabby }]).length, 1);
});

test("wallet errors and exact owner/network context remain visible and stable", () => {
  assert.equal(classifyWalletError({ code: 4001 }), "WALLET_REQUEST_REJECTED");
  assert.equal(classifyWalletError({ code: 4001 }, "switch"), "NETWORK_SWITCH_REJECTED");
  assert.equal(classifyWalletError({ code: 4902 }, "switch"), "NETWORK_NOT_CONFIGURED");
  assert.equal(walletContext({ account: "0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d", chainId: "0xc488", owner: "0xefe0412781d3c1e7888b2db9deeca3037542494d", requiredChainId: "0xc488" }).valid, true);
  assert.equal(walletContext({ account: "0x1111111111111111111111111111111111111111", chainId: "0xc488", owner: "0xefe0412781d3c1e7888b2db9deeca3037542494d", requiredChainId: "0xc488" }).valid, false);
  assert.equal(walletContext({ account: "0xefe0412781d3c1e7888b2db9deeca3037542494d", chainId: "0x1", owner: "0xefe0412781d3c1e7888b2db9deeca3037542494d", requiredChainId: "0xc488" }).valid, false);
  assert.doesNotMatch(sanitizeProviderReason(new Error("bad\n0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef")), /0x1234/);
});

test("browser wallet hotfix does not redefine injected providers or auto-submit", async () => {
  const source = await fs.readFile(new URL("../../scripts/phase3b1b1-owner-prep-wizard-client.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Object\.defineProperty/);
  const connect = source.slice(source.indexOf("async function connectWallet"), source.indexOf("function renderTransactionReview"));
  assert.doesNotMatch(connect, /eth_sendTransaction/);
  assert.match(source, /eip6963:announceProvider/);
  assert.match(source, /eip6963:requestProvider/);
  assert.match(source, /await loadState\(true\)/);
  assert.match(source, /readSequence/);
  assert.match(source, /current\.walletContext\?\.connected === true/);
});
