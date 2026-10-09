import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { EMPTY, Observable, Subject } from 'rxjs';
import {
  FeelingCategory,
  RETRO_SESSION_ENDED,
  RetroCard,
  RetroColumn,
  RetroConfiguration,
  RetroSessionEndedPayload,
  User,
} from '@shared/types';
import {
  END_SESSION_FAILED_MESSAGE,
  END_SESSION_TIMEOUT_MS,
  END_SESSION_TOAST_MS,
  RetroBoardPageComponent,
  SESSION_ENDED_MESSAGE,
} from './retro-board-page.component';
import { RetroStateService } from '../../services/retro-state.service';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { RetroExportService } from '../../services/retro-export.service';
import { RetroScreenshotService } from '../../services/retro-screenshot.service';
import { FeelingsService } from '../../services/feelings.service';
import { AuthService } from '../../services/auth.service';
import { BasePathService } from '../../services/base-path.service';
import { ToastService } from '../../services/toast.service';

/**
 * Stream 8 — ending a retrospective from the board (R9.1–R9.6, R9.12, R9.13, R9.16).
 *
 * Two surfaces are covered here, because the single notification the
 * participant sees is a property of the pair rather than of either one:
 *
 *   1. **`RetroBoardPageComponent`** — the moderator-only control, the
 *      confirmation dialog, the one authenticated DELETE it sends, and the
 *      error, timeout and event-driven paths. Rendered against doubles for the
 *      retro state and the socket, with the real `HttpClient` wired to the
 *      testing backend so each request is asserted rather than stubbed.
 *   2. **`RetroWebSocketService`** — the internal `retro:session:ended`
 *      subscription, against a mock socket. Once the event has arrived, the
 *      1000 close that follows it and a 4004 close answering a message that
 *      raced the removal must both stay silent, otherwise the page's single
 *      notification is joined by a transport one (R9.12, R11.17, R11.18).
 *
 * The page's success path deliberately shows nothing: it keeps the control
 * disabled and waits for the broadcast, which is what drives the notification
 * and the navigation for every participant, the moderator included.
 */

// --- Fixtures ----------------------------------------------------------------------

const SESSION_ID = 'retro-session-1';
const USER_ID = 'user-1';
const TOKEN = 'test-token';
const DELETE_URL = `/api/retro/sessions/${SESSION_ID}`;

function makeCard(overrides: Partial<RetroCard> = {}): RetroCard {
  return {
    id: 'card-1',
    text: 'Pairing on the token refresh paid off',
    authorId: USER_ID,
    authorName: 'Alice',
    votes: 3,
    votedBy: [USER_ID],
    comments: [],
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
      name: 'Went well',
      order: 0,
      cards: [makeCard({ id: 'card-1', order: 0 }), makeCard({ id: 'card-2', order: 1 })],
    },
    {
      id: 'col-2',
      name: 'To improve',
      order: 1,
      cards: [makeCard({ id: 'card-3', columnId: 'col-2', order: 0, votes: 1 })],
    },
  ];
}

