/**
 * Private-engine placeholder entrypoint for the bounded Phase 3B1A runner.
 * The signer runtime is intentionally not installed in this phase. This
 * command therefore fails closed unless an explicit one-cycle request is
 * supplied, and it never loads .env or imports a signer-bearing module.
 */

const oneCycle = process.argv.includes("--one-cycle");
const mode = String(process.env.VILLA_EXECUTION_MODE ?? "SHADOW").toUpperCase();
const enabled = process.env.VILLA_EXECUTION_ENABLED === "true";
const account = process.argv.find((arg) => arg.startsWith("--account="))?.slice("--account=".length) ?? null;
const sessionId = process.argv.find((arg) => arg.startsWith("--session-id="))?.slice("--session-id=".length) ?? null;

if (!oneCycle) {
  console.error(JSON.stringify({ result: "REFUSED", code: "ONE_CYCLE_REQUIRED", broadcast: false }));
  process.exitCode = 2;
} else if (!account || !sessionId) {
  console.error(JSON.stringify({ result: "REFUSED", code: "ACCOUNT_SESSION_REQUIRED", broadcast: false }));
  process.exitCode = 2;
} else if (mode !== "SHADOW" && mode !== "WET") {
  console.error(JSON.stringify({ result: "REFUSED", code: "MODE_INVALID", broadcast: false }));
  process.exitCode = 2;
} else if (mode === "SHADOW") {
  console.log(JSON.stringify({ result: "SHADOW", code: "SIGNER_RUNTIME_NOT_INSTALLED", broadcast: false, writes: 0 }));
  process.exitCode = 0;
} else if (!enabled) {
  console.log(JSON.stringify({ result: "REFUSED", code: "EXECUTION_DISABLED", broadcast: false, writes: 0 }));
  process.exitCode = 2;
} else {
  console.error(JSON.stringify({ result: "REFUSED", code: "PRIVATE_RUNTIME_NOT_INSTALLED", broadcast: false }));
  process.exitCode = 2;
}
