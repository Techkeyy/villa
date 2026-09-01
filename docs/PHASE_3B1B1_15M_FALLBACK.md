# Phase 3B1B1 15-minute fallback

The owner-preparation helper keeps the original BTC 5-minute mode. The
15-minute mode is an operational fallback for the first account-bound wet
proof when the 5-minute market does not leave enough time for human wallet
review. It does not change the product strategy or the execution policy.

## Selection and proof gates

Both modes discover a fresh live BTC Trading market from the venue and verify
the market facts, YES book, opening reference, risk decision, account capital,
operator identity, and bounded projected path before displaying an owner call.

The 5-minute mode uses its existing gates: 240 seconds before the first owner
call, 180 seconds after market approval, and 120 seconds for the final
preflight. The 15-minute mode uses 600 seconds before the first owner call,
480 seconds after market approval, 360 seconds after protocol preparation
preflight, and 300 seconds before the wet-session handoff.

The owner still approves exactly two calls through the wallet: the
market-specific `setMarketApproval` call and, after the first receipt,
`prepareMarket`. The helper does not sign, broadcast, arm execution, place an
order, or send a blockchain transaction.

## Why 15 minutes is used for the proof

The 5-minute path remains supported for normal operation, but a short market
can lose its owner-review window while a human wallet prompt and receipt are
being handled. A 15-minute market provides the same binary BTC/Event Contract
shape with enough operational time to preserve the unchanged later gates.

The chosen path is still the lower-risk valid projection from the live book:
Path A is one post-only BUY_YES followed by cancel and reconciliation; Path B
is the minimum mint, one post-only SELL_YES, cancel, reconciliation, and burn.
No path is accepted when its quote, risk, venue, account, or transaction-policy
checks fail.
