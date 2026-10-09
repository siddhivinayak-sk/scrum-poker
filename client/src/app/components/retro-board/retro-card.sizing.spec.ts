import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { EMPTY } from 'rxjs';
import { RetroCard, RetroConfiguration } from '@shared/types';
import { RetroCardComponent } from './retro-card.component';
import { RetroStateService } from '../../services/retro-state.service';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import {
  FLUID_MIN_LINES,
  FLUID_MAX_LINES,
  FIXED_LINES,
} from '../../services/retro-card-height';

/**
 * Stream 4 — retro card text area sizing (R5.11, R6.7).
 *
 * Two things are asserted here, and they need two different techniques because the
 * client test runner performs no layout:
 *
 *   1. **The height binding and its recomputation (R6.7).** The applied height is
 *      observable: it is written to `style.height` on the text area. What is *not*
 *      observable is pixel geometry, so no absolute pixel value is asserted. Instead
 *      the line height and the vertical padding are *derived* from the two clamp
 *      endpoints the component itself produces (a one-line text pins the height to
 *      `FLUID_MIN_LINES`, a twenty-line text to `FLUID_MAX_LINES`), and every other
 *      expectation is stated as `lines × lineHeight + padding`. That holds whether the
 *      count came from the DOM or from the `measureLineCount` fallback.
 *
 *      The width-change half of R6.7 is driven through the component's own seam: the
 *      width-only `ResizeObserver` is stubbed so the test can deliver a width change,
 *      and the text area's `clientWidth` is pinned to a value the test controls so the
 *      re-measurement has a different width to read. A narrower box fits fewer
 *      characters per line, so the same text needs more lines — which is how a width
 *      recomputation becomes visible without a layout engine.
 *
 *   2. **Scrollbar containment (R5.11).** A scrollbar's position cannot be measured
 *      here, so containment is asserted from the declared stylesheet (`overflow-y:
 *      auto` so overflow scrolls instead of spilling, `scrollbar-gutter: stable` so the
 *      gutter is reserved inside the box, `box-sizing: border-box` so the bound height
 *      includes it) together with the DOM structure that puts the author line, the
 *      action row and the comment section outside the text area's box in normal flow.
 *
 * Determinism and prefix monotonicity of the height itself are covered by
 * `services/retro-card-height.property.spec.ts`; the scroll-offset and value behaviour
 * by `retro-card.scroll.property.spec.ts`.
 */

// --- Declared-CSS helpers ----------------------------------------------------------

/** Shape of the compiled component definition this file reads. */
interface StyledComponentDef {
  readonly styles: readonly string[];
}

function compiledStyles(): readonly string[] {
  const def = (RetroCardComponent as unknown as { ɵcmp: StyledComponentDef }).ɵcmp;
  return def.styles;
}

/**
 * Collapses whitespace and strips it around CSS punctuation, so a declaration can be
 * matched as a stable substring regardless of source formatting.
 */
function normalizeCss(css: string): string {
  return css
    .replace(/\s+/g, ' ')
    .replace(/\s*([:;{},])\s*/g, '$1')
    .trim();
}

interface CssRule {
  readonly selectors: readonly string[];
  readonly body: string;
}

/** Brace-matching walk that flattens at-rule bodies into the same flat rule list. */
function collectRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  let cursor = 0;

  while (cursor < css.length) {
    const open = css.indexOf('{', cursor);
    if (open === -1) {
      break;
    }

    let depth = 0;
    let close = css.length - 1;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') {
        depth++;
      } else if (css[i] === '}') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }

    const prelude = css.slice(cursor, open).trim();
    const body = css.slice(open + 1, close);
    if (prelude.startsWith('@')) {
      rules.push(...collectRules(body));
    } else {
      rules.push({ selectors: prelude.split(',').map(selector => selector.trim()), body });
    }
    cursor = close + 1;
  }

  return rules;
}

/** Drops the component-scoping attribute the Angular compiler appends to selectors. */
function stripScope(selector: string): string {
  return selector.replace(/\[[^\]]*\]/g, '').trim();
}

/** Declaration bodies of every rule whose selector list targets exactly `selector`. */
function declarationsFor(selector: string): string[] {
  const css = normalizeCss(compiledStyles().join('\n'));
  return collectRules(css)
    .filter(rule => rule.selectors.some(candidate => stripScope(candidate) === selector))
    .map(rule => rule.body);
}

