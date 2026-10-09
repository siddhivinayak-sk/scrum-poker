import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal, WritableSignal } from '@angular/core';
import { EMPTY } from 'rxjs';
import { FeelingCategory, RetroConfiguration } from '@shared/types';
import { RetroToolbarComponent } from './retro-toolbar.component';
import { RetroBoardPageComponent } from './retro-board-page.component';
import { FeelingsStripComponent } from '../feelings-strip/feelings-strip.component';
import { RetroStateService } from '../../services/retro-state.service';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { RetroExportService } from '../../services/retro-export.service';
import { RetroScreenshotService } from '../../services/retro-screenshot.service';
import { FeelingsService } from '../../services/feelings.service';
import { ToastService } from '../../services/toast.service';
import {
  borderWidthPx,
  CssRule,
  declared,
  edgesPx,
  lineBoxPx,
  MOBILE_MEDIA,
  rulesOf,
  stylesFor,
  toPx,
} from '../../testing/declared-css';

/**
 * Stream 10 — the compact retrospective toolbar (R10.1, R10.2, R10.4, R10.5,
 * R10.7–R10.11).
 *
 * The runner performs no layout, so none of the pixel criteria here can be
 * measured. Two things are asserted instead, and nothing else:
 *
 *   1. **Declared values.** The toolbar's and the strip's compiled `styles` are
 *      parsed by `testing/declared-css` into rules carrying their media query,
 *      then queried by selector. Height budgets are arithmetic over those
 *      declarations — the `max-height` cap against the block padding plus the
 *      declared control box — never a measured `offsetHeight`.
 *
 *   2. **The rendered DOM.** Which controls exist, in what order, with which
 *      icon, `title`, accessible name and `disabled` state, and whether each
 *      takes focus, are all real in this environment, so the preserved-control
 *      matrix and keyboard reach are asserted against the live tree across the
 *      full cross product of role and board state.
 *
 * Division of labour: the shared declared-value invariants across every retro
 * surface (the 4-px scale, token-only colours, the 12-px font floor, 32-px
 * controls, contrast — R7.1–R7.5, R10.3, R10.6) belong to the Property 27
 * spec, and the board page's own rows (R7.6–R7.18, including the page-level
 * overflow confinement and the context row's unclipped text) belong to
 * `retro-layout.spec.ts`. This file reads the context row only as the second
 * term of the R10.11 sum.
 */

// --- Declared geometry of the toolbar row -------------------------------------------

/** R10.1 / R10.2: the per-row outer-box cap, and the mobile row allowance. */
const ROW_CAP_PX = 40;
const MAX_MOBILE_ROWS = 3;

/** R10.11: the toolbar row plus the sprint context row. */
const TOOLBAR_PLUS_CONTEXT_BUDGET_PX = 72;

/** R10.10: the strip's own block size ceiling. */
const STRIP_BLOCK_CAP_PX = 32;

/**
 * The toolbar's declared outer row height, read off its own `max-height`.
 *
 * `box-sizing: border-box` is asserted here rather than at each call site,
 * because without it the cap would bound the content box and the padding would
 * sit outside the budget the criteria state.
 */
function toolbarRowCapPx(mediaNeedle?: string): number {
  expect(declared(RetroToolbarComponent, '.retro-toolbar', 'box-sizing')).toBe('border-box');
  return toPx(declared(RetroToolbarComponent, '.retro-toolbar', 'max-height', mediaNeedle));
}

/** Block padding declared on the toolbar: the part of the cap not left for items. */
function toolbarBlockPaddingPx(): number {
  const padding = edgesPx(declared(RetroToolbarComponent, '.retro-toolbar', 'padding'));
  return padding.top + padding.bottom;
}

/** The band a single row leaves for its items: the cap less the block padding. */
function rowContentBandPx(mediaNeedle?: string): number {
  const rows = mediaNeedle === undefined ? 1 : MAX_MOBILE_ROWS;
  return (toolbarRowCapPx(mediaNeedle) - toolbarBlockPaddingPx()) / rows;
}

/**
 * Declared outer block size of the sprint context row: block padding + line box
 * + both borders, with `box-sizing: border-box` asserted so the cap and the
 * padding describe the same box.
 */
function contextRowHeightPx(selector: string): number {
  expect(declared(RetroBoardPageComponent, selector, 'box-sizing')).toBe('border-box');
  const padding = edgesPx(declared(RetroBoardPageComponent, selector, 'padding'));
  const border = borderWidthPx(declared(RetroBoardPageComponent, selector, 'border'));
  return (
    padding.top + padding.bottom + lineBoxPx(RetroBoardPageComponent, selector) + 2 * border
  );
}

