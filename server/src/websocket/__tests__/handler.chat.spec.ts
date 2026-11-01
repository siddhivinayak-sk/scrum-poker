import crypto from 'crypto';
import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { handleWebSocket, _reset as resetHandler, getSessionClients } from '../handler';
import { CHAT_REJECTION_MESSAGES } from '../chat-send';
import * as authService from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import { GameSession } from '../../services/game-session';
import {
  User,
  WebSocketMessage,
  DEFAULT_SESSION_CONFIG,
  ChatMessage,
  ChatRejection,
  ChatMessageRejectedPayload,
  isCanonicalUuid,
  CHAT_MESSAGE_SEND,
  CHAT_MESSAGE_ADDED,
  CHAT_MESSAGE_REJECTED,
  CHAT_HISTORY,
  RETRO_CHAT_MESSAGE_SEND,
  RETRO_CHAT_MESSAGE_ADDED,
  RETRO_CHAT_MESSAGE_REJECTED,
  RETRO_CHAT_HISTORY,
  CHAT_HISTORY_LIMIT,
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_RATE_LIMIT_COUNT,
  CHAT_RATE_LIMIT_WINDOW_MS,
} from '../../../../shared/types';

/**
 * Unit tests for the Poker_Chat_Handler (task 3.7): the `chat:message:send`
 * case of `handleEvent`, `handleChatSend` and the `chat:history` frame sent on
 * connect.
 *
 * Time is controlled by stubbing `Date.now` *before* each session is created:
 * `ChatRoom` captures `Date.now` as its default clock at construction, so the
 * stub drives `sentAt`, the rate limiter and `lastActivityAt` with no real
 * waiting. The throwing-`idFactory` case spies on `crypto.randomUUID`, which is
 * the default `ChatRoom` id factory, for exactly one call.
 *
 * **Validates: Requirements 22.8, 1.13, 15.3, 15.7, 15.9, 15.12, 15.13, 18.4, 18.6, 18.8, 20.6, 20.7**
 */

// --- Mock socket --------------------------------------------------------------

type MockWs = WebSocket & {
  sentMessages: string[];
  /** `send:<event>` / `close:<code>` in call order. */
  ops: string[];
  close: jest.Mock;
};

function createMockWs(): MockWs {
  const emitter = new EventEmitter();
  const mock = emitter as any;
  mock.readyState = WebSocket.OPEN;
  mock.sentMessages = [];
  mock.ops = [];
  mock.send = jest.fn((data: string) => {
    mock.sentMessages.push(data);
    mock.ops.push(`send:${(JSON.parse(data) as WebSocketMessage).event}`);
  });
  mock.close = jest.fn((code?: number) => {
    mock.ops.push(`close:${code ?? 1000}`);
    mock.readyState = WebSocket.CLOSED;
  });
  return mock as MockWs;
}

function createSessionRequest(token: string, sid: string): IncomingMessage {
  return {
    url: `/?token=${token}&sessionId=${sid}`,
    headers: { host: 'localhost:3000' },
  } as unknown as IncomingMessage;
}

function emitEvent(ws: MockWs, event: string, data: unknown): void {
  ws.emit('message', Buffer.from(JSON.stringify({ event, data, timestamp: new Date().toISOString() })));
}

/** A frame with no `data` key at all. */
function emitEventWithoutData(ws: MockWs, event: string): void {
  ws.emit('message', Buffer.from(JSON.stringify({ event, timestamp: new Date().toISOString() })));
}

function frames(ws: MockWs): WebSocketMessage[] {
  return ws.sentMessages.map((raw) => JSON.parse(raw) as WebSocketMessage);
}

function eventsOf(ws: MockWs): string[] {
  return frames(ws).map((m) => m.event);
}

function added(ws: MockWs): ChatMessage[] {
  return frames(ws)
    .filter((m) => m.event === CHAT_MESSAGE_ADDED)
    .map((m) => m.data.message as ChatMessage);
}

