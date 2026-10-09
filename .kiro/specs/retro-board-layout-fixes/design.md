# Retro Board Layout Fixes — Bugfix Design

## Overview

Three reported defects, two independent causes, one CSS-level fix in three component
stylesheets. No template, no service, no shared type and no public API changes.

**Cause A — the Board Settings dialog cannot scroll.** `.retro-settings` stacks every row in a
single flex column, `.retro-dialog` declares `padding: 24px; min-width: 300px` with no
`max-height` and no `overflow`, and the backdrop is `position: fixed; inset: 0` with
`align-items: center`. An over-tall body is therefore centred on a fixed box and clipped at
*both* ends, with no scrollbar anywhere. The fix makes the dialog a height-capped flex column
and turns the body into a responsive `auto-fit` grid that scrolls internally — fewer rows
*and* a scroller, so the dialog title and the Close button stay in view.

**Cause B — a vertical column neither stretches nor scrolls.** The page is
`height: 100dvh; overflow: hidden`, the column container is `align-items: flex-start` with
`overflow-y: hidden`, and each column is content-sized (`align-self: flex-start`,
`height: auto`, `.retro-column__cards { flex: 0 1 auto; min-height: 60px }`). A tall column
overflows a container that hides vertical overflow, so the surplus is clipped with no
scrollbar; an empty one collapses to the 60px card-area floor. The fix adopts the standard
kanban model: the column stretches to the board height and `.retro-column__cards` becomes the
scrolling element, with the header pinned. The container's `overflow-y: hidden` then becomes
*correct* rather than over-applied, because nothing overflows it any more.

The horizontal (stacked) layout keeps its content-sized behaviour unchanged. That split is
what makes the fix targeted: every vertical-layout declaration gains an `is-horizontal`
counterpart that restores the current value.

This contradicts R7.16 of `poker-retro-ux-improvements` as originally written, so that
criterion, its design rows and its coverage entry are amended rather than silently broken.

## Glossary

- **Bug_Condition (C)** — the declared style chain of either the settings dialog or a
  vertical-layout column fails to establish the scroll/stretch contract the fix requires.
  Formalised as `isBugCondition` below, over two disjoint sub-domains.
- **Property (P)** — for every link of both chains, the declaration establishes the contract:
  a height-capped flex-column dialog over an internally scrolling grid body (Cause A), and an
  unbroken `stretch` chain from the column container down to a `flex: 1 1 auto; min-height: 0;
  overflow-y: auto` card list (Cause B).
- **Preservation** — the horizontal layout's content-sized columns and left-to-right card row,
  horizontal overflow confinement (R7.12, R7.15), the full settings control set and its
  moderator gating, drag-and-drop, the 4px spacing scale and token-only colour (Property 27).
- **Stretch chain** — the four links a vertical column's block size passes through:
  `.retro-board__columns--vertical` → `.retro-board__columns > .interaction-blocker` →
  `app-retro-column` host → `.retro-column`. `.interaction-blocker` is rendered
  unconditionally between the container and the column hosts (R11.12), so it is a *mandatory*
  link; a chain that skips it does not stretch.
- **Scroll chain** — the three links the settings body's scroll passes through:
  `.retro-dialog--settings` (the cap) → its flex column → `.retro-settings` (the scroller,
  which needs `min-height: 0` to be allowed to shrink below its content).
- **Declared CSS** — the client runner performs no layout. Every property below is asserted
  against a component's compiled `styles` text via `client/src/app/testing/declared-css.ts`,
  never against measured geometry.
- **`.retro-column__cards`** — the card list in `retro-column.component.ts`. After the fix it
  is the scrolling element in the vertical layout and a non-growing left-to-right row in the
  horizontal layout.
- **`.retro-settings`** — the settings dialog body in `retro-toolbar.component.ts`, holding six
  base toggles, the moderator-only fluid-height toggle, the layout radios, the "Feelings"
  section label and ten feeling toggles.

## Bug Details

### Bug Condition

