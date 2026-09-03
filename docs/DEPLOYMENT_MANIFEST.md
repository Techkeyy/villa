# VILLA deployment manifest

This manifest describes the intended release topology. It contains no
credentials and is not a deployment command.

## Private runtime

- Host the private account runtime under /opt/villa-private-runtime.
- Run villa-engine-uat@.service and villa-engine-uat-settle@.service as
  villa-engine.
- Bind each session to one owner, one VillaAccount, and one generated session
  id through the root-owned /run/villa-uat-bindings directory.
- Require the binding file before either private unit can start.
- Load the signer only through the private service credential path. The
  public API and broker receive no signer value.

## Broker and systemd boundary

- Run villa-uat-broker.service as root with the fixed Unix socket
  /run/villa-uat-broker/control.sock.
- The broker may start or settle only after full owner/account/operator
  verification. Stop uses an existing exact binding so cleanup remains
  available after a later operator-authorization change.
- The broker is denied access to /etc/villa-engine.env.
- The fixed wrapper is not granted through sudo. The broker is the only
  privileged control boundary.

## Public operator API

- Run the owner-authenticated API separately from the private runtime.
- Bind it only to its intended private host/interface and expose it through
  the approved HTTPS reverse proxy.
- Keep VILLA_EXECUTION_ENABLED=false for the legacy/global control path.
- Use VILLA_ACCOUNT_EXECUTION_ENABLED=true only for a deliberately armed
  account-control deployment. The default or safe deployment may leave it
  false.
- Use VILLA_PUBLIC_ACCOUNT_CONTROL_ENABLED, VILLA_ALLOWED_ORIGINS,
  VILLA_ENGINE_OPERATOR, RPC_URL, INDEXER_URL, and WS_RPC_URL as non-secret
  configuration names.
- OPERATOR_PRIVATE_KEY, TAKER_PRIVATE_KEY, and equivalent signer material
  are absent from the public API and broker environments.

## Vercel frontend

- Deploy the checked-in dashboard build with / as the explainer, /app as the
  owner workspace, and /proof as read-only evidence.
- Configure only the non-secret VILLA_ENGINE_API_URL engine origin.
- Do not configure a signer, private key, or transaction relay credential in
  Vercel.

## Release verification

- Confirm the public repository contains no secret or .env material.
- Confirm public route runtime behavior for /, /app, and /proof.
- Confirm authenticated account Start requires the dedicated account gate,
  while Stop remains capable of reaching an already-running bound session.
- Confirm deployment configuration before any production rollout. No
  deployment, transaction, or wet execution is performed by this manifest.
