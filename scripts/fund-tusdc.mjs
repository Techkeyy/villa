/**
 * Call the testnet tUSDC faucet() via the installed SDK.
 * Requires STT for gas. Never prints the key.
 */
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";

const key = process.env.OPERATOR_PRIVATE_KEY;
if (!key) {
  console.error("OPERATOR_PRIVATE_KEY unset");
  process.exit(1);
}

const exchange = new SomniaMarkets({
  indexerUrl: process.env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql",
  chain: somniaShannon,
  wsRpcUrl: process.env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws",
  addresses: SOMNIA_TESTNET_ADDRESSES,
  priceFeed: SOMNIA_TESTNET_PRICE_FEED,
  privateKey: key,
});

const token = SOMNIA_TESTNET_ADDRESSES.collateral || SOMNIA_TESTNET_ADDRESSES.testUsdc;
const me = exchange.walletAddress;
const before = token ? await exchange.client.getErc20Balance(token, me) : 0n;
console.log("address", me);
console.log("tUSDC before raw", String(before));
// 100 tUSDC is far more than one-lot escrow and well under the 10_000 cap.
const amount = 100n * 10n ** 6n;
const res = await exchange.trader.faucet({ amount });
console.log("faucet tx", res.hash);
console.log("receipt.status", res.receipt?.status);
const after = token ? await exchange.client.getErc20Balance(token, me) : 0n;
console.log("tUSDC after raw", String(after));
process.exit(0);
