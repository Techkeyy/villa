# VILLA private operator engine

VILLA has a separate private one-shot engine for the owner-controlled VPS.
This is a custody and execution boundary, not a public API deployment. The
current Phase 3B2A checkpoint installs the real typed writer and keeps
execution explicitly disabled.

## Boundary

- Vercel and the public dashboard remain signer-free and read-only.
- `villa-operator-api.service` runs as the separate `villa` user and exposes
  only the existing authenticated control-plane surface.
- `villa-engine.service` runs as the separate `villa-engine` user with
  `NoNewPrivileges`, private filesystem defaults, no public listener, and a
  one-shot invocation of `scripts/lp-one-cycle.mjs`.
- The signer credential is external to the repository and public API. systemd
  makes it available only as the private `operator-key` credential to the
  private engine process.

The engine binds one immutable session to the configured owner, VillaAccount,
canonical operator, Shannon chain `50312`, BTC 24-hour series, exact market,
and one session ID. It reads the account and market from chain/venue sources,
then revalidates readiness, risk, capital, protocol permissions, order state,
and reconciliation before it can create a writer.

## Typed writer boundary

The writer accepts only a policy-prepared VILLA intent. It derives the exact
`VillaAccount` ABI call and target internally. There is no public or external
generic transaction interface and no caller-controlled recipient, selector,
calldata, native value, withdrawal, ownership mutation, or operator mutation.

The allowlist is limited to:

`operatorPlaceOrder`, `operatorCancelOrder`, `operatorReduceOrder`,
`operatorMintSet`, `operatorBurnSet`, `operatorRedeem`, and
`operatorClaimVault`.

Each future write is simulated, revalidated, checked against latest and
pending nonce state, serialized as the sole in-flight write, journaled, and
waited to a definitive receipt. `PENDING`, `CONFIRMED`, `REVERTED`, and
`UNKNOWN` are explicit states. An uncertain result or restart blocks further
writes until authoritative reconciliation; the engine never blindly retries.

## Current safe mode

The VPS service must contain:

```text
VILLA_EXECUTION_MODE=WET
VILLA_EXECUTION_ENABLED=false
```

The WET mode name selects the private runtime implementation. The false flag
is checked before wallet-client creation or invocation. A dry one-shot loads
and verifies the private signer, reads the exact account and market, runs the
read-only feasibility and final preflight, builds the bounded mint,
SELL_YES, cancel, and burn intents, and stops at the writer boundary.

Expected dry result:

```text
result: DRY_READY
code: EXECUTION_DISABLED
broadcastAttempts: 0
writes: 0
```

The hard caps remain unchanged: account capital `1,002,000` raw, maximum
order/mint/pending exposure `250,000` raw, at most two open orders, a
900-second session, and 12 transactions.

## Public API and frontend

`GET /health` remains a non-writable service check. The existing wallet
signature routes authenticate the operator for control-plane reads/actions;
message signing does not send a blockchain transaction. With execution false,
`POST /session/start` returns `EXECUTION_DISABLED` and must not spawn a
writer.

The public frontend may know only the HTTPS engine origin through
`VILLA_ENGINE_API_URL`. It never receives the signer, wallet client, private
credential, or private engine logs. The API origin remains configured with the
exact allowed Vercel origin and no wildcard.

## Phase boundary

This checkpoint does not create a wet session, select a replacement market,
mint, place or cancel an order, burn, redeem, withdraw, enable execution, or
send a chain transaction. A separate owner-approved phase is required before
changing the execution flag or starting a wet one-shot.
