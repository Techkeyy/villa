import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createOperatorAuth, OperatorAuthError } from "./auth.mjs";

test("invalid nonce and signature are rejected", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const auth = createOperatorAuth({ authorizedAddress: account.address });
  const issued = auth.issueNonce(account.address);
  await assert.rejects(auth.verify({ ...issued, nonce: "wrong", signature: "0x1234" }), (error) => error instanceof OperatorAuthError && error.code === "NONCE_INVALID");
  await assert.rejects(auth.verify({ ...issued, signature: "0x1234" }), (error) => error instanceof OperatorAuthError && error.code === "SIGNATURE_INVALID");
});

test("authorized wallet signature creates a short-lived session", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const auth = createOperatorAuth({ authorizedAddress: account.address });
  const issued = auth.issueNonce(account.address);
  const signature = await account.signMessage({ message: issued.message });
  const session = await auth.verify({ ...issued, signature });
  assert.equal(session.operatorAddress, account.address);
  assert.equal(auth.authenticate(session.token).address, account.address);
  await assert.rejects(auth.verify({ ...issued, signature }), /already used/);
});

test("a different wallet cannot authenticate as the operator", async () => {
  const authorized = privateKeyToAccount(generatePrivateKey());
  const visitor = privateKeyToAccount(generatePrivateKey());
  const auth = createOperatorAuth({ authorizedAddress: authorized.address });
  const issued = auth.issueNonce(visitor.address);
  const signature = await visitor.signMessage({ message: issued.message });
  await assert.rejects(auth.verify({ ...issued, signature }), (error) => error.code === "OPERATOR_UNAUTHORIZED");
});

test("expired sessions are rejected without exposing token material", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  let timestamp = 1_000;
  const auth = createOperatorAuth({ authorizedAddress: account.address, now: () => timestamp, sessionTtlMs: 100 });
  const issued = auth.issueNonce(account.address);
  const signature = await account.signMessage({ message: issued.message });
  const session = await auth.verify({ ...issued, signature });
  assert.equal(auth.authenticate(session.token).address, account.address);
  timestamp = 1_101;
  assert.equal(auth.authenticate(session.token), null);
  assert.equal(JSON.stringify(session).includes("PRIVATE_KEY"), false);
});