/** The declarations of `selector`, joined — the rule may be split across blocks. */
function declaredCss(selector: string): string {
  return declarationsFor(selector).join(';');
}

// --- ResizeObserver stub -----------------------------------------------------------

/**
 * Records every observer the component creates and lets a test deliver one entry, so
 * the width-change path of R6.7 can be exercised without a layout engine.
 */
class StubResizeObserver {
  static readonly instances: StubResizeObserver[] = [];

  readonly targets: Element[] = [];
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    StubResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.push(target);
  }

  unobserve(target: Element): void {
    const index = this.targets.indexOf(target);
    if (index >= 0) {
      this.targets.splice(index, 1);
    }
  }

  disconnect(): void {
    this.disconnected = true;
    this.targets.length = 0;
  }

  /** Delivers a content-box resize. `heightPx` varies independently of the width. */
  emit(target: Element, widthPx: number, heightPx: number): void {
    const entry = {
      target,
      contentRect: { width: widthPx, height: heightPx, top: 0, left: 0, right: widthPx, bottom: heightPx, x: 0, y: 0 },
    } as unknown as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }
}

type ResizeObserverGlobal = { ResizeObserver?: typeof ResizeObserver };

let originalResizeObserver: typeof ResizeObserver | undefined;

beforeAll(() => {
  const target = globalThis as ResizeObserverGlobal;
  originalResizeObserver = target.ResizeObserver;
  target.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
});

afterAll(() => {
  const target = globalThis as ResizeObserverGlobal;
  if (originalResizeObserver) {
    target.ResizeObserver = originalResizeObserver;
  } else {
    delete target.ResizeObserver;
  }
});

// --- Fixtures ----------------------------------------------------------------------

const CARD_ID = 'card-sizing-1';

/** Content width the text area reports unless a test narrows it. */
const WIDE_CONTENT_WIDTH_PX = 210;

/** Narrow enough that the sample text below needs noticeably more lines. */
const NARROW_CONTENT_WIDTH_PX = 70;

function makeCard(text: string): RetroCard {
  return {
    id: CARD_ID,
    text,
    authorId: 'user-1',
    authorName: 'Alice',
    votes: 2,
    votedBy: ['user-1'],
    comments: [
      {
        id: 'comment-1',
        text: 'A comment',
        authorId: 'user-2',
        authorName: 'Bob',
        createdAt: '2026-05-01T00:00:00.000Z',
      },
    ],
    columnId: 'col-1',
    order: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
  };
}

function makeConfig(fluid: boolean): RetroConfiguration {
  return {
    boardName: 'Board',
    maxVotesPerUser: 6,
    templateId: 'default',
    hideCardsInitially: false,
    disableVotingInitially: false,
    hideVoteCount: false,
    oneVotePerCard: false,
    // The author line must render so the structural assertions can see it.
    showCardAuthor: true,
    password: null,
    enableGifEmoji: true,
    columnLayout: 'vertical',
    allowedFeelings: ['Satisfaction'],
    fluidCardHeight: fluid,
  };
}

/** A text of `count` single-character lines — a line count that is width-independent. */
function explicitLines(count: number): string {
  return Array.from({ length: count }, () => 'a').join('\n');
}

/** Ten eight-character words: how many lines it needs depends on the available width. */
const WRAPPING_TEXT = Array.from({ length: 10 }, () => 'abcdefgh').join(' ');

interface SizingHarness {
  readonly fixture: ComponentFixture<RetroCardComponent>;
  readonly component: RetroCardComponent;
  readonly textArea: HTMLTextAreaElement;
  readonly config: WritableSignal<RetroConfiguration>;
  /** The content width the text area reports to the component's measurement. */
  setContentWidth(widthPx: number): void;
  /** Delivers a `ResizeObserver` entry for the text area. */
  resize(widthPx: number, heightPx: number): void;
  /** Replaces the inbound card text. */
  setText(text: string): Promise<void>;
  /** Flushes change detection and the render effects it schedules. */
  settle(): Promise<void>;
  /** Applied text area height in pixels, read off the inline style binding. */
  appliedHeightPx(): number;
}

