# VILLA deployment boundary

## Chosen shape

Vercel is the primary public frontend for the VILLA cockpit. It serves the
signer-free dashboard and public control API. The private operator API and
account engine are separate owner-controlled services; the operator signer is
never hosted on Vercel.

The native Node dashboard server remains a local replay and evidence fallback.
Render describes that fallback. It is not the hosted execution boundary.

The public repository is published at https://github.com/Techkeyy/villa.

## Hosted security model

The Vercel dashboard and public API contain no OPERATOR_PRIVATE_KEY,
TAKER_PRIVATE_KEY, wallet seed, signer, or write-capable credential. The
browser remains signer-free: it can authenticate an owner, select a verified
VillaAccount, and request account control, but it cannot sign or submit an
arbitrary transaction.

The private owner-controlled runtime is the only place that loads the operator
credential and performs bounded account-authorized execution. It may place,
cancel, mint, burn, redeem, or settle only after the existing owner, account,
session, market, lease, provenance, journal, admission, and policy checks pass.
The legacy unrestricted execution gate remains disabled.

The public proof route is read-only. Public API health and control state do not
expose signer material or another user account state.

## Runtime details

- npm start starts the local replay mode and respects the platform PORT value.
- HOST defaults to 127.0.0.1 locally and is set to 0.0.0.0 in hosted configuration.
- The local replay service exposes the explainer, scene data, snapshot routes,
  and an optional live read-only route.
- The hosted dashboard uses the public control API for authenticated account
  state; replay is a credential-free local fallback and never silently
  substitutes for live.
- The private runtime and broker load signer-capable code only behind their
  existing service boundary and durable admission checks.
- scripts/dashboard-build.mjs copies the favicon and checks its presence.

## Publication checklist

Before calling public deployment complete, record the Vercel project, public
HTTPS URL, deployed commit, build result, and environment variable names only.
Test the primary Vercel URL in a browser at desktop and mobile widths. Check
that the public API and account-control endpoint do not expose signer material
or another user state. The legacy replay service may be checked as evidence,
but it is not the primary operator product.
