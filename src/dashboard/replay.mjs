/**
 * Recorded, read-only dashboard scenes built from VILLA verification evidence.
 *
 * These are not synthetic market ticks. Each displayed figure is either an
 * exact value in the verification record or an exact event fact from a local
 * secret-free journal. Unknown values remain unavailable.
 */

import { buildDashboardSnapshot } from "./contract.mjs";

const WALLET = "0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37";
const A3CF = "0x000000000000000000000000000000000000000000000000000000000000a3cf";
const A00B = "0x000000000000000000000000000000000000000000000000000000000000a00b";
const A3DD = "0x000000000000000000000000000000000000000000000000000000000000a3dd";
const A3E9 = "0x000000000000000000000000000000000000000000000000000000000000a3e9";
const A17B = "0x000000000000000000000000000000000000000000000000000000000000a17b";
const A17D = "0x000000000000000000000000000000000000000000000000000000000000a17d";
const ACCOUNT_BOUND_MARKET = "0x0000000000000000000000000000000000000000000000000000000000010a14";
const ACCOUNT_BOUND_OWNER = "0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d";
const ACCOUNT_BOUND_ACCOUNT = "0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2";
const ACCOUNT_BOUND_OPERATOR = "0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37";
const ACCOUNT_BOUND_ORDER_ID = "166020696663386049266";

const FILL_EVIDENCE = Object.freeze([
  { marketId: A3DD, orderId: "55340232221128713213", action: "SELL_YES", quantityRaw: "1000", result: "NO residual", source: "Phase 6A verification record" },
  { marketId: A3E9, orderId: "18446744073709615271", action: "SELL_YES", quantityRaw: "1000", result: "NO residual", source: "Phase 6A verification record" },
]);

