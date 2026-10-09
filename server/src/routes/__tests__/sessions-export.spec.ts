import express from 'express';
import * as fc from 'fast-check';
import request from 'supertest';

import { sessionsRouter } from '../sessions';
import { _resetStore, login } from '../../services/auth-service';
import { GameSession } from '../../services/game-session';
import { sessionRegistry } from '../../services/session-registry';
import { SUMMARY_HEADER, buildEstimateExportCsv } from '../../../../shared/estimate-export';
import {
  DEFAULT_SESSION_CONFIG,
  getCardsForVotingSystem,
  type CardValue,
  type ExtendedCardValue,
  type SessionConfiguration,
  type VotingSystemType,
} from '../../../../shared/types';

// Feature: poker-retro-ux-improvements — the Estimate_Export_Endpoint
// (`GET /api/sessions/:sessionId/export`).
//
// Covers the check order (401 before 404 before 403), the success response and
// its headers, the 200-estimate / 50-participant timing budget, and Property 23
// (the endpoint is a pure read).

// `broadcastConfigUpdate` is only reached by the config route; mocked so the
// suite needs no live WebSocket server.
jest.mock('../../websocket/handler', () => ({
  broadcastConfigUpdate: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use('/api/sessions', sessionsRouter);

// A document holding nothing but the summary header. `serializeCsvDocument`
// joins records with CRLF and emits no terminator after the final record,
// which RFC 4180 permits.
const HEADER_ONLY_DOCUMENT = SUMMARY_HEADER.join(',');

beforeEach(() => {
  _resetStore();
  sessionRegistry._reset();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function loginUser(name: string) {
  return login(name, false);
}

function configFor(votingSystem: VotingSystemType): SessionConfiguration {
  return { ...DEFAULT_SESSION_CONFIG, votingSystem };
}

/** Creates a session owned by `ownerId` and returns the live instance. */
function createSession(ownerId: string, votingSystem: VotingSystemType = 'fibonacci'): GameSession {
  const info = sessionRegistry.createSession(ownerId, configFor(votingSystem));
  return sessionRegistry.getSession(info.sessionId)!;
}

/**
 * The metrics engine and `selectCard` are typed against `CardValue`, which
 * predates the extended voting systems that `getCardsForVotingSystem` yields.
 * The narrowing lives here so the call sites stay readable and no `any`
 * cast is introduced.
 */
function asCardValue(value: ExtendedCardValue): CardValue {
  return value as CardValue;
}

interface RoundPlan {
  story: string;
  /** One entry per participant; `null` records a participant who did not vote. */
  votes: (ExtendedCardValue | null)[];
  /** Reveal before clearing, which is what gives the entry a voting duration. */
  reveal: boolean;
}

/**
 * Drives a real `GameSession` through start → select → (reveal) → clearBoard so
 * the exported history is produced the way the running server produces it.
 *
 * Each round replaces the participant set, which is how a session behaves when
 * people join and leave between stories, and lets a plan vary the recorded
 * participant count per Completed_Estimate.
 */
function playRounds(session: GameSession, plans: readonly RoundPlan[]): void {
  for (const [roundIndex, plan] of plans.entries()) {
    for (const participant of session.getParticipants()) {
      session.removeParticipant(participant.id);
    }

    plan.votes.forEach((_vote, voterIndex) => {
      session.addParticipant({
        id: `user-${roundIndex}-${voterIndex}`,
        // Descending display names, so the exported vote rows can only be in
        // ascending order if the builder actually sorts them.
        displayName: `Voter ${String(plan.votes.length - voterIndex).padStart(3, '0')}`,
        role: 'participant',
        isAnonymous: false,
      });
    });

    session.startRound(plan.story);
    plan.votes.forEach((vote, voterIndex) => {
      if (vote !== null) {
        session.selectCard(`user-${roundIndex}-${voterIndex}`, asCardValue(vote));
      }
    });

    if (plan.reveal) {
      session.revealCards();
    }
    session.clearBoard();
  }
}

/**
 * Serializes the parts of the session state that Requirement 1.19 pins down —
 * history, current round, participants and config — plus `lastActivityAt`,
 * which a write would move. `selections` is a `Map`, so it is expanded.
 */
function snapshotSession(session: GameSession): string {
  return JSON.stringify(
    {
      history: session.getHistory(),
      currentRound: session.getCurrentRound(),
      participants: session.getParticipants(),
      config: session.config,
      issueList: session.getIssueList(),
      lastActivityAt: session.lastActivityAt,
    },
    (_key, value: unknown) =>
      value instanceof Map ? Array.from(value.entries()) : (value as unknown)
  );
}

function exportUrl(sessionId: string): string {
  return `/api/sessions/${sessionId}/export`;
}

// ---------------------------------------------------------------------------
// 401 — missing or invalid token (Requirement 1.6)
// ---------------------------------------------------------------------------
describe('GET /api/sessions/:sessionId/export — authentication', () => {
  it('returns 401 UNAUTHORIZED when no Authorization header is sent', async () => {
    const { user } = loginUser('alice');
    const session = createSession(user.id);

    const res = await request(app).get(exportUrl(session.sessionId));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('returns 401 UNAUTHORIZED when the token is invalid', async () => {
    const { user } = loginUser('alice');
    const session = createSession(user.id);

    const res = await request(app)
      .get(exportUrl(session.sessionId))
      .set('Authorization', 'Bearer not-a-real-token');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('returns 401 UNAUTHORIZED when the Authorization scheme is not Bearer', async () => {
    const { user } = loginUser('alice');
    const session = createSession(user.id);

    const res = await request(app)
      .get(exportUrl(session.sessionId))
      .set('Authorization', 'Basic some-token');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('answers 401 rather than 404 for an unknown session, so existence is not disclosed', async () => {
    const res = await request(app).get(exportUrl('nonexist'));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// 404 — unknown session (Requirement 1.8)
// ---------------------------------------------------------------------------
describe('GET /api/sessions/:sessionId/export — unknown session', () => {
  it('returns 404 SESSION_NOT_FOUND for a session the registry does not hold', async () => {
    const { token } = loginUser('alice');

    const res = await request(app)
      .get(exportUrl('nonexist'))
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SESSION_NOT_FOUND');
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('returns 404 after the session has been deleted', async () => {
    const { token, user } = loginUser('alice');
    const session = createSession(user.id);
    const sessionId = session.sessionId;
    sessionRegistry.deleteSession(sessionId);

    const res = await request(app)
      .get(exportUrl(sessionId))
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SESSION_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// 403 — authenticated non-owner (Requirement 1.7)
// ---------------------------------------------------------------------------
describe('GET /api/sessions/:sessionId/export — ownership', () => {
  it('returns 403 FORBIDDEN for an authenticated user who does not own the session', async () => {
    const { user: owner } = loginUser('alice');
    const { token: strangerToken } = loginUser('bob');
    const session = createSession(owner.id);
    playRounds(session, [{ story: 'Story A', votes: [3, 5], reveal: true }]);

    const res = await request(app)
      .get(exportUrl(session.sessionId))
      .set('Authorization', `Bearer ${strangerToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('returns 403 for a moderator participant who is not the owner', async () => {
    const { user: owner } = loginUser('alice');
    const { token: modToken, user: modUser } = loginUser('bob');
    const session = createSession(owner.id);
    session.addParticipant({ ...modUser, role: 'moderator' });

    const res = await request(app)
      .get(exportUrl(session.sessionId))
      .set('Authorization', `Bearer ${modToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
// 200 — the Export_Document and its headers (Requirement 1.5)
// ---------------------------------------------------------------------------
describe('GET /api/sessions/:sessionId/export — success response', () => {
  it('responds 200 with Content-Type text/csv and an attachment Content-Disposition', async () => {
    const { token, user } = loginUser('alice');
    const session = createSession(user.id);
    playRounds(session, [{ story: 'Story A', votes: [3, 5, null], reveal: true }]);

    const res = await request(app)
      .get(exportUrl(session.sessionId))
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    // Exactly `text/csv`: the route sends a Buffer so Express appends no charset.
    expect(res.headers['content-type']).toBe('text/csv');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="scrum-poker-${session.sessionId}.csv"`
    );
    expect(res.headers['content-disposition']).toContain('attachment');
  });

  it('returns the document built by the shared estimate-export module', async () => {
    const { token, user } = loginUser('alice');
    const session = createSession(user.id, 't-shirt');
    playRounds(session, [
      { story: 'Login, with "quotes"', votes: ['S', 'M', 'M'], reveal: true },
      { story: 'Logout', votes: ['L', null], reveal: false },
    ]);

    const res = await request(app)
      .get(exportUrl(session.sessionId))
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.text).toBe(
      buildEstimateExportCsv({
        history: session.getHistory(),
        votingSystem: session.config.votingSystem,
      })
    );
    expect(res.text).toContain('No Vote');
  });

  it('returns a header-only document for a session holding zero completed estimates', async () => {
    const { token, user } = loginUser('alice');
    const session = createSession(user.id);

    const res = await request(app)
      .get(exportUrl(session.sessionId))
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv');
    expect(res.text).toBe(HEADER_ONLY_DOCUMENT);
  });

  it(
    'responds within the 5-second budget for 200 completed estimates of 50 participants',
    async () => {
      const { token, user } = loginUser('alice');
      const session = createSession(user.id);
      const cards = getCardsForVotingSystem('fibonacci');

      const plans: RoundPlan[] = Array.from({ length: 200 }, (_entry, roundIndex) => ({
        story: `Story ${roundIndex}`,
        votes: Array.from(
          { length: 50 },
          (_vote, voterIndex) => cards[(roundIndex + voterIndex) % cards.length]!
        ),
        reveal: true,
      }));
      playRounds(session, plans);
      expect(session.getHistory()).toHaveLength(200);

      const startedAt = Date.now();
      const res = await request(app)
        .get(exportUrl(session.sessionId))
        .set('Authorization', `Bearer ${token}`);
      const elapsedMs = Date.now() - startedAt;

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      // 200 summary rows + 200 vote headers + 200 * 50 vote rows + 1 summary header
      expect(res.text.split('\r\n').filter((line) => line !== '')).toHaveLength(10_401);
      expect(elapsedMs).toBeLessThan(5_000);
    },
    60_000
  );
});

// ---------------------------------------------------------------------------
// Property 23: Export endpoint is a pure read
// ---------------------------------------------------------------------------
describe('Property 23: export endpoint is a pure read', () => {
  const votingSystemArb: fc.Arbitrary<VotingSystemType> = fc.constantFrom(
    'fibonacci',
    'modified-fibonacci',
    't-shirt',
    'power-of-2'
  );

  /**
   * Story descriptions mixing plain text with the characters that force CSV
   * quoting. `startRound` rejects a blank story, so each generated value
   * carries a non-whitespace prefix.
   */
  const storyArb: fc.Arbitrary<string> = fc
    .tuple(
      fc.integer({ min: 0, max: 999 }),
      fc.constantFrom('', ', comma', ' "quoted"', '\nnewline', '\r\nCRLF', ' ünïcode')
    )
    .map(([index, suffix]) => `Story ${index}${suffix}`);

  /** 0–6 participants per round, some of whom did not vote. */
  function votesArb(votingSystem: VotingSystemType): fc.Arbitrary<(ExtendedCardValue | null)[]> {
    const cards = getCardsForVotingSystem(votingSystem);
    return fc.array(fc.option(fc.constantFrom(...cards), { nil: null }), {
      minLength: 0,
      maxLength: 6,
    });
  }

  function roundPlansArb(votingSystem: VotingSystemType): fc.Arbitrary<RoundPlan[]> {
    return fc.array(
      fc.record({
        story: storyArb,
        votes: votesArb(votingSystem),
        reveal: fc.boolean(),
      }),
      { minLength: 0, maxLength: 8 }
    );
  }

  it('returns byte-identical documents and leaves the session state unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        votingSystemArb.chain((votingSystem) =>
          fc.record({
            votingSystem: fc.constant(votingSystem),
            plans: roundPlansArb(votingSystem),
            // Sometimes a round is still in progress, so the snapshot also
            // pins down `currentRound` and the live selections map.
            activeRound: fc.option(storyArb, { nil: null }),
          })
        ),
        async ({ votingSystem, plans, activeRound }) => {
          _resetStore();
          sessionRegistry._reset();

          const { token, user } = loginUser('alice');
          const session = createSession(user.id, votingSystem);
          playRounds(session, plans);
          if (activeRound !== null) {
            session.startRound(activeRound);
          }

          const before = snapshotSession(session);

          const first = await request(app)
            .get(exportUrl(session.sessionId))
            .set('Authorization', `Bearer ${token}`);
          const second = await request(app)
            .get(exportUrl(session.sessionId))
            .set('Authorization', `Bearer ${token}`);

          expect(first.status).toBe(200);
          expect(second.status).toBe(200);
          // Byte-identical: compared as raw UTF-8 bytes, not just as text.
          expect(Buffer.from(second.text, 'utf-8').equals(Buffer.from(first.text, 'utf-8'))).toBe(
            true
          );
          expect(first.headers['content-type']).toBe('text/csv');
          expect(second.headers['content-disposition']).toBe(first.headers['content-disposition']);

          // The deep snapshot — history, current round, participants, config,
          // issue list and last-activity stamp — survives both requests.
          expect(snapshotSession(session)).toBe(before);
          expect(session.getHistory()).toHaveLength(plans.length);
        }
      ),
      { numRuns: 50 }
    );
  }, 120_000);
});
