import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, isAddress } from "viem";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { VILLA_ACCOUNT_CONFIG, VILLA_CHAIN } from "../../dashboard/account-config.mjs";
import { runtimeBytecodeMatches } from "../../dashboard/account-client.mjs";
import { createViemLpAccountReader } from "../execution/lp-adapter.mjs";
import { AccountControlError } from "./account-control.mjs";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ARTIFACT_PATH = fileURLToPath(new URL("../../dashboard/villa-account-artifact.json", import.meta.url));
const ARTIFACT_V1_PATH = fileURLToPath(new URL("../../dashboard/villa-account-artifact-v1.json", import.meta.url));
const VILLA_ACCOUNT_CONFIG_CHAIN_ID = 50312;

function address(value, label) {
  const text = String(value ?? "");
  if (!ADDRESS_RE.test(text) || !isAddress(text)) throw new AccountControlError("ACCOUNT_BINDING_INVALID", `${label} is not a valid address`, 400);
  return text.toLowerCase();
}

function same(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function bytecodeHash(bytecode) {
  const text = String(bytecode ?? "");
  if (!/^0x[0-9a-fA-F]*$/.test(text) || text.length % 2 !== 0) return "";
  return crypto.createHash("sha256").update(Buffer.from(text.slice(2), "hex")).digest("hex");
}

async function readTrustedArtifact() {
  try {
    const v2 = JSON.parse(await fs.readFile(ARTIFACT_PATH, "utf8"));
    let v1 = null;
    try {
      v1 = JSON.parse(await fs.readFile(ARTIFACT_V1_PATH, "utf8"));
    } catch {}
    return { ...v2, accountVersion: 2, v2: { ...v2, accountVersion: 2 }, v1: v1 ? { ...v1, accountVersion: 1 } : null };
  } catch (error) {
    throw new AccountControlError("ACCOUNT_VERIFICATION_UNAVAILABLE", "The verified VILLA account implementation is unavailable.", 503, { cause: error?.code ?? "ARTIFACT_READ_FAILED" });
  }
}

function assertTrustedArtifact(artifact) {
  const primary = artifact.v2 || artifact;
  if (primary?.schema !== "villa-browser-account-artifact-v2"
    || Number(primary.chainId) !== VILLA_ACCOUNT_CONFIG_CHAIN_ID
    || typeof primary.creationBytecode !== "string"
    || typeof primary.runtimeBytecode !== "string"
    || !Array.isArray(primary.runtimeImmutableReferences)
    || primary.runtimeImmutableReferences.length === 0) {
    throw new AccountControlError("ACCOUNT_VERIFICATION_UNAVAILABLE", "The verified VILLA account implementation failed its integrity metadata check.", 503);
  }
  if (bytecodeHash(primary.creationBytecode) !== VILLA_ACCOUNT_CONFIG.artifactCreationSha256
    || bytecodeHash(primary.runtimeBytecode) !== VILLA_ACCOUNT_CONFIG.artifactRuntimeSha256) {
    throw new AccountControlError("ACCOUNT_VERIFICATION_UNAVAILABLE", "The verified VILLA account implementation failed its audited bytecode check.", 503);
  }
  if (artifact.v1) {
    const legacy = artifact.v1;
    if (legacy.schema !== "villa-browser-account-artifact-v2"
      || Number(legacy.chainId) !== VILLA_ACCOUNT_CONFIG_CHAIN_ID
      || typeof legacy.creationBytecode !== "string"
      || typeof legacy.runtimeBytecode !== "string"
      || !Array.isArray(legacy.runtimeImmutableReferences)
      || legacy.runtimeImmutableReferences.length === 0
      || bytecodeHash(legacy.creationBytecode) !== VILLA_ACCOUNT_CONFIG.legacyV1CreationSha256
      || bytecodeHash(legacy.runtimeBytecode) !== VILLA_ACCOUNT_CONFIG.legacyV1RuntimeSha256) {
      throw new AccountControlError("ACCOUNT_VERIFICATION_UNAVAILABLE", "The legacy VILLA account implementation failed its audited bytecode check.", 503);
    }
  }
}

function matchesAnyArtifact(code, artifact) {
  if (!code) return null;
  const primary = artifact.v2 || artifact;
  if (primary && runtimeBytecodeMatches(code, primary.runtimeBytecode, primary.runtimeImmutableReferences)) {
    return 2;
  }
  if (artifact.v1 && runtimeBytecodeMatches(code, artifact.v1.runtimeBytecode, artifact.v1.runtimeImmutableReferences)) {
    return 1;
  }
  return null;
}

/**
 * Build a read-only server verifier for the account selector supplied by an
 * authenticated wallet. It proves the exact deployed VillaAccount runtime,
 * owner, canonical operator, and Shannon contract wiring before control.
 */
export function createOnChainAccountVerifier({
  env = process.env,
  publicClient = null,
  identityReader = null,
  artifactLoader = readTrustedArtifact,
} = {}) {
  const rpcUrl = String(
    env.RPC_URL ||
    VILLA_CHAIN.rpcUrl ||
    VILLA_ACCOUNT_CONFIG.rpcUrl ||
    ""
  ).trim();
  if (!rpcUrl) throw new AccountControlError("ACCOUNT_VERIFICATION_UNAVAILABLE", "No Shannon RPC URL configured for account verification.", 500);
  const expectedOperator = address(env.VILLA_ENGINE_OPERATOR || env.OPERATOR_ADDRESS || VILLA_ACCOUNT_CONFIG.operator, "canonical VILLA operator");
  const client = publicClient ?? createPublicClient({ chain: somniaShannon, transport: http(rpcUrl, { timeout: 15_000 }) });
  const reader = identityReader ?? createViemLpAccountReader({ publicClient: client });

  return async function verifyAccountBinding({ caller, account, requireOperator = true } = {}) {
    const owner = address(caller, "authenticated owner");
    const target = address(account, "VillaAccount");
    if (same(owner, target) || same(owner, expectedOperator) || same(target, expectedOperator)) {
      throw new AccountControlError("ACCOUNT_IDENTITY_COLLISION", "The owner, VillaAccount, and VILLA operator must remain distinct.", 403);
    }

    let artifact;
    let code;
    try {
      artifact = await artifactLoader();
      assertTrustedArtifact(artifact);
      if (typeof client.getBytecode !== "function") throw new Error("getBytecode is unavailable");
      code = await client.getBytecode({ address: target });
    } catch (error) {
      if (error instanceof AccountControlError) throw error;
      throw new AccountControlError("ACCOUNT_VERIFICATION_UNAVAILABLE", "The VILLA account could not be verified on Shannon.", 503, { cause: error?.code ?? "READ_FAILED" });
    }

    const accountVersion = matchesAnyArtifact(code, artifact);
    if (!accountVersion) {
      throw new AccountControlError("ACCOUNT_INVALID", "The selected address is not a verified VILLA account.", 403);
    }

    let identity;
    try {
      identity = await reader.readAccountIdentity({ account: target });
    } catch (error) {
      if (error instanceof AccountControlError) throw error;
      throw new AccountControlError("ACCOUNT_VERIFICATION_UNAVAILABLE", "The VILLA account could not be verified on Shannon.", 503, { cause: error?.code ?? "READ_FAILED" });
    }

    if (matchesAnyArtifact(code, artifact) !== accountVersion) {
      throw new AccountControlError("ACCOUNT_INVALID", "The selected address is not a verified VILLA account.", 403);
    }
    if (!same(identity?.owner, owner)) {
      throw new AccountControlError("OWNER_SCOPE_MISMATCH", "The authenticated wallet is not the owner of this VillaAccount.", 403);
    }
    const operatorAuthorized = same(identity?.operator, expectedOperator);
    if (requireOperator && !operatorAuthorized) {
      throw new AccountControlError("OPERATOR_NOT_AUTHORIZED", "The canonical VILLA operator is not authorized for this VillaAccount.", 403);
    }
    const wiring = {
      collateralToken: VILLA_ACCOUNT_CONFIG.collateralToken,
      outcomeToken: VILLA_ACCOUNT_CONFIG.outcomeToken,
      binaryModule: VILLA_ACCOUNT_CONFIG.binaryModule,
      binarySettlement: VILLA_ACCOUNT_CONFIG.binarySettlement,
    };
    for (const [name, expected] of Object.entries(wiring)) {
      if (!same(identity?.[name], expected)) throw new AccountControlError("ACCOUNT_WIRING_MISMATCH", `The VillaAccount ${name} does not match the trusted Shannon configuration.`, 403);
    }
    return Object.freeze({
      account: target,
      owner,
      operator: expectedOperator,
      accountVersion,
      version: accountVersion,
      identity: Object.freeze({ ...identity, account: target, owner, accountVersion, version: accountVersion, actualOperator: identity?.operator ?? null, operator: expectedOperator, operatorAuthorized, autonomousTradingEnabled: accountVersion === 2 && identity?.autonomousTradingEnabled === true, runtimeVerified: true }),
      runtimeVerified: true,
      onChain: true,
      operatorAuthorized,
    });
  };
}
