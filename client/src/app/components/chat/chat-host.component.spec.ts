/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Component,
  Provider,
  Type,
  WritableSignal,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { RouterLink, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY, Observable, Subject } from 'rxjs';
import {
  BoardKind,
  CardValue,
  ChatMessage,
  ChatMessageAddedPayload,
  ChatMessageSendPayload,
  ConnectionState,
  ExtendedCardValue,
  HistoryEntry,
  RETRO_SESSION_ENDED,
  RetroColumn,
  RetroConfiguration,
  RetroSessionEndedPayload,
  SessionConfiguration,
  User,
  VotingMetrics,
  VotingRound,
} from '@shared/types';
import { AuthService } from '../../services/auth.service';
import { BasePathService } from '../../services/base-path.service';
import { CHAT_TIMERS, ChatStore, ChatTimers } from '../../services/chat-store.service';
import { READ_MARKER_KEY_PREFIX } from '../../services/chat-read-marker';
import { ChatTransport, PokerChatTransport, RetroChatTransport } from '../../services/chat-transport';
import { PANEL_CHUNK_LOADER_DEPS } from '../../services/panel-chunk-loader';
import { RetroStateService } from '../../services/retro-state.service';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { SessionStateService } from '../../services/session-state.service';
import { ToastService } from '../../services/toast.service';
import { WebSocketService } from '../../services/websocket.service';
import {
  WCAG_AA_NON_TEXT_CONTRAST,
  WCAG_AA_TEXT_CONTRAST,
  mixColors,
  wcagContrastRatio,
} from '../../testing/contrast';
import { MOBILE_MEDIA, edgesPx, rulesOf, stylesFor, toPx } from '../../testing/declared-css';
import { RetroBoardPageComponent } from '../retro-board/retro-board-page.component';
import { SessionPokerPageComponent } from '../session-poker-page/session-poker-page.component';
import { AVATAR_PALETTE, CHAT_NARROW_QUERY, chatPanelId } from './chat-format';
import { ChatComposerComponent } from './chat-composer.component';
import { ChatHostComponent } from './chat-host.component';
import { ChatLauncherComponent } from './chat-launcher.component';
import { ChatLoadErrorNoticeComponent } from './chat-load-error-notice.component';
import { ChatMessageListComponent } from './chat-message-list.component';
import { ChatPanelComponent } from './chat-panel.component';
import { ChatPanelHeaderComponent } from './chat-panel-header.component';
import { ChatPresenceListComponent } from './chat-presence-list.component';

/**
 * ChatHost and Board_Page wiring (task 14.7).
 *
 * The page tests render the real `SessionPokerPageComponent` and `RetroBoardPageComponent` behind
 * the real router, with their board children stubbed and the REAL `ChatHostComponent` kept in
 * their imports. The chat store and loader run for real over fake chat transports, a manual clock
 * and a controllable importer that hands out a stub Chat_Panel (the real panel is only reachable
 * through the Deferred chat chunk).
 *
 * The style tests read the declared stylesheets: the client test runner performs no layout and
 * resolves no custom property, so the R12.5 clearance, the R12.1 token rule and the contrast pairs
 * are asserted against the declarations and the `:root` values of `client/src/styles.scss`.
 * Vitest runs with `process.cwd()` = `client/`.
 */

// --- Chat doubles ------------------------------------------------------------------------------

class ManualTimers implements ChatTimers {
  time = 1_000_000;
  private nextHandle = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }
  setTimeout(callback: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.pending.set(handle, { at: this.time + ms, callback });
    return handle;
  }
  clearTimeout(handle: number): void {
    this.pending.delete(handle);
  }
}

class FakeTransport implements ChatTransport {
  constructor(readonly boardKind: BoardKind) {}
  readonly connectionState = signal<ConnectionState>('connected');
  readonly connectionGeneration = signal(1);
  readonly participants = signal<readonly User[]>([]);
  readonly currentUserId = signal<string | null>('me');
  readonly added$ = new Subject<unknown>();
  readonly history$ = new Subject<unknown>();
  readonly rejected$ = new Subject<unknown>();
  send(_payload: ChatMessageSendPayload): boolean {
    return true;
  }
}

/** Stand-in for the Chat_Panel: the same id and the host's store. */
@Component({
  selector: 'app-stub-chat-panel',
  template: `<section class="stub-panel" [id]="id"></section>`,
})
class StubPanelComponent {
  readonly store = inject(ChatStore);
  protected readonly id = chatPanelId(this.store.boardKind);
}

/** A promise per importer call, settled by the test. */
class ControlledImporter {
  readonly calls: { resolve(cls: Type<unknown>): void; reject(error: unknown): void }[] = [];
  readonly importer = (): Promise<Type<unknown>> =>
    new Promise<Type<unknown>>((resolve, reject) => this.calls.push({ resolve, reject }));
}

interface ChatDoubles {
  readonly timers: ManualTimers;
  readonly importer: ControlledImporter;
  readonly poker: FakeTransport;
  readonly retro: FakeTransport;
}

function chatProviders(chat: ChatDoubles): Provider[] {
  return [
    { provide: PokerChatTransport, useValue: chat.poker },
    { provide: RetroChatTransport, useValue: chat.retro },
    { provide: CHAT_TIMERS, useValue: chat.timers },
    {
      provide: PANEL_CHUNK_LOADER_DEPS,
      useValue: {
        importer: chat.importer.importer,
        baseUrl: 'http://localhost/chunk-importer.js',
        importUrl: () => new Promise<Type<unknown>>(() => undefined),
        timers: chat.timers,
        requestIdle: null,
      },
    },
  ];
}

