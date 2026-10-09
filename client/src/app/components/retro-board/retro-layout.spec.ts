import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { EMPTY } from 'rxjs';
import {
  CONNECTION_LABEL,
  FeelingCategory,
  RetroCard,
  RetroColumn,
  RetroConfiguration,
  User,
} from '@shared/types';
import { ConnectionStatusComponent } from '../connection-status/connection-status.component';
import { RetroBoardPageComponent } from './retro-board-page.component';
import { RetroCardComponent } from './retro-card.component';
import { RetroColumnComponent } from './retro-column.component';
import { RetroToolbarComponent } from './retro-toolbar.component';
import { RetroStateService } from '../../services/retro-state.service';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { RetroExportService } from '../../services/retro-export.service';
import { RetroScreenshotService } from '../../services/retro-screenshot.service';
import { FeelingsService } from '../../services/feelings.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import {
  borderWidthPx,
  declared,
  edgesPx,
  lineBoxPx,
  MOBILE_MEDIA,
  REDUCED_MOTION_MEDIA,
  rulesOf,
  stylesFor,
  toPx,
} from '../../testing/declared-css';

/**
 * Stream 6 — retro board layout, example-based cover (R7.6–R7.13, R7.15–R7.18).
 *
 * The client test runner performs no layout: no box is measured, no custom
 * property is resolved and every `getComputedStyle` read echoes the authored
 * value back. So nothing here asserts geometry. Two observable things stand in
 * for it, and they are the two the design names for this stream:
 *
 *   1. **The declared stylesheet.** Each component's compiled `styles` blocks
 *      are parsed into rules (selector list, declarations, enclosing media
 *      query) and queried by selector, via `testing/declared-css`. Row-height
 *      budgets are then *arithmetic
 *      over declared values* — block padding plus the declared control minimum
 *      or the declared line box plus the declared border — rather than measured
 *      heights. Where a budget needs a row count, the count comes from the
 *      rendered DOM (how many flex children the row holds), not from a guess.
 *
 *   2. **The rendered DOM.** Structure, document order, attributes, accessible
 *      names and the disabled conditions are all real here, so the "every
 *      control survives the layout change" and "the pieces of a card each take
 *      their own band" criteria are asserted against the live tree.
 *
 * Declared-value invariants that hold across *all* retro surfaces (the 4-px
 * scale, token-only colours, the 12-px font floor, 32-px controls, contrast)
 * belong to the property spec for Property 27; the toolbar's own 40-px row and
 * the 72-px toolbar-plus-context budget belong to `retro-toolbar.compact.spec`.
 */

// --- Declared-CSS model ------------------------------------------------------------

/** R7.8 / R7.13 budgets for the stacked chrome rows. */
const DESKTOP_CHROME_BUDGET_PX = 160;
const MOBILE_CHROME_BUDGET_PX = 240;

/**
 * Declared block size of the sprint context row: block padding + line box +
 * block borders. `box-sizing: border-box` is asserted alongside each use, so
 * this is the row's outer box.
 */
function contextRowHeightPx(selector: string): number {
  const padding = edgesPx(declared(RetroBoardPageComponent, selector, 'padding'));
  const border = borderWidthPx(declared(RetroBoardPageComponent, selector, 'border'));
  return padding.top + padding.bottom + lineBoxPx(RetroBoardPageComponent, selector) + 2 * border;
}

/** Declared outer height of one toolbar row, read off its own `max-height` cap. */
function toolbarRowCapPx(mediaNeedle?: string): number {
  expect(declared(RetroToolbarComponent, '.retro-toolbar', 'box-sizing')).toBe('border-box');
  return toPx(declared(RetroToolbarComponent, '.retro-toolbar', 'max-height', mediaNeedle));
}

/**
 * Declared outer height of the board header: block padding, plus one declared
 * control minimum per wrapped row, plus the row gaps between them. The header's
 * tallest item is a 32px control — every text item in it declares a smaller
 * font size, which `the header row is driven by its controls` checks.
 */
function headerHeightPx(rows: number, mediaNeedle?: string): number {
  const padding = edgesPx(declared(RetroBoardPageComponent, '.retro-board__header', 'padding'));
  const controlPx = toPx(
    declared(RetroBoardPageComponent, '.retro-board__lobby-btn', 'min-height'),
  );
  const rowGapPx =
    rows > 1
      ? toPx(declared(RetroBoardPageComponent, '.retro-board__header', 'row-gap', mediaNeedle))
      : 0;
  return padding.top + padding.bottom + rows * controlPx + (rows - 1) * rowGapPx;
}

// --- Fixtures ----------------------------------------------------------------------

const SESSION_ID = 'retro-session-1';
const USER_ID = 'user-1';

/** Longer than any column header can show, so the ellipsis path is the live one. */
const LONG_COLUMN_NAME =
  'What went well during the authentication hardening sprint and should continue';

const LONG_CONTEXT =
  'Sprint 14 — User Authentication.\nGoal: finish the token refresh work and ' +
  'close the outstanding accessibility findings before the release review.';

