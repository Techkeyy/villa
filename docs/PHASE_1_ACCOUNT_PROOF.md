# Phase 1 per-user account proof

Status: **PASS on Somnia Shannon**

This document records the smallest safe account boundary before public Add
Liquidity is enabled. It is deliberately separate from the historical single
operator-wallet proof. The proof used disposable testnet wallets and the
existing VILLA automation identity only as the explicit operator caller.

## Proof conditions

- Network: Somnia Shannon, chain `50312`
- Starting commit: `cee9003cfc12d7c63bf9eff7842e0ff2f0f8b856`
- Contract: direct `VillaAccount` deployments with immutable DreamDEX wiring
- Wallet A owner: `0xCAecf98CD369D57e4e6c0f332C31815C192b7a81`
- Wallet B owner: `0x644d171741c86E2e787cA4817248e0759b69a379`
- VILLA operator: `0xaf4ee6C0c6Ff6337F4C4F07b87C8343dF73e8d37`
- Wallet A account: `0xe78bd09d6869e450e66a49d1d3beebbfa75fb0cd`
- Wallet B account: `0x811c7940f5b574f16f7a732dcb31397883942d03`
- Market A: `0x000000000000000000000000000000000000000000000000000000000000c111`
- Successor Market B: `0x000000000000000000000000000000000000000000000000000000000000c11d`
- Signer material: process-local only; no private key was written to tracked
  files or logs
- Execution: Shannon testnet only; no production signer, no public deposit
  integration, and no public Add Liquidity surface

## On-chain evidence

| Required condition | Result | Evidence |
| --- | --- | --- |
| Wallet A funding | PASS | 10,000,000 tUSDC deposited into Account A; funding tx `0x22a0476f06be2d7af9ab04799ae9669ad73cf60d3d5c52758a3ade3cce46bba1` |
| Wallet B funding | PASS | 10,000,000 tUSDC deposited into Account B; funding tx `0x1aa4875651889bc571ada020b74429ee2779034883b93d6e6a7a6529604fbc40` |
| Account deployment | PASS | Account A deploy `0x9242514abfb40cad10f6ca8b9d6e291d70aedee637cb7a9c642b45efbbeac552`; Account B deploy `0x47361933b57c209ee2df7c3fcc0bc15bf00455243b5b004d67024b287350be3f` |
| Complete-set mint | PASS | Operator mint for Account A tx `0x7a79042b0ff177229f34f7c191e99c25b18bb8ce81797419d46a1327d68d344c` |
| Real EC order placement | PASS | Account A was the on-chain order owner; order ID `73786976294838275019`; tx `0x81c0bed9958beba476275db3c9099203c7b3183005e078b9e20d6b988a2ca676` |
| Cancellation | PASS | The same order was cancelled; tx `0x6b01fdd961239cffd4703c197c0c7c87cd4df58d5a6e6bf18f7aa89014fc0c2e` |
| Paired burn | PASS | Account A YES/NO inventory reached zero; tx `0xf3256157c14d4f11ab062fede22d44c91000575bba9c3042dbec1d7b4e4e8ede` |
| Owner withdrawal | PASS | Account A returned 10,000,000 raw collateral to Owner A; tx `0x4ad6682c19e0a5e56eefd1b3c839285c6d2c73ef8fcbe6884195e164d91ffcf9` |
| Settlement and redeem | PASS | Market A resolved with NO winning; Account B redeemed 1,000 units; tx `0x0c3c1881bf5e35135375e2a36b5bf6271cc5bcb4ddc4420c3c57571603689970` |
| Settled owner withdrawal | PASS | Account B returned 10,000,000 raw collateral to Owner B; tx `0x17f8cae136373883079a89005f6c653251cedd649ca032717f25251ad3df2422` |
| Same-account rollover | PASS | Account A prepared successor Market B `c11d`; tx `0x170eb8e8d8a24ffb9450941eb55222ef36e1b6842608e162a33d5810f395197a` |

The proof generated 25 mined transactions in total. The complete structured
runtime record is intentionally ignored at `runtime/state/` so no disposable
wallet key material can enter the repository.

## Security evidence

| Check | Result |
| --- | --- |
| Operator withdrawal | Rejected |
| Attacker withdrawal | Rejected |
| Attacker operator action | Rejected |
| Operator ownership change | Rejected |
| Revoked-operator action | Rejected after owner revocation |
| Two-LP isolation | PASS: distinct accounts, Account B had zero orders while Account A placed the verified order |
| Zero unrequested orders | PASS |
| Zero unrequested transactions | PASS |
| Zero runner spawn | PASS |

Owner withdrawals have no destination argument and are hard-coded to the
current owner. Operator vault claims call the fixed DreamDEX pool from the
account, so any payout is credited to the account rather than the operator.
There is no generic call surface, arbitrary token transfer, arbitrary
withdrawal destination, or signer material in the account contract.

## Deterministic and regression gates

- Account policy and contract-structure tests: **9/9 passed**
- Full VILLA test suite including account tests: **417/417 passed**
- Existing fair-value, risk, and quote modules remained unchanged
- The public Add Liquidity integration remains disabled

## Stop conditions

The proof would be a FAIL if a contract account could not be the on-chain
order owner, if protocol payout could not remain pinned to the account/owner
boundary, if an operator could withdraw to an arbitrary destination, if a
successor market required generic call permission, or if the protocol's
current interface no longer matched the pinned assumptions. None occurred in
this Shannon proof.

Phase 1 stops here, before public deposit integration, production execution,
or wet trading.
