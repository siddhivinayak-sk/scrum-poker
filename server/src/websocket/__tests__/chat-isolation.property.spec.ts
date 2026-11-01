import { IncomingMessage } from 'http';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import * as fc from 'fast-check';
import { handleWebSocket, _reset as resetPokerHandler } from '../handler';
import { handleRetroWebSocket, _resetRetroHandler } from '../retro-handler';
import { CHAT_REJECTION_MESSAGES } from '../chat-send';
import * as authService from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import { retroSessionRegistry } from '../../services/retro-session-registry';
import {
  User,
  WebSocketMessage,
  DEFAULT_SESSION_CONFIG,
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
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_RATE_LIMIT_COUNT,
  CHAT_RATE_LIMIT_WINDOW_MS,
} from '../../../../shared/types';

/**
 * Property 9 — sessions are isolated, driven through both WebSocket handlers.
 *
 * Each run creates two or three poker sessions and two or three retro sessions,
 * connects several users (some to several sessions of both Board_Kinds, some
 * with several tabs in one session) and then plays a generated sequence of
 * connects, disconnects, clock ticks and chat sends with valid and invalid
 * payloads. An independent model of every session's chat (history, per-author
 * dedup record, per-author rate-limit window) predicts the outcome of each send,
 * and every socket's new frames are compared with that prediction after every
 * command.
 *
 * Time is controlled by stubbing `Date.now` before the sessions are created, so
 * each `ChatRoom` captures the stub as its clock.
 *
 * **Validates: Requirements 15.10, 15.5**
 */

// --- Mock socket --------------------------------------------------------------

type MockWs = WebSocket & { sentMessages: string[] };

function createMockWs(): MockWs {
  const emitter = new EventEmitter();
  const mock = emitter as any;
  mock.readyState = WebSocket.OPEN;
  mock.sentMessages = [];
  mock.send = jest.fn((data: string) => {
    mock.sentMessages.push(data);
  });
  mock.close = jest.fn(() => {
    mock.readyState = WebSocket.CLOSED;
  });
  return mock as MockWs;
}

function emitEvent(ws: MockWs, event: string, data: unknown): void {
  ws.emit('message', Buffer.from(JSON.stringify({ event, data, timestamp: new Date().toISOString() })));
}

function parse(raw: string): WebSocketMessage {
  return JSON.parse(raw) as WebSocketMessage;
}

/** Deterministic canonical v4 UUID for Client_Message_Ids. */
function cid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

// --- Fixtures -----------------------------------------------------------------

type Kind = 'poker' | 'retro';

const EVENTS: Record<
  Kind,
  { send: string; added: string; rejected: string; history: string; error: string; state: string; joined: string }
> = {
  poker: {
    send: CHAT_MESSAGE_SEND,
    added: CHAT_MESSAGE_ADDED,
    rejected: CHAT_MESSAGE_REJECTED,
    history: CHAT_HISTORY,
    error: 'error',
    state: 'session:state',
    joined: 'participant:joined',
  },
  retro: {
    send: RETRO_CHAT_MESSAGE_SEND,
    added: RETRO_CHAT_MESSAGE_ADDED,
    rejected: RETRO_CHAT_MESSAGE_REJECTED,
    history: RETRO_CHAT_HISTORY,
    error: 'retro:error',
    state: 'retro:session:state',
    joined: 'retro:participant:joined',
  },
};

const OTHER_KIND: Record<Kind, Kind> = { poker: 'retro', retro: 'poker' };

const POKER_CHAT_EVENTS = [CHAT_MESSAGE_ADDED, CHAT_MESSAGE_REJECTED, CHAT_HISTORY];
const RETRO_CHAT_EVENTS = [RETRO_CHAT_MESSAGE_ADDED, RETRO_CHAT_MESSAGE_REJECTED, RETRO_CHAT_HISTORY];