function makeCard(overrides: Partial<RetroCard> = {}): RetroCard {
  return {
    id: 'card-1',
    text: 'Pairing on the token refresh paid off',
    authorId: USER_ID,
    authorName: 'Alice',
    votes: 3,
    votedBy: [USER_ID],
    comments: [
      {
        id: 'comment-1',
        text: 'Agreed, lets keep it',
        authorId: 'user-2',
        authorName: 'Bob',
        createdAt: '2026-05-01T00:00:00.000Z',
      },
    ],
    columnId: 'col-1',
    order: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeColumns(): RetroColumn[] {
  return [
    {
      id: 'col-1',
      name: LONG_COLUMN_NAME,
      order: 0,
      cards: [
        makeCard({ id: 'card-1', order: 0 }),
        makeCard({ id: 'card-2', order: 1, text: 'Shorter card' }),
      ],
    },
    {
      id: 'col-2',
      name: 'To improve',
      order: 1,
      cards: [makeCard({ id: 'card-3', columnId: 'col-2', order: 0, text: 'Flaky pipeline' })],
    },
  ];
}

function makeConfig(overrides: Partial<RetroConfiguration> = {}): RetroConfiguration {
  return {
    boardName: 'Sprint 14 Retrospective',
    maxVotesPerUser: 6,
    templateId: 'default',
    hideCardsInitially: false,
    disableVotingInitially: false,
    hideVoteCount: false,
    oneVotePerCard: false,
    showCardAuthor: true,
    password: null,
    enableGifEmoji: true,
    columnLayout: 'vertical',
    allowedFeelings: ['Happy', 'Sad'],
    fluidCardHeight: true,
    ...overrides,
  } as RetroConfiguration;
}

const PARTICIPANTS: User[] = [
  { id: USER_ID, displayName: 'Alice', role: 'moderator', isAnonymous: false },
];

interface BoardOptions {
  readonly moderator?: boolean;
  readonly layout?: 'vertical' | 'horizontal';
  readonly context?: string;
  readonly columns?: readonly RetroColumn[];
}

interface BoardHarness {
  readonly fixture: ComponentFixture<RetroBoardPageComponent>;
  readonly root: HTMLElement;
  /** Flushes change detection and the render effects it schedules. */
  settle(): Promise<void>;
}

function provideRetroDoubles(options: {
  readonly moderator: boolean;
  readonly columns: readonly RetroColumn[];
  readonly config: RetroConfiguration;
  readonly context: WritableSignal<string>;
}): void {
  const retroState = {
    columns: signal(options.columns as RetroColumn[]).asReadonly(),
    votesRemaining: signal(4).asReadonly(),
    isModerator: signal(options.moderator).asReadonly(),
    isCompleted: signal(false).asReadonly(),
    context: options.context.asReadonly(),
    config: signal(options.config).asReadonly(),
    cardsRevealed: signal(true).asReadonly(),
    votingEnabled: signal(true).asReadonly(),
    currentUserId: signal(USER_ID).asReadonly(),
    participants: signal(PARTICIPANTS).asReadonly(),
    state: signal({ sessionId: SESSION_ID }).asReadonly(),
    lastAddedOwnCardId: signal<string | null>(null),
    ownNewCardIds: signal(new Set<string>()).asReadonly(),
    reset: vi.fn(),
  };

  const ws = {
    connectionState: signal('connected').asReadonly(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    on: vi.fn().mockReturnValue(EMPTY),
    sendContextUpdate: vi.fn(),
    sendCardAdd: vi.fn(),
    sendCardEdit: vi.fn(),
    sendCardRemove: vi.fn(),
    sendCardMove: vi.fn(),
    sendCardVote: vi.fn(),
    sendCardMerge: vi.fn(),
    sendColumnAdd: vi.fn(),
    sendColumnRemove: vi.fn(),
    sendColumnReorder: vi.fn(),
    sendCommentAdd: vi.fn(),
    sendCommentRemove: vi.fn(),
    sendCardsReveal: vi.fn(),
    sendVotingEnable: vi.fn(),
    sendBoardComplete: vi.fn(),
    sendConfigUpdate: vi.fn(),
  };

  TestBed.configureTestingModule({
    providers: [
      // The page issues the end-session DELETE itself, so it needs a client.
      // No test here activates it, so the testing backend stays idle.
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: RetroStateService, useValue: retroState },
      { provide: RetroWebSocketService, useValue: ws },
      { provide: RetroExportService, useValue: { exportCSV: vi.fn(), importCSV: vi.fn() } },
      {
        provide: RetroScreenshotService,
        useValue: { captureBoard: vi.fn(), capturing: signal(false).asReadonly() },
      },
      {
        provide: FeelingsService,
        useValue: {
          myFeeling: signal<FeelingCategory | null>(null).asReadonly(),
          feelings: signal<Record<string, FeelingCategory | null>>({}).asReadonly(),
          selectFeeling: vi.fn(),
        },
      },
      { provide: AuthService, useValue: { getToken: () => 'test-token', logout: vi.fn() } },
      { provide: ToastService, useValue: { show: vi.fn() } },
      { provide: Router, useValue: { navigate: vi.fn() } },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: { get: () => SESSION_ID } } },
      },
    ],
  });
}

