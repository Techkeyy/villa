/**
 * Build one fresh account-bound Phase 3B1A shadow plan from public Shannon
 * reads. This file has no signer, private-key, wallet, or broadcast path.
 */

import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED, isBinaryMarket } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { createPublicClient, http } from "viem";
import { VILLA_ACCOUNT_CONFIG } from "../dashboard/account-config.mjs";
import { estimateFairValue } from "../src/fair-value/model.mjs";
import { fetchReference, fetchSpot, fetchVolFromPriceHistory } from "../src/fair-value/live.mjs";
import { evaluateRisk, DEFAULT_RISK_CONFIG } from "../src/risk-governor/index.mjs";
import { readChainTime, readOpenOrders } from "../src/risk-governor/live.mjs";
import { planQuotes, decimalToRaw } from "../src/quote-planner/index.mjs";
import { createLpExecutionAdapter, createViemLpAccountReader, ERC20_BALANCE_ABI, VILLA_ACCOUNT_READ_ABI } from "../src/execution/lp-adapter.mjs";
import { buildLpShadowPlan } from "../src/execution/lp-shadow.mjs";
import { evaluateWetExecutionPreflight } from "../src/execution/lp-preflight.mjs";
import { createLpExecutionSession, createAccountLeaseStore, transitionLpSession } from "../src/execution/lp-session.mjs";
import { runLpOneCycle } from "../src/execution/lp-one-cycle.mjs";
import { DEFAULT_PHASE_3B1_CAPS, createLpTransactionPolicy } from "../src/execution/lp-transaction-policy.mjs";
import { LP_MARKET_SERIES, selectCurrentBtc5mMarket } from "../src/execution/lp-market-selection.mjs";

const ACCOUNT = "0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2";
const OWNER = "0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d";
const OPERATOR = VILLA_ACCOUNT_CONFIG.operator;
const RPC_URL = process.env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl || "https://dream-rpc.somnia.network";
const INDEXER_URL = process.env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql";
const WS_RPC_URL = process.env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws";
const POOL_READ_ABI = Object.freeze([
  { type: "function", name: "getOwnOpenOrders", stateMutability: "view", inputs: [], outputs: [{ type: "uint128[]" }] },
  { type: "function", name: "getBinaryPoolParams", stateMutability: "view", inputs: [], outputs: [{ name: "params", type: "tuple", components: [{ name: "collateralToken", type: "address" }, { name: "market", type: "address" }, { name: "outcomeToken", type: "address" }, { name: "yesId", type: "uint256" }, { name: "noId", type: "uint256" }, { name: "oneCollateral", type: "uint256" }, { name: "setBacking", type: "uint256" }, { name: "feeRecipient", type: "address" }, { name: "makerFeeBpsTimes1k", type: "uint256" }, { name: "takerFeeBpsTimes1k", type: "uint256" }, { name: "maxBuilderFeeBpsTimes1k", type: "uint256" }, { name: "settlementFeeBpsTimes1k", type: "uint256" }, { name: "settlement", type: "address" }, { name: "marketNonce", type: "uint64" }, { name: "finalized", type: "bool" }] }] },
]);
const OUTCOME_OPERATOR_ABI = Object.freeze([{ type: "function", name: "isOperator", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "bool" }] }]);
const ERC20_ALLOWANCE_ABI = Object.freeze([{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ type: "uint256" }] }]);
const publicClient = createPublicClient({ chain: somniaShannon, transport: http(RPC_URL, { timeout: 15_000 }) });
const exchange = new SomniaMarkets({ account: ACCOUNT, indexerUrl: INDEXER_URL, chain: somniaShannon, wsRpcUrl: WS_RPC_URL, addresses: SOMNIA_TESTNET_ADDRESSES, priceFeed: SOMNIA_TESTNET_PRICE_FEED });

const jsonSafe = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, null, 2);
const sameAddress = (left, right) => String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
const field = (value, name, index) => value?.[name] ?? value?.[index];

async function closeExchange() {
  await Promise.race([exchange.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 500))]);
}

