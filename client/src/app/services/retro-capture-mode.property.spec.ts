import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { TestBed } from '@angular/core/testing';
import { ColumnLayout } from '@shared/types';
import { computeTextAreaHeightPx, measureLineCount } from './retro-card-height';
import {
  CAPTURE_CLONE_CLASS,
  CAPTURE_ROOT_ATTRIBUTE,
  CARD_TEXT_SELECTOR,
  SCROLL_CONTAINER_SELECTORS,
  captureTextStyle,
  enterCaptureMode,
} from './retro-capture-mode';
import { CAPTURE_TIMEOUT_MS, RetroScreenshotService } from './retro-screenshot.service';
import { ToastService } from './toast.service';

// The service reaches html2canvas through a dynamic import, so the module is
// mocked and the three capture outcomes are driven through the real service.
vi.mock('html2canvas', () => ({ default: vi.fn() }));

/**
 * Properties 12 and 13 for the transient capture-mode DOM substitution
 * (design Stream 5).
 *
 * Both properties build a real retro board — 0–10 columns holding 0–100 cards,
 * card texts 0–2,000 characters, either column layout, either `fluidCardHeight`
 * value — enter capture mode over it and inspect the result.
 *
 * The test DOM performs no layout, so two things are supplied that a browser
 * would compute and three things are observed that a browser would render:
 *
 * - supplied: each card text area carries its typography as inline declarations
 *   (which `getComputedStyle` then reports verbatim) and an own `clientWidth`
 *   equal to its border-box width, so the module sees the generated card content
 *   width of 160–400 px rather than the environment's zero;
 * - observed: element count, attribute values, inline style declarations and the
 *   recorded scroll offsets — never `getBoundingClientRect`, which reports
 *   zeroes here.
 *
 * Scroll offsets are seeded non-zero on the three scroll containers and then
 * collapsed to zero while the capture is in flight, which is what a browser does
 * when `overflow` turns `visible`. Restoring therefore has to put the recorded
 * values back rather than merely leave them untouched.
 */

/** Upper bound on generated card text length (Property 12 generators). */
const MAX_TEXT_LENGTH = 2000;

/** Card content width bounds (Property 13 generators). */
const MIN_CONTENT_WIDTH_PX = 160;
const MAX_CONTENT_WIDTH_PX = 400;

/** Board shape bounds (Property 12 generators). */
const MAX_COLUMNS = 10;
const MAX_CARDS_PER_COLUMN = 100;

/**
 * Average glyph advance as a fraction of the font size. Mirrors the private
 * constant `retro-capture-mode.ts` and `RetroCardComponent` both use to wrap
 * text without a layout engine.
 */
const AVERAGE_CHAR_WIDTH_RATIO = 0.5;

/** Which of the three capture outcomes a run drives through the service. */
type Outcome = 'success' | 'throw' | 'timeout';

const OUTCOMES: readonly Outcome[] = ['success', 'throw', 'timeout'];

/** One generated card: its text plus the typography the browser would resolve. */
interface GeneratedCard {
  text: string;
  /** Content box width in CSS pixels, 160–400 (Property 13). */
  contentWidthPx: number;
  fontFamily: string;
  fontSizePx: number;
  lineHeightPx: number;
  color: [number, number, number];
  paddingTopPx: number;
  paddingRightPx: number;
  paddingBottomPx: number;
  paddingLeftPx: number;
  /** Non-zero seeds, so a lost restore is visible. */
  scrollTop: number;
  scrollLeft: number;
}

/** One generated board. */
interface GeneratedBoard {
  columns: GeneratedCard[][];
  layout: ColumnLayout;
  /** The `fluidCardHeight` setting the card heights were laid out with. */
  fluid: boolean;
  /** Whether the scroll containers carry `overflow`/`max-height` inline. */
  inlineScrollStyles: boolean;
  columnsScrollTop: number;
  columnsScrollLeft: number;
  cardsScrollTop: number;
}

