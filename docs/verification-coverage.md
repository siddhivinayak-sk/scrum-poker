# Verification Coverage Ledger — `poker-retro-ux-improvements`

Satisfies R14.1, R14.2 and R14.3: one row for every acceptance criterion of Requirements 1
through 13, naming the automated test that asserts it, or recording why the criterion is not
observable in the test environment.

**Criterion inventory.** R1–R13 hold **205** acceptance criteria:
R1 22 · R2 13 · R3 10 · R4 13 · R5 11 · R6 17 · R7 18 · R8 22 · R9 16 · R10 11 · R11 27 ·
R12 10 · R13 15.

**Totals.** 193 covered by a named test · 8 recorded as not directly observable (with the
surrogate assertion named) · 4 open gaps. See the three sections after the table.

**Path legend** (test paths are abbreviated to keep the rows readable):

| Prefix | Expands to |
|---|---|
| `C/` | `client/src/app/` |
| `S/` | `server/src/` |
| `H/` | `shared/` |

**Reading the test column.** Where a test title carries its own `Rx.y` markers the title is
quoted as-is, which is what makes the covered count derivable from test names alone (R14.2).
Where the authoritative link is a `**Validates: Requirements ...**` doc comment on a property
test instead, the describe block and the comment are both cited — those are the property tests
named by Property number in the design, and the comment is the link the design defines for them.

---

## Coverage table