function newChatDoubles(): ChatDoubles {
  return {
    timers: new ManualTimers(),
    importer: new ControlledImporter(),
    poker: new FakeTransport('poker'),
    retro: new FakeTransport('retro'),
  };
}

function chatMessage(seq: number): ChatMessage {
  const hex = seq.toString(16).padStart(12, '0');
  return {
    id: `00000000-0000-4000-8000-${hex}`,
    seq,
    clientMessageId: `11111111-1111-4111-8111-${hex}`,
    authorId: 'someone-else',
    authorName: 'Dana',
    text: `message ${seq}`,
    sentAt: '2026-05-01T10:00:00.000Z',
  };
}

// --- Globals: matchMedia and storage, restored after every test ---------------------------------

const windows = (): Window[] => {
  const view = document.defaultView;
  return view !== null && view !== window ? [window, view] : [window];
};

function installMatchMedia(narrow: boolean): void {
  const list = (media: string) => ({
    matches: media === CHAT_NARROW_QUERY ? narrow : false,
    media,
    onchange: null,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    addListener: (): void => undefined,
    removeListener: (): void => undefined,
    dispatchEvent: (): boolean => false,
  });
  for (const win of windows()) {
    Object.defineProperty(win, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (media: string) => list(media),
    });
  }
}

/** Storage keys seeded by a test; removed again afterwards. */
const seededKeys: string[] = [];
let originalMatchMedia: PropertyDescriptor | undefined;
let hadOwnMatchMedia = false;

beforeEach(() => {
  hadOwnMatchMedia = Object.prototype.hasOwnProperty.call(window, 'matchMedia');
  originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  installMatchMedia(false);
});

afterEach(() => {
  for (const win of windows()) {
    if (hadOwnMatchMedia && originalMatchMedia) Object.defineProperty(win, 'matchMedia', originalMatchMedia);
    else Reflect.deleteProperty(win, 'matchMedia');
  }
  vi.restoreAllMocks();
  for (const key of seededKeys.splice(0)) {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  }
  for (const storage of [localStorage, sessionStorage]) {
    const markers: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(READ_MARKER_KEY_PREFIX)) markers.push(key);
    }
    for (const key of markers) storage.removeItem(key);
  }
  document.documentElement.style.overflow = '';
});

/** Records every `getItem` key read from `localStorage` and `sessionStorage`. */
function recordStorageReads(): () => string[] {
  const spies = new Set<{ mock: { calls: unknown[][] } }>();
  for (const storage of [localStorage, sessionStorage]) {
    const owner: Storage =
      typeof Storage !== 'undefined' && storage instanceof Storage ? Storage.prototype : storage;
    spies.add(vi.spyOn(owner, 'getItem'));
  }
  return () => [...spies].flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
}

// --- Poker page stubs (as in the existing page specs) -------------------------------------------

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

// --- Retro page stubs --------------------------------------------------------------------------

@Component({ selector: 'app-retro-column', standalone: true, template: '' })
class StubRetroColumnComponent {
  readonly column = input.required<RetroColumn>();
}
@Component({ selector: 'app-retro-toolbar', standalone: true, template: '' })
class StubRetroToolbarComponent {
  readonly isModerator = input<boolean>(false);
  readonly isCompleted = input<boolean>(false);
}
@Component({ selector: 'app-retro-user-menu', standalone: true, template: '' })
class StubRetroUserMenuComponent {}

@Component({ selector: 'app-stub-lobby', standalone: true, template: '<p class="stub-lobby">Lobby</p>' })
class StubLobbyComponent {}

// --- Page harnesses ----------------------------------------------------------------------------

const POKER_ID = 'abc12345';
const RETRO_ID = 'retro-session-1';

interface PageHarness<T> {
  readonly page: T;
  readonly harness: RouterTestingHarness;
  readonly chat: ChatDoubles;
  readonly root: () => HTMLElement;
  readonly flush: () => void;
  /** Lets the importer promises settle, then renders. */
  readonly settle: () => Promise<void>;
  readonly host: () => ChatHostComponent | null;
  readonly store: () => ChatStore;
  readonly launcher: () => HTMLButtonElement | null;
  readonly panel: () => HTMLElement | null;
  /** Activates the launcher, completes the Load_Sequence and renders the open panel. */
  readonly openChat: () => Promise<void>;
}

const ROUTES = [
  { path: 'session/:sessionId', component: SessionPokerPageComponent },
  { path: 'retro/:sessionId', component: RetroBoardPageComponent },
  { path: 'lobby', component: StubLobbyComponent },
];

