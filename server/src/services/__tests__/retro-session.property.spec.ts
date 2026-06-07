import * as fc from 'fast-check';
import { RetroConfiguration } from '../../../../shared/types';
import { RetroSession } from '../retro-session';

/**
 * Helper function to create a RetroConfiguration with sensible defaults.
 */
function makeConfig(overrides: Partial<RetroConfiguration> = {}): RetroConfiguration {
  return {
    boardName: 'Test Retro',
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
    ...overrides,
  };
}

/**
 * Helper to create a session with a participant and a card in the first column.
 */
function setupSessionWithCard(config?: Partial<RetroConfiguration>) {
  const session = new RetroSession('session-1', 'owner-1', makeConfig(config));
  session.addParticipant({ id: 'user-1', displayName: 'Alice', role: 'participant', isAnonymous: false });
  const state = session.getSessionState();
  const columnId = state.board.columns[0].id;
  const card = session.addCard(columnId, 'Test card', 'user-1', 'Alice');
  return { session, columnId, card, state };
}

/**
 * Property 1: Board name validation
 *
 * For any string input, the board creation stores the boardName as-is in the config.
 * Validation happens at the REST route level, not in RetroSession constructor.
 *
 * **Validates: Requirements 2.1, 2.5**
 */
describe('Property 1: Board name validation', () => {
  it('the config stores the boardName as-is for any string', () => {
    fc.assert(
      fc.property(
        fc.string(),
        (boardName: string) => {
          const config = makeConfig({ boardName });
          const session = new RetroSession('session-1', 'owner-1', config);
          const state = session.getSessionState();
          expect(state.config.boardName).toBe(boardName);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 2: Max votes validation
 *
 * For any positive integer maxVotesPerUser, a new user should have exactly that many
 * votes remaining. Validation of the value happens at the route level.
 *
 * **Validates: Requirements 2.2**
 */
describe('Property 2: Max votes validation', () => {
  it('getVotesRemaining returns the configured max for new users', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        (maxVotes: number) => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig({ maxVotesPerUser: maxVotes }));
          session.addParticipant({ id: 'user-1', displayName: 'Alice', role: 'participant', isAnonymous: false });
          expect(session.getVotesRemaining('user-1')).toBe(maxVotes);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 4: Configuration toggle isolation
 *
 * For any valid RetroConfiguration and any single configuration toggle change,
 * updating that toggle should modify only the targeted setting while preserving
 * all other configuration values unchanged.
 *
 * **Validates: Requirements 4.1–4.8**
 */
describe('Property 4: Configuration toggle isolation', () => {
  const toggleKeys: (keyof RetroConfiguration)[] = [
    'hideCardsInitially',
    'disableVotingInitially',
    'hideVoteCount',
    'oneVotePerCard',
    'showCardAuthor',
    'enableGifEmoji',
  ];

  it('changing one toggle preserves all other config values', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...toggleKeys),
        fc.boolean(),
        (toggleKey, newValue) => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig());
          const configBefore = { ...session.getSessionState().config };

          session.updateConfig({ [toggleKey]: newValue });

          const configAfter = session.getSessionState().config;

          // The targeted toggle should have the new value
          expect(configAfter[toggleKey]).toBe(newValue);

          // All other keys should remain unchanged
          for (const key of Object.keys(configBefore) as (keyof RetroConfiguration)[]) {
            if (key !== toggleKey) {
              expect(configAfter[key]).toEqual(configBefore[key]);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 7: Display name case-insensitive uniqueness
 *
 * For any retrospective session with an existing participant named N,
 * hasDisplayName should return true for any case variation of N.
 *
 * **Validates: Requirements 6.2**
 */
describe('Property 7: Display name case-insensitive uniqueness', () => {
  it('hasDisplayName detects case-insensitive matches', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        (displayName: string) => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig());
          session.addParticipant({ id: 'user-1', displayName, role: 'participant', isAnonymous: false });

          // Same case should match
          expect(session.hasDisplayName(displayName)).toBe(true);
          // Upper case should match
          expect(session.hasDisplayName(displayName.toUpperCase())).toBe(true);
          // Lower case should match
          expect(session.hasDisplayName(displayName.toLowerCase())).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 8: Column addition
 *
 * For any board with N columns and any valid (non-empty) column name,
 * adding a column should result in exactly N+1 columns with the new column appended at the end.
 *
 * **Validates: Requirements 7.3, 19.1**
 */
describe('Property 8: Column addition', () => {
  it('adding a column increases column count by 1 and appends at end', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        (columnName: string) => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig());
          const columnsBefore = session.getSessionState().board.columns.length;

          const newColumn = session.addColumn(columnName);

          const columnsAfter = session.getSessionState().board.columns;
          expect(columnsAfter.length).toBe(columnsBefore + 1);
          expect(columnsAfter[columnsAfter.length - 1].id).toBe(newColumn.id);
          expect(columnsAfter[columnsAfter.length - 1].name).toBe(columnName.trim());
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 9: Column removal cascades to cards
 *
 * For any board and any column containing cards, removing that column should result
 * in both the column and all its cards being absent from the board state.
 *
 * **Validates: Requirements 7.4, 19.2**
 */
describe('Property 9: Column removal cascades to cards', () => {
  it('removing a column removes it and all its cards from the board', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 5 }),
        (cardTexts: string[]) => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig());
          session.addParticipant({ id: 'user-1', displayName: 'Alice', role: 'participant', isAnonymous: false });
          const state = session.getSessionState();
          const columnId = state.board.columns[0].id;

          // Add cards to the first column
          const cardIds: string[] = [];
          for (const text of cardTexts) {
            const card = session.addCard(columnId, text, 'user-1', 'Alice');
            cardIds.push(card.id);
          }

          // Remove the column
          session.removeColumn(columnId);

          // Verify column is gone
          const stateAfter = session.getSessionState();
          const columnIds = stateAfter.board.columns.map((c) => c.id);
          expect(columnIds).not.toContain(columnId);

          // Verify all cards from that column are gone
          const allCardIds = stateAfter.board.columns.flatMap((c) => c.cards.map((card) => card.id));
          for (const cardId of cardIds) {
            expect(allCardIds).not.toContain(cardId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 10: Column reorder preserves cards
 *
 * For any board with columns and any valid permutation of column IDs,
 * reordering should produce exactly that column order with all cards within each column unchanged.
 *
 * **Validates: Requirements 7.5, 19.3**
 */
describe('Property 10: Column reorder preserves cards', () => {
  it('reordering columns preserves all cards within each column', () => {
    fc.assert(
      fc.property(
        fc.constant(null),
        () => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig());
          session.addParticipant({ id: 'user-1', displayName: 'Alice', role: 'participant', isAnonymous: false });

          // Add cards to each column
          const stateBefore = session.getSessionState();
          const cardsByColumn: Record<string, string[]> = {};
          for (const col of stateBefore.board.columns) {
            const card = session.addCard(col.id, `Card in ${col.name}`, 'user-1', 'Alice');
            cardsByColumn[col.id] = [card.id];
          }

          // Reverse the column order
          const columnIds = stateBefore.board.columns.map((c) => c.id);
          const reversedIds = [...columnIds].reverse();
          session.reorderColumns(reversedIds);

          // Verify new order
          const stateAfter = session.getSessionState();
          const newOrder = stateAfter.board.columns.map((c) => c.id);
          expect(newOrder).toEqual(reversedIds);

          // Verify cards are preserved in each column
          for (const col of stateAfter.board.columns) {
            const expectedCardIds = cardsByColumn[col.id];
            const actualCardIds = col.cards.map((c) => c.id);
            expect(actualCardIds).toEqual(expectedCardIds);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 11: Card addition
 *
 * For any column in any board state and any valid (non-empty) card text,
 * adding a card should increase that column's card count by exactly 1
 * and the new card should contain the provided text and author.
 *
 * **Validates: Requirements 8.1**
 */
describe('Property 11: Card addition', () => {
  it('adding a card increases column card count by 1 with correct text and author', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        (cardText: string, authorName: string) => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig());
          session.addParticipant({ id: 'user-1', displayName: authorName, role: 'participant', isAnonymous: false });
          const state = session.getSessionState();
          const columnId = state.board.columns[0].id;
          const cardsBefore = state.board.columns[0].cards.length;

          const card = session.addCard(columnId, cardText, 'user-1', authorName);

          const stateAfter = session.getSessionState();
          const column = stateAfter.board.columns.find((c) => c.id === columnId)!;
          expect(column.cards.length).toBe(cardsBefore + 1);
          expect(card.text).toBe(cardText);
          expect(card.authorId).toBe('user-1');
          expect(card.authorName).toBe(authorName);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 12: Card edit updates text
 *
 * For any existing card and any valid new text string, editing the card
 * (by the author or moderator) should result in the card containing the new text
 * with all other card properties unchanged.
 *
 * **Validates: Requirements 8.2**
 */
describe('Property 12: Card edit updates text', () => {
  it('editing a card updates only the text, preserving other properties', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        (newText: string) => {
          const { session, card } = setupSessionWithCard();

          // Capture card state before edit
          const stateBefore = session.getSessionState();
          const cardBefore = stateBefore.board.columns[0].cards.find((c) => c.id === card.id)!;
          const { text: _oldText, ...otherPropsBefore } = cardBefore;

          // Edit the card (author edits their own card)
          session.editCard(card.id, newText, 'user-1');

          const stateAfter = session.getSessionState();
          const cardAfter = stateAfter.board.columns[0].cards.find((c) => c.id === card.id)!;
          const { text: actualText, ...otherPropsAfter } = cardAfter;

          expect(actualText).toBe(newText);
          expect(otherPropsAfter).toEqual(otherPropsBefore);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 13: Card removal permissions
 *
 * For any card on the board and any user, removal should succeed if and only if
 * the user is the card's author or the moderator (ownerId). Successful removal
 * should result in the card being absent from the board.
 *
 * **Validates: Requirements 8.3, 8.4**
 */
describe('Property 13: Card removal permissions', () => {
  it('only the card author or moderator can remove a card', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('user-1', 'owner-1', 'user-other'),
        (actingUserId: string) => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig());
          session.addParticipant({ id: 'user-1', displayName: 'Alice', role: 'participant', isAnonymous: false });
          session.addParticipant({ id: 'user-other', displayName: 'Bob', role: 'participant', isAnonymous: false });
          const state = session.getSessionState();
          const columnId = state.board.columns[0].id;
          const card = session.addCard(columnId, 'Test card', 'user-1', 'Alice');

          const isAuthor = actingUserId === 'user-1';
          const isModerator = actingUserId === 'owner-1';

          if (isAuthor || isModerator) {
            // Should succeed
            session.removeCard(card.id, actingUserId);
            const stateAfter = session.getSessionState();
            const allCardIds = stateAfter.board.columns.flatMap((c) => c.cards.map((cd) => cd.id));
            expect(allCardIds).not.toContain(card.id);
          } else {
            // Should throw
            expect(() => session.removeCard(card.id, actingUserId)).toThrow('Not authorized');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 14: Card move between columns
 *
 * For any card in column A and any target column B (where A ≠ B),
 * moving the card should remove it from column A and add it to column B
 * at the specified index, preserving all card data.
 *
 * **Validates: Requirements 8.8, 8.9**
 */
describe('Property 14: Card move between columns', () => {
  it('moving a card between columns removes from source and adds to target preserving data', () => {
    fc.assert(
      fc.property(
        fc.constant(null),
        () => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig());
          session.addParticipant({ id: 'user-1', displayName: 'Alice', role: 'participant', isAnonymous: false });
          const state = session.getSessionState();
          const sourceColumnId = state.board.columns[0].id;
          const targetColumnId = state.board.columns[1].id;

          const card = session.addCard(sourceColumnId, 'Moving card', 'user-1', 'Alice');
          const cardText = card.text;
          const cardAuthorId = card.authorId;

          session.moveCard(card.id, targetColumnId, 0);

          const stateAfter = session.getSessionState();
          const sourceColumn = stateAfter.board.columns.find((c) => c.id === sourceColumnId)!;
          const targetColumn = stateAfter.board.columns.find((c) => c.id === targetColumnId)!;

          // Card is no longer in source
          expect(sourceColumn.cards.map((c) => c.id)).not.toContain(card.id);
          // Card is in target
          const movedCard = targetColumn.cards.find((c) => c.id === card.id)!;
          expect(movedCard).toBeDefined();
          expect(movedCard.text).toBe(cardText);
          expect(movedCard.authorId).toBe(cardAuthorId);
          expect(movedCard.columnId).toBe(targetColumnId);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 15: Voting mechanics
 *
 * For any participant with remaining votes > 0 and any card, voting should
 * increment the card's vote count by 1 and decrement the participant's remaining votes by 1.
 * When remaining votes equals 0, all further vote attempts should be rejected.
 *
 * **Validates: Requirements 9.1, 9.2, 9.3**
 */
describe('Property 15: Voting mechanics', () => {
  it('voting increments card votes and decrements remaining; zero remaining rejects', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        (maxVotes: number) => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig({ maxVotesPerUser: maxVotes }));
          session.addParticipant({ id: 'user-1', displayName: 'Alice', role: 'participant', isAnonymous: false });
          const state = session.getSessionState();
          const columnId = state.board.columns[0].id;

          // Create enough cards to vote on (one per vote to avoid oneVotePerCard issues)
          const cards: string[] = [];
          for (let i = 0; i < maxVotes + 1; i++) {
            const card = session.addCard(columnId, `Card ${i}`, 'owner-1', 'Owner');
            cards.push(card.id);
          }

          // Use all votes
          for (let i = 0; i < maxVotes; i++) {
            const votesBefore = session.getVotesRemaining('user-1');
            session.voteCard(cards[i], 'user-1');
            expect(session.getVotesRemaining('user-1')).toBe(votesBefore - 1);
          }

          // Verify no votes remaining
          expect(session.getVotesRemaining('user-1')).toBe(0);

          // Next vote should be rejected
          expect(() => session.voteCard(cards[maxVotes], 'user-1')).toThrow('No votes remaining');
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 16: Disabled voting prevents all votes
 *
 * For any board where voting is disabled and any participant attempting to vote
 * on any card, the vote should be rejected and no vote counts should change.
 *
 * **Validates: Requirements 9.4**
 */
describe('Property 16: Disabled voting prevents all votes', () => {
  it('voting is rejected when voting is disabled', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        (cardText: string) => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig({ disableVotingInitially: true }));
          session.addParticipant({ id: 'user-1', displayName: 'Alice', role: 'participant', isAnonymous: false });
          const state = session.getSessionState();
          const columnId = state.board.columns[0].id;
          const card = session.addCard(columnId, cardText, 'user-1', 'Alice');

          expect(() => session.voteCard(card.id, 'user-1')).toThrow('Voting is not enabled');

          // Verify vote count unchanged
          const stateAfter = session.getSessionState();
          const cardAfter = stateAfter.board.columns[0].cards.find((c) => c.id === card.id)!;
          expect(cardAfter.votes).toBe(0);
          expect(session.getVotesRemaining('user-1')).toBe(6);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 17: Card visibility — server returns all cards
 *
 * For any board with "hide cards initially" active, the server always sends
 * ALL cards to all participants. The client handles visibility filtering.
 *
 * **Validates: Requirements 10.1, 10.3**
 */
describe('Property 17: Card visibility when hidden', () => {
  it('all participants see all cards via getVisibleState (client handles filtering)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 5 }),
        fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 5 }),
        (user1Cards: string[], user2Cards: string[]) => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig({ hideCardsInitially: true }));
          session.addParticipant({ id: 'user-1', displayName: 'Alice', role: 'participant', isAnonymous: false });
          session.addParticipant({ id: 'user-2', displayName: 'Bob', role: 'participant', isAnonymous: false });
          const state = session.getSessionState();
          const columnId = state.board.columns[0].id;

          // Add cards for both users
          for (const text of user1Cards) {
            session.addCard(columnId, text, 'user-1', 'Alice');
          }
          for (const text of user2Cards) {
            session.addCard(columnId, text, 'user-2', 'Bob');
          }

          const totalCards = user1Cards.length + user2Cards.length;

          // Both users see ALL cards (server no longer filters)
          const visibleToUser1 = session.getVisibleState('user-1');
          expect(visibleToUser1.board.columns[0].cards.length).toBe(totalCards);

          const visibleToUser2 = session.getVisibleState('user-2');
          expect(visibleToUser2.board.columns[0].cards.length).toBe(totalCards);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 18: getVisibleState returns full state regardless of reveal
 *
 * For any board state, getVisibleState always returns all cards.
 * The reveal action only changes the board.cardsRevealed flag which
 * the client uses to decide display behavior.
 *
 * **Validates: Requirements 10.2**
 */
describe('Property 18: Card reveal makes all visible', () => {
  it('getVisibleState returns all cards before and after reveal', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 5 }),
        (cardTexts: string[]) => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig({ hideCardsInitially: true }));
          session.addParticipant({ id: 'user-1', displayName: 'Alice', role: 'participant', isAnonymous: false });
          session.addParticipant({ id: 'user-2', displayName: 'Bob', role: 'participant', isAnonymous: false });
          const state = session.getSessionState();
          const columnId = state.board.columns[0].id;

          // Add cards by user-1
          for (const text of cardTexts) {
            session.addCard(columnId, text, 'user-1', 'Alice');
          }

          // Before reveal, user-2 sees all cards (server sends full state)
          const beforeReveal = session.getVisibleState('user-2');
          expect(beforeReveal.board.columns[0].cards.length).toBe(cardTexts.length);

          // Reveal cards
          session.revealCards();

          // After reveal, user-2 still sees all cards
          const afterReveal = session.getVisibleState('user-2');
          expect(afterReveal.board.columns[0].cards.length).toBe(cardTexts.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 19: Completed board rejects modifications
 *
 * After completeBoard(), all modification methods should throw.
 *
 * **Validates: Requirements 11.4, 19.4**
 */
describe('Property 19: Completed board rejects modifications', () => {
  it('all modification operations throw after board is completed', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'addCard',
          'editCard',
          'removeCard',
          'moveCard',
          'voteCard',
          'addColumn',
          'removeColumn',
          'reorderColumns',
          'addComment',
        ),
        (operation: string) => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig());
          session.addParticipant({ id: 'user-1', displayName: 'Alice', role: 'participant', isAnonymous: false });
          const state = session.getSessionState();
          const columnId = state.board.columns[0].id;
          const card = session.addCard(columnId, 'Test card', 'user-1', 'Alice');

          // Complete the board
          session.completeBoard();

          // All modifications should throw
          switch (operation) {
            case 'addCard':
              expect(() => session.addCard(columnId, 'New card', 'user-1', 'Alice')).toThrow('Board is completed');
              break;
            case 'editCard':
              expect(() => session.editCard(card.id, 'Edited', 'user-1')).toThrow('Board is completed');
              break;
            case 'removeCard':
              expect(() => session.removeCard(card.id, 'user-1')).toThrow('Board is completed');
              break;
            case 'moveCard':
              expect(() => session.moveCard(card.id, state.board.columns[1].id, 0)).toThrow('Board is completed');
              break;
            case 'voteCard':
              expect(() => session.voteCard(card.id, 'user-1')).toThrow('Board is completed');
              break;
            case 'addColumn':
              expect(() => session.addColumn('New Column')).toThrow('Board is completed');
              break;
            case 'removeColumn':
              expect(() => session.removeColumn(columnId)).toThrow('Board is completed');
              break;
            case 'reorderColumns':
              expect(() => session.reorderColumns([columnId])).toThrow('Board is completed');
              break;
            case 'addComment':
              expect(() => session.addComment(card.id, 'Comment', 'user-1', 'Alice')).toThrow('Board is completed');
              break;
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: retro-board-improvements, Property 4: Completed board rejects all merge attempts
 *
 * For any board state where isCompleted is true, and for any pair of card IDs,
 * attempting a merge operation SHALL be rejected (throw an error), and the board
 * state SHALL remain unchanged.
 *
 * **Validates: Requirements 3.7**
 */
describe('Feature: retro-board-improvements, Property 4: Completed board rejects all merge attempts', () => {
  it('mergeCards throws "Board is completed" and leaves board state unchanged for any card pair', () => {
    fc.assert(
      fc.property(
        // Generate 1-3 columns, each with 1-4 cards
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 2, maxLength: 8 }),
        (numExtraColumns: number, cardTexts: string[]) => {
          // Setup session with cards distributed across columns
          const session = new RetroSession('session-1', 'owner-1', makeConfig());
          session.addParticipant({ id: 'user-1', displayName: 'Alice', role: 'participant', isAnonymous: false });

          // Add extra columns beyond the default template columns
          for (let i = 0; i < numExtraColumns; i++) {
            session.addColumn(`Extra Column ${i}`);
          }

          const state = session.getSessionState();
          const columns = state.board.columns;

          // Add cards across columns
          const allCardIds: string[] = [];
          for (let i = 0; i < cardTexts.length; i++) {
            const colIdx = i % columns.length;
            const card = session.addCard(columns[colIdx].id, cardTexts[i], 'user-1', 'Alice');
            allCardIds.push(card.id);
          }

          // We need at least 2 cards to attempt a merge
          fc.pre(allCardIds.length >= 2);

          // Complete the board
          session.completeBoard();

          // Capture board state before merge attempt (deep snapshot)
          const boardStateBefore = JSON.parse(JSON.stringify(session.getSessionState().board));

          // Attempt merge with first two card IDs
          const sourceCardId = allCardIds[0];
          const targetCardId = allCardIds[1];

          // Merge should throw
          expect(() => session.mergeCards(sourceCardId, targetCardId, 'user-1')).toThrow('Board is completed');

          // Board state should be completely unchanged
          const boardStateAfter = JSON.parse(JSON.stringify(session.getSessionState().board));
          expect(boardStateAfter).toEqual(boardStateBefore);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('mergeCards throws for any arbitrary pair of card IDs on completed board', () => {
    fc.assert(
      fc.property(
        // Generate arbitrary card ID pairs (including potentially non-existent ones)
        fc.uuid(),
        fc.uuid(),
        (sourceId: string, targetId: string) => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig());
          session.addParticipant({ id: 'user-1', displayName: 'Alice', role: 'participant', isAnonymous: false });

          // Add some cards so the board isn't empty
          const state = session.getSessionState();
          const columnId = state.board.columns[0].id;
          session.addCard(columnId, 'Card A', 'user-1', 'Alice');
          session.addCard(columnId, 'Card B', 'user-1', 'Alice');

          // Complete the board
          session.completeBoard();

          // Capture board state before merge attempt
          const boardStateBefore = JSON.parse(JSON.stringify(session.getSessionState().board));

          // Merge should throw "Board is completed" regardless of card IDs
          expect(() => session.mergeCards(sourceId, targetId, 'user-1')).toThrow('Board is completed');

          // Board state should remain unchanged
          const boardStateAfter = JSON.parse(JSON.stringify(session.getSessionState().board));
          expect(boardStateAfter).toEqual(boardStateBefore);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: retro-board-improvements
 * Property 2: Merge produces combined text and removes source card
 *
 * For any two cards (source and target) in any board state that is not completed,
 * performing a merge SHALL produce a target card whose text equals the original
 * target text followed by the separator "\n--------\n" followed by the source card text,
 * AND the source card SHALL no longer exist in any column of the board.
 *
 * **Validates: Requirements 3.3, 3.4**
 */
describe('Feature: retro-board-improvements, Property 2: Merge produces combined text and removes source card', () => {
  // Arbitrary for generating card text (including special characters)
  const arbCardText = fc.string({ minLength: 1, maxLength: 200 });

  // Arbitrary for generating number of columns to use (1 = same column, 2 = different columns)
  const arbSameColumn = fc.boolean();

  it('merge produces target text + separator + source text and removes source card', () => {
    fc.assert(
      fc.property(
        arbCardText,
        arbCardText,
        arbSameColumn,
        (sourceText: string, targetText: string, sameColumn: boolean) => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig());
          session.addParticipant({ id: 'user-1', displayName: 'Alice', role: 'participant', isAnonymous: false });

          const state = session.getSessionState();
          const columns = state.board.columns;
          const sourceColumnId = columns[0].id;
          const targetColumnId = sameColumn ? columns[0].id : columns[1].id;

          // Add source and target cards
          const sourceCard = session.addCard(sourceColumnId, sourceText, 'user-1', 'Alice');
          const targetCard = session.addCard(targetColumnId, targetText, 'user-1', 'Alice');

          // Perform merge
          const result = session.mergeCards(sourceCard.id, targetCard.id, 'user-1');

          // Verify merged text = target text + separator + source text
          const expectedText = `${targetText}\n--------\n${sourceText}`;
          expect(result.targetCard.text).toBe(expectedText);

          // Verify target card in the board also has the merged text
          const stateAfter = session.getSessionState();
          const allCards = stateAfter.board.columns.flatMap((col) => col.cards);
          const mergedCard = allCards.find((c) => c.id === targetCard.id);
          expect(mergedCard).toBeDefined();
          expect(mergedCard!.text).toBe(expectedText);

          // Verify source card no longer exists in any column
          const allCardIds = allCards.map((c) => c.id);
          expect(allCardIds).not.toContain(sourceCard.id);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('merge removes source card from the correct column', () => {
    fc.assert(
      fc.property(
        arbCardText,
        arbCardText,
        (sourceText: string, targetText: string) => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig());
          session.addParticipant({ id: 'user-1', displayName: 'Alice', role: 'participant', isAnonymous: false });

          const state = session.getSessionState();
          const sourceColumnId = state.board.columns[0].id;
          const targetColumnId = state.board.columns[1].id;

          const sourceCard = session.addCard(sourceColumnId, sourceText, 'user-1', 'Alice');
          const targetCard = session.addCard(targetColumnId, targetText, 'user-1', 'Alice');

          const result = session.mergeCards(sourceCard.id, targetCard.id, 'user-1');

          // Verify removedFromColumnId matches the source card's column
          expect(result.removedFromColumnId).toBe(sourceColumnId);

          // Verify the source column no longer contains the source card
          const stateAfter = session.getSessionState();
          const sourceColumn = stateAfter.board.columns.find((c) => c.id === sourceColumnId)!;
          const sourceCardIds = sourceColumn.cards.map((c) => c.id);
          expect(sourceCardIds).not.toContain(sourceCard.id);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: retro-board-improvements, Property 1: CSV export/import round-trip preserves board data
 *
 * For any valid RetroBoard state containing arbitrary columns, cards (with arbitrary text
 * including special characters, commas, quotes, newlines), vote counts, author names, and
 * comments, exporting to CSV via exportCSV() and then importing that CSV into an empty board
 * with matching column names SHALL produce cards whose "Column", "Card Text", "Votes",
 * "Author", and "Comments" fields match the original board data.
 *
 * **Validates: Requirements 1.5, 2.6**
 */
describe('Feature: retro-board-improvements, Property 1: CSV export/import round-trip preserves board data', () => {
  /**
   * Arbitrary generator for card text that includes special CSV characters:
   * commas, quotes, newlines, and general unicode.
   */
  const cardTextArb = fc.stringOf(
    fc.oneof(
      fc.char(),               // any single char
      fc.constant(','),        // comma
      fc.constant('"'),        // double quote
      fc.constant('\n'),       // newline
      fc.constant('\r'),       // carriage return
      fc.constant('\r\n'),     // CRLF
    ),
    { minLength: 1, maxLength: 80 },
  ).filter((s) => s.trim().length > 0); // importCSV trims and rejects empty text

  const authorNameArb = fc.stringOf(
    fc.oneof(
      fc.char(),
      fc.constant(','),
      fc.constant('"'),
    ),
    { minLength: 1, maxLength: 30 },
  ).filter((s) => s.trim().length > 0);

  const commentTextArb = fc.stringOf(
    fc.oneof(
      fc.char(),
      fc.constant(','),
      fc.constant('"'),
      fc.constant('\n'),
    ),
    { minLength: 1, maxLength: 40 },
  ).filter((s) => s.trim().length > 0);

  /**
   * Arbitrary for a card definition (before insertion into board).
   */
  const cardDefArb = fc.record({
    text: cardTextArb,
    authorName: authorNameArb,
    votes: fc.integer({ min: 0, max: 20 }),
    comments: fc.array(commentTextArb, { minLength: 0, maxLength: 3 }),
  });

  /**
   * Generate a column name that won't clash with others.
   * Column names for the test come from the template, so we use a fixed set.
   */
  const columnNameArb = fc.stringOf(
    fc.oneof(
      fc.char(),
      fc.constant(','),
      fc.constant('"'),
    ),
    { minLength: 1, maxLength: 20 },
  ).filter((s) => s.trim().length > 0);

  /**
   * Helper: Parse CSV text into rows of fields using the same logic the server uses.
   * We replicate a minimal CSV parser here to verify exported CSV content.
   */
  function parseCSVFields(csvData: string): string[][] {
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentField = '';
    let inQuotes = false;
    let i = 0;

    while (i < csvData.length) {
      const char = csvData[i];

      if (inQuotes) {
        if (char === '"') {
          if (i + 1 < csvData.length && csvData[i + 1] === '"') {
            currentField += '"';
            i += 2;
          } else {
            inQuotes = false;
            i++;
          }
        } else {
          currentField += char;
          i++;
        }
      } else {
        if (char === '"') {
          inQuotes = true;
          i++;
        } else if (char === ',') {
          currentRow.push(currentField);
          currentField = '';
          i++;
        } else if (char === '\r') {
          currentRow.push(currentField);
          currentField = '';
          rows.push(currentRow);
          currentRow = [];
          if (i + 1 < csvData.length && csvData[i + 1] === '\n') {
            i += 2;
          } else {
            i++;
          }
        } else if (char === '\n') {
          currentRow.push(currentField);
          currentField = '';
          rows.push(currentRow);
          currentRow = [];
          i++;
        } else {
          currentField += char;
          i++;
        }
      }
    }

    if (currentField !== '' || currentRow.length > 0) {
      currentRow.push(currentField);
      rows.push(currentRow);
    }

    return rows;
  }

  it('exported CSV fields match original board data for arbitrary cards with special characters', () => {
    fc.assert(
      fc.property(
        // Generate 1-4 cards per column (use the default template columns: Start, Stop, Continue)
        fc.array(cardDefArb, { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 0, max: 2 }), // which column to put cards in
        (cardDefs, columnIdx) => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig());
          session.addParticipant({ id: 'user-1', displayName: 'Tester', role: 'participant', isAnonymous: false });

          const state = session.getSessionState();
          const column = state.board.columns[columnIdx];
          const columnId = column.id;
          const columnName = column.name;

          // Add cards with arbitrary data
          const expectedCards: Array<{ text: string; authorName: string; votes: number; commentsText: string }> = [];
          for (const def of cardDefs) {
            const card = session.addCard(columnId, def.text, 'user-1', def.authorName);

            // Add votes manually by voting from different users
            for (let v = 0; v < def.votes; v++) {
              const voterId = `voter-${v}`;
              session.addParticipant({ id: voterId, displayName: `Voter${v}`, role: 'participant', isAnonymous: false });
              // Need voting to be enabled
              try {
                session.voteCard(card.id, voterId);
              } catch {
                // May run out of votes for the voter, that's OK
              }
            }

            // Add comments
            for (const commentText of def.comments) {
              session.addComment(card.id, commentText, 'user-1', 'Tester');
            }

            // Get actual card state after modifications
            const updatedState = session.getSessionState();
            const updatedCard = updatedState.board.columns[columnIdx].cards.find((c) => c.id === card.id)!;
            const commentsText = updatedCard.comments.map((c) => c.text).join(' | ');

            expectedCards.push({
              text: updatedCard.text,
              authorName: updatedCard.authorName,
              votes: updatedCard.votes,
              commentsText,
            });
          }

          // Export to CSV
          const csv = session.exportCSV();

          // Parse the CSV back
          const rows = parseCSVFields(csv);

          // Verify headers
          expect(rows[0]).toEqual(['Column', 'Card Text', 'Votes', 'Author', 'Comments']);

          // Find data rows for our column
          const dataRows = rows.slice(1).filter((row) => row[0] === columnName);
          expect(dataRows.length).toBe(expectedCards.length);

          // Verify each exported row matches the original card data
          for (let i = 0; i < expectedCards.length; i++) {
            const row = dataRows[i];
            const expected = expectedCards[i];
            expect(row[0]).toBe(columnName);           // Column
            expect(row[1]).toBe(expected.text);        // Card Text
            expect(row[2]).toBe(String(expected.votes)); // Votes
            expect(row[3]).toBe(expected.authorName);  // Author
            expect(row[4]).toBe(expected.commentsText); // Comments
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('CSV export then import into empty board with matching columns preserves Column and Card Text', () => {
    fc.assert(
      fc.property(
        // Generate cards distributed across columns
        fc.array(
          fc.record({
            text: cardTextArb,
            columnIdx: fc.integer({ min: 0, max: 2 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (cardInputs) => {
          // Build source session with cards
          const sourceSession = new RetroSession('source-1', 'owner-1', makeConfig());
          sourceSession.addParticipant({ id: 'user-1', displayName: 'Alice', role: 'participant', isAnonymous: false });
          const sourceState = sourceSession.getSessionState();

          const expectedByColumn: Map<string, string[]> = new Map();

          for (const input of cardInputs) {
            const col = sourceState.board.columns[input.columnIdx];
            sourceSession.addCard(col.id, input.text, 'user-1', 'Alice');
            if (!expectedByColumn.has(col.name)) {
              expectedByColumn.set(col.name, []);
            }
            expectedByColumn.get(col.name)!.push(input.text);
          }

          // Export CSV from source
          const csv = sourceSession.exportCSV();

          // Create target session with same template (same column names)
          const targetSession = new RetroSession('target-1', 'owner-1', makeConfig());

          // Import CSV into target
          targetSession.importCSV(csv);

          // Verify imported cards match
          const targetState = targetSession.getSessionState();
          for (const col of targetState.board.columns) {
            const expectedTexts = expectedByColumn.get(col.name) ?? [];
            const importedTexts = col.cards.map((c) => c.text);
            // importCSV trims text, so we compare trimmed
            expect(importedTexts).toEqual(expectedTexts.map((t) => t.trim()));
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 26: Context editable only by moderator
 *
 * The updateContext method updates the context correctly.
 * (Authorization check happens at the handler level, not in the method itself.)
 *
 * **Validates: Requirements 18.3**
 */
describe('Property 26: Context editable only by moderator', () => {
  it('updateContext correctly updates the board context', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 500 }),
        (contextText: string) => {
          const session = new RetroSession('session-1', 'owner-1', makeConfig());

          session.updateContext(contextText);

          const state = session.getSessionState();
          expect(state.board.context).toBe(contextText);
        },
      ),
      { numRuns: 100 },
    );
  });
});
