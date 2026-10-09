# Implementation Plan

## Environment facts (apply to every task below)

Carried forward from design.md so no task has to rediscover them:

- **Client runner is Vitest via `ng test` with happy-dom, and it performs no layout.**
  `getBoundingClientRect` returns zeros, custom properties do not resolve, and
  `getComputedStyle` echoes authored values back. Assert **declared CSS and DOM structure
  only**, through `client/src/app/testing/declared-css.ts` (`declared`, `stylesFor`, `rulesOf`,
  `toPx`, `MOBILE_MEDIA`). Do not re-derive a parser. `contrast.ts` is not needed — the fix
  introduces no colour.
- **happy-dom has no `:scope` support.** Any DOM traversal must walk `children` /
  `querySelector` from a known element rather than using a `:scope`-rooted selector.
- **A backtick inside a CSS comment terminates the Angular `styles: [` template literal** and
  breaks compilation. Change 5 rewrites a stale comment — write that comment in plain prose,
  with no backtick-quoted selector or property names. Same rule for any other comment touched.
- **Property 27 scans `margin*`, `padding*` and `gap*` only**, splits each value on whitespace
  and runs `toPx` on every part, which **throws on `calc()` and `%`**. Keep every `calc()` and
  `min()` value on `max-height` and `width`, which are outside the scanned set. Every gap
  introduced is `8px 20px`, so both parts land on the 4px scale. `minmax(220px, 1fr)` and
  `minmax(150px, 1fr)` are `grid-template-columns`, also unscanned.
- **If any fast-check generator is introduced**, every `fc.array` / `fc.string` with a
  `maxLength` above 10 needs `size: 'max'` plus a post-`fc.assert` coverage assertion that
  fails loudly if the generator collapses. This is the §D3 failure mode in
  `docs/verification-coverage.md`. The chain domain here is a small finite table, so
  exhaustive iteration is preferred and no generator is required.
- **Expected non-failures — do not chase these.** Jest's "worker process failed to exit
  gracefully" notice; `npm warn Unknown user config "always-auth"`; three production build
  warnings (`anyComponentStyle` 9.71 kB on session-poker-page, non-ESM `qrcode`, non-ESM
  `html2canvas`).
- **Leave alone.** The deliberate long timeouts in `retro-resume-list.property.spec.ts` (120 s)
  and `retro-capture-mode.property.spec.ts` (180 s), and `server/jest.config.ts`'s
  `moduleDirectories` / `modulePaths`.
- **New test file for the two properties**: `client/src/app/components/retro-board/retro-board-layout-fixes.property.spec.ts`.
  The re-pointed R7.16 work in task 4 stays in the existing `retro-layout.spec.ts`, which is
  the R7.16 coverage reference.

---

