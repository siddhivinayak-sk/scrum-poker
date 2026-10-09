/**
 * Pure helpers for the issue list title layout (Stream 2, R2).
 *
 * The client test runner performs no layout, so the overflow rule of R2.3 is
 * expressed here as a box-model calculation rather than read back from
 * `scrollWidth` / `clientWidth`. Keeping these functions free of Angular and of
 * DOM access makes them reachable from property tests.
 */

/** Rendered in place of an empty or whitespace-only stored title (R2.10). */
export const ISSUE_TITLE_PLACEHOLDER = '(untitled issue)';

/**
 * The title element declares `min-width: 0`, so it may shrink below its content
 * width and never forces the row wider than the panel content box.
 */
export const TITLE_MIN_WIDTH_PX = 0;

/** Number of flex gaps in a row: status marker | title | action slot. */
export const ISSUE_ROW_GAP_COUNT = 2;

/**
 * Box model of one issue list row, mirroring the CSS declarations on
 * `.issue-list-panel__item` and its three children. All widths are pixels.
 */
export interface IssueRowLayoutModel {
  /** Content-box width available inside the panel. */
  readonly panelContentWidth: number;
  /** Width of the fixed status marker (`min-width: 1rem; flex: 0 0 auto`). */
  readonly statusWidth: number;
  /** Width of the fixed action slot (`flex: 0 0 5.5rem`), R2.13. */
  readonly actionWidth: number;
  /** Flex `gap` between adjacent row children. */
  readonly gap: number;
  /** Always 0: the title declares `min-width: 0`. */
  readonly titleMinWidth: 0;
  /**
   * Width of the longest run of characters carrying no whitespace. Recorded for
   * completeness; `overflow-wrap: anywhere` breaks such a run, so it never
   * contributes to the row's minimum width (R2.5).
   */
  readonly longestUnbreakableTokenWidth: number;
}

function isBlank(title: string): boolean {
  return title.trim().length === 0;
}

/**
 * Visible text for the title element: the stored value, or the placeholder when
 * the stored value is empty or whitespace only (R2.10). Never truncated here —
 * the two-line clamp is applied by CSS.
 */
export function issueTitleText(title: string): string {
  return isBlank(title) ? ISSUE_TITLE_PLACEHOLDER : title;
}

/**
 * Accessible name for the title element, used as both `title` and `aria-label`.
 * Carries every character of the stored value with no truncation marker added
 * (R2.2), or the placeholder when the stored value is blank (R2.10).
 */
export function issueTitleAccessibleName(title: string): string {
  return isBlank(title) ? ISSUE_TITLE_PLACEHOLDER : title;
}

/**
 * Minimum width the row occupies once the title has shrunk as far as its
 * `min-width` allows: the two fixed children plus the flex gaps.
 */
export function issueRowMinWidth(model: IssueRowLayoutModel): number {
  return (
    model.statusWidth +
    model.actionWidth +
    model.gap * ISSUE_ROW_GAP_COUNT +
    model.titleMinWidth
  );
}

/**
 * Does the row force the panel to scroll horizontally (R2.3)?
 *
 * Because the title declares `min-width: 0` and `overflow-wrap: anywhere`,
 * neither the title length nor an unbreakable token widens the row: the title
 * shrinks and its content breaks. The row therefore overflows only when the two
 * fixed children and the gaps alone exceed the panel content width.
 */
export function issueRowOverflows(model: IssueRowLayoutModel): boolean {
  return issueRowMinWidth(model) > model.panelContentWidth;
}

/**
 * Inline offset of the action slot's left edge from the row's left edge. Equal
 * for every row of a panel because the slot width is fixed and the title takes
 * the remainder (R2.13).
 */
export function issueActionSlotOffset(model: IssueRowLayoutModel): number {
  return Math.max(model.panelContentWidth - model.actionWidth, 0);
}