const retroConfig: RetroConfiguration = {
  boardName: 'Isolation Retro',
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

const USERS: User[] = [
  { id: 'user-0', displayName: 'Alice', role: 'participant', isAnonymous: false },
  { id: 'user-1', displayName: 'Bob', role: 'participant', isAnonymous: false },
  { id: 'user-2', displayName: 'Carol', role: 'participant', isAnonymous: true },
  { id: 'user-3', displayName: 'Dave', role: 'participant', isAnonymous: false },
];

/** Already-normalised texts, so the stored text equals the sent text. */
const TEXTS = ['hi', 'hello there', 'ok 👍', 'same text', 'line one\nline two'];

const START = 1_700_000_000_000;

let now = START;

// --- Model --------------------------------------------------------------------

interface ModelRoom {
  /** Accepted messages in ascending seq; the buffer never fills within a run. */
  history: ChatMessage[];
  /** `${authorId}|${lower-cased clientMessageId}` → seq. */
  dedup: Map<string, number>;
  /** authorId → acceptance times in ascending order. */
  acceptTimes: Map<string, number[]>;
}

interface Board {
  kind: Kind;
  id: string;
  label: string;
  model: ModelRoom;
}

interface Conn {
  ws: MockWs;
  board: Board;
  user: User;
  open: boolean;
}

type Expected =
  | { kind: 'accepted'; message: Omit<ChatMessage, 'id'> }
  | { kind: 'replay'; message: ChatMessage }
  | { kind: 'rejected'; payload: ChatMessageRejectedPayload }
  | { kind: 'unknown' };

function rejection(clientMessageId: string, code: ChatRejection, retryAfterMs?: number): Expected {
  const payload: ChatMessageRejectedPayload = { clientMessageId, code, message: CHAT_REJECTION_MESSAGES[code] };
  if (retryAfterMs !== undefined) payload.retryAfterMs = retryAfterMs;
  return { kind: 'rejected', payload };
}

/** Steps 5 and 6 of R14.11 on the model, for a payload that passed steps 1 to 4. */
function predictValid(room: ModelRoom, author: User, clientMessageId: string, text: string): Expected {
  const seq = room.dedup.get(`${author.id}|${clientMessageId.toLowerCase()}`);
  if (seq !== undefined) {
    return { kind: 'replay', message: room.history[seq - 1] };
  }
  const inWindow = (room.acceptTimes.get(author.id) ?? []).filter((t) => now - t < CHAT_RATE_LIMIT_WINDOW_MS);
  if (inWindow.length >= CHAT_RATE_LIMIT_COUNT) {
    const retry = Math.min(
      CHAT_RATE_LIMIT_WINDOW_MS,
      Math.max(1, Math.ceil(inWindow[0] + CHAT_RATE_LIMIT_WINDOW_MS - now))
    );
    return rejection(clientMessageId, 'CHAT_RATE_LIMITED', retry);
  }
  return {
    kind: 'accepted',
    message: {
      seq: room.history.length + 1,
      clientMessageId,
      authorId: author.id,
      authorName: author.displayName,
      text,
      sentAt: new Date(now).toISOString(),
    },
  };
}

function commitToModel(room: ModelRoom, message: ChatMessage): void {
  room.history.push(message);
  room.dedup.set(`${message.authorId}|${message.clientMessageId.toLowerCase()}`, message.seq);
  const times = room.acceptTimes.get(message.authorId) ?? [];
  times.push(now);
  room.acceptTimes.set(message.authorId, times);
}

// --- Commands -----------------------------------------------------------------

type SendKind =
  | 'valid'
  | 'otherSession'
  | 'missingSession'
  | 'badId'
  | 'empty'
  | 'tooLong'
  | 'notObject'
  | 'otherKindEvent';

type Command =
  | { type: 'connect'; user: number; board: number }
  | { type: 'disconnect'; pick: number }
  | { type: 'send'; pick: number; kind: SendKind; n: number; text: string; target: number }
  | { type: 'tick'; ms: number };

const sendKindArb: fc.Arbitrary<SendKind> = fc.oneof(
  { weight: 6, arbitrary: fc.constant<SendKind>('valid') },
  {
    weight: 4,
    arbitrary: fc.constantFrom<SendKind>(
      'otherSession',
      'missingSession',
      'badId',
      'empty',
      'tooLong',
      'notObject',
      'otherKindEvent'
    ),
  }
);

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 2,
    arbitrary: fc.record({
      type: fc.constant<'connect'>('connect'),
      user: fc.nat(USERS.length - 1),
      board: fc.nat(5),
    }),
  },
  { weight: 1, arbitrary: fc.record({ type: fc.constant<'disconnect'>('disconnect'), pick: fc.nat(63) }) },
  {
    weight: 7,
    arbitrary: fc.record({
      type: fc.constant<'send'>('send'),
      pick: fc.nat(63),
      kind: sendKindArb,
      // A small id pool makes same-id sends within and across sessions common.
      n: fc.integer({ min: 1, max: 6 }),
      text: fc.constantFrom(...TEXTS),
      target: fc.nat(5),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      type: fc.constant<'tick'>('tick'),
      ms: fc.constantFrom(0, 250, 1500, CHAT_RATE_LIMIT_WINDOW_MS),
    }),
  }
);

