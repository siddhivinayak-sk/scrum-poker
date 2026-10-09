import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { Component, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, Router, RouterLink, provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { EMPTY, Observable } from 'rxjs';
import {
  CONNECTION_LABEL,
  CardValue,
  ConnectionState,
  ExtendedCardValue,
  FeelingCategory,
  HistoryEntry,
  RetroCard,
  RetroColumn,
  RetroConfiguration,
  SessionConfiguration,
  User,
  VotingMetrics,
  VotingRound,
} from '@shared/types';
import { rulesOf } from '../../testing/declared-css';
import { ConnectionStatusComponent } from './connection-status.component';
import { SessionPokerPageComponent } from '../session-poker-page/session-poker-page.component';
import { RetroBoardPageComponent } from '../retro-board/retro-board-page.component';
import { UserMenuComponent } from '../user-menu/user-menu.component';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { AuthService } from '../../services/auth.service';
import { ToastService } from '../../services/toast.service';
import { BasePathService } from '../../services/base-path.service';
import { EstimateExportService } from '../../services/estimate-export.service';
import { RetroStateService } from '../../services/retro-state.service';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { RetroExportService } from '../../services/retro-export.service';
import { RetroScreenshotService } from '../../services/retro-screenshot.service';
import { FeelingsService } from '../../services/feelings.service';

/**
 * Property 17 — interaction is permitted *exactly* when connected
 * (R11.9, R11.10, R11.11, R11.12, R11.13, R14.12).
 *
 * The blocker is a projection of one boolean: `blocked()` is
 * `displayedConnectionState() !== 'connected'`, every wrapper binds `inert` and
 * `aria-disabled` to it, and the paused-interaction message is rendered under
 * the same condition. The claim worth proving is therefore the *biconditional*
 * — blocked for every state that is not `connected`, and permitted again for
 * `connected` — after *any* history of states, on *both* session pages, with
 * the three exempt controls (the indicator, back to lobby, logout) never swept
 * into the blocked region and the already-typed text never touched.
 *
 * Both pages are driven through their own WebSocket service double, so the
 * generated sequence reaches `blocked()` the way the running app does: service
 * signal → page `computed` → attribute binding, rather than by setting the
 * flag directly.
 *
 * ## Generators
 *
 * `arbStateSequence` draws 1–50 states from `CONNECTION_STATES`, which is
 * pinned to the whole `ConnectionState` union at compile time (see
 * `StatesAreTotal`) and at run time (see the totality test below).
 * `size: 'max'` is required: fast-check's default sizing silently caps an
 * array at ten entries, which would quietly shrink the stated 1–50 range.
 * Sequences rather than single states because a stale `computed` or a wrapper
 * that latched its attribute would only show up on a *transition* — each run
 * replays its whole sequence through one page, asserting every clause after
 * each step, so repeats (`reconnecting` → `reconnecting`) and round trips
 * (`connected` → `disconnected` → `connected`, which is R11.13) are both
 * exercised. `arbTypedText` draws 0–200 characters, entered into a session
 * input *before* the sequence starts, which is what R11.12 means by text
 * already entered. `numRuns: 100`, per R14.12.
 *
 * ## What is asserted, given a runner that performs no layout
 *
 * The client test runner resolves no custom property and measures no box, and
 * it implements none of `inert`'s own semantics. "Prevents activation" is
 * therefore asserted as the contract the browser acts on — the `inert`
 * attribute on the wrapper, `aria-disabled` for assistive technology, and DOM
 * containment deciding which controls that wrapper covers — never by
 * dispatching a click at a blocked control and hoping the runner swallows it.
 *
 * Likewise "content stays visible" is asserted as: the wrapper keeps its whole
 * subtree (same elements, same text) across every transition, carries neither
 * `hidden` nor `aria-hidden`, and the stylesheet hangs nothing off `[inert]` or
 * `[aria-disabled]` that could hide it.
 *
 * ## Timing
 *
 * R11.10 and R11.13 allow 500 ms either way. `blocked()` is a `computed`, so
 * every assertion below runs immediately after the synchronous
 * change-detection pass that follows the state change, with no timer advanced —
 * strictly stronger than the 500 ms budget.
 *
 * ## Scope of the scroll-container clause
 *
 * R11.12 asks that the *session page* keeps scrolling. The clause is asserted
 * against the scroll containers each page component declares (collected from
 * its compiled styles below): none of them may be, or sit inside, the inert
 * element. Scrollers belonging to child components inside the blocked region —
 * a retro column's card list, a card's own text area — are blocked content by
 * design, which is what task 24.5 and 24.6 fixed when they put each wrapper
 * *inside* its page-level scroll container.
 *
 * **Validates: Requirements R11.9, R11.10, R11.11, R11.12, R11.13**
 */

// --- The state space, pinned to the union ------------------------------------------

/** Every `ConnectionState`: the one `connected` that permits, and the two that block. */
const CONNECTION_STATES = [
  'connected',
  'reconnecting',
  'disconnected',
] as const satisfies readonly ConnectionState[];

type CoveredState = (typeof CONNECTION_STATES)[number];

/**
 * Compile-time totality: this alias only resolves while every member of
 * `ConnectionState` appears in `CONNECTION_STATES`. A fourth state added to
 * `shared/types.ts` stops this file type-checking, which is the point — the
 * generator must never quantify over a strict subset of the union, or a new
 * state could slip through unblocked.
 */
type AssertAssignable<T extends U, U> = true;
type StatesAreTotal = AssertAssignable<ConnectionState, CoveredState>;
const STATES_ARE_TOTAL: StatesAreTotal = true;

const arbState: fc.Arbitrary<ConnectionState> = fc.constantFrom(...CONNECTION_STATES);

/** Transition sequences of length 1 through 50 (R14.12). */
const arbStateSequence: fc.Arbitrary<readonly ConnectionState[]> = fc.array(arbState, {
  minLength: 1,
  maxLength: 50,
  size: 'max',
});

/** Text already entered in a session input, 0 through 200 characters (R11.12). */
const arbTypedText: fc.Arbitrary<string> = fc.string({
  minLength: 0,
  maxLength: 200,
  size: 'max',
});

const NUM_RUNS = { numRuns: 100 } as const;

/** Budget for one 100-run property over a fully rendered page. */
const PROPERTY_TIMEOUT_MS = 180_000;

// --- The rendered contract ---------------------------------------------------------

const BLOCKER = '.interaction-blocker';
const STATUS = '.interaction-blocker__status';
const INDICATOR = '.connection-status';
const LOGOUT_TRIGGER = '.user-menu__avatar';
const LOGOUT_ITEM = '.user-menu__item--logout';

/** The message R11.11 requires while interaction is paused. */
const PAUSED_MESSAGE = 'Interaction is paused until the connection is restored.';

/** Where one blocker wrapper must sit. */
interface WrapperPlacement {
  /** Selector matching exactly that wrapper. */
  readonly selector: string;
  /**
   * The page-level scroll container the wrapper must sit inside, or `null` for
   * a wrapper whose row does not scroll.
   */
  readonly container: string | null;
}

/** A control R11.9 exempts from blocking. */
interface ExemptControl {
  readonly name: string;
  readonly selector: string;
  /** Interactive controls must also accept keyboard focus; the chip need not. */
  readonly focusable: boolean;
}

/** One rendered session page, driven by its own connection state. */
interface PageHarness {
  readonly label: string;
  readonly root: HTMLElement;
  /** The page's own view of the connection, as the indicator reads it. */
  displayedState(): ConnectionState;
  /** The page's own blocking decision. */
  blocked(): boolean;
  /** The compiled component, for the declared-CSS clauses. */
  readonly componentType: unknown;
  readonly wrappers: readonly WrapperPlacement[];
  readonly exempt: readonly ExemptControl[];
  /** Pushes a state through the service double and settles the view. */
  setState(state: ConnectionState): void;
  /** Enters `text` in a session input inside a blocker wrapper. */
  typeInto(text: string): HTMLInputElement;
  /** Activates back to lobby and logout, asserting both still reach their effect. */
  activateExemptControls(): void;
  destroy(): void;
}

// --- Declared scroll containers ----------------------------------------------------

const SCROLLING_VALUE = /\b(auto|scroll)\b/;

/**
 * Every selector a component declares a scrolling overflow on, media rules
 * included. Selectors carrying `:host` or a pseudo-element are dropped: they
 * are not queryable against the rendered tree.
 */
function declaredScrollSelectors(component: unknown): readonly string[] {
  const selectors = new Set<string>();
  for (const rule of rulesOf(component)) {
    const scrolls = (['overflow', 'overflow-x', 'overflow-y'] as const).some(property => {
      const value = rule.declarations.get(property);
      return value !== undefined && SCROLLING_VALUE.test(value);
    });
    if (!scrolls) {
      continue;
    }
    for (const selector of rule.selectors) {
      if (!selector.includes(':host') && !selector.includes('::')) {
        selectors.add(selector);
      }
    }
  }
  return [...selectors];
}

/** Rules targeting a blocker wrapper, excluding the status message's own rule. */
function wrapperRules(component: unknown) {
  return rulesOf(component).filter(rule =>
    rule.selectors.some(selector => /(^|[\s>])\.interaction-blocker(?![\w-])/.test(selector)),
  );
}

// --- Poker page harness ------------------------------------------------------------

const POKER_SESSION_ID = 'abc12345';

const POKER_USER: User = {
  id: 'owner-1',
  displayName: 'Owner',
  role: 'moderator',
  isAnonymous: false,
};

/**
 * Child-component stubs, as in `export-control.spec.ts` and
 * `session-poker-page.component.spec.ts`: the page's own structure is under
 * test, not its children's.
 *
 * Two children are kept real, because this property is about them: the
 * indicator (`ConnectionStatusComponent`, input-driven and dependency-free),
 * so the chip's own reading can be checked while the page is blocked, and the
 * user menu (`UserMenuComponent`), so the exempt logout action is the real one
 * rather than an invented stand-in.
 *
 * The story-manager stub keeps a text input, mirroring the real
 * `#story-input`, because R11.12's "text already entered" needs a session input
 * inside a blocker wrapper to live in.
 */
@Component({ selector: 'app-card-deck', standalone: true, template: '' })
class StubCardDeckComponent {}

@Component({ selector: 'app-board', standalone: true, template: '' })
class StubBoardComponent {}

const STORY_INPUT = '.story-manager__input';

@Component({
  selector: 'app-story-manager',
  standalone: true,
  template: `<input type="text" class="story-manager__input" aria-label="Story Description" />`,
})
class StubStoryManagerComponent {}

@Component({ selector: 'app-metrics', standalone: true, template: '' })
class StubMetricsComponent {}

@Component({ selector: 'app-session-history', standalone: true, template: '' })
class StubSessionHistoryComponent {}

@Component({ selector: 'app-qr-code', standalone: true, template: '' })
class StubQrCodeComponent {
  readonly url = input.required<string>();
}

@Component({ selector: 'app-session-settings-panel', standalone: true, template: '' })
class StubSessionSettingsPanelComponent {
  readonly sessionId = input<string>('');
  readonly config = input<SessionConfiguration | null>(null);
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

const POKER_WRAPPERS: readonly WrapperPlacement[] = [
  {
    selector: '.session-poker-page__board-area > .interaction-blocker',
    container: '.session-poker-page__board-area',
  },
  {
    selector: '.session-poker-page__sidebar--desktop > .interaction-blocker',
    container: '.session-poker-page__sidebar--desktop',
  },
  // The mobile history row holds the overlay toggle; it is not a scroll container.
  {
    selector: '.session-poker-page__mobile-history > .interaction-blocker',
    container: null,
  },
];

const POKER_EXEMPT: readonly ExemptControl[] = [
  { name: 'the connection indicator', selector: INDICATOR, focusable: false },
  { name: 'back to lobby', selector: '.session-poker-page__lobby-btn', focusable: true },
  { name: 'the logout trigger', selector: LOGOUT_TRIGGER, focusable: true },
];

async function renderPokerPage(): Promise<PageHarness> {
  TestBed.resetTestingModule();

  const connectionState = signal<ConnectionState>('reconnecting');
  const logout = vi.fn();

  const sessionStateMock: Record<string, unknown> = {
    currentRound: signal<VotingRound | null>(null),
    participants: signal<User[]>([POKER_USER]),
    sessionConfig: signal<SessionConfiguration | null>(null),
    countdownActive: signal<boolean>(false),
    currentUser: signal<User | null>(POKER_USER),
    isRevealed: signal<boolean>(false),
    selections: signal<Map<string, CardValue>>(new Map()),
    metrics: signal<VotingMetrics | null>(null),
    history: signal<HistoryEntry[]>([]),
    votedUserIds: signal<Set<string>>(new Set()),
    hasRevealPermission: signal<boolean>(false),
    hasIssuePermission: signal<boolean>(false),
    votingSystemCards: signal<ExtendedCardValue[]>([]),
    issueList: signal([]),
    ownerId: signal<string | null>(POKER_USER.id),
  };

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
          on: vi.fn().mockReturnValue({ subscribe: vi.fn() }),
          connectionState,
        },
      },
      {
        provide: AuthService,
        useValue: {
          getToken: vi.fn().mockReturnValue('test-token-123'),
          getCurrentUser: vi.fn().mockReturnValue(signal<User | null>(POKER_USER)),
          logout,
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
      { provide: SessionStateService, useValue: sessionStateMock },
      {
        provide: EstimateExportService,
        useValue: { inFlight: signal(false), exportEstimates: vi.fn() },
      },
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: {
            paramMap: { get: (key: string) => (key === 'sessionId' ? POKER_SESSION_ID : null) },
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
        UserMenuComponent,
        StubQrCodeComponent,
        StubSessionSettingsPanelComponent,
        StubCountdownOverlayComponent,
        StubVotingTimerDisplayComponent,
        StubConsensusIndicatorComponent,
        StubFacilitatorFlowComponent,
        StubIssueListPanelComponent,
        ConnectionStatusComponent,
      ],
    },
  });

  const fixture = TestBed.createComponent(SessionPokerPageComponent);
  const http = TestBed.inject(HttpTestingController);
  const navigate = vi
    .spyOn(TestBed.inject(Router), 'navigate')
    .mockResolvedValue(true);
  const root = fixture.nativeElement as HTMLElement;

  fixture.detectChanges();
  // The `/exists` answer is what flips `connectAttempted`, after which the
  // indicator reads the service's own state rather than the pre-connect
  // `reconnecting` (R11.1).
  http.expectOne(`/api/sessions/${POKER_SESSION_ID}/exists`).flush({ exists: true });
  fixture.detectChanges();
  await fixture.whenStable();

  return {
    label: 'the poker session page',
    root,
    displayedState: () => fixture.componentInstance.displayedConnectionState(),
    blocked: () => fixture.componentInstance.blocked(),
    componentType: SessionPokerPageComponent,
    wrappers: POKER_WRAPPERS,
    exempt: POKER_EXEMPT,
    setState: state => {
      connectionState.set(state);
      fixture.detectChanges();
    },
    typeInto: text => enterText(root, STORY_INPUT, text, () => fixture.detectChanges()),
    activateExemptControls: () =>
      activateLobbyAndLogout({
        root,
        lobbySelector: '.session-poker-page__lobby-btn',
        navigate,
        logout,
        render: () => fixture.detectChanges(),
      }),
    destroy: () => {
      http.verify();
      fixture.destroy();
    },
  };
}

