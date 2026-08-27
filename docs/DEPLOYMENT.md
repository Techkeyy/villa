# VILLA deployment boundary

## Chosen shape

VILLA is prepared for one native Node web service. The service runs the
existing dashboard server in replay mode with `npm start`, serves the cockpit
assets, exposes the recorded scene list and snapshots, and keeps the optional
live read-only endpoint available only when explicitly requested. `render.yaml`
describes the smallest provider-neutral Render web-service configuration for
this shape.

Render was selected for the deployment preparation because the current product
already is a Node HTTP service. It does not require a framework migration or a
serverless rewrite. Actual publication still requires an authenticated public
repository and hosting account.

## Hosted security model

The hosted service must contain no `OPERATOR_PRIVATE_KEY`, `TAKER_PRIVATE_KEY`,
wallet seed, signer, or write-capable environment variable. The only hosted
configuration prepared here is `HOST=0.0.0.0`; replay needs no secrets. Public
browser capabilities are observation only:

- replay scenes and recorded evidence;
- public market reads when a read-only Shannon configuration is supplied;
- fair-value, risk, and quote-plan projections from read-only inputs.

The hosted service must not place, cancel, mint, burn, redeem, or start the
bounded wallet writer. Wet commands remain local and are not part of the
deployment command.

## Runtime details

- `npm start` starts replay mode and respects the platform `PORT` value;
- `HOST` defaults to `127.0.0.1` locally and is set to `0.0.0.0` in the hosted
  configuration;
- the service exposes `/`, `/api/scenes`, `/api/snapshot?scene=quote`,
  `/api/snapshot?scene=rollover`, `/api/snapshot?scene=settlement`, and the
  optional `mode=live` read-only route;
- replay is the availability baseline and never silently substitutes for live;
- `scripts/dashboard-build.mjs` copies the favicon and checks its presence.

## Publication checklist

Before calling deployment complete, record the provider, service name, public
HTTPS URL, deployed commit, build/runtime result, and environment variable
names only. Then test the public URL in a browser at 1440x900, 1366x768, and
390x844, including all three replay scenes and the honest live-unavailable
state if live reads cannot be configured safely.
