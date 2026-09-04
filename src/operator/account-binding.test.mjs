import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createOnChainAccountVerifier } from "./account-binding.mjs";

const OWNER = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OPERATOR = "0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37";

async function fixture(identityPatch = {}, code = null) {
  const artifact = JSON.parse(await fs.readFile(new URL("../../dashboard/villa-account-artifact.json", import.meta.url), "utf8"));
  const identity = {
    account: ACCOUNT,
    owner: OWNER,
    operator: OPERATOR,
    collateralToken: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
    outcomeToken: "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9",
    binaryModule: "0x3ecC694Cef705358864a646142ac17A90E29e388",
    binarySettlement: "0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23",
    ...identityPatch,
  };
  return createOnChainAccountVerifier({
    env: { VILLA_ENGINE_OPERATOR: OPERATOR },
    artifactLoader: async () => artifact,
    publicClient: { async getBytecode() { return code ?? artifact.runtimeBytecode; } },
    identityReader: { async readAccountIdentity() { return identity; } },
  });
}

async function v1Fixture(identityPatch = {}) {
  const v2 = JSON.parse(await fs.readFile(new URL("../../dashboard/villa-account-artifact.json", import.meta.url), "utf8"));
  const v1 = JSON.parse(await fs.readFile(new URL("../../dashboard/villa-account-artifact-v1.json", import.meta.url), "utf8"));
  const identity = {
    account: ACCOUNT,
    owner: OWNER,
    operator: OPERATOR,
    collateralToken: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
    outcomeToken: "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9",
    binaryModule: "0x3ecC694Cef705358864a646142ac17A90E29e388",
    binarySettlement: "0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23",
    ...identityPatch,
  };
  return createOnChainAccountVerifier({
    env: { VILLA_ENGINE_OPERATOR: OPERATOR },
    artifactLoader: async () => ({ ...v2, v2, v1 }),
    publicClient: { async getBytecode() { return v1.runtimeBytecode; } },
    identityReader: { async readAccountIdentity() { return identity; } },
  });
}

test("on-chain verifier accepts only the audited VillaAccount and its owner/operator wiring", async () => {
  const verify = await fixture();
  const result = await verify({ caller: OWNER, account: ACCOUNT });
  assert.equal(result.account, ACCOUNT);
  assert.equal(result.owner, OWNER);
  assert.equal(result.operator, OPERATOR.toLowerCase());
  assert.equal(result.accountVersion, 2);
  assert.equal(result.version, 2);
  assert.equal(result.identity.accountVersion, 2);
  assert.equal(result.runtimeVerified, true);
});

test("on-chain verifier rejects wrong runtime, owner, operator, and contract wiring", async () => {
  await assert.rejects(() => fixture({}, "0x6000").then((verify) => verify({ caller: OWNER, account: ACCOUNT })), { code: "ACCOUNT_INVALID" });
  await assert.rejects(() => fixture({ owner: "0x2222222222222222222222222222222222222222" }).then((verify) => verify({ caller: OWNER, account: ACCOUNT })), { code: "OWNER_SCOPE_MISMATCH" });
  await assert.rejects(() => fixture({ operator: "0x3333333333333333333333333333333333333333" }).then((verify) => verify({ caller: OWNER, account: ACCOUNT })), { code: "OPERATOR_NOT_AUTHORIZED" });
  await assert.rejects(() => fixture({ binaryModule: "0x3333333333333333333333333333333333333333" }).then((verify) => verify({ caller: OWNER, account: ACCOUNT })), { code: "ACCOUNT_WIRING_MISMATCH" });
});

test("recovery verification can prove owner and wiring without granting operator authorization", async () => {
  const verify = await fixture({ operator: "0x3333333333333333333333333333333333333333" });
  const result = await verify({ caller: OWNER, account: ACCOUNT, requireOperator: false });
  assert.equal(result.operatorAuthorized, false);
  assert.equal(result.runtimeVerified, true);
  assert.equal(result.identity.operatorAuthorized, false);
});

test("verifier recognizes the trusted V1 runtime while preserving owner and wiring checks", async () => {
  const verify = await v1Fixture();
  const result = await verify({ caller: OWNER, account: ACCOUNT });
  assert.equal(result.runtimeVerified, true);
  assert.equal(result.operatorAuthorized, true);
  assert.equal(result.accountVersion, 1);
  assert.equal(result.version, 1);
  assert.equal(result.identity.accountVersion, 1);
  assert.equal(result.identity.autonomousTradingEnabled, false);
});

test("verifier rejects a tampered trusted artifact before reading account identity", async () => {
  const artifact = JSON.parse(await fs.readFile(new URL("../../dashboard/villa-account-artifact.json", import.meta.url), "utf8"));
  let identityReaderCalled = false;
  const verify = createOnChainAccountVerifier({
    env: { VILLA_ENGINE_OPERATOR: OPERATOR },
    artifactLoader: async () => ({ ...artifact, runtimeBytecode: "0x6000" }),
    publicClient: { async getBytecode() { return artifact.runtimeBytecode; } },
    identityReader: { async readAccountIdentity() { identityReaderCalled = true; return {}; } },
  });
  await assert.rejects(() => verify({ caller: OWNER, account: ACCOUNT }), { code: "ACCOUNT_VERIFICATION_UNAVAILABLE" });
  assert.equal(identityReaderCalled, false);
});

test("verifier defaults to VILLA_CHAIN.rpcUrl when env.RPC_URL is omitted", async () => {
  const verifier = createOnChainAccountVerifier({
    env: { VILLA_ENGINE_OPERATOR: OPERATOR },
  });
  assert.ok(typeof verifier === "function");
});

test("verifier throws explicit configuration error if RPC URL is completely empty", async () => {
  assert.throws(
    () => createOnChainAccountVerifier({
      env: { VILLA_ENGINE_OPERATOR: OPERATOR, RPC_URL: " " },
      artifactLoader: async () => ({}),
    }),
    { code: "ACCOUNT_VERIFICATION_UNAVAILABLE", message: "No Shannon RPC URL configured for account verification." }
  );
});

test("undeployed address fails closed with ACCOUNT_INVALID 403 without invoking identity reader", async () => {
  let identityReaderCalled = false;
  const artifact = JSON.parse(await fs.readFile(new URL("../../dashboard/villa-account-artifact.json", import.meta.url), "utf8"));
  const verify = createOnChainAccountVerifier({
    env: { VILLA_ENGINE_OPERATOR: OPERATOR },
    artifactLoader: async () => artifact,
    publicClient: { async getBytecode() { return undefined; } },
    identityReader: {
      async readAccountIdentity() {
        identityReaderCalled = true;
        throw new Error("identityReader must not be called for undeployed account");
      },
    },
  });

  await assert.rejects(
    () => verify({ caller: OWNER, account: ACCOUNT }),
    { code: "ACCOUNT_INVALID", status: 403 }
  );
  assert.equal(identityReaderCalled, false);
});