async function renderBoard(options: BoardOptions = {}): Promise<BoardHarness> {
  const context = signal(options.context ?? LONG_CONTEXT);
  provideRetroDoubles({
    moderator: options.moderator ?? false,
    columns: options.columns ?? makeColumns(),
    config: makeConfig({ columnLayout: options.layout ?? 'vertical' }),
    context,
  });

  const fixture = TestBed.createComponent(RetroBoardPageComponent);
  const settle = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };
  await settle();

  return { fixture, root: fixture.nativeElement as HTMLElement, settle };
}

interface CardHarness {
  readonly fixture: ComponentFixture<RetroCardComponent>;
  readonly cardEl: HTMLElement;
  settle(): Promise<void>;
}

async function renderCard(text: string): Promise<CardHarness> {
  provideRetroDoubles({
    moderator: false,
    columns: makeColumns(),
    config: makeConfig(),
    context: signal(''),
  });

  const fixture = TestBed.createComponent(RetroCardComponent);
  fixture.componentRef.setInput('card', makeCard({ text }));
  const settle = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };
  await settle();

  const cardEl = (fixture.nativeElement as HTMLElement).querySelector('.retro-card');
  expect(cardEl).not.toBeNull();
  return { fixture, cardEl: cardEl as HTMLElement, settle };
}

function textOf(element: Element | null): string {
  return (element?.textContent ?? '').trim();
}

afterEach(() => {
  TestBed.resetTestingModule();
});

// --- Column header row (R7.6, R7.7, R7.16) -----------------------------------------

describe('retro column header row (R7.6, R7.7)', () => {
  it('holds the name, the count, add and delete on one non-wrapping row', async () => {
    const harness = await renderBoard();
    const header = harness.root.querySelector('.retro-column__header');
    expect(header).not.toBeNull();

    // Structure: the name, then the action group with count, add and delete.
    const name = header!.querySelector('.retro-column__name');
    const actions = header!.querySelector('.retro-column__actions');
    expect(name).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(Array.from(header!.children)).toEqual([name, actions]);
    expect(
      Array.from(actions!.children).map(child => child.className),
    ).toEqual([
      'retro-column__card-count',
      'retro-column__add-btn',
      'retro-column__delete-btn',
    ]);

    // The row itself never wraps, and every item in it is unshrinkable, so the
    // four pieces stay side by side instead of stacking or overlapping.
    expect(declared(RetroColumnComponent, '.retro-column__header', 'flex-wrap')).toBe('nowrap');
    expect(declared(RetroColumnComponent, '.retro-column__actions', 'flex-wrap')).toBe('nowrap');
    expect(declared(RetroColumnComponent, '.retro-column__actions', 'flex-shrink')).toBe('0');
  });

  it('gives the name the only flexible width, so the controls are never pushed out', () => {
    // `scrollWidth <= clientWidth` cannot be measured here. The declared
    // equivalent: the name is the single shrinkable item and it may shrink to
    // nothing (`min-width: 0`), so surplus text is absorbed by the ellipsis
    // rather than by widening the row past its box.
    expect(declared(RetroColumnComponent, '.retro-column__name', 'flex')).toBe('1 1 auto');
    expect(declared(RetroColumnComponent, '.retro-column__name', 'min-width')).toBe('0');
    expect(declared(RetroColumnComponent, '.retro-column__card-count', 'white-space')).toBe(
      'nowrap',
    );
  });

  it('keeps the add and delete controls at 32px in both axes', () => {
    for (const selector of ['.retro-column__add-btn', '.retro-column__delete-btn']) {
      expect(toPx(declared(RetroColumnComponent, selector, 'min-width'))).toBeGreaterThanOrEqual(32);
      expect(toPx(declared(RetroColumnComponent, selector, 'min-height'))).toBeGreaterThanOrEqual(
        32,
      );
    }
  });

  it('truncates the name to one line and exposes the whole name twice over', async () => {
    const harness = await renderBoard();
    const name = harness.root.querySelector('.retro-column__name') as HTMLElement;

    expect(declared(RetroColumnComponent, '.retro-column__name', 'white-space')).toBe('nowrap');
    expect(declared(RetroColumnComponent, '.retro-column__name', 'overflow')).toBe('hidden');
    expect(declared(RetroColumnComponent, '.retro-column__name', 'text-overflow')).toBe('ellipsis');

    // The visible node is truncated by CSS, but the complete name is reachable
    // as the title tooltip and as the accessible name (R7.7).
    expect(name.getAttribute('title')).toBe(LONG_COLUMN_NAME);
    expect(name.getAttribute('aria-label')).toBe(LONG_COLUMN_NAME);
    expect(textOf(name)).toBe(LONG_COLUMN_NAME);
  });
});

