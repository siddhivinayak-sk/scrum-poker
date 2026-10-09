import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fc from 'fast-check';
import WebSocket from 'ws';
import { retroRouter } from '../retro-routes';
import { retroSessionRegistry } from '../../services/retro-session-registry';
import { RetroSession } from '../../services/retro-session';
import { sessionRegistry } from '../../services/session-registry';
import { getRetroSessionClients } from '../../websocket/retro-handler';
import { _resetStore, login, logout } from '../../services/auth-service';
import {
  DEFAULT_SESSION_CONFIG,
  RetroConfiguration,
  RETRO_SESSION_ENDED,
  User,
} from '../../../../shared/types';

/**
 * Property 21 — "Ending a retro session touches nothing else", plus the
 * 200 happy path and the 401/403/404 example cases.
 *
 * Units exercised: the retro `DELETE /api/retro/sessions/:sessionId` route and
 * `RetroSessionRegistry`.
 *
 * Requirements: R9.7, R9.9, R9.10, R9.11, R9.15
 */

const app = express();
app.use(express.json());
app.use('/api/retro', retroRouter);

const del = (sessionId: string) => `/api/retro/sessions/${sessionId}`;

/** Same fallback the auth service uses, so a hand-signed token verifies. */
const JWT_SECRET = process.env.JWT_SECRET || 'scrum-poker-secret-key';

/** A handful of real template ids, every one of which has at least one column. */
const TEMPLATE_IDS = [
  'went-well-improve-actions',
  'mad-sad-glad',
  'plus-delta',
  'starfish',
] as const;

/** Votes are capped per user by the configured budget. */
const MAX_VOTES_PER_USER = 6;

/**
 * Deliberately tiny timestamp pools, as in Property 20: colliding
 * `lastActivityAt` and `createdAt` values are the norm, so the snapshot
 * comparison cannot accidentally pass by telling sessions apart on their
 * clocks alone.
 */
const BASE_MS = Date.UTC(2024, 0, 15, 9, 0, 0);
const ACTIVITY_SLOTS = [0, 1, 2, 3].map((i) => new Date(BASE_MS + i * 60_000).toISOString());
const CREATED_SLOTS = [1, 2, 3].map((i) => new Date(BASE_MS - i * 3_600_000).toISOString());

const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz'.split('');

function retroConfig(boardName: string, templateId: string): RetroConfiguration {
  return {
    boardName,
    maxVotesPerUser: MAX_VOTES_PER_USER,
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
 * Force the session timestamps once the board is fully built — every mutation
 * touches `lastActivityAt`, and `createdAt` is declared readonly.
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
  voteCount: number;
  completed: boolean;
  activitySlot: number;
  createdSlot: number;
}

/** Which session the DELETE targets. */
type TargetMode = 'owned' | 'foreign' | 'fresh';

/** What the request sends in its `Authorization` header. */
type TokenMode = 'valid' | 'absent' | 'malformed' | 'garbage' | 'expired' | 'revoked';

const TARGET_MODES: TargetMode[] = ['owned', 'foreign', 'fresh'];
const TOKEN_MODES: TokenMode[] = ['valid', 'absent', 'malformed', 'garbage', 'expired', 'revoked'];

interface RegistrySpec {
  ownerCount: number;
  callerSlot: number;
  retros: RetroSpec[];
  pokers: { ownerSlot: number }[];
  targetMode: TargetMode;
  targetSlot: number;
  freshId: string;
  tokenMode: TokenMode;
}

const retroSpecArb: fc.Arbitrary<RetroSpec> = fc.record({
  ownerSlot: fc.nat({ max: 4 }),
  boardName: fc
    .string({ minLength: 1, maxLength: 40 })
    .map((raw) => (raw.trim() === '' ? 'Board' : raw)),
  templateId: fc.constantFrom(...TEMPLATE_IDS),
  cardCount: fc.integer({ min: 0, max: 20 }),
  participantCount: fc.integer({ min: 0, max: 10 }),
  voteCount: fc.integer({ min: 0, max: MAX_VOTES_PER_USER }),
  completed: fc.boolean(),
  activitySlot: fc.nat({ max: ACTIVITY_SLOTS.length - 1 }),
  createdSlot: fc.nat({ max: CREATED_SLOTS.length - 1 }),
});

/** An 8-character base-36 id, the shape the registry itself mints. */
const freshIdArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...ID_CHARS), { minLength: 8, maxLength: 8 })
  .map((chars) => chars.join(''));