function makeConfig(): RetroConfiguration {
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

const PARTICIPANTS: User[] = [
  { id: USER_ID, displayName: 'Alice', role: 'moderator', isAnonymous: false },
];

interface Harness {
  readonly fixture: ComponentFixture<RetroBoardPageComponent>;
  readonly root: HTMLElement;
  readonly http: HttpTestingController;
  readonly toast: { show: ReturnType<typeof vi.fn> };
  readonly router: { navigate: ReturnType<typeof vi.fn> };
  readonly ws: {
    send: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  /** Pushes a `retro:session:ended` broadcast through the socket double. */
  endSession(): void;
  /** Flushes change detection and the render effects it schedules. */
  settle(): Promise<void>;
  endButton(): HTMLButtonElement | null;
  dialog(): HTMLElement | null;
  cancelButton(): HTMLButtonElement | null;
  confirmButton(): HTMLButtonElement | null;
}

async function renderBoard(options: { moderator: boolean }): Promise<Harness> {
  const sessionEnded$ = new Subject<RetroSessionEndedPayload>();

  const retroState = {
    columns: signal(makeColumns()).asReadonly(),
    votesRemaining: signal(4).asReadonly(),
    isModerator: signal(options.moderator).asReadonly(),
    isCompleted: signal(false).asReadonly(),
    context: signal('Sprint 14').asReadonly(),
    config: signal(makeConfig()).asReadonly(),
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
    // Only the end-session event is live; every other subscription stays empty.
    on: vi.fn(
      (event: string): Observable<unknown> =>
        event === RETRO_SESSION_ENDED ? sessionEnded$.asObservable() : EMPTY,
    ),
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

  const toast = { show: vi.fn(), dismiss: vi.fn(), dismissByTag: vi.fn() };
  const router = { navigate: vi.fn() };

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
      { provide: AuthService, useValue: { getToken: () => TOKEN, logout: vi.fn() } },
      {
        provide: BasePathService,
        useValue: { getApiUrl: (path: string) => path, getBasePath: () => '' },
      },
      { provide: ToastService, useValue: toast },
      { provide: Router, useValue: router },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: { get: () => SESSION_ID } } },
      },
    ],
  });

  const fixture = TestBed.createComponent(RetroBoardPageComponent);
  const root = fixture.nativeElement as HTMLElement;
  const settle = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };
  await settle();

  return {
    fixture,
    root,
    http: TestBed.inject(HttpTestingController),
    toast,
    router,
    ws,
    endSession: () => sessionEnded$.next({ sessionId: SESSION_ID }),
    settle,
    endButton: () => root.querySelector<HTMLButtonElement>('.retro-board__end-btn'),
    dialog: () => root.querySelector<HTMLElement>('[role="alertdialog"]'),
    cancelButton: () => root.querySelector<HTMLButtonElement>('.retro-board__dialog-btn--cancel'),
    confirmButton: () => root.querySelector<HTMLButtonElement>('.retro-board__dialog-btn--confirm'),
  };
}

/** Opens the confirmation and settles twice, so the focus effect has run. */
async function openDialog(harness: Harness): Promise<void> {
  harness.endButton()!.click();
  await harness.settle();
  await harness.settle();
}

/** The rendered card ids and vote counts, as a stand-in for "the board is unchanged". */
function boardSnapshot(harness: Harness): string {
  return Array.from(harness.root.querySelectorAll('[data-card-id]'))
    .map(card => `${card.getAttribute('data-card-id')}:${card.textContent?.trim()}`)
    .join('|');
}

function textOf(element: Element | null): string {
  return (element?.textContent ?? '').trim();
}

afterEach(() => {
  TestBed.resetTestingModule();
  vi.useRealTimers();
});

// --- The control (R9.1, R9.2, R9.16) -----------------------------------------------

describe('end-session control visibility (R9.1, R9.2)', () => {
  it('gives the moderator a header control named End session', async () => {
    const harness = await renderBoard({ moderator: true });
    const button = harness.endButton();

    expect(button).not.toBeNull();
    expect(button!.tagName).toBe('BUTTON');
    expect(button!.getAttribute('title')).toBe('End session');
    expect(button!.getAttribute('aria-label')).toBe('End session');
    expect(button!.disabled).toBe(false);

    // It sits in the header meta group, alongside the other header controls.
    expect(button!.closest('.retro-board__meta')).not.toBeNull();

    // Reachable and activatable by keyboard: a native button with no negative
    // tabindex that accepts focus.
    expect(button!.getAttribute('tabindex')).toBeNull();
    button!.focus();
    expect(harness.root.ownerDocument.activeElement).toBe(button);
  });

  it('renders the header without the control for a non-moderator', async () => {
    const harness = await renderBoard({ moderator: false });

    expect(harness.endButton()).toBeNull();
    expect(harness.dialog()).toBeNull();
    // The rest of the header is still there.
    expect(harness.root.querySelector('.retro-board__lobby-btn')).not.toBeNull();
    expect(harness.root.querySelector('.retro-board__copy-link-btn')).not.toBeNull();
  });
});

