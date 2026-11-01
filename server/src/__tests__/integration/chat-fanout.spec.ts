/**
 * Chat fan-out and board-latency integration tests (R22.9, R20.1, R20.9).
 *
 * Real `ws` clients on localhost, 50 connections of 50 distinct users to one
 * session of each board kind, all on the single harness server process:
 * - Fan-out (R20.1, R22.9): 20 consecutive chat messages, each from a
 *   different author, each reach all 50 connections (the sender included)
 *   within 500 ms of the server receiving the send event.
 * - Board events under chat load (R20.9): while every one of the 50
 *   connections sends chat messages at `CHAT_RATE_LIMIT_COUNT` per
 *   `CHAT_RATE_LIMIT_WINDOW_MS`, each vote (poker) or card addition (retro)
 *   broadcast reaches all 50 connections within 500 ms of the server
 *   receiving the triggering event.
 *
 * Latency is measured per message and per connection, from the server-side
 * socket's `message` event (a listener prepended so it runs before the
 * handler) to the client socket's `message` event for the broadcast frame.
 * Server and clients share one process, so both ends read the same
 * monotonic clock (`performance.now()`).
 */
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import WebSocket from 'ws';
import { login } from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import { retroSessionRegistry } from '../../services/retro-session-registry';
import {
  BoardKind,
  CHAT_EVENTS,
  CHAT_RATE_LIMIT_COUNT,
  CHAT_RATE_LIMIT_WINDOW_MS,
  ChatMessageAddedPayload,
  ChatMessageSendPayload,
  DEFAULT_SESSION_CONFIG,
  RetroCard,
  RetroConfiguration,
  WebSocketMessage,
} from '../../../../shared/types';
import { quiet, startWsHarness, TestClient, WsHarness } from './ws-harness';

jest.setTimeout(120_000);

const CONNECTIONS = 50;
const FANOUT_MESSAGES = 20;
const LATENCY_BOUND_MS = 500;
/** How long a single receipt may take before the test fails instead of hanging. */
const RECEIPT_TIMEOUT_MS = 10_000;
/** Board events triggered during the chat load, spread across the load. */
const BOARD_EVENTS_UNDER_LOAD = 5;

