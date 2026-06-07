import * as fc from 'fast-check';
import { RetroConfiguration } from '../../../../shared/types';
import { RetroSessionRegistry } from '../retro-session-registry';
import { RetroSession } from '../retro-session';

/**
 * Helper: generate a valid RetroConfiguration for testing.
 */
function makeConfig(): RetroConfiguration {
  return {
    boardName: 'Test',
    maxVotesPerUser: 6,
    templateId: 'start-stop-continue',
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

/**
 * Arbitrary generator for a valid RetroConfiguration.
 */
function arbRetroConfig(): fc.Arbitrary<RetroConfiguration> {
  const arbTemplateId = fc.constantFrom(
    'start-stop-continue',
    'went-well-improve-actions',
    'mad-sad-glad',
    'four-questions',
    'liked-learned-lacked-longed',
  );

  const arbColumnLayout = fc.constantFrom('vertical' as const, 'horizontal' as const);

  const arbFeelingCategory = fc.constantFrom(
    'Satisfaction' as const, 'Frustration' as const, 'Confidence' as const,
    'Confusion' as const, 'Boredom' as const, 'Happy' as const,
    'No_Feeling' as const, 'Glad' as const, 'Sad' as const, 'Mad' as const,
  );

  const arbAllowedFeelings = fc.uniqueArray(arbFeelingCategory, { minLength: 1, maxLength: 10 });

  return fc.record({
    boardName: fc.string({ minLength: 1, maxLength: 50 }),
    maxVotesPerUser: fc.integer({ min: 1, max: 20 }),
    templateId: arbTemplateId,
    hideCardsInitially: fc.boolean(),
    disableVotingInitially: fc.boolean(),
    hideVoteCount: fc.boolean(),
    oneVotePerCard: fc.boolean(),
    showCardAuthor: fc.boolean(),
    password: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 30 })),
    enableGifEmoji: fc.boolean(),
    columnLayout: arbColumnLayout,
    allowedFeelings: arbAllowedFeelings,
  });
}

/**
 * Property 5: Session ID uniqueness
 *
 * For any sequence of session creations (up to N sessions), all generated
 * session IDs should be unique (no two sessions share the same ID).
 *
 * **Validates: Requirements 5.1**
 */