function accountBoundScene() {
  const events = [
    { type: "ACCOUNT_FUNDED", sequence: 1, atChainSec: null, facts: { account: ACCOUNT_BOUND_ACCOUNT, capitalRaw: "1002000" } },
    { type: "ACCOUNT_OPERATOR_AUTHORIZED", sequence: 2, atChainSec: null, facts: { account: ACCOUNT_BOUND_ACCOUNT, operator: ACCOUNT_BOUND_OPERATOR } },
    { type: "INVENTORY_MINTED", sequence: 3, atChainSec: null, facts: { marketId: ACCOUNT_BOUND_MARKET, amountRaw: "1000" } },
    { type: "ORDER_RESTING", sequence: 4, atChainSec: null, facts: { marketId: ACCOUNT_BOUND_MARKET, orderId: ACCOUNT_BOUND_ORDER_ID, action: "SELL_YES", priceRaw: "356000", quantityRaw: "1000", owner: ACCOUNT_BOUND_ACCOUNT } },
    { type: "ORDER_CANCELLED", sequence: 5, atChainSec: null, facts: { marketId: ACCOUNT_BOUND_MARKET, orderId: ACCOUNT_BOUND_ORDER_ID } },
    { type: "PAIRED_INVENTORY_BURNED", sequence: 6, atChainSec: null, facts: { marketId: ACCOUNT_BOUND_MARKET, amountRaw: "1000" } },
    { type: "ACCOUNT_CAPITAL_RECONCILED", sequence: 7, atChainSec: null, facts: { account: ACCOUNT_BOUND_ACCOUNT, capitalRaw: "1002000", openOrders: 0 } },
  ];
  return {
    mode: "REPLAY",
    scene: "account-bound",
    source: "Recorded 2026-09-02 Shannon account-bound wet proof, no live writes",
    snapshot: buildDashboardSnapshot({
      generatedAtChainSec: null,
      system: { state: "STOPPED", network: "Somnia Shannon", walletAddress: ACCOUNT_BOUND_OPERATOR, currentSeries: "BINARY:BTC:86400", orchestratorVersion: "villa-account-bound-wet-proof-v1" },
      market: { marketId: ACCOUNT_BOUND_MARKET, asset: "BTC", intervalSec: 86400, reference: null, currentUnderlying: null, expiry: null, timeRemainingSec: null, status: "Finalized" },
      model: { pUp: null, pDown: null, confidence: null, volatility: null, fairValueModelVersion: "villa-fv-v1" },
      bookQuotes: { bestBid: null, bestAsk: null, targetBid: null, targetAsk: null, restingBid: null, restingAsk: null, bidQuantity: null, askQuantity: null, quotePlanVersion: "villa-quote-v1" },
      risk: { action: "HALT", triggeredReasons: ["MARKET_NOT_TRADING"], exposure: { directionalBalance: 0 }, capacity: null, collateral: { availableRaw: "1002000" }, gas: null },
      inventory: { currentMarketYes: "0", currentMarketNo: "0", completeSets: "0", directionalExposure: 0, classifications: ["CLEAN_AFTER_BURN"] },
      events,
      lifecycle: { currentMarket: ACCOUNT_BOUND_MARKET, previousMarket: null, rolloverState: "SETTLED" },
      accounting: { tUSDC: "1002000", STT: null, knownCollateralMovement: { status: "FINAL_COLLATERAL_RECONCILED" } },
    }),
    evidence: {
      title: "Canonical account-bound wet proof",
      note: "A bounded Shannon testnet proof. The LP account owned the capital and the order; the separate VILLA operator only executed the approved account action.",
      identity: {
        owner: ACCOUNT_BOUND_OWNER,
        account: ACCOUNT_BOUND_ACCOUNT,
        orderOwner: ACCOUNT_BOUND_ACCOUNT,
        operator: ACCOUNT_BOUND_OPERATOR,
      },
      steps: [
        "The LP funded a personal VillaAccount with 1,002,000 raw tUSDC.",
        "The LP authorized the canonical VILLA operator for approved account actions.",
        "VILLA minted the minimum complete set for the exact BTC 24-hour market.",
        "VILLA placed one real post-only SELL_YES order through the VillaAccount.",
        "DreamDEX recorded the VillaAccount as the order owner, while the VILLA operator was the caller.",
        "The order was cancelled, the paired inventory was burned, and capital returned to 1,002,000 raw.",
        "VILLA never called the owner withdrawal path. Execution is now disabled and the session is stopped.",
      ],
      facts: [
        "Canonical market ID: 0x0000000000000000000000000000000000000000000000000000000000010a14 (BTC 24-hour)",
        "Mint confirmed, minimum amount: 1000 raw",
        "Order confirmed: SELL_YES, price 0.356, quantity 1000 raw",
        "Order owner matched VillaAccount: YES",
        "Final state: 1,002,000 raw collateral, zero YES, zero NO, zero open orders",
        "No owner withdrawal was called",
      ],
      fills: [],
      transactionLabels: ["MINT TX", "ORDER TX", "CANCEL TX", "BURN TX"],
      transactions: [
        "0x0389fac8ca7fe56bf6b2b96324fd69dd4799845926e920fe136627445171b972",
        "0xbb4e0d8b33259858dee23a50ce9bbd8dac60fe3b52a803fdce260a429ba89e6d",
        "0x80a3563c92ef35fedfa61af5ae099ce5804cf74e80158615a0e7852a36078735",
        "0xb645b3b0b9ffbc7cd72c1b40aaca0f2f344afe64fb2c6c1145fa56fe81f0b87e",
      ],
    },
  };
}

