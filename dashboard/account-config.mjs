export const VILLA_CHAIN = Object.freeze({
  id: 50312,
  idHex: "0xc488",
  name: "Somnia Shannon Testnet",
  rpcUrl: "https://dream-rpc.somnia.network",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
});

// Capital policy concepts are deliberately separate. The initial-deposit floor
// is public onboarding policy; the strategy floor and Phase 3B1 cap are bounded
// engineering-test policy and are not a public-user deposit ceiling.
export const MIN_INITIAL_DEPOSIT_TUSDC = "1.00";
export const MIN_INITIAL_DEPOSIT_RAW = 1_000_000n;
export const MIN_DEPOSIT_TUSDC = MIN_INITIAL_DEPOSIT_TUSDC;
export const MIN_DEPOSIT_RAW = MIN_INITIAL_DEPOSIT_RAW;
export const MIN_TOP_UP_TUSDC = "0.001";
export const MIN_TOP_UP_RAW = 1_000n;
export const MIN_STRATEGY_CAPITAL_TUSDC = "1.001";
export const MIN_STRATEGY_CAPITAL_RAW = 1_001_000n;
export const PHASE_3B1_RECOMMENDED_CAP_TUSDC = "1.002";
export const PHASE_3B1_MAX_ACCOUNT_CAPITAL_RAW = 1_002_000n;

export const VILLA_ACCOUNT_CONFIG = Object.freeze({
  rpcUrl: VILLA_CHAIN.rpcUrl,
  artifactPath: "/villa-account-artifact.json",
  legacyArtifactPath: "/villa-account-artifact-v1.json",
  artifactCreationSha256: "7eac8952f55274fde3fffaf286405d8ff15aa451956f1907f1ac0d7d5a0da4b1",
  artifactRuntimeSha256: "d37d0527683c763c9586a9fdeaa45672abc3c16ea6d8c3527af1630314421df5",
  legacyV1CreationSha256: "a8acd22fe43cf08ea01b474fa71e630a41be1d02237135ebc2c0efa3b0b69644",
  legacyV1RuntimeSha256: "a61885ce1f5709424bcd72945f580f7db947b7ef297a9bfc0501ac7b179427d5",
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
  initialMaxAggregateExposure: 1_000_000n,
  initialMaxMintExposure: 1_000_000n,
  discoveryEventTopic: "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
});

export const VILLA_SELECTORS = Object.freeze({
  accountVersion: "0x535e1547",
  owner: "0x8da5cb5b",
  operator: "0x570ca735",
  autonomousTradingEnabled: "0x015d0803",
  collateralToken: "0xb2016bd4",
  outcomeToken: "0xa998d6d8",
  binaryModule: "0x36e5d64f",
  binarySettlement: "0x1f2ef0c7",
  deposit: "0xb6b55f25",
  withdraw: "0x2e1a7d4d",
  setOperator: "0xb3ab15fb",
  revokeOperator: "0xb674759c",
  setAutonomousTrading: "0x40403741",
  prepareMarket: "0x057e80da",
  preparedMarkets: "0x2bd6062b",
  approvedMarkets: "0xe602b063",
  tokenBalanceOf: "0x70a08231",
  allowance: "0xdd62ed3e",
  approve: "0x095ea7b3",
});

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO_TOPIC = `0x${"0".repeat(64)}`;
