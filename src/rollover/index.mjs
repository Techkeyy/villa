/**
 * Pure successor selection and market-context rollover decisions.
 *
 * This module deliberately has no SDK, RPC, indexer, wallet, clock, or
 * environment dependency.  The live adapter supplies already-read market,
 * chain, feed, inventory, and book facts; this layer decides whether a
 * successor is safe to select and how market-scoped state is replaced.
 */

export const ROLLOVER_VERSION = "villa-rollover-v1";

export const ROLLOVER_STATES = Object.freeze({
  ACTIVE: "ACTIVE",
  STOPPING_CURRENT: "STOPPING_CURRENT",
  WAITING_FOR_SUCCESSOR: "WAITING_FOR_SUCCESSOR",
  SUCCESSOR_FOUND: "SUCCESSOR_FOUND",
  INITIALIZING_SUCCESSOR: "INITIALIZING_SUCCESSOR",
  SUCCESSOR_READY: "SUCCESSOR_READY",
  HALTED: "HALTED",
});

export const ROLLOVER_EVENTS = Object.freeze([
  "MARKET_CONTEXT_STARTED",
  "CURRENT_MARKET_NO_LONGER_TRADING",
  "SUCCESSOR_SEARCH_STARTED",
  "SUCCESSOR_CANDIDATE_FOUND",
  "SUCCESSOR_REJECTED",
  "SUCCESSOR_CONFIRMED",
  "MARKET_CONTEXT_CLOSED",
  "MARKET_CONTEXT_INITIALIZED",
  "REFERENCE_RESOLVED",
  "ROLLOVER_FAIR_VALUE_CALCULATED",
  "ROLLOVER_GOVERNOR_EVALUATED",
  "ROLLOVER_QUOTE_PLANNED",
  "ROLLOVER_READY",
  "WAITING_FOR_SUCCESSOR",
  "ROLLOVER_HALTED",
]);

export const UNDERLYING_HISTORY_POLICY = Object.freeze({
  maxAgeSec: 180,
  maxGapSec: 180,
  futureSkewSec: 5,
  maxTicks: 240,
});

export class RolloverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RolloverError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new RolloverError(code, message);
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail("INVALID_DATA", `${label} must be finite`);
  return number;
}

function positiveInteger(value, label) {
  const number = finite(value, label);
  if (!Number.isInteger(number) || number <= 0) fail("INVALID_DATA", `${label} must be a positive integer`);
  return number;
}

function nonNegativeRaw(value, label) {
  let raw;
  try {
    raw = typeof value === "bigint" ? value : BigInt(String(value));
  } catch {
    fail("INVALID_BALANCE", `${label} must be a non-negative integer`);
  }
  if (raw < 0n) fail("INVALID_BALANCE", `${label} must be a non-negative integer`);
  return raw;
}

function text(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail("INVALID_DATA", `${label} is required`);
  return value.trim();
}

function idKey(value, label = "marketId") {
  return text(value, label).toLowerCase();
}

function marketField(market, field) {
  return market?.[field] ?? market?.info?.[field];
}

function marketIdOf(market) {
  return marketField(market, "marketId") ?? market?.id;
}

function statusNumber(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (value === "Trading") return 1;
  if (value === "Listed") return 0;
  if (value === "Locked") return 2;
  if (value === "Settling") return 3;
  if (value === "Resolved" || value === "Finalized") return 4;
  if (value === "Voided") return 5;
  return null;
}

function statusFrom(candidate) {
  return statusNumber(candidate?.onchain?.status ?? candidate?.status ?? marketField(candidate?.market ?? candidate, "status"));
}

function expiryOf(candidate) {
  return finite(candidate?.onchain?.expiry ?? candidate?.expirySec ?? marketField(candidate?.market ?? candidate, "expiry"), "market expiry");
}

function assetOf(market) {
  return text(marketField(market, "asset"), "asset").toUpperCase();
}

function intervalOf(market) {
  return positiveInteger(marketField(market, "intervalSec"), "intervalSec");
}

function binaryTypeOf(market) {
  const type = market?.marketType ?? market?.type ?? market?.info?.marketType ?? market?.info?.type;
  // Small fixtures often omit the discriminator.  A row with typed binary
  // fields is treated as binary; a populated non-binary discriminator is not.
  if (type === undefined || type === null || type === "") return "BINARY";
  const normalized = String(type).toUpperCase();
  if (normalized === "BINARY" || normalized === "BINARYMARKET") return "BINARY";
  return normalized;
}