The bug manifests whenever either declared chain is read: the settings dialog declares no
height cap and no internal scroller, and the vertical column chain declares `flex-start`
alignment with a content-sized column. Both hold unconditionally on the unfixed code — this is
a declaration-level defect, not a data-dependent one, so the condition is deterministic and
its domain is a small finite table rather than a generated space.

**Formal Specification:**

```
TYPE ChainLink = RECORD
  surface  : ComponentClass        // RetroToolbarComponent | RetroBoardPageComponent | RetroColumnComponent
  selector : CssSelector           // canonical, view encapsulation undone
  property : CssProperty
  required : CssValue              // the value the contract needs
END RECORD

TYPE Contract = RECORD
  kind  : { SETTINGS_SCROLL, VERTICAL_STRETCH }
  links : LIST OF ChainLink
END RECORD

FUNCTION declaredValue(link)
  // testing/declared-css.ts: declared(link.surface, link.selector, link.property)
  // Returns the authored value, or ABSENT when the selector declares no such property.
END FUNCTION

FUNCTION isBugCondition(X)
  INPUT:  X of type Contract
  OUTPUT: boolean

  // True when any link of the contract fails to declare the value the
  // contract needs — i.e. the chain is broken somewhere.
  RETURN EXISTS link IN X.links WHERE declaredValue(link) != link.required
END FUNCTION
```

Instantiated on the unfixed code, both contracts satisfy `isBugCondition`:

| Contract | Link | Required | Declared (unfixed) |
|---|---|---|---|
| `SETTINGS_SCROLL` | `.retro-dialog--settings` / `max-height` | `calc(100dvh - 48px)` | ABSENT |
| `SETTINGS_SCROLL` | `.retro-dialog--settings` / `display` | `flex` | ABSENT |
| `SETTINGS_SCROLL` | `.retro-dialog--settings` / `flex-direction` | `column` | ABSENT |
| `SETTINGS_SCROLL` | `.retro-settings` / `overflow-y` | `auto` | ABSENT |
| `SETTINGS_SCROLL` | `.retro-settings` / `min-height` | `0` | ABSENT |
| `SETTINGS_SCROLL` | `.retro-settings` / `display` | `grid` | `flex` |
| `VERTICAL_STRETCH` | `.retro-board__columns--vertical` / `align-items` | `stretch` | `flex-start` |
| `VERTICAL_STRETCH` | `.retro-board__columns > .interaction-blocker` / `align-items` | `stretch` | `flex-start` |
| `VERTICAL_STRETCH` | `:host` / `align-self` | `stretch` | `flex-start` |
| `VERTICAL_STRETCH` | `.retro-column` / `height` | `100%` | `auto` |
| `VERTICAL_STRETCH` | `.retro-column__cards` / `flex` | `1 1 auto` | `0 1 auto` |
| `VERTICAL_STRETCH` | `.retro-column__cards` / `min-height` | `0` | `60px` |

### Examples

- **Moderator opens Board Settings on a 768px-tall viewport.** Expected: the dialog caps at
  the viewport, the title and Close stay visible, the body scrolls to reach all ten feeling
  toggles. Actual: the body runs to roughly 800px, the centred fixed backdrop clips it top and
  bottom, and neither the dialog nor the page offers a scrollbar — the first toggles and the
  Close button are both unreachable (1.1, 1.2).
- **A board in the vertical layout with one empty column.** Expected: the empty column fills
  the board height like its siblings. Actual: it collapses to the 60px card-area floor and
  renders as a stubby grey box (1.3).
- **A vertical column holding 20 cards with fluid card height on.** Expected: the column fills
  the board height and its card list scrolls, header pinned. Actual: the column grows past the
  container, `overflow-y: hidden` clips the surplus, and no scrollbar appears on the column or
  the page — cards at both ends are unreachable (1.4, 1.5).
- **Edge case — the same board in the horizontal layout.** Expected and actual agree: each
  column sizes to its own cards and the container scrolls. This is the behaviour the fix must
  leave untouched (3.1, 3.2).

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- The horizontal layout sizes each column to its own cards and scrolls the column container
  vertically; `.retro-board__columns--horizontal` keeps `align-items: flex-start` (3.1).
