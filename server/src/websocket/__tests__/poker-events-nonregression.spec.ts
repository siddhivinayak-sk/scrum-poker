import { IncomingMessage } from 'http';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  CALLOUT_NOTE_ADDED,
  CALLOUT_NOTE_SUBMIT,
  DEFAULT_SESSION_CONFIG,
  ExtendedCardValue,
  SessionConfiguration,
  User,
  WebSocketMessage,
} from '../../../../shared/types';
import { handleWebSocket, broadcastConfigUpdate, _reset as resetHandler } from '../handler';
import * as authService from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';

/**
 * WebSocket non-regression net for the vote-reveal callouts feature (Requirement 13.3).
 *
 * Every pre-existing poker event is driven through the real handler, SessionRegistry and
 * GameSession with in-memory sockets, and what each one puts on the wire is compared with a
 * hand-recorded baseline: the event NAME, the payload KEY SET and the RECIPIENT SET. The
 * baselines below are written out by hand rather than derived from the code, so a field
 * added to a pre-existing payload (for example a note collection on `cards:revealed`) or a
 * widened recipient set makes a test fail instead of moving the baseline with it.
 *
 * Two cross-cutting rules hold for every captured action: nothing reaches a connection of
 * the second, unrelated session, and no `callout:*` event is emitted by a pre-existing flow.
 *
 * Validates: Requirements 13.3, 13.4
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type MockWs = WebSocket & { sentMessages: string[] };

function createMockWs(): MockWs {
  const mock = new EventEmitter() as unknown as MockWs;
  Object.assign(mock, {
    readyState: WebSocket.OPEN,
    sentMessages: [] as string[],
    send: jest.fn((data: string) => {
      mock.sentMessages.push(data);
    }),
    close: jest.fn(),
  });
  return mock;
}

function createRequest(token: string, sessionId: string): IncomingMessage {
  return {
    url: `/?token=${token}&sessionId=${sessionId}`,
    headers: { host: 'localhost:3000' },
  } as unknown as IncomingMessage;
}

function user(id: string, displayName: string, role: User['role'] = 'participant'): User {
  return { id, displayName, role, isAnonymous: false };
}

/** Socket -> display name, for every socket opened by the current test. */
const names = new Map<MockWs, string>();

function connect(sessionId: string, u: User): MockWs {
  // A copy: the handler mutates the participant object on `role:change`, which must not
  // leak into the module-level fixtures shared by the other tests.
  jest.spyOn(authService, 'validateToken').mockReturnValueOnce({ ...u });
  const ws = createMockWs();
  names.set(ws, u.displayName);
  handleWebSocket(ws, createRequest(`token-${u.id}`, sessionId));
  return ws;
}

function send(ws: MockWs, event: string, data: unknown): void {
  ws.emit('message', JSON.stringify({ event, data, timestamp: new Date().toISOString() }));
}

function parsed(ws: MockWs, from = 0): WebSocketMessage[] {
  return ws.sentMessages.slice(from).map((raw) => JSON.parse(raw) as WebSocketMessage);
}

function lastOf(ws: MockWs, event: string): WebSocketMessage {
  const all = parsed(ws).filter((m) => m.event === event);
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1];
}

interface Observed {
  keys: string[];
  recipients: string[];
}
type ObservedMap = Record<string, Observed>;

const OTHER_SESSION_MEMBER = 'Zed';

/**
 * Runs `action` and returns, per event name, the sorted payload key set and the sorted
 * recipient set of every message sent while it ran. Also enforces the two cross-cutting
 * rules: no message reaches the unrelated session, and no `callout:*` event appears.
 */
