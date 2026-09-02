/**
 * Pure safety boundary for the Phase 3B1.1 localhost owner-preparation
 * wizard. This module contains no wallet, RPC writer, signer, or engine code.
 * It only validates a read-only feasibility envelope and builds the two
 * exact owner calls permitted by the phase.
 */

import { encodeFunctionData } from "viem";
import { VILLA_ACCOUNT_OWNER_PREP_ABI } from "./lp-owner-prep.mjs";

export const LP_OWNER_WIZARD_VERSION = "villa-lp-owner-wizard-v1";
export const OWNER_WIZARD_CHAIN_ID = 50312;
export const OWNER_WIZARD_ACCOUNT = "0x3a46446a30f945d390a41daab0d390fbef3d2cf2";
export const OWNER_WIZARD_OWNER = "0xefe0412781d3c1e7888b2db9deeca3037542494d";
export const OWNER_WIZARD_OPERATOR = "0xaf4ee6c0c6ff6337f4c4f07b87c8343df73e8d37";
export const OWNER_WIZARD_CAPITAL_RAW = "1002000";
export const OWNER_WIZARD_MINT_RAW = "1000";
export const OWNER_WIZARD_INITIAL_HEADROOM_SEC = 240;
export const OWNER_WIZARD_TX1_HEADROOM_SEC = 180;
export const OWNER_WIZARD_FINAL_HEADROOM_SEC = 120;
export const OWNER_WIZARD_15M_SERIES = "BINARY:BTC:900";
export const OWNER_WIZARD_15M_INITIAL_HEADROOM_SEC = 600;
export const OWNER_WIZARD_15M_TX1_HEADROOM_SEC = 480;
export const OWNER_WIZARD_15M_FINAL_PREFLIGHT_HEADROOM_SEC = 360;
export const OWNER_WIZARD_15M_FINAL_HANDOFF_HEADROOM_SEC = 300;
export const OWNER_WIZARD_1H_SERIES = "BINARY:BTC:3600";
export const OWNER_WIZARD_1H_INITIAL_HEADROOM_SEC = 1500;
export const OWNER_WIZARD_1H_TX1_HEADROOM_SEC = 1200;
export const OWNER_WIZARD_1H_FINAL_PREFLIGHT_HEADROOM_SEC = 900;
export const OWNER_WIZARD_1H_FINAL_HANDOFF_HEADROOM_SEC = 900;
export const OWNER_WIZARD_4H_SERIES = "BINARY:BTC:14400";
export const OWNER_WIZARD_4H_INITIAL_HEADROOM_SEC = 2100;
export const OWNER_WIZARD_4H_TX1_HEADROOM_SEC = 1800;
export const OWNER_WIZARD_4H_FINAL_PREFLIGHT_HEADROOM_SEC = 1500;
export const OWNER_WIZARD_4H_FINAL_HANDOFF_HEADROOM_SEC = 1500;
// The adaptive first-wet-proof helper evaluates every live BTC interval and
// ranks only candidates that pass the complete read-only owner-prep envelope.
// Keep these independent from the historical interval-specific policies above.
export const OWNER_WIZARD_AUTO_INITIAL_HEADROOM_SEC = 3600;
export const OWNER_WIZARD_AUTO_TX1_HEADROOM_SEC = 2700;
export const OWNER_WIZARD_AUTO_FINAL_PREFLIGHT_HEADROOM_SEC = 2700;
export const OWNER_WIZARD_AUTO_FINAL_HANDOFF_HEADROOM_SEC = 2700;

