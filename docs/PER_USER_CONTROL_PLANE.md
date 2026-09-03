# VILLA per-user control plane

The public control plane is account-scoped, not globally allowlisted.

1. A wallet signs a short-lived VILLA account-authentication message.
2. The request names one VillaAccount. It contains no destination, selector,
   calldata, native value, withdrawal recipient, or generic transaction data.
3. The server reads the selected address on Shannon and verifies the audited
   VillaAccount runtime, on-chain owner, fixed contract wiring, and canonical
   VILLA operator authorization.
4. The request is keyed by `owner + VillaAccount`. An owner/account mismatch,
   invalid contract, or missing operator authorization fails closed.
5. In an armed deployment, the per-account session registry creates an isolated
   bridge with that identity. The legacy/global execution flag stays false.
   VILLA_ACCOUNT_EXECUTION_ENABLED is the separate account-session gate; when
   false it returns ACCOUNT_EXECUTION_DISABLED, and when true it still
   requires every identity and preflight check before a writer can start.

The private runtime has no process-wide owner or VillaAccount. The root-only
account broker independently verifies the typed owner/account pair before
writing a root-owned session binding and starting a fixed systemd unit. The
private unit reads that binding through systemd and receives the signer only as
its external credential. The public API and browser never receive signer
material.

Stop and settlement are reauthorized against the same owner/account binding.
The broker also checks the existing root-owned binding before stopping or
settling a session. The private engine retains its existing typed writer,
account-bound calls, lease, reconciliation, and owner-only withdrawal boundary.

The legacy/global release path stays disabled. A deliberately account-enabled
deployment may start only a verified owner-bound session; the browser still
cannot sign, choose arbitrary calls, or receive the private credential.
