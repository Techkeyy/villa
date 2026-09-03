/**
 * Durable private-runtime recovery helpers.
 *
 * Recovery is public-chain read-only. An UNKNOWN record is never adopted
 * from local memory; it must first match a chain transaction, receipt,
 * operator, VillaAccount, market, and audited calldata.
 */

import * as fs from "node:fs";
import { decodeFunctionData } from "viem";
import { DEFAULT_PHASE_3B1_CAPS } from "./lp-transaction-policy.mjs";
import { VILLA_ACCOUNT_OPERATOR_ABI } from "./lp-adapter.mjs";
import { receiptState } from "./lp-private-writer.mjs";

const JOURNAL_VERSION = "villa-private-account-writer-v1";
const ACTION_FUNCTIONS = Object.freeze({
  PLACE_ORDER: "operatorPlaceOrder",
  CANCEL_ORDER: "operatorCancelOrder",
  REDUCE_ORDER: "operatorReduceOrder",
  MINT_COMPLETE_SET: "operatorMintSet",
  BURN_COMPLETE_SET: "operatorBurnSet",
  REDEEM_RESOLVED: "operatorRedeem",
  CLAIM_VAULT_CREDIT: "operatorClaimVault",
});
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

function sameAddress(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function raw(value, label) {
  try {
    const result = typeof value === "bigint" ? value : BigInt(String(value));
    if (result < 0n) throw new Error();
    return result;
  } catch {
    const error = new Error(`${label} must be a non-negative raw integer`);
    error.code = "RECOVERY_VALUE_INVALID";
    throw error;
  }
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function readJournal(journalPath) {
  if (!journalPath || !fs.existsSync(journalPath)) return { payload: null, records: [] };
  let payload;
  try { payload = JSON.parse(fs.readFileSync(journalPath, "utf8")); } catch { fail("JOURNAL_CORRUPT", "private transaction journal is unreadable; recovery is blocked"); }
  if (payload?.version !== JOURNAL_VERSION || !Array.isArray(payload.records)) fail("JOURNAL_CORRUPT", "private transaction journal version is unsupported; recovery is blocked");
  return { payload, records: payload.records };
}

function persistJournal(journalPath, payload) {
  const temporary = `${journalPath}.reconcile-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(payload, (_key, item) => typeof item === "bigint" ? `${item}n` : item, 2), { mode: 0o600 });
  fs.renameSync(temporary, journalPath);
}

function transactionFacts(record, transaction, config) {
  if (!transaction || !sameAddress(transaction.from, config.operator) || !sameAddress(transaction.to, config.account)) fail("JOURNAL_SCOPE_MISMATCH", "the durable transaction does not match the bound operator and VillaAccount");
  if (transaction.chainId !== undefined && Number(transaction.chainId) !== config.chainId) fail("JOURNAL_CHAIN_MISMATCH", "the durable transaction is not on Shannon 50312");
  const functionName = ACTION_FUNCTIONS[record.action];
  if (!functionName) fail("JOURNAL_ACTION_INVALID", "the durable transaction action is not allowlisted");
  let decoded;
  try { decoded = decodeFunctionData({ abi: VILLA_ACCOUNT_OPERATOR_ABI, data: transaction.input }); } catch { fail("JOURNAL_CALLDATA_INVALID", "the durable transaction calldata is not an audited VillaAccount action"); }
  if (decoded.functionName !== functionName) fail("JOURNAL_ACTION_MISMATCH", "the durable transaction action differs from its calldata");
  const marketId = String(decoded.args?.[0] ?? "").toLowerCase();
  if (marketId !== config.marketId || String(record.marketId ?? "").toLowerCase() !== config.marketId || !sameAddress(record.account, config.account)) fail("JOURNAL_SCOPE_MISMATCH", "the durable transaction market or account differs from the bound session");
  return {
    functionName,
    marketId,
    amountRaw: decoded.args?.[functionName === "operatorPlaceOrder" ? 3 : functionName === "operatorRedeem" ? 2 : 1] === undefined
      ? null
      : String(decoded.args[functionName === "operatorPlaceOrder" ? 3 : functionName === "operatorRedeem" ? 2 : 1]),
    outcomeIdx: functionName === "operatorRedeem" ? Number(decoded.args?.[1]) : null,
    priceRaw: functionName === "operatorPlaceOrder" && decoded.args?.[2] !== undefined ? String(decoded.args[2]) : null,
    side: functionName === "operatorPlaceOrder" ? ["BUY_YES", "BUY_NO", "SELL_YES", "SELL_NO"][Number(decoded.args?.[1])] : null,
  };
}

/** Reconcile every pending/unknown record from chain truth before a session. */
export async function reconcileDurableJournal({ journalPath, publicClient, config, now = () => Date.now() } = {}) {
  const source = readJournal(journalPath);
  if (!source.payload) return { records: [], pending: 0, unknown: 0, reverted: 0, changed: false };
  const records = [];
  let changed = false;
  let unresolved = 0;
  let reverted = 0;
  for (const original of source.records) {
    const record = { ...original };
    if (!sameAddress(record.account, config.account) || String(record.marketId ?? "").toLowerCase() !== config.marketId) fail("JOURNAL_SCOPE_MISMATCH", "a durable transaction record belongs to another account or market");
    const hash = typeof record.hash === "string" && HASH_RE.test(record.hash) ? record.hash : null;
    let transaction = null;
    let receipt = null;
    if (!hash) {
      if (["PENDING", "UNKNOWN", "CONFIRMED"].includes(record.state)) unresolved += 1;
    } else {
      [transaction, receipt] = await Promise.all([
        publicClient.getTransaction({ hash }).catch(() => null),
        publicClient.getTransactionReceipt({ hash }).catch(() => null),
      ]);
      if (!transaction || !receipt) {
        if (record.state !== "REVERTED") unresolved += 1;
      } else {
        Object.assign(record, transactionFacts(record, transaction, config));
        const state = receiptState(receipt);
        if (state === "UNKNOWN") unresolved += 1;
        else if (record.state !== state || record.receiptStatus !== receipt.status || record.receiptBlock === null) {
          record.state = state;
          record.receiptStatus = receipt.status;
          record.receiptBlock = receipt.blockNumber === undefined || receipt.blockNumber === null ? null : String(receipt.blockNumber);
          record.reconciledAt = now();
          changed = true;
        }
        changed = true;
      }
    }
    if (record.state === "REVERTED") reverted += 1;
    records.push(record);
  }
  const pending = records.filter((record) => record.state === "PENDING").length;
  const unknown = unresolved;
  const halted = unknown > 0;
  if (changed || source.payload.halted !== halted) persistJournal(journalPath, { ...source.payload, halted, records });
  return { records, pending, unknown, reverted, changed: changed || source.payload.halted !== halted };
}

/**
 * Match current inventory to exactly one confirmed mint in this account and
 * market. Any untracked or mismatched inventory fails closed.
 */
export function resolveMintRecovery({ config, journal, accountState, caps = DEFAULT_PHASE_3B1_CAPS } = {}) {
  const capitalRaw = raw(accountState?.capital?.directCollateralRaw, "account capital");
  const yesRaw = raw(accountState?.inventory?.yesRaw ?? 0n, "YES inventory");
  const noRaw = raw(accountState?.inventory?.noRaw ?? 0n, "NO inventory");
  if ((journal?.pending ?? 0) > 0 || (journal?.unknown ?? 0) > 0) fail("RESTART_RECONCILIATION_REQUIRED", "an unresolved durable transaction remains");
  if ((journal?.reverted ?? 0) > 0) fail("REVERTED_TRANSACTION", "a previous bounded write reverted and requires director review");
  const records = journal?.records ?? [];
  for (const record of records) {
    if (!sameAddress(record.account, config.account) || String(record.marketId ?? "").toLowerCase() !== config.marketId) fail("JOURNAL_SCOPE_MISMATCH", "a durable transaction record belongs to another account or market");
  }
  const mintRecords = records.filter((record) => record.action === "MINT_COMPLETE_SET");
  const placeRecords = records.filter((record) => record.action === "PLACE_ORDER");
  const cancelRecords = records.filter((record) => record.action === "CANCEL_ORDER");
  const burnRecords = records.filter((record) => record.action === "BURN_COMPLETE_SET");
  const otherRecords = records.filter((record) => !["MINT_COMPLETE_SET", "PLACE_ORDER", "CANCEL_ORDER", "BURN_COMPLETE_SET"].includes(record.action));
  if (otherRecords.length > 0) fail("PRIOR_SESSION_WRITE", "a prior non-bounded write cannot be adopted automatically");
  if (mintRecords.length > 1 || placeRecords.length > 1 || cancelRecords.length > 1 || burnRecords.length > 1) fail("DUPLICATE_SESSION_WRITE", "more than one bounded action of the same type cannot be adopted automatically");
  if (mintRecords.length === 0) {
    if (records.length > 0) fail("PRIOR_SESSION_WRITE", "a prior bounded write has no confirmed mint provenance");
    if (yesRaw !== 0n || noRaw !== 0n) fail("UNEXPECTED_INVENTORY", "account inventory exists without a matching confirmed mint");
    if (capitalRaw !== 1_002_000n) fail("CAPITAL_MISMATCH", "fresh account capital is not the 1.002 tUSDC fixture");
    return Object.freeze({ mint: "REQUIRED", skipMint: false, skipPlace: false, skipCancel: false, skipBurn: false, complete: false, amountRaw: null, capitalRaw, yesRaw, noRaw, recoveredPlace: null, recoveredOrderId: null });
  }
  const mint = mintRecords[0];
  if (mint.state !== "CONFIRMED" || mint.functionName !== "operatorMintSet") fail("MINT_NOT_CONFIRMED", "the matching mint is not authoritatively confirmed");
  const amountRaw = raw(mint.amountRaw, "confirmed mint amount");
  if (amountRaw <= 0n || amountRaw > caps.MAX_MINT_AMOUNT) fail("MINT_AMOUNT_MISMATCH", "confirmed mint amount is outside the bounded policy");
  const place = placeRecords[0] ?? null;
  const cancel = cancelRecords[0] ?? null;
  const burn = burnRecords[0] ?? null;
  if (place && (place.state !== "CONFIRMED" || place.functionName !== "operatorPlaceOrder" || place.side !== "SELL_YES" || raw(place.amountRaw, "confirmed order quantity") !== amountRaw)) fail("PLACE_NOT_CONFIRMED", "the recovered order is not the exact bounded SELL_YES action");
  if (cancel && (cancel.state !== "CONFIRMED" || cancel.functionName !== "operatorCancelOrder")) fail("CANCEL_NOT_CONFIRMED", "the recovered cancellation is not authoritatively confirmed");
  if (burn && (burn.state !== "CONFIRMED" || burn.functionName !== "operatorBurnSet" || raw(burn.amountRaw, "confirmed burn amount") !== amountRaw)) fail("BURN_NOT_CONFIRMED", "the recovered burn is not the exact paired cleanup");
  if (cancel && !place) fail("RECOVERY_SEQUENCE_INVALID", "a cancellation cannot be adopted without its confirmed place action");
  if (burn && !cancel) fail("RECOVERY_SEQUENCE_INVALID", "a burn cannot be adopted before its confirmed cancellation");
  const recoveredOrderId = cancel ? raw(cancel.amountRaw, "confirmed order id") : null;
  if (place && cancel && burn && yesRaw === 0n && noRaw === 0n && capitalRaw === 1_002_000n) {
    return Object.freeze({ mint: "ALREADY_CONFIRMED", skipMint: true, skipPlace: true, skipCancel: true, skipBurn: true, complete: true, amountRaw, capitalRaw, yesRaw, noRaw, cleanupBurnAmountRaw: amountRaw, recoveredPlace: place, recoveredOrderId });
  }
  if (yesRaw !== amountRaw || noRaw !== amountRaw) fail("INVENTORY_MINT_MISMATCH", "current inventory does not exactly match the confirmed mint");
  if (capitalRaw !== 1_002_000n - amountRaw) fail("CAPITAL_MINT_MISMATCH", "current collateral does not match the confirmed mint state");
  return Object.freeze({ mint: "ALREADY_CONFIRMED", skipMint: true, skipPlace: Boolean(place), skipCancel: Boolean(cancel), skipBurn: Boolean(burn), complete: false, amountRaw, capitalRaw, yesRaw, noRaw, cleanupBurnAmountRaw: amountRaw, recoveredPlace: place, recoveredOrderId });
}
