/** Explicit, one-shot, account-bound f920 paired-inventory cleanup. */

import { parsePrivateCleanupArgs, runPrivateLpCleanup, serializePrivateCleanupResult } from "../src/execution/lp-private-cleanup.mjs";

function output(value, stream = process.stdout) {
  stream.write(`${serializePrivateCleanupResult(value)}\\n`);
}

let args;
try {
  args = parsePrivateCleanupArgs();
} catch (error) {
  output({ result: "REFUSED", code: error?.code ?? "ARGUMENT_INVALID", broadcast: false, writes: 0 }, process.stderr);
  process.exitCode = 2;
}

if (process.exitCode === undefined && !args.confirmCleanup) {
  output({ result: "REFUSED", code: "CLEANUP_CONFIRM_REQUIRED", broadcast: false, writes: 0 }, process.stderr);
  process.exitCode = 2;
} else if (process.exitCode === undefined) {
  try {
    const result = await runPrivateLpCleanup({ env: process.env, args });
    output(result, result.result === "COMPLETED" || result.result === "CLEANUP_READY" ? process.stdout : process.stderr);
    process.exitCode = ["CLEANUP_READY", "COMPLETED"].includes(result.result) ? 0 : 2;
  } catch (error) {
    output({ result: "BLOCKED", code: error?.code ?? "PRIVATE_CLEANUP_FAILED", broadcast: false, writes: 0, reason: error?.message ?? "cleanup failed closed" }, process.stderr);
    process.exitCode = 2;
  }
}