async function pageHarness<T>(
  harness: RouterTestingHarness,
  chat: ChatDoubles,
  url: string,
  type: Type<T>,
  afterNavigate: () => void,
): Promise<PageHarness<T>> {
  const page = await harness.navigateByUrl(url, type);
  const flush = (): void => {
    TestBed.tick();
    harness.detectChanges();
  };
  afterNavigate();
  flush();
  const root = (): HTMLElement => harness.fixture.nativeElement as HTMLElement;
  const hostDebug = () => harness.fixture.debugElement.query(By.directive(ChatHostComponent));
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    flush();
  };
  const launcher = (): HTMLButtonElement | null =>
    root().querySelector<HTMLButtonElement>('button.chat-launcher');
  const store = (): ChatStore => {
    const debug = hostDebug();
    if (debug === null) throw new Error('no <app-chat-host> rendered');
    return debug.injector.get(ChatStore);
  };
  return {
    page,
    harness,
    chat,
    root,
    flush,
    settle,
    host: () => (hostDebug()?.componentInstance as ChatHostComponent | undefined) ?? null,
    store,
    launcher,
    panel: () => root().querySelector<HTMLElement>('.stub-panel'),
    openChat: async () => {
      launcher()?.click();
      flush();
      const call = chat.importer.calls[chat.importer.calls.length - 1];
      if (call === undefined) throw new Error('the launcher started no Load_Sequence');
      call.resolve(StubPanelComponent);
      await settle();
    },
  };
}

async function renderPokerPage(
  options: { exists?: boolean; connection?: ConnectionState } = {},
): Promise<PageHarness<SessionPokerPageComponent>> {
  const chat = newChatDoubles();
  const ws = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    on: (): Observable<unknown> => EMPTY,
    connectionState: signal<ConnectionState>(options.connection ?? 'connected'),
  };
  const sessionState = {
    currentRound: signal<VotingRound | null>(null),
    participants: signal<User[]>([]),
    sessionConfig: signal<SessionConfiguration | null>(null),
    countdownActive: signal(false),
    currentUser: signal<User | null>(null),
    isRevealed: signal(false),
    selections: signal(new Map<string, CardValue>()),
    metrics: signal<VotingMetrics | null>(null),
    history: signal<HistoryEntry[]>([]),
    votedUserIds: signal(new Set<string>()),
    hasRevealPermission: signal(false),
    hasIssuePermission: signal(false),
    votingSystemCards: signal<ExtendedCardValue[]>([]),
    issueList: signal([]),
    ownerId: signal<string | null>(null),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter(ROUTES),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: WebSocketService, useValue: ws },
      {
        provide: AuthService,
        useValue: { getToken: () => 'test-token', getCurrentUser: () => signal<User | null>(null) },
      },
      { provide: ToastService, useValue: { show: vi.fn(), dismiss: vi.fn(), toasts: signal([]) } },
      { provide: BasePathService, useValue: { getBasePath: () => '', getApiUrl: (p: string) => p } },
      { provide: SessionStateService, useValue: sessionState },
      ...chatProviders(chat),
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
        StubVoteCalloutLayerComponent,
        StubModeratorNoteBalloonComponent,
        ChatHostComponent,
      ],
    },
  });
  const harness = await RouterTestingHarness.create();
  return pageHarness(harness, chat, `/session/${POKER_ID}`, SessionPokerPageComponent, () => {
    TestBed.inject(HttpTestingController)
      .expectOne(`/api/sessions/${POKER_ID}/exists`)
      .flush({ exists: options.exists ?? true });
  });
}

interface RetroPageHarness extends PageHarness<RetroBoardPageComponent> {
  /** Pushes a `retro:session:ended` broadcast through the socket double. */
  readonly endSession: () => void;
}

async function renderRetroPage(
  options: { connection?: ConnectionState } = {},
): Promise<RetroPageHarness> {
  const chat = newChatDoubles();
  const ended$ = new Subject<RetroSessionEndedPayload>();
  const ws = {
    connectionState: signal<ConnectionState>(options.connection ?? 'connected'),
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    on: (event: string): Observable<unknown> =>
      event === RETRO_SESSION_ENDED ? ended$.asObservable() : EMPTY,
  };
  const retroState = {
    columns: signal<RetroColumn[]>([]),
    votesRemaining: signal(3),
    isModerator: signal(false),
    isCompleted: signal(false),
    context: signal(''),
    config: signal<RetroConfiguration | null>(null),
    reset: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter(ROUTES),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: RetroWebSocketService, useValue: ws },
      { provide: RetroStateService, useValue: retroState },
      { provide: AuthService, useValue: { getToken: () => 'test-token', logout: vi.fn() } },
      { provide: ToastService, useValue: { show: vi.fn(), dismiss: vi.fn(), dismissByTag: vi.fn() } },
      { provide: BasePathService, useValue: { getBasePath: () => '', getApiUrl: (p: string) => p } },
      ...chatProviders(chat),
    ],
  }).overrideComponent(RetroBoardPageComponent, {
    set: {
      imports: [
        CommonModule,
        FormsModule,
        ChatHostComponent,
        StubConnectionStatusComponent,
        StubRetroColumnComponent,
        StubRetroToolbarComponent,
        StubRetroUserMenuComponent,
      ],
    },
  });
  const harness = await RouterTestingHarness.create();
  const h = await pageHarness(harness, chat, `/retro/${RETRO_ID}`, RetroBoardPageComponent, () => undefined);
  return { ...h, endSession: () => ended$.next({ sessionId: RETRO_ID }) };
}

/** Renders either Board_Page, for the tests that hold for both. */
async function renderBoard(kind: BoardKind): Promise<PageHarness<{ sessionId: WritableSignal<string> }>> {
  return kind === 'poker' ? renderPokerPage() : renderRetroPage();
}

// --- Page wiring -------------------------------------------------------------------------------

