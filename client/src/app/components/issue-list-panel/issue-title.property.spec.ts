import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ISSUE_ROW_GAP_COUNT,
  ISSUE_TITLE_PLACEHOLDER,
  IssueRowLayoutModel,
  TITLE_MIN_WIDTH_PX,
  issueActionSlotOffset,
  issueRowMinWidth,
  issueRowOverflows,
  issueTitleAccessibleName,
  issueTitleText,
} from './issue-title';

/**
 * Property 5: Issue row never overflows its panel.
 *
 * Exercises the pure units of `issue-title.ts` — `issueRowOverflows`,
 * `issueTitleText`, `issueTitleAccessibleName` — across the generated panel
 * states R14.14 calls for: title lengths 0 through 500 characters including
 * titles holding no whitespace character, 0 through 200 entries, and viewport
 * widths 360 through 1920 pixels.
 *
 * **Validates: Requirements 2.2, 2.3, 2.5, 2.9, 2.10, 2.13, 14.14**
 */

// --- Declared layout values, mirroring the component styles ---

/** `.issue-list-panel__item-status` — `min-width: 1rem`. */
const STATUS_WIDTH_PX = 16;

/** `.issue-list-panel__item-action` — `flex: 0 0 5.5rem` (R2.13). */
const ACTION_WIDTH_PX = 88;

/** `.issue-list-panel__item` — `gap: 0.5rem`. */
const ROW_GAP_PX = 8;

/** `.issue-list-panel` — `padding: 0.75rem` on both inline edges. */
const PANEL_INLINE_PADDING_PX = 24;

/** `.session-poker-page__accordion-content` — `padding: 0.25rem` both edges. */
const ACCORDION_INLINE_PADDING_PX = 8;

/** `.session-poker-page__sidebar--desktop` — `width: 280px`. */
const DESKTOP_SIDEBAR_WIDTH_PX = 280;

/** `.session-poker-page__sidebar-overlay` — `max-width: 480px`, `width: 100%`. */
const MOBILE_OVERLAY_MAX_WIDTH_PX = 480;

/** `.session-poker-page__sidebar-overlay` — `padding: 0.75rem 1rem`. */
const MOBILE_OVERLAY_INLINE_PADDING_PX = 32;

/** `@media (max-width: 767px)` — the desktop sidebar is replaced by the overlay. */
const MOBILE_BREAKPOINT_PX = 768;

/** Advance width of one character at the title's `font-size: 0.8125rem`. */
const CHAR_WIDTH_PX = 7.5;

/**
 * Panel content-box width at a viewport width, derived from the declared
 * layout values above: a fixed-width sidebar from the mobile breakpoint up, the
 * full-width capped overlay below it.
 */
function panelContentWidthForViewport(viewportWidth: number): number {
  if (viewportWidth >= MOBILE_BREAKPOINT_PX) {
    return (
      DESKTOP_SIDEBAR_WIDTH_PX - ACCORDION_INLINE_PADDING_PX - PANEL_INLINE_PADDING_PX
    );
  }
  return (
    Math.min(viewportWidth, MOBILE_OVERLAY_MAX_WIDTH_PX) -
    MOBILE_OVERLAY_INLINE_PADDING_PX -
    PANEL_INLINE_PADDING_PX
  );
}

/** Width of the longest whitespace-free run of a title, in pixels. */
function longestUnbreakableTokenWidth(title: string): number {
  const longestRun = title
    .split(/\s+/)
    .reduce((longest, token) => Math.max(longest, token.length), 0);
  return longestRun * CHAR_WIDTH_PX;
}

function buildRowModel(title: string, panelContentWidth: number): IssueRowLayoutModel {
  return {
    panelContentWidth,
    statusWidth: STATUS_WIDTH_PX,
    actionWidth: ACTION_WIDTH_PX,
    gap: ROW_GAP_PX,
    titleMinWidth: TITLE_MIN_WIDTH_PX as 0,
    longestUnbreakableTokenWidth: longestUnbreakableTokenWidth(title),
  };
}

// --- Generators ---

const NON_WHITESPACE_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_/.,;:!?()[]{}#@&%+=*"\'\\|<>~^$€émöüß日本語';

const WHITESPACE_CHARS = [' ', '\t', '\n', '\r'];

/** Stated bounds of the generated space (R14.14). */
const MAX_TITLE_LENGTH = 500;
const MAX_ISSUE_COUNT = 200;

/**
 * Every length-bounded generator below passes `size: 'max'`. Without it
 * fast-check's default sizing caps a generated array or string near ten
 * entries whatever `maxLength` says, so the 500-character titles and the
 * 200-entry panels R14.14 states would never be generated and the overflow
 * invariant would pass without ever meeting a long unbreakable title.
 */

/** Arbitrary title text, 0–500 characters. */
const mixedTitle = fc.string({ minLength: 0, maxLength: MAX_TITLE_LENGTH, size: 'max' });

/** A title holding no whitespace character at all (R2.5), 1–500 characters. */
const noWhitespaceTitle = fc
  .array(fc.constantFrom(...NON_WHITESPACE_CHARS.split('')), {
    minLength: 1,
    maxLength: MAX_TITLE_LENGTH,
    size: 'max',
  })
  .map((chars) => chars.join(''));

/** A title made only of whitespace characters (R2.10), 1–500 characters. */
const whitespaceOnlyTitle = fc
  .array(fc.constantFrom(...WHITESPACE_CHARS), {
    minLength: 1,
    maxLength: MAX_TITLE_LENGTH,
    size: 'max',
  })
  .map((chars) => chars.join(''));