- The horizontal layout flows a column's cards left-to-right at a fixed 200px card width, with
  that row scrolling horizontally inside the column (3.2).
- Horizontal overflow stays confined to the column container, which keeps filling the content
  width — `width: 100%` on the container and `min-width: 100%` on the blocker wrapper (R7.12,
  R7.15; 3.3).
- Drag-and-drop keeps showing the drop indicator at the computed index and committing on drop,
  in both layouts and both indicator orientations (3.4).
- The settings dialog keeps the same control set — six base toggles, the moderator-only fluid
  card height toggle, the layout radios, the ten feeling toggles — with the same change
  handlers and the same moderator gating (3.5).
- The Add Column dialog and the column delete-confirmation dialog keep their current sizing:
  the new rules are scoped to `.retro-dialog--settings`, never to `.retro-dialog` (3.6).
- The toolbar's compact and mobile layouts are untouched; no rule outside the dialog block
  changes (3.7).
- Every margin, padding and gap edge stays 0 or a multiple of 4px and every colour stays a
  `var(--token)` reference (Property 27; 3.8).
- Cards inside a stretched column keep their natural height, top-aligned, because
  `.retro-column__cards` stays `flex-direction: column` and the stretch stops at the card list
  — no card gains a `stretch` cross-axis size (3.9).

**Scope:**

Every input outside the two chains in the table above is unaffected. Concretely:

- the horizontal layout, in full;
- every dialog other than Board Settings;
- every toolbar, header, context-row and card declaration;
- all templates, services, guards and shared types — nothing outside the three `styles` blocks
  is edited by the fix itself.

The expected *correct* behaviour is stated once, in Correctness Properties below.

## Hypothesized Root Cause

Both causes were traced to specific declarations and confirmed against the code before this
design was written, so what follows is a confirmed diagnosis rather than a list of candidates.
The exploratory test in task 1 still runs on unfixed code, because its purpose is to produce
the counterexample record and to encode the expected behaviour that will validate the fix.

1. **Missing height cap on the settings dialog.** `.retro-dialog` declares
   `padding: 24px; min-width: 300px` and nothing about height; `.retro-dialog--settings` adds
   only `min-width: 320px`. With the backdrop `position: fixed; inset: 0` and
   `align-items: center`, an over-tall child is centred and overflows symmetrically. Centre
   alignment is what makes it clip at *both* ends rather than just the bottom.

2. **No scroll container in the dialog.** Even with a cap, `.retro-settings` declares no
   `overflow-y` and no `min-height: 0`. A flex item's automatic minimum size is its content
   size, so without `min-height: 0` the body refuses to shrink below its content and the cap
   would just move the clipping outwards.

3. **Single-column settings body.** `.retro-settings` and `.retro-settings__feelings` are both
   `display: flex; flex-direction: column`, so eighteen-odd rows stack vertically. This is the
   amplifier: it is what makes the body exceed any realistic viewport in the first place.

4. **`align-items: flex-start` on the vertical column container.** Content-sizing the columns
   was deliberate under R7.16 as originally written. Combined with `overflow-y: hidden` — added
   for R7.12, which governs *horizontal* overflow only and was therefore over-applied — it
   produces clipping with no scrollbar.

5. **The stretch chain is broken at four links, including the blocker wrapper.**
   `.retro-board__columns > .interaction-blocker` is rendered unconditionally between the
   container and the column hosts, and also declares `align-items: flex-start`. Fixing only the
   container would leave the chain broken one level down, which is the most likely way a
   partial fix fails here.

6. **`min-height: 60px` on the card area.** This is the empty-column floor: with the column
   content-sized, 60px plus the header is the entire block size of an empty column.

7. **Fluid card height is an amplifier, not a cause.** Taller cards reach the container height
   at a lower card count, which is why the symptoms were reported there first. The defect is
   present at fixed card height too, just at a higher count.

