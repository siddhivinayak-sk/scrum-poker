import { RetroSession } from '../retro-session';
import { RetroConfiguration, User } from '../../../../shared/types';

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

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: overrides.id ?? 'user-1',
    displayName: overrides.displayName ?? 'Alice',
    role: overrides.role ?? 'participant',
    isAnonymous: overrides.isAnonymous ?? false,
  };
}

function createSession(configOverrides: Partial<RetroConfiguration> = {}): RetroSession {
  return new RetroSession('retro-session-1', 'owner-1', makeConfig(configOverrides));
}

describe('RetroSession - Constructor and State Management', () => {
  describe('constructor', () => {
    it('initializes with the provided sessionId and ownerId', () => {
      const session = new RetroSession('my-session', 'my-owner', makeConfig());
      const state = session.getSessionState();
      expect(state.sessionId).toBe('my-session');
      expect(state.ownerId).toBe('my-owner');
    });

    it('stores a copy of the configuration', () => {
      const config = makeConfig({ boardName: 'My Board' });
      const session = new RetroSession('s1', 'o1', config);
      // Mutating original config should not affect session
      config.boardName = 'Changed';
      expect(session.getSessionState().config.boardName).toBe('My Board');
    });

    it('sets createdAt to a valid ISO 8601 timestamp', () => {
      const session = createSession();
      const state = session.getSessionState();
      expect(() => new Date(state.createdAt)).not.toThrow();
      expect(new Date(state.createdAt).toISOString()).toBe(state.createdAt);
    });

    it('initializes columns from the selected template', () => {
      const session = createSession({ templateId: 'start-stop-continue' });
      const state = session.getSessionState();
      expect(state.board.columns).toHaveLength(3);
      expect(state.board.columns[0].name).toBe('Start');
      expect(state.board.columns[1].name).toBe('Stop');
      expect(state.board.columns[2].name).toBe('Continue');
    });

    it('assigns unique IDs to each column', () => {
      const session = createSession({ templateId: 'starfish' });
      const state = session.getSessionState();
      const ids = state.board.columns.map((c) => c.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('assigns sequential order to columns', () => {
      const session = createSession({ templateId: 'four-ls' });
      const state = session.getSessionState();
      state.board.columns.forEach((col, index) => {
        expect(col.order).toBe(index);
      });
    });

    it('initializes columns with empty cards arrays', () => {
      const session = createSession();
      const state = session.getSessionState();
      state.board.columns.forEach((col) => {
        expect(col.cards).toEqual([]);
      });
    });

    it('initializes board with empty context', () => {
      const session = createSession();
      expect(session.getSessionState().board.context).toBe('');
    });

    it('initializes board with cardsRevealed = false', () => {
      const session = createSession();
      expect(session.getSessionState().board.cardsRevealed).toBe(false);
    });

    it('initializes board with isCompleted = false', () => {
      const session = createSession();
      expect(session.getSessionState().board.isCompleted).toBe(false);
    });

    it('initializes votingEnabled based on disableVotingInitially config', () => {
      const enabledSession = createSession({ disableVotingInitially: false });
      expect(enabledSession.getSessionState().board.votingEnabled).toBe(true);

      const disabledSession = createSession({ disableVotingInitially: true });
      expect(disabledSession.getSessionState().board.votingEnabled).toBe(false);
    });

    it('initializes with empty participants list', () => {
      const session = createSession();
      expect(session.getSessionState().participants).toEqual([]);
    });

    it('initializes with empty votesRemaining map', () => {
      const session = createSession();
      expect(session.getSessionState().votesRemaining).toEqual({});
    });

    it('handles unknown template by creating empty columns', () => {
      const session = createSession({ templateId: 'nonexistent-template' });
      const state = session.getSessionState();
      expect(state.board.columns).toEqual([]);
    });
  });

  describe('getSessionState', () => {
    it('returns the full session state', () => {
      const session = createSession({ boardName: 'Sprint 42 Retro' });
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));

      const state = session.getSessionState();
      expect(state.sessionId).toBe('retro-session-1');
      expect(state.config.boardName).toBe('Sprint 42 Retro');
      expect(state.board.columns).toHaveLength(3);
      expect(state.participants).toHaveLength(1);
      expect(state.participants[0].displayName).toBe('Alice');
      expect(state.ownerId).toBe('owner-1');
      expect(state.votesRemaining).toEqual({ u1: 6 });
    });

    it('includes votesRemaining for all participants', () => {
      const session = createSession({ maxVotesPerUser: 3 });
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));
      session.addParticipant(makeUser({ id: 'u2', displayName: 'Bob' }));

      const state = session.getSessionState();
      expect(state.votesRemaining).toEqual({ u1: 3, u2: 3 });
    });
  });

  describe('getVisibleState', () => {
    it('returns full state when hideCardsInitially is false', () => {
      const session = createSession({ hideCardsInitially: false });
      session.addParticipant(makeUser({ id: 'u1' }));

      const fullState = session.getSessionState();
      const visibleState = session.getVisibleState('u1');
      expect(visibleState).toEqual(fullState);
    });

    it('returns full state when hideCardsInitially is true (client handles filtering)', () => {
      const session = createSession({ hideCardsInitially: true });
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));

      const fullState = session.getSessionState();
      const visibleState = session.getVisibleState('u1');
      expect(visibleState).toEqual(fullState);
    });

    it('returns all cards from all users regardless of hideCardsInitially', () => {
      const session = createSession({ hideCardsInitially: true });
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));
      session.addParticipant(makeUser({ id: 'u2', displayName: 'Bob' }));
      const columnId = session.getSessionState().board.columns[0].id;
      session.addCard(columnId, 'Alice card', 'u1', 'Alice');
      session.addCard(columnId, 'Bob card', 'u2', 'Bob');

      const visibleState = session.getVisibleState('u1');
      expect(visibleState.board.columns[0].cards).toHaveLength(2);
    });

    it('preserves column structure', () => {
      const session = createSession({ hideCardsInitially: true });
      const visibleState = session.getVisibleState('u1');

      expect(visibleState.board.columns[0].name).toBe('Start');
      expect(visibleState.board.columns[1].name).toBe('Stop');
      expect(visibleState.board.columns[2].name).toBe('Continue');
    });

    it('includes all state fields', () => {
      const session = createSession({ hideCardsInitially: true });
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));

      const visibleState = session.getVisibleState('u1');
      expect(visibleState.sessionId).toBe('retro-session-1');
      expect(visibleState.config.hideCardsInitially).toBe(true);
      expect(visibleState.participants).toHaveLength(1);
      expect(visibleState.ownerId).toBe('owner-1');
      expect(visibleState.votesRemaining).toEqual({ u1: 6 });
    });
  });

  describe('participant helpers (used by state methods)', () => {
    it('addParticipant adds user and initializes votes', () => {
      const session = createSession({ maxVotesPerUser: 5 });
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));

      expect(session.getParticipants()).toHaveLength(1);
      expect(session.getVotesRemaining('u1')).toBe(5);
    });

    it('removeParticipant removes user', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));
      session.removeParticipant('u1');

      expect(session.getParticipants()).toHaveLength(0);
    });

    it('getParticipantCount returns correct count', () => {
      const session = createSession();
      expect(session.getParticipantCount()).toBe(0);
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));
      expect(session.getParticipantCount()).toBe(1);
      session.addParticipant(makeUser({ id: 'u2', displayName: 'Bob' }));
      expect(session.getParticipantCount()).toBe(2);
    });

    it('hasDisplayName checks case-insensitively', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));

      expect(session.hasDisplayName('Alice')).toBe(true);
      expect(session.hasDisplayName('alice')).toBe(true);
      expect(session.hasDisplayName('ALICE')).toBe(true);
      expect(session.hasDisplayName('Bob')).toBe(false);
    });

    it('getVotesRemaining returns max for new user', () => {
      const session = createSession({ maxVotesPerUser: 10 });
      session.addParticipant(makeUser({ id: 'u1' }));
      expect(session.getVotesRemaining('u1')).toBe(10);
    });

    it('getVotesRemaining returns max for unknown user', () => {
      const session = createSession({ maxVotesPerUser: 6 });
      // User not added as participant
      expect(session.getVotesRemaining('unknown')).toBe(6);
    });
  });
});

