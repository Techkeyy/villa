# VILLA demo rehearsal script

Status: rehearsal script prepared. Recording and upload are intentionally not
performed by this task.

Target runtime: 2:40 to 2:50.

Start at the public product overview, [villa-ten-ashen.vercel.app](https://villa-ten-ashen.vercel.app/),
then use its verified replay action for the evidence scenes. The local replay
command is also available. The legacy Render replay URL,
[villa-yhzx.onrender.com](https://villa-yhzx.onrender.com), is a fallback only.
Every quote, fill, rollover, and settlement scene below is labelled REPLAY in
the cockpit and must be described as a replay of a real Shannon verification
session.

## Run of show

| Time | Screen and narration |
| --- | --- |
| 0:00-0:15 | Open VILLA. "Event Contract books need someone willing to quote them. VILLA is software for that liquidity operator, not another bettor screen." |
| 0:15-0:35 | Quote proof scene. Point to VILLA Fair and the DreamDEX midpoint. "VILLA forms its own UP probability from BTC, reference, time, and realized volatility. DreamDEX is comparison only and is not a model input." |
| 0:35-0:55 | Point to the post-only bid and ask, then Risk Governor. "The quote planner adapts around independent value. The governor decides whether a quote is allowed." |
| 0:55-1:20 | Show the quote event timeline. "This is a replay of a real Phase 4B Shannon checkpoint: a complete set was supplied and both post-only sides rested. The cockpit is not sending a transaction." |
| 1:20-1:40 | Switch to rollover proof. Highlight the terminal market, successor, fresh fair value, and NO QUOTE reason. "When the old window leaves Trading, VILLA closes that scope, rediscovers a later same-series window, and refuses a quote when the venue grid leaves no safe order." |
| 1:40-2:05 | Switch to settlement proof. Highlight the two organic fills and the NO residuals. "These are two genuine external SELL_YES fills from the bounded runner, not simulated fills." |
| 2:05-2:25 | Highlight the redeemed claims, payout reconciliation, known zero-value residual, and wallet hygiene. "Settlement uses the exact market and payout vector. The claim amounts reconciled, and the final audit found zero unknown inventory and zero active orders." |
| 2:25-2:45 | Close on the cockpit. "The stock DreamDEX maker supplies useful exchange plumbing. VILLA adds independent valuation, confidence-aware quoting, worst-case pending exposure, deterministic halts, settlement recovery, and successor rollover. It is bounded testnet software, with PnL and an indefinite daemon deliberately not claimed." |
| 2:45-2:50 | Show the public repo and demo URL. "The source, replay cockpit, evidence, and limitations are linked below." |

## Rehearsal checks

- Say that the direct user is the liquidity provider/operator.
- Say `REPLAY` aloud before discussing fills or redemption.
- Make the `DreamDEX comparison only` and `not a model input` labels visible.
- Explain the Risk Governor as a safety permission, not a price formula.
- Do not promise a fill, profitability, production PnL, or an always-on daemon.
- Keep the final cut under three minutes; cut implementation filenames before
  cutting the problem, independent value, or lifecycle proof.

## Evidence references

- Quote and adaptive planner: `docs/TECHNICAL_VERIFICATION.md`, Phase 4B.
- Organic fills and redemption: `docs/TECHNICAL_VERIFICATION.md`, Phase 6A
  and Phase 6A.1.
- Successor rollover: `docs/TECHNICAL_VERIFICATION.md`, Phase 5B and Phase 6A.
- Final wallet hygiene: `docs/BACKEND_FREEZE.md` and Phase 6A.2 evidence.
- Primary public URL: https://villa-ten-ashen.vercel.app/
