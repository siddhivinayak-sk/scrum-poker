import { IncomingMessage } from 'http';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import * as fc from 'fast-check';
import {
  CALLOUT_NOTE_SUBMIT,
  CALLOUT_NOTE_ADDED,
  CALLOUT_NOTE_REJECTED,
  DEFAULT_SESSION_CONFIG,
  CalloutNote,
  RetroConfiguration,
  User,
  WebSocketMessage,
} from '../../../../shared/types';
import { handleWebSocket, _reset as resetPokerHandler } from '../handler';
import { handleRetroWebSocket, _resetRetroHandler } from '../retro-handler';
import * as authService from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import { retroSessionRegistry } from '../../services/retro-session-registry';

/**
 * Feature: vote-reveal-fun-callouts, Property 16: Session isolation
 *
 * For generated pairs of distinct Poker_Sessions:
 *  - a callout:note:submit whose session identifier differs from the sending connection's
 *    session is rejected (NOTE_SESSION_MISMATCH), stores nothing in either session, broadcasts
 *    nothing, and answers the sending connection only;
 *  - a valid callout:note:submit reaches only the connections joined to its own session and
 *    zero connections on the retro endpoint.
 *
 * **Validates: Requirements 12.5, 13.4, 13.13**
 */

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type MockWs = WebSocket & { sentMessages: string[] };