describe('RetroSession - Card CRUD Operations', () => {
  it('adds a card to a valid column', () => {
    const session = createSession();
    const state = session.getSessionState();
    const columnId = state.board.columns[0].id;

    const card = session.addCard(columnId, 'My card', 'user-1', 'Alice');

    expect(card.text).toBe('My card');
    expect(card.authorId).toBe('user-1');
    expect(card.authorName).toBe('Alice');
    expect(card.votes).toBe(0);
    expect(card.votedBy).toEqual([]);
    expect(card.comments).toEqual([]);
    expect(card.columnId).toBe(columnId);
    expect(card.order).toBe(0);
    expect(card.id).toBeDefined();
    expect(card.createdAt).toBeDefined();

    const updatedState = session.getSessionState();
    expect(updatedState.board.columns[0].cards).toHaveLength(1);
    expect(updatedState.board.columns[0].cards[0].text).toBe('My card');
  });

  it('throws when adding a card to a non-existent column', () => {
    const session = createSession();
    expect(() => session.addCard('non-existent-col', 'text', 'user-1', 'Alice')).toThrow(
      'Column not found'
    );
  });

  it('edit card by author succeeds', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Original', 'user-1', 'Alice');

    session.editCard(card.id, 'Updated', 'user-1');

    const state = session.getSessionState();
    expect(state.board.columns[0].cards[0].text).toBe('Updated');
  });

  it('edit card by moderator (ownerId) succeeds', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Original', 'user-1', 'Alice');

    // ownerId is 'owner-1'
    session.editCard(card.id, 'Moderator edit', 'owner-1');

    const state = session.getSessionState();
    expect(state.board.columns[0].cards[0].text).toBe('Moderator edit');
  });

  it('edit card by other user throws "Not authorized"', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Original', 'user-1', 'Alice');

    expect(() => session.editCard(card.id, 'Hacked', 'user-2')).toThrow('Not authorized');
  });

  it('remove card by author succeeds', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'To remove', 'user-1', 'Alice');

    session.removeCard(card.id, 'user-1');

    const state = session.getSessionState();
    expect(state.board.columns[0].cards).toHaveLength(0);
  });

  it('remove card by moderator succeeds', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'To remove', 'user-1', 'Alice');

    session.removeCard(card.id, 'owner-1');

    const state = session.getSessionState();
    expect(state.board.columns[0].cards).toHaveLength(0);
  });

  it('remove card by other user throws', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Protected', 'user-1', 'Alice');

    expect(() => session.removeCard(card.id, 'user-2')).toThrow('Not authorized');
  });

  it('move card within same column', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const card1 = session.addCard(columnId, 'First', 'user-1', 'Alice');
    const card2 = session.addCard(columnId, 'Second', 'user-1', 'Alice');

    // Move card1 to index 1 (after card2)
    session.moveCard(card1.id, columnId, 1);

    const state = session.getSessionState();
    const cards = state.board.columns[0].cards;
    expect(cards[0].text).toBe('Second');
    expect(cards[1].text).toBe('First');
  });

  it('move card to different column', () => {
    const session = createSession();
    const state = session.getSessionState();
    const col1Id = state.board.columns[0].id;
    const col2Id = state.board.columns[1].id;
    const card = session.addCard(col1Id, 'Moving card', 'user-1', 'Alice');

    session.moveCard(card.id, col2Id, 0);

    const updatedState = session.getSessionState();
    expect(updatedState.board.columns[0].cards).toHaveLength(0);
    expect(updatedState.board.columns[1].cards).toHaveLength(1);
    expect(updatedState.board.columns[1].cards[0].text).toBe('Moving card');
    expect(updatedState.board.columns[1].cards[0].columnId).toBe(col2Id);
  });

  it('move card to non-existent column throws', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Card', 'user-1', 'Alice');

    expect(() => session.moveCard(card.id, 'non-existent-col', 0)).toThrow('Column not found');
  });

  it('rejects card operations when board is completed', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Card', 'user-1', 'Alice');

    session.completeBoard();

    expect(() => session.addCard(columnId, 'New', 'user-1', 'Alice')).toThrow('Board is completed');
    expect(() => session.editCard(card.id, 'Edit', 'user-1')).toThrow('Board is completed');
    expect(() => session.removeCard(card.id, 'user-1')).toThrow('Board is completed');
    expect(() => session.moveCard(card.id, columnId, 0)).toThrow('Board is completed');
  });
});