// --- Retro page harness ------------------------------------------------------------

const RETRO_SESSION_ID = 'retro-session-1';
const RETRO_USER_ID = 'user-1';
const RETRO_CONTEXT_INPUT = '.retro-board__context-input';

const RETRO_WRAPPERS: readonly WrapperPlacement[] = [
  // The toolbar and the context row; neither scrolls, so both are wrapped whole.
  { selector: '.retro-board__chrome.interaction-blocker', container: null },
  {
    selector: '.retro-board__columns > .interaction-blocker',
    container: '.retro-board__columns',
  },
];

const RETRO_EXEMPT: readonly ExemptControl[] = [
  { name: 'the connection indicator', selector: INDICATOR, focusable: false },
  { name: 'back to lobby', selector: '.retro-board__lobby-btn', focusable: true },
  { name: 'the logout trigger', selector: LOGOUT_TRIGGER, focusable: true },
];

function retroColumns(): RetroColumn[] {
  const card: RetroCard = {
    id: 'card-1',
    text: 'Pairing on the token refresh paid off',
    authorId: RETRO_USER_ID,
    authorName: 'Alice',
    votes: 1,
    votedBy: [RETRO_USER_ID],
    comments: [],
    columnId: 'col-1',
    order: 0,
    createdAt: '2026-05-01T00:00:00.000Z',
  };
  return [{ id: 'col-1', name: 'Went well', order: 0, cards: [card] }];
}

