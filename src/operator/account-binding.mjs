import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, isAddress } from "viem";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { VILLA_ACCOUNT_CONFIG } from "../../dashboard/account-config.mjs";
import { runtimeBytecodeMatches } from "../../dashboard/account-client.mjs";
import { createViemLpAccountReader } from "../execution/lp-adapter.mjs";
import { AccountControlError } from "./account-control.mjs";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ARTIFACT_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dashboard/villa-account-artifact.json");
const VILLA_ACCOUNT_CONFIG_CHAIN_ID = 50312;

function address(value, label) {
  const text = String(value ?? "");
  if (!ADDRESS_RE.test(text) || !isAddress(text)) throw new AccountControlError("ACCOUNT_BINDING_INVALID", `${label} is not a valid address`, 400);
  return text.toLowerCase();
}

function same(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

async function readTrustedArtifact() {
  try {
    return JSON.parse(await fs.readFile(ARTIFACT_PATH, "utf8"));
  } catch (error) {
    throw new AccountControlError("ACCOUNT_VERIFICATION_UNAVAILABLE", "The verified VILLA account implementation is unavailable.", 503, { cause: error?.code ?? "ARTIFACT_READ_FAILED" });
  }
}

function assertTrustedArtifact(artifact) {
  if (artifact?.schema !== "villa-browser-account-artifact-v2"
    || Number(artifact.chainId) !== VILLA_ACCOUNT_CONFIG_CHAIN_ID
    || typeof artifact.runtimeBytecode !== "string"
    || !Array.isArray(artifact.runtimeImmutableReferences)
    || artifact.runtimeImmutableReferences.length === 0) {
    throw new AccountControlError("ACCOUNT_VERIFICATION_UNAVAILABLE", "The verified VILLA account implementation failed its integrity metadata check.", 503);
  }
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
  const rpcUrl = String(env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl);
  const expectedOperator = address(env.VILLA_ENGINE_OPERATOR || env.OPERATOR_ADDRESS || VILLA_ACCOUNT_CONFIG.operator, "canonical VILLA operator");
  const client = publicClient ?? createPublicClient({ chain: somniaShannon, transport: http(rpcUrl, { timeout: 15_000 }) });
  const reader = identityReader ?? createViemLpAccountReader({ publicClient: client });

  return async function verifyAccountBinding({ caller, account } = {}) {
    const owner = address(caller, "authenticated owner");
    const target = address(account, "VillaAccount");
    if (same(owner, target) || same(owner, expectedOperator) || same(target, expectedOperator)) {
      throw new AccountControlError("ACCOUNT_IDENTITY_COLLISION", "The owner, VillaAccount, and VILLA operator must remain distinct.", 403);
    }

    let artifact;
    let code;
    let identity;
    try {
      artifact = await artifactLoader();
      assertTrustedArtifact(artifact);
      if (typeof client.getBytecode !== "function") throw new Error("getBytecode is unavailable");
      code = await client.getBytecode({ address: target });
      identity = await reader.readAccountIdentity({ account: target });
    } catch (error) {
      if (error instanceof AccountControlError) throw error;
      throw new AccountControlError("ACCOUNT_VERIFICATION_UNAVAILABLE", "The VILLA account could not be verified on Shannon.", 503, { cause: error?.code ?? "READ_FAILED" });
    }

    if (!runtimeBytecodeMatches(code, artifact.runtimeBytecode, artifact.runtimeImmutableReferences)) {
      throw new AccountControlError("ACCOUNT_INVALID", "The selected address is not a verified VILLA account.", 403);
    }
    if (!same(identity?.owner, owner)) {
      throw new AccountControlError("OWNER_SCOPE_MISMATCH", "The authenticated wallet is not the owner of this VillaAccount.", 403);
    }
    if (!same(identity?.operator, expectedOperator)) {
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
      identity: Object.freeze({ ...identity, account: target, owner, operator: expectedOperator, runtimeVerified: true }),
      runtimeVerified: true,
      onChain: true,
    });
  };
}