describe('the existing header controls survive the addition (R9.16)', () => {
  it('keeps back to lobby, copy link, votes remaining, session id and the user control', async () => {
    const harness = await renderBoard({ moderator: true });

    const lobby = harness.root.querySelector<HTMLButtonElement>('.retro-board__lobby-btn')!;
    expect(lobby.getAttribute('title')).toBe('Back to Lobby');
    expect(lobby.getAttribute('aria-label')).toBe('Back to Lobby');
    expect(lobby.disabled).toBe(false);

    const copy = harness.root.querySelector<HTMLButtonElement>('.retro-board__copy-link-btn')!;
    expect(copy.getAttribute('title')).toBe('Copy session link');
    expect(copy.getAttribute('aria-label')).toBe('Copy session link');
    expect(copy.disabled).toBe(false);

    const votes = harness.root.querySelector('.retro-board__votes-remaining')!;
    expect(votes.getAttribute('title')).toBe('Your remaining votes');
    expect(votes.getAttribute('aria-label')).toBe('Your remaining votes: 4');
    expect(textOf(votes)).toContain('4 votes left');

    const sessionId = harness.root.querySelector('.retro-board__session-id')!;
    expect(sessionId.getAttribute('title')).toBe(`Session ID: ${SESSION_ID}`);
    expect(textOf(sessionId)).toBe(`ID: ${SESSION_ID}`);

    const avatar = harness.root.querySelector('app-retro-user-menu .user-menu__avatar')!;
    expect(avatar.getAttribute('aria-label')).toBe('User menu for Alice');
  });

  it('leaves those controls untouched while the confirmation is open', async () => {
    const harness = await renderBoard({ moderator: true });
    await openDialog(harness);

    for (const selector of ['.retro-board__lobby-btn', '.retro-board__copy-link-btn']) {
      const button = harness.root.querySelector<HTMLButtonElement>(selector)!;
      expect(button.disabled, selector).toBe(false);
    }
    expect(harness.root.querySelector('.retro-board__votes-remaining')).not.toBeNull();
    expect(harness.root.querySelector('.retro-board__session-id')).not.toBeNull();
    expect(harness.root.querySelector('app-retro-user-menu .user-menu__avatar')).not.toBeNull();
  });
});

// --- The confirmation dialog (R9.3, R9.4) ------------------------------------------

describe('the confirmation dialog (R9.3)', () => {
  it('is absent until the control is activated', async () => {
    const harness = await renderBoard({ moderator: true });

    expect(harness.dialog()).toBeNull();
    expect(harness.fixture.componentInstance.showEndDialog()).toBe(false);
  });

  it('opens as an alertdialog with exactly one confirm and one cancel action', async () => {
    const harness = await renderBoard({ moderator: true });
    await openDialog(harness);

    const dialog = harness.dialog();
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('role')).toBe('alertdialog');
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    expect(dialog!.getAttribute('aria-label')).toBeTruthy();

    const actions = Array.from(dialog!.querySelectorAll('button'));
    expect(actions.length).toBe(2);
    expect(actions.filter(button => button === harness.cancelButton()).length).toBe(1);
    expect(actions.filter(button => button === harness.confirmButton()).length).toBe(1);
    expect(textOf(harness.cancelButton())).toBe('Cancel');
    expect(textOf(harness.confirmButton())).toBe('End session');
  });

  it('places initial keyboard focus on the cancel action', async () => {
    const harness = await renderBoard({ moderator: true });
    await openDialog(harness);

    expect(harness.root.ownerDocument.activeElement).toBe(harness.cancelButton());
  });

  it('leaves the session alone while the confirmation is merely open', async () => {
    const harness = await renderBoard({ moderator: true });
    const before = boardSnapshot(harness);

    await openDialog(harness);

    // Nothing is sent over either transport until the confirm action is taken.
    harness.http.expectNone(DELETE_URL);
    expect(harness.ws.send).not.toHaveBeenCalled();
    expect(harness.toast.show).not.toHaveBeenCalled();
    expect(harness.router.navigate).not.toHaveBeenCalled();
    expect(boardSnapshot(harness)).toBe(before);
    expect(harness.fixture.componentInstance.endInFlight()).toBe(false);
  });
});

describe('cancelling the confirmation (R9.4)', () => {
  it('dismisses the dialog, returns focus to the control and leaves the session unchanged', async () => {
    const harness = await renderBoard({ moderator: true });
    const before = boardSnapshot(harness);
    await openDialog(harness);

    harness.cancelButton()!.click();
    await harness.settle();

    expect(harness.dialog()).toBeNull();
    expect(harness.root.ownerDocument.activeElement).toBe(harness.endButton());
    harness.http.expectNone(DELETE_URL);
    expect(harness.ws.send).not.toHaveBeenCalled();
    expect(harness.toast.show).not.toHaveBeenCalled();
    expect(harness.router.navigate).not.toHaveBeenCalled();
    expect(boardSnapshot(harness)).toBe(before);
  });

  it('can be reopened after a cancellation, with focus back on cancel', async () => {
    const harness = await renderBoard({ moderator: true });
    await openDialog(harness);
    harness.cancelButton()!.click();
    await harness.settle();

    await openDialog(harness);

    expect(harness.dialog()).not.toBeNull();
    expect(harness.root.ownerDocument.activeElement).toBe(harness.cancelButton());
  });
});

