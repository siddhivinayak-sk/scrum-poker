/**
 * Cross-session chat isolation integration test (R22.5; R15.5, R15.10).
 *
 * Real `ws` clients on localhost open Board_Connections to two Poker_Sessions
 * and two Retro_Sessions. Every session has two connections: its own owner,
 * and one connection of a "roamer" user who is in all four sessions, so
 * isolation is checked per session and not merely per user. Each session
 * receives two chat sends, all eight written before any delivery is awaited
 * so the handlers see them interleaved. The roamer sends every one of its
 * messages with the same `clientMessageId`, so a Dedup_Record shared across
 * sessions would answer three of them as duplicates.
 *
 * What "nothing else" means here: R22.5 and R15.10 forbid a connection to
 * receive any Chat_Message or Chat_History of another Board_Session. Join
 * frames (state, joined, history) all arrive before the mark taken after the
 * last connect, and the test causes no other board activity during the
 * window, so the assertion is stricter than the requirement: from the mark
 * on, each connection's frames must be exactly its own session's
 * `chat:message:added` / `retro:chat:message:added` events, each once, in
 * Sequence_Number order. That covers chat events of other sessions (of either
 * Board_Kind), stray `chat:history` frames, and rejections. Chat_Histories
 * are checked separately: the on-connect history of every connection holds
 * only its own session's messages (none, as the sessions are fresh), and a
 * late joiner of each session gets a history of exactly its session's messages.
 */
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { login } from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import { retroSessionRegistry } from '../../services/retro-session-registry';
import {
  BoardKind,
  CHAT_ACK_TIMEOUT_MS,
  CHAT_EVENTS,
  ChatHistoryPayload,
  ChatMessage,
  ChatMessageAddedPayload,
  ChatMessageSendPayload,
  DEFAULT_SESSION_CONFIG,
  RetroConfiguration,
  User,
  WebSocketMessage,
} from '../../../../shared/types';
import { quiet, startWsHarness, TestClient, WsHarness } from './ws-harness';

jest.setTimeout(CHAT_ACK_TIMEOUT_MS + 20_000);

/** The further window in which no other chat event may arrive (R22.5). */
const QUIET_MS = 500;