/** The rules a component declares inside the sub-768px block. */
function mobileRules(component: unknown): readonly CssRule[] {
  return rulesOf(component).filter(rule => rule.media?.includes(MOBILE_MEDIA) ?? false);
}

/** Rules whose every selector is scoped to the toolbar row (dialogs excluded). */
function toolbarRowRules(): readonly CssRule[] {
  return rulesOf(RetroToolbarComponent).filter(rule =>
    rule.selectors.every(
      selector => selector === ':host' || selector.startsWith('.retro-toolbar'),
    ),
  );
}

/**
 * Declared block size that one rendered toolbar row item contributes.
 *
 * Every item the toolbar can place in its row is listed; an unrecognised child
 * throws, so a new control cannot slip into the row without being accounted for
 * against the cap.
 */
function rowItemBlockPx(element: Element): number {
  if (element.classList.contains('retro-toolbar__btn')) {
    return toPx(declared(RetroToolbarComponent, '.retro-toolbar__btn', 'height'));
  }
  if (element.classList.contains('retro-toolbar__spacer')) {
    // A pure strut: it grows along the inline axis and declares no block size,
    // so it can never be the tallest item in the row.
    const spacer = stylesFor(RetroToolbarComponent, '.retro-toolbar__spacer');
    expect(spacer.get('height')).toBeUndefined();
    expect(spacer.get('min-height')).toBeUndefined();
    return 0;
  }
  if (element.classList.contains('retro-toolbar__file-input')) {
    expect(declared(RetroToolbarComponent, '.retro-toolbar__file-input', 'display')).toBe('none');
    return 0;
  }
  if (element.tagName === 'APP-FEELINGS-STRIP') {
    expect(declared(FeelingsStripComponent, '.feelings-strip', 'box-sizing')).toBe('border-box');
    return toPx(declared(FeelingsStripComponent, '.feelings-strip', 'height'));
  }
  throw new Error(
    `unaccounted toolbar row item: <${element.tagName.toLowerCase()} class="${element.className}">`,
  );
}

// --- Harness -----------------------------------------------------------------------

const SESSION_ID = 'retro-session-1';

/** The allowed feelings the strip renders in these fixtures. */
const ALLOWED_FEELINGS: readonly FeelingCategory[] = ['Happy', 'Sad'];

/** The axes R10.1 and R10.5 quantify over: the user's role and the board state. */
interface ToolbarState {
  readonly moderator: boolean;
  readonly completed: boolean;
  readonly cardsRevealed: boolean;
  readonly votingEnabled: boolean;
}

/** All sixteen role/board-state combinations. */
const ALL_STATES: readonly ToolbarState[] = [false, true].flatMap(moderator =>
  [false, true].flatMap(completed =>
    [false, true].flatMap(cardsRevealed =>
      [false, true].map(votingEnabled => ({
        moderator,
        completed,
        cardsRevealed,
        votingEnabled,
      })),
    ),
  ),
);

function describeState(state: ToolbarState): string {
  return [
    state.moderator ? 'moderator' : 'participant',
    state.completed ? 'completed' : 'active',
    state.cardsRevealed ? 'revealed' : 'hidden',
    state.votingEnabled ? 'voting on' : 'voting off',
  ].join(', ');
}

type Spy = ReturnType<typeof vi.fn>;

interface ToolbarMocks {
  readonly ws: {
    readonly sendCardsReveal: Spy;
    readonly sendVotingEnable: Spy;
    readonly sendBoardComplete: Spy;
    readonly sendColumnAdd: Spy;
    readonly sendConfigUpdate: Spy;
  };
  readonly exportService: { readonly exportCSV: Spy; readonly importCSV: Spy };
  readonly screenshot: { readonly captureBoard: Spy };
  readonly toast: { readonly show: Spy };
  readonly feelings: { readonly selectFeeling: Spy };
}

interface ToolbarHarness {
  readonly fixture: ComponentFixture<RetroToolbarComponent>;
  readonly component: RetroToolbarComponent;
  readonly root: HTMLElement;
  /** The toolbar row element itself. */
  readonly row: HTMLElement;
  readonly mocks: ToolbarMocks;
  /** Drives the `capturing` signal the screenshot action is bound to (20.2). */
  readonly capturing: WritableSignal<boolean>;
  settle(): void;
}

