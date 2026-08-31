import {
  AccountClientError,
  actionTransaction,
  accountCall,
  formatAmount,
  getChainId,
  parseAmount,
  readAccount,
  readAllowance,
  readTokenBalance,
  sendTransaction,
  tokenCall,
} from "./account-client.mjs";
import { MIN_DEPOSIT_RAW, VILLA_ACCOUNT_CONFIG, VILLA_CHAIN } from "./account-config.mjs";
import { accountReadinessSnapshot } from "./account-readiness.mjs";

const errorCode = (error) => error?.code || "UNKNOWN";

function emitDebug(onDebug, event, details = {}) {
  try { onDebug?.(event, details); } catch {
    // Local diagnostics must never change the transaction path.
  }
}

export function parseLiquidityAmount(value, walletBalance = null) {
  const amount = parseAmount(value, VILLA_ACCOUNT_CONFIG.collateralDecimals, { allowZero: true });
  if (amount < MIN_DEPOSIT_RAW) {
    throw new AccountClientError(
      "MIN_DEPOSIT",
      `Enter at least ${formatAmount(MIN_DEPOSIT_RAW)} ${VILLA_ACCOUNT_CONFIG.collateralSymbol}.`,
    );
  }
  if (walletBalance !== null && amount > BigInt(walletBalance)) {
    throw new AccountClientError("INSUFFICIENT_FUNDS", "Your wallet does not have enough tUSDC.");
  }
  return amount;
}

function transactionUpdate(onTransactionUpdate, phase) {
  return (state, hash = "") => onTransactionUpdate?.(state, hash, phase);
}

async function readAllowanceWithDiagnostics(readAllowanceFor, provider, owner, spender, amount, onDebug) {
  emitDebug(onDebug, "allowance_request_start", {
    owner,
    spender,
    requestedAmountRaw: amount.toString(),
  });
  try {
    const allowance = await readAllowanceFor(provider, owner, spender);
    emitDebug(onDebug, "allowance_request_result", {
      allowanceRaw: allowance.toString(),
      coversRequestedAmount: allowance >= amount,
    });
    return allowance;
  } catch (error) {
    emitDebug(onDebug, "allowance_request_result", { status: "error", errorCode: errorCode(error) });
    throw error;
  }
}

async function sendPhaseTransaction(send, provider, transaction, onTransactionUpdate, phase, onDebug, event) {
  emitDebug(onDebug, `${event}_request_start`, {
    to: transaction.to,
    amountRaw: phase.amount.toString(),
  });
  try {
    const result = await send(provider, transaction, transactionUpdate(onTransactionUpdate, phase.name));
    emitDebug(onDebug, `${event}_request_result`, { status: "success", hashPresent: Boolean(result?.hash) });
    return result;
  } catch (error) {
    emitDebug(onDebug, `${event}_request_result`, { status: "error", errorCode: errorCode(error) });
    throw error;
  }
}

