# VILLA backend freeze

Phase 6A.2 was the final wallet-state hygiene checkpoint before frontend work.
The backend remains feature-frozen for the hackathon: future changes require a
concrete bug or hackathon-critical need. Phase 6B adds only a read-only cockpit
over the stable contract documented below.

## VILLA backend status

| Capability | Status |
| --- | --- |
| Fair value | VERIFIED |
| Risk governor | VERIFIED |
| Adaptive quote planner | VERIFIED |
| BUY maker execution | VERIFIED |
| SELL maker execution | VERIFIED |
| Complete-set mint/burn | VERIFIED |
| Simultaneous two-sided liquidity | VERIFIED |
| Organic external fills | VERIFIED |
| Fill reconciliation | VERIFIED |
| Settlement/redeem | VERIFIED |
| Successor rollover | VERIFIED |
| Bounded autonomous multi-window operation | VERIFIED |
| Restart journal | VERIFIED WITH BOUNDED SCOPE |
| Full production PnL accounting | NOT IMPLEMENTED |
| Production indefinite daemon | NOT IMPLEMENTED / NOT REQUIRED FOR CURRENT HACKATHON MVP |
| Frontend | PHASE 6B READ-ONLY COCKPIT |

The backend baseline before this freeze was commit
`ccf61a6a529e9eefeed01666d1aad72d573eee46`. The final freeze commit is the
commit containing this manifest and is reported by the handoff.

The backend freeze baseline passed `376/376` tests. The current repository
suite, including the Phase 6B dashboard tests, is reported by the handoff.

## Final wallet state

- network: Somnia Shannon, chain ID `50312`;
- wallet: `0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37`;
- current active orders: `0`;
- current claimable inventory: none;
- current STT: `49842766634000000000` raw;
- current tUSDC: `100000954` raw;
- `a3cf` claim: redeemed successfully in
  `0xacc6c3173fd5c5ef887a93df6d1e56472ac054f5cfe7b246d8e7f4484e7af28f`;
- `a3cf` payout: expected and actual `1000` raw; YES balance is now `0`;
- known zero-value residual: market
  `0x000000000000000000000000000000000000000000000000000000000000a00b`, NO
  token `1451285352625137128431785982617919410823961476258071882535378379375617`,
  balance `1000` raw, winner YES, payout vector `[10000000,0]`;
- unknown outcome inventory: `0`.

The a3cf position was proven by direct indexer order/fill history: the VILLA
wallet's filled `BUY_YES` order was `147573952589676446899`, quantity `1000`,
at price `690000`, with fill transaction
`0xac5752a04f75ba4bfa384412664f447320ac8aa8bbbaca563533268bd5589dd2`.
No matching VILLA runtime session journal exists, so exact session attribution
is unavailable; no provenance was fabricated.

## Dashboard data contract

The stable pure mapping is `villa-dashboard-v1` in
`src/dashboard/contract.mjs`. It exposes these backend-owned structures:

- `system`: running/stopped state, network, wallet public address, current
  series, orchestrator version;
- `market`: market ID, asset, interval, reference, underlying, expiry,
  remaining time, and status;
- `model`: pUp, pDown, confidence, realized volatility, and model version;
- `bookQuotes`: DreamDEX best bid/ask, VILLA target/resting bid/ask,
  quantities, and quote-plan version;
- `risk`: ALLOW / REDUCE_ONLY / HALT, reasons, exposure, capacity,
  collateral, and gas state;
- `inventory`: current-market YES/NO, complete sets, directional exposure,
  and classifications;
- `activity`: structured orchestrator events;
- `lifecycle`: current/previous market, rollover state, claims, and residuals;
- `accounting`: tUSDC, STT, and known collateral movements.

Accounting always exposes `pnlState: PNL_UNAVAILABLE` and `pnl: null`. The
dashboard must not invent a zero or estimated PnL while complete maker
proceeds, fees, and all cash-flow components are unavailable.

The Phase 6B cockpit is implemented in `dashboard/`, with a server-side
read-only adapter in `scripts/dashboard-server.mjs`, a pure projection layer in
`src/dashboard/presenter.mjs`, and recorded evidence scenes in
`src/dashboard/replay.mjs`. It has no signer, transaction, order-control, or
dashboard write path.

## Known limitations

- production indefinite daemon behavior is outside the bounded MVP;
- restart recovery is bounded by the existing journal and chain-truth
  reconciliation scope;
- the finalized claim sweep is bounded to the latest 200 indexed rows, while
  the wallet audit also uses the complete indexed wallet portfolio and exact
  market reads;
- the old losing `a00b` NO token remains visible as a known zero-value residual
  and is excluded from active inventory, exposure, claimable value, capital,
  PnL, and sell capacity;
- true realized PnL remains unavailable until the ledger includes complete
  per-fill maker proceeds, protocol fees, and other relevant cash flows;
- session-key/operator behavior for Event Contracts remains unverified for
  the MVP.

No private key, secret, or signer material belongs in this manifest or the
dashboard contract.
