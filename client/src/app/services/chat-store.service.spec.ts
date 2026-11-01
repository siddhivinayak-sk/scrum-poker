import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { ChatMessage, ChatMessageSendPayload, ConnectionState, User } from '@shared/types';
import { CHAT_ACK_TIMEOUT_NOTICE, CHAT_NOT_SENT_ANNOUNCEMENT, OutboxEntry } from './chat-store';
import { CHAT_TIMERS, ChatStore, ChatTimers } from './chat-store.service';
import { CHAT_READ_MARKER_STORE, ReadMarkerStore, readMarkerKey } from './chat-read-marker';
import { CHAT_TRANSPORT, ChatTransport } from './chat-transport';

/** Manual clock: timers fire only through `advance`. */
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
  advance(ms: number): void {
    this.time += ms;
    for (const [handle, timer] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= this.time && this.pending.delete(handle)) timer.callback();
    }
  }
}

class FakeTransport implements ChatTransport {
  readonly boardKind = 'poker' as const;
  readonly connectionState = signal<ConnectionState>('connected');
  readonly connectionGeneration = signal(1);
  readonly participants = signal<readonly User[]>([]);
  readonly currentUserId = signal<string | null>('me');
  readonly added$ = new Subject<unknown>();
  readonly history$ = new Subject<unknown>();
  readonly rejected$ = new Subject<unknown>();
  readonly sent: ChatMessageSendPayload[] = [];
  send(payload: ChatMessageSendPayload): boolean {
    this.sent.push(payload);
    return true;
  }
}

function message(seq: number, authorId: string): ChatMessage {
  return {
    id: `10000000-0000-4000-8000-${seq.toString().padStart(12, '0')}`,
    seq,
    clientMessageId: `20000000-0000-4000-8000-${seq.toString().padStart(12, '0')}`,
    authorId,
    authorName: authorId,
    text: `text ${seq}`,
    sentAt: new Date(1_000_000 + seq).toISOString(),
  };
}

describe('ChatStore service (smoke)', () => {
  let transport: FakeTransport;
  let timers: ManualTimers;
  let storage: Map<string, string>;
  let store: ChatStore;

  beforeEach(() => {
    transport = new FakeTransport();
    timers = new ManualTimers();
    storage = new Map();
    TestBed.configureTestingModule({
      providers: [
        ChatStore,
        { provide: CHAT_TRANSPORT, useValue: transport },
        { provide: CHAT_TIMERS, useValue: timers },
        {
          provide: CHAT_READ_MARKER_STORE,
          useValue: new ReadMarkerStore(() => ({
            getItem: (k: string) => storage.get(k) ?? null,
            setItem: (k: string, v: string) => void storage.set(k, v),
          })),
        },
      ],
    });
    store = TestBed.inject(ChatStore);
    store.reset('s1');
    TestBed.tick();
  });

  it('sends the Normalised_Text with a canonical id and clears the draft and caret', () => {
    store.draft.set('  hello\r\n ');
    store.caret.set(9);
    expect(store.sendable()).toBe(true);
    store.sendDraft();
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].text).toBe('hello');
    expect(transport.sent[0].sessionId).toBe('s1');
    expect(transport.sent[0].clientMessageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(store.draft()).toBe('');
    expect(store.caret()).toBe(0);
    expect(store.entries()).toHaveLength(1);
  });

  it('is not sendable while disconnected', () => {
    transport.connectionState.set('reconnecting');
    TestBed.tick();
    store.draft.set('hello');
    expect(store.sendable()).toBe(false);
    store.sendDraft();
    expect(transport.sent).toHaveLength(0);
    expect(store.draft()).toBe('hello');
  });

  it('fails a pending message after 10,000 ms and announces it', () => {
    store.draft.set('hello');
    store.sendDraft();
    timers.advance(10_000);
    const entry = store.entries()[0];
    expect(entry.kind === 'outbox' && entry.entry.state).toBe('failed');
    expect(store.announcement()?.text).toBe(CHAT_NOT_SENT_ANNOUNCEMENT);
  });

  it('times out the loading state 10,000 ms after the first connected', () => {
    expect(store.historyStatus()).toBe('loading');
    timers.advance(10_000);
    expect(store.historyStatus()).toBe('timed-out');
  });

  it('counts unread increases while closed and writes the Read_Marker once open', () => {
    transport.history$.next({ messages: [message(1, 'other')] });
    expect(store.unreadCount()).toBe(1);
    expect(store.unreadIncreaseCount()).toBe(1);
    transport.added$.next({ message: message(2, 'other') });
    expect(store.unreadIncreaseCount()).toBe(2);

    store.panelState.set('open');
    TestBed.tick();
    expect(store.unreadCount()).toBe(0);
    expect(storage.get(readMarkerKey('poker', 's1'))).toBe('2');
  });

  it('counts the New_Messages_Indicator while not At_Bottom, also while closed', () => {
    transport.history$.next({ messages: [message(1, 'other')] });
    store.scroll.set({ top: 0, atBottom: false });
    transport.added$.next({ message: message(2, 'other') });
    transport.added$.next({ message: message(3, 'me') });
    expect(store.newIndicatorCount()).toBe(1);

    transport.connectionGeneration.set(2);
    transport.history$.next({ messages: [message(1, 'other'), message(2, 'other'), message(4, 'other')] });
    expect(store.newIndicatorCount()).toBe(2);
  });
});

