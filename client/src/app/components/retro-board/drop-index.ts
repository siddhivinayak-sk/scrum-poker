/**
 * Pure drop-index geometry for retro column drag and drop.
 *
 * The algorithm is height-agnostic by construction: it only ever reads each
 * card's measured `start` and `size` along the layout axis (taken from
 * `getBoundingClientRect()` at drag time) and compares the pointer against
 * `start + size / 2`. No card height — uniform or fluid — appears as a
 * constant here, so variable card heights cannot shift the result.
 */

/** A rendered card's extent along the active layout axis. */
export interface CardRect {
  /** `rect.left` for horizontal columns, `rect.top` for vertical columns. */
  start: number;
  /** `rect.width` for horizontal columns, `rect.height` for vertical columns. */
  size: number;
}

/**
 * Index of the first card whose midpoint lies beyond `pointerPos`, else
 * `rects.length`. An empty column yields 0, since the loop falls through to
 * `rects.length === 0`.
 */
export function computeDropIndex(rects: readonly CardRect[], pointerPos: number): number {
  for (let i = 0; i < rects.length; i++) {
    const mid = rects[i].start + rects[i].size / 2;
    if (pointerPos < mid) {
      return i;
    }
  }

  return rects.length;
}

/**
 * Same-column move correction: removing the card from its original position
 * shifts every later index down by one.
 */
export function adjustDropIndexForSameColumn(dropIndex: number, originalIndex: number): number {
  return originalIndex !== -1 && originalIndex < dropIndex ? dropIndex - 1 : dropIndex;
}
