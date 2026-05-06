import * as fc from 'fast-check';
import {
  CardValue,
  ALL_CARDS,
  User,
} from '../../../../shared/types';
import {
  _reset,
  addParticipant,
  selectCard,
  startRound,
  getCurrentRound,
  revealCards,
  clearBoard,
  getHistory,
  clearHistory,
  getSelections,
} from '../session-manager';

/**
 * Helper: create a User object with the given id and displayName.
 */
function makeUser(id: string, displayName: string): User {
  return { id, displayName, role: 'participant', isAnonymous: false };
}

/**
 * Helper: run a full voting round through to clearBoard, returning the history entry.
 * Adds participants, starts a round, selects cards, reveals, and clears.
 */
function completeRound(
  story: string,
  participants: { id: string; displayName: string; card: CardValue }[],
) {
  for (const p of participants) {
    addParticipant(makeUser(p.id, p.displayName));
  }
  startRound(story);
  for (const p of participants) {
    selectCard(p.id, p.card);
  }
  revealCards();
  return clearBoard();
}

beforeEach(() => {
  _reset();
});

/**
 * Property 5: Card selection last-write-wins
 *
 * For any participant and for any sequence of card selections during an
 * active voting round, the recorded selection SHALL always be the most
 * recently selected card value, replacing all previous selections.
 *
 * Validates: Requirements 8.1, 8.2
 */