describe('RetroSession - Voting Edge Cases', () => {
  it('vote on card increments count and decrements remaining', () => {
    const session = createSession({ maxVotesPerUser: 6 });
    session.addParticipant(makeUser({ id: 'user-1' }));
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Vote me', 'user-2', 'Bob');

    session.voteCard(card.id, 'user-1');

    const state = session.getSessionState();
    expect(state.board.columns[0].cards[0].votes).toBe(1);
    expect(state.board.columns[0].cards[0].votedBy).toContain('user-1');
    expect(session.getVotesRemaining('user-1')).toBe(5);
  });

  it('unvote on card decrements count and increments remaining', () => {
    const session = createSession({ maxVotesPerUser: 6 });
    session.addParticipant(makeUser({ id: 'user-1' }));
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Vote me', 'user-2', 'Bob');

    session.voteCard(card.id, 'user-1');
    session.unvoteCard(card.id, 'user-1');

    const state = session.getSessionState();
    expect(state.board.columns[0].cards[0].votes).toBe(0);
    expect(state.board.columns[0].cards[0].votedBy).not.toContain('user-1');
    expect(session.getVotesRemaining('user-1')).toBe(6);
  });

  it('vote when zero remaining throws', () => {
    const session = createSession({ maxVotesPerUser: 1 });
    session.addParticipant(makeUser({ id: 'user-1' }));
    const columnId = session.getSessionState().board.columns[0].id;
    const card1 = session.addCard(columnId, 'Card 1', 'user-2', 'Bob');
    const card2 = session.addCard(columnId, 'Card 2', 'user-2', 'Bob');

    session.voteCard(card1.id, 'user-1');

    expect(() => session.voteCard(card2.id, 'user-1')).toThrow('No votes remaining');
  });

  it('one-vote-per-card: second vote on same card throws', () => {
    const session = createSession({ oneVotePerCard: true, maxVotesPerUser: 6 });
    session.addParticipant(makeUser({ id: 'user-1' }));
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Card', 'user-2', 'Bob');

    session.voteCard(card.id, 'user-1');

    expect(() => session.voteCard(card.id, 'user-1')).toThrow('Already voted on this card');
  });

  it('one-vote-per-card: vote on different card succeeds', () => {
    const session = createSession({ oneVotePerCard: true, maxVotesPerUser: 6 });
    session.addParticipant(makeUser({ id: 'user-1' }));
    const columnId = session.getSessionState().board.columns[0].id;
    const card1 = session.addCard(columnId, 'Card 1', 'user-2', 'Bob');
    const card2 = session.addCard(columnId, 'Card 2', 'user-2', 'Bob');

    session.voteCard(card1.id, 'user-1');
    session.voteCard(card2.id, 'user-1');

    const state = session.getSessionState();
    expect(state.board.columns[0].cards[0].votes).toBe(1);
    expect(state.board.columns[0].cards[1].votes).toBe(1);
    expect(session.getVotesRemaining('user-1')).toBe(4);
  });

  it('unvote when user has not voted throws', () => {
    const session = createSession();
    session.addParticipant(makeUser({ id: 'user-1' }));
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Card', 'user-2', 'Bob');

    expect(() => session.unvoteCard(card.id, 'user-1')).toThrow(
      'User has not voted on this card'
    );
  });

  it('vote when voting disabled throws', () => {
    const session = createSession({ disableVotingInitially: true });
    session.addParticipant(makeUser({ id: 'user-1' }));
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Card', 'user-2', 'Bob');

    expect(() => session.voteCard(card.id, 'user-1')).toThrow('Voting is not enabled');
  });

  it('vote when board is completed throws', () => {
    const session = createSession();
    session.addParticipant(makeUser({ id: 'user-1' }));
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Card', 'user-2', 'Bob');

    session.completeBoard();

    expect(() => session.voteCard(card.id, 'user-1')).toThrow('Board is completed');
  });
});