## Correctness Properties

Property 1: Bug Condition — the settings dialog scrolls and the vertical column stretches

_For any_ contract `X` in the enumerated chain table where the bug condition held before the
fix (`isBugCondition(X)` was true), the fixed stylesheets SHALL declare the value that contract
requires at every link, so that `isBugCondition(X)` is false: the settings dialog caps at the
viewport height, lays its body out as a responsive multi-column grid and scrolls that body
internally; and a vertical-layout column stretches to the board height through the blocker
wrapper, with `.retro-column__cards` as the single scrolling element and
`.retro-column__header` pinned at `flex-shrink: 0`.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7**

Property 2: Preservation — the horizontal layout and every non-settings surface

_For any_ declared-style query where the bug condition does NOT hold — every
`is-horizontal` counterpart, `.retro-board__columns--horizontal`, the unscoped `.retro-dialog`,
and every margin/padding/gap and colour declaration across the five retro surfaces — the fixed
stylesheets SHALL declare the same value as the original stylesheets, preserving content-sized
horizontal columns, the fixed-width left-to-right card row, horizontal overflow confinement,
the sizing of all other dialogs, and the 4px spacing scale and token-only colour of
Property 27.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9**

## Fix Implementation

### Changes Required — Cause A

**File**: `client/src/app/components/retro-board/retro-toolbar.component.ts` (styles block only)

1. **`.retro-dialog--settings` becomes a height-capped flex column.** Keep
   `min-width: 320px`; add `width: min(620px, calc(100vw - 32px))`,
   `max-height: calc(100dvh - 48px)`, `display: flex`, `flex-direction: column`. The cap is
   what stops the centred fixed backdrop clipping at both ends; the flex column is what lets
   the body shrink while the title and actions keep their intrinsic size. `.retro-dialog` is
   left alone, so the Add Column dialog is unaffected (3.6).