describe('Board_Page wiring: outside every Interaction_Blocker (R1.5)', () => {
  it.each(['reconnecting', 'disconnected'] as const)(
    'poker: while %s the launcher and the panel are not inside [inert] and the launcher activates',
    async (connection) => {
      const h = await renderPokerPage({ connection });
      const root = h.root();
      expect(h.page.blocked()).toBe(true);
      expect(root.querySelectorAll('.interaction-blocker[inert]').length).toBeGreaterThanOrEqual(3);

      const launcher = h.launcher();
      expect(launcher).not.toBeNull();
      expect(launcher?.closest('[inert]')).toBeNull();
      expect(launcher?.closest('.interaction-blocker')).toBeNull();
      // The host is the sibling after .session-poker-page, not inside it (D9).
      const hostEl = root.querySelector('app-chat-host');
      expect(hostEl?.previousElementSibling?.classList.contains('session-poker-page')).toBe(true);
      expect(hostEl?.closest('.session-poker-page')).toBeNull();

      await h.openChat();
      expect(h.chat.importer.calls).toHaveLength(1);
      expect(h.store().panelState()).toBe('open');
      expect(h.panel()).not.toBeNull();
      expect(h.panel()?.closest('[inert]')).toBeNull();
    },
  );

  it.each(['reconnecting', 'disconnected'] as const)(
    'retro: while %s the launcher and the panel are not inside [inert] and the launcher activates',
    async (connection) => {
      const h = await renderRetroPage({ connection });
      const root = h.root();
      expect(h.page.blocked()).toBe(true);
      expect(root.querySelectorAll('.interaction-blocker[inert]').length).toBeGreaterThanOrEqual(2);

      const launcher = h.launcher();
      expect(launcher).not.toBeNull();
      expect(launcher?.closest('[inert]')).toBeNull();
      const hostEl = root.querySelector('app-chat-host');
      expect(hostEl?.previousElementSibling?.classList.contains('retro-board')).toBe(true);
      expect(hostEl?.closest('.retro-board')).toBeNull();

      await h.openChat();
      expect(h.store().panelState()).toBe('open');
      expect(h.panel()?.id).toBe('chat-panel-retro');
      expect(h.panel()?.closest('[inert]')).toBeNull();
    },
  );
});

describe('Board_Page wiring: "Session Not Found" (R1.3)', () => {
  it('renders no launcher and no panel in the "Session Not Found" branch', async () => {
    const h = await renderPokerPage({ exists: false });
    expect(h.page.sessionNotFound()).toBe(true);
    expect(h.root().textContent).toContain('Session Not Found');
    expect(h.root().querySelector('app-chat-host')).toBeNull();
    expect(h.launcher()).toBeNull();
    expect(h.panel()).toBeNull();
  });

  it.each(['open', 'minimized'] as const)(
    'removes the launcher and the panel when the page switches to that branch while %s',
    async (state) => {
      const h = await renderPokerPage();
      await h.openChat();
      h.store().panelState.set(state);
      h.flush();
      const launcher = h.launcher();
      const panel = h.panel();
      expect(launcher).not.toBeNull();
      expect(panel).not.toBeNull();

      h.page.sessionNotFound.set(true);
      h.flush();
      expect(h.root().textContent).toContain('Session Not Found');
      expect(h.host()).toBeNull();
      expect(h.launcher()).toBeNull();
      expect(h.panel()).toBeNull();
      expect(launcher?.isConnected).toBe(false);
      expect(panel?.isConnected).toBe(false);
    },
  );
});

describe('Board_Page wiring: page destroy (R1.9)', () => {
  it('poker: navigating to /lobby removes the launcher and the open panel from the document', async () => {
    const h = await renderPokerPage();
    await h.openChat();
    const launcher = h.launcher();
    const panel = h.panel();
    expect(launcher?.isConnected).toBe(true);
    expect(panel?.isConnected).toBe(true);

    h.page.goToLobby();
    await h.harness.fixture.whenStable();
    h.flush();
    expect(h.root().querySelector('.stub-lobby')).not.toBeNull();
    expect(launcher?.isConnected).toBe(false);
    expect(panel?.isConnected).toBe(false);
    expect(document.querySelector('.chat-launcher')).toBeNull();
    expect(document.querySelector('.stub-panel')).toBeNull();
  });

  it('retro: the navigation after retro:session:ended removes the launcher and the panel', async () => {
    const h = await renderRetroPage();
    await h.openChat();
    h.store().panelState.set('minimized');
    h.flush();
    const launcher = h.launcher();
    const panel = h.panel();
    expect(launcher?.isConnected).toBe(true);
    expect(panel?.isConnected).toBe(true);

    h.endSession();
    await h.harness.fixture.whenStable();
    h.flush();
    expect(h.root().querySelector('.stub-lobby')).not.toBeNull();
    expect(launcher?.isConnected).toBe(false);
    expect(panel?.isConnected).toBe(false);
    expect(document.querySelector('.chat-launcher')).toBeNull();
  });
});