describe('retro column fills the board height and scrolls its own cards (R7.16)', () => {
  it('stretches the column through the blocker wrapper and makes the card list the scroller', () => {
    // The stretch chain, container down to column. The blocker wrapper is a
    // mandatory link: it is rendered unconditionally between the container and
    // the column hosts, so a chain that skips it does not stretch.
    expect(
      declared(RetroBoardPageComponent, '.retro-board__columns--vertical', 'align-items'),
    ).toBe('stretch');
    expect(
      declared(RetroBoardPageComponent, '.retro-board__columns > .interaction-blocker', 'align-items'),
    ).toBe('stretch');
    expect(declared(RetroColumnComponent, ':host', 'align-self')).toBe('stretch');
    expect(declared(RetroColumnComponent, ':host', 'min-height')).toBe('0');
    expect(declared(RetroColumnComponent, '.retro-column', 'height')).toBe('100%');
    expect(declared(RetroColumnComponent, '.retro-column', 'min-height')).toBe('0');

    // The card list takes the leftover height under the header and is the single
    // scrolling element, so every card is reachable and the 60px empty-column
    // floor is gone.
    expect(declared(RetroColumnComponent, '.retro-column__cards', 'flex')).toBe('1 1 auto');
    expect(declared(RetroColumnComponent, '.retro-column__cards', 'min-height')).toBe('0');
    expect(declared(RetroColumnComponent, '.retro-column__cards', 'overflow-y')).toBe('auto');
    expect(declared(RetroColumnComponent, '.retro-column', 'overflow')).toBe('hidden');
    expect(
      declared(RetroBoardPageComponent, '.retro-board__columns--vertical', 'overflow-y'),
    ).toBe('hidden');

    // The header is pinned above the scroller, so the name, count, add and
    // delete controls stay reachable at any card count.
    expect(declared(RetroColumnComponent, '.retro-column__header', 'flex-shrink')).toBe('0');
  });

  it('keeps the stacked layout content-sized, so the two layouts cannot be satisfied by breaking one', () => {
    expect(declared(RetroColumnComponent, ':host.is-horizontal', 'align-self')).toBe('flex-start');
    expect(
      declared(RetroColumnComponent, ':host.is-horizontal .retro-column', 'height'),
    ).toBe('auto');
    expect(
      declared(RetroColumnComponent, ':host.is-horizontal .retro-column__cards', 'flex'),
    ).toBe('0 0 auto');
    expect(
      declared(RetroBoardPageComponent, '.retro-board__columns--horizontal', 'align-items'),
    ).toBe('flex-start');
  });

  it('renders one blocker wrapper and one card list per column at every card count', async () => {
    const harness = await renderBoard({});
    const container = harness.root.querySelector('.retro-board__columns') as HTMLElement;

    // happy-dom has no :scope support, so walk the children directly.
    const wrappers = Array.from(container.children).filter(child =>
      child.classList.contains('interaction-blocker'),
    );
    expect(wrappers).toHaveLength(1);
    expect(container.children).toHaveLength(1);

    const columns = Array.from(harness.root.querySelectorAll('app-retro-column'));
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      expect(column.querySelectorAll('.retro-column__cards')).toHaveLength(1);
      expect(column.querySelectorAll('.retro-column__header')).toHaveLength(1);
    }
  });
});

// --- Settings dialog fits the viewport (R7.16 sibling fix) -------------------------

describe('board settings dialog caps its height and scrolls its body', () => {
  it('declares a height cap, a flex column and an internally scrolling grid body', () => {
    // A centred fixed backdrop clips an unbounded body at BOTH ends instead of
    // scrolling it, so the cap plus an internal scroller is what keeps the
    // title and the Close button in view.
    expect(declared(RetroToolbarComponent, '.retro-dialog--settings', 'max-height')).toBe(
      'calc(100dvh - 48px)',
    );
    expect(declared(RetroToolbarComponent, '.retro-dialog--settings', 'display')).toBe('flex');
    expect(
      declared(RetroToolbarComponent, '.retro-dialog--settings', 'flex-direction'),
    ).toBe('column');

    expect(declared(RetroToolbarComponent, '.retro-settings', 'display')).toBe('grid');
    expect(declared(RetroToolbarComponent, '.retro-settings', 'overflow-y')).toBe('auto');
    // Load-bearing: without it the grid automatic minimum size defeats the cap.
    expect(declared(RetroToolbarComponent, '.retro-settings', 'min-height')).toBe('0');
  });

  it('spans the layout row, the section label and the feelings grid across every track', () => {
    for (const selector of ['.retro-settings__layout', '.retro-settings__section-label', '.retro-settings__feelings']) {
      // The style parser strips the whitespace around the slash.
      expect(declared(RetroToolbarComponent, selector, 'grid-column'), selector).toBe('1/-1');
    }
    expect(declared(RetroToolbarComponent, '.retro-settings__feelings', 'display')).toBe('grid');
  });

  it('leaves the unscoped dialog sizing alone, so the other dialogs are untouched', () => {
    const dialog = stylesFor(RetroToolbarComponent, '.retro-dialog');
    expect(dialog.get('padding')).toBe('24px');
    expect(dialog.get('min-width')).toBe('300px');
    expect(dialog.get('max-height')).toBeUndefined();
  });
});

