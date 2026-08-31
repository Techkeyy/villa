import { normalizeAddress } from "./account-client.mjs";

export const VERIFIED_ACCOUNT_STATE = "VERIFIED";

function normalizeChainId(value) {
  if (typeof value === "string" && /^0x[0-9a-f]+$/i.test(value)) return Number.parseInt(value, 16);
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : null;
}

export function evaluateVerifiedOwnerAccountReadiness(state = {}) {
  const wallet = normalizeAddress(state.owner);
  const currentOwner = normalizeAddress(state.currentOwner ?? state.owner);
  const chainId = normalizeChainId(state.chainId);
  const discovery = String(state.discoveryStatus ?? state.discovery ?? "");
  const accountAddress = normalizeAddress(state.account?.address ?? state.account?.accountAddress);
  const accountOwner = normalizeAddress(state.account?.owner ?? state.account?.accountOwner);
  const currentAccountAddress = normalizeAddress(state.currentAccountAddress);
  const connected = Boolean(wallet);
  const accountVerified = state.account?.verification === VERIFIED_ACCOUNT_STATE;
  const networkCorrect = chainId === 50312 && state.chainStatus === "SHANNON";
  const ownerMatches = Boolean(accountOwner && currentOwner && accountOwner === currentOwner);
  const accountCurrent = Boolean(accountAddress && currentAccountAddress && accountAddress === currentAccountAddress);
  const snapshot = Object.freeze({
    connected,
    wallet,
    chainId,
    discovery,
    accountAddress,
    accountOwner,
    accountVerified,
    currentOwner,
    currentAccountAddress,
    networkCorrect,
    accountCurrent,
  });
  const reasons = [];
  if (!connected) reasons.push("WALLET_NOT_CONNECTED");
  if (!networkCorrect) reasons.push("WRONG_NETWORK");
  if (discovery !== "DISCOVERED") reasons.push("DISCOVERY_NOT_COMPLETE");
  if (!accountAddress) reasons.push("ACCOUNT_MISSING");
  if (!accountVerified) reasons.push("ACCOUNT_NOT_VERIFIED");
  if (!accountOwner) reasons.push("ACCOUNT_OWNER_MISSING");
  if (!currentOwner || !ownerMatches) reasons.push("OWNER_MISMATCH");
  if (!accountCurrent) reasons.push("ACCOUNT_NOT_CURRENT");
  return Object.freeze({
    ready: reasons.length === 0,
    reasons: Object.freeze(reasons),
    snapshot,
  });
}

export function accountReadinessSnapshot(state = {}) {
  const evaluation = evaluateVerifiedOwnerAccountReadiness(state);
  return Object.freeze({ ...evaluation.snapshot, reasons: evaluation.reasons, ready: evaluation.ready });
}

export function isVerifiedOwnerAccountReady(state = {}) {
  return evaluateVerifiedOwnerAccountReadiness(state).ready;
}