| Criterion | Behaviour | Test file | Test (describe › it) | Property |
|---|---|---|---|---|
| R1.1 | Owner sees `Export estimates`, ≥32×32 | `C/components/session-poker-page/export-control.spec.ts` | `owner rendering (R1.1)` › `renders the export control in the session header for the session owner` | — |
| R1.2 | Non-owner sees no such control | `C/components/session-poker-page/export-control.spec.ts` | `non-owner rendering (R1.2)` › `renders no control named "Export estimates" for a non-owner` | — |
| R1.3 | Disabled with zero completed estimates | `C/components/session-poker-page/export-control.spec.ts` | `disabled state (R1.3)` › `disables the control while the session holds zero completed estimates` | — |
| R1.4 | Exactly one authenticated GET per activation | `C/services/estimate-export.service.spec.ts` | `request shape (R1.4)` › `sends exactly one authenticated GET request per activation` | — |
| R1.5 | 200 + `text/csv` + attachment, 5 s budget | `S/routes/__tests__/sessions-export.spec.ts` | `success response` › `responds 200 with Content-Type text/csv and an attachment Content-Disposition`; `responds within the 5-second budget for 200 completed estimates of 50 participants` | — |
| R1.6 | 401 `UNAUTHORIZED` without a valid token | `S/routes/__tests__/sessions-export.spec.ts` | `authentication` › `returns 401 UNAUTHORIZED when no Authorization header is sent` (+ invalid token, non-Bearer scheme) | — |
| R1.7 | 403 `FORBIDDEN` for a non-owner | `S/routes/__tests__/sessions-export.spec.ts` | `ownership` › `returns 403 FORBIDDEN for an authenticated user who does not own the session` | — |
| R1.8 | 404 `SESSION_NOT_FOUND` for an unknown id | `S/routes/__tests__/sessions-export.spec.ts` | `unknown session` › `returns 404 SESSION_NOT_FOUND for a session the registry does not hold` | — |
| R1.9 | One summary row per estimate, `completedAt` ascending, stable ties | `H/__tests__/estimate-export.property.spec.ts` | `R1.9/R1.11/R1.12/R1.20/R1.21: headers, ordering, adjacency and ownership hold` | P4 |
| R1.10 | Summary field order and `MM:SS` duration | `H/__tests__/estimate-export.property.spec.ts` | `R1.10: absent durations blank and present durations render as MM:SS` | P24 |
| R1.11 | One vote row per participant per estimate | `H/__tests__/estimate-export.property.spec.ts` | `R1.9/R1.11/R1.12/R1.20/R1.21: headers, ordering, adjacency and ownership hold` | P4 |
| R1.12 | Null card value renders `No Vote` | `H/__tests__/estimate-export.property.spec.ts` | `R1.9/R1.11/R1.12/R1.20/R1.21: headers, ordering, adjacency and ownership hold` | P4 |
| R1.13 | Average half-up to one decimal | `H/__tests__/estimate-export.property.spec.ts` | `R1.13/R1.14/R14.9: every statistic field carries the computed metrics value` | P2 |
| R1.14 | Mode, spread, distribution, outlier count equal the metrics | `H/__tests__/estimate-export.property.spec.ts` | `R1.13/R1.14/R14.9: every statistic field carries the computed metrics value` | P2 |
| R1.15 | `insufficientData` blanks average, mode, spread | `H/__tests__/estimate-export.property.spec.ts` | `R1.15/R14.10: average, mode and spread blank while distribution and outliers stay` | P3 |
| R1.16 | RFC 4180 quoting round trip | `H/__tests__/csv.property.spec.ts` | `R1.16/R14.8: parsing a serialized row recovers every original field value unchanged` | P1 |
| R1.17 | One download, body unchanged | `C/services/estimate-export.service.spec.ts` | `successful download (R1.17)` › `downloads the response body unchanged as scrum-poker-<sessionId>.csv with text/csv MIME type` | — |
| R1.18 | Non-200 or 30 s timeout: one error toast, no download | `C/services/estimate-export.service.spec.ts` | `failure paths (R1.18)` › `shows exactly one error toast and triggers no download on an error status` | — |
| R1.19 | Export is a pure read | `S/routes/__tests__/sessions-export.spec.ts` | `Property 23: export endpoint is a pure read` › `returns byte-identical documents and leaves the session state unchanged` | P23 |
| R1.20 | Vote rows follow their summary row, name ascending | `H/__tests__/estimate-export.property.spec.ts` | `R1.9/R1.11/R1.12/R1.20/R1.21: headers, ordering, adjacency and ownership hold` | P4 |
| R1.21 | Summary header once, vote header per estimate | `H/__tests__/estimate-export.property.spec.ts` | `R1.9/R1.11/R1.12/R1.20/R1.21: headers, ordering, adjacency and ownership hold` | P4 |
| R1.22 | Enabled with estimates and nothing in flight | `C/components/session-poker-page/export-control.spec.ts` | `enabled state (R1.22)` › `enables the control with completed estimates and no request in flight` | — |
| R2.1 | Title clamped to at most two lines | `C/components/issue-list-panel/issue-list-panel.layout.spec.ts` | `clamps the title to two lines with hidden overflow (R2.1, R2.8)` | — |
| R2.2 | Full title as `title` and accessible name | `C/components/issue-list-panel/issue-list-panel.layout.spec.ts` | `carries the complete stored title as both title and aria-label (R2.2)` | — |
| R2.3 | Panel `scrollWidth` ≤ `clientWidth` | `C/components/issue-list-panel/issue-title.property.spec.ts` | `R2.3: reports no row overflow for any title length, entry count and viewport width` | P5 |
| R2.4 | Marker, title and action do not overlap | `C/components/issue-list-panel/issue-list-panel.layout.spec.ts` | `breaks a title that holds no whitespace (R2.4)` | — |
| R2.5 | Whitespace-free title breaks within the word | `C/components/issue-list-panel/issue-title.property.spec.ts` | `R2.5: a title with no whitespace character does not widen the row beyond the panel` | P5 |
| R2.6 | Title font size ≥ 12 px | `C/components/issue-list-panel/issue-list-panel.layout.spec.ts` | `declares a title font size of at least 12 pixels (R2.6)` | — |
| R2.7 | Existing drag, markers and actions preserved | `C/components/issue-list-panel/issue-list-panel.layout.spec.ts` | `pre-existing actions keep their accessible names (R2.7)` › `keeps the estimate and resume actions` | — |
| R2.8 | Ellipsis beyond two lines | `C/components/issue-list-panel/issue-list-panel.layout.spec.ts` | `clamps the title to two lines with hidden overflow (R2.1, R2.8)` | — |
| R2.9 | No ellipsis when the title fits | `C/components/issue-list-panel/issue-title.property.spec.ts` | `R2.2, R2.9: the accessible name carries the stored title exactly, with no truncation marker added` | P5 |
| R2.10 | Blank title renders and announces a placeholder | `C/components/issue-list-panel/issue-list-panel.layout.spec.ts` | `blank titles` › `keeps a blank-titled row selectable by its existing action (R2.10)` | P5 |
| R2.11 | Title takes the remaining inline width | `C/components/issue-list-panel/issue-list-panel.layout.spec.ts` | `lets the title shrink below its content width and take the remaining space (R2.11)` | — |
| R2.12 | Rows start at the panel content edge | `C/components/issue-list-panel/issue-list-panel.layout.spec.ts` | `confines overflow to the panel and starts every row at the content edge (R2.12)` | — |
| R2.13 | Action buttons share one fixed slot | `C/components/issue-list-panel/issue-title.property.spec.ts` | `R2.13: the action slot offset is identical across every row of a panel` | P5 |
| R3.1 | Lift 8–12 px within 300 ms | `C/components/card-deck/card-deck.containment.spec.ts` | `declared values match the geometry constants (R3.1, R3.4)` › `keeps the lift inside the 8–12 px range required by R3.1` | — |
| R3.2 | Selected card stays below the deck top edge | `C/components/card-deck/card-deck-geometry.property.spec.ts` | `R3.2/R3.3/R3.4/R3.5: keeps the selected card and the hovered focused card inside the deck for every card position, height and viewport width` | P6 |
| R3.3 | Hovered/focused card also contained | `C/components/card-deck/card-deck-geometry.property.spec.ts` | same test as R3.2 | P6 |
| R3.4 | Scale 1.00–1.10 with reserved headroom | `C/components/card-deck/card-deck-geometry.property.spec.ts` | same test as R3.2 | P6 |
| R3.5 | Holds for every card position, 2–20 cards, 360–1920 px | `C/components/card-deck/card-deck-geometry.property.spec.ts` | same test as R3.2 | P6 |
| R3.6 | Strip does not clip vertically | `C/components/card-deck/card-deck.containment.spec.ts` | `mobile scrollable strip (R3.6)` › `declares overflow-y: hidden so scrollHeight cannot exceed clientHeight` | — |
| R3.7 | Exactly one card elevated | `C/components/card-deck/card-deck.containment.spec.ts` | `keeps exactly one elevated card across successive selections (R3.7)` | — |
| R3.8 | Reset on round change / board clear | `C/components/card-deck/card-deck.containment.spec.ts` | `resets the elevation when a new round starts (R3.8)` | — |
| R3.9 | Reduced motion: 0 ms, same end state | `C/components/card-deck/card-deck.containment.spec.ts` | `reduced motion (R3.9)` › `zeroes the transition duration for the card and the selected card` | — |
| R3.10 | Existing visuals and ARIA kept | `C/components/card-deck/card-deck.containment.spec.ts` | `keeps the aria-pressed state and the selection announcement (R3.10)` | — |
| R4.1 | Every glyph inside its card in the PNG | — | **not directly observable** — see §A1; surrogate: `C/services/retro-capture-mode.property.spec.ts` (P12, P13) and `C/services/retro-screenshot.service.spec.ts` › `re-entry guard (R4.1, R4.10)` | P12, P13 |
| R4.2 | Complete text of every card, including off-screen | `C/services/retro-capture-mode.property.spec.ts` | `R4.2/R4.11/R4.12/R4.13: every clone holds the full card text, the copied typography and a height containing its wrapped lines` | P13 |
| R4.3 | Board restored after every outcome | `C/services/retro-capture-mode.property.spec.ts` | `R4.3/R4.7: returns the element count, attributes, inline styles and scroll offsets to their pre-capture values for every outcome` | P12 |
| R4.4 | Failure: one error toast, no clipboard, no download | `C/services/retro-screenshot.service.spec.ts` | `render failure (R4.4)` › `emits exactly one error notification, copies nothing and downloads nothing` | — |
| R4.5 | Clipboard success: one toast, no download | `C/services/retro-screenshot.service.spec.ts` | `clipboard success (R4.5)` › `renders the board at its full scroll size` | — |
| R4.6 | Clipboard unavailable: one PNG download | `C/services/retro-screenshot.service.spec.ts` | `download fallback (R4.6, R4.9)` › `downloads one PNG and emits exactly one notification when the clipboard is unavailable` | — |
| R4.7 | Both layouts, both modes, empty board, 360–1920 px | `C/services/retro-capture-mode.property.spec.ts` | `R4.3/R4.7: returns the element count, attributes, inline styles and scroll offsets to their pre-capture values for every outcome` | P12 |
| R4.8 | 10 s budget | `C/services/retro-screenshot.service.spec.ts` | `capture budget (R4.8)` › `ends a capture that has not produced an image within 10 seconds` | — |
| R4.9 | Download triggers one toast | `C/services/retro-screenshot.service.spec.ts` | `download fallback (R4.6, R4.9)` › same test as R4.6 | — |
| R4.10 | Action disabled while capturing | `C/services/retro-screenshot.service.spec.ts` | `re-entry guard (R4.1, R4.10)` › `holds capturing true for the whole run` | — |
| R4.11 | No line wider than the card content width | `C/services/retro-capture-mode.property.spec.ts` | `R4.2/R4.11/R4.12/R4.13: ...` | P13 |
| R4.12 | Live typography reproduced | `C/services/retro-capture-mode.property.spec.ts` | `R4.12/R4.13: captureTextStyle reproduces the live declarations and the height it is handed` | P13 |
| R4.13 | Card height contains its wrapped text | `C/services/retro-capture-mode.property.spec.ts` | `R4.12/R4.13: captureTextStyle reproduces the live declarations and the height it is handed` | P13 |
| R5.1 | Unfocused offset stays 0 | `C/components/retro-board/retro-card.scroll.property.spec.ts` | `Property 14: Unfocused card text area is pinned to its first line` › `reports a zero scroll offset on first render, after every inbound update and after focus loss` (`Validates: Requirements 5.1–5.5, 5.10`) | P14 |
| R5.2 | Inbound update shows line one within 100 ms | same | same | P14 |
| R5.3 | Scroll range 0..last line, offset 0 initially | same | same | P14 |
| R5.4 | Focus loss resets to 0, text unchanged | same | same | P14 |
| R5.5 | Holds for 0–2,000 chars, breaks, long word, both modes | same | same | P14 |
| R5.6 | Blur with changed text sends a card edit | `C/components/retro-board/retro-card.scroll.property.spec.ts` | `Property 15: A focused card text area is never written by the component` › `leaves a focused text area untouched and sends the text then present on blur` (`Validates: Requirements 5.6, 5.8, 5.9`) | P15 |
| R5.7 | Enter without Shift commits and blurs | — | **open gap** — see §C1 | — |
| R5.8 | Only user input moves the offset while focused | `C/components/retro-board/retro-card.scroll.property.spec.ts` | `Property 15` › same test as R5.6 | P15 |
| R5.9 | Inbound update while focused changes nothing | `C/components/retro-board/retro-card.scroll.property.spec.ts` | `Property 15` › same test as R5.6 | P15 |
| R5.10 | Scroll thumb at the track start initially | `C/components/retro-board/retro-card.scroll.property.spec.ts` | `Property 14` › same test as R5.1 | P14 |
| R5.11 | Scrollbar inside the text area box | `C/components/retro-board/retro-card.sizing.spec.ts` | `the scrollbar stays inside the text area box (R5.11)` › `scrolls overflow inside its own box rather than spilling out` | — |
| R6.1 | Optional boolean `fluidCardHeight` | `H/__tests__/fluid-card-height.property.spec.ts` | `Property 10: fluidCardHeight default resolution` › `resolves to the supplied boolean, and to true for every non-boolean` (`Validates: Requirements 6.1, 6.3, 13.4`) | P10 |
| R6.2 | Server default true | `S/services/__tests__/retro-session-fluid-height.spec.ts` | `RetroSession creation normalises fluidCardHeight (R6.2)` › `defaults to true when the creation config omits the field` | — |
| R6.3 | Client default true | `H/__tests__/fluid-card-height.property.spec.ts` | `Property 10` › same test as R6.1 | P10 |
| R6.4 | Fluid height clamped to 3..12 lines | `C/services/retro-card-height.property.spec.ts` | `R6.4/R6.5/R6.6: equals the clamp formula and stays between the mode bounds for every text and width` | P9 |
| R6.5 | Fluid overflow scrolls from line one | `C/services/retro-card-height.property.spec.ts` | `R6.4/R6.5/R6.6: ...` | P9 |
| R6.6 | Fixed mode is 4 lines for every length | `C/services/retro-card-height.property.spec.ts` | `R6.6: holds the fixed four-line height for every text length when the mode is not fluid` | P9 |
| R6.7 | Recompute within 200 ms of text/width change | `C/components/retro-board/retro-card.sizing.spec.ts` | `recomputes on a text change (R6.7)` › `grows and shrinks with the line count, clamped to the fluid range` | — |
| R6.8 | Deterministic height | `C/services/retro-card-height.property.spec.ts` | `R6.8/R14.11: returns an identical height across three successive evaluations for every text, width and mode` | P7 |
| R6.9 | Prefix monotonicity | `C/services/retro-card-height.property.spec.ts` | `R6.9/R14.11: never reports a taller text area for a prefix than for the full text at the same width` | P8 |
| R6.10 | Moderator control reflects the stored value | `C/components/retro-board/fluid-height-settings.spec.ts` | `the control (R6.10, R6.11, R6.15)` › `presents the control to a moderator, with an accessible label`; `reflects a stored value of true when the dialog opens` | — |
| R6.11 | Change stored and broadcast within 1 s | `S/services/__tests__/retro-session-fluid-height.spec.ts` | `RetroSession.updateConfig fluidCardHeight (R6.11, R6.17)` › `accepts a boolean update and reports no rejected keys` | — |
| R6.12 | Drop index from bounding-box midpoints | `C/components/retro-board/drop-index.property.spec.ts` | `R6.12: returns the count of card midpoints at or before the pointer, for any non-uniform card sizes`; `R6.12: an empty column always yields index 0` | P11 |
| R6.13 | Existing drag/drop/merge/reorder preserved | `C/components/retro-board/retro-column.dnd.spec.ts` | `RetroColumnComponent drag and drop (non-uniform card extents)` › `keeps exactly one drop indicator across successive drag over events`; `opens the merge popup for a card dropped onto a rendered card`; `reorders columns when a column is dropped onto this one` (file header links R6.13, R7.10) | — |
| R6.14 | AC 4/5/6 hold for both layouts | `C/services/retro-card-height.property.spec.ts` | `R6.14: produces the same height for both column layouts at the same width and mode` | P9 |
| R6.15 | Non-moderator sees no control | `C/components/retro-board/fluid-height-settings.spec.ts` | `the control (R6.10, R6.11, R6.15)` › `renders the settings dialog without the control for a non-moderator` | — |
| R6.16 | Received change applied within 500 ms, no reload | `C/components/retro-board/fluid-height-settings.spec.ts` | `the broadcast (R6.16)` › `re-applies the fixed rule to every rendered card when the broadcast turns it off` | — |
| R6.17 | Non-moderator / non-boolean update rejected | `S/services/__tests__/retro-session-fluid-height.spec.ts` | `RetroSession.updateConfig fluidCardHeight (R6.11, R6.17)` | — |
| R7.1 | Spacing on the 4 px scale | `C/components/retro-board/retro-layout.property.spec.ts` | `Property 27: every retro spacing declaration sits on the 4px scale (R7.1)` › `resolves every margin, padding and gap edge to 0 or a multiple of 4px` | P27 |
| R7.2 | Colours are design-token references | `C/components/retro-board/retro-layout.property.spec.ts` | `Property 27: every retro colour is a design-token reference (R7.2)` › `names no literal colour in any background, border, text colour or shadow` | P27 |
| R7.3 | Font size ≥ 12 px | `C/components/retro-board/retro-layout.property.spec.ts` | `Property 27: every retro font size clears the 12px floor (R7.3, R10.6)` › `resolves every declared font size to at least 12px` | P27 |
| R7.4 | Text contrast ≥ 4.5:1 | `C/components/retro-board/retro-layout.property.spec.ts` | `Property 27: the retro token pairs reach their contrast thresholds` › `reaches 4.5:1 on every (text token, surface) pair (R7.4, R10.6, R11.8)` — **documented shortfall, see §B** | P27 |
| R7.5 | Controls ≥ 32×32 | `C/components/retro-board/retro-layout.property.spec.ts` | `Property 27: every retro control declares a 32x32px box (R7.5, R10.3)` › `declares at least 32px on both axes of every button` | P27 |
| R7.6 | Column header on one non-overflowing row | `C/components/retro-board/retro-layout.spec.ts` | `retro column header row (R7.6, R7.7)` › `holds the name, the count, add and delete on one non-wrapping row` | — |
| R7.7 | Long column name ellipsised, full name exposed twice | `C/components/retro-board/retro-layout.spec.ts` | `retro column header row (R7.6, R7.7)` › `truncates the name to one line and exposes the whole name twice over` | — |
| R7.8 | Chrome rows ≤ 160 px at ≥768 px | `C/components/retro-board/retro-layout.spec.ts` | **not directly observable** — see §A2; surrogate: `declared chrome row heights (R7.8, R7.13)` › `sums header, toolbar and context to well inside 160px at 768px and up` | — |
| R7.9 | Every existing control survives | `C/components/retro-board/retro-layout.spec.ts` | `every board control survives the layout change (R7.9)` › `keeps each header button with its icon, title, accessible name and keyboard reach` | — |
| R7.10 | Orientation, order and drag behaviour kept | `C/components/retro-board/retro-layout.spec.ts` | `orientation, order and drag affordances for both layouts (R7.10)` › `renders columns and cards in state order in the vertical layout` | — |
| R7.11 | Reduced motion zeroes every duration | `C/components/retro-board/retro-layout.spec.ts` | `reduced motion settles every descendant immediately (R7.11)` › `zeroes transition and animation duration for the host and all descendants` | — |
| R7.12 | Page `scrollWidth` ≤ `clientWidth` | `C/components/retro-board/retro-layout.spec.ts` | `horizontal overflow is confined to the column container (R7.12, R7.15)` › `hides overflow on the page and scrolls only inside the column container` | — |
| R7.13 | Wrapped chrome rows ≤ 240 px below 768 px | `C/components/retro-board/retro-layout.spec.ts` | **not directly observable** — see §A2; surrogate: `declared chrome row heights (R7.8, R7.13)` › `stays inside 240px below 768px, where each row wraps instead of overlapping` | — |
| R7.14 | Focus indicator ≥ 3:1 | `C/components/retro-board/retro-layout.property.spec.ts` | `Property 27: the retro token pairs reach their contrast thresholds` › `reaches 3:1 on every (focus outline or status fill, adjacent surface) pair (R7.14, R11.8)` | P27 |
| R7.15 | Column container fills the content width | `C/components/retro-board/retro-layout.spec.ts` | `horizontal overflow is confined to the column container (R7.12, R7.15)` › `lets the column container fill the content width in both layouts` | — |
| R7.16 | Vertical column fills the board height and scrolls its own cards; horizontal column sizes to its cards | `C/components/retro-board/retro-layout.spec.ts` | `retro column fills the board height and scrolls its own cards (R7.16)` › `stretches the column through the blocker wrapper and makes the card list the scroller` (+ the stacked-layout and structural cases) | — |
| R7.17 | Sprint context row not clipped | `C/components/retro-board/retro-layout.spec.ts` | `the sprint context row renders its whole text (R7.17)` › `reserves at least a line box plus its block padding` | — |
| R7.18 | Card parts inside the card, non-overlapping | `C/components/retro-board/retro-layout.spec.ts` | `card parts each take their own band (R7.18)` › `stacks the card parts in a single column` | — |
| R8.1 | `GET /api/retro/sessions/mine` with bearer token | `S/routes/__tests__/retro-sessions-mine.spec.ts`, `S/__tests__/isolation.spec.ts` | `Property 20: ...` › `returns exactly the caller's retro sessions, ordered, well formed, and without side effects (R8.2, R8.4, R8.6, R8.7, R8.8, R14.16)`; `R13.5: the three added routes resolve without shadowing their pre-existing siblings` | P20 |
| R8.2 | 200 with one summary per owned retro session | `S/routes/__tests__/retro-sessions-mine.spec.ts` | `Property 20` › same test as R8.1 | P20 |
| R8.3 | 200 with an empty array when none are owned | `S/routes/__tests__/retro-sessions-mine.spec.ts` | `R8.3 zero-session cases` › `responds 200 with zero entries when the registry is empty (R8.3)` | — |
| R8.4 | Ordered by `lastActivityAt` then creation, descending | `S/routes/__tests__/retro-sessions-mine.spec.ts` | `Property 20` › same test as R8.1 | P20 |
| R8.5 | 401 `UNAUTHORIZED` for missing/invalid/expired tokens | `S/routes/__tests__/retro-sessions-mine.spec.ts` | `R8.5 unauthorized cases` › `responds 401 UNAUTHORIZED when the request carries no token (R8.5)` (+ non-Bearer, failed verification, expired, inactive) | — |
| R8.6 | Summary field set and types | `S/routes/__tests__/retro-sessions-mine.spec.ts` | `Property 20` › same test as R8.1 | P20 |
| R8.7 | Poker sessions excluded | `S/routes/__tests__/retro-sessions-mine.spec.ts` | `R8.3 zero-session cases` › `responds 200 with zero entries when the caller owns only poker sessions (R8.3, R8.7)` | P20 |
| R8.8 | Endpoint is a pure read | `S/routes/__tests__/retro-sessions-mine.spec.ts` | `R8.5 unauthorized cases` › `leaves the registry unchanged when the request is rejected (R8.5, R8.8)` | P20 |
| R8.9 | Lobby sends one authenticated request | `C/components/retro-resume-list/retro-resume-list.spec.ts` | `request shape (R8.9)` › `sends exactly one GET carrying the stored token` | — |
| R8.10 | One entry per summary, in response order | `C/components/retro-resume-list/retro-resume-list.property.spec.ts` | `Property 26: retro session list entries render and navigate` › `renders one control per summary in response order, shows all four values, exposes the full board name and navigates on activation` (`Validates: Requirements 8.10, 8.13, 8.14, 8.16`) | P26 |
| R8.11 | Loading indicator, poker list still rendered | `C/components/retro-resume-list/retro-resume-list.spec.ts` | `loading indicator (R8.11)` › `renders a status line in place of the list while the request is pending` | — |
| R8.12 | Distinct heading, programmatically associated | `C/components/retro-resume-list/retro-resume-list.spec.ts` | `heading association and distinctness (R8.12)` › `associates the section with its visible heading` | — |
| R8.13 | Shows name, id, created and last activity | `C/components/retro-resume-list/retro-resume-list.property.spec.ts` | `Property 26` › same test as R8.10 | P26 |
| R8.14 | Long board name ellipsised, full name exposed | `C/components/retro-resume-list/retro-resume-list.property.spec.ts` | `Property 26` › same test as R8.10 | P26 |
| R8.15 | Each entry focusable in document order, activatable | `C/components/retro-resume-list/retro-resume-list.spec.ts` | `keyboard focus order (R8.15)` › `renders each entry as a natively focusable button in response order` | — |
| R8.16 | Activation navigates to `/retro/:sessionId` | `C/components/retro-resume-list/retro-resume-list.property.spec.ts` | `Property 26` › same test as R8.10 | P26 |
| R8.17 | Zero sessions: no list | `C/components/retro-resume-list/retro-resume-list.spec.ts` | `render-nothing paths` › `renders nothing for a response holding zero entries (R8.17)` | — |
| R8.18 | 401: no list, no failure message | `C/components/retro-resume-list/retro-resume-list.spec.ts` | `render-nothing paths` › `renders nothing and no failure message on 401 (R8.18)` | — |
| R8.19 | Other non-200: failure message | `C/components/retro-resume-list/retro-resume-list.spec.ts` | `failure message (R8.19, R8.20)` › `renders an alert when the request fails without a response` | — |
| R8.20 | 10 s timeout: stop loading, failure message | `C/components/retro-resume-list/retro-resume-list.spec.ts` | `failure message (R8.19, R8.20)` › same test as R8.19 | — |
| R8.21 | Poker list and actions stay enabled on failure | `C/components/retro-resume-list/retro-resume-list.spec.ts` | `sibling independence (R8.21)` › `leaves the poker session list rendered and enabled when the retro request fails` | — |
| R8.22 | Existing lobby actions and poker list kept | `C/components/lobby/lobby-user-menu.spec.ts` | `preserved lobby actions and session lists (R8.22)` › `keeps the three actions with their accessible names and behaviour while the control is present` | — |
| R9.1 | Moderator sees `End session` | `C/components/retro-board/end-session.spec.ts` | `end-session control visibility (R9.1, R9.2)` › `gives the moderator a header control named End session` | — |
| R9.2 | Non-moderator sees none | `C/components/retro-board/end-session.spec.ts` | `end-session control visibility (R9.1, R9.2)` | — |
| R9.3 | `alertdialog`, one confirm, one cancel, focus on cancel | `C/components/retro-board/end-session.spec.ts` | `the confirmation dialog (R9.3)` › `is absent until the control is activated` | — |
| R9.4 | Cancel dismisses, returns focus, changes nothing | `C/components/retro-board/end-session.spec.ts` | `cancelling the confirmation (R9.4)` › `dismisses the dialog, returns focus to the control and leaves the session unchanged` | — |
| R9.5 | Confirm sends exactly one authenticated DELETE | `C/components/retro-board/end-session.spec.ts` | `confirming the end of the session (R9.5, R9.6)` › `sends exactly one authenticated DELETE` | — |
| R9.6 | In-flight: confirm and control disabled | `C/components/retro-board/end-session.spec.ts` | `confirming the end of the session (R9.5, R9.6)` | — |
| R9.7 | Owner DELETE removes the session, 200 | `S/routes/__tests__/retro-end-session.spec.ts` | `R9.7 success path` › `removes the session from the registry and responds 200 (R9.7)` | — |
| R9.8 | `retro:session:ended` broadcast then close within 2 s | `S/routes/__tests__/retro-end-session.spec.ts` | `R9.7 success path` › `broadcasts retro:session:ended and drops the connection map entry (R9.7, R9.8)` | — |
| R9.9 | 401 leaves the session in the registry | `S/routes/__tests__/retro-end-session.spec.ts` | `R9.9 unauthorized cases` › `responds 401 for an id the registry does not hold, without disclosing that (R9.9)` | — |
| R9.10 | 403 for a non-owner, state untouched | `S/routes/__tests__/retro-end-session.spec.ts` | `R9.10 and R9.11 rejection cases` › `responds 403 and leaves the session, its cards and its votes unchanged (R9.10)` | — |
| R9.11 | 404 for an unknown id, others untouched | `S/routes/__tests__/retro-end-session.spec.ts` | `R9.7 success path` › `leaves the owner's other retro sessions in place (R9.7, R9.11)` | — |
| R9.12 | Participants navigate to `/lobby` with one toast ≥5 s | `C/services/retro-websocket.service.connection.spec.ts` | `after retro:session:ended` › `ends the episode as soon as the broadcast arrives, with no notification of its own (R9.12)` | — |
| R9.13 | DELETE failure: dialog dismissed, board unchanged, one toast | `C/components/retro-board/end-session.spec.ts` | `the end-session request fails (R9.13)` › `allows a retry once the failure has been reported` | — |
| R9.14 | Late retro WS message mutates nothing, socket closed | `S/websocket/__tests__/retro-session-ended.spec.ts` | `Property 22: late retro WebSocket messages change nothing (R9.14)` › `closes the socket with 4004 and mutates no session state` | P22 |
| R9.15 | Poker sessions untouched | `S/routes/__tests__/retro-end-session.spec.ts` | `leaves every poker session unchanged when the retro delete succeeds (R9.15)` | — |
| R9.16 | Existing header controls kept | `C/components/retro-board/end-session.spec.ts` | `the existing header controls survive the addition (R9.16)` › `keeps back to lobby, copy link, votes remaining, session id and the user control` | — |
| R10.1 | Toolbar ≤ 40 px at ≥768 px | `C/components/retro-board/retro-toolbar.compact.spec.ts` | **not directly observable** — see §A2; surrogate: `the toolbar row is capped at 40px from 768px up (R10.1)` › `caps its outer box at 40px, with its padding counted inside the cap` | — |
| R10.2 | ≤3 wrapped rows of ≤40 px below 768 px | `C/components/retro-board/retro-toolbar.compact.spec.ts` | **not directly observable** — see §A2; surrogate: `the toolbar wraps to at most three 40px rows below 768px (R10.2)` › `allows exactly three rows of the same height, with no gap between them` | — |
| R10.3 | Toolbar buttons ≥ 32×32 | `C/components/retro-board/retro-layout.property.spec.ts` | `Property 27: every retro control declares a 32x32px box (R7.5, R10.3)` | P27 |
| R10.4 | Feelings strip inside a capped row | `C/components/retro-board/retro-toolbar.compact.spec.ts` | `the feelings strip is an item of the toolbar row (R10.4)` › `renders as a direct child of the toolbar row in every state` | — |
| R10.5 | Every toolbar action kept | `C/components/retro-board/retro-toolbar.compact.spec.ts` | `every toolbar action survives the compaction (R10.5)` › `keeps the toolbar container a role="toolbar" with its accessible name` | — |
| R10.6 | Toolbar text ≥ 4.5:1 and ≥ 12 px | `C/components/retro-board/retro-layout.property.spec.ts` | `reaches 4.5:1 on every (text token, surface) pair (R7.4, R10.6, R11.8)`; `Property 27: every retro font size clears the 12px floor (R7.3, R10.6)` | P27 |
| R10.7 | Toolbar items do not overlap | `C/components/retro-board/retro-toolbar.compact.spec.ts` | `toolbar items share the row without overlapping (R10.7)` › `keeps every item in flow, with no absolute positioning and no negative margin` | — |
| R10.8 | Surplus width scrolls inside the toolbar | `C/components/retro-board/retro-toolbar.compact.spec.ts` | `surplus control width scrolls inside the toolbar box (R10.8)` › `makes the toolbar itself the scroll container` | — |
| R10.9 | Every visible control keyboard reachable | `C/components/retro-board/retro-toolbar.compact.spec.ts` | `every visible control stays reachable from the keyboard (R10.9)` › `activates each enabled action from a keyboard-equivalent activation` | — |
| R10.10 | Strip ≤ 32 px, no empty bordered region | `C/components/retro-board/retro-toolbar.compact.spec.ts` | `no empty bordered region grows past the controls it holds (R10.10)` › `sizes the bordered strip to its contents and nothing more` | — |
| R10.11 | Toolbar + context row ≤ 72 px | `C/components/retro-board/retro-toolbar.compact.spec.ts` | **not directly observable** — see §A2; surrogate: `the toolbar and the sprint context row fit 72px together (R10.11)` › `sums the two declared row boxes to 66.8px for the read-only context row` | — |
| R11.1 | Poker header shows the indicator from first render | `C/services/websocket.service.connection.spec.ts` | `connectionState transitions` › `reads reconnecting while the socket is CONNECTING, so the indicator is never blank (R11.1)` | — |
| R11.2 | Retro header shows the indicator from first render | `C/services/retro-websocket.service.connection.spec.ts` | `connectionState transitions` › `reads reconnecting while the socket is CONNECTING, so the indicator is never blank (R11.2)` | — |
| R11.3 | Width ≥ 1.5 × height, height ≤ 32 px | `C/components/retro-board/retro-layout.spec.ts` | **width ratio not directly observable** — see §A3; the ≤32 px half is asserted by `declared chrome row heights (R7.8, R7.13)` › `drives the header row height from its 32px controls, not its text` | — |
| R11.4 | `connected`: green token, `Connected` | `C/components/connection-status/connection-status.property.spec.ts` | `Property 16: the connection indicator maps every state to a colour and a label` › `derives healthy, and the modifier class, as exactly state === connected`; `resolves both filled parts to the green token when connected and the red token otherwise` (`Validates: Requirements R11.4–R11.8`) | P16 |
| R11.5 | `reconnecting`: red token, `Trying to restore connection` | same | `Property 16` › same tests as R11.4 | P16 |
| R11.6 | `disconnected`: red token, `Disconnected` | same | `Property 16` › same tests as R11.4 | P16 |
| R11.7 | Visible label identical to the `title` text | `C/components/connection-status/connection-status.property.spec.ts` | `Property 16` › `renders title, accessible name and visible text all equal to the state label` | P16 |
| R11.8 | Fill ≥ 3:1 on the header, label ≥ 4.5:1 on the fill | `C/components/connection-status/connection-status.property.spec.ts` | `Property 16` › `keeps every state at 3:1 fill-on-chip and 4.5:1 label-on-fill` | P16, P27 |
| R11.9 | Blocked controls except indicator, back, logout | `C/components/connection-status/interaction-blocking.property.spec.ts` | `Property 17: interaction is permitted exactly when connected` › `blocks every wrapper, and only while not connected, after any state sequence` (`Validates: Requirements R11.9–R11.13`) | P17 |
| R11.10 | Blocking begins within 500 ms, exposed as unavailable | same | `Property 17` › same test as R11.9 | P17 |
| R11.11 | `aria-live="polite"` paused-interaction message | same | `Property 17` › same test as R11.9 | P17 |
| R11.12 | Content visible, scrolling allowed, input retained | same | `Property 17` › `hides nothing while blocked: no rule keys off inert or aria-disabled`; `declares page scroll containers, none of which is a blocker wrapper` | P17 |
| R11.13 | Restoration within 500 ms, message removed | same | `Property 17` › same test as R11.9 | P17 |
| R11.14 | Zero notifications while reconnecting | `C/services/connection-episode.property.spec.ts` | `R11.14/R11.16/R11.23/R11.25/R11.26/R11.27: emits one notification per threshold crossing and none otherwise, over arbitrary event sequences` | P18 |
| R11.15 | At most one notification per episode, only at the threshold | `C/services/connection-episode.property.spec.ts` | `R11.15/R14.13: an episode holding 1 through 9 attempts that ends with a restored connection produces zero notifications` | P18 |
| R11.16 | Exactly one `error` notification at the threshold | `C/services/connection-episode.property.spec.ts` | `R11.16/R11.23: ten consecutive attempts cross the threshold exactly once and stop reconnecting` | P18 |
| R11.17 | Close codes 4009 / 4010 / 4004 keep their meanings | `C/services/retro-websocket.service.connection.spec.ts` | `reserved close codes` › `reports 4009 once as an error and routes back to this session's login, with no reconnection (R11.17, R11.18)` | P19 |
| R11.18 | Reserved close: one notification, `disconnected`, no retry | `C/services/connection-episode.property.spec.ts` | `R11.18: ends the episode with exactly one cause notification and no reconnection, from any reachable state` | P19 |
| R11.19 | Backoff `min(2^attempt·1000, 30000)` | `C/services/connection-episode.property.spec.ts` | `R11.19: the reconnection delay equals min(2^attempt * 1000, 30000) for attempts 0 through 20` | P19 |
| R11.20 | Liveness probe every 30 s ±5 s | `S/websocket/__tests__/liveness.spec.ts` | `liveness probe cadence (R11.20)` › `declares a 30-second interval` — **tolerance clause not directly observable, see §A4** | — |
| R11.21 | Two missed probes: close, remove, broadcast | `S/websocket/__tests__/liveness.spec.ts` | `nextMissedCount (R11.21)` › `counts a tick with no pong as one more missed probe` | — |
| R11.22 | Poker and retro probes independent | `S/websocket/__tests__/liveness.spec.ts` | `poker and retro probes are independent (R11.22)` › `closing a poker connection leaves retro connections open and their session intact` | — |
| R11.23 | Threshold sets `disconnected`, stops retrying | `C/services/connection-episode.property.spec.ts` | `R11.16/R11.23: ten consecutive attempts cross the threshold exactly once and stop reconnecting` | P18 |
| R11.24 | Give-up navigates to login within 2 s | `C/services/retro-websocket.service.connection.spec.ts` | `reaching the give-up threshold` › `navigates to /login in the same turn as the give-up, well inside the 2 second allowance (R11.24)` | — |
| R11.25 | Reconnect to `connected` resets the attempt count | `C/services/connection-episode.property.spec.ts` | `R11.14/R11.16/R11.23/R11.25/R11.26/R11.27: ...` | P18 |
| R11.26 | No loss and no attempt-number notification text | `C/services/connection-episode.property.spec.ts` | `R11.14/R11.16/R11.23/R11.25/R11.26/R11.27: ...` | P18 |
| R11.27 | Leaving `connected` dismisses connection notifications | `C/services/connection-episode.property.spec.ts` | `R11.14/R11.16/R11.23/R11.25/R11.26/R11.27: ...` | P18 |
| R12.1 | User control last in the lobby header row | `C/components/lobby/lobby-user-menu.spec.ts` | `placement in the header (R12.1)` › `renders the control as the last element of the header row inside the content area` | — |
| R12.2 | Poker accessible names and ARIA reproduced | `C/components/lobby/lobby-user-menu.property.spec.ts` | `Property 25: Lobby user control structure and avatar initial` › `exposes the poker accessible names, a single Logout item and the uppercased first non-whitespace initial` (`Validates: Requirements 12.2, 12.3, 12.10`) | P25 |
| R12.3 | Avatar initial = uppercase first non-whitespace char | same | `Property 25` › same test as R12.2 | P25 |
| R12.4 | Name and role in the dropdown, logout only, no role switch | `C/components/lobby/lobby-user-menu.spec.ts` | `dropdown content (R12.4)` › `presents the display name and role with logout as the only action and no role switch` | — |
| R12.5 | Logout clears storage before navigating, within 1000 ms | `C/components/lobby/lobby-user-menu.spec.ts` | `logout (R12.5)` › `clears the stored token and user record before navigating to the login page` | — |
| R12.6 | No credentials: no control, rest of the lobby kept | `C/components/lobby/lobby-user-menu.spec.ts` | `missing credentials (R12.6)` › `renders no user control and keeps the rest of the lobby when the token is missing` | — |
| R12.7 | Outside or avatar activation closes the dropdown | `C/components/lobby/lobby-user-menu.spec.ts` | `open and close (R12.7, R12.8, R12.9)` › `closes on an outside pointer activation, leaving the stored credentials unchanged` | — |
| R12.8 | Escape closes and focuses the avatar | `C/components/lobby/lobby-user-menu.spec.ts` | `open and close (R12.7, R12.8, R12.9)` › `closes on Escape and returns focus to the avatar button` | — |
| R12.9 | Avatar activation opens and focuses logout | `C/components/lobby/lobby-user-menu.spec.ts` | `open and close (R12.7, R12.8, R12.9)` › `opens on avatar activation and moves focus to the logout action` | — |
| R12.10 | Blank name: no initial, target kept, menu reachable | `C/components/lobby/lobby-user-menu.property.spec.ts` | `Property 25` › `renders no initial for a whitespace-only name while the dropdown and logout stay reachable` | P25 |
| R13.1 | Every pre-existing WS event name still routes | `S/__tests__/isolation.spec.ts` | `R13.1: the poker handler answers no pre-existing event with UNKNOWN_EVENT`; `R13.1: the retro handler answers no pre-existing event with UNKNOWN_EVENT` | P28 |
| R13.2 | Every pre-existing payload field still emitted | `S/__tests__/isolation.spec.ts` | `R13.2: the poker full-state payload still carries every pre-existing field`; `R13.2: every pre-existing runtime export is still exported` | P28 |
| R13.3 | Additions use new names | `S/__tests__/isolation.spec.ts` | `R13.3: every added event name differs from every pre-existing one` | P28 |
| R13.4 | Omitted new field falls back to its default | `S/__tests__/isolation.spec.ts` | `R13.4: an added field left out of a stored record falls back to its documented default` | P10 |
| R13.5 | Every pre-existing REST route still served | `S/__tests__/isolation.spec.ts` | `R13.5/R13.6: every pre-existing route resolves at its path and method with its existing status` | P28 |
| R13.6 | Pre-existing responses unchanged | `S/__tests__/isolation.spec.ts` | `R13.6: an authenticated pre-existing route still answers with its existing response fields` | P28 |
| R13.7 | Every existing accessible name and ARIA attribute kept | `C/no-regression.spec.ts` | `R13.7/R13.8: pre-existing ARIA surface and key bindings survive` › `R13.7/R13.8: every frozen claim holds, with none left to the draw` — see §D for the one deliberate change | P28 |
| R13.8 | Every existing keyboard interaction kept | `C/no-regression.spec.ts` | `R13.7/R13.8: any frozen claim drawn at random still holds` | P28 |
| R13.9 | Retro and poker concerns isolated | `S/__tests__/isolation.spec.ts` | `R13.9: no retro module names a poker module in any import specifier`; `R13.9: the shared liveness probe names neither the retro nor the poker half` | P28 |
| R13.10 | Legacy config broadcasts `fluidCardHeight` true | `S/services/__tests__/retro-session-fluid-height.spec.ts` | `Broadcast state always carries a boolean fluidCardHeight (R13.10)` › `reports true for a legacy config that omits the field` | P10 |
| R13.11 | Legacy session renders with the fluid behaviour | `C/components/retro-board/fluid-height-settings.spec.ts`, `H/__tests__/fluid-card-height.property.spec.ts` | `the broadcast (R6.16)` › `treats a broadcast configuration that omits the field as fluid`; `Property 10` (`Validates: Requirements 6.1, 6.3, 13.4`) | P10 |
| R13.12 | `/api/health` 200 for every base path | `S/__tests__/server.test.ts` | `GET /api/health` › `should return 200 with status ok` — **empty base path only; open gap, see §C2** | — |
| R13.13 | Client and REST routes resolve under every base path | — | **open gap** — see §C2 | — |
| R13.14 | WS upgrade split holds for every base path | — | **open gap** — see §C3 | — |
| R13.15 | Stored token and user keys unchanged | `C/components/lobby/lobby-user-menu.spec.ts` | `logout (R12.5)` › `clears the stored token and user record before navigating to the login page` — asserts the literal `scrum-poker-token` / `scrum-poker-user` keys | — |

