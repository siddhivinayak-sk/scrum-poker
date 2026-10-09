import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CardRect, adjustDropIndexForSameColumn, computeDropIndex } from './drop-index';

// Feature: poker-retro-ux-improvements, Property 11: For any list of card
// rectangles with arbitrary, non-uniform sizes and any pointer position, the
// computed drop index equals the number of rectangles whose midpoint lies at
// or before the pointer, which is 0 for an empty list.

/**
 * One generated column layout: cards laid end to end along the active axis,
 * separated by the generated gaps. Sizes are deliberately non-uniform so the
 * height-agnostic claim of R6.12 is exercised rather than assumed.
 */
interface Layout {
  /** Coordinate of the first card's leading edge. */
  origin: number;
  /** Card extents along the axis, 10–400 px, one entry per card (0–50 cards). */
  sizes: number[];
  /** Gap preceding card `i + 1`, 0–16 px. */
  gaps: number[];
}

/** Lays the generated sizes out end to end, applying the gap before each card after the first. */
function layOut(layout: Layout, sizeDelta = 0): CardRect[] {
  const rects: CardRect[] = [];
  let cursor = layout.origin;

  for (let i = 0; i < layout.sizes.length; i++) {
    if (i > 0) {
      cursor += layout.gaps[i - 1] ?? 0;
    }
    const size = layout.sizes[i] + sizeDelta;
    rects.push({ start: cursor, size });
    cursor += size;
  }

  return rects;
}

/** Trailing edge of the strip, or the origin for an empty column. */
function stripEnd(rects: readonly CardRect[], origin: number): number {
  const last = rects[rects.length - 1];
  return last ? last.start + last.size : origin;
}

function midpoint(rect: CardRect): number {
  return rect.start + rect.size / 2;
}

/**
 * The specification read directly: the index is the count of cards whose
 * midpoint is at or before the pointer.
 */
function expectedDropIndex(rects: readonly CardRect[], pointerPos: number): number {
  return rects.filter((rect) => midpoint(rect) <= pointerPos).length;
}

/** Stated upper bound on the generated column size. */
const MAX_CARDS = 50;

/**
 * `size: 'max'` on both arrays: fast-check's default sizing caps a generated
 * array near ten entries whatever `maxLength` says, so without it the 0–50
 * card columns this property claims to cover would never be generated and the
 * `rects.length <= 50` assertion below would be vacuous.
 */
const layoutArb: fc.Arbitrary<Layout> = fc.record({
  origin: fc.integer({ min: 0, max: 1000 }),
  sizes: fc.array(fc.integer({ min: 10, max: 400 }), {
    minLength: 0,
    maxLength: MAX_CARDS,
    size: 'max',
  }),
  gaps: fc.array(fc.integer({ min: 0, max: 16 }), {
    minLength: 0,
    maxLength: MAX_CARDS,
    size: 'max',
  }),
});

/**
 * Pointer positions spanning before, inside and after the strip, plus the
 * exact midpoints and their immediate neighbours, since the midpoint is the
 * decision boundary.
 */
function pointerArb(rects: readonly CardRect[], origin: number): fc.Arbitrary<number> {
  const end = stripEnd(rects, origin);
  const before = fc.integer({ min: 1, max: 500 }).map((d) => origin - d);
  const after = fc.integer({ min: 0, max: 500 }).map((d) => end + d);

  if (rects.length === 0) {
    return fc.oneof(before, after);
  }

  const inside = fc.integer({ min: origin, max: end });
  const aroundMidpoint = fc
    .integer({ min: 0, max: rects.length - 1 })
    .chain((i) =>
      fc.constantFrom(-0.5, 0, 0.5).map((offset) => midpoint(rects[i]) + offset),
    );

  return fc.oneof(before, inside, after, aroundMidpoint);
}

interface Scenario {
  layout: Layout;
  rects: CardRect[];
  pointerPos: number;
  /** Size increase applied uniformly to every card, 0–200 px. */
  sizeDelta: number;
  /** Uniform scale factor applied to the whole geometry. */
  scale: number;
  /** Index the dragged card currently occupies, or -1 when it is not in this column. */
  originalIndex: number;
}

const scenarioArb: fc.Arbitrary<Scenario> = layoutArb.chain((layout) => {
  const rects = layOut(layout);
  return fc.record({
    layout: fc.constant(layout),
    rects: fc.constant(rects),
    pointerPos: pointerArb(rects, layout.origin),
    sizeDelta: fc.integer({ min: 0, max: 200 }),
    scale: fc.integer({ min: 1, max: 4 }),
    originalIndex: fc.integer({ min: -1, max: Math.max(-1, rects.length - 1) }),
  });
});