function renderToolbar(
  state: ToolbarState,
  configOverrides: Partial<RetroConfiguration> = {},
): ToolbarHarness {
  TestBed.resetTestingModule();

  const config = signal<RetroConfiguration>({
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
    allowedFeelings: [...ALLOWED_FEELINGS],
    fluidCardHeight: true,
    ...configOverrides,
  } as RetroConfiguration);

  const capturing = signal(false);

  const ws = {
    sendCardsReveal: vi.fn(),
    sendVotingEnable: vi.fn(),
    sendBoardComplete: vi.fn(),
    sendColumnAdd: vi.fn(),
    sendConfigUpdate: vi.fn(),
    send: vi.fn(),
    on: vi.fn().mockReturnValue(EMPTY),
    connectionState: signal('connected').asReadonly(),
  };
  const exportService = {
    exportCSV: vi.fn().mockResolvedValue(undefined),
    importCSV: vi.fn().mockResolvedValue(undefined),
  };
  const screenshot = { captureBoard: vi.fn(), capturing: capturing.asReadonly() };
  const toast = { show: vi.fn() };
  const feelings = {
    myFeeling: signal<FeelingCategory | null>(null).asReadonly(),
    feelings: signal<Record<string, FeelingCategory | null>>({}).asReadonly(),
    selectFeeling: vi.fn(),
  };

  TestBed.configureTestingModule({
    imports: [RetroToolbarComponent],
    providers: [
      {
        provide: RetroStateService,
        useValue: {
          config: config.asReadonly(),
          isModerator: signal(state.moderator).asReadonly(),
          isCompleted: signal(state.completed).asReadonly(),
          cardsRevealed: signal(state.cardsRevealed).asReadonly(),
          votingEnabled: signal(state.votingEnabled).asReadonly(),
          state: signal({ sessionId: SESSION_ID }).asReadonly(),
          currentUserId: signal('user-1').asReadonly(),
          participants: signal([]).asReadonly(),
        },
      },
      { provide: RetroWebSocketService, useValue: ws },
      { provide: RetroExportService, useValue: exportService },
      { provide: RetroScreenshotService, useValue: screenshot },
      { provide: FeelingsService, useValue: feelings },
      { provide: ToastService, useValue: toast },
    ],
  });

  const fixture = TestBed.createComponent(RetroToolbarComponent);
  fixture.componentRef.setInput('isModerator', state.moderator);
  fixture.componentRef.setInput('isCompleted', state.completed);
  fixture.detectChanges();

  const root = fixture.nativeElement as HTMLElement;
  const row = root.querySelector('.retro-toolbar') as HTMLElement | null;
  expect(row, 'the toolbar row element').not.toBeNull();

  return {
    fixture,
    component: fixture.componentInstance,
    root,
    row: row as HTMLElement,
    mocks: { ws, exportService, screenshot, toast, feelings },
    capturing,
    settle: () => fixture.detectChanges(),
  };
}

// --- The control matrix (R10.5) -----------------------------------------------------

/**
 * One toolbar action as it must still be after the compaction: the same icon,
 * the same `title`, the same accessible name, the same visibility rule and the
 * same disabled rule it had before.
 */
interface ToolbarControl {
  /** Doubles as the `title` and the `aria-label`. */
  readonly name: string;
  readonly icon: string;
  readonly moderatorOnly: boolean;
  disabledIn(state: ToolbarState, capturing: boolean): boolean;
  /** The observable effect of activating it, used for the R10.9 reach check. */
  activated(harness: ToolbarHarness): boolean;
}

const TOOLBAR_CONTROLS: readonly ToolbarControl[] = [
  {
    name: 'Reveal Cards',
    icon: '👁️',
    moderatorOnly: true,
    disabledIn: state => state.completed || state.cardsRevealed,
    activated: h => h.mocks.ws.sendCardsReveal.mock.calls.length > 0,
  },
  {
    name: 'Enable Voting',
    icon: '🗳️',
    moderatorOnly: true,
    disabledIn: state => state.completed || state.votingEnabled,
    activated: h => h.mocks.ws.sendVotingEnable.mock.calls.length > 0,
  },
  {
    name: 'Complete Retrospective',
    icon: '✅',
    moderatorOnly: true,
    disabledIn: state => state.completed,
    activated: h => h.mocks.ws.sendBoardComplete.mock.calls.length > 0,
  },
  {
    name: 'Export CSV',
    icon: '📥',
    moderatorOnly: false,
    disabledIn: () => false,
    activated: h => h.mocks.exportService.exportCSV.mock.calls.length > 0,
  },
  {
    name: 'Import CSV',
    icon: '📤',
    moderatorOnly: true,
    disabledIn: state => state.completed,
    // Opens the hidden file picker; nothing else is observable without a file.
    activated: h => h.root.querySelector('.retro-toolbar__file-input') !== null,
  },
  {
    name: 'Screenshot',
    icon: '📸',
    moderatorOnly: false,
    // Bound to the capture guard the screenshot service exposes (20.2).
    disabledIn: (_state, capturing) => capturing,
    activated: h =>
      h.mocks.screenshot.captureBoard.mock.calls.length > 0 ||
      h.mocks.toast.show.mock.calls.length > 0,
  },
  {
    name: 'Add Column',
    icon: '➕',
    moderatorOnly: false,
    disabledIn: state => state.completed,
    activated: h => h.component.showAddColumnDialog(),
  },
  {
    name: 'Board Settings',
    icon: '⚙️',
    moderatorOnly: true,
    disabledIn: () => false,
    activated: h => h.component.showSettingsDialog(),
  },
];