const retroConfig: RetroConfiguration = {
  boardName: 'Chat isolation',
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

// ---------------------------------------------------------------------------
// Local helpers (the shared harness is not extended by this task)
// ---------------------------------------------------------------------------

interface Login {
  token: string;
  user: User;
}

interface Board {
  label: string;
  kind: BoardKind;
  sessionId: string;
  owner: Login;
  /** The session's server-side Chat_Buffer contents. */
  history(): ChatMessage[];
}

interface Send {
  board: Board;
  author: Login;
  clientMessageId: string;
  text: string;
}

function createBoard(label: string, kind: BoardKind): Board {
  const owner = login(`Owner ${label}`, false);
  if (kind === 'poker') {
    const { sessionId } = sessionRegistry.createSession(owner.user.id, DEFAULT_SESSION_CONFIG);
    const session = sessionRegistry.getSession(sessionId)!;
    return { label, kind, sessionId, owner, history: () => session.chat.history() };
  }
  const { sessionId } = retroSessionRegistry.createSession(owner.user.id, retroConfig);
  const session = retroSessionRegistry.getSession(sessionId)!;
  return { label, kind, sessionId, owner, history: () => session.chat.history() };
}

function sendFrame(s: Send): string {
  const data: ChatMessageSendPayload = {
    sessionId: s.board.sessionId,
    clientMessageId: s.clientMessageId,
    text: s.text,
  };
  return JSON.stringify({ event: CHAT_EVENTS[s.board.kind].send, data, timestamp: new Date().toISOString() });
}

/** Every chat event name of either Board_Kind. */
const ALL_CHAT_EVENTS = new Set<string>(
  (['poker', 'retro'] as const).flatMap((k) => Object.values(CHAT_EVENTS[k]))
);

function addedMessage(m: WebSocketMessage): ChatMessage {
  return (m.data as ChatMessageAddedPayload).message;
}

function historyOf(client: TestClient): ChatMessage[] {
  const frame = client.frames.find((m) => m.event === CHAT_EVENTS[client.kind].history);
  if (!frame) throw new Error(`No ${client.kind} chat history frame`);
  return (frame.data as ChatHistoryPayload).messages;
}

/** The (authorId, clientMessageId, text) triple a Chat_Message must carry for a send. */
function fingerprint(m: Pick<ChatMessage, 'authorId' | 'clientMessageId' | 'text'>): string {
  return JSON.stringify([m.authorId, m.clientMessageId, m.text]);
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('Chat isolation across Board_Sessions (integration, real sockets on localhost)', () => {
  let h: WsHarness;

  beforeEach(async () => {
    h = await startWsHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('delivers each Chat_Message only to the connections of its own session, of either Board_Kind (R22.5, R15.5, R15.10)', async () => {
    const boards: Board[] = [
      createBoard('poker-A', 'poker'),
      createBoard('poker-B', 'poker'),
      createBoard('retro-A', 'retro'),
      createBoard('retro-B', 'retro'),
    ];
    const roamer = login('Roamer', false);

    // Two connections per session: its owner and the roamer.
    const connections = new Map<Board, TestClient[]>();
    for (const board of boards) {
      const ownerConn = await h.connect(board.kind, board.owner.token, board.sessionId);
      const roamerConn = await h.connect(board.kind, roamer.token, board.sessionId);
      connections.set(board, [ownerConn, roamerConn]);
    }
    const allClients = boards.flatMap((b) => connections.get(b)!);

    // On-connect histories carry nothing of another session (fresh sessions: empty).
    for (const client of allClients) {
      expect(historyOf(client)).toEqual([]);
    }

    // Mark every connection after all join frames (connect() waits for them).
    const marks = new Map<TestClient, number>(allClients.map((c) => [c, c.frames.length]));

    // One owner message and one roamer message per session; the roamer reuses
    // one clientMessageId in every session.
    const roamerClientMessageId = randomUUID();
    const sends: Send[] = boards.flatMap((board) => [
      { board, author: board.owner, clientMessageId: randomUUID(), text: `owner message of ${board.label}` },
      { board, author: roamer, clientMessageId: roamerClientMessageId, text: `roamer message of ${board.label}` },
    ]);

    // Write all eight frames before awaiting any delivery, alternating kinds
    // and sessions, so the handlers process them interleaved.
    const order = [0, 4, 2, 6, 1, 5, 3, 7].map((i) => sends[i]);
    await Promise.all(
      order.map((s) => {
        const [ownerConn, roamerConn] = connections.get(s.board)!;
        const conn = s.author === roamer ? roamerConn : ownerConn;
        return conn.sendRaw(sendFrame(s));
      })
    );

    // Every connection receives its session's two messages within CHAT_ACK_TIMEOUT_MS.
    const deadline = Date.now() + CHAT_ACK_TIMEOUT_MS;
    await Promise.all(
      boards.flatMap((board) => {
        const added = CHAT_EVENTS[board.kind].added;
        const expected = sends.filter((s) => s.board === board).map((s) =>
          fingerprint({ authorId: s.author.user.id, clientMessageId: s.clientMessageId, text: s.text })
        );
        return connections.get(board)!.map(async (client) => {
          for (const fp of expected) {
            await client.waitFor((m) => m.event === added && fingerprint(addedMessage(m)) === fp, {
              from: marks.get(client),
              timeoutMs: Math.max(1, deadline - Date.now()),
            });
          }
        });
      })
    );
    expect(Date.now()).toBeLessThanOrEqual(deadline);

    // A further 500 ms after the last expected delivery.
    await quiet(QUIET_MS);

    for (const board of boards) {
      const added = CHAT_EVENTS[board.kind].added;
      const expected = sends
        .filter((s) => s.board === board)
        .map((s) => fingerprint({ authorId: s.author.user.id, clientMessageId: s.clientMessageId, text: s.text }))
        .sort();

      // The server-side Chat_Buffer holds exactly this session's messages.
      const stored = board.history();
      expect(stored.map(fingerprint).sort()).toEqual(expected);
      expect(stored.map((m) => m.seq)).toEqual([1, 2]);

      for (const client of connections.get(board)!) {
        const mark = marks.get(client)!;
        const received = client.frames.slice(mark);

        // Only this session's added events: no chat event of any other
        // session or Board_Kind, no history, no rejection, nothing else.
        expect(client.eventsSince(mark)).toEqual([added, added]);

        // Exactly this session's messages, each once, in Sequence_Number
        // order and identical to the stored ones.
        const messages = received.map(addedMessage);
        expect(messages.map(fingerprint).sort()).toEqual(expected);
        expect(messages.map((m) => m.seq)).toEqual([1, 2]);
        expect(messages).toEqual(stored);

        expect(client.ws.readyState).toBe(WebSocket.OPEN);
      }
    }

    // Message IDs are distinct across all four sessions.
    const ids = boards.flatMap((b) => b.history().map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length);

    // A late joiner of each session gets a Chat_History of exactly its own
    // session's messages (R15.10, Chat_Histories).
    for (const board of boards) {
      const late = login(`Late ${board.label}`, false);
      const lateConn = await h.connect(board.kind, late.token, board.sessionId);
      expect(historyOf(lateConn)).toEqual(board.history());
      // Its only chat frame is that one history.
      expect(lateConn.frames.map((m) => m.event).filter((e) => ALL_CHAT_EVENTS.has(e))).toEqual([
        CHAT_EVENTS[board.kind].history,
      ]);
    }

    expect(h.logLines.filter((l) => l.startsWith('WebSocket error:'))).toEqual([]);
    expect(h.uncaughtExceptions).toEqual([]);
  });
});
