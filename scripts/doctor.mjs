/**
 * Read-only environment + venue doctor.
 * Proves the toolchain and live Event Contract surface. Does not trade.
 *
 * Statuses: PASS | WARN | FAIL
 * FAIL exits non-zero. Secrets are never printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED } from "@somnia-chain/markets-sdk";

if (existsSync(".env") && !process.env.OPERATOR_PRIVATE_KEY) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq);
    if (process.env[name] === undefined) process.env[name] = line.slice(eq + 1);
  }
}
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const RPC_URL = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const EXPECTED_CHAIN_ID = 50312;
const MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";
const TUSDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";

let failures = 0;
let warnings = 0;

function line(check, status, detail) {
  console.log(`${check.padEnd(34)} ${status.padEnd(6)} ${detail}`);
  if (status === "FAIL") failures += 1;
  if (status === "WARN") warnings += 1;
}

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body.result;
}

const node = process.versions.node;
const major = Number(node.split(".")[0]);
line("node >= 20", major >= 20 ? "PASS" : "FAIL", `v${node}`);

line(
  "OPERATOR_PRIVATE_KEY present",
  process.env.OPERATOR_PRIVATE_KEY ? "PASS" : "WARN",
  process.env.OPERATOR_PRIVATE_KEY ? "name found, value not printed" : "unset — writes blocked until a disposable wallet exists",
);

try {
  const chainHex = await rpc("eth_chainId");
  const chainId = Number.parseInt(chainHex, 16);
  line(
    "RPC reachable / chain id",
    chainId === EXPECTED_CHAIN_ID ? "PASS" : "FAIL",
    `${RPC_URL} -> ${chainId} (${chainHex})`,
  );
  const heightHex = await rpc("eth_blockNumber");
  line("chain producing blocks", "PASS", `height ${Number.parseInt(heightHex, 16)}`);
} catch (err) {
  line("RPC reachable / chain id", "FAIL", String(err.message || err));
}

try {
  const code = await rpc("eth_getCode", [MODULE, "latest"]);
  line(
    "BinaryMarketsModule has code",
    code && code !== "0x" ? "PASS" : "FAIL",
    code && code !== "0x" ? `${(code.length - 2) / 2} bytes (proxy-sized is expected)` : "empty",
  );
} catch (err) {
  line("BinaryMarketsModule has code", "FAIL", String(err.message || err));
}

try {
  const code = await rpc("eth_getCode", [TUSDC, "latest"]);
  line(
    "tUSDC has code",
    code && code !== "0x" ? "PASS" : "FAIL",
    code && code !== "0x" ? `${(code.length - 2) / 2} bytes` : "empty",
  );
} catch (err) {
  line("tUSDC has code", "FAIL", String(err.message || err));
}

try {
  const exchange = new SomniaMarkets({
    indexerUrl: "https://dev.smk.somnia.host/v1/graphql",
    chain: somniaShannon,
    wsRpcUrl: "wss://api.infra.testnet.somnia.network/ws",
    addresses: SOMNIA_TESTNET_ADDRESSES,
    priceFeed: SOMNIA_TESTNET_PRICE_FEED,
  });
  const markets = await exchange.loadMarkets(true);
  const all = Object.values(markets);
  const binaries = all.filter((m) => m.type === "binary" || m.info?.kind === "binary");
  line("SDK loadMarkets()", "PASS", `${all.length} tradables, ${binaries.length} binary-looking`);

  const listed = await exchange.client.listBinaryMarkets({ limit: 40 });
  const now = Date.now() / 1000;
  const live = listed.filter((m) => Number(m.expiry ?? 0) > now);
  const assets = [...new Set(listed.map((m) => m.asset).filter(Boolean))];
  const intervals = [...new Set(listed.map((m) => Number(m.intervalSec)).filter(Boolean))].sort((a, b) => a - b);
  line(
    "listBinaryMarkets()",
    listed.length > 0 ? "PASS" : "FAIL",
    `${listed.length} rows, ${live.length} with expiry in future, assets=${assets.join(",") || "none"} intervals=${intervals.join(",") || "none"}`,
  );

  try {
    const btc = await exchange.fetchPrice("BTC");
    const spot = btc?.price ?? btc?.spot ?? btc;
    line("price feed fetchPrice(BTC)", "PASS", `shape keys=${Object.keys(btc || {}).join(",") || "scalar"} spot=${spot}`);
  } catch (err) {
    line("price feed fetchPrice(BTC)", "FAIL", String(err.message || err));
  }
} catch (err) {
  line("SDK loadMarkets()", "FAIL", String(err.message || err));
}

console.log("");
if (failures > 0) {
  console.log(`STATUS FAIL  failures=${failures} warnings=${warnings}`);
  process.exit(1);
}
if (warnings > 0) {
  console.log(`STATUS READY WITH WARNINGS  warnings=${warnings}`);
  process.exit(0);
}
console.log("STATUS READY");
process.exit(0);