async function renderCard(initialText: string, fluid: boolean): Promise<SizingHarness> {
  const config = signal<RetroConfiguration>(makeConfig(fluid));
  const retroState = {
    lastAddedOwnCardId: signal<string | null>(null),
    ownNewCardIds: signal(new Set<string>()).asReadonly(),
    isCompleted: signal(false).asReadonly(),
    votingEnabled: signal(true).asReadonly(),
    votesRemaining: signal(5).asReadonly(),
    config: config.asReadonly(),
    currentUserId: signal('user-1').asReadonly(),
    isModerator: signal(false).asReadonly(),
  };
  const ws = {
    send: vi.fn(),
    on: vi.fn().mockReturnValue(EMPTY),
    sendCardEdit: vi.fn(),
    sendCardVote: vi.fn(),
    sendCardRemove: vi.fn(),
    sendCommentAdd: vi.fn(),
    sendCommentRemove: vi.fn(),
  };

  TestBed.configureTestingModule({
    imports: [RetroCardComponent],
    providers: [
      { provide: RetroStateService, useValue: retroState },
      { provide: RetroWebSocketService, useValue: ws },
    ],
  });

  const fixture = TestBed.createComponent(RetroCardComponent);
  const component = fixture.componentInstance;
  fixture.componentRef.setInput('card', makeCard(initialText));

  const settle = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  // First pass only creates the element; the content width must be pinned before the
  // render effect measures, so it is installed as soon as the element exists.
  fixture.detectChanges();
  const textArea = (fixture.nativeElement as HTMLElement).querySelector('textarea');
  if (!textArea) {
    throw new Error('retro card text area was not rendered');
  }

  let contentWidthPx = WIDE_CONTENT_WIDTH_PX;
  Object.defineProperty(textArea, 'clientWidth', {
    configurable: true,
    get: () => contentWidthPx,
  });

  await settle();

  const observerFor = (): StubResizeObserver => {
    const observer = StubResizeObserver.instances.find(candidate =>
      candidate.targets.includes(textArea)
    );
    if (!observer) {
      throw new Error('no ResizeObserver was attached to the retro card text area');
    }
    return observer;
  };

  return {
    fixture,
    component,
    textArea,
    config,
    setContentWidth(widthPx: number): void {
      contentWidthPx = widthPx;
    },
    resize(widthPx: number, heightPx: number): void {
      observerFor().emit(textArea, widthPx, heightPx);
    },
    async setText(text: string): Promise<void> {
      fixture.componentRef.setInput('card', makeCard(text));
      await settle();
    },
    settle,
    appliedHeightPx(): number {
      return Number.parseFloat(textArea.style.height);
    },
  };
}

