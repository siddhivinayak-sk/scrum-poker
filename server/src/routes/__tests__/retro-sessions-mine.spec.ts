import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fc from 'fast-check';
import { retroRouter, summariseRetroSessions } from '../retro-routes';
import { retroSessionRegistry } from '../../services/retro-session-registry';
import { RetroSession } from '../../services/retro-session';
import { sessionRegistry } from '../../services/session-registry';
import { _resetStore, login, logout } from '../../services/auth-service';
import {
  DEFAULT_SESSION_CONFIG,
  RetroConfiguration,
  RetroSessionSummary,
  User,
} from '../../../../shared/types';

/**
 * Property 20 — "Retro session list holds exactly the caller's retro sessions",
 * plus the 401 and zero-session example cases.
 *
 * Units exercised: `summariseRetroSessions`, `RetroSessionRegistry.getSessionsByOwner`,
 * and the `GET /api/retro/sessions/mine` route itself (through supertest).
 *
 * Requirements: R8.2, R8.3, R8.4, R8.5, R8.6, R8.7, R8.8, R14.16
 */

const app = express();
app.use(express.json());
app.use('/api/retro', retroRouter);

const MINE = '/api/retro/sessions/mine';

/** Same fallback the auth service uses, so a hand-signed token verifies. */
const JWT_SECRET = process.env.JWT_SECRET || 'scrum-poker-secret-key';

/** Canonical ISO 8601 UTC with milliseconds, as produced by `toISOString()`. */
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A handful of real template ids, every one of which has at least one column. */
const TEMPLATE_IDS = [
  'went-well-improve-actions',
  'mad-sad-glad',
  'plus-delta',
  'starfish',
] as const;

/**
 * Deliberately tiny timestamp pools. With up to 50 sessions drawn from four
 * `lastActivityAt` values and three `createdAt` values, collisions on the
 * primary sort key are the norm rather than the exception, which is what
 * exercises the `createdAt` tie-break of R8.4.
 */
const BASE_MS = Date.UTC(2024, 0, 15, 9, 0, 0);
const ACTIVITY_SLOTS = [0, 1, 2, 3].map((i) => new Date(BASE_MS + i * 60_000).toISOString());
const CREATED_SLOTS = [1, 2, 3].map((i) => new Date(BASE_MS - i * 3_600_000).toISOString());

