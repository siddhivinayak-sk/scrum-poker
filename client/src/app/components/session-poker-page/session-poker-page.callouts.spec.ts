/**
 * Page wiring of the Vote_Callout_Layer on the poker session page (vote-reveal-fun-callouts,
 * task 14.3; R7.5, R7.12, R9.4, R11.11, R11.12 and the page-side half of R6.8, R6.10).
 *
 * Two suites share one fixture builder:
 *  - structure and inputs, with the layer stubbed like the other page specs, so the assertions are
 *    about WHERE the page puts the layer and WHAT it passes in;
 *  - countdown behaviour, with the REAL layer hosted by the page, because hiding and restoring the
 *    callouts is the layer's decision and only observable through the page that feeds it.
 *
 * The test DOM performs no layout, so paint order and stacking are not asserted here; DOM order and
 * ancestry are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CommonModule } from '@angular/common';
import { Component, Type, input, output, signal, WritableSignal } from '@angular/core';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter, RouterLink } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Observable, Subject } from 'rxjs';
import { SessionPokerPageComponent } from './session-poker-page.component';
import { VoteCalloutLayerComponent, COUNTDOWN_DURATION_MS } from '../vote-callout/vote-callout-layer.component';
import { EXIT_REMOVAL_DEADLINE_MS } from '../vote-callout/callout-animation';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { BasePathService } from '../../services/base-path.service';
import { EstimateExportService } from '../../services/estimate-export.service';
import type {
  CalloutNoteAddedPayload,
  CalloutNoteRejectedPayload,
  ConnectionState,
  ExtendedCardValue,
  HistoryEntry,
  SessionConfiguration,
  User,
  VotingMetrics,
  VotingRound,
} from '@shared/types';

// --- Child component stubs (same set as the other page specs) ---

@Component({ selector: 'app-card-deck', standalone: true, template: '' })
class StubCardDeckComponent {}

@Component({ selector: 'app-board', standalone: true, template: '' })
class StubBoardComponent {}

@Component({ selector: 'app-story-manager', standalone: true, template: '' })
class StubStoryManagerComponent {}

@Component({ selector: 'app-metrics', standalone: true, template: '' })
class StubMetricsComponent {}

@Component({ selector: 'app-session-history', standalone: true, template: '' })
class StubSessionHistoryComponent {}

@Component({ selector: 'app-user-menu', standalone: true, template: '' })
class StubUserMenuComponent {}

@Component({ selector: 'app-qr-code', standalone: true, template: '' })
class StubQrCodeComponent {
  readonly url = input.required<string>();
}

@Component({ selector: 'app-session-settings-panel', standalone: true, template: '' })
class StubSessionSettingsPanelComponent {
  readonly sessionId = input<string>('');
  readonly config = input<SessionConfiguration | null>(null);
  readonly isGameOwner = input<boolean>(false);
  readonly isOwner = input<boolean>(false);
}

@Component({ selector: 'app-countdown-overlay', standalone: true, template: '' })
class StubCountdownOverlayComponent {
  readonly active = input<boolean>(false);
  readonly onComplete = output<void>();
}

@Component({ selector: 'app-voting-timer-display', standalone: true, template: '' })
class StubVotingTimerDisplayComponent {
  readonly startedAt = input<string | null>(null);
  readonly revealedAt = input<string | null>(null);
}

@Component({ selector: 'app-consensus-indicator', standalone: true, template: '' })
class StubConsensusIndicatorComponent {
  readonly metrics = input<VotingMetrics | null>(null);
  readonly votingSystem = input<string>('fibonacci');
}

@Component({ selector: 'app-facilitator-flow', standalone: true, template: '' })
class StubFacilitatorFlowComponent {}

@Component({ selector: 'app-issue-list-panel', standalone: true, template: '' })
class StubIssueListPanelComponent {}

@Component({ selector: 'app-connection-status', standalone: true, template: '' })
class StubConnectionStatusComponent {
  readonly state = input.required<ConnectionState>();
}

@Component({ selector: 'app-vote-callout-layer', standalone: true, template: '' })
class StubVoteCalloutLayerComponent {
  readonly sessionId = input.required<string>();
}

@Component({ selector: 'app-moderator-note-balloon', standalone: true, template: '' })
class StubModeratorNoteBalloonComponent {
  readonly sessionId = input.required<string>();
}

// --- Fixtures ---

const SESSION_ID = 'abc12345';
const ROUND_ID = 'round-1';

const OWNER: User = { id: 'owner-1', displayName: 'Owner', role: 'moderator', isAnonymous: false };
const MODERATOR: User = { id: 'mod-1', displayName: 'Mod', role: 'moderator', isAnonymous: false };
const PLAYER: User = { id: 'player-1', displayName: 'Player', role: 'participant', isAnonymous: false };

const CONFIG: SessionConfiguration = {
  votingSystem: 'fibonacci',
  revealPermission: { mode: 'all-players', allowedUserIds: [] },
  issuePermission: { mode: 'moderator-only', allowedUserIds: [] },
  autoReveal: false,
  countdownAnimation: true,
  funCallouts: true,
};

/** Fibonacci ladder, average 7: Ben, Cy and Ann are near it, Eve (the viewer) is far from it. */
const VIEWER_ID = 'eve';
const PEOPLE: readonly User[] = ['ann', 'ben', 'cy', 'dee', 'eve'].map((id) => ({
  id,
  displayName: id.charAt(0).toUpperCase() + id.slice(1),
  role: 'participant',
  isAnonymous: false,
}));
const VOTES: ReadonlyArray<readonly [string, ExtendedCardValue]> = [
  ['ann', 5],
  ['ben', 8],
  ['cy', 8],
  ['dee', 13],
  ['eve', 1],
];
const REVEALED_METRICS: VotingMetrics = {
  average: 7,
  mode: 8,
  spread: 12,
  distribution: { '1': 1, '5': 1, '8': 2, '13': 1 },
  outliers: [],
  numericVoteCount: 5,
  insufficientData: false,
};

