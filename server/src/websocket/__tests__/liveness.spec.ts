import { IncomingMessage } from 'http';
import { EventEmitter } from 'events';
import WebSocket, { WebSocketServer } from 'ws';
import {
  attachLivenessProbe,
  nextMissedCount,
  LIVENESS_INTERVAL_MS,
  MAX_MISSED_PONGS,
  LivenessProbe,
} from '../liveness';
import { handleWebSocket, removePokerConnection, _reset as resetPokerHandler } from '../handler';
import {
  handleRetroWebSocket,
  removeRetroConnection,
  _resetRetroHandler,
} from '../retro-handler';
import * as authService from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import { retroSessionRegistry } from '../../services/retro-session-registry';
import {
  User,
  WebSocketMessage,
  DEFAULT_SESSION_CONFIG,
  RetroConfiguration,
} from '../../../../shared/types';

// ---------------------------------------------------------------------------
// Test doubles
//
// The probe only needs `on`/`off`/`once`, `readyState`, `ping()` and
// `terminate()` from a socket, so an EventEmitter stands in for a real
// connection. Probe timing is observed through the recorded ping timestamps,
// which the fake clock makes exact.
// ---------------------------------------------------------------------------

type MockWs = WebSocket & {
  id: string;
  /** Fake-clock timestamp of every `ping()` the probe sent, in call order. */
  pingTimes: number[];
  terminateCount: number;
  closeCount: number;
  sentMessages: string[];
  /** Answer the outstanding probe, as a live client's `pong` frame would. */
  answerProbe(): void;
};

function createMockWs(id: string): MockWs {
  const emitter = new EventEmitter();
  const mock = emitter as unknown as MockWs & Record<string, unknown>;

  mock.id = id;
  (mock as { readyState: number }).readyState = WebSocket.OPEN;
  mock.pingTimes = [];
  mock.terminateCount = 0;
  mock.closeCount = 0;
  mock.sentMessages = [];

  mock.send = jest.fn((data: string) => {
    mock.sentMessages.push(data);
  }) as unknown as MockWs['send'];

  mock.ping = jest.fn(() => {
    mock.pingTimes.push(Date.now());
  }) as unknown as MockWs['ping'];

  // The real `terminate()` tears the socket down and fires 'close'; reproducing
  // both is what lets these tests prove the handler's own close path and the
  // probe's path agree.
  mock.terminate = jest.fn(() => {
    mock.terminateCount += 1;
    (mock as { readyState: number }).readyState = WebSocket.CLOSED;
    emitter.emit('close');
  }) as unknown as MockWs['terminate'];

  mock.close = jest.fn(() => {
    mock.closeCount += 1;
    (mock as { readyState: number }).readyState = WebSocket.CLOSED;
    emitter.emit('close');
  }) as unknown as MockWs['close'];

  mock.answerProbe = (): void => {
    emitter.emit('pong');
  };

  return mock as unknown as MockWs;
}

/** A server that binds no port, so `emit('connection', ws)` is the whole wiring. */
function createServer(): WebSocketServer {
  return new WebSocketServer({ noServer: true });
}

function connectTo(wss: WebSocketServer, ws: MockWs): void {
  wss.emit('connection', ws);
}

function parsedMessages(ws: MockWs): WebSocketMessage[] {
  return ws.sentMessages.map((raw) => JSON.parse(raw) as WebSocketMessage);
}

/** Advance the fake clock by whole probe intervals. */
function advanceIntervals(count: number): void {
  jest.advanceTimersByTime(count * LIVENESS_INTERVAL_MS);
}

// --- Users and session helpers ---

function user(id: string, displayName: string, role: 'moderator' | 'participant'): User {
  return { id, displayName, role, isAnonymous: false };
}

const moderatorUser = user('mod-1', 'Moderator', 'moderator');
const aliceUser = user('user-a', 'Alice', 'participant');
const bobUser = user('user-b', 'Bob', 'participant');