// --- Row height budgets (R7.8, R7.13) ----------------------------------------------

describe('declared chrome row heights (R7.8, R7.13)', () => {
  it('drives the header row height from its 32px controls, not its text', () => {
    const controlPx = toPx(
      declared(RetroBoardPageComponent, '.retro-board__lobby-btn', 'min-height'),
    );
    expect(controlPx).toBe(32);

    for (const selector of [
      '.retro-board__title',
      '.retro-board__votes-remaining',
      '.retro-board__session-id',
    ]) {
      const fontSizePx = toPx(declared(RetroBoardPageComponent, selector, 'font-size'));
      expect(fontSizePx).toBeGreaterThanOrEqual(12);
      expect(fontSizePx).toBeLessThan(controlPx);
    }

    // The connection indicator is now a component chip rather than an inline
    // glyph in this stylesheet (task 24.6). It is the one non-text item in the
    // header, and it declares a box shorter than a control, so it does not
    // drive the row either.
    expect(
      toPx(declared(ConnectionStatusComponent, '.connection-status', 'font-size')),
    ).toBeGreaterThanOrEqual(12);
    expect(
      toPx(declared(ConnectionStatusComponent, '.connection-status', 'height')),
    ).toBeLessThanOrEqual(controlPx);
  });

  it('sums header, toolbar and context to well inside 160px at 768px and up', async () => {
    const harness = await renderBoard({ moderator: false });
    expect(harness.root.querySelector('.retro-board__context-display')).not.toBeNull();

    const headerPx = headerHeightPx(1);
    const toolbarPx = toolbarRowCapPx();
    const contextPx = contextRowHeightPx('.retro-board__context-display');

    expect(headerPx).toBe(48);
    expect(toolbarPx).toBe(40);
    expect(headerPx + toolbarPx + contextPx).toBeLessThanOrEqual(DESKTOP_CHROME_BUDGET_PX);
  });

  it('stays inside 240px below 768px, where each row wraps instead of overlapping', async () => {
    const harness = await renderBoard({ moderator: true });
    const header = harness.root.querySelector('.retro-board__header');
    expect(header).not.toBeNull();

    // The header wraps, and it holds exactly two flex children, so wrapping can
    // produce at most two rows.
    expect(declared(RetroBoardPageComponent, '.retro-board__header', 'flex-wrap', MOBILE_MEDIA)).toBe(
      'wrap',
    );
    expect(Array.from(header!.children).map(child => child.className)).toEqual([
      'retro-board__header-left',
      'retro-board__meta',
    ]);

    const headerPx = headerHeightPx(2, MOBILE_MEDIA);
    const toolbarPx = toolbarRowCapPx(MOBILE_MEDIA);
    const contextPx = contextRowHeightPx('.retro-board__context-input');

    expect(declared(RetroToolbarComponent, '.retro-toolbar', 'flex-wrap', MOBILE_MEDIA)).toBe(
      'wrap',
    );
    // Three wrapped toolbar rows at the 40px cap.
    expect(toolbarPx).toBe(3 * 40);
    expect(headerPx + toolbarPx + contextPx).toBeLessThanOrEqual(MOBILE_CHROME_BUDGET_PX);
  });
});

// --- Preserved controls and behaviour (R7.9, R7.10) --------------------------------