- [ ] 1. Write bug condition exploration test over both chain contracts
  - **Property 1: Bug Condition** - The settings dialog scrolls and the vertical column stretches
  - **CRITICAL**: This test MUST FAIL on unfixed code — the failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behaviour — it validates the fix when it passes in task 3.4
  - **GOAL**: Surface counterexamples proving both chains are broken, and confirm the diagnosis — in particular that the vertical chain breaks at **four** links including the blocker wrapper, not just at the container
  - **Scoped PBT approach**: the domain is the deterministic 12-row chain table in design.md "Bug Details"; exhaust it by iteration over `SETTINGS_SCROLL` and `VERTICAL_STRETCH` rather than sampling it. Assert `declaredValue(link) === link.required` for every link of both contracts
  - Create `retro-board-layout-fixes.property.spec.ts` and encode the table as data: `{ surface, selector, property, required }` rows, surfaces being `RetroToolbarComponent`, `RetroBoardPageComponent`, `RetroColumnComponent`
  - Cover design.md's six exploratory test cases:
    - Case 1 — settings cap and scroller: `max-height: calc(100dvh - 48px)`, `display: flex`, `flex-direction: column` on `.retro-dialog--settings`; `display: grid`, `overflow-y: auto`, `min-height: 0` on `.retro-settings` — **must FAIL**
    - Case 2 — settings grid bands: `grid-column: 1 / -1` on `.retro-settings__layout`, `.retro-settings__section-label`, `.retro-settings__feelings`, and `display: grid` on the feelings container — **must FAIL**
    - Case 3 — vertical stretch chain: `align-items: stretch` on `.retro-board__columns--vertical` and on `.retro-board__columns > .interaction-blocker`; `align-self: stretch` and `min-height: 0` on `:host`; `height: 100%` on `.retro-column` — **must FAIL at all four links**
    - Case 4 — card list is the scroller: `flex: 1 1 auto`, `min-height: 0`, `overflow-y: auto` on `.retro-column__cards` — **must FAIL on the first two**
    - Case 5 — chain completeness (DOM): render the board and assert the only element between `.retro-board__columns` and the `app-retro-column` hosts is the `.interaction-blocker` wrapper. **Expected to PASS on unfixed code** — it pins the structural premise of the diagnosis rather than probing the defect. Walk `children` / `querySelector`; no `:scope`
    - Case 6 — pinned header: `flex-shrink: 0` on `.retro-column__header`. **Expected to PASS on unfixed code** — it guards an existing declaration the fix now depends on
  - Run on UNFIXED code: `cd client && npx ng test --watch=false`
  - **EXPECTED OUTCOME**: cases 1–4 FAIL, cases 5–6 PASS. `declared` throws on an absent declaration (`.retro-dialog--settings declares no max-height` and similar) — that throw is the honest counterexample report, not a test defect
  - Document the counterexamples in the task notes: six ABSENT/wrong values on the settings chain; `align-items: flex-start` on both the container and the blocker wrapper; `align-self: flex-start` on the host; `.retro-column` `height: auto`; `.retro-column__cards` `flex: 0 1 auto` with `min-height: 60px`
  - Mark complete when the test is written, run, and the 1–4 failures plus the 5–6 passes are recorded
  - _Bug_Condition: isBugCondition(X) over SETTINGS_SCROLL and VERTICAL_STRETCH from design.md "Bug Details"_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

- [ ] 2. Capture preservation baselines on unfixed code (BEFORE implementing the fix)
  - **Property 2: Preservation** - The horizontal layout and every non-settings surface
  - **IMPORTANT**: Follow the observation-first methodology — read each baseline value off the UNFIXED code and write it into the test as a literal. Do not assume values
  - Add these to the same new `retro-board-layout-fixes.property.spec.ts`, as an exhaustive iteration over the preservation table (the `is-horizontal` / `--horizontal` counterparts plus the unscoped dialog). The domain is roughly a dozen entries; exhausting it is strictly stronger than sampling, so no generator
  - Cover design.md's six preservation test cases:
    - Case 1 — horizontal column sizing: observe and pin `align-self` on `:host.is-horizontal`, `height` on `:host.is-horizontal .retro-column`, and `align-items` on `.retro-board__columns--horizontal` (3.1). Note: `stylesFor` matches selectors **exactly** and does not model the cascade across different selectors, so each `is-horizontal` value must be asserted on the `is-horizontal` selector itself
    - Case 2 — horizontal card row: pin `flex-direction: row`, `overflow-x: auto`, `overflow-y: hidden`, `min-height: unset` on `:host.is-horizontal .retro-column__cards`, and `flex: 0 0 200px` on the card width rule (3.2)
    - Case 3 — overflow confinement: pin `width: 100%` and `overflow-x: auto` on `.retro-board__columns--vertical`, and `min-width: 100%` and `flex: 0 0 auto` on the blocker wrapper (R7.12, R7.15; 3.3)
    - Case 4 — other dialogs: pin `padding: 24px` and `min-width: 300px` on the unscoped `.retro-dialog`, and assert it declares **no** `max-height`, so the Add Column and delete-confirmation dialogs stay untouched (3.6)
    - Case 5 — settings control set: render the dialog as moderator and as participant, at desktop and `MOBILE_MEDIA` widths, and pin the full inventory — six base toggles, the moderator-gated fluid card height toggle, the layout radios, the ten feeling toggles — with the same change handlers and the same gating (3.5)
    - Case 6 — spacing scale: confirm Property 27 in `retro-layout.property.spec.ts` passes as-is on the unfixed code, so its result after the fix is a meaningful comparison (3.8)
  - Also pin that cards keep their natural height, top-aligned: `.retro-column__cards` stays `flex-direction: column` with `gap: 8px` in the vertical layout, and no card rule declares a `stretch` cross-axis size (3.9)
  - Run on UNFIXED code: `cd client && npx ng test --watch=false`
  - **EXPECTED OUTCOME**: all preservation assertions PASS, confirming the baseline to preserve
  - Mark complete when the tests are written, run, and passing on unfixed code
  - _Preservation: Preservation Requirements from design.md "Expected Behavior"_
  - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6, 3.8, 3.9_