const WORD_CHARS = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ...'-_/.,:;!?()[]{}#@&%',
  ...'äöüéßµ…✓→',
];

/** An ordinary word. `size: 'max'` so the 24-character bound is reachable. */
const wordArb = fc
  .array(fc.constantFrom(...WORD_CHARS), { minLength: 1, maxLength: 24, size: 'max' })
  .map((chars) => chars.join(''));

/** A token no card content width can fit on one line, so the wrap hard-breaks it. */
const oversizedTokenArb = fc
  .array(fc.constantFrom(...WORD_CHARS), { minLength: 120, maxLength: 240, size: 'max' })
  .map((chars) => chars.join(''));

const separatorArb = fc.constantFrom(' ', '  ', '\t');

/** Explicit single breaks and consecutive breaks that render as empty lines. */
const lineBreakArb = fc.constantFrom('\n', '\n\n', '\n\n\n');

const fragmentArb = fc.oneof(
  { weight: 6, arbitrary: wordArb },
  { weight: 3, arbitrary: separatorArb },
  { weight: 3, arbitrary: lineBreakArb },
  { weight: 1, arbitrary: oversizedTokenArb },
);

/**
 * Card text, 0 through 2,000 characters.
 *
 * Long texts are the expensive arm — they are the ones the live text area clips
 * and scrolls, so they stay in the space, but at a lower weight than the short
 * texts that dominate a real board. `size: 'max'` on every array keeps the
 * lengths from collapsing to the default 10-entry cap; the coverage assertions
 * after each `fc.assert` fail loudly if they do anyway.
 */
const textArb: fc.Arbitrary<string> = fc
  .oneof(
    { weight: 1, arbitrary: fc.constant('') },
    {
      weight: 6,
      arbitrary: fc.array(fragmentArb, { maxLength: 12, size: 'max' }).map((parts) => parts.join('')),
    },
    {
      weight: 2,
      arbitrary: fc.array(fragmentArb, { maxLength: 120, size: 'max' }).map((parts) => parts.join('')),
    },
    { weight: 1, arbitrary: fc.string({ maxLength: 400, size: 'max' }).map((raw) => raw.replace(/\r/g, '')) },
  )
  .map((text) => text.slice(0, MAX_TEXT_LENGTH));

const cardArb: fc.Arbitrary<GeneratedCard> = fc.record({
  text: textArb,
  contentWidthPx: fc.integer({ min: MIN_CONTENT_WIDTH_PX, max: MAX_CONTENT_WIDTH_PX }),
  fontFamily: fc.constantFrom(
    'Inter, sans-serif',
    'Segoe UI, Arial, sans-serif',
    'Roboto, Helvetica, sans-serif',
  ),
  fontSizePx: fc.integer({ min: 11, max: 18 }),
  lineHeightPx: fc.integer({ min: 14, max: 30 }),
  color: fc.tuple(
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
  ),
  paddingTopPx: fc.integer({ min: 0, max: 12 }),
  paddingRightPx: fc.integer({ min: 0, max: 12 }),
  paddingBottomPx: fc.integer({ min: 0, max: 12 }),
  paddingLeftPx: fc.integer({ min: 0, max: 12 }),
  scrollTop: fc.integer({ min: 1, max: 480 }),
  scrollLeft: fc.integer({ min: 1, max: 240 }),
});

/**
 * Columns holding 0–100 cards each. The two degenerate arms make the R4.7 cases
 * — a board with no columns and columns with no cards — certain rather than
 * merely likely.
 */
const columnsArb: fc.Arbitrary<GeneratedCard[][]> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<GeneratedCard[][]>([]) },
  {
    weight: 1,
    arbitrary: fc.array(fc.constant<GeneratedCard[]>([]), {
      minLength: 1,
      maxLength: MAX_COLUMNS,
      size: 'max',
    }),
  },
  {
    weight: 8,
    arbitrary: fc.array(
      fc.array(cardArb, { maxLength: MAX_CARDS_PER_COLUMN, size: 'max' }),
      { maxLength: MAX_COLUMNS, size: 'max' },
    ),
  },
);

