import * as fc from 'fast-check';
import {
  SessionConfiguration,
  DEFAULT_SESSION_CONFIG,
} from '../../../../shared/types';
import { SessionRegistry } from '../session-registry';

/**
 * Arbitrary generator for a valid SessionConfiguration.
 */
function arbSessionConfig(): fc.Arbitrary<SessionConfiguration> {
  const arbVotingSystem = fc.constantFrom(
    'fibonacci' as const,
    'modified-fibonacci' as const,
    't-shirt' as const,
    'power-of-2' as const,
  );

  const arbPermissionMode = fc.constantFrom(
    'moderator-only' as const,
    'all-players' as const,
    'select-specific' as const,
  );

  const arbPermissionConfig = fc.record({
    mode: arbPermissionMode,
    allowedUserIds: fc.array(fc.uuid(), { minLength: 0, maxLength: 5 }),
  });

  return fc.record({
    votingSystem: arbVotingSystem,
    revealPermission: arbPermissionConfig,
    issuePermission: arbPermissionConfig,
    autoReveal: fc.boolean(),
    countdownAnimation: fc.boolean(),
  });
}

/**
 * Property 1: Session creation produces unique IDs with correct owner
 *
 * For any sequence of N creation requests, all session IDs are distinct,
 * each session is retrievable, and each session's ownerId matches the creator.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3**
 */
describe('Property 1: Session creation produces unique IDs with correct owner', () => {
  it('all session IDs are distinct, each session is retrievable, and each ownerId matches the creator', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ownerId: fc.uuid(),
            config: arbSessionConfig(),
          }),
          { minLength: 0, maxLength: 20 },
        ),
        (requests) => {
          const registry = new SessionRegistry();

          const createdSessions: Array<{ sessionId: string; ownerId: string; config: SessionConfiguration }> = [];

          // Create all sessions
          for (const req of requests) {
            const info = registry.createSession(req.ownerId, req.config);
            createdSessions.push({
              sessionId: info.sessionId,
              ownerId: req.ownerId,
              config: req.config,
            });
          }

          // Verify all session IDs are unique
          const sessionIds = createdSessions.map((s) => s.sessionId);
          const uniqueIds = new Set(sessionIds);
          expect(uniqueIds.size).toBe(sessionIds.length);

          // Verify each session is retrievable and ownerId matches
          for (const created of createdSessions) {
            const session = registry.getSession(created.sessionId);
            expect(session).toBeDefined();
            expect(session!.ownerId).toBe(created.ownerId);
          }

          // Cleanup
          registry._reset();
        },
      ),
      { numRuns: 100 },
    );
  });
});

import { GameSession } from '../game-session';
import { User, CardValue, ALL_CARDS, HistoryEntry } from '../../../../shared/types';

/**
 * Represents an operation that can be performed on a GameSession.
 */
type SessionOp =
  | { type: 'addParticipant'; user: User }
  | { type: 'startRound'; storyDescription: string }
  | { type: 'selectCard'; userId: string; cardValue: CardValue }
  | { type: 'revealCards' }
  | { type: 'clearBoard' };

/**
 * Arbitrary generator for a User.
 */
function arbUser(): fc.Arbitrary<User> {
  return fc.record({
    id: fc.uuid(),
    displayName: fc.string({ minLength: 1, maxLength: 20 }),
    role: fc.constantFrom('moderator' as const, 'participant' as const),
    isAnonymous: fc.boolean(),
  });
}

/**
 * Arbitrary generator for a CardValue.
 */
function arbCardValue(): fc.Arbitrary<CardValue> {
  return fc.constantFrom(...ALL_CARDS);
}

/**
 * Arbitrary generator for a session operation.
 * Generates a random operation that can be applied to a GameSession.
 */
function arbSessionOp(): fc.Arbitrary<SessionOp> {
  return fc.oneof(
    arbUser().map((user): SessionOp => ({ type: 'addParticipant', user })),
    fc.string({ minLength: 1, maxLength: 50 }).map(
      (desc): SessionOp => ({ type: 'startRound', storyDescription: desc }),
    ),
    fc.record({ userId: fc.uuid(), cardValue: arbCardValue() }).map(
      ({ userId, cardValue }): SessionOp => ({ type: 'selectCard', userId, cardValue }),
    ),
    fc.constant<SessionOp>({ type: 'revealCards' }),
    fc.constant<SessionOp>({ type: 'clearBoard' }),
  );
}

/**
 * Apply an operation to a GameSession, swallowing any errors
 * (since random operation sequences may produce invalid states).
 */