function quoteScene() {
  const events = [
    { type: "MARKET_INITIALIZED", sequence: 1, atChainSec: null, facts: { marketId: "suffix:9a4f", source: "Phase 4B quote-cycle verification" } },
    { type: "FAIR_VALUE_UPDATED", sequence: 2, atChainSec: null, facts: { pUp: 0.768, modelVersion: "villa-fv-v1" } },
    { type: "GOVERNOR_STATE_CHANGED", sequence: 3, atChainSec: null, facts: { state: "ALLOW", reason: "NONE" } },
    { type: "INVENTORY_MINTED", sequence: 4, atChainSec: null, facts: { amountRaw: "1000" } },
    { type: "ORDER_RESTING", sequence: 5, atChainSec: null, facts: { action: "SELL_YES", priceRaw: "786000", quantityRaw: "1000" } },
    { type: "ORDER_RESTING", sequence: 6, atChainSec: null, facts: { action: "BUY_YES", priceRaw: "725000", quantityRaw: "1000" } },
  ];
  return {
    mode: "REPLAY",
    scene: "quote",
    source: "Recorded Phase 4B quote-cycle evidence, no live writes",
    comparisonOnly: { midpoint: 0.7165, note: "Exact midpoint recorded; individual best levels were not retained." },
    snapshot: buildDashboardSnapshot({
      generatedAtChainSec: null,
      system: { state: "RUNNING", network: "Somnia Shannon", walletAddress: WALLET, currentSeries: "BINARY:BTC:86400", orchestratorVersion: "villa-quote-v1" },
      market: { marketId: "suffix:9a4f", asset: "BTC", intervalSec: 86400, reference: 78528.87, currentUnderlying: 78975.325, expiry: null, timeRemainingSec: 58320, status: "Trading" },
      model: { pUp: 0.768, pDown: 0.232, confidence: 0.9, volatility: 3.208549e-5, fairValueModelVersion: "villa-fv-v1" },
      bookQuotes: { bestBid: null, bestAsk: null, targetBid: 725000, targetAsk: 786000, restingBid: 725000, restingAsk: 786000, bidQuantity: 1000, askQuantity: 1000, quotePlanVersion: "villa-quote-v1" },
      risk: { action: "ALLOW", triggeredReasons: [], exposure: { directionalBalance: 0 }, capacity: { directionalUp: 0.001, directionalDown: 0.001 }, collateral: { availableRaw: "99999000" }, gas: null },
      inventory: { currentMarketYes: "1000", currentMarketNo: "1000", completeSets: "1000", directionalExposure: 0, classifications: ["PAIRED_BURNABLE_INVENTORY"] },
      events,
      lifecycle: { currentMarket: "suffix:9a4f", previousMarket: null, rolloverState: "ACTIVE" },
      accounting: { tUSDC: "99999000", STT: null, knownCollateralMovement: { status: "RECORDED_AFTER_MINT" } },
    }),
    evidence: {
      title: "Recorded quote proof",
      note: "Phase 4B recorded a two-sided post-only checkpoint on the BTC 24h contract. The full market id was not retained in the verification record, so only suffix 9a4f is shown.",
      facts: ["VILLA fair UP 76.8%", "DreamDEX midpoint 71.65%, comparison only", "Post-only SELL_YES 78.60% and BUY_YES 72.50%", "No transaction is sent by this dashboard"],
      fills: [],
      transactions: [
        "0x5af3eec659addbbd095aab49dcbfad8c60ec6c4dd2d4f4fd316074a40ec617e7",
        "0xf03046325a38106e3b517502bf33ffe22a33236ff60d0a61ef576552d2af2332",
        "0x56866b26fb1b4a10e1cea9a168b0e1657e5113fe964db249960a85e3d0e1c34f",
      ],
    },
  };
}

