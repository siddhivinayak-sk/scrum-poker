/**
 * Payload-limit integration test (R22.11; R23.4–R23.9).
 *
 * Real `ws` clients on localhost, for both the poker `wss` and `retroWss`:
 * - a message of exactly WS_MAX_PAYLOAD_BYTES bytes reaches the handler;
 * - a message of WS_MAX_PAYLOAD_BYTES + 1 bytes, as one frame and as several
 *   fragments, closes that connection with 1009, runs no `message` listener,
 *   changes no session state and broadcasts nothing except the normal leave
 *   broadcast; the error log line holds only the permitted fields; no
 *   `uncaughtException` is raised; and a second connection of the same user
 *   stays open and keeps receiving broadcasts.
 */
import WebSocket from 'ws';
import { login } from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import { retroSessionRegistry } from '../../services/retro-session-registry';
import { getSessionClients } from '../../websocket/handler';
import { getRetroSessionClients } from '../../websocket/retro-handler';
import {
  BoardKind,
  DEFAULT_SESSION_CONFIG,
  RetroConfiguration,
  User,
  WebSocketMessage,
  WS_MAX_PAYLOAD_BYTES,
} from '../../../../shared/types';
import { loadServerModule, quiet, startWsHarness, TestClient, WsHarness } from './ws-harness';

jest.setTimeout(20_000);

const MARKER = 'OVERSIZE-PAYLOAD-MARKER';
const QUIET_MS = 300;

