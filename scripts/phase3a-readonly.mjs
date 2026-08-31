/**
 * Phase 3A live read-only fixture check.
 *
 * This script intentionally does not load .env, create a wallet client, or
 * import a signer. It verifies the real Phase 2 account through public RPC and
 * evaluates the shadow readiness result.
 */

import { readFile } from "node:fs/promises";
import { createPublicClient, http } from "viem";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { VILLA_ACCOUNT_CONFIG, MIN_DEPOSIT_RAW, ZERO_ADDRESS } from "../dashboard/account-config.mjs";
import { runtimeBytecodeMatches } from "../dashboard/account-client.mjs";
import { createLpExecutionAdapter } from "../src/execution/lp-adapter.mjs";
import { evaluateLpExecutionReadiness } from "../src/execution/lp-readiness.mjs";
import { createViemLpAccountReader } from "../src/execution/lp-adapter.mjs";

const ACCOUNT = "0xFc9dbf0a8468aA56799b4e23B1EBe936426eE30b";
const OWNER = "0xCc67779F8eDb2C80DC665775C5597657C512FE1A";
const RPC_URL = process.env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl || "https://dream-rpc.somnia.network";

const publicClient = createPublicClient({ chain: somniaShannon, transport: http(RPC_URL, { timeout: 15_000 }) });
const artifact = JSON.parse(await readFile("dashboard/villa-account-artifact.json", "utf8"));
const reader = createViemLpAccountReader({ publicClient });
const adapter = createLpExecutionAdapter({ account: ACCOUNT, owner: OWNER, operator: VILLA_ACCOUNT_CONFIG.operator, reader });
const identity = await adapter.readAccountIdentity();
const capital = await adapter.readCapital();
const code = await publicClient.getBytecode({ address: ACCOUNT });
const runtimeVerified = Boolean(code && runtimeBytecodeMatches(code, artifact.runtimeBytecode, artifact.runtimeImmutableReferences));
const chainId = await publicClient.getChainId();
const readiness = evaluateLpExecutionReadiness({
  chain: { id: chainId },
  account: { address: ACCOUNT, owner: identity.owner, operator: identity.operator, runtimeVerified },
  owner: { address: OWNER, verified: identity.owner.toLowerCase() === OWNER.toLowerCase() },
  operator: { configuredAddress: VILLA_ACCOUNT_CONFIG.operator, signerAddress: VILLA_ACCOUNT_CONFIG.operator },
  capital: { collateralRaw: capital.directCollateralRaw },
  permissions: { requiresMarketApproval: false, requiresProtocolApproval: false },
  riskLimits: { valid: true },
  executionConfig: { mode: "SHADOW", minimumCollateralRaw: MIN_DEPOSIT_RAW },
});

if (identity.owner.toLowerCase() !== OWNER.toLowerCase()) throw new Error("Phase 2 account owner mismatch");
if (identity.operator.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) throw new Error("Phase 2 account is unexpectedly authorized");
if (capital.directCollateralRaw !== 0n) throw new Error(`Phase 2 account collateral is not zero: ${capital.directCollateralRaw}`);
if (!runtimeVerified) throw new Error("Phase 2 account runtime does not match the pinned VillaAccount artifact");
if (readiness.ready) throw new Error("zero-capital, revoked Phase 2 account unexpectedly passed execution readiness");

console.log(JSON.stringify({
  result: "PASS",
  mode: adapter.executionMode,
  chainId,
  account: ACCOUNT,
  owner: identity.owner,
  currentOperator: identity.operator,
  configuredOperator: VILLA_ACCOUNT_CONFIG.operator,
  runtimeVerified,
  directCollateralRaw: capital.directCollateralRaw.toString(),
  readiness: { ready: readiness.ready, reasons: readiness.reasons },
  broadcastDisabled: readiness.broadcastDisabled,
}, null, 2));
