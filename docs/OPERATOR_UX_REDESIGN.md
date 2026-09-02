# VILLA Operator UX Redesign

Status: design checkpoint completed before implementation

## 1. Product understanding

VILLA is a professional control room for a single liquidity provider running a
bounded BTC 5 minute DreamDEX Event Contract session.

- Primary user: the operator who configures, starts, watches, pauses, and safely
  stops a bounded testnet liquidity session.
- Primary job: decide whether it is safe to allow VILLA to quote, then supervise
  the resulting session.
- Primary action: `START VILLA`, after a short pre-start review.
- Magic moment: the operator sees VILLA's fair value, risk permission, and quote
  posture become an explicit running session state.
- Trust requirement: capital, exposure, risk permission, engine state, and recent
  activity must be visible without reading implementation details.
- Product character: serious, analytical, trustworthy.

The product is interactive and financial. It needs a single focused operator
surface, plus a clearly labelled public replay mode for judges and visitors.

## 2. Design sources used

The implementation is guided by these actual files from the supplied design
skill:

1. `design-skill instructions`
2. `design-system reference`
3. `design text-audit script`

The first two files were read completely before UI changes. The audit script is
part of the implementation gate and will be run after the redesign.

## 3. Rules extracted and implementation evidence

| Rule from the skill | Current underuse or violation | Implementation change and direct evidence |
| --- | --- | --- |
| Design from the user's journey, not from a template | The current page begins as an engineering evidence wall. It has no entry, auth, pre-start review, or operator result loop. | The page order becomes arrival, understand, authenticate, review, start, supervise, stop, and inspect history. Evidence: `dashboard/index.html` sections named `operator-entry`, `preflight`, `session-controls`, `session-overview`, `activity`, `lifecycle`, and `advanced`. |
| One primary action | The current top bar gives replay and live mode equal weight, while no real operator action exists. | `START VILLA` is the only dominant action in the pre-start area. Pause and stop are secondary. Emergency cancel is danger styled and confirmation gated. Evidence: `[data-action="start"]`, `[data-action="pause"]`, `[data-action="stop"]`, and `[data-action="emergency-cancel"]`. |
| Readable type | The current cockpit uses many 11px and 12px labels and a dense all-caps vocabulary. | Body copy and operator instructions stay at 15px or larger. Small type is limited to metadata and identifiers. Evidence: tokenized `--text-body`, `--text-small`, and the audit script result. |
| Hierarchy comes from size, weight, spacing, position, and contrast | System state, fair value, diagnostics, evidence, and balances compete as equal cards. | Status, market, capital, exposure, and risk occupy the first decision band. Technical diagnostics move into an Advanced disclosure. Evidence: `.operator-hero`, `.decision-grid`, `.session-controls`, and `.advanced-details`. |
| Avoid card-ification | The existing page wraps nearly every group in the same rounded panel. | The redesign uses one primary status surface, separators for related facts, and bordered groups only for independent actions or risk-bearing data. Evidence: `.status-board`, `.control-rail`, `.activity-list`, and limited `.surface` usage. |
| Defaults reduce cognitive load | There is no safe configuration or meaningful start path. | `Use safe defaults` is the preferred action and fills the bounded verified policy. Advanced limits remain collapsed until requested. Evidence: `[data-action="safe-defaults"]` and `DEFAULT_OPERATOR_CONFIG`. |
| The four states are real | The current unavailable state repeats dead metrics and live failure does not offer an operator path. | Loading, empty, success, and error are represented in the operator connection, engine state, activity, and control feedback. Evidence: `[data-state="loading"]`, contextual empty copy, `[data-state="success"]`, and `[data-state="error"]` with retry and safe-state text. |
| Hide technical complexity | The current interface exposes model internals before operator actions. | Human labels lead the page: `Capital allowed`, `What VILLA thinks`, `Permission to quote`, and `What happened`. Raw event codes and model diagnostics are under Advanced. |
| Web3 wallet guidance | The current page shows a wallet address but has no ownership flow. | Connect wallet is explained as ownership confirmation, then a nonce signature is requested. The copy explicitly says this is a message signature and sends no transaction. Evidence: `Connect wallet`, `Confirm you own this wallet`, and the auth status region. |
| Status is not color-only | Current state and governor badges rely heavily on color. | Every state uses a text label, a status dot, and an explanatory sentence. Focus and live status are announced through the existing live region. |
| Responsive behavior is intentional | The current desktop grid collapses into a long sequence of panels and the mobile top bar becomes crowded. | Mobile order keeps status, capital, risk, and the main action first. Advanced evidence follows. Controls remain reachable with 44px touch targets. Evidence: the 1024px and 390px media rules and browser QA matrix. |
| Accessibility | The current page has good focus styling but no labelled operator form, auth flow, confirmation dialog, or disabled-action explanation. | Use semantic `section`, `fieldset`, labelled inputs, `aria-live`, keyboard-visible focus, accessible button names, and a real confirmation dialog for emergency cancellation. |
| Motion restraint | The current page has a loading spinner and transitions but no meaningful control feedback. | Use short state feedback for network actions only. Respect `prefers-reduced-motion`. No decorative animation is added. |
| Copy is calm and specific | Current copy is technically accurate but often framed as evidence rather than an operator decision. | Rewrite visible operator copy around outcomes, with no em dashes or en dashes. Examples: `Start this bounded session`, `Stop new quotes safely`, and `Emergency cancel all orders`. |
| No fake functionality | The existing UI has no control calls to fake, but adding dead buttons would violate the product goal. | Every enabled control calls the authenticated control API. Unsupported actions are visibly marked `Not available in this engine` and are not clickable. |
| Financial product fit | The existing dark surface is credible, but the page is too diagnostic-first. | Retain a restrained dark console identity with warm amber action color, semantic green, warning, and danger colors. Figures use tabular numerals; prose uses the interface font. |