function capture(action: () => void): ObservedMap {
  const starts = new Map<MockWs, number>();
  for (const ws of names.keys()) starts.set(ws, ws.sentMessages.length);

  action();

  const recipients = new Map<string, Set<string>>();
  const keys = new Map<string, string[]>();
  for (const [ws, name] of names) {
    for (const msg of parsed(ws, starts.get(ws) ?? 0)) {
      const payloadKeys = Object.keys((msg.data ?? {}) as Record<string, unknown>).sort();
      const seen = keys.get(msg.event);
      if (seen) {
        // The same event must keep one shape across all of its recipients.
        expect({ event: msg.event, keys: payloadKeys }).toEqual({ event: msg.event, keys: seen });
      } else {
        keys.set(msg.event, payloadKeys);
        recipients.set(msg.event, new Set());
      }
      recipients.get(msg.event)!.add(name);
    }
  }

  const observed: ObservedMap = {};
  for (const [event, eventKeys] of keys) {
    observed[event] = { keys: eventKeys, recipients: [...recipients.get(event)!].sort() };
  }

  for (const event of Object.keys(observed)) {
    expect(event.startsWith('callout:')).toBe(false);
    expect(observed[event].recipients).not.toContain(OTHER_SESSION_MEMBER);
  }
  return observed;
}

// ---------------------------------------------------------------------------
// Recorded baselines
// ---------------------------------------------------------------------------

const ROOM = ['Alice', 'Bob', 'Mod'];
const METRIC_KEYS = [
  'average',
  'distribution',
  'insufficientData',
  'mode',
  'numericVoteCount',
  'outliers',
  'spread',
];
/** Fields of a round as sent on `round:started`, before any note exists. */
const ROUND_KEYS = ['id', 'selections', 'startedAt', 'status', 'storyDescription'];
/** Fields of a revealed round as it appears in `session:state`. */
const REVEALED_ROUND_KEYS = [...ROUND_KEYS, 'revealedAt', 'votingDurationMs'].sort();
/** Fields of a history entry after a revealed round is cleared. */
const HISTORY_ENTRY_KEYS = [
  'completedAt',
  'metrics',
  'participants',
  'roundId',
  'storyDescription',
  'votingDurationMs',
];
const SESSION_STATE_KEYS = [
  'config',
  'createdAt',
  'currentRound',
  'history',
  'isRevealed',
  'issueList',
  'ownerId',
  'participants',
  'sessionId',
];
const USER_KEYS = ['displayName', 'id', 'isAnonymous', 'role'];
const ISSUE_KEYS = ['createdAt', 'id', 'status', 'title'];

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const mod = user('nr-mod', 'Mod', 'moderator');
const alice = user('nr-alice', 'Alice');
const bob = user('nr-bob', 'Bob');
const zed = user('nr-zed', OTHER_SESSION_MEMBER, 'moderator');

interface Room {
  sessionId: string;
  mod: MockWs;
  alice: MockWs;
  bob: MockWs;
  zed: MockWs;
  zedSessionId: string;
}

function createRoom(config: Partial<SessionConfiguration> = {}): Room {
  const { sessionId } = sessionRegistry.createSession(mod.id, { ...DEFAULT_SESSION_CONFIG, ...config });
  const other = sessionRegistry.createSession(zed.id, { ...DEFAULT_SESSION_CONFIG });
  return {
    sessionId,
    zedSessionId: other.sessionId,
    mod: connect(sessionId, mod),
    alice: connect(sessionId, alice),
    bob: connect(sessionId, bob),
    zed: connect(other.sessionId, zed),
  };
}

function startStory(room: Room, story = 'Baseline story'): string {
  send(room.mod, 'story:submit', { storyDescription: story });
  return (lastOf(room.mod, 'round:started').data as { round: { id: string } }).round.id;
}

function vote(ws: MockWs, cardValue: ExtendedCardValue): void {
  send(ws, 'card:select', { cardValue });
}

