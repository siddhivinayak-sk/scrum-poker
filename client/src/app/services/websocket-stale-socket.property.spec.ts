// Feature: session-chat, Property 37: Stale-socket events change nothing
import { Signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Observable, Subscription } from 'rxjs';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionState, RETRO_SESSION_ENDED, WS_MAX_PAYLOAD_BYTES } from '@shared/types';
import { WebSocketService } from './websocket.service';
import { RetroWebSocketService } from './retro-websocket.service';
import { ToastService } from './toast.service';
import { ConnectionEvent } from './connection-episode';

/**
 * Property 37: Stale-socket events change nothing.
 *
 * For any sequence of `connect()`, `disconnect()`, `send()`, reconnect-timer expiries
 * and `open`, `message`, `close` (any code) and `error` events addressed to the
 * Current_Socket or to any Stale_Socket, run against `WebSocketService` and, separately,
 * `RetroWebSocketService` with a mock `WebSocket` and fake timers:
 *
 * - the observable log equals the log of the same sequence with every Stale_Socket
 *   event removed;
 * - after every step at most one created socket has neither emitted `close` nor had
 *   `close()` called on it;
 * - frames are written only to the Current_Socket while it is `OPEN`, and `send()`
 *   returns `false` otherwise;
 * - `connectionGeneration` starts at 0 and increases by exactly 1 on each `open` of the
 *   Current_Socket, and on nothing else.
 *
 * Each case runs the command list twice on fresh service instances. The first run
 * resolves every socket event to a creation index and records which events were stale
 * (addressed to a socket that was not the Current_Socket at that moment); the second
 * run drops exactly those events and replays the others against the same creation
 * indices. Stale events create no sockets, so creation indices line up in both runs.
 *
 * **Validates: Requirements 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.10**
 */

// --- Fixtures ----------------------------------------------------------------------

const TOKEN = 'test-token';
const FIXED_NOW = '2026-05-01T12:00:00.000Z';
const POKER_SESSIONS: readonly (string | undefined)[] = ['sess0001', 'sess0002', undefined];
const RETRO_SESSIONS: readonly string[] = ['retro0001', 'retro0002'];
/** Its envelope is above `WS_MAX_PAYLOAD_BYTES`, so the frame guard rejects it. */
const OVERSIZED_DATA = 'a'.repeat(WS_MAX_PAYLOAD_BYTES);

type LogEntry = { readonly kind: string } & Record<string, unknown>;

/** Sink of the run in progress; mocks and stubs append to it. */
let activeLog: LogEntry[] = [];

/**
 * Browser-like `WebSocket` stand-in. `close()` only records the call; the `close`
 * event arrives later through `emitClose`. A socket that emitted `close` emits nothing
 * further, `open` fires at most once and `message` only after `open`. Each `emit*`
 * returns whether the event reached the handler.
 */
class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];
  /** Live sockets among the existing ones at the moment each socket was created. */
  static liveAtCreation: number[] = [];

  readonly index: number;
  readyState = MockWebSocket.CONNECTING;
  closeCalls = 0;
  opened = false;
  closeEmitted = false;

  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {
    MockWebSocket.liveAtCreation.push(liveSocketCount());
    this.index = MockWebSocket.instances.length;
    MockWebSocket.instances.push(this);
    activeLog.push({ kind: 'socket-created', index: this.index, url });
  }

  send(data: string): void {
    activeLog.push({ kind: 'frame', index: this.index, readyState: this.readyState, data });
  }

  close(): void {
    this.closeCalls++;
    activeLog.push({ kind: 'close-call', index: this.index });
    if (this.readyState !== MockWebSocket.CLOSED) {
      this.readyState = MockWebSocket.CLOSING;
    }
  }

  emitOpen(): boolean {
    if (this.closeEmitted || this.opened) {
      return false;
    }
    this.opened = true;
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
    return true;
  }

  emitMessage(event: string, data: unknown): boolean {
    if (this.closeEmitted || !this.opened) {
      return false;
    }
    this.onmessage?.({ data: JSON.stringify({ event, data, timestamp: FIXED_NOW }) });
    return true;
  }

  emitClose(code: number): boolean {
    if (this.closeEmitted) {
      return false;
    }
    this.closeEmitted = true;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code });
    return true;
  }

  emitError(): boolean {
    if (this.closeEmitted) {
      return false;
    }
    this.onerror?.({});
    return true;
  }

  static reset(): void {
    MockWebSocket.instances = [];
    MockWebSocket.liveAtCreation = [];
  }
}

/** Neither closed by the service nor emitted `close` (R25.8). */
function isLive(socket: MockWebSocket): boolean {
  return socket.closeCalls === 0 && !socket.closeEmitted;
}