/** Define the stable series key.  Venue and pool are intentionally excluded. */
export function seriesIdentity(market) {
  const source = market?.market ?? market;
  const marketType = binaryTypeOf(source);
  if (marketType !== "BINARY") fail("SERIES_MISMATCH", `unsupported market type ${marketType}`);
  const asset = assetOf(source);
  const intervalSec = intervalOf(source);
  return Object.freeze({
    marketType: "BINARY",
    asset,
    intervalSec,
    key: `BINARY:${asset}:${intervalSec}`,
  });
}

function sameSeries(left, right) {
  const a = left?.key ?? seriesIdentity(left).key;
  const b = right?.key ?? seriesIdentity(right).key;
  return a === b;
}

function outcomeIdOf(source, outcome) {
  return source?.onchain?.[outcome === "YES" ? "yesId" : "noId"]
    ?? source?.[outcome === "YES" ? "yesId" : "noId"]
    ?? source?.market?.[outcome === "YES" ? "yesTokenId" : "noTokenId"]
    ?? source?.market?.info?.[outcome === "YES" ? "yesTokenId" : "noTokenId"]
    ?? null;
}

function indexedOutcomeIdOf(source, outcome) {
  const market = source?.market ?? source;
  return market?.[outcome === "YES" ? "yesTokenId" : "noTokenId"]
    ?? market?.info?.[outcome === "YES" ? "yesTokenId" : "noTokenId"]
    ?? null;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/**
 * Normalize one market into a context whose identity and all outcome ids are
 * explicit.  The context is intentionally separate from wallet/session state.
 */
export function buildMarketContext({ market, onchain = null, reference = null, chainNowSec, blockNumber = null, status = undefined } = {}) {
  const source = market?.market ?? market;
  const marketId = text(marketIdOf(source), "marketId");
  const series = seriesIdentity(source);
  const expirySec = finite(onchain?.expiry ?? market?.expirySec ?? marketField(source, "expiry"), "expiry");
  const resolvedStatus = statusNumber(status ?? onchain?.status ?? marketField(source, "status"));
  if (resolvedStatus === null) fail("INVALID_DATA", "market status must be numeric or a known status name");
  const yesId = outcomeIdOf({ ...source, onchain }, "YES");
  const noId = outcomeIdOf({ ...source, onchain }, "NO");
  if (yesId === null || noId === null) fail("INVALID_DATA", "YES and NO token ids are required");
  const decimalsValue = onchain?.decimals ?? market?.decimals ?? source?.baseDecimals ?? source?.quoteDecimals ?? source?.info?.baseDecimals ?? source?.info?.quoteDecimals ?? null;
  const decimals = decimalsValue === null || decimalsValue === undefined ? null : finite(decimalsValue, "market decimals");
  if (decimals !== null && (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)) fail("INVALID_DATA", "market decimals must be an integer from 0 through 18");
  const normalizedReference = reference === null || reference === undefined ? null : clone(reference);
  if (normalizedReference?.marketId !== undefined && idKey(normalizedReference.marketId, "reference.marketId") !== idKey(marketId)) {
    fail("REFERENCE_SCOPE_MISMATCH", "reference belongs to a different market");
  }
  return {
    marketId,
    series,
    asset: series.asset,
    intervalSec: series.intervalSec,
    symbol: market?.symbol ?? source?.symbol ?? null,
    expirySec,
    yesId: String(yesId),
    noId: String(noId),
    decimals,
    reference: normalizedReference,
    status: resolvedStatus,
    venueId: market?.venueId ?? source?.venueId ?? source?.info?.venueId ?? null,
    pool: onchain?.pool ?? market?.pool ?? source?.poolAddress ?? source?.info?.pool ?? null,
    marketAddress: onchain?.marketAddress ?? market?.marketAddress ?? source?.marketAddress ?? null,
    outcomeToken: onchain?.outcomeToken ?? null,
    initializedAt: {
      chainNowSec: chainNowSec === undefined ? null : finite(chainNowSec, "chainNowSec"),
      blockNumber: blockNumber === null || blockNumber === undefined ? null : finite(blockNumber, "blockNumber"),
    },
  };
}

function baseCandidate(candidate) {
  const market = candidate?.market ?? candidate;
  const marketId = marketIdOf(market);
  return {
    market,
    marketId: marketId === undefined ? null : String(marketId),
    asset: marketField(market, "asset"),
    intervalSec: marketField(market, "intervalSec"),
    expirySec: candidate?.expirySec ?? marketField(market, "expiry"),
    status: candidate?.status ?? marketField(market, "status"),
    onchain: candidate?.onchain ?? null,
    symbol: candidate?.symbol ?? market?.symbol ?? null,
  };
}

function reject(code, reason, candidate = null) {
  return {
    marketId: candidate?.marketId ?? null,
    symbol: candidate?.symbol ?? null,
    code,
    reason,
  };
}

function candidateRejection(current, candidate, chainNowSec, { requireOnchain = false } = {}) {
  const normalized = baseCandidate(candidate);
  let candidateId;
  try {
    candidateId = idKey(normalized.marketId);
  } catch {
    return reject("INVALID_MARKET_ID", "candidate marketId is missing or invalid", normalized);
  }
  const currentId = idKey(current.marketId ?? marketIdOf(current), "current marketId");
  if (candidateId === currentId) return reject("SAME_MARKET", "candidate is the current market", normalized);

  let expectedSeries;
  try {
    expectedSeries = current.series ?? seriesIdentity(current);
  } catch (err) {
    return reject(err.code ?? "SERIES_INVALID", err.message, normalized);
  }
  let candidateSeries;
  try {
    candidateSeries = seriesIdentity(normalized.market);
  } catch (err) {
    return reject(err.code ?? "SERIES_INVALID", err.message, normalized);
  }
  if (!sameSeries(expectedSeries, candidateSeries)) return reject("SERIES_MISMATCH", "asset, binary type, or interval does not match", normalized);

  let currentExpiry;
  let candidateExpiry;
  try {
    currentExpiry = finite(current.expirySec ?? marketField(current, "expiry"), "current expiry");
    candidateExpiry = expiryOf(normalized);
  } catch (err) {
    return reject("EXPIRY_INVALID", err.message, normalized);
  }
  if (!(candidateExpiry > currentExpiry)) return reject("EXPIRY_NOT_LATER", "successor expiry must be later than current expiry", normalized);
  const now = finite(chainNowSec, "chainNowSec");
  if (!(candidateExpiry > now)) return reject("CANDIDATE_EXPIRED", "candidate is not in the future at chain time", normalized);

  const status = statusFrom(normalized);
  if (requireOnchain && !normalized.onchain) return reject("ONCHAIN_UNVERIFIED", "candidate has no on-chain verification", normalized);
  if (status !== null && status !== 1) return reject("ONCHAIN_NOT_TRADING", `candidate status is ${status}`, normalized);
  if (status === null && requireOnchain) return reject("ONCHAIN_STATUS_INVALID", "candidate on-chain status is unavailable", normalized);

  if (normalized.onchain) {
    const indexedExpiry = normalized.expirySec === undefined || normalized.expirySec === null ? null : finite(normalized.expirySec, "indexed expiry");
    const chainExpiry = finite(normalized.onchain.expiry, "on-chain expiry");
    if (indexedExpiry !== null && indexedExpiry !== chainExpiry) return reject("EXPIRY_MISMATCH", "on-chain expiry differs from indexed candidate", normalized);
    for (const outcome of ["YES", "NO"]) {
      const indexedId = indexedOutcomeIdOf(normalized, outcome);
      const chainId = normalized.onchain[outcome === "YES" ? "yesId" : "noId"];
      if (indexedId !== null && chainId !== undefined && String(indexedId) !== String(chainId)) return reject("OUTCOME_ID_MISMATCH", `${outcome} outcome id differs from on-chain snapshot`, normalized);
    }
  }

  return null;
}

/**
 * Select the earliest later window from a source-discovered candidate list.
 * Equal expiry matches are ambiguous, never randomly tie-broken.
 */
export function selectSuccessor({ current, candidates = [], chainNowSec } = {}) {
  if (!current || typeof current !== "object") fail("CURRENT_INVALID", "current market context is required");
  const currentId = text(current.marketId ?? marketIdOf(current), "current marketId");
  const currentContext = current.series ? current : { ...current, marketId: currentId, series: seriesIdentity(current) };
  const rejections = [];
  const accepted = [];
  if (!Array.isArray(candidates)) fail("CANDIDATES_INVALID", "candidates must be an array");
  for (const candidate of candidates) {
    const normalized = baseCandidate(candidate);
    const reason = candidateRejection(currentContext, normalized, chainNowSec, { requireOnchain: Boolean(normalized.onchain) });
    if (reason) rejections.push(reason);
    else accepted.push(normalized);
  }
  if (accepted.length === 0) {
    return {
      model: ROLLOVER_VERSION,
      state: ROLLOVER_STATES.WAITING_FOR_SUCCESSOR,
      selected: null,
      currentMarketId: currentId,
      candidatesConsidered: candidates.length,
      acceptedCount: 0,
      rejections,
    };
  }
  accepted.sort((a, b) => expiryOf(a) - expiryOf(b) || idKey(a.marketId).localeCompare(idKey(b.marketId)));
  const earliestExpiry = expiryOf(accepted[0]);
  const sameExpiry = accepted.filter((candidate) => expiryOf(candidate) === earliestExpiry);
  if (sameExpiry.length > 1) {
    for (const candidate of sameExpiry) rejections.push(reject("SUCCESSOR_AMBIGUOUS", "more than one valid successor has the same earliest expiry", candidate));
    return {
      model: ROLLOVER_VERSION,
      state: ROLLOVER_STATES.HALTED,
      selected: null,
      currentMarketId: currentId,
      candidatesConsidered: candidates.length,
      acceptedCount: accepted.length,
      rejections,
      code: "SUCCESSOR_AMBIGUOUS",
    };
  }
  return {
    model: ROLLOVER_VERSION,
    state: ROLLOVER_STATES.SUCCESSOR_FOUND,
    selected: accepted[0],
    currentMarketId: currentId,
    candidatesConsidered: candidates.length,
    acceptedCount: accepted.length,
    rejections,
  };
}

/** Verify the selected indexer candidate against the exact chain snapshot. */
export function verifySuccessorCandidate({ current, candidate, onchain, chainNowSec } = {}) {
  const normalized = baseCandidate({ ...candidate, onchain: onchain ?? candidate?.onchain ?? null });
  const reason = candidateRejection(current, normalized, chainNowSec, { requireOnchain: true });
  if (reason) return { verified: false, ...reason, candidate: normalized };
  const chainId = normalized.onchain?.marketId;
  if (chainId !== undefined && idKey(chainId) !== idKey(normalized.marketId)) {
    return { verified: false, ...reject("MARKET_ID_MISMATCH", "on-chain marketId differs from indexed candidate", normalized), candidate: normalized };
  }
  const indexedExpiry = finite(normalized.expirySec, "indexed expiry");
  const chainExpiry = finite(normalized.onchain.expiry, "on-chain expiry");
  if (indexedExpiry !== chainExpiry) {
    return { verified: false, ...reject("EXPIRY_MISMATCH", "on-chain expiry differs from indexed candidate", normalized), candidate: normalized };
  }
  for (const outcome of ["YES", "NO"]) {
    const candidateId = indexedOutcomeIdOf(normalized, outcome);
    const chainOutcomeId = normalized.onchain[outcome === "YES" ? "yesId" : "noId"];
    if (candidateId !== null && chainOutcomeId !== undefined && String(candidateId) !== String(chainOutcomeId)) {
      return { verified: false, ...reject("OUTCOME_ID_MISMATCH", `${outcome} outcome id differs from on-chain snapshot`, normalized), candidate: normalized };
    }
  }
  return { verified: true, candidate: normalized };
}

/** Compare A and B without assigning identity to a pool or venue. */
export function compareMarketContexts(current, successor) {
  const currentSeries = current.series ?? seriesIdentity(current);
  const successorSeries = successor.series ?? seriesIdentity(successor);
  return {
    marketIdChanged: idKey(current.marketId) !== idKey(successor.marketId),
    expiryAdvanced: finite(successor.expirySec, "successor expiry") > finite(current.expirySec, "current expiry"),
    sameSeries: sameSeries(currentSeries, successorSeries),
    intervalSame: currentSeries.intervalSec === successorSeries.intervalSec,
    assetSame: currentSeries.asset === successorSeries.asset,
    poolReused: current.pool !== null && current.pool !== undefined && successor.pool !== null && String(current.pool).toLowerCase() === String(successor.pool).toLowerCase(),
    venueIdChanged: String(current.venueId ?? "").toLowerCase() !== String(successor.venueId ?? "").toLowerCase(),
    symbolChanged: String(current.symbol ?? "") !== String(successor.symbol ?? ""),
    yesIdChanged: String(current.yesId) !== String(successor.yesId),
    noIdChanged: String(current.noId) !== String(successor.noId),
  };
}

function balancesById(input) {
  const out = new Map();
  if (input instanceof Map) {
    for (const [id, value] of input.entries()) out.set(String(id), nonNegativeRaw(value, `balance[${String(id)}]`));
    return out;
  }
  if (Array.isArray(input)) {
    for (const row of input) {
      if (!row || row.id === undefined) fail("INVALID_BALANCE", "balance rows require an id");
      out.set(String(row.id), nonNegativeRaw(row.amountRaw ?? row.balanceRaw ?? row.amount, `balance[${String(row.id)}]`));
    }
    return out;
  }
  if (!input || typeof input !== "object") fail("INVALID_BALANCE", "balancesByTokenId must be an object, Map, or rows");
  for (const [id, value] of Object.entries(input)) out.set(String(id), nonNegativeRaw(value, `balance[${id}]`));
  return out;
}

/** Read only the two exact outcome ids for one market. */
export function inventoryForMarket({ marketId, yesId, noId, balancesByTokenId } = {}) {
  const normalizedMarketId = text(marketId, "marketId");
  const yesKey = text(yesId, "yesId");
  const noKey = text(noId, "noId");
  if (yesKey === noKey) fail("OUTCOME_ID_COLLISION", "YES and NO token ids must differ");
  const balances = balancesById(balancesByTokenId);
  const yesRaw = balances.get(yesKey) ?? 0n;
  const noRaw = balances.get(noKey) ?? 0n;
  const excluded = [...balances.entries()]
    .filter(([id]) => id !== yesKey && id !== noKey)
    .map(([id, amountRaw]) => ({ tokenId: id, amountRaw }));
  return {
    marketId: normalizedMarketId,
    yesId: yesKey,
    noId: noKey,
    yesRaw,
    noRaw,
    completeSetsRaw: yesRaw < noRaw ? yesRaw : noRaw,
    directionalDeltaRaw: yesRaw - noRaw,
    excludedTokenBalances: excluded,
  };
}

/**
 * Label held outcomes instead of pretending a wallet is globally clean.  A
 * resolved losing token is a known zero-value historical residual and is never
 * included in a different market's active inventory.
 */
export function classifyMarketInventory({ marketId, yesId, noId, balancesByTokenId, status, isResolved = false, isVoided = false, winningOutcome } = {}) {
  const inventory = inventoryForMarket({ marketId, yesId, noId, balancesByTokenId });
  const terminal = Boolean(isResolved || isVoided || Number(status) === 4 || Number(status) === 5);
  const labels = [];
  for (const [outcome, amountRaw, idx] of [["YES", inventory.yesRaw, 0], ["NO", inventory.noRaw, 1]]) {
    if (amountRaw === 0n) continue;
    let classification = "ACTIVE_INVENTORY";
    if (terminal && isVoided) classification = "REDEEMABLE_INVENTORY";
    else if (terminal && Number(winningOutcome) === idx) classification = "REDEEMABLE_INVENTORY";
    else if (terminal) classification = "KNOWN_ZERO_VALUE_SETTLED_RESIDUAL";
    else if (inventory.completeSetsRaw > 0n) classification = "PAIRED_BURNABLE_INVENTORY";
    labels.push({ outcome, outcomeIdx: idx, amountRaw, classification });
  }
  return { ...inventory, terminal, labels, knownResidual: labels.filter((item) => item.classification === "KNOWN_ZERO_VALUE_SETTLED_RESIDUAL") };
}

/** Keep usable BTC history across windows, cutting stale/gapped prefixes. */
export function retainUnderlyingHistory(ticks, chainNowSec, policy = UNDERLYING_HISTORY_POLICY) {
  const now = finite(chainNowSec, "chainNowSec");
  const limits = { ...UNDERLYING_HISTORY_POLICY, ...policy };
  if (!Number.isFinite(limits.maxAgeSec) || limits.maxAgeSec < 0 || !Number.isFinite(limits.maxGapSec) || limits.maxGapSec <= 0 || !Number.isFinite(limits.futureSkewSec) || limits.futureSkewSec < 0 || !Number.isInteger(limits.maxTicks) || limits.maxTicks < 2) {
    fail("HISTORY_POLICY_INVALID", "underlying history policy is invalid");
  }
  if (!Array.isArray(ticks)) fail("HISTORY_INVALID", "underlying history must be an array");
  const byTimestamp = new Map();
  let droppedInvalid = 0;
  for (const tick of ticks) {
    const price = Number(tick?.price);
    const tSec = Number(tick?.tSec ?? tick?.blockTimestamp);
    if (!(price > 0) || !Number.isFinite(price) || !Number.isFinite(tSec)) {
      droppedInvalid += 1;
      continue;
    }
    if (tSec > now + limits.futureSkewSec || now - tSec > limits.maxAgeSec) continue;
    byTimestamp.set(tSec, { price, tSec });
  }
  const sorted = [...byTimestamp.values()].sort((a, b) => a.tSec - b.tSec);
  let start = 0;
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].tSec - sorted[index - 1].tSec > limits.maxGapSec) start = index;
  }
  const retained = sorted.slice(start).slice(-limits.maxTicks);
  return {
    policy: limits,
    ticks: retained,
    retainedCount: retained.length,
    droppedInvalid,
    droppedStaleOrFuture: ticks.length - droppedInvalid - byTimestamp.size,
    cutAfterGap: start > 0,
    usable: retained.length >= 2,
  };
}