const scenarioArb = fc.record({
  pokerCount: fc.integer({ min: 2, max: 3 }),
  retroCount: fc.integer({ min: 2, max: 3 }),
  commands: fc.array(commandArb, { minLength: 1, maxLength: 40 }),
});

// --- Harness ------------------------------------------------------------------

function resetAll(): void {
  resetPokerHandler();
  _resetRetroHandler();
  sessionRegistry._reset();
  retroSessionRegistry._reset();
}

function actualHistory(board: Board): ChatMessage[] {
  const session =
    board.kind === 'poker' ? sessionRegistry.getSession(board.id) : retroSessionRegistry.getSession(board.id);
  return session!.chat.history();
}

class World {
  readonly boards: Board[] = [];
  readonly conns: Conn[] = [];
  /** Every message id accepted in any session, for cross-session uniqueness. */
  readonly seenIds = new Set<string>();

  constructor(pokerCount: number, retroCount: number) {
    for (let i = 0; i < pokerCount; i++) {
      const { sessionId } = sessionRegistry.createSession(`poker-owner-${i}`, DEFAULT_SESSION_CONFIG);
      this.boards.push({ kind: 'poker', id: sessionId, label: `P${i}`, model: newModel() });
    }
    for (let i = 0; i < retroCount; i++) {
      const { sessionId } = retroSessionRegistry.createSession(`retro-owner-${i}`, retroConfig);
      this.boards.push({ kind: 'retro', id: sessionId, label: `R${i}`, model: newModel() });
    }
  }

  run(cmd: Command): void {
    const before = new Map(this.conns.map((c) => [c, c.ws.sentMessages.length]));
    const freshRaw = (c: Conn): string[] => c.ws.sentMessages.slice(before.get(c) ?? 0);
    const newFrames = (c: Conn): WebSocketMessage[] => freshRaw(c).map(parse);

    switch (cmd.type) {
      case 'connect':
        this.connect(USERS[cmd.user], this.boards[cmd.board % this.boards.length], newFrames);
        break;
      case 'disconnect':
        this.disconnect(cmd.pick, newFrames);
        break;
      case 'send':
        this.send(cmd, freshRaw);
        break;
      case 'tick':
        now += cmd.ms;
        for (const c of this.conns) expect(newFrames(c)).toEqual([]);
        break;
    }

    // Each session's buffer holds exactly the messages sent on its own sockets,
    // numbered 1, 2, 3, … independently of every other session.
    for (const board of this.boards) {
      const history = actualHistory(board);
      expect({ board: board.label, history }).toEqual({ board: board.label, history: board.model.history });
      expect(history.map((m) => m.seq)).toEqual(history.map((_, i) => i + 1));
    }
  }

  connect(user: User, board: Board, newFrames: (c: Conn) => WebSocketMessage[]): void {
    jest.spyOn(authService, 'validateToken').mockReturnValueOnce(user);
    const ws = createMockWs();
    const url =
      board.kind === 'poker'
        ? `/?token=token-${user.id}&sessionId=${board.id}`
        : `/retro?token=token-${user.id}&sessionId=${board.id}`;
    const request = { url, headers: { host: 'localhost:3000' } } as unknown as IncomingMessage;
    if (board.kind === 'poker') handleWebSocket(ws, request);
    else handleRetroWebSocket(ws, request);

    const conn: Conn = { ws, board, user, open: true };
    expect(ws.close).not.toHaveBeenCalled();

    // The new socket gets its own session's history only.
    const ev = EVENTS[board.kind];
    const received = ws.sentMessages.map(parse);
    expect(received.map((m) => m.event)).toEqual([ev.state, ev.joined, ev.history]);
    expect(received[2].data).toEqual({ messages: board.model.history });

    for (const other of this.conns) {
      const frames = newFrames(other);
      if (other.open && other.board === board) {
        expect(frames.map((m) => m.event)).toEqual([ev.joined]);
      } else {
        expect(frames).toEqual([]);
      }
    }
    this.conns.push(conn);
  }

