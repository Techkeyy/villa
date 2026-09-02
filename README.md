# VILLA

VILLA is account-bound liquidity infrastructure for DreamDEX Event Contracts on Somnia Shannon. It helps liquidity providers price BTC event markets, manage bounded exposure, and keep each market lifecycle visible.

> Provide liquidity on DreamDEX without giving up custody.

[Live app](https://villa-ten-ashen.vercel.app/) · [Verified proof](https://villa-ten-ashen.vercel.app/proof) · [Public repository](https://github.com/Techkeyy/villa)

## The problem

DreamDEX Event Contracts are more useful when traders can find a price. A liquidity provider must repeatedly decide what a contract is worth, how much inventory is acceptable, when to stop quoting, and how to clean up after a fill or expiry. Manual work makes continuity difficult and hides important risk decisions.

VILLA is built for liquidity providers and operators, not retail bettors. The product turns that work into a repeatable, inspectable workflow.

## The solution

VILLA combines:

- an independent fair-value model for binary BTC Event Contracts;
- a Risk Governor that returns `ALLOW`, `REDUCE_ONLY`, or `HALT`;
- venue-grid, post-only quote planning;
- inventory and pending-order accounting;
- market rollover and settlement tracking;
- an isolated `VillaAccount` for each LP;
- an account-bound operator permission that cannot withdraw LP capital.

The economic objective is potential spread capture from providing useful maker liquidity. VILLA makes no promise of profit, yield, or positive PnL.

## Who uses VILLA

VILLA is for an LP who wants to supply testnet collateral to DreamDEX while retaining ownership in a personal on-chain account. An operator can run approved liquidity actions for that account, subject to the exact market, risk, capital, order, and session policies.

The LP journey is:

```text
CONNECT WALLET
  -> CREATE VILLA ACCOUNT
  -> FUND ACCOUNT
  -> AUTHORIZE VILLA
  -> REVIEW READINESS
  -> START STRATEGY
  -> MONITOR
  -> STOP
  -> SETTLE
  -> WITHDRAW
```

Capital actions are approved by the connected owner wallet. Strategy control is a separate authenticated path. The browser does not hold the execution credential and does not provide a generic transaction relay.

## How it works

1. The LP connects a wallet to Somnia Shannon and creates a personal `VillaAccount`.
2. The LP deposits the exact amount they choose. The account records the wallet as owner.
3. The LP authorizes the canonical VILLA operator for approved account actions.
4. VILLA reads a fresh DreamDEX market, underlying data, book, inventory, and account state.
5. The fair-value engine forms a price. The Risk Governor checks capital, exposure, inventory, pending orders, time, and data quality.
6. If every policy gate passes, VILLA plans post-only maker quotes through the LP account.
7. Fills, cancellations, rollover, settlement, redemption, and final accounting are recorded against the same account and market identity.
8. Stop prevents new expansion, cleans up only tracked account-owned orders, reconciles state, and never withdraws funds.

## Why the account boundary matters

The `VillaAccount` is the owner of the LP capital and the DreamDEX order. The VILLA operator is a separate address that can execute only the approved account-bound actions. This is the central custody boundary:

```text
LP wallet
  owns and funds
      |
      v
VillaAccount
  owns collateral, inventory, and orders
      ^
      |
VILLA operator
  executes constrained, account-bound actions
```

The operator cannot choose an arbitrary destination, calldata, withdrawal recipient, or unrelated account. Owner withdrawal remains a direct owner-wallet action.

## DreamDEX and Somnia

DreamDEX supplies the Event Contract markets, order books, and settlement lifecycle. VILLA reads the market and venue state, then plans maker liquidity around the exact market identity.

Somnia Shannon provides the testnet execution environment. The verified release proof uses chain ID `50312`, a real `VillaAccount`, and a real DreamDEX order. The public app is safe-mode by policy and the public proof surface is read-only.

## Pricing, inventory, and risk

The fair-value boundary uses `villa-fv-v1`, a digital probability model based on the underlying, reference, time to expiry, and realized volatility. The model keeps probability and confidence separate and rejects malformed, stale, or insufficient data.

The Risk Governor is explicit:

- `ALLOW` permits a policy-validated quote plan.
- `REDUCE_ONLY` allows cleanup or reduction while blocking new expansion.
- `HALT` blocks new risk when market, data, capital, gas, inventory, or policy conditions are unsafe.

Quotes remain post-only. Inventory and open orders are checked together so the next decision is based on actual exposure, not an assumed zero state.

## Canonical live proof

The final account-bound proof is the BTC 24-hour market ending in `10a14` on Shannon. It used:

- owner: `0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d`;
- VillaAccount: `0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2`;
- VILLA operator: `0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37`;
- minimum mint: `1000` raw;
- one post-only `SELL_YES` order at `0.356`, quantity `1000` raw;
- order ID `166020696663386049266`;
- order owner verified as the `VillaAccount`;
- MINT TX: `0x0389fac8ca7fe56bf6b2b96324fd69dd4799845926e920fe136627445171b972`;
- ORDER TX: `0xbb4e0d8b33259858dee23a50ce9bbd8dac60fe3b52a803fdce260a429ba89e6d`;
- CANCEL TX: `0x80a3563c92ef35fedfa61af5ae099ce5804cf74e80158615a0e7852a36078735`;
- BURN TX: `0xb645b3b0b9ffbc7cd72c1b40aaca0f2f344afe64fb2c6c1145fa56fe81f0b87e`;
- cancellation, paired burn, and final reconciliation.

The final account state was `1,002,000` raw tUSDC, zero YES, zero NO, and zero open orders. The owner withdrawal path was not called. The session stopped, the lease was released, and execution remained disabled.

The proof page shows the four exact transaction hashes with labels for mint, order, cancel, and burn, plus the plain-language journey and ownership split. See [`docs/ACCOUNT_BOUND_WET_PROOF.md`](docs/ACCOUNT_BOUND_WET_PROOF.md) for the evidence record.

Historical f920 evidence covers settlement and redemption behavior only. It is supporting lifecycle evidence, not the canonical order proof.

## Product surfaces

- `/` explains the product for first-time visitors and judges.
- `/app` is the LP workspace for wallet connection, account creation, funding, authorization, readiness, safe Start/Stop controls, and owner withdrawal.
- `/proof` is a read-only judge-friendly replay of verified evidence.

The app uses a white and light-blue visual system, readable type, sparse panels, clear primary actions, responsive layout, reduced-motion support, and keyboard-visible focus states.

## Start and Stop safety

Start is not a browser transaction button. It authenticates the connected owner wallet with a short-lived message signature, then sends an empty-body request to the account-bound control route. The server owns the account facts and preflight. The browser cannot provide a target or calldata.

The safe release still keeps persistent execution disabled. A safe-mode Start request returns `EXECUTION_DISABLED` without spawning a writer or sending a chain transaction. Stop is reserved for an authenticated account session and never withdraws capital.

The private engine is separate from the public app. Its signer stays outside the repository and outside Vercel. The public deployment exposes no signer, wallet credential, or private engine logs.

## Architecture

```text
Public visitor
    |
    +--> Vercel dashboard: explainer, LP workspace, read-only proof
    |
    +--> owner wallet: account deploy, fund, authorize, withdraw
    |
    +--> authenticated empty-body control request
              |
              v
       private operator API
              |
              v
       account-bound session and preflight
              |
              v
       private one-shot engine
              |
              v
       VillaAccount -> DreamDEX Event Contracts
```

The account adapter, typed writer, lease, reconciliation, and transaction policy are separate modules. A session is bound to the account, owner, operator, Shannon chain, exact market series, and exact market ID.

## Local development

Requirements: Node.js 20 or newer and an EIP-1193 wallet for wallet-mediated Shannon actions.

```bash
git clone https://github.com/Techkeyy/villa.git
cd villa
npm ci
npm test
npm run dashboard:build
npm run dashboard:replay
```

Open `http://127.0.0.1:4173/` for the explainer, `/app` for the owner workspace, and `/proof` for the read-only proof. The replay server does not require credentials or send transactions.

For a read-only live snapshot, use a separately configured local environment and the project’s existing live adapter. Never put signer material in browser files, Vercel variables, the README, or a public issue.

## Verification

The final local release gate recorded:

| Gate | Result |
| --- | --- |
| Full regression | 651/651 release run passing |
| Dashboard | 95/95 release run passing |
| Operator | 25/25 release run passing |
| Execution | 210/210 baseline passing |
| Recovery | 13/13 focused passing |
| Writer, session, reconciliation, policy | 72/72 focused passing |
| Dashboard build | Passing |
| Solidity account artifact compile | Passing |
| Secret scan | Clean |
| Production dependency audit | 0 vulnerabilities |

Counts are kept here as release evidence, while the test files remain the source of truth for future runs.

## Security model

- LP capital is held by the owner-scoped `VillaAccount`.
- Owner-only withdrawal has no destination input.
- The operator address is fixed by audited configuration and verified on-chain.
- Strategy control requires wallet authentication and owner scope.
- The private signer is loaded only inside the private engine process.
- Public control requests reject arbitrary transaction fields.
- Persistent execution remains disabled in the public release.
- Unknown transactions, unknown orders, stale leases, and incomplete reconciliation block continuation.
- Secrets are excluded by ignore rules and secret scanning.

The complete release audit is recorded in [`docs/FINAL_AUDIT.md`](docs/FINAL_AUDIT.md) and [`docs/ACCOUNT_BOUND_WET_PROOF.md`](docs/ACCOUNT_BOUND_WET_PROOF.md).

## Limitations and future work

This is a Shannon testnet MVP for a single canonical operator configuration. Market data and venue availability can change. PnL is not presented when it cannot be independently verified. The public deployment is safe-mode and does not claim autonomous production execution. Multi-LP operations, broader venue coverage, and production custody operations remain future work.

## Hackathon context

VILLA is built for the DreamDEX and Somnia ecosystem: a focused account-bound liquidity-provider workflow for fast Event Contract markets. The submission emphasizes a real testnet order owner, constrained permissions, transparent cleanup, and a judge-friendly evidence trail.

## License

MIT. See [`LICENSE`](LICENSE).