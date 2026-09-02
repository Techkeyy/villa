# VILLA skills compliance checkpoint

Date: 2026-09-02

This final checkpoint records completion of the release gates. It applies the current
Desktop skill instructions to the already audited VILLA repository. It does
not restart Phase 7A, change the backend strategy, or authorize a new trading
feature.

## Recovered state

- Repository: `the VILLA repository`
- Branch: `master`
- Starting HEAD for this checkpoint: `6e14e817e6fef03679c03803b5adddc6331e3552`
  (`Complete Phase 7A final pre-submission audit`)
- Starting worktree: clean at the start of the checkpoint; the only current
  change is the UI-only fix recorded below.
- Expected handover commit `8c9619bb53fea0ae21214bbb883e6406fb7292ff` is an
  earlier milestone. The repository contains legitimate later VILLA commits
  through Phase 7A and was not reset.
- Existing `.env` was confirmed present and remains ignored. Its contents were
  not read, printed, copied, or changed.
- Phase 1 and later lifecycle evidence were recovered through the current
  `README.md`, phase evidence in `docs/TECHNICAL_VERIFICATION.md`,
  `docs/FINAL_AUDIT.md`, and the linked implementation files. No wet test was
  rerun for handover reassurance.

## Compliance matrix

| Skill | Material requirement | VILLA application and evidence | Status | Change or follow-up |
| --- | --- | --- | --- | --- |
| `audit-skill` (`audit-skill instructions`) | Compare claims with implementation, test hygiene and history, try to break the project, report verified and unverified limits, and avoid assuming success. | `docs/FINAL_AUDIT.md` contains the 44-section audit, severity dispositions, secret/history scans, live-read limits, zero-transaction result, test/build results, and known limitations. `docs/SOURCES.md` maps technical claims to source or evidence. | PASS | This release checkpoint cross-checks the final public README and submission package against implementation and evidence. |
| `build-process` (`build-process instructions`) | Read before editing, preserve the core loop and boundaries, verify external reality, keep pure logic reproducible, test before commit, and avoid fake success. | The repository retains separate fair value, governor, quote, execution, lifecycle, orchestrator, and dashboard boundaries. Phase records show deterministic tests, fixture/replay paths, live read checks, explicit refusal states, and no unbounded daemon claim. | PASS | Phase 7B follows the same order: verify deadline and hosting reality, prepare the frozen artifact, test public replay, then package evidence. |
| `perfect-readme` (`perfect-readme instructions`) | Use real outputs and working links; explain the problem before the product; include quickstart, architecture, differentiation, adversarial checks, limitations, and no phantom features. | The final README is the public product and developer handoff. It includes verified links, public replay, current test counts, honest limitations, security boundaries, and SDK context. | PASS | Keep the public README and submission copy synchronized with verified release URLs. |
| `design-skill` (`design-skill instructions`) | Inspect the rendered product at required viewports, check hierarchy, readability, responsive behavior, accessibility, states, and text hygiene; fix concrete violations only. | Fresh replay cockpit audit at 1440x900, 1366x768, 1024x768, and 390x844. The mobile scene switcher had clipped controls and several controls/text blocks were below the readability/target-size floor. The minimal fix is in `dashboard/styles.css`; after reload all three scene controls are visible at 390px, scene and copy controls are 44px high, text audit passes, and the dashboard suite/build pass. Screenshots are in `.scratch/phase-7b-design/*-after.png`. | PASS | No redesign was introduced. The UI text audit, local runtime checks, and public route checks passed after deployment. |
| `project-understanding` (`project-understanding instructions`) | State the one-sentence product, actors, problem, before/after, user/system journey, magic moment, data flow, trust boundary, load-bearing assumption, MVP, and non-goals in normal language. | `docs/PROJECT_UNDERSTANDING.md` records VILLA as an operator LP desk, distinguishes operator from traders, explains the independent value and lifecycle journey, identifies the magic moment, maps components and data flow, documents custody/trust, and lists MVP/non-goals. | PASS | Carry this language into the public README and demo script. |
| `project-edge` (`project-edge instructions`) | Audit differentiation against the rubric and rivals, name the lane, connect claims to evidence, present a product rather than a prototype, and check the final links/form. | `docs/HACKATHON.md`, `docs/PROJECT_UNDERSTANDING.md`, `docs/DECISIONS.md`, and `docs/FINAL_AUDIT.md` make the lane explicit: VILLA is an operator liquidity engine above DreamDEX plumbing, not `ec-maker` plus a dashboard. Independent value, governor, inventory, settlement, rollover, and cockpit evidence are all present. | PASS | The distinction is visible above the fold, in the evidence table, and in `docs/SUBMISSION.md`; the public link and submission fields are prepared for final human review. |
| `hackathon-onboarding` (`hackathon-onboarding instructions`) | Verify current official rules, deadline, eligibility, judging, required links/assets, testnet constraints, and ecosystem framing; label Confirmed/Inferred/Unknown. | Existing `docs/HACKATHON.md` records the official Dora page, current known requirements, weights, Shannon chain 50312, and the unresolved Dora timezone conflict. The official Dora page still requires a fresh browser check before submission planning. | PARTIAL | Open the current official Dora page in the browser, capture its displayed deadline/status/fields, label timezone exactly, and update `docs/HACKATHON.md` and `docs/SOURCES.md` with only current verified facts. |

## Concrete design audit result

The cockpit remained a single read-only operator page. The audit found three
specific violations and fixed only those:

1. At 390px, the three scene controls were clipped by a horizontal scroller.
2. Scene, mode, and copy controls were below the approximately 44px target
   size recommended by the design skill.
3. Several explanatory and evidence text blocks used 12px text.

The fix raises target sizes and supporting text, allows the scene controls to
fit the mobile layout, and leaves the information hierarchy and visual system
unchanged. Post-fix checks:

- 1440x900, 1366x768, 1024x768, and 390x844 rendered and inspected;
- no global horizontal overflow at the required viewports;
- all three scene buttons visible at 390px;
- `python scripts/audit_ui_text.py dashboard`
  passed with 0 long-dash errors and 0 small-text warnings;
- `npm run dashboard:test` passed 95/95;
- `npm run dashboard:build` passed;
- browser console error/warning log was empty for the inspected replay page.

## Phase 7B gate

The skill applications are complete for this release. The remaining
PARTIAL items are deliberate sequencing states, not hidden product defects:
the final hackathon deadline and fields need a current official browser check before human submission. No signer, writer, or transaction path
was added or connected.
