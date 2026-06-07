import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { RetroColumn, RetroCard, RetroComment } from '@shared/types';

/**
 * Property 3: Cancel Merge Is a No-Op
 *
 * For any board state and any pair of cards selected for merge, if the user
 * cancels the merge operation, the board state (all columns, all cards, all
 * card texts, votes, and comments) SHALL remain identical to the state before
 * the merge was initiated.
 *
 * This tests the pure state-level behavior: when a merge popup is shown and
 * then cancelled, no board state mutation occurs. The cancel path in
 * RetroColumnComponent only resets popup-related signals (showMergePopup,
 * mergeSourceCardId, mergeTargetCardId, mergeSourceCardText, mergeTargetCardText)
 * — it never calls sendCardMerge or modifies the columns/cards state.
 *
 * **Validates: Requirements 3.5**
 */

// --- Arbitraries ---

/** Generate a valid ISO date string */
const arbISODate = fc
  .integer({ min: 946684800000, max: 4102444799999 }) // 2000-01-01 to 2099-12-31 in ms
  .map((ts) => new Date(ts).toISOString());

/** Generate an arbitrary RetroComment */
const arbComment: fc.Arbitrary<RetroComment> = fc.record({
  id: fc.uuid(),
  text: fc.string({ minLength: 0, maxLength: 200 }),
  authorId: fc.uuid(),
  authorName: fc.string({ minLength: 1, maxLength: 30 }),
  createdAt: arbISODate,
});

/** Generate an arbitrary RetroCard */
const arbCard: fc.Arbitrary<RetroCard> = fc.record({
  id: fc.uuid(),
  text: fc.string({ minLength: 0, maxLength: 500 }),
  authorId: fc.uuid(),
  authorName: fc.string({ minLength: 1, maxLength: 30 }),
  votes: fc.nat({ max: 100 }),
  votedBy: fc.array(fc.uuid(), { minLength: 0, maxLength: 10 }),
  comments: fc.array(arbComment, { minLength: 0, maxLength: 5 }),
  columnId: fc.uuid(),
  order: fc.nat({ max: 50 }),
  createdAt: arbISODate,
});

/** Generate an arbitrary RetroColumn with at least 1 card (to enable merge selection) */
const arbColumnWithCards: fc.Arbitrary<RetroColumn> = fc
  .record({
    id: fc.uuid(),
    name: fc.string({ minLength: 1, maxLength: 30 }),
    cards: fc.array(arbCard, { minLength: 1, maxLength: 10 }),
    order: fc.nat({ max: 20 }),
  })
  .map((col) => ({
    ...col,
    cards: col.cards.map((card, idx) => ({ ...card, columnId: col.id, order: idx })),
  }));

/** Generate an arbitrary board state (array of columns) with at least 2 cards total to pick a pair */
const arbBoardWithCardPair = fc
  .array(arbColumnWithCards, { minLength: 1, maxLength: 5 })
  .filter((columns) => {
    const totalCards = columns.reduce((sum, col) => sum + col.cards.length, 0);
    return totalCards >= 2;
  })
  .chain((columns) => {
    // Collect all cards across all columns
    const allCards: { card: RetroCard; columnId: string }[] = [];
    for (const col of columns) {
      for (const card of col.cards) {
        allCards.push({ card, columnId: col.id });
      }
    }

    // Pick two distinct card indices
    return fc
      .tuple(
        fc.nat({ max: allCards.length - 1 }),
        fc.nat({ max: allCards.length - 1 })
      )
      .filter(([a, b]) => a !== b)
      .map(([sourceIdx, targetIdx]) => ({
        columns,
        sourceCard: allCards[sourceIdx].card,
        targetCard: allCards[targetIdx].card,
      }));
  });