function createMockWs(): MockWs {
  const emitter = new EventEmitter();
  const mock = emitter as unknown as MockWs;
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

function createRequest(path: string, token: string, sessionId: string): IncomingMessage {
  return {
    url: `${path}?token=${token}&sessionId=${sessionId}`,
    headers: { host: 'localhost:3000' },
  } as unknown as IncomingMessage;
}

function parse(raw: string): WebSocketMessage {
  return JSON.parse(raw) as WebSocketMessage;
}

function send(ws: WebSocket, event: string, data: unknown): void {
  ws.emit('message', JSON.stringify({ event, data, timestamp: new Date().toISOString() }));
}

const RETRO_CONFIG: RetroConfiguration = {
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

interface World {
  aId: string;
  bId: string;
  retroId: string;
  aRoundId: string;
  bRoundId: string;
  aSockets: MockWs[];
  bSockets: MockWs[];
  retroSockets: MockWs[];
  /** Sockets of session A grouped by the user that owns them. */
  aUsers: Array<{ user: User; sockets: MockWs[] }>;
}

function buildUser(tag: string, index: number): User {
  return {
    id: `${tag}-${index}`,
    displayName: `${tag}-name-${index}`,
    role: index === 0 ? 'moderator' : 'participant',
    isAnonymous: false,
  };
}

/** Creates two distinct poker sessions and one retro session, each with live mock connections. */
function buildWorld(aShape: number[], bShape: number[], retroShape: number[]): World {
  const validate = jest.spyOn(authService, 'validateToken');

  const aUsersList = aShape.map((_, i) => buildUser('a', i));
  const bUsersList = bShape.map((_, i) => buildUser('b', i));
  const retroUsersList = retroShape.map((_, i) => buildUser('r', i));

  const aId = sessionRegistry.createSession(aUsersList[0].id, DEFAULT_SESSION_CONFIG).sessionId;
  const bId = sessionRegistry.createSession(bUsersList[0].id, DEFAULT_SESSION_CONFIG).sessionId;
  const retroId = retroSessionRegistry.createSession(retroUsersList[0].id, RETRO_CONFIG).sessionId;

  const connectPoker = (users: User[], shape: number[], sessionId: string) =>
    users.map((user, i) => {
      const sockets: MockWs[] = [];
      for (let s = 0; s < shape[i]; s++) {
        validate.mockReturnValueOnce(user);
        const ws = createMockWs();
        handleWebSocket(ws, createRequest('/', `token-${user.id}`, sessionId));
        sockets.push(ws);
      }
      return { user, sockets };
    });

  const aUsers = connectPoker(aUsersList, aShape, aId);
  const bUsers = connectPoker(bUsersList, bShape, bId);

  const retroSockets: MockWs[] = [];
  retroUsersList.forEach((user, i) => {
    for (let s = 0; s < retroShape[i]; s++) {
      validate.mockReturnValueOnce(user);
      const ws = createMockWs();
      handleRetroWebSocket(ws, createRequest('/retro', `token-${user.id}`, retroId));
      retroSockets.push(ws);
    }
  });

  const aRoundId = sessionRegistry.getSession(aId)!.startRound('Story A').id;
  const bRoundId = sessionRegistry.getSession(bId)!.startRound('Story B').id;

  return {
    aId,
    bId,
    retroId,
    aRoundId,
    bRoundId,
    aSockets: aUsers.flatMap((u) => u.sockets),
    bSockets: bUsers.flatMap((u) => u.sockets),
    retroSockets,
    aUsers,
  };
}

/** Records how many messages each socket has received so far, to isolate what a step produced. */
function snapshot(sockets: MockWs[]): Map<MockWs, number> {
  return new Map(sockets.map((ws) => [ws, ws.sentMessages.length]));
}

function sentSince(ws: MockWs, marks: Map<MockWs, number>): WebSocketMessage[] {
  return ws.sentMessages.slice(marks.get(ws) ?? 0).map(parse);
}

function calloutNotesOf(sessionId: string, roundId: string): CalloutNote[] {
  const session = sessionRegistry.getSession(sessionId)!;
  const round = session.getCurrentRound();
  return round?.id === roundId ? round.calloutNotes ?? [] : [];
}

function resetAll(): void {
  resetPokerHandler();
  _resetRetroHandler();
  sessionRegistry._reset();
  retroSessionRegistry._reset();
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Number of live connections per user: 1..3 users, 1..2 sockets each. */
const shapeArb = fc.array(fc.integer({ min: 1, max: 2 }), { minLength: 1, maxLength: 3 });
const retroShapeArb = fc.array(fc.integer({ min: 1, max: 2 }), { minLength: 1, maxLength: 2 });

/** Valid note text: always non-empty after trim, padded with whitespace, within 280 chars. */
const validTextArb = fc
  .string({ unit: 'grapheme', maxLength: 40 })
  .map((s) => `  \t x${s}\n `);

/** Arbitrary text for rejected submissions: whatever the sender wrote must not matter. */
const anyTextArb = fc.string({ unit: 'grapheme', maxLength: 60 });

type ClaimKind =
  | 'otherPokerSession'
  | 'retroSession'
  | 'randomString'
  | 'emptyString'
  | 'ownIdSuffixed'
  | 'number'
  | 'null'
  | 'object'
  | 'missing';

const claimKindArb = fc.constantFrom<ClaimKind>(
  'otherPokerSession',
  'retroSession',
  'randomString',
  'emptyString',
  'ownIdSuffixed',
  'number',
  'null',
  'object',
  'missing'
);

type RoundTarget = 'ownRound' | 'otherRound' | 'bogusRound';
const roundTargetArb = fc.constantFrom<RoundTarget>('ownRound', 'otherRound', 'bogusRound');

/** Builds the submit payload with a session claim that is guaranteed to differ from `ownId`. */
function buildMismatchedPayload(
  kind: ClaimKind,
  random: string,
  ids: { ownId: string; otherId: string; retroId: string },
  roundId: string,
  text: string
): Record<string, unknown> {
  const payload: Record<string, unknown> = { roundId, text };
  switch (kind) {
    case 'otherPokerSession':
      payload.sessionId = ids.otherId;
      break;
    case 'retroSession':
      payload.sessionId = ids.retroId;
      break;
    case 'randomString':
      payload.sessionId = random === ids.ownId ? `${random}!` : random;
      break;
    case 'emptyString':
      payload.sessionId = '';
      break;
    case 'ownIdSuffixed':
      payload.sessionId = `${ids.ownId}x`;
      break;
    case 'number':
      payload.sessionId = 42;
      break;
    case 'null':
      payload.sessionId = null;
      break;
    case 'object':
      payload.sessionId = { id: ids.ownId };
      break;
    case 'missing':
      break;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('Property 16: Session isolation of callout note events', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    resetAll();
  });

  afterAll(() => {
    jest.restoreAllMocks();
    resetAll();
  });

  it('rejects a note whose session differs from the connection session: nothing stored, nothing broadcast, error to the sender only', () => {
    fc.assert(
      fc.property(
        shapeArb,
        shapeArb,
        retroShapeArb,
        fc.nat(),
        claimKindArb,
        fc.string({ maxLength: 12 }),
        roundTargetArb,
        anyTextArb,
        (aShape, bShape, retroShape, senderPick, kind, random, target, text) => {
          resetAll();
          const w = buildWorld(aShape, bShape, retroShape);
          expect(w.aId).not.toBe(w.bId);

          const sender = w.aSockets[senderPick % w.aSockets.length];
          const everyone = [...w.aSockets, ...w.bSockets, ...w.retroSockets];
          const marks = snapshot(everyone);

          const roundId =
            target === 'ownRound' ? w.aRoundId : target === 'otherRound' ? w.bRoundId : 'no-such-round';
          send(
            sender,
            CALLOUT_NOTE_SUBMIT,
            buildMismatchedPayload(
              kind,
              random,
              { ownId: w.aId, otherId: w.bId, retroId: w.retroId },
              roundId,
              text
            )
          );

          // Error goes to the sending connection only, and it is the dedicated rejection event.
          const received = sentSince(sender, marks);
          expect(received).toHaveLength(1);
          expect(received[0].event).toBe(CALLOUT_NOTE_REJECTED);
          expect((received[0].data as { code: string }).code).toBe('NOTE_SESSION_MISMATCH');

          // Nothing at all reaches any other connection: not in session A, not in session B,
          // not on the retro endpoint.
          for (const ws of everyone) {
            if (ws !== sender) {
              expect(sentSince(ws, marks)).toEqual([]);
            }
          }

          // Nothing stored in either session.
          expect(calloutNotesOf(w.aId, w.aRoundId)).toEqual([]);
          expect(calloutNotesOf(w.bId, w.bRoundId)).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('delivers a valid note only to connections joined to its own session and to none on the retro endpoint', () => {
    fc.assert(
      fc.property(
        shapeArb,
        shapeArb,
        retroShapeArb,
        fc.nat(),
        fc.boolean(),
        validTextArb,
        (aShape, bShape, retroShape, senderPick, fromA, text) => {
          resetAll();
          const w = buildWorld(aShape, bShape, retroShape);

          const own = fromA ? w.aSockets : w.bSockets;
          const foreign = fromA ? w.bSockets : w.aSockets;
          const ownId = fromA ? w.aId : w.bId;
          const ownRoundId = fromA ? w.aRoundId : w.bRoundId;
          const foreignId = fromA ? w.bId : w.aId;
          const foreignRoundId = fromA ? w.bRoundId : w.aRoundId;
          const sender = own[senderPick % own.length];

          const everyone = [...w.aSockets, ...w.bSockets, ...w.retroSockets];
          const marks = snapshot(everyone);

          send(sender, CALLOUT_NOTE_SUBMIT, { sessionId: ownId, roundId: ownRoundId, text });

          // Every connection joined to the target session receives exactly one callout:note:added.
          for (const ws of own) {
            const received = sentSince(ws, marks);
            expect(received).toHaveLength(1);
            expect(received[0].event).toBe(CALLOUT_NOTE_ADDED);
            const data = received[0].data as { roundId: string; note: CalloutNote };
            expect(data.roundId).toBe(ownRoundId);
            expect(data.note.roundId).toBe(ownRoundId);
            expect(data.note.text).toBe(text.trim());
          }

          // Zero messages of any kind reach the other poker session or the retro endpoint.
          for (const ws of [...foreign, ...w.retroSockets]) {
            expect(sentSince(ws, marks)).toEqual([]);
          }

          // Exactly one note stored, in the target session only.
          expect(calloutNotesOf(ownId, ownRoundId)).toHaveLength(1);
          expect(calloutNotesOf(foreignId, foreignRoundId)).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );
  });
});