2. **`.retro-settings` becomes a scrolling responsive grid.** Replace
   `flex-direction: column` with
   `display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
   gap: 8px 20px; align-content: start; overflow-y: auto; min-height: 0;`. `auto-fit` gives
   the narrow-viewport collapse to one column with no media query. `min-height: 0` is
   load-bearing: without it the grid's automatic minimum size defeats the cap. `align-content:
   start` keeps rows at the top instead of distributing free space. The existing
   `margin-bottom: 16px` is retained.

3. **Full-width rows keep their own band.** `.retro-settings__layout` and
   `.retro-settings__section-label` each add `grid-column: 1 / -1`, so the layout radio row and
   the "Feelings" heading span the dialog rather than sharing a track with a toggle (2.3).

4. **The feeling toggles get their own nested grid.** `.retro-settings__feelings` adds
   `grid-column: 1 / -1` and replaces `flex-direction: column` with
   `display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px 20px;`.
   A denser track minimum than the parent's, because a feeling label is shorter than a setting
   label.

No template change: the existing six toggles, the moderator-gated fluid-height toggle, the
radios and the `@for` over `allFeelingCategories` all become grid items as authored (3.5).

### Changes Required — Cause B

**File**: `client/src/app/components/retro-board/retro-board-page.component.ts` (styles block only)

5. **`.retro-board__columns--vertical`**: `align-items: flex-start` → `align-items: stretch`.
   `overflow-y: hidden` is kept and is now correct — the columns scroll internally, so nothing
   overflows the container vertically. The stale comment claiming columns size to their card
   count must be rewritten to state the kanban contract and cite the amended R7.16; leaving it
   would misdescribe the rule below it.

6. **`.retro-board__columns > .interaction-blocker`**: `align-items: flex-start` →
   `align-items: stretch`. Without this the chain breaks one level below the container and the
   fix does nothing. `flex: 0 0 auto`, `gap: 8px`, `min-width: 100%` and `min-height: 0` are
   all unchanged (R7.12, R7.15 preserved).

7. **`.retro-board__columns--horizontal`**: unchanged at `align-items: flex-start` (3.1).

**File**: `client/src/app/components/retro-board/retro-column.component.ts` (styles block only)

8. **`:host`**: `align-self: flex-start` → `align-self: stretch`, and add `min-height: 0` so
   the host can shrink below its content and hand the overflow to the card list. `min-width`,
   `width` and `flex: 0 0 300px` are unchanged.

9. **`:host.is-horizontal`**: add `align-self: flex-start`, restoring the current value for the
   horizontal layout (3.1).

10. **`.retro-column`**: `height: auto` → `height: 100%`; keep `min-height: 0`,
    `overflow: hidden` and the flex column. Add a new rule
    `:host.is-horizontal .retro-column { height: auto; }` to restore content sizing in the
    horizontal layout.

11. **`.retro-column__cards`**: `flex: 0 1 auto` → `flex: 1 1 auto`, add `min-height: 0`, keep
    `overflow-y: auto`. Drop the `min-height: 60px` floor, or reduce it sharply — it is the
    empty-column stub, and with the column stretched it serves no purpose. `flex-direction:
    column` and `gap: 8px` are unchanged, so cards keep their natural height, top-aligned
    (3.9).

12. **`:host.is-horizontal .retro-column__cards`**: add `flex: 0 0 auto`, so the card row does
    not inherit the new grow factor. `min-height: unset`, `overflow-x: auto`,
    `overflow-y: hidden`, `flex-direction: row` and `align-items: flex-start` are unchanged,
    as is the `flex: 0 0 200px` card width rule (3.2).

13. **`.retro-column__header`** is already `flex-shrink: 0`, so the header, count, add and
    delete controls stay pinned above the scroller with no edit. The fix adds no declaration
    here; the testing strategy adds an assertion so the property is guarded rather than
    assumed (2.5).

### Constraints on the Fix

- **Declared-CSS observability.** Every value introduced must be readable through
  `declared(Component, selector, property)`. That rules out values that only exist after
  layout, and it means each `is-horizontal` override has to be an explicit declaration on the
  `is-horizontal` selector — `stylesFor` matches selectors exactly and does not model the
  cascade across different selectors.
- **The 4px scale (Property 27).** The property scans `margin*`, `padding*` and `gap*` only,
  splits the value on whitespace and runs `toPx` on each part, which **throws on `calc()` and
  `%`**. Every gap introduced is `8px 20px`, so both parts land on the scale. The `calc()` and
  `min()` values go on `max-height` and `width`, which the property does not scan — keep it
  that way: a `calc()` gap would fail the property outright. The `minmax(220px, 1fr)` and
  `minmax(150px, 1fr)` track minimums are `grid-template-columns`, also outside the scanned
  set. 32px and 48px inset allowances are multiples of 4 regardless.
- **Token-only colour.** The fix introduces no colour declaration at all, so the colour half
  of Property 27 is untouched.
- **Backticks terminate the styles template literal.** All three stylesheets are
  ``styles: [` … `]`` template literals, so a backtick inside a CSS comment ends the literal
  and breaks compilation. Comments added or rewritten in these blocks must use plain prose —
  no backtick-quoted selectors or property names.
- **Angular 21 conventions.** Standalone components, Signals over RxJS, `@shared/*` alias,
  strict TS with no `any`. The fix touches only `styles` blocks and the spec/doc files, so no
  new import, injection or type is introduced.

### Spec and Documentation Amendments

R7.16 of `poker-retro-ux-improvements` states the opposite of the fixed behaviour. It is
amended in place, keeping the criterion number so every existing citation stays resolvable.

1. **`.kiro/specs/poker-retro-ux-improvements/requirements.md`** — Requirement 7, criterion 16.
   Replace the single content-sized rule with the layout-dependent pair: in the vertical
   layout the Retro_Column fills the block size of the Column_Container, its Retro_Card list
   scrolls internally and its header row stays rendered; in the horizontal layout the
   Retro_Column sizes to its Retro_Card entries and the Column_Container scrolls. Number
   unchanged.

2. **`.kiro/specs/poker-retro-ux-improvements/design.md`** — two places:
   - the style table row for `.retro-board__columns--vertical`, which currently lists
     `align-items: flex-start` against R7.1, R7.15, R7.16 → `align-items: stretch`;
   - the Stream 6 prose on `retro-column.component.ts`, which currently states that
     `align-self: flex-start` and `height: auto` *replace* `height: 100%` so the block size
     follows the card count → restate as the kanban contract with the `is-horizontal`
     exception.

3. **`docs/verification-coverage.md`** — two edits:
   - the R7.16 row: update the criterion summary and re-point the test reference to the
     renamed `describe`/`it` titles below;
   - a new **§D** entry (D4) recording the post-delivery behavioural correction: the three
     defects fixed, the two causes, why R7.16 was amended rather than treated as a regression,
     and that the amendment is a deliberate change with test coverage, not a shortfall. It
     follows the D2 pattern — deliberate, covered change.

## Testing Strategy

### Validation Approach

Two phases. First, surface the counterexamples on unfixed code: one test that asserts the
fixed contract and therefore fails, and one that records the behaviour to be preserved and
therefore passes. Then apply the fix and re-run both — the first must flip to passing, the
second must stay passing.

Both are assertions over declared CSS and rendered DOM structure. The runner is **Vitest via
`ng test` with happy-dom and performs no layout**: `getBoundingClientRect` returns zeros,
custom properties do not resolve, and `getComputedStyle` echoes authored values back. happy-dom
also has no `:scope` support, so any DOM traversal must walk `children`/`querySelector` from a
known element rather than using a `:scope`-rooted selector. Reuse
`client/src/app/testing/declared-css.ts` (`declared`, `stylesFor`, `rulesOf`, `toPx`,
`MOBILE_MEDIA`) rather than re-deriving a parser; `contrast.ts` is not needed — the fix
introduces no colour.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples proving both chains are broken on the unfixed code, and
confirm the diagnosis — in particular that the break is at *four* links in the vertical chain,
the blocker wrapper included, not just at the container.

**Test Plan**: Write one test that iterates the enumerated chain table from Bug Details and
asserts the required value at every link, for both contracts. Run it on UNFIXED code. Each
failing link is a counterexample; record them.

**Test Cases**:

1. **Settings dialog cap and scroller**: assert `max-height`, `display: flex` and
   `flex-direction: column` on `.retro-dialog--settings`, and `display: grid`,
   `overflow-y: auto`, `min-height: 0` on `.retro-settings` (will fail on unfixed code —
   `declared` throws on the absent properties).
2. **Settings grid bands**: assert `grid-column: 1 / -1` on `.retro-settings__layout`,
   `.retro-settings__section-label` and `.retro-settings__feelings`, and `display: grid` on the
   feelings container (will fail on unfixed code).
3. **Vertical stretch chain**: assert `align-items: stretch` on
   `.retro-board__columns--vertical` and on `.retro-board__columns > .interaction-blocker`,
   `align-self: stretch` and `min-height: 0` on `:host`, and `height: 100%` on `.retro-column`
   (will fail on unfixed code at all four).
4. **Column card list is the scroller**: assert `flex: 1 1 auto`, `min-height: 0` and
   `overflow-y: auto` on `.retro-column__cards` (will fail on the first two).
5. **Chain completeness (DOM)**: render the board and assert the only element between
   `.retro-board__columns` and the `app-retro-column` hosts is the `.interaction-blocker`
   wrapper, so the chain in the table is the whole chain (passes on unfixed code — it pins the
   structural premise of the diagnosis).
6. **Edge case — pinned header**: assert `flex-shrink: 0` on `.retro-column__header` (passes on
   unfixed code; it guards an existing declaration the fix now depends on).

**Expected Counterexamples**:

- `.retro-dialog--settings declares no max-height`, `.retro-settings declares no overflow-y`,
  `.retro-settings declares no min-height` — thrown by `declared`, which is the honest report
  for an absent declaration.
- `.retro-settings` `display` is `flex`, not `grid`; `flex-direction` is `column`.
- `align-items` is `flex-start` on both the vertical container and the blocker wrapper;
  `align-self` is `flex-start` on the host; `.retro-column` `height` is `auto`;
  `.retro-column__cards` `flex` is `0 1 auto` with `min-height: 60px`.
- Causes confirmed: missing height cap, missing scroll container, single-column body,
  `flex-start` alignment at two levels, content-sized column, 60px card-area floor.

### Fix Checking

**Goal**: For every contract where the bug condition held, the fixed stylesheets satisfy the
contract.

**Pseudocode:**

```
FOR ALL X IN { SETTINGS_SCROLL, VERTICAL_STRETCH } DO
  FOR ALL link IN X.links DO
    ASSERT declaredValue_fixed(link) = link.required
  END FOR
END FOR
// equivalently: NOT isBugCondition(X) for both contracts
```

### Preservation Checking

**Goal**: For every declared-style query where the bug condition does not hold, the fixed
stylesheets declare what the original ones declared.

**Pseudocode:**

```
FOR ALL q WHERE NOT isBugCondition(q) DO
  ASSERT declaredValue_original(q) = declaredValue_fixed(q)
END FOR
```

**Testing Approach**: Observation-first. The baseline values are read off the unfixed code and
written into the test as literals, so the test passes before the fix and would fail if the fix
drifted into the horizontal layout or another dialog.

The domain here is a **small finite enumeration** — roughly a dozen chain links plus the
`is-horizontal` and `--horizontal` counterparts — so these are scoped property tests
implemented as exhaustive iteration over that table. Exhausting a ten-element domain is
strictly stronger than sampling it, and introducing a generator would add no coverage.

**If a fast-check generator is introduced anyway** (for example by folding these into
`retro-layout.property.spec.ts` alongside Property 27's `sliceOf`), two rules are mandatory:
pass `size: 'max'` on every `fc.array`/`fc.string` whose `maxLength` exceeds 10, because
`maxLength` alone is an upper bound that fast-check's default sizing ignores and generated
input silently caps near 10 entries; and follow the `fc.assert` with a coverage assertion that
fails loudly if the generator ever collapses again. This is the §D3 failure mode already
recorded in `docs/verification-coverage.md`.

**Test Cases**:

1. **Horizontal column sizing**: observe on unfixed code that the horizontal layout content-
   sizes its columns, then assert the fix declares `align-self: flex-start` on
   `:host.is-horizontal`, `height: auto` on `:host.is-horizontal .retro-column`, and
   `align-items: flex-start` on `.retro-board__columns--horizontal` (3.1).
2. **Horizontal card row**: assert `:host.is-horizontal .retro-column__cards` keeps
   `flex-direction: row`, `overflow-x: auto`, `overflow-y: hidden`, `min-height: unset` and
   adds `flex: 0 0 auto`, and that the card width rule stays `flex: 0 0 200px` (3.2).
3. **Overflow confinement**: assert `.retro-board__columns--vertical` keeps `width: 100%` and
   `overflow-x: auto`, and the blocker wrapper keeps `min-width: 100%` and `flex: 0 0 auto`
   (R7.12, R7.15; 3.3).
4. **Other dialogs**: assert the unscoped `.retro-dialog` still declares `padding: 24px` and
   `min-width: 300px` and declares no `max-height`, so the Add Column dialog is untouched
   (3.6).
5. **Settings control set**: render the dialog as moderator and as participant and assert the
   same control inventory, change handlers and gating as before the fix (3.5).
6. **Spacing scale**: re-run Property 27 and confirm the new gaps are scanned and pass (3.8).

### Unit Tests

The existing R7.16 block in
`client/src/app/components/retro-board/retro-layout.spec.ts` asserts the old contract and must
be re-pointed, not deleted — it is the R7.16 coverage reference.

**Rename**:

- `describe('retro column block size follows its cards (R7.16)')` →
  `describe('retro column fills the board height and scrolls its own cards (R7.16)')`
- `it('declares no fixed block size and lets the column sit at the container top')` →
  `it('stretches the column through the blocker wrapper and makes the card list the scroller')`

**Of the six values that test asserts, four change and two stay**:

| Assertion | Before | After |
|---|---|---|
| `:host` / `align-self` | `flex-start` | `stretch` |
| `.retro-column` / `height` | `auto` | `100%` |
| `.retro-column` / `min-height` | `0` | `0` (unchanged) |
| `.retro-column__cards` / `flex` | `0 1 auto` | `1 1 auto` |
| `.retro-column__cards` / `overflow-y` | `auto` | `auto` (unchanged) |
| `.retro-board__columns--vertical` / `align-items` | `flex-start` | `stretch` |

**New assertions in the renamed block**, covering the guarantee the fix adds:

- `:host` declares `min-height: 0`.
- `.retro-board__columns > .interaction-blocker` declares `align-items: stretch`, plus the DOM
  check that this wrapper is the only element between the container and the column hosts — the
  chain assertion is only meaningful if the chain is complete.
- `.retro-column__cards` declares `min-height: 0` and no 60px floor.
- `.retro-column__cards` is the single scrolling element: `overflow-y: auto` on it,
  `overflow: hidden` on `.retro-column`, `overflow-y: hidden` on the vertical container.
- `.retro-column__header` declares `flex-shrink: 0`, so the header, count, add and delete stay
  pinned above the scroller (2.5).

**A second `it` in the same block** asserts the horizontal counterpart — `align-self:
flex-start`, `height: auto`, `flex: 0 0 auto` — so the two layouts are contrasted in one place
and a future edit cannot satisfy one by breaking the other (3.1).

**A new `describe` for the settings dialog** in the same file (it already imports
`RetroToolbarComponent`): the cap, the flex column, the grid body with its scroller and
`min-height: 0`, the three full-width bands, the nested feelings grid, and the untouched
`.retro-dialog` baseline.

### Property-Based Tests

- **Property 1** — scoped to the enumerated chain table: for every link of both contracts, the
  declared value equals the required value. Deterministic domain, exhausted rather than
  sampled.
- **Property 2** — scoped to the preservation table: for every `is-horizontal` /
  `--horizontal` / unscoped-dialog query, the declared value equals the observed baseline.
- **Property 27** (existing, `retro-layout.property.spec.ts`) — re-run unchanged. It already
  generates over the declaration set of all five retro surfaces, so the new declarations enter
  its domain automatically; the `> 40` spacing-declaration and `> 60` colour-declaration floors
  still hold.

### Integration Tests

- Render the board in the vertical layout with 0, 1 and 20 cards in a column and assert the
  structure the stretch contract relies on: one `.interaction-blocker` between container and
  hosts, one `.retro-column__cards` per column, header present in every column at every count.
- Render in the horizontal layout at the same counts and assert the structure and the
  `is-horizontal` host class are unchanged.
- Re-run `retro-column.dnd.spec.ts` to confirm the drop indicator index and the drop commit are
  unaffected by the alignment change in both layouts (3.4).
- Render the settings dialog as moderator and as participant at desktop and `MOBILE_MEDIA`
  widths and assert the full control inventory, the moderator gating of the fluid-height
  toggle, and the ten feeling toggles (3.5).

### Suites to Re-run

All in `client/src/app/components/retro-board/`:

| Suite | Why |
|---|---|
| `retro-layout.spec.ts` | Holds the re-pointed R7.16 block and the new settings-dialog block |
| `retro-layout.property.spec.ts` | Property 27 scans the new gap declarations |
| `retro-toolbar.compact.spec.ts` | Shares the stylesheet the dialog rules live in (3.7) |
| `retro-column.dnd.spec.ts` | Drag-and-drop across the changed alignment (3.4) |
| `fluid-height-settings.spec.ts` | Fluid card height is the amplifier of Cause B (2.7) |
| `retro-toolbar.component.feelings.spec.ts` | The feelings container changes from flex to grid (2.3, 3.5) |

Run as a single execution, not in watch mode.