describe('Board_Page wiring: Panel_State and session binding (R1.8, R18.11)', () => {
  it.each(['poker', 'retro'] as const)(
    '%s: starts closed on render and reads no Panel_State from browser storage',
    async (kind) => {
      for (const key of [
        'scrum-poker-chat-panel',
        'scrum-poker-chat-panel-state',
        `chat-panel-${kind}`,
        'panelState',
      ]) {
        seededKeys.push(key);
        localStorage.setItem(key, 'open');
        sessionStorage.setItem(key, 'open');
      }
      const reads = recordStorageReads();

      const h = await renderBoard(kind);
      expect(h.store().panelState()).toBe('closed');
      expect(h.panel()).toBeNull();
      expect(h.launcher()?.getAttribute('aria-expanded')).toBe('false');
      expect(h.launcher()?.getAttribute('aria-controls')).toBe(`chat-panel-${kind}`);
      // The only chat value in storage is the Read_Marker (R2.10); nothing else is read.
      const chatReads = reads().filter((key) => /chat|panel/i.test(key));
      for (const key of chatReads) expect(key.startsWith(`${READ_MARKER_KEY_PREFIX}:`)).toBe(true);
    },
  );

  it.each(['poker', 'retro'] as const)(
    '%s: binds the store to the page sessionId and resets it when the sessionId changes',
    async (kind) => {
      const h = await renderBoard(kind);
      const store = h.store();
      expect(store.boardKind).toBe(kind);
      expect(store.sessionId()).toBe(kind === 'poker' ? POKER_ID : RETRO_ID);

      const transport = kind === 'poker' ? h.chat.poker : h.chat.retro;
      const added: ChatMessageAddedPayload = { message: chatMessage(1) };
      transport.added$.next(added);
      store.draft.set('half-written');
      h.flush();
      expect(store.entries()).toHaveLength(1);
      expect(store.unreadCount()).toBe(1);

      h.page.sessionId.set('next-session');
      h.flush();
      expect(h.store()).toBe(store);
      expect(store.sessionId()).toBe('next-session');
      expect(store.entries()).toHaveLength(0);
      expect(store.unreadCount()).toBe(0);
      expect(store.draft()).toBe('');
      expect(store.panelState()).toBe('closed');
    },
  );
});

// --- Stylesheet helpers ------------------------------------------------------------------------

const CHAT_DIR = join(process.cwd(), 'src', 'app', 'components', 'chat');
const STYLES_PATH = join(process.cwd(), 'src', 'styles.scss');

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

function matchingParen(text: string, open: number, pair: '()' | '{}' = '()'): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === pair[0]) depth++;
    else if (text[i] === pair[1] && --depth === 0) return i;
  }
  throw new Error(`unbalanced ${pair} in "${text}"`);
}

/** The custom properties of the first `:root` block of `styles.scss`. */
function rootTokens(): Map<string, string> {
  const css = stripComments(readFileSync(STYLES_PATH, 'utf8'));
  const match = /:root\s*\{/.exec(css);
  if (match === null) throw new Error('styles.scss declares no :root block');
  const open = css.indexOf('{', match.index);
  const body = css.slice(open + 1, matchingParen(css, open, '{}'));
  const tokens = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (!tokens.has(m[1])) tokens.set(m[1], m[2].trim());
  }
  return tokens;
}

const TOKENS = rootTokens();

/** A declared colour with every `var(--x)` replaced by its `:root` value. */
function resolve(value: string): string {
  const match = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim());
  if (match === null) return value.trim();
  const tokenValue = TOKENS.get(match[1]);
  if (tokenValue === undefined) throw new Error(`styles.scss declares no ${match[1]}`);
  return resolve(tokenValue);
}

/** The declared value of `property` on `selector`, or a throw naming what was missing. */
function declaredOn(component: unknown, selector: string, property: string): string {
  const value = stylesFor(component, selector).get(property);
  if (value === undefined) throw new Error(`${selector} declares no ${property}`);
  return value;
}

/** A declared colour painted over an opaque `backdrop`: `rgba()` is alpha-composited. */
function over(value: string, backdrop: string): string {
  const rgba = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i.exec(value);
  if (rgba === null) return value;
  return mixColors(`rgb(${rgba[1]}, ${rgba[2]}, ${rgba[3]})`, backdrop, Number(rgba[4]));
}

const gradientStops = (value: string): string[] =>
  [...value.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)].map((m) => m[0]);

/** Every point of a gradient, sampled in 5 % steps between consecutive stops. */
function gradientPoints(value: string): string[] {
  const stops = gradientStops(value);
  const points: string[] = [];
  for (let s = 0; s < stops.length - 1; s++) {
    for (let i = 0; i <= 20; i++) points.push(mixColors(stops[s + 1], stops[s], i / 20));
  }
  return points.length > 0 ? points : stops;
}

const PAGE_STOPS = gradientStops(resolve('var(--gradient-page-bg)'));
/** The Chat_Panel shell surface (also the minimized Panel_Header and the notice). */
const PANEL_SURFACE = resolve(declaredOn(ChatPanelComponent, '.chat-panel', 'background'));
/** The panel surface over every stop of the dark page gradient behind it. */
const PANEL_BACKDROPS = PAGE_STOPS.map((stop) => over(PANEL_SURFACE, stop));

// --- Scroll clearance (R12.5) ------------------------------------------------------------------

/** The bottom padding a selector resolves to, `padding` and `padding-bottom` in source order. */
function bottomPaddingPx(component: unknown, selector: string, media?: string): number | null {
  let bottom: number | null = null;
  for (const rule of rulesOf(component)) {
    if (rule.media !== null && (media === undefined || !rule.media.includes(media))) continue;
    if (!rule.selectors.includes(selector)) continue;
    for (const [property, value] of rule.declarations) {
      if (property === 'padding') bottom = edgesPx(value).bottom;
      else if (property === 'padding-bottom') bottom = toPx(value);
    }
  }
  return bottom;
}