  disconnect(pick: number, newFrames: (c: Conn) => WebSocketMessage[]): void {
    const open = this.conns.filter((c) => c.open);
    if (open.length === 0) return;
    const target = open[pick % open.length];
    target.open = false;
    (target.ws as any).readyState = WebSocket.CLOSED;
    target.ws.emit('close');

    for (const c of this.conns) {
      const frames = newFrames(c);
      if (c.open && c.board === target.board) {
        // Presence frames only (participant left / feeling cleared); never chat.
        expect(frames.filter((m) => [...POKER_CHAT_EVENTS, ...RETRO_CHAT_EVENTS].includes(m.event))).toEqual([]);
      } else {
        expect(frames).toEqual([]);
      }
    }
  }

  send(
    cmd: Extract<Command, { type: 'send' }>,
    freshRaw: (c: Conn) => string[]
  ): void {
    const newFrames = (c: Conn): WebSocketMessage[] => freshRaw(c).map(parse);
    const open = this.conns.filter((c) => c.open);
    if (open.length === 0) return;
    const sender = open[cmd.pick % open.length];
    const board = sender.board;
    const ev = EVENTS[board.kind];
    const clientMessageId = cid(cmd.n);

    let event = ev.send;
    let data: unknown = { sessionId: board.id, clientMessageId, text: cmd.text };
    let expected: Expected;

    switch (cmd.kind) {
      case 'valid':
        expected = predictValid(board.model, sender.user, clientMessageId, cmd.text);
        break;
      case 'otherSession': {
        // Any other session of either kind, so a poker payload may name a retro
        // session and the other way round.
        const others = this.boards.filter((b) => b !== board);
        const named = others[cmd.target % others.length];
        data = { sessionId: named.id, clientMessageId, text: cmd.text };
        expected = rejection(clientMessageId, 'CHAT_SESSION_MISMATCH');
        break;
      }
      case 'missingSession':
        data = { clientMessageId, text: cmd.text };
        expected = rejection(clientMessageId, 'CHAT_SESSION_MISMATCH');
        break;
      case 'badId':
        data = { sessionId: board.id, clientMessageId: `not-a-uuid-${cmd.n}`, text: cmd.text };
        expected = rejection(`not-a-uuid-${cmd.n}`, 'CHAT_INVALID');
        break;
      case 'empty':
        data = { sessionId: board.id, clientMessageId, text: ' \n\t ' };
        expected = rejection(clientMessageId, 'CHAT_EMPTY');
        break;
      case 'tooLong':
        data = { sessionId: board.id, clientMessageId, text: 'x'.repeat(CHAT_MESSAGE_MAX_LENGTH + 1) };
        expected = rejection(clientMessageId, 'CHAT_TOO_LONG');
        break;
      case 'notObject':
        data = null;
        expected = rejection('', 'CHAT_INVALID');
        break;
      case 'otherKindEvent':
        // The other Board_Kind's send event name with a payload that would be valid.
        event = EVENTS[OTHER_KIND[board.kind]].send;
        expected = { kind: 'unknown' };
        break;
    }

    emitEvent(sender.ws, event, data);

    const senderFrames = newFrames(sender);
    let accepted: ChatMessage | undefined;
    switch (expected.kind) {
      case 'accepted': {
        expect(senderFrames.map((m) => m.event)).toEqual([ev.added]);
        accepted = senderFrames[0].data.message as ChatMessage;
        expect(accepted).toEqual({ ...expected.message, id: accepted.id });
        expect(isCanonicalUuid(accepted.id)).toBe(true);
        expect(this.seenIds.has(accepted.id)).toBe(false);
        this.seenIds.add(accepted.id);
        commitToModel(board.model, accepted);
        break;
      }
      case 'replay':
        expect(senderFrames).toEqual([expect.objectContaining({ event: ev.added, data: { message: expected.message } })]);
        break;
      case 'rejected':
        expect(senderFrames).toEqual([expect.objectContaining({ event: ev.rejected, data: expected.payload })]);
        break;
      case 'unknown':
        expect(senderFrames.map((m) => [m.event, m.data?.code])).toEqual([[ev.error, 'UNKNOWN_EVENT']]);
        break;
    }

    // Everyone else: an accepted message reaches every open socket of the same
    // session exactly once, as the identical frame; nothing else reaches anyone.
    const senderRaw = sender.ws.sentMessages[sender.ws.sentMessages.length - 1];
    for (const c of this.conns) {
      if (c === sender) continue;
      const fresh = freshRaw(c);
      if (accepted && c.open && c.board === board) {
        expect(fresh).toEqual([senderRaw]);
      } else {
        expect({ to: `${c.board.label}/${c.user.id}`, fresh }).toEqual({ to: `${c.board.label}/${c.user.id}`, fresh: [] });
      }
    }
  }

