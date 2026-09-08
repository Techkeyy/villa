import assert from "node:assert/strict";
import test from "node:test";
import { classifyFactBasedRecovery, recoveryActions } from "./lp-session-recovery.mjs";
import { reconcileControlPayload } from "../../dashboard/control-client.mjs";
import { assessSessionSettlement, assessSessionValueCompleteness } from "../settlement/session-lifecycle.mjs";
import { createLpExecutionSession, transitionLpSession } from "./lp-session.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const MARKET = "0x" + "aa".repeat(32);
const session = createLpExecutionSession({ sessionId: "uat-1000-aaaaaaaa", account: ACCOUNT, owner: OWNER, operator: OPERATOR, marketSeries: "BINARY:BTC:300", currentMarketId: MARKET, riskPolicyVersion: "villa-risk-v1", createdAt: 1000 });
const provenance = { schemaVersion: "villa-lp-execution-provenance-v1" };
const cleanFacts = { activeUnit: false, activeLease: false, activeSignerWorker: false, openOrders: 0, outcomeInventory: 0, aggregateExposure: 0, mintExposure: 0, vault: 0, claimableValue: 0, pendingSettlement: false, redeemableValue: 0, unknownTransactions: 0 };
const journal = (records = []) => ({ initializedBeforeWrite: true, writeAuthorityReached: records.length > 0, records });
const confirmed = (action, extra = {}) => ({ action, state: "CONFIRMED", account: ACCOUNT, marketId: MARKET, sessionId: session.sessionId, ...extra });
const facts = (patch = {}) => ({ ...cleanFacts, ...patch });
const accountState = ({ yesRaw = 0n, noRaw = 0n, vaultRaw = 0n, orders = [], orderStatus = "VERIFIED" } = {}) => ({ account: ACCOUNT, inventory: { yesRaw, noRaw }, capital: { directCollateralRaw: 1_000_000n, vaultRaw }, orders: { status: orderStatus, orders } });
const settlementArgs = (overrides = {}) => ({ session, account: ACCOUNT, owner: OWNER, marketId: MARKET, onchain: { status: 1, isResolved: false, isVoided: false }, held: { yesRaw: 1000n, noRaw: 1000n }, owned: { yesRaw: 0n, noRaw: 0n }, orders: { status: "VERIFIED", orders: [] }, capital: { directCollateralRaw: 1_000_000n, vaultRaw: 0n }, outcomeIds: { yes: 11n, no: 12n }, ...overrides });

test("16. mint succeeds then order fails: facts drive paired cleanup", () => {
  const result = classifyFactBasedRecovery({ provenance, journal: journal([confirmed("MINT_COMPLETE_SET")]), facts: facts({ outcomeInventory: 2000 }) });
  assert.equal(result.classification, "DIRTY");
  assert.ok(result.requiredActions.includes("RECONCILE_INVENTORY"));
  assert.equal(recoveryActions({ session, provenance: { knownOrderIds: [] }, accountState: accountState({ yesRaw: 1000n, noRaw: 1000n }) }).burnAmountRaw, 1000n);
});

test("17. uncertain order is resolved by journal and live order facts without a duplicate place", () => {
  const result = classifyFactBasedRecovery({ provenance, journal: journal([confirmed("MINT_COMPLETE_SET"), confirmed("PLACE_ORDER", { side: "SELL_YES" })]), facts: facts({ openOrders: 1, outcomeInventory: 2000 }) });
  assert.equal(result.classification, "DIRTY");
  assert.deepEqual(result.requiredActions.slice(0, 2), ["CANCEL_ORDERS", "RECONCILE_INVENTORY"]);
});

test("18. partial fill remains exact residual inventory and settlement-required", () => {
  const result = assessSessionSettlement(settlementArgs({ owned: { yesRaw: 400n, noRaw: 1000n } }));
  assert.equal(result.state, "STOPPED_SETTLEMENT_PENDING");
  assert.equal(assessSessionValueCompleteness({ inventory: result.owned, capital: { directCollateralRaw: 1_000_000n, vaultRaw: 0n }, settlement: result }).state, "SETTLEMENT_REQUIRED");
});

test("19. vault proceeds remain claim-required", () => {
  const result = assessSessionSettlement(settlementArgs({ capital: { directCollateralRaw: 1_000_000n, vaultRaw: 568n } }));
  assert.equal(result.state, "SETTLEMENT_READY");
  assert.equal(result.claimVaultRaw, 568n);
  assert.equal(recoveryActions({ session, provenance: { knownOrderIds: [] }, accountState: accountState({ vaultRaw: 568n }) }).claimVaultRaw, 568n);
  assert.equal(assessSessionValueCompleteness({ capital: { directCollateralRaw: 1_000_000n, vaultRaw: 568n }, settlement: result }).state, "CLAIM_REQUIRED");
});

test("20. unresolved market later creates an explicit winner redemption leg", () => {
  assert.equal(assessSessionSettlement(settlementArgs({ owned: { yesRaw: 1000n, noRaw: 1000n } })).state, "STOPPED_SETTLEMENT_PENDING");
  const result = assessSessionSettlement(settlementArgs({ onchain: { status: 4, isResolved: true, isVoided: false }, payoutNumerators: [10_000_000n, 0n], owned: { yesRaw: 1000n, noRaw: 0n } }));
  assert.equal(result.state, "SETTLEMENT_READY");
  assert.equal(result.plan.legs[0].action, "REDEEM");
});

test("21. settlement reaches withdrawable and the session state permits another start", () => {
  let value = transitionLpSession(transitionLpSession(session, "PREFLIGHT", { atMs: 1100 }), "RUNNING", { atMs: 1200 });
  value = transitionLpSession(transitionLpSession(value, "STOPPING", { atMs: 1300 }), "SETTLEMENT_READY", { atMs: 1400 });
  value = transitionLpSession(transitionLpSession(value, "SETTLING", { atMs: 1500 }), "SETTLED", { atMs: 1600 });
  value = transitionLpSession(value, "WITHDRAWABLE", { atMs: 1700 });
  assert.equal(value.state, "WITHDRAWABLE");
  assert.equal(assessSessionValueCompleteness({ capital: { directCollateralRaw: 1_000_000n, vaultRaw: 0n } }).state, "WITHDRAWABLE");
});

test("22. confirmed write after worker crash is reconstructable from facts", () => {
  const result = classifyFactBasedRecovery({ provenance, journal: journal([confirmed("MINT_COMPLETE_SET")]), facts: facts({ outcomeInventory: 2000 }) });
  assert.equal(result.classification, "DIRTY");
});

test("23. refresh preserves current SETTLING over old terminal result", () => {
  const result = reconcileControlPayload({ state: "SETTLING", session: { sessionId: session.sessionId, account: ACCOUNT, owner: OWNER, state: "SETTLING" }, result: { status: "SETTLED" } }, { result: { status: "STOPPED" } });
  assert.equal(result.state, "SETTLING");
  assert.equal(result.active, true);
});

test("24. lifecycle facts preserve account isolation and clean retry classification", () => {
  assert.throws(() => assessSessionSettlement(settlementArgs({ session: { ...session, account: "0x4444444444444444444444444444444444444444" } })), { code: "ACCOUNT_SCOPE_MISMATCH" });
  const result = classifyFactBasedRecovery({ provenance, journal: journal(), facts: cleanFacts });
  assert.deepEqual(result, { classification: "CLEAN", safeToRetry: true, reason: "PRE_WRITE" });
});
