import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import * as fc from 'fast-check';
import {
  handleRetroWebSocket,
  endRetroSession,
  getRetroSessionClients,
  _resetRetroHandler,
  RETRO_SESSION_ENDED,
} from '../retro-handler';
import * as authService from '../../services/auth-service';
import { retroSessionRegistry } from '../../services/retro-session-registry';
import { User, WebSocketMessage, RetroConfiguration } from '../../../../shared/types';

// --- Mock socket that records the *order* of send and close calls ---

/** One observable socket operation, appended to a log shared by all sockets. */
interface SocketCall {
  kind: 'send' | 'close';
  socket: string;
  event?: string;
  code?: number;
}

type MockWs = WebSocket & {
  id: string;
  sentMessages: string[];
  /** Per-socket slice of the shared log, in call order. */
  calls: SocketCall[];
};

/**
 * A socket whose `close` flips `readyState` to CLOSED, exactly as the real one
 * does. That is what makes broadcast-before-close observable: a send attempted
 * after the close is dropped by the handler's readyState guard, so a closed-first
 * implementation would produce no retro:session:ended message at all.
 */
function createMockWs(id: string, log: SocketCall[]): MockWs {
  const emitter = new EventEmitter();
  const mock = emitter as any;
  mock.id = id;
  mock.readyState = WebSocket.OPEN;
  mock.sentMessages = [];
  mock.calls = [];

  mock.send = jest.fn((data: string) => {
    mock.sentMessages.push(data);
    const parsed = JSON.parse(data) as WebSocketMessage;
    const call: SocketCall = { kind: 'send', socket: id, event: parsed.event };
    mock.calls.push(call);
    log.push(call);
  });

  mock.close = jest.fn((code?: number) => {
    const call: SocketCall = { kind: 'close', socket: id, code: code ?? 1000 };
    mock.calls.push(call);
    log.push(call);
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

function clientMessage(event: string, data: unknown): Buffer {
  return Buffer.from(JSON.stringify({ event, data, timestamp: new Date().toISOString() }));
}

function parsedMessages(ws: MockWs): WebSocketMessage[] {
  return ws.sentMessages.map((raw) => JSON.parse(raw) as WebSocketMessage);
}

const defaultRetroConfig: RetroConfiguration = {
  boardName: 'Ended Session Retro',
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

function user(id: string, displayName: string, role: 'moderator' | 'participant'): User {
  return { id, displayName, role, isAnonymous: false };
}

const moderatorUser = user('mod-1', 'Moderator', 'moderator');

/**
 * Connect a mock socket for `u` to `sessionId`, stubbing token validation for
 * that single call.
 */
function connect(u: User, sessionId: string, id: string, log: SocketCall[]): MockWs {
  jest.spyOn(authService, 'validateToken').mockReturnValueOnce(u);
  const ws = createMockWs(id, log);
  handleRetroWebSocket(ws, createRetroRequest(`token-${u.id}`, sessionId));
  return ws;
}

/** Deep snapshot of the named sessions, or `null` for ids the registry lacks. */
function snapshotSessions(ids: string[]): string {
  return JSON.stringify(
    ids.map((id) => {
      const session = retroSessionRegistry.getSession(id);
      return [id, session ? session.getSessionState() : null];
    })
  );
}

// ---------------------------------------------------------------------------
// Broadcast-then-close ordering
//
// **Validates: Requirements 9.8**
// ---------------------------------------------------------------------------

describe('endRetroSession broadcasts before closing (R9.8)', () => {
  let log: SocketCall[];
  let sessionId: string;

  beforeEach(() => {
    _resetRetroHandler();
    retroSessionRegistry._reset();
    jest.restoreAllMocks();
    log = [];
    sessionId = retroSessionRegistry.createSession(moderatorUser.id, defaultRetroConfig)
      .sessionId;
  });

  afterEach(() => {
    _resetRetroHandler();
    retroSessionRegistry._reset();
  });

  it('delivers retro:session:ended to every socket before that socket is closed', () => {
    const alice = user('user-a', 'Alice', 'participant');
    const bob = user('user-b', 'Bob', 'participant');

    const sockets: MockWs[] = [
      connect(moderatorUser, sessionId, 'mod', log),
      connect(alice, sessionId, 'alice-1', log),
      // Same user, second tab: both sockets must be told and both closed.
      connect(alice, sessionId, 'alice-2', log),
      connect(bob, sessionId, 'bob', log),
    ];

    endRetroSession(sessionId);

    for (const ws of sockets) {
      const sendIndex = ws.calls.findIndex(
        (c) => c.kind === 'send' && c.event === RETRO_SESSION_ENDED
      );
      const closeIndex = ws.calls.findIndex((c) => c.kind === 'close');

      // The event arrived...
      expect(sendIndex).toBeGreaterThanOrEqual(0);
      // ...the socket was closed...
      expect(closeIndex).toBeGreaterThanOrEqual(0);
      // ...and in that order, on this very socket.
      expect(sendIndex).toBeLessThan(closeIndex);

      expect(ws.close).toHaveBeenCalledWith(1000, 'Session ended by moderator');
    }

    // Globally too: no socket is closed until the broadcast has finished.
    const lastEnded = log.map((c) => c.event === RETRO_SESSION_ENDED).lastIndexOf(true);
    const firstClose = log.findIndex((c) => c.kind === 'close');
    expect(lastEnded).toBeLessThan(firstClose);

    // Exactly one ended event per socket.
    expect(log.filter((c) => c.event === RETRO_SESSION_ENDED)).toHaveLength(sockets.length);
  });

  it('carries the session id in the ended payload', () => {
    const ws = connect(moderatorUser, sessionId, 'mod', log);

    endRetroSession(sessionId);

    const ended = parsedMessages(ws).find((m) => m.event === RETRO_SESSION_ENDED);
    expect(ended).toBeDefined();
    expect(ended!.data).toEqual({ sessionId });
  });

  it('drops the session client map entry and leaves other sessions connected', () => {
    const otherSessionId = retroSessionRegistry.createSession(
      moderatorUser.id,
      defaultRetroConfig
    ).sessionId;

    connect(moderatorUser, sessionId, 'mod-target', log);
    const bystander = connect(moderatorUser, otherSessionId, 'mod-bystander', log);

    endRetroSession(sessionId);

    expect(getRetroSessionClients().has(sessionId)).toBe(false);
    expect(getRetroSessionClients().has(otherSessionId)).toBe(true);
    expect(bystander.close).not.toHaveBeenCalled();
    expect(
      parsedMessages(bystander).some((m) => m.event === RETRO_SESSION_ENDED)
    ).toBe(false);
  });

  it('is a no-op for a session that has no connected sockets', () => {
    expect(() => endRetroSession('never-connected')).not.toThrow();
    expect(log).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Property 22: late retro WebSocket messages change nothing
//
// **Validates: Requirements 9.14**
// ---------------------------------------------------------------------------

/** Every event name the handler routes in `handleRetroEvent`. */
const ROUTED_EVENT_NAMES = [
  'retro:card:add',
  'retro:card:edit',
  'retro:card:remove',
  'retro:card:move',
  'retro:card:vote',
  'retro:card:unvote',
  'retro:card:merge',
  'retro:comment:add',
  'retro:comment:remove',
  'retro:column:add',
  'retro:column:remove',
  'retro:column:reorder',
  'retro:column:rename',
  'retro:context:update',
  'retro:cards:reveal',
  'retro:voting:enable',
  'retro:board:complete',
  'retro:config:update',
  'retro:feeling:select',
  'role:change',
];

const eventNameArb = fc.oneof(
  fc.constantFrom(...ROUTED_EVENT_NAMES),
  fc.string({ minLength: 1, maxLength: 40 })
);

const payloadArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.object({ maxDepth: 2 }),
  fc.record({
    cardId: fc.string(),
    columnId: fc.string(),
    text: fc.string(),
    targetIndex: fc.integer(),
  }),
  fc.anything({ maxDepth: 2 })
);

describe('Property 22: late retro WebSocket messages change nothing (R9.14)', () => {
  beforeEach(() => {
    _resetRetroHandler();
    retroSessionRegistry._reset();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    _resetRetroHandler();
    retroSessionRegistry._reset();
  });

  it('closes the socket with 4004 and mutates no session state', () => {
    fc.assert(
      fc.property(eventNameArb, payloadArb, (event, payload) => {
        _resetRetroHandler();
        retroSessionRegistry._reset();

        // A session the caller connected to, plus a bystander session that must
        // survive the late message untouched.
        const targetId = retroSessionRegistry.createSession(
          moderatorUser.id,
          defaultRetroConfig
        ).sessionId;
        const bystanderId = retroSessionRegistry.createSession(
          'owner-2',
          defaultRetroConfig
        ).sessionId;

        const log: SocketCall[] = [];
        const ws = connect(moderatorUser, targetId, 'late-sender', log);

        // The moderator ends the session: the registry no longer holds it.
        expect(retroSessionRegistry.removeSession(targetId)).toBe(true);

        const before = snapshotSessions([targetId, bystanderId]);
        const countBefore = retroSessionRegistry.getSessionCount();
        const sentBefore = ws.sentMessages.length;

        ws.emit('message', clientMessage(event, payload));

        // No RetroSession was created or mutated.
        expect(snapshotSessions([targetId, bystanderId])).toBe(before);
        expect(retroSessionRegistry.getSessionCount()).toBe(countBefore);
        expect(retroSessionRegistry.hasSession(targetId)).toBe(false);

        // The connection was told and then closed.
        const replies = ws.sentMessages
          .slice(sentBefore)
          .map((raw) => JSON.parse(raw) as WebSocketMessage);
        const error = replies.find((m) => m.event === 'retro:error');
        expect(error).toBeDefined();
        expect(error!.data.code).toBe('NOT_FOUND');

        expect(ws.close).toHaveBeenCalledWith(4004, 'Session not found');

        // The error reaches the client before the socket closes.
        const errorIndex = ws.calls.findIndex(
          (c) => c.kind === 'send' && c.event === 'retro:error'
        );
        const closeIndex = ws.calls.findIndex((c) => c.kind === 'close');
        expect(errorIndex).toBeGreaterThanOrEqual(0);
        expect(errorIndex).toBeLessThan(closeIndex);
      }),
      { numRuns: 100 }
    );
  });

  it('applies no change for a sequence of late messages on one socket', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(eventNameArb, payloadArb), { minLength: 1, maxLength: 10 }),
        (messages) => {
          _resetRetroHandler();
          retroSessionRegistry._reset();

          const targetId = retroSessionRegistry.createSession(
            moderatorUser.id,
            defaultRetroConfig
          ).sessionId;
          const bystanderId = retroSessionRegistry.createSession(
            'owner-2',
            defaultRetroConfig
          ).sessionId;

          const log: SocketCall[] = [];
          const ws = connect(moderatorUser, targetId, 'late-sender', log);
          retroSessionRegistry.removeSession(targetId);

          const before = snapshotSessions([targetId, bystanderId]);

          for (const [event, payload] of messages) {
            ws.emit('message', clientMessage(event, payload));
          }

          expect(snapshotSessions([targetId, bystanderId])).toBe(before);
          expect(retroSessionRegistry.getSessionCount()).toBe(1);
          expect(ws.close).toHaveBeenCalledWith(4004, 'Session not found');
        }
      ),
      { numRuns: 100 }
    );
  });
});