const boardArb: fc.Arbitrary<GeneratedBoard> = fc.record({
  columns: columnsArb,
  layout: fc.constantFrom<ColumnLayout>('vertical', 'horizontal'),
  fluid: fc.boolean(),
  inlineScrollStyles: fc.boolean(),
  columnsScrollTop: fc.integer({ min: 1, max: 600 }),
  columnsScrollLeft: fc.integer({ min: 1, max: 600 }),
  cardsScrollTop: fc.integer({ min: 1, max: 600 }),
});

/** Border-box width of a card text area: content width plus its inline padding. */
function elementWidthPx(card: GeneratedCard): number {
  return card.contentWidthPx + card.paddingLeftPx + card.paddingRightPx;
}

function colorDeclaration(card: GeneratedCard): string {
  const [red, green, blue] = card.color;
  return `rgb(${red}, ${green}, ${blue})`;
}

/** Height the live card text area was laid out at, clamp included. */
function liveHeightPx(card: GeneratedCard, fluid: boolean): number {
  const lineCount = measureLineCount(card.text, {
    availableWidthPx: card.contentWidthPx,
    charWidthPx: card.fontSizePx * AVERAGE_CHAR_WIDTH_RATIO,
  });
  return computeTextAreaHeightPx(lineCount, {
    lineHeightPx: card.lineHeightPx,
    verticalPaddingPx: card.paddingTopPx + card.paddingBottomPx,
    fluid,
  });
}

/**
 * Height the clone needs for every wrapped line: the wrap's line count at the
 * card content width, times the line height, plus the vertical padding — the
 * same quantity unclamped, because a clamped clone would scroll and clip.
 */
function requiredCloneHeightPx(card: GeneratedCard): number {
  const lineCount = measureLineCount(card.text, {
    availableWidthPx: card.contentWidthPx,
    charWidthPx: card.fontSizePx * AVERAGE_CHAR_WIDTH_RATIO,
  });
  return lineCount * card.lineHeightPx + card.paddingTopPx + card.paddingBottomPx;
}

function parsePx(raw: string): number {
  return Number.parseFloat(raw);
}

function setInlineStyles(element: HTMLElement, declarations: Record<string, string>): void {
  for (const [property, value] of Object.entries(declarations)) {
    element.style.setProperty(property, value);
  }
}

/** The card text area, carrying the typography a browser would have computed. */
function buildCard(card: GeneratedCard, fluid: boolean): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'retro-card';

  const textArea = document.createElement('textarea');
  textArea.className = 'retro-card__text';
  // Seeded through the style API, the way the component binds them: the
  // `style` attribute is then already in the DOM's own serialised form, so a
  // later property write cannot change the string by re-serialising it.
  setInlineStyles(textArea, {
    'font-family': card.fontFamily,
    'font-size': `${card.fontSizePx}px`,
    'line-height': `${card.lineHeightPx}px`,
    color: colorDeclaration(card),
    padding: `${card.paddingTopPx}px ${card.paddingRightPx}px ${card.paddingBottomPx}px ${card.paddingLeftPx}px`,
    width: `${elementWidthPx(card)}px`,
    'box-sizing': 'border-box',
    height: `${liveHeightPx(card, fluid)}px`,
    'overflow-y': 'auto',
  });
  textArea.value = card.text;
  // The environment lays nothing out, so the content width the module reads has
  // to be supplied: `clientWidth - inlinePadding` must land on `contentWidthPx`.
  Object.defineProperty(textArea, 'clientWidth', {
    value: elementWidthPx(card),
    configurable: true,
  });
  textArea.scrollTop = card.scrollTop;
  textArea.scrollLeft = card.scrollLeft;

  const author = document.createElement('div');
  author.className = 'retro-card__author';
  author.textContent = 'Anonymous';

  wrapper.appendChild(textArea);
  wrapper.appendChild(author);
  return wrapper;
}

