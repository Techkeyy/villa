/**
 * Read-only feasibility envelope compatibility layer.
 *
 * The base feasibility calculation remains unchanged. This wrapper adds the
 * independently read public market pool to the envelope so account-bound
 * runtimes can compare it with the VillaAccount's configured pool.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { VILLA_ACCOUNT_CONFIG } from "../dashboard/account-config.mjs";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASE_SCRIPT = fileURLToPath(new URL("./phase3b1a-feasibility-readonly-base.mjs", import.meta.url));
const jsonSafe = (value) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);

function withoutSignerSecrets(env) {
  const safe = { ...env };
  for (const name of ["OPERATOR_PRIVATE_KEY", "TAKER_PRIVATE_KEY", "PRIVATE_KEY", "WALLET_SEED", "MNEMONIC", "CREDENTIALS_DIRECTORY"]) delete safe[name];
  return safe;
}

function parseEnvelope(stdout, stderr) {
  for (const candidate of [String(stdout ?? "").trim(), String(stderr ?? "").trim()]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* use the other stream */ }
  }
  return null;
}

async function closeExchange(exchange) {
  await Promise.race([exchange.close().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 500))]);
}

async function main() {
  let child;
  let exitCode = 0;
  try {
    child = await execFileAsync(process.execPath, [BASE_SCRIPT], { cwd: ROOT, env: withoutSignerSecrets(process.env), maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    child = { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    exitCode = Number.isInteger(error.code) ? error.code : 2;
  }
  const envelope = parseEnvelope(child.stdout, child.stderr);
  if (!envelope) {
    console.log(jsonSafe({ result: "BLOCKED", code: "FEASIBILITY_OUTPUT_INVALID", reason: "the read-only feasibility result was not JSON" }));
    return 2;
  }
  if (envelope.result !== "PASS" || !envelope.market?.marketId || !envelope.account) {
    console.log(jsonSafe(envelope));
    return exitCode || 2;
  }

  const exchange = new SomniaMarkets({
    account: envelope.account,
    indexerUrl: process.env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql",
    chain: somniaShannon,
    wsRpcUrl: process.env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws",
    addresses: SOMNIA_TESTNET_ADDRESSES,
    priceFeed: SOMNIA_TESTNET_PRICE_FEED,
  });
  try {
    const onchain = await exchange.client.getMarketOnchain(envelope.market.marketId);
    if (!onchain?.pool) {
      console.log(jsonSafe({ result: "BLOCKED", code: "MARKET_POOL_UNAVAILABLE", reason: "fresh market pool read was unavailable" }));
      return 2;
    }
    console.log(jsonSafe({
      ...envelope,
      market: { ...envelope.market, pool: onchain.pool },
      shadow: {
        ...envelope.shadow,
        market: {
          ...(envelope.shadow?.market ?? {}),
          onchain: { ...(envelope.shadow?.market?.onchain ?? {}), pool: onchain.pool },
        },
      },
    }));
    return exitCode;
  } finally {
    await closeExchange(exchange);
  }
}

const exitCode = await main();
process.exit(exitCode);