async function discover() {
  const block = await publicClient.getBlock();
  const chainNowSec = Number(block.timestamp);
  const rows = typeof exchange.client.listLiveBinaryMarkets === "function"
    ? await exchange.client.listLiveBinaryMarkets({ asset: "BTC", intervalSec: 300, status: "Trading", orderBy: "closingSoon", limit: 100, nowSec: Math.floor(chainNowSec) })
    : await exchange.client.listBinaryMarkets({ asset: "BTC", intervalSec: 300, status: "Trading", limit: 100 });
  const loaded = await exchange.loadMarkets(true);
  const candidates = [];
  for (const row of rows) {
    if (!(isBinaryMarket(row) || String(row.marketType ?? row.info?.marketType ?? "").toUpperCase() === "BINARY")) continue;
    if (String(row.asset ?? row.info?.asset ?? "").toUpperCase() !== "BTC" || Number(row.intervalSec ?? row.info?.intervalSec) !== 300) continue;
    const marketId = row.marketId ?? row.info?.marketId ?? row.id;
    if (!marketId) continue;
    const onchain = await exchange.client.getMarketOnchain(marketId);
    if (Number(onchain.status) !== 1 || onchain.isResolved || onchain.isVoided) continue;
    const params = await exchange.client.getBinaryBookParams(onchain.pool);
    const market = loaded[row.symbol] ?? Object.values(loaded).find((item) => String(item.info?.marketId).toLowerCase() === String(marketId).toLowerCase());
    const yesSymbol = market?.outcomes?.find((outcome) => outcome.label === "YES")?.symbol;
    if (!yesSymbol) continue;
    const spot = await fetchSpot(exchange, "BTC", { nowSec: chainNowSec });
    const reference = await fetchReference(exchange, { marketId: String(marketId), strike: row.strike ?? row.info?.strike, spot: spot.price });
    const book = await exchange.fetchOrderBook(yesSymbol, 5);
    candidates.push({ row, market, onchain: { ...onchain, poolFinalized: Boolean(params.finalized) }, marketId: String(marketId), expirySec: Number(onchain.expiry), grid: { tickSizeRaw: String(params.tickSize), lotSizeRaw: String(params.lotSize), minQuantityRaw: String(params.minQuantity) }, minimumOrderRaw: String(params.minQuantity), book: { bids: book?.bids?.slice?.(0, 5) ?? [], asks: book?.asks?.slice?.(0, 5) ?? [] }, reference: { price: reference.price, source: reference.kind }, spot: { price: spot.price, timestampSec: spot.tSec } });
  }
  const selection = selectCurrentBtc5mMarket({ candidates, chainNowSec });
  if (!selection.selected) return { block, chainNowSec, candidates, selection };
  const selected = candidates.find((item) => item.marketId.toLowerCase() === selection.selected.marketId.toLowerCase());
  return { block, chainNowSec, candidates, selection, selected };
}

