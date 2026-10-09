import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketService } from './websocket.service';
import { ToastService } from './toast.service';
import { GIVE_UP_THRESHOLD } from './connection-episode';

/**
 * Stream 9 — the poker socket's connection episodes (R11.17, R11.18, R11.24).
 *
 * `websocket.service.spec.ts` covers the pre-reducer transport: the URL, `send`,
 * `on`, and the per-drop and per-attempt toasts that R11 removes. This file is its
 * complement and asserts what the episode reducer decides once
 * `WebSocketService` routes its socket events through `reduceEpisode`:
 *
 *   - every episode that ends below the give-up threshold is silent — the
 *     indicator is the only channel for the loss (R11.14, R11.15, R11.26);
 *   - the transition that reaches the tenth attempt carries exactly one `error`
 *     notification and the navigation to login (R11.16, R11.23, R11.24);
 *   - a reserved close code reports its own cause once and never retries
 *     (R11.17, R11.18);
 *   - every connection notification carries the `'connection'` tag, which is what
 *     `ToastService.dismissByTag` acts on when the state leaves `connected` (R11.27).
 *
 * The socket is a hand-written stand-in following the `MockWebSocket` pattern of
 * `components/retro-board/end-session.spec.ts`, and the reconnection timers run
 * under Vitest fake timers, so an episode that spans more than three virtual
 * minutes of backoff still completes in one synchronous test body.
 */

// --- Fixtures ----------------------------------------------------------------------

const TOKEN = 'test-token';
const SESSION_ID = 'sess0001';

/** Tag carried by every connection notification (R11.27). */
const CONNECTION_TAG = 'connection';

const GIVE_UP_MESSAGE = 'Unable to connect after 10 attempts. Redirecting to login.';
const DUPLICATE_NAME_MESSAGE =
  'This name is already taken in the session. Please choose a different name.';
const REMOVED_MESSAGE = 'You have been removed from the session by the moderator.';

/**
 * Delay preceding attempt `i + 1` of an episode: `min(2^i * 1000, 30000)` ms (R11.19).
 * Ten entries, because the tenth attempt is the one that gives up (R11.16).
 */
const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000];

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

  /** A close carrying a code; 1000 is an ordinary drop, 4009/4010/4004 are reserved. */
  simulateClose(code = 1000): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }
}