function event(state, type, facts = {}) {
  if (!ROLLOVER_EVENTS.includes(type)) fail("EVENT_INVALID", `unsupported rollover event ${type}`);
  return {
    seq: state.events.length + 1,
    type,
    state: state.state,
    marketId: state.activeMarketId ?? state.currentMarketId ?? null,
    facts: clone(facts),
  };
}

function withEvent(state, type, facts = {}) {
  const next = { ...state, events: [...state.events, event(state, type, facts)] };
  return next;
}

function emptyMarketScope() {
  return { marketId: null, yesId: null, noId: null, reference: null, expirySec: null, status: null, openOrderIds: [], inventory: null, pendingExposure: null, quotePlan: null, decisionSnapshotId: null };
}

/** Create the bounded session state with A as the only active quote context. */
export function createRolloverState({ sessionId = "fixture", currentContext, walletState = {}, strategyState = {}, underlyingHistory = [] } = {}) {
  if (!currentContext?.marketId) fail("CURRENT_INVALID", "currentContext is required");
  const context = clone(currentContext);
  const state = {
    model: ROLLOVER_VERSION,
    sessionId: text(String(sessionId), "sessionId"),
    state: ROLLOVER_STATES.ACTIVE,
    currentMarketId: context.marketId,
    activeMarketId: context.marketId,
    currentContext: context,
    activeContext: context,
    successor: null,
    marketScope: {
      ...emptyMarketScope(),
      marketId: context.marketId,
      yesId: context.yesId,
      noId: context.noId,
      reference: clone(context.reference),
      expirySec: context.expirySec,
      status: context.status,
    },
    walletState: clone(walletState),
    strategyState: clone(strategyState),
    underlyingHistory: clone(underlyingHistory),
    settlementHistory: [],
    events: [],
    haltReason: null,
  };
  return withEvent(state, "MARKET_CONTEXT_STARTED", { marketId: context.marketId, series: context.series });
}