// --- Confirming (R9.5, R9.6) -------------------------------------------------------

describe('confirming the end of the session (R9.5, R9.6)', () => {
  it('sends exactly one authenticated DELETE', async () => {
    const harness = await renderBoard({ moderator: true });
    await openDialog(harness);

    harness.confirmButton()!.click();
    await harness.settle();

    const request = harness.http.expectOne(DELETE_URL);
    expect(request.request.method).toBe('DELETE');
    expect(request.request.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);

    request.flush({ success: true });
    await harness.settle();

    harness.http.expectNone(DELETE_URL);
  });

  it('disables the control and the confirm action while the request is pending', async () => {
    const harness = await renderBoard({ moderator: true });
    await openDialog(harness);

    harness.confirmButton()!.click();
    await harness.settle();

    expect(harness.fixture.componentInstance.endInFlight()).toBe(true);
    expect(harness.endButton()!.disabled).toBe(true);
    expect(harness.confirmButton()!.disabled).toBe(true);

    harness.http.expectOne(DELETE_URL).flush({ success: true });
    await harness.settle();
  });

  it('sends no additional DELETE however often the actions are activated again', async () => {
    const harness = await renderBoard({ moderator: true });
    await openDialog(harness);

    harness.confirmButton()!.click();
    await harness.settle();

    // Both the disabled attribute and the in-flight guard refuse a repeat, so
    // neither a click on the rendered control nor a direct call adds a request.
    harness.confirmButton()!.click();
    harness.endButton()!.click();
    harness.fixture.componentInstance.confirmEndSession();
    harness.fixture.componentInstance.openEndDialog();
    harness.fixture.componentInstance.confirmEndSession();
    await harness.settle();

    const requests = harness.http.match(DELETE_URL);
    expect(requests.length).toBe(1);
    requests[0].flush({ success: true });
    await harness.settle();
  });

  it('shows nothing of its own on success and waits for the broadcast', async () => {
    const harness = await renderBoard({ moderator: true });
    const before = boardSnapshot(harness);
    await openDialog(harness);

    harness.confirmButton()!.click();
    await harness.settle();
    harness.http.expectOne(DELETE_URL).flush({ success: true });
    await harness.settle();

    // The dialog is gone, but the control stays disabled: the session is
    // already removed, so a second DELETE has nothing left to remove.
    expect(harness.dialog()).toBeNull();
    expect(harness.fixture.componentInstance.endInFlight()).toBe(true);
    expect(harness.endButton()!.disabled).toBe(true);
    expect(harness.toast.show).not.toHaveBeenCalled();
    expect(harness.router.navigate).not.toHaveBeenCalled();
    expect(boardSnapshot(harness)).toBe(before);

    // The broadcast, not the response, carries the notification (R9.12).
    harness.endSession();
    await harness.settle();
    expect(harness.toast.show).toHaveBeenCalledTimes(1);
    expect(harness.router.navigate).toHaveBeenCalledWith(['/lobby']);
  });
});

// --- Failure and timeout (R9.13) ---------------------------------------------------

describe('the end-session request fails (R9.13)', () => {
  for (const { label, status } of [
    { label: '401', status: 401 },
    { label: '403', status: 403 },
    { label: '404', status: 404 },
    { label: '500', status: 500 },
  ]) {
    it(`dismisses the dialog, re-enables the control and notifies once on ${label}`, async () => {
      const harness = await renderBoard({ moderator: true });
      const before = boardSnapshot(harness);
      await openDialog(harness);

      harness.confirmButton()!.click();
      await harness.settle();
      harness.http
        .expectOne(DELETE_URL)
        .flush({ error: 'FAILED' }, { status, statusText: label });
      await harness.settle();

      expect(harness.dialog()).toBeNull();
      expect(harness.fixture.componentInstance.endInFlight()).toBe(false);
      expect(harness.endButton()!.disabled).toBe(false);

      // Exactly one notification, and it is an error one.
      expect(harness.toast.show).toHaveBeenCalledTimes(1);
      expect(harness.toast.show.mock.calls[0][0]).toBe('error');
      expect(harness.toast.show.mock.calls[0][1]).toBe(END_SESSION_FAILED_MESSAGE);

      // The board is still here, cards and votes as they were.
      expect(harness.router.navigate).not.toHaveBeenCalled();
      expect(boardSnapshot(harness)).toBe(before);
    });
  }

  it('allows a retry once the failure has been reported', async () => {
    const harness = await renderBoard({ moderator: true });
    await openDialog(harness);

    harness.confirmButton()!.click();
    await harness.settle();
    harness.http.expectOne(DELETE_URL).flush({}, { status: 500, statusText: 'Server Error' });
    await harness.settle();

    await openDialog(harness);
    harness.confirmButton()!.click();
    await harness.settle();

    const retry = harness.http.expectOne(DELETE_URL);
    expect(retry.request.method).toBe('DELETE');
    retry.flush({ success: true });
    await harness.settle();
  });

  it('reports a failure without sending anything when the stored token is gone', async () => {
    const harness = await renderBoard({ moderator: true });
    await openDialog(harness);

    vi.spyOn(TestBed.inject(AuthService), 'getToken').mockReturnValue(null);
    harness.confirmButton()!.click();
    await harness.settle();

    harness.http.expectNone(DELETE_URL);
    expect(harness.dialog()).toBeNull();
    expect(harness.fixture.componentInstance.endInFlight()).toBe(false);
    expect(harness.toast.show).toHaveBeenCalledTimes(1);
    expect(harness.toast.show.mock.calls[0][1]).toBe(END_SESSION_FAILED_MESSAGE);
  });
});