describe('Scroll clearance below the Chat_Launcher (R12.5)', () => {
  const containers: {
    page: string;
    component: unknown;
    selector: string;
    /** `MOBILE_MEDIA` for a rule that only exists below 768 px. */
    media?: string;
    /** False for the page root, where the document scrolls. */
    scrolls: boolean;
  }[] = [
    { page: 'poker', component: SessionPokerPageComponent, selector: '.session-poker-page__board-area', scrolls: true },
    { page: 'poker', component: SessionPokerPageComponent, selector: '.session-poker-page__sidebar--desktop', scrolls: true },
    {
      page: 'poker',
      component: SessionPokerPageComponent,
      selector: '.session-poker-page__sidebar-overlay',
      media: MOBILE_MEDIA,
      scrolls: true,
    },
    {
      page: 'poker',
      component: SessionPokerPageComponent,
      selector: '.session-poker-page',
      media: MOBILE_MEDIA,
      scrolls: false,
    },
    { page: 'retro', component: RetroBoardPageComponent, selector: '.retro-board__columns', scrolls: true },
  ];

  it.each(containers)('$page $selector declares padding-bottom: 88px', ({ component, selector, media, scrolls }) => {
    expect(stylesFor(component, selector, media).get('padding-bottom')).toBe('88px');
    const viewports = media === undefined ? [undefined, MOBILE_MEDIA] : [media];
    for (const viewport of viewports) {
      expect(bottomPaddingPx(component, selector, viewport), `${selector} @ ${viewport ?? 'wide'}`).toBe(88);
    }
    if (scrolls) {
      const declared = stylesFor(component, selector, media);
      const overflowY = declared.get('overflow-y') ?? declared.get('overflow');
      expect(['auto', 'scroll']).toContain(overflowY);
    }
  });
});

// --- Token scan (R12.1) ------------------------------------------------------------------------

const CHAT_COMPONENTS: { name: string; component: unknown }[] = [
  { name: 'ChatLauncherComponent', component: ChatLauncherComponent },
  { name: 'ChatLoadErrorNoticeComponent', component: ChatLoadErrorNoticeComponent },
  { name: 'ChatPanelComponent', component: ChatPanelComponent },
  { name: 'ChatPanelHeaderComponent', component: ChatPanelHeaderComponent },
  { name: 'ChatMessageListComponent', component: ChatMessageListComponent },
  { name: 'ChatComposerComponent', component: ChatComposerComponent },
  { name: 'ChatPresenceListComponent', component: ChatPresenceListComponent },
];

/** Properties whose value carries a colour. */
const COLOUR_PROPERTY =
  /^(color|background(-color|-image)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?)$/;

/** Keywords that may sit in a colour-bearing value without being a colour. */
const NON_COLOUR_KEYWORDS = new Set([
  'none', 'transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'inset',
  'solid', 'dashed', 'dotted', 'double', 'auto', 'thin', 'medium', 'thick', 'hidden',
]);

