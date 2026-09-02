/**
 * VILLA private one-shot entrypoint.
 *
 * SHADOW is the safe default. WET is a private VPS mode only and still stops
 * at the typed writer boundary while VILLA_EXECUTION_ENABLED=false.
 */

import { parsePrivateRuntimeArgs, runPrivateLpOneShotEntry, serializePrivateRuntimeResult } from "../src/execution/lp-private-runtime-entry.mjs";

const mode = String(process.env.VILLA_EXECUTION_MODE ?? "SHADOW").toUpperCase();
const enabled = process.env.VILLA_EXECUTION_ENABLED === "true";

function output(value, stream = process.stdout) {
  stream.write(`${serializePrivateRuntimeResult(value)}\n`);
}

let args;
try {
  args = parsePrivateRuntimeArgs();
} catch (error) {
  output({ result: "REFUSED", code: error?.code ?? "ARGUMENT_INVALID", broadcast: false, writes: 0 }, process.stderr);
  process.exitCode = 2;
}

if (process.exitCode === undefined && !args.oneCycle) {
  output({ result: "REFUSED", code: "ONE_CYCLE_REQUIRED", broadcast: false, writes: 0 }, process.stderr);
  process.exitCode = 2;
} else if (process.exitCode === undefined && (!args.account || !args.sessionId)) {
  output({ result: "REFUSED", code: "ACCOUNT_SESSION_REQUIRED", broadcast: false, writes: 0 }, process.stderr);
  process.exitCode = 2;
} else if (process.exitCode === undefined && !["SHADOW", "WET"].includes(mode)) {
  output({ result: "REFUSED", code: "MODE_INVALID", broadcast: false, writes: 0 }, process.stderr);
  process.exitCode = 2;
} else if (process.exitCode === undefined && mode === "SHADOW") {
  output({ result: "SHADOW", code: "PRIVATE_RUNTIME_NOT_USED", broadcast: false, writes: 0 });
  process.exitCode = 0;
} else if (process.exitCode === undefined && !enabled && !process.env.CREDENTIALS_DIRECTORY) {
  // Preserve the local no-credential smoke path. A real private dry run must
  // still load and verify the installed signer before it reaches its boundary.
  output({ result: "REFUSED", code: "EXECUTION_DISABLED", broadcast: false, writes: 0 });
  process.exitCode = 2;
} else if (process.exitCode === undefined) {
  try {
    const result = await runPrivateLpOneShotEntry({ env: process.env, args });
    output(result, result.result === "BLOCKED" ? process.stderr : process.stdout);
    process.exitCode = ["DRY_READY", "RECOVERY_READY", "COMPLETED"].includes(result.result) ? 0 : 2;
  } catch (error) {
    output({ result: "BLOCKED", code: error?.code ?? "PRIVATE_RUNTIME_FAILED", broadcast: false, writes: 0, reason: error?.message ?? "private runtime failed closed" }, process.stderr);
    process.exitCode = 2;
  }
}
