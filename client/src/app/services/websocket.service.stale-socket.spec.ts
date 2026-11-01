import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WS_MAX_PAYLOAD_BYTES } from '@shared/types';
import { WebSocketService } from './websocket.service';
import { RetroWebSocketService } from './retro-websocket.service';
import { ToastService } from './toast.service';
import { ConnectionEvent, GIVE_UP_THRESHOLD } from './connection-episode';
import { utf8ByteLength } from './frame-guard';

/**
 * `WebSocketService` stale-socket isolation, Connection_Generation and the
 * Client_Frame_Guard (R22.13, R22.17, R23.10, R25.1–R25.5, R25.7, R25.10).
 *
 * The socket is the `MockWebSocket` stand-in of `websocket.service.connection.spec.ts`,
 * extended so a test can address any instance the service created, current or stale:
 * `emitOpen`, `emitMessage`, `emitClose`, `emitError`, a `closeCalls` counter and the
 * list of frames written to it. `close()` only records the call; the `close` event
 * arrives later through `emitClose`, as it does in a browser. Reconnect timers and
 * `Date` run under Vitest fake timers, so the envelope timestamp has a fixed length.
 */

// --- Fixtures ----------------------------------------------------------------------

const TOKEN = 'test-token';
const SESSION_ID = 'sess0001';
const CONNECTION_TAG = 'connection';
const FIXED_NOW = '2026-05-01T12:00:00.000Z';

const FRAME_TOO_LARGE_MESSAGE = 'This change is too large to send.';
const PAYLOAD_TOO_LARGE_CLOSE_MESSAGE =
  'The connection was closed because a message was too large. Reload the page to reconnect.';

/** Delay preceding attempt `i + 1` of an episode (R11.19). */
const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  /** Number of times the service called `close()` on this socket. */
  closeCalls = 0;
  /** Frames the service wrote with `send()`. */
  readonly sent: string[] = [];

  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls++;
    if (this.readyState !== MockWebSocket.CLOSED) {
      this.readyState = MockWebSocket.CLOSING;
    }
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  emitMessage(event: string, data: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ event, data, timestamp: FIXED_NOW }) });
  }

  emitClose(code: number): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  emitError(): void {
    this.onerror?.({});
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }
}

/** Private surface the tests observe: every event handed to the episode reducer. */
interface DispatchInternals {
  dispatch(event: ConnectionEvent): void;
}

interface DispatchRecord {
  event: ConnectionEvent;
  /** `connectionGeneration` at the moment of the dispatch. */
  generation: number;
}

/** Wrap the service's private `dispatch` so each event is logged before it runs. */
function recordDispatches(service: WebSocketService): DispatchRecord[] {
  const log: DispatchRecord[] = [];
  const internals = service as unknown as DispatchInternals;
  const original = internals.dispatch.bind(service);
  internals.dispatch = (event: ConnectionEvent) => {
    log.push({ event, generation: service.connectionGeneration() });
    original(event);
  };
  return log;
}

/** The serialised envelope `send()` builds under the fixed clock. */
function envelope(event: string, data: unknown): string {
  return JSON.stringify({ event, data, timestamp: FIXED_NOW });
}

/** A string `data` whose envelope for `event` is exactly `bytes` UTF-8 bytes long. */
function dataForFrameOf(event: string, bytes: number): string {
  const overhead = utf8ByteLength(envelope(event, ''));
  return 'a'.repeat(bytes - overhead);
}

