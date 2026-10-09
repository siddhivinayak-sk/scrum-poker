import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Component, computed, inject, signal, WritableSignal } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { EMPTY, Observable, Subject, filter, map } from 'rxjs';
import {
  RetroCard,
  RetroConfiguration,
  RetroSessionState,
  User,
  WebSocketMessage,
} from '@shared/types';
import { RetroToolbarComponent } from './retro-toolbar.component';
import { RetroCardComponent } from './retro-card.component';
import { RetroStateService } from '../../services/retro-state.service';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { RetroExportService } from '../../services/retro-export.service';
import { RetroScreenshotService } from '../../services/retro-screenshot.service';
import { ToastService } from '../../services/toast.service';
import { FeelingsService } from '../../services/feelings.service';
import { AuthService } from '../../services/auth.service';
import {
  FIXED_LINES,
  FLUID_MAX_LINES,
  FLUID_MIN_LINES,
} from '../../services/retro-card-height';

/**
 * Task 18.6 — the `fluidCardHeight` board setting.
 *
 * Two surfaces are exercised here, because the requirement spans both:
 *
 * - `RetroToolbarComponent` owns the control itself: present for a moderator and
 *   absent for everybody else, reflecting the value stored for the session at the
 *   moment the dialog opens, and routed through the existing
 *   `onSettingChange` → `sendConfigUpdate` → `retro:config:update` path
 *   (R6.10, R6.11, R6.15).
 * - the rendered board reacts to the resulting broadcast: a `retro:config:updated`
 *   message carrying a different `fluidCardHeight` re-applies the height rule to
 *   every already-rendered card, in place, with no re-navigation (R6.16).
 *
 * The second block therefore runs against the *real* `RetroStateService`, fed through
 * a `Subject`-backed stand-in for the socket, so the broadcast travels the same path
 * it does in the application.
 */

// --- Shared fixtures ---------------------------------------------------------------

const OWNER_ID = 'user-moderator';

const MODERATOR: User = {
  id: OWNER_ID,
  displayName: 'Mo',
  role: 'moderator',
  isAnonymous: false,
};

function makeConfig(overrides: Partial<RetroConfiguration> = {}): RetroConfiguration {
  return {
    boardName: 'Sprint 42 retro',
    maxVotesPerUser: 6,
    templateId: 'default',
    hideCardsInitially: false,
    disableVotingInitially: false,
    hideVoteCount: false,
    oneVotePerCard: false,
    showCardAuthor: false,
    password: null,
    enableGifEmoji: true,
    columnLayout: 'vertical',
    allowedFeelings: ['Happy', 'Sad', 'No_Feeling'],
    fluidCardHeight: true,
    ...overrides,
  };
}

/** Finds the `fluidCardHeight` checkbox by its visible label text. */
function fluidHeightToggle(root: HTMLElement): HTMLInputElement | null {
  const labels = Array.from(root.querySelectorAll<HTMLElement>('.retro-settings__toggle'));
  const label = labels.find(element =>
    (element.textContent ?? '').toLowerCase().includes('fluid card height')
  );
  return label?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;
}

// --- The control in the board settings dialog ---------------------------------------