const retroConfig: RetroConfiguration = {
  boardName: 'Chat fan-out',
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

type Login = ReturnType<typeof login>;
type Predicate = (m: WebSocketMessage) => boolean;

/** A client event, how the server-side socket recognises it, and its broadcast. */
interface Triggered {
  event: string;
  data: unknown;
  /** Matches the frame as the server receives it. */
  sent: Predicate;
  /** Matches the broadcast frame every connection must receive. */
  broadcast: Predicate;
}

interface Board {
  kind: BoardKind;
  sessionId: string;
  users: Login[];
  /** An existing board event (vote / card addition) sent by `users[i]`. */
  boardEvent(i: number): Triggered;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parse(raw: WebSocket.RawData): WebSocketMessage | null {
  try {
    return JSON.parse(raw.toString()) as WebSocketMessage;
  } catch {
    return null;
  }
}

/**
 * Resolve with `performance.now()` taken when `socket` emits the first
 * `message` matching `pred`. The listener is prepended, so on a server-side
 * socket the time is taken before the board handler runs.
 */
function receiptTime(socket: WebSocket, pred: Predicate, label: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: WebSocket.RawData): void => {
      const at = performance.now();
      const m = parse(raw);
      if (m && pred(m)) {
        cleanup();
        resolve(at);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${RECEIPT_TIMEOUT_MS} ms waiting for ${label}`));
    }, RECEIPT_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('message', onMessage);
    };
    socket.prependListener('message', onMessage);
  });
}

function frameOf(t: Triggered): string {
  return JSON.stringify({ event: t.event, data: t.data, timestamp: new Date().toISOString() });
}

/**
 * Send `t` from `sender` and return, per client in `clients` order, the time
 * from the server's receipt of the event to that client's receipt of the
 * broadcast.
 */
async function measureBroadcast(
  sender: TestClient,
  clients: TestClient[],
  t: Triggered,
  label: string
): Promise<number[]> {
  const receipts = Promise.all([
    receiptTime(sender.server.ws, t.sent, `the server to receive ${label}`),
    ...clients.map((c, i) => receiptTime(c.ws, t.broadcast, `connection ${i} to receive ${label}`)),
  ]);
  const [[serverAt, ...clientAts]] = await Promise.all([receipts, sender.sendRaw(frameOf(t))]);
  return clientAts.map((at) => at - serverAt);
}

function chatSend(kind: BoardKind, sessionId: string, text: string): Triggered {
  const clientMessageId = randomUUID();
  const events = CHAT_EVENTS[kind];
  const data: ChatMessageSendPayload = { sessionId, clientMessageId, text };
  return {
    event: events.send,
    data,
    sent: (m) => m.event === events.send && (m.data as ChatMessageSendPayload).clientMessageId === clientMessageId,
    broadcast: (m) =>
      m.event === events.added && (m.data as ChatMessageAddedPayload).message.clientMessageId === clientMessageId,
  };
}

function countEvents(client: TestClient, event: string): number {
  return client.frames.reduce((n, m) => (m.event === event ? n + 1 : n), 0);
}

async function waitUntil(cond: () => boolean, label: string, timeoutMs = RECEIPT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`);
    await quiet(20);
  }
}

function createBoard(kind: BoardKind): Board {
  const users = Array.from({ length: CONNECTIONS }, (_, i) => login(`${kind} user ${i}`, false));
  const ownerId = users[0].user.id;

  if (kind === 'poker') {
    const { sessionId } = sessionRegistry.createSession(ownerId, { ...DEFAULT_SESSION_CONFIG, autoReveal: false });
    // An open voting round, so every participant can vote.
    sessionRegistry.getSession(sessionId)!.startRound('Fan-out story');
    return {
      kind,
      sessionId,
      users,
      boardEvent: (i) => {
        const userId = users[i].user.id;
        return {
          event: 'card:select',
          data: { cardValue: 5 },
          sent: (m) => m.event === 'card:select',
          broadcast: (m) => m.event === 'card:voted' && (m.data as { userId: string }).userId === userId,
        };
      },
    };
  }

  const { sessionId } = retroSessionRegistry.createSession(ownerId, retroConfig);
  const columnId = retroSessionRegistry.getSession(sessionId)!.getSessionState().board.columns[0].id;
  return {
    kind,
    sessionId,
    users,
    boardEvent: (i) => {
      const text = `card from user ${i} ${randomUUID()}`;
      return {
        event: 'retro:card:add',
        data: { columnId, text },
        sent: (m) => m.event === 'retro:card:add' && (m.data as { text: string }).text === text,
        broadcast: (m) => m.event === 'retro:card:added' && (m.data as { card: RetroCard }).card.text === text,
      };
    },
  };
}

async function connectAll(h: WsHarness, board: Board): Promise<TestClient[]> {
  const clients: TestClient[] = [];
  // One at a time: connect() matches each client to the newest server socket.
  for (const u of board.users) {
    clients.push(await h.connect(board.kind, u.token, board.sessionId));
  }
  return clients;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.each<BoardKind>(['poker', 'retro'])('%s chat fan-out (integration, real sockets on localhost)', (kind) => {
  const events = CHAT_EVENTS[kind];
  let h: WsHarness;

  beforeEach(async () => {
    h = await startWsHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it(`delivers each of ${FANOUT_MESSAGES} consecutive messages from distinct authors to all ${CONNECTIONS} connections within ${LATENCY_BOUND_MS} ms (R20.1, R22.9)`, async () => {
    const board = createBoard(kind);
    const clients = await connectAll(h, board);
    const marks = clients.map((c) => c.frames.length);

    const slow: Array<{ message: number; connection: number; latencyMs: number }> = [];
    for (let i = 0; i < FANOUT_MESSAGES; i++) {
      const send = chatSend(kind, board.sessionId, `fan-out message ${i}`);
      const latencies = await measureBroadcast(clients[i], clients, send, `chat message ${i}`);
      latencies.forEach((latencyMs, connection) => {
        if (latencyMs > LATENCY_BOUND_MS) slow.push({ message: i, connection, latencyMs });
      });
    }
    expect(slow).toEqual([]);

    // Every connection, the senders included, got exactly the 20 messages, in
    // order, each from a different author, and nothing was rejected.
    const authors = board.users.slice(0, FANOUT_MESSAGES).map((u) => u.user.id);
    expect(new Set(authors).size).toBe(FANOUT_MESSAGES);
    clients.forEach((c, i) => {
      const added = c.frames
        .slice(marks[i])
        .filter((m) => m.event === events.added)
        .map((m) => (m.data as ChatMessageAddedPayload).message);
      expect(added.map((m) => m.authorId)).toEqual(authors);
      expect(added.map((m) => m.text)).toEqual(authors.map((_, n) => `fan-out message ${n}`));
      expect(countEvents(c, events.rejected)).toBe(0);
      expect(c.ws.readyState).toBe(WebSocket.OPEN);
    });
    expect(h.uncaughtExceptions).toEqual([]);
  });

  it(`delivers a board broadcast to all ${CONNECTIONS} connections within ${LATENCY_BOUND_MS} ms while all of them chat at the rate limit (R20.9)`, async () => {
    const board = createBoard(kind);
    const clients = await connectAll(h, board);
    const addedBefore = clients.map((c) => countEvents(c, events.added));

    // Each connection sends CHAT_RATE_LIMIT_COUNT messages, one every
    // WINDOW / COUNT ms: exactly at the limit, and all within one window so
    // every send is accepted. Connections are staggered evenly over one
    // spacing so the server sees a steady stream of sends.
    const spacingMs = CHAT_RATE_LIMIT_WINDOW_MS / CHAT_RATE_LIMIT_COUNT;
    const loadStart = performance.now();
    const loadSends: Array<Promise<void>> = [];
    const timers: NodeJS.Timeout[] = [];
    clients.forEach((c, i) => {
      const offsetMs = (i * spacingMs) / CONNECTIONS;
      for (let k = 0; k < CHAT_RATE_LIMIT_COUNT; k++) {
        loadSends.push(
          new Promise<void>((resolve, reject) => {
            timers.push(
              setTimeout(() => {
                c.sendRaw(frameOf(chatSend(kind, board.sessionId, `load ${i}.${k}`))).then(resolve, reject);
              }, offsetMs + k * spacingMs)
            );
          })
        );
      }
    });
    const loadSpanMs = (CHAT_RATE_LIMIT_COUNT - 1) * spacingMs + spacingMs;

    try {
      // Board events at evenly spread points inside the load, each from a
      // different connection (which is also chatting).
      const slow: Array<{ boardEvent: number; connection: number; latencyMs: number }> = [];
      for (let e = 0; e < BOARD_EVENTS_UNDER_LOAD; e++) {
        const atMs = ((e + 0.5) * loadSpanMs) / BOARD_EVENTS_UNDER_LOAD;
        const waitMs = loadStart + atMs - performance.now();
        if (waitMs > 0) await quiet(waitMs);
        const senderIndex = 1 + e;
        const latencies = await measureBroadcast(
          clients[senderIndex],
          clients,
          board.boardEvent(senderIndex),
          `board event ${e}`
        );
        latencies.forEach((latencyMs, connection) => {
          if (latencyMs > LATENCY_BOUND_MS) slow.push({ boardEvent: e, connection, latencyMs });
        });
      }
      expect(slow).toEqual([]);

      // The load really ran: every send was accepted and reached every
      // connection, so the board events were measured under the full load.
      await Promise.all(loadSends);
      const loadMessages = CONNECTIONS * CHAT_RATE_LIMIT_COUNT;
      await waitUntil(
        () => clients.every((c, i) => countEvents(c, events.added) - addedBefore[i] >= loadMessages),
        `all ${loadMessages} load messages on every connection`
      );
      clients.forEach((c, i) => {
        expect(countEvents(c, events.added) - addedBefore[i]).toBe(loadMessages);
        expect(countEvents(c, events.rejected)).toBe(0);
        expect(c.ws.readyState).toBe(WebSocket.OPEN);
      });
      expect(h.uncaughtExceptions).toEqual([]);
    } finally {
      timers.forEach((t) => clearTimeout(t));
    }
  });
});