/** Builds the board DOM and attaches it, so computed styles resolve. */
function buildBoard(board: GeneratedBoard): HTMLElement {
  const root = document.createElement('div');
  root.className = 'retro-board';
  root.setAttribute('data-column-layout', board.layout);
  root.setAttribute('data-fluid-card-height', String(board.fluid));

  const columnsContainer = document.createElement('div');
  columnsContainer.className =
    board.layout === 'horizontal'
      ? 'retro-board__columns retro-board__columns--horizontal'
      : 'retro-board__columns';
  if (board.inlineScrollStyles) {
    setInlineStyles(columnsContainer, {
      overflow: 'auto',
      'max-height': '720px',
      height: '720px',
    });
  }
  columnsContainer.scrollTop = board.columnsScrollTop;
  columnsContainer.scrollLeft = board.columnsScrollLeft;

  board.columns.forEach((cards, columnIndex) => {
    const column = document.createElement('div');
    column.className = 'retro-column';
    column.setAttribute('data-column-id', `column-${columnIndex}`);

    const header = document.createElement('div');
    header.className = 'retro-column__header';
    header.textContent = `Column ${columnIndex} (${cards.length})`;

    const cardsContainer = document.createElement('div');
    cardsContainer.className = 'retro-column__cards';
    if (board.inlineScrollStyles) {
      setInlineStyles(cardsContainer, { 'overflow-y': 'auto', 'max-height': '480px' });
    }
    for (const card of cards) {
      cardsContainer.appendChild(buildCard(card, board.fluid));
    }
    cardsContainer.scrollTop = board.cardsScrollTop + columnIndex;
    cardsContainer.scrollLeft = 0;

    column.appendChild(header);
    column.appendChild(cardsContainer);
    columnsContainer.appendChild(column);
  });

  root.appendChild(columnsContainer);
  document.body.appendChild(root);

  // Read by the renderer to size the capture; no layout exists to supply them.
  Object.defineProperty(root, 'scrollWidth', { value: 1200, configurable: true });
  Object.defineProperty(root, 'scrollHeight', { value: 900, configurable: true });

  return root;
}

/** One element's observable state. */
interface ElementSnapshot {
  path: string;
  tag: string;
  attributes: Array<[string, string]>;
  inlineStyle: Array<[string, string]>;
  scrollTop: number;
  scrollLeft: number;
  value: string | null;
}

function attributeEntries(element: Element): Array<[string, string]> {
  return Array.from(element.attributes)
    .map((attribute): [string, string] => [attribute.name, attribute.value])
    .sort(([left], [right]) => left.localeCompare(right));
}

function inlineStyleEntries(element: HTMLElement): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (let index = 0; index < element.style.length; index += 1) {
    const property = element.style.item(index);
    entries.push([property, element.style.getPropertyValue(property)]);
  }
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

/**
 * Structural snapshot of `root` and every descendant, in document order.
 *
 * Covers exactly what is observable without layout: the element count (the
 * array length), every attribute name and value, every inline style declaration
 * and the recorded scroll offsets. Text area values ride along so a substitution
 * that ate the card text would show up too.
 */
function snapshot(root: HTMLElement): ElementSnapshot[] {
  const snapshots: ElementSnapshot[] = [];

  const walk = (element: HTMLElement, path: string): void => {
    snapshots.push({
      path,
      tag: element.tagName,
      attributes: attributeEntries(element),
      inlineStyle: inlineStyleEntries(element),
      scrollTop: element.scrollTop,
      scrollLeft: element.scrollLeft,
      value: element instanceof HTMLTextAreaElement ? element.value : null,
    });
    Array.from(element.children).forEach((child, index) => {
      if (child instanceof HTMLElement) {
        walk(child, `${path}/${index}:${child.tagName}`);
      }
    });
  };

  walk(root, '');
  return snapshots;
}