function applyOp(session: GameSession, op: SessionOp): void {
  try {
    switch (op.type) {
      case 'addParticipant':
        session.addParticipant(op.user);
        break;
      case 'startRound':
        session.startRound(op.storyDescription);
        break;
      case 'selectCard':
        session.selectCard(op.userId, op.cardValue);
        break;
      case 'revealCards':
        session.revealCards();
        break;
      case 'clearBoard':
        session.clearBoard();
        break;
    }
  } catch {
    // Operations may throw for invalid state transitions (e.g., reveal without round).
    // This is expected — we only care about isolation, not operation success.
  }
}

/**
 * Snapshot the observable state of a GameSession for comparison.
 */
function snapshotSession(session: GameSession): {
  participants: User[];
  currentRound: ReturnType<GameSession['getCurrentRound']>;
  history: HistoryEntry[];
} {
  const currentRound = session.getCurrentRound();
  return {
    participants: session.getParticipants().map((p) => ({ ...p })),
    currentRound: currentRound
      ? {
          ...currentRound,
          selections: new Map(currentRound.selections),
        }
      : null,
    history: session.getHistory().map((h) => ({ ...h })),
  };
}

/**
 * Deep-compare two session snapshots for equality.
 */
function snapshotsEqual(
  a: ReturnType<typeof snapshotSession>,
  b: ReturnType<typeof snapshotSession>,
): boolean {
  // Compare participants
  if (a.participants.length !== b.participants.length) return false;
  for (let i = 0; i < a.participants.length; i++) {
    if (
      a.participants[i].id !== b.participants[i].id ||
      a.participants[i].displayName !== b.participants[i].displayName ||
      a.participants[i].role !== b.participants[i].role ||
      a.participants[i].isAnonymous !== b.participants[i].isAnonymous
    ) {
      return false;
    }
  }

  // Compare current round
  if (a.currentRound === null && b.currentRound !== null) return false;
  if (a.currentRound !== null && b.currentRound === null) return false;
  if (a.currentRound !== null && b.currentRound !== null) {
    if (
      a.currentRound.id !== b.currentRound.id ||
      a.currentRound.storyDescription !== b.currentRound.storyDescription ||
      a.currentRound.status !== b.currentRound.status ||
      a.currentRound.startedAt !== b.currentRound.startedAt ||
      a.currentRound.revealedAt !== b.currentRound.revealedAt
    ) {
      return false;
    }
    // Compare selections maps
    if (a.currentRound.selections.size !== b.currentRound.selections.size) return false;
    for (const [key, val] of a.currentRound.selections) {
      if (b.currentRound.selections.get(key) !== val) return false;
    }
  }

  // Compare history
  if (a.history.length !== b.history.length) return false;
  for (let i = 0; i < a.history.length; i++) {
    if (
      a.history[i].roundId !== b.history[i].roundId ||
      a.history[i].storyDescription !== b.history[i].storyDescription ||
      a.history[i].completedAt !== b.history[i].completedAt
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Property 2: Session state isolation
 *
 * For any two distinct active game sessions, performing operations on one session
 * (adding participants, starting rounds, selecting cards, revealing, clearing board)
 * SHALL NOT change the participant list, current round state, or history of the other session.
 *
 * **Validates: Requirements 1.5, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3**
 */
describe('Property 2: Session state isolation', () => {
  it('operations on one session do not change the other session\'s participants, round state, or history', () => {
    fc.assert(
      fc.property(
        fc.record({
          configA: arbSessionConfig(),
          configB: arbSessionConfig(),
          ownerA: fc.uuid(),
          ownerB: fc.uuid(),
          opsOnA: fc.array(arbSessionOp(), { minLength: 1, maxLength: 15 }),
        }),
        ({ configA, configB, ownerA, ownerB, opsOnA }) => {
          const registry = new SessionRegistry();

          // Create two distinct sessions
          const infoA = registry.createSession(ownerA, configA);
          const infoB = registry.createSession(ownerB, configB);

          const sessionA = registry.getSession(infoA.sessionId)!;
          const sessionB = registry.getSession(infoB.sessionId)!;

          expect(sessionA).toBeDefined();
          expect(sessionB).toBeDefined();
          expect(infoA.sessionId).not.toBe(infoB.sessionId);

          // Snapshot session B's state before any operations on A
          const snapshotBefore = snapshotSession(sessionB);

          // Perform random operations on session A only
          for (const op of opsOnA) {
            applyOp(sessionA, op);
          }

          // Snapshot session B's state after operations on A
          const snapshotAfter = snapshotSession(sessionB);

          // Session B's state must be unchanged
          expect(snapshotsEqual(snapshotBefore, snapshotAfter)).toBe(true);

          // Cleanup
          registry._reset();
        },
      ),
      { numRuns: 100 },
    );
  });
});
