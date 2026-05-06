import * as fc from 'fast-check';
import {
  User,
  CardValue,
  ALL_CARDS,
  SessionConfiguration,
  DEFAULT_SESSION_CONFIG,
} from '../../../../shared/types';
import { GameSession } from '../game-session';

/**
 * Helper: create a User object with the given id.
 */
function makeUser(id: string, role: 'moderator' | 'participant' = 'participant'): User {
  return { id, displayName: `User ${id}`, role, isAnonymous: false };
}

/**
 * Helper: create a SessionConfiguration with the given autoReveal flag.
 */
function makeConfig(autoReveal: boolean): SessionConfiguration {
  return { ...DEFAULT_SESSION_CONFIG, autoReveal };
}

/**
 * Property 7: Auto-reveal trigger logic
 *
 * For any game session with a set of participants and a current voting round,
 * `checkAutoReveal` SHALL return `true` if and only if auto-reveal is enabled
 * in the session configuration AND every participant in the session has a card
 * selection in the current round's selections map.
 *
 * Validates: Requirements 10.3, 10.5
 */
describe('Property 7: Auto-reveal trigger logic', () => {
  // Generator for a non-empty set of unique participant IDs
  const arbParticipantIds = fc
    .uniqueArray(fc.uuid(), { minLength: 1, maxLength: 10 })
    .filter((ids) => ids.length >= 1);

  // Generator for a card value
  const arbCardValue = fc.constantFrom<CardValue>(...ALL_CARDS);

  it('checkAutoReveal returns true iff auto-reveal is enabled AND every participant has voted', () => {
    fc.assert(
      fc.property(
        arbParticipantIds,
        fc.boolean(),
        (participantIds: string[], autoReveal: boolean) => {
          const session = new GameSession('test-session', 'owner-1', makeConfig(autoReveal));

          // Add all participants
          for (const id of participantIds) {
            session.addParticipant(makeUser(id));
          }

          // Start a round
          session.startRound('Test story');

          // Generate a random subset of voters using a deterministic approach:
          // have ALL participants vote so we test the "all voted" case
          for (const id of participantIds) {
            session.selectCard(id, 5);
          }

          const result = session.checkAutoReveal();

          // All participants have voted, so result depends only on autoReveal flag
          const expected = autoReveal;
          expect(result).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('checkAutoReveal returns false when not all participants have voted, regardless of autoReveal', () => {
    fc.assert(
      fc.property(
        // Need at least 2 participants so we can have a non-empty non-full subset
        fc.uniqueArray(fc.uuid(), { minLength: 2, maxLength: 10 }),
        fc.boolean(),
        arbCardValue,
        (participantIds: string[], autoReveal: boolean, cardValue: CardValue) => {
          const session = new GameSession('test-session', 'owner-1', makeConfig(autoReveal));

          // Add all participants
          for (const id of participantIds) {
            session.addParticipant(makeUser(id));
          }

          // Start a round
          session.startRound('Test story');

          // Only the first participant votes (leaving at least one without a vote)
          session.selectCard(participantIds[0], cardValue);

          const result = session.checkAutoReveal();

          // Not all participants have voted, so should always be false
          expect(result).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('checkAutoReveal correctly reflects the biconditional for arbitrary voter subsets', () => {
    fc.assert(
      fc.property(
        arbParticipantIds,
        fc.boolean(),
        arbCardValue,
        fc.func(fc.boolean()),
        (
          participantIds: string[],
          autoReveal: boolean,
          cardValue: CardValue,
          shouldVoteFn: (v: unknown) => boolean,
        ) => {
          const session = new GameSession('test-session', 'owner-1', makeConfig(autoReveal));

          // Add all participants
          for (const id of participantIds) {
            session.addParticipant(makeUser(id));
          }

          // Start a round
          session.startRound('Test story');

          // Determine which participants vote based on the generated function
          const voters: string[] = [];
          for (const id of participantIds) {
            if (shouldVoteFn(id)) {
              session.selectCard(id, cardValue);
              voters.push(id);
            }
          }

          const allVoted = voters.length === participantIds.length;
          const result = session.checkAutoReveal();
          const expected = autoReveal && allVoted;

          expect(result).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 8: Voting duration computation
 *
 * For any voting round with valid startedAt and revealedAt ISO 8601 timestamps
 * where revealedAt is after startedAt, the computed votingDurationMs SHALL equal
 * the difference in milliseconds between the two timestamps, and this value SHALL
 * be included in the history entry when the board is cleared.
 *
 * **Validates: Requirements 12.3, 12.4**
 */
describe('Property 8: Voting duration computation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('votingDurationMs equals revealedAt - startedAt in milliseconds and is included in the history entry', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2000000000000 }),
        fc.integer({ min: 1, max: 3600000 }),
        (startMs: number, durationMs: number) => {
          // Set the clock to the start time
          jest.setSystemTime(new Date(startMs));

          const session = new GameSession(
            'test-session',
            'owner-1',
            { ...DEFAULT_SESSION_CONFIG },
          );

          // Add a participant and start a round
          session.addParticipant(makeUser('user-1'));
          const round = session.startRound('Test story');

          // Verify startedAt was captured at startMs
          const startedAtMs = new Date(round.startedAt).getTime();
          expect(startedAtMs).toBe(startMs);

          // Have the participant vote
          session.selectCard('user-1', 5);

          // Advance time by the generated duration
          const revealMs = startMs + durationMs;
          jest.setSystemTime(new Date(revealMs));

          // Reveal cards — this computes votingDurationMs
          const revealResult = session.revealCards();

          // Verify the current round has the correct votingDurationMs
          const currentRound = session.getCurrentRound();
          expect(currentRound).not.toBeNull();
          expect(currentRound!.votingDurationMs).toBe(durationMs);

          // Verify revealedAt was captured at revealMs
          const revealedAtMs = new Date(currentRound!.revealedAt!).getTime();
          expect(revealedAtMs).toBe(revealMs);

          // Clear the board — this creates a history entry
          const historyEntry = session.clearBoard();

          // Verify the history entry includes the correct votingDurationMs
          expect(historyEntry.votingDurationMs).toBe(durationMs);

          // Also verify it's in the session history
          const history = session.getHistory();
          expect(history.length).toBe(1);
          expect(history[0].votingDurationMs).toBe(durationMs);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('votingDurationMs is consistent with the difference between revealedAt and startedAt timestamps', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2000000000000 }),
        fc.integer({ min: 1, max: 3600000 }),
        (startMs: number, durationMs: number) => {
          jest.setSystemTime(new Date(startMs));

          const session = new GameSession(
            'test-session',
            'owner-1',
            { ...DEFAULT_SESSION_CONFIG },
          );

          session.addParticipant(makeUser('user-1'));
          session.startRound('Test story');
          session.selectCard('user-1', 8);

          // Advance time
          jest.setSystemTime(new Date(startMs + durationMs));
          session.revealCards();

          const round = session.getCurrentRound()!;
          const computedDuration =
            new Date(round.revealedAt!).getTime() - new Date(round.startedAt).getTime();

          // The votingDurationMs should equal the timestamp difference
          expect(round.votingDurationMs).toBe(computedDuration);
          expect(computedDuration).toBe(durationMs);
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 10: Session configuration update persistence
 *
 * For any game session and for any sequence of partial configuration updates,
 * the session's configuration after applying all updates SHALL reflect the last
 * value set for each configuration field, with unchanged fields retaining their
 * previous values.
 *
 * **Validates: Requirements 14.2, 14.5**
 */
describe('Property 10: Session configuration update persistence', () => {
  // Generator for a VotingSystemType
  const arbVotingSystem = fc.constantFrom(
    'fibonacci' as const,
    'modified-fibonacci' as const,
    't-shirt' as const,
    'power-of-2' as const,
  );

  // Generator for a PermissionMode
  const arbPermissionMode = fc.constantFrom(
    'moderator-only' as const,
    'all-players' as const,
    'select-specific' as const,
  );

  // Generator for a PermissionConfig
  const arbPermissionConfig = fc.record({
    mode: arbPermissionMode,
    allowedUserIds: fc.array(fc.uuid(), { minLength: 0, maxLength: 5 }),
  });

  // Generator for a full SessionConfiguration
  const arbSessionConfig: fc.Arbitrary<SessionConfiguration> = fc.record({
    votingSystem: arbVotingSystem,
    revealPermission: arbPermissionConfig,
    issuePermission: arbPermissionConfig,
    autoReveal: fc.boolean(),
    countdownAnimation: fc.boolean(),
  });

  // Generator for a partial SessionConfiguration update (each field is optional)
  const arbPartialConfig: fc.Arbitrary<Partial<SessionConfiguration>> = fc
    .record({
      votingSystem: fc.option(arbVotingSystem, { nil: undefined }),
      revealPermission: fc.option(arbPermissionConfig, { nil: undefined }),
      issuePermission: fc.option(arbPermissionConfig, { nil: undefined }),
      autoReveal: fc.option(fc.boolean(), { nil: undefined }),
      countdownAnimation: fc.option(fc.boolean(), { nil: undefined }),
    })
    .map((rec) => {
      // Remove undefined keys to produce a true partial object
      const partial: Partial<SessionConfiguration> = {};
      if (rec.votingSystem !== undefined) partial.votingSystem = rec.votingSystem;
      if (rec.revealPermission !== undefined) partial.revealPermission = rec.revealPermission;
      if (rec.issuePermission !== undefined) partial.issuePermission = rec.issuePermission;
      if (rec.autoReveal !== undefined) partial.autoReveal = rec.autoReveal;
      if (rec.countdownAnimation !== undefined) partial.countdownAnimation = rec.countdownAnimation;
      return partial;
    });

  it('final config reflects the last value set for each field after a sequence of partial updates', () => {
    fc.assert(
      fc.property(
        arbSessionConfig,
        fc.array(arbPartialConfig, { minLength: 1, maxLength: 20 }),
        (initialConfig: SessionConfiguration, updates: Partial<SessionConfiguration>[]) => {
          const session = new GameSession('test-session', 'owner-1', initialConfig);

          // Apply each partial update sequentially
          for (const update of updates) {
            session.updateConfig(update);
          }

          // Compute the expected final config by replaying updates on the initial config
          let expected: SessionConfiguration = { ...initialConfig };
          for (const update of updates) {
            expected = { ...expected, ...update };
          }

          // Verify each field matches the expected value
          const finalConfig = session.config;
          expect(finalConfig.votingSystem).toBe(expected.votingSystem);
          expect(finalConfig.autoReveal).toBe(expected.autoReveal);
          expect(finalConfig.countdownAnimation).toBe(expected.countdownAnimation);
          expect(finalConfig.revealPermission).toEqual(expected.revealPermission);
          expect(finalConfig.issuePermission).toEqual(expected.issuePermission);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('unchanged fields retain their previous values when partial updates omit them', () => {
    fc.assert(
      fc.property(
        arbSessionConfig,
        arbPartialConfig,
        (initialConfig: SessionConfiguration, partialUpdate: Partial<SessionConfiguration>) => {
          const session = new GameSession('test-session', 'owner-1', initialConfig);

          // Snapshot the config before the update
          const configBefore = { ...session.config };

          // Apply the partial update
          const updatedConfig = session.updateConfig(partialUpdate);

          // For each field NOT in the partial update, verify it retained its previous value
          const allFields: (keyof SessionConfiguration)[] = [
            'votingSystem',
            'revealPermission',
            'issuePermission',
            'autoReveal',
            'countdownAnimation',
          ];

          for (const field of allFields) {
            if (field in partialUpdate) {
              // Field was updated — should reflect the new value
              expect(updatedConfig[field]).toEqual(partialUpdate[field]);
            } else {
              // Field was NOT updated — should retain the previous value
              expect(updatedConfig[field]).toEqual(configBefore[field]);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
