# Phase 3 signer custody

## Finding

The canonical VILLA operator is
`0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37`.

The corresponding signer material was verified as present in the local
developer machine's ignored `.env` and absent from the VPS environment. The
VPS read-only probe found `/etc/villa-operator.env`, with
`VILLA_EXECUTION_ENABLED` and `OPERATOR_ADDRESS` configured, but no
`OPERATOR_PRIVATE_KEY` or `TAKER_PRIVATE_KEY`. No secret value was printed or
copied. No signer was installed during Phase 3B0.

Classification: **local development only**. The VPS is not a signer custody
location yet.

## Production custody model

The future production model is:

```text
owner-controlled VPS
  -> non-root villa service account
  -> least-privilege secret store readable only by the engine service
  -> private engine
  -> account-bound VillaAccount calls only
```

The signer must remain server-side. It must not be present in the browser,
Vercel environment, API responses, telemetry, crash reports, or ordinary logs.
The engine must never return a private key, seed, wallet export, or raw signer
configuration through a control-plane endpoint.

The `villa` service account should be able to read only the signer secret and
the engine's required configuration. It should not be able to modify system
units, Caddy, unrelated users, or the operating system. The public API should
receive high-level account/session requests, not transaction calldata.

## Deployment is intentionally deferred

Phase 3B0 does not install the signer, change the VPS environment, change
`VILLA_EXECUTION_ENABLED`, or start a wet engine. Before a later installation,
the owner must review the VPS filesystem permissions, service unit, secret
rotation/recovery procedure, log redaction, SSH access, and account-specific
session lease. A signer installation is a separate owner-authorized action.