describe('every board control survives the layout change (R7.9)', () => {
  const HEADER_BUTTONS = [
    { selector: '.retro-board__lobby-btn', name: 'Back to Lobby', icon: '🏠' },
    { selector: '.retro-board__copy-link-btn', name: 'Copy session link', icon: '🔗' },
  ] as const;

  it('keeps each header button with its icon, title, accessible name and keyboard reach', async () => {
    const harness = await renderBoard({ moderator: true });

    for (const expected of HEADER_BUTTONS) {
      const button = harness.root.querySelector(expected.selector) as HTMLButtonElement | null;
      expect(button, expected.selector).not.toBeNull();
      expect(button!.tagName).toBe('BUTTON');
      expect(button!.getAttribute('title')).toBe(expected.name);
      expect(button!.getAttribute('aria-label')).toBe(expected.name);
      expect(textOf(button)).toBe(expected.icon);
      expect(button!.disabled).toBe(false);
      expect(button!.getAttribute('tabindex')).toBeNull();

      // A native, non-disabled button with no negative tabindex is reachable and
      // activatable by keyboard; focus confirms it accepts focus here.
      button!.focus();
      expect(harness.root.ownerDocument.activeElement).toBe(button);
    }
  });

  it('keeps the read-only header items with their titles and accessible names', async () => {
    const harness = await renderBoard({ moderator: true });

    const votes = harness.root.querySelector('.retro-board__votes-remaining') as HTMLElement;
    expect(votes.getAttribute('title')).toBe('Your remaining votes');
    expect(votes.getAttribute('aria-label')).toBe('Your remaining votes: 4');
    expect(textOf(votes)).toContain('4 votes left');

    const sessionId = harness.root.querySelector('.retro-board__session-id') as HTMLElement;
    expect(sessionId.getAttribute('title')).toBe(`Session ID: ${SESSION_ID}`);
    expect(textOf(sessionId)).toBe(`ID: ${SESSION_ID}`);

    // Task 24.6 replaced the inline `●`/`◌`/`○` glyph with the shared
    // indicator chip, so the accessible name is the required label text rather
    // than the raw state name.
    const status = harness.root.querySelector(
      'app-connection-status .connection-status',
    ) as HTMLElement;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('title')).toBe(CONNECTION_LABEL.connected);
    expect(status.getAttribute('aria-label')).toBe(CONNECTION_LABEL.connected);
    expect(textOf(status)).toBe(CONNECTION_LABEL.connected);

    // The toolbar and the user control are still mounted in the header chrome.
    expect(harness.root.querySelector('app-retro-user-menu')).not.toBeNull();
    expect(harness.root.querySelector('app-retro-toolbar [role="toolbar"]')).not.toBeNull();
  });

  it('keeps the column controls and their disabled conditions', async () => {
    const harness = await renderBoard({ moderator: true });
    const add = harness.root.querySelector('.retro-column__add-btn') as HTMLButtonElement;
    const remove = harness.root.querySelector('.retro-column__delete-btn') as HTMLButtonElement;

    expect(add.getAttribute('title')).toBe('Add Card');
    expect(add.getAttribute('aria-label')).toBe('Add Card');
    expect(textOf(add)).toBe('+');
    expect(remove.getAttribute('title')).toBe('Delete Column');
    expect(remove.getAttribute('aria-label')).toBe('Delete Column');
    expect(textOf(remove)).toBe('🗑️');

    // Both are bound to the completed state, which is false in this fixture.
    expect(add.disabled).toBe(false);
    expect(remove.disabled).toBe(false);
  });
});

describe('orientation, order and drag affordances for both layouts (R7.10)', () => {
  it('renders columns and cards in state order in the vertical layout', async () => {
    const harness = await renderBoard({ layout: 'vertical' });
    const container = harness.root.querySelector('.retro-board__columns') as HTMLElement;

    expect(container.classList.contains('retro-board__columns--vertical')).toBe(true);
    expect(container.classList.contains('retro-board__columns--horizontal')).toBe(false);
    expect(
      Array.from(harness.root.querySelectorAll('[data-column-id]')).map(el =>
        el.getAttribute('data-column-id'),
      ),
    ).toEqual(['col-1', 'col-2']);
    expect(
      Array.from(harness.root.querySelectorAll('[data-card-id]')).map(el =>
        el.getAttribute('data-card-id'),
      ),
    ).toEqual(['card-1', 'card-2', 'card-3']);

    // Columns side by side, scrolling across; cards stacked inside a column.
    expect(declared(RetroBoardPageComponent, '.retro-board__columns--vertical', 'flex-direction')).toBe(
      'row',
    );
    expect(declared(RetroBoardPageComponent, '.retro-board__columns--vertical', 'overflow-x')).toBe(
      'auto',
    );
    expect(declared(RetroColumnComponent, '.retro-column__cards', 'flex-direction')).toBe('column');
  });

  it('renders the same order stacked, with the across-column scroll, in the horizontal layout', async () => {
    const harness = await renderBoard({ layout: 'horizontal' });
    const container = harness.root.querySelector('.retro-board__columns') as HTMLElement;

    expect(container.classList.contains('retro-board__columns--horizontal')).toBe(true);
    expect(
      Array.from(harness.root.querySelectorAll('[data-column-id]')).map(el =>
        el.getAttribute('data-column-id'),
      ),
    ).toEqual(['col-1', 'col-2']);
    expect(
      Array.from(harness.root.querySelectorAll('[data-card-id]')).map(el =>
        el.getAttribute('data-card-id'),
      ),
    ).toEqual(['card-1', 'card-2', 'card-3']);

    // Each column host opts into the horizontal rules.
    const host = harness.root.querySelector('app-retro-column') as HTMLElement;
    expect(host.classList.contains('is-horizontal')).toBe(true);
    expect(
      declared(RetroBoardPageComponent, '.retro-board__columns--horizontal', 'flex-direction'),
    ).toBe('column');
    expect(
      declared(RetroBoardPageComponent, '.retro-board__columns--horizontal', 'overflow-y'),
    ).toBe('auto');
    expect(
      declared(RetroColumnComponent, ':host.is-horizontal .retro-column__cards', 'flex-direction'),
    ).toBe('row');
    expect(
      declared(RetroColumnComponent, ':host.is-horizontal .retro-column__cards', 'overflow-x'),
    ).toBe('auto');
  });

  it('keeps the drag handles and the drop-target identifiers in both layouts', async () => {
    for (const layout of ['vertical', 'horizontal'] as const) {
      const harness = await renderBoard({ layout });

      // Column headers are the reorder handles; cards are the movable items.
      for (const header of Array.from(
        harness.root.querySelectorAll('.retro-column__header'),
      )) {
        expect(header.getAttribute('draggable')).toBe('true');
      }
      for (const card of Array.from(harness.root.querySelectorAll('.retro-card'))) {
        expect(card.getAttribute('draggable')).toBe('true');
        expect(card.getAttribute('data-card-id')).toBeTruthy();
      }
      // The card text area stays undraggable so selecting text still works.
      expect(
        (harness.root.querySelector('.retro-card__text') as HTMLElement).getAttribute('draggable'),
      ).toBe('false');

      TestBed.resetTestingModule();
    }
  });
});

