import { IncomingMessage } from 'http';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  CALLOUT_NOTE_ADDED,
  CALLOUT_NOTE_REJECTED,
  CALLOUT_NOTE_SUBMIT,
  CalloutNote,
  CalloutNoteAddedPayload,
  CalloutNoteRejectedPayload,
  DEFAULT_SESSION_CONFIG,
  ExtendedCardValue,
  HistoryEntry,
  NOTE_MAX_LENGTH,
  SessionConfiguration,
  User,
  VotingMetrics,
  WebSocketMessage,
} from '../../../../shared/types';
import { buildEstimateExportCsv } from '../../../../shared/estimate-export';
import { handleWebSocket, _reset as resetHandler } from '../handler';
import * as authService from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import { GameSession } from '../../services/game-session';

/**
 * End-to-end server flow for the vote-reveal callouts, driven through the real
 * WebSocket handler, SessionRegistry and GameSession with in-memory sockets.
 *
 * Covers: reveal metrics per voting system (power-of-2 outliers, t-shirt insufficient
 * data), note submit -> callout:note:added to the session only, rejections to the sender
 * only, unchanged cards:revealed payload keys, notes carried into history, notes on a
 * history round, and an export that is identical with and without notes.
 *
 * Validates: Requirements 10.4, 10.5, 10.10, 10.16, 13.3, 13.4, 14.9, 15.4
 */

// ---------------------------------------------------------------------------
// Helpers
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

function messagesOf(ws: MockWs, event: string): WebSocketMessage[] {
  return ws.sentMessages.map((m) => JSON.parse(m) as WebSocketMessage).filter((m) => m.event === event);
}

function lastOf(ws: MockWs, event: string): WebSocketMessage {
  const all = messagesOf(ws, event);
  expect(all.length).toBeGreaterThan(0);
  return all[all.length - 1];
}

function send(ws: MockWs, event: string, data: unknown): void {
  ws.emit('message', JSON.stringify({ event, data, timestamp: new Date().toISOString() }));
}

function user(id: string, displayName: string, role: User['role'] = 'participant'): User {
  return { id, displayName, role, isAnonymous: false };
}

function connect(sessionId: string, u: User): MockWs {
  jest.spyOn(authService, 'validateToken').mockReturnValueOnce(u);
  const ws = createMockWs();
  handleWebSocket(ws, createRequest(`token-${u.id}`, sessionId));
  return ws;
}

/** Number of messages of `event` a socket received, across all of its traffic. */
function count(ws: MockWs, event: string): number {
  return messagesOf(ws, event).length;
}

interface Room {
  sessionId: string;
  session: GameSession;
  owner: MockWs;
  /** Sockets by display name, owner included. */
  sockets: Record<string, MockWs>;
  all: MockWs[];
}

/** Creates a session for `votingSystem`, connects the owner plus the named participants. */
function createRoom(
  votingSystem: SessionConfiguration['votingSystem'],
  ownerUser: User,
  participants: User[]
): Room {
  const { sessionId } = sessionRegistry.createSession(ownerUser.id, {
    ...DEFAULT_SESSION_CONFIG,
    votingSystem,
  });
  const session = sessionRegistry.getSession(sessionId)!;
  const owner = connect(sessionId, ownerUser);
  const sockets: Record<string, MockWs> = { [ownerUser.displayName]: owner };
  for (const p of participants) {
    sockets[p.displayName] = connect(sessionId, p);
  }
  return { sessionId, session, owner, sockets, all: Object.values(sockets) };
}

/** Owner submits a story; returns the id of the round the server started. */
function startStory(room: Room, story: string): string {
  send(room.owner, 'story:submit', { storyDescription: story });
  const started = lastOf(room.owner, 'round:started').data as { round: { id: string } };
  return started.round.id;
}

function vote(room: Room, name: string, cardValue: ExtendedCardValue): void {
  send(room.sockets[name], 'card:select', { cardValue });
}