- [ ] 3. Fix the settings dialog scroll and the vertical column stretch

  - [ ] 3.1 Cause A — make the settings dialog a height-capped, internally scrolling grid
    - **File**: `client/src/app/components/retro-board/retro-toolbar.component.ts`, styles block only
    - Design change 1 — `.retro-dialog--settings`: keep `min-width: 320px`; add `width: min(620px, calc(100vw - 32px))`, `max-height: calc(100dvh - 48px)`, `display: flex`, `flex-direction: column`. Leave the unscoped `.retro-dialog` alone (3.6)
    - Design change 2 — `.retro-settings`: replace `flex-direction: column` with `display: grid`, `grid-template-columns: repeat(auto-fit, minmax(220px, 1fr))`, `gap: 8px 20px`, `align-content: start`, `overflow-y: auto`, `min-height: 0`. Retain the existing `margin-bottom: 16px`. `auto-fit` gives the narrow-viewport collapse with no media query; `min-height: 0` is load-bearing — without it the grid's automatic minimum size defeats the cap
    - Design change 3 — `.retro-settings__layout` and `.retro-settings__section-label`: add `grid-column: 1 / -1` to each
    - Design change 4 — `.retro-settings__feelings`: add `grid-column: 1 / -1`, replace `flex-direction: column` with `display: grid`, `grid-template-columns: repeat(auto-fit, minmax(150px, 1fr))`, `gap: 8px 20px`
    - No template change — the existing toggles, the moderator-gated fluid-height toggle, the radios and the `@for` over `allFeelingCategories` all become grid items as authored (3.5)
    - Keep `calc()` and `min()` on `max-height` and `width` only; both gaps are `8px 20px` so Property 27's `toPx` never meets a `calc()`
    - Independently verifiable: exploratory cases 1 and 2 flip to passing after this task alone
    - _Bug_Condition: SETTINGS_SCROLL links from the design.md chain table_
    - _Expected_Behavior: Correctness Property 1 (settings half)_
    - _Preservation: unscoped `.retro-dialog` untouched; control set and gating unchanged_
    - _Design changes: 1, 2, 3, 4_
    - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 3.5, 3.6, 3.7_

  - [ ] 3.2 Cause B (board page) — stretch the vertical container and the blocker wrapper
    - **File**: `client/src/app/components/retro-board/retro-board-page.component.ts`, styles block only
    - Design change 5 — `.retro-board__columns--vertical`: `align-items: flex-start` → `align-items: stretch`. Keep `overflow-y: hidden`; it is now correct because the columns scroll internally and nothing overflows the container vertically. Keep `width: 100%` and `overflow-x: auto` (3.3). **Rewrite the stale comment** that claims columns size to their card count — state the kanban contract and cite the amended R7.16. **Use plain prose with no backticks**: a backtick inside a CSS comment terminates the `styles: [` template literal and breaks compilation
    - Design change 6 — `.retro-board__columns > .interaction-blocker`: `align-items: flex-start` → `align-items: stretch`. Without this the chain breaks one level below the container and the fix does nothing. Leave `flex: 0 0 auto`, `gap: 8px`, `min-width: 100%` and `min-height: 0` unchanged (R7.12, R7.15)
    - Design change 7 — `.retro-board__columns--horizontal`: leave at `align-items: flex-start`, unchanged (3.1)
    - Independently verifiable: the two container links of exploratory case 3 flip to passing after this task alone
    - _Bug_Condition: VERTICAL_STRETCH container and blocker links from the design.md chain table_
    - _Expected_Behavior: Correctness Property 1 (stretch chain, upper two links)_
    - _Preservation: `--horizontal` alignment, `width: 100%`, `min-width: 100%`, `flex: 0 0 auto`_
    - _Design changes: 5, 6, 7_
    - _Requirements: 1.3, 1.4, 2.4, 2.6, 3.1, 3.3_

  - [ ] 3.3 Cause B (column) — stretch the column and make the card list the scroller
    - **File**: `client/src/app/components/retro-board/retro-column.component.ts`, styles block only
    - Design change 8 — `:host`: `align-self: flex-start` → `align-self: stretch`, and add `min-height: 0` so the host can shrink below its content and hand the overflow to the card list. Leave `min-width`, `width` and `flex: 0 0 300px` unchanged
    - Design change 9 — `:host.is-horizontal`: add `align-self: flex-start`, restoring the current value for the horizontal layout (3.1)
    - Design change 10 — `.retro-column`: `height: auto` → `height: 100%`; keep `min-height: 0`, `overflow: hidden` and the flex column. Add a new rule `:host.is-horizontal .retro-column { height: auto; }` to restore content sizing in the horizontal layout
    - Design change 11 — `.retro-column__cards`: `flex: 0 1 auto` → `flex: 1 1 auto`, add `min-height: 0`, keep `overflow-y: auto`, and **drop the `min-height: 60px` floor** — it is the empty-column stub and serves no purpose once the column stretches. Leave `flex-direction: column` and `gap: 8px` unchanged so cards keep their natural height, top-aligned (3.9)
    - Design change 12 — `:host.is-horizontal .retro-column__cards`: add `flex: 0 0 auto` so the card row does not inherit the new grow factor. Leave `min-height: unset`, `overflow-x: auto`, `overflow-y: hidden`, `flex-direction: row`, `align-items: flex-start` and the `flex: 0 0 200px` card width rule unchanged (3.2)
    - Design change 13 — `.retro-column__header` is already `flex-shrink: 0`; **add no declaration here**. The header stays pinned above the scroller by the existing rule, which task 4 adds an assertion for so the property is guarded rather than assumed (2.5)
    - Each `is-horizontal` override must be an explicit declaration on the `is-horizontal` selector — `stylesFor` matches selectors exactly and does not model the cascade across different selectors
    - **Expected side effect**: the existing `describe('retro column block size follows its cards (R7.16)')` block in `retro-layout.spec.ts` now FAILS, because it asserts the pre-fix contract. That is addressed in task 4; do not patch it here and do not revert the fix
    - _Bug_Condition: VERTICAL_STRETCH host, column and card-list links from the design.md chain table_
    - _Expected_Behavior: Correctness Property 1 (stretch chain, lower two links, plus the scroller)_
    - _Preservation: every `is-horizontal` counterpart restores its pre-fix value_
    - _Design changes: 8, 9, 10, 11, 12, 13_
    - _Requirements: 1.3, 1.4, 1.5, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.9_

  - [ ] 3.4 Verify the bug condition exploration test now passes
    - **Property 1: Expected Behavior** - The settings dialog scrolls and the vertical column stretches
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test. That test encodes the expected behaviour, so its passing is the fix check
    - Fix check per design.md: `FOR ALL X IN { SETTINGS_SCROLL, VERTICAL_STRETCH }`, `FOR ALL link IN X.links`, `declaredValue_fixed(link) = link.required` — equivalently, `isBugCondition(X)` is false for both contracts
    - Run `cd client && npx ng test --watch=false`
    - **EXPECTED OUTCOME**: all six exploratory cases PASS, including the four that failed in task 1
    - _Expected_Behavior: expectedBehavior(result) / Correctness Property 1 from design.md_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [ ] 3.5 Verify the preservation tests still pass
    - **Property 2: Preservation** - The horizontal layout and every non-settings surface
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests
    - Preservation check per design.md: `FOR ALL q WHERE NOT isBugCondition(q)`, `declaredValue_original(q) = declaredValue_fixed(q)`
    - Run `cd client && npx ng test --watch=false`
    - **EXPECTED OUTCOME**: all preservation assertions still PASS — no regression. A failure here means the fix drifted into the horizontal layout or another dialog
    - _Preservation: Preservation Requirements / Correctness Property 2 from design.md_
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6, 3.8, 3.9_