// These are invalidated owner-prep candidates, not reusable fixtures. The
// server also keeps the set in memory so a candidate cannot return after a
// failed/stale review in the same local session.
export const INVALIDATED_OWNER_MARKETS = Object.freeze(new Set([
  "0x000000000000000000000000000000000000000000000000000000000000f8bc",
  "0x000000000000000000000000000000000000000000000000000000000000f5ee",
  "0x000000000000000000000000000000000000000000000000000000000000f5fe",
  "0x000000000000000000000000000000000000000000000000000000000000fee9",
  "0x000000000000000000000000000000000000000000000000000000000000fee7",
  "0x0000000000000000000000000000000000000000000000000000000000010050",
]));

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const BYTES32_RE = /^0x[0-9a-f]{64}$/i;
const REQUIRED_SEQUENCES = Object.freeze({
  A: Object.freeze(["operatorPlaceOrder", "operatorCancelOrder"]),
  B: Object.freeze(["operatorMintSet", "operatorPlaceOrder", "operatorCancelOrder", "operatorBurnSet"]),
});

const lower = (value) => String(value ?? "").toLowerCase();
const same = (left, right) => lower(left) === lower(right);
const numberOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const rawString = (value) => {
  try { return BigInt(String(value)).toString(); } catch { return null; }
};

export function isInvalidatedOwnerMarket(marketId) {
  return INVALIDATED_OWNER_MARKETS.has(lower(marketId));
}

/**
 * Rank fully evaluated owner-prep candidates by the least disruptive proof
 * that still leaves the most time. The helper supplies `valid` only after
 * all market, account, risk, quote, policy, and owner-call checks pass.
 */
export function rankOwnerPreparationCandidates(candidates = [], { minimumHeadroomSec = OWNER_WIZARD_AUTO_INITIAL_HEADROOM_SEC } = {}) {
  const minimum = Number(minimumHeadroomSec);
  if (!Array.isArray(candidates) || !Number.isFinite(minimum)) return Object.freeze([]);
  const ranked = candidates
    .filter((candidate) => candidate?.valid === true && Number(candidate?.evaluated?.headroomSec) >= minimum)
    .slice()
    .sort((left, right) => {
      const headroom = Number(right.evaluated.headroomSec) - Number(left.evaluated.headroomSec);
      if (headroom) return headroom;
      const path = (left.evaluated.projectedPath === "A" ? 0 : 1) - (right.evaluated.projectedPath === "A" ? 0 : 1);
      if (path) return path;
      const leftActions = Array.isArray(left.evaluated.projected?.sequence?.actions) ? left.evaluated.projected.sequence.actions.length : Number.MAX_SAFE_INTEGER;
      const rightActions = Array.isArray(right.evaluated.projected?.sequence?.actions) ? right.evaluated.projected.sequence.actions.length : Number.MAX_SAFE_INTEGER;
      if (leftActions !== rightActions) return leftActions - rightActions;
      return lower(left.candidate?.marketId ?? left.evaluated.marketId).localeCompare(lower(right.candidate?.marketId ?? right.evaluated.marketId));
    });
  return Object.freeze(ranked);
}

function add(blockers, code, reason) {
  if (!blockers.some((item) => item.code === code)) blockers.push({ code, reason });
}

function marketFrom(feasibility) {
  return feasibility?.shadow?.market ?? feasibility?.market ?? null;
}

function chainTimeFrom(feasibility) {
  return numberOrNull(feasibility?.shadow?.risk?.authoritativeTime?.chainNowSec)
    ?? numberOrNull(feasibility?.shadow?.chainNowSec)
    ?? numberOrNull(feasibility?.chainNowSec);
}

function projectedSequenceFrom(feasibility, projectedPath = "B") {
  const path = projectedPath === "A" ? "A" : "B";
  const projected = path === "A" ? feasibility?.buyWithoutMint : feasibility?.sellAfterMint;
  return {
    viable: projected?.viable === true,
    path,
    mintAmountRaw: path === "A" ? "0" : rawString(projected?.mintAmountRaw),
    riskState: projected?.riskDecision?.state ?? null,
    quotePlan: projected?.quotePlan ?? null,
    quoteExecution: projected?.quoteExecution ?? null,
    sequence: projected?.sequence ?? null,
  };
}

