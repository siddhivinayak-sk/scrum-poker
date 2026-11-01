import crypto from 'crypto';
import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { handleRetroWebSocket, _resetRetroHandler } from '../retro-handler';
import { CHAT_REJECTION_MESSAGES } from '../chat-send';
import * as authService from '../../services/auth-service';
import { retroSessionRegistry } from '../../services/retro-session-registry';
import { RetroSession } from '../../services/retro-session';
import {
  User,
  WebSocketMessage,
  RetroConfiguration,
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
 * Unit tests for the Retro_Chat_Handler (task 3.8): the `retro:chat:message:send`
 * case of `handleRetroEvent`, `handleChatSend` and the `retro:chat:history`
 * frame sent on connect.
 *
 * Time is controlled by stubbing `Date.now` *before* each session is created:
 * `ChatRoom` captures `Date.now` as its default clock at construction, so the
 * stub drives `sentAt`, the rate limiter and `lastActivityAt` with no real
 * waiting. The throwing-`idFactory` case spies on `crypto.randomUUID`, which is
 * the default `ChatRoom` id factory, for exactly one call.
 *
 * **Validates: Requirements 22.8, 1.13, 15.4, 15.7, 18.5, 18.9, 20.7**
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

function createRetroRequest(token: string, sessionId: string): IncomingMessage {
  return {
    url: `/retro?token=${token}&sessionId=${sessionId}`,
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
    .filter((m) => m.event === RETRO_CHAT_MESSAGE_ADDED)
    .map((m) => m.data.message as ChatMessage);
}

function rejected(ws: MockWs): ChatMessageRejectedPayload[] {
  return frames(ws)
    .filter((m) => m.event === RETRO_CHAT_MESSAGE_REJECTED)
    .map((m) => m.data as ChatMessageRejectedPayload);
}

function retroErrors(ws: MockWs): { code: string; message: string }[] {
  return frames(ws)
    .filter((m) => m.event === 'retro:error')
    .map((m) => m.data as { code: string; message: string });
}

/** Chat frames of any kind (added, rejected, history). */
function chatFrames(ws: MockWs): WebSocketMessage[] {
  return frames(ws).filter((m) =>
    [RETRO_CHAT_MESSAGE_ADDED, RETRO_CHAT_MESSAGE_REJECTED, RETRO_CHAT_HISTORY].includes(m.event)
  );
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

const retroConfig: RetroConfiguration = {
  boardName: 'Chat Retro',
  maxVotesPerUser: 6,
  templateId: 'went-well-improve-actions',
  hideCardsInitially: false,
  disableVotingInitially: false,
  hideVoteCount: false,
  oneVotePerCard: false,
  showCardAuthor: false,
  password: null,
  enableGifEmoji: true,
  columnLayout: 'vertical',
  allowedFeelings: ['Happy', 'Sad', 'No_Feeling'],
};

const moderator: User = { id: 'mod-1', displayName: 'Moderator', role: 'moderator', isAnonymous: false };
const alice: User = { id: 'user-a', displayName: 'Alice', role: 'participant', isAnonymous: false };
const bob: User = { id: 'user-b', displayName: 'Bob', role: 'participant', isAnonymous: false };
const carol: User = { id: 'user-c', displayName: 'Carol', role: 'participant', isAnonymous: false };

const START = 1_700_000_000_000;

let now: number;
let sessionId: string;
let session: RetroSession;

function connect(u: User, sid: string = sessionId): MockWs {
  jest.spyOn(authService, 'validateToken').mockReturnValueOnce(u);
  const ws = createMockWs();
  handleRetroWebSocket(ws, createRetroRequest(`token-${u.id}`, sid));
  return ws;
}

function sendChat(ws: MockWs, n: number, text: string = `message ${n}`): void {
  emitEvent(ws, RETRO_CHAT_MESSAGE_SEND, { sessionId, clientMessageId: cid(n), text });
}

function rejection(clientMessageId: string, code: ChatRejection): ChatMessageRejectedPayload {
  return { clientMessageId, code, message: CHAT_REJECTION_MESSAGES[code] };
}

function historyJson(): string {
  return JSON.stringify(session.chat.history());
}

beforeEach(() => {
  jest.restoreAllMocks();
  _resetRetroHandler();
  retroSessionRegistry._reset();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  now = START;
  // Installed before createSession so ChatRoom captures the stub as its clock.
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  sessionId = retroSessionRegistry.createSession(moderator.id, retroConfig).sessionId;
  session = retroSessionRegistry.getSession(sessionId)!;
});

afterEach(() => {
  _resetRetroHandler();
  retroSessionRegistry._reset();
  jest.restoreAllMocks();
});

// --- retro:chat:history on connect (R18.5) -------------------------------------

describe('retro:chat:history on connect (R18.5)', () => {
  it('is sent last, after retro:session:state and retro:participant:joined, and is empty for a new session', () => {
    const ws = connect(moderator);

    // Existing frame indexes are unchanged: 0 = state, 1 = joined; history is appended.
    expect(eventsOf(ws)).toEqual(['retro:session:state', 'retro:participant:joined', RETRO_CHAT_HISTORY]);
    expect(frames(ws)[2].data).toEqual({ messages: [] });
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('goes to the new socket only; existing sockets just get the join broadcast', () => {
    const mod = connect(moderator);
    clearSent(mod);
    const a = connect(alice);

    expect(eventsOf(a)).toEqual(['retro:session:state', 'retro:participant:joined', RETRO_CHAT_HISTORY]);
    expect(eventsOf(mod)).toEqual(['retro:participant:joined']);
  });

  it('holds every buffered message in ascending seq order, before any later added event', () => {
    const mod = connect(moderator);
    sendChat(mod, 1);
    sendChat(mod, 2);
    sendChat(mod, 3);

    const b = connect(bob);
    const history = frames(b)[2];
    expect(history.event).toBe(RETRO_CHAT_HISTORY);
    expect(history.data.messages).toEqual(session.chat.history());
    expect((history.data.messages as ChatMessage[]).map((m) => m.seq)).toEqual([1, 2, 3]);

    sendChat(mod, 4);
    const events = eventsOf(b);
    expect(events.indexOf(RETRO_CHAT_HISTORY)).toBeLessThan(events.indexOf(RETRO_CHAT_MESSAGE_ADDED));
    expect(added(b).map((m) => m.seq)).toEqual([4]);
  });
});

// --- Accepted send (R22.8) ---------------------------------------------------

describe('accepted send', () => {
  it('broadcasts one identical frame to every socket of the session, the sender and every tab included', () => {
    const mod = connect(moderator);
    const a1 = connect(alice);
    const a2 = connect(alice);
    const b = connect(bob);
    const otherSessionId = retroSessionRegistry.createSession('owner-2', retroConfig).sessionId;
    const outsider = connect(carol, otherSessionId);
    clearSent(mod, a1, a2, b, outsider);

    // Author fields in the payload are ignored; the author is the connection's identity (R15.1).
    emitEvent(a1, RETRO_CHAT_MESSAGE_SEND, {
      sessionId,
      clientMessageId: cid(1),
      text: '  hi there \r\n',
      authorId: 'spoofed',
      authorName: 'Mallory',
    });

    const sockets = [mod, a1, a2, b];
    for (const ws of sockets) {
      expect(eventsOf(ws)).toEqual([RETRO_CHAT_MESSAGE_ADDED]);
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

    expect(outsider.sentMessages).toHaveLength(0);
    expect(retroSessionRegistry.getSession(otherSessionId)!.chat.history()).toEqual([]);
  });

  it('answers a resend of a held clientMessageId with the stored message to the sender only (replay)', () => {
    const a = connect(alice);
    const b = connect(bob);
    sendChat(a, 1, 'first');
    const stored = session.chat.history()[0];
    clearSent(a, b);

    sendChat(a, 1, 'different text');

    expect(added(a)).toEqual([stored]);
    expect(b.sentMessages).toHaveLength(0);
    expect(session.chat.history()).toEqual([stored]);
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
    '%s: rejected to the sender only, leaving seq, dedup and rate limiter unchanged',
    (code, payload, echoedId) => {
      const mod = connect(moderator);
      const a = connect(alice);
      const b = connect(bob);
      clearSent(mod, a, b);

      // More rejections than the rate limit allows accepts.
      for (let i = 0; i <= CHAT_RATE_LIMIT_COUNT; i++) {
        emitEvent(a, RETRO_CHAT_MESSAGE_SEND, payload());
      }

      const replies = rejected(a);
      expect(replies).toHaveLength(CHAT_RATE_LIMIT_COUNT + 1);
      for (const reply of replies) {
        expect(reply).toEqual(rejection(echoedId, code));
        expect(reply).not.toHaveProperty('retryAfterMs');
      }
      expect(eventsOf(a).every((e) => e === RETRO_CHAT_MESSAGE_REJECTED)).toBe(true);
      expect(mod.sentMessages).toHaveLength(0);
      expect(b.sentMessages).toHaveLength(0);
      expect(session.chat.history()).toEqual([]);
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
    clearSent(mod, a, b);

    now = START + 1200;
    sendChat(a, 6);

    expect(rejected(a)).toEqual([
      { ...rejection(cid(6), 'CHAT_RATE_LIMITED'), retryAfterMs: CHAT_RATE_LIMIT_WINDOW_MS - 1200 },
    ]);
    expect(eventsOf(a)).toEqual([RETRO_CHAT_MESSAGE_REJECTED]);
    expect(mod.sentMessages).toHaveLength(0);
    expect(b.sentMessages).toHaveLength(0);
    expect(session.chat.history()).toHaveLength(CHAT_RATE_LIMIT_COUNT);

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
    expect(eventsOf(a)).toEqual([RETRO_CHAT_MESSAGE_REJECTED]);
    expect(mod.sentMessages).toHaveLength(0);
    expect(b.sentMessages).toHaveLength(0);
    expect(historyJson()).toBe(before);

    // With Alice rate limited, the duplicate check (5) still answers first (R14.11).
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

    emitEvent(a, RETRO_CHAT_MESSAGE_SEND, payload());

    expect(rejected(a).map((r) => r.code)).toEqual([code]);
    expect(eventsOf(a)).toEqual([RETRO_CHAT_MESSAGE_REJECTED]);
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
    ['a null', (ws) => emitEvent(ws, RETRO_CHAT_MESSAGE_SEND, null)],
    ['a missing', (ws) => emitEventWithoutData(ws, RETRO_CHAT_MESSAGE_SEND)],
    ['an array', (ws) => emitEvent(ws, RETRO_CHAT_MESSAGE_SEND, [sessionId, cid(1), 'hi'])],
    ['a string', (ws) => emitEvent(ws, RETRO_CHAT_MESSAGE_SEND, 'hi')],
    ['a number', (ws) => emitEvent(ws, RETRO_CHAT_MESSAGE_SEND, 7)],
  ])('%s payload is answered with CHAT_INVALID and an empty clientMessageId', (_label, send) => {
    const a = connect(alice);
    const b = connect(bob);
    clearSent(a, b);

    send(a);

    expect(rejected(a)).toEqual([rejection('', 'CHAT_INVALID')]);
    expect(eventsOf(a)).toEqual([RETRO_CHAT_MESSAGE_REJECTED]);
    expect(b.sentMessages).toHaveLength(0);
    expect(session.chat.history()).toEqual([]);
    expect(a.close).not.toHaveBeenCalled();
  });
});

// --- Missing session (R15.4) -------------------------------------------------

describe('session no longer in the registry (R15.4)', () => {
  it('sends retro:error NOT_FOUND, then closes with 4004, storing and broadcasting nothing', () => {
    const mod = connect(moderator);
    const a = connect(alice);
    const removed = session;
    expect(retroSessionRegistry.removeSession(sessionId)).toBe(true);
    clearSent(mod, a);

    sendChat(a, 1);

    expect(frames(a)).toEqual([
      expect.objectContaining({ event: 'retro:error', data: { message: 'Session not found', code: 'NOT_FOUND' } }),
    ]);
    expect(a.close).toHaveBeenCalledWith(4004, 'Session not found');
    expect(a.ops).toEqual(['send:retro:error', 'close:4004']);
    expect(mod.sentMessages).toHaveLength(0);
    expect(removed.chat.history()).toEqual([]);
    expect(retroSessionRegistry.hasSession(sessionId)).toBe(false);
  });
});

// --- Poker chat names on a retro connection (R15.7) ---------------------------

describe('poker chat event names (R15.7)', () => {
  it.each([CHAT_MESSAGE_SEND, CHAT_MESSAGE_ADDED, CHAT_MESSAGE_REJECTED, CHAT_HISTORY])(
    '%s → UNKNOWN_EVENT, connection open, chat unchanged',
    (event) => {
      const a = connect(alice);
      const b = connect(bob);
      clearSent(a, b);

      emitEvent(a, event, { sessionId, clientMessageId: cid(1), text: 'hi' });

      expect(retroErrors(a).map((e) => e.code)).toEqual(['UNKNOWN_EVENT']);
      expect(chatFrames(a)).toEqual([]);
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

// --- Connections no longer registered (R15.12) --------------------------------

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

    sendChat(a2, 1);
    expect(added(mod).map((m) => [m.seq, m.clientMessageId])).toEqual([[1, cid(1)]]);
    expect(added(a2)).toHaveLength(1);
    expect(a1.sentMessages).toHaveLength(0);
  });

  it("keeps a participant's messages after they leave and sends them nothing later", () => {
    const mod = connect(moderator);
    const a = connect(alice);
    const b = connect(bob);
    sendChat(b, 1, 'from bob');

    b.emit('close');
    expect(session.getParticipants().some((p) => p.id === bob.id)).toBe(false);
    clearSent(mod, a, b);

    sendChat(a, 2, 'from alice');
    expect(b.sentMessages).toHaveLength(0);
    expect(added(mod).map((m) => m.authorId)).toEqual([alice.id]);

    // The stale socket's sends are dropped too.
    sendChat(b, 3);
    expect(b.sentMessages).toHaveLength(0);

    const history = session.chat.history();
    expect(history.map((m) => [m.authorName, m.text])).toEqual([
      ['Bob', 'from bob'],
      ['Alice', 'from alice'],
    ]);
    const c = connect(carol);
    expect(frames(c)[2].data.messages).toEqual(history);
  });
});

// --- Board operations leave chat unchanged (R1.13, R18.9) ---------------------

describe('board operations leave chat unchanged (R1.13, R18.9)', () => {
  /**
   * Seq, dedup and rate-limiter state survive. `priorCount` messages (ids
   * cid(1)…) were accepted from `a` in the current window: cid(1) replays, the
   * remaining window allowance is accepted with the next seqs, then one more
   * send is rate limited.
   */
  function expectChatStateKept(a: MockWs, b: MockWs, priorCount: number): void {
    const held = session.chat.history().find((m) => m.clientMessageId === cid(1))!;
    clearSent(a, b);
    sendChat(a, 1);
    expect(added(a)).toEqual([held]);
    expect(b.sentMessages).toHaveLength(0);

    const allowance = CHAT_RATE_LIMIT_COUNT - priorCount;
    for (let i = 0; i <= allowance; i++) sendChat(a, 10 + i);
    const expectedSeqs = Array.from({ length: allowance }, (_, i) => priorCount + 1 + i);
    expect(added(b).map((m) => m.seq)).toEqual(expectedSeqs);
    expect(rejected(a).map((r) => r.code)).toEqual(['CHAT_RATE_LIMITED']);
  }

  it.each([
    ['retro:cards:reveal', 'retro:cards:revealed'],
    ['retro:voting:enable', 'retro:voting:enabled'],
    ['retro:board:complete', 'retro:board:completed'],
  ])('%s leaves the buffer, seq, dedup and rate limiter unchanged', (event, broadcast) => {
    const mod = connect(moderator);
    const a = connect(alice);
    sendChat(a, 1);
    sendChat(a, 2);
    const before = historyJson();
    clearSent(mod, a);

    emitEvent(mod, event, {});

    expect(eventsOf(a)).toEqual([broadcast]);
    expect(retroErrors(mod)).toEqual([]);
    expect(chatFrames(mod)).toEqual([]);
    expect(historyJson()).toBe(before);

    expectChatStateKept(a, mod, 2);

    const c = connect(carol);
    expect((frames(c)[2].data.messages as ChatMessage[]).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('card, comment, column, context, config, feeling and role events leave chat unchanged', () => {
    const mod = connect(moderator);
    const a = connect(alice);
    sendChat(a, 1);
    sendChat(a, 2);
    const before = historyJson();
    const [col0, col1] = session.getSessionState().board.columns;
    clearSent(mod, a);

    emitEvent(a, 'retro:card:add', { columnId: col0.id, text: 'A card' });
    const cardId = session.getSessionState().board.columns[0].cards[0].id;
    emitEvent(a, 'retro:card:edit', { cardId, text: 'Edited card' });
    emitEvent(a, 'retro:card:vote', { cardId });
    emitEvent(a, 'retro:card:unvote', { cardId });
    emitEvent(a, 'retro:comment:add', { cardId, text: 'A comment' });
    emitEvent(a, 'retro:card:move', { cardId, targetColumnId: col1.id, targetIndex: 0 });
    emitEvent(mod, 'retro:column:add', { name: 'Extra' });
    emitEvent(mod, 'retro:column:rename', { columnId: col0.id, name: 'Renamed' });
    emitEvent(mod, 'retro:context:update', { text: 'Sprint 12' });
    emitEvent(mod, 'retro:config:update', { config: { boardName: 'Renamed board' } });
    emitEvent(a, 'retro:feeling:select', { category: 'Happy' });
    emitEvent(a, 'role:change', { role: 'participant' });
    emitEvent(a, 'retro:card:remove', { cardId });

    expect(retroErrors(a)).toEqual([]);
    expect(retroErrors(mod)).toEqual([]);
    expect(chatFrames(a)).toEqual([]);
    expect(chatFrames(mod)).toEqual([]);
    expect(historyJson()).toBe(before);

    expectChatStateKept(a, mod, 2);
  });

  it('accepts sends after retro:board:complete under the same checks', () => {
    const mod = connect(moderator);
    const a = connect(alice);
    emitEvent(mod, 'retro:board:complete', {});
    clearSent(mod, a);

    // The board really is complete: board edits are refused.
    emitEvent(a, 'retro:card:add', { columnId: session.getSessionState().board.columns[0].id, text: 'late' });
    expect(retroErrors(a).map((e) => e.code)).toEqual(['BOARD_COMPLETED']);
    clearSent(mod, a);

    sendChat(a, 1, 'after completion');
    expect(added(mod).map((m) => [m.seq, m.authorId, m.text])).toEqual([[1, alice.id, 'after completion']]);
    expect(added(a)).toHaveLength(1);

    emitEvent(a, RETRO_CHAT_MESSAGE_SEND, { sessionId, clientMessageId: cid(2), text: '  ' });
    expect(rejected(a)).toEqual([rejection(cid(2), 'CHAT_EMPTY')]);

    expectChatStateKept(a, mod, 1);
    expect(retroErrors(a)).toEqual([]);

    const b = connect(bob);
    expect((frames(b)[2].data.messages as ChatMessage[]).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
  });
});

// --- Exceptions during chat handling (R20.7) ----------------------------------

describe('an exception while handling a chat send (R20.7)', () => {
  it('leaves all state unchanged, keeps the socket open, sends nothing (no retro:error) and logs the error name only', () => {
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
    expect(historyJson()).toBe(historyBefore);
    expect(JSON.stringify(session.getSessionState())).toBe(stateBefore);
    expect(session.lastActivityAt).toBe(activityBefore);
    expect(errorLog.mock.calls).toEqual([
      [`chat retro session=${sessionId} event=${RETRO_CHAT_MESSAGE_SEND} error=TypeError`],
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
    expect(added(a).map((m) => [m.seq, m.authorId])).toEqual([
      [5, alice.id],
      [6, bob.id],
    ]);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });
});
