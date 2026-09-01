# Phase 3B1B2A private writer

This checkpoint installs the private account-bound wet writer without arming
execution. The public dashboard, browser, Vercel deployment, and operator API
do not import the private runtime and never receive a signer or wallet client.

## Boundary

The VPS one-shot entrypoint is `scripts/lp-one-cycle.mjs`. It requires an
explicit one-shot request and an immutable runtime binding for:

- Somnia Shannon, chain `50312`;
- the configured owner, VillaAccount, and canonical VILLA operator;
- one exact BTC 24-hour market and one session ID.

The signer is loaded only from systemd's `operator-key` credential directory.
The private credential is not read from the ordinary environment, repository,
browser, or API. The derived public address is checked against the canonical
operator before any writer can be created.

## Typed write boundary

The writer accepts only a policy-prepared VILLA plan with a valid intent. It
derives the transaction request from the audited `VillaAccount` ABI and the
bound account. It has no generic transaction method and does not accept a
caller-supplied recipient, selector, calldata, native value, withdrawal, or
permission mutation.

The exact allowlist is:

`operatorPlaceOrder`, `operatorCancelOrder`, `operatorReduceOrder`,
`operatorMintSet`, `operatorBurnSet`, `operatorRedeem`, and
`operatorClaimVault`.

Every write is simulated first, checked against latest and pending nonce state,
serialized as one in-flight action, journaled with its intent/session/action
and receipt fields, and classified as `PENDING`, `CONFIRMED`, `REVERTED`, or
`UNKNOWN`. A restart or uncertain receipt blocks further writes until the
transaction is reconciled. There is no blind retry.

## Dry one-shot

The private service is configured with `VILLA_EXECUTION_ENABLED=false`. The
dry one-shot still loads and verifies the signer, reads the account and exact
market, performs the fresh read-only feasibility and preflight checks, creates
the four projected typed actions for the bounded mint, SELL, cancel, and burn
path, then stops at the writer boundary.

The expected dry result is:

```text
result: DRY_READY
code: EXECUTION_DISABLED
broadcastAttempts: 0
writes: 0
```

The hard caps remain unchanged: account capital `1,002,000` raw,
`250,000` raw order/mint/exposure limits, at most two open orders, a 900-second
session, and 12 transactions.

This phase does not create a wet session, select a replacement market, mint,
place or cancel an order, burn, withdraw, enable execution, or send a chain
transaction.
