/**
 * Pure browser-safe helpers for selecting the explicitly identified Rabby
 * provider. This module never reads or writes window state and never submits
 * transactions.
 */

const RABBY_RE = /rabby/i;

const text = (value) => String(value ?? "");

export function providerMetadata(entry = {}) {
  const info = entry?.info ?? {};
  const provider = entry?.provider ?? entry;
  return {
    name: text(info.name || provider?.name),
    rdns: text(info.rdns || provider?.rdns),
    uuid: text(info.uuid),
    icon: text(info.icon),
  };
}

export function isRabbyProvider(entry = {}) {
  const provider = entry?.provider ?? entry;
  const metadata = providerMetadata(entry);
  return provider?.isRabby === true
    || provider?.isRabbyWallet === true
    || RABBY_RE.test(metadata.name)
    || RABBY_RE.test(metadata.rdns)
    || RABBY_RE.test(metadata.uuid);
}

export function providerLabel(entry = {}) {
  const metadata = providerMetadata(entry);
  return metadata.name || metadata.rdns || (isRabbyProvider(entry) ? "Rabby" : "Unknown provider");
}

export function dedupeProviderEntries(entries = []) {
  const seen = new Set();
  return entries.filter((entry) => {
    const provider = entry?.provider ?? entry;
    if (!provider || typeof provider.request !== "function" || seen.has(provider)) return false;
    seen.add(provider);
    return true;
  });
}

export function selectRabbyProvider({ announced = [], legacy = [] } = {}) {
  return dedupeProviderEntries([...announced, ...legacy]).find((entry) => isRabbyProvider(entry)) ?? null;
}

export function classifyWalletError(error, context = "connection") {
  const code = Number(error?.code);
  if (error?.walletCode) return error.walletCode;
  if (code === 4001) return context === "switch" || context === "add" ? "NETWORK_SWITCH_REJECTED" : "WALLET_REQUEST_REJECTED";
  if (code === 4902) return "NETWORK_NOT_CONFIGURED";
  return context === "switch" || context === "add" ? "PROVIDER_CONNECTION_FAILED" : "PROVIDER_CONNECTION_FAILED";
}

export function sanitizeProviderReason(error) {
  const reason = text(error?.message || error || "Unknown provider error")
    .replace(/0x[0-9a-f]{40,}/gi, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return reason.slice(0, 180) || "Unknown provider error";
}

export function walletContext({ account, chainId, owner, requiredChainId } = {}) {
  const normalizedAccount = text(account).toLowerCase();
  const normalizedOwner = text(owner).toLowerCase();
  const normalizedChain = text(chainId).toLowerCase();
  const normalizedRequiredChain = text(requiredChainId).toLowerCase();
  return Object.freeze({
    account: text(account),
    chainId: text(chainId),
    ownerMatch: normalizedAccount === normalizedOwner,
    chainMatch: normalizedChain === normalizedRequiredChain,
    valid: normalizedAccount === normalizedOwner && normalizedChain === normalizedRequiredChain,
  });
}