/**
 * `size: 'max'` is required. With `maxLength` alone, fast-check's default
 * sizing caps the generated arrays at 10 entries, which would leave most of
 * the stated 0–50 range unexercised.
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
  targetMode: fc.constantFrom(...TARGET_MODES),
  targetSlot: fc.nat({ max: 60 }),
  freshId: freshIdArb,
  // Weighted so roughly half the runs authenticate successfully. An even draw
  // across the six modes would spend five sixths of the budget on the 401
  // branch and leave the 403 and 200 branches barely visited.
  tokenMode: fc.oneof(
    { arbitrary: fc.constant<TokenMode>('valid'), weight: 5 },
    { arbitrary: fc.constantFrom(...TOKEN_MODES.filter((m) => m !== 'valid')), weight: 5 }
  ),
});

interface BuiltState {
  /** Token of the user the request authenticates as. */
  callerToken: string;
  /** Identifier of the user the request authenticates as. */
  callerUserId: string;
  /** Retro session ids owned by the caller. */
  ownedRetroIds: string[];
  /** Retro session ids owned by somebody other than the caller. */
  foreignRetroIds: string[];
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
  const foreignRetroIds: string[] = [];
  const allRetroIds: string[] = [];

  for (const retro of spec.retros) {
    const owner = owners[retro.ownerSlot % spec.ownerCount]!;
    const info = retroSessionRegistry.createSession(
      owner.user.id,
      retroConfig(retro.boardName, retro.templateId)
    );
    const session = retroSessionRegistry.getSession(info.sessionId)!;

    const members: string[] = [owner.user.id];
    for (let i = 0; i < retro.participantCount; i++) {
      const member = participant(info.sessionId, i);
      session.addParticipant(member);
      members.push(member.id);
    }

    const columns = session.getSessionState().board.columns;
    for (let i = 0; i < retro.cardCount; i++) {
      const column = columns[i % columns.length]!;
      session.addCard(column.id, `card ${i}`, owner.user.id, owner.user.displayName);
    }

    // Votes give R9.10 something to protect beyond the cards themselves.
    const cardIds = session
      .getSessionState()
      .board.columns.flatMap((column) => column.cards.map((card) => card.id));
    if (cardIds.length > 0) {
      const votesEach = Math.min(retro.voteCount, MAX_VOTES_PER_USER);
      members.forEach((memberId, memberIndex) => {
        for (let v = 0; v < votesEach; v++) {
          session.voteCard(cardIds[(memberIndex + v) % cardIds.length]!, memberId);
        }
      });
    }

    // Completing the board closes it to further cards and votes, so it goes last.
    if (retro.completed) {
      session.completeBoard();
    }

    setTimestamps(session, CREATED_SLOTS[retro.createdSlot]!, ACTIVITY_SLOTS[retro.activitySlot]!);

    allRetroIds.push(info.sessionId);
    if (owner.user.id === caller.user.id) {
      ownedRetroIds.push(info.sessionId);
    } else {
      foreignRetroIds.push(info.sessionId);
    }
  }

  // Guarantee the generated target mode has something to point at. The owner
  // draw frequently leaves one of the two pools empty — every retro owned by
  // the caller, or none at all — which would quietly turn the 403 and 200
  // branches into 404s and leave them unexercised.
  if (spec.targetMode === 'owned' && ownedRetroIds.length === 0) {
    const info = retroSessionRegistry.createSession(
      caller.user.id,
      retroConfig('Caller board', TEMPLATE_IDS[0])
    );
    ownedRetroIds.push(info.sessionId);
    allRetroIds.push(info.sessionId);
  }
  if (spec.targetMode === 'foreign' && foreignRetroIds.length === 0) {
    const other =
      owners.find((candidate) => candidate.user.id !== caller.user.id) ??
      login('other-owner', false);
    const info = retroSessionRegistry.createSession(
      other.user.id,
      retroConfig('Foreign board', TEMPLATE_IDS[0])
    );
    foreignRetroIds.push(info.sessionId);
    allRetroIds.push(info.sessionId);
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
    foreignRetroIds,
    allRetroIds,
    allPokerIds,
  };
}