function retroConfig(): RetroConfiguration {
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
  } as RetroConfiguration;
}

async function renderRetroPage(): Promise<PageHarness> {
  TestBed.resetTestingModule();

  const connectionState = signal<ConnectionState>('reconnecting');
  const logout = vi.fn();
  const navigate = vi.fn();

  const retroState = {
    columns: signal(retroColumns()).asReadonly(),
    votesRemaining: signal(4).asReadonly(),
    // A moderator, so the editable context input — the session input R11.12
    // speaks of — is the one rendered.
    isModerator: signal(true).asReadonly(),
    isCompleted: signal(false).asReadonly(),
    context: signal('Sprint 14').asReadonly(),
    config: signal(retroConfig()).asReadonly(),
    cardsRevealed: signal(true).asReadonly(),
    votingEnabled: signal(true).asReadonly(),
    currentUserId: signal(RETRO_USER_ID).asReadonly(),
    participants: signal<User[]>([
      { id: RETRO_USER_ID, displayName: 'Alice', role: 'moderator', isAnonymous: false },
    ]).asReadonly(),
    state: signal({ sessionId: RETRO_SESSION_ID }).asReadonly(),
    lastAddedOwnCardId: signal<string | null>(null),
    ownNewCardIds: signal(new Set<string>()).asReadonly(),
    reset: vi.fn(),
  };

  const ws = {
    connectionState,
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    on: vi.fn((): Observable<unknown> => EMPTY),
    sendContextUpdate: vi.fn(),
    sendCardAdd: vi.fn(),
    sendCardEdit: vi.fn(),
    sendCardRemove: vi.fn(),
    sendCardMove: vi.fn(),
    sendCardVote: vi.fn(),
    sendCardUnvote: vi.fn(),
    sendCardMerge: vi.fn(),
    sendColumnAdd: vi.fn(),
    sendColumnRemove: vi.fn(),
    sendColumnReorder: vi.fn(),
    sendColumnRename: vi.fn(),
    sendCommentAdd: vi.fn(),
    sendCommentRemove: vi.fn(),
    sendCardsReveal: vi.fn(),
    sendVotingEnable: vi.fn(),
    sendBoardComplete: vi.fn(),
    sendConfigUpdate: vi.fn(),
  };

  TestBed.configureTestingModule({
    providers: [
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
      { provide: AuthService, useValue: { getToken: () => 'test-token', logout } },
      {
        provide: BasePathService,
        useValue: { getApiUrl: (path: string) => path, getBasePath: () => '' },
      },
      { provide: ToastService, useValue: { show: vi.fn(), dismiss: vi.fn(), dismissByTag: vi.fn() } },
      { provide: Router, useValue: { navigate } },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: { get: () => RETRO_SESSION_ID } } },
      },
    ],
  });

  const fixture = TestBed.createComponent(RetroBoardPageComponent);
  const root = fixture.nativeElement as HTMLElement;
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();

  return {
    label: 'the retro board page',
    root,
    displayedState: () => fixture.componentInstance.displayedConnectionState(),
    blocked: () => fixture.componentInstance.blocked(),
    componentType: RetroBoardPageComponent,
    wrappers: RETRO_WRAPPERS,
    exempt: RETRO_EXEMPT,
    setState: state => {
      connectionState.set(state);
      fixture.detectChanges();
    },
    typeInto: text => enterText(root, RETRO_CONTEXT_INPUT, text, () => fixture.detectChanges()),
    activateExemptControls: () =>
      activateLobbyAndLogout({
        root,
        lobbySelector: '.retro-board__lobby-btn',
        navigate,
        logout,
        render: () => fixture.detectChanges(),
      }),
    destroy: () => fixture.destroy(),
  };
}