/** Advance A to a closed context. Open A orders block the transition. */
export function closeCurrentMarket(state, { chainNowSec, status, openOrderIds = [] } = {}) {
  if (state?.state !== ROLLOVER_STATES.ACTIVE) fail("STATE_INVALID", "current market can only close from ACTIVE");
  const numericStatus = statusNumber(status);
  if (numericStatus === 1) fail("CURRENT_STILL_TRADING", "cannot close a market that is still Trading");
  if (!Array.isArray(openOrderIds)) fail("OPEN_ORDERS_INVALID", "openOrderIds must be an array");
  if (openOrderIds.length > 0) {
    const halted = { ...state, state: ROLLOVER_STATES.HALTED, haltReason: "CURRENT_OPEN_ORDERS", activeMarketId: state.currentMarketId };
    return withEvent(halted, "ROLLOVER_HALTED", { code: "CURRENT_OPEN_ORDERS", openOrderIds: [...openOrderIds], chainNowSec });
  }
  const closedContext = { ...state.currentContext, status: numericStatus, closedAtChainSec: finite(chainNowSec, "chainNowSec") };
  let next = { ...state, state: ROLLOVER_STATES.STOPPING_CURRENT, marketScope: { ...state.marketScope, status: numericStatus } };
  next = withEvent(next, "CURRENT_MARKET_NO_LONGER_TRADING", { marketId: state.currentMarketId, status: numericStatus, chainNowSec });
  next = withEvent(next, "MARKET_CONTEXT_CLOSED", { marketId: state.currentMarketId, openOrderCount: 0, chainNowSec });
  next = { ...next, state: ROLLOVER_STATES.WAITING_FOR_SUCCESSOR, activeMarketId: null, activeContext: null, marketScope: emptyMarketScope(), settlementHistory: [...next.settlementHistory, clone(closedContext)] };
  return withEvent(next, "SUCCESSOR_SEARCH_STARTED", { previousMarketId: state.currentMarketId, chainNowSec });
}

