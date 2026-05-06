import * as fc from 'fast-check';
import { DEFAULT_SESSION_CONFIG, CardValue, FIBONACCI_SEQUENCE } from '../../../../shared/types';
import { GameSession } from '../game-session';

/**
 * Arbitrary generator for card selections: a map of userId -> CardValue.
 */
function arbSelections(): fc.Arbitrary<Array<{ userId: string; cardValue: CardValue }>> {
  return fc.array(
    fc.record({
      userId: fc.uuid(),
      cardValue: fc.constantFrom(...FIBONACCI_SEQUENCE) as fc.Arbitrary<CardValue>,
    }),
    { minLength: 1, maxLength: 10 },
  );
}

/**
 * Property 10: Re-vote preserves story, resets state, does not save history
 *
 * For any game session with a revealed round, calling `revote()` SHALL produce a new
 * voting round with the same `storyDescription` as the previous round, with status
 * 'voting', an empty selections map, and the session's history length SHALL remain
 * unchanged (the previous round is NOT saved to history).
 *
 * **Validates: Requirements 8.2, 8.3, 8.4**
 */
describe('Property 10: Re-vote preserves story, resets state, does not save history', () => {
  it('revote() preserves storyDescription, resets status to voting, empties selections, and does not change history length', () => {
    fc.assert(
      fc.property(
        fc.record({
          storyDescription: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
          selections: arbSelections(),
          historyLength: fc.nat({ max: 10 }),
        }),
        ({ storyDescription, selections, historyLength }) => {
          const session = new GameSession('test-session', 'owner-1', DEFAULT_SESSION_CONFIG);

          // Optionally add some history entries by starting and clearing rounds
          for (let i = 0; i < historyLength; i++) {
            session.addParticipant({ id: `hist-user-${i}`, displayName: `HistUser${i}`, role: 'participant', isAnonymous: false });
            session.startRound(`History story ${i}`);
            session.selectCard(`hist-user-${i}`, 5);
            session.revealCards();
            session.clearBoard();
          }

          // Record history length before the revote scenario
          const historyLengthBefore = session.getHistory().length;
          expect(historyLengthBefore).toBe(historyLength);

          // Start a round with the random story description
          session.startRound(storyDescription);

          // Add participants and make selections
          for (const sel of selections) {
            session.addParticipant({ id: sel.userId, displayName: `User-${sel.userId.slice(0, 8)}`, role: 'participant', isAnonymous: false });
            session.selectCard(sel.userId, sel.cardValue);
          }

          // Reveal cards to get to the revealed state
          session.revealCards();

          // Record the old round ID
          const oldRoundId = session.getCurrentRound()!.id;

          // Call revote()
          const newRound = session.revote();

          // 1. New round has same storyDescription (trimmed)
          expect(newRound.storyDescription).toBe(storyDescription.trim());

          // 2. New round has status 'voting'
          expect(newRound.status).toBe('voting');

          // 3. New round has empty selections
          expect(newRound.selections.size).toBe(0);

          // 4. History length is unchanged
          expect(session.getHistory().length).toBe(historyLengthBefore);

          // 5. New round has a different ID from the old round
          expect(newRound.id).not.toBe(oldRoundId);
        },
      ),
      { numRuns: 100 },
    );
  });
});