function validateSequence(sequence, blockers, path) {
  if (sequence?.valid !== true) {
    add(blockers, "PROJECTED_SEQUENCE_INVALID", path === "A"
      ? "the projected BUY_YES, cancel, and reconcile path did not pass policy"
      : "the projected mint, post-only SELL_YES, cancel, reconcile, and burn path did not pass policy");
    return;
  }
  const actions = Array.isArray(sequence.actions) ? sequence.actions : [];
  const names = actions.map((item) => item?.functionName);
  for (const required of REQUIRED_SEQUENCES[path === "A" ? "A" : "B"]) {
    if (!names.includes(required)) add(blockers, "PROJECTED_SEQUENCE_INCOMPLETE", `projected sequence is missing ${required}`);
  }
}

/**
 * Validate one fresh feasibility envelope. `minimumHeadroomSec` is the
 * operational threshold for this wizard stage; the base owner-prep module
 * still enforces its independent 120-second lower bound.
 */
export function evaluateOwnerWizardSnapshot({ feasibility, minimumHeadroomSec, expectedMarketId = null, expectedSeries = "BINARY:BTC:300", projectedPath = "B", requireMarketApproved = null, requireProtocolPrepared = null } = {}) {
  const blockers = [];
  const market = marketFrom(feasibility);
  const marketId = lower(market?.marketId ?? feasibility?.market?.marketId);
  const chainNowSec = chainTimeFrom(feasibility);
  const expirySec = numberOrNull(market?.expirySec ?? feasibility?.market?.expirySec);
  const headroomSec = expirySec === null || chainNowSec === null ? null : expirySec - chainNowSec;
  const projected = projectedSequenceFrom(feasibility, projectedPath);
  const permissions = feasibility?.shadow?.permissions ?? {};

  if (feasibility?.result !== "PASS") add(blockers, "FRESH_READ_FAILED", feasibility?.reason ?? "the fresh read-only feasibility check did not pass");
  if (!BYTES32_RE.test(marketId)) add(blockers, "MARKET_ID_INVALID", "the selected market id is not bytes32");
  if (isInvalidatedOwnerMarket(marketId)) add(blockers, "HISTORICAL_MARKET_DENIED", "this market id was invalidated and cannot be reused");
  if (market?.series !== expectedSeries) add(blockers, "MARKET_SERIES_MISMATCH", `the selected market is not ${expectedSeries}`);
  if (market?.status !== undefined && String(market.status).toLowerCase() !== "trading" && Number(market.status) !== 1) add(blockers, "MARKET_NOT_TRADING", "the selected market is not Trading");
  if (market?.current === false || market?.poolFinalized === true) add(blockers, "STALE_MARKET", "the selected market is stale or finalized");
  if (!Array.isArray(market?.book?.bids) || !Array.isArray(market?.book?.asks) || (market.book.bids.length === 0 && market.book.asks.length === 0)) add(blockers, "BOOK_UNUSABLE", "the selected market has no usable live YES book");
  if (expectedMarketId !== null && !same(marketId, expectedMarketId)) add(blockers, "MARKET_CHANGED", "the live market differs from the reviewed market");
  if (headroomSec === null) add(blockers, "HEADROOM_UNKNOWN", "live expiry and chain time were not both verified");
  else if (headroomSec < Number(minimumHeadroomSec)) add(blockers, "HEADROOM_INSUFFICIENT", `only ${Math.floor(headroomSec)} seconds remain; ${minimumHeadroomSec} seconds are required`);

  if (Number(feasibility?.shadow?.chainId ?? feasibility?.chainId) !== OWNER_WIZARD_CHAIN_ID) add(blockers, "CHAIN_MISMATCH", "the feasibility read was not on Shannon 50312");
  if (!same(feasibility?.account, OWNER_WIZARD_ACCOUNT)) add(blockers, "ACCOUNT_MISMATCH", "the verified VillaAccount is not the canonical disposable account");
  if (!same(feasibility?.owner, OWNER_WIZARD_OWNER)) add(blockers, "OWNER_MISMATCH", "the verified owner is not the authorized owner wallet");
  if (!same(feasibility?.operator, OWNER_WIZARD_OPERATOR)) add(blockers, "OPERATOR_MISMATCH", "the verified operator is not the canonical VILLA operator");

  const capital = rawString(feasibility?.shadow?.capital?.directCollateralRaw ?? feasibility?.shadow?.capital?.collateralAvailableRaw ?? feasibility?.capital?.collateralAvailableRaw);
  if (capital !== OWNER_WIZARD_CAPITAL_RAW) add(blockers, "CAPITAL_MISMATCH", `live account capital is ${capital ?? "unknown"} raw, not ${OWNER_WIZARD_CAPITAL_RAW}`);

  if (!projected.viable) add(blockers, "PROJECTED_SEQUENCE_INVALID", projected.path === "A"
    ? "the bounded BUY_YES projection is not viable"
    : "the full bounded mint and SELL_YES projection is not viable");
  if (projected.path === "B" && projected.mintAmountRaw !== OWNER_WIZARD_MINT_RAW) add(blockers, "MINT_AMOUNT_MISMATCH", "the projected mint is not exactly 1,000 raw");
  if (projected.riskState !== "ALLOW") add(blockers, "RISK_NOT_ALLOW", "the projected risk state is not ALLOW");
  const quote = projected.quotePlan;
  if (!quote || quote.plan === "NO_QUOTE") add(blockers, "NO_QUOTE", "the projected quote plan is NO_QUOTE");
  const side = projected.path === "A" ? quote?.bid : quote?.ask;
  const expectedAction = projected.path === "A" ? "BUY_YES" : "SELL_YES";
  if (side?.enabled !== true || side?.action !== expectedAction) add(blockers, "QUOTE_ACTION_MISMATCH", `the projected quote is not one post-only ${expectedAction}`);
  if (rawString(side?.targetQuantityRaw) !== OWNER_WIZARD_MINT_RAW) add(blockers, "QUOTE_QUANTITY_MISMATCH", `the projected ${expectedAction} quantity is not exactly 1,000 raw`);
  if (projected.quoteExecution?.postOnly !== true || Number(projected.quoteExecution?.orderType) !== 3) add(blockers, "POST_ONLY_NOT_PROVEN", "the projected quote is not proven post-only");
  if (projected.quoteExecution?.policyValid !== true) add(blockers, "POLICY_NOT_PROVEN", "the projected quote did not pass the account policy");
  validateSequence(projected.sequence, blockers, projected.path);

  const marketApproved = permissions.marketApproved === true;
  const protocolPrepared = permissions.protocolPrepared === true || (permissions.moduleOperator === true && permissions.poolOperator === true);
  if (requireMarketApproved !== null && marketApproved !== requireMarketApproved) add(blockers, requireMarketApproved ? "MARKET_NOT_APPROVED" : "MARKET_ALREADY_APPROVED", "on-chain market approval state does not match this wizard action");
  if (requireProtocolPrepared !== null && protocolPrepared !== requireProtocolPrepared) add(blockers, requireProtocolPrepared ? "PROTOCOL_APPROVAL_MISSING" : "PROTOCOL_ALREADY_PREPARED", "on-chain protocol approval state does not match this wizard action");
  if (feasibility?.shadow?.executionEnabled === true || feasibility?.executionEnabled === true) add(blockers, "EXECUTION_ENABLED", "execution must remain disabled during owner preparation");

  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze(blockers),
    marketId,
    expirySec,
    chainNowSec,
    headroomSec,
    marketApproved,
    protocolPrepared,
    quotePriceRaw: rawString(side?.targetPriceRaw),
    quoteQuantityRaw: rawString(side?.targetQuantityRaw),
    quoteAction: side?.action ?? null,
    projectedPath: projected.path,
    projected,
  });
}