/**
 * Collapses the scroll offsets of every unclipped container to zero, as a
 * browser does once `overflow` turns `visible`. Run while the capture is in
 * flight, so `restore()` has to reinstate the recorded offsets.
 */
function collapseScrollOffsets(root: HTMLElement): void {
  const selector = SCROLL_CONTAINER_SELECTORS.join(', ');
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    element.scrollTop = 0;
    element.scrollLeft = 0;
  }
  if (root.matches(selector)) {
    root.scrollTop = 0;
    root.scrollLeft = 0;
  }
}

/** Every generated card of a board, in document order. */
function allCards(board: GeneratedBoard): GeneratedCard[] {
  return board.columns.flat();
}

/** Accumulates what the generators actually produced across an `fc.assert`. */
class Coverage {
  maxColumns = 0;
  minColumns = Number.POSITIVE_INFINITY;
  maxCardsInColumn = 0;
  maxCardsOnBoard = 0;
  minCardsOnBoard = Number.POSITIVE_INFINITY;
  maxTextLength = 0;
  minTextLength = Number.POSITIVE_INFINITY;
  maxContentWidth = 0;
  minContentWidth = Number.POSITIVE_INFINITY;
  readonly layouts = new Set<ColumnLayout>();
  readonly fluidValues = new Set<boolean>();
  readonly outcomes = new Set<Outcome>();

  record(board: GeneratedBoard, outcome?: Outcome): void {
    const cards = allCards(board);
    this.maxColumns = Math.max(this.maxColumns, board.columns.length);
    this.minColumns = Math.min(this.minColumns, board.columns.length);
    this.maxCardsInColumn = Math.max(
      this.maxCardsInColumn,
      ...board.columns.map((column) => column.length),
      0,
    );
    this.maxCardsOnBoard = Math.max(this.maxCardsOnBoard, cards.length);
    this.minCardsOnBoard = Math.min(this.minCardsOnBoard, cards.length);
    this.layouts.add(board.layout);
    this.fluidValues.add(board.fluid);
    if (outcome) {
      this.outcomes.add(outcome);
    }
    for (const card of cards) {
      this.maxTextLength = Math.max(this.maxTextLength, card.text.length);
      this.minTextLength = Math.min(this.minTextLength, card.text.length);
      this.maxContentWidth = Math.max(this.maxContentWidth, card.contentWidthPx);
      this.minContentWidth = Math.min(this.minContentWidth, card.contentWidthPx);
    }
  }
}

/**
 * Fails when a generator collapsed — `fc.array` silently caps at 10 entries
 * without `size: 'max'`, which would quietly shrink the board space to a
 * fraction of the one the property is stated over.
 */
function assertBoardCoverage(coverage: Coverage): void {
  expect(coverage.minColumns).toBe(0);
  expect(coverage.maxColumns).toBeGreaterThanOrEqual(8);
  expect(coverage.maxCardsInColumn).toBeGreaterThanOrEqual(40);
  expect(coverage.minCardsOnBoard).toBe(0);
  expect(coverage.maxCardsOnBoard).toBeGreaterThanOrEqual(40);
  expect(coverage.minTextLength).toBe(0);
  expect(coverage.maxTextLength).toBeGreaterThanOrEqual(1000);
  expect(coverage.maxTextLength).toBeLessThanOrEqual(MAX_TEXT_LENGTH);
  expect(coverage.minContentWidth).toBeLessThanOrEqual(200);
  expect(coverage.maxContentWidth).toBeGreaterThanOrEqual(360);
  expect([...coverage.layouts].sort()).toEqual(['horizontal', 'vertical']);
  expect(coverage.fluidValues.size).toBe(2);
}