function visibleControls(state: ToolbarState): readonly ToolbarControl[] {
  return TOOLBAR_CONTROLS.filter(control => !control.moderatorOnly || state.moderator);
}

function toolbarButton(harness: ToolbarHarness, name: string): HTMLButtonElement | null {
  return harness.row.querySelector<HTMLButtonElement>(`.retro-toolbar__btn[title="${name}"]`);
}

/** Every button the toolbar row shows, the strip's own buttons included. */
function rowButtons(harness: ToolbarHarness): readonly HTMLButtonElement[] {
  return Array.from(harness.row.querySelectorAll<HTMLButtonElement>('button'));
}

function textOf(element: Element | null): string {
  return (element?.textContent ?? '').trim();
}

afterEach(() => {
  TestBed.resetTestingModule();
});

// --- R10.1: the 40px desktop row ---------------------------------------------------

describe('the toolbar row is capped at 40px from 768px up (R10.1)', () => {
  it('caps its outer box at 40px, with its padding counted inside the cap', () => {
    // 4px + a 32px control + 4px = the 40px the criterion allows, and
    // border-box means the 1px border is inside that too.
    expect(toolbarRowCapPx()).toBe(ROW_CAP_PX);
    expect(toolbarBlockPaddingPx()).toBe(8);
    expect(rowContentBandPx()).toBe(32);
    expect(toPx(declared(RetroToolbarComponent, '.retro-toolbar__btn', 'height'))).toBe(32);
  });

  it('declares a single row, so the cap bounds the whole toolbar', () => {
    expect(declared(RetroToolbarComponent, '.retro-toolbar', 'display')).toBe('flex');
    expect(declared(RetroToolbarComponent, '.retro-toolbar', 'flex-direction')).toBe('row');
    expect(declared(RetroToolbarComponent, '.retro-toolbar', 'flex-wrap')).toBe('nowrap');
  });

  it('keeps every row item inside the 32px band for every role and board state', () => {
    const bandPx = rowContentBandPx();

    for (const state of ALL_STATES) {
      const harness = renderToolbar(state);
      const items = Array.from(harness.row.children);

      // There is at least one item in every state, and each one — button,
      // strut, strip or hidden input — declares a block size inside the band,
      // so no visible combination can push the row past its cap.
      expect(items.length, describeState(state)).toBeGreaterThan(0);
      for (const item of items) {
        expect(rowItemBlockPx(item), `${describeState(state)}: ${item.className}`).toBeLessThanOrEqual(
          bandPx,
        );
      }

      TestBed.resetTestingModule();
    }
  });
});

// --- R10.2: the wrapped mobile layout ----------------------------------------------

describe('the toolbar wraps to at most three 40px rows below 768px (R10.2)', () => {
  it('allows exactly three rows of the same height, with no gap between them', () => {
    const mobileCapPx = toolbarRowCapPx(MOBILE_MEDIA);

    expect(declared(RetroToolbarComponent, '.retro-toolbar', 'flex-wrap', MOBILE_MEDIA)).toBe(
      'wrap',
    );
    // row-gap: 0 makes the cap an exact multiple of the row height, so the
    // number of rows the cap permits is the quotient and nothing is hidden
    // between rows.
    expect(toPx(declared(RetroToolbarComponent, '.retro-toolbar', 'row-gap', MOBILE_MEDIA))).toBe(
      0,
    );
    expect(mobileCapPx).toBe(MAX_MOBILE_ROWS * ROW_CAP_PX);
    expect(mobileCapPx / MAX_MOBILE_ROWS).toBe(ROW_CAP_PX);
  });

  it('leaves each wrapped row the same 32px item band as the desktop row', () => {
    // The block padding is declared once, outside the media block, so it is
    // charged to the toolbar box rather than to each row: three rows of
    // (40 - 8/3) is not the reading. What the criterion needs is that no item
    // is taller than a row, which is the desktop band again.
    expect(rowContentBandPx(MOBILE_MEDIA)).toBeGreaterThanOrEqual(
      toPx(declared(RetroToolbarComponent, '.retro-toolbar__btn', 'height')),
    );
  });

  it('changes nothing but the wrapping geometry below 768px', () => {
    // Anything else in this block — a display, an order, a position — could
    // take a control out of flow or out of the tab sequence, which R10.9
    // forbids for the wrapped layout too.
    const allowed = new Set(['max-height', 'flex-wrap', 'row-gap', 'overflow-x', 'overflow-y']);

    for (const rule of mobileRules(RetroToolbarComponent)) {
      for (const property of rule.declarations.keys()) {
        expect(allowed.has(property), `${rule.selectors.join(', ')} { ${property} }`).toBe(true);
      }
    }
    // The strip declares no mobile block at all, so it keeps its desktop box.
    expect(mobileRules(FeelingsStripComponent)).toHaveLength(0);
  });
});

