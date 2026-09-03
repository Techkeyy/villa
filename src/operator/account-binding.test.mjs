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

test("on-chain verifier accepts only the audited VillaAccount and its owner/operator wiring", async () => {
  const verify = await fixture();
  const result = await verify({ caller: OWNER, account: ACCOUNT });
  assert.equal(result.account, ACCOUNT);
  assert.equal(result.owner, OWNER);
  assert.equal(result.operator, OPERATOR.toLowerCase());
  assert.equal(result.runtimeVerified, true);
});

test("on-chain verifier rejects wrong runtime, owner, operator, and contract wiring", async () => {
  await assert.rejects(() => fixture({}, "0x6000").then((verify) => verify({ caller: OWNER, account: ACCOUNT })), { code: "ACCOUNT_INVALID" });
  await assert.rejects(() => fixture({ owner: "0x2222222222222222222222222222222222222222" }).then((verify) => verify({ caller: OWNER, account: ACCOUNT })), { code: "OWNER_SCOPE_MISMATCH" });
  await assert.rejects(() => fixture({ operator: "0x3333333333333333333333333333333333333333" }).then((verify) => verify({ caller: OWNER, account: ACCOUNT })), { code: "OPERATOR_NOT_AUTHORIZED" });
  await assert.rejects(() => fixture({ binaryModule: "0x3333333333333333333333333333333333333333" }).then((verify) => verify({ caller: OWNER, account: ACCOUNT })), { code: "ACCOUNT_WIRING_MISMATCH" });
});
