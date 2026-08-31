# Phase 3B1A runtime preparation

Phase 3B1A prepares one bounded, account-bound wet proof without installing a
signer or arming execution. It is local preparation only. The current VPS
must remain `VILLA_EXECUTION_ENABLED=false`, with no `OPERATOR_PRIVATE_KEY` or
`TAKER_PRIVATE_KEY`.

## Identity and account gate

The Phase 2 fixture account is excluded by code:

```text
Phase 2 account: 0xFc9dbf0a8468aA56799b4e23B1EBe936426eE30b
Phase 2 owner:   0xCc67779F8eDb2C80DC665775C5597657C512FE1A
```

The disposable LP must be a new Shannon `VillaAccount`, owned by the owner's
new wallet, and authorized to the canonical operator
`0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37`. The owner wallet remains the
only withdrawal and account-mutation authority. No seed, private key, or
wallet export is accepted by the engine or recorded in evidence.

## Bounded cycle

The prepared runtime is `src/execution/lp-one-cycle.mjs`, with
`scripts/lp-one-cycle.mjs` as a fail-closed entrypoint. It requires all of:

- explicit `--one-cycle`;
- one named account and session;
- fresh chain, venue, identity, order, inventory, and reconciliation facts;
- the exact current `BINARY:BTC:300` market selected from live reads;
- the central LP transaction policy and account lease;
- `VILLA_EXECUTION_ENABLED=true` only at a later owner-approved gate; and
- a private injected writer.

The default is SHADOW and `broadcast=false`. There is no loop, daemon,
rollover, automatic restart, arbitrary target, arbitrary calldata, direct
withdrawal, or direct operator-wallet portfolio path. The old historical
signer-owned supervisor runner is disabled.

The smallest future wet proof is:

```text
optional minimal mint -> one post-only account order -> prove account owner
-> cancel that exact order -> reconcile -> burn the paired amount if safe
-> stop
```

No organic fill, profitability, or continuous execution claim is part of this
proof. The amount is capped at 0.25 tUSDC per order/mint and the account
capital cap is 1.00 tUSDC. The session cap is 900 seconds, open orders are
capped at 2, pending exposure at 0.25 tUSDC, and writes at 12 transactions.

## Future signer custody design

Only in a separate owner-authorized wet phase, the operator signer may be
placed in a root-created secret file such as `/etc/villa-engine.env` with
owner `root`, group `root`, mode `0600`, then passed to a dedicated private
service with systemd credentials. A dedicated `villa` systemd service would
read only that credential and run the private one-cycle engine as user `villa`;
the public control plane and Vercel never receive the file, key, seed, or
signer object.

The exact future command shape, with the secret supplied separately by the
owner and never written in the repository, is:

```sh
sudo install -o root -g root -m 0600 /secure/owner-supplied/villa-engine.env /etc/villa-engine.env
sudo systemctl edit villa-engine.service
```

The service drop-in would contain only the private runtime wiring:

```ini
[Service]
User=villa
Group=villa
LoadCredential=operator.env:/etc/villa-engine.env
EnvironmentFile=%d/operator.env
ExecStart=/usr/bin/node /opt/villa-operator/scripts/lp-one-cycle.mjs --one-cycle
```

After the owner reviews the unit and secret permissions:

```sh
sudo systemctl daemon-reload
sudo systemctl start villa-engine.service
```

These commands are design artifacts only in Phase 3B1A. They were not run.

The service must not be allowed to edit systemd, Caddy, unrelated users, or
the operating system. Logs use the safe field allowlist in
`src/execution/lp-logging.mjs`. The signer installation command is deliberately
not included here because it would be an external secret-bearing action.

## Deferred Phase 3B1B signer and one-shot package

This is the exact review sequence for a later owner-authorized run. It is a
procedure, not an authorization, and it was not executed in Phase 3B1A.

1. The owner supplies the signer value out of band to a root-only file. The
   repository, Vercel, public API, shell history, process arguments, and logs
   never receive the value.

   ```sh
   sudo install -o root -g root -m 0600 /owner-controlled-input/villa-engine.env /etc/villa-engine.env
   sudo systemctl cat villa-engine.service
   sudo systemd-analyze verify villa-engine.service
   ```

2. The private runtime reads the credential through systemd, derives the
   address in memory, and prints only the derived public address. The run must
   stop before any write unless it exactly equals
   `0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37`. A mismatch is a hard refusal;
   there is no address override or fallback signer.

3. The public control plane remains arbitrary-transaction denied. The private
   path may receive only the named VillaAccount, the canonical operator
   identity, the exact current market, and policy-prepared account methods.
   Native value, arbitrary calldata, withdrawal, ownership mutation, market
   approval, and protocol-preparation methods remain denied to the operator
   writer.

4. The owner reviews `VILLA_EXECUTION_ENABLED=true` in the private credential,
   then starts only the private one-shot unit. The unit must acquire the
   disposable account lease and perform a fresh chain, market, account,
   inventory, order, risk, reconciliation, and transaction-policy preflight.
   Any missing, stale, mismatched, unknown, or ambiguous fact refuses before
   broadcast.

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl start villa-engine.service
   sudo systemctl status --no-pager villa-engine.service
   ```

5. The only permitted bounded sequence is optional minimal mint, one
   post-only order, on-chain proof that the order owner is the VillaAccount,
   exact cancellation, reconciliation, paired burn only when the reconciliation
   proves it safe, and stop. The sequence is one-cycle only, never a loop,
   rollover, restart, or organic-fill test.

6. The operator stops immediately after the proof, sets the private execution
   flag false, and reconciles before releasing the account lease. The private
   signer is then removed or retained only according to the owner-approved
   custody policy.

   ```sh
   sudo systemctl stop villa-engine.service
   sudo systemctl stop villa-operator-api.service
   # owner-approved private edit: VILLA_EXECUTION_ENABLED=false
   # private authenticated stop of the named account session
   # cancel only known VillaAccount-owned orders
   # verify zero open orders, zero pending/unknown transactions, and safe reconciliation
   # release the account lease only after those checks pass
   ```

If any step fails, the kill switch is the stop plus reconciliation sequence
above. Service stop alone is not a successful cleanup. No step in this package
authorizes a transaction by itself.

## Kill switch and failure drill

Stopping the service is not sufficient by itself. A future stop procedure must
set the execution flag false, stop the account session, cancel only known
account-owned orders, reconcile chain and venue state, and release the account
lease only after reconciliation proves it safe. Unknown transaction, order,
RPC, nonce, stale-intent, signer, operator, market, lease, or cap facts deny
the cycle before broadcast. The A-J drill is enumerated in
`src/execution/lp-failure-drill.mjs`.

The reviewed kill-switch command shape is:

```sh
sudo systemctl stop villa-engine.service
sudo systemctl stop villa-operator-api.service
# owner-approved edit: VILLA_EXECUTION_ENABLED=false in the private env
# authenticated control action: stop the named account session
# private reconciliation: cancel known account-owned orders, then verify zero
# open orders, zero unknown/pending transactions, and release the lease
```

The final two lines are mandatory reconciliation steps, not shell shortcuts;
service stop alone is never considered a safe terminal state.

## Explicit owner gate before Phase 3B1B

The owner must review the exact new account, owner, operator authorization,
one current market, caps, custody design, and failure-drill result. Only then
may a separate task authorize signer installation and a single wet proof. This
phase stops before that authorization.
