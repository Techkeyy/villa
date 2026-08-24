# Hackathon — build requirements

Source of truth: [DoraHacks Event Contracts Hackathon](https://dorahacks.io/hackathon/event-contracts/detail), read 2026-08-24.

This file is the judging-facing constraint list. Implementation is planned backwards from it.

## Facts

| Item | Value | Label |
| --- | --- | --- |
| Name | Somnia × DreamDEX Event Contracts Hackathon | Confirmed |
| Organizers | Somnia, DreamDEX; platform DoraHacks | Confirmed |
| Format | Virtual | Confirmed |
| Pre-registration | 2026-08-18 00:00 on DoraHacks | Time confirmed, **timezone unlabelled** |
| Submission opens | 2026-08-25 00:00 on DoraHacks | Time confirmed, TZ unlabelled |
| Deadline display | 2026-09-08 18:00 on DoraHacks | Time confirmed, **timezone Unknown** |
| Eventbrite mirror | 25 Aug 15:00 UTC → 9 Sep 09:00 UTC | Confirmed as Eventbrite; **conflicts** with DoraHacks clock. Do not prefer Eventbrite. |
| Prize | $5,000 USDso, split unpublished | Confirmed pool / Unknown split |
| Eligibility | Worldwide, individual or team | Confirmed |
| Team cap | Unstated | Unknown |
| Tracks / sponsor bounties | None | Confirmed |
| Registered hackers | 163 | Confirmed at research time |
| Required network | **Testnet prototype** | Confirmed. Mainnet not required. |
| Required integration | Meaningful use of DreamDEX Event Contracts and APIs/SDKs | Confirmed |
| Repo | Public GitHub/GitLab/Bitbucket | Confirmed |
| Demo video | Required, 2–3 minutes | Confirmed |
| Optional | Deck; SDK/docs feedback report | Confirmed |

Telegram named for updates and STT faucet pointer: https://t.me/+XHq0F0JXMyhmMzM0

STT faucet also: https://testnet.somnia.network/

## Judging weights (Confirmed)

| Criterion | Weight | What a judge can actually see |
| --- | --- | --- |
| Technical Implementation | 25% | Live Event Contract writes via the current SDK, not a mocked book |
| Innovation & Originality | 20% | Not `ec-maker` with a skin. Independent value + governor |
| UX & Design | 20% | Operator can understand and control without reading logs |
| Business & Ecosystem Impact | 20% | Real quotes on DreamDEX books; activity; adoption |
| Presentation & Demo | 15% | Problem, solution, working demo, honest limits |

## What organizers say they want

Consumer trading apps, AI agents, analytics, social prediction, or new experiences.

## What they score as ecosystem impact

Attract users, **generate trading activity**, increase Event Contracts adoption, expand DreamDEX, sustainable use case.

Empty books are the venue's bottleneck. A maker that actually rests liquidity is doing the job they are hiring for. A prettier betting UI is not.

## Translated BUILD REQUIREMENTS

1. **Must run on Shannon testnet (chain 50312).** Mainnet is out of scope for submission.
2. **Must use `@somnia-chain/markets-sdk` ≥ 0.28.0** for Event Contracts. The HTTP API is spot-only (official Event Contracts page). Using CCXT or the spot HTTP API as the Event Contract path **fails Technical Implementation**.
3. **Must show a working prototype**, not a slide. At least one live market, real orders or a documented live write-path plus an honest demo of the loop.
4. **Must be distinguishable from the official bot kit in the first minute of the video.** Independent fair value, inventory-aware quoting, and a visible risk halt.
5. **Must have an operator UX**, because UX is 20% and VILLA's user is the LP, not the bettor.
6. **Must handle settlement/claim**, because otherwise capital dies and the lifecycle claim is false.
7. **Must ship a public repo + 2–3 min demo.** Submit early; edit after.
8. **Should file the optional SDK/docs feedback report.** Cheap technical-judge signal. Already have real gotchas: venue id drift, priceFeed missing from quickstart, strike=0 opening-price path, indexer status vs on-chain status.
9. **Must not fake fills or wash-trade for the demo.** If a second wallet is used to cross a quote, disclose it.
10. **Do not spend demo minutes on logos.** Judges have 5 minutes. Show the desk moving.

## Official resources (use these, not memory)

- Bot kit: https://github.com/somnia-chain/dreamdex-bot-kit
- Event Contracts docs: https://docs.dreamdex.io/developers/event-contracts
- Bot Builder: https://dreambot-builder.vercel.app/ — **crowded Telegram-bot shape. Not VILLA.**
- SDK package actually installed here: `@somnia-chain/markets-sdk@0.28.1`

## Deadline risk

Timezone on DoraHacks is unlabelled. Treat **2026-09-08 18:00** as the displayed cut and assume the earlier interpretation if unsure. Confirm in Telegram before the last day. A guessed timezone is the one mistake that voids the build.
