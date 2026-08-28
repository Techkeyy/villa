# VILLA private operator engine

This runbook prepares the owner-controlled long-running engine service. It is
not a deployment authorization and it does not place the execution signer on a
remote machine.

## Boundary

- Vercel serves the public product overview, read-only replay surface, and the
  small `/api/operator-config` config response.
- The private engine runs `scripts/villa-bounded.mjs` through
  `scripts/operator-api.mjs` on an owner-controlled VPS.
- The browser receives state and sends authenticated control requests. It never
  receives a signer, private key, wallet seed, or raw private service log.
- The MVP is single-operator testnet software. It is not a multi-user custody
  platform.

## Unarmed control-plane preparation

For the current unarmed phase, start only the control plane on the
owner-controlled VPS. A private key is not required while execution is
disabled:

```text
npm ci --omit=dev
npm run operator:dev
```

The service must bind on a private or reverse-proxied interface. Put HTTPS and
access control in front of it. Allow the Vercel origin exactly, with no wildcard
origin:

```text
PORT=8782
VILLA_BIND_HOST=127.0.0.1
VILLA_ALLOWED_ORIGINS=https://villa-ten-ashen.vercel.app
VILLA_EXECUTION_ENABLED=false
OPERATOR_ADDRESS=<authorized wallet address>
```

The existing read-only network variables may also be supplied to the private
engine as required by the verified live adapter:

```text
RPC_URL=<private VPS value>
WS_RPC_URL=<private VPS value>
INDEXER_URL=<private VPS value>
PRICE_FEED_URL=<private VPS value>
NETWORK=<private VPS value>
VENUE_ID=<private VPS value>
```

Do not commit these values. Do not install `OPERATOR_PRIVATE_KEY`,
`TAKER_PRIVATE_KEY`, a mnemonic, or a seed phrase during this phase. The API
can boot, authenticate, and expose safe read/control-plane state without a
signer. START remains `EXECUTION_DISABLED`, no writer is spawned, and no
transaction can be sent.

Only after a separately approved wet phase may the owner add
`OPERATOR_PRIVATE_KEY` to a restricted VPS secret store. It must never enter
Vercel, the browser bundle, API responses, screenshots, or service logs.

## Frontend connection

After the private service has a verified HTTPS URL, the Vercel project may set
this non-secret frontend variable:

```text
VILLA_ENGINE_API_URL=https://operator.example.invalid
```

The value must be the HTTPS origin of the private operator API. It is safe for
the browser to know this URL, but the API must still require the short-lived
wallet-signature session for state and control routes.

## API and control semantics

- `GET /health` is a non-writable service check.
- `POST /auth/nonce` and `POST /auth/verify` implement wallet message-signature
  authentication. Signing sends no blockchain transaction.
- `GET /state`, `/config`, and `/activity` require a bearer session.
- `POST /session/start` refuses with `EXECUTION_DISABLED` unless
  `VILLA_EXECUTION_ENABLED` is exactly `true`. The default and the current
  deployment phase are unarmed: no writer is spawned, no order is created, and
  no transaction can be sent. Only an explicitly approved wet phase may set
  the flag to the exact string `true`, after the owner has reviewed the VPS
  custody and safety controls.
- When explicitly enabled, `POST /session/start` launches the existing bounded
  runner after lower-only configuration validation and a live Risk Governor
  preflight.
- `POST /session/pause` cancels session-owned resting orders and stops new
  quoting until an explicit resume.
- `POST /session/resume` releases a real paused runner.
- `POST /session/stop` performs the runner cleanup and reconciliation path.
- `POST /orders/cancel-all` performs the same safe cleanup with the explicit
  emergency reason. It does not liquidate unmatched inventory.

The service exposes explicit operator states including `STOPPED`, `STARTING`,
`WATCHING`, `QUOTING`, `NO_QUOTE`, `REDUCE_ONLY`, `HALTED`, `PAUSED`,
`ROLLING_OVER`, `SETTLING`, `STOPPING`, and `ERROR`.

## Readiness checks

Before any owner deployment, verify locally:

```text
npm run operator:test
npm test
npm run dashboard:test
npm run dashboard:build
```

The current phase stops at local validation. The exact next human action is to
review and approve the private VPS custody step, then deploy the private engine
with HTTPS and the exact Vercel origin. No signer deployment is performed by
this phase.