export function buildExactOwnerAction({ action, marketId, account = OWNER_WIZARD_ACCOUNT, owner = OWNER_WIZARD_OWNER, chainId = OWNER_WIZARD_CHAIN_ID } = {}) {
  const id = lower(marketId);
  if (!BYTES32_RE.test(id)) throw new Error("marketId must be bytes32");
  if (isInvalidatedOwnerMarket(id)) throw new Error("invalidated marketId cannot be used");
  if (!ADDRESS_RE.test(lower(account)) || !same(account, OWNER_WIZARD_ACCOUNT)) throw new Error("owner action target must be the canonical VillaAccount");
  if (!ADDRESS_RE.test(lower(owner)) || !same(owner, OWNER_WIZARD_OWNER)) throw new Error("owner action sender must be the authorized owner");
  if (Number(chainId) !== OWNER_WIZARD_CHAIN_ID) throw new Error("owner action must use Shannon chain 50312");
  const functionName = action === "MARKET_APPROVAL" ? "setMarketApproval" : action === "PROTOCOL_APPROVAL" ? "prepareMarket" : null;
  if (!functionName) throw new Error("only market approval and protocol preparation are permitted");
  const args = functionName === "setMarketApproval" ? [id, true] : [id];
  const data = encodeFunctionData({ abi: VILLA_ACCOUNT_OWNER_PREP_ABI, functionName, args });
  return Object.freeze({
    action,
    functionName,
    from: lower(owner),
    to: lower(account),
    chainId: OWNER_WIZARD_CHAIN_ID,
    marketId: id,
    value: "0x0",
    selector: data.slice(0, 10).toLowerCase(),
    args: Object.freeze(args),
    data,
    requiresHumanWalletApproval: true,
    sign: false,
    broadcast: false,
  });
}

