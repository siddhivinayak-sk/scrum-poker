import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { deriveBoardCards, getCardDisplayText, BoardCard, calculateStaggerDelay, calculateClearAnimationDuration } from './board.component';
import { User, CardValue, ALL_CARDS } from '@shared/types';

/**
 * Arbitrary for generating a User with a unique id and non-empty displayName.
 */
const arbUser: fc.Arbitrary<User> = fc.record({
  id: fc.uuid(),
  displayName: fc.string({ minLength: 1, maxLength: 30 }),
  role: fc.constantFrom('moderator' as const, 'participant' as const),
  isAnonymous: fc.boolean(),
});

/**
 * Arbitrary for generating a list of 1–50 unique participants.
 */
const arbParticipants: fc.Arbitrary<User[]> = fc
  .array(arbUser, { minLength: 1, maxLength: 50 })
  .map((users) => {
    // Ensure unique IDs
    const seen = new Set<string>();
    return users.filter((u) => {
      if (seen.has(u.id)) return false;
      seen.add(u.id);
      return true;
    });
  })
  .filter((users) => users.length >= 1);

/**
 * Property 3: Board participant count invariant
 *
 * For any set of connected participants during an active voting round,
 * the number of card placeholders displayed on the board SHALL equal
 * the number of connected participants.
 *
 * **Validates: Requirements 6.1**
 */
describe('Property 3: Board participant count invariant', () => {
  it('should produce exactly one board card per participant regardless of selections or reveal state', () => {
    fc.assert(
      fc.property(
        arbParticipants,
        fc.boolean(), // isRevealed
        (participants, isRevealed) => {
          // Generate random selections for a subset of participants
          const selections = new Map<string, CardValue>();
          // We don't need to populate selections for this property —
          // the count should match regardless
          const boardCards = deriveBoardCards(participants, selections, isRevealed);
          expect(boardCards.length).toBe(participants.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should produce exactly one board card per participant with random selections', () => {
    fc.assert(
      fc.property(
        arbParticipants,
        fc.boolean(), // isRevealed
        (participants, isRevealed) => {
          // Generate random selections for some participants
          const selections = new Map<string, CardValue>();
          for (const p of participants) {
            if (Math.random() > 0.5) {
              const randomCard = ALL_CARDS[Math.floor(Math.random() * ALL_CARDS.length)];
              selections.set(p.id, randomCard);
            }
          }
          const boardCards = deriveBoardCards(participants, selections, isRevealed);
          expect(boardCards.length).toBe(participants.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 4: Pre-reveal card value secrecy
 *
 * For any active voting round where cards have not been revealed,
 * and for any participant who has made a card selection, the board state
 * visible to other users SHALL NOT contain the selected card value —
 * only a "voted" indicator and the participant's display name.
 *
 * **Validates: Requirements 6.2, 6.3, 8.3**
 */
describe('Property 4: Pre-reveal card value secrecy', () => {
  it('should never expose card values when isRevealed is false', () => {
    fc.assert(
      fc.property(
        arbParticipants,
        fc.array(fc.constantFrom(...ALL_CARDS), { minLength: 0, maxLength: 50 }),
        (participants, cardValues) => {
          const selections = new Map<string, CardValue>();
          participants.forEach((p, i) => {
            if (i < cardValues.length) {
              selections.set(p.id, cardValues[i]);
            }
          });

          const boardCards = deriveBoardCards(participants, selections, false);

          for (const card of boardCards) {
            // cardValue must be null in pre-reveal state
            expect(card.cardValue).toBeNull();
            // Display text should be either "Voted ✓" or empty, never a card value
            const displayText = getCardDisplayText(card, false);
            expect(displayText === 'Voted ✓' || displayText === '').toBe(true);
            // Verify hasVoted is correct
            expect(card.hasVoted).toBe(selections.has(card.userId));
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

/**
 * Property 7: Post-reveal card display completeness
 *
 * For any set of participants after a reveal event, every participant's card
 * SHALL display either their selected card value (if they voted) or "No Vote"
 * (if they did not vote). No card shall remain in a face-down state.
 *
 * **Validates: Requirements 9.3, 9.4**
 */
describe('Property 7: Post-reveal card display completeness', () => {
  it('should show selected value or "No Vote" for every participant after reveal', () => {
    fc.assert(
      fc.property(
        arbParticipants,
        fc.array(
          fc.option(fc.constantFrom(...ALL_CARDS), { nil: undefined }),
          { minLength: 0, maxLength: 50 }
        ),
        (participants, optionalSelections) => {
          const selections = new Map<string, CardValue>();
          participants.forEach((p, i) => {
            if (i < optionalSelections.length && optionalSelections[i] !== undefined) {
              selections.set(p.id, optionalSelections[i] as CardValue);
            }
          });

          const boardCards = deriveBoardCards(participants, selections, true);

          for (const card of boardCards) {
            const displayText = getCardDisplayText(card, true);

            if (selections.has(card.userId)) {
              // Should show the actual card value
              expect(card.cardValue).toBe(selections.get(card.userId));
              expect(displayText).toBe(String(selections.get(card.userId)));
            } else {
              // Should show "No Vote"
              expect(card.cardValue).toBeNull();
              expect(displayText).toBe('No Vote');
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


/**
 * Property 19: Board clear animation stagger delay
 *
 * For any number of cards on the board (1 to N), the animation delay for
 * card at index `i` (0-based) SHALL equal `i * 50` milliseconds, producing
 * a sequential sweep effect across the board.
 *
 * **Validates: Requirements 24.3**
 */
describe('Property 19: Board clear animation stagger delay', () => {
  it('should assign stagger delay of i * 50ms to each card at index i', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        (cardCount) => {
          for (let i = 0; i < cardCount; i++) {
            expect(calculateStaggerDelay(i)).toBe(i * 50);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should compute total clear animation duration as 400 + (n-1) * 50 ms', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        (cardCount) => {
          const expectedDuration = 400 + (cardCount - 1) * 50;
          expect(calculateClearAnimationDuration(cardCount)).toBe(expectedDuration);
        }
      ),
      { numRuns: 100 }
    );
  });
});