const retroConfig: RetroConfiguration = {
  boardName: 'Payload limit',
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
// Per-board-kind adapter: a state-changing "add" event, its broadcast, the
// leave broadcast and a state snapshot.
// ---------------------------------------------------------------------------

interface Board {
  kind: BoardKind;
  sessionId: string;
  /** The add event and its data for a given text (an issue title / card text). */
  addEvent(text: string): { event: string; data: unknown };
  /** The broadcast the add event causes. */
  addedEvent: string;
  /** Whether a broadcast add frame carries `text`. */
  addedCarries(m: WebSocketMessage, text: string): boolean;
  /** Events of the normal participant-leave broadcast, in order. */
  leaveEvents: string[];
  /** Session state without the participant-dependent fields, plus chat history. */
  contentSnapshot(): string;
  /** Participant IDs of the session. */
  participantIds(): string[];
  /** Whether the user still has a socket in the handler's client map. */
  inClientMap(userId: string): boolean;
}

function createBoard(kind: BoardKind, ownerId: string): Board {
  if (kind === 'poker') {
    const { sessionId } = sessionRegistry.createSession(ownerId, DEFAULT_SESSION_CONFIG);
    const session = sessionRegistry.getSession(sessionId)!;
    session.addIssues(['Existing issue']);
    return {
      kind,
      sessionId,
      addEvent: (text) => ({ event: 'issue:add', data: { titles: [text] } }),
      addedEvent: 'issue:list-updated',
      addedCarries: (m, text) =>
        m.event === 'issue:list-updated' &&
        (m.data as { issues: { title: string }[] }).issues.some((i) => i.title === text),
      leaveEvents: ['participant:left'],
      contentSnapshot: () => {
        const { participants: _p, currentRound, ...rest } = session.getSessionState();
        return JSON.stringify({
          ...rest,
          currentRound: currentRound
            ? { ...currentRound, selections: Object.fromEntries(currentRound.selections) }
            : null,
          chat: session.chat.history(),
        });
      },
      participantIds: () => session.getParticipants().map((p) => p.id).sort(),
      inClientMap: (userId) => getSessionClients().get(sessionId)?.has(userId) ?? false,
    };
  }

  const { sessionId } = retroSessionRegistry.createSession(ownerId, retroConfig);
  const session = retroSessionRegistry.getSession(sessionId)!;
  const columnId = session.getSessionState().board.columns[0].id;
  session.addCard(columnId, 'Existing card', ownerId, 'Owner');
  return {
    kind,
    sessionId,
    addEvent: (text) => ({ event: 'retro:card:add', data: { columnId, text } }),
    addedEvent: 'retro:card:added',
    addedCarries: (m, text) =>
      m.event === 'retro:card:added' && (m.data as { card: { text: string } }).card.text === text,
    leaveEvents: ['retro:participant:left', 'retro:feeling:updated'],
    contentSnapshot: () => {
      const { participants: _p, feelings: _f, votesRemaining: _v, ...rest } = session.getSessionState();
      return JSON.stringify({ ...rest, chat: session.chat.history() });
    },
    participantIds: () => session.getParticipants().map((p) => p.id).sort(),
    inClientMap: (userId) => getRetroSessionClients().get(sessionId)?.has(userId) ?? false,
  };
}

/**
 * A JSON envelope of `board`'s add event whose UTF-8 length is exactly `bytes`.
 * The padding is ASCII, so characters and bytes match.
 */
function frameOfBytes(board: Board, bytes: number, prefix: string): { frame: string; text: string } {
  const build = (text: string): string => {
    const { event, data } = board.addEvent(text);
    return JSON.stringify({ event, data, timestamp: '2026-01-01T00:00:00.000Z' });
  };
  const base = Buffer.byteLength(build(prefix), 'utf8');
  const text = prefix + 'x'.repeat(bytes - base);
  const frame = build(text);
  expect(Buffer.byteLength(frame, 'utf8')).toBe(bytes);
  return { frame, text };
}

/** Send `frame` as one frame, or as three fragments whose payloads sum to its length. */
async function sendOversized(client: TestClient, frame: string, mode: 'single frame' | 'fragments'): Promise<void> {
  if (mode === 'single frame') {
    await client.sendRaw(frame).catch(() => undefined);
    return;
  }
  const buf = Buffer.from(frame, 'utf8');
  const a = Math.floor(buf.length / 3);
  const b = 2 * a;
  const parts = [buf.subarray(0, a), buf.subarray(a, b), buf.subarray(b)];
  expect(parts.reduce((n, p) => n + p.length, 0)).toBe(WS_MAX_PAYLOAD_BYTES + 1);
  // The final fragment may race the server's 1009 close; a write error then is expected.
  await client.sendRaw(parts[0], { fin: false });
  await client.sendRaw(parts[1], { fin: false });
  await client.sendRaw(parts[2], { fin: true }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Log and console capture
// ---------------------------------------------------------------------------

let consoleLines: string[] = [];

function captureConsole(): void {
  consoleLines = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
}

/**
 * Every log line is either a redacted upgrade line or the one permitted error
 * line, and no log or console line holds a token, a query string or payload.
 */
function expectPermittedLogs(h: WsHarness, kind: BoardKind, sessionId: string, tokens: string[]): void {
  const upgradePath = kind === 'retro' ? '/retro' : '/';
  const errorLine = `WebSocket error: kind=${kind} session=${sessionId} code=WS_ERR_UNSUPPORTED_MESSAGE_LENGTH close=1009`;

  for (const line of h.logLines) {
    expect([`WebSocket upgrade request: ${upgradePath}`, errorLine]).toContain(line);
  }
  expect(h.logLines.filter((l) => l.startsWith('WebSocket error:'))).toEqual([errorLine]);

  for (const line of [...h.logLines, ...consoleLines]) {
    expect(line).not.toContain(MARKER);
    expect(line).not.toContain('xxxxxxxx');
    expect(line).not.toContain('token=');
    expect(line).not.toContain('?');
    expect(line).not.toContain('Max payload size exceeded');
    for (const token of tokens) expect(line).not.toContain(token);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebSocket payload limit (integration, real sockets on localhost)', () => {
  let h: WsHarness;

  beforeEach(async () => {
    h = await startWsHarness();
    captureConsole();
  });

  afterEach(async () => {
    await h.close();
    jest.restoreAllMocks();
  });

  it('creates both production WebSocketServers with maxPayload = WS_MAX_PAYLOAD_BYTES (R23.4)', async () => {
    const mod = await loadServerModule();
    expect(mod.wss.options.maxPayload).toBe(WS_MAX_PAYLOAD_BYTES);
    expect(mod.retroWss.options.maxPayload).toBe(WS_MAX_PAYLOAD_BYTES);
    expect(mod.wss.options.noServer).toBe(true);
    expect(mod.retroWss.options.noServer).toBe(true);
  });

  describe.each<BoardKind>(['poker', 'retro'])('%s server', (kind) => {
    let owner: { token: string; user: User };
    let other: { token: string; user: User };
    let board: Board;

    beforeEach(() => {
      owner = login('Owner', false);
      other = login('Observer', false);
      board = createBoard(kind, owner.user.id);
    });

    it('delivers a message of exactly WS_MAX_PAYLOAD_BYTES bytes to the handler (R23.6)', async () => {
      const sender = await h.connect(kind, owner.token, board.sessionId);
      const observer = await h.connect(kind, other.token, board.sessionId);
      const { frame, text } = frameOfBytes(board, WS_MAX_PAYLOAD_BYTES, 'exact-limit-');
      const mark = observer.frames.length;

      await sender.sendRaw(frame);

      await observer.waitFor((m) => board.addedCarries(m, text), { from: mark });
      await sender.waitFor((m) => board.addedCarries(m, text));
      expect(sender.server.messageBytes).toEqual([WS_MAX_PAYLOAD_BYTES]);
      expect(sender.ws.readyState).toBe(WebSocket.OPEN);
      expect(board.contentSnapshot()).toContain(text);
      expect(h.logLines.filter((l) => l.startsWith('WebSocket error:'))).toEqual([]);
      expect(h.uncaughtExceptions).toEqual([]);
    });

    it.each(['single frame', 'fragments'] as const)(
      'closes a %s message of WS_MAX_PAYLOAD_BYTES + 1 bytes with 1009 and handles it like a 1006 close (R23.5, R23.7–R23.9)',
      async (mode) => {
        const sender = await h.connect(kind, owner.token, board.sessionId);
        const observer = await h.connect(kind, other.token, board.sessionId);
        const contentBefore = board.contentSnapshot();
        const participantsBefore = board.participantIds();
        const { frame } = frameOfBytes(board, WS_MAX_PAYLOAD_BYTES + 1, MARKER);
        const senderMark = sender.frames.length;
        const observerMark = observer.frames.length;

        await sendOversized(sender, frame, mode);

        // The sender's connection closes with 1009 (R23.5).
        expect((await sender.closed).code).toBe(1009);
        await sender.server.closed;

        // The normal leave broadcast reaches the other connection (R23.9).
        const lastLeave = board.leaveEvents[board.leaveEvents.length - 1];
        await observer.waitFor((m) => m.event === lastLeave, { from: observerMark });
        await quiet(QUIET_MS);

        // No `message` listener ran, nothing but the leave broadcast was sent.
        expect(sender.server.messageBytes).toEqual([]);
        expect(sender.eventsSince(senderMark)).toEqual([]);
        expect(observer.eventsSince(observerMark)).toEqual(board.leaveEvents);
        const left = observer.frames[observerMark].data as { participants: User[] };
        expect(left.participants.map((p) => p.id)).toEqual([other.user.id]);

        // No session content changed; only the leave handling removed the sender.
        expect(board.contentSnapshot()).toBe(contentBefore);
        expect(participantsBefore).toEqual([owner.user.id, other.user.id].sort());
        expect(board.participantIds()).toEqual([other.user.id]);
        expect(board.inClientMap(owner.user.id)).toBe(false);

        // Only the permitted log fields; the process keeps running (R23.7, R23.8).
        expectPermittedLogs(h, kind, board.sessionId, [owner.token, other.token]);
        expect(h.uncaughtExceptions).toEqual([]);

        // The other connection stays open and keeps receiving broadcasts.
        expect(observer.ws.readyState).toBe(WebSocket.OPEN);
        const third = login('Latecomer', false);
        const joinMark = observer.frames.length;
        await h.connect(kind, third.token, board.sessionId);
        const joinedEvent = kind === 'retro' ? 'retro:participant:joined' : 'participant:joined';
        await observer.waitFor((m) => m.event === joinedEvent, { from: joinMark });
      }
    );

    it.each(['single frame', 'fragments'] as const)(
      'keeps a second connection of the same user open and receiving after a %s oversized message (R23.7, R23.9)',
      async (mode) => {
        const first = await h.connect(kind, owner.token, board.sessionId);
        const second = await h.connect(kind, owner.token, board.sessionId);
        const observer = await h.connect(kind, other.token, board.sessionId);
        const contentBefore = board.contentSnapshot();
        const participantsBefore = board.participantIds();
        const { frame } = frameOfBytes(board, WS_MAX_PAYLOAD_BYTES + 1, MARKER);
        const secondMark = second.frames.length;
        const observerMark = observer.frames.length;

        await sendOversized(first, frame, mode);

        expect((await first.closed).code).toBe(1009);
        await first.server.closed;
        await quiet(QUIET_MS);

        // The user still holds a connection, so no leave broadcast and no
        // other frame; no state changed at all.
        expect(first.server.messageBytes).toEqual([]);
        expect(second.eventsSince(secondMark)).toEqual([]);
        expect(observer.eventsSince(observerMark)).toEqual([]);
        expect(board.contentSnapshot()).toBe(contentBefore);
        expect(board.participantIds()).toEqual(participantsBefore);
        expect(board.inClientMap(owner.user.id)).toBe(true);

        expectPermittedLogs(h, kind, board.sessionId, [owner.token, other.token]);
        expect(h.uncaughtExceptions).toEqual([]);

        // The same user's second connection is open and still receives broadcasts.
        expect(second.ws.readyState).toBe(WebSocket.OPEN);
        const { event, data } = board.addEvent('after-oversize');
        await second.sendRaw(JSON.stringify({ event, data, timestamp: new Date().toISOString() }));
        await second.waitFor((m) => board.addedCarries(m, 'after-oversize'), { from: secondMark });
        await observer.waitFor((m) => board.addedCarries(m, 'after-oversize'), { from: observerMark });
      }
    );
  });
});