function retroConfig(boardName: string, templateId: string): RetroConfiguration {
  return {
    boardName,
    maxVotesPerUser: 6,
    templateId,
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
}

function participant(sessionId: string, index: number): User {
  return {
    id: `${sessionId}-p${index}`,
    displayName: `P${index}`,
    role: 'participant',
    isAnonymous: false,
  };
}

/**
 * Force the session timestamps. The registry stamps `createdAt` and
 * `lastActivityAt` from the clock and every mutation touches the latter, so the
 * only way to produce colliding values is to overwrite them once the board is
 * fully built. `createdAt` is declared readonly, hence `defineProperty`.
 */
function setTimestamps(session: RetroSession, createdAt: string, lastActivityAt: string): void {
  Object.defineProperty(session, 'createdAt', {
    value: createdAt,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  session.lastActivityAt = lastActivityAt;
}

// --- Generated registry state -----------------------------------------------

interface RetroSpec {
  ownerSlot: number;
  boardName: string;
  templateId: string;
  cardCount: number;
  participantCount: number;
  completed: boolean;
  activitySlot: number;
  createdSlot: number;
}

interface RegistrySpec {
  ownerCount: number;
  callerSlot: number;
  retros: RetroSpec[];
  pokers: { ownerSlot: number }[];
}

const retroSpecArb: fc.Arbitrary<RetroSpec> = fc.record({
  ownerSlot: fc.nat({ max: 4 }),
  boardName: fc
    .string({ minLength: 1, maxLength: 40 })
    .map((raw) => (raw.trim() === '' ? 'Board' : raw)),
  templateId: fc.constantFrom(...TEMPLATE_IDS),
  cardCount: fc.integer({ min: 0, max: 20 }),
  participantCount: fc.integer({ min: 0, max: 10 }),
  completed: fc.boolean(),
  activitySlot: fc.nat({ max: ACTIVITY_SLOTS.length - 1 }),
  createdSlot: fc.nat({ max: CREATED_SLOTS.length - 1 }),
});

/**
 * `size: 'max'` is required. With `maxLength` alone, fast-check's default
 * sizing caps the generated arrays at 10 entries, which would leave the
 * 0–50 range of R14.16 unexercised.
 */
const registrySpecArb: fc.Arbitrary<RegistrySpec> = fc.record({
  ownerCount: fc.integer({ min: 1, max: 5 }),
  callerSlot: fc.nat({ max: 4 }),
  retros: fc.array(retroSpecArb, { minLength: 0, maxLength: 50, size: 'max' }),
  pokers: fc.array(fc.record({ ownerSlot: fc.nat({ max: 4 }) }), {
    minLength: 0,
    maxLength: 50,
    size: 'max',
  }),
});

interface BuiltState {
  /** Token of the user the request authenticates as. */
  callerToken: string;
  /** Identifier of the user the request authenticates as. */
  callerUserId: string;
  /** Retro session ids owned by the caller. */
  ownedRetroIds: string[];
  /** Every retro session id in the registry. */
  allRetroIds: string[];
  /** Every poker session id in the registry. */
  allPokerIds: string[];
}

/**
 * Materialise a generated spec into the two live registries. Called after a
 * reset, so the registries hold exactly what the spec describes.
 */
function buildRegistryState(spec: RegistrySpec): BuiltState {
  const owners = Array.from({ length: spec.ownerCount }, (_, i) => login(`owner-${i}`, false));
  const caller = owners[spec.callerSlot % spec.ownerCount]!;

  const ownedRetroIds: string[] = [];
  const allRetroIds: string[] = [];

  for (const retro of spec.retros) {
    const owner = owners[retro.ownerSlot % spec.ownerCount]!;
    const info = retroSessionRegistry.createSession(
      owner.user.id,
      retroConfig(retro.boardName, retro.templateId)
    );
    const session = retroSessionRegistry.getSession(info.sessionId)!;

    for (let i = 0; i < retro.participantCount; i++) {
      session.addParticipant(participant(info.sessionId, i));
    }

    const columns = session.getSessionState().board.columns;
    for (let i = 0; i < retro.cardCount; i++) {
      const column = columns[i % columns.length]!;
      session.addCard(column.id, `card ${i}`, owner.user.id, owner.user.displayName);
    }

    // Completing the board closes it to further cards, so it goes last.
    if (retro.completed) {
      session.completeBoard();
    }

    setTimestamps(session, CREATED_SLOTS[retro.createdSlot]!, ACTIVITY_SLOTS[retro.activitySlot]!);

    allRetroIds.push(info.sessionId);
    if (owner.user.id === caller.user.id) {
      ownedRetroIds.push(info.sessionId);
    }
  }

  const allPokerIds: string[] = [];
  for (const poker of spec.pokers) {
    const owner = owners[poker.ownerSlot % spec.ownerCount]!;
    const info = sessionRegistry.createSession(owner.user.id, DEFAULT_SESSION_CONFIG);
    allPokerIds.push(info.sessionId);
  }

  return {
    callerToken: caller.token,
    callerUserId: caller.user.id,
    ownedRetroIds,
    allRetroIds,
    allPokerIds,
  };
}

// --- Snapshots ---------------------------------------------------------------

/** Deep, serialisable snapshot of every retro session the registry holds. */
function snapshotRetroRegistry(ids: string[]): unknown {
  return JSON.parse(
    JSON.stringify({
      count: retroSessionRegistry.getSessionCount(),
      sessions: ids.map((id) => {
        const session = retroSessionRegistry.getSession(id);
        if (!session) {
          return { id, present: false };
        }
        return {
          id,
          present: true,
          ownerId: session.ownerId,
          createdAt: session.createdAt,
          lastActivityAt: session.lastActivityAt,
          config: session.config,
          participants: session.getParticipants(),
          state: session.getSessionState(),
        };
      }),
    })
  );
}

/** Snapshot of the poker registry, which this route must never touch. */
function snapshotPokerRegistry(ids: string[]): unknown {
  return JSON.parse(
    JSON.stringify({
      count: sessionRegistry.getActiveSessionCount(),
      sessions: ids.map((id) => {
        const session = sessionRegistry.getSession(id);
        return session
          ? { id, present: true, ownerId: session.ownerId, state: session.getSessionState() }
          : { id, present: false };
      }),
    })
  );
}

// --- Invariant helpers -------------------------------------------------------

/**
 * Non-increasing under the composite comparator of R8.4: `lastActivityAt`
 * descending, ties broken by `createdAt` descending. Compared as instants, so
 * this is independent of the route's lexicographic implementation.
 */
function orderingViolation(summaries: RetroSessionSummary[]): string | null {
  for (let i = 1; i < summaries.length; i++) {
    const prev = summaries[i - 1]!;
    const cur = summaries[i]!;
    const prevActivity = Date.parse(prev.lastActivityAt);
    const curActivity = Date.parse(cur.lastActivityAt);

    if (prevActivity < curActivity) {
      return `lastActivityAt ascends at index ${i}: ${prev.lastActivityAt} then ${cur.lastActivityAt}`;
    }
    if (prevActivity === curActivity && Date.parse(prev.createdAt) < Date.parse(cur.createdAt)) {
      return `createdAt tie-break ascends at index ${i}: ${prev.createdAt} then ${cur.createdAt}`;
    }
  }
  return null;
}

function resetAll(): void {
  _resetStore();
  retroSessionRegistry._reset();
  sessionRegistry._reset();
}

beforeEach(() => {
  resetAll();
});

afterAll(() => {
  resetAll();
});

describe('GET /api/retro/sessions/mine — R8.5 unauthorized cases', () => {
  it('responds 401 UNAUTHORIZED when the request carries no token (R8.5)', async () => {
    const res = await request(app).get(MINE);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(res.body.sessions).toBeUndefined();
  });

  it('responds 401 UNAUTHORIZED when the Authorization header is not a Bearer header (R8.5)', async () => {
    const res = await request(app).get(MINE).set('Authorization', 'Basic abc123');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('responds 401 UNAUTHORIZED when the token fails verification (R8.5)', async () => {
    const res = await request(app).get(MINE).set('Authorization', 'Bearer not-a-real-token');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('responds 401 UNAUTHORIZED when the token has expired (R8.5)', async () => {
    const expired = jwt.sign(
      { userId: 'u1', displayName: 'alice', role: 'participant', isAnonymous: false },
      JWT_SECRET,
      { expiresIn: '-1s' }
    );

    const res = await request(app).get(MINE).set('Authorization', `Bearer ${expired}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('responds 401 UNAUTHORIZED for a token that is no longer active (R8.5)', async () => {
    const { token } = login('alice', false);
    logout(token);

    const res = await request(app).get(MINE).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('leaves the registry unchanged when the request is rejected (R8.5, R8.8)', async () => {
    const { user } = login('alice', false);
    const info = retroSessionRegistry.createSession(user.id, retroConfig('Board', TEMPLATE_IDS[0]));

    const before = snapshotRetroRegistry([info.sessionId]);
    await request(app).get(MINE);
    const after = snapshotRetroRegistry([info.sessionId]);

    expect(after).toEqual(before);
  });
});

describe('GET /api/retro/sessions/mine — R8.3 zero-session cases', () => {
  it('responds 200 with zero entries when the registry is empty (R8.3)', async () => {
    const { token } = login('alice', false);

    const res = await request(app).get(MINE).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });

  it('responds 200 with zero entries when the caller owns none of the held sessions (R8.3)', async () => {
    const { token } = login('alice', false);
    const { user: bob } = login('bob', false);

    retroSessionRegistry.createSession(bob.id, retroConfig('Bob 1', TEMPLATE_IDS[0]));
    retroSessionRegistry.createSession(bob.id, retroConfig('Bob 2', TEMPLATE_IDS[1]));

    const res = await request(app).get(MINE).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });

  it('responds 200 with zero entries when the caller owns only poker sessions (R8.3, R8.7)', async () => {
    const { token, user } = login('alice', false);
    sessionRegistry.createSession(user.id, DEFAULT_SESSION_CONFIG);
    sessionRegistry.createSession(user.id, DEFAULT_SESSION_CONFIG);

    const res = await request(app).get(MINE).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
  });

  it('summarises an empty session list as an empty array (R8.3)', () => {
    expect(summariseRetroSessions([])).toEqual([]);
  });
});

describe('Property 20: retro session list holds exactly the caller\u2019s retro sessions', () => {
  // The generated states create thousands of sessions, each of which the
  // registries announce on stdout. Silence that for the duration.
  let logSpy: jest.SpyInstance;

  beforeAll(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterAll(() => {
    logSpy.mockRestore();
  });

  it(
    'returns exactly the caller\u2019s retro sessions, ordered, well formed, and without side effects (R8.2, R8.4, R8.6, R8.7, R8.8, R14.16)',
    async () => {
      // R14.16 requires the generated states to span 0–50 retro sessions and
      // 0–50 game sessions. Record the observed span and assert it afterwards,
      // so a generator that silently collapsed to tiny states fails the test.
      let maxRetros = 0;
      let minRetros = Number.MAX_SAFE_INTEGER;
      let maxPokers = 0;
      let minPokers = Number.MAX_SAFE_INTEGER;

      await fc.assert(
        fc.asyncProperty(registrySpecArb, async (spec) => {
          resetAll();
          maxRetros = Math.max(maxRetros, spec.retros.length);
          minRetros = Math.min(minRetros, spec.retros.length);
          maxPokers = Math.max(maxPokers, spec.pokers.length);
          minPokers = Math.min(minPokers, spec.pokers.length);

          const built = buildRegistryState(spec);
          const auth = `Bearer ${built.callerToken}`;

          const before = snapshotRetroRegistry(built.allRetroIds);
          const pokerBefore = snapshotPokerRegistry(built.allPokerIds);

          const first = await request(app).get(MINE).set('Authorization', auth);

          expect(first.status).toBe(200);
          const summaries = first.body.sessions as RetroSessionSummary[];
          expect(Array.isArray(summaries)).toBe(true);

          // R8.2 — exactly one entry per owned retro session, no limit applied.
          const returnedIds = summaries.map((s) => s.sessionId);
          expect(returnedIds.length).toBe(built.ownedRetroIds.length);
          expect(new Set(returnedIds)).toEqual(new Set(built.ownedRetroIds));

          // R8.7 — no poker session identifier leaks into the response.
          const retroIdSet = new Set(built.allRetroIds);
          const pokerOnlyIds = built.allPokerIds.filter((id) => !retroIdSet.has(id));
          for (const pokerId of pokerOnlyIds) {
            expect(returnedIds).not.toContain(pokerId);
          }

          // R8.4 — non-increasing under the composite comparator.
          expect(orderingViolation(summaries)).toBeNull();

          // R8.6 — every summary is well formed and agrees with its session.
          for (const summary of summaries) {
            const session = retroSessionRegistry.getSession(summary.sessionId)!;
            expect(session).toBeDefined();
            expect(session.ownerId).toBe(built.callerUserId);
            expect(summary.boardName).toBe(session.config.boardName);
            expect(summary.createdAt).toMatch(ISO_8601_UTC);
            expect(summary.lastActivityAt).toMatch(ISO_8601_UTC);
            expect(summary.createdAt).toBe(session.createdAt);
            expect(summary.lastActivityAt).toBe(session.lastActivityAt);
            expect(Number.isInteger(summary.participantCount)).toBe(true);
            expect(summary.participantCount).toBeGreaterThanOrEqual(0);
            expect(summary.participantCount).toBe(session.getParticipantCount());
            expect(Number.isInteger(summary.cardCount)).toBe(true);
            expect(summary.cardCount).toBeGreaterThanOrEqual(0);
            expect(summary.cardCount).toBe(session.getCardCount());
            expect(typeof summary.isCompleted).toBe('boolean');
            expect(summary.isCompleted).toBe(session.isBoardCompleted());
            expect(Object.keys(summary).sort()).toEqual([
              'boardName',
              'cardCount',
              'createdAt',
              'isCompleted',
              'lastActivityAt',
              'participantCount',
              'sessionId',
            ]);
          }

          // R8.8 — a second identical request returns identical entries and
          // neither registry has moved.
          const second = await request(app).get(MINE).set('Authorization', auth);
          expect(second.status).toBe(200);
          expect(second.body).toEqual(first.body);

          expect(snapshotRetroRegistry(built.allRetroIds)).toEqual(before);
          expect(snapshotPokerRegistry(built.allPokerIds)).toEqual(pokerBefore);
        }),
        { numRuns: 200 }
      );

      // R14.16 — the 200 generated registry states covered the stated ranges.
      expect(minRetros).toBeLessThanOrEqual(1);
      expect(maxRetros).toBeGreaterThanOrEqual(40);
      expect(maxRetros).toBeLessThanOrEqual(50);
      expect(minPokers).toBeLessThanOrEqual(1);
      expect(maxPokers).toBeGreaterThanOrEqual(40);
      expect(maxPokers).toBeLessThanOrEqual(50);
    },
    300_000
  );
});
