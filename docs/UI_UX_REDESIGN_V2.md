# VILLA UI/UX Redesign V2

Status: Phase 0 implementation brief

## Information architecture

### `/` Public explainer

1. Hero: VILLA, a clear LP-oriented statement, short supporting copy, Launch VILLA, and See how it works.
2. How it works: Add liquidity, VILLA prices, VILLA quotes, VILLA manages risk, VILLA settles and rolls.
3. Why VILLA: independent pricing, Risk Governor, automatic rollover, and capital-control model.
4. Proven on Shannon: factual replay evidence for maker orders, external fills, rollover, settlement, and reviewable proof.
5. Final CTA: Launch VILLA.

The landing page explains the product without showing the entire technical architecture. It is written for judges, first-time visitors, and potential LPs.

### `/app` LP product surface

The app is organized around My Liquidity and My VILLA. The primary terms are Strategy, Capital, Risk, Orders, Activity, and Settlement. A disconnected visitor sees only the onboarding state. A connected visitor sees the capital setup state and clear development gating. Advanced details are collapsed or secondary.

### `/proof` verified evidence

Proof is a separate evidence surface. It contains replay status, scenario selection, lifecycle checkpoints, fills, rollover, settlement, and technical references. It is labelled as verified replay or evidence and is not mixed into the LP's primary control flow.

## Visual system

The implementation follows the required white and blue minimal product direction:

- white-dominant background,
- near-black primary text,
- one restrained blue for actions and emphasis,
- neutral gray supporting text,
- thin borders and modest radii,
- generous spacing and a readable type scale,
- minimal cards with clear grouping,
- no gradients, neon, purple, dark terminal treatment, glassmorphism, or tile-wall dashboard.

The interface uses one primary action per view, a clear state hierarchy, sentence-case labels, and plain-language copy. Buttons use a minimum touch target, visible keyboard focus, and disabled styling that explains why an action is unavailable.

## Reference influence

Ignix influenced the narrative sequence: strong hero, plain-English positioning, progressive explanation, modular sections, and a clear CTA into the product. It is a structure reference only. VILLA keeps its own LP vocabulary and safety boundaries.

Hummingbot and Condor influenced compact strategy and operational status patterns. Arrakis influenced LP-oriented capital visibility. dYdX influenced state-aware trading controls. Polymarket influenced readable market and outcome presentation. These references are patterns, not copied visual assets or copy.

## Design-skill application evidence

- Journey-first structure was defined in `docs/LP_USER_JOURNEY.md` before component work.
- Product language is LP-specific rather than generic SaaS language.
- The public page has one clear entry action and a short progressive story.
- The app separates onboarding, capital setup, strategy state, and advanced evidence.
- Disabled controls communicate development status and do not simulate transactions.
- Proof and replay are moved to a separate route.
- Responsive and accessibility checks cover 1440x900, 1366x768, 1024x768, and 390x844, with keyboard focus, reduced motion, overflow, and error-state review required at the implementation gate.
- The design text audit is run against the dashboard after implementation.

## Non-goals

This redesign does not implement deposits, withdrawals, per-user accounts, new custody, wet execution, or changes to the frozen VILLA strategy. It prepares an honest product surface for the next feasibility-led build phase.