describe('RetroSession - Moderator Workflow', () => {
  it('revealCards sets cardsRevealed to true', () => {
    const session = createSession({ hideCardsInitially: true });
    expect(session.getSessionState().board.cardsRevealed).toBe(false);

    session.revealCards();

    expect(session.getSessionState().board.cardsRevealed).toBe(true);
  });

  it('enableVoting sets votingEnabled to true', () => {
    const session = createSession({ disableVotingInitially: true });
    expect(session.getSessionState().board.votingEnabled).toBe(false);

    session.enableVoting();

    expect(session.getSessionState().board.votingEnabled).toBe(true);
  });

  it('completeBoard sets isCompleted to true', () => {
    const session = createSession();
    expect(session.getSessionState().board.isCompleted).toBe(false);

    session.completeBoard();

    expect(session.getSessionState().board.isCompleted).toBe(true);
  });

  it('updateContext updates board context', () => {
    const session = createSession();
    expect(session.getSessionState().board.context).toBe('');

    session.updateContext('Sprint 42 - Focus on performance');

    expect(session.getSessionState().board.context).toBe('Sprint 42 - Focus on performance');
  });

  it('updateConfig merges partial config', () => {
    const session = createSession({
      boardName: 'Original',
      maxVotesPerUser: 6,
      hideVoteCount: false,
    });

    const { config: updatedConfig } = session.updateConfig({ boardName: 'Updated', hideVoteCount: true });

    expect(updatedConfig.boardName).toBe('Updated');
    expect(updatedConfig.hideVoteCount).toBe(true);
    expect(updatedConfig.maxVotesPerUser).toBe(6); // unchanged
    expect(session.getSessionState().config.boardName).toBe('Updated');
  });

  it('moderator workflow: reveal → enable voting → complete', () => {
    const session = createSession({ hideCardsInitially: true, disableVotingInitially: true });
    session.addParticipant(makeUser({ id: 'user-1' }));
    const columnId = session.getSessionState().board.columns[0].id;
    session.addCard(columnId, 'Card 1', 'user-1', 'Alice');

    // Step 1: Reveal cards
    session.revealCards();
    expect(session.getSessionState().board.cardsRevealed).toBe(true);

    // Step 2: Enable voting
    session.enableVoting();
    expect(session.getSessionState().board.votingEnabled).toBe(true);

    // Step 3: Vote (now allowed)
    const cardId = session.getSessionState().board.columns[0].cards[0].id;
    session.voteCard(cardId, 'user-1');
    expect(session.getSessionState().board.columns[0].cards[0].votes).toBe(1);

    // Step 4: Complete
    session.completeBoard();
    expect(session.getSessionState().board.isCompleted).toBe(true);

    // Step 5: All modifications rejected
    expect(() => session.addCard(columnId, 'New', 'user-1', 'Alice')).toThrow('Board is completed');
  });

  it('getVisibleState shows all cards regardless of reveal state', () => {
    const session = createSession({ hideCardsInitially: true });
    session.addParticipant(makeUser({ id: 'user-1', displayName: 'Alice' }));
    session.addParticipant(makeUser({ id: 'user-2', displayName: 'Bob' }));
    const columnId = session.getSessionState().board.columns[0].id;
    session.addCard(columnId, 'Alice card', 'user-1', 'Alice');
    session.addCard(columnId, 'Bob card', 'user-2', 'Bob');

    // Before reveal: user-1 sees all cards (client handles visibility)
    const beforeReveal = session.getVisibleState('user-1');
    expect(beforeReveal.board.columns[0].cards).toHaveLength(2);

    // After reveal: user-1 still sees all cards
    session.revealCards();
    const afterReveal = session.getVisibleState('user-1');
    expect(afterReveal.board.columns[0].cards).toHaveLength(2);
  });
});