function liveSocketCount(): number {
  return MockWebSocket.instances.filter(isLive).length;
}

// --- Commands ----------------------------------------------------------------------

/**
 * Socket events name their target by creation index, counted back from the most
 * recently created socket (`back` 0 is the latest, larger values wrap around), so
 * they reach both the Current_Socket and earlier sockets.
 */
type Command =
  | { readonly kind: 'connect'; readonly session: number }
  | { readonly kind: 'disconnect' }
  | { readonly kind: 'send'; readonly oversized: boolean; readonly value: number }
  | { readonly kind: 'advance'; readonly ms: number }
  | { readonly kind: 'open'; readonly back: number }
  | { readonly kind: 'message'; readonly back: number; readonly event: number; readonly n: number }
  | { readonly kind: 'close'; readonly back: number; readonly code: number }
  | { readonly kind: 'error'; readonly back: number };

type SocketCommand = Extract<Command, { readonly back: number }>;

function isSocketCommand(command: Command): command is SocketCommand {
  return 'back' in command;
}

const backArb = fc.oneof(
  { arbitrary: fc.constant(0), weight: 3 },
  { arbitrary: fc.integer({ min: 1, max: 4 }), weight: 2 }
);

/** Ordinary drops more often than the reserved codes, which end the episode. */
const closeCodeArb = fc.oneof(
  { arbitrary: fc.constantFrom(1000, 1001, 1005, 1006, 1009, 1011), weight: 3 },
  { arbitrary: fc.constantFrom(4004, 4009, 4010), weight: 1 }
);

