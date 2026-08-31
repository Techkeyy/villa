/**
 * Phase 3B1A.4 bounded capital-floor calibration.
 *
 * Each shadow invocation performs fresh public reads. Every candidate balance
 * and proof path below is simulated in memory. This script has no signer,
 * private-key, wallet, owner-approval, or broadcast path.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { evaluateCapitalAtSnapshot, createProjectedEvaluator } from "../src/execution/lp-feasibility-simulation.mjs";
import { DEFAULT_PHASE_3B1_CAPS } from "../src/execution/lp-transaction-policy.mjs";
import { calibrationCandidatesRaw, compareLockedCaps, deriveCapitalEquation, LP_CAPITAL_CALIBRATION_VERSION, PHASE_3B1A4_BASELINE_CAPITAL_RAW } from "../src/execution/lp-capital-calibration.mjs";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHADOW_SCRIPT = fileURLToPath(new URL("./phase3b1a-shadow-readonly.mjs", import.meta.url));
const SNAPSHOT_COUNT = Math.max(3, Number(process.env.CALIBRATION_SNAPSHOT_COUNT ?? 3));
const MIN_HEADROOM_SEC = 120;
const jsonSafe = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, null, 2);

function withoutSignerSecrets(env) {
  const safe = { ...env };
  delete safe.OPERATOR_PRIVATE_KEY;
  delete safe.TAKER_PRIVATE_KEY;
  delete safe.PRIVATE_KEY;
  return safe;
}

async function readFreshShadow(index) {
  let result;
  try {
    result = await execFileAsync(process.execPath, [SHADOW_SCRIPT], { cwd: ROOT, env: { ...withoutSignerSecrets(process.env), MIN_MARKET_HEADROOM_SEC: "120" }, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
  const output = `${String(result.stdout ?? "").trim()}\n${String(result.stderr ?? "").trim()}`.trim();
  let parsed;
  try { parsed = JSON.parse(output); } catch { throw new Error(`fresh snapshot ${index} was not JSON: ${output.slice(-1200)}`); }
  if (parsed.result !== "PASS") throw new Error(`fresh snapshot ${index} blocked: ${parsed.reason ?? parsed.code ?? "unknown public-read failure"}`);
  const headroom = Number(parsed.risk?.authoritativeTime?.timeRemainingSec ?? parsed.market?.expirySec - parsed.riskSnapshot?.chainTime?.chainNowSec ?? 0);
  if (!Number.isFinite(headroom) || headroom < MIN_HEADROOM_SEC) throw new Error(`fresh snapshot ${index} has only ${Math.floor(headroom)}s headroom; minimum is ${MIN_HEADROOM_SEC}s`);
  return parsed;
}

function raw(value, label) {
  try { const result = typeof value === "bigint" ? value : BigInt(String(value)); if (result < 0n) throw new Error(); return result; } catch { throw new Error(`${label} must be non-negative raw units`); }
}

function union(values) {
  return [...new Set(values.filter(Boolean))];
}

function tUSDC(rawValue, decimals = 6) {
  return Number(rawValue) / 10 ** decimals;
}

function candidateSummary(candidateRows, decimals) {
  const first = candidateRows[0];
  const allBuy = candidateRows.every((row) => row.buyOnly.feasible);
  const allSell = candidateRows.every((row) => row.mintSell.feasible);
  const allStrategy = candidateRows.every((row) => row.strategyFeasible);
  const reasons = union(candidateRows.flatMap((row) => row.reasons));
  const risk = union(candidateRows.flatMap((row) => [row.risk.buy, row.risk.mintSell]));
  return {
    capital: tUSDC(first.capitalRaw, decimals).toFixed(decimals),
    capitalRaw: first.capitalRaw,
    minimumMintRaw: first.minimumMintRaw,
    postMintCollateralRaw: first.postMintCollateralRaw,
    risk: { observed: risk, buyOnly: union(candidateRows.map((row) => row.risk.buy)), mintSell: union(candidateRows.map((row) => row.risk.mintSell)) },
    bidFeasible: `${candidateRows.filter((row) => row.buyOnly.feasible).length}/${candidateRows.length}`,
    askFeasible: `${candidateRows.filter((row) => row.mintSell.feasible).length}/${candidateRows.length}`,
    quote: { buyOnly: allBuy ? "BUY_ONLY" : "NO_BUY_ONLY", mintSell: allSell ? "MINT+SELL" : "NO_MINT+SELL" },
    notional: { buyOnlyRaw: first.buyOnly.quantityRaw, mintSellRaw: first.mintSell.quantityRaw },
    pendingExposureRaw: first.pendingExposureRaw,
    caps: {
      currentCapital: first.currentCapitalPass ? "PASS" : "FAIL: MAX_ACCOUNT_CAPITAL",
      nonCapital: allStrategy ? "PASS" : "FAIL",
      currentPolicy: first.currentCapsPass && allStrategy ? "PASS" : "FAIL",
      proposedReplacement: allStrategy ? "PASS" : "FAIL",
    },
    pathReasons: { buyOnly: union(candidateRows.flatMap((row) => row.buyOnly.reasons)), mintSell: union(candidateRows.flatMap((row) => row.mintSell.reasons)) },
    reason: reasons,
  };
}

let snapshots;
try {
  // Start the independent public reads together so a 120-second market is
  // not lost merely because three sequential probes consumed its headroom.
  snapshots = await Promise.all(Array.from({ length: SNAPSHOT_COUNT }, (_value, index) => readFreshShadow(index + 1)));
} catch (error) {
  console.log(jsonSafe({ result: "BLOCKED", stage: "FRESH_MULTI_SNAPSHOT_READ", code: "LIVE_PUBLIC_READ_UNAVAILABLE", reason: error.message, noWrites: true, signerInstalled: false }));
  process.exit(2);
}

const first = snapshots[0];
const decimals = Number(first.market?.decimals ?? first.riskSnapshot?.market?.decimals ?? 6);
const account = first.account;
const owner = first.owner;
const operator = first.operator;
const accountMaxOrderQuantityRaw = raw(first.accountLimits.maxOrderQuantityRaw, "VillaAccount maxOrderQuantity");
const accountMaxOrderCollateralRaw = raw(first.accountLimits.maxOrderCollateralRaw, "VillaAccount maxOrderCollateral");
const minimumMintRaw = raw(first.market.minimumOrderRaw ?? first.market.grid.minQuantityRaw, "venue minimum mint");
const yesRaw = raw(first.inventory.yesRaw ?? first.inventory.yes, "YES inventory");
const noRaw = raw(first.inventory.noRaw ?? first.inventory.no, "NO inventory");
const candidateInputs = calibrationCandidatesRaw({ decimals, values: ["1.000", "1.001", "1.002", "1.005", "1.010", "1.025", "1.050", "1.100", "1.250"] });
const snapshotResults = snapshots.map((shadow, index) => {
  const market = shadow.market;
  const evaluator = createProjectedEvaluator({ shadow, market, decimals, account, owner, operator, accountMaxOrderQuantityRaw, accountMaxOrderCollateralRaw, caps: DEFAULT_PHASE_3B1_CAPS });
  const capitalRaw = raw(shadow.capital.collateralAvailableRaw, "live collateral");
  const snapshotYesRaw = raw(shadow.inventory.yesRaw ?? shadow.inventory.yes, "YES inventory");
  const snapshotNoRaw = raw(shadow.inventory.noRaw ?? shadow.inventory.no, "NO inventory");
  const rows = candidateInputs.map((candidate) => evaluateCapitalAtSnapshot({ evaluator, collateralRaw: candidate.raw, yesRaw: snapshotYesRaw, noRaw: snapshotNoRaw, minimumMintRaw, currentCapitalCapRaw: PHASE_3B1A4_BASELINE_CAPITAL_RAW, recommendedCapitalRaw: null }));
  return { index: index + 1, marketId: market.marketId, headroomSec: Number(shadow.risk?.authoritativeTime?.timeRemainingSec ?? 0), liveCapitalRaw: capitalRaw, yesRaw: snapshotYesRaw, noRaw: snapshotNoRaw, rows, evaluator };
});

const rowsByIndex = candidateInputs.map((_candidate, index) => snapshotResults.map((snapshot) => snapshot.rows[index]));
const summaries = candidateInputs.map((candidate, index) => ({ candidate: candidate.tUSDC, ...candidateSummary(rowsByIndex[index], decimals) }));
const bEquations = snapshotResults.map((snapshot) => {
  const firstViable = snapshot.rows.find((row) => row.mintSell.feasible) ?? snapshot.rows[1];
  return firstViable.equation.paths.mintSell;
});
const mathFloorRaw = bEquations.reduce((max, equation) => equation.requiredCapitalRaw > max ? equation.requiredCapitalRaw : max, 0n);
const mathFloor = tUSDC(mathFloorRaw, decimals);
// Exact equality proves the mathematical boundary. The recommendation uses
// the first explicitly sampled value above that boundary so one raw-unit
// reserve comparison cannot become an operational edge.
const firstRobustB = summaries.find((summary, index) => summary.capitalRaw > mathFloorRaw && rowsByIndex[index].every((row) => row.mintSell.feasible))
  ?? summaries.find((summary, index) => summary.capitalRaw === mathFloorRaw && rowsByIndex[index].every((row) => row.mintSell.feasible));
const firstRobustA = summaries.find((summary, index) => summary.capitalRaw > mathFloorRaw && rowsByIndex[index].every((row) => row.buyOnly.feasible))
  ?? summaries.find((summary, index) => summary.capitalRaw === mathFloorRaw && rowsByIndex[index].every((row) => row.buyOnly.feasible));
const preferred = firstRobustA ? { path: "A", summary: firstRobustA, reason: "BUY-only is feasible across every fresh snapshot and avoids mint/burn mutation" } : firstRobustB ? { path: "B", summary: firstRobustB, reason: "BUY-only is not feasible under the deployed VillaAccount order limits; minimal mint then SELL is the first robust bounded path" } : { path: null, summary: null, reason: "no robust bounded path was feasible across the fresh snapshots" };
const recommendedRaw = preferred.summary?.capitalRaw ?? null;
const safetyMarginRaw = recommendedRaw === null ? null : recommendedRaw - mathFloorRaw;
const lockedCaps = compareLockedCaps(DEFAULT_PHASE_3B1_CAPS);
const outputSummaries = summaries.map((summary, index) => ({ ...summary, recommended: recommendedRaw !== null && summary.capitalRaw >= recommendedRaw, rowsObserved: rowsByIndex[index].length }));

console.log(jsonSafe({
  result: preferred.path ? "PASS" : "BLOCKED",
  version: LP_CAPITAL_CALIBRATION_VERSION,
  phase: "3B1A.4",
  noWrites: true,
  signerInstalled: false,
  liveAccount: { account, owner, operator, collateralRaw: first.capital.collateralAvailableRaw, dreamDexVaultCreditRaw: first.capital.dreamDexVaultCreditRaw ?? null, yesRaw: first.inventory.yesRaw, noRaw: first.inventory.noRaw, accountMaxOrderQuantityRaw, accountMaxOrderCollateralRaw },
  snapshots: snapshotResults.map((snapshot) => ({ index: snapshot.index, marketId: snapshot.marketId, headroomSec: snapshot.headroomSec, liveCapitalRaw: snapshot.liveCapitalRaw })),
  equation: { pathA: "reserve + DreamDEX-held collateral + BUY order escrow + safety margin", pathB: "reserve + DreamDEX-held collateral + required complete-set mint + safety margin", reserveRaw: 1_000_000n, dreamDexReservedCollateralRaw: snapshotResults[0].evaluator.dreamDexReservedCollateralRaw, dreamDexVaultCreditRaw: first.capital.dreamDexVaultCreditRaw ?? null, vaultTreatment: "vault credit is reported but not counted as direct working capital because this bounded path contains no withdrawal", rounding: "all raw arithmetic is integer; BUY escrow uses ceil(price * quantity / 1e6); MINT+SELL has no order escrow", inventory: { currentYesRaw: yesRaw, requiredMintRaw: minimumMintRaw }, mathematicalMinimumRaw: mathFloorRaw, mathematicalMinimumTUSDC: mathFloor, pathBPerSnapshot: bEquations.map((equation) => ({ requiredCapitalRaw: equation.requiredCapitalRaw, requiredCapitalTUSDC: equation.requiredCapital, components: equation.components })) },
  candidates: outputSummaries,
  preferredProofPath: preferred,
  recommendation: { currentCapTUSDC: tUSDC(PHASE_3B1A4_BASELINE_CAPITAL_RAW, decimals), activatedPhase3B1CapTUSDC: tUSDC(DEFAULT_PHASE_3B1_CAPS.MAX_ACCOUNT_CAPITAL, decimals), mathematicalMinimumTUSDC: mathFloor, recommendedPhase3B1BCapTUSDC: recommendedRaw === null ? null : tUSDC(recommendedRaw, decimals), recommendedRaw, safetyMarginTUSDC: safetyMarginRaw === null ? null : tUSDC(safetyMarginRaw, decimals), additionalOwnerDepositTUSDC: recommendedRaw === null ? null : tUSDC(recommendedRaw - raw(first.capital.collateralAvailableRaw, "live collateral"), decimals), minimumStrategyCapitalTUSDC: mathFloor, proposedReplacement: "docs/PHASE_3B1A_4_CAPITAL_CALIBRATION.md" },
  lockedCaps: { pass: lockedCaps.pass, differences: lockedCaps.differences, values: lockedCaps.values },
  proof: { currentCapChanged: false, liveAccountMutated: false, ownerRequestsEmitted: false, marketApprovalsPrepared: false, marketApprovalsSent: false, transactionCount: 0, blockchainWrites: 0 },
}));
