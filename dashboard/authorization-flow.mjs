import {
  AccountClientError,
  actionTransaction,
  accountCall,
  getChainId,
  normalizeAddress,
  readAccount,
  sendTransaction,
} from "./account-client.mjs";
import { VILLA_CHAIN, ZERO_ADDRESS } from "./account-config.mjs";
import { accountReadinessSnapshot } from "./account-readiness.mjs";

const errorCode = (error) => error?.code || "UNKNOWN";

function emitDebug(onDebug, event, details = {}) {
  try { onDebug?.(event, details); } catch {
    // Local diagnostics must never change authorization behavior.
  }
}

function readinessDetails(context, isReady) {
  const snapshot = accountReadinessSnapshot(context);
  return {
    ...snapshot,
    accountAddress: context.account?.address || "",
    ready: Boolean(isReady(context)),
  };
}

export async function runAuthorization({
  provider,
  owner,
  account,
  accountArtifact,
  operator,
  onStage = () => {},
  onTransactionUpdate = () => {},
  onDebug = () => {},
  dependencies = {},
}) {
  const operatorAddress = normalizeAddress(operator);
  if (!operatorAddress) throw new AccountClientError("OPERATOR_UNAVAILABLE", "VILLA operator configuration is unavailable. Retry.");
  const readChainIdFor = dependencies.getChainId || getChainId;
  const readAccountFor = dependencies.readAccount || readAccount;
  const send = dependencies.sendTransaction || sendTransaction;
  const chainId = await readChainIdFor(provider);
  if (chainId !== VILLA_CHAIN.id) throw new AccountClientError("WRONG_NETWORK", "Switch to Somnia Shannon.");
  const verified = await readAccountFor(provider, account.address, accountArtifact, owner);
  if (verified.operator === operatorAddress) return { alreadyAuthorized: true, accountAfter: verified, hash: "" };
  if (verified.operator !== ZERO_ADDRESS) throw new AccountClientError("UNEXPECTED_OPERATOR", "This account has a different operator. VILLA will not overwrite it.");

  const transaction = actionTransaction(owner, verified.address, accountCall.setOperator(operatorAddress));
  emitDebug(onDebug, "authorize_prepare", {
    owner,
    account: verified.address,
    operator: operatorAddress,
    chainId,
    to: transaction.to,
  });
  onStage("READY");
  const result = await send(provider, transaction, (state, hash = "") => onTransactionUpdate(state, hash));
  onStage("CONFIRMING", result.hash);
  const after = await readAccountFor(provider, verified.address, accountArtifact, owner);
  if (after.operator !== operatorAddress) throw new AccountClientError("AUTHORIZATION_MISMATCH", "Authorization was not set to the trusted VILLA operator.", result.hash);
  return { alreadyAuthorized: false, accountAfter: after, hash: result.hash };
}

export function createAuthorizationHandler({
  getContext,
  run = runAuthorization,
  isReady = (context) => Boolean(context.account?.address),
  setBusy = () => {},
  onStart = () => {},
  onDebug = () => {},
  onError = () => {},
  onSuccess = () => {},
}) {
  const fail = (error, context, reason = errorCode(error)) => {
    emitDebug(onDebug, "authorize_blocked_reason", {
      reason,
      errorCode: errorCode(error),
      readiness: readinessDetails(context, isReady),
    });
    onError(error);
    return { kind: "ERROR", error };
  };

  return async function handleAuthorizeClick() {
    const context = getContext();
    emitDebug(onDebug, "authorize_click", {
      transactionStatus: context.transactionStatus || "IDLE",
      busy: Boolean(context.busy),
      providerAvailable: Boolean(context.provider?.request),
      readiness: readinessDetails(context, isReady),
    });
    if (context.busy) return fail(new AccountClientError("ACTION_BUSY", "A transaction is already pending. Please wait."), context, "BUSY");
    if (!context.provider?.request) return fail(new AccountClientError("WALLET_MISSING", "Wallet connection is unavailable. Reconnect your wallet."), context, "PROVIDER_UNAVAILABLE");
    if (context.chainStatus !== "SHANNON") return fail(new AccountClientError("WRONG_NETWORK", "Switch to Somnia Shannon."), context, "WRONG_NETWORK");
    if (!isReady(context)) return fail(new AccountClientError("ACCOUNT_NOT_READY", "Your VILLA account is not ready. Refresh account verification before authorizing VILLA."), context, "ACCOUNT_NOT_READY");
    if (!normalizeAddress(context.operator)) return fail(new AccountClientError("OPERATOR_UNAVAILABLE", "VILLA operator configuration is unavailable. Retry."), context, "OPERATOR_UNAVAILABLE");

    onStart();
    setBusy(true);
    try {
      const result = await run({ ...context, onDebug });
      await onSuccess(result);
      return result;
    } catch (error) {
      emitDebug(onDebug, "authorize_error", { errorCode: errorCode(error) });
      return fail(error, context);
    } finally {
      setBusy(false);
    }
  };
}