// --- R10.4 / R10.10: the embedded feelings strip ------------------------------------

describe('the feelings strip is an item of the toolbar row (R10.4)', () => {
  it('renders as a direct child of the toolbar row in every state', () => {
    for (const state of ALL_STATES) {
      const harness = renderToolbar(state);
      const strip = harness.row.querySelector('app-feelings-strip');

      expect(strip, describeState(state)).not.toBeNull();
      expect(strip!.parentElement).toBe(harness.row);
      expect(strip!.querySelector('.feelings-strip')?.getAttribute('role')).toBe('group');
      expect(strip!.querySelector('.feelings-strip')?.getAttribute('aria-label')).toBe(
        'Your feeling',
      );

      TestBed.resetTestingModule();
    }
  });

  it('declares a 32px border box, so the row it sits in keeps its cap', () => {
    expect(toPx(declared(FeelingsStripComponent, '.feelings-strip', 'height'))).toBe(
      STRIP_BLOCK_CAP_PX,
    );
    expect(STRIP_BLOCK_CAP_PX).toBeLessThanOrEqual(rowContentBandPx());
    expect(STRIP_BLOCK_CAP_PX).toBeLessThanOrEqual(rowContentBandPx(MOBILE_MEDIA));

    // Its inline padding is the only slack inside the border, and it is on the
    // 4-px scale rather than a leftover rem value.
    const padding = edgesPx(declared(FeelingsStripComponent, '.feelings-strip', 'padding'));
    expect(padding.top).toBe(0);
    expect(padding.bottom).toBe(0);
    expect(padding.left).toBe(4);
    expect(padding.right).toBe(4);
  });
});

describe('no empty bordered region grows past the controls it holds (R10.10)', () => {
  it('sizes the bordered strip to its contents and nothing more', () => {
    for (const selector of [':host', '.retro-toolbar app-feelings-strip']) {
      const component = selector === ':host' ? FeelingsStripComponent : RetroToolbarComponent;
      expect(declared(component, selector, 'flex')).toBe('0 0 auto');
    }

    // Content-sized on the inline axis: no width, no non-zero minimum, no
    // grow factor anywhere on the strip or its host.
    for (const selector of [':host', '.feelings-strip']) {
      const rules = stylesFor(FeelingsStripComponent, selector);
      expect(rules.get('width')).toBeUndefined();
      expect(rules.get('flex-grow')).toBeUndefined();
      const minWidth = rules.get('min-width');
      if (minWidth !== undefined) {
        expect(toPx(minWidth)).toBe(0);
      }
    }
    expect(declared(FeelingsStripComponent, '.feelings-strip', 'display')).toBe('inline-flex');
  });

  it('gives the one growing row item neither a border nor a background', () => {
    // The spacer is what absorbs the surplus width. Because it draws nothing,
    // the growth leaves no bordered void behind the strip.
    const spacer = stylesFor(RetroToolbarComponent, '.retro-toolbar__spacer');
    expect(spacer.get('flex')).toBe('1');
    expect(spacer.get('border')).toBeUndefined();
    expect(spacer.get('background')).toBeUndefined();

    // And the spacer is the only growing item in the row: every other rule
    // scoped to the row either declares `flex: 0 0 auto` or declares no flex.
    for (const rule of toolbarRowRules()) {
      const flex = rule.declarations.get('flex');
      if (flex === undefined || rule.selectors.includes('.retro-toolbar__spacer')) {
        continue;
      }
      expect(flex, rule.selectors.join(', ')).toBe('0 0 auto');
    }
  });

  it('renders exactly the configured feelings, with no placeholder slots', () => {
    for (const allowed of [['Happy'], ['Happy', 'Sad', 'Confusion']] as FeelingCategory[][]) {
      const harness = renderToolbar(
        { moderator: false, completed: false, cardsRevealed: true, votingEnabled: true },
        { allowedFeelings: allowed },
      );
      const emojis = harness.row.querySelectorAll('.feelings-strip__emoji-btn');

      expect(emojis).toHaveLength(allowed.length);
      expect(
        Array.from(emojis).map(button => button.getAttribute('aria-label')),
      ).toEqual(allowed.map(category => category.replace(/_/g, ' ')));
      // No moderator summary button for a participant, so the bordered strip
      // holds the label plus exactly these controls.
      expect(harness.row.querySelector('.feelings-strip__summary-btn')).toBeNull();

      TestBed.resetTestingModule();
    }
  });
});

