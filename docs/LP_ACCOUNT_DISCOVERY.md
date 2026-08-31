# LP account discovery

Status: Phase 2 live account discovery proof complete for the verified owner-browser lifecycle.

VILLA uses direct deployment of the proven `VillaAccount` contract. There is no factory registry and no shared operator wallet. The browser must rediscover the account for the connected owner after refresh, local storage deletion, and a new session.

## Candidate sources

The browser may collect candidate addresses from two read-only sources:

1. A local storage hint keyed by the normalized connected owner.
2. The Shannon Explorer Blockscout-compatible logs endpoint, filtered for `OwnershipTransferred(address,address)` where the previous owner is zero and the new owner is the connected wallet.

The explorer returns `status: "0"` with `message: "No logs found"` for a valid owner with no account; the browser treats that response as an authoritative empty candidate set and shows the safe creation path. Other explorer failures trigger one bounded provider fallback that scans at most the latest 2,000 blocks in 1,000-block chunks with an explicit timeout. Shannon RPC range limits make reliable full-history RPC discovery impossible without a factory or registry, so an incomplete fallback fails closed and asks the LP to retry. It never treats an unavailable index or incomplete RPC window as proof that an account does not exist.

The official explorer API is used only as an index. See [Somnia explorer API health and monitoring](https://docs.somnia.network/developer/deployment-and-production/explorer-api-health-and-monitoring) and the [Shannon explorer API documentation](https://shannon-explorer.somnia.network/api-docs).

## Verification before recognition

Every candidate is independently checked through the connected provider:

1. Read `eth_getCode(account, latest)` and compare it with the pinned locally compiled `VillaAccount` runtime template in `dashboard/villa-account-artifact.json`. Compiler-declared immutable reference ranges are masked for this comparison because deployment fills those slots with the fixed constructor addresses. Those addresses are then independently verified by the contract reads below.
2. Read `owner()` and require exact equality with the connected wallet.
3. Read `operator()` and display either zero, the trusted VILLA operator, or an unrecognized state. An unexpected operator pauses automation controls.
4. Read `collateralToken()`, `outcomeToken()`, `binaryModule()`, and `binarySettlement()` and require exact equality with the trusted Shannon configuration.
5. Read the account's tUSDC balance only after the identity and wiring checks pass.

The explorer address, a local hint, a URL parameter, a request body, or user-edited browser storage can therefore supply a candidate but can never authorize a capital action. If a candidate exists but fails verification, discovery enters a separate security-error state. It never becomes `NO_ACCOUNT`, and the UI does not offer account creation. All writes re-run the identity checks immediately before the transaction and verify the post-transaction state.

## Creation verification

Creation is a direct wallet deployment transaction. The constructor receives the connected owner, zero initial operator, the fixed Shannon addresses, and the bounded initial order limits. The browser reports success only after it has:

- received a successful receipt with a contract address;
- confirmed runtime bytecode against the normalized local template;
- confirmed connected-wallet ownership;
- confirmed zero operator;
- confirmed all immutable protocol addresses;
- stored the address only as a convenience hint.

The hint accelerates a later lookup. It is never the account registry.

## Why this architecture is retained

The direct deployment path avoids adding a factory or mutable registry before the custody boundary is independently proven. The implementation and runtime template are compiled from `contracts/VillaAccount.sol` with the pinned `solc 0.8.30` optimizer settings. The browser artifact records the source hash, source commit, compiler description, and immutable reference ranges for review. A deployed account is accepted only when its normalized runtime matches that local template and its on-chain owner and protocol wiring match the trusted configuration.

The wallet and chain guidance follows the official [Somnia network information](https://docs.somnia.network/developer/network-info), including chain ID 50312 and Shannon testnet resources. Testnet funding links stay pointed to Somnia's [official testnet resources](https://testnet.somnia.network/).

## Live Phase 2 result

The verified owner account 0xFc9dbf0a8468aA56799b4e23B1EBe936426eE30b was
rediscovered after the real browser lifecycle and reload. Its owner matched
0xCc67779F8eDb2C80DC665775C5597657C512FE1A, its operator could be revoked to
zero, and its final collateral balance was zero after the owner withdrawal.
The complete transaction record is in PHASE_2_LP_ONBOARDING_PROOF.md.