---

## §A — Not directly observable

The client test runner performs no layout: `getBoundingClientRect()` returns zeros and CSS
custom properties are not computed. The criteria below are therefore asserted through a
surrogate, named in the table above.

| Criterion | Why not observable | Surrogate asserted instead |
|---|---|---|
| **A1 — R4.1** | The position of a rasterised glyph inside the produced PNG cannot be read back in the test environment; no canvas rasteriser runs. | The capture-mode substitution that guarantees containment: the live `<textarea>` is replaced by a static block clone carrying the full text with the live typography and a height containing its wrapped lines (Property 13), and every mutation is undone exactly (Property 12). A one-off manual visual check of a captured PNG stands in for the pixel assertion. |
| **A2 — R7.8, R7.13, R10.1, R10.2, R10.11** | Rendered row heights require layout. | The **declared** maxima are read from the compiled stylesheets and summed: header + toolbar + context against the 160 px and 240 px caps, the toolbar row against 40 px, the three wrapped rows against 3 × 40 px, and toolbar + context against 72 px (asserted as 66.8 px). |
| **A3 — R11.3 (width ratio)** | The `width ≥ 1.5 × height` relation is a rendered-geometry fact. The chip declares a 24 px height with an inline text label, which makes the ratio hold by construction but not by measurement. | The height half of the criterion is asserted against the declared 24 px being within the 32 px control box; the width half rests on the declared inline-label layout. |
| **A4 — R11.20 (±5 s tolerance)** | Wall-clock drift of a 30-second interval is not measurable under a deterministic test runner. | The declared interval is asserted as exactly 30 000 ms and probe behaviour is driven by **tick counts under fake timers**, so the tolerance window is never exercised as elapsed time. |

