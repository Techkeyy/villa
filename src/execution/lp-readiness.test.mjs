import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLpExecutionReadiness, LP_READINESS_VERSION } from "./lp-readiness.mjs";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OWNER = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";
const MARKET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function base(overrides = {}) {
  return {
    chain: { id: 50312 },
    account: { address: ACCOUNT, owner: OWNER, operator: OPERATOR, runtimeVerified: true },
    owner: { address: OWNER, verified: true },
    operator: { configuredAddress: OPERATOR, signerAddress: OPERATOR },
    market: { marketId: MARKET, currentMarketId: MARKET, valid: true, current: true },
    permissions: { requiresMarketApproval: true, marketApproved: true, requiresProtocolApproval: true, protocolPrepared: true },
    capital: { collateralRaw: 2_000_000n },
    riskLimits: { valid: true },
    executionConfig: { mode: "SHADOW", minimumCollateralRaw: 1_000_000n },
    ...overrides,
  };
}

test("authorized operator with every precondition passes readiness", () => {
  const result = evaluateLpExecutionReadiness(base());
  assert.equal(result.version, LP_READINESS_VERSION);
  assert.equal(result.ready, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.orderOwner, ACCOUNT);
  assert.equal(result.broadcastDisabled, true);
});

test("zero operator and zero capital make the real Phase 2 account unavailable", () => {
  const result = evaluateLpExecutionReadiness(base({ account: { ...base().account, operator: "0x0000000000000000000000000000000000000000" }, capital: { collateralRaw: 0n } }));
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes("OPERATOR_NOT_AUTHORIZED"));
  assert.ok(result.reasons.includes("INSUFFICIENT_CAPITAL"));
});

test("readiness rejects stale market identity", () => {
  const result = evaluateLpExecutionReadiness(base({ market: { ...base().market, currentMarketId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } }));
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes("STALE_MARKET_ID"));
});

test("readiness rejects wrong chain, wrong signer, and owner mismatch", () => {
  const result = evaluateLpExecutionReadiness(base({ chain: { id: 1 }, operator: { configuredAddress: OPERATOR, signerAddress: OWNER }, account: { ...base().account, owner: OPERATOR } }));
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes("CHAIN_UNSUPPORTED"));
  assert.ok(result.reasons.includes("SIGNER_MISMATCH"));
  assert.ok(result.reasons.includes("OWNER_MISMATCH"));
});

test("readiness requires owner market and protocol permissions", () => {
  const result = evaluateLpExecutionReadiness(base({ permissions: { requiresMarketApproval: true, marketApproved: false, requiresProtocolApproval: true, protocolPrepared: false } }));
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes("MARKET_NOT_APPROVED"));
  assert.ok(result.reasons.includes("PROTOCOL_APPROVAL_MISSING"));
});

test("readiness rejects risk halt, active second session, and non-shadow mode", () => {
  const result = evaluateLpExecutionReadiness(base({ risk: { state: "HALT" }, executionConfig: { mode: "LIVE", minimumCollateralRaw: 1n, sessionActive: true } }));
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes("RISK_HALTED"));
  assert.ok(result.reasons.includes("ENGINE_SESSION_ACTIVE"));
  assert.ok(result.reasons.includes("EXECUTION_MODE_INVALID"));
});

test("missing market is explicit rather than silently treated as current", () => {
  const result = evaluateLpExecutionReadiness(base({ market: null }));
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes("MARKET_NOT_SELECTED"));
});
