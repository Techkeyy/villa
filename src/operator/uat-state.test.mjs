import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistPrivateUatState, persistUatState } from "./uat-state.mjs";

test("UAT state persistence writes only public lifecycle facts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "villa-uat-state-"));
  const file = path.join(directory, "session.json");
  persistUatState(file, { type: "state", state: "RUNNING", session: { account: "0x1111111111111111111111111111111111111111" }, secret: "never-persist" });
  persistUatState(file, { type: "snapshot", snapshot: { marketId: "0x" + "a".repeat(64), collateralRaw: 1002000n, openOrders: [], signer: "never-persist", privateKey: "never-persist" } });
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(state.state, "RUNNING");
  assert.equal(state.snapshot.collateralRaw, "1002000");
  assert.equal(JSON.stringify(state).includes("never-persist"), false);
  assert.equal("secret" in state, false);
  await fs.rm(directory, { recursive: true, force: true });
});

test("private lifecycle state is separate from the public status file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "villa-uat-private-state-"));
  const statusFile = path.join(directory, "status", "session.json");
  const privateFile = path.join(directory, "private", "session.json");
  const message = { type: "state", state: "STOPPING", session: { account: "0x1111111111111111111111111111111111111111" }, snapshot: { marketId: "0x" + "b".repeat(64), trackedYesRaw: 1000n, trackedNoRaw: 1000n } };
  persistUatState(statusFile, message);
  persistPrivateUatState(privateFile, message);
  const status = JSON.parse(await fs.readFile(statusFile, "utf8"));
  const privateState = JSON.parse(await fs.readFile(privateFile, "utf8"));
  assert.deepEqual({ ...status, updatedAt: 0 }, { ...privateState, updatedAt: 0 });
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(statusFile)).mode & 0o777, 0o640);
    assert.equal((await fs.stat(privateFile)).mode & 0o777, 0o600);
  }
  await fs.rm(directory, { recursive: true, force: true });
});