// --- Example tests (task 8.15) -------------------------------------------------------------

const MARKER_KEY = readMarkerKey('poker', 's1');

interface Harness {
  readonly transport: FakeTransport;
  readonly timers: ManualTimers;
  readonly store: ChatStore;
}

/** A store bound to `s1` over a fresh fake transport and manual clock, connected at generation 1. */
function setup(readMarkers: ReadMarkerStore): Harness {
  const transport = new FakeTransport();
  const timers = new ManualTimers();
  TestBed.configureTestingModule({
    providers: [
      ChatStore,
      { provide: CHAT_TRANSPORT, useValue: transport },
      { provide: CHAT_TIMERS, useValue: timers },
      { provide: CHAT_READ_MARKER_STORE, useValue: readMarkers },
    ],
  });
  const store = TestBed.inject(ChatStore);
  store.reset('s1');
  TestBed.tick();
  return { transport, timers, store };
}

function memoryMarkers(storage = new Map<string, string>()): ReadMarkerStore {
  return new ReadMarkerStore(() => ({
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  }));
}

/** Types the Draft and sends it; returns the frame handed to the transport. */
function sendText(h: Harness, text: string): ChatMessageSendPayload {
  const before = h.transport.sent.length;
  h.store.draft.set(text);
  h.store.sendDraft();
  expect(h.transport.sent).toHaveLength(before + 1);
  return h.transport.sent[before];
}

/** The server's confirmed copy of an Own_Message frame. */
function ownMessage(seq: number, payload: ChatMessageSendPayload): ChatMessage {
  return { ...message(seq, 'me'), clientMessageId: payload.clientMessageId, text: payload.text };
}

function outbox(store: ChatStore): OutboxEntry[] {
  return store.entries().flatMap((e) => (e.kind === 'outbox' ? [e.entry] : []));
}

function outboxEntry(store: ChatStore, clientMessageId: string): OutboxEntry | undefined {
  return outbox(store).find((e) => e.clientMessageId === clientMessageId);
}

function confirmedSeqs(store: ChatStore): number[] {
  return store.entries().flatMap((e) => (e.kind === 'confirmed' ? [e.message.seq] : []));
}

function framesFor(transport: FakeTransport, clientMessageId: string): ChatMessageSendPayload[] {
  return transport.sent.filter((p) => p.clientMessageId === clientMessageId);
}

/** Drops the Board_Connection and opens a new one with the next Connection_Generation. */
function reconnect(h: Harness, offlineMs = 0): void {
  h.transport.connectionState.set('reconnecting');
  TestBed.tick();
  h.timers.advance(offlineMs);
  h.transport.connectionGeneration.update((g) => g + 1);
  h.transport.connectionState.set('connected');
  TestBed.tick();
}