/**
 * Property 11: Drop index from bounding-box midpoints
 *
 * For any column of 0–50 cards with non-uniform sizes (10–400 px) laid end to
 * end with gaps of 0–16 px, and any pointer position before, inside or after
 * the strip, `computeDropIndex` returns the number of cards whose midpoint lies
 * at or before the pointer — 0 for an empty column. A uniform size increase,
 * and a uniform scaling of the whole geometry, leave that decision unchanged
 * once the pointer is carried along with the midpoint boundary it sits against.
 * `adjustDropIndexForSameColumn` then applies the same-column correction, and
 * leaves the index untouched when the card does not belong to this column
 * (`originalIndex === -1`).
 *
 * **Validates: Requirements 6.12**
 */
describe('Property 11: Drop index from bounding-box midpoints', () => {
  /** Largest generated column the properties actually saw (coverage guard). */
  let widestColumn = 0;

  it('R6.12: returns the count of card midpoints at or before the pointer, for any non-uniform card sizes', () => {
    fc.assert(
      fc.property(scenarioArb, ({ rects, pointerPos }) => {
        widestColumn = Math.max(widestColumn, rects.length);
        expect(rects.length).toBeLessThanOrEqual(MAX_CARDS);

        const index = computeDropIndex(rects, pointerPos);

        expect(index).toBe(expectedDropIndex(rects, pointerPos));
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThanOrEqual(rects.length);

        // A card dropped above a card's midpoint takes that card's index; at or
        // below it, the following index.
        if (index > 0) {
          expect(midpoint(rects[index - 1])).toBeLessThanOrEqual(pointerPos);
        }
        if (index < rects.length) {
          expect(pointerPos).toBeLessThan(midpoint(rects[index]));
        }
      }),
      { numRuns: 100 },
    );
  });

  it('R6.12: an empty column always yields index 0', () => {
    fc.assert(
      fc.property(fc.double({ min: -1000, max: 1000, noNaN: true }), (pointerPos) => {
        expect(computeDropIndex([], pointerPos)).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('R6.12: a uniform size increase and a uniform scaling leave the decision unchanged for a correspondingly moved pointer', () => {
    fc.assert(
      fc.property(scenarioArb, ({ layout, rects, pointerPos, sizeDelta, scale }) => {
        const index = computeDropIndex(rects, pointerPos);

        // Growing every card by `sizeDelta` and re-laying the strip moves the
        // midpoint bounding the decision by `sizeDelta * (index - 0.5)`.
        const grown = layOut(layout, sizeDelta);
        const grownPointer = index === 0 ? pointerPos : pointerPos + sizeDelta * (index - 0.5);

        expect(computeDropIndex(grown, grownPointer)).toBe(index);

        // Scaling the whole geometry scales every midpoint by the same factor.
        const scaled = rects.map(({ start, size }) => ({ start: start * scale, size: size * scale }));

        expect(computeDropIndex(scaled, pointerPos * scale)).toBe(index);
      }),
      { numRuns: 100 },
    );
  });

  it('R6.12: the same-column correction shifts only indices after the dragged card and never fires for a foreign card', () => {
    fc.assert(
      fc.property(scenarioArb, ({ rects, pointerPos, originalIndex }) => {
        const dropIndex = computeDropIndex(rects, pointerPos);
        const adjusted = adjustDropIndexForSameColumn(dropIndex, originalIndex);

        if (originalIndex === -1) {
          // Behaviour-identical with the component: a card arriving from
          // another column is never corrected.
          expect(adjusted).toBe(dropIndex);
        } else if (originalIndex < dropIndex) {
          expect(adjusted).toBe(dropIndex - 1);
          // Dropping onto either side of its own midpoint is a no-op move.
          if (dropIndex === originalIndex + 1) {
            expect(adjusted).toBe(originalIndex);
          }
        } else {
          expect(adjusted).toBe(dropIndex);
          if (dropIndex === originalIndex) {
            expect(adjusted).toBe(originalIndex);
          }
        }

        expect(adjusted).toBeGreaterThanOrEqual(0);
        expect(adjusted).toBeLessThanOrEqual(rects.length);
      }),
      { numRuns: 100 },
    );
  });

  it('R6.12: the column generator actually reaches the stated 50-card bound', () => {
    // A coverage guard over the runs above: a return to fast-check's default
    // sizing collapses the column to about ten cards, which would make the
    // non-uniform, many-card claim pass without ever being exercised.
    expect(widestColumn).toBeGreaterThanOrEqual(45);
    expect(widestColumn).toBeLessThanOrEqual(MAX_CARDS);
  });
});