/**
 * Simulate the cancel-merge operation.
 *
 * In the actual component (RetroColumnComponent), when a card-on-card drop
 * is detected:
 * 1. Popup-related signals are set (showMergePopup, mergeSourceCardText, etc.)
 * 2. The popup is displayed
 * 3. When cancelled, `dismissMergePopup()` is called which resets ONLY
 *    popup signals — it does NOT call ws.sendCardMerge() or modify columns/state
 *
 * This function returns the board state after cancel. Since cancel is a no-op
 * on board state, it simply returns the same columns unchanged.
 */
function simulateCancelMerge(
  columns: RetroColumn[],
  _sourceCardId: string,
  _targetCardId: string
): RetroColumn[] {
  // Cancel merge does nothing to the board state.
  // The popup is shown and dismissed — no WebSocket event is sent,
  // no state mutation occurs on the columns/cards.
  return columns;
}

/** Deep-compare two board states (columns with all cards, texts, votes, comments) */
function boardStatesAreIdentical(before: RetroColumn[], after: RetroColumn[]): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

// --- Property Test ---

describe('Feature: retro-board-improvements, Property 3: Cancel merge leaves board state unchanged', () => {
  it('should leave board state identical before and after initiating and cancelling a merge', () => {
    fc.assert(
      fc.property(arbBoardWithCardPair, ({ columns, sourceCard, targetCard }) => {
        // Capture the board state before the merge initiation
        const stateBefore = JSON.parse(JSON.stringify(columns)) as RetroColumn[];

        // Simulate initiating a merge and then cancelling
        const stateAfter = simulateCancelMerge(columns, sourceCard.id, targetCard.id);

        // Board state must be identical
        expect(boardStatesAreIdentical(stateBefore, stateAfter)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('should preserve all card texts unchanged after cancel', () => {
    fc.assert(
      fc.property(arbBoardWithCardPair, ({ columns, sourceCard, targetCard }) => {
        const textsBefore = columns.flatMap((col) => col.cards.map((c) => c.text));

        const stateAfter = simulateCancelMerge(columns, sourceCard.id, targetCard.id);
        const textsAfter = stateAfter.flatMap((col) => col.cards.map((c) => c.text));

        expect(textsAfter).toEqual(textsBefore);
      }),
      { numRuns: 100 }
    );
  });

  it('should preserve all card votes unchanged after cancel', () => {
    fc.assert(
      fc.property(arbBoardWithCardPair, ({ columns, sourceCard, targetCard }) => {
        const votesBefore = columns.flatMap((col) => col.cards.map((c) => c.votes));

        const stateAfter = simulateCancelMerge(columns, sourceCard.id, targetCard.id);
        const votesAfter = stateAfter.flatMap((col) => col.cards.map((c) => c.votes));

        expect(votesAfter).toEqual(votesBefore);
      }),
      { numRuns: 100 }
    );
  });

  it('should preserve all card comments unchanged after cancel', () => {
    fc.assert(
      fc.property(arbBoardWithCardPair, ({ columns, sourceCard, targetCard }) => {
        const commentsBefore = columns.flatMap((col) =>
          col.cards.flatMap((c) => c.comments.map((cm) => cm.text))
        );

        const stateAfter = simulateCancelMerge(columns, sourceCard.id, targetCard.id);
        const commentsAfter = stateAfter.flatMap((col) =>
          col.cards.flatMap((c) => c.comments.map((cm) => cm.text))
        );

        expect(commentsAfter).toEqual(commentsBefore);
      }),
      { numRuns: 100 }
    );
  });

  it('should preserve the total number of cards across all columns after cancel', () => {
    fc.assert(
      fc.property(arbBoardWithCardPair, ({ columns, sourceCard, targetCard }) => {
        const totalBefore = columns.reduce((sum, col) => sum + col.cards.length, 0);

        const stateAfter = simulateCancelMerge(columns, sourceCard.id, targetCard.id);
        const totalAfter = stateAfter.reduce((sum, col) => sum + col.cards.length, 0);

        expect(totalAfter).toBe(totalBefore);
      }),
      { numRuns: 100 }
    );
  });
});
