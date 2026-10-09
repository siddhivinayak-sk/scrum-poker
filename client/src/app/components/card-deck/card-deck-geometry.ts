/**
 * Pure geometry helpers for card deck selection containment (Stream 3, R3).
 *
 * The client test runner performs no layout, so `getBoundingClientRect()` is
 * always zeroed there. The reserved-space arithmetic therefore lives here as
 * plain functions that the component styles and the property tests both read,
 * which keeps the declared CSS values and the containment check from drifting.
 *
 * Deliberately free of Angular imports.
 */

/** Selection lift applied to the selected card, in pixels. Within [8, 12] (R3.1). */
export const SELECTION_LIFT_PX = 10;

/** Scale factor applied to the selected card. Within [1.00, 1.10] (R3.4). */
export const SELECTION_SCALE = 1.04;

/** Vertical space reserved above the card row, in pixels. Multiple of 4 (R3.4). */
export const DECK_PADDING_TOP_PX = 12;

/** Inputs describing one card's transformed box against the deck container. */
export interface DeckGeometry {
  /** Untransformed card border-box height, in pixels. */
  cardHeightPx: number;
  /** Vertical displacement applied to the card, in pixels (positive lifts upward). */
  liftPx: number;
  /** Scale factor applied to the card; 1 means unscaled. */
  scale: number;
  /** Space reserved above the card row inside the container, in pixels. */
  paddingTopPx: number;
}

/**
 * Vertical space the transform needs above the card's untransformed top edge.
 *
 * `liftPx + cardHeightPx * (scale - 1) / 2` — the lift, plus half the growth
 * from scaling, because a centred scale grows the box equally up and down.
 */
export function requiredHeadroomPx(g: DeckGeometry): number {
  return g.liftPx + (g.cardHeightPx * (g.scale - 1)) / 2;
}

/**
 * Top edge of the transformed border box relative to the container's top edge.
 * A value of 0 or more means the card stays inside the container (R3.2, R3.3).
 */
export function selectedCardTopOffsetPx(g: DeckGeometry): number {
  return g.paddingTopPx - requiredHeadroomPx(g);
}

/** True when the transformed card does not cross the container's top edge. */
export function isSelectionContained(g: DeckGeometry): boolean {
  return selectedCardTopOffsetPx(g) >= 0;
}
