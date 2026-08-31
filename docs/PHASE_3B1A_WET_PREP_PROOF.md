# Phase 3B1A wet-preparation proof

Status: **BLOCKED before signer installation and before Phase 3B1B**

This document records the owner-provisioned disposable LP and the latest
read-only Shannon preparation run. No wallet, private key, signer, transaction
writer, account creation, market approval, protocol approval, order, or
blockchain write was performed by the preparation probes.

## Live disposable account

The exact account supplied by the owner was independently read from Shannon:

| Fact | Verified value |
| --- | --- |
| Chain | Somnia Shannon, chain ID 50312 |
| VillaAccount | `0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2` |
| Owner | `0xEFe0412781d3c1e7888b2DB9dEEcA3037542494d` |
| Canonical VILLA operator | `0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37` |
| Collateral | `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E` (`tUSDC`) |
| Collateral balance | exactly `1,000,000` raw, `1.00 tUSDC` |
| Outcome token | `0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9` |
| Binary module | `0x3ecC694Cef705358864a646142ac17A90E29e388` |
| Binary settlement | `0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23` |
| Contract order limits | `maxOrderQuantity=1000`, `maxOrderCollateral=1000` |
| Runtime | verified against `villa-browser-account-artifact-v2`, 9,970 bytes |

The four owner-supplied provisioning receipts were fetched directly and each
was successful at the stated block. The owner was the sender for all four:

| Action | Transaction | Block |
| --- | --- | --- |
| Create account | `0x274ced1d57933de5c1c85ebb80f0537c44b6c65e2027f849f52d2ecbf0b9c164` | `475881176` |
| Approve 1.00 tUSDC | `0x5d79ebe5a5900e3769e31b8b6269d9dee912452ec5de59d2bce81ede0b688166` | `475881408` |
| Deposit 1.00 tUSDC | `0xb1c514af5b550a9a0d150051efb715bd48383dc0140226ead3f71ce90bfc548b` | `475881510` |
| Authorize canonical operator | `0x91c9a7d3e5ab40efdac31c7152908cce0e971ce9eca13f2baf2ef935da5171e3` | `475881664` |

The account is distinct from the historical Phase 2 account and owner. No
private key was read or installed.

## Fresh market and shadow plan

The fresh public market probe selected the following current market after
requiring exact BTC 5-minute identity, Trading status, valid reference and
book facts, compatible grid, at least 120 seconds of headroom, and an
unfinalized pool:

| Fact | Read-only value |
| --- | --- |
| Market | `0x000000000000000000000000000000000000000000000000000000000000eb74` |
| Series | `BINARY:BTC:300` |
| Status | Trading |
| Expiry | `1788163500` |
| Headroom | 204 seconds at selection, 197 seconds at risk snapshot |
| Pool | `0xEbDd988665a41f059565619747a393f15099d96A` |
| Pool finalized | false |
| Spot | `78225.765` |
| Strike/reference | `78196.52`, source `strike` |
| Grid | tick `1000`, lot `1000`, minimum quantity `1000` raw |
| Book | YES bids `0.736/200`, `0.726/330`, `0.717/460`; asks `0.763/200`, `0.772/330`, `0.782/460` |

The account-scoped risk read found zero YES inventory, zero NO inventory, and a
verified empty open-order set. The fair-value result was `pUp=0.7558719859`,
`pDown=0.2441280141`, confidence `0.975`, data quality `HIGH`, and model
`villa-fv-v1`. The volatility observation set contained 228 observations with
`realizedVolPerSqrtSec=0.0000384382`; the model recorded a
`VOLATILITY_OUTLIER` warning.

The exact existing risk and quote pipeline then returned:

- Risk Governor: `HALT`, reason `GAS_RESERVE_LOW`.
- Quote plan: `NO_QUOTE`, because risk permissions were empty.
- Account readiness: not ready because `MARKET_NOT_APPROVED`,
  `PROTOCOL_APPROVAL_MISSING`, and `RISK_HALTED`.
- Current-market approval: false.
- Outcome-token operator approvals for the binary module and pool: both false.
- Collateral allowance outside a write: `0` raw.
- Shadow plan: zero actions, `broadcast=false`, `orderOwner` equal to the
  VillaAccount.
- Shadow one-cycle coordinator: `SHADOW`, zero writes.
- WET one-cycle coordinator: `REFUSED`, reason `EXECUTION_DISABLED`, zero
  writes.
- WET preflight: denied with `EXECUTION_DISABLED`,
  `MARKET_NOT_APPROVED`, `PROTOCOL_APPROVAL_MISSING`, and `RISK_HALTED`.

The shadow plan therefore contains no transaction intents yet. This is the
correct fail-closed result; an unsigned order must not be manufactured while
the account is not market-ready or the governor is halted.

## Phase 3B1 caps

The unchanged B0 hard caps remain:

| Cap | Value |
| --- | --- |
| `MAX_ACCOUNT_CAPITAL` | `1.00 tUSDC` |
| `MAX_ORDER_NOTIONAL` | `0.25 tUSDC` |
| `MAX_OPEN_ORDERS` | `2` |
| `MAX_PENDING_EXPOSURE` | `0.25 tUSDC` |
| `MAX_MINT_AMOUNT` | `0.25 tUSDC` |
| `MAX_SESSION_DURATION_SEC` | `900` |
| `MAX_TX_COUNT` | `12` |

## Blockers and next approval

The owner must first decide whether to prepare the selected live market. The
owner-side account actions are the exact market approval and protocol
preparation for that market. They were not performed here. The risk halt also
needs to be resolved by the owner’s approved gas-funding/setup process before
the risk gate can produce a quote.

Only after a fresh market and risk preflight pass should a separate approval
authorize signer installation. That approval must cover the root-only secret
file, derived signer-address match, private one-shot runtime, explicit lease,
one-cycle mint/order/cancel/reconcile/burn proof, and immediate disable/rollback
procedure. The next phase must still stop before organic fills,
profitability claims, continuous execution, or market rollover.

Reproducible probes:

```text
node scripts/phase3b1a-account-readonly.mjs --market-id=<fresh-market-id>
node scripts/phase3b1a-market-readonly.mjs
node scripts/phase3b1a-shadow-readonly.mjs
```

All three probes are read-only. The market id must come from the same fresh
market-selection run; it is never hardcoded by the engine.
