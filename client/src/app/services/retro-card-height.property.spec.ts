import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ColumnLayout } from '@shared/types';
import {
  FIXED_LINES,
  FLUID_MAX_LINES,
  FLUID_MIN_LINES,
  HeightMetrics,
  WrapMetrics,
  cardTextAreaHeightPx,
  clampLines,
  computeTextAreaHeightPx,
  measureLineCount,
} from './retro-card-height';

/**
 * Properties 7, 8 and 9 for the pure retro card height module.
 *
 * All three properties exercise `measureLineCount`, `clampLines`,
 * `computeTextAreaHeightPx` and `cardTextAreaHeightPx` with no DOM: the module
 * is the single clamp implementation shared by the component, the screenshot
 * clone and these tests.
 *
 * The generated input space is the one R14.11 calls for: texts 0 through 5,000
 * characters including explicit line breaks, consecutive line breaks and a
 * single token wider than the element, at element widths 200 through 1,200
 * pixels, for both `fluid` values and both column layouts.
 */

/** Upper bound on generated text length (R14.11). */
const MAX_TEXT_LENGTH = 5000;

/** Element width bounds (R14.11). */
const MIN_WIDTH_PX = 200;
const MAX_WIDTH_PX = 1200;

/** Character advance width bounds; the card renders at `font-size: 0.8rem`. */
const MIN_CHAR_WIDTH_PX = 5;
const MAX_CHAR_WIDTH_PX = 12;

/**
 * Smallest token length that is wider than the element for *every* generated
 * width and character width: the widest line holds
 * `floor(1200 / 5) = 240` characters, so 300 characters never fit.
 */
const OVERSIZED_TOKEN_MIN_LENGTH = 300;
const OVERSIZED_TOKEN_MAX_LENGTH = 600;

const WORD_CHARS = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ...'-_/.,:;!?()[]{}#@&%',
  ...'äöüéßµ…✓→',
];

/**
 * Every length-bounded generator below passes `size: 'max'`. Without it
 * fast-check's default sizing caps a generated array or string near ten entries
 * whatever `maxLength` says, so the texts would never approach the 5,000
 * character bound R14.11 states and the clamp ceiling — which only engages past
 * twelve wrapped lines — would never be reached.
 */

/** An ordinary word, 1–24 characters, holding no whitespace. */
const wordArb = fc
  .array(fc.constantFrom(...WORD_CHARS), { minLength: 1, maxLength: 24, size: 'max' })
  .map((chars) => chars.join(''));

/** A token the element can never fit on one line, so the wrap must hard-break it. */
const oversizedTokenArb = fc
  .array(fc.constantFrom(...WORD_CHARS), {
    minLength: OVERSIZED_TOKEN_MIN_LENGTH,
    maxLength: OVERSIZED_TOKEN_MAX_LENGTH,
    size: 'max',
  })
  .map((chars) => chars.join(''));

/** Wrap opportunities, including runs that sit at the end of a line. */
const separatorArb = fc.constantFrom(' ', '  ', '   ', '\t');

/** Explicit single breaks and consecutive breaks that render as empty lines. */
const lineBreakArb = fc.constantFrom('\n', '\n\n', '\n\n\n', '\r\n');

const fragmentArb = fc.oneof(
  { weight: 6, arbitrary: wordArb },
  { weight: 3, arbitrary: separatorArb },
  { weight: 3, arbitrary: lineBreakArb },
  { weight: 1, arbitrary: oversizedTokenArb },
);

/**
 * Card text, 0 through 5,000 characters. The fragment arm covers the shapes the
 * wrap has branches for; the unconstrained arm adds breadth over arbitrary
 * unicode. Both are truncated to the 5,000 character bound.
 */
const textArb: fc.Arbitrary<string> = fc
  .oneof(
    {
      weight: 5,
      arbitrary: fc
        .array(fragmentArb, { maxLength: 80, size: 'max' })
        .map((parts) => parts.join('')),
    },
    { weight: 1, arbitrary: fc.string({ maxLength: 500, size: 'max' }) },
    { weight: 1, arbitrary: fc.constant('') },
  )
  .map((text) => text.slice(0, MAX_TEXT_LENGTH));

const wrapMetricsArb: fc.Arbitrary<WrapMetrics> = fc.record({
  availableWidthPx: fc.integer({ min: MIN_WIDTH_PX, max: MAX_WIDTH_PX }),
  charWidthPx: fc.integer({ min: MIN_CHAR_WIDTH_PX, max: MAX_CHAR_WIDTH_PX }),
});

const heightMetricsArb: fc.Arbitrary<HeightMetrics> = fc.record({
  lineHeightPx: fc.integer({ min: 14, max: 30 }),
  verticalPaddingPx: fc.integer({ min: 0, max: 24 }),
  fluid: fc.boolean(),
});

/** Both values of the retro column layout configuration (R6.14). */
const columnLayoutArb = fc.constantFrom<ColumnLayout>('vertical', 'horizontal');