describe('RetroSession - CSV Export/Import', () => {
  it('export empty board produces only headers', () => {
    const session = createSession();
    const csv = session.exportCSV();

    expect(csv).toBe('Column,Card Text,Votes,Author,Comments');
  });

  it('export board with cards produces correct CSV format', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    session.addCard(columnId, 'Good teamwork', 'user-1', 'Alice');

    const csv = session.exportCSV();
    const lines = csv.split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('Column,Card Text,Votes,Author,Comments');
    expect(lines[1]).toBe('Start,Good teamwork,0,Alice,');
  });

  it('export handles special characters (commas, quotes, newlines)', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    session.addCard(columnId, 'Has, comma', 'user-1', 'Alice');
    session.addCard(columnId, 'Has "quotes"', 'user-1', 'Alice');
    session.addCard(columnId, 'Has\nnewline', 'user-1', 'Alice');

    const csv = session.exportCSV();
    const lines = csv.split('\n');

    // Header + 3 cards, but the newline card will split across lines in raw text
    // The CSV should properly quote fields with special characters
    expect(csv).toContain('"Has, comma"');
    expect(csv).toContain('"Has ""quotes"""');
    expect(csv).toContain('"Has\nnewline"');
  });

  it('import valid CSV creates cards in correct columns', () => {
    const session = createSession(); // Start, Stop, Continue columns
    const csvData = 'Column,Card Text,Votes,Author,Comments\nStart,Great sprint,0,Alice,\nStop,Too many meetings,0,Bob,';

    session.importCSV(csvData);

    const state = session.getSessionState();
    expect(state.board.columns[0].cards).toHaveLength(1);
    expect(state.board.columns[0].cards[0].text).toBe('Great sprint');
    expect(state.board.columns[1].cards).toHaveLength(1);
    expect(state.board.columns[1].cards[0].text).toBe('Too many meetings');
    expect(state.board.columns[2].cards).toHaveLength(0);
  });

  it('import empty CSV throws', () => {
    const session = createSession();
    expect(() => session.importCSV('')).toThrow('CSV data is empty');
  });

  it('import CSV with missing headers throws', () => {
    const session = createSession();
    const csvData = 'Name,Text\nStart,Hello';

    expect(() => session.importCSV(csvData)).toThrow(
      'CSV is missing required headers'
    );
  });

  it('import CSV with non-existent column throws', () => {
    const session = createSession();
    const csvData = 'Column,Card Text\nNonExistent,Some card';

    expect(() => session.importCSV(csvData)).toThrow('column "NonExistent" not found on the board');
  });

  it('import/export round trip preserves card text and column placement', () => {
    const session = createSession(); // Start, Stop, Continue
    const columnIds = session.getSessionState().board.columns.map((c) => c.id);

    session.addCard(columnIds[0], 'Start item 1', 'user-1', 'Alice');
    session.addCard(columnIds[0], 'Start item 2', 'user-1', 'Alice');
    session.addCard(columnIds[1], 'Stop item 1', 'user-1', 'Alice');
    session.addCard(columnIds[2], 'Continue item 1', 'user-1', 'Alice');

    const exportedCSV = session.exportCSV();

    // Create a new session with same template and import
    const session2 = createSession();
    session2.importCSV(exportedCSV);

    const state2 = session2.getSessionState();
    expect(state2.board.columns[0].cards).toHaveLength(2);
    expect(state2.board.columns[0].cards[0].text).toBe('Start item 1');
    expect(state2.board.columns[0].cards[1].text).toBe('Start item 2');
    expect(state2.board.columns[1].cards).toHaveLength(1);
    expect(state2.board.columns[1].cards[0].text).toBe('Stop item 1');
    expect(state2.board.columns[2].cards).toHaveLength(1);
    expect(state2.board.columns[2].cards[0].text).toBe('Continue item 1');
  });

  it('export includes comments joined with pipe separator', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Card with comments', 'user-1', 'Alice');
    session.addComment(card.id, 'First comment', 'user-2', 'Bob');
    session.addComment(card.id, 'Second comment', 'user-2', 'Bob');

    const csv = session.exportCSV();
    expect(csv).toContain('First comment | Second comment');
  });

  it('export includes vote count', () => {
    const session = createSession();
    session.addParticipant(makeUser({ id: 'user-1' }));
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Popular card', 'user-2', 'Bob');
    session.voteCard(card.id, 'user-1');

    const csv = session.exportCSV();
    const lines = csv.split('\n');
    // The vote count should be 1
    expect(lines[1]).toContain(',1,');
  });
});

