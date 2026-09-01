import assert from "node:assert/strict";
import test from "node:test";
import {
  OWNER_WIZARD_ACCOUNT,
  OWNER_WIZARD_CAPITAL_RAW,
  OWNER_WIZARD_CHAIN_ID,
  OWNER_WIZARD_FINAL_HEADROOM_SEC,
  OWNER_WIZARD_INITIAL_HEADROOM_SEC,
  OWNER_WIZARD_15M_FINAL_HANDOFF_HEADROOM_SEC,
  OWNER_WIZARD_15M_FINAL_PREFLIGHT_HEADROOM_SEC,
  OWNER_WIZARD_15M_INITIAL_HEADROOM_SEC,
  OWNER_WIZARD_15M_SERIES,
  OWNER_WIZARD_15M_TX1_HEADROOM_SEC,
  OWNER_WIZARD_1H_FINAL_HANDOFF_HEADROOM_SEC,
  OWNER_WIZARD_1H_FINAL_PREFLIGHT_HEADROOM_SEC,
  OWNER_WIZARD_1H_INITIAL_HEADROOM_SEC,
  OWNER_WIZARD_1H_SERIES,
  OWNER_WIZARD_1H_TX1_HEADROOM_SEC,
  OWNER_WIZARD_MINT_RAW,
  OWNER_WIZARD_OPERATOR,
  OWNER_WIZARD_OWNER,
  OWNER_WIZARD_TX1_HEADROOM_SEC,
  buildExactOwnerAction,
  evaluateOwnerWizardSnapshot,
  finalOwnerHandoffBlockers,
  isInvalidatedOwnerMarket,
  validateHumanOwnerTransaction,
  validateOwnerWalletContext,
} from "./lp-owner-wizard.mjs";

const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("owner-prep keeps the corrected initial gate and later gates unchanged", () => {
  assert.equal(OWNER_WIZARD_INITIAL_HEADROOM_SEC, 240);
  assert.equal(OWNER_WIZARD_TX1_HEADROOM_SEC, 180);
  assert.equal(OWNER_WIZARD_FINAL_HEADROOM_SEC, 120);
});

test("15m fallback uses only its explicit longer safety windows", () => {
  assert.equal(OWNER_WIZARD_15M_SERIES, "BINARY:BTC:900");
  assert.equal(OWNER_WIZARD_15M_INITIAL_HEADROOM_SEC, 600);
  assert.equal(OWNER_WIZARD_15M_TX1_HEADROOM_SEC, 480);
  assert.equal(OWNER_WIZARD_15M_FINAL_PREFLIGHT_HEADROOM_SEC, 360);
  assert.equal(OWNER_WIZARD_15M_FINAL_HANDOFF_HEADROOM_SEC, 300);
});

test("1h owner preparation uses the fresh-market and final handoff gates", () => {
  assert.equal(OWNER_WIZARD_1H_SERIES, "BINARY:BTC:3600");
  assert.equal(OWNER_WIZARD_1H_INITIAL_HEADROOM_SEC, 1500);
  assert.equal(OWNER_WIZARD_1H_TX1_HEADROOM_SEC, 1200);
  assert.equal(OWNER_WIZARD_1H_FINAL_PREFLIGHT_HEADROOM_SEC, 900);
  assert.equal(OWNER_WIZARD_1H_FINAL_HANDOFF_HEADROOM_SEC, 900);
});

function feasibility(overrides = {}) {
  const quotePlan = {
    plan: "ONE_SIDED",
    ask: { enabled: true, action: "SELL_YES", targetPriceRaw: "461000", targetQuantityRaw: OWNER_WIZARD_MINT_RAW },
    bid: { enabled: false },
    ...overrides.quotePlan,
  };
  return {
    result: "PASS",
    account: OWNER_WIZARD_ACCOUNT,
    owner: OWNER_WIZARD_OWNER,
    operator: OWNER_WIZARD_OPERATOR,
    shadow: {
      chainId: OWNER_WIZARD_CHAIN_ID,
      market: { marketId: MARKET, series: "BINARY:BTC:300", current: true, status: "Trading", poolFinalized: false, expirySec: 10_000, book: { bids: [[0.45, 1000]], asks: [[0.55, 1000]] } },
      risk: { authoritativeTime: { chainNowSec: 9_700 } },
      permissions: { marketApproved: false, protocolPrepared: false },
      capital: { directCollateralRaw: OWNER_WIZARD_CAPITAL_RAW },
      executionEnabled: false,
    },
    sellAfterMint: {
      viable: true,
      mintAmountRaw: OWNER_WIZARD_MINT_RAW,
      riskDecision: { state: "ALLOW" },
      quotePlan,
      quoteExecution: { postOnly: true, orderType: 3, policyValid: true },
      sequence: { valid: true, actions: ["operatorMintSet", "operatorPlaceOrder", "operatorCancelOrder", "operatorBurnSet"].map((functionName) => ({ functionName })) },
    },
    ...overrides,
  };
}

test("invalidated stale owner-prep markets are rejected", () => {
  assert.equal(isInvalidatedOwnerMarket(`0x${"0".repeat(60)}f8bc`), true);
  assert.equal(isInvalidatedOwnerMarket(`0x${"0".repeat(60)}f5ee`), true);
  assert.equal(isInvalidatedOwnerMarket(`0x${"0".repeat(60)}f5fe`), true);
  assert.equal(isInvalidatedOwnerMarket(`0x${"0".repeat(60)}fee9`), true);
  assert.equal(isInvalidatedOwnerMarket(MARKET), false);
});