describe('ChatStore service: Delivery_State (R22.3, R8)', () => {
  let h: Harness;

  beforeEach(() => {
    h = setup(memoryMarkers());
  });

  it('pending → sent when the own Chat_Message arrives', () => {
    const frame = sendText(h, 'hello');
    expect(outboxEntry(h.store, frame.clientMessageId)?.state).toBe('pending');

    h.transport.added$.next({ message: ownMessage(1, frame) });
    const entries = h.store.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0].kind === 'confirmed' && entries[0].own).toBe(true);
    expect(entries[0].kind === 'confirmed' && entries[0].message.clientMessageId).toBe(frame.clientMessageId);

    // The acknowledgement timer was stopped: nothing fails later.
    h.timers.advance(20_000);
    expect(h.store.entries()).toEqual(entries);
    expect(h.store.announcement()).toBeNull();
  });

  it('pending → failed after 10,000 ms of connected time only (R8.5, R9.3)', () => {
    const frame = sendText(h, 'hello');
    h.timers.advance(4_000);

    h.transport.connectionState.set('reconnecting');
    TestBed.tick();
    h.timers.advance(60_000);
    expect(outboxEntry(h.store, frame.clientMessageId)?.state).toBe('pending');

    h.transport.connectionState.set('connected');
    TestBed.tick();
    h.timers.advance(5_999);
    expect(outboxEntry(h.store, frame.clientMessageId)?.state).toBe('pending');
    expect(h.store.announcement()).toBeNull();

    h.timers.advance(1);
    const entry = outboxEntry(h.store, frame.clientMessageId);
    expect(entry?.state).toBe('failed');
    expect(entry?.notice).toBe(CHAT_ACK_TIMEOUT_NOTICE);
    expect(entry?.text).toBe('hello');
    expect(h.store.announcement()?.text).toBe(CHAT_NOT_SENT_ANNOUNCEMENT);
  });

  it('failed → pending on Retry, resending the same id and text with a timer from 0 (R8.7)', () => {
    const frame = sendText(h, 'hello');
    h.timers.advance(10_000);
    expect(outboxEntry(h.store, frame.clientMessageId)?.state).toBe('failed');

    h.store.retry(frame.clientMessageId);
    const entry = outboxEntry(h.store, frame.clientMessageId);
    expect(entry?.state).toBe('pending');
    expect(entry?.notice).toBeNull();
    expect(h.transport.sent).toEqual([frame, frame]);

    h.timers.advance(9_999);
    expect(outboxEntry(h.store, frame.clientMessageId)?.state).toBe('pending');
    h.transport.added$.next({ message: ownMessage(1, frame) });
    expect(outbox(h.store)).toEqual([]);
    expect(confirmedSeqs(h.store)).toEqual([1]);
  });

  it('runs the reconnect merge of R9.4–R9.7', () => {
    h.transport.history$.next({ messages: [message(1, 'other'), message(2, 'other')] });

    // C and D fail by timeout; A and B are still pending when the connection drops.
    const c = sendText(h, 'charlie');
    const d = sendText(h, 'delta');
    h.timers.advance(10_000);
    expect(outboxEntry(h.store, c.clientMessageId)?.state).toBe('failed');
    expect(outboxEntry(h.store, d.clientMessageId)?.state).toBe('failed');
    const a = sendText(h, 'alpha');
    const b = sendText(h, 'bravo');
    h.timers.advance(2_000);

    reconnect(h, 30_000);
    // R9.3: the disconnect failed nothing.
    expect(outboxEntry(h.store, a.clientMessageId)?.state).toBe('pending');
    expect(outboxEntry(h.store, b.clientMessageId)?.state).toBe('pending');
    expect(h.transport.sent).toHaveLength(4);

    h.transport.history$.next({
      messages: [
        message(1, 'other'),
        message(2, 'other'),
        ownMessage(3, a),
        message(4, 'other'),
        ownMessage(5, c),
        message(6, 'other'),
      ],
    });

    // R9.4: confirmed messages in seq order, then the remaining outbox in first-send order.
    // R9.5: A (pending) and C (failed) are replaced by their confirmed copies.
    const entries = h.store.entries();
    expect(entries.map((e) => e.key)).toEqual([
      message(1, 'other').id,
      message(2, 'other').id,
      ownMessage(3, a).id,
      message(4, 'other').id,
      ownMessage(5, c).id,
      message(6, 'other').id,
      `outbox:${d.clientMessageId}`,
      `outbox:${b.clientMessageId}`,
    ]);
    expect(entries[2].kind === 'confirmed' && entries[2].own && entries[2].message.text).toBe('alpha');
    expect(entries[4].kind === 'confirmed' && entries[4].own && entries[4].message.text).toBe('charlie');

    // R9.6: B is resent exactly once with its original id and text; R9.7: D is not resent.
    expect(h.transport.sent).toHaveLength(5);
    expect(h.transport.sent[4]).toEqual(b);
    expect(framesFor(h.transport, d.clientMessageId)).toHaveLength(1);
    expect(outboxEntry(h.store, d.clientMessageId)?.state).toBe('failed');
    expect(outboxEntry(h.store, d.clientMessageId)?.notice).toBe(CHAT_ACK_TIMEOUT_NOTICE);
    expect(h.store.unreadCount()).toBe(4);

    // R9.6: B has a new full 10,000 ms timer.
    h.timers.advance(9_999);
    expect(outboxEntry(h.store, b.clientMessageId)?.state).toBe('pending');
    h.timers.advance(1);
    expect(outboxEntry(h.store, b.clientMessageId)?.state).toBe('failed');
    expect(h.transport.sent).toHaveLength(5);
  });
});