function round(status: VotingRound['status']): VotingRound {
  return {
    id: ROUND_ID,
    storyDescription: 'Story',
    status,
    selections: new Map(),
    startedAt: '2026-05-01T10:00:00.000Z',
  };
}

function completedEstimate(): HistoryEntry {
  return {
    roundId: 'r0',
    storyDescription: 'Earlier story',
    participants: [{ userId: OWNER.id, displayName: OWNER.displayName, cardValue: 5 }],
    metrics: { ...REVEALED_METRICS, distribution: { '5': 1 }, numericVoteCount: 1 },
    completedAt: '2026-05-01T09:00:00.000Z',
  };
}

describe('SessionPokerPageComponent vote callout layer wiring', () => {
  let fixture: ComponentFixture<SessionPokerPageComponent>;
  let httpTesting: HttpTestingController;

  let currentUser: WritableSignal<User | null>;
  let ownerId: WritableSignal<string | null>;
  let sessionConfig: WritableSignal<SessionConfiguration | null>;
  let currentRound: WritableSignal<VotingRound | null>;
  let participants: WritableSignal<User[]>;
  let metrics: WritableSignal<VotingMetrics | null>;
  let selections: WritableSignal<Map<string, ExtendedCardValue>>;
  let isRevealed: WritableSignal<boolean>;
  let countdownActive: WritableSignal<boolean>;
  let hasRevealPermission: WritableSignal<boolean>;
  let connectionState: WritableSignal<ConnectionState>;

  function configure(routedSessionId: string, layer: Type<unknown>): void {
    currentUser = signal<User | null>(OWNER);
    ownerId = signal<string | null>(OWNER.id);
    sessionConfig = signal<SessionConfiguration | null>(CONFIG);
    currentRound = signal<VotingRound | null>(null);
    participants = signal<User[]>([OWNER]);
    metrics = signal<VotingMetrics | null>(null);
    selections = signal<Map<string, ExtendedCardValue>>(new Map());
    isRevealed = signal<boolean>(false);
    countdownActive = signal<boolean>(false);
    hasRevealPermission = signal<boolean>(true);
    connectionState = signal<ConnectionState>('connected');

    const added$ = new Subject<CalloutNoteAddedPayload>();
    const rejected$ = new Subject<CalloutNoteRejectedPayload>();

    TestBed.configureTestingModule({
      imports: [SessionPokerPageComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: WebSocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            send: vi.fn(),
            on: <T>(): Observable<T> => new Subject<T>().asObservable(),
            connectionState,
          },
        },
        {
          provide: AuthService,
          useValue: {
            getToken: vi.fn().mockReturnValue('test-token-123'),
            getCurrentUser: vi.fn().mockReturnValue(signal<User | null>(OWNER)),
            logout: vi.fn(),
          },
        },
        { provide: ToastService, useValue: { show: vi.fn(), dismiss: vi.fn(), toasts: signal([]) } },
        {
          provide: BasePathService,
          useValue: {
            getBasePath: vi.fn().mockReturnValue(''),
            getApiUrl: vi.fn().mockImplementation((path: string) => path),
          },
        },
        {
          provide: SessionStateService,
          useValue: {
            stateSessionId: signal<string | null>(routedSessionId),
            currentRound,
            participants,
            sessionConfig,
            countdownActive,
            currentUser,
            isRevealed,
            selections,
            metrics,
            history: signal<HistoryEntry[]>([completedEstimate()]),
            votedUserIds: signal<Set<string>>(new Set()),
            hasRevealPermission,
            hasIssuePermission: signal<boolean>(false),
            votingSystemCards: signal<ExtendedCardValue[]>([]),
            issueList: signal([]),
            ownerId,
            calloutNoteAdded$: added$.asObservable(),
            calloutNoteRejected$: rejected$.asObservable(),
          },
        },
        {
          provide: EstimateExportService,
          useValue: { inFlight: signal<boolean>(false), exportEstimates: vi.fn() },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: { get: (key: string) => (key === 'sessionId' ? routedSessionId : null) },
            },
          },
        },
      ],
    }).overrideComponent(SessionPokerPageComponent, {
      set: {
        imports: [
          CommonModule,
          RouterLink,
          StubCardDeckComponent,
          StubBoardComponent,
          StubStoryManagerComponent,
          StubMetricsComponent,
          StubSessionHistoryComponent,
          StubUserMenuComponent,
          StubQrCodeComponent,
          StubSessionSettingsPanelComponent,
          StubCountdownOverlayComponent,
          StubVotingTimerDisplayComponent,
          StubConsensusIndicatorComponent,
          StubFacilitatorFlowComponent,
          StubIssueListPanelComponent,
          StubConnectionStatusComponent,
          StubModeratorNoteBalloonComponent,
          layer,
        ],
      },
    });
  }

  /** Creates the page and resolves the `/exists` check with `exists` (or an HTTP error). */
  function render(routedSessionId: string, outcome: 'found' | 'missing' | 'error' = 'found'): void {
    fixture = TestBed.createComponent(SessionPokerPageComponent);
    httpTesting = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    if (routedSessionId !== '') {
      const request = httpTesting.expectOne(`/api/sessions/${routedSessionId}/exists`);
      if (outcome === 'error') {
        request.flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' });
      } else {
        request.flush({ exists: outcome === 'found' });
      }
    }
    flush();
  }

  /** Change detection until effects, reconciliation and re-renders settle. */
  function flush(): void {
    for (let i = 0; i < 4; i += 1) fixture.detectChanges();
  }

  const root = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const page = (): HTMLElement | null => root().querySelector<HTMLElement>('.session-poker-page');
  const layerHost = (): HTMLElement | null => root().querySelector<HTMLElement>('app-vote-callout-layer');
  const blockers = (): HTMLElement[] => Array.from(root().querySelectorAll<HTMLElement>('.interaction-blocker'));

  function stubbedLayer(): StubVoteCalloutLayerComponent {
    const debug = fixture.debugElement.query(By.directive(StubVoteCalloutLayerComponent));
    return debug.componentInstance as StubVoteCalloutLayerComponent;
  }

  function settingsPanel(): StubSessionSettingsPanelComponent {
    const debug = fixture.debugElement.query(By.directive(StubSessionSettingsPanelComponent));
    return debug.componentInstance as StubSessionSettingsPanelComponent;
  }

  afterEach(() => {
    httpTesting?.verify();
  });

  // ---------------------------------------------------------------------------------------------

  describe('layer placement (stubbed layer)', () => {
    beforeEach(() => {
      configure(SESSION_ID, StubVoteCalloutLayerComponent);
    });

    it('renders exactly one layer when the session is found (R11.11)', () => {
      render(SESSION_ID);

      expect(root().querySelectorAll('app-vote-callout-layer')).toHaveLength(1);
      expect(page()).not.toBeNull();
    });

    it('makes the layer the last child of .session-poker-page, after the countdown overlay (R9.4)', () => {
      render(SESSION_ID);

      const host = layerHost() as HTMLElement;
      expect(host.parentElement).toBe(page());
      expect(page()?.lastElementChild).toBe(host);
      const overlay = root().querySelector('app-countdown-overlay') as HTMLElement;
      expect(overlay.parentElement).toBe(page());
      expect(overlay.nextElementSibling).toBe(host);
    });

    it('keeps the layer last when the QR popup and the end-session dialog are open', () => {
      render(SESSION_ID);
      const component = fixture.componentInstance;

      component.toggleQrCode();
      component.showEndSessionDialog.set(true);
      flush();

      // The dialog is declared after the layer, so the layer is last only among the always-present
      // children; the layer must still come after the board and the countdown overlay.
      const children = Array.from((page() as HTMLElement).children);
      const layerIndex = children.indexOf(layerHost() as HTMLElement);
      expect(layerIndex).toBeGreaterThan(children.indexOf(root().querySelector('main') as HTMLElement));
      expect(layerIndex).toBeGreaterThan(
        children.indexOf(root().querySelector('app-countdown-overlay') as HTMLElement)
      );
    });

    it('is not inside any .interaction-blocker wrapper (R11.12)', () => {
      render(SESSION_ID);

      const host = layerHost() as HTMLElement;
      expect(host.closest('.interaction-blocker')).toBeNull();
      expect(blockers().length).toBeGreaterThan(0);
      for (const blocker of blockers()) {
        expect(blocker.contains(host)).toBe(false);
      }
    });

    it('stays outside every wrapper and is never inert while interaction is paused (R11.12)', () => {
      connectionState.set('disconnected');
      render(SESSION_ID);

      // The wrappers really are inert now, so this proves the layer escapes them.
      expect(blockers().every((blocker) => blocker.hasAttribute('inert'))).toBe(true);
      const host = layerHost() as HTMLElement;
      expect(host).not.toBeNull();
      expect(host.closest('[inert]')).toBeNull();
      expect(host.closest('.interaction-blocker')).toBeNull();
      expect(page()?.lastElementChild).toBe(host);
    });

    it('passes the routed session id as the layer input (R12.5)', () => {
      render(SESSION_ID);

      expect(stubbedLayer().sessionId()).toBe(SESSION_ID);
      expect(fixture.componentInstance.sessionId()).toBe(SESSION_ID);
    });

    it('is not rendered when the session does not exist (R11.11)', () => {
      TestBed.resetTestingModule();
      configure('gone0001', StubVoteCalloutLayerComponent);
      render('gone0001', 'missing');

      expect(fixture.componentInstance.sessionNotFound()).toBe(true);
      expect(root().querySelector('.session-error__card')).not.toBeNull();
      expect(layerHost()).toBeNull();
      expect(page()).toBeNull();
    });

    it('is not rendered when the existence check fails (R11.11)', () => {
      TestBed.resetTestingModule();
      configure('broken01', StubVoteCalloutLayerComponent);
      render('broken01', 'error');

      expect(root().querySelector('.session-error__card')).not.toBeNull();
      expect(layerHost()).toBeNull();
    });

    it('is not rendered when the route carries no session id (R11.11)', () => {
      TestBed.resetTestingModule();
      configure('', StubVoteCalloutLayerComponent);
      render('');

      expect(fixture.componentInstance.sessionNotFound()).toBe(true);
      expect(layerHost()).toBeNull();
    });

    it('removes the layer if the session turns out to be missing after the first render', () => {
      TestBed.resetTestingModule();
      configure('late0001', StubVoteCalloutLayerComponent);
      fixture = TestBed.createComponent(SessionPokerPageComponent);
      httpTesting = TestBed.inject(HttpTestingController);
      fixture.detectChanges();
      // Before the check resolves the page is in its session-found branch.
      expect(layerHost()).not.toBeNull();

      httpTesting.expectOne('/api/sessions/late0001/exists').flush({ exists: false });
      flush();

      expect(layerHost()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('existing page markup and tab order (stubbed layer)', () => {
    beforeEach(() => {
      configure(SESSION_ID, StubVoteCalloutLayerComponent);
    });

    it('adds tabindex="-1" to #main-content without making it a tab stop', () => {
      render(SESSION_ID);

      const main = root().querySelector<HTMLElement>('#main-content') as HTMLElement;
      expect(main.getAttribute('tabindex')).toBe('-1');
      expect(main.closest('main.session-poker-page__main')).not.toBeNull();
      expect(main.closest('.session-poker-page')).toBe(page());
    });

    it('orders the page children header, main, moderator balloon, countdown overlay, layer', () => {
      render(SESSION_ID);

      const order = Array.from((page() as HTMLElement).children).map((child) => child.tagName.toLowerCase());
      expect(order).toEqual([
        'header',
        'main',
        'app-moderator-note-balloon',
        'app-countdown-overlay',
        'app-vote-callout-layer',
      ]);
    });

    it('shows the pause status between main and the countdown overlay without moving the layer', () => {
      connectionState.set('reconnecting');
      render(SESSION_ID);

      const order = Array.from((page() as HTMLElement).children).map((child) =>
        child.matches('p.interaction-blocker__status') ? 'status' : child.tagName.toLowerCase()
      );
      expect(order).toEqual([
        'header',
        'main',
        'status',
        'app-moderator-note-balloon',
        'app-countdown-overlay',
        'app-vote-callout-layer',
      ]);
    });

    it('keeps the keyboard tab sequence of the page controls in its existing order', () => {
      render(SESSION_ID);

      const tabStops = Array.from(
        root().querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, summary, [tabindex]')
      )
        .filter((node) => !node.hasAttribute('disabled') && node.getAttribute('tabindex') !== '-1')
        .map((node) => node.className.split(/\s+/)[0] || node.tagName.toLowerCase());

      expect(tabStops).toEqual([
        'session-poker-page__lobby-btn',
        'session-poker-page__export-btn',
        'session-poker-page__end-btn',
        'session-poker-page__copy-btn',
        'session-poker-page__qr-toggle',
        'session-poker-page__accordion-header',
        'session-poker-page__accordion-header',
        'session-poker-page__history-toggle',
      ]);
    });

    it('still renders the unchanged header, board region, sidebar and mobile history blocks', () => {
      render(SESSION_ID);

      for (const selector of [
        '.session-poker-page__header',
        '.session-poker-page__board-area',
        '.session-poker-page__sidebar--desktop',
        '.session-poker-page__mobile-history',
        'app-countdown-overlay',
      ]) {
        expect(root().querySelector(selector), selector).not.toBeNull();
      }
      expect(blockers()).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('settings panel isGameOwner wiring (stubbed layer)', () => {
    beforeEach(() => {
      configure(SESSION_ID, StubVoteCalloutLayerComponent);
    });

    it('passes true to the true owner', () => {
      currentUser.set(OWNER);
      ownerId.set(OWNER.id);
      render(SESSION_ID);

      expect(settingsPanel().isGameOwner()).toBe(true);
      expect(settingsPanel().isOwner()).toBe(true);
    });

    it('passes false to a moderator who is not the owner, while isOwner stays role-based', () => {
      currentUser.set(MODERATOR);
      ownerId.set(OWNER.id);
      render(SESSION_ID);

      expect(settingsPanel().isOwner()).toBe(true);
      expect(settingsPanel().isGameOwner()).toBe(false);
    });

    it('passes false to a participant', () => {
      currentUser.set(PLAYER);
      ownerId.set(OWNER.id);
      render(SESSION_ID);

      expect(settingsPanel().isOwner()).toBe(false);
      expect(settingsPanel().isGameOwner()).toBe(false);
    });

    it('passes false while the owner is unknown', () => {
      currentUser.set(OWNER);
      ownerId.set(null);
      render(SESSION_ID);

      expect(settingsPanel().isGameOwner()).toBe(false);
    });

    it('follows ownership changes in the same change-detection cycle', () => {
      currentUser.set(MODERATOR);
      ownerId.set(OWNER.id);
      render(SESSION_ID);
      expect(settingsPanel().isGameOwner()).toBe(false);

      ownerId.set(MODERATOR.id);
      fixture.detectChanges();

      expect(settingsPanel().isGameOwner()).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------------------------

  describe('countdown with the real layer (R7.5, R7.12)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      sessionStorage.clear();
      configure(SESSION_ID, VoteCalloutLayerComponent);
      currentUser.set(PEOPLE.find((person) => person.id === VIEWER_ID) ?? null);
      participants.set([...PEOPLE]);
    });

    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
      sessionStorage.clear();
    });

    const near = (): HTMLElement | null => root().querySelector<HTMLElement>('.callout--near');
    const far = (): HTMLElement | null => root().querySelector<HTMLElement>('.callout--far');

    function advance(ms: number): void {
      vi.advanceTimersByTime(ms);
      flush();
    }

    function reveal(): void {
      selections.set(new Map(VOTES));
      currentRound.set(round('revealed'));
      metrics.set(REVEALED_METRICS);
      isRevealed.set(true);
      flush();
    }

    it('hosts the real layer as the last child, outside every blocker, and shows callouts after a reveal', () => {
      render(SESSION_ID);
      reveal();
      advance(500);

      const host = layerHost() as HTMLElement;
      expect(page()?.lastElementChild).toBe(host);
      expect(host.closest('.interaction-blocker')).toBeNull();
      expect(near()).not.toBeNull();
      expect(far()).not.toBeNull();
      expect(host.contains(near())).toBe(true);
      expect(host.contains(far())).toBe(true);
    });

    it('shows no callout while the countdown runs and restores them when the run ends', () => {
      render(SESSION_ID);
      countdownActive.set(true);
      flush();
      reveal();
      advance(1000);

      expect(near()).toBeNull();
      expect(far()).toBeNull();
      expect(layerHost()?.querySelectorAll('button, textarea')).toHaveLength(0);

      advance(COUNTDOWN_DURATION_MS);
      advance(500);

      expect(near()).not.toBeNull();
      expect(far()).not.toBeNull();
    });

    it('hides callouts that are already visible when a countdown starts', () => {
      render(SESSION_ID);
      reveal();
      advance(500);
      expect(near()).not.toBeNull();

      countdownActive.set(true);
      flush();
      advance(EXIT_REMOVAL_DEADLINE_MS);

      expect(near()).toBeNull();
      expect(far()).toBeNull();
      expect(layerHost()?.querySelectorAll('button, textarea')).toHaveLength(0);
    });

    it('returns within one change-detection cycle once the countdown flag clears', () => {
      render(SESSION_ID);
      countdownActive.set(true);
      flush();
      reveal();
      advance(500);
      expect(near()).toBeNull();

      countdownActive.set(false);
      fixture.detectChanges();

      expect(near()).not.toBeNull();
      expect(far()).not.toBeNull();
    });

    it('does not make the countdown overlay part of the layer subtree', () => {
      render(SESSION_ID);
      countdownActive.set(true);
      flush();

      const overlay = root().querySelector('app-countdown-overlay') as HTMLElement;
      expect(layerHost()?.contains(overlay)).toBe(false);
      expect(overlay.nextElementSibling).toBe(layerHost());
    });

    it('is not rendered at all when the session is not found, even with callouts due', () => {
      TestBed.resetTestingModule();
      configure('gone0001', VoteCalloutLayerComponent);
      currentUser.set(PEOPLE.find((person) => person.id === VIEWER_ID) ?? null);
      participants.set([...PEOPLE]);
      render('gone0001', 'missing');
      reveal();
      advance(500);

      expect(layerHost()).toBeNull();
      expect(root().querySelector('.vote-callout-layer')).toBeNull();
      expect(root().querySelector('.callout--near')).toBeNull();
    });
  });
});