export function recordSuccessorSearch(state, facts = {}) {
  if (state?.state !== ROLLOVER_STATES.WAITING_FOR_SUCCESSOR) fail("STATE_INVALID", "successor search requires WAITING_FOR_SUCCESSOR");
  return withEvent(state, "SUCCESSOR_SEARCH_STARTED", facts);
}

/** Store only the selected, source-discovered successor; A remains history. */
export function acceptSuccessor(state, selection, facts = {}) {
  if (state?.state !== ROLLOVER_STATES.WAITING_FOR_SUCCESSOR) fail("STATE_INVALID", "successor selection requires WAITING_FOR_SUCCESSOR");
  if (!selection || selection.state !== ROLLOVER_STATES.SUCCESSOR_FOUND || !selection.selected) {
    const waiting = { ...state, state: selection?.state === ROLLOVER_STATES.HALTED ? ROLLOVER_STATES.HALTED : ROLLOVER_STATES.WAITING_FOR_SUCCESSOR, haltReason: selection?.code ?? null };
    let next = withEvent(waiting, "SUCCESSOR_REJECTED", { ...facts, selectionState: selection?.state ?? null, code: selection?.code ?? null, rejections: selection?.rejections ?? [] });
    return withEvent(next, selection?.state === ROLLOVER_STATES.HALTED ? "ROLLOVER_HALTED" : "WAITING_FOR_SUCCESSOR", { ...facts, selectionState: selection?.state ?? null, rejections: selection?.rejections ?? [] });
  }
  const selected = clone(selection.selected);
  let next = { ...state, state: ROLLOVER_STATES.SUCCESSOR_FOUND, successor: selected };
  next = withEvent(next, "SUCCESSOR_CANDIDATE_FOUND", { ...facts, marketId: selected.marketId, candidatesConsidered: selection.candidatesConsidered });
  if (selection.rejections?.length) next = withEvent(next, "SUCCESSOR_REJECTED", { ...facts, count: selection.rejections.length, rejections: selection.rejections });
  return withEvent(next, "SUCCESSOR_CONFIRMED", { marketId: selected.marketId, expirySec: selected.expirySec, series: seriesIdentity(selected.market) });
}