// --- Shared harness helpers --------------------------------------------------------

function require$<T extends Element>(root: ParentNode, selector: string, where: string): T {
  const element = root.querySelector<T>(selector);
  expect(element, `${selector} is missing, ${where}`).not.toBeNull();
  return element as T;
}

/** Types `text` into a session input the way a participant would. */
function enterText(
  root: HTMLElement,
  selector: string,
  text: string,
  render: () => void,
): HTMLInputElement {
  const input = require$<HTMLInputElement>(root, selector, 'before the sequence');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  render();
  return input;
}

/**
 * Activates the two exempt *actions* and asserts each still reaches its effect.
 * Logout lives in a dropdown, so its trigger is opened first; the dropdown is
 * part of the header and so must also sit outside every wrapper.
 */
function activateLobbyAndLogout(options: {
  readonly root: HTMLElement;
  readonly lobbySelector: string;
  readonly navigate: ReturnType<typeof vi.fn> | ReturnType<typeof vi.spyOn>;
  readonly logout: ReturnType<typeof vi.fn>;
  readonly render: () => void;
}): void {
  const { root, lobbySelector, navigate, logout, render } = options;

  navigate.mockClear();
  require$<HTMLButtonElement>(root, lobbySelector, 'on activation').click();
  expect(navigate, 'back to lobby did not navigate').toHaveBeenCalledWith(['/lobby']);

  navigate.mockClear();
  logout.mockClear();
  require$<HTMLButtonElement>(root, LOGOUT_TRIGGER, 'on activation').click();
  render();

  const item = require$<HTMLButtonElement>(root, LOGOUT_ITEM, 'on activation');
  expect(item.closest(BLOCKER), 'logout rendered inside a blocker wrapper').toBeNull();
  expect(item.closest('[inert]'), 'logout rendered inside an inert subtree').toBeNull();
  item.click();
  render();

  expect(logout, 'logout did not reach the auth service').toHaveBeenCalledTimes(1);
  expect(navigate, 'logout did not navigate').toHaveBeenCalledWith(['/login']);
}