const advanceArb = fc.oneof(
  fc.constantFrom(0, 500, 999, 1000, 2000, 4000, 8000, 16000, 30000),
  fc.integer({ min: 0, max: 40_000 })
);

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  {
    arbitrary: fc.record({ kind: fc.constant('connect' as const), session: fc.nat({ max: 5 }) }),
    weight: 2,
  },
  { arbitrary: fc.constant({ kind: 'disconnect' as const }), weight: 1 },
  {
    arbitrary: fc.record({
      kind: fc.constant('send' as const),
      oversized: fc.oneof(
        { arbitrary: fc.constant(false), weight: 9 },
        { arbitrary: fc.constant(true), weight: 1 }
      ),
      value: fc.nat({ max: 20 }),
    }),
    weight: 2,
  },
  { arbitrary: fc.record({ kind: fc.constant('advance' as const), ms: advanceArb }), weight: 3 },
  { arbitrary: fc.record({ kind: fc.constant('open' as const), back: backArb }), weight: 3 },
  {
    arbitrary: fc.record({
      kind: fc.constant('message' as const),
      back: backArb,
      event: fc.nat({ max: 2 }),
      n: fc.nat({ max: 99 }),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({ kind: fc.constant('close' as const), back: backArb, code: closeCodeArb }),
    weight: 3,
  },
  { arbitrary: fc.record({ kind: fc.constant('error' as const), back: backArb }), weight: 1 }
);

/**
 * Up to 30 commands. The first is a `connect()`, so most commands find a socket to
 * address; `size: 'max'` spreads lengths over the whole range instead of near 10.
 */
const commandsArb: fc.Arbitrary<Command[]> = fc
  .tuple(
    fc.record({ kind: fc.constant('connect' as const), session: fc.nat({ max: 5 }) }),
    fc.array(commandArb, { maxLength: 29, size: 'max' })
  )
  .map(([first, rest]) => [first, ...rest]);

// --- Services under test -----------------------------------------------------------

interface ServiceUnderTest {
  readonly connectionState: Signal<ConnectionState>;
  readonly connectionGeneration: Signal<number>;
  disconnect(): void;
  send(event: string, data: unknown): boolean;
  on<T>(event: string): Observable<T>;
}

interface ServiceKind<S extends ServiceUnderTest> {
  readonly name: string;
  inject(): S;
  connect(service: S, session: number): void;
  /** Three event names, addressed by `Command.event`. */
  readonly messageEvents: readonly string[];
  readonly sendEvent: string;
}

const POKER: ServiceKind<WebSocketService> = {
  name: 'WebSocketService',
  inject: () => TestBed.inject(WebSocketService),
  connect: (service, session) =>
    service.connect(TOKEN, POKER_SESSIONS[session % POKER_SESSIONS.length]),
  messageEvents: ['round:revealed', 'chat:message', 'participant:joined'],
  sendEvent: 'card:select',
};

const RETRO: ServiceKind<RetroWebSocketService> = {
  name: 'RetroWebSocketService',
  inject: () => TestBed.inject(RetroWebSocketService),
  connect: (service, session) =>
    service.connect(RETRO_SESSIONS[session % RETRO_SESSIONS.length], TOKEN),
  // `retro:session:ended` also reaches the service's own internal subscription.
  messageEvents: ['retro:card:added', 'chat:message', RETRO_SESSION_ENDED],
  sendEvent: 'retro:card:add',
};

/** Private surface observed through an `unknown` cast. */
interface Internals {
  current: { readonly socket: unknown } | null;
  dispatch(event: ConnectionEvent): void;
  scheduleReconnect(delayMs: number): void;
}

function internalsOf(service: ServiceUnderTest): Internals {
  return service as unknown as Internals;
}

/** Log every reducer event and every scheduled reconnect delay before it runs. */
function instrument(service: ServiceUnderTest): void {
  const internals = internalsOf(service);
  const dispatch = internals.dispatch.bind(service);
  internals.dispatch = (event: ConnectionEvent) => {
    activeLog.push({ kind: 'dispatch', event });
    dispatch(event);
  };
  const schedule = internals.scheduleReconnect.bind(service);
  internals.scheduleReconnect = (delayMs: number) => {
    activeLog.push({ kind: 'schedule-reconnect', delayMs });
    schedule(delayMs);
  };
}

function snapshot(service: ServiceUnderTest) {
  return {
    state: service.connectionState(),
    generation: service.connectionGeneration(),
    sockets: MockWebSocket.instances.length,
    timers: vi.getTimerCount(),
  };
}

// --- Runner ------------------------------------------------------------------------

interface Plan {
  /** Positions of the commands that were stale in the first run. */
  readonly stale: ReadonlySet<number>;
  /** Creation index each socket command resolved to in the first run. */
  readonly targets: readonly (number | null)[];
}

interface RunResult {
  readonly log: LogEntry[];
  readonly plan: Plan;
}

/**
 * Run `commands` on a fresh service. Without a plan, socket targets are resolved and
 * stale commands recorded; with a plan, the stale commands are skipped and the
 * others address the recorded creation indices.
 */
function runSequence<S extends ServiceUnderTest>(
  kind: ServiceKind<S>,
  commands: readonly Command[],
  plan?: Plan
): RunResult {
  const log: LogEntry[] = [];
  const stale = new Set<number>();
  const targets: (number | null)[] = [];
  const subscriptions: Subscription[] = [];

  activeLog = [];
  TestBed.resetTestingModule();
  MockWebSocket.reset();
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(new Date(FIXED_NOW));
  activeLog = log;

  TestBed.configureTestingModule({
    providers: [
      {
        provide: ToastService,
        useValue: {
          show: (...args: unknown[]) => activeLog.push({ kind: 'toast', args }),
          dismiss: (...args: unknown[]) => activeLog.push({ kind: 'dismiss', args }),
          dismissByTag: (...args: unknown[]) => activeLog.push({ kind: 'dismiss-by-tag', args }),
        },
      },
      {
        provide: Router,
        useValue: {
          navigate: (...args: unknown[]) => {
            activeLog.push({ kind: 'navigate', args });
            return Promise.resolve(true);
          },
        },
      },
    ],
  });

  try {
    const service = kind.inject();
    instrument(service);
    for (const event of kind.messageEvents) {
      subscriptions.push(
        service.on<unknown>(event).subscribe((data) => activeLog.push({ kind: 'received', event, data }))
      );
    }

    // Model of the Current_Socket by creation index: the socket created last, until
    // another is created or `disconnect()` is called.
    let current: number | null = null;
    expect(service.connectionGeneration()).toBe(0);

    commands.forEach((command, i) => {
      if (plan?.stale.has(i)) {
        targets.push(plan.targets[i]);
        return;
      }
      const ctx = `${kind.name}, run ${plan ? 2 : 1}, command #${i} ${JSON.stringify(command)}`;
      const before = snapshot(service);
      const logBefore = log.length;

      let target: number | null = null;
      let isStale = false;
      if (isSocketCommand(command)) {
        if (plan) {
          target = plan.targets[i];
          // A replayed (non-stale) event addresses the Current_Socket of this run.
          if (target !== null) {
            expect(target, ctx).toBe(current);
          } else {
            expect(MockWebSocket.instances.length, ctx).toBe(0);
          }
        } else {
          const count = MockWebSocket.instances.length;
          target = count === 0 ? null : count - 1 - (command.back % count);
          isStale = target !== null && target !== current;
        }
      }
      targets.push(target);
      if (isStale) {
        stale.add(i);
      }
      const socket = target === null ? null : MockWebSocket.instances[target];

      let currentOpenDelivered = false;
      let sendResult: boolean | null = null;
      switch (command.kind) {
        case 'connect':
          kind.connect(service, command.session);
          break;
        case 'disconnect':
          service.disconnect();
          break;
        case 'send':
          sendResult = service.send(
            kind.sendEvent,
            command.oversized ? OVERSIZED_DATA : { value: command.value }
          );
          log.push({ kind: 'send-result', result: sendResult });
          break;
        case 'advance':
          vi.advanceTimersByTime(command.ms);
          break;
        case 'open':
          currentOpenDelivered = socket !== null && socket.emitOpen() && !isStale;
          break;
        case 'message':
          socket?.emitMessage(kind.messageEvents[command.event], { n: command.n });
          break;
        case 'close':
          socket?.emitClose(command.code);
          break;
        case 'error':
          socket?.emitError();
          break;
      }

      // Socket creation: one at a time, never by a stale event, and only after every
      // earlier socket was closed (R25.1, R25.5).
      const created = MockWebSocket.instances.length - before.sockets;
      expect(created, ctx).toBeLessThanOrEqual(1);
      if (created === 1) {
        expect(isStale, ctx).toBe(false);
        current = MockWebSocket.instances.length - 1;
        expect(MockWebSocket.liveAtCreation[current], ctx).toBe(0);
      }
      if (command.kind === 'disconnect') {
        current = null;
        // The scheduled reconnection attempt is cancelled (R25.2).
        expect(vi.getTimerCount(), ctx).toBe(0);
      }

      // The service's Current_Socket is the modelled one (R25.1, R25.2, R25.5).
      expect(internalsOf(service).current?.socket ?? null, ctx).toBe(
        current === null ? null : MockWebSocket.instances[current]
      );

      // At most one live socket (R25.8).
      expect(liveSocketCount(), ctx).toBeLessThanOrEqual(1);

      // Connection_Generation moves only on an open of the Current_Socket (R25.3, R25.7).
      expect(service.connectionGeneration() - before.generation, ctx).toBe(
        currentOpenDelivered ? 1 : 0
      );

      // Frames reach only the Current_Socket while OPEN (R25.3, R25.10).
      const frames = log.slice(logBefore).filter((entry) => entry.kind === 'frame');
      for (const frame of frames) {
        expect(frame['index'], ctx).toBe(current);
        expect(frame['readyState'], ctx).toBe(MockWebSocket.OPEN);
      }
      if (command.kind === 'send') {
        const currentSocket = current === null ? null : MockWebSocket.instances[current];
        if (currentSocket === null || currentSocket.readyState !== MockWebSocket.OPEN) {
          expect(sendResult, ctx).toBe(false);
        }
        expect(frames.length, ctx).toBe(sendResult ? 1 : 0);
      } else {
        expect(frames.length, ctx).toBe(0);
      }

      if (isStale) {
        // A stale event changes nothing and is absent from the log (R25.3–R25.5).
        expect(snapshot(service), ctx).toEqual(before);
        expect(log.slice(logBefore), ctx).toEqual([]);
        return;
      }
      log.push({ kind: 'step', i, ...snapshot(service) });
    });
  } finally {
    subscriptions.forEach((subscription) => subscription.unsubscribe());
    activeLog = [];
    TestBed.resetTestingModule();
    vi.clearAllTimers();
    vi.useRealTimers();
  }

  return { log, plan: { stale, targets } };
}

function checkStaleSocketProperty<S extends ServiceUnderTest>(kind: ServiceKind<S>): void {
  fc.assert(
    fc.property(commandsArb, (commands) => {
      const first = runSequence(kind, commands);
      const second = runSequence(kind, commands, first.plan);
      expect(second.log).toEqual(first.log);
    }),
    { numRuns: 150 }
  );
}

// --- Properties --------------------------------------------------------------------

let originalWebSocket: typeof globalThis.WebSocket;

beforeEach(() => {
  originalWebSocket = globalThis.WebSocket;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket;
});

afterEach(() => {
  activeLog = [];
  TestBed.resetTestingModule();
  vi.useRealTimers();
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
});

/**
 * 150 runs take about 1.2 s alone but can pass Vitest's 5,000 ms default when the whole client
 * suite runs in parallel, so each property gets its own budget.
 */
const PROPERTY_TIMEOUT_MS = 30_000;

describe('Feature: session-chat, Property 37: Stale-socket events change nothing (WebSocketService)', () => {
  it('logs the same with stale events removed, keeps one live socket and writes only to the open Current_Socket', () => {
    checkStaleSocketProperty(POKER);
  }, PROPERTY_TIMEOUT_MS);
});

describe('Feature: session-chat, Property 37: Stale-socket events change nothing (RetroWebSocketService)', () => {
  it('logs the same with stale events removed, keeps one live socket and writes only to the open Current_Socket', () => {
    checkStaleSocketProperty(RETRO);
  }, PROPERTY_TIMEOUT_MS);
});
