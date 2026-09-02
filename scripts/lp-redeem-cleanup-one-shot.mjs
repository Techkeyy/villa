import {
  parsePrivateLpRedeemCleanupArgs,
  runPrivateLpRedeemCleanup,
  serializePrivateLpRedeemCleanupResult,
} from "../src/execution/lp-private-redeem-cleanup.mjs";

try {
  const args = parsePrivateLpRedeemCleanupArgs();
  const result = await runPrivateLpRedeemCleanup({ args });
  process.stdout.write(serializePrivateLpRedeemCleanupResult(result) + "\n");
  process.exitCode = result.result === "COMPLETED" || result.result === "REDEEM_READY" ? 0 : 2;
} catch (error) {
  process.stdout.write(serializePrivateLpRedeemCleanupResult({
    result: "BLOCKED",
    code: error?.code ?? "REDEEM_CLEANUP_FAILED",
    reason: error?.message ?? String(error),
    broadcast: false,
    writes: 0,
  }) + "\n");
  process.exitCode = 2;
}