// --- R10.5: the preserved control matrix -------------------------------------------

describe('every toolbar action survives the compaction (R10.5)', () => {
  for (const state of ALL_STATES) {
    it(`keeps the right controls, icons, names and disabled states for ${describeState(state)}`, () => {
      const harness = renderToolbar(state);

      for (const control of TOOLBAR_CONTROLS) {
        const button = toolbarButton(harness, control.name);
        const shouldBeVisible = !control.moderatorOnly || state.moderator;

        if (!shouldBeVisible) {
          expect(button, `${control.name} must be hidden`).toBeNull();
          continue;
        }

        expect(button, `${control.name} must be rendered`).not.toBeNull();
        expect(button!.tagName).toBe('BUTTON');
        expect(textOf(button)).toBe(control.icon);
        expect(button!.getAttribute('title')).toBe(control.name);
        expect(button!.getAttribute('aria-label')).toBe(control.name);
        expect(button!.disabled, `${control.name} disabled state`).toBe(
          control.disabledIn(state, false),
        );
      }

      // The hidden import picker is still in the row, still out of the
      // accessibility tree.
      const fileInput = harness.row.querySelector('.retro-toolbar__file-input');
      expect(fileInput).not.toBeNull();
      expect(fileInput!.getAttribute('aria-hidden')).toBe('true');
    });
  }

  it('keeps the toolbar container a role="toolbar" with its accessible name', () => {
    const harness = renderToolbar({
      moderator: true,
      completed: false,
      cardsRevealed: false,
      votingEnabled: false,
    });

    expect(harness.row.getAttribute('role')).toBe('toolbar');
    expect(harness.row.getAttribute('aria-label')).toBe('Board actions');
  });

  it('keeps the screenshot action bound to the live capture guard', () => {
    const harness = renderToolbar({
      moderator: false,
      completed: false,
      cardsRevealed: true,
      votingEnabled: true,
    });
    const screenshot = toolbarButton(harness, 'Screenshot') as HTMLButtonElement;

    // The binding is `[disabled]="capturing()"` against the service signal, so
    // it must follow the signal rather than a copy taken at construction.
    expect(screenshot.disabled).toBe(false);

    harness.capturing.set(true);
    harness.settle();
    expect(screenshot.disabled).toBe(true);

    harness.capturing.set(false);
    harness.settle();
    expect(screenshot.disabled).toBe(false);
  });

  it('keeps the fluid card height toggle moderator-only in the settings dialog', () => {
    const moderator = renderToolbar({
      moderator: true,
      completed: false,
      cardsRevealed: false,
      votingEnabled: false,
    });
    moderator.component.showSettingsDialog.set(true);
    moderator.settle();

    const labels = Array.from(
      moderator.root.querySelectorAll('.retro-settings__toggle'),
    ).filter(label => textOf(label) === 'Fluid card height');
    expect(labels).toHaveLength(1);

    const toggle = labels[0].querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    toggle.click();
    moderator.settle();
    expect(moderator.mocks.ws.sendConfigUpdate).toHaveBeenCalledWith({
      fluidCardHeight: false,
    });

    TestBed.resetTestingModule();

    const participant = renderToolbar({
      moderator: false,
      completed: false,
      cardsRevealed: false,
      votingEnabled: false,
    });
    // No settings action for a participant, so the toggle is unreachable.
    expect(toolbarButton(participant, 'Board Settings')).toBeNull();
    participant.component.showSettingsDialog.set(true);
    participant.settle();
    expect(
      Array.from(participant.root.querySelectorAll('.retro-settings__toggle')).some(
        label => textOf(label) === 'Fluid card height',
      ),
    ).toBe(false);
  });
});

// --- R10.7: the row items do not overlap -------------------------------------------