const COLOUR_FUNCTION = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|linear-gradient|radial-gradient|conic-gradient)\(/i;

/** The custom properties a value reads, and anything else in it that is (or may be) a colour. */
function colourParts(value: string): { tokens: string[]; literals: string[] } {
  const tokens: string[] = [];
  const literals: string[] = [];
  let rest = value;
  for (let at = rest.indexOf('var('); at !== -1; at = rest.indexOf('var(')) {
    const close = matchingParen(rest, at + 3);
    const inner = rest.slice(at + 4, close);
    const comma = inner.indexOf(',');
    tokens.push((comma === -1 ? inner : inner.slice(0, comma)).trim());
    if (comma !== -1) {
      const fallback = colourParts(inner.slice(comma + 1));
      tokens.push(...fallback.tokens);
      literals.push(...fallback.literals);
    }
    rest = `${rest.slice(0, at)} ${rest.slice(close + 1)}`;
  }
  if (COLOUR_FUNCTION.test(rest)) literals.push(rest.trim());
  for (const word of rest.split(/[\s,/]+/)) {
    if (word === '' || /^-?[\d.]+([a-z%]+)?$/i.test(word)) continue;
    if (!NON_COLOUR_KEYWORDS.has(word.toLowerCase())) literals.push(word);
  }
  return { tokens, literals };
}

interface ColourUse {
  readonly where: string;
  readonly property: string;
  readonly value: string;
}

function colourUses(): ColourUse[] {
  const uses: ColourUse[] = [];
  for (const { name, component } of CHAT_COMPONENTS) {
    for (const rule of rulesOf(component)) {
      for (const [property, value] of rule.declarations) {
        if (COLOUR_PROPERTY.test(property)) {
          uses.push({ where: `${name} ${rule.selectors.join(', ')}`, property, value });
        }
      }
    }
  }
  const keyframes = stripComments(readFileSync(join(CHAT_DIR, 'chat.keyframes.scss'), 'utf8'));
  for (const m of keyframes.matchAll(/([\w-]+)\s*:\s*([^;{}]+)/g)) {
    if (COLOUR_PROPERTY.test(m[1])) uses.push({ where: 'chat.keyframes.scss', property: m[1], value: m[2].trim() });
  }
  return uses;
}

describe('Chat colours come from styles.scss tokens (R12.1)', () => {
  const uses = colourUses();

  it('scans a non-trivial set of colour declarations', () => {
    expect(uses.length).toBeGreaterThan(30);
  });

  it('every colour in the chat stylesheets is a var(--…) declared in styles.scss :root', () => {
    const offenders: string[] = [];
    for (const use of uses) {
      const { tokens, literals } = colourParts(use.value);
      for (const literal of literals) offenders.push(`${use.where} { ${use.property}: ${use.value} } has "${literal}"`);
      for (const token of tokens) {
        if (!TOKENS.has(token)) offenders.push(`${use.where} { ${use.property} } reads undeclared ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the launcher and the panel use the R12.1 named tokens', () => {
    expect(declaredOn(ChatLauncherComponent, '.chat-launcher', 'background')).toBe('var(--gradient-primary)');
    expect(declaredOn(ChatLauncherComponent, '.chat-launcher', 'color')).toBe('var(--text-on-primary)');
    expect(declaredOn(ChatPanelComponent, '.chat-panel', 'background')).toBe('var(--surface-board)');
    expect(declaredOn(ChatPanelComponent, '.chat-panel', 'color')).toBe('var(--text-primary)');
    expect(declaredOn(ChatPanelComponent, '.chat-panel', 'box-shadow')).toBe('var(--shadow-lg)');
  });

  it('the avatar palette is the only colour outside the stylesheets: one inline binding fed by AVATAR_PALETTE', () => {
    const bindings: string[] = [];
    for (const file of [
      'chat-launcher.component.ts',
      'chat-load-error-notice.component.ts',
      'chat-panel.component.ts',
      'chat-panel-header.component.ts',
      'chat-message-list.component.ts',
      'chat-composer.component.ts',
      'chat-presence-list.component.ts',
      'chat-host.component.ts',
    ]) {
      const source = readFileSync(join(CHAT_DIR, file), 'utf8');
      expect(source, `${file} binds [style] or [ngStyle]`).not.toMatch(/\[(style|ngStyle)\]\s*=/);
      for (const m of source.matchAll(/\[style\.([\w-]+)(?:\.[\w%]+)?\]\s*=\s*"([^"]*)"/g)) {
        if (COLOUR_PROPERTY.test(m[1])) bindings.push(`${file} ${m[1]}=${m[2]}`);
      }
    }
    expect(bindings).toEqual(['chat-message-list.component.ts background-color=row.color']);
    const list = readFileSync(join(CHAT_DIR, 'chat-message-list.component.ts'), 'utf8');
    expect(list).toMatch(/color:\s*own\s*\?\s*''\s*:\s*AVATAR_PALETTE\[/);
  });
});

// --- Contrast (R5.4, R5.7, R11.11, R11.12, R24.8) ----------------------------------------------

describe('Chat contrast pairs (values from styles.scss)', () => {
  it('R5.4: every avatar palette colour reaches 4.5:1 against the initials colour', () => {
    const initials = resolve(declaredOn(ChatMessageListComponent, '.chat-msg__avatar', 'color'));
    expect(AVATAR_PALETTE).toHaveLength(8);
    expect(new Set(AVATAR_PALETTE.map((c) => c.toLowerCase())).size).toBe(8);
    for (const colour of AVATAR_PALETTE) {
      const ratio = wcagContrastRatio(colour, initials);
      expect(ratio, `${initials} on ${colour} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(WCAG_AA_TEXT_CONTRAST);
    }
  });

  it('R5.7: own and other bubbles differ and each reaches 4.5:1 with its text', () => {
    const otherBg = resolve(declaredOn(ChatMessageListComponent, '.chat-msg__bubble', 'background'));
    const otherFg = resolve(declaredOn(ChatMessageListComponent, '.chat-msg__bubble', 'color'));
    const ownBg = resolve(declaredOn(ChatMessageListComponent, '.chat-msg--own .chat-msg__bubble', 'background'));
    const ownFg = resolve(declaredOn(ChatMessageListComponent, '.chat-msg--own .chat-msg__bubble', 'color'));
    expect(ownBg.toLowerCase()).not.toBe(otherBg.toLowerCase());
    expect(wcagContrastRatio(ownBg, ownFg)).toBeGreaterThanOrEqual(WCAG_AA_TEXT_CONTRAST);
    expect(wcagContrastRatio(otherBg, otherFg)).toBeGreaterThanOrEqual(WCAG_AA_TEXT_CONTRAST);
    // Timestamps and delivery text: --text-secondary on other rows, inherited on own rows (R11.12).
    const time = resolve(declaredOn(ChatMessageListComponent, '.chat-msg__time', 'color'));
    expect(wcagContrastRatio(otherBg, time)).toBeGreaterThanOrEqual(WCAG_AA_TEXT_CONTRAST);
    expect(declaredOn(ChatMessageListComponent, '.chat-msg--own .chat-msg__time', 'color')).toBe('inherit');
  });

  it('R11.12: the Unread_Badge text reaches 4.5:1 on the badge', () => {
    const bg = resolve(declaredOn(ChatLauncherComponent, '.chat-launcher__badge', 'background'));
    const fg = resolve(declaredOn(ChatLauncherComponent, '.chat-launcher__badge', 'color'));
    expect(wcagContrastRatio(bg, fg)).toBeGreaterThanOrEqual(WCAG_AA_TEXT_CONTRAST);
  });

  it('R11.12: the Composer placeholder reaches 4.5:1 on the text area over the panel', () => {
    const placeholder = resolve(declaredOn(ChatComposerComponent, '.chat-composer__input::placeholder', 'color'));
    expect(stylesFor(ChatComposerComponent, '.chat-composer__input::placeholder').get('opacity')).toBe('1');
    const field = resolve(declaredOn(ChatComposerComponent, '.chat-composer__input', 'background'));
    for (const backdrop of PANEL_BACKDROPS) {
      const surface = over(field, backdrop);
      const ratio = wcagContrastRatio(placeholder, surface);
      expect(ratio, `${placeholder} on ${surface} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(WCAG_AA_TEXT_CONTRAST);
    }
  });

  it('R24.8: the Unread_Dot reaches 3:1 against the minimized Panel_Header background', () => {
    const dot = resolve(declaredOn(ChatPanelHeaderComponent, '.chat-header__dot', 'background'));
    // The dot sits inside the Restore control, which paints nothing of its own.
    expect(declaredOn(ChatPanelHeaderComponent, '.chat-header__control', 'background')).toBe('transparent');
    for (const backdrop of PANEL_BACKDROPS) {
      const ratio = wcagContrastRatio(dot, backdrop);
      expect(ratio, `${dot} on ${backdrop} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_CONTRAST);
    }
  });
});

// --- Focus ring (R11.11, C11) ------------------------------------------------------------------

/** Splits a value at its top-level commas (not inside parentheses). */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')') depth--;
    else if (value[i] === ',' && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

const pxOf = (length: string): number => (length === '0' ? 0 : Number.parseFloat(length));

/** Two-tone ring bands from stacked `0 0 0 Npx var(--x)` shadows, innermost first. */
function ringBands(value: string): { token: string; thickness: number }[] {
  let previous = 0;
  return splitTopLevel(value).map((layer) => {
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+var\(\s*(--[\w-]+)\s*\)$/.exec(layer);
    if (m === null) throw new Error(`unexpected box-shadow layer "${layer}"`);
    expect([pxOf(m[1]), pxOf(m[2]), pxOf(m[3])], `offsets and blur of "${layer}"`).toEqual([0, 0, 0]);
    const spread = pxOf(m[4]);
    const band = { token: m[5], thickness: spread - previous };
    previous = spread;
    return band;
  });
}

interface FocusRing {
  readonly where: string;
  readonly component: unknown;
  readonly control: string;
  readonly shadow: string;
}

function focusRings(): FocusRing[] {
  const rings: FocusRing[] = [];
  for (const { name, component } of CHAT_COMPONENTS) {
    for (const rule of rulesOf(component)) {
      const shadow = rule.declarations.get('box-shadow');
      if (shadow === undefined) continue;
      for (const selector of rule.selectors) {
        if (!selector.endsWith(':focus-visible')) continue;
        rings.push({ where: `${name} ${selector}`, component, control: selector.replace(/:focus-visible$/, ''), shadow });
      }
    }
  }
  return rings;
}

/** The colours a control paints under its ring: its own fill, or the surface behind it. */
function controlFills(component: unknown, control: string, surroundings: string[]): string[] {
  const background = stylesFor(component, control).get('background') ?? 'transparent';
  if (background === 'transparent' || background === 'none') return surroundings;
  const value = resolve(background);
  if (/gradient\(/.test(value)) return gradientPoints(value);
  return surroundings.map((backdrop) => over(value, backdrop));
}

describe('Chat focus ring (R11.11, C11)', () => {
  const rings = focusRings();
  const inner = resolve('var(--text-on-primary)');
  const outer = resolve('var(--text-primary)');

  it('every chat control with a focus ring is covered, including the R11.11 controls', () => {
    const controls = rings.map((r) => r.control);
    for (const expected of [
      '.chat-launcher',
      '.chat-header__control',
      '.chat-composer__input',
      '.chat-composer__send',
      '.chat-list__indicator',
      '.chat-load-error__button',
    ]) {
      expect(controls).toContain(expected);
    }
  });

  it.each(focusRings())('$where: two bands of --text-on-primary inside --text-primary, each at least 2px', ({ shadow }) => {
    const bands = ringBands(shadow);
    expect(bands.map((b) => b.token)).toEqual(['--text-on-primary', '--text-primary']);
    for (const band of bands) expect(band.thickness).toBeGreaterThanOrEqual(2);
    expect(bands.reduce((sum, b) => sum + b.thickness, 0)).toBeLessThanOrEqual(7);
  });

  it('the two bands reach 3:1 against each other', () => {
    expect(wcagContrastRatio(inner, outer)).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_CONTRAST);
  });

  it.each(focusRings())('$where: the ring reaches 3:1 against the control and the surface around it', ({ component, control }) => {
    // The launcher floats over the page; every other control sits on the panel or notice surface.
    const surroundings =
      component === ChatLauncherComponent
        ? [...PAGE_STOPS, ...PAGE_STOPS.map((stop) => over(resolve('var(--surface-board)'), stop))]
        : PANEL_BACKDROPS;
    const adjacent = [...controlFills(component, control, surroundings), ...surroundings];
    for (const colour of adjacent) {
      const ratio = Math.max(wcagContrastRatio(inner, colour), wcagContrastRatio(outer, colour));
      expect(ratio, `ring on ${colour} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_CONTRAST);
    }
  });
});