describe('Property 5: Session ID uniqueness', () => {
  it('all generated session IDs are unique for any sequence of session creations', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ownerId: fc.uuid(),
            config: arbRetroConfig(),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (requests) => {
          const registry = new RetroSessionRegistry();

          const sessionIds: string[] = [];

          for (const req of requests) {
            const info = registry.createSession(req.ownerId, req.config);
            sessionIds.push(info.sessionId);
          }

          // All session IDs must be unique
          const uniqueIds = new Set(sessionIds);
          expect(uniqueIds.size).toBe(sessionIds.length);

          // Each session should be retrievable
          for (const id of sessionIds) {
            expect(registry.hasSession(id)).toBe(true);
            expect(registry.getSession(id)).toBeDefined();
          }

          // Cleanup
          registry._reset();
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Represents an operation that can be performed on a RetroSession.
 */
type RetroSessionOp =
  | { type: 'addCard'; columnIndex: number; text: string; authorId: string; authorName: string }
  | { type: 'addColumn'; name: string }
  | { type: 'addParticipant'; userId: string; displayName: string }
  | { type: 'vote'; cardIndex: number; columnIndex: number; userId: string };

/**
 * Arbitrary generator for a retro session operation.
 */
function arbRetroSessionOp(): fc.Arbitrary<RetroSessionOp> {
  return fc.oneof(
    fc.record({
      type: fc.constant('addCard' as const),
      columnIndex: fc.integer({ min: 0, max: 4 }),
      text: fc.string({ minLength: 1, maxLength: 50 }),
      authorId: fc.uuid(),
      authorName: fc.string({ minLength: 1, maxLength: 20 }),
    }),
    fc.record({
      type: fc.constant('addColumn' as const),
      name: fc.string({ minLength: 1, maxLength: 30 }),
    }),
    fc.record({
      type: fc.constant('addParticipant' as const),
      userId: fc.uuid(),
      displayName: fc.string({ minLength: 1, maxLength: 20 }),
    }),
    fc.record({
      type: fc.constant('vote' as const),
      cardIndex: fc.integer({ min: 0, max: 10 }),
      columnIndex: fc.integer({ min: 0, max: 4 }),
      userId: fc.uuid(),
    }),
  );
}

/**
 * Apply an operation to a RetroSession, swallowing errors
 * (since random operations may produce invalid states).
 */
function applyRetroOp(session: RetroSession, op: RetroSessionOp): void {
  try {
    switch (op.type) {
      case 'addParticipant':
        session.addParticipant({
          id: op.userId,
          displayName: op.displayName,
          role: 'participant',
          isAnonymous: false,
        });
        break;
      case 'addColumn':
        session.addColumn(op.name);
        break;
      case 'addCard': {
        const state = session.getSessionState();
        if (state.board.columns.length > 0) {
          const colIdx = op.columnIndex % state.board.columns.length;
          const column = state.board.columns[colIdx];
          session.addCard(column.id, op.text, op.authorId, op.authorName);
        }
        break;
      }
      case 'vote': {
        const state = session.getSessionState();
        if (state.board.columns.length > 0) {
          const colIdx = op.columnIndex % state.board.columns.length;
          const column = state.board.columns[colIdx];
          if (column.cards.length > 0) {
            const cardIdx = op.cardIndex % column.cards.length;
            const card = column.cards[cardIdx];
            session.voteCard(card.id, op.userId);
          }
        }
        break;
      }
    }
  } catch {
    // Operations may throw for invalid state transitions.
    // This is expected — we only care about isolation.
  }
}

/**
 * Snapshot the observable state of a RetroSession for comparison.
 */
function snapshotRetroSession(session: RetroSession): string {
  const state = session.getSessionState();
  return JSON.stringify(state);
}

/**
 * Property 24: Session isolation
 *
 * For any two concurrent retro sessions, any modification to one session's state
 * (adding cards, voting, column changes, etc.) should not affect the other session's state.
 *
 * **Validates: Requirements 15.2**
 */
describe('Property 24: Session isolation', () => {
  it('modifications to one session do not affect another session', () => {
    fc.assert(
      fc.property(
        fc.record({
          configA: arbRetroConfig(),
          configB: arbRetroConfig(),
          ownerA: fc.uuid(),
          ownerB: fc.uuid(),
          opsOnA: fc.array(arbRetroSessionOp(), { minLength: 1, maxLength: 15 }),
        }),
        ({ configA, configB, ownerA, ownerB, opsOnA }) => {
          const registry = new RetroSessionRegistry();

          // Create two distinct sessions
          const infoA = registry.createSession(ownerA, configA);
          const infoB = registry.createSession(ownerB, configB);

          const sessionA = registry.getSession(infoA.sessionId)!;
          const sessionB = registry.getSession(infoB.sessionId)!;

          expect(sessionA).toBeDefined();
          expect(sessionB).toBeDefined();
          expect(infoA.sessionId).not.toBe(infoB.sessionId);

          // Snapshot session B's state before any operations on A
          const snapshotBefore = snapshotRetroSession(sessionB);

          // Perform random operations on session A only
          for (const op of opsOnA) {
            applyRetroOp(sessionA, op);
          }

          // Snapshot session B's state after operations on A
          const snapshotAfter = snapshotRetroSession(sessionB);

          // Session B's state must be unchanged
          expect(snapshotAfter).toBe(snapshotBefore);

          // Cleanup
          registry._reset();
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 25: Inactive session cleanup
 *
 * For any session with zero participants and lastActivityAt older than 30 minutes,
 * running the cleanup process should remove that session from the registry.
 *
 * **Validates: Requirements 15.3**
 */
describe('Property 25: Inactive session cleanup', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sessions with zero participants and inactive for >30 minutes are cleaned up', () => {
    fc.assert(
      fc.property(
        fc.record({
          config: arbRetroConfig(),
          ownerId: fc.uuid(),
          inactiveMinutes: fc.integer({ min: 31, max: 120 }),
        }),
        ({ config, ownerId, inactiveMinutes }) => {
          const registry = new RetroSessionRegistry();

          // Create a session
          const info = registry.createSession(ownerId, config);
          const session = registry.getSession(info.sessionId)!;
          expect(session).toBeDefined();

          // Ensure session has zero participants (default state)
          expect(session.getParticipantCount()).toBe(0);

          // Set lastActivityAt to be older than 30 minutes
          const pastTime = new Date(Date.now() - inactiveMinutes * 60 * 1000).toISOString();
          session.lastActivityAt = pastTime;

          // Start cleanup and advance time to trigger the cleanup interval (5 minutes)
          registry.startCleanup();
          jest.advanceTimersByTime(5 * 60 * 1000);

          // Session should have been removed
          expect(registry.hasSession(info.sessionId)).toBe(false);
          expect(registry.getSession(info.sessionId)).toBeUndefined();

          // Cleanup
          registry._reset();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('sessions with participants are NOT cleaned up even if inactive', () => {
    fc.assert(
      fc.property(
        fc.record({
          config: arbRetroConfig(),
          ownerId: fc.uuid(),
          participantId: fc.uuid(),
          participantName: fc.string({ minLength: 1, maxLength: 20 }),
          inactiveMinutes: fc.integer({ min: 31, max: 120 }),
        }),
        ({ config, ownerId, participantId, participantName, inactiveMinutes }) => {
          const registry = new RetroSessionRegistry();

          // Create a session
          const info = registry.createSession(ownerId, config);
          const session = registry.getSession(info.sessionId)!;

          // Add a participant
          session.addParticipant({
            id: participantId,
            displayName: participantName,
            role: 'participant',
            isAnonymous: false,
          });

          // Set lastActivityAt to be older than 30 minutes
          const pastTime = new Date(Date.now() - inactiveMinutes * 60 * 1000).toISOString();
          session.lastActivityAt = pastTime;

          // Start cleanup and advance time to trigger the cleanup interval
          registry.startCleanup();
          jest.advanceTimersByTime(5 * 60 * 1000);

          // Session should NOT have been removed (has participants)
          expect(registry.hasSession(info.sessionId)).toBe(true);
          expect(registry.getSession(info.sessionId)).toBeDefined();

          // Cleanup
          registry._reset();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('sessions that are inactive for less than 30 minutes are NOT cleaned up', () => {
    fc.assert(
      fc.property(
        fc.record({
          config: arbRetroConfig(),
          ownerId: fc.uuid(),
          // Account for the 5-minute timer advancement: total inactivity will be
          // inactiveMinutes + 5, so we cap at 24 to ensure total stays under 30.
          inactiveMinutes: fc.integer({ min: 0, max: 24 }),
        }),
        ({ config, ownerId, inactiveMinutes }) => {
          const registry = new RetroSessionRegistry();

          // Create a session
          const info = registry.createSession(ownerId, config);
          const session = registry.getSession(info.sessionId)!;

          // Ensure session has zero participants
          expect(session.getParticipantCount()).toBe(0);

          // Set lastActivityAt to be less than 30 minutes ago.
          // After advancing timers by 5 minutes, total inactivity will be
          // inactiveMinutes + 5, which is at most 29 minutes (< 30 threshold).
          const pastTime = new Date(Date.now() - inactiveMinutes * 60 * 1000).toISOString();
          session.lastActivityAt = pastTime;

          // Start cleanup and advance time to trigger the cleanup interval (5 minutes)
          registry.startCleanup();
          jest.advanceTimersByTime(5 * 60 * 1000);

          // Session should NOT have been removed (not inactive long enough)
          expect(registry.hasSession(info.sessionId)).toBe(true);

          // Cleanup
          registry._reset();
        },
      ),
      { numRuns: 100 },
    );
  });
});