// --- Reduced motion (R7.11) --------------------------------------------------------

describe('reduced motion settles every descendant immediately (R7.11)', () => {
  it('zeroes transition and animation duration for the host and all descendants', () => {
    const blocks = rulesOf(RetroBoardPageComponent).filter(
      rule => rule.media?.includes(REDUCED_MOTION_MEDIA) ?? false,
    );
    expect(blocks.length).toBeGreaterThan(0);

    const covered = new Set(blocks.flatMap(rule => rule.selectors));
    // The host plus a descendant wildcard, pseudo-elements included: no element
    // under the board is left with a running transition or animation.
    expect(covered.has(':host')).toBe(true);
    expect(covered.has(':host *')).toBe(true);
    expect(covered.has(':host *::before')).toBe(true);
    expect(covered.has(':host *::after')).toBe(true);

    for (const rule of blocks) {
      // `!important` so a component-level transition cannot win over this.
      expect(rule.declarations.get('transition-duration')).toBe('0s !important');
      expect(rule.declarations.get('animation-duration')).toBe('0s !important');
    }
  });
});

// --- Overflow confinement and container width (R7.12, R7.15) ----------------------

describe('horizontal overflow is confined to the column container (R7.12, R7.15)', () => {
  it('hides overflow on the page and scrolls only inside the column container', () => {
    expect(declared(RetroBoardPageComponent, '.retro-board', 'overflow-x')).toBe('hidden');
    expect(declared(RetroBoardPageComponent, ':host', 'overflow')).toBe('hidden');

    // Nothing else in the page stylesheet opts into a scroll or a visible
    // overflow, so no descendant can widen the page instead.
    const scrollers = rulesOf(RetroBoardPageComponent)
      .filter(rule =>
        ['overflow', 'overflow-x'].some(property => {
          const value = rule.declarations.get(property);
          return value === 'auto' || value === 'scroll' || value === 'visible';
        }),
      )
      .flatMap(rule => rule.selectors);

    expect(scrollers.length).toBeGreaterThan(0);
    for (const selector of scrollers) {
      expect(selector.startsWith('.retro-board__columns'), selector).toBe(true);
    }
  });

  it('lets the column container fill the content width in both layouts', () => {
    for (const selector of [
      '.retro-board__columns--vertical',
      '.retro-board__columns--horizontal',
    ]) {
      expect(declared(RetroBoardPageComponent, selector, 'width')).toBe('100%');
    }
    // The horizontal (stacked) layout never scrolls sideways at the container.
    expect(
      declared(RetroBoardPageComponent, '.retro-board__columns--horizontal', 'overflow-x'),
    ).toBe('hidden');
  });

  it('keeps the toolbar overflow inside the toolbar box', () => {
    expect(declared(RetroToolbarComponent, '.retro-toolbar', 'overflow-x')).toBe('auto');
    expect(declared(RetroToolbarComponent, '.retro-toolbar', 'overflow-y')).toBe('hidden');
  });
});

// --- Sprint context row (R7.17) ----------------------------------------------------

describe('the sprint context row renders its whole text (R7.17)', () => {
  it('reserves at least a line box plus its block padding', () => {
    for (const selector of [
      '.retro-board__context-display',
      '.retro-board__context-input',
    ]) {
      const padding = edgesPx(declared(RetroBoardPageComponent, selector, 'padding'));
      const blockPaddingPx = padding.top + padding.bottom;

      expect(declared(RetroBoardPageComponent, selector, 'box-sizing')).toBe('border-box');
      expect(blockPaddingPx).toBeGreaterThan(0);
      expect(contextRowHeightPx(selector)).toBeGreaterThanOrEqual(
        lineBoxPx(RetroBoardPageComponent, selector) + blockPaddingPx,
      );
    }
  });

  it('declares no clipping and no fixed block size on the read-only display', () => {
    const display = stylesFor(RetroBoardPageComponent, '.retro-board__context-display');

    // A block with pre-wrap grows a line at a time; `min-height: auto` replaced
    // the old fixed row, and nothing hides or caps the block.
    expect(display.get('display')).toBe('block');
    expect(display.get('white-space')).toBe('pre-wrap');
    expect(display.get('overflow-wrap')).toBe('anywhere');
    expect(display.get('min-height')).toBe('auto');
    expect(display.get('height')).toBeUndefined();
    expect(display.get('max-height')).toBeUndefined();
    expect(display.get('overflow')).toBeUndefined();
    expect(display.get('overflow-y')).toBeUndefined();
    expect(display.get('text-overflow')).toBeUndefined();
  });

  it('renders the complete multi-line context for a participant', async () => {
    const harness = await renderBoard({ moderator: false, context: LONG_CONTEXT });
    const display = harness.root.querySelector('.retro-board__context-display') as HTMLElement;

    expect(harness.root.querySelector('.retro-board__context-input')).toBeNull();
    expect(display.getAttribute('aria-label')).toBe('Sprint context');
    expect(textOf(display)).toBe(LONG_CONTEXT);
  });

  it('falls back to a placeholder line when no context is set', async () => {
    const harness = await renderBoard({ moderator: false, context: '' });

    expect(textOf(harness.root.querySelector('.retro-board__context-display'))).toBe(
      'No context set',
    );
  });

  it('gives the moderator an editable row carrying the whole context text', async () => {
    // The moderator row is a text input, which is single-line by definition, so
    // the multi-line, unclipped half of R7.17 is carried by the read-only
    // display above. What matters here is that the editor holds the complete
    // text rather than a truncation of it.
    const singleLineContext = LONG_CONTEXT.replace(/\n/g, ' ');
    const harness = await renderBoard({ moderator: true, context: singleLineContext });
    const input = harness.root.querySelector('.retro-board__context-input') as HTMLInputElement;

    expect(harness.root.querySelector('.retro-board__context-display')).toBeNull();
    expect(input.getAttribute('aria-label')).toBe('Sprint context');
    expect(input.value).toBe(singleLineContext);
  });
});