/**
 * A stand-in for "the content is still there": every element inside the
 * wrappers, by tag, plus their text. Deliberately coarse about attributes and
 * inline styles, so a card measuring itself does not read as content changing,
 * and exact about what is rendered and what it says.
 */
function contentSignature(harness: PageHarness): string {
  return harness.wrappers
    .map(({ selector }) => {
      const wrapper = require$<HTMLElement>(harness.root, selector, harness.label);
      const tags = Array.from(wrapper.querySelectorAll('*'))
        .map(element => element.tagName)
        .join('>');
      const text = (wrapper.textContent ?? '').replace(/\s+/g, ' ').trim();
      return `${selector}[${tags}]{${text}}`;
    })
    .join('|');
}

// --- The invariant -----------------------------------------------------------------

/**
 * Asserts the whole of Property 17 against one page in one state: the
 * biconditional on every wrapper, the status message, the exempt controls, the
 * scroll containers, the visible content and the typed text.
 */
function assertPermittedExactlyWhenConnected(
  harness: PageHarness,
  state: ConnectionState,
  typedText: string,
  inputSelector: string,
  expectedSignature: string,
  scrollSelectors: readonly string[],
): void {
  const expectBlocked = state !== 'connected';
  const where = `${harness.label} after ${state}`;
  const root = harness.root;

  // The two computeds the page blocks on.
  expect(harness.displayedState(), `displayedConnectionState(), ${where}`).toBe(state);
  expect(harness.blocked(), `blocked(), ${where}`).toBe(expectBlocked);

  // --- R11.9, R11.10, R11.13: inert and aria-disabled exactly when not connected ---

  const placed = harness.wrappers.map(({ selector }) =>
    require$<HTMLElement>(root, selector, where),
  );
  const rendered = Array.from(root.querySelectorAll<HTMLElement>(BLOCKER));

  // Every rendered wrapper is one of the expected ones: none added outside the
  // declared structure, none moved out of its container.
  expect(rendered.length, `wrapper count, ${where}`).toBe(harness.wrappers.length);
  expect(new Set(placed).size, `wrappers are distinct elements, ${where}`).toBe(
    harness.wrappers.length,
  );
  for (const wrapper of rendered) {
    expect(placed, `an unexpected wrapper is rendered, ${where}`).toContain(wrapper);
  }

  harness.wrappers.forEach(({ selector }, index) => {
    const wrapper = placed[index];

    expect(wrapper.hasAttribute('inert'), `inert on ${selector}, ${where}`).toBe(expectBlocked);
    expect(wrapper.getAttribute('aria-disabled'), `aria-disabled on ${selector}, ${where}`).toBe(
      String(expectBlocked),
    );

    // R11.12: blocked is not hidden. The wrapper stays in the tree, stays
    // exposed to assistive technology, and nothing inline hides it.
    expect(wrapper.hasAttribute('hidden'), `hidden on ${selector}, ${where}`).toBe(false);
    expect(wrapper.hasAttribute('aria-hidden'), `aria-hidden on ${selector}, ${where}`).toBe(
      false,
    );
    expect(wrapper.style.display, `inline display on ${selector}, ${where}`).toBe('');
    expect(wrapper.style.visibility, `inline visibility on ${selector}, ${where}`).toBe('');
    expect(wrapper.style.opacity, `inline opacity on ${selector}, ${where}`).toBe('');
  });

  // R11.12: the same content, element for element and word for word.
  expect(contentSignature(harness), `the wrapped content changed, ${where}`).toBe(
    expectedSignature,
  );

  // --- R11.11, R11.13: the status message is present exactly while blocked ---------

  const messages = Array.from(root.querySelectorAll<HTMLElement>(STATUS));
  expect(messages.length, `status message count, ${where}`).toBe(expectBlocked ? 1 : 0);
  if (expectBlocked) {
    const message = messages[0];
    expect(message.getAttribute('role'), `status role, ${where}`).toBe('status');
    expect(message.getAttribute('aria-live'), `status aria-live, ${where}`).toBe('polite');
    expect((message.textContent ?? '').replace(/\s+/g, ' ').trim(), `status text, ${where}`).toBe(
      PAUSED_MESSAGE,
    );
    // Announced only if it is not itself inert.
    expect(message.closest(BLOCKER), `the status message is wrapped, ${where}`).toBeNull();
    expect(message.closest('[inert]'), `the status message is inert, ${where}`).toBeNull();
  }

  // --- R11.9: the three exempt controls stay outside and usable --------------------

  for (const control of harness.exempt) {
    const element = require$<HTMLElement>(root, control.selector, `${control.name}, ${where}`);

    expect(element.closest(BLOCKER), `${control.name} is wrapped, ${where}`).toBeNull();
    expect(element.closest('[inert]'), `${control.name} is inert, ${where}`).toBeNull();
    expect(
      element.getAttribute('aria-disabled'),
      `${control.name} is aria-disabled, ${where}`,
    ).not.toBe('true');
    if (element.tagName === 'BUTTON') {
      expect((element as HTMLButtonElement).disabled, `${control.name} is disabled, ${where}`).toBe(
        false,
      );
    }

    if (control.focusable) {
      const tabindex = element.getAttribute('tabindex');
      expect(
        tabindex === null || Number(tabindex) >= 0,
        `${control.name} is removed from the tab order, ${where}`,
      ).toBe(true);
      element.focus();
      expect(
        element.ownerDocument.activeElement,
        `${control.name} did not take focus, ${where}`,
      ).toBe(element);
    }
  }

  // The indicator keeps reporting the current state while interaction is paused.
  const indicator = require$<HTMLElement>(root, INDICATOR, where);
  expect(
    (
      require$<HTMLElement>(indicator, '.connection-status__label', where).textContent ?? ''
    ).trim(),
    `the indicator label, ${where}`,
  ).toBe(CONNECTION_LABEL[state]);

  // --- R11.12: no page scroll container is, or sits inside, the inert element ------

  for (const { selector, container } of harness.wrappers) {
    if (container === null) {
      continue;
    }
    const scroller = require$<HTMLElement>(root, container, where);
    expect(scroller.classList.contains('interaction-blocker'), `${container}, ${where}`).toBe(
      false,
    );
    expect(scroller.hasAttribute('inert'), `inert on ${container}, ${where}`).toBe(false);
    expect(
      scroller.contains(require$<HTMLElement>(root, selector, where)),
      `${selector} left ${container}, ${where}`,
    ).toBe(true);
  }

  for (const selector of scrollSelectors) {
    for (const scroller of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
      expect(scroller.hasAttribute('inert'), `inert on scroller ${selector}, ${where}`).toBe(
        false,
      );
      expect(
        scroller.closest('[inert]'),
        `the scroller ${selector} sits inside an inert subtree, ${where}`,
      ).toBeNull();
    }
  }

  // --- R11.12: the text already entered is untouched --------------------------------

  const input = require$<HTMLInputElement>(root, inputSelector, where);
  expect(input.closest(BLOCKER), `the session input is not wrapped, ${where}`).not.toBeNull();
  expect(input.value, `the typed text changed, ${where}`).toBe(typedText);
}