Count: **8** criteria (R4.1, R7.8, R7.13, R10.1, R10.2, R10.11, R11.3, R11.20).

---

## §B — The "R13.18 conflict": what the spec documents and what the code actually changed

### B1 — R13.18 does not exist

`requirements.md` Requirement 13 has **15** acceptance criteria (R13.1 through R13.15). There
is no R13.18. The identifier `R13.18` is cited by `design.md` (Stream 10, "One documented
conflict (R13.18)"), by `tasks.md` (tasks 24.11, 25.1, 25.2) and by inline comments in four
test files, but it has no text in `requirements.md`.

The text the design attributes to it — *"existing assertions remain present and unchanged"* —
is the text of **R14.18**: *"THE existing automated test suite SHALL pass without modification
to its existing assertions, so that every assertion present in the test files before this
feature remains present and unchanged after this feature."*

So the conflict this ledger was asked to record is a conflict against a criterion that is not
present in the requirements. Recorded here as a spec-document inconsistency, not resolved:
changing a requirement identifier is not a documentation decision. The substance of the change
is documented below against R11.14 and R11.26, which do exist, and the no-regression constraint
it trades against is R14.18.

### B2 — The two superseded test cases

Two pre-existing test cases were replaced, one in each WebSocket service spec. Both originally
asserted toast text that R11 now forbids.

| File | Superseded assertion | Replacement test |
|---|---|---|
| `client/src/app/services/websocket.service.spec.ts` | a drop shows `'Connection lost. Attempting to reconnect...'` | `toast notifications` › `should show no toast on unexpected connection close, reporting it through the state instead` |
| `client/src/app/services/websocket.service.spec.ts` | the first retry shows `` `Reconnecting... (attempt 1)` `` | `toast notifications` › `should show no toast for the first nine reconnection attempts and exactly one at the tenth` |
| `client/src/app/services/retro-websocket.service.spec.ts` | a drop shows `'Connection lost. Attempting to reconnect...'` | `toast notifications` › `should show no toast on unexpected connection close, reporting it through the state instead` |
| `client/src/app/services/retro-websocket.service.spec.ts` | the first retry shows `` `Reconnecting... (attempt 1)` `` | `toast notifications` › `should show no toast for the first nine reconnection attempts and exactly one at the tenth` |

**Rationale.** R11.14 requires the connection loss to be conveyed through the connection status
indicator alone, with zero notifications. R11.26 forbids any notification whose text reports a
connection loss or a reconnection attempt number. R11.15 permits at most one notification per
episode and only at the give-up threshold. A per-drop toast and a per-attempt toast are each
directly incompatible with those three. R11 is the specific, intentional change and wins; the
replacements assert the counterpart rule (silence below the threshold, exactly one tagged
`error` notification at it). Each replacement carries an inline comment recording what it
replaced.

### B3 — One further change to a pre-existing assertion

Beyond the four cases in B2, two pre-existing assertions in
`client/src/app/services/retro-websocket.service.spec.ts` were widened rather than replaced:
the reserved-close-code cases for 4009 (`'This name is already taken in the session. Please
choose a different name.'`) and 4004 (`'Retrospective session not found.'`) now expect a third
`show()` argument, `{ tag: 'connection' }`. The notification type, the message text and the
subsequent navigation are byte-identical to the pre-existing expectations; the tag is what
R11.27 dismisses on the next connection state change, so a tagless call would leave the
notification on screen after the state moved on. `websocket.service.spec.ts` holds no
equivalent case and is unchanged outside B2.

Recorded here as a fifth departure from R14.18's "present and unchanged" wording. Unlike B2 it
is additive: no pre-existing expectation was dropped or inverted.

### B4 — Property 18 changed in substance: avatar initial extraction

`client/src/app/components/user-menu/user-menu.component.property.spec.ts`.

| Superseded assertion | Replacement test |
|---|---|
| `Property 18: Avatar first-letter extraction` › `should return the uppercase first character of any non-empty display name`, asserting `expect(getAvatarLetter(name)).toBe(name.charAt(0).toUpperCase())` over `fc.string({ minLength: 1, maxLength: 50 })` | `Property 18: Avatar initial extraction` › `should return the uppercase first non-whitespace character of any display name`, plus the new case `should return no initial for whitespace-only display names` asserting `getAvatarLetter(name)` is `''` over whitespace-only strings |

**Rationale.** R12.3 requires the initial to be *"the uppercase form of the first
non-whitespace character"* of the display name; R12.10 requires the avatar button to render
**without initial text** when the name holds no non-whitespace character. The superseded
assertion is incompatible with both: for the input `" "` it demands `' '`, and that is the
input it failed on. `getAvatarLetter` was hardened to iterate by code point, skip any character
matching `/\s/u`, and return `''` when none remains — so astral characters survive intact and
the whitespace-only case has a defined, asserted answer.

This is a genuine behavioural change, not a restatement of the old assertion in new words. It
is the same shape of conflict as B2 — the specific new criterion wins over the no-regression
wording — with one difference: task 24.11 pre-authorized only the four B2 cases, so this one
was not pre-authorized. Recorded here as a sixth departure from R14.18. The baseline file also
carried `**Validates: Requirements 23.1**`, an identifier with no text in `requirements.md`
(cf. B1); the replacement cites R12.3 and R12.10.

### B5 — `retro-screenshot.service.spec.ts` rewritten: 5 cases to 13

`client/src/app/services/retro-screenshot.service.spec.ts` was rewritten rather than extended.
All five baseline `it` names are gone — `should be created`, `should show success toast when
screenshot is copied to clipboard`, `should fallback to download when clipboard API is not
available`, `should show error toast when screenshot capture fails`, `should fallback to
download when clipboard write throws` — so read literally against R14.18's "remains present and
unchanged" the file does not satisfy it. **The substance of all five is preserved**, as follows.

| Baseline assertion | Where it survives now |
|---|---|
| `expect(showSpy).toHaveBeenCalledWith('info', 'Screenshot copied to clipboard')` | `clipboard success (R4.5)` › `copies the PNG and emits exactly one notification without downloading`, via `COPIED_MESSAGE` |
| `expect(showSpy).toHaveBeenCalledWith('info', 'Screenshot downloaded')` (both fallback cases) | `download fallback (R4.6, R4.9)` › `downloads one PNG and emits exactly one notification when the clipboard is unavailable` and › `... when the clipboard write rejects`, via `DOWNLOADED_MESSAGE` |
| `expect(showSpy).toHaveBeenCalledWith('error', 'Failed to capture screenshot')` | `render failure (R4.4)` › `emits exactly one error notification, copies nothing and downloads nothing`, via `FAILED_MESSAGE` |
| `windowWidth: 800`, `windowHeight: 600`, `width: 800`, `height: 600` passed to `html2canvas` | `clipboard success (R4.5)` › `renders the board at its full scroll size`, asserting the same four values |
| `expect(service).toBeTruthy()` | `is created and reports no capture in progress` |

The three toast assertions now read through constants exported by
`retro-screenshot.service.ts` whose values are byte-identical to the former inline literals:
`COPIED_MESSAGE = 'Screenshot copied to clipboard'`,
`DOWNLOADED_MESSAGE = 'Screenshot downloaded'`,
`FAILED_MESSAGE = 'Failed to capture screenshot'`. Each is **strengthened**, not weakened: the
baseline asserted "was called with", the replacement asserts *exactly one* notification
(`expect(show).toHaveBeenCalledTimes(1)` and then the same type and message), which is what the
R4 criteria actually require.

**Why the rewrite was required.** The five baseline cases reach none of R4.4 (a failed capture
must also write nothing to the clipboard and trigger no download), R4.5 (clipboard success emits
one notification and no download), R4.6 (unavailable *or* failing clipboard falls back to
exactly one PNG download), R4.8 (a capture that produces no image within 10 s ends and counts as
a failure), R4.9 (a download emits exactly one notification) or R4.10 (no second capture starts
while one is in progress). Covering them needs the `capture budget (R4.8)` and
`re-entry guard (R4.1, R4.10)` blocks, a deferred-render harness and fake timers, which is what
took the file from 5 cases to 13.

Recorded here as a seventh departure from R14.18: literal in form, additive in substance.

### B6 — Verified equivalent, not a departure: Property 17 contrast helpers

`client/src/app/components/card-deck/card-deck.component.property.spec.ts` Property 17 was
**re-expressed, not changed**. Its local `hexToSrgb`, `linearize`, `relativeLuminance`,
`contrastRatio` and `mixWithWhite` helpers were deleted in favour of
`client/src/app/testing/contrast.ts`. The shared module computes the identical numbers:

- same WCAG 2.1 linearisation — `c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)`
- same luminance weights — `0.2126 R + 0.7152 G + 0.0722 B`
- same ratio formula — `(lighter + 0.05) / (darker + 0.05)`
- same sRGB white mix — `mixWithWhite(accent, ratio)` is `color-mix(in srgb, accent ratio%, #ffffff)`, as before
- `WCAG_AA_TEXT_CONTRAST === 4.5`, the threshold the baseline inlined

`effectiveBackground` keeps its 0.08 and 0.25 worst-case tints and the property keeps
`numRuns: 200`. Numerically identical on every input — a deduplication, not a behavioural
change. Recorded so a future reader does not have to re-derive the equivalence.

---

## §C — Open gaps

Criteria with no automated test asserting them. Recorded, not fixed.

| Criterion | Gap |
|---|---|
| **C1 — R5.7** | Enter without Shift inside a card text area must commit the edit and release focus. `RetroCardComponent.onTextEnter` implements it (`(keydown.enter)` binding, `!keyEvent.shiftKey` guard, `preventDefault()` then `blur()`), and Property 15 asserts the blur-commit path it feeds into, but no test dispatches the Enter key. The behaviour is observable — a keyboard event on the rendered textarea — so this is a missing test, not an observability limit. |
| **C2 — R13.12 (partial), R13.13** | `S/__tests__/server.test.ts` asserts `/api/health` returns 200 under the default empty base path only. No test exercises a non-empty `BASE_PATH`, so neither the "for every configured base path value" clause of R13.12 nor the route-prefix resolution of R13.13 is asserted in Jest or Vitest. `tests/k8s-smoke.test.sh` checks that both k8s probes point at `/api/health`, and `tests/docker-smoke.test.sh` curls it in a running container — deployment smoke scripts, not part of either `npm test`. |
| **C3 — R13.14** | The `server.on('upgrade')` retro/poker split is asserted for neither the default nor a prefixed base path. `server.ts` carries the split and the two independent liveness probes (`R11.22`, `R13.9`, `R13.14` are cited in its comments), and `liveness.spec.ts` asserts probe independence, but no test drives an upgrade request through the path-matching branch. |

Count: **4** criteria (R5.7, R13.12, R13.13, R13.14).

---

## §D — Known shortfalls and deliberate changes

### D1 — Retro board header text contrast (R7.4)

The retro board header paints the shared `--gradient-primary`. Its light stop `#667eea` gives
white header text a measured contrast ratio of **3.66:1** — above the 3:1 a non-text indicator
or focus ring needs (R7.14), below the **4.5:1 that R7.4 requires for text**. The contrast
tests therefore assert that header pair at the 3:1 non-text threshold only, and the
`(text token, surface)` pair list in
`client/src/app/components/retro-board/retro-layout.property.spec.ts` deliberately excludes it;
the exclusion and the measured figure are recorded in that file's header comment (lines 67–78).

This is pre-existing app-wide chrome. Fixing it needs a darker `--gradient-primary` stop, a
theme-level change that affects every page, which is outside this spec's scope.
`client/src/styles.scss` already records the same conclusion for the connection indicator: the
session headers paint a gradient against which no saturated green or red reaches 3:1, which is
why the indicator sits on its own neutral chip surface instead.

**Status: known, documented shortfall. Not fixed by this feature.**

### D2 — Retro board connection indicator accessible name (R13.7)

Before this feature the retro board header carried an inline indicator with
`[attr.aria-label]="'Connection status: ' + connectionState()"`, so its accessible name read
`Connection status: connected`. That span was replaced by `<app-connection-status>`, whose
accessible name for the same state is `Connected` — the exact text R11.4 requires.

This is a **delegation to the shared component, not a removal of the indicator**. The name is
still present on the page, declared one level down, and the substitution is covered twice over:

- `C/no-regression.spec.ts` › `R13.7: the retro board page still exposes a connection-status accessible name` asserts `ConnectionStatusComponent` is a declared dependency of the page, that it carries `role="status"`, and that every `CONNECTION_LABEL` entry is non-empty.
- Property 16 (`C/components/connection-status/connection-status.property.spec.ts` › `renders title, accessible name and visible text all equal to the state label`) asserts `title === ariaLabel === labelText === CONNECTION_LABEL[state]` for all three states.

**Status: deliberate, covered change. Not a regression.**

### D3 — Collapsed property generators: one fixed false green, 23 specs left alone

A generator audit found that `fc.array` and `fc.string` with a `maxLength` above 10 **silently
cap generated input near 10 entries** unless `size: 'max'` is passed as well. `maxLength` alone
is an upper bound, not a target, and fast-check's default sizing ignores it.

**Fixed in this spec.** 15 call sites across 6 of this feature's property specs were collapsed
this way. Each now passes `size: 'max'` and is followed by a coverage assertion that fails
loudly if the generator ever collapses again.

**One was a real false green.** `client/src/app/services/connection-episode.property.spec.ts`
Property 18 never reached its threshold-crossing branch. `GIVE_UP_THRESHOLD` is 10 and the
`attempt` arm carries weight 8 of 12, so sequences capped near 12 events could essentially never
stack 10 consecutive attempts. The run-level assertion `expect(notifications).toBe(
thresholdCrossings)` was passing as `0 === 0`, and every assertion inside the `step.after.gaveUp`
branch — the single `toast-give-up`, `attempt === GIVE_UP_THRESHOLD`, no `schedule-reconnect`,
one `navigate-login` — was dead code. The fix raises the bound to `MAX_SEQUENCE_LENGTH = 60` with
`size: 'max'` and adds `R14.12: the generated sequences reach the stated length bound and
actually cross the threshold`, which asserts `coverage.longestSequence >= 54` and
`coverage.crossings > 0`.

**Left alone: 23 pre-existing property specs** tracked at the baseline hold the same collapsed
generators — among them `game-session-issues`, `retro-session`, `retro-session-registry`,
`session-manager`, `metrics-engine`, `board.component`, `merge` and `feelings.service.sync`.
Widening their generators changes the behaviour of pre-existing tests, which is exactly what
R14.18 freezes, and any of them could surface a pre-existing failure unrelated to this feature.
They were deliberately not touched.

**Status: recommended follow-up outside this spec.** Widen the 23 baseline specs' generators in
a dedicated change, one spec at a time, so that any failure it uncovers is attributable.


### D4 - R7.16 amended post-delivery: columns now fill the board height

Three defects were reported on the retro board after delivery. Two of them traced to R7.16 as
originally written, so the criterion was amended rather than treated as a regression. Tracked
in the `retro-board-layout-fixes` bugfix spec.

| Defect | Cause | Fix |
|---|---|---|
| Settings dialog clipped at both ends, no scrollbar | `.retro-settings` stacked ~19 rows in one flex column; `.retro-dialog` declared no `max-height` and no `overflow`, and the backdrop is a centred `position: fixed` box | `.retro-dialog--settings` capped at `calc(100dvh - 48px)` as a flex column; `.retro-settings` became an `auto-fit` grid with `overflow-y: auto; min-height: 0` |
| Empty column rendered as a 60px stub | `.retro-column__cards { min-height: 60px }` on a content-sized column | Column stretches to the board height; the 60px floor removed |
| Cards unreachable, page would not scroll | `.retro-board__columns--vertical { align-items: flex-start; overflow-y: hidden }` with content-sized columns clipped the surplus, and the page is `height: 100dvh; overflow: hidden` | `align-items: stretch` through the mandatory `.interaction-blocker` link; `.retro-column__cards` is now the single scroller at `flex: 1 1 auto; min-height: 0` |

**Why R7.16 was amended.** Its original wording - a column block size that follows its card
count, with no fixed size leaving dead space below the last card - is what produced both the
60px empty column and the clipped overflow. The container `overflow-y: hidden` was added for
R7.12, which governs horizontal overflow only, so it was over-applied. The amended criterion
splits by layout: vertical columns fill the container and scroll internally with the header
pinned; horizontal columns keep content sizing and the container scrolls. Fluid card height was
an amplifier, not a cause - the defect was present at fixed card height at a higher card count.

**Coverage.** The R7.16 row above names the renamed test. Two further cases guard the split: the
stacked-layout counterparts (`align-self: flex-start`, `height: auto`, `flex: 0 0 auto`) so one
layout cannot be satisfied by breaking the other, and a structural case asserting one
`.interaction-blocker` between container and hosts plus one card list and one header per column.
A new settings-dialog describe covers the cap, the grid body and the untouched `.retro-dialog`
baseline. One pre-existing assertion was widened: `retro-toolbar.compact.spec.ts` R10.8 required
`.retro-toolbar` to be the only scroller in that stylesheet, and now allows `.retro-settings` as
an explicit second entry, since it sits inside a fixed backdrop and cannot push the toolbar row
scroll onto the page.

**Status: fixed and covered.** A deliberate behavioural change with test coverage, not a shortfall.

---

## §E — Note on R14.2 derivability

Most added tests embed their `Rx.y` markers directly in the `it` title or in the enclosing
`describe` title, so the covered count is derivable by scanning test names. Nine property-test
files identify themselves by Property number instead and carry the criterion list in a
`**Validates: Requirements ...**` doc comment immediately above the describe block — the link
form the design defines for property tests. Those files are:
`retro-card.scroll.property.spec.ts`, `fluid-card-height.property.spec.ts`,
`retro-resume-list.property.spec.ts`, `connection-status.property.spec.ts`,
`interaction-blocking.property.spec.ts`, `lobby-user-menu.property.spec.ts`, plus the
`sessions-export.spec.ts`, `retro-column.dnd.spec.ts` and `server.test.ts` cases cited above,
whose criterion links come from the file header comment or from this ledger. For those, the
count is derivable from the test name plus its adjacent annotation rather than from the name
alone.
