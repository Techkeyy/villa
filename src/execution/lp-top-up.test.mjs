import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_INITIAL_DEPOSIT_RAW,
  MIN_STRATEGY_CAPITAL_RAW,
  PHASE_3B1_MAX_ACCOUNT_CAPITAL_RAW,
  MIN_INITIAL_DEPOSIT_TUSDC,
  MIN_DEPOSIT_TUSDC,
  VILLA_ACCOUNT_CONFIG,
} from "../../dashboard/account-config.mjs";
import { buildPhase3B1TopUpPlan, projectPhase3B1TopUp } from "./lp-top-up.mjs";

const OWNER = "0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d";
const ACCOUNT = "0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2";

test("the exact 0.002 top-up projects the approved capital boundaries", () => {
  const result = projectPhase3B1TopUp({ currentCollateralRaw: 1_000_000n, topUpRaw: 2_000n, walletBalanceRaw: 2_000n });
  assert.equal(result.currentCollateralRaw, MIN_INITIAL_DEPOSIT_RAW);
  assert.equal(result.topUpRaw, 2_000n);
  assert.equal(result.resultingCollateralRaw, 1_002_000n);
  assert.equal(result.minimumStrategyCapitalRaw, MIN_STRATEGY_CAPITAL_RAW);
  assert.equal(result.phase3b1CapRaw, PHASE_3B1_MAX_ACCOUNT_CAPITAL_RAW);
  assert.equal(result.minimumMintRaw, 1_000n);
  assert.equal(result.postMintCollateralRaw, 1_001_000n);
  assert.equal(result.collateralReserveRaw, 1_000_000n);
  assert.equal(result.strategyMinimumPass, true);
  assert.equal(result.phase3b1CapPass, true);
  assert.equal(result.collateralReservePass, true);
  assert.equal(result.mintSellFeasibleUnderPreviouslyProvenConditions, true);
});

test("the activated engineering cap does not replace the public initial-deposit floor", () => {
  assert.equal(MIN_INITIAL_DEPOSIT_TUSDC, "1.00");
  assert.equal(MIN_DEPOSIT_TUSDC, "1.00");
});

test("the top-up path rejects unfunded accounts, zero, negative, and under-minimum amounts", () => {
  assert.throws(() => projectPhase3B1TopUp({ currentCollateralRaw: 0n, topUpRaw: 2_000n }), /INITIAL_DEPOSIT_REQUIRED/);
  assert.throws(() => projectPhase3B1TopUp({ currentCollateralRaw: 1_000_000n, topUpRaw: 0n }), /top-up amount must be positive/);
  assert.throws(() => projectPhase3B1TopUp({ currentCollateralRaw: 1_000_000n, topUpRaw: -1n }), /top-up amount must be positive/);
  assert.throws(() => projectPhase3B1TopUp({ currentCollateralRaw: 1_000_000n, topUpRaw: 999n }), /TOP_UP_BELOW_MINIMUM/);
});

test("wallet balance is checked without float conversion", () => {
  assert.throws(() => projectPhase3B1TopUp({ currentCollateralRaw: 1_000_000n, topUpRaw: 2_000n, walletBalanceRaw: 1_999n }), /INSUFFICIENT_WALLET_BALANCE/);
  assert.throws(() => projectPhase3B1TopUp({ currentCollateralRaw: 1_000_000n, topUpRaw: "2.000" }), /integer raw value/);
});

test("owner preparation emits exactly finite approve(2000) and deposit(2000) requests", () => {
  const plan = buildPhase3B1TopUpPlan({ owner: OWNER, account: ACCOUNT, currentCollateralRaw: 1_000_000n, topUpRaw: 2_000n });
  assert.equal(plan.owner, OWNER.toLowerCase());
  assert.equal(plan.account, ACCOUNT.toLowerCase());
  assert.equal(plan.token, VILLA_ACCOUNT_CONFIG.collateralToken.toLowerCase());
  assert.equal(plan.currentCapitalRaw, 1_000_000n);
  assert.equal(plan.topUpRaw, 2_000n);
  assert.equal(plan.resultingCapitalRaw, 1_002_000n);
  assert.equal(plan.approvalTarget, ACCOUNT.toLowerCase());
  assert.equal(plan.approvalAmountRaw, 2_000n);
  assert.equal(plan.depositTarget, ACCOUNT.toLowerCase());
  assert.equal(plan.depositAmountRaw, 2_000n);
  assert.deepEqual(plan.requests.map(({ operation, to, functionName, args, sign, broadcast }) => ({ operation, to, functionName, args, sign, broadcast })), [
    { operation: "TOP_UP_APPROVAL", to: VILLA_ACCOUNT_CONFIG.collateralToken.toLowerCase(), functionName: "approve", args: [ACCOUNT.toLowerCase(), 2_000n], sign: false, broadcast: false },
    { operation: "TOP_UP_DEPOSIT", to: ACCOUNT.toLowerCase(), functionName: "deposit", args: [2_000n], sign: false, broadcast: false },
  ]);
  assert.equal(plan.transactionGenerated, false);
  assert.equal(plan.requests.some((request) => request.args.includes(2n ** 256n - 1n)), false);
});

test("exact top-up plan rejects a different amount or overfunding", () => {
  assert.throws(() => buildPhase3B1TopUpPlan({ owner: OWNER, account: ACCOUNT, topUpRaw: 1_000n }), /EXACTLY_2000/);
  assert.throws(() => buildPhase3B1TopUpPlan({ owner: OWNER, account: ACCOUNT, currentCollateralRaw: 1_001_000n, topUpRaw: 2_000n }), /EXACT_TARGET/);
});