describe('WebSocketService connection episodes (R11.17, R11.18, R11.24)', () => {
  let service: WebSocketService;
  let originalWebSocket: typeof globalThis.WebSocket;
  let toast: {
    show: ReturnType<typeof vi.fn>;
    dismiss: ReturnType<typeof vi.fn>;
    dismissByTag: ReturnType<typeof vi.fn>;
  };
  let router: { navigate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    MockWebSocket.reset();
    originalWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;

    // Only the timer functions are faked: the service's reconnect schedule is the
    // sole thing this file needs to control, and leaving `Date` real keeps the
    // message timestamps the transport builds untouched.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

    toast = { show: vi.fn(), dismiss: vi.fn(), dismissByTag: vi.fn() };
    router = { navigate: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        { provide: ToastService, useValue: toast },
        { provide: Router, useValue: router },
      ],
    });
    service = TestBed.inject(WebSocketService);
  });

  afterEach(() => {
    service.ngOnDestroy();
    vi.useRealTimers();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  function latest(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  /** Connect and let the first socket open, which is where every episode starts. */
  function connectAndOpen(): MockWebSocket {
    service.connect(TOKEN, SESSION_ID);
    const socket = latest();
    socket.simulateOpen();
    expect(service.connectionState()).toBe('connected');
    return socket;
  }

  /**
   * Drive `count` failed reconnection attempts of the current episode: wait out
   * each backoff delay and close the socket that attempt opened. The attempt that
   * reaches the threshold opens no socket, so the close is conditional.
   */
  function failAttempts(count: number): void {
    for (let i = 0; i < count; i++) {
      const before = MockWebSocket.instances.length;
      vi.advanceTimersByTime(BACKOFF_DELAYS[i]);
      if (MockWebSocket.instances.length > before) {
        latest().simulateClose(1000);
      }
    }
  }

  // --- connectionState transitions (R11.1, R11.25) ---------------------------------

  describe('connectionState transitions', () => {
    it('starts out disconnected, before any connect', () => {
      expect(service.connectionState()).toBe('disconnected');
      expect(MockWebSocket.instances.length).toBe(0);
    });

    it('reads reconnecting while the socket is CONNECTING, so the indicator is never blank (R11.1)', () => {
      service.connect(TOKEN, SESSION_ID);

      // `openConnection()` publishes `reconnecting` before `onopen` fires, which is
      // the state the page's indicator renders on its very first paint.
      expect(service.connectionState()).toBe('reconnecting');
      expect(MockWebSocket.instances.length).toBe(1);
      expect(toast.show).not.toHaveBeenCalled();
    });

    it('goes connected on open and back to reconnecting on an unexpected close', () => {
      const socket = connectAndOpen();

      socket.simulateClose(1000);
      expect(service.connectionState()).toBe('reconnecting');

      service.disconnect();
      expect(service.connectionState()).toBe('disconnected');
    });

    it('returns to connected on a successful attempt and counts the next episode from zero (R11.25)', () => {
      const first = connectAndOpen();
      first.simulateClose(1000);

      vi.advanceTimersByTime(1000);
      const second = latest();
      expect(MockWebSocket.instances.length).toBe(2);
      second.simulateOpen();
      expect(service.connectionState()).toBe('connected');

      // The second episode's first delay is 1000 ms again, not 2000 ms: returning
      // to `connected` reset the attempt counter.
      second.simulateClose(1000);
      vi.advanceTimersByTime(999);
      expect(MockWebSocket.instances.length).toBe(2);
      vi.advanceTimersByTime(1);
      expect(MockWebSocket.instances.length).toBe(3);

      service.disconnect();
    });
  });

  // --- silence below the threshold (R11.14, R11.15, R11.26) ------------------------

  describe('episodes that end below the give-up threshold', () => {
    it('shows no notification for the drop itself (R11.14, R11.26)', () => {
      const socket = connectAndOpen();

      socket.simulateClose(1000);

      expect(toast.show).not.toHaveBeenCalled();
      expect(router.navigate).not.toHaveBeenCalled();

      service.disconnect();
    });

    it('shows no notification across nine consecutive failed attempts (R11.15)', () => {
      const socket = connectAndOpen();
      socket.simulateClose(1000);

      failAttempts(GIVE_UP_THRESHOLD - 1);

      // Nine attempts were made and nine sockets were opened after the first one.
      expect(MockWebSocket.instances.length).toBe(GIVE_UP_THRESHOLD);
      expect(toast.show).not.toHaveBeenCalled();
      expect(router.navigate).not.toHaveBeenCalled();
      expect(service.connectionState()).toBe('reconnecting');

      service.disconnect();
    });

    it('shows no notification for an episode that recovers on its ninth attempt (R11.15)', () => {
      const socket = connectAndOpen();
      socket.simulateClose(1000);

      failAttempts(GIVE_UP_THRESHOLD - 2);
      vi.advanceTimersByTime(BACKOFF_DELAYS[GIVE_UP_THRESHOLD - 2]);
      latest().simulateOpen();

      expect(service.connectionState()).toBe('connected');
      expect(toast.show).not.toHaveBeenCalled();
      expect(router.navigate).not.toHaveBeenCalled();

      service.disconnect();
    });

    it('waits min(2^attempt * 1000, 30000) ms before each attempt (R11.19)', () => {
      const socket = connectAndOpen();
      socket.simulateClose(1000);

      for (let i = 0; i < GIVE_UP_THRESHOLD - 1; i++) {
        const before = MockWebSocket.instances.length;

        vi.advanceTimersByTime(BACKOFF_DELAYS[i] - 1);
        expect(MockWebSocket.instances.length).toBe(before);

        vi.advanceTimersByTime(1);
        expect(MockWebSocket.instances.length).toBe(before + 1);

        latest().simulateClose(1000);
      }

      // The delay is capped from the sixth attempt on, where 2^5 * 1000 exceeds 30000.
      expect(BACKOFF_DELAYS.slice(5)).toEqual([30000, 30000, 30000, 30000, 30000]);

      service.disconnect();
    });
  });

  // --- the give-up transition (R11.16, R11.23, R11.24) -----------------------------

  describe('reaching the give-up threshold', () => {
    it('shows exactly one tagged error notification on the tenth attempt (R11.16)', () => {
      const socket = connectAndOpen();
      socket.simulateClose(1000);

      failAttempts(GIVE_UP_THRESHOLD);

      expect(toast.show).toHaveBeenCalledTimes(1);
      expect(toast.show).toHaveBeenCalledWith('error', GIVE_UP_MESSAGE, { tag: CONNECTION_TAG });
      expect(service.connectionState()).toBe('disconnected');
    });

    it('navigates to /login in the same turn as the give-up, well inside the 2 second allowance (R11.24)', () => {
      const socket = connectAndOpen();
      socket.simulateClose(1000);
      failAttempts(GIVE_UP_THRESHOLD - 1);
      expect(router.navigate).not.toHaveBeenCalled();

      // The advance that triggers the tenth attempt is the last virtual time this
      // test spends: the navigation is asserted with zero further time elapsed.
      vi.advanceTimersByTime(BACKOFF_DELAYS[GIVE_UP_THRESHOLD - 1]);

      expect(router.navigate).toHaveBeenCalledTimes(1);
      expect(router.navigate).toHaveBeenCalledWith(['/login']);
    });

    it('makes no further attempt and adds no further notification after giving up (R11.23)', () => {
      const socket = connectAndOpen();
      socket.simulateClose(1000);
      failAttempts(GIVE_UP_THRESHOLD);

      // One initial socket plus the nine that attempts 1 through 9 opened; the
      // tenth attempt opens none.
      const openedBeforeGivingUp = GIVE_UP_THRESHOLD;
      expect(MockWebSocket.instances.length).toBe(openedBeforeGivingUp);

      vi.advanceTimersByTime(120_000);

      expect(MockWebSocket.instances.length).toBe(openedBeforeGivingUp);
      expect(toast.show).toHaveBeenCalledTimes(1);
      expect(router.navigate).toHaveBeenCalledTimes(1);
      expect(service.connectionState()).toBe('disconnected');
    });
  });

  // --- reserved close codes (R11.17, R11.18) ---------------------------------------

  describe('reserved close codes', () => {
    it('reports 4009 once as an error and routes to /login, with no reconnection (R11.17, R11.18)', () => {
      const socket = connectAndOpen();

      socket.simulateClose(4009);

      expect(toast.show).toHaveBeenCalledTimes(1);
      expect(toast.show).toHaveBeenCalledWith('error', DUPLICATE_NAME_MESSAGE, {
        tag: CONNECTION_TAG,
      });
      expect(router.navigate).toHaveBeenCalledTimes(1);
      expect(router.navigate).toHaveBeenCalledWith(['/login']);
      expect(service.connectionState()).toBe('disconnected');

      vi.advanceTimersByTime(60_000);
      expect(MockWebSocket.instances.length).toBe(1);
    });

    it('reports 4010 once as a warning and routes to /lobby, with no reconnection (R11.17, R11.18)', () => {
      const socket = connectAndOpen();

      socket.simulateClose(4010);

      expect(toast.show).toHaveBeenCalledTimes(1);
      expect(toast.show).toHaveBeenCalledWith('warning', REMOVED_MESSAGE, {
        tag: CONNECTION_TAG,
      });
      expect(router.navigate).toHaveBeenCalledTimes(1);
      expect(router.navigate).toHaveBeenCalledWith(['/lobby']);
      expect(service.connectionState()).toBe('disconnected');

      vi.advanceTimersByTime(60_000);
      expect(MockWebSocket.instances.length).toBe(1);
    });

    it('ends the episode for 4004 without reconnecting, the code being the retro socket\u2019s (R11.17, R11.18)', () => {
      const socket = connectAndOpen();

      socket.simulateClose(4004);

      // 4004 means "retrospective session not found", so the poker service keeps no
      // message for it and reports nothing; the reserved-code rule still applies, so
      // the episode ends `disconnected` and nothing is retried. The notification for
      // 4004 belongs to `RetroWebSocketService` and is asserted in its own spec.
      expect(toast.show).not.toHaveBeenCalled();
      expect(router.navigate).not.toHaveBeenCalled();
      expect(service.connectionState()).toBe('disconnected');

      vi.advanceTimersByTime(60_000);
      expect(MockWebSocket.instances.length).toBe(1);
    });

    it('keeps the count at exactly one notification when further closes follow (R11.18)', () => {
      const socket = connectAndOpen();

      socket.simulateClose(4009);
      socket.simulateClose(4009);
      socket.simulateClose(1000);
      vi.advanceTimersByTime(60_000);

      expect(toast.show).toHaveBeenCalledTimes(1);
      expect(router.navigate).toHaveBeenCalledTimes(1);
      expect(MockWebSocket.instances.length).toBe(1);
      expect(service.connectionState()).toBe('disconnected');
    });

    it('does not dismiss tagged toasts for a reserved code, so its own cause stays visible (R11.27)', () => {
      const socket = connectAndOpen();
      toast.dismissByTag.mockClear();

      socket.simulateClose(4010);

      expect(toast.dismissByTag).not.toHaveBeenCalled();
      expect(toast.show).toHaveBeenCalledTimes(1);
    });
  });

  // --- manual disconnect stays silent ----------------------------------------------

  describe('manual disconnect', () => {
    it('reports nothing and schedules nothing when the caller disconnects', () => {
      connectAndOpen();

      service.disconnect();
      vi.advanceTimersByTime(60_000);

      expect(service.connectionState()).toBe('disconnected');
      expect(toast.show).not.toHaveBeenCalled();
      expect(router.navigate).not.toHaveBeenCalled();
      expect(MockWebSocket.instances.length).toBe(1);
    });

    it('opens no episode for the close that follows a disconnect', () => {
      const socket = connectAndOpen();

      service.disconnect();
      socket.simulateClose(1000);
      vi.advanceTimersByTime(60_000);

      expect(service.connectionState()).toBe('disconnected');
      expect(toast.show).not.toHaveBeenCalled();
      expect(MockWebSocket.instances.length).toBe(1);
    });

    it('ends a reconnecting episode silently when the caller disconnects mid-episode', () => {
      const socket = connectAndOpen();
      socket.simulateClose(1000);
      failAttempts(3);
      expect(service.connectionState()).toBe('reconnecting');

      service.disconnect();
      vi.advanceTimersByTime(120_000);

      // The episode that was four attempts deep is abandoned without ever reaching
      // the threshold, so it stays silent.
      expect(service.connectionState()).toBe('disconnected');
      expect(toast.show).not.toHaveBeenCalled();
      expect(router.navigate).not.toHaveBeenCalled();
      expect(MockWebSocket.instances.length).toBe(4);
    });
  });

  // --- the connection tag drives the dismissal (R11.27) ----------------------------

  describe('connection toast tag', () => {
    it('dismisses tagged connection toasts when the state leaves connected (R11.27)', () => {
      const socket = connectAndOpen();
      toast.dismissByTag.mockClear();

      socket.simulateClose(1000);

      expect(toast.dismissByTag).toHaveBeenCalledWith(CONNECTION_TAG);

      service.disconnect();
    });

    it('dismisses tagged connection toasts again once the connection is restored (R11.27)', () => {
      const socket = connectAndOpen();
      socket.simulateClose(1000);
      vi.advanceTimersByTime(1000);
      toast.dismissByTag.mockClear();

      latest().simulateOpen();

      expect(toast.dismissByTag).toHaveBeenCalledWith(CONNECTION_TAG);
      expect(service.connectionState()).toBe('connected');

      service.disconnect();
    });

    it('tags every notification an episode produces, so none of them survives the next drop', () => {
      const socket = connectAndOpen();
      socket.simulateClose(1000);
      failAttempts(GIVE_UP_THRESHOLD);

      const tags = toast.show.mock.calls.map((call) => call[2]?.tag);
      expect(tags).toEqual([CONNECTION_TAG]);
    });
  });
});

/**
 * The same tag, against the real `ToastService`, so the reducer's
 * `dismiss-connection-toasts` effect is shown to remove the connection notification
 * and only that one (R11.27).
 */
describe('WebSocketService connection toasts against the real ToastService (R11.27)', () => {
  let service: WebSocketService;
  let toasts: ToastService;
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    MockWebSocket.reset();
    originalWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

    TestBed.configureTestingModule({
      providers: [{ provide: Router, useValue: { navigate: vi.fn() } }],
    });
    service = TestBed.inject(WebSocketService);
    toasts = TestBed.inject(ToastService);
  });

  afterEach(() => {
    service.ngOnDestroy();
    vi.useRealTimers();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  it('removes the connection notification and leaves unrelated notifications standing', () => {
    service.connect(TOKEN, SESSION_ID);
    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    socket.simulateOpen();

    // A connection notification left over from an earlier give-up, alongside a
    // session notification that has nothing to do with the transport.
    toasts.show('error', GIVE_UP_MESSAGE, { tag: CONNECTION_TAG });
    toasts.show('info', 'The round was revealed.');
    expect(toasts.toasts().length).toBe(2);

    socket.simulateClose(1000);

    const remaining = toasts.toasts();
    expect(remaining.map((t) => t.message)).toEqual(['The round was revealed.']);
    expect(remaining.every((t) => t.tag !== CONNECTION_TAG)).toBe(true);
    expect(service.connectionState()).toBe('reconnecting');

    service.disconnect();
  });
});
