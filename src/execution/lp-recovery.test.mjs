import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { encodeFunctionData } from "viem";
import { VILLA_ACCOUNT_OPERATOR_ABI } from "./lp-adapter.mjs";
import { reconcileDurableJournal, resolveMintRecovery } from "./lp-recovery.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const MARKET = "0x000000000000000000000000000000000000000000000000000000000000f920";
const CONFIG = Object.freeze({ account: ACCOUNT, operator: OPERATOR, marketId: MARKET, chainId: 50312 });

function state({ capitalRaw = 1_001_000n, yesRaw = 1_000n, noRaw = 1_000n } = {}) {
  return { capital: { directCollateralRaw: capitalRaw }, inventory: { yesRaw, noRaw } };
}

function confirmedMint() {
  return { hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", action: "MINT_COMPLETE_SET", account: ACCOUNT, marketId: MARKET, state: "CONFIRMED", functionName: "operatorMintSet", amountRaw: "1000", receiptStatus: "success", receiptBlock: "7" };
}

function journal(records) {
  return { pending: 0, unknown: 0, reverted: 0, records };
}

function tempJournal(payload) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "villa-recovery-"));
  const journalPath = path.join(directory, "transactions.json");
  fs.writeFileSync(journalPath, JSON.stringify({ version: "villa-private-account-writer-v1", nextNonce: 124, sequence: 1, halted: true, records: payload }));
  return journalPath;
}

function chainProof() {
  return {
    async getTransaction() {
      return { from: OPERATOR, to: ACCOUNT, chainId: 50312, input: encodeFunctionData({ abi: VILLA_ACCOUNT_OPERATOR_ABI, functionName: "operatorMintSet", args: [MARKET, 1000n] }) };
    },
    async getTransactionReceipt() { return { status: "success", blockNumber: 477312009n }; },
  };
}

test("confirmed mint recovery adopts exact inventory and skips duplicate mint", () => {
  const result = resolveMintRecovery({ config: CONFIG, journal: journal([confirmedMint()]), accountState: state() });
  assert.equal(result.mint, "ALREADY_CONFIRMED");
  assert.equal(result.skipMint, true);
  assert.equal(result.amountRaw, 1000n);
  assert.equal(result.cleanupBurnAmountRaw, 1000n);
});

test("confirmed mint recovery blocks mismatched inventory", () => {
  assert.throws(() => resolveMintRecovery({ config: CONFIG, journal: journal([confirmedMint()]), accountState: state({ yesRaw: 999n }) }), { code: "INVENTORY_MINT_MISMATCH" });
});

test("confirmed mint recovery blocks mismatched capital", () => {
  assert.throws(() => resolveMintRecovery({ config: CONFIG, journal: journal([confirmedMint()]), accountState: state({ capitalRaw: 1_000_000n }) }), { code: "CAPITAL_MINT_MISMATCH" });
});

test("inventory without a confirmed mint is never adopted", () => {
  assert.throws(() => resolveMintRecovery({ config: CONFIG, journal: journal([]), accountState: state() }), { code: "UNEXPECTED_INVENTORY" });
});

test("direct recovery scope guard rejects a mismatched account", () => {
  assert.throws(() => resolveMintRecovery({ config: CONFIG, journal: journal([{ ...confirmedMint(), account: "0x4444444444444444444444444444444444444444" }]), accountState: state() }), { code: "JOURNAL_SCOPE_MISMATCH" });
});

test("direct recovery scope guard rejects a mismatched market", () => {
  assert.throws(() => resolveMintRecovery({ config: CONFIG, journal: journal([{ ...confirmedMint(), marketId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }]), accountState: state() }), { code: "JOURNAL_SCOPE_MISMATCH" });
});

test("unresolved unknown remains a hard recovery blocker", async () => {
  const journalPath = tempJournal([{ ...confirmedMint(), state: "UNKNOWN", receiptStatus: null, receiptBlock: null }]);
  const result = await reconcileDurableJournal({ journalPath, publicClient: { async getTransaction() { return null; }, async getTransactionReceipt() { return null; } }, config: CONFIG });
  assert.equal(result.unknown, 1);
  assert.equal(result.pending, 0);
  assert.equal(result.records[0].state, "UNKNOWN");
  assert.throws(() => resolveMintRecovery({ config: CONFIG, journal: result, accountState: state() }), { code: "RESTART_RECONCILIATION_REQUIRED" });
});

test("unknown mint reconciles from chain proof and becomes adoptable", async () => {
  const journalPath = tempJournal([{ ...confirmedMint(), state: "UNKNOWN", receiptStatus: null, receiptBlock: null }]);
  const result = await reconcileDurableJournal({ journalPath, publicClient: chainProof(), config: CONFIG });
  assert.equal(result.unknown, 0);
  assert.equal(result.records[0].state, "CONFIRMED");
  assert.equal(result.records[0].amountRaw, "1000");
  const recovered = resolveMintRecovery({ config: CONFIG, journal: result, accountState: state() });
  assert.equal(recovered.skipMint, true);
});

test("durable journal rejects an account mismatch before adoption", async () => {
  const journalPath = tempJournal([{ ...confirmedMint(), account: "0x4444444444444444444444444444444444444444" }]);
  await assert.rejects(() => reconcileDurableJournal({ journalPath, publicClient: chainProof(), config: CONFIG }), { code: "JOURNAL_SCOPE_MISMATCH" });
});

test("durable journal rejects a market mismatch before adoption", async () => {
  const journalPath = tempJournal([{ ...confirmedMint(), marketId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }]);
  await assert.rejects(() => reconcileDurableJournal({ journalPath, publicClient: chainProof(), config: CONFIG }), { code: "JOURNAL_SCOPE_MISMATCH" });
});