describe('ChatStore service: Connection_Generation gate (R22.17, R25.9, R25.11, R25.12)', () => {
  let h: Harness;

  beforeEach(() => {
    h = setup(memoryMarkers());
  });

  it('applies the first Chat_History with no resend and no new timer (R25.9)', () => {
    const frame = sendText(h, 'hello');
    h.timers.advance(4_000);
    h.transport.connectionGeneration.set(3);

    h.transport.history$.next({ messages: [message(1, 'other')] });
    expect(h.store.historyGeneration()).toBe(3);
    expect(h.store.historyStatus()).toBe('loaded');
    expect(confirmedSeqs(h.store)).toEqual([1]);
    expect(h.transport.sent).toEqual([frame]);

    // The original timer keeps running: it fails 10,000 ms after the send.
    h.timers.advance(5_999);
    expect(outboxEntry(h.store, frame.clientMessageId)?.state).toBe('pending');
    h.timers.advance(1);
    expect(outboxEntry(h.store, frame.clientMessageId)?.state).toBe('failed');
  });

  it('resends exactly once for a higher Connection_Generation (R25.11)', () => {
    h.transport.history$.next({ messages: [message(1, 'other')] });
    const frame = sendText(h, 'hello');

    reconnect(h);
    h.transport.history$.next({ messages: [message(1, 'other')] });
    expect(h.store.historyGeneration()).toBe(2);
    expect(framesFor(h.transport, frame.clientMessageId)).toHaveLength(2);

    // Equal and lower generations resend nothing more.
    h.transport.history$.next({ messages: [message(1, 'other')] });
    h.transport.connectionGeneration.set(1);
    h.transport.history$.next({ messages: [message(1, 'other')] });
    expect(framesFor(h.transport, frame.clientMessageId)).toHaveLength(2);
    expect(h.store.historyGeneration()).toBe(2);
  });

  it('ignores a Chat_History of an equal or lower Connection_Generation (R25.12)', () => {
    h.transport.connectionGeneration.set(2);
    h.transport.history$.next({ messages: [message(1, 'other')] });
    const frame = sendText(h, 'hello');
    h.timers.advance(3_000);

    const entries = h.store.entries();
    const unread = h.store.unreadCount();
    for (const generation of [2, 1]) {
      h.transport.connectionGeneration.set(generation);
      h.transport.history$.next({
        messages: [message(1, 'other'), message(2, 'other'), ownMessage(3, frame)],
      });
      expect(h.store.entries()).toBe(entries);
      expect(h.store.unreadCount()).toBe(unread);
      expect(h.store.historyGeneration()).toBe(2);
    }
    expect(h.transport.sent).toEqual([frame]);

    // The timer is unchanged: the message fails 10,000 ms after its send.
    h.timers.advance(6_999);
    expect(outboxEntry(h.store, frame.clientMessageId)?.state).toBe('pending');
    h.timers.advance(1);
    expect(outboxEntry(h.store, frame.clientMessageId)?.state).toBe('failed');
  });

  it('treats the first Chat_History after reset as first, whatever its generation (R18.11, R25.9)', () => {
    h.transport.connectionGeneration.set(2);
    h.transport.history$.next({ messages: [message(1, 'other')] });
    const old = sendText(h, 'old session');

    h.store.reset('s2');
    TestBed.tick();
    expect(h.store.historyGeneration()).toBeNull();
    expect(h.store.entries()).toEqual([]);
    expect(h.store.sessionId()).toBe('s2');

    // The previous session's timer was cancelled.
    h.timers.advance(10_000);
    expect(h.store.announcement()).toBeNull();

    const frame = sendText(h, 'new session');
    expect(frame.sessionId).toBe('s2');
    h.transport.connectionGeneration.set(1);
    h.transport.history$.next({ messages: [message(1, 'other')] });
    expect(h.store.historyGeneration()).toBe(1);
    expect(h.store.historyStatus()).toBe('loaded');
    expect(confirmedSeqs(h.store)).toEqual([1]);
    expect(framesFor(h.transport, frame.clientMessageId)).toHaveLength(1);
    expect(framesFor(h.transport, old.clientMessageId)).toHaveLength(1);

    // Later histories follow the gate again.
    h.transport.history$.next({ messages: [message(1, 'other')] });
    expect(framesFor(h.transport, frame.clientMessageId)).toHaveLength(1);
    h.transport.connectionGeneration.set(2);
    h.transport.history$.next({ messages: [message(1, 'other')] });
    expect(framesFor(h.transport, frame.clientMessageId)).toHaveLength(2);
    expect(framesFor(h.transport, old.clientMessageId)).toHaveLength(1);
  });
});

