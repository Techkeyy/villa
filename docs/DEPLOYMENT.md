# VILLA deployment boundary

## Chosen shape

Vercel is the primary public frontend for the VILLA cockpit. It serves the
dashboard assets and the small operator configuration response. The private
operator API is a separate owner-controlled service; it is never hosted with
the execution signer on Vercel.

The existing native Node dashboard server remains the local and legacy replay
path. `render.yaml` describes that replay-only fallback for
https://villa-yhzx.onrender.com. Render is not the primary VILLA UI.

The public repository is published at https://github.com/Techkeyy/villa.

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

- `npm start` starts the local replay mode and respects the platform `PORT` value;
- `HOST` defaults to `127.0.0.1` locally and is set to `0.0.0.0` in the hosted
  configuration;
- the legacy replay service exposes `/`, `/api/scenes`, `/api/snapshot?scene=quote`,
  `/api/snapshot?scene=rollover`, `/api/snapshot?scene=settlement`, and the
  optional `mode=live` read-only route;
- replay is the availability baseline and never silently substitutes for live;
- `scripts/dashboard-build.mjs` copies the favicon and checks its presence.

## Publication checklist

Before calling public deployment complete, record the Vercel project, public
HTTPS URL, deployed commit, build result, and environment variable names only.
Then test the primary Vercel URL in a browser at 1440x900, 1366x768, and
390x844. The legacy Render service may be checked as replay evidence, but it is
not the primary operator product.