describe('the end-session request never answers (R9.13)', () => {
  it('keeps waiting until the 10 second deadline, then notifies once', async () => {
    const harness = await renderBoard({ moderator: true });
    const before = boardSnapshot(harness);
    await openDialog(harness);

    // Fake timers only from here, so the render above ran on real ones. Angular's
    // own scheduling is left alone; only the timeout operator's clock is faked.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });

    harness.confirmButton()!.click();
    harness.fixture.detectChanges();

    const request = harness.http.expectOne(DELETE_URL);
    expect(harness.fixture.componentInstance.endInFlight()).toBe(true);

    // One millisecond short of the deadline nothing has happened yet.
    await vi.advanceTimersByTimeAsync(END_SESSION_TIMEOUT_MS - 1);
    harness.fixture.detectChanges();
    expect(harness.toast.show).not.toHaveBeenCalled();
    expect(harness.dialog()).not.toBeNull();
    expect(harness.confirmButton()!.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    harness.fixture.detectChanges();

    expect(request.cancelled).toBe(true);
    expect(harness.dialog()).toBeNull();
    expect(harness.fixture.componentInstance.endInFlight()).toBe(false);
    expect(harness.endButton()!.disabled).toBe(false);
    expect(harness.toast.show).toHaveBeenCalledTimes(1);
    expect(harness.toast.show.mock.calls[0][0]).toBe('error');
    expect(harness.toast.show.mock.calls[0][1]).toBe(END_SESSION_FAILED_MESSAGE);
    expect(harness.router.navigate).not.toHaveBeenCalled();
    expect(boardSnapshot(harness)).toBe(before);
  });
});

// --- The broadcast (R9.12) ---------------------------------------------------------

describe('the session ended broadcast (R9.12)', () => {
  for (const moderator of [true, false]) {
    const who = moderator ? 'the moderator' : 'a participant';

    it(`notifies ${who} once for at least 5 seconds and leaves for the lobby`, async () => {
      const harness = await renderBoard({ moderator });

      harness.endSession();
      await harness.settle();

      expect(harness.toast.show).toHaveBeenCalledTimes(1);
      const [type, message, options] = harness.toast.show.mock.calls[0];
      expect(type).toBe('info');
      expect(message).toBe(SESSION_ENDED_MESSAGE);
      expect(options?.durationMs).toBe(END_SESSION_TOAST_MS);
      expect(END_SESSION_TOAST_MS).toBeGreaterThanOrEqual(5000);

      // No confirmation, no further input: the navigation happens by itself.
      expect(harness.router.navigate).toHaveBeenCalledTimes(1);
      expect(harness.router.navigate).toHaveBeenCalledWith(['/lobby']);
    });
  }

  it('subscribes to the broadcast through the socket service', async () => {
    const harness = await renderBoard({ moderator: false });

    expect(harness.ws.connect).toHaveBeenCalledWith(SESSION_ID, TOKEN);
    expect(harness.ws.on.mock.calls.map(call => call[0])).toContain(RETRO_SESSION_ENDED);
  });
});

// --- The transport stays silent (R9.12, R11.17, R11.18) ---------------------------

/** Minimal stand-in for the browser WebSocket API. */
class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.OPEN;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(): void {
    /* no sends are asserted here */
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  simulateMessage(event: string, data: unknown): void {
    this.onmessage?.({
      data: JSON.stringify({ event, data, timestamp: new Date().toISOString() }),
    });
  }

  simulateClose(code: number): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }
}