function rolloverScene() {
  const events = [
    { type: "MARKET_CONTEXT_STARTED", sequence: 1, atChainSec: null, facts: { marketId: A17B } },
    { type: "CURRENT_MARKET_NO_LONGER_TRADING", sequence: 2, atChainSec: 1787745241, facts: { marketId: A17B, status: 4 } },
    { type: "SUCCESSOR_READY", sequence: 3, atChainSec: 1787745242, facts: { marketId: A17D } },
    { type: "FAIR_VALUE_UPDATED", sequence: 4, atChainSec: null, facts: { pUp: 0.550108, modelVersion: "villa-fv-v1" } },
    { type: "GOVERNOR_STATE_CHANGED", sequence: 5, atChainSec: null, facts: { state: "ALLOW", reason: "NONE" } },
    { type: "NO_QUOTE", sequence: 6, atChainSec: null, facts: { reason: "MIN_QUANTITY_UNMET / POST_ONLY_CONSTRAINT" } },
  ];
  return {
    mode: "REPLAY",
    scene: "rollover",
    source: "Recorded Phase 5B successor-market evidence, no live writes",
    snapshot: buildDashboardSnapshot({
      generatedAtChainSec: 1787745242,
      system: { state: "RUNNING", network: "Somnia Shannon", walletAddress: WALLET, currentSeries: "BINARY:BTC:60", orchestratorVersion: "villa-rollover-v1" },
      market: { marketId: A17D, asset: "BTC", intervalSec: 60, reference: 78529.44, currentUnderlying: 78532.35, expiry: 1787745300, timeRemainingSec: 57, status: "Trading" },
      model: { pUp: 0.550108, pDown: 0.449892, confidence: 0.95, volatility: 3.8973363e-5, fairValueModelVersion: "villa-fv-v1" },
      bookQuotes: { bestBid: 541000, bestAsk: 571000, targetBid: null, targetAsk: null, restingBid: null, restingAsk: null, bidQuantity: "0", askQuantity: "0", quotePlanVersion: "villa-quote-v1" },
      risk: { action: "ALLOW", triggeredReasons: [], exposure: { directionalBalance: 0 }, capacity: { directionalUp: 0.001, directionalDown: 0.001 }, collateral: null, gas: null },
      inventory: { currentMarketYes: "0", currentMarketNo: "0", completeSets: "0", directionalExposure: 0, classifications: ["CURRENT_MARKET_ONLY"] },
      events,
      lifecycle: { currentMarket: A17D, previousMarket: A17B, rolloverState: "SUCCESSOR_READY", historicalResiduals: [{ marketId: A00B, classification: "KNOWN_ZERO_VALUE_SETTLED_RESIDUAL", active: false }] },
      accounting: { tUSDC: null, STT: null },
    }),
    evidence: {
      title: "Recorded rollover proof",
      note: "The terminal A observation and later B discovery were observed on chain time. B was first seen after A left Trading, with zero overlap and zero transactions.",
      facts: ["Previous A: BTC 1m, market ending a17b, terminal status 4", "Current B: BTC 1m, market ending a17d, Trading", "B fair UP 55.0108%", "B quote plan NO_QUOTE because the minimum-grid and post-only constraints left no valid quote"],
      fills: [],
      transactions: [],
    },
  };
}