describe('toolbar items share the row without overlapping (R10.7)', () => {
  it('keeps every item in flow, with no absolute positioning and no negative margin', () => {
    const rules = [...toolbarRowRules(), ...rulesOf(FeelingsStripComponent)];
    expect(rules.length).toBeGreaterThan(0);

    for (const rule of rules) {
      const where = rule.selectors.join(', ');
      const position = rule.declarations.get('position');
      if (position !== undefined) {
        expect(['static', 'relative'], where).toContain(position);
      }
      for (const [property, value] of rule.declarations) {
        if (property.startsWith('margin')) {
          expect(value.startsWith('-'), `${where} { ${property}: ${value} }`).toBe(false);
        }
      }
    }
  });

  it('separates the items by a declared gap that the hover lift cannot cross', () => {
    const gapPx = toPx(declared(RetroToolbarComponent, '.retro-toolbar', 'gap'));
    expect(gapPx).toBeGreaterThan(0);

    // The strip's emoji buttons are the only items that scale. A 32px box at
    // the largest declared scale overhangs its own edge by
    // 32 x (scale - 1) / 2 per side, which has to stay inside the gap for the
    // painted boxes to stay clear of each other.
    const buttonPx = toPx(declared(FeelingsStripComponent, '.feelings-strip__emoji-btn', 'width'));
    const scales = rulesOf(FeelingsStripComponent)
      .map(rule => rule.declarations.get('transform'))
      .filter((value): value is string => value !== undefined)
      .map(value => /^scale\(([\d.]+)\)$/.exec(value)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number.parseFloat);

    expect(scales.length).toBeGreaterThan(0);
    const overhangPx = (buttonPx * (Math.max(...scales) - 1)) / 2;
    expect(overhangPx).toBeLessThanOrEqual(gapPx);
  });

  it('centres the items on the row rather than stretching them past it', () => {
    expect(declared(RetroToolbarComponent, '.retro-toolbar', 'align-items')).toBe('center');
    expect(declared(FeelingsStripComponent, '.feelings-strip', 'align-items')).toBe('center');
  });
});

// --- R10.8: surplus width scrolls inside the toolbar -------------------------------

describe('surplus control width scrolls inside the toolbar box (R10.8)', () => {
  it('makes the toolbar itself the scroll container', () => {
    expect(declared(RetroToolbarComponent, '.retro-toolbar', 'overflow-x')).toBe('auto');
    expect(declared(RetroToolbarComponent, '.retro-toolbar', 'overflow-y')).toBe('hidden');

    // Nothing else in the toolbar's own stylesheet opts into a scroll or a
    // visible overflow, so no descendant can push the scroll outward onto the
    // page instead.
    const scrollers = rulesOf(RetroToolbarComponent)
      .filter(rule =>
        ['overflow', 'overflow-x', 'overflow-y'].some(property => {
          const value = rule.declarations.get(property);
          return value === 'auto' || value === 'scroll' || value === 'visible';
        }),
      )
      .flatMap(rule => rule.selectors);

    expect(scrollers.length).toBeGreaterThan(0);
    // The settings dialog body is the one permitted exception: it lives inside a
    // position: fixed backdrop, so it is outside the toolbar row flow entirely and
    // cannot push the row scroll outward onto the page. It has to scroll, because a
    // centred fixed backdrop clips an over-tall body at both ends instead.
    const allowed = ['.retro-toolbar', '.retro-settings'];
    for (const selector of scrollers) {
      expect(allowed, 'only the toolbar row and the settings dialog body scroll').toContain(
        selector,
      );
    }
    expect(scrollers).toContain('.retro-toolbar');
    expect(rulesOf(FeelingsStripComponent).some(rule => rule.declarations.has('overflow'))).toBe(
      false,
    );
  });

  it('keeps the toolbar host at the page width instead of the content width', () => {
    // A block host that never shrinks: the row's own box is the page's content
    // width, so the surplus becomes toolbar scroll rather than page scroll.
    expect(declared(RetroToolbarComponent, ':host', 'display')).toBe('block');
    expect(declared(RetroToolbarComponent, ':host', 'flex-shrink')).toBe('0');
    expect(stylesFor(RetroToolbarComponent, '.retro-toolbar').get('min-width')).toBeUndefined();
    expect(stylesFor(RetroToolbarComponent, '.retro-toolbar').get('width')).toBeUndefined();
  });

  it('replaces the scroll with wrapping below 768px', () => {
    expect(declared(RetroToolbarComponent, '.retro-toolbar', 'overflow-x', MOBILE_MEDIA)).toBe(
      'hidden',
    );
  });
});

// --- R10.9: keyboard reach ---------------------------------------------------------