  /** Whole-run checks over every frame each socket ever received. */
  checkAllFrames(): void {
    for (const c of this.conns) {
      const frames = c.ws.sentMessages.map(parse);
      const ownChat = c.board.kind === 'poker' ? POKER_CHAT_EVENTS : RETRO_CHAT_EVENTS;
      const foreignChat = c.board.kind === 'poker' ? RETRO_CHAT_EVENTS : POKER_CHAT_EVENTS;
      const ownIds = new Map(c.board.model.history.map((m) => [m.id, m]));

      for (const frame of frames) {
        expect(foreignChat).not.toContain(frame.event);
        // Poker sockets never see a retro event; retro sockets see only retro events.
        expect(frame.event.startsWith('retro:')).toBe(c.board.kind === 'retro');

        if (frame.event === EVENTS[c.board.kind].added) {
          const message = frame.data.message as ChatMessage;
          expect(ownIds.get(message.id)).toEqual(message);
        }
        if (frame.event === EVENTS[c.board.kind].history) {
          for (const message of frame.data.messages as ChatMessage[]) {
            expect(ownIds.get(message.id)).toEqual(message);
          }
        }
      }
      expect(frames.some((m) => ownChat.includes(m.event))).toBe(true);
    }
  }
}

function newModel(): ModelRoom {
  return { history: [], dedup: new Map(), acceptTimes: new Map() };
}

/**
 * Fixed opening so every run has users in several sessions of both kinds and
 * several tabs in one session: user 0 joins every session, user 1 opens two
 * tabs in the first poker and the first retro session, user 2 joins the second
 * poker session and the last retro session.
 */
function prelude(world: World): Command[] {
  const firstRetro = world.boards.findIndex((b) => b.kind === 'retro');
  const commands: Command[] = world.boards.map((_, i) => ({ type: 'connect', user: 0, board: i }));
  commands.push(
    { type: 'connect', user: 1, board: 0 },
    { type: 'connect', user: 1, board: 0 },
    { type: 'connect', user: 1, board: firstRetro },
    { type: 'connect', user: 1, board: firstRetro },
    { type: 'connect', user: 2, board: 1 },
    { type: 'connect', user: 2, board: world.boards.length - 1 }
  );
  return commands;
}

// --- Property -----------------------------------------------------------------

describe('chat session isolation through both handlers', () => {
  beforeEach(() => {
    resetAll();
  });

  afterEach(() => {
    resetAll();
    jest.restoreAllMocks();
  });

  // Feature: session-chat, Property 9: Sessions are isolated
  it("Property 9: every socket sees only its own session's chat and every buffer holds only its own sends", () => {
    fc.assert(
      fc.property(scenarioArb, ({ pokerCount, retroCount, commands }) => {
        jest.restoreAllMocks();
        resetAll();
        jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        now = START;
        // Installed before createSession so every ChatRoom captures the stub as its clock.
        jest.spyOn(Date, 'now').mockImplementation(() => now);

        const world = new World(pokerCount, retroCount);
        for (const cmd of [...prelude(world), ...commands]) {
          world.run(cmd);
        }
        world.checkAllFrames();
        expect(errorLog).not.toHaveBeenCalled();
      }),
      { numRuns: 100 }
    );
  });
});