- [ ] 4. Re-point the existing R7.16 assertions in `retro-layout.spec.ts`
  - **File**: `client/src/app/components/retro-board/retro-layout.spec.ts`
  - Re-point, do **not** delete — this block is the R7.16 coverage reference cited from `docs/verification-coverage.md`
  - Rename the `describe`: `'retro column block size follows its cards (R7.16)'` → `'retro column fills the board height and scrolls its own cards (R7.16)'`
  - Rename the `it`: `'declares no fixed block size and lets the column sit at the container top'` → `'stretches the column through the blocker wrapper and makes the card list the scroller'`
  - Update the four changed values, leave the two unchanged ones as they are:
    - `:host` / `align-self`: `flex-start` → `stretch`
    - `.retro-column` / `height`: `auto` → `100%`
    - `.retro-column` / `min-height`: `0` → `0` (unchanged)
    - `.retro-column__cards` / `flex`: `0 1 auto` → `1 1 auto`
    - `.retro-column__cards` / `overflow-y`: `auto` → `auto` (unchanged)
    - `.retro-board__columns--vertical` / `align-items`: `flex-start` → `stretch`
  - Add the new assertions covering the guarantee the fix introduces:
    - `:host` declares `min-height: 0`
    - `.retro-board__columns > .interaction-blocker` declares `align-items: stretch`, plus the DOM check that this wrapper is the only element between the container and the column hosts — the chain assertion is only meaningful if the chain is complete. Walk `children` / `querySelector`; happy-dom has no `:scope`
    - `.retro-column__cards` declares `min-height: 0` and no 60px floor
    - `.retro-column__cards` is the single scrolling element: `overflow-y: auto` on it, `overflow: hidden` on `.retro-column`, `overflow-y: hidden` on the vertical container
    - `.retro-column__header` declares `flex-shrink: 0`, so the header, count, add and delete stay pinned above the scroller
  - Add a **second `it` in the same block** asserting the horizontal counterpart — `align-self: flex-start`, `height: auto`, `flex: 0 0 auto` — so the two layouts are contrasted in one place and a future edit cannot satisfy one by breaking the other (3.1)
  - Add a **new `describe` for the settings dialog** in the same file; it already imports `RetroToolbarComponent`. Cover the cap, the flex column, the grid body with its scroller and `min-height: 0`, the three full-width bands, the nested feelings grid, and the untouched `.retro-dialog` baseline
  - Add the structural integration assertions from design.md: render the vertical layout with 0, 1 and 20 cards in a column and assert one `.interaction-blocker` between container and hosts, one `.retro-column__cards` per column, and a header present in every column at every count; then the same counts in the horizontal layout, asserting the structure and the `is-horizontal` host class are unchanged
  - Run `cd client && npx ng test --watch=false` and confirm the renamed block passes
  - _Expected_Behavior: Correctness Property 1 from design.md_
  - _Design changes: 5, 6, 8, 10, 11, 12, 13 (assertions), 1, 2, 3, 4 (settings describe)_
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1_