export function validateHumanOwnerTransaction({ action, transaction, marketId } = {}) {
  const expected = buildExactOwnerAction({ action, marketId });
  const sameData = lower(transaction?.data) === lower(expected.data);
  const valid = sameData
    && same(transaction?.from, expected.from)
    && same(transaction?.to, expected.to)
    && (transaction?.value === undefined || lower(transaction.value) === "0x0" || lower(transaction.value) === "0x00" || String(transaction.value) === "0");
  return Object.freeze({ valid, expected, reason: valid ? null : "wallet transaction did not match the exact reviewed owner call" });
}

export function validateOwnerWalletContext({ account, chainId } = {}) {
  const valid = same(account, OWNER_WIZARD_OWNER) && Number(chainId) === OWNER_WIZARD_CHAIN_ID;
  return Object.freeze({
    valid,
    reason: valid ? null : same(account, OWNER_WIZARD_OWNER) ? "wallet must be on Somnia Shannon 50312" : "wallet account is not the authorized owner",
  });
}

export function finalOwnerHandoffBlockers({ executionEnabled = false, marketApproved, protocolPrepared, collateralRaw, operator, marketTrading, headroomSec, minimumHeadroomSec = OWNER_WIZARD_FINAL_HEADROOM_SEC } = {}) {
  const blockers = [];
  if (marketApproved !== true) blockers.push("MARKET_NOT_APPROVED");
  if (protocolPrepared !== true) blockers.push("PROTOCOL_APPROVAL_MISSING");
  if (rawString(collateralRaw) !== OWNER_WIZARD_CAPITAL_RAW) blockers.push("CAPITAL_MISMATCH");
  if (!same(operator, OWNER_WIZARD_OPERATOR)) blockers.push("OPERATOR_MISMATCH");
  if (marketTrading !== true) blockers.push("MARKET_NOT_TRADING");
  if (numberOrNull(headroomSec) === null || Number(headroomSec) < minimumHeadroomSec) blockers.push("HEADROOM_INSUFFICIENT");
  if (executionEnabled !== false) blockers.push("EXECUTION_ENABLED");
  return Object.freeze([...new Set(blockers), ...(executionEnabled === false ? ["EXECUTION_DISABLED"] : [])]);
}