describe('RetroSession - Comment Operations', () => {
  it('add comment to card', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Card', 'user-1', 'Alice');

    const comment = session.addComment(card.id, 'Great point!', 'user-2', 'Bob');

    expect(comment.text).toBe('Great point!');
    expect(comment.authorId).toBe('user-2');
    expect(comment.authorName).toBe('Bob');
    expect(comment.id).toBeDefined();
    expect(comment.createdAt).toBeDefined();

    const state = session.getSessionState();
    expect(state.board.columns[0].cards[0].comments).toHaveLength(1);
    expect(state.board.columns[0].cards[0].comments[0].text).toBe('Great point!');
  });

  it('remove comment by author', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Card', 'user-1', 'Alice');
    const comment = session.addComment(card.id, 'My comment', 'user-2', 'Bob');

    session.removeComment(card.id, comment.id, 'user-2');

    const state = session.getSessionState();
    expect(state.board.columns[0].cards[0].comments).toHaveLength(0);
  });

  it('remove comment by moderator', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Card', 'user-1', 'Alice');
    const comment = session.addComment(card.id, 'A comment', 'user-2', 'Bob');

    // ownerId is 'owner-1' (moderator)
    session.removeComment(card.id, comment.id, 'owner-1');

    const state = session.getSessionState();
    expect(state.board.columns[0].cards[0].comments).toHaveLength(0);
  });

  it('remove comment by other user throws', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Card', 'user-1', 'Alice');
    const comment = session.addComment(card.id, 'A comment', 'user-2', 'Bob');

    expect(() => session.removeComment(card.id, comment.id, 'user-3')).toThrow('Not authorized');
  });

  it('remove non-existent comment throws', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Card', 'user-1', 'Alice');

    expect(() => session.removeComment(card.id, 'non-existent-comment', 'user-1')).toThrow(
      'Comment not found'
    );
  });

  it('rejects comment operations when board is completed', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const card = session.addCard(columnId, 'Card', 'user-1', 'Alice');
    const comment = session.addComment(card.id, 'Comment', 'user-2', 'Bob');

    session.completeBoard();

    expect(() => session.addComment(card.id, 'New comment', 'user-2', 'Bob')).toThrow(
      'Board is completed'
    );
    expect(() => session.removeComment(card.id, comment.id, 'user-2')).toThrow(
      'Board is completed'
    );
  });
});