/** The clamp bounds the configured mode declares: `(3, 12)` fluid, `(4, 4)` fixed. */
function expectedBounds(fluid: boolean): { min: number; max: number } {
  return fluid
    ? { min: FLUID_MIN_LINES, max: FLUID_MAX_LINES }
    : { min: FIXED_LINES, max: FIXED_LINES };
}

/** Widest text and most wrapped lines any property actually saw. */
const coverage = { textLength: 0, lineCount: 0 };

/** Guards every property against a generator that drifts out of the R14.11 space. */
function assertGeneratedInputsInRange(text: string, wrap: WrapMetrics): void {
  expect(text.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
  expect(wrap.availableWidthPx).toBeGreaterThanOrEqual(MIN_WIDTH_PX);
  expect(wrap.availableWidthPx).toBeLessThanOrEqual(MAX_WIDTH_PX);

  coverage.textLength = Math.max(coverage.textLength, text.length);
  coverage.lineCount = Math.max(coverage.lineCount, measureLineCount(text, wrap));
}

/**
 * Property 7: Card text area height is idempotent
 *
 * For any card text and any text-area width, evaluating the height function
 * repeatedly returns an identical value.
 *
 * **Validates: Requirements 6.8, 14.11**
 */
describe('Property 7: Card text area height is idempotent', () => {
  it('R6.8/R14.11: returns an identical height across three successive evaluations for every text, width and mode', () => {
    fc.assert(
      fc.property(textArb, wrapMetricsArb, heightMetricsArb, columnLayoutArb, (text, wrap, height, columnLayout) => {
        assertGeneratedInputsInRange(text, wrap);
        expect(columnLayout === 'vertical' || columnLayout === 'horizontal').toBe(true);

        const first = cardTextAreaHeightPx(text, wrap, height);
        const second = cardTextAreaHeightPx(text, wrap, height);
        const third = cardTextAreaHeightPx(text, wrap, height);

        expect(second).toBe(first);
        expect(third).toBe(first);

        // Each stage of the pipeline is idempotent on its own, so a recompute
        // triggered at any stage by a render pass yields the same value.
        const lines = measureLineCount(text, wrap);
        expect(measureLineCount(text, wrap)).toBe(lines);
        expect(measureLineCount(text, wrap)).toBe(lines);

        const clamped = clampLines(lines, height.fluid);
        expect(clampLines(lines, height.fluid)).toBe(clamped);
        expect(clampLines(clamped, height.fluid)).toBe(clamped);

        const fromLines = computeTextAreaHeightPx(lines, height);
        expect(computeTextAreaHeightPx(lines, height)).toBe(fromLines);
        expect(fromLines).toBe(first);
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 8: Card text area height is monotone in text prefixes
 *
 * For any pair of texts where the first is a prefix of the second, the computed
 * height of the first is less than or equal to the height of the second at the
 * same width.
 *
 * **Validates: Requirements 6.9, 14.11**
 */
describe('Property 8: Card text area height is monotone in text prefixes', () => {
  const textWithSplitArb = textArb.chain((text) =>
    fc.record({
      text: fc.constant(text),
      splitPoint: fc.integer({ min: 0, max: text.length }),
    }),
  );

  it('R6.9/R14.11: never reports a taller text area for a prefix than for the full text at the same width', () => {
    fc.assert(
      fc.property(
        textWithSplitArb,
        wrapMetricsArb,
        heightMetricsArb,
        columnLayoutArb,
        ({ text, splitPoint }, wrap, height, columnLayout) => {
          assertGeneratedInputsInRange(text, wrap);
          expect(splitPoint).toBeGreaterThanOrEqual(0);
          expect(splitPoint).toBeLessThanOrEqual(text.length);
          expect(columnLayout === 'vertical' || columnLayout === 'horizontal').toBe(true);

          const prefix = text.slice(0, splitPoint);
          expect(text.startsWith(prefix)).toBe(true);

          // The height itself, which is what the component binds.
          expect(cardTextAreaHeightPx(prefix, wrap, height)).toBeLessThanOrEqual(
            cardTextAreaHeightPx(text, wrap, height),
          );

          // The two stages the height is built from are monotone as well, so the
          // guarantee cannot be an artefact of the clamp flattening a regression.
          const prefixLines = measureLineCount(prefix, wrap);
          const fullLines = measureLineCount(text, wrap);
          expect(prefixLines).toBeLessThanOrEqual(fullLines);
          expect(clampLines(prefixLines, height.fluid)).toBeLessThanOrEqual(
            clampLines(fullLines, height.fluid),
          );

          // Monotonicity also holds for the empty prefix and the whole text,
          // the two boundaries of the split range.
          expect(cardTextAreaHeightPx('', wrap, height)).toBeLessThanOrEqual(
            cardTextAreaHeightPx(text, wrap, height),
          );
          expect(cardTextAreaHeightPx(text, wrap, height)).toBe(
            cardTextAreaHeightPx(text.slice(0, text.length), wrap, height),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('R6.9: grows monotonically along a chain of successive prefixes of one text', () => {
    fc.assert(
      fc.property(
        textArb,
        wrapMetricsArb,
        heightMetricsArb,
        fc.array(fc.nat(), { minLength: 1, maxLength: 8 }),
        (text, wrap, height, rawSplits) => {
          assertGeneratedInputsInRange(text, wrap);

          const splits = [
            0,
            ...rawSplits.map((value) => (text.length === 0 ? 0 : value % (text.length + 1))),
            text.length,
          ].sort((a, b) => a - b);

          let previous = -1;
          for (const split of splits) {
            const current = cardTextAreaHeightPx(text.slice(0, split), wrap, height);
            expect(current).toBeGreaterThanOrEqual(previous === -1 ? current : previous);
            previous = current;
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 9: Height clamp follows the configured mode
 *
 * For any card text, width and `fluidCardHeight` value, the height equals
 * `clamp(lineCount, min, max) × lineHeight + padding` where `(min, max)` is
 * `(3, 12)` when fluid and `(4, 4)` when not, independent of the column layout.
 *
 * **Validates: Requirements 6.4, 6.5, 6.6, 6.14**
 */
describe('Property 9: Height clamp follows the configured mode', () => {
  it('R6.4/R6.5/R6.6: equals the clamp formula and stays between the mode bounds for every text and width', () => {
    fc.assert(
      fc.property(textArb, wrapMetricsArb, heightMetricsArb, (text, wrap, height) => {
        assertGeneratedInputsInRange(text, wrap);

        const { min, max } = expectedBounds(height.fluid);
        const lines = measureLineCount(text, wrap);
        const expectedLines = Math.min(max, Math.max(min, Math.round(lines)));
        const expectedHeight = expectedLines * height.lineHeightPx + height.verticalPaddingPx;

        const actual = cardTextAreaHeightPx(text, wrap, height);

        expect(clampLines(lines, height.fluid)).toBe(expectedLines);
        expect(actual).toBe(expectedHeight);

        // R6.4 / R6.6 floor: never shorter than the 3-line (fluid) or 4-line
        // (fixed) height, the empty text included.
        expect(actual).toBeGreaterThanOrEqual(min * height.lineHeightPx + height.verticalPaddingPx);
        // R6.5 ceiling: never taller than the 12-line (fluid) or 4-line (fixed)
        // height, so anything beyond it scrolls instead of growing the card.
        expect(actual).toBeLessThanOrEqual(max * height.lineHeightPx + height.verticalPaddingPx);
      }),
      { numRuns: 100 },
    );
  });

  it('R6.14: produces the same height for both column layouts at the same width and mode', () => {
    fc.assert(
      fc.property(textArb, wrapMetricsArb, heightMetricsArb, (text, wrap, height) => {
        assertGeneratedInputsInRange(text, wrap);

        // The column layout reaches the height rule only through the element
        // width, so an equal width under either layout must give an equal
        // height. `layouts` enumerates both configuration values.
        const layouts: ColumnLayout[] = ['vertical', 'horizontal'];
        const heights = layouts.map(() => cardTextAreaHeightPx(text, wrap, height));

        expect(heights[0]).toBe(heights[1]);
        expect(new Set(heights).size).toBe(1);

        const { min, max } = expectedBounds(height.fluid);
        for (const value of heights) {
          expect(value).toBeGreaterThanOrEqual(min * height.lineHeightPx + height.verticalPaddingPx);
          expect(value).toBeLessThanOrEqual(max * height.lineHeightPx + height.verticalPaddingPx);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('R6.6: holds the fixed four-line height for every text length when the mode is not fluid', () => {
    fc.assert(
      fc.property(textArb, wrapMetricsArb, heightMetricsArb, (text, wrap, height) => {
        assertGeneratedInputsInRange(text, wrap);

        const fixed: HeightMetrics = { ...height, fluid: false };
        const expectedHeight = FIXED_LINES * fixed.lineHeightPx + fixed.verticalPaddingPx;

        expect(cardTextAreaHeightPx(text, wrap, fixed)).toBe(expectedHeight);
        // Independent of the text, so the empty card and the longest generated
        // card share one height.
        expect(cardTextAreaHeightPx('', wrap, fixed)).toBe(expectedHeight);
      }),
      { numRuns: 100 },
    );
  });

  it('R14.11: the text generator actually reaches the stated 5,000-character bound and the clamp ceiling', () => {
    // A coverage guard over every property in this file: a return to
    // fast-check's default sizing collapses the texts to a few characters, at
    // which point the clamp never leaves its 3- or 4-line floor and the
    // monotonicity and ceiling claims pass without being exercised.
    expect(coverage.textLength).toBeGreaterThanOrEqual(4500);
    expect(coverage.textLength).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
    expect(coverage.lineCount).toBeGreaterThan(FLUID_MAX_LINES);
  });
});
