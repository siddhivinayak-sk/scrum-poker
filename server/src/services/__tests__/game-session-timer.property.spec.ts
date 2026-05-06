import * as fc from 'fast-check';
import { DEFAULT_SESSION_CONFIG } from '../../../../shared/types';
import { GameSession } from '../game-session';

/**
 * Property 4: Voting duration computation
 *
 * For any voting round with valid `startedAt` and `revealedAt` ISO 8601 timestamps
 * where `revealedAt` is after `startedAt`, the computed `votingDurationMs` SHALL equal
 * the difference in milliseconds between the two timestamps.
 *
 * **Validates: Requirements 3.3, 14.3**
 */
describe('Property 4: Voting duration computation', () => {
  it('votingDurationMs equals revealedAt - startedAt in milliseconds', () => {
    fc.assert(
      fc.property(
        fc.record({
          startMs: fc.integer({ min: 0, max: 2000000000000 }),
          durationMs: fc.integer({ min: 1, max: 3600000 }),
        }),
        ({ startMs, durationMs }) => {
          const session = new GameSession('test-session', 'owner-1', DEFAULT_SESSION_CONFIG);

          // Add a participant so we can select a card
          const participantId = 'participant-1';
          session.addParticipant({
            id: participantId,
            displayName: 'Test User',
            role: 'participant',
            isAnonymous: false,
          });

          // Start a round
          session.startRound('Test Story');

          // Override startedAt with our controlled timestamp
          const round = session.getCurrentRound()!;
          const startDate = new Date(startMs);
          round.startedAt = startDate.toISOString();

          // Add a card selection so the round has votes
          session.selectCard(participantId, 5);

          // Mock Date to control revealedAt
          const revealedMs = startMs + durationMs;
          const revealDate = new Date(revealedMs);
          const originalDateNow = Date.now;
          const OriginalDate = global.Date;

          // Override Date constructor to return our controlled time for reveal
          const MockDate = class extends OriginalDate {
            constructor(...args: any[]) {
              if (args.length === 0) {
                super(revealedMs);
              } else {
                super(...(args as [any]));
              }
            }

            static now() {
              return revealedMs;
            }
          } as DateConstructor;

          global.Date = MockDate;

          try {
            // Reveal cards
            session.revealCards();

            const revealedRound = session.getCurrentRound()!;

            // Verify votingDurationMs is the difference
            const expectedDuration =
              new OriginalDate(revealedRound.revealedAt!).getTime() -
              new OriginalDate(revealedRound.startedAt).getTime();

            expect(revealedRound.votingDurationMs).toBe(expectedDuration);
            expect(expectedDuration).toBe(durationMs);
          } finally {
            global.Date = OriginalDate;
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 13: Timestamps stored in UTC ISO 8601 format
 *
 * For any voting round created by `startRound()`, the `startedAt` timestamp SHALL be
 * a valid ISO 8601 string ending with 'Z' (UTC). Similarly, after `revealCards()`,
 * the `revealedAt` timestamp SHALL be a valid ISO 8601 string ending with 'Z'.
 *
 * **Validates: Requirements 14.1**
 */
describe('Property 13: Timestamps stored in UTC ISO 8601 format', () => {
  const ISO_8601_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;

  it('startedAt is a valid ISO 8601 string ending with Z', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        (storyDescription) => {
          // Filter out whitespace-only strings since startRound rejects them
          if (storyDescription.trim().length === 0) return;

          const session = new GameSession('test-session', 'owner-1', DEFAULT_SESSION_CONFIG);

          session.startRound(storyDescription);
          const round = session.getCurrentRound()!;

          // startedAt should be a valid ISO 8601 UTC string
          expect(round.startedAt).toMatch(ISO_8601_UTC_REGEX);
          expect(round.startedAt.endsWith('Z')).toBe(true);

          // Should be parseable as a valid date
          const parsed = new Date(round.startedAt);
          expect(parsed.getTime()).not.toBeNaN();
          // Re-serializing should produce the same string
          expect(parsed.toISOString()).toBe(round.startedAt);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('revealedAt is a valid ISO 8601 string ending with Z after revealCards()', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        (storyDescription) => {
          // Filter out whitespace-only strings since startRound rejects them
          if (storyDescription.trim().length === 0) return;

          const session = new GameSession('test-session', 'owner-1', DEFAULT_SESSION_CONFIG);

          // Add a participant and select a card so reveal works
          const participantId = 'participant-1';
          session.addParticipant({
            id: participantId,
            displayName: 'Test User',
            role: 'participant',
            isAnonymous: false,
          });

          session.startRound(storyDescription);
          session.selectCard(participantId, 8);
          session.revealCards();

          const round = session.getCurrentRound()!;

          // revealedAt should be a valid ISO 8601 UTC string
          expect(round.revealedAt).toBeDefined();
          expect(round.revealedAt!).toMatch(ISO_8601_UTC_REGEX);
          expect(round.revealedAt!.endsWith('Z')).toBe(true);

          // Should be parseable as a valid date
          const parsed = new Date(round.revealedAt!);
          expect(parsed.getTime()).not.toBeNaN();
          // Re-serializing should produce the same string
          expect(parsed.toISOString()).toBe(round.revealedAt!);
        },
      ),
      { numRuns: 100 },
    );
  });
});