/** The empty title (R2.10). */
const emptyTitle = fc.constant('');

const anyTitle = fc.oneof(
  { arbitrary: mixedTitle, weight: 4 },
  { arbitrary: noWhitespaceTitle, weight: 3 },
  { arbitrary: whitespaceOnlyTitle, weight: 2 },
  { arbitrary: emptyTitle, weight: 1 },
);

/** 0–200 Issue_Item entries (R2.3, R14.14). */
const titleList = fc.array(anyTitle, { minLength: 0, maxLength: MAX_ISSUE_COUNT, size: 'max' });

/** Viewport widths 360–1920 pixels (R2.3, R14.14). */
const viewportWidth = fc.integer({ min: 360, max: 1920 });

const panelState = fc.record({ titles: titleList, viewportWidth });

const NUM_RUNS = 100;

/** Widest generated panel state the properties actually saw (coverage guard). */
let widestTitleLength = 0;
let widestTitleList = 0;

describe('Property 5: issue row never overflows its panel', () => {
  it('R2.3: reports no row overflow for any title length, entry count and viewport width', () => {
    fc.assert(
      fc.property(panelState, ({ titles, viewportWidth: width }) => {
        const panelContentWidth = panelContentWidthForViewport(width);
        widestTitleList = Math.max(widestTitleList, titles.length);

        for (const title of titles) {
          widestTitleLength = Math.max(widestTitleLength, title.length);
          const model = buildRowModel(title, panelContentWidth);
          expect(issueRowOverflows(model)).toBe(false);
          expect(issueRowMinWidth(model)).toBeLessThanOrEqual(model.panelContentWidth);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('R2.5: a title with no whitespace character does not widen the row beyond the panel', () => {
    fc.assert(
      fc.property(
        noWhitespaceTitle,
        viewportWidth,
        (title, width) => {
          const panelContentWidth = panelContentWidthForViewport(width);
          const model = buildRowModel(title, panelContentWidth);

          // The unbreakable run may be far wider than the panel, yet
          // `overflow-wrap: anywhere` plus `min-width: 0` keep the row inside
          // the panel content box.
          expect(model.longestUnbreakableTokenWidth).toBeGreaterThan(0);
          expect(issueRowOverflows(model)).toBe(false);

          const widerToken: IssueRowLayoutModel = {
            ...model,
            longestUnbreakableTokenWidth:
              model.longestUnbreakableTokenWidth + panelContentWidth * 10,
          };
          expect(issueRowOverflows(widerToken)).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('R2.13: the action slot offset is identical across every row of a panel', () => {
    fc.assert(
      fc.property(panelState, ({ titles, viewportWidth: width }) => {
        const panelContentWidth = panelContentWidthForViewport(width);
        const offsets = new Set(
          titles.map((title) =>
            issueActionSlotOffset(buildRowModel(title, panelContentWidth)),
          ),
        );

        expect(offsets.size).toBeLessThanOrEqual(1);
        if (offsets.size === 1) {
          expect([...offsets][0]).toBe(
            issueActionSlotOffset(buildRowModel('', panelContentWidth)),
          );
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('R2.2, R2.9: the accessible name carries the stored title exactly, with no truncation marker added', () => {
    fc.assert(
      fc.property(fc.oneof(mixedTitle, noWhitespaceTitle), (title) => {
        const name = issueTitleAccessibleName(title);

        if (title.trim().length === 0) {
          expect(name).toBe(ISSUE_TITLE_PLACEHOLDER);
          return;
        }

        expect(name).toBe(title);
        expect(name).toHaveLength(title.length);
        expect(issueTitleText(title)).toBe(title);
        // No truncation indicator is introduced by the helpers themselves.
        expect(name.endsWith('\u2026')).toBe(false);
        expect(name.endsWith('...')).toBe(title.endsWith('...'));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('R2.10: a blank stored title renders and announces the non-empty placeholder', () => {
    fc.assert(
      fc.property(fc.oneof(emptyTitle, whitespaceOnlyTitle), (title) => {
        expect(issueTitleText(title)).toBe(ISSUE_TITLE_PLACEHOLDER);
        expect(issueTitleAccessibleName(title)).toBe(ISSUE_TITLE_PLACEHOLDER);
        expect(ISSUE_TITLE_PLACEHOLDER.trim().length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('R2.3: the visible text and the accessible name agree for every generated title', () => {
    fc.assert(
      fc.property(anyTitle, (title) => {
        expect(issueTitleText(title)).toBe(issueTitleAccessibleName(title));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('R2.3: the row minimum width is the fixed children plus the gaps only', () => {
    fc.assert(
      fc.property(anyTitle, viewportWidth, (title, width) => {
        const model = buildRowModel(title, panelContentWidthForViewport(width));

        expect(issueRowMinWidth(model)).toBe(
          STATUS_WIDTH_PX + ACTION_WIDTH_PX + ROW_GAP_PX * ISSUE_ROW_GAP_COUNT,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('R14.14: the panel state generator actually reaches its stated title length and entry count bounds', () => {
    // A coverage guard over the overflow run above, so a future return to
    // fast-check's default sizing fails here instead of quietly shrinking the
    // generated panel to a handful of short titles.
    expect(widestTitleLength).toBeGreaterThanOrEqual(450);
    expect(widestTitleLength).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(widestTitleList).toBeGreaterThanOrEqual(180);
    expect(widestTitleList).toBeLessThanOrEqual(MAX_ISSUE_COUNT);
  });
});