describe('fluidCardHeight board setting — the control (R6.10, R6.11, R6.15)', () => {
  let fixture: ComponentFixture<RetroToolbarComponent>;
  let component: RetroToolbarComponent;
  let configSignal: WritableSignal<RetroConfiguration | null>;
  let sendConfigUpdate: ReturnType<typeof vi.fn>;

  /** Builds the toolbar around a stored configuration, then opens the dialog. */
  function openSettings(
    storedConfig: RetroConfiguration | null,
    isModerator: boolean
  ): HTMLElement {
    configSignal = signal<RetroConfiguration | null>(storedConfig);
    sendConfigUpdate = vi.fn();

    TestBed.configureTestingModule({
      imports: [RetroToolbarComponent],
      providers: [
        {
          provide: RetroStateService,
          useValue: {
            config: configSignal.asReadonly(),
            isModerator: signal(isModerator).asReadonly(),
            isCompleted: signal(false).asReadonly(),
            cardsRevealed: signal(false).asReadonly(),
            votingEnabled: signal(false).asReadonly(),
            state: signal(null).asReadonly(),
            currentUserId: signal(OWNER_ID).asReadonly(),
          },
        },
        {
          provide: RetroWebSocketService,
          useValue: {
            send: vi.fn(),
            on: vi.fn().mockReturnValue(EMPTY),
            sendConfigUpdate,
            sendCardsReveal: vi.fn(),
            sendVotingEnable: vi.fn(),
            sendBoardComplete: vi.fn(),
            sendColumnAdd: vi.fn(),
          },
        },
        {
          provide: RetroExportService,
          useValue: {
            exportCSV: vi.fn().mockResolvedValue(undefined),
            importCSV: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: RetroScreenshotService,
          useValue: { captureBoard: vi.fn(), capturing: signal(false) },
        },
        { provide: ToastService, useValue: { show: vi.fn() } },
        {
          provide: FeelingsService,
          useValue: {
            myFeeling: signal(null).asReadonly(),
            feelings: signal({}).asReadonly(),
            selectFeeling: vi.fn(),
          },
        },
      ],
    });

    fixture = TestBed.createComponent(RetroToolbarComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('isModerator', isModerator);
    fixture.componentRef.setInput('isCompleted', false);
    fixture.detectChanges();

    // Opening the dialog is the moment the control takes its value from the store.
    component.showSettingsDialog.set(true);
    fixture.detectChanges();

    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('presents the control to a moderator, with an accessible label', () => {
    const root = openSettings(makeConfig(), true);

    const toggle = fluidHeightToggle(root);
    expect(toggle).toBeTruthy();
    expect(toggle!.type).toBe('checkbox');
    expect(toggle!.disabled).toBe(false);
  });

  it('renders the settings dialog without the control for a non-moderator', () => {
    const root = openSettings(makeConfig(), false);

    // The dialog itself is rendered …
    expect(root.querySelector('.retro-dialog--settings')).toBeTruthy();
    // … but carries no fluidCardHeight control.
    expect(fluidHeightToggle(root)).toBeNull();
  });

  it('reflects a stored value of true when the dialog opens', () => {
    const root = openSettings(makeConfig({ fluidCardHeight: true }), true);

    expect(fluidHeightToggle(root)!.checked).toBe(true);
  });

  it('reflects a stored value of false when the dialog opens', () => {
    const root = openSettings(makeConfig({ fluidCardHeight: false }), true);

    expect(fluidHeightToggle(root)!.checked).toBe(false);
  });

  it('reflects the default when the stored configuration omits the field', () => {
    const stored = makeConfig();
    delete stored.fluidCardHeight;
    const root = openSettings(stored, true);

    expect(fluidHeightToggle(root)!.checked).toBe(true);
  });

  it('sends a config update carrying true when the moderator checks the control', () => {
    const root = openSettings(makeConfig({ fluidCardHeight: false }), true);
    const toggle = fluidHeightToggle(root)!;

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(sendConfigUpdate).toHaveBeenCalledTimes(1);
    expect(sendConfigUpdate).toHaveBeenCalledWith({ fluidCardHeight: true });
  });

  it('sends a config update carrying false when the moderator clears the control', () => {
    const root = openSettings(makeConfig({ fluidCardHeight: true }), true);
    const toggle = fluidHeightToggle(root)!;

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(sendConfigUpdate).toHaveBeenCalledTimes(1);
    expect(sendConfigUpdate).toHaveBeenCalledWith({ fluidCardHeight: false });
  });

  it('leaves the other settings untouched when only the height control changes', () => {
    const root = openSettings(makeConfig({ fluidCardHeight: true }), true);
    const toggle = fluidHeightToggle(root)!;

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(Object.keys(sendConfigUpdate.mock.calls[0][0])).toEqual(['fluidCardHeight']);
  });
});

// --- The broadcast re-applying the rule to the rendered board ------------------------

/**
 * Renders every card the state service holds, so a config broadcast has to reach all of
 * them through the same `retroState.config()` the real board reads.
 */
@Component({
  selector: 'app-fluid-height-host',
  standalone: true,
  imports: [RetroCardComponent],
  template: `
    @for (card of cards(); track card.id) {
      <app-retro-card [card]="card" />
    }
  `,
})
class FluidHeightHostComponent {
  private readonly retroState = inject(RetroStateService);
  readonly cards = computed<RetroCard[]>(() =>
    this.retroState.columns().flatMap(column => column.cards)
  );
}

/** Text guaranteed to occupy `lines` rendered lines, whatever the wrap width. */
function textOfLines(lines: number): string {
  return Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join('\n');
}

const SHORT_TEXT = 'Short';
const EMPTY_TEXT = '';
/** Comfortably past FLUID_MAX_LINES so the fluid clamp lands on its maximum. */
const LONG_TEXT = textOfLines(FLUID_MAX_LINES * 3);

function makeCard(id: string, text: string, order: number): RetroCard {
  return {
    id,
    text,
    authorId: OWNER_ID,
    authorName: 'Mo',
    votes: 0,
    votedBy: [],
    comments: [],
    columnId: 'col-1',
    order,
    createdAt: '2026-05-01T00:00:00.000Z',
  };
}

/** Index order matches the render order asserted below. */
const CARDS: RetroCard[] = [
  makeCard('card-short', SHORT_TEXT, 0),
  makeCard('card-long-a', LONG_TEXT, 1),
  makeCard('card-empty', EMPTY_TEXT, 2),
  makeCard('card-long-b', LONG_TEXT, 3),
];

/** Which clamp bound each card above is expected to land on while fluid. */
const FLUID_LINES_PER_CARD = [
  FLUID_MIN_LINES,
  FLUID_MAX_LINES,
  FLUID_MIN_LINES,
  FLUID_MAX_LINES,
];

function makeState(config: RetroConfiguration): RetroSessionState {
  return {
    sessionId: 'retro-1',
    config,
    board: {
      columns: [{ id: 'col-1', name: 'Went well', cards: CARDS, order: 0 }],
      context: '',
      cardsRevealed: true,
      votingEnabled: true,
      isCompleted: false,
    },
    participants: [MODERATOR],
    ownerId: OWNER_ID,
    createdAt: '2026-05-01T00:00:00.000Z',
    votesRemaining: { [OWNER_ID]: 6 },
    feelings: {},
  };
}

describe('fluidCardHeight board setting — the broadcast (R6.16)', () => {
  let messages$: Subject<WebSocketMessage>;
  let fixture: ComponentFixture<FluidHeightHostComponent>;

  beforeEach(() => {
    messages$ = new Subject<WebSocketMessage>();

    TestBed.configureTestingModule({
      imports: [FluidHeightHostComponent],
      providers: [
        RetroStateService,
        {
          provide: RetroWebSocketService,
          useValue: {
            send: vi.fn(),
            // Same filter/map shape as the real service, so RetroStateService wires up
            // to this subject exactly as it does to a live socket.
            on: <T>(event: string): Observable<T> =>
              messages$.pipe(
                filter(message => message.event === event),
                map(message => message.data as T)
              ),
            sendCardEdit: vi.fn(),
            sendCardVote: vi.fn(),
            sendCardRemove: vi.fn(),
            sendCommentAdd: vi.fn(),
            sendCommentRemove: vi.fn(),
            sendConfigUpdate: vi.fn(),
          },
        },
        {
          provide: AuthService,
          useValue: { getCurrentUser: () => signal(MODERATOR).asReadonly() },
        },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
  }

  function broadcast(event: string, data: unknown): void {
    messages$.next({ event, data, timestamp: new Date().toISOString() });
  }

  /** The live text areas, in render order. */
  function textAreas(): HTMLTextAreaElement[] {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLTextAreaElement>(
        'textarea.retro-card__text'
      )
    );
  }

  function appliedHeights(): number[] {
    return textAreas().map(element => Number.parseFloat(element.style.height));
  }

  /** Brings the board up with the given stored value and renders every card. */
  async function renderBoard(fluidCardHeight: boolean): Promise<void> {
    // Instantiating the state service first means its subscriptions exist before the
    // first message is pushed.
    TestBed.inject(RetroStateService);
    fixture = TestBed.createComponent(FluidHeightHostComponent);
    broadcast('retro:session:state', { state: makeState(makeConfig({ fluidCardHeight })) });
    await settle();

    expect(textAreas()).toHaveLength(CARDS.length);
  }

  /**
   * Recovers the single rendered line height and the text area's vertical padding from
   * two observed heights, which lets the expectations below be written in *lines*
   * instead of pixels — the environment's own metrics stay out of the assertion.
   *
   * `height(n) = n * lineHeight + padding`, so two samples at different clamps
   * determine both unknowns.
   */
  function solveMetrics(minLinesHeightPx: number, maxLinesHeightPx: number): {
    lineHeightPx: number;
    paddingPx: number;
  } {
    const lineHeightPx =
      (maxLinesHeightPx - minLinesHeightPx) / (FLUID_MAX_LINES - FLUID_MIN_LINES);
    return {
      lineHeightPx,
      paddingPx: minLinesHeightPx - FLUID_MIN_LINES * lineHeightPx,
    };
  }

  function heightForLines(
    lines: number,
    metrics: { lineHeightPx: number; paddingPx: number }
  ): number {
    return lines * metrics.lineHeightPx + metrics.paddingPx;
  }

  it('applies the fluid rule to every card while the stored value is true', async () => {
    await renderBoard(true);

    const heights = appliedHeights();
    const metrics = solveMetrics(heights[0], heights[1]);

    // A degenerate environment would make every assertion below vacuous.
    expect(metrics.lineHeightPx).toBeGreaterThan(0);

    for (const [index, lines] of FLUID_LINES_PER_CARD.entries()) {
      expect(heights[index]).toBeCloseTo(heightForLines(lines, metrics), 5);
    }
  });

  it('re-applies the fixed rule to every rendered card when the broadcast turns it off', async () => {
    await renderBoard(true);

    const fluidHeights = appliedHeights();
    const metrics = solveMetrics(fluidHeights[0], fluidHeights[1]);
    expect(metrics.lineHeightPx).toBeGreaterThan(0);

    const elementsBefore = textAreas();
    const textsBefore = elementsBefore.map(element => element.value);

    broadcast('retro:config:updated', {
      config: makeConfig({ fluidCardHeight: false }),
    });
    await settle();

    const expectedFixed = heightForLines(FIXED_LINES, metrics);
    for (const height of appliedHeights()) {
      expect(height).toBeCloseTo(expectedFixed, 5);
    }

    // The long cards really did change — the rule was re-applied, not merely re-asserted.
    expect(appliedHeights()[1]).not.toBeCloseTo(fluidHeights[1], 5);

    // No page reload: the same elements are still mounted, carrying the same text.
    const elementsAfter = textAreas();
    expect(elementsAfter).toHaveLength(elementsBefore.length);
    elementsAfter.forEach((element, index) => {
      expect(element).toBe(elementsBefore[index]);
      expect(element.value).toBe(textsBefore[index]);
    });
  });

  it('re-applies the fluid rule to every rendered card when the broadcast turns it on', async () => {
    await renderBoard(false);

    const fixedHeights = appliedHeights();
    // Fixed height ignores the text length, so every card shares one height.
    for (const height of fixedHeights) {
      expect(height).toBeCloseTo(fixedHeights[0], 5);
    }

    const elementsBefore = textAreas();

    broadcast('retro:config:updated', {
      config: makeConfig({ fluidCardHeight: true }),
    });
    await settle();

    const fluidHeights = appliedHeights();
    const metrics = solveMetrics(fluidHeights[0], fluidHeights[1]);
    expect(metrics.lineHeightPx).toBeGreaterThan(0);

    for (const [index, lines] of FLUID_LINES_PER_CARD.entries()) {
      expect(fluidHeights[index]).toBeCloseTo(heightForLines(lines, metrics), 5);
    }
    // The fixed height sits at FIXED_LINES, so the long cards grew.
    expect(fluidHeights[1]).toBeGreaterThan(fixedHeights[1]);

    const elementsAfter = textAreas();
    elementsAfter.forEach((element, index) => {
      expect(element).toBe(elementsBefore[index]);
    });
  });

  it('leaves the applied heights alone when the broadcast repeats the current value', async () => {
    await renderBoard(true);
    const before = appliedHeights();

    broadcast('retro:config:updated', {
      config: makeConfig({ fluidCardHeight: true }),
    });
    await settle();

    expect(appliedHeights()).toEqual(before);
  });

  it('treats a broadcast configuration that omits the field as fluid', async () => {
    await renderBoard(false);
    const fixedHeights = appliedHeights();

    const withoutField = makeConfig();
    delete withoutField.fluidCardHeight;
    broadcast('retro:config:updated', { config: withoutField });
    await settle();

    const heights = appliedHeights();
    const metrics = solveMetrics(heights[0], heights[1]);
    expect(metrics.lineHeightPx).toBeGreaterThan(0);
    for (const [index, lines] of FLUID_LINES_PER_CARD.entries()) {
      expect(heights[index]).toBeCloseTo(heightForLines(lines, metrics), 5);
    }
    expect(heights[1]).toBeGreaterThan(fixedHeights[1]);
  });
});