test("fresh snapshot requires exact identity, capital, ALLOW, and projected SELL_YES sequence", () => {
  const result = evaluateOwnerWizardSnapshot({ feasibility: feasibility(), minimumHeadroomSec: 270, requireMarketApproved: false, requireProtocolPrepared: false });
  assert.equal(result.valid, true);
  assert.equal(result.marketId, MARKET);
  assert.equal(result.headroomSec, 300);
  assert.equal(result.quotePriceRaw, "461000");
});

test("Path A remains valid when it is the lower-risk fresh-market projection", () => {
  const base = feasibility();
  const result = evaluateOwnerWizardSnapshot({
    feasibility: {
      ...base,
      recommendation: { path: "A" },
      shadow: { ...base.shadow, market: { ...base.shadow.market, series: "BINARY:BTC:900", expirySec: 11_000 }, risk: { authoritativeTime: { chainNowSec: 10_000 } } },
      buyWithoutMint: {
        viable: true,
        riskDecision: { state: "ALLOW" },
        quotePlan: { plan: "ONE_SIDED", bid: { enabled: true, action: "BUY_YES", targetPriceRaw: "461000", targetQuantityRaw: OWNER_WIZARD_MINT_RAW }, ask: { enabled: false } },
        quoteExecution: { postOnly: true, orderType: 3, policyValid: true },
        sequence: { valid: true, actions: [{ functionName: "operatorPlaceOrder" }, { functionName: "operatorCancelOrder" }] },
      },
    },
    minimumHeadroomSec: OWNER_WIZARD_15M_INITIAL_HEADROOM_SEC,
    expectedSeries: OWNER_WIZARD_15M_SERIES,
    projectedPath: "A",
    requireMarketApproved: false,
    requireProtocolPrepared: false,
  });
  assert.equal(result.valid, true);
  assert.equal(result.projectedPath, "A");
  assert.equal(result.quoteAction, "BUY_YES");
});

test("wrong network and wrong owner are stable blocking states", () => {
  assert.equal(validateOwnerWalletContext({ account: OWNER_WIZARD_OWNER, chainId: OWNER_WIZARD_CHAIN_ID }).valid, true);
  assert.equal(validateOwnerWalletContext({ account: OWNER_WIZARD_OWNER, chainId: 1 }).valid, false);
  assert.equal(validateOwnerWalletContext({ account: "0x1111111111111111111111111111111111111111", chainId: OWNER_WIZARD_CHAIN_ID }).valid, false);
});

test("tx1 and tx2 are exact human-only calls with fixed target and market", () => {
  const tx1 = buildExactOwnerAction({ action: "MARKET_APPROVAL", marketId: MARKET });
  const tx2 = buildExactOwnerAction({ action: "PROTOCOL_APPROVAL", marketId: MARKET });
  assert.equal(tx1.selector, "0xccb658f7");
  assert.equal(tx2.selector, "0x057e80da");
  for (const tx of [tx1, tx2]) {
    assert.equal(tx.to, OWNER_WIZARD_ACCOUNT);
    assert.equal(tx.from, OWNER_WIZARD_OWNER);
    assert.equal(tx.chainId, OWNER_WIZARD_CHAIN_ID);
    assert.equal(tx.value, "0x0");
    assert.equal(tx.sign, false);
    assert.equal(tx.broadcast, false);
    assert.equal(tx.requiresHumanWalletApproval, true);
  }
  assert.equal(validateHumanOwnerTransaction({ action: "MARKET_APPROVAL", transaction: tx1, marketId: MARKET }).valid, true);
  assert.equal(validateHumanOwnerTransaction({ action: "MARKET_APPROVAL", transaction: { ...tx1, data: tx2.data }, marketId: MARKET }).valid, false);
  assert.throws(() => buildExactOwnerAction({ action: "MARKET_APPROVAL", marketId: `0x${"0".repeat(60)}f5fe` }));
});

test("market change, risk change, NO_QUOTE, and short headroom block before an owner call", () => {
  assert.ok(evaluateOwnerWizardSnapshot({ feasibility: feasibility(), minimumHeadroomSec: 301 }).blockers.some((item) => item.code === "HEADROOM_INSUFFICIENT"));
  assert.ok(evaluateOwnerWizardSnapshot({ feasibility: feasibility({ shadow: { ...feasibility().shadow, market: { ...feasibility().shadow.market, marketId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } } }), minimumHeadroomSec: 270, expectedMarketId: MARKET }).blockers.some((item) => item.code === "MARKET_CHANGED"));
  assert.ok(evaluateOwnerWizardSnapshot({ feasibility: feasibility({ sellAfterMint: { ...feasibility().sellAfterMint, riskDecision: { state: "HALT" } } }), minimumHeadroomSec: 270 }).blockers.some((item) => item.code === "RISK_NOT_ALLOW"));
  assert.ok(evaluateOwnerWizardSnapshot({ feasibility: feasibility({ sellAfterMint: { ...feasibility().sellAfterMint, quotePlan: { plan: "NO_QUOTE", ask: { enabled: false } } } }), minimumHeadroomSec: 270 }).blockers.some((item) => item.code === "NO_QUOTE"));
});

test("final handoff exposes only EXECUTION_DISABLED when all live facts pass", () => {
  assert.deepEqual(finalOwnerHandoffBlockers({ executionEnabled: false, marketApproved: true, protocolPrepared: true, collateralRaw: OWNER_WIZARD_CAPITAL_RAW, operator: OWNER_WIZARD_OPERATOR, marketTrading: true, headroomSec: 120 }), ["EXECUTION_DISABLED"]);
  assert.ok(finalOwnerHandoffBlockers({ executionEnabled: false, marketApproved: true, protocolPrepared: false, collateralRaw: OWNER_WIZARD_CAPITAL_RAW, operator: OWNER_WIZARD_OPERATOR, marketTrading: true, headroomSec: 120 }).includes("PROTOCOL_APPROVAL_MISSING"));
});