describe('RetroSession - mergeCards()', () => {
  it('combines text with separator (target + separator + source)', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const sourceCard = session.addCard(columnId, 'Source text', 'user-1', 'Alice');
    const targetCard = session.addCard(columnId, 'Target text', 'user-1', 'Alice');

    const result = session.mergeCards(sourceCard.id, targetCard.id, 'user-1');

    expect(result.targetCard.text).toBe('Target text\n--------\nSource text');
  });

  it('sums votes from both cards', () => {
    const session = createSession();
    session.addParticipant(makeUser({ id: 'user-1', displayName: 'Alice' }));
    session.addParticipant(makeUser({ id: 'user-2', displayName: 'Bob' }));
    session.addParticipant(makeUser({ id: 'user-3', displayName: 'Charlie' }));
    const columnId = session.getSessionState().board.columns[0].id;
    const sourceCard = session.addCard(columnId, 'Source', 'user-1', 'Alice');
    const targetCard = session.addCard(columnId, 'Target', 'user-1', 'Alice');

    // Vote on source (2 votes)
    session.voteCard(sourceCard.id, 'user-1');
    session.voteCard(sourceCard.id, 'user-2');
    // Vote on target (1 vote)
    session.voteCard(targetCard.id, 'user-3');

    const result = session.mergeCards(sourceCard.id, targetCard.id, 'user-1');

    expect(result.targetCard.votes).toBe(3);
    expect(result.targetCard.votedBy).toContain('user-1');
    expect(result.targetCard.votedBy).toContain('user-2');
    expect(result.targetCard.votedBy).toContain('user-3');
  });

  it('concatenates comments from both cards', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const sourceCard = session.addCard(columnId, 'Source', 'user-1', 'Alice');
    const targetCard = session.addCard(columnId, 'Target', 'user-1', 'Alice');

    session.addComment(sourceCard.id, 'Source comment 1', 'user-2', 'Bob');
    session.addComment(sourceCard.id, 'Source comment 2', 'user-2', 'Bob');
    session.addComment(targetCard.id, 'Target comment 1', 'user-3', 'Charlie');

    const result = session.mergeCards(sourceCard.id, targetCard.id, 'user-1');

    expect(result.targetCard.comments).toHaveLength(3);
    const commentTexts = result.targetCard.comments.map((c) => c.text);
    expect(commentTexts).toContain('Target comment 1');
    expect(commentTexts).toContain('Source comment 1');
    expect(commentTexts).toContain('Source comment 2');
  });

  it('removes source card from its column', () => {
    const session = createSession();
    const state = session.getSessionState();
    const col1Id = state.board.columns[0].id;
    const sourceCard = session.addCard(col1Id, 'Source', 'user-1', 'Alice');
    const targetCard = session.addCard(col1Id, 'Target', 'user-1', 'Alice');

    const result = session.mergeCards(sourceCard.id, targetCard.id, 'user-1');

    expect(result.removedFromColumnId).toBe(col1Id);
    const updatedState = session.getSessionState();
    const col1Cards = updatedState.board.columns[0].cards;
    expect(col1Cards).toHaveLength(1);
    expect(col1Cards[0].id).toBe(targetCard.id);
    // Source card should not exist anywhere
    const allCardIds = updatedState.board.columns.flatMap((col) => col.cards.map((c) => c.id));
    expect(allCardIds).not.toContain(sourceCard.id);
  });

  it('rejects merge on completed board', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const sourceCard = session.addCard(columnId, 'Source', 'user-1', 'Alice');
    const targetCard = session.addCard(columnId, 'Target', 'user-1', 'Alice');

    session.completeBoard();

    expect(() => session.mergeCards(sourceCard.id, targetCard.id, 'user-1')).toThrow(
      'Board is completed'
    );
  });

  it('rejects merge with invalid source card ID', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const targetCard = session.addCard(columnId, 'Target', 'user-1', 'Alice');

    expect(() => session.mergeCards('non-existent-id', targetCard.id, 'user-1')).toThrow(
      'Card not found'
    );
  });

  it('rejects merge with invalid target card ID', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const sourceCard = session.addCard(columnId, 'Source', 'user-1', 'Alice');

    expect(() => session.mergeCards(sourceCard.id, 'non-existent-id', 'user-1')).toThrow(
      'Card not found'
    );
  });

  it('merge works across different columns', () => {
    const session = createSession();
    const state = session.getSessionState();
    const col1Id = state.board.columns[0].id;
    const col2Id = state.board.columns[1].id;
    const sourceCard = session.addCard(col1Id, 'Source in col1', 'user-1', 'Alice');
    const targetCard = session.addCard(col2Id, 'Target in col2', 'user-1', 'Alice');

    const result = session.mergeCards(sourceCard.id, targetCard.id, 'user-1');

    expect(result.targetCard.text).toBe('Target in col2\n--------\nSource in col1');
    expect(result.removedFromColumnId).toBe(col1Id);
    const updatedState = session.getSessionState();
    expect(updatedState.board.columns[0].cards).toHaveLength(0);
    expect(updatedState.board.columns[1].cards).toHaveLength(1);
  });

  it('re-indexes remaining cards after removing source', () => {
    const session = createSession();
    const columnId = session.getSessionState().board.columns[0].id;
    const card1 = session.addCard(columnId, 'First', 'user-1', 'Alice');
    const card2 = session.addCard(columnId, 'Second (source)', 'user-1', 'Alice');
    const card3 = session.addCard(columnId, 'Third', 'user-1', 'Alice');
    // Target in a different column
    const col2Id = session.getSessionState().board.columns[1].id;
    const targetCard = session.addCard(col2Id, 'Target', 'user-1', 'Alice');

    session.mergeCards(card2.id, targetCard.id, 'user-1');

    const updatedState = session.getSessionState();
    const col1Cards = updatedState.board.columns[0].cards;
    expect(col1Cards).toHaveLength(2);
    expect(col1Cards[0].order).toBe(0);
    expect(col1Cards[0].text).toBe('First');
    expect(col1Cards[1].order).toBe(1);
    expect(col1Cards[1].text).toBe('Third');
  });
});