describe('ChatStore service: Read_Marker storage failures (R2.12)', () => {
  afterEach(() => vi.restoreAllMocks());

  const blocked = (): never => {
    throw new DOMException('Storage is blocked', 'SecurityError');
  };
  const cases: readonly [string, ReadMarkerStore][] = [
    ['the storage provider throws', new ReadMarkerStore(blocked)],
    ['getItem and setItem throw', new ReadMarkerStore(() => ({ getItem: blocked, setItem: blocked }))],
  ];

  for (const [name, markers] of cases) {
    it(`keeps the Read_Marker in memory when ${name}`, () => {
      const consoleError = vi.spyOn(console, 'error');
      let h!: Harness;
      expect(() => {
        h = setup(markers);
        h.transport.history$.next({ messages: [message(1, 'other'), message(2, 'other')] });
      }).not.toThrow();
      expect(h.store.unreadCount()).toBe(2);

      h.store.panelState.set('open');
      TestBed.tick();
      expect(h.store.unreadCount()).toBe(0);
      expect(markers.read('poker', 's1')).toBe(2);

      h.store.panelState.set('closed');
      TestBed.tick();
      h.transport.added$.next({ message: message(3, 'other') });
      expect(h.store.unreadCount()).toBe(1);

      // The in-memory marker survives a session change and back.
      h.store.reset('s2');
      TestBed.tick();
      h.store.reset('s1');
      TestBed.tick();
      h.transport.history$.next({ messages: [message(1, 'other'), message(2, 'other'), message(3, 'other')] });
      expect(h.store.unreadCount()).toBe(1);

      expect(consoleError).not.toHaveBeenCalled();
      expect(h.store.announcement()).toBeNull();
    });
  }
});

