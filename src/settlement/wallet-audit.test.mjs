import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExactClaimableEntry,
  buildWalletInventoryAudit,
  reconcileWalletClaim,
  WALLET_AUDIT_VERSION,
  WALLET_INVENTORY_CLASSIFICATIONS,
} from "./wallet-audit.mjs";

const A = "0x000000000000000000000000000000000000000000000000000000000000a3cf";
const B = "0x000000000000000000000000000000000000000000000000000000000000a00b";
const YES_A = "100";
const NO_A = "101";
const NO_B = "200";

function observation({ marketId = A, status = 4, isResolved = true, isVoided = false, winningOutcome = 0, yesRaw = 1000n, noRaw = 0n, vector = [10_000_000n, 0n], orders = 0 } = {}) {
  return {
    marketId,
    row: { id: marketId, asset: "BTC", intervalSec: "300", status: status === 4 ? "Finalized" : "Trading" },
    onchain: { marketId, status, isResolved, isVoided, finalized: status === 4, winningOutcome, yesId: marketId === A ? YES_A : "201", noId: marketId === A ? NO_A : NO_B },
    balances: { yesRaw, noRaw, collateralRaw: 100_000_000n, sttRaw: 1_000_000_000_000_000_000n },
    payoutNumerators: status === 1 ? null : vector,
    orders: { status: "VERIFIED", count: orders },
  };
}

function position(marketId, outcomeIndex, tokenId, balance = "1000") {
  return { market: { id: marketId }, outcomeIndex, tokenId, balance };
}

test("classifies a settled winning balance as claimable with exact payout", () => {
  const audit = buildWalletInventoryAudit({
    positions: [position(A, 0, YES_A)],
    observations: [observation()],
  });
  assert.equal(audit.model, WALLET_AUDIT_VERSION);
  assert.equal(audit.unknownCount, 0);
  assert.deepEqual(audit.claimable[0], {
    marketId: A,
    outcome: "YES",
    outcomeIdx: 0,
    tokenId: YES_A,
    balanceRaw: 1000n,
    classification: WALLET_INVENTORY_CLASSIFICATIONS.CLAIMABLE_SETTLED_INVENTORY,
    action: "REDEEM",
    expectedPayoutRaw: 1000n,
    reason: null,
  });
});

test("classifies a resolved losing balance as a known zero-value residual", () => {
  const audit = buildWalletInventoryAudit({
    positions: [position(B, 1, NO_B)],
    observations: [observation({ marketId: B, yesRaw: 0n, noRaw: 1000n, vector: [10_000_000n, 0n] })],
  });
  assert.equal(audit.unknownCount, 0);
  assert.equal(audit.zeroValueResiduals[0].classification, WALLET_INVENTORY_CLASSIFICATIONS.KNOWN_ZERO_VALUE_SETTLED_RESIDUAL);
  assert.equal(audit.zeroValueResiduals[0].action, "SKIP");
  assert.equal(audit.zeroValueResiduals[0].reason, "LOSING_OUTCOME_ZERO_PAYOUT");
});

test("labels equal live YES and NO balances as paired burnable inventory", () => {
  const audit = buildWalletInventoryAudit({
    positions: [position(A, 0, YES_A), position(A, 1, NO_A)],
    observations: [observation({ status: 1, isResolved: false, finalized: false, yesRaw: 1000n, noRaw: 1000n })],
  });
  assert.equal(audit.unknownCount, 0);
  assert.equal(audit.active.length, 2);
  assert.ok(audit.active.every((entry) => entry.classification === WALLET_INVENTORY_CLASSIFICATIONS.PAIRED_BURNABLE_INVENTORY));
  assert.ok(audit.active.every((entry) => entry.completeSetsRaw === 1000n));
});

test("keeps unequal live inventory as active inventory", () => {
  const audit = buildWalletInventoryAudit({
    positions: [position(A, 0, YES_A)],
    observations: [observation({ status: 1, isResolved: false, finalized: false, yesRaw: 1000n, noRaw: 0n })],
  });
  assert.equal(audit.entries[0].classification, WALLET_INVENTORY_CLASSIFICATIONS.ACTIVE_MARKET_INVENTORY);
});

test("fails closed when a direct nonzero balance is missing from indexed positions", () => {
  const audit = buildWalletInventoryAudit({ observations: [observation()] });
  assert.equal(audit.unknownCount, 1);
  assert.equal(audit.entries[0].reason, "INDEXER_POSITION_MISSING");
});

test("fails closed for token and balance disagreement", () => {
  const tokenMismatch = buildWalletInventoryAudit({ positions: [position(A, 0, "999")], observations: [observation()] });
  assert.equal(tokenMismatch.unknownCount, 1);
  assert.equal(tokenMismatch.entries[0].reason, "TOKEN_ID_MISMATCH");
  const balanceMismatch = buildWalletInventoryAudit({ positions: [position(A, 0, YES_A, "999")], observations: [observation()] });
  assert.equal(balanceMismatch.unknownCount, 1);
  assert.equal(balanceMismatch.entries[0].reason, "INDEXER_CHAIN_BALANCE_MISMATCH");
});

test("exact claim scope rejects a different market or amount", () => {
  const audit = buildWalletInventoryAudit({ positions: [position(A, 0, YES_A)], observations: [observation()] });
  const entry = audit.claimable[0];
  assert.equal(assertExactClaimableEntry(entry, { marketId: A, outcomeIdx: 0, amountRaw: 1000n }), true);
  assert.throws(() => assertExactClaimableEntry(entry, { marketId: B, outcomeIdx: 0, amountRaw: 1000n }), (error) => error.code === "CLAIM_SCOPE_MISMATCH");
  assert.throws(() => assertExactClaimableEntry(entry, { marketId: A, outcomeIdx: 0, amountRaw: 999n }), (error) => error.code === "CLAIM_SCOPE_MISMATCH");
});

test("reconciles exact payout while keeping native gas separate", () => {
  const entry = buildWalletInventoryAudit({ positions: [position(A, 0, YES_A)], observations: [observation()] }).claimable[0];
  const result = reconcileWalletClaim({
    entry,
    before: { collateralRaw: 100_000_000n, sttRaw: 10_000_000_000_000_000_000n, yesRaw: 1000n, noRaw: 0n },
    after: { collateralRaw: 100_001_000n, sttRaw: 9_997_000_000_000_000_000n, yesRaw: 0n, noRaw: 0n },
    actualPayoutRaw: 1000n,
    receiptGasWei: 3_000_000_000_000_000n,
  });
  assert.equal(result.payoutExact, true);
  assert.equal(result.collateralDeltaRaw, 1000n);
  assert.equal(result.nativeBalanceDeltaWei, -3_000_000_000_000_000n);
  assert.equal(result.receiptGasWei, 3_000_000_000_000_000n);
  assert.equal(result.gasMeasuredSeparately, true);
  assert.throws(() => reconcileWalletClaim({ entry, before: { collateralRaw: 1n, sttRaw: 1n }, after: { collateralRaw: 2n, sttRaw: 1n, yesRaw: 1n }, actualPayoutRaw: 1000n }), (error) => error.code === "CLAIM_NOT_CLEARED");
});

test("same inventory audit input is deterministic", () => {
  const input = { positions: [position(A, 0, YES_A)], observations: [observation()] };
  assert.deepEqual(buildWalletInventoryAudit(input), buildWalletInventoryAudit(input));
});