// --- The pages under test ----------------------------------------------------------

interface PageUnderTest {
  readonly label: string;
  readonly render: () => Promise<PageHarness>;
  /** The input the typed text goes into. */
  readonly inputSelector: string;
  readonly componentType: unknown;
  readonly expectedScrollSelectors: readonly string[];
}

const PAGES: readonly PageUnderTest[] = [
  {
    label: 'the poker session page',
    render: renderPokerPage,
    inputSelector: STORY_INPUT,
    componentType: SessionPokerPageComponent,
    expectedScrollSelectors: [
      '.session-poker-page__board-area',
      '.session-poker-page__sidebar--desktop',
    ],
  },
  {
    label: 'the retro board page',
    render: renderRetroPage,
    inputSelector: RETRO_CONTEXT_INPUT,
    componentType: RetroBoardPageComponent,
    expectedScrollSelectors: ['.retro-board__columns'],
  },
];

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
});

describe('Property 17: interaction is permitted exactly when connected', () => {
  it('quantifies over every ConnectionState, exactly one of which permits interaction', () => {
    expect(STATES_ARE_TOTAL).toBe(true);

    // Run-time half of the totality claim: the generator's state list and the
    // label table agree, so neither can gain a member the other misses.
    expect([...CONNECTION_STATES].sort()).toEqual(Object.keys(CONNECTION_LABEL).sort());
    expect(CONNECTION_STATES.filter(state => state === 'connected')).toHaveLength(1);
  });

  for (const page of PAGES) {
    describe(page.label, () => {
      it('blocks every wrapper, and only while not connected, after any state sequence', async () => {
        const scrollSelectors = declaredScrollSelectors(page.componentType);

        await fc.assert(
          fc.asyncProperty(arbStateSequence, arbTypedText, async (states, typedText) => {
            const harness = await page.render();
            try {
              const input = harness.typeInto(typedText);
              expect(input.closest(BLOCKER)).not.toBeNull();

              // The content baseline is taken once, in whatever state the
              // sequence opens with, and every later step is compared against
              // it: blocking may not add, remove or reword anything.
              harness.setState(states[0]);
              const baseline = contentSignature(harness);

              for (const state of states) {
                harness.setState(state);
                assertPermittedExactlyWhenConnected(
                  harness,
                  state,
                  typedText,
                  page.inputSelector,
                  baseline,
                  scrollSelectors,
                );
              }

              // In whichever state the sequence left the page, the two exempt
              // actions still reach their effect (R11.9).
              harness.activateExemptControls();
            } finally {
              harness.destroy();
            }
          }),
          NUM_RUNS,
        );
        // 100 runs of up to 50 renders of a whole page outgrow the default
        // per-test budget, so this one states its own.
      }, PROPERTY_TIMEOUT_MS);

      // --- The declared half of the two style-dependent clauses --------------------

      it('declares page scroll containers, none of which is a blocker wrapper', () => {
        const declared = declaredScrollSelectors(page.componentType);

        for (const selector of page.expectedScrollSelectors) {
          expect(declared, `${selector} declares no scrolling overflow`).toContain(selector);
        }
        // Whatever the page scrolls, it is never the element carrying `inert`.
        for (const selector of declared) {
          expect(
            /\.interaction-blocker(?![\w-])/.test(selector),
            `${selector} is both a scroll container and a blocker wrapper`,
          ).toBe(false);
        }
      });

      it('hides nothing while blocked: no rule keys off inert or aria-disabled', () => {
        for (const rule of rulesOf(page.componentType)) {
          for (const selector of rule.selectors) {
            expect(
              /inert|aria-disabled/.test(selector),
              `${selector} styles the blocked state, which could hide content`,
            ).toBe(false);
          }
        }

        for (const rule of wrapperRules(page.componentType)) {
          const where = rule.selectors.join(', ');
          expect(rule.declarations.get('display'), `display on ${where}`).not.toBe('none');
          expect(rule.declarations.get('visibility'), `visibility on ${where}`).not.toBe('hidden');
          expect(rule.declarations.get('opacity'), `opacity on ${where}`).toBeUndefined();
        }
      });
    });
  }
});
