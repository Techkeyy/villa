/**
 * Localhost-only Phase 3B1.1 owner preparation wizard.
 *
 * It performs public reads and serves a tiny local UI. The browser wallet is
 * the only signing boundary. This process never loads signer material and
 * never calls a writer itself.
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPublicClient, http as viemHttp } from "viem";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { VILLA_ACCOUNT_CONFIG } from "../dashboard/account-config.mjs";
import { buildOwnerMarketPreparation, VILLA_ACCOUNT_OWNER_PREP_ABI } from "../src/execution/lp-owner-prep.mjs";
import { VILLA_ACCOUNT_MARKET_ABI, VILLA_ACCOUNT_READ_ABI } from "../src/execution/lp-adapter.mjs";
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
  OWNER_WIZARD_OPERATOR,
  OWNER_WIZARD_OWNER,
  OWNER_WIZARD_TX1_HEADROOM_SEC,
  buildExactOwnerAction,
  evaluateOwnerWizardSnapshot,
  finalOwnerHandoffBlockers,
  isInvalidatedOwnerMarket,
  validateHumanOwnerTransaction,
  validateOwnerWalletContext,
} from "../src/execution/lp-owner-wizard.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "phase3b1b1-owner-prep-wizard.html");
const CLIENT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "phase3b1b1-owner-prep-wizard-client.mjs");
const WALLET_DISCOVERY_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "lib", "owner-wallet-discovery.mjs");
const RPC_URL = process.env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl || "https://dream-rpc.somnia.network";
const INDEXER_URL = process.env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = process.env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws";
const MARKET_INTERVAL_SEC = Number(process.argv.find((arg) => arg.startsWith("--interval="))?.slice("--interval=".length) || process.env.MARKET_INTERVAL_SEC || 300);
if (MARKET_INTERVAL_SEC !== 300 && MARKET_INTERVAL_SEC !== 900 && MARKET_INTERVAL_SEC !== 3600) throw new Error("owner-prep supports only BTC 5m, BTC 15m, or BTC 1h");
const IS_15M = MARKET_INTERVAL_SEC === 900;
const IS_1H = MARKET_INTERVAL_SEC === 3600;
const MARKET_SERIES = IS_1H ? OWNER_WIZARD_1H_SERIES : IS_15M ? OWNER_WIZARD_15M_SERIES : "BINARY:BTC:300";
const MARKET_LABEL = IS_1H ? "BTC 1-hour" : IS_15M ? "BTC 15-minute" : "BTC 5-minute";
const INITIAL_HEADROOM_SEC = IS_1H ? OWNER_WIZARD_1H_INITIAL_HEADROOM_SEC : IS_15M ? OWNER_WIZARD_15M_INITIAL_HEADROOM_SEC : OWNER_WIZARD_INITIAL_HEADROOM_SEC;
const ACTION2_HEADROOM_SEC = IS_1H ? OWNER_WIZARD_1H_TX1_HEADROOM_SEC : IS_15M ? OWNER_WIZARD_15M_TX1_HEADROOM_SEC : OWNER_WIZARD_TX1_HEADROOM_SEC;
const FINAL_PREFLIGHT_HEADROOM_SEC = IS_1H ? OWNER_WIZARD_1H_FINAL_PREFLIGHT_HEADROOM_SEC : IS_15M ? OWNER_WIZARD_15M_FINAL_PREFLIGHT_HEADROOM_SEC : OWNER_WIZARD_FINAL_HEADROOM_SEC;
const FINAL_HANDOFF_HEADROOM_SEC = IS_1H ? OWNER_WIZARD_1H_FINAL_HANDOFF_HEADROOM_SEC : IS_15M ? OWNER_WIZARD_15M_FINAL_HANDOFF_HEADROOM_SEC : OWNER_WIZARD_FINAL_HEADROOM_SEC;
const PORT = Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) || process.env.PORT || 4191);
const HOST = "127.0.0.1";
const publicClient = createPublicClient({ chain: somniaShannon, transport: viemHttp(RPC_URL, { timeout: 15_000 }) });
const jsonSafe = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);

const STAGES = Object.freeze({ WAITING: "WAITING_FOR_MARKET", REVIEW: "REVIEW", TX1_PENDING: "APPROVAL_CONFIRMING", ACTION2: "PREPARE_REVIEW", TX2_PENDING: "PREPARE_CONFIRMING", COMPLETE: "FINAL_PREFLIGHT", BLOCKED: "BLOCKED" });
const session = {
  stage: STAGES.WAITING,
  selectedMarketId: null,
  review: null,
  tx1Hash: null,
  tx1HeadroomSec: null,
  tx2Hash: null,
  tx2HeadroomSec: null,
  final: null,
  message: "Connect the authorized Rabby wallet on Somnia Shannon before fresh-market discovery.",
  lastReadAt: 0,
  readPromise: null,
  pending: null,
  walletConnected: false,
  walletAddress: null,
  walletChainId: null,
  walletGeneration: 0,
};

function safeEnv(minimumHeadroomSec) {
  return {
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    RPC_URL,
    INDEXER_URL,
    WS_RPC_URL,
    MIN_MARKET_HEADROOM_SEC: String(minimumHeadroomSec),
    MARKET_INTERVAL_SEC: String(MARKET_INTERVAL_SEC),
    MARKET_SERIES,
  };
}

function parseChildJson(stdout, stderr) {
  const text = String(stdout ?? "").trim();
  try { return JSON.parse(text); } catch {
    return { result: "BLOCKED", reason: `read-only feasibility output was not JSON: ${String(stderr ?? "").trim().slice(-500) || text.slice(-500)}` };
  }
}

async function readFeasibility(minimumHeadroomSec) {
  let result;
  try {
    result = await execFileAsync(process.execPath, [path.join(ROOT, "scripts", "phase3b1a-feasibility-readonly.mjs")], {
      cwd: ROOT,
      env: safeEnv(minimumHeadroomSec),
      maxBuffer: 12 * 1024 * 1024,
    });
  } catch (error) {
    result = { stdout: error.stdout ?? "", stderr: error.stderr ?? error.message ?? "" };
  }
  return parseChildJson(result.stdout, result.stderr);
}

function projectionFor(feasibility) {
  const path = feasibility?.recommendation?.path === "A" ? "A" : "B";
  const projected = path === "A" ? feasibility?.buyWithoutMint : feasibility?.sellAfterMint;
  return projected ? {
    valid: projected.viable === true,
    path,
    quotePlan: projected.quotePlan,
    quoteExecution: projected.quoteExecution,
    minimumMintRaw: path === "A" ? "0" : projected.mintAmountRaw,
    recommendedPath: feasibility?.recommendation?.path ?? null,
    reasons: projected.reasons ?? [],
  } : { valid: false, path, quotePlan: null, quoteExecution: { postOnly: true, orderType: 3, policyValid: false }, minimumMintRaw: null, recommendedPath: null, reasons: ["NO_PROJECTED_SEQUENCE"] };
}

function ownerPreparation(feasibility) {
  const snapshot = feasibility?.shadow;
  if (!snapshot) return { status: "BLOCKED", blockers: [{ code: "FRESH_READ_FAILED", reason: feasibility?.reason ?? "no shadow snapshot" }], request: null, preparation: null };
  const preparation = buildOwnerMarketPreparation({
    account: OWNER_WIZARD_ACCOUNT,
    owner: OWNER_WIZARD_OWNER,
    operator: OWNER_WIZARD_OPERATOR,
    chainId: snapshot.chainId,
    market: snapshot.market,
    chainNowSec: snapshot.risk?.authoritativeTime?.chainNowSec,
    permissions: snapshot.permissions,
    quotePlan: snapshot.quotePlan,
    quoteExecution: snapshot.quoteExecution,
    projectedSequence: projectionFor(feasibility),
    marketSeries: MARKET_SERIES,
    minimumHeadroomSec: INITIAL_HEADROOM_SEC,
  });
  return { status: preparation.status, blockers: preparation.blockers, request: preparation.requests[0] ?? null, preparation };
}

function publicReview(feasibility, evaluated, prep) {
  const side = evaluated.projectedPath === "A" ? evaluated.projected?.quotePlan?.bid ?? {} : evaluated.projected?.quotePlan?.ask ?? {};
  const projection = projectionFor(feasibility);
  return {
    marketId: evaluated.marketId,
    expirySec: evaluated.expirySec,
    chainNowSec: evaluated.chainNowSec,
    headroomSec: evaluated.headroomSec,
    intervalSec: MARKET_INTERVAL_SEC,
    intervalLabel: MARKET_LABEL,
    spot: feasibility?.shadow?.riskSnapshot?.feed?.price ?? null,
    strike: feasibility?.shadow?.market?.strike ?? null,
    fairValue: feasibility?.shadow?.riskSnapshot?.fairValue?.pUp ?? null,
    confidence: feasibility?.shadow?.riskSnapshot?.fairValue?.confidence ?? null,
    quote: { action: side.action ?? null, priceRaw: evaluated.quotePriceRaw, quantityRaw: evaluated.quoteQuantityRaw },
    plannedPath: projection.recommendedPath,
    plannedMintRaw: projection.minimumMintRaw,
    capitalRaw: OWNER_WIZARD_CAPITAL_RAW,
    owner: OWNER_WIZARD_OWNER,
    account: OWNER_WIZARD_ACCOUNT,
    operator: OWNER_WIZARD_OPERATOR,
    execution: "DISABLED",
    action: prep.request ? {
      operation: prep.request.functionName === "setMarketApproval" ? "MARKET_APPROVAL" : "PROTOCOL_APPROVAL",
      functionName: prep.request.functionName,
      selector: prep.request.selector,
      data: prep.request.data,
      to: prep.request.to,
      from: prep.request.from,
      marketId: evaluated.marketId,
      value: "0x0",
    } : null,
    blockers: evaluated.blockers,
  };
}

function snapshotState(extra = {}) {
  return {
    ok: true,
    version: "villa-lp-owner-wizard-v1",
    localhostOnly: true,
    stage: session.stage,
    message: session.message,
    selectedMarketId: session.selectedMarketId,
    review: session.review,
    tx1Hash: session.tx1Hash,
    tx1HeadroomSec: session.tx1HeadroomSec,
    tx2Hash: session.tx2Hash,
    tx2HeadroomSec: session.tx2HeadroomSec,
    final: session.final,
    walletContext: { connected: session.walletConnected, address: session.walletAddress, chainId: session.walletChainId },
    safety: { chainId: OWNER_WIZARD_CHAIN_ID, executionEnabled: false, signerRead: false, autoSign: false, autoBroadcast: false, allowedOwnerCalls: ["setMarketApproval", "prepareMarket"] },
    ...extra,
  };
}

function invalidateWalletPreparation() {
  session.walletGeneration += 1;
  session.walletConnected = false;
  session.walletAddress = null;
  session.walletChainId = null;
  session.selectedMarketId = null;
  session.review = null;
  session.pending = null;
  session.lastReadAt = 0;
  if (session.stage !== STAGES.COMPLETE) {
    session.stage = STAGES.WAITING;
    session.final = null;
    session.message = "Wallet context changed. Reconnect the authorized Rabby wallet before fresh-market discovery.";
  }
}

function markWalletConnected(body) {
  const account = String(body?.address ?? "");
  const chainId = body?.chainId;
  const validation = validateOwnerWalletContext({ account, chainId });
  if (!validation.valid) {
    invalidateWalletPreparation();
    throw new Error(validation.reason);
  }
  session.walletConnected = true;
  session.walletAddress = OWNER_WIZARD_OWNER;
  session.walletChainId = OWNER_WIZARD_CHAIN_ID;
  session.lastReadAt = 0;
  session.message = `Authorized owner wallet connected. Looking for a fresh ${MARKET_LABEL} market.`;
  return snapshotState();
}

function selectReview(feasibility, minimumHeadroomSec, expectedMarketId = null, requirements = {}) {
  const evaluated = evaluateOwnerWizardSnapshot({ feasibility, minimumHeadroomSec, expectedMarketId, expectedSeries: MARKET_SERIES, projectedPath: feasibility?.recommendation?.path === "A" ? "A" : "B", requireMarketApproved: requirements.requireMarketApproved ?? null, requireProtocolPrepared: requirements.requireProtocolPrepared ?? null });
  const prep = ownerPreparation(feasibility);
  const blockers = [...evaluated.blockers];
  if (prep.status !== "READY") blockers.push(...prep.blockers.map((item) => ({ code: item.code, reason: item.reason })));
  const unique = [...new Map(blockers.map((item) => [item.code, item])).values()];
  return { evaluated, prep, valid: unique.length === 0, blockers: unique };
}

async function refreshWaiting() {
  const feasibility = await readFeasibility(INITIAL_HEADROOM_SEC);
  if (!session.walletConnected) return snapshotState({ blockers: [{ code: "WALLET_NOT_CONNECTED", reason: "Connect Rabby on Shannon before discovery." }] });
  const evaluated = evaluateOwnerWizardSnapshot({ feasibility, minimumHeadroomSec: INITIAL_HEADROOM_SEC, expectedSeries: MARKET_SERIES, projectedPath: feasibility?.recommendation?.path === "A" ? "A" : "B", requireMarketApproved: false, requireProtocolPrepared: false });
  if (!evaluated.valid) {
    session.review = null;
    session.selectedMarketId = null;
    session.message = evaluated.blockers.some((item) => item.code === "HEADROOM_INSUFFICIENT")
      ? `No ${MARKET_LABEL} market has the required ${INITIAL_HEADROOM_SEC}-second review window yet. Still watching.`
      : `Waiting for a fresh ${MARKET_LABEL} market that passes every read-only safety gate.`;
    return snapshotState({ blockers: evaluated.blockers });
  }
  const prep = ownerPreparation(feasibility);
  if (!prep.request || prep.request.functionName !== "setMarketApproval" || !prep.preparation?.status || prep.preparation.status !== "READY") {
    session.message = "A fresh market was found, but the exact owner approval gate is not ready.";
    return snapshotState({ blockers: [...evaluated.blockers, ...(prep.blockers ?? [])] });
  }
  session.stage = STAGES.REVIEW;
  session.selectedMarketId = evaluated.marketId;
  session.review = publicReview(feasibility, evaluated, prep);
  session.message = "Review the live facts, then approve this exact market in Rabby.";
  return snapshotState();
}

async function refreshAction2() {
  const feasibility = await readFeasibility(ACTION2_HEADROOM_SEC);
  const evaluated = evaluateOwnerWizardSnapshot({ feasibility, minimumHeadroomSec: ACTION2_HEADROOM_SEC, expectedSeries: MARKET_SERIES, projectedPath: feasibility?.recommendation?.path === "A" ? "A" : "B", expectedMarketId: session.selectedMarketId, requireMarketApproved: true, requireProtocolPrepared: false });
  const prep = ownerPreparation(feasibility);
  const blockers = [...evaluated.blockers];
  if (prep.status !== "READY" || prep.request?.functionName !== "prepareMarket") blockers.push(...(prep.blockers ?? []));
  const unique = [...new Map(blockers.map((item) => [item.code, item])).values()];
  if (unique.length) {
    session.stage = STAGES.BLOCKED;
    session.message = "Action 2 is withheld because the approved market no longer passes its live safety gate.";
    session.final = { blockers: unique, stopBoundary: true };
    return snapshotState({ blockers: unique });
  }
  session.stage = STAGES.ACTION2;
  session.review = publicReview(feasibility, evaluated, prep);
  session.message = "Action 1 is confirmed. Review the exact protocol-preparation call, then use Rabby.";
  return snapshotState();
}

async function latestForExpected(minimumHeadroomSec, requirements = {}) {
  const feasibility = await readFeasibility(minimumHeadroomSec);
  const review = selectReview(feasibility, minimumHeadroomSec, session.selectedMarketId, requirements);
  return { feasibility, ...review };
}

async function cachedState() {
  const now = Date.now();
  if (session.readPromise) return session.readPromise;
  if (!session.walletConnected) {
    return snapshotState({ blockers: [{ code: "WALLET_NOT_CONNECTED", reason: "Connect Rabby on Shannon before discovery." }] });
  }
  if (now - session.lastReadAt < 3_000 && session.review) return snapshotState();
  session.readPromise = (async () => {
    try {
      session.lastReadAt = Date.now();
      if (session.stage === STAGES.WAITING) return await refreshWaiting();
      if (session.stage === STAGES.REVIEW) {
          const latest = await latestForExpected(INITIAL_HEADROOM_SEC, { requireMarketApproved: false, requireProtocolPrepared: false });
        if (!latest.valid) {
          session.stage = STAGES.WAITING;
          session.selectedMarketId = null;
          session.review = null;
          session.message = `The reviewed market changed or lost its ${INITIAL_HEADROOM_SEC}-second window. Looking for a new market.`;
          return snapshotState({ blockers: latest.blockers });
        }
        session.review = publicReview(latest.feasibility, latest.evaluated, latest.prep);
      }
      return snapshotState();
    } catch (error) {
      session.message = "The read-only live check failed. No owner action is available until it recovers.";
      return snapshotState({ blockers: [{ code: error?.code ?? "READ_FAILED", reason: error?.message ?? String(error) }] });
    } finally {
      session.readPromise = null;
    }
  })();
  return session.readPromise;
}

function hash(value) {
  return /^0x[0-9a-f]{64}$/i.test(String(value ?? "")) ? String(value).toLowerCase() : null;
}

async function verifyOwnerReceipt(txHash, action, marketId) {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  const transaction = await publicClient.getTransaction({ hash: txHash });
  const expectedAction = buildExactOwnerAction({ action, marketId });
  const transactionCheck = validateHumanOwnerTransaction({ action, transaction: { ...transaction, value: transaction.value?.toString?.() ?? transaction.value, data: transaction.input }, marketId });
  if (String(receipt.status).toLowerCase() !== "success" || !transactionCheck.valid) throw new Error("confirmed receipt did not match the exact reviewed owner call");
  return { receipt, transaction };
}

async function readProtocolState(marketId) {
  const marketDetailsPromise = publicClient.readContract({ address: OWNER_WIZARD_ACCOUNT, abi: VILLA_ACCOUNT_MARKET_ABI, functionName: "markets", args: [marketId] });
  const [marketApproved, operator, moduleOperator, marketDetails] = await Promise.all([
    publicClient.readContract({ address: OWNER_WIZARD_ACCOUNT, abi: VILLA_ACCOUNT_READ_ABI, functionName: "approvedMarkets", args: [marketId] }),
    publicClient.readContract({ address: OWNER_WIZARD_ACCOUNT, abi: VILLA_ACCOUNT_READ_ABI, functionName: "operator" }),
    publicClient.readContract({ address: VILLA_ACCOUNT_CONFIG.outcomeToken, abi: [{ type: "function", name: "isOperator", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "bool" }] }], functionName: "isOperator", args: [OWNER_WIZARD_ACCOUNT, VILLA_ACCOUNT_CONFIG.binaryModule] }),
    marketDetailsPromise,
  ]);
  const poolAddress = String(marketDetails?.pool ?? marketDetails?.[9] ?? "");
  const poolOperator = await publicClient.readContract({ address: VILLA_ACCOUNT_CONFIG.outcomeToken, abi: [{ type: "function", name: "isOperator", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "bool" }] }], functionName: "isOperator", args: [OWNER_WIZARD_ACCOUNT, poolAddress] });
  const collateralRaw = await publicClient.readContract({ address: VILLA_ACCOUNT_CONFIG.collateralToken, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [OWNER_WIZARD_ACCOUNT] });
  return { marketApproved: Boolean(marketApproved), operator: String(operator).toLowerCase(), moduleOperator: Boolean(moduleOperator), poolOperator: Boolean(poolOperator), collateralRaw: collateralRaw.toString() };
}

async function waitForReceipt(txHash, action, marketId) {
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    try { return await verifyOwnerReceipt(txHash, action, marketId); } catch (error) {
      if (/did not match|rejected|reverted/i.test(String(error?.message))) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("owner transaction receipt was not confirmed within the local wait window");
}

async function handlePrepareAction(action) {
  if (!session.walletConnected) throw new Error("authorized Rabby wallet on Shannon is required before an owner action");
  const walletGeneration = session.walletGeneration;
  if (action === "MARKET_APPROVAL" && session.stage !== STAGES.REVIEW) throw new Error("market approval is not available in the current wizard stage");
  if (action === "PROTOCOL_APPROVAL" && session.stage !== STAGES.ACTION2) throw new Error("protocol preparation is not available in the current wizard stage");
  const minimumHeadroomSec = action === "MARKET_APPROVAL" ? INITIAL_HEADROOM_SEC : ACTION2_HEADROOM_SEC;
  const latest = await latestForExpected(minimumHeadroomSec, action === "MARKET_APPROVAL"
    ? { requireMarketApproved: false, requireProtocolPrepared: false }
    : { requireMarketApproved: true, requireProtocolPrepared: false });
  if (!session.walletConnected || session.walletGeneration !== walletGeneration) throw new Error("wallet context changed; reconnect before preparing an owner action");
  if (!latest.valid) throw new Error(latest.blockers.map((item) => item.code).join(", "));
  const expectedFunction = action === "MARKET_APPROVAL" ? "setMarketApproval" : "prepareMarket";
  if (latest.prep.request?.functionName !== expectedFunction) throw new Error("the exact owner action is no longer the next permitted action");
  const request = buildExactOwnerAction({ action, marketId: session.selectedMarketId });
  session.pending = { action, marketId: session.selectedMarketId, request, createdAt: Date.now() };
  session.stage = action === "MARKET_APPROVAL" ? STAGES.TX1_PENDING : STAGES.TX2_PENDING;
  session.message = "Waiting for the owner wallet request and confirmed receipt.";
  return snapshotState({ walletTransaction: request });
}

async function handleReceipt(action, body) {
  const txHash = hash(body?.txHash);
  if (!txHash || !session.pending || session.pending.action !== action || session.pending.marketId !== session.selectedMarketId) throw new Error("receipt is not tied to the current reviewed action");
  const pending = session.pending;
  session.pending = null;
  if (action === "MARKET_APPROVAL") {
    const result = await waitForReceipt(txHash, action, pending.marketId);
    const state = await readProtocolState(pending.marketId);
    if (!state.marketApproved) throw new Error("market approval receipt confirmed but approvedMarkets is still false");
    session.tx1Hash = txHash;
    session.tx1HeadroomSec = (await latestForExpected(ACTION2_HEADROOM_SEC, { requireMarketApproved: true, requireProtocolPrepared: false })).evaluated.headroomSec;
    session.stage = STAGES.TX1_PENDING;
    const action2 = await refreshAction2();
    return snapshotState({ receipt: { status: "success", txHash, blockNumber: result.receipt.blockNumber?.toString?.() ?? null }, protocolState: state, next: action2 });
  }
  const result = await waitForReceipt(txHash, action, pending.marketId);
  const latest = await latestForExpected(FINAL_PREFLIGHT_HEADROOM_SEC);
  if (!latest.valid || latest.prep.preparation?.status !== "READY") throw new Error("protocol preparation receipt confirmed but final live revalidation failed");
  const state = await readProtocolState(pending.marketId);
  const finalBlockers = finalOwnerHandoffBlockers({ executionEnabled: false, marketApproved: state.marketApproved, protocolPrepared: state.moduleOperator && state.poolOperator, collateralRaw: state.collateralRaw, operator: state.operator, marketTrading: latest.evaluated.valid, headroomSec: latest.evaluated.headroomSec, minimumHeadroomSec: FINAL_HANDOFF_HEADROOM_SEC });
  session.tx2Hash = txHash;
  session.tx2HeadroomSec = latest.evaluated.headroomSec;
  session.stage = STAGES.COMPLETE;
  session.final = { blockers: finalBlockers, stopBoundary: true, marketApproval: state.marketApproved, moduleOperator: state.moduleOperator, poolOperator: state.poolOperator, collateralRaw: state.collateralRaw, operator: state.operator };
  session.message = "Final owner preparation is complete. Execution remains disabled. Stop before any wet session.";
  return snapshotState({ receipt: { status: "success", txHash, blockNumber: result.receipt.blockNumber?.toString?.() ?? null }, protocolState: state });
}

async function handleFailure(action) {
  if (session.pending?.action !== action) return snapshotState();
  session.pending = null;
  session.stage = action === "MARKET_APPROVAL" ? STAGES.REVIEW : STAGES.ACTION2;
  session.message = "The wallet request was cancelled. Nothing changed. Rechecking the same market before another review.";
  return snapshotState();
}

let html;
let clientScript;
try { html = await fs.readFile(HTML_PATH, "utf8"); } catch (error) { console.error(`Unable to load local wizard UI: ${error.message}`); process.exit(1); }
try { clientScript = await fs.readFile(CLIENT_PATH, "utf8"); } catch (error) { console.error(`Unable to load local wizard client: ${error.message}`); process.exit(1); }
let walletDiscoveryScript;
try { walletDiscoveryScript = await fs.readFile(WALLET_DISCOVERY_PATH, "utf8"); } catch (error) { console.error(`Unable to load wallet discovery helpers: ${error.message}`); process.exit(1); }

async function readJsonBody(request) {
  let rawBody = "";
  for await (const chunk of request) {
    rawBody += chunk;
    if (rawBody.length > 8_192) throw new Error("request body is too large");
  }
  return JSON.parse(rawBody || "{}");
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${HOST}:${PORT}`}`);
  response.setHeader("Cache-Control", "no-store");
  try {
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/owner-prep")) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(html); return;
    }
    if (request.method === "GET" && url.pathname === "/phase3b1b1-owner-prep-wizard-client.mjs") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); response.end(clientScript); return;
    }
    if (request.method === "GET" && url.pathname === "/owner-wallet-discovery.mjs") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" }); response.end(walletDiscoveryScript); return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      const state = await cachedState(); response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); response.end(jsonSafe(state)); return;
    }
    if (request.method === "POST" && url.pathname === "/api/wallet-connected") {
      const state = markWalletConnected(await readJsonBody(request)); response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); response.end(jsonSafe(state)); return;
    }
    if (request.method === "POST" && url.pathname === "/api/invalidate") {
      invalidateWalletPreparation(); response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); response.end(jsonSafe(snapshotState())); return;
    }
    if (request.method === "POST" && ["/api/action/approve", "/api/action/prepare"].includes(url.pathname)) {
      const action = url.pathname.endsWith("approve") ? "MARKET_APPROVAL" : "PROTOCOL_APPROVAL";
      const state = await handlePrepareAction(action); response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); response.end(jsonSafe(state)); return;
    }
    if (request.method === "POST" && ["/api/receipt/approve", "/api/receipt/prepare"].includes(url.pathname)) {
      const action = url.pathname.endsWith("approve") ? "MARKET_APPROVAL" : "PROTOCOL_APPROVAL";
      const body = await readJsonBody(request);
      const state = await handleReceipt(action, body); response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); response.end(jsonSafe(state)); return;
    }
    if (request.method === "POST" && ["/api/failure/approve", "/api/failure/prepare"].includes(url.pathname)) {
      const action = url.pathname.endsWith("approve") ? "MARKET_APPROVAL" : "PROTOCOL_APPROVAL";
      const state = await handleFailure(action); response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }); response.end(jsonSafe(state)); return;
    }
    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify({ error: "not found" }));
  } catch (error) {
    response.writeHead(409, { "Content-Type": "application/json; charset=utf-8" }); response.end(jsonSafe({ ok: false, error: error?.message ?? String(error), state: snapshotState() }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`LOCAL OWNER-PREP READY`);
  console.log(`URL: http://${HOST}:${PORT}/owner-prep`);
  console.log(`Fresh-market threshold: ${INITIAL_HEADROOM_SEC}s; later thresholds: ${ACTION2_HEADROOM_SEC}s / ${FINAL_PREFLIGHT_HEADROOM_SEC}s / ${FINAL_HANDOFF_HEADROOM_SEC}s`);
  console.log(`Execution: DISABLED; signer read: false; auto-sign: false; auto-broadcast: false`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