/** In-memory `Storage` stand-in whose `setItem` is a spy. */
class SpyStorage {
  private readonly data = new Map<string, string>();
  readonly setItem = vi.fn((key: string, value: string): void => {
    this.data.set(key, String(value));
  });
  get length(): number {
    return this.data.size;
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  keys(): string[] {
    return [...this.data.keys()];
  }
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

describe('ChatStore service: storage and console privacy (R19.3, R19.7)', () => {
  let sessionStub: SpyStorage;
  let localStub: SpyStorage;
  let prototypeSetItem: { mock: { calls: unknown[][] } } | null;

  beforeEach(() => {
    sessionStub = new SpyStorage();
    localStub = new SpyStorage();
    vi.stubGlobal('sessionStorage', sessionStub);
    vi.stubGlobal('localStorage', localStub);
    // Catches a write to any real Storage object that bypasses the stubs.
    prototypeSetItem = typeof Storage === 'undefined' ? null : vi.spyOn(Storage.prototype, 'setItem');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function allSetItemCalls(): unknown[][] {
    return [...sessionStub.setItem.mock.calls, ...localStub.setItem.mock.calls, ...(prototypeSetItem?.mock.calls ?? [])];
  }

  /** Sends, rejects, retries, times out and reads while open, on the default `sessionStorage` store. */
  function runScenario(h: Harness, text: string): void {
    h.transport.history$.next({ messages: [message(1, 'other'), { ...message(2, 'other'), text }] });
    h.store.draft.set(text);
    const rejected = sendText(h, text);
    h.transport.rejected$.next({
      clientMessageId: rejected.clientMessageId,
      code: 'CHAT_INVALID',
      message: 'Message is invalid.',
    });
    expect(outboxEntry(h.store, rejected.clientMessageId)?.state).toBe('failed');
    h.store.retry(rejected.clientMessageId);
    h.timers.advance(10_000);
    expect(outboxEntry(h.store, rejected.clientMessageId)?.notice).toBe(CHAT_ACK_TIMEOUT_NOTICE);

    // Events that fail to parse.
    h.transport.added$.next({ message: { text } });
    h.transport.history$.next({ messages: { text } });
    h.transport.rejected$.next({ clientMessageId: rejected.clientMessageId, code: 'NOPE', message: text });

    const confirmed = sendText(h, `${text} again`);
    h.transport.added$.next({ message: ownMessage(3, confirmed) });
    h.store.panelState.set('open');
    TestBed.tick();
    h.transport.added$.next({ message: { ...message(4, 'other'), text } });
    h.store.draft.set(text);
    TestBed.tick();
  }

  it('writes only the Read_Marker key with a decimal value to sessionStorage, nothing to localStorage', () => {
    const h = setup(new ReadMarkerStore());
    runScenario(h, 'storage probe');

    const writes = sessionStub.setItem.mock.calls;
    expect(writes.length).toBeGreaterThan(0);
    for (const [key, value] of writes) {
      expect(key).toBe(MARKER_KEY);
      expect(value).toMatch(/^[1-9]\d*$/);
    }
    expect(sessionStub.keys()).toEqual([MARKER_KEY]);
    expect(sessionStub.getItem(MARKER_KEY)).toBe('4');
    expect(localStub.setItem).not.toHaveBeenCalled();
    for (const [key] of prototypeSetItem?.mock.calls ?? []) expect(key).toBe(MARKER_KEY);
  });

  it('writes no message or Draft text to the console or storage on send, reject and timeout', () => {
    const secret = 'zebra-quartz-7731';
    const consoleSpies = CONSOLE_METHODS.map((method) =>
      vi.spyOn(console as Record<ConsoleMethod, (...args: unknown[]) => void>, method),
    );
    const fakeStorage = new SpyStorage();
    const h = setup(new ReadMarkerStore(() => fakeStorage));
    runScenario(h, secret);

    const calls = [
      ...consoleSpies.flatMap((spy) => spy.mock.calls as unknown[][]),
      ...fakeStorage.setItem.mock.calls,
      ...allSetItemCalls(),
    ];
    expect(fakeStorage.setItem).toHaveBeenCalled();
    for (const args of calls) {
      for (const arg of args) expect(describeArg(arg)).not.toContain(secret);
    }
  });
});

/** Every readable form of a logged or stored argument. */
function describeArg(arg: unknown): string {
  if (arg instanceof Error) return `${arg.name} ${arg.message} ${arg.stack ?? ''}`;
  if (typeof arg === 'string') return arg;
  try {
    return `${JSON.stringify(arg)} ${String(arg)}`;
  } catch {
    return String(arg);
  }
}