/** Starts a story, has Alice and Bob vote, and reveals. Returns the round id. */
function revealedRound(room: Room): string {
  const roundId = startStory(room);
  vote(room.alice, 5);
  vote(room.bob, 8);
  send(room.mod, 'cards:reveal', {});
  return roundId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Poker WebSocket events — non-regression against recorded baselines', () => {
  beforeEach(() => {
    resetHandler();
    sessionRegistry._reset();
    names.clear();
    jest.restoreAllMocks();
  });

  describe('round flow', () => {
    it('story:submit -> round:started {round} to the whole session, round carries no note field', () => {
      const room = createRoom();
      const observed = capture(() => send(room.mod, 'story:submit', { storyDescription: 'S' }));

      expect(observed).toEqual({ 'round:started': { keys: ['round'], recipients: ROOM } });
      const round = (lastOf(room.alice, 'round:started').data as { round: Record<string, unknown> }).round;
      expect(Object.keys(round).sort()).toEqual(ROUND_KEYS);
    });

    it('card:select -> card:voted {userId} to the whole session', () => {
      const room = createRoom();
      startStory(room);
      const observed = capture(() => vote(room.alice, 5));

      expect(observed).toEqual({ 'card:voted': { keys: ['userId'], recipients: ROOM } });
    });

    it('cards:reveal -> cards:revealed gains no field and goes to the whole session', () => {
      const room = createRoom();
      startStory(room);
      vote(room.alice, 5);
      vote(room.bob, 8);
      const observed = capture(() => send(room.mod, 'cards:reveal', {}));

      expect(observed).toEqual({
        'cards:revealed': { keys: ['metrics', 'selections'], recipients: ROOM },
      });
      const payload = lastOf(room.bob, 'cards:revealed').data as {
        metrics: Record<string, unknown>;
        selections: Record<string, unknown>;
      };
      expect(Object.keys(payload.metrics).sort()).toEqual(METRIC_KEYS);
      expect(payload.selections).toEqual({ 'nr-alice': 5, 'nr-bob': 8 });
    });

    it('cards:revealed still carries exactly metrics and selections when notes exist on the round', () => {
      const room = createRoom();
      const roundId = startStory(room);
      vote(room.alice, 5);
      send(room.alice, CALLOUT_NOTE_SUBMIT, { sessionId: room.sessionId, roundId, text: 'a note' });
      expect(parsed(room.bob).some((m) => m.event === CALLOUT_NOTE_ADDED)).toBe(true);

      const observed = capture(() => send(room.mod, 'cards:reveal', {}));

      expect(observed).toEqual({
        'cards:revealed': { keys: ['metrics', 'selections'], recipients: ROOM },
      });
    });

    it('board:clear -> board:cleared {historyEntry} to the whole session, entry carries no note field', () => {
      const room = createRoom();
      revealedRound(room);
      const observed = capture(() => send(room.mod, 'board:clear', {}));

      expect(observed).toEqual({ 'board:cleared': { keys: ['historyEntry'], recipients: ROOM } });
      const entry = (lastOf(room.alice, 'board:cleared').data as { historyEntry: Record<string, unknown> })
        .historyEntry;
      expect(Object.keys(entry).sort()).toEqual(HISTORY_ENTRY_KEYS);
    });

    it('round:revote -> round:started {round} to the whole session', () => {
      const room = createRoom();
      revealedRound(room);
      const observed = capture(() => send(room.mod, 'round:revote', {}));

      expect(observed).toEqual({ 'round:started': { keys: ['round'], recipients: ROOM } });
    });

    it('history:clear -> history:cleared {} to the whole session', () => {
      const room = createRoom();
      revealedRound(room);
      send(room.mod, 'board:clear', {});
      const observed = capture(() => send(room.mod, 'history:clear', {}));

      expect(observed).toEqual({ 'history:cleared': { keys: [], recipients: ROOM } });
    });
  });

  describe('auto reveal', () => {
    it('with the countdown on: the last vote adds auto:reveal-triggered {countdown}, no cards:revealed', () => {
      const room = createRoom({ autoReveal: true, countdownAnimation: true });
      startStory(room);
      vote(room.mod, 3);
      vote(room.alice, 5);
      const observed = capture(() => vote(room.bob, 8));

      expect(observed).toEqual({
        'card:voted': { keys: ['userId'], recipients: ROOM },
        'auto:reveal-triggered': { keys: ['countdown'], recipients: ROOM },
      });
    });

    it('with the countdown off: auto:reveal-triggered is followed by an unchanged cards:revealed', () => {
      const room = createRoom({ autoReveal: true, countdownAnimation: false });
      startStory(room);
      vote(room.mod, 3);
      vote(room.alice, 5);
      const observed = capture(() => vote(room.bob, 8));

      expect(observed).toEqual({
        'card:voted': { keys: ['userId'], recipients: ROOM },
        'auto:reveal-triggered': { keys: ['countdown'], recipients: ROOM },
        'cards:revealed': { keys: ['metrics', 'selections'], recipients: ROOM },
      });
    });
  });

  describe('participant flow', () => {
    it('role:change -> role:changed {user} to the whole session', () => {
      const room = createRoom();
      const observed = capture(() => send(room.alice, 'role:change', { role: 'moderator' }));

      expect(observed).toEqual({ 'role:changed': { keys: ['user'], recipients: ROOM } });
      const changed = (lastOf(room.bob, 'role:changed').data as { user: Record<string, unknown> }).user;
      expect(Object.keys(changed).sort()).toEqual(USER_KEYS);
    });

    it('participant:remove -> participant:removed {reason} to the target, participant:left to the rest', () => {
      const room = createRoom();
      const observed = capture(() => send(room.mod, 'participant:remove', { userId: bob.id }));

      expect(observed).toEqual({
        'participant:removed': { keys: ['reason'], recipients: ['Bob'] },
        'participant:left': { keys: ['participants'], recipients: ['Alice', 'Mod'] },
      });
    });

    it('a new connection -> session:state {state} to it alone and participant:joined {participants} to the session', () => {
      const room = createRoom();
      let carol: MockWs | undefined;
      const observed = capture(() => {
        carol = connect(room.sessionId, user('nr-carol', 'Carol'));
      });

      expect(carol).toBeDefined();
      expect(observed).toEqual({
        'session:state': { keys: ['state'], recipients: ['Carol'] },
        'participant:joined': { keys: ['participants'], recipients: ['Alice', 'Bob', 'Carol', 'Mod'] },
      });
    });

    it('a closed connection -> participant:left {participants} to the remaining session', () => {
      const room = createRoom();
      const observed = capture(() => room.bob.emit('close'));

      expect(observed).toEqual({ 'participant:left': { keys: ['participants'], recipients: ['Alice', 'Mod'] } });
    });
  });

  describe('issue flow', () => {
    it('issue:add / issue:select / issue:reorder / issue:remove -> issue:list-updated {issues} (+ round:started on select)', () => {
      const room = createRoom();

      const added = capture(() => send(room.mod, 'issue:add', { titles: ['First', 'Second'] }));
      expect(added).toEqual({ 'issue:list-updated': { keys: ['issues'], recipients: ROOM } });
      const issues = (lastOf(room.mod, 'issue:list-updated').data as { issues: Array<Record<string, unknown>> })
        .issues;
      expect(issues).toHaveLength(2);
      expect(Object.keys(issues[0]).sort()).toEqual(ISSUE_KEYS);
      const ids = issues.map((i) => i.id as string);

      const reordered = capture(() => send(room.mod, 'issue:reorder', { orderedIds: [ids[1], ids[0]] }));
      expect(reordered).toEqual({ 'issue:list-updated': { keys: ['issues'], recipients: ROOM } });

      const selected = capture(() => send(room.mod, 'issue:select', { issueId: ids[0] }));
      expect(selected).toEqual({
        'round:started': { keys: ['round'], recipients: ROOM },
        'issue:list-updated': { keys: ['issues'], recipients: ROOM },
      });

      const removed = capture(() => send(room.mod, 'issue:remove', { issueId: ids[1] }));
      expect(removed).toEqual({ 'issue:list-updated': { keys: ['issues'], recipients: ROOM } });
    });
  });

  describe('configuration', () => {
    it('session:config-updated -> {config} to the whole session', () => {
      const room = createRoom();
      const observed = capture(() =>
        broadcastConfigUpdate(room.sessionId, { ...DEFAULT_SESSION_CONFIG, autoReveal: true })
      );

      expect(observed).toEqual({ 'session:config-updated': { keys: ['config'], recipients: ROOM } });
    });
  });

  describe('errors', () => {
    it('a rejected pre-existing action -> error {code, message} to the sender only', () => {
      const room = createRoom();
      startStory(room);

      const unauthorised = capture(() => send(room.alice, 'cards:reveal', {}));
      expect(unauthorised).toEqual({ error: { keys: ['code', 'message'], recipients: ['Alice'] } });

      const invalidCard = capture(() => send(room.alice, 'card:select', { cardValue: 4 }));
      expect(invalidCard).toEqual({ error: { keys: ['code', 'message'], recipients: ['Alice'] } });
    });

    it('an unknown event still answers UNKNOWN_EVENT on the generic error channel, to the sender only', () => {
      const room = createRoom();
      const observed = capture(() => send(room.alice, 'definitely:not:an:event', {}));

      expect(observed).toEqual({ error: { keys: ['code', 'message'], recipients: ['Alice'] } });
      expect((lastOf(room.alice, 'error').data as { code: string }).code).toBe('UNKNOWN_EVENT');
    });
  });

  describe('session:state', () => {
    it('carries exactly the pre-existing top-level fields when no round and no note exist', () => {
      const room = createRoom();
      const state = (lastOf(room.alice, 'session:state').data as { state: Record<string, unknown> }).state;

      expect(Object.keys(state).sort()).toEqual(SESSION_STATE_KEYS);
      expect(state.currentRound).toBeNull();
      expect(state.history).toEqual([]);
    });

    it('a revealed round and a saved history entry add no field beyond the optional calloutNotes', () => {
      const room = createRoom();
      const roundId = revealedRound(room);
      send(room.mod, 'board:clear', {});
      const secondRoundId = startStory(room, 'Second story');

      let late: MockWs | undefined;
      capture(() => {
        late = connect(room.sessionId, user('nr-late', 'Late'));
      });
      const withoutNotes = (lastOf(late!, 'session:state').data as {
        state: { currentRound: Record<string, unknown>; history: Array<Record<string, unknown>> };
      }).state;
      expect(Object.keys(withoutNotes.currentRound).sort()).toEqual(ROUND_KEYS);
      expect(Object.keys(withoutNotes.history[0]).sort()).toEqual(HISTORY_ENTRY_KEYS);

      // Notes on both the current round and the saved one add only `calloutNotes`.
      send(room.alice, CALLOUT_NOTE_SUBMIT, { sessionId: room.sessionId, roundId: secondRoundId, text: 'now' });
      send(room.alice, CALLOUT_NOTE_SUBMIT, { sessionId: room.sessionId, roundId, text: 'then' });
      const later = connect(room.sessionId, user('nr-later', 'Later'));
      const withNotes = (lastOf(later, 'session:state').data as {
        state: Record<string, unknown> & {
          currentRound: Record<string, unknown>;
          history: Array<Record<string, unknown>>;
        };
      }).state;

      expect(Object.keys(withNotes).sort()).toEqual(SESSION_STATE_KEYS);
      expect(Object.keys(withNotes.currentRound).sort()).toEqual([...ROUND_KEYS, 'calloutNotes'].sort());
      expect(Object.keys(withNotes.history[0]).sort()).toEqual([...HISTORY_ENTRY_KEYS, 'calloutNotes'].sort());
      expect(Array.isArray(withNotes.currentRound.calloutNotes)).toBe(true);
      expect(Array.isArray(withNotes.history[0].calloutNotes)).toBe(true);
    });

    it('a revealed current round keeps its pre-existing fields', () => {
      const room = createRoom();
      revealedRound(room);
      const late = connect(room.sessionId, user('nr-late', 'Late'));
      const state = (lastOf(late, 'session:state').data as {
        state: { currentRound: Record<string, unknown>; isRevealed: boolean };
      }).state;

      expect(Object.keys(state.currentRound).sort()).toEqual(REVEALED_ROUND_KEYS);
      expect(state.isRevealed).toBe(true);
    });
  });
});