describe('RetroCardComponent — text area sizing', () => {
  afterEach(() => {
    StubResizeObserver.instances.length = 0;
    TestBed.resetTestingModule();
  });

  describe('the height binding is present (R6.7)', () => {
    it('writes a pixel height onto the text area instead of a row count', async () => {
      const harness = await renderCard('A card', true);

      expect(harness.textArea.style.height).toMatch(/^\d+(\.\d+)?px$/);
      expect(harness.appliedHeightPx()).toBeGreaterThan(0);
      // `rows` and the old `min-height` are what the binding replaced.
      expect(harness.textArea.hasAttribute('rows')).toBe(false);
      expect(declaredCss('.retro-card__text')).not.toContain('min-height');
      expect(declaredCss('.retro-card__text')).not.toMatch(/(^|;)height:/);
    });

    it('keeps the applied height equal to the component height signal', async () => {
      const harness = await renderCard(explicitLines(5), true);

      expect(harness.appliedHeightPx()).toBe(harness.component.textAreaHeightPx());
    });

    it('settles on one height — a further change pass does not move it', async () => {
      const harness = await renderCard(explicitLines(7), true);
      const first = harness.appliedHeightPx();

      await harness.settle();
      await harness.settle();

      expect(harness.appliedHeightPx()).toBe(first);
    });
  });

  describe('recomputes on a text change (R6.7)', () => {
    it('grows and shrinks with the line count, clamped to the fluid range', async () => {
      const harness = await renderCard('a', true);

      // The two clamp endpoints the component produces, used to derive the geometry
      // the environment refuses to report.
      const atMinLines = harness.appliedHeightPx();
      await harness.setText(explicitLines(20));
      const atMaxLines = harness.appliedHeightPx();

      const lineHeightPx = (atMaxLines - atMinLines) / (FLUID_MAX_LINES - FLUID_MIN_LINES);
      const paddingPx = atMinLines - FLUID_MIN_LINES * lineHeightPx;
      expect(lineHeightPx).toBeGreaterThan(0);
      expect(paddingPx).toBeGreaterThanOrEqual(0);

      const expectedFor = (lines: number): number => lines * lineHeightPx + paddingPx;

      // A count inside the range is applied as measured, in the same pass.
      await harness.setText(explicitLines(6));
      expect(harness.appliedHeightPx()).toBeCloseTo(expectedFor(6), 5);
      expect(harness.appliedHeightPx()).toBe(harness.component.textAreaHeightPx());

      // Above the maximum the height stops growing and the text scrolls instead.
      await harness.setText(explicitLines(40));
      expect(harness.appliedHeightPx()).toBeCloseTo(expectedFor(FLUID_MAX_LINES), 5);

      // Back to a short text in the same pass: the card shrinks again.
      await harness.setText('a');
      expect(harness.appliedHeightPx()).toBeCloseTo(expectedFor(FLUID_MIN_LINES), 5);
      expect(harness.appliedHeightPx()).toBe(harness.component.textAreaHeightPx());
    });

    it('holds the fixed height for every text length when fluid height is off', async () => {
      const harness = await renderCard('a', false);
      const short = harness.appliedHeightPx();

      await harness.setText(explicitLines(40));
      expect(harness.appliedHeightPx()).toBe(short);

      await harness.setText('');
      expect(harness.appliedHeightPx()).toBe(short);
    });

    it('applies the configured clamp relationship between the two modes', async () => {
      const fluidHarness = await renderCard('a', true);
      const atMinLines = fluidHarness.appliedHeightPx();
      await fluidHarness.setText(explicitLines(20));
      const atMaxLines = fluidHarness.appliedHeightPx();
      const lineHeightPx = (atMaxLines - atMinLines) / (FLUID_MAX_LINES - FLUID_MIN_LINES);
      const paddingPx = atMinLines - FLUID_MIN_LINES * lineHeightPx;

      // Flipping the mode re-clamps the already measured line count in place.
      fluidHarness.config.set(makeConfig(false));
      await fluidHarness.settle();

      expect(fluidHarness.appliedHeightPx()).toBeCloseTo(
        FIXED_LINES * lineHeightPx + paddingPx,
        5
      );
      expect(fluidHarness.appliedHeightPx()).toBe(fluidHarness.component.textAreaHeightPx());
    });
  });

  describe('recomputes on a width change (R6.7)', () => {
    it('re-measures the unchanged text when the text area width changes', async () => {
      const harness = await renderCard(WRAPPING_TEXT, true);

      const wide = harness.appliedHeightPx();

      harness.setContentWidth(NARROW_CONTENT_WIDTH_PX);
      harness.resize(NARROW_CONTENT_WIDTH_PX, 0);
      await harness.settle();

      const narrow = harness.appliedHeightPx();
      // Fewer characters per line ⇒ more lines ⇒ a taller box, same text.
      expect(narrow).toBeGreaterThan(wide);
      expect(narrow).toBe(harness.component.textAreaHeightPx());
      expect(harness.textArea.value).toBe(WRAPPING_TEXT);

      // Widening again brings the height back down: the measurement reads the content
      // height rather than the height already applied.
      harness.setContentWidth(WIDE_CONTENT_WIDTH_PX);
      harness.resize(WIDE_CONTENT_WIDTH_PX, 0);
      await harness.settle();

      expect(harness.appliedHeightPx()).toBe(wide);
      expect(harness.appliedHeightPx()).toBe(harness.component.textAreaHeightPx());
    });

    it('ignores a resize that reports the same width, so the height cannot feed back', async () => {
      const harness = await renderCard(WRAPPING_TEXT, true);

      harness.resize(WIDE_CONTENT_WIDTH_PX, 40);
      await harness.settle();
      const baseline = harness.appliedHeightPx();

      // A height-only resize at the same width must not trigger a re-measure, even
      // though the content width underneath has since changed.
      harness.setContentWidth(NARROW_CONTENT_WIDTH_PX);
      harness.resize(WIDE_CONTENT_WIDTH_PX, 400);
      await harness.settle();
      expect(harness.appliedHeightPx()).toBe(baseline);

      // The very same width value, once reported as a width change, is picked up.
      harness.resize(NARROW_CONTENT_WIDTH_PX, 400);
      await harness.settle();
      expect(harness.appliedHeightPx()).toBeGreaterThan(baseline);
    });

    it('observes the text area and disconnects the observer when the card is destroyed', async () => {
      const harness = await renderCard('a', true);
      const observer = StubResizeObserver.instances.find(candidate =>
        candidate.targets.includes(harness.textArea)
      );
      expect(observer).toBeDefined();

      harness.fixture.destroy();
      expect(observer!.disconnected).toBe(true);
    });
  });

  describe('the scrollbar stays inside the text area box (R5.11)', () => {
    it('exposes a non-empty compiled stylesheet to assert against', () => {
      expect(compiledStyles().length).toBeGreaterThan(0);
      expect(declaredCss('.retro-card__text').length).toBeGreaterThan(0);
    });

    it('scrolls overflow inside its own box rather than spilling out', () => {
      const css = declaredCss('.retro-card__text');
      expect(css).toContain('overflow-y:auto');
      // Reserving the gutter keeps the scrollbar from being laid over the text and
      // keeps the box width stable as the text crosses the overflow threshold.
      expect(css).toContain('scrollbar-gutter:stable');
      // The bound height is a border-box height, so the gutter is inside it.
      expect(css).toContain('box-sizing:border-box');
      expect(css).toContain('width:100%');
      expect(css).toContain('white-space:pre-wrap');
      expect(css).toContain('overflow-wrap:anywhere');
      expect(css).toContain('resize:none');
    });

    it('leaves the text area in normal flow so its box cannot cover a sibling', () => {
      const css = declaredCss('.retro-card__text');
      expect(css).not.toMatch(/position:(absolute|fixed)/);
      expect(css).not.toMatch(/float:/);
      expect(css).not.toMatch(/transform:/);
    });

    it('pulls no sibling back over the text area box with a negative margin', () => {
      for (const selector of [
        '.retro-card__text',
        '.retro-card__author',
        '.retro-card__actions',
        '.retro-card__comments',
      ]) {
        const css = declaredCss(selector);
        expect(css.length).toBeGreaterThan(0);
        expect(css).not.toMatch(/margin[a-z-]*:[^;]*-\d/);
        expect(css).not.toMatch(/position:(absolute|fixed)/);
      }
    });

    it('renders the author line, action row and comment section outside the text area', async () => {
      const harness = await renderCard(explicitLines(40), true);
      harness.component.toggleComments();
      await harness.settle();

      const card = (harness.fixture.nativeElement as HTMLElement).querySelector('.retro-card');
      expect(card).not.toBeNull();

      const author = card!.querySelector('.retro-card__author');
      const actions = card!.querySelector('.retro-card__actions');
      const comments = card!.querySelector('.retro-card__comments');
      expect(author).not.toBeNull();
      expect(actions).not.toBeNull();
      expect(comments).not.toBeNull();

      // None of them lives inside the scrolling box, so no scrollbar can reach them.
      for (const sibling of [author!, actions!, comments!]) {
        expect(harness.textArea.contains(sibling)).toBe(false);
        expect(sibling.contains(harness.textArea)).toBe(false);
        expect(sibling.parentElement).toBe(harness.textArea.parentElement);
      }
      expect(harness.textArea.children).toHaveLength(0);

      // Document order: the scrolling box ends where the author line begins.
      const order = Array.from(card!.children);
      expect(order.indexOf(harness.textArea)).toBeLessThan(order.indexOf(author!));
      expect(order.indexOf(author!)).toBeLessThan(order.indexOf(actions!));
      expect(order.indexOf(actions!)).toBeLessThan(order.indexOf(comments!));

      // The box is bounded even though the text needs far more lines than it shows,
      // which is the condition under which the scrollbar appears at all.
      expect(harness.appliedHeightPx()).toBeGreaterThan(0);
      expect(harness.component.textAreaHeightPx()).toBe(harness.appliedHeightPx());
    });
  });
});