export async function runAddLiquidity({
  provider,
  owner,
  account,
  accountArtifact,
  rawInput,
  setNetworkState = () => true,
  onStage = () => {},
  onTransactionUpdate = () => {},
  onDebug = () => {},
  dependencies = {},
}) {
  const readChainIdFor = dependencies.getChainId || getChainId;
  const readAccountFor = dependencies.readAccount || readAccount;
  const readWalletBalanceFor = dependencies.readTokenBalance || readTokenBalance;
  const readAllowanceFor = dependencies.readAllowance || readAllowance;
  const send = dependencies.sendTransaction || sendTransaction;

  onStage("PREPARING");
  const amount = parseLiquidityAmount(rawInput);
  emitDebug(onDebug, "amount_parsed", {
    rawInput: String(rawInput ?? ""),
    amountRaw: amount.toString(),
    amount: formatAmount(amount),
  });

  emitDebug(onDebug, "chain_request_start", {});
  const chainId = await readChainIdFor(provider);
  emitDebug(onDebug, "chain_request_result", { chainId, expectedChainId: VILLA_CHAIN.id });
  if (!setNetworkState(chainId)) {
    throw new AccountClientError("WRONG_NETWORK", "Switch to Somnia Shannon.");
  }

  const verified = await readAccountFor(provider, account.address, accountArtifact, owner);
  emitDebug(onDebug, "account_verified", { owner, account: verified.address, chainId });
  const walletBefore = await readWalletBalanceFor(provider, owner);
  emitDebug(onDebug, "wallet_balance_result", { balanceRaw: walletBefore.toString() });
  if (amount > walletBefore) throw new AccountClientError("INSUFFICIENT_FUNDS", "Your wallet does not have enough tUSDC.");

  const allowance = await readAllowanceWithDiagnostics(
    readAllowanceFor,
    provider,
    owner,
    verified.address,
    amount,
    onDebug,
  );
  if (allowance < amount) {
    onStage("APPROVAL_READY", amount);
    await sendPhaseTransaction(
      send,
      provider,
      actionTransaction(owner, VILLA_ACCOUNT_CONFIG.collateralToken, tokenCall.approve(verified.address, amount)),
      onTransactionUpdate,
      { name: "approval", amount },
      onDebug,
      "approval",
    );
    onStage("APPROVAL_CONFIRMING", amount);
    const allowanceAfter = await readAllowanceWithDiagnostics(
      readAllowanceFor,
      provider,
      owner,
      verified.address,
      amount,
      onDebug,
    );
    if (allowanceAfter < amount) {
      throw new AccountClientError("APPROVAL_MISMATCH", "The exact tUSDC approval could not be verified.");
    }
  } else {
    emitDebug(onDebug, "approval_skipped", { reason: "existing_allowance", allowanceRaw: allowance.toString() });
  }

  onStage("DEPOSIT_READY", amount);
  const deposit = await sendPhaseTransaction(
    send,
    provider,
    actionTransaction(owner, verified.address, accountCall.deposit(amount)),
    onTransactionUpdate,
    { name: "deposit", amount },
    onDebug,
    "deposit",
  );
  onStage("DEPOSIT_CONFIRMING", amount, deposit.hash);
  const accountBefore = verified.balance;
  const walletAfter = await readWalletBalanceFor(provider, owner);
  const accountAfter = await readAccountFor(provider, verified.address, accountArtifact, owner);
  if (walletBefore - walletAfter !== amount || accountAfter.balance - accountBefore !== amount) {
    throw new AccountClientError("BALANCE_MISMATCH", "The deposit did not reconcile to the exact amount. No success was recorded.", deposit.hash);
  }

  return { amount, walletAfter, accountAfter, hash: deposit.hash };
}

export function createAddLiquidityHandler({
  getContext,
  run = runAddLiquidity,
  isReady = (context) => Boolean(context.account?.address),
  setBusy = () => {},
  onStart = () => {},
  onDebug = () => {},
  onError = () => {},
  onSuccess = () => {},
}) {
  const fail = (error, context) => {
    emitDebug(onDebug, "caught_error", {
      errorCode: errorCode(error),
      owner: context.owner || "",
      account: context.account?.address || "",
    });
    emitDebug(onDebug, "add_liquidity_blocked_reason", { reason: errorCode(error), readiness: accountReadinessSnapshot(context) });
    onError(error);
    return { kind: "ERROR", error };
  };

  return async function handleAddLiquidityClick() {
    const context = getContext();
    emitDebug(onDebug, "add_liquidity_click", {
      rawInput: String(context.rawInput ?? ""),
      parsedAmountRaw: null,
      owner: context.owner || "",
      account: context.account?.address || "",
      chainId: context.chainId ?? null,
      providerAvailable: Boolean(context.provider?.request),
      busy: Boolean(context.busy),
      transactionStatus: context.transactionStatus || "IDLE",
      readiness: accountReadinessSnapshot(context),
    });

    if (context.busy) return fail(new AccountClientError("ACTION_BUSY", "A liquidity action is already in progress. Please wait."), context);
    if (!context.provider?.request) return fail(new AccountClientError("WALLET_MISSING", "Wallet connection is unavailable. Reconnect your wallet."), context);
    if (!context.owner) return fail(new AccountClientError("INVALID_OWNER", "Connect your wallet before adding liquidity."), context);
    if (!isReady(context)) return fail(new AccountClientError("ACCOUNT_NOT_READY", "Your VILLA account is not ready. Refresh account verification before adding liquidity."), context);

    onStart();
    setBusy(true);
    try {
      const result = await run({ ...context, onDebug });
      onSuccess(result);
      return result;
    } catch (error) {
      return fail(error, context);
    } finally {
      setBusy(false);
    }
  };
}
