# Retro Board Layout Fixes — Bugfix Requirements Document

## Introduction

Three layout defects are reported on the retrospective board. They fall into two independent
causes.

The first is in the Board Settings dialog. Every setting row stacks in a single column, the
dialog declares no height cap and no internal scroll, so on a moderator's board the body runs
to roughly 800px and the centred fixed backdrop clips it at both the top and the bottom. No
scrollbar appears anywhere, so the settings at either end are unreachable.

The second and third defects share one cause in the vertical (side-by-side) column layout. The
page is `height: 100dvh; overflow: hidden`, the column container is `align-items: flex-start`
with `overflow-y: hidden`, and each column is content-sized. A column therefore grows past the
container and the surplus is clipped with no scrollbar (cards unreachable), while an empty
column collapses to the 60px floor on its card area (stubby grey box). Enabling fluid card
height makes cards taller, which is why both symptoms surface there first. The container's
`overflow-y: hidden` was added for R7.12, but R7.12 governs horizontal overflow only, so it was
over-applied.

The fix adopts the standard kanban model for the vertical layout: columns fill the board height
and each column scrolls its own cards, keeping the header and add button pinned. The horizontal
(stacked) layout keeps its existing content-sized behaviour. This contradicts R7.16 of the
`poker-retro-ux-improvements` spec as originally written, so that criterion is amended rather
than silently broken.

## Bug Analysis

### Current Behavior (Defect)

What currently happens when the bug is triggered.

1.1 WHEN the Board Settings dialog is opened THEN the system stacks all setting rows in a single
column, producing a dialog body taller than the viewport.

1.2 WHEN the Board Settings dialog body is taller than the viewport THEN the system clips the
dialog at both the top and the bottom and offers no scrollbar, leaving the settings at either
end unreachable.

1.3 WHEN the board is in the vertical layout and a column holds no cards THEN the system
collapses that column to the 60px minimum block size of its card area, rendering a stubby grey
box well short of the board height.

1.4 WHEN the board is in the vertical layout and a column's cards extend past the board height
THEN the system clips the surplus cards and offers no vertical scrollbar on either the column or
the page, leaving the cards at the top and bottom of that column unreachable.

1.5 WHEN fluid card height is enabled THEN the system makes cards taller, which makes defects 1.3
and 1.4 visible at a lower card count than with fixed-height cards.

### Expected Behavior (Correct)

What should happen instead.

2.1 WHEN the Board Settings dialog is opened THEN the system SHALL lay the settings out across
multiple columns on a wide enough viewport and SHALL collapse to a single column on a narrow
viewport without a media query.

2.2 WHEN the Board Settings dialog content exceeds the available viewport height THEN the system
SHALL cap the dialog at the viewport height and SHALL scroll the settings body internally, so
the dialog title and action buttons stay in view and every setting is reachable.

2.3 WHEN the Board Settings dialog is laid out in multiple columns THEN the system SHALL make the
column-layout row and the "Feelings" section heading span the full dialog width, and SHALL lay
the feeling toggles out in their own responsive multi-column grid.

2.4 WHEN the board is in the vertical layout and a column holds no cards THEN the system SHALL
stretch that column to the full board height.

2.5 WHEN the board is in the vertical layout and a column's cards extend past the board height
THEN the system SHALL scroll that column's card list internally, keeping the column header, card
count, add button and delete button pinned, so every card in the column is reachable.

2.6 WHEN the board is in the vertical layout THEN the system SHALL stretch every column to the
board height regardless of its card count, so all columns share a common block size.

2.7 WHEN fluid card height is enabled THEN the system SHALL satisfy 2.4, 2.5 and 2.6 at any card
count and any card height.

### Unchanged Behavior (Regression Prevention)

Existing behavior that must be preserved.

3.1 WHEN the board is in the horizontal (stacked) layout THEN the system SHALL CONTINUE TO size
each column to its own cards and SHALL CONTINUE TO scroll the column container vertically.

3.2 WHEN the board is in the horizontal layout THEN the system SHALL CONTINUE TO flow a column's
cards left-to-right at a fixed card width, with that row scrolling horizontally inside the
column.

3.3 WHEN the columns do not fit the content width in the vertical layout THEN the system SHALL
CONTINUE TO confine horizontal overflow to the column container and SHALL CONTINUE TO let that
container fill the content width (R7.12, R7.15).

3.4 WHEN a card or a column is dragged in either layout THEN the system SHALL CONTINUE TO show
the drop indicator at the computed index and SHALL CONTINUE TO commit the move on drop.

3.5 WHEN the Board Settings dialog is open THEN the system SHALL CONTINUE TO render the same set
of controls — the six base toggles, the moderator-only fluid card height toggle, the column
layout radios and the ten feeling toggles — with the same change handlers and the same
moderator gating.

3.6 WHEN any dialog other than Board Settings is opened THEN the system SHALL CONTINUE TO size
and position it as before.

3.7 WHEN the toolbar is rendered at a compact or mobile width THEN the system SHALL CONTINUE TO
lay out its controls as before.

3.8 WHEN any retro component style is inspected THEN the system SHALL CONTINUE TO declare every
margin, padding and gap edge as 0 or a multiple of 4px and every colour as a `var(--token)`
reference (Property 27).

3.9 WHEN a column's cards do not fill the board height in the vertical layout THEN the system
SHALL CONTINUE TO render those cards at their natural height, top-aligned within the column,
without stretching individual cards.