function rejected(ws: MockWs): ChatMessageRejectedPayload[] {
  return frames(ws)
    .filter((m) => m.event === CHAT_MESSAGE_REJECTED)
    .map((m) => m.data as ChatMessageRejectedPayload);
}

function errors(ws: MockWs): { code: string; message: string }[] {
  return frames(ws)
    .filter((m) => m.event === 'error')
    .map((m) => m.data as { code: string; message: string });
}

/** Chat frames of any kind (added, rejected, history). */
function chatFrames(ws: MockWs): WebSocketMessage[] {
  return frames(ws).filter((m) => [CHAT_MESSAGE_ADDED, CHAT_MESSAGE_REJECTED, CHAT_HISTORY].includes(m.event));
}

function clearSent(...sockets: MockWs[]): void {
  for (const ws of sockets) {
    ws.sentMessages.length = 0;
    ws.ops.length = 0;
  }
}

/** Deterministic canonical v4 UUID for Client_Message_Ids. */
function cid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

// --- Fixtures -----------------------------------------------------------------

const moderator: User = { id: 'mod-1', displayName: 'Moderator', role: 'moderator', isAnonymous: false };
const alice: User = { id: 'user-a', displayName: 'Alice', role: 'participant', isAnonymous: false };
const bob: User = { id: 'user-b', displayName: 'Bob', role: 'participant', isAnonymous: false };
const carol: User = { id: 'user-c', displayName: 'Carol', role: 'participant', isAnonymous: false };

const START = 1_700_000_000_000;

let now: number;
let sessionId: string;
let session: GameSession;

function connect(u: User, sid: string = sessionId): MockWs {
  jest.spyOn(authService, 'validateToken').mockReturnValueOnce(u);
  const ws = createMockWs();
  handleWebSocket(ws, createSessionRequest(`token-${u.id}`, sid));
  return ws;
}

function sendChat(ws: MockWs, n: number, text: string = `message ${n}`): void {
  emitEvent(ws, CHAT_MESSAGE_SEND, { sessionId, clientMessageId: cid(n), text });
}

function rejection(clientMessageId: string, code: ChatRejection): ChatMessageRejectedPayload {
  return { clientMessageId, code, message: CHAT_REJECTION_MESSAGES[code] };
}

function historyJson(): string {
  return JSON.stringify(session.chat.history());
}

beforeEach(() => {
  jest.restoreAllMocks();
  resetHandler();
  sessionRegistry._reset();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  now = START;
  // Installed before createSession so ChatRoom captures the stub as its clock.
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  sessionId = sessionRegistry.createSession(moderator.id, DEFAULT_SESSION_CONFIG).sessionId;
  session = sessionRegistry.getSession(sessionId)!;
});

afterEach(() => {
  resetHandler();
  sessionRegistry._reset();
  jest.restoreAllMocks();
});

// --- chat:history on connect (R18.4, R18.6, R20.6) ----------------------------