describe('RetroWebSocketService after retro:session:ended (R9.12, R11.17, R11.18)', () => {
  let originalWebSocket: typeof globalThis.WebSocket;
  let service: RetroWebSocketService;
  let toast: {
    show: ReturnType<typeof vi.fn>;
    dismiss: ReturnType<typeof vi.fn>;
    dismissByTag: ReturnType<typeof vi.fn>;
  };
  let router: { navigate: ReturnType<typeof vi.fn> };

  function setUp(): MockWebSocket {
    MockWebSocket.reset();
    originalWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;

    toast = { show: vi.fn(), dismiss: vi.fn(), dismissByTag: vi.fn() };
    router = { navigate: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        { provide: ToastService, useValue: toast },
        { provide: Router, useValue: router },
      ],
    });

    service = TestBed.inject(RetroWebSocketService);
    service.connect(SESSION_ID, TOKEN);
    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    socket.simulateOpen();
    expect(service.connectionState()).toBe('connected');
    return socket;
  }

  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  it('shows no second notification for the 1000 close that follows the broadcast', () => {
    const socket = setUp();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });

    socket.simulateMessage(RETRO_SESSION_ENDED, { sessionId: SESSION_ID });
    expect(service.connectionState()).toBe('disconnected');

    socket.simulateClose(1000);

    // The board page owns the only notification; the transport adds none and
    // starts no reconnect episode, so no new socket appears however long we wait.
    expect(toast.show).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
    expect(service.connectionState()).toBe('disconnected');

    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances.length).toBe(1);
    expect(toast.show).not.toHaveBeenCalled();
  });

  it('stays silent for a 4004 close answering a message that raced the removal', () => {
    const socket = setUp();

    socket.simulateMessage(RETRO_SESSION_ENDED, { sessionId: SESSION_ID });
    socket.simulateClose(4004);

    // Without the event this close shows "session not found" and navigates; the
    // broadcast suppresses both, so the page's notification stands alone.
    expect(toast.show).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
    expect(service.connectionState()).toBe('disconnected');
  });

  /**
   * R13.18 exception (task 24.11), same root cause as the two WS-service cases:
   * this assertion read `expect(toast.show).toHaveBeenCalled()` for a plain drop.
   * R11.14 and R11.26 forbid a notification for the loss, so the contrast between
   * a suppressed close and an ordinary one is now drawn where it remains
   * observable — the connection state and the reconnect episode the drop opens,
   * plus the dismissal of any tagged connection toast (R11.27).
   */
  it('still reports an ordinary drop when no broadcast arrived', () => {
    const socket = setUp();

    socket.simulateClose(1000);

    // The contrast case: the suppression is tied to the broadcast, not to the
    // close code, so a plain drop keeps its existing reconnect behaviour — but it
    // keeps it silently.
    expect(service.connectionState()).toBe('reconnecting');
    expect(toast.show).not.toHaveBeenCalled();
    expect(toast.dismissByTag).toHaveBeenCalledWith('connection');

    service.disconnect();
  });

  /**
   * R13.18 exception (task 24.11): the second session's drop was asserted through
   * `toast.show` being called exactly once. With the per-drop toast gone (R11.14,
   * R11.26), re-arming is shown by the episode itself — the suppressed close ends
   * the episode outright and retries nothing, while the later session's close
   * moves to `reconnecting` and opens a new socket once its backoff elapses.
   */
  it('re-arms on the next connect, so a later session reports its own drops', () => {
    const socket = setUp();
    socket.simulateMessage(RETRO_SESSION_ENDED, { sessionId: SESSION_ID });
    socket.simulateClose(1000);
    expect(toast.show).not.toHaveBeenCalled();
    expect(service.connectionState()).toBe('disconnected');
    expect(MockWebSocket.instances.length).toBe(1);

    service.connect('retro-session-2', TOKEN);
    const next = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    next.simulateOpen();

    // Fake timers only from here, so the reconnect the drop below schedules can be
    // observed without waiting out a real second.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    next.simulateClose(1000);

    expect(service.connectionState()).toBe('reconnecting');
    expect(toast.show).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances.length).toBe(3);

    service.disconnect();
  });
});
