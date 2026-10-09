/**
 * Pure retro card height module (design Stream 4).
 *
 * The browser is the authoritative source of a card's rendered line count
 * (`(scrollHeight - verticalPadding) / lineHeight`), but the test DOM performs no
 * layout and the screenshot clone needs a height before it is attached. This module
 * therefore owns both a DOM-free greedy wrap (`measureLineCount`) and the single
 * clamp implementation (`clampLines` / `computeTextAreaHeightPx`) that the component,
 * the capture clone and the property tests all share.
 *
 * Two algebraic guarantees hold by construction:
 * - determinism / idempotence: every function is pure in its arguments (R6.8)
 * - prefix monotonicity: the scan only ever *increments* `completedLines`, and the
 *   clamp plus the height formula are monotone non-decreasing, so
 *   `height(prefix) <= height(text)` at the same width (R6.9)
 */

/** Smallest number of text lines a fluid card ever renders (R6.4). */
export const FLUID_MIN_LINES = 3;

/** Largest number of text lines a fluid card ever renders; beyond this it scrolls (R6.5). */
export const FLUID_MAX_LINES = 12;

/** Number of text lines a non-fluid card always renders, for any text length (R6.6). */
export const FIXED_LINES = 4;

/** Geometry needed to wrap text without a layout engine. */
export interface WrapMetrics {
  /** Content width of the text area in CSS pixels. */
  availableWidthPx: number;
  /** Average advance width of one character in CSS pixels. */
  charWidthPx: number;
}

/** Geometry needed to turn a line count into a text area height. */
export interface HeightMetrics {
  /** Rendered height of one text line in CSS pixels. */
  lineHeightPx: number;
  /** Sum of the top and bottom padding of the text area in CSS pixels. */
  verticalPaddingPx: number;
  /** `true` when the card sizes itself to its text, `false` for the fixed height. */
  fluid: boolean;
}

/**
 * Fallbacks used only when the caller hands over a degenerate metric (0, negative,
 * NaN) — a pre-layout element reports zeroes. They approximate the card's own
 * `font-size: 0.85rem` / `line-height: 1.4` so a fallback height stays plausible.
 */
const DEFAULT_CHAR_WIDTH_PX = 7;
const DEFAULT_LINE_HEIGHT_PX = 19;

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Whitespace that offers a wrap opportunity. `\n` is handled separately. */
function isWrapOpportunity(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\f' || char === '\v';
}

/**
 * Left-to-right greedy wrap. Honours explicit `\n`, hard-breaks tokens wider than a
 * line (the card text area wraps with `overflow-wrap: anywhere`), and returns at
 * least 1 for the empty string.
 *
 * The scan's whole state is `{ completedLines, usedWidth, pendingTokenWidth }` and
 * `completedLines` is only ever incremented, which is what makes the result monotone
 * in the length of `text`.
 */
export function measureLineCount(text: string, metrics: WrapMetrics): number {
  const charWidthPx = positiveOr(metrics.charWidthPx, DEFAULT_CHAR_WIDTH_PX);
  const availableWidthPx = positiveOr(metrics.availableWidthPx, charWidthPx);

  // Work in whole characters so every width is a multiple of `charWidthPx`.
  const charsPerLine = Math.max(1, Math.floor(availableWidthPx / charWidthPx));
  const lineCapacityPx = charsPerLine * charWidthPx;

  let completedLines = 0;
  let usedWidth = 0;
  let pendingTokenWidth = 0;

  for (const char of text) {
    if (char === '\r') {
      // Textarea values are newline-normalised; a stray CR occupies no space.
      continue;
    }

    if (char === '\n') {
      // The pending token lands on a fresh line when it no longer fits, then the
      // explicit break terminates whichever line it ended up on.
      if (pendingTokenWidth > 0 && usedWidth > 0 && usedWidth + pendingTokenWidth > lineCapacityPx) {
        completedLines += 1;
      }
      completedLines += 1;
      usedWidth = 0;
      pendingTokenWidth = 0;
      continue;
    }

    if (isWrapOpportunity(char)) {
      if (pendingTokenWidth > 0) {
        if (usedWidth > 0 && usedWidth + pendingTokenWidth > lineCapacityPx) {
          completedLines += 1;
          usedWidth = 0;
        }
        usedWidth += pendingTokenWidth;
        pendingTokenWidth = 0;
      }

      // A separator at the end of a line hangs rather than forcing a break, but it
      // still counts towards the line, so the next token wraps. Saturating keeps the
      // state bounded for long separator runs.
      usedWidth = Math.min(usedWidth + charWidthPx, lineCapacityPx);
      continue;
    }

    pendingTokenWidth += charWidthPx;

    // A token wider than one whole line cannot be placed by wrapping, so it is
    // broken: the current line is closed, one full line is consumed by the token,
    // and the remainder keeps accumulating.
    while (pendingTokenWidth > lineCapacityPx) {
      if (usedWidth > 0) {
        completedLines += 1;
        usedWidth = 0;
      }
      completedLines += 1;
      pendingTokenWidth -= lineCapacityPx;
    }
  }

  // The final token is never closed by a separator, so place it here. The condition
  // is the same one every separator applies, and `pendingTokenWidth` only grows as
  // the scan continues, so a longer text can never place this token any higher.
  if (pendingTokenWidth > 0 && usedWidth > 0 && usedWidth + pendingTokenWidth > lineCapacityPx) {
    completedLines += 1;
  }

  // The line currently under construction is always rendered, empty text included.
  return completedLines + 1;
}

/**
 * Clamp a line count to the range the configured mode allows: `(3, 12)` when fluid,
 * `(4, 4)` otherwise. Independent of the column layout (R6.14).
 */
export function clampLines(lineCount: number, fluid: boolean): number {
  const minLines = fluid ? FLUID_MIN_LINES : FIXED_LINES;
  const maxLines = fluid ? FLUID_MAX_LINES : FIXED_LINES;

  if (!Number.isFinite(lineCount)) {
    return minLines;
  }

  // The DOM-derived count carries float noise; rounding is monotone, so it cannot
  // break prefix monotonicity.
  const lines = Math.max(0, Math.round(lineCount));
  return Math.min(maxLines, Math.max(minLines, lines));
}

/** `clamp(lines) * lineHeight + padding`. */
export function computeTextAreaHeightPx(lineCount: number, metrics: HeightMetrics): number {
  const lineHeightPx = positiveOr(metrics.lineHeightPx, DEFAULT_LINE_HEIGHT_PX);
  const verticalPaddingPx = Number.isFinite(metrics.verticalPaddingPx)
    ? Math.max(0, metrics.verticalPaddingPx)
    : 0;

  return clampLines(lineCount, metrics.fluid) * lineHeightPx + verticalPaddingPx;
}

/**
 * Composition used by the component's DOM-free fallback, by the screenshot clone and
 * by the property tests.
 */
export function cardTextAreaHeightPx(
  text: string,
  wrap: WrapMetrics,
  height: HeightMetrics,
): number {
  return computeTextAreaHeightPx(measureLineCount(text, wrap), height);
}
