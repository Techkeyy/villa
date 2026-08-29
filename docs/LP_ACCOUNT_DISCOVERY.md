# LP account discovery

Status: Phase 2 implementation.

VILLA uses direct deployment of the proven `VillaAccount` contract. There is no factory registry and no shared operator wallet. The browser must rediscover the account for the connected owner after refresh, local storage deletion, and a new session.

## Candidate sources

The browser may collect candidate addresses from two read-only sources:

1. A local storage hint keyed by the normalized connected owner.
2. The Shannon Explorer Blockscout-compatible logs endpoint, filtered for `OwnershipTransferred(address,address)` where the previous owner is zero and the new owner is the connected wallet.

If the explorer index is unavailable, the browser tries a provider `eth_getLogs` read. Shannon RPC range limits can make a full-history query unavailable, so the product fails closed and asks the LP to retry. It never treats a missing index result as proof that an account does not exist.

The official explorer API is used only as an index. See [Somnia explorer API health and monitoring](https://docs.somnia.network/developer/deployment-and-production/explorer-api-health-and-monitoring) and the [Shannon explorer API documentation](https://shannon-explorer.somnia.network/api-docs).

## Verification before recognition

Every candidate is independently checked through the connected provider:

1. Read `eth_getCode(account, latest)` and require exact equality with the pinned `VillaAccount` runtime bytecode in `dashboard/villa-account-artifact.json`.
2. Read `owner()` and require exact equality with the connected wallet.
3. Read `operator()` and display either zero, the trusted VILLA operator, or an unrecognized state. An unexpected operator pauses automation controls.
4. Read `collateralToken()`, `outcomeToken()`, `binaryModule()`, and `binarySettlement()` and require exact equality with the trusted Shannon configuration.
5. Read the account's tUSDC balance only after the identity and wiring checks pass.

The explorer address, a local hint, a URL parameter, a request body, or user-edited browser storage can therefore supply a candidate but can never authorize a capital action. All writes re-run the identity checks immediately before the transaction and verify the post-transaction state.

## Creation verification

Creation is a direct wallet deployment transaction. The constructor receives the connected owner, zero initial operator, the fixed Shannon addresses, and the bounded initial order limits. The browser reports success only after it has:

- received a successful receipt with a contract address;
- confirmed exact runtime bytecode;
- confirmed connected-wallet ownership;
- confirmed zero operator;
- confirmed all immutable protocol addresses;
- stored the address only as a convenience hint.

The hint accelerates a later lookup. It is never the account registry.

## Why this architecture is retained

The direct deployment path avoids adding a factory or mutable registry before the custody boundary is independently proven. The implementation and runtime reference were built from `contracts/VillaAccount.sol` and checked against the known Shannon deployment used in Phase 1. The browser artifact records the source hash, source commit, compiler description, and reference account for review.

The wallet and chain guidance follows the official [Somnia network information](https://docs.somnia.network/developer/network-info), including chain ID 50312 and Shannon testnet resources. Testnet funding links stay pointed to Somnia's [official testnet resources](https://testnet.somnia.network/).