describe('Property 5: Card selection last-write-wins', () => {
  it('only the last card value in a sequence is recorded', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...ALL_CARDS), { minLength: 2, maxLength: 10 }),
        (cardSequence: CardValue[]) => {
          _reset();

          const userId = 'user-lww';
          addParticipant(makeUser(userId, 'Test User'));
          startRound('Estimation story');

          // Select each card in sequence
          for (const card of cardSequence) {
            selectCard(userId, card);
          }

          const selections = getSelections();
          const lastCard = cardSequence[cardSequence.length - 1];

          expect(selections.get(userId)).toBe(lastCard);
          expect(selections.size).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 6: Story submission starts round
 *
 * For any non-empty story description submitted by a moderator, the
 * Session_Manager SHALL create a new VotingRound with status 'voting'
 * and the submitted story description.
 *
 * Validates: Requirements 7.2
 */
describe('Property 6: Story submission starts round', () => {
  it('startRound creates a VotingRound with status voting and the submitted description', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 500 }),
        (storyDescription: string) => {
          _reset();

          // startRound trims the description; skip whitespace-only strings
          if (storyDescription.trim().length === 0) return;

          const round = startRound(storyDescription);

          expect(round.status).toBe('voting');
          expect(round.storyDescription).toBe(storyDescription.trim());
          expect(round.selections.size).toBe(0);
          expect(round.id).toBeDefined();
          expect(round.startedAt).toBeDefined();

          // getCurrentRound should return the same round
          expect(getCurrentRound()).toBe(round);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 11: Clear board saves and resets
 *
 * For any completed voting round (cards revealed), when the board is cleared,
 * the Session_Manager SHALL: (a) add the round's results to the session history,
 * and (b) reset the current round to null, clear all card selections, and clear
 * the story description.
 *
 * Validates: Requirements 12.2, 12.3
 */
describe('Property 11: Clear board saves and resets', () => {
  it('clearBoard adds round to history and resets current round to null', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
        fc.array(fc.constantFrom(...ALL_CARDS), { minLength: 1, maxLength: 10 }),
        (story: string, cards: CardValue[]) => {
          _reset();

          // Add participants and start round
          const participants = cards.map((card, i) => ({
            id: `user-${i}`,
            displayName: `User ${i}`,
            card,
          }));

          const historyBefore = getHistory().length;

          completeRound(story, participants);

          // History should have one more entry
          const historyAfter = getHistory();
          expect(historyAfter.length).toBe(historyBefore + 1);

          // The newest entry should be at index 0
          const entry = historyAfter[0];
          expect(entry.storyDescription).toBe(story.trim());
          expect(entry.roundId).toBeDefined();
          expect(entry.completedAt).toBeDefined();

          // Current round should be null
          expect(getCurrentRound()).toBeNull();

          // Selections should be empty
          expect(getSelections().size).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 13: History ordering newest-first
 *
 * For any sequence of completed voting rounds added to the session history,
 * the history list SHALL be ordered with the most recently completed round
 * at index 0 (prepended to the top).
 *
 * Validates: Requirements 13.3
 */
describe('Property 13: History ordering newest-first', () => {
  it('history is ordered with the most recent round at index 0', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
          { minLength: 2, maxLength: 10 },
        ),
        (stories: string[]) => {
          _reset();

          const storyDescriptions: string[] = [];

          for (const story of stories) {
            addParticipant(makeUser('user-1', 'User 1'));
            startRound(story);
            selectCard('user-1', 5);
            revealCards();
            clearBoard();
            storyDescriptions.push(story.trim());
          }

          const history = getHistory();

          // History length should match number of rounds
          expect(history.length).toBe(stories.length);

          // Most recent story should be at index 0 (reversed order)
          for (let i = 0; i < history.length; i++) {
            const expectedStory = storyDescriptions[storyDescriptions.length - 1 - i];
            expect(history[i].storyDescription).toBe(expectedStory);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 14: Clear history empties all entries
 *
 * For any session history state containing one or more entries, clearing
 * the history SHALL result in an empty history list with zero entries.
 *
 * Validates: Requirements 14.3
 */
describe('Property 14: Clear history empties all entries', () => {
  it('clearHistory results in an empty history list', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (numRounds: number) => {
          _reset();

          // Create numRounds history entries
          for (let i = 0; i < numRounds; i++) {
            addParticipant(makeUser('user-1', 'User 1'));
            startRound(`Story ${i}`);
            selectCard('user-1', 3);
            revealCards();
            clearBoard();
          }

          // Verify history is non-empty
          expect(getHistory().length).toBe(numRounds);

          // Clear history
          clearHistory();

          // Verify history is empty
          expect(getHistory().length).toBe(0);
          expect(getHistory()).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 12: History entry data completeness
 *
 * For any history entry, the stored data SHALL include the story description,
 * all individual participant votes (with display names and card values or null
 * for no-vote), and the complete voting metrics (average, mode, spread,
 * distribution, outliers).
 *
 * Validates: Requirements 13.4
 */
describe('Property 12: History entry data completeness', () => {
  it('each history entry contains story, participant votes, and complete metrics', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
        fc.array(
          fc.record({
            displayName: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
            card: fc.oneof(
              fc.constantFrom(...ALL_CARDS),
              fc.constant(null as CardValue | null),
            ),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        (story: string, participantData) => {
          _reset();

          // Add participants
          const users = participantData.map((p, i) => ({
            id: `user-${i}`,
            displayName: p.displayName,
          }));

          for (const u of users) {
            addParticipant(makeUser(u.id, u.displayName));
          }

          startRound(story);

          // Select cards for participants that have a non-null card
          for (let i = 0; i < participantData.length; i++) {
            if (participantData[i].card !== null) {
              selectCard(`user-${i}`, participantData[i].card as CardValue);
            }
          }

          revealCards();
          const entry = clearBoard();

          // Verify story description
          expect(entry.storyDescription).toBe(story.trim());

          // Verify roundId and completedAt
          expect(entry.roundId).toBeDefined();
          expect(typeof entry.roundId).toBe('string');
          expect(entry.completedAt).toBeDefined();
          expect(typeof entry.completedAt).toBe('string');

          // Verify participant votes
          expect(entry.participants).toBeDefined();
          expect(Array.isArray(entry.participants)).toBe(true);
          expect(entry.participants.length).toBe(participantData.length);

          for (let i = 0; i < entry.participants.length; i++) {
            const vote = entry.participants[i];
            expect(vote.userId).toBe(`user-${i}`);
            expect(vote.displayName).toBe(users[i].displayName);
            // cardValue should be the selected card or null
            if (participantData[i].card !== null) {
              expect(vote.cardValue).toBe(participantData[i].card);
            } else {
              expect(vote.cardValue).toBeNull();
            }
          }

          // Verify complete metrics structure
          expect(entry.metrics).toBeDefined();
          expect(
            entry.metrics.average === null || typeof entry.metrics.average === 'number',
          ).toBe(true);
          expect(
            entry.metrics.mode === null || entry.metrics.mode !== undefined,
          ).toBe(true);
          expect(
            entry.metrics.spread === null || typeof entry.metrics.spread === 'number',
          ).toBe(true);
          expect(entry.metrics.distribution).toBeDefined();
          expect(typeof entry.metrics.distribution).toBe('object');
          expect(Array.isArray(entry.metrics.outliers)).toBe(true);
          expect(typeof entry.metrics.numericVoteCount).toBe('number');
          expect(typeof entry.metrics.insufficientData).toBe('boolean');
        },
      ),
      { numRuns: 100 },
    );
  });
});
