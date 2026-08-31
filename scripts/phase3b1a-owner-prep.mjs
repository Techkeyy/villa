/**
 * Local-only Phase 3B1A owner preparation.
 *
 * The command composes a fresh public shadow read with unsigned owner wallet
 * requests. It never loads .env, private keys, a wallet client, or a writer.
 * Run it again after a human wallet review to re-read the chain from scratch.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, http } from "viem";
import { VILLA_ACCOUNT_CONFIG } from "../dashboard/account-config.mjs";
import { DEFAULT_RISK_CONFIG } from "../src/risk-governor/config.mjs";
import {
  buildOwnerMarketPreparation,
  calculateGasReserve,
  PHASE_3B1_GAS_LIMIT_PER_TX,
  PHASE_3B1_GAS_MARGIN_BPS,
  PHASE_3B1_GAS_TX_COUNT,
} from "../src/execution/lp-owner-prep.mjs";

const execFileAsync = promisify(execFile);
const RPC_URL = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const ACCOUNT = "0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2";
const OWNER = "0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d";
const OPERATOR = VILLA_ACCOUNT_CONFIG.operator;
const SHADOW_SCRIPT = fileURLToPath(new URL("./phase3b1a-shadow-readonly.mjs", import.meta.url));
const publicClient = createPublicClient({ chain: somniaShannon, transport: http(RPC_URL, { timeout: 15_000 }) });
const jsonSafe = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, null, 2);

function withoutSignerSecrets(env) {
  const safe = { ...env };
  delete safe.OPERATOR_PRIVATE_KEY;
  delete safe.TAKER_PRIVATE_KEY;
  delete safe.PRIVATE_KEY;
  return safe;
}

async function readFreshShadow() {
  let result;
  try {
    result = await execFileAsync(process.execPath, [SHADOW_SCRIPT], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...withoutSignerSecrets(process.env), RPC_URL },
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
  const output = `${String(result.stdout ?? "").trim()}\n${String(result.stderr ?? "").trim()}`.trim();
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`shadow output was not JSON: ${output.slice(-1000)}`);
  }
}

const snapshot = await readFreshShadow();
if (snapshot.result !== "PASS") {
  console.log(jsonSafe({
    result: "BLOCKED",
    stage: "FRESH_MARKET_DISCOVERY",
    reason: snapshot.reason ?? "fresh shadow did not produce an eligible market",
    chainNowSec: snapshot.chainNowSec ?? null,
    blockNumber: snapshot.blockNumber ?? null,
    candidates: snapshot.candidates ?? [],
    rejected: snapshot.rejected ?? [],
    safety: { privateKeyRead: false, autoSign: false, autoBroadcast: false, executionEnabled: false },
  }));
  process.exit(2);
}

const gasBalanceWei = await publicClient.getBalance({ address: OPERATOR });
const gasPriceWei = await publicClient.getGasPrice();
const minimumGasReserveWei = BigInt(Math.round(DEFAULT_RISK_CONFIG.minGasReserve * 1e18));
const gas = calculateGasReserve({
  currentBalanceWei: gasBalanceWei,
  gasPriceWei,
  minReserveWei: minimumGasReserveWei,
  gasLimitPerTx: PHASE_3B1_GAS_LIMIT_PER_TX,
  txCount: PHASE_3B1_GAS_TX_COUNT,
  marginBps: PHASE_3B1_GAS_MARGIN_BPS,
});

const preparation = buildOwnerMarketPreparation({
  account: ACCOUNT,
  owner: OWNER,
  operator: OPERATOR,
  chainId: snapshot.chainId,
  market: snapshot.market,
  chainNowSec: snapshot.risk.authoritativeTime.chainNowSec,
  permissions: snapshot.permissions,
  quotePlan: snapshot.quotePlan,
  quoteExecution: snapshot.quoteExecution,
});

console.log(jsonSafe({
  result: preparation.status === "READY" ? "READY_FOR_HUMAN_REVIEW" : "BLOCKED",
  version: preparation.version,
  account: ACCOUNT,
  owner: OWNER,
  operator: OPERATOR,
  chainId: snapshot.chainId,
  freshShadow: {
    marketId: snapshot.market.marketId,
    expirySec: snapshot.market.expirySec,
    headroomSec: snapshot.risk.authoritativeTime.timeRemainingSec,
    quotePlan: snapshot.quotePlan.plan,
    riskState: snapshot.risk.state,
    riskReasons: snapshot.risk.triggeredRules,
  },
  permissions: preparation.permissions,
  protocolApproval: preparation.protocolApproval,
  gasReserve: {
    currentSTT: Number(gas.currentBalanceWei) / 1e18,
    minimumSTT: Number(gas.minimumReserveWei) / 1e18,
    recommendedSTT: Number(gas.recommendedReserveWei) / 1e18,
    shortfallSTT: Number(gas.shortfallWei) / 1e18,
    gasPriceWei: gas.gasPriceWei,
    gasLimitPerTx: gas.gasLimitPerTx,
    txCount: gas.txCount,
    marginBps: PHASE_3B1_GAS_MARGIN_BPS,
  },
  blockers: preparation.blockers,
  quote: preparation.quote,
  ownerTransactionReview: preparation.requests.map((request) => ({
    account: request.to,
    owner: request.from,
    marketId: request.marketId,
    expirySec: preparation.market.expirySec,
    headroomSec: preparation.market.headroomSec,
    action: request.operation,
    targetContract: request.to,
    method: request.functionName,
    selector: request.selector,
    amountOrApproval: request.functionName === "setMarketApproval" ? "approved=true" : "internal approvals: derived pool=true, binary module=true",
    why: request.why,
    data: request.data,
    sign: request.sign,
    broadcast: request.broadcast,
  })),
  requests: preparation.requests,
  safety: {
    privateKeyRead: false,
    autoSign: false,
    autoBroadcast: false,
    executionEnabled: false,
    rerunAfterHumanApproval: "node scripts/phase3b1a-owner-prep.mjs",
  },
}));
