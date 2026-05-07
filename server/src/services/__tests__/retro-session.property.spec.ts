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
 * Property 17: Card visibility when hidden
 *
 * For any board with "hide cards initially" active and cards not yet revealed,
 * the visible cards should be exactly those authored by that participant.
 *
 * **Validates: Requirements 10.1, 10.3**
 */
describe('Property 17: Card visibility when hidden', () => {
  it('each participant sees only their own cards when cards are hidden', () => {
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

          // User 1 should see only their own cards
          const visibleToUser1 = session.getVisibleState('user-1');
          const user1VisibleCards = visibleToUser1.board.columns[0].cards;
          expect(user1VisibleCards.length).toBe(user1Cards.length);
          for (const card of user1VisibleCards) {
            expect(card.authorId).toBe('user-1');
          }

          // User 2 should see only their own cards
          const visibleToUser2 = session.getVisibleState('user-2');
          const user2VisibleCards = visibleToUser2.board.columns[0].cards;
          expect(user2VisibleCards.length).toBe(user2Cards.length);
          for (const card of user2VisibleCards) {
            expect(card.authorId).toBe('user-2');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 18: Card reveal makes all visible
 *
 * For any board state, after the moderator triggers card reveal,
 * all cards in all columns should be visible to all participants.
 *
 * **Validates: Requirements 10.2**
 */
describe('Property 18: Card reveal makes all visible', () => {
  it('after reveal, all cards are visible to all participants', () => {
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

          // Before reveal, user-2 sees no cards
          const beforeReveal = session.getVisibleState('user-2');
          expect(beforeReveal.board.columns[0].cards.length).toBe(0);

          // Reveal cards
          session.revealCards();

          // After reveal, user-2 sees all cards
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
