export const VILLA_CHAIN = Object.freeze({
  id: 50312,
  idHex: "0xc488",
  name: "Somnia Shannon Testnet",
  rpcUrl: "https://dream-rpc.somnia.network",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
});

export const VILLA_ACCOUNT_CONFIG = Object.freeze({
  artifactPath: "/villa-account-artifact.json",
  discoveryApiUrl: "https://shannon-explorer.somnia.network/api",
  collateralToken: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
  collateralSymbol: "tUSDC",
  collateralDecimals: 6,
  outcomeToken: "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9",
  binaryModule: "0x3ecC694Cef705358864a646142ac17A90E29e388",
  binarySettlement: "0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23",
  operator: "0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37",
  initialMaxOrderQuantity: 1000n,
  initialMaxOrderCollateral: 1000n,
  discoveryEventTopic: "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
});

export const VILLA_SELECTORS = Object.freeze({
  owner: "0x8da5cb5b",
  operator: "0x570ca735",
  collateralToken: "0xb2016bd4",
  outcomeToken: "0xa998d6d8",
  binaryModule: "0x36e5d64f",
  binarySettlement: "0x1f2ef0c7",
  deposit: "0xb6b55f25",
  withdraw: "0x2e1a7d4d",
  setOperator: "0xb3ab15fb",
  revokeOperator: "0xb674759c",
  tokenBalanceOf: "0x70a08231",
  allowance: "0xdd62ed3e",
  approve: "0x095ea7b3",
});

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO_TOPIC = `0x${"0".repeat(64)}`;