/**
 * Resolve the generated target mode against the state that was actually built.
 * An empty owned or foreign pool degrades to a fresh id, which the returned
 * mode reports so the expected status stays in step with reality.
 */
function resolveTarget(
  spec: RegistrySpec,
  built: BuiltState
): { id: string; mode: TargetMode } {
  const pool =
    spec.targetMode === 'owned'
      ? built.ownedRetroIds
      : spec.targetMode === 'foreign'
        ? built.foreignRetroIds
        : [];

  if (pool.length > 0) {
    return { id: pool[spec.targetSlot % pool.length]!, mode: spec.targetMode };
  }

  // Registry ids are exactly 8 characters, so a longer id cannot collide.
  let fresh = spec.freshId;
  while (retroSessionRegistry.hasSession(fresh)) {
    fresh = `${fresh}z`;
  }
  return { id: fresh, mode: 'fresh' };
}

/** Build the `Authorization` header value, or null for "send no header". */
function authHeader(mode: TokenMode, callerToken: string): string | null {
  switch (mode) {
    case 'valid':
      return `Bearer ${callerToken}`;
    case 'absent':
      return null;
    case 'malformed':
      return `Basic ${callerToken}`;
    case 'garbage':
      return 'Bearer not-a-real-token';
    case 'expired':
      return `Bearer ${jwt.sign(
        { userId: 'u1', displayName: 'alice', role: 'participant', isAnonymous: false },
        JWT_SECRET,
        { expiresIn: '-1s' }
      )}`;
    case 'revoked': {
      const { token } = login('revoked-user', false);
      logout(token);
      return `Bearer ${token}`;
    }
  }
}

// --- Snapshots ---------------------------------------------------------------

/**
 * Deep, serialisable snapshot of the named retro sessions. Deliberately does
 * not include the registry size, so the same helper serves the 200 case (where
 * the count drops by one) and the rejection cases (where it must not move).
 */
function snapshotRetroSessions(ids: string[]): unknown {
  return JSON.parse(
    JSON.stringify(
      ids.map((id) => {
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
      })
    )
  );
}

/** Snapshot of the poker registry, which this route must never touch (R9.15). */
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

function resetAll(): void {
  _resetStore();
  retroSessionRegistry._reset();
  sessionRegistry._reset();
  getRetroSessionClients().clear();
}

// The registries announce every create and remove on stdout, and the generated
// states create thousands of sessions. Silence that for the whole file.
let logSpy: jest.SpyInstance;

beforeAll(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterAll(() => {
  logSpy.mockRestore();
});

beforeEach(() => {
  resetAll();
});

afterAll(() => {
  resetAll();
});

// --- Example cases -----------------------------------------------------------

describe('DELETE /api/retro/sessions/:sessionId — R9.7 success path', () => {
  it('removes the session from the registry and responds 200 (R9.7)', async () => {
    const { token, user } = login('alice', false);
    const info = retroSessionRegistry.createSession(user.id, retroConfig('Board', TEMPLATE_IDS[0]));

    const res = await request(app).delete(del(info.sessionId)).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(retroSessionRegistry.hasSession(info.sessionId)).toBe(false);
    expect(retroSessionRegistry.getSessionCount()).toBe(0);
  });

  it('leaves the owner\u2019s other retro sessions in place (R9.7, R9.11)', async () => {
    const { token, user } = login('alice', false);
    const target = retroSessionRegistry.createSession(user.id, retroConfig('A', TEMPLATE_IDS[0]));
    const keep = retroSessionRegistry.createSession(user.id, retroConfig('B', TEMPLATE_IDS[1]));

    const before = snapshotRetroSessions([keep.sessionId]);

    const res = await request(app).delete(del(target.sessionId)).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(retroSessionRegistry.hasSession(target.sessionId)).toBe(false);
    expect(snapshotRetroSessions([keep.sessionId])).toEqual(before);
  });

  it('broadcasts retro:session:ended and drops the connection map entry (R9.7, R9.8)', async () => {
    const { token, user } = login('alice', false);
    const info = retroSessionRegistry.createSession(user.id, retroConfig('Board', TEMPLATE_IDS[0]));

    const sent: string[] = [];
    const closed: number[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      send: (raw: string) => sent.push(raw),
      close: (code: number) => closed.push(code),
    } as unknown as WebSocket;

    getRetroSessionClients().set(info.sessionId, new Map([[user.id, new Set([socket])]]));

    const res = await request(app).delete(del(info.sessionId)).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!).event).toBe(RETRO_SESSION_ENDED);
    expect(closed).toEqual([1000]);
    expect(getRetroSessionClients().has(info.sessionId)).toBe(false);
  });
});