const retroConfig: RetroConfiguration = {
  boardName: 'Liveness Retro',
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

function pokerRequest(token: string, sessionId: string): IncomingMessage {
  return {
    url: `/?token=${token}&sessionId=${sessionId}`,
    headers: { host: 'localhost:3000' },
  } as unknown as IncomingMessage;
}

function retroRequest(token: string, sessionId: string): IncomingMessage {
  return {
    url: `/retro?token=${token}&sessionId=${sessionId}`,
    headers: { host: 'localhost:3000' },
  } as unknown as IncomingMessage;
}

/** Register a mock socket with the poker handler and with `wss`. */
function joinPoker(
  wss: WebSocketServer,
  u: User,
  sessionId: string,
  socketId: string
): MockWs {
  jest.spyOn(authService, 'validateToken').mockReturnValueOnce(u);
  const ws = createMockWs(socketId);
  handleWebSocket(ws, pokerRequest(`token-${u.id}`, sessionId));
  expect(ws.closeCount).toBe(0);
  connectTo(wss, ws);
  return ws;
}

/** Register a mock socket with the retro handler and with `wss`. */
function joinRetro(
  wss: WebSocketServer,
  u: User,
  sessionId: string,
  socketId: string
): MockWs {
  jest.spyOn(authService, 'validateToken').mockReturnValueOnce(u);
  const ws = createMockWs(socketId);
  handleRetroWebSocket(ws, retroRequest(`token-${u.id}`, sessionId));
  expect(ws.closeCount).toBe(0);
  connectTo(wss, ws);
  return ws;
}

// ---------------------------------------------------------------------------
// nextMissedCount — the probe's arithmetic, provable without timers
//
// **Validates: Requirements 11.21**
// ---------------------------------------------------------------------------

describe('nextMissedCount (R11.21)', () => {
  it('counts a tick with no pong as one more missed probe', () => {
    expect(nextMissedCount(0, false)).toBe(1);
    expect(nextMissedCount(1, false)).toBe(2);
    expect(nextMissedCount(2, false)).toBe(3);
  });

  it('resets to zero whenever a pong was seen', () => {
    expect(nextMissedCount(0, true)).toBe(0);
    expect(nextMissedCount(1, true)).toBe(0);
    expect(nextMissedCount(5, true)).toBe(0);
  });

  it('reaches the two-missed-pong threshold only after two unanswered ticks', () => {
    const afterOne = nextMissedCount(0, false);
    const afterTwo = nextMissedCount(afterOne, false);

    expect(afterOne).toBeLessThan(MAX_MISSED_PONGS);
    expect(afterTwo).toBe(MAX_MISSED_PONGS);
    expect(MAX_MISSED_PONGS).toBe(2);
  });

  it('never reaches the threshold while pongs keep arriving', () => {
    let missed = 0;
    for (let i = 0; i < 50; i += 1) {
      // One unanswered tick, then an answered one: the counter can never climb.
      missed = nextMissedCount(missed, false);
      missed = nextMissedCount(missed, true);
      expect(missed).toBeLessThan(MAX_MISSED_PONGS);
    }
    expect(missed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Probe cadence — 30 s per interval, within a ±5 s tolerance
//
// The client test environment does no real waiting: the fake clock makes each
// tick's nominal time exact, so the ±5 s tolerance of R11.20 is asserted as a
// tick count — the i-th probe must be the i-th tick and must land inside
// [i*30s - 5s, i*30s + 5s].
//
// **Validates: Requirements 11.20**
// ---------------------------------------------------------------------------

describe('liveness probe cadence (R11.20)', () => {
  const TOLERANCE_MS = 5_000;
  let wss: WebSocketServer;
  let probe: LivenessProbe;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    wss = createServer();
  });

  afterEach(() => {
    probe?.stop();
    wss.close();
    jest.useRealTimers();
  });

  it('declares a 30-second interval', () => {
    expect(LIVENESS_INTERVAL_MS).toBe(30_000);
    expect(LIVENESS_INTERVAL_MS).toBeGreaterThanOrEqual(30_000 - TOLERANCE_MS);
    expect(LIVENESS_INTERVAL_MS).toBeLessThanOrEqual(30_000 + TOLERANCE_MS);
  });

  it('sends no probe before the tolerance window opens and exactly one by the time it closes', () => {
    const ws = createMockWs('cadence-1');
    probe = attachLivenessProbe(wss, { onDead: jest.fn() });
    connectTo(wss, ws);

    jest.advanceTimersByTime(30_000 - TOLERANCE_MS);
    expect(ws.pingTimes).toHaveLength(0);

    jest.advanceTimersByTime(2 * TOLERANCE_MS);
    expect(ws.pingTimes).toHaveLength(1);
  });

  it('sends the i-th probe on the i-th tick, each within 5 seconds of its nominal time', () => {
    const ws = createMockWs('cadence-2');
    probe = attachLivenessProbe(wss, { onDead: jest.fn() });
    connectTo(wss, ws);

    const intervals = 10;
    for (let i = 0; i < intervals; i += 1) {
      advanceIntervals(1);
      // A responsive client answers every probe, so the probe keeps ticking.
      ws.answerProbe();
      expect(ws.pingTimes).toHaveLength(i + 1);
    }

    expect(ws.pingTimes).toHaveLength(intervals);
    ws.pingTimes.forEach((at, index) => {
      const nominal = (index + 1) * LIVENESS_INTERVAL_MS;
      expect(Math.abs(at - nominal)).toBeLessThanOrEqual(TOLERANCE_MS);
    });

    // No drift accumulates and a responsive socket is never torn down.
    expect(ws.terminateCount).toBe(0);
    expect((ws as unknown as { readyState: number }).readyState).toBe(WebSocket.OPEN);
  });

  it('pings every open connection on each tick and skips ones that already closed', () => {
    const open1 = createMockWs('open-1');
    const open2 = createMockWs('open-2');
    const gone = createMockWs('gone');

    probe = attachLivenessProbe(wss, { onDead: jest.fn() });
    [open1, open2, gone].forEach((ws) => connectTo(wss, ws));
    (gone as unknown as { readyState: number }).readyState = WebSocket.CLOSED;

    advanceIntervals(1);

    expect(open1.pingTimes).toHaveLength(1);
    expect(open2.pingTimes).toHaveLength(1);
    expect(gone.pingTimes).toHaveLength(0);
  });

  it('stops ticking once the probe is stopped', () => {
    const ws = createMockWs('stopped');
    probe = attachLivenessProbe(wss, { onDead: jest.fn() });
    connectTo(wss, ws);

    advanceIntervals(1);
    expect(ws.pingTimes).toHaveLength(1);

    probe.stop();
    advanceIntervals(5);
    expect(ws.pingTimes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Two missed pongs — close, remove the participant, broadcast the new state
//
// **Validates: Requirements 11.21**
// ---------------------------------------------------------------------------

describe('two missed pongs remove the participant and broadcast (R11.21)', () => {
  let wss: WebSocketServer;
  let probe: LivenessProbe;
  let sessionId: string;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    resetPokerHandler();
    sessionRegistry._reset();
    jest.restoreAllMocks();

    wss = createServer();
    sessionId = sessionRegistry.createSession(moderatorUser.id, DEFAULT_SESSION_CONFIG)
      .sessionId;
  });

  afterEach(() => {
    probe?.stop();
    wss.close();
    jest.useRealTimers();
    resetPokerHandler();
    sessionRegistry._reset();
  });

  it('keeps an unresponsive socket for the first missed pong and drops it on the second', () => {
    probe = attachLivenessProbe(wss, { onDead: (ws) => removePokerConnection(ws) });

    const alice = joinPoker(wss, aliceUser, sessionId, 'alice');
    const bob = joinPoker(wss, bobUser, sessionId, 'bob');
    const session = sessionRegistry.getSession(sessionId)!;

    // First probe: both sockets are still considered responsive.
    advanceIntervals(1);
    alice.answerProbe();
    expect(bob.terminateCount).toBe(0);

    // One probe went unanswered — under the threshold, so Bob stays.
    advanceIntervals(1);
    alice.answerProbe();
    expect(bob.terminateCount).toBe(0);
    expect(session.getParticipants().map((p) => p.id)).toContain(bobUser.id);

    const aliceSeenBefore = alice.sentMessages.length;

    // Second consecutive unanswered probe: Bob is dropped.
    advanceIntervals(1);
    alice.answerProbe();

    expect(bob.terminateCount).toBe(1);
    expect(bob.closeCount).toBe(0);

    // The participant is gone from the session...
    const remainingIds = session.getParticipants().map((p) => p.id);
    expect(remainingIds).not.toContain(bobUser.id);
    expect(remainingIds).toContain(aliceUser.id);

    // ...and the remaining socket of that session was told.
    const broadcasts = parsedMessages(alice)
      .slice(aliceSeenBefore)
      .filter((m) => m.event === 'participant:left');
    expect(broadcasts).toHaveLength(1);
    expect(
      (broadcasts[0].data.participants as User[]).map((p) => p.id)
    ).not.toContain(bobUser.id);

    // Alice keeps answering, so she is never touched.
    expect(alice.terminateCount).toBe(0);
    expect(alice.pingTimes).toHaveLength(3);
  });

  it('leaves other sessions untouched when a connection dies', () => {
    const otherSessionId = sessionRegistry.createSession(
      moderatorUser.id,
      DEFAULT_SESSION_CONFIG
    ).sessionId;

    probe = attachLivenessProbe(wss, { onDead: (ws) => removePokerConnection(ws) });

    const doomed = joinPoker(wss, aliceUser, sessionId, 'doomed');
    const bystander = joinPoker(wss, bobUser, otherSessionId, 'bystander');

    for (let i = 0; i < 3; i += 1) {
      advanceIntervals(1);
      // Only the bystander, in the other session, answers.
      bystander.answerProbe();
    }

    expect(doomed.terminateCount).toBe(1);
    expect(bystander.terminateCount).toBe(0);

    const otherSession = sessionRegistry.getSession(otherSessionId)!;
    expect(sessionRegistry.getSession(sessionId)!.getParticipants()).toHaveLength(0);
    expect(otherSession.getParticipants().map((p) => p.id)).toContain(bobUser.id);
  });

  it('removes the participant only once every socket of that user is dropped', () => {
    probe = attachLivenessProbe(wss, { onDead: (ws) => removePokerConnection(ws) });

    const tabOne = joinPoker(wss, aliceUser, sessionId, 'alice-tab-1');
    // Same user, second tab: the handler keeps the participant while one socket lives.
    const tabTwo = joinPoker(wss, aliceUser, sessionId, 'alice-tab-2');
    const session = sessionRegistry.getSession(sessionId)!;

    // Only the second tab answers probes.
    advanceIntervals(1);
    tabTwo.answerProbe();
    advanceIntervals(1);
    tabTwo.answerProbe();
    advanceIntervals(1);
    tabTwo.answerProbe();

    expect(tabOne.terminateCount).toBe(1);
    expect(tabTwo.terminateCount).toBe(0);
    expect(session.getParticipants().map((p) => p.id)).toContain(aliceUser.id);

    // The surviving tab goes silent too.
    advanceIntervals(3);
    expect(tabTwo.terminateCount).toBe(1);
    expect(session.getParticipants().map((p) => p.id)).not.toContain(aliceUser.id);
  });
});

// ---------------------------------------------------------------------------
// Per-server independence: the poker and retro probes share no state
//
// **Validates: Requirements 11.22**
// ---------------------------------------------------------------------------

describe('poker and retro probes are independent (R11.22)', () => {
  let pokerWss: WebSocketServer;
  let retroWss: WebSocketServer;
  let pokerProbe: LivenessProbe;
  let retroProbe: LivenessProbe;
  let pokerSessionId: string;
  let retroSessionId: string;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    resetPokerHandler();
    _resetRetroHandler();
    sessionRegistry._reset();
    retroSessionRegistry._reset();
    jest.restoreAllMocks();

    pokerWss = createServer();
    retroWss = createServer();

    // Exactly the wiring server.ts performs, minus the real listening socket.
    pokerProbe = attachLivenessProbe(pokerWss, {
      onDead: (ws) => removePokerConnection(ws),
    });
    retroProbe = attachLivenessProbe(retroWss, {
      onDead: (ws) => removeRetroConnection(ws),
    });

    pokerSessionId = sessionRegistry.createSession(moderatorUser.id, DEFAULT_SESSION_CONFIG)
      .sessionId;
    retroSessionId = retroSessionRegistry.createSession(moderatorUser.id, retroConfig)
      .sessionId;
  });

  afterEach(() => {
    pokerProbe?.stop();
    retroProbe?.stop();
    pokerWss.close();
    retroWss.close();
    jest.useRealTimers();
    resetPokerHandler();
    _resetRetroHandler();
    sessionRegistry._reset();
    retroSessionRegistry._reset();
  });

  it('closing a poker connection leaves retro connections open and their session intact', () => {
    const pokerSocket = joinPoker(pokerWss, aliceUser, pokerSessionId, 'poker-dead');
    const retroSocket = joinRetro(retroWss, aliceUser, retroSessionId, 'retro-live');

    for (let i = 0; i < 3; i += 1) {
      advanceIntervals(1);
      // Only the retro client answers.
      retroSocket.answerProbe();
    }

    expect(pokerSocket.terminateCount).toBe(1);
    expect(sessionRegistry.getSession(pokerSessionId)!.getParticipants()).toHaveLength(0);

    expect(retroSocket.terminateCount).toBe(0);
    expect((retroSocket as unknown as { readyState: number }).readyState).toBe(
      WebSocket.OPEN
    );
    expect(
      retroSessionRegistry.getSession(retroSessionId)!.getParticipants().map((p) => p.id)
    ).toContain(aliceUser.id);
  });

  it('closing a retro connection leaves poker connections open and their session intact', () => {
    const pokerSocket = joinPoker(pokerWss, aliceUser, pokerSessionId, 'poker-live');
    const retroSocket = joinRetro(retroWss, aliceUser, retroSessionId, 'retro-dead');

    for (let i = 0; i < 3; i += 1) {
      advanceIntervals(1);
      pokerSocket.answerProbe();
    }

    expect(retroSocket.terminateCount).toBe(1);
    expect(
      retroSessionRegistry.getSession(retroSessionId)!.getParticipants()
    ).toHaveLength(0);

    expect(pokerSocket.terminateCount).toBe(0);
    expect(
      sessionRegistry.getSession(pokerSessionId)!.getParticipants().map((p) => p.id)
    ).toContain(aliceUser.id);
  });

  it('tracks missed counts per server, so a silent socket on one does not age one on the other', () => {
    const pokerSocket = joinPoker(pokerWss, aliceUser, pokerSessionId, 'poker-silent');
    const retroSocket = joinRetro(retroWss, bobUser, retroSessionId, 'retro-silent');

    // Both eventually go silent, but the retro socket answers once on the way:
    // each probe keeps its own counter, so they die on different ticks.
    advanceIntervals(2);
    expect(pokerSocket.terminateCount).toBe(0);
    retroSocket.answerProbe();

    // Tick 3: the poker counter reaches two, the retro one was just reset.
    advanceIntervals(1);
    expect(pokerSocket.terminateCount).toBe(1);
    expect(retroSocket.terminateCount).toBe(0);

    // Tick 4: one missed probe on the retro side, still under the threshold.
    advanceIntervals(1);
    expect(retroSocket.terminateCount).toBe(0);

    // Tick 5: two consecutive missed probes, so the retro socket goes too.
    advanceIntervals(1);
    expect(retroSocket.terminateCount).toBe(1);
  });

  it('stopping one probe leaves the other probing', () => {
    const pokerSocket = joinPoker(pokerWss, aliceUser, pokerSessionId, 'poker-keep');
    const retroSocket = joinRetro(retroWss, aliceUser, retroSessionId, 'retro-keep');

    pokerProbe.stop();

    advanceIntervals(1);
    retroSocket.answerProbe();
    advanceIntervals(1);
    retroSocket.answerProbe();

    expect(pokerSocket.pingTimes).toHaveLength(0);
    expect(retroSocket.pingTimes).toHaveLength(2);
    expect(pokerSocket.terminateCount).toBe(0);
  });
});
