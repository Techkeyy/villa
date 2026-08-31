/**
 * Pure, unsigned owner top-up preparation for the bounded Phase 3B1 test.
 *
 * This module creates no wallet client, signer, provider, or broadcast path.
 * It is intentionally separate from the operator transaction policy because
 * the owner funds the account while the operator may only use approved account
 * methods.
 */

import { encodeFunctionData, isAddress } from "viem";
import {
  MIN_INITIAL_DEPOSIT_RAW,
  MIN_STRATEGY_CAPITAL_RAW,
  MIN_TOP_UP_RAW,
  PHASE_3B1_MAX_ACCOUNT_CAPITAL_RAW,
  VILLA_ACCOUNT_CONFIG,
} from "../../dashboard/account-config.mjs";

export const LP_TOP_UP_PREP_VERSION = "villa-lp-top-up-prep-v1";
export const PHASE_3B1_CURRENT_CAPITAL_RAW = MIN_INITIAL_DEPOSIT_RAW;
export const PHASE_3B1_TOP_UP_RAW = PHASE_3B1_MAX_ACCOUNT_CAPITAL_RAW - PHASE_3B1_CURRENT_CAPITAL_RAW;
export const PHASE_3B1_MINIMUM_MINT_RAW = MIN_TOP_UP_RAW;

const ERC20_APPROVE_ABI = Object.freeze([
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "success", type: "bool" }] },
]);
const VILLA_ACCOUNT_DEPOSIT_ABI = Object.freeze([
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
]);

function address(value, label) {
  const normalized = String(value ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized) || !isAddress(normalized)) throw new Error(`${label} must be a valid address`);
  return normalized;
}

function raw(value, label, { positive = false } = {}) {
  let result;
  try { result = typeof value === "bigint" ? value : BigInt(String(value)); } catch { throw new Error(`${label} must be an integer raw value`); }
  if (result < 0n || (positive && result === 0n)) throw new Error(`${label} must be ${positive ? "positive" : "non-negative"}`);
  return result;
}

function unsignedRequest({ operation, from, to, functionName, args, data, why }) {
  return Object.freeze({
    operation,
    from,
    to,
    chainId: 50312,
    value: 0n,
    functionName,
    selector: data.slice(0, 10).toLowerCase(),
    args: Object.freeze([...args]),
    data,
    sign: false,
    broadcast: false,
    requiresHumanWalletApproval: true,
    why,
  });
}

/**
 * Validate and project one owner-funded capital increment using integer raw
 * units. A zero-collateral account cannot use this top-up path.
 */
export function projectPhase3B1TopUp({ currentCollateralRaw, topUpRaw, walletBalanceRaw = null } = {}) {
  const current = raw(currentCollateralRaw, "current collateral");
  const topUp = raw(topUpRaw, "top-up amount", { positive: true });
  if (current === 0n) throw new Error("INITIAL_DEPOSIT_REQUIRED");
  if (topUp < MIN_TOP_UP_RAW) throw new Error("TOP_UP_BELOW_MINIMUM");
  if (walletBalanceRaw !== null && raw(walletBalanceRaw, "wallet balance") < topUp) throw new Error("INSUFFICIENT_WALLET_BALANCE");
  const resulting = current + topUp;
  const postMintCollateral = resulting >= PHASE_3B1_MINIMUM_MINT_RAW ? resulting - PHASE_3B1_MINIMUM_MINT_RAW : 0n;
  const collateralReservePass = postMintCollateral >= MIN_INITIAL_DEPOSIT_RAW;
  return Object.freeze({
    currentCollateralRaw: current,
    topUpRaw: topUp,
    resultingCollateralRaw: resulting,
    minimumInitialDepositRaw: MIN_INITIAL_DEPOSIT_RAW,
    minimumStrategyCapitalRaw: MIN_STRATEGY_CAPITAL_RAW,
    phase3b1CapRaw: PHASE_3B1_MAX_ACCOUNT_CAPITAL_RAW,
    minimumMintRaw: PHASE_3B1_MINIMUM_MINT_RAW,
    postMintCollateralRaw: postMintCollateral,
    collateralReserveRaw: MIN_INITIAL_DEPOSIT_RAW,
    strategyMinimumPass: resulting >= MIN_STRATEGY_CAPITAL_RAW,
    phase3b1CapPass: resulting <= PHASE_3B1_MAX_ACCOUNT_CAPITAL_RAW,
    collateralReservePass,
    mintSellFeasibleUnderPreviouslyProvenConditions: collateralReservePass,
  });
}

/**
 * Build the exact two-request owner plan for the disposable 1.000 -> 1.002
 * tUSDC fixture. It always uses a finite approval equal to the deposit.
 */
export function buildPhase3B1TopUpPlan({ owner, account, token = VILLA_ACCOUNT_CONFIG.collateralToken, currentCollateralRaw = PHASE_3B1_CURRENT_CAPITAL_RAW, topUpRaw = PHASE_3B1_TOP_UP_RAW, walletBalanceRaw = null } = {}) {
  const normalizedOwner = address(owner, "owner");
  const normalizedAccount = address(account, "VillaAccount");
  const normalizedToken = address(token, "collateral token");
  const projection = projectPhase3B1TopUp({ currentCollateralRaw, topUpRaw, walletBalanceRaw });
  if (projection.topUpRaw !== PHASE_3B1_TOP_UP_RAW) throw new Error("PHASE_3B1_TOP_UP_MUST_BE_EXACTLY_2000_RAW");
  if (projection.resultingCollateralRaw !== PHASE_3B1_MAX_ACCOUNT_CAPITAL_RAW) throw new Error("PHASE_3B1_TOP_UP_WOULD_EXCEED_EXACT_TARGET");

  const approvalArgs = [normalizedAccount, projection.topUpRaw];
  const approvalData = encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: approvalArgs });
  const depositArgs = [projection.topUpRaw];
  const depositData = encodeFunctionData({ abi: VILLA_ACCOUNT_DEPOSIT_ABI, functionName: "deposit", args: depositArgs });
  const requests = [
    unsignedRequest({ operation: "TOP_UP_APPROVAL", from: normalizedOwner, to: normalizedToken, functionName: "approve", args: approvalArgs, data: approvalData, why: "Approve only the exact 0.002 tUSDC top-up for this VillaAccount." }),
    unsignedRequest({ operation: "TOP_UP_DEPOSIT", from: normalizedOwner, to: normalizedAccount, functionName: "deposit", args: depositArgs, data: depositData, why: "Deposit only the exact 0.002 tUSDC top-up into the verified VillaAccount." }),
  ];
  return Object.freeze({
    version: LP_TOP_UP_PREP_VERSION,
    chainId: 50312,
    owner: normalizedOwner,
    account: normalizedAccount,
    token: normalizedToken,
    currentCapitalRaw: projection.currentCollateralRaw,
    topUpRaw: projection.topUpRaw,
    resultingCapitalRaw: projection.resultingCollateralRaw,
    approvalTarget: normalizedAccount,
    approvalAmountRaw: projection.topUpRaw,
    depositTarget: normalizedAccount,
    depositAmountRaw: projection.topUpRaw,
    projection,
    requests: Object.freeze(requests),
    sign: false,
    broadcast: false,
    transactionGenerated: false,
  });
}