describe('WebSocketService stale sockets, generation and frame guard (R25, R23.10)', () => {
  let service: WebSocketService;
  let originalWebSocket: typeof globalThis.WebSocket;
  let toast: {
    show: ReturnType<typeof vi.fn>;
    dismiss: ReturnType<typeof vi.fn>;
    dismissByTag: ReturnType<typeof vi.fn>;
  };
  let router: { navigate: ReturnType<typeof vi.fn> };
  let dispatches: DispatchRecord[];

  beforeEach(() => {
    MockWebSocket.reset();
    originalWebSocket = globalThis.WebSocket;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;

    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    vi.setSystemTime(new Date(FIXED_NOW));

    toast = { show: vi.fn(), dismiss: vi.fn(), dismissByTag: vi.fn() };
    router = { navigate: vi.fn() };

    TestBed.configureTestingModule({
      providers: [
        { provide: ToastService, useValue: toast },
        { provide: Router, useValue: router },
      ],
    });
    service = TestBed.inject(WebSocketService);
    dispatches = recordDispatches(service);
  });

  afterEach(() => {
    service.ngOnDestroy();
    vi.useRealTimers();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
  });

  function socketAt(index: number): MockWebSocket {
    return MockWebSocket.instances[index];
  }

  function latest(): MockWebSocket {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  function connectAndOpen(): MockWebSocket {
    service.connect(TOKEN, SESSION_ID);
    const socket = latest();
    socket.emitOpen();
    expect(service.connectionState()).toBe('connected');
    return socket;
  }

  /** Everything a stale event must leave untouched, captured for comparison. */
  function snapshot() {
    return {
      state: service.connectionState(),
      generation: service.connectionGeneration(),
      sockets: MockWebSocket.instances.length,
      timers: vi.getTimerCount(),
      dispatches: dispatches.length,
      toasts: toast.show.mock.calls.length,
      dismissals: toast.dismissByTag.mock.calls.length,
      navigations: router.navigate.mock.calls.length,
    };
  }

  /** No reconnect follows: a minute of virtual time creates no socket. */
  function expectNoReconnect(socketCount: number): void {
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances.length).toBe(socketCount);
  }

  // --- stale close after a second connect() (R25.1, R25.5) --------------------------

  describe('a second connect() while the first socket is open', () => {
    it.each([1000, 1006, 1009])(
      'ignores the old socket\u2019s later close %i once the new socket is open',
      (code) => {
        const first = connectAndOpen();
        service.connect(TOKEN, SESSION_ID);
        const second = latest();
        expect(first.closeCalls).toBe(1);
        second.emitOpen();
        expect(service.connectionGeneration()).toBe(2);

        const before = snapshot();
        first.emitClose(code);

        expect(snapshot()).toEqual(before);
        expect(service.connectionState()).toBe('connected');
        expect(first.closeCalls).toBe(1);
        expectNoReconnect(2);
        expect(toast.show).not.toHaveBeenCalled();

        // The Current_Socket reference is unchanged: frames still reach the second socket.
        expect(service.send('card:select', { value: 3 })).toBe(true);
        expect(second.sent).toHaveLength(1);
        expect(first.sent).toHaveLength(0);
      }
    );

    it('ignores the old socket\u2019s close 1009 that arrives before the new socket opens', () => {
      const first = connectAndOpen();
      service.connect(TOKEN, SESSION_ID);
      const second = latest();
      expect(service.connectionState()).toBe('reconnecting');

      const before = snapshot();
      first.emitClose(1009);
      expect(snapshot()).toEqual(before);

      second.emitOpen();
      expect(service.connectionState()).toBe('connected');
      expect(service.connectionGeneration()).toBe(2);
      expectNoReconnect(2);
      expect(toast.show).not.toHaveBeenCalled();
    });
  });

  // --- stale close after disconnect() + connect() (R25.2, R25.5) --------------------

  describe('disconnect() then connect() before the old close arrives', () => {
    it.each([1000, 1006, 1009])('ignores the old socket\u2019s later close %i', (code) => {
      const first = connectAndOpen();
      service.disconnect();
      expect(first.closeCalls).toBe(1);
      expect(service.connectionState()).toBe('disconnected');

      service.connect(TOKEN, SESSION_ID);
      const second = latest();
      second.emitOpen();
      // disconnect() dispatched its single manual-disconnect; nothing else is pending.
      expect(dispatches.filter((d) => d.event.kind === 'manual-disconnect')).toHaveLength(1);

      const before = snapshot();
      first.emitClose(code);

      expect(snapshot()).toEqual(before);
      expect(service.connectionState()).toBe('connected');
      expect(service.connectionGeneration()).toBe(2);
      expectNoReconnect(2);
      expect(toast.show).not.toHaveBeenCalled();
      expect(router.navigate).not.toHaveBeenCalled();

      expect(service.send('issue:add', { title: 'x' })).toBe(true);
      expect(second.sent).toHaveLength(1);
      expect(first.sent).toHaveLength(0);
    });
  });

  // --- stale message (R25.4) --------------------------------------------------------

  describe('stale message', () => {
    it('reaches no on<T>() subscriber, also after the Current_Socket opens; a current message does', () => {
      const received: unknown[] = [];
      const sub = service.on<{ n: number }>('round:revealed').subscribe((d) => received.push(d));

      const first = connectAndOpen();
      service.connect(TOKEN, SESSION_ID);
      const second = latest();

      first.emitMessage('round:revealed', { n: 1 });
      expect(received).toEqual([]);

      second.emitOpen();
      expect(received).toEqual([]);

      first.emitMessage('round:revealed', { n: 2 });
      expect(received).toEqual([]);

      second.emitMessage('round:revealed', { n: 3 });
      expect(received).toEqual([{ n: 3 }]);

      sub.unsubscribe();
    });

    it('drops a message of the socket closed by disconnect()', () => {
      const received: unknown[] = [];
      const sub = service.on<{ n: number }>('round:revealed').subscribe((d) => received.push(d));

      const first = connectAndOpen();
      service.disconnect();
      first.emitMessage('round:revealed', { n: 1 });

      expect(received).toEqual([]);
      sub.unsubscribe();
    });
  });

  // --- stale open (R25.3) -----------------------------------------------------------

  describe('stale open', () => {
    it('leaves state and generation unchanged, dispatches nothing and the socket stays closed', () => {
      service.connect(TOKEN, SESSION_ID);
      const first = latest();
      service.connect(TOKEN, SESSION_ID);
      const second = latest();
      expect(first.closeCalls).toBe(1);

      const before = snapshot();
      first.emitOpen();

      expect(snapshot()).toEqual(before);
      expect(service.connectionState()).toBe('reconnecting');
      expect(service.connectionGeneration()).toBe(0);
      // Closed when it was retired, and never closed twice (design D13).
      expect(first.closeCalls).toBe(1);

      // The stale socket is OPEN in the mock, yet send() never writes to it.
      expect(service.send('card:select', { value: 5 })).toBe(false);
      expect(first.sent).toHaveLength(0);

      second.emitOpen();
      expect(service.connectionGeneration()).toBe(1);
      expect(service.send('card:select', { value: 5 })).toBe(true);
      expect(second.sent).toHaveLength(1);
      expect(first.sent).toHaveLength(0);
    });

    it('closes a late-opening socket of a disconnected service and changes nothing', () => {
      service.connect(TOKEN, SESSION_ID);
      const first = latest();
      service.disconnect();
      expect(first.closeCalls).toBe(1);

      const before = snapshot();
      first.emitOpen();

      expect(snapshot()).toEqual(before);
      expect(service.connectionState()).toBe('disconnected');
      expect(service.connectionGeneration()).toBe(0);
      expect(first.closeCalls).toBe(1);
      expect(service.send('card:select', { value: 1 })).toBe(false);
      expect(first.sent).toHaveLength(0);
    });
  });

  // --- stale close / error with a pending reconnect (R25.5) -------------------------

  describe('stale close or error while a reconnect is scheduled', () => {
    it.each([1000, 1006, 1009, 4009, 4010])(
      'neither cancels nor reschedules the pending attempt and dismisses nothing (close %i)',
      (code) => {
        const first = connectAndOpen();
        service.connect(TOKEN, SESSION_ID);
        const second = latest();
        second.emitOpen();
        second.emitClose(1006);
        expect(service.connectionState()).toBe('reconnecting');
        expect(vi.getTimerCount()).toBe(1);

        vi.advanceTimersByTime(500);
        const before = snapshot();
        first.emitError();
        first.emitClose(code);
        expect(snapshot()).toEqual(before);
        expect(toast.show).not.toHaveBeenCalled();
        expect(router.navigate).not.toHaveBeenCalled();

        // The attempt still fires at 1000 ms after the drop, not earlier and not later.
        vi.advanceTimersByTime(499);
        expect(MockWebSocket.instances.length).toBe(2);
        vi.advanceTimersByTime(1);
        expect(MockWebSocket.instances.length).toBe(3);
      }
    );

    it('a stale error alone changes nothing', () => {
      const first = connectAndOpen();
      service.connect(TOKEN, SESSION_ID);
      latest().emitOpen();

      const before = snapshot();
      first.emitError();
      expect(snapshot()).toEqual(before);
    });
  });

  // --- disconnect() cancels the reconnect (R25.2) -----------------------------------

  describe('disconnect()', () => {
    it('cancels a scheduled reconnect and dispatches exactly one manual-disconnect', () => {
      const first = connectAndOpen();
      first.emitClose(1006);
      expect(vi.getTimerCount()).toBe(1);
      dispatches.length = 0;

      service.disconnect();

      expect(dispatches.map((d) => d.event)).toEqual([{ kind: 'manual-disconnect' }]);
      expect(vi.getTimerCount()).toBe(0);
      // The socket already emitted close, so it is not closed again.
      expect(first.closeCalls).toBe(0);
      expect(service.connectionState()).toBe('disconnected');
      expectNoReconnect(1);
      expect(toast.show).not.toHaveBeenCalled();
    });

    it('keeps a single manual-disconnect when the closed socket\u2019s close event follows', () => {
      const first = connectAndOpen();
      dispatches.length = 0;

      service.disconnect();
      first.emitClose(1000);

      expect(dispatches.map((d) => d.event)).toEqual([{ kind: 'manual-disconnect' }]);
      expect(first.closeCalls).toBe(1);
      expect(service.connectionState()).toBe('disconnected');
      expectNoReconnect(1);
    });
  });

  // --- send() results (R25.10, R23.16) ----------------------------------------------

  describe('send() result', () => {
    it('returns false while there is no Current_Socket', () => {
      expect(service.send('card:select', { value: 1 })).toBe(false);

      const first = connectAndOpen();
      service.disconnect();
      expect(service.send('card:select', { value: 1 })).toBe(false);
      expect(first.sent).toHaveLength(0);
    });

    it('returns false while the Current_Socket is CONNECTING or closed, and true once OPEN', () => {
      service.connect(TOKEN, SESSION_ID);
      const socket = latest();
      expect(service.send('card:select', { value: 1 })).toBe(false);

      socket.emitOpen();
      expect(service.send('card:select', { value: 1 })).toBe(true);
      expect(socket.sent).toEqual([envelope('card:select', { value: 1 })]);

      socket.emitClose(1006);
      expect(service.send('card:select', { value: 2 })).toBe(false);
      expect(socket.sent).toHaveLength(1);
      expect(toast.show).not.toHaveBeenCalled();
    });

    it('never writes to a Stale_Socket that is still OPEN', () => {
      const first = connectAndOpen();
      service.connect(TOKEN, SESSION_ID);
      // The mock keeps the retired socket's readyState at CLOSING; force it OPEN to
      // show that only the Current_Socket is consulted.
      first.readyState = MockWebSocket.OPEN;

      expect(service.send('card:select', { value: 8 })).toBe(false);
      expect(first.sent).toHaveLength(0);
    });
  });

  // --- Connection_Generation (R25.7) ------------------------------------------------

  describe('connectionGeneration', () => {
    it('starts at 0 and increases by exactly 1 on each open of the Current_Socket only', () => {
      const seen: number[] = [service.connectionGeneration()];
      const record = () => seen.push(service.connectionGeneration());

      service.connect(TOKEN, SESSION_ID);
      record();
      const first = latest();
      first.emitOpen();
      record();
      first.emitMessage('x', {});
      first.emitError();
      first.emitClose(1006);
      record();

      // Reconnect attempt and its socket's open.
      vi.advanceTimersByTime(1000);
      record();
      const second = latest();
      second.emitOpen();
      record();

      // connect() again, then a stale open of the socket it replaced.
      service.connect(TOKEN, 'sess0002');
      record();
      second.emitOpen();
      record();
      latest().emitOpen();
      record();

      service.disconnect();
      record();

      expect(seen).toEqual([0, 0, 1, 1, 1, 2, 2, 2, 3, 3]);
    });

    it('is incremented before open is dispatched, so a consumer of connected reads the new value', () => {
      const first = connectAndOpen();
      first.emitClose(1006);
      vi.advanceTimersByTime(1000);
      latest().emitOpen();

      const opens = dispatches.filter((d) => d.event.kind === 'open');
      expect(opens.map((d) => d.generation)).toEqual([1, 2]);
    });

    it('keeps its value through a give-up and never decreases', () => {
      const first = connectAndOpen();
      first.emitClose(1006);
      for (let i = 0; i < GIVE_UP_THRESHOLD; i++) {
        const before = MockWebSocket.instances.length;
        vi.advanceTimersByTime(BACKOFF_DELAYS[i]);
        if (MockWebSocket.instances.length > before) {
          latest().emitClose(1006);
        }
        expect(service.connectionGeneration()).toBe(1);
      }
      expect(router.navigate).toHaveBeenCalledWith(['/login']);
      expect(service.connectionState()).toBe('disconnected');
      expect(service.connectionGeneration()).toBe(1);
    });

    it('is unaffected by events of RetroWebSocketService', () => {
      const retro = TestBed.inject(RetroWebSocketService);
      try {
        connectAndOpen();
        expect(service.connectionGeneration()).toBe(1);

        retro.connect('retro0001', TOKEN);
        const retroSocket = latest();
        expect(retroSocket.url).toContain('/retro');
        retroSocket.emitOpen();
        retroSocket.emitClose(1006);
        vi.advanceTimersByTime(1000);
        latest().emitOpen();

        expect(retro.connectionGeneration()).toBe(2);
        expect(service.connectionGeneration()).toBe(1);
      } finally {
        retro.ngOnDestroy();
      }
    });
  });

  // --- Client_Frame_Guard (R23.10, R22.13) ------------------------------------------

  describe('frame guard', () => {
    it('sends a frame of exactly WS_MAX_PAYLOAD_BYTES bytes', () => {
      const socket = connectAndOpen();
      const data = dataForFrameOf('issue:add', WS_MAX_PAYLOAD_BYTES);

      expect(service.send('issue:add', data)).toBe(true);

      expect(socket.sent).toHaveLength(1);
      expect(socket.sent[0]).toBe(envelope('issue:add', data));
      expect(utf8ByteLength(socket.sent[0])).toBe(WS_MAX_PAYLOAD_BYTES);
      expect(toast.show).not.toHaveBeenCalled();
    });

    it('rejects a frame of WS_MAX_PAYLOAD_BYTES + 1 bytes with one untagged toast per call', () => {
      const socket = connectAndOpen();
      const data = dataForFrameOf('issue:add', WS_MAX_PAYLOAD_BYTES + 1);
      const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => undefined)
      );
      dispatches.length = 0;
      toast.dismissByTag.mockClear();

      try {
        expect(service.send('issue:add', data)).toBe(false);
        expect(service.send('issue:add', data)).toBe(false);

        expect(socket.sent).toHaveLength(0);
        // Exactly one notification per rejected call, with no tag, so a later
        // Connection_State change cannot dismiss it.
        expect(toast.show.mock.calls).toEqual([
          ['error', FRAME_TOO_LARGE_MESSAGE],
          ['error', FRAME_TOO_LARGE_MESSAGE],
        ]);
        expect(toast.dismissByTag).not.toHaveBeenCalled();

        // The socket stays open and the connection state is untouched.
        expect(socket.closeCalls).toBe(0);
        expect(socket.readyState).toBe(MockWebSocket.OPEN);
        expect(service.connectionState()).toBe('connected');
        expect(dispatches).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);

        // No frame content reaches the console.
        for (const spy of consoleSpies) {
          for (const args of spy.mock.calls) {
            expect(args.some((a) => typeof a === 'string' && a.includes(data))).toBe(false);
          }
        }

        // The socket still carries frames within the limit.
        expect(service.send('card:select', { value: 2 })).toBe(true);
        expect(socket.sent).toHaveLength(1);
      } finally {
        consoleSpies.forEach((spy) => spy.mockRestore());
      }
    });

    it('measures UTF-8 bytes, not UTF-16 code units', () => {
      const socket = connectAndOpen();
      // Each "é" is one UTF-16 code unit and two UTF-8 bytes.
      const overhead = utf8ByteLength(envelope('issue:add', ''));
      const chars = Math.ceil((WS_MAX_PAYLOAD_BYTES - overhead + 1) / 2);
      const data = '\u00e9'.repeat(chars);
      expect(envelope('issue:add', data).length).toBeLessThanOrEqual(WS_MAX_PAYLOAD_BYTES);

      expect(service.send('issue:add', data)).toBe(false);
      expect(socket.sent).toHaveLength(0);
      expect(toast.show).toHaveBeenCalledTimes(1);
    });

    it('leaves the count of consecutive 1009 closes unchanged', () => {
      // Two 1009 closes, each followed by a successful reconnect: the count is 2.
      const first = connectAndOpen();
      first.emitClose(1009);
      vi.advanceTimersByTime(1000);
      latest().emitOpen();
      latest().emitClose(1009);
      vi.advanceTimersByTime(1000);
      const third = latest();
      third.emitOpen();
      expect(MockWebSocket.instances.length).toBe(3);
      expect(toast.show).not.toHaveBeenCalled();

      expect(service.send('issue:add', dataForFrameOf('issue:add', WS_MAX_PAYLOAD_BYTES + 1))).toBe(
        false
      );
      expect(service.connectionState()).toBe('connected');

      // Had the rejected send reset the count, this close would only reconnect.
      third.emitClose(1009);
      expect(toast.show).toHaveBeenLastCalledWith('error', PAYLOAD_TOO_LARGE_CLOSE_MESSAGE, {
        tag: CONNECTION_TAG,
      });
      expect(service.connectionState()).toBe('disconnected');
      expect(router.navigate).not.toHaveBeenCalled();
      expectNoReconnect(3);
    });

    it('drops frames silently while the socket is not OPEN', () => {
      service.connect(TOKEN, SESSION_ID);
      const socket = latest();

      expect(service.send('issue:add', dataForFrameOf('issue:add', WS_MAX_PAYLOAD_BYTES + 1))).toBe(
        false
      );
      expect(socket.sent).toHaveLength(0);
      expect(toast.show).not.toHaveBeenCalled();
    });
  });
});