// --- Card composition (R7.18) ------------------------------------------------------

describe('card parts each take their own band (R7.18)', () => {
  const EMPTY_TEXT = '';
  const MAX_TEXT = 'a'.repeat(2000);

  it('stacks the card parts in a single column', () => {
    expect(declared(RetroCardComponent, '.retro-card', 'display')).toBe('flex');
    expect(declared(RetroCardComponent, '.retro-card', 'flex-direction')).toBe('column');

    // The text area is the only part that can overflow, and it scrolls inside
    // its own border box rather than over the rows below it.
    expect(declared(RetroCardComponent, '.retro-card__text', 'overflow-y')).toBe('auto');
    expect(declared(RetroCardComponent, '.retro-card__text', 'box-sizing')).toBe('border-box');
    expect(declared(RetroCardComponent, '.retro-card__author', 'display')).toBe('block');
  });

  for (const [label, text] of [
    ['0 characters', EMPTY_TEXT],
    ['2,000 characters', MAX_TEXT],
  ] as const) {
    it(`holds text, author, vote count, comment count and delete at ${label}`, async () => {
      const harness = await renderCard(text);
      const card = harness.cardEl;

      // Document order of the bands, so nothing is layered over anything else.
      expect(Array.from(card.children).map(child => child.className)).toEqual([
        'retro-card__text',
        'retro-card__author',
        'retro-card__actions',
      ]);

      const textArea = card.querySelector('.retro-card__text') as HTMLTextAreaElement;
      expect(textArea.value).toBe(text);
      expect(textArea.getAttribute('aria-label')).toBe('Card text');

      expect(textOf(card.querySelector('.retro-card__author'))).toBe('— Alice');

      const actions = card.querySelector('.retro-card__actions') as HTMLElement;
      expect(textOf(actions.querySelector('.retro-card__vote-count'))).toBe('3');
      expect(textOf(actions.querySelector('.retro-card__comment-btn'))).toBe('💬 1');
      const remove = actions.querySelector('.retro-card__delete-btn') as HTMLButtonElement;
      expect(remove.getAttribute('aria-label')).toBe('Delete card');
      expect(remove.disabled).toBe(false);

      // Every action control keeps its 32px box at both text lengths.
      for (const selector of [
        '.retro-card__vote-btn',
        '.retro-card__comment-btn',
        '.retro-card__emoji-btn',
        '.retro-card__delete-btn',
      ]) {
        expect(card.querySelector(selector), selector).not.toBeNull();
        expect(toPx(declared(RetroCardComponent, selector, 'min-width'))).toBeGreaterThanOrEqual(
          32,
        );
        expect(toPx(declared(RetroCardComponent, selector, 'min-height'))).toBeGreaterThanOrEqual(
          32,
        );
      }

      TestBed.resetTestingModule();
    });
  }

  it('appends the comment section as a further band when it is opened', async () => {
    const harness = await renderCard(MAX_TEXT);
    const comments = harness.cardEl.querySelector('.retro-card__comment-btn') as HTMLButtonElement;

    comments.click();
    await harness.settle();

    expect(Array.from(harness.cardEl.children).map(child => child.className)).toEqual([
      'retro-card__text',
      'retro-card__author',
      'retro-card__actions',
      'retro-card__comments',
    ]);
    expect(textOf(harness.cardEl.querySelector('.retro-card__comment-text'))).toContain(
      'Agreed, lets keep it',
    );
    // The comment band is separated by its own top border, not by overlap.
    expect(declared(RetroCardComponent, '.retro-card__comments', 'margin-top')).toBe('8px');
  });
});