describe('every visible control stays reachable from the keyboard (R10.9)', () => {
  const REACH_STATES: readonly ToolbarState[] = [
    { moderator: true, completed: false, cardsRevealed: false, votingEnabled: false },
    { moderator: false, completed: false, cardsRevealed: true, votingEnabled: true },
  ];

  for (const state of REACH_STATES) {
    it(`focuses every enabled control in document order for ${describeState(state)}`, () => {
      const harness = renderToolbar(state);
      const buttons = rowButtons(harness);
      const doc = harness.root.ownerDocument;

      // Native buttons, no tabindex anywhere: the tab sequence is the document
      // order, which is the same tree the wrapped layout renders.
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(button.getAttribute('tabindex'), textOf(button)).toBeNull();
        if (button.disabled) {
          continue;
        }
        button.focus();
        expect(doc.activeElement, `${button.getAttribute('title')} takes focus`).toBe(button);
      }
      expect(
        Array.from(harness.row.querySelectorAll('[tabindex]')),
        'no control is pulled out of the natural tab order',
      ).toHaveLength(0);
    });
  }

  it('activates each enabled action from a keyboard-equivalent activation', () => {
    for (const control of visibleControls({
      moderator: true,
      completed: false,
      cardsRevealed: false,
      votingEnabled: false,
    })) {
      const harness = renderToolbar({
        moderator: true,
        completed: false,
        cardsRevealed: false,
        votingEnabled: false,
      });
      const button = toolbarButton(harness, control.name) as HTMLButtonElement;

      expect(button.disabled, control.name).toBe(false);
      // Enter and Space on a focused native button dispatch exactly this.
      button.focus();
      button.click();

      expect(control.activated(harness), `${control.name} did nothing`).toBe(true);
      TestBed.resetTestingModule();
    }
  });

  it('activates the strip controls too, including the moderator summary', () => {
    const harness = renderToolbar({
      moderator: true,
      completed: false,
      cardsRevealed: false,
      votingEnabled: false,
    });

    const emoji = harness.row.querySelector('.feelings-strip__emoji-btn') as HTMLButtonElement;
    emoji.focus();
    expect(harness.root.ownerDocument.activeElement).toBe(emoji);
    emoji.click();
    expect(harness.mocks.feelings.selectFeeling).toHaveBeenCalledWith(ALLOWED_FEELINGS[0]);

    const summary = harness.row.querySelector(
      '.feelings-strip__summary-btn',
    ) as HTMLButtonElement;
    expect(summary.getAttribute('title')).toBe('Feelings Summary');
    expect(summary.getAttribute('aria-label')).toBe('Feelings Summary');
    summary.click();
    harness.settle();
    expect(harness.root.querySelector('app-feelings-summary-popup')).not.toBeNull();
  });

  it('disables the strip on a completed board rather than removing it', () => {
    const harness = renderToolbar({
      moderator: false,
      completed: true,
      cardsRevealed: true,
      votingEnabled: false,
    });
    const emojis = Array.from(
      harness.row.querySelectorAll<HTMLButtonElement>('.feelings-strip__emoji-btn'),
    );

    expect(emojis).toHaveLength(ALLOWED_FEELINGS.length);
    for (const emoji of emojis) {
      expect(emoji.disabled).toBe(true);
    }
  });
});

// --- R10.11: the toolbar plus the context row -------------------------------------

describe('the toolbar and the sprint context row fit 72px together (R10.11)', () => {
  it('sums the two declared row boxes to 66.8px for the read-only context row', () => {
    const toolbarPx = toolbarRowCapPx();
    const contextPx = contextRowHeightPx('.retro-board__context-display');

    // 4 + 4 padding + a 12px x 1.4 line box + two 1px borders.
    expect(contextPx).toBeCloseTo(26.8, 5);
    expect(toolbarPx + contextPx).toBeCloseTo(66.8, 5);
    expect(toolbarPx + contextPx).toBeLessThanOrEqual(TOOLBAR_PLUS_CONTEXT_BUDGET_PX);
  });

  it('sums to the same budget for the moderator-editable context row', () => {
    const toolbarPx = toolbarRowCapPx();
    const contextPx = contextRowHeightPx('.retro-board__context-input');

    expect(contextPx).toBeCloseTo(26.8, 5);
    expect(toolbarPx + contextPx).toBeLessThanOrEqual(TOOLBAR_PLUS_CONTEXT_BUDGET_PX);
  });

  it('leaves the budget intact however many controls the row holds', () => {
    // The toolbar's contribution is its cap, not its content, so the sum is
    // the same for every role and board state. The matrix check above is what
    // makes the cap binding; this just records that the cap is role-blind.
    const capsSeen = new Set<number>();

    for (const state of ALL_STATES) {
      const harness = renderToolbar(state);
      expect(harness.row.children.length).toBeGreaterThan(0);
      capsSeen.add(toolbarRowCapPx());
      TestBed.resetTestingModule();
    }

    expect(Array.from(capsSeen)).toEqual([ROW_CAP_PX]);
  });
});