function revealPayload(room: Room): { selections: Record<string, ExtendedCardValue>; metrics: VotingMetrics } {
  send(room.owner, 'cards:reveal', {});
  return lastOf(room.owner, 'cards:revealed').data as {
    selections: Record<string, ExtendedCardValue>;
    metrics: VotingMetrics;
  };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const modP2 = user('p2-mod', 'Moderator', 'moderator');
const p2Users = [
  user('p2-alice', 'Alice'),
  user('p2-bob', 'Bob'),
  user('p2-carol', 'Carol'),
  user('p2-dave', 'Dave'),
];

const modTs = user('ts-mod', 'Facilitator', 'moderator');
const tsUsers = [user('ts-erin', 'Erin'), user('ts-frank', 'Frank')];

const METRIC_KEYS = [
  'average',
  'distribution',
  'insufficientData',
  'mode',
  'numericVoteCount',
  'outliers',
  'spread',
];

describe('Vote reveal callouts — server end-to-end flow', () => {
  beforeEach(() => {
    resetHandler();
    sessionRegistry._reset();
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Reveal with metrics for the session's voting system
  // -------------------------------------------------------------------------

  describe('reveal metrics per voting system', () => {
    it('power-of-2: flags the divergent vote as an outlier and keeps the payload keys unchanged', () => {
      const room = createRoom('power-of-2', modP2, p2Users);
      startStory(room, 'Power of two story');
      vote(room, 'Moderator', 1);
      vote(room, 'Alice', 1);
      vote(room, 'Bob', 2);
      vote(room, 'Carol', 2);
      vote(room, 'Dave', 64);

      const payload = revealPayload(room);

      // R13.3: the cards:revealed payload carries exactly these two keys, no notes.
      expect(Object.keys(payload).sort()).toEqual(['metrics', 'selections']);
      expect(Object.keys(payload.metrics).sort()).toEqual(METRIC_KEYS);
      expect(payload.selections).toEqual({
        'p2-mod': 1,
        'p2-alice': 1,
        'p2-bob': 2,
        'p2-carol': 2,
        'p2-dave': 64,
      });

      // R15.4: 64 sits 6 ladder steps from the mode (1) on [0,1,2,4,8,16,32,64].
      expect(payload.metrics.outliers).toEqual(['p2-dave']);
      expect(payload.metrics.insufficientData).toBe(false);
      expect(payload.metrics.numericVoteCount).toBe(5);
      expect(payload.metrics.mode).toBe(1);
      expect(payload.metrics.average).toBeCloseTo(14, 10);
      expect(payload.metrics.spread).toBe(63);
      expect(payload.metrics.distribution).toEqual({ '1': 2, '2': 2, '64': 1 });
    });

    it('every client in the session receives the identical cards:revealed message', () => {
      const room = createRoom('power-of-2', modP2, p2Users);
      startStory(room, 'Story');
      vote(room, 'Moderator', 1);
      vote(room, 'Dave', 64);

      revealPayload(room);

      const payloads = room.all.map((ws) => {
        expect(count(ws, 'cards:revealed')).toBe(1);
        return messagesOf(ws, 'cards:revealed')[0].data;
      });
      for (const p of payloads) {
        expect(p).toEqual(payloads[0]);
      }
    });

    it('t-shirt: reports insufficient data with null average, mode and spread', () => {
      const room = createRoom('t-shirt', modTs, tsUsers);
      startStory(room, 'T-shirt story');
      vote(room, 'Facilitator', 'M');
      vote(room, 'Erin', 'L');
      vote(room, 'Frank', 'XL');

      const payload = revealPayload(room);

      expect(Object.keys(payload).sort()).toEqual(['metrics', 'selections']);
      expect(payload.metrics.insufficientData).toBe(true); // R14.9
      expect(payload.metrics.average).toBeNull();
      expect(payload.metrics.mode).toBeNull();
      expect(payload.metrics.spread).toBeNull();
      expect(payload.metrics.outliers).toEqual([]);
      expect(payload.metrics.numericVoteCount).toBe(0);
      expect(payload.metrics.distribution).toEqual({ M: 1, L: 1, XL: 1 });
      // JSON round trip keeps nulls as null, never NaN.
      expect(JSON.stringify(payload.metrics)).not.toContain('NaN');
    });
  });

  // -------------------------------------------------------------------------
  // Note submit -> broadcast, scoped to the session
  // -------------------------------------------------------------------------

  describe('note submit and broadcast', () => {
    it('stores a note on the current round and broadcasts callout:note:added to that session only', () => {
      const room = createRoom('power-of-2', modP2, p2Users);
      const other = createRoom('t-shirt', modTs, tsUsers);
      const roundId = startStory(room, 'Story');
      startStory(other, 'Other story');
      vote(room, 'Moderator', 1);
      vote(room, 'Dave', 64);
      revealPayload(room);

      send(room.sockets['Dave'], CALLOUT_NOTE_SUBMIT, {
        sessionId: room.sessionId,
        roundId,
        text: '  I assumed we also migrate the data  ',
      });

      // R10.4: every connection in the session receives it, with the author name.
      for (const ws of room.all) {
        const added = messagesOf(ws, CALLOUT_NOTE_ADDED);
        expect(added).toHaveLength(1);
        const data = added[0].data as CalloutNoteAddedPayload;
        expect(data.roundId).toBe(roundId);
        expect(data.note).toMatchObject({
          roundId,
          authorId: 'p2-dave',
          authorName: 'Dave',
          text: 'I assumed we also migrate the data',
        });
      }
      // R13.4: zero callout messages reach the other session.
      for (const ws of other.all) {
        expect(count(ws, CALLOUT_NOTE_ADDED)).toBe(0);
        expect(count(ws, CALLOUT_NOTE_REJECTED)).toBe(0);
      }
      expect(room.session.getCurrentRound()?.calloutNotes).toHaveLength(1);
      expect(other.session.getCurrentRound()?.calloutNotes).toBeUndefined();
    });

    it('accepts a note of exactly 280 trimmed characters and rejects 281', () => {
      const room = createRoom('power-of-2', modP2, p2Users);
      const roundId = startStory(room, 'Story');

      send(room.sockets['Bob'], CALLOUT_NOTE_SUBMIT, {
        sessionId: room.sessionId,
        roundId,
        text: 'x'.repeat(NOTE_MAX_LENGTH + 1),
      });
      expect(count(room.sockets['Bob'], CALLOUT_NOTE_REJECTED)).toBe(1);
      expect(room.session.getCurrentRound()?.calloutNotes ?? []).toHaveLength(0);

      send(room.sockets['Bob'], CALLOUT_NOTE_SUBMIT, {
        sessionId: room.sessionId,
        roundId,
        text: ` ${'x'.repeat(NOTE_MAX_LENGTH)} `,
      });
      expect(count(room.sockets['Bob'], CALLOUT_NOTE_ADDED)).toBe(1);
      expect(room.session.getCurrentRound()?.calloutNotes).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Rejections reach the sender only
  // -------------------------------------------------------------------------

  describe('rejections go to the sender only', () => {
    it.each([
      ['empty after trim', 'NOTE_EMPTY', '   '],
      ['281 characters', 'NOTE_TOO_LONG', 'y'.repeat(NOTE_MAX_LENGTH + 1)],
    ])('%s -> %s to the sender, nothing stored, nothing broadcast', (_label, code, text) => {
      const room = createRoom('power-of-2', modP2, p2Users);
      const roundId = startStory(room, 'Story');

      send(room.sockets['Carol'], CALLOUT_NOTE_SUBMIT, { sessionId: room.sessionId, roundId, text });

      const rejected = messagesOf(room.sockets['Carol'], CALLOUT_NOTE_REJECTED);
      expect(rejected).toHaveLength(1);
      expect((rejected[0].data as CalloutNoteRejectedPayload).code).toBe(code);
      for (const ws of room.all) {
        expect(count(ws, CALLOUT_NOTE_ADDED)).toBe(0);
        if (ws !== room.sockets['Carol']) {
          expect(count(ws, CALLOUT_NOTE_REJECTED)).toBe(0);
        }
      }
      // Rejections never use the generic error channel (no toast on the client).
      expect(count(room.sockets['Carol'], 'error')).toBe(0);
      expect(room.session.getCurrentRound()?.calloutNotes ?? []).toHaveLength(0);
    });

    it('unknown round -> NOTE_ROUND_UNKNOWN to the sender only', () => {
      const room = createRoom('power-of-2', modP2, p2Users);
      startStory(room, 'Story');

      send(room.sockets['Alice'], CALLOUT_NOTE_SUBMIT, {
        sessionId: room.sessionId,
        roundId: 'no-such-round',
        text: 'hello',
      });

      const rejected = messagesOf(room.sockets['Alice'], CALLOUT_NOTE_REJECTED);
      expect(rejected).toHaveLength(1);
      expect((rejected[0].data as CalloutNoteRejectedPayload).code).toBe('NOTE_ROUND_UNKNOWN');
      for (const ws of room.all.filter((w) => w !== room.sockets['Alice'])) {
        expect(count(ws, CALLOUT_NOTE_REJECTED)).toBe(0);
      }
    });

    it('second note from the same author -> NOTE_DUPLICATE to the sender only, stored note unchanged', () => {
      const room = createRoom('power-of-2', modP2, p2Users);
      const roundId = startStory(room, 'Story');
      send(room.sockets['Dave'], CALLOUT_NOTE_SUBMIT, { sessionId: room.sessionId, roundId, text: 'first' });

      send(room.sockets['Dave'], CALLOUT_NOTE_SUBMIT, { sessionId: room.sessionId, roundId, text: 'second' });

      const rejected = messagesOf(room.sockets['Dave'], CALLOUT_NOTE_REJECTED);
      expect(rejected).toHaveLength(1);
      expect((rejected[0].data as CalloutNoteRejectedPayload).code).toBe('NOTE_DUPLICATE');
      expect(count(room.sockets['Alice'], CALLOUT_NOTE_ADDED)).toBe(1); // only the first
      expect(room.session.getCurrentRound()?.calloutNotes?.map((n) => n.text)).toEqual(['first']);
    });

    it('session mismatch -> rejected to the sender only, and the other session is untouched (R13.13)', () => {
      const room = createRoom('power-of-2', modP2, p2Users);
      const other = createRoom('t-shirt', modTs, tsUsers);
      const roundId = startStory(room, 'Story');
      const otherRoundId = startStory(other, 'Other story');

      // Dave is joined to `room` but names the other session and its round.
      send(room.sockets['Dave'], CALLOUT_NOTE_SUBMIT, {
        sessionId: other.sessionId,
        roundId: otherRoundId,
        text: 'sneaky',
      });

      const rejected = messagesOf(room.sockets['Dave'], CALLOUT_NOTE_REJECTED);
      expect(rejected).toHaveLength(1);
      expect((rejected[0].data as CalloutNoteRejectedPayload).code).toBe('NOTE_SESSION_MISMATCH');
      for (const ws of [...room.all, ...other.all]) {
        expect(count(ws, CALLOUT_NOTE_ADDED)).toBe(0);
      }
      for (const ws of [...room.all.filter((w) => w !== room.sockets['Dave']), ...other.all]) {
        expect(count(ws, CALLOUT_NOTE_REJECTED)).toBe(0);
      }
      expect(other.session.getCurrentRound()?.calloutNotes ?? []).toHaveLength(0);
      expect(room.session.getCurrentRound()?.calloutNotes ?? []).toHaveLength(0);
      expect(roundId).not.toBe(otherRoundId);
    });
  });

  // -------------------------------------------------------------------------
  // clearBoard carries notes into history; history rounds still accept notes
  // -------------------------------------------------------------------------

  describe('notes and history', () => {
    it('carries the round notes into the history entry on board:clear, with notes unchanged', () => {
      const room = createRoom('power-of-2', modP2, p2Users);
      const roundId = startStory(room, 'History story');
      vote(room, 'Moderator', 1);
      vote(room, 'Dave', 64);
      revealPayload(room);
      send(room.sockets['Dave'], CALLOUT_NOTE_SUBMIT, { sessionId: room.sessionId, roundId, text: 'my reasoning' });
      const stored = (lastOf(room.sockets['Dave'], CALLOUT_NOTE_ADDED).data as CalloutNoteAddedPayload).note;

      send(room.owner, 'board:clear', {});

      const entry = (lastOf(room.sockets['Alice'], 'board:cleared').data as { historyEntry: HistoryEntry })
        .historyEntry;
      expect(entry.roundId).toBe(roundId);
      expect(entry.calloutNotes).toEqual([stored]); // R10.10
      expect(room.session.getHistory()[0].calloutNotes).toEqual([stored]);
    });

    it('stores a note for a saved round against its history entry and broadcasts it with that round id', () => {
      const room = createRoom('power-of-2', modP2, p2Users);
      const savedRoundId = startStory(room, 'Saved story');
      vote(room, 'Moderator', 1);
      vote(room, 'Dave', 64);
      revealPayload(room);
      send(room.owner, 'board:clear', {});
      const nextRoundId = startStory(room, 'Next story');

      send(room.sockets['Dave'], CALLOUT_NOTE_SUBMIT, {
        sessionId: room.sessionId,
        roundId: savedRoundId,
        text: 'late thought about the saved story',
      });

      // R10.5: broadcast to everyone in the session, tagged with the history round id.
      for (const ws of room.all) {
        const added = messagesOf(ws, CALLOUT_NOTE_ADDED);
        expect(added).toHaveLength(1);
        const data = added[0].data as CalloutNoteAddedPayload;
        expect(data.roundId).toBe(savedRoundId);
        expect(data.note.roundId).toBe(savedRoundId);
      }
      const entry = room.session.getHistory().find((e) => e.roundId === savedRoundId)!;
      expect(entry.calloutNotes?.map((n) => n.text)).toEqual(['late thought about the saved story']);
      // The round in progress is not affected.
      expect(nextRoundId).not.toBe(savedRoundId);
      expect(room.session.getCurrentRound()?.calloutNotes ?? []).toHaveLength(0);
    });

    it('delivers history notes as a plain JSON array to a client that joins later', () => {
      const room = createRoom('power-of-2', modP2, p2Users);
      const roundId = startStory(room, 'Story');
      vote(room, 'Moderator', 1);
      revealPayload(room);
      send(room.sockets['Dave'], CALLOUT_NOTE_SUBMIT, { sessionId: room.sessionId, roundId, text: 'kept' });
      send(room.owner, 'board:clear', {});

      const late = connect(room.sessionId, user('p2-late', 'Latecomer'));

      const state = (messagesOf(late, 'session:state')[0].data as {
        state: { history: Array<{ roundId: string; calloutNotes?: CalloutNote[] }> };
      }).state;
      expect(Array.isArray(state.history[0].calloutNotes)).toBe(true);
      expect(state.history[0].calloutNotes).toHaveLength(1);
      expect(state.history[0].calloutNotes?.[0]).toMatchObject({ roundId, authorId: 'p2-dave', text: 'kept' });
    });
  });

  // -------------------------------------------------------------------------
  // Export unaffected by notes (R10.16)
  // -------------------------------------------------------------------------

  describe('estimate export', () => {
    it('is identical to one built from the same history without notes', () => {
      const room = createRoom('power-of-2', modP2, p2Users);
      const roundId = startStory(room, 'Export story');
      vote(room, 'Moderator', 1);
      vote(room, 'Alice', 1);
      vote(room, 'Bob', 2);
      vote(room, 'Carol', 2);
      vote(room, 'Dave', 64);
      revealPayload(room);
      send(room.sockets['Dave'], CALLOUT_NOTE_SUBMIT, {
        sessionId: room.sessionId,
        roundId,
        text: 'Needs "quotes", commas, and\nnewlines',
      });
      send(room.sockets['Carol'], CALLOUT_NOTE_SUBMIT, { sessionId: room.sessionId, roundId, text: 'Me too' });
      send(room.owner, 'board:clear', {});

      const withNotes: HistoryEntry[] = JSON.parse(JSON.stringify(room.session.getHistory()));
      expect(withNotes[0].calloutNotes).toHaveLength(2);
      const withoutNotes: HistoryEntry[] = withNotes.map((entry) => {
        const { calloutNotes: _omitted, ...rest } = entry;
        return rest;
      });
      expect(withoutNotes[0].calloutNotes).toBeUndefined();

      const input = { votingSystem: 'power-of-2' as const };
      const csvWith = buildEstimateExportCsv({ ...input, history: withNotes });
      const csvWithout = buildEstimateExportCsv({ ...input, history: withoutNotes });

      expect(csvWith).toBe(csvWithout);
      expect(csvWith).not.toContain('Needs');
      expect(csvWith).not.toContain('Me too');
    });
  });
});
