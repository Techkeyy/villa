/**
 * Emit the exact unsigned owner top-up plan for the disposable Phase 3B1
 * account. This is a preparation-only command: it never loads .env, creates a
 * signer, requests wallet approval, or broadcasts a transaction.
 */

import { formatAmount } from "../dashboard/account-client.mjs";
import { VILLA_ACCOUNT_CONFIG } from "../dashboard/account-config.mjs";
import { buildPhase3B1TopUpPlan } from "../src/execution/lp-top-up.mjs";

const OWNER = "0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d";
const ACCOUNT = "0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2";
const plan = buildPhase3B1TopUpPlan({ owner: OWNER, account: ACCOUNT, token: VILLA_ACCOUNT_CONFIG.collateralToken });
const jsonSafe = (value) => JSON.stringify(value, (_key, item) => {
  if (typeof item === "bigint") return item.toString();
  return item;
}, 2);

console.log(jsonSafe({
  result: "PASS",
  version: plan.version,
  chainId: plan.chainId,
  owner: plan.owner,
  account: plan.account,
  token: plan.token,
  currentCapital: { raw: plan.currentCapitalRaw, tUSDC: formatAmount(plan.currentCapitalRaw, 6, 3) },
  topUp: { raw: plan.topUpRaw, tUSDC: formatAmount(plan.topUpRaw, 6, 3) },
  resultingCapital: { raw: plan.resultingCapitalRaw, tUSDC: formatAmount(plan.resultingCapitalRaw, 6, 3) },
  approvalTarget: plan.approvalTarget,
  approvalAmount: { raw: plan.approvalAmountRaw, tUSDC: formatAmount(plan.approvalAmountRaw, 6, 3) },
  depositTarget: plan.depositTarget,
  depositAmount: { raw: plan.depositAmountRaw, tUSDC: formatAmount(plan.depositAmountRaw, 6, 3) },
  projectedReadiness: {
    minimumStrategyCapitalRaw: plan.projection.minimumStrategyCapitalRaw,
    minimumStrategyCapitalPass: plan.projection.strategyMinimumPass,
    phase3b1CapRaw: plan.projection.phase3b1CapRaw,
    phase3b1CapPass: plan.projection.phase3b1CapPass,
    minimumMintRaw: plan.projection.minimumMintRaw,
    postMintCollateralRaw: plan.projection.postMintCollateralRaw,
    collateralReserveRaw: plan.projection.collateralReserveRaw,
    collateralReservePass: plan.projection.collateralReservePass,
    mintSellFeasibleUnderPreviouslyProvenConditions: plan.projection.mintSellFeasibleUnderPreviouslyProvenConditions,
  },
  requests: plan.requests,
  sign: plan.sign,
  broadcast: plan.broadcast,
  transactionGenerated: plan.transactionGenerated,
}));