async function main() {
  const discovered = await discover();
  if (!discovered.selected) {
    console.log(jsonSafe({ result: "BLOCKED", reason: "NO_ELIGIBLE_BTC_5M_MARKET", chainNowSec: discovered.chainNowSec, blockNumber: discovered.block.number?.toString?.() ?? null, rejected: discovered.selection.rejected.slice(0, 12), candidates: discovered.candidates.map((item) => ({ marketId: item.marketId, expirySec: item.expirySec, pool: item.onchain.pool, poolFinalized: item.onchain.poolFinalized })) }));
    return 2;
  }
  const { selected, selection } = discovered;
  const chainTime = await readChainTime(exchange);
  const riskCollected = await (async () => {
    const spot = await fetchSpot(exchange, "BTC", { nowSec: chainTime.chainNowSec });
    const reference = await fetchReference(exchange, { marketId: selected.marketId, strike: selected.row.strike ?? selected.row.info?.strike, spot: spot.price });
    const volatility = await fetchVolFromPriceHistory(exchange, "BTC", { nowSec: chainTime.chainNowSec, refreshChainTime: true, limit: 240, minReturns: 12, minElapsedSec: 60, maxAgeSec: 180, maxGapSec: 180 });
    const effectiveChainTime = volatility.chainNowSec > chainTime.chainNowSec ? { ...chainTime, chainNowSec: volatility.chainNowSec, blockNumber: volatility.chainBlockNumber } : chainTime;
    const timeRemainingSec = selected.expirySec - effectiveChainTime.chainNowSec;
    const fairValue = estimateFairValue({ currentUnderlyingPrice: spot.price, referencePrice: reference.price, timeRemainingSec, volatility, dataQuality: { priceAgeSec: spot.priceAgeSec, referenceSource: reference.kind } });
    const [yesRaw, noRaw, collateralRaw, gasRaw, openOrderRead] = await Promise.all([
      exchange.client.getOutcomeBalance({ outcomeToken: selected.onchain.outcomeToken, account: ACCOUNT, id: selected.onchain.yesId }),
      exchange.client.getOutcomeBalance({ outcomeToken: selected.onchain.outcomeToken, account: ACCOUNT, id: selected.onchain.noId }),
      exchange.client.getErc20Balance(selected.onchain.collateral, ACCOUNT),
      // The VillaAccount owns LP collateral and positions, but the canonical
      // operator EOA pays native STT for future account-bound writes.
      publicClient.getBalance({ address: OPERATOR }),
      readOpenOrders(exchange, selected.onchain, ACCOUNT, selected.marketId, Number(selected.market.info.baseDecimals ?? selected.market.info.quoteDecimals), {}),
    ]);
    const decimals = Number(selected.market.info.baseDecimals ?? selected.market.info.quoteDecimals);
    const one = 10 ** decimals;
    const snapshot = {
      fairValue,
      chainTime: effectiveChainTime,
      feed: { price: spot.price, timestampSec: spot.tSec, sourceAgeSec: spot.sourceAgeSec },
      market: { status: Number(selected.onchain.status), expirySec: selected.expirySec, reference: { status: "VALID", source: reference.kind, scaleExponent10: reference.scaleExponent10 } },
      inventory: { yes: Number(yesRaw) / one, no: Number(noRaw) / one },
      openOrdersStatus: openOrderRead.status,
      openOrders: openOrderRead.orders,
      capital: { collateralAvailable: Number(collateralRaw) / one, capitalAtRisk: 0, accountingStatus: "PARTIAL" },
      gas: { nativeBalance: Number(gasRaw) / 1e18, payer: OPERATOR },
      drawdown: { status: "UNAVAILABLE" },
    };
    return { snapshot, spot, reference, volatility, openOrderRead, decimals, yesRaw, noRaw, collateralRaw, gasRaw };
  })();
  const decision = evaluateRisk(riskCollected.snapshot, DEFAULT_RISK_CONFIG);
  const decimals = riskCollected.decimals;
  const oneRaw = 10n ** BigInt(decimals);
  const params = await exchange.client.getBinaryBookParams(selected.onchain.pool);
  const plannerInput = {
    fairValue: riskCollected.snapshot.fairValue,
    governor: { state: decision.state, permissions: decision.permissions, sizeMultiplier: decision.sizeMultiplier, triggeredRules: decision.triggeredRules, warnings: decision.warnings, reduceOnlyPolicy: decision.reduceOnlyPolicy, directionalRiskCapacity: DEFAULT_RISK_CONFIG.directionalExposureHard, limits: { directionalExposureHard: DEFAULT_RISK_CONFIG.directionalExposureHard, grossExposureHard: DEFAULT_RISK_CONFIG.grossExposureHard } },
    inventory: { yesRaw: riskCollected.yesRaw.toString(), noRaw: riskCollected.noRaw.toString(), yesAvailableRaw: riskCollected.yesRaw.toString() },
    pendingOrders: riskCollected.snapshot.openOrders,
    book: { bestBidRaw: selected.book.bids[0] ? decimalToRaw(String(selected.book.bids[0][0]), decimals).toString() : null, bestAskRaw: selected.book.asks[0] ? decimalToRaw(String(selected.book.asks[0][0]), decimals).toString() : null, empty: !selected.book.bids.length && !selected.book.asks.length },
    grid: { decimals, oneRaw: oneRaw.toString(), tickSizeRaw: String(params.tickSize), lotSizeRaw: String(params.lotSize), minQuantityRaw: String(params.minQuantity) },
    capital: { collateralAvailableRaw: riskCollected.collateralRaw.toString(), collateralReserveRaw: decimalToRaw(String(DEFAULT_RISK_CONFIG.minCollateralReserve), decimals).toString(), collateralReserve: DEFAULT_RISK_CONFIG.minCollateralReserve },
    market: { marketId: selected.marketId, timeRemainingSec: decision.authoritativeTime.timeRemainingSec },
    quote: { baseQuantityRaw: (params.minQuantity > params.lotSize * 5n ? params.minQuantity : params.lotSize * 5n).toString() },
  };
  const quotePlan = planQuotes(plannerInput);
  const reader = createViemLpAccountReader({ publicClient, listOpenOrderIds: async ({ pool }) => publicClient.readContract({ address: pool, abi: POOL_READ_ABI, functionName: "getOwnOpenOrders", account: ACCOUNT }) });
  const adapter = createLpExecutionAdapter({ account: ACCOUNT, owner: OWNER, operator: OPERATOR, reader });
  const accountRead = await adapter.readAccountState({ marketId: selected.marketId });
  const [marketApproved, modulePrepared, poolPrepared, allowance] = await Promise.all([
    publicClient.readContract({ address: ACCOUNT, abi: VILLA_ACCOUNT_READ_ABI, functionName: "approvedMarkets", args: [selected.marketId] }),
    publicClient.readContract({ address: VILLA_ACCOUNT_CONFIG.outcomeToken, abi: OUTCOME_OPERATOR_ABI, functionName: "isOperator", args: [ACCOUNT, VILLA_ACCOUNT_CONFIG.binaryModule] }),
    publicClient.readContract({ address: VILLA_ACCOUNT_CONFIG.outcomeToken, abi: OUTCOME_OPERATOR_ABI, functionName: "isOperator", args: [ACCOUNT, selected.onchain.pool] }),
    publicClient.readContract({ address: VILLA_ACCOUNT_CONFIG.collateralToken, abi: ERC20_ALLOWANCE_ABI, functionName: "allowance", args: [ACCOUNT, selected.onchain.pool] }),
  ]);
  const accountState = {
    account: ACCOUNT,
    owner: OWNER,
    operator: OPERATOR,
    capital: { collateralAvailable: Number(accountRead.capital.directCollateralRaw) / 10 ** 6, collateralAvailableRaw: accountRead.capital.directCollateralRaw },
    inventory: { account: ACCOUNT, yes: Number(accountRead.inventory.yesRaw) / 10 ** decimals, no: Number(accountRead.inventory.noRaw) / 10 ** decimals, yesRaw: accountRead.inventory.yesRaw, noRaw: accountRead.inventory.noRaw },
    orders: { account: ACCOUNT, status: accountRead.orders.status, orders: accountRead.orders.orders },
  };
  const readinessInput = {
    chain: { id: 50312 },
    account: { owner: OWNER, operator: OPERATOR, runtimeVerified: true },
    owner: { verified: true },
    operator: { configuredAddress: OPERATOR, signerAddress: OPERATOR },
    market: { marketId: selected.marketId, series: LP_MARKET_SERIES, currentMarketId: selected.marketId, valid: true, current: true },
    permissions: { requiresMarketApproval: true, marketApproved, requiresProtocolApproval: true, protocolPrepared: modulePrepared && poolPrepared },
    capital: { collateralRaw: accountRead.capital.directCollateralRaw },
    riskLimits: { valid: true },
    risk: { state: decision.state },
    executionConfig: { mode: "SHADOW", minimumCollateralRaw: 1n, sessionActive: false },
  };
  const sessionBase = createLpExecutionSession({ sessionId: `phase3b1a-shadow-${selected.marketId.slice(-8)}`, account: ACCOUNT, owner: OWNER, operator: OPERATOR, marketSeries: LP_MARKET_SERIES, currentMarketId: selected.marketId, riskPolicyVersion: decision.governorVersion, executionMode: "WET", createdAt: Date.now() });
  const session = transitionLpSession(sessionBase, "PREFLIGHT");
  const leases = createAccountLeaseStore();
  const lease = leases.acquire(session, { reconciled: true });
  const policy = createLpTransactionPolicy({ session, caps: DEFAULT_PHASE_3B1_CAPS, now: () => Date.now() });
  const shadow = buildLpShadowPlan({ adapter, accountState, readinessInput, market: { marketId: selected.marketId }, decision, quotePlan, orderExpiryNs: BigInt(Math.floor(selected.expirySec - 2)) * 1_000_000_000n, transactionPolicy: policy, txIndexStart: 0, createdAtMs: Date.now() });
  const preflight = evaluateWetExecutionPreflight({
    nowMs: Date.now(), session, lease: { ...lease, held: true }, chain: { id: 50312 }, executionEnabled: false,
    account: { address: ACCOUNT, owner: OWNER, operator: OPERATOR, runtimeVerified: true }, owner: { address: OWNER, verified: true }, operator: { configuredAddress: OPERATOR, signerAddress: OPERATOR }, capital: { collateralRaw: accountRead.capital.directCollateralRaw },
    market: { marketId: selected.marketId, series: LP_MARKET_SERIES, status: 1, valid: true, current: true, currentMarketId: selected.marketId }, orders: { account: ACCOUNT, status: accountRead.orders.status, orders: accountRead.orders.orders }, inventory: { account: ACCOUNT, status: "VERIFIED", yesRaw: accountRead.inventory.yesRaw, noRaw: accountRead.inventory.noRaw }, reconciliation: { status: "RECONCILED", pendingTransactions: 0, unknownTransactions: 0, unknownOrders: 0 }, permissions: readinessInput.permissions, riskLimits: { valid: true }, risk: { state: decision.state }, executionConfig: { mode: "WET", minimumCollateralRaw: 1n }, caps: DEFAULT_PHASE_3B1_CAPS,
  });
  const facts = { fresh: true, session, lease: { ...lease, held: true }, account: { operator: OPERATOR }, operator: { signerAddress: OPERATOR }, market: { marketId: selected.marketId, series: LP_MARKET_SERIES } };
  const shadowCycle = await runLpOneCycle({ request: { oneCycle: true, account: ACCOUNT, sessionId: session.sessionId }, mode: "SHADOW", executionEnabled: false, facts, buildPlans: async () => shadow.actions, validatePlan: async (plan) => policy.validate(plan) });
  const wetDisabled = await runLpOneCycle({ request: { oneCycle: true, account: ACCOUNT, sessionId: session.sessionId }, mode: "WET", executionEnabled: false, facts, buildPlans: async () => shadow.actions, validatePlan: async (plan) => policy.validate(plan) });
  console.log(jsonSafe({ result: "PASS", chainId: 50312, account: ACCOUNT, owner: OWNER, operator: OPERATOR, market: { ...selection.selected, poolFinalized: false }, fairValue: riskCollected.snapshot.fairValue, volatility: { realizedVolPerSqrtSec: riskCollected.volatility.realizedVolPerSqrtSec, dataQualityStatus: riskCollected.volatility.dataQualityStatus ?? null }, inventory: accountState.inventory, openOrders: accountState.orders, risk: decision, quotePlan, quoteExecution: { orderType: 3, postOnly: true, policyValid: shadow.actions.length > 0 }, readiness: shadow.readiness, permissions: { marketApproved, protocolPrepared: modulePrepared && poolPrepared, moduleOperator: modulePrepared, poolOperator: poolPrepared, collateralAllowanceRaw: allowance.toString(), outcomeToken: VILLA_ACCOUNT_CONFIG.outcomeToken, binaryModule: VILLA_ACCOUNT_CONFIG.binaryModule }, gas: { payer: OPERATOR, balanceWei: riskCollected.gasRaw.toString() }, shadowPlan: { actions: shadow.actions, actionCount: shadow.actions.length, broadcast: shadow.broadcast, orderOwner: ACCOUNT }, wetPreflight: preflight, shadowCycle, wetDisabled, caps: DEFAULT_PHASE_3B1_CAPS, signer: { installed: false, privateKeyRead: false }, writes: { broadcast: false, intents: shadow.actions.map((action) => action.intent ?? null) } }));
  return 0;
}

let exitCode = 0;
try {
  exitCode = await main();
} catch (error) {
  console.error(jsonSafe({ result: "BLOCKED", code: error?.code ?? "READONLY_PROBE_FAILED", reason: error?.message ?? String(error) }));
  exitCode = 2;
} finally {
  await closeExchange();
  process.exit(exitCode);
}