/**
 * Property 12: Capture mode is restored exactly
 *
 * For any board — 0–10 columns holding 0–100 cards each, either column layout,
 * either `fluidCardHeight` value, texts 0–2,000 characters — entering capture
 * mode and then restoring returns the element count, every element's attribute
 * set, every inline style and the scroll offsets of the column container and of
 * every card text area to their pre-capture values, whether the capture
 * succeeded, threw, or timed out.
 *
 * **Validates: Requirements 4.3, 4.7**
 */
describe('Property 12: Capture mode is restored exactly', () => {
  const PNG_BYTES = 'fake-png-bytes';

  let service: RetroScreenshotService;
  let html2canvasMock: ReturnType<typeof vi.fn>;
  let toastService: { show: ReturnType<typeof vi.fn> };
  let originalClipboard: PropertyDescriptor | undefined;

  function canvasYieldingPng(): HTMLCanvasElement {
    const blob = new Blob([PNG_BYTES], { type: 'image/png' });
    return {
      toBlob: (callback: (value: Blob | null) => void) => callback(blob),
    } as unknown as HTMLCanvasElement;
  }

  beforeEach(async () => {
    toastService = { show: vi.fn() };
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

    vi.stubGlobal(
      'ClipboardItem',
      class StubClipboardItem {
        constructor(public readonly items: Record<string, Blob>) {}
      },
    );
    // The success path copies rather than downloads, so no anchor is clicked.
    Object.defineProperty(navigator, 'clipboard', {
      value: { write: () => Promise.resolve() },
      writable: true,
      configurable: true,
    });

    TestBed.configureTestingModule({
      providers: [RetroScreenshotService, { provide: ToastService, useValue: toastService }],
    });
    service = TestBed.inject(RetroScreenshotService);

    const module = await import('html2canvas');
    html2canvasMock = module.default as unknown as ReturnType<typeof vi.fn>;
    html2canvasMock.mockReset();

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    }
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  /**
   * Runs one capture with the given outcome and returns the before/after
   * snapshots. The mid-capture hook proves capture mode was actually entered,
   * so an equal pair cannot be the result of the capture never happening.
   */
  async function runCapture(
    board: GeneratedBoard,
    root: HTMLElement,
    outcome: Outcome,
  ): Promise<{ before: ElementSnapshot[]; after: ElementSnapshot[]; entered: boolean }> {
    const cardCount = allCards(board).length;
    let entered = false;

    html2canvasMock.mockImplementation((element: HTMLElement): Promise<HTMLCanvasElement> => {
      entered =
        element.getAttribute(CAPTURE_ROOT_ATTRIBUTE) === 'true' &&
        element.querySelectorAll(`.${CAPTURE_CLONE_CLASS}`).length === cardCount &&
        Array.from(element.querySelectorAll<HTMLElement>(CARD_TEXT_SELECTOR)).every(
          (textArea) => textArea.style.display === 'none',
        );
      collapseScrollOffsets(element);

      if (outcome === 'throw') {
        return Promise.reject(new Error('render failed'));
      }
      if (outcome === 'timeout') {
        return new Promise<HTMLCanvasElement>(() => {});
      }
      return Promise.resolve(canvasYieldingPng());
    });

    const before = snapshot(root);
    const capture = service.captureBoard(root);

    // html2canvas arrives through a dynamic import, so the render only starts
    // once that microtask chain has drained.
    for (let attempt = 0; attempt < 10 && html2canvasMock.mock.calls.length === 0; attempt += 1) {
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS);
    await capture;

    return { before, after: snapshot(root), entered };
  }

  it('R4.3/R4.7: returns the element count, attributes, inline styles and scroll offsets to their pre-capture values for every outcome', async () => {
    const coverage = new Coverage();

    await fc.assert(
      fc.asyncProperty(boardArb, fc.constantFrom(...OUTCOMES), async (board, outcome) => {
        coverage.record(board, outcome);
        const root = buildBoard(board);

        try {
          const { before, after, entered } = await runCapture(board, root, outcome);

          // The capture really ran over a board in capture mode.
          expect(html2canvasMock).toHaveBeenCalledTimes(1);
          expect(entered).toBe(true);

          // Element count, attribute values, inline declarations and the
          // recorded scroll offsets, all back where they started.
          expect(after).toHaveLength(before.length);
          expect(after).toEqual(before);

          // Nothing of capture mode is left behind, and the board is free for
          // the next capture.
          expect(root.hasAttribute(CAPTURE_ROOT_ATTRIBUTE)).toBe(false);
          expect(root.querySelectorAll(`.${CAPTURE_CLONE_CLASS}`)).toHaveLength(0);
          expect(service.capturing()).toBe(false);
        } finally {
          root.remove();
          html2canvasMock.mockReset();
          toastService.show.mockClear();
        }
      }),
      { numRuns: 100 },
    );

    assertBoardCoverage(coverage);
    expect([...coverage.outcomes].sort()).toEqual(['success', 'throw', 'timeout']);
  }, 180_000);

  it('R4.3: restores the same snapshot when `restore()` is called more than once', () => {
    const coverage = new Coverage();

    fc.assert(
      fc.property(boardArb, (board) => {
        coverage.record(board);
        const root = buildBoard(board);

        try {
          const cardCount = allCards(board).length;
          const before = snapshot(root);

          const handle = enterCaptureMode(root);
          expect(root.getAttribute(CAPTURE_ROOT_ATTRIBUTE)).toBe('true');
          expect(root.querySelectorAll(`.${CAPTURE_CLONE_CLASS}`)).toHaveLength(cardCount);
          collapseScrollOffsets(root);

          handle.restore();
          const afterFirst = snapshot(root);
          handle.restore();
          handle.restore();
          const afterThird = snapshot(root);

          expect(afterFirst).toEqual(before);
          expect(afterThird).toEqual(before);
        } finally {
          root.remove();
        }
      }),
      { numRuns: 100 },
    );

    assertBoardCoverage(coverage);
  }, 180_000);
});

/**
 * Property 13: Capture clone carries the complete text with the live typography
 *
 * For any board as in Property 12, the capture clones together contain the full
 * text of every card, including text the live text area clipped or scrolled and
 * cards outside the visible scroll area, each clone carries the live element's
 * font family, font size, line height and text colour unchanged, and each
 * clone's height is at least the height its wrapped line count requires at the
 * card content width.
 *
 * **Validates: Requirements 4.2, 4.11, 4.12, 4.13**
 */
describe('Property 13: Capture clone carries the complete text with the live typography', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('R4.2/R4.11/R4.12/R4.13: every clone holds the full card text, the copied typography and a height containing its wrapped lines', () => {
    const coverage = new Coverage();

    fc.assert(
      fc.property(boardArb, (board) => {
        coverage.record(board);
        const root = buildBoard(board);

        try {
          const cards = allCards(board);
          const handle = enterCaptureMode(root);

          const clones = Array.from(root.querySelectorAll<HTMLElement>(`.${CAPTURE_CLONE_CLASS}`));
          const textAreas = Array.from(
            root.querySelectorAll<HTMLTextAreaElement>(CARD_TEXT_SELECTOR),
          );

          // One clone per card, including the cards an ancestor scroll
          // container would have kept outside the visible area.
          expect(clones).toHaveLength(cards.length);
          expect(textAreas).toHaveLength(cards.length);

          // R4.2: the clones together carry the complete text of every card,
          // in board order, whatever the live control clipped or scrolled.
          expect(clones.map((clone) => clone.textContent ?? '')).toEqual(
            cards.map((card) => card.text),
          );

          cards.forEach((card, index) => {
            const clone = clones[index];
            const textArea = textAreas[index];
            const live = getComputedStyle(textArea);

            // The clone stands in for the control it shadows, right next to it.
            expect(textArea.value).toBe(card.text);
            expect(textArea.nextSibling).toBe(clone);
            expect(textArea.style.display).toBe('none');
            expect(clone.classList.contains('retro-card__text')).toBe(true);

            // The live control really carries the generated typography, so the
            // comparisons below are anchored on the generated card.
            expect(live.fontSize).toBe(`${card.fontSizePx}px`);
            expect(live.lineHeight).toBe(`${card.lineHeightPx}px`);
            expect(live.color).toBe(colorDeclaration(card));
            // Family names are quoted by the CSS serialiser when they hold a
            // space, which is the only difference the round trip may introduce.
            expect(live.fontFamily.replace(/"/g, '')).toBe(card.fontFamily);

            // R4.12: the four typography declarations, copied unchanged from
            // the live element.
            expect(clone.style.getPropertyValue('font-family')).toBe(live.fontFamily);
            expect(clone.style.getPropertyValue('font-size')).toBe(live.fontSize);
            expect(clone.style.getPropertyValue('line-height')).toBe(live.lineHeight);
            expect(clone.style.getPropertyValue('color')).toBe(live.color);

            // R4.11: padding and width reproduce the card's content width, and
            // the wrap keeps every line inside it.
            expect(clone.style.getPropertyValue('width')).toBe(`${elementWidthPx(card)}px`);
            expect(parsePx(clone.style.getPropertyValue('padding-top'))).toBe(card.paddingTopPx);
            expect(parsePx(clone.style.getPropertyValue('padding-bottom'))).toBe(
              card.paddingBottomPx,
            );
            expect(clone.style.getPropertyValue('white-space')).toBe('pre-wrap');
            expect(clone.style.getPropertyValue('overflow-wrap')).toBe('anywhere');

            // R4.13: the box contains every wrapped line rather than scrolling,
            // so nothing the live control clipped is clipped again.
            expect(clone.style.getPropertyValue('overflow')).toBe('visible');
            const cloneHeightPx = parsePx(clone.style.getPropertyValue('height'));
            expect(cloneHeightPx).toBeGreaterThanOrEqual(requiredCloneHeightPx(card));
          });

          handle.restore();
        } finally {
          root.remove();
        }
      }),
      { numRuns: 100 },
    );

    assertBoardCoverage(coverage);
  }, 180_000);

  it('R4.12/R4.13: `captureTextStyle` reproduces the live declarations and the height it is handed', () => {
    const coverage = new Coverage();

    fc.assert(
      fc.property(boardArb, fc.integer({ min: 0, max: 4000 }), (board, heightPx) => {
        coverage.record(board);
        const root = buildBoard(board);

        try {
          for (const textArea of root.querySelectorAll<HTMLTextAreaElement>(CARD_TEXT_SELECTOR)) {
            const computed = getComputedStyle(textArea);
            const declarations = captureTextStyle(computed, heightPx);

            // Pure in its arguments: the same computed style and height give
            // the same declarations.
            expect(captureTextStyle(computed, heightPx)).toEqual(declarations);

            // R4.12: the four typography declarations come from the live
            // element, unchanged.
            expect(declarations['font-family']).toBe(computed.fontFamily);
            expect(declarations['font-size']).toBe(computed.fontSize);
            expect(declarations['line-height']).toBe(computed.lineHeight);
            expect(declarations['color']).toBe(computed.color);

            // R4.11: the content box the lines wrap inside.
            expect(declarations['width']).toBe(computed.width);
            expect(declarations['padding']).toBe(computed.padding);

            // R4.13: a static block that grows to the height it is given.
            expect(declarations['height']).toBe(`${heightPx}px`);
            expect(declarations['overflow']).toBe('visible');
            expect(declarations['white-space']).toBe('pre-wrap');
            expect(declarations['overflow-wrap']).toBe('anywhere');
            expect(declarations['display']).toBe('block');
          }
        } finally {
          root.remove();
        }
      }),
      { numRuns: 100 },
    );

    assertBoardCoverage(coverage);
  }, 180_000);
});
