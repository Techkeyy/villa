/**
 * Production entry facade for the private runtime.
 *
 * The historical account adapter deliberately exposes only account-state
 * reads. This facade supplies the separately scoped market reader required by
 * the private runtime without changing the public adapter surface.
 */

import { createPublicClient, http } from "viem";
import { SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { VILLA_ACCOUNT_CONFIG } from "../../dashboard/account-config.mjs";
import { createLpExecutionAdapter, createViemLpAccountReader } from "./lp-adapter.mjs";
import { parsePrivateRuntimeArgs, runPrivateLpOneShot, serializePrivateRuntimeResult } from "./lp-private-runtime.mjs";

const POOL_OWN_ORDERS_ABI = Object.freeze([
  { type: "function", name: "getOwnOpenOrders", stateMutability: "view", inputs: [], outputs: [{ type: "uint128[]" }] },
]);

function makeReader(publicClient, account) {
  return createViemLpAccountReader({
    publicClient,
    listOpenOrderIds: async ({ pool }) => publicClient.readContract({ address: pool, abi: POOL_OWN_ORDERS_ABI, functionName: "getOwnOpenOrders", account }),
  });
}

/** Build dependencies for a single immutable account session. */
export function createPrivateRuntimeDependencies({ env = process.env, publicClient = null } = {}) {
  const account = String(env.VILLA_ENGINE_ACCOUNT ?? "");
  const owner = String(env.VILLA_ENGINE_OWNER ?? "");
  const operator = String(env.VILLA_ENGINE_OPERATOR ?? env.OPERATOR_ADDRESS ?? "");
  const client = publicClient ?? createPublicClient({ chain: somniaShannon, transport: http(env.RPC_URL || VILLA_ACCOUNT_CONFIG.rpcUrl, { timeout: 15_000 }) });
  const reader = makeReader(client, account);
  const baseAdapter = createLpExecutionAdapter({ account, owner, operator, reader, sessionId: env.VILLA_ENGINE_SESSION_ID });
  const adapter = Object.freeze({
    ...baseAdapter,
    readMarket: (input = {}) => reader.readMarket({ ...input, account }),
  });
  return Object.freeze({ publicClient: client, reader, adapter });
}

/** The service-facing one-shot entrypoint, with the market-read seam fixed. */
export async function runPrivateLpOneShotEntry(options = {}) {
  const env = options.env ?? process.env;
  const dependencies = { ...(options.dependencies ?? {}) };
  if (!dependencies.adapter || typeof dependencies.adapter.readMarket !== "function") {
    const prepared = createPrivateRuntimeDependencies({ env, publicClient: dependencies.publicClient ?? null });
    dependencies.publicClient ??= prepared.publicClient;
    dependencies.reader ??= prepared.reader;
    dependencies.adapter ??= prepared.adapter;
  }
  return runPrivateLpOneShot({ ...options, env, dependencies });
}

export { parsePrivateRuntimeArgs, serializePrivateRuntimeResult };