/** Replace market-scoped fields while carrying wallet/strategy/history forward. */
export function initializeSuccessor(state, successorContext, { underlyingHistory = state.underlyingHistory } = {}) {
  if (state?.state !== ROLLOVER_STATES.SUCCESSOR_FOUND) fail("STATE_INVALID", "successor initialization requires SUCCESSOR_FOUND");
  if (!successorContext?.marketId) fail("SUCCESSOR_INVALID", "successor context is required");
  const proof = compareMarketContexts(state.currentContext, successorContext);
  if (!proof.marketIdChanged || !proof.expiryAdvanced || !proof.sameSeries || !proof.intervalSame) fail("SUCCESSOR_INVALID", "successor does not prove a later window in the same series");
  const marketScope = {
    ...emptyMarketScope(),
    marketId: successorContext.marketId,
    yesId: successorContext.yesId,
    noId: successorContext.noId,
    reference: clone(successorContext.reference),
    expirySec: successorContext.expirySec,
    status: successorContext.status,
  };
  let next = {
    ...state,
    state: ROLLOVER_STATES.INITIALIZING_SUCCESSOR,
    activeMarketId: successorContext.marketId,
    activeContext: clone(successorContext),
    marketScope,
    underlyingHistory: clone(underlyingHistory),
  };
  return withEvent(next, "MARKET_CONTEXT_INITIALIZED", { marketId: successorContext.marketId, reset: ["reference", "expirySec", "yesId", "noId", "openOrderIds", "inventory", "pendingExposure", "quotePlan"] });
}