describe('chat:history on connect (R18.4, R18.6, R20.6)', () => {
  it('is sent after session:state and participant:joined, and is empty for a new session', () => {
    const ws = connect(moderator);

    // Existing frame indexes are unchanged: 0 = state, 1 = joined; history is appended.
    expect(eventsOf(ws)).toEqual(['session:state', 'participant:joined', CHAT_HISTORY]);
    expect(frames(ws)[2].data).toEqual({ messages: [] });
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('goes to the new socket only; existing sockets just get the join broadcast', () => {
    const mod = connect(moderator);
    clearSent(mod);
    const a = connect(alice);

    expect(eventsOf(a)).toEqual(['session:state', 'participant:joined', CHAT_HISTORY]);
    expect(eventsOf(mod)).toEqual(['participant:joined']);
  });

  it('holds every buffered message in ascending seq order, before any later added event', () => {
    const mod = connect(moderator);
    sendChat(mod, 1);
    sendChat(mod, 2);
    sendChat(mod, 3);

    const b = connect(bob);
    const history = frames(b)[2];
    expect(history.event).toBe(CHAT_HISTORY);
    expect(history.data.messages).toEqual(session.chat.history());
    expect((history.data.messages as ChatMessage[]).map((m) => m.seq)).toEqual([1, 2, 3]);

    sendChat(mod, 4);
    const events = eventsOf(b);
    expect(events.indexOf(CHAT_HISTORY)).toBeLessThan(events.indexOf(CHAT_MESSAGE_ADDED));
    expect(added(b).map((m) => m.seq)).toEqual([4]);
  });

  it('a second poker session starts with its own empty chat (R18.6)', () => {
    const mod = connect(moderator);
    sendChat(mod, 1);

    const otherId = sessionRegistry.createSession('owner-2', DEFAULT_SESSION_CONFIG).sessionId;
    const c = connect(carol, otherId);
    expect(frames(c)[2]).toEqual(expect.objectContaining({ event: CHAT_HISTORY, data: { messages: [] } }));
    expect(sessionRegistry.getSession(otherId)!.chat.history()).toEqual([]);
  });
});

// --- Accepted send (R22.8) ---------------------------------------------------

describe('accepted send', () => {
  it('broadcasts one identical frame to every socket of the session, the sender and every tab included', () => {
    const mod = connect(moderator);
    const a1 = connect(alice);
    const a2 = connect(alice);
    const b = connect(bob);
    const otherSessionId = sessionRegistry.createSession('owner-2', DEFAULT_SESSION_CONFIG).sessionId;
    const outsider = connect(carol, otherSessionId);
    clearSent(mod, a1, a2, b, outsider);

    // Author fields in the payload are ignored; the author is the connection's identity (R15.1).
    emitEvent(a1, CHAT_MESSAGE_SEND, {
      sessionId,
      clientMessageId: cid(1),
      text: '  hi there \r\n',
      authorId: 'spoofed',
      authorName: 'Mallory',
    });

    const sockets = [mod, a1, a2, b];
    for (const ws of sockets) {
      expect(eventsOf(ws)).toEqual([CHAT_MESSAGE_ADDED]);
    }
    expect(new Set(sockets.map((ws) => ws.sentMessages[0])).size).toBe(1);

    const [message] = added(mod);
    expect(message).toEqual({
      id: expect.any(String),
      seq: 1,
      clientMessageId: cid(1),
      authorId: alice.id,
      authorName: alice.displayName,
      text: 'hi there',
      sentAt: new Date(START).toISOString(),
    });
    expect(isCanonicalUuid(message.id)).toBe(true);
    expect(session.chat.history()).toEqual([message]);
    expect(session.lastActivityAt).toBe(new Date(START).toISOString());

    expect(outsider.sentMessages).toHaveLength(0);
    expect(sessionRegistry.getSession(otherSessionId)!.chat.history()).toEqual([]);
  });

  it('answers a resend of a held clientMessageId with the stored message to the sender only (replay)', () => {
    const a = connect(alice);
    const b = connect(bob);
    sendChat(a, 1, 'first');
    const stored = session.chat.history()[0];
    const activity = session.lastActivityAt;
    clearSent(a, b);

    now = START + 100;
    sendChat(a, 1, 'different text');

    expect(added(a)).toEqual([stored]);
    expect(b.sentMessages).toHaveLength(0);
    expect(session.chat.history()).toEqual([stored]);
    expect(session.lastActivityAt).toBe(activity);
  });
});

// --- The six rejection codes (R22.8) -----------------------------------------

describe('rejections go to the sender only and store nothing', () => {
  const payloadRejections: [ChatRejection, () => Record<string, unknown>, string][] = [
    ['CHAT_SESSION_MISMATCH', () => ({ sessionId: 'other-session', clientMessageId: cid(1), text: 'hi' }), cid(1)],
    ['CHAT_INVALID', () => ({ sessionId, clientMessageId: 'not-a-uuid', text: 'hi' }), 'not-a-uuid'],
    ['CHAT_EMPTY', () => ({ sessionId, clientMessageId: cid(1), text: ' \n\t ' }), cid(1)],
    [
      'CHAT_TOO_LONG',
      () => ({ sessionId, clientMessageId: cid(1), text: 'x'.repeat(CHAT_MESSAGE_MAX_LENGTH + 1) }),
      cid(1),
    ],
  ];

  it.each(payloadRejections)(
    '%s: rejected to the sender only, leaving seq, dedup, rate limiter and lastActivityAt unchanged',
    (code, payload, echoedId) => {
      const mod = connect(moderator);
      const a = connect(alice);
      const b = connect(bob);
      const activity = session.lastActivityAt;
      clearSent(mod, a, b);

      // More rejections than the rate limit allows accepts.
      for (let i = 0; i <= CHAT_RATE_LIMIT_COUNT; i++) {
        emitEvent(a, CHAT_MESSAGE_SEND, payload());
      }

      const replies = rejected(a);
      expect(replies).toHaveLength(CHAT_RATE_LIMIT_COUNT + 1);
      for (const reply of replies) {
        expect(reply).toEqual(rejection(echoedId, code));
        expect(reply).not.toHaveProperty('retryAfterMs');
      }
      expect(eventsOf(a).every((e) => e === CHAT_MESSAGE_REJECTED)).toBe(true);
      expect(mod.sentMessages).toHaveLength(0);
      expect(b.sentMessages).toHaveLength(0);
      expect(session.chat.history()).toEqual([]);
      expect(session.lastActivityAt).toBe(activity);
      expect(a.close).not.toHaveBeenCalled();

      // Nothing was counted: five fresh sends are all accepted, the first with
      // seq 1 and the very clientMessageId that was rejected.
      clearSent(mod, a, b);
      for (let n = 1; n <= CHAT_RATE_LIMIT_COUNT; n++) sendChat(a, n);
      expect(added(b).map((m) => [m.seq, m.clientMessageId])).toEqual(
        [1, 2, 3, 4, 5].map((n) => [n, cid(n)])
      );
      expect(rejected(a)).toEqual([]);
    }
  );

  it('CHAT_RATE_LIMITED: the 6th send in the window is rejected with retryAfterMs; other authors are unaffected', () => {
    const mod = connect(moderator);
    const a = connect(alice);
    const b = connect(bob);
    for (let n = 1; n <= CHAT_RATE_LIMIT_COUNT; n++) sendChat(a, n);
    const activity = session.lastActivityAt;
    clearSent(mod, a, b);

    now = START + 1200;
    sendChat(a, 6);

    expect(rejected(a)).toEqual([
      { ...rejection(cid(6), 'CHAT_RATE_LIMITED'), retryAfterMs: CHAT_RATE_LIMIT_WINDOW_MS - 1200 },
    ]);
    expect(eventsOf(a)).toEqual([CHAT_MESSAGE_REJECTED]);
    expect(mod.sentMessages).toHaveLength(0);
    expect(b.sentMessages).toHaveLength(0);
    expect(session.chat.history()).toHaveLength(CHAT_RATE_LIMIT_COUNT);
    expect(session.lastActivityAt).toBe(activity);
    expect(a.close).not.toHaveBeenCalled();

    // Bob is limited separately.
    sendChat(b, 100);
    expect(added(mod).map((m) => m.authorId)).toEqual([bob.id]);

    // Once the oldest counted message leaves the window, the rejected id is accepted.
    now = START + CHAT_RATE_LIMIT_WINDOW_MS;
    clearSent(mod, a, b);
    sendChat(a, 6);
    expect(added(mod).map((m) => [m.seq, m.clientMessageId])).toEqual([[7, cid(6)]]);
  });

  it('CHAT_DUPLICATE: a recorded id whose message left the buffer is rejected, checked before the rate limit', () => {
    const mod = connect(moderator);
    const a = connect(alice);
    const b = connect(bob);
    sendChat(a, 1);

    // Bob fills the buffer, evicting Alice's seq 1, while staying under his rate limit.
    for (let i = 0; i < CHAT_HISTORY_LIMIT; i++) {
      if (i > 0 && i % CHAT_RATE_LIMIT_COUNT === 0) now += CHAT_RATE_LIMIT_WINDOW_MS;
      sendChat(b, 1000 + i);
    }
    expect(session.chat.history()).toHaveLength(CHAT_HISTORY_LIMIT);
    expect(session.chat.history()[0].seq).toBe(2);

    const before = historyJson();
    clearSent(mod, a, b);
    sendChat(a, 1);

    expect(rejected(a)).toEqual([rejection(cid(1), 'CHAT_DUPLICATE')]);
    expect(eventsOf(a)).toEqual([CHAT_MESSAGE_REJECTED]);
    expect(mod.sentMessages).toHaveLength(0);
    expect(b.sentMessages).toHaveLength(0);
    expect(historyJson()).toBe(before);

    // With Alice rate limited, the duplicate check still answers first (R14.11).
    for (let n = 2; n <= 1 + CHAT_RATE_LIMIT_COUNT; n++) sendChat(a, n);
    clearSent(mod, a, b);
    sendChat(a, 1);
    sendChat(a, 2000);
    expect(rejected(a).map((r) => r.code)).toEqual(['CHAT_DUPLICATE', 'CHAT_RATE_LIMITED']);
    expect(mod.sentMessages).toHaveLength(0);
  });
});

// --- Order of checks (R14.11) and unreadable payloads (R14.10) ----------------

describe('first failing check wins', () => {
  const multiFailures: [string, ChatRejection, () => Record<string, unknown>][] = [
    ['wrong session + bad id + empty text', 'CHAT_SESSION_MISMATCH', () => ({ sessionId: 'other', clientMessageId: 'bad', text: '' })],
    ['non-string session + non-string text', 'CHAT_SESSION_MISMATCH', () => ({ sessionId: 42, clientMessageId: cid(2), text: 7 })],
    ['bad id + too long text', 'CHAT_INVALID', () => ({ sessionId, clientMessageId: 'bad', text: 'x'.repeat(CHAT_MESSAGE_MAX_LENGTH + 1) })],
    ['held id + empty text', 'CHAT_EMPTY', () => ({ sessionId, clientMessageId: cid(1), text: '   ' })],
    ['held id + too long text', 'CHAT_TOO_LONG', () => ({ sessionId, clientMessageId: cid(1), text: 'x'.repeat(CHAT_MESSAGE_MAX_LENGTH + 1) })],
  ];

  it.each(multiFailures)('%s → %s', (_label, code, payload) => {
    const a = connect(alice);
    const b = connect(bob);
    sendChat(a, 1);
    const before = historyJson();
    clearSent(a, b);

    emitEvent(a, CHAT_MESSAGE_SEND, payload());

    expect(rejected(a).map((r) => r.code)).toEqual([code]);
    expect(eventsOf(a)).toEqual([CHAT_MESSAGE_REJECTED]);
    expect(b.sentMessages).toHaveLength(0);
    expect(historyJson()).toBe(before);
  });

  it('a held id while rate limited is a replay, not CHAT_RATE_LIMITED (duplicate before rate limit)', () => {
    const a = connect(alice);
    const b = connect(bob);
    for (let n = 1; n <= CHAT_RATE_LIMIT_COUNT; n++) sendChat(a, n);
    const stored = session.chat.history()[0];
    clearSent(a, b);

    sendChat(a, 1);

    expect(added(a)).toEqual([stored]);
    expect(rejected(a)).toEqual([]);
    expect(b.sentMessages).toHaveLength(0);
  });

  it.each<[string, (ws: MockWs) => void]>([
    ['a null', (ws) => emitEvent(ws, CHAT_MESSAGE_SEND, null)],
    ['a missing', (ws) => emitEventWithoutData(ws, CHAT_MESSAGE_SEND)],
    ['an array', (ws) => emitEvent(ws, CHAT_MESSAGE_SEND, [sessionId, cid(1), 'hi'])],
    ['a string', (ws) => emitEvent(ws, CHAT_MESSAGE_SEND, 'hi')],
    ['a number', (ws) => emitEvent(ws, CHAT_MESSAGE_SEND, 7)],
  ])('%s payload is answered with CHAT_INVALID and an empty clientMessageId', (_label, send) => {
    const a = connect(alice);
    const b = connect(bob);
    clearSent(a, b);

    send(a);

    expect(rejected(a)).toEqual([rejection('', 'CHAT_INVALID')]);
    expect(eventsOf(a)).toEqual([CHAT_MESSAGE_REJECTED]);
    expect(b.sentMessages).toHaveLength(0);
    expect(session.chat.history()).toEqual([]);
    expect(a.close).not.toHaveBeenCalled();
  });
});

// --- Missing session (R15.3) -------------------------------------------------

describe('session no longer in the registry (R15.3)', () => {
  it('answers with error SESSION_NOT_FOUND to the sender only, keeps the socket open, stores and broadcasts nothing', () => {
    const mod = connect(moderator);
    const a = connect(alice);
    const removed = session;
    expect(sessionRegistry.deleteSession(sessionId)).toBe(true);
    clearSent(mod, a);

    sendChat(a, 1);

    expect(frames(a)).toEqual([
      expect.objectContaining({ event: 'error', data: { message: 'Session not found', code: 'SESSION_NOT_FOUND' } }),
    ]);
    expect(a.ops).toEqual(['send:error']);
    expect(a.close).not.toHaveBeenCalled();
    expect(a.readyState).toBe(WebSocket.OPEN);
    expect(mod.sentMessages).toHaveLength(0);
    expect(removed.chat.history()).toEqual([]);
    expect(sessionRegistry.hasSession(sessionId)).toBe(false);
  });
});

// --- Retro chat names on a poker connection (R15.7) ---------------------------

describe('retro chat event names (R15.7)', () => {
  it.each([RETRO_CHAT_MESSAGE_SEND, RETRO_CHAT_MESSAGE_ADDED, RETRO_CHAT_MESSAGE_REJECTED, RETRO_CHAT_HISTORY])(
    '%s → UNKNOWN_EVENT, connection open, chat unchanged',
    (event) => {
      const a = connect(alice);
      const b = connect(bob);
      clearSent(a, b);

      emitEvent(a, event, { sessionId, clientMessageId: cid(1), text: 'hi' });

      expect(errors(a).map((e) => e.code)).toEqual(['UNKNOWN_EVENT']);
      expect(eventsOf(a)).toEqual(['error']);
      expect(b.sentMessages).toHaveLength(0);
      expect(a.close).not.toHaveBeenCalled();
      expect(session.chat.history()).toEqual([]);

      // The id was not recorded and no seq was used.
      clearSent(a, b);
      sendChat(a, 1);
      expect(added(b).map((m) => [m.seq, m.clientMessageId])).toEqual([[1, cid(1)]]);
    }
  );
});

// --- Connections no longer registered (R15.9, R15.12, R15.13) -----------------

describe('connections no longer in the client map', () => {
  it('drops a send from a socket whose close has run, and excludes it from broadcasts', () => {
    const mod = connect(moderator);
    const a1 = connect(alice);
    const a2 = connect(alice);
    // The 'close' listener deregisters a1; its readyState stays OPEN, so only
    // the client map can keep it out.
    a1.emit('close');
    clearSent(mod, a1, a2);

    sendChat(a1, 1);
    expect(mod.sentMessages).toHaveLength(0);
    expect(a1.sentMessages).toHaveLength(0);
    expect(a2.sentMessages).toHaveLength(0);
    expect(session.chat.history()).toEqual([]);

    // Seq, dedup and the rate limiter were not touched by the dropped send.
    sendChat(a2, 1);
    expect(added(mod).map((m) => [m.seq, m.clientMessageId])).toEqual([[1, cid(1)]]);
    expect(added(a2)).toHaveLength(1);
    expect(a1.sentMessages).toHaveLength(0);
  });

  it("participant:remove keeps the removed user's messages, sends them nothing later and drops their stale sends", () => {
    const mod = connect(moderator);
    const a = connect(alice);
    const b = connect(bob);
    sendChat(b, 1, 'from bob');
    sendChat(a, 2, 'from alice');
    clearSent(mod, a, b);

    emitEvent(mod, 'participant:remove', { userId: bob.id });

    expect(b.ops).toEqual(['send:participant:removed', 'close:4010']);
    expect(getSessionClients().get(sessionId)!.has(bob.id)).toBe(false);
    expect(chatFrames(mod)).toEqual([]);
    expect(chatFrames(a)).toEqual([]);

    // Model a close that has not completed: the socket still reads OPEN, so only
    // the client map can keep it out of later broadcasts (R15.12, R15.13).
    (b as any).readyState = WebSocket.OPEN;
    clearSent(mod, a, b);

    sendChat(a, 3, 'after removal');
    expect(added(mod).map((m) => [m.seq, m.authorId])).toEqual([[3, alice.id]]);
    expect(b.sentMessages).toHaveLength(0);

    // The stale socket's sends are dropped: no reply, nothing stored, seq unused.
    sendChat(b, 4, 'stale');
    expect(b.sentMessages).toHaveLength(0);
    expect(added(mod)).toHaveLength(1);

    const history = session.chat.history();
    expect(history.map((m) => [m.seq, m.authorId, m.authorName, m.text])).toEqual([
      [1, bob.id, 'Bob', 'from bob'],
      [2, alice.id, 'Alice', 'from alice'],
      [3, alice.id, 'Alice', 'after removal'],
    ]);
    const c = connect(carol);
    expect(frames(c)[2]).toEqual(expect.objectContaining({ event: CHAT_HISTORY, data: { messages: history } }));
  });
});

// --- Board operations leave chat unchanged (R1.13, R18.8) ---------------------

describe('board operations leave chat unchanged (R1.13, R18.8)', () => {
  /**
   * Seq, dedup and rate-limiter state survive. `priorCount` messages (ids
   * cid(1)…) were accepted from `a` in the current window: cid(1) replays, the
   * remaining window allowance is accepted with the next seqs, then one more
   * send is rate limited.
   */
  function expectChatStateKept(a: MockWs, observer: MockWs, priorCount: number): void {
    const held = session.chat.history().find((m) => m.clientMessageId === cid(1))!;
    clearSent(a, observer);
    sendChat(a, 1);
    expect(added(a)).toEqual([held]);
    expect(observer.sentMessages).toHaveLength(0);

    const allowance = CHAT_RATE_LIMIT_COUNT - priorCount;
    for (let i = 0; i <= allowance; i++) sendChat(a, 10 + i);
    const expectedSeqs = Array.from({ length: allowance }, (_, i) => priorCount + 1 + i);
    expect(added(observer).map((m) => m.seq)).toEqual(expectedSeqs);
    expect(rejected(a).map((r) => r.code)).toEqual(['CHAT_RATE_LIMITED']);
  }

  type Room = { mod: MockWs; a: MockWs; b: MockWs };

  function startStory(room: Room): void {
    emitEvent(room.mod, 'story:submit', { storyDescription: 'Story' });
  }

  function reveal(room: Room): void {
    startStory(room);
    emitEvent(room.a, 'card:select', { cardValue: 5 });
    emitEvent(room.mod, 'cards:reveal', {});
  }

  function firstIssueId(): string {
    return session.getIssueList()[0].id;
  }

  const operations: [string, string, (room: Room) => void, (room: Room) => void][] = [
    ['history:clear', 'history:cleared', () => undefined, (r) => emitEvent(r.mod, 'history:clear', {})],
    ['board:clear', 'board:cleared', startStory, (r) => emitEvent(r.mod, 'board:clear', {})],
    ['story:submit', 'round:started', () => undefined, startStory],
    [
      'cards:reveal',
      'cards:revealed',
      (r) => {
        startStory(r);
        emitEvent(r.a, 'card:select', { cardValue: 5 });
      },
      (r) => emitEvent(r.mod, 'cards:reveal', {}),
    ],
    ['round:revote', 'round:started', reveal, (r) => emitEvent(r.mod, 'round:revote', {})],
    [
      'issue:select',
      'round:started',
      (r) => emitEvent(r.mod, 'issue:add', { titles: ['First', 'Second'] }),
      (r) => emitEvent(r.mod, 'issue:select', { issueId: firstIssueId() }),
    ],
    [
      'participant:remove',
      'participant:left',
      () => undefined,
      (r) => emitEvent(r.mod, 'participant:remove', { userId: bob.id }),
    ],
  ];

  it.each(operations)(
    '%s leaves the buffer, seq, dedup and rate limiter unchanged and sends no chat event',
    (_event, broadcast, setup, action) => {
      const room: Room = { mod: connect(moderator), a: connect(alice), b: connect(bob) };
      sendChat(room.a, 1);
      sendChat(room.a, 2);
      const before = historyJson();
      setup(room);
      clearSent(room.mod, room.a, room.b);

      action(room);

      expect(eventsOf(room.a)).toContain(broadcast);
      for (const ws of [room.mod, room.a, room.b]) {
        expect(errors(ws)).toEqual([]);
        expect(chatFrames(ws)).toEqual([]);
      }
      expect(historyJson()).toBe(before);

      expectChatStateKept(room.a, room.mod, 2);

      const c = connect(carol);
      expect((frames(c)[2].data.messages as ChatMessage[]).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    }
  );
});

// --- Exceptions during chat handling (R20.7) ----------------------------------

describe('an exception while handling a chat send (R20.7)', () => {
  it('leaves all state unchanged, keeps the socket open, sends nothing and logs the error name only', () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const mod = connect(moderator);
    const a = connect(alice);
    const b = connect(bob);
    for (let n = 1; n <= CHAT_RATE_LIMIT_COUNT - 1; n++) sendChat(a, n);

    now = START + 1000;
    const historyBefore = historyJson();
    const stateBefore = JSON.stringify(session.getSessionState());
    const activityBefore = session.lastActivityAt;
    clearSent(mod, a, b);

    // ChatRoom's default idFactory is crypto.randomUUID; make exactly one call throw.
    const uuid = jest.spyOn(crypto, 'randomUUID').mockImplementationOnce(() => {
      throw new TypeError('boom');
    });
    sendChat(a, CHAT_RATE_LIMIT_COUNT, 'secret words');

    expect(uuid).toHaveBeenCalledTimes(1);
    expect(mod.sentMessages).toHaveLength(0);
    expect(a.sentMessages).toHaveLength(0);
    expect(b.sentMessages).toHaveLength(0);
    expect(a.close).not.toHaveBeenCalled();
    expect(a.readyState).toBe(WebSocket.OPEN);
    expect(historyJson()).toBe(historyBefore);
    expect(JSON.stringify(session.getSessionState())).toBe(stateBefore);
    expect(session.lastActivityAt).toBe(activityBefore);
    expect(errorLog.mock.calls).toEqual([
      [`chat poker session=${sessionId} event=${CHAT_MESSAGE_SEND} error=TypeError`],
    ]);

    // Dedup, seq and rate limiter were not touched: the same id is accepted as
    // seq 5 (the 5th counted send), and only the next send hits the limit.
    sendChat(a, CHAT_RATE_LIMIT_COUNT, 'secret words');
    expect(added(mod).map((m) => [m.seq, m.clientMessageId])).toEqual([[5, cid(5)]]);
    expect(session.lastActivityAt).toBe(new Date(now).toISOString());
    sendChat(a, 6);
    expect(rejected(a).map((r) => r.code)).toEqual(['CHAT_RATE_LIMITED']);

    // Later events on every connection are still handled.
    sendChat(b, 100);
    emitEvent(mod, 'story:submit', { storyDescription: 'Still works' });
    expect(added(a).map((m) => [m.seq, m.authorId])).toEqual([
      [5, alice.id],
      [6, bob.id],
    ]);
    expect(eventsOf(b)).toContain('round:started');
    expect(errorLog).toHaveBeenCalledTimes(1);
  });
});