## 4. Intended page hierarchy

One page is sufficient because the operator repeatedly performs one connected
workflow and needs current state beside controls. Public replay remains a mode,
not a second product.

1. Top bar: VILLA, network, wallet/auth status, public replay or operator mode.
2. Operator entry: what VILLA does, current connection state, and the next action.
3. Pre-start review: BTC 5m, available tUSDC, allocation, exposure, order cap,
   fair value, venue midpoint, and Risk Governor permission.
4. Primary session board: engine state, market, time left, capital deployed,
   directional exposure, risk permission, and bid/ask posture.
5. Session controls: start, pause, resume, safe stop, and confirmed emergency
   cancellation.
6. Activity and inventory: recent engine events, active orders, fills, and
   current-market inventory.
7. Lifecycle: rollover and settlement or redeem state.
8. Advanced: model diagnostics, raw identifiers, and verified replay evidence.

## 5. Intended operator journey

`Arrive -> understand VILLA -> connect wallet -> confirm ownership -> review safe
defaults -> inspect fair value and risk -> start VILLA -> watch status and
activity -> pause or stop safely when needed -> inspect rollover and settlement`

The public journey is:

`Arrive -> understand VILLA -> enter verified replay -> inspect quote, rollover,
and settlement evidence`

## 6. Engine boundary decisions

The verified fair-value, risk, quote, inventory, rollover, settlement, and wallet
hygiene modules remain unchanged. The control plane will wrap the existing
bounded runner and expose only controls with real semantics.

- Start launches the existing bounded runner with validated configuration.
- Pause stops new quoting and cancels session-owned resting orders, then waits
  for an explicit resume. It does not pretend the engine is still quoting.
- Resume releases a real paused runner.
- Stop asks the runner to perform its existing cleanup and reconciliation path,
  then leaves the session stopped.
- Emergency cancel asks the same runner to stop with an emergency cleanup reason.
- If a safe operation cannot be supported by the runner, the API returns an
  explicit unsupported response and the UI does not create a dead button.

The execution signer stays inside the owner-controlled private engine service.
The browser and Vercel receive public state only.

## 7. Validation evidence required before completion

- Run the design text-audit script against the `dashboard` directory.
- `npm test`
- `npm run dashboard:test`
- `npm run dashboard:build`
- control-plane unit tests for nonce, auth, start, duplicate start, pause,
  resume, stop, cancel-all, config validation, refusal, and secret-free output
- rendered browser QA at 1440x900, 1366x768, 1024x768, and 390x844
- offline, HALT, NO_QUOTE, rollover, settlement, and dangerous-action checks