function decisionTimeMatches(context, decision, chainNowSec, label) {
  const expected = finite(context.expirySec, `${label} expiry`) - finite(chainNowSec, "chainNowSec");
  const actual = decision?.timeRemainingSec ?? decision?.authoritativeTime?.timeRemainingSec;
  if (actual !== undefined && actual !== null && Math.abs(finite(actual, `${label} timeRemainingSec`) - expected) > 1) fail("STALE_MARKET_TIME", `${label} decision uses a different market expiry`);
  return expected;
}

/** Evaluate the fresh B pipeline without turning a HALT/NO_QUOTE into fallback. */
export function evaluateSuccessor(state, { reference, fairValue, riskDecision, quotePlan, inventory, pendingOrders = [], chainNowSec, decisionSnapshotId = null } = {}) {
  if (state?.state !== ROLLOVER_STATES.INITIALIZING_SUCCESSOR) fail("STATE_INVALID", "successor evaluation requires INITIALIZING_SUCCESSOR");
  const context = state.activeContext;
  if (!context) fail("SUCCESSOR_INVALID", "active successor context is missing");
  const nextReference = reference ?? context.reference;
  if (!nextReference || (nextReference.marketId !== undefined && idKey(nextReference.marketId) !== idKey(context.marketId))) fail("REFERENCE_SCOPE_MISMATCH", "B reference is missing or belongs to A");
  if (nextReference === state.currentContext.reference) fail("REFERENCE_SCOPE_MISMATCH", "A reference object cannot be reused for B");
  const expectedTime = decisionTimeMatches(context, fairValue, chainNowSec, "fair value");
  decisionTimeMatches(context, riskDecision, chainNowSec, "risk");
  const decision = riskDecision ?? { state: "HALT", primaryReasonCode: "RISK_MISSING" };
  const plan = quotePlan ?? { plan: "NO_QUOTE", marketId: context.marketId, reasonCodes: ["QUOTE_MISSING"] };
  if (plan.marketId !== undefined && plan.marketId !== null && idKey(plan.marketId) !== idKey(context.marketId)) fail("STALE_PLAN_MARKET", "quote plan belongs to a different market");
  const contextInventory = inventory ?? null;
  let next = {
    ...state,
    marketScope: {
      ...state.marketScope,
      reference: clone({ ...nextReference, marketId: context.marketId }),
      status: context.status,
      openOrderIds: pendingOrders.map((order) => String(order.id ?? order.orderId)),
      inventory: clone(contextInventory),
      pendingExposure: clone(pendingOrders),
      quotePlan: clone(plan),
      decisionSnapshotId,
    },
    evaluation: {
      fairValue: clone(fairValue),
      riskDecision: clone(decision),
      quotePlan: clone(plan),
      expectedTimeRemainingSec: expectedTime,
    },
    haltReason: decision.state === "HALT" ? decision.primaryReasonCode ?? "GOVERNOR_HALT" : null,
  };
  next = withEvent(next, "REFERENCE_RESOLVED", { marketId: context.marketId, source: nextReference.source ?? nextReference.kind ?? null });
  next = withEvent(next, "ROLLOVER_FAIR_VALUE_CALCULATED", { marketId: context.marketId, modelVersion: fairValue?.modelVersion ?? null, pUp: fairValue?.pUp ?? null });
  next = withEvent(next, "ROLLOVER_GOVERNOR_EVALUATED", { marketId: context.marketId, state: decision.state ?? "HALT", primaryReasonCode: decision.primaryReasonCode ?? null });
  next = withEvent(next, "ROLLOVER_QUOTE_PLANNED", { marketId: context.marketId, plan: plan.plan ?? "NO_QUOTE" });
  if (decision.state === "HALT" || fairValue?.valid === false || fairValue?.dataQualityStatus === "LOW") {
    next = { ...next, state: ROLLOVER_STATES.HALTED };
    return withEvent(next, "ROLLOVER_HALTED", { marketId: context.marketId, reason: next.haltReason ?? "DATA_NOT_READY" });
  }
  next = { ...next, state: ROLLOVER_STATES.SUCCESSOR_READY };
  return withEvent(next, "ROLLOVER_READY", { marketId: context.marketId, quotePlan: plan.plan ?? "NO_QUOTE" });
}

export function assertPlanMarketBound(plan, marketId) {
  if (!plan || plan.marketId === undefined || plan.marketId === null) fail("STALE_PLAN_MARKET", "quote plan has no marketId binding");
  if (idKey(plan.marketId) !== idKey(marketId)) fail("STALE_PLAN_MARKET", "quote plan marketId does not match active market");
  return true;
}

export function assertExecutionSessionBound(session, marketId) {
  if (!session || session.marketId === undefined || session.marketId === null) fail("SESSION_SCOPE_MISMATCH", "execution session has no marketId binding");
  if (idKey(session.marketId) !== idKey(marketId)) fail("SESSION_SCOPE_MISMATCH", "execution session is bound to a different market");
  return true;
}

export function stateScopeAudit(state) {
  return {
    market: clone(state?.marketScope ?? emptyMarketScope()),
    wallet: clone(state?.walletState ?? {}),
    strategy: clone(state?.strategyState ?? {}),
    underlying: {
      policy: UNDERLYING_HISTORY_POLICY,
      retainedCount: Array.isArray(state?.underlyingHistory) ? state.underlyingHistory.length : 0,
    },
    settlementHistoryMarketIds: (state?.settlementHistory ?? []).map((context) => context.marketId),
  };
}