function settlementScene() {
  const events = [
    { type: "ORGANIC_FILL_POSITION_TRACKED", sequence: 1, atChainSec: 1787765603, facts: { marketId: A3DD, fillOrderId: "55340232221128713213", filledQuantityRaw: "1000", balance: { yesRaw: "0", noRaw: "1000" }, resolution: "RESOLVED", winningOutcome: 1 } },
    { type: "ORGANIC_FILL_POSITION_TRACKED", sequence: 2, atChainSec: 1787765603, facts: { marketId: A3E9, fillOrderId: "18446744073709615271", filledQuantityRaw: "1000", balance: { yesRaw: "0", noRaw: "1000" }, resolution: "RESOLVED", winningOutcome: 1 } },
    { type: "KNOWN_RESIDUAL_CLASSIFIED", sequence: 3, atChainSec: 1787765603, facts: { marketId: A00B, balance: { yesRaw: "0", noRaw: "1000" }, classification: "KNOWN_ZERO_VALUE_SETTLED_RESIDUAL", resolution: "RESOLVED", winningOutcome: 0 } },
    { type: "REDEEM_CONFIRMED", sequence: 4, atChainSec: null, facts: { marketId: A3DD, outcome: "NO", amountRaw: "1000", transaction: { hash: "0xc365dcd77a9f66ade5ca3363812ebccbbad091eb8618167e53693b230919d134" } } },
    { type: "REDEEM_CONFIRMED", sequence: 5, atChainSec: null, facts: { marketId: A3E9, outcome: "NO", amountRaw: "1000", transaction: { hash: "0xb04fffb4f9c55248e387029a66bc1de1e5671fd5cdd59f5b6be6b815e6ca4" } } },
    { type: "A3CF_REDEEM_CONFIRMED", sequence: 6, atChainSec: null, facts: { marketId: A3CF, outcome: "YES", amountRaw: "1000", transaction: { hash: "0xacc6c3173fd5c5ef887a93df6d1e56472ac054f5cfe7b246d8e7f4484e7af28f" } } },
    { type: "WALLET_HYGIENE_CLEAN", sequence: 7, atChainSec: 1787770823, facts: { unknownCount: 0, activeOrders: 0, claimableWinners: 0 } },
  ];
  return {
    mode: "REPLAY",
    scene: "settlement",
    source: "Recorded Phase 6A and Phase 6A.1 settlement evidence, no live writes",
    snapshot: buildDashboardSnapshot({
      generatedAtChainSec: 1787770823,
      system: { state: "STOPPED", network: "Somnia Shannon", walletAddress: WALLET, currentSeries: "BINARY:BTC:300", orchestratorVersion: "villa-loop-v1" },
      market: { marketId: A3CF, asset: "BTC", intervalSec: 300, reference: 78025.85, currentUnderlying: null, expiry: 1787759400, timeRemainingSec: null, status: "Finalized" },
      model: { pUp: null, pDown: null, confidence: null, volatility: null, fairValueModelVersion: "villa-fv-v1" },
      bookQuotes: { bestBid: null, bestAsk: null, targetBid: null, targetAsk: null, restingBid: null, restingAsk: null, bidQuantity: null, askQuantity: null, quotePlanVersion: "villa-quote-v1" },
      risk: { action: "HALT", triggeredReasons: ["MARKET_NOT_TRADING"], exposure: { directionalBalance: 0 }, capacity: null, collateral: null, gas: null },
      inventory: { currentMarketYes: "0", currentMarketNo: "0", completeSets: "0", directionalExposure: 0, classifications: [] },
      events,
      lifecycle: {
        currentMarket: A3CF,
        previousMarket: A3DD,
        rolloverState: "SETTLED",
        settlementClaims: [
          { marketId: A3DD, outcome: "NO", amountRaw: "1000", payoutRaw: "1000", status: "REDEEMED", transactionHash: "0xc365dcd77a9f66ade5ca3363812ebccbbad091eb8618167e53693b230919d134" },
          { marketId: A3E9, outcome: "NO", amountRaw: "1000", payoutRaw: "1000", status: "REDEEMED", transactionHash: "0xb04fffb4f9c55248e387029a66bc1de1e5671fd5cdd59f5b6be6b815e6ca4" },
          { marketId: A3CF, outcome: "YES", amountRaw: "1000", payoutRaw: "1000", status: "REDEEMED", transactionHash: "0xacc6c3173fd5c5ef887a93df6d1e56472ac054f5cfe7b246d8e7f4484e7af28f" },
        ],
        historicalResiduals: [{ marketId: A00B, outcome: "NO", amountRaw: "1000", classification: "KNOWN_ZERO_VALUE_SETTLED_RESIDUAL", status: "SETTLED_ZERO_VALUE" }],
      },
      accounting: { tUSDC: "100000954", STT: "49842766634000000000", knownCollateralMovement: { status: "RECORDED_PAYOUTS", payoutsRaw: "3000" } },
    }),
    evidence: {
      title: "Recorded fill and settlement proof",
      note: "The fills and redeems below are exact facts from the Phase 6A verification record and the secret-free Phase 6A.1 recovery journal. They were not recreated by the dashboard.",
      facts: ["Two genuine external SELL_YES fills, 1000 raw each", "A and B resolved with NO and paid 1000 raw each", "a3cf YES claim paid 1000 raw", "Final wallet audit: zero active orders, zero claimable winners, zero unknown inventory"],
      fills: FILL_EVIDENCE,
      transactions: ["0xc365dcd77a9f66ade5ca3363812ebccbbad091eb8618167e53693b230919d134", "0xb04fffb4f9c55248e387029a66bc1de1e5671fd5cdd59f5b6be6b815e6ca4", "0xacc6c3173fd5c5ef887a93df6d1e56472ac054f5cfe7b246d8e7f4484e7af28f"],
    },
  };
}

const SCENES = Object.freeze({ "account-bound": accountBoundScene, quote: quoteScene, rollover: rolloverScene, settlement: settlementScene });

export const REPLAY_SCENES = Object.freeze(Object.keys(SCENES));

export function buildReplayEnvelope(scene = "quote") {
  return (SCENES[scene] ?? SCENES.quote)();
}
