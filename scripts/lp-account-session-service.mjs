/**
 * systemd entrypoint for the private UAT worker.
 *
 * systemd signals this small parent; the parent forwards a typed Stop command
 * to the worker so the worker can cancel, reconcile, and release its lease
 * before the service exits. No signer or transaction input crosses this seam.
 */

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const workerPath = fileURLToPath(new URL("./lp-account-session.mjs", import.meta.url));
const worker = fork(workerPath, [], { env: process.env, stdio: ["ignore", "inherit", "inherit", "ipc"] });
let stopping = false;

function requestStop() {
  if (stopping) return;
  stopping = true;
  if (worker.connected) worker.send({ type: "stop", reason: "SERVICE_STOP" });
}

process.once("SIGTERM", requestStop);
process.once("SIGINT", requestStop);

worker.once("error", () => process.exitCode = 1);
worker.once("exit", (code, signal) => {
  if (signal && !stopping) process.exitCode = 1;
  else if (code !== 0) process.exitCode = code ?? 1;
  process.exit();
});
