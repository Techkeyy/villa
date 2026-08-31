# Phase 3B1A.2 owner preparation

This is a local preparation layer for the disposable LP only. It reads a
fresh Shannon BTC 5-minute market, runs the existing fair-value, risk, quote,
account, and policy boundaries, and then emits public unsigned wallet
requests. It never reads a private key, signs, broadcasts, funds the operator,
starts the engine, or changes the public Start flow.

## Exact owner boundary

`VillaAccount.approvedMarkets[marketId]` is a market-specific boolean. The
owner changes it with:

```text
to: VillaAccount 0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2
method: setMarketApproval(bytes32,bool)
selector: 0xccb658f7
args: [freshMarketId, true]
```

`setMarketApproval` is `onlyOwner`, rejects the zero market id, and is keyed by
the exact market id. Every successor market therefore needs a new approval.
The engine operator cannot grant or change this permission.

## Exact protocol boundary

`prepareMarket(bytes32)` is also `onlyOwner` on the VillaAccount:

```text
to: VillaAccount 0x3A46446A30F945d390A41dAab0D390fBEf3d2cF2
method: prepareMarket(bytes32)
selector: 0x057e80da
args: [freshMarketId]
```

The call first requires the market-specific approval, derives the current
pool from the fixed binary module, and makes two internal calls from the
VillaAccount to the outcome token:

```text
setOperator(derivedPool, true)
setOperator(binaryModule, true)
selector: 0x558a7297
```

These are the minimum protocol permissions. The owner does not directly
approve an arbitrary pool or outcome spender. No persistent collateral
allowance is required: the account uses exact per-operation allowances and
resets them to zero.

## Fresh-market gate

`npm run phase3b1a:owner-prep` invokes the read-only shadow pipeline on every
run. It requires the exact `BINARY:BTC:300` series, Trading status, an
unfinalized compatible pool, at least 120 seconds of chain-time headroom, a
current fair-value/risk snapshot, and a genuine post-only quote. `NO_QUOTE`, a
stale market, a finalized pool, a failed grid check, a crossed order, or a
missing governor permission produces no owner requests.

The quote must also have a non-empty account-bound shadow action set that has
already passed the central Phase 3B1 transaction policy. A planner result by
itself is not enough.

The helper displays account, owner, market id, expiry, headroom, action, target,
method, approval, selector, and reason for each unsigned request. It must be
rerun after any owner approval so that market expiry, approval state, protocol
operator state, inventory, order state, gas, risk, and quote facts are read
again from the chain.

The request sequence is intentionally serialized: while
`approvedMarkets[marketId]` is false, the helper emits only
`setMarketApproval`. It emits `prepareMarket` only on a later fresh run after
the approval is observed on-chain. This prevents a known owner-side revert and
forces a new 120-second headroom check between the two actions.

## Gas reserve policy

Native gas is attributed to the canonical operator EOA, because the
VillaAccount owns collateral and positions but does not receive native STT.
The prep calculation uses the configured `minGasReserve` of 0.1 STT, the
bounded Phase 3B1 cap of 12 transactions, a planning ceiling of 1,000,000 gas
per transaction, and a transparent 25% margin. This is a reserve calculation
only; it does not fund or set a transaction gas limit.

## Deferred gates

Even after owner preparation, signer installation and `VILLA_EXECUTION_ENABLED`
remain separate gates. The intended post-preparation blockers are exactly
`SIGNER_NOT_INSTALLED` and `EXECUTION_DISABLED`; the engine remains stopped
until Phase 3B1B explicitly authorizes otherwise.