describe('DELETE /api/retro/sessions/:sessionId — R9.9 unauthorized cases', () => {
  it.each([
    ['no token', 'absent' as TokenMode],
    ['a non-Bearer header', 'malformed' as TokenMode],
    ['an unverifiable token', 'garbage' as TokenMode],
    ['an expired token', 'expired' as TokenMode],
    ['a revoked token', 'revoked' as TokenMode],
  ])('responds 401 and keeps the session when the request carries %s (R9.9)', async (_label, mode) => {
    const { token, user } = login('alice', false);
    const info = retroSessionRegistry.createSession(user.id, retroConfig('Board', TEMPLATE_IDS[0]));
    const before = snapshotRetroSessions([info.sessionId]);

    const header = authHeader(mode, token);
    const req = request(app).delete(del(info.sessionId));
    const res = await (header ? req.set('Authorization', header) : req);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(retroSessionRegistry.hasSession(info.sessionId)).toBe(true);
    expect(snapshotRetroSessions([info.sessionId])).toEqual(before);
  });

  it('responds 401 for an id the registry does not hold, without disclosing that (R9.9)', async () => {
    const res = await request(app).delete(del('deadbeef'));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });
});

describe('DELETE /api/retro/sessions/:sessionId — R9.10 and R9.11 rejection cases', () => {
  it('responds 403 and leaves the session, its cards and its votes unchanged (R9.10)', async () => {
    const { user: owner } = login('alice', false);
    const { token: intruderToken } = login('bob', false);
    const info = retroSessionRegistry.createSession(owner.id, retroConfig('Board', TEMPLATE_IDS[0]));
    const session = retroSessionRegistry.getSession(info.sessionId)!;
    const column = session.getSessionState().board.columns[0]!;
    const card = session.addCard(column.id, 'keep me', owner.id, 'alice');
    session.voteCard(card.id, owner.id);

    const before = snapshotRetroSessions([info.sessionId]);

    const res = await request(app)
      .delete(del(info.sessionId))
      .set('Authorization', `Bearer ${intruderToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(retroSessionRegistry.hasSession(info.sessionId)).toBe(true);
    expect(snapshotRetroSessions([info.sessionId])).toEqual(before);
  });

  it('responds 404 for an id the registry does not hold and keeps every other session (R9.11)', async () => {
    const { token, user } = login('alice', false);
    const keep = retroSessionRegistry.createSession(user.id, retroConfig('Board', TEMPLATE_IDS[0]));
    const before = snapshotRetroSessions([keep.sessionId]);

    const res = await request(app).delete(del('deadbeef')).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SESSION_NOT_FOUND');
    expect(retroSessionRegistry.getSessionCount()).toBe(1);
    expect(snapshotRetroSessions([keep.sessionId])).toEqual(before);
  });

  it('responds 404 before 403 for an unheld id the caller does not own (R9.11)', async () => {
    const { token } = login('alice', false);
    const { user: bob } = login('bob', false);
    retroSessionRegistry.createSession(bob.id, retroConfig('Bob', TEMPLATE_IDS[0]));

    const res = await request(app).delete(del('nosuchid')).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SESSION_NOT_FOUND');
  });

  it('leaves every poker session unchanged when the retro delete succeeds (R9.15)', async () => {
    const { token, user } = login('alice', false);
    const poker = sessionRegistry.createSession(user.id, DEFAULT_SESSION_CONFIG);
    const info = retroSessionRegistry.createSession(user.id, retroConfig('Board', TEMPLATE_IDS[0]));

    const before = snapshotPokerRegistry([poker.sessionId]);

    const res = await request(app).delete(del(info.sessionId)).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(snapshotPokerRegistry([poker.sessionId])).toEqual(before);
  });
});

// --- Property 21 -------------------------------------------------------------

describe('Property 21: ending a retro session touches nothing else', () => {
  it(
    'returns the status the case calls for and leaves every non-target retro session and the whole poker registry untouched (R9.7, R9.9, R9.10, R9.11, R9.15)',
    async () => {
      // Observed coverage, asserted after the run so a generator that silently
      // collapsed to tiny states or to a single case fails the test.
      let maxRetros = 0;
      let minRetros = Number.MAX_SAFE_INTEGER;
      let maxPokers = 0;
      let minPokers = Number.MAX_SAFE_INTEGER;
      const statusCounts = new Map<number, number>();
      const targetModesSeen = new Set<TargetMode>();
      const tokenModesSeen = new Set<TokenMode>();

      await fc.assert(
        fc.asyncProperty(registrySpecArb, async (spec) => {
          resetAll();
          maxRetros = Math.max(maxRetros, spec.retros.length);
          minRetros = Math.min(minRetros, spec.retros.length);
          maxPokers = Math.max(maxPokers, spec.pokers.length);
          minPokers = Math.min(minPokers, spec.pokers.length);

          const built = buildRegistryState(spec);
          const target = resolveTarget(spec, built);
          targetModesSeen.add(target.mode);
          tokenModesSeen.add(spec.tokenMode);

          const nonTargetIds = built.allRetroIds.filter((id) => id !== target.id);

          // The status the four ordered checks of the route must produce.
          const expectedStatus =
            spec.tokenMode !== 'valid'
              ? 401
              : target.mode === 'fresh'
                ? 404
                : target.mode === 'foreign'
                  ? 403
                  : 200;

          const header = authHeader(spec.tokenMode, built.callerToken);
          const countBefore = retroSessionRegistry.getSessionCount();
          const nonTargetBefore = snapshotRetroSessions(nonTargetIds);
          const targetBefore = snapshotRetroSessions([target.id]);
          const pokerBefore = snapshotPokerRegistry(built.allPokerIds);

          const pending = request(app).delete(del(target.id));
          const res = await (header ? pending.set('Authorization', header) : pending);

          expect(res.status).toBe(expectedStatus);
          statusCounts.set(res.status, (statusCounts.get(res.status) ?? 0) + 1);

          // Non-target retro sessions are untouched in every case
          // (R9.9, R9.10, R9.11).
          expect(snapshotRetroSessions(nonTargetIds)).toEqual(nonTargetBefore);

          // The whole poker registry is untouched in every case (R9.15).
          expect(snapshotPokerRegistry(built.allPokerIds)).toEqual(pokerBefore);

          if (expectedStatus === 200) {
            // R9.7 — the target, and only the target, is gone.
            expect(res.body).toEqual({ success: true });
            expect(retroSessionRegistry.hasSession(target.id)).toBe(false);
            expect(retroSessionRegistry.getSessionCount()).toBe(countBefore - 1);
          } else {
            // R9.9, R9.10, R9.11 — the target is exactly as it was, cards and
            // votes included, and nothing was removed.
            expect(snapshotRetroSessions([target.id])).toEqual(targetBefore);
            expect(retroSessionRegistry.getSessionCount()).toBe(countBefore);
            expect(res.body.error).toBe(
              expectedStatus === 401
                ? 'UNAUTHORIZED'
                : expectedStatus === 404
                  ? 'SESSION_NOT_FOUND'
                  : 'FORBIDDEN'
            );
          }
        }),
        { numRuns: 100 }
      );

      // The generated states really did span the stated ranges...
      expect(minRetros).toBeLessThanOrEqual(1);
      expect(maxRetros).toBeGreaterThanOrEqual(40);
      expect(maxRetros).toBeLessThanOrEqual(50);
      expect(minPokers).toBeLessThanOrEqual(1);
      expect(maxPokers).toBeGreaterThanOrEqual(40);
      expect(maxPokers).toBeLessThanOrEqual(50);

      // ...and really did reach all three target kinds, every token mode and
      // all four status codes, the 200 happy path included.
      expect([...targetModesSeen].sort()).toEqual(['foreign', 'fresh', 'owned']);
      expect([...tokenModesSeen].sort()).toEqual([...TOKEN_MODES].sort());
      expect([...statusCounts.keys()].sort()).toEqual([200, 401, 403, 404]);
    },
    300_000
  );
});