- [ ] 5. Re-run the six affected retro suites as a regression gate
  - All in `client/src/app/components/retro-board/`. Run as a single execution, not in watch mode
  - `retro-layout.spec.ts` — holds the re-pointed R7.16 block and the new settings-dialog block
  - `retro-layout.property.spec.ts` — Property 27 scans the new gap declarations. Confirm the new `8px 20px` gaps enter its domain and pass, and that the `> 40` spacing-declaration and `> 60` colour-declaration floors still hold (3.8)
  - `retro-toolbar.compact.spec.ts` — shares the stylesheet the dialog rules live in; confirms the compact and mobile toolbar layouts are untouched (3.7)
  - `retro-column.dnd.spec.ts` — drag-and-drop across the changed alignment; confirms the drop indicator index and the drop commit are unaffected in both layouts and both indicator orientations (3.4)
  - `fluid-height-settings.spec.ts` — fluid card height is the amplifier of Cause B (2.7)
  - `retro-toolbar.component.feelings.spec.ts` — the feelings container changes from flex to grid (2.3, 3.5)
  - **EXPECTED OUTCOME**: every suite passes. Any failure outside the re-pointed R7.16 block is a regression, not an expected update
  - _Preservation: Preservation Requirements / Correctness Property 2 from design.md_
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

- [ ] 6. Amend the affected spec and documentation files
  - Design amendment 1 — `.kiro/specs/poker-retro-ux-improvements/requirements.md`, Requirement 7, criterion 16: replace the single content-sized rule with the layout-dependent pair. In the vertical layout the Retro_Column fills the block size of the Column_Container, its Retro_Card list scrolls internally and its header row stays rendered; in the horizontal layout the Retro_Column sizes to its Retro_Card entries and the Column_Container scrolls. **Keep the criterion number R7.16** so every existing citation stays resolvable
  - Design amendment 2 — `.kiro/specs/poker-retro-ux-improvements/design.md`, two places:
    - the style table row for `.retro-board__columns--vertical`, currently listing `align-items: flex-start` against R7.1, R7.15, R7.16 → `align-items: stretch`
    - the Stream 6 prose on `retro-column.component.ts`, which currently states that `align-self: flex-start` and `height: auto` *replace* `height: 100%` so the block size follows the card count → restate as the kanban contract with the `is-horizontal` exception
  - Design amendment 3 — `docs/verification-coverage.md`, two edits:
    - the R7.16 row: update the criterion summary and re-point the test reference to the renamed `describe` / `it` titles from task 4
    - a new **§D4** entry under "§D — Known shortfalls and deliberate changes", recording the post-delivery behavioural correction: the three defects fixed, the two causes, why R7.16 was amended rather than treated as a regression, and that this is a deliberate change with test coverage, not a shortfall. Follow the **D2** pattern and close with the D2-style status line for a deliberate, covered change
  - Documentation only — no code or test change in this task
  - _Expected_Behavior: Correctness Property 1 from design.md_
  - _Design changes: Spec and Documentation Amendments 1, 2, 3_
  - _Requirements: 2.4, 2.5, 2.6, 3.1_

- [ ] 7. Checkpoint — run all three verification gates
  - Gate 1 — client tests: `cd client && npx ng test --watch=false`. Require **0 failures and 0 skipped**. Note that `ng test` rejects a bare `--run`, so use `--watch=false`
  - Gate 2 — server tests: `cd server && npm test`. Jest's "worker process failed to exit gracefully" notice and `npm warn Unknown user config "always-auth"` are expected and are not failures
  - Gate 3 — production build: `cd client && npx ng build --configuration production`. The three known warnings are expected: `anyComponentStyle` 9.71 kB on session-poker-page, non-ESM `qrcode`, non-ESM `html2canvas`
  - Leave the deliberate long timeouts in `retro-resume-list.property.spec.ts` (120 s) and `retro-capture-mode.property.spec.ts` (180 s) as they are
  - Do not revert `server/jest.config.ts`'s `moduleDirectories` / `modulePaths`
  - Ensure all tests pass; ask the user if questions arise
