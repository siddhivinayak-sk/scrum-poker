import {
  addParticipant,
  removeParticipant,
  getParticipants,
  startRound,
  getCurrentRound,
  selectCard,
  getSelections,
  revealCards,
  clearBoard,
  getHistory,
  clearHistory,
  getSessionState,
  _reset,
} from '../session-manager';
import { User, CardValue } from '../../../../shared/types';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: overrides.id ?? 'user-1',
    displayName: overrides.displayName ?? 'Alice',
    role: overrides.role ?? 'participant',
    isAnonymous: overrides.isAnonymous ?? false,
  };
}

describe('SessionManager', () => {
  beforeEach(() => {
    _reset();
  });

  describe('participant management', () => {
    it('adds a participant', () => {
      const user = makeUser();
      addParticipant(user);
      expect(getParticipants()).toEqual([user]);
    });

    it('replaces a participant with the same id (reconnect)', () => {
      const user1 = makeUser({ id: 'u1', displayName: 'Alice' });
      const user2 = makeUser({ id: 'u1', displayName: 'Alice Updated' });
      addParticipant(user1);
      addParticipant(user2);
      expect(getParticipants()).toHaveLength(1);
      expect(getParticipants()[0].displayName).toBe('Alice Updated');
    });

    it('removes a participant', () => {
      const user = makeUser({ id: 'u1' });
      addParticipant(user);
      removeParticipant('u1');
      expect(getParticipants()).toEqual([]);
    });

    it('removing a non-existent participant is a no-op', () => {
      removeParticipant('non-existent');
      expect(getParticipants()).toEqual([]);
    });

    it('manages multiple participants', () => {
      addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));
      addParticipant(makeUser({ id: 'u2', displayName: 'Bob' }));
      addParticipant(makeUser({ id: 'u3', displayName: 'Charlie' }));
      expect(getParticipants()).toHaveLength(3);

      removeParticipant('u2');
      expect(getParticipants()).toHaveLength(2);
      expect(getParticipants().map((p) => p.id)).toEqual(['u1', 'u3']);
    });
  });

  describe('startRound', () => {
    it('creates a voting round with status voting', () => {
      const round = startRound('Estimate login feature');
      expect(round.storyDescription).toBe('Estimate login feature');
      expect(round.status).toBe('voting');
      expect(round.selections.size).toBe(0);
      expect(round.id).toBeDefined();
      expect(round.startedAt).toBeDefined();
    });

    it('trims whitespace from story description', () => {
      const round = startRound('  Some story  ');
      expect(round.storyDescription).toBe('Some story');
    });

    it('throws on empty story description', () => {
      expect(() => startRound('')).toThrow('Story description must not be empty');
    });

    it('throws on whitespace-only story description', () => {
      expect(() => startRound('   ')).toThrow('Story description must not be empty');
    });

    it('getCurrentRound returns the active round', () => {
      expect(getCurrentRound()).toBeNull();
      const round = startRound('A story');
      expect(getCurrentRound()).toBe(round);
    });

    it('starting a new round replaces the previous one', () => {
      const round1 = startRound('Story 1');
      const round2 = startRound('Story 2');
      expect(getCurrentRound()).toBe(round2);
      expect(getCurrentRound()!.storyDescription).toBe('Story 2');
    });
  });

  describe('selectCard', () => {
    it('records a card selection during an active round', () => {
      startRound('A story');
      selectCard('u1', 5);
      expect(getSelections().get('u1')).toBe(5);
    });

    it('last-write-wins: replaces previous selection', () => {
      startRound('A story');
      selectCard('u1', 5);
      selectCard('u1', 13);
      expect(getSelections().get('u1')).toBe(13);
    });

    it('supports special card values', () => {
      startRound('A story');
      selectCard('u1', 'coffee');
      expect(getSelections().get('u1')).toBe('coffee');
    });

    it('is ignored when no active round', () => {
      selectCard('u1', 5);
      expect(getSelections().size).toBe(0);
    });

    it('is ignored when round is already revealed', () => {
      startRound('A story');
      selectCard('u1', 5);
      selectCard('u2', 8);
      revealCards();
      selectCard('u1', 13);
      // Should still be 5, not 13
      expect(getSelections().get('u1')).toBe(5);
    });

    it('records selections from multiple users', () => {
      startRound('A story');
      selectCard('u1', 3);
      selectCard('u2', 8);
      selectCard('u3', 'no-clue');
      expect(getSelections().size).toBe(3);
    });
  });

  describe('revealCards', () => {
    it('changes round status to revealed and returns metrics', () => {
      startRound('A story');
      selectCard('u1', 5);
      selectCard('u2', 8);

      const result = revealCards();
      expect(getCurrentRound()!.status).toBe('revealed');
      expect(getCurrentRound()!.revealedAt).toBeDefined();
      expect(result.selections).toBe(getCurrentRound()!.selections);
      expect(result.metrics).toBeDefined();
      expect(result.metrics.average).toBe(6.5);
      expect(result.metrics.insufficientData).toBe(false);
    });

    it('returns insufficientData when fewer than 2 numeric votes', () => {
      startRound('A story');
      selectCard('u1', 'coffee');

      const result = revealCards();
      expect(result.metrics.insufficientData).toBe(true);
    });

    it('throws when no active round', () => {
      expect(() => revealCards()).toThrow('No active voting round');
    });

    it('throws when cards are already revealed', () => {
      startRound('A story');
      selectCard('u1', 5);
      selectCard('u2', 8);
      revealCards();
      expect(() => revealCards()).toThrow('Cards have already been revealed');
    });
  });

  describe('clearBoard', () => {
    it('saves round to history and resets current round', () => {
      addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));
      addParticipant(makeUser({ id: 'u2', displayName: 'Bob' }));
      startRound('Story 1');
      selectCard('u1', 5);
      selectCard('u2', 8);
      revealCards();

      const entry = clearBoard();
      expect(getCurrentRound()).toBeNull();
      expect(entry.storyDescription).toBe('Story 1');
      expect(entry.roundId).toBeDefined();
      expect(entry.completedAt).toBeDefined();
      expect(entry.participants).toHaveLength(2);
      expect(entry.metrics).toBeDefined();
    });

    it('records participant votes including no-vote as null', () => {
      addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));
      addParticipant(makeUser({ id: 'u2', displayName: 'Bob' }));
      startRound('Story 1');
      selectCard('u1', 5);
      // u2 does not vote
      revealCards();

      const entry = clearBoard();
      const aliceVote = entry.participants.find((p) => p.userId === 'u1');
      const bobVote = entry.participants.find((p) => p.userId === 'u2');
      expect(aliceVote!.cardValue).toBe(5);
      expect(bobVote!.cardValue).toBeNull();
    });

    it('prepends to history (newest-first)', () => {
      addParticipant(makeUser({ id: 'u1' }));
      addParticipant(makeUser({ id: 'u2' }));

      startRound('Story 1');
      selectCard('u1', 3);
      selectCard('u2', 5);
      revealCards();
      clearBoard();

      startRound('Story 2');
      selectCard('u1', 8);
      selectCard('u2', 13);
      revealCards();
      clearBoard();

      const hist = getHistory();
      expect(hist).toHaveLength(2);
      expect(hist[0].storyDescription).toBe('Story 2');
      expect(hist[1].storyDescription).toBe('Story 1');
    });

    it('throws when no active round', () => {
      expect(() => clearBoard()).toThrow('No active voting round to clear');
    });
  });

  describe('history management', () => {
    it('getHistory returns empty array initially', () => {
      expect(getHistory()).toEqual([]);
    });

    it('clearHistory empties all entries', () => {
      addParticipant(makeUser({ id: 'u1' }));
      addParticipant(makeUser({ id: 'u2' }));
      startRound('Story 1');
      selectCard('u1', 5);
      selectCard('u2', 8);
      revealCards();
      clearBoard();

      expect(getHistory()).toHaveLength(1);
      clearHistory();
      expect(getHistory()).toEqual([]);
    });
  });

  describe('getSessionState', () => {
    it('returns full state for reconnect sync', () => {
      addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));
      startRound('A story');
      selectCard('u1', 5);

      const state = getSessionState();
      expect(state.currentRound).not.toBeNull();
      expect(state.currentRound!.storyDescription).toBe('A story');
      expect(state.participants).toHaveLength(1);
      expect(state.history).toEqual([]);
      expect(state.isRevealed).toBe(false);
    });

    it('isRevealed is true after reveal', () => {
      addParticipant(makeUser({ id: 'u1' }));
      addParticipant(makeUser({ id: 'u2' }));
      startRound('A story');
      selectCard('u1', 5);
      selectCard('u2', 8);
      revealCards();

      const state = getSessionState();
      expect(state.isRevealed).toBe(true);
    });

    it('returns null currentRound when no round is active', () => {
      const state = getSessionState();
      expect(state.currentRound).toBeNull();
      expect(state.isRevealed).toBe(false);
    });

    it('includes history entries', () => {
      addParticipant(makeUser({ id: 'u1' }));
      addParticipant(makeUser({ id: 'u2' }));
      startRound('Story 1');
      selectCard('u1', 3);
      selectCard('u2', 5);
      revealCards();
      clearBoard();

      const state = getSessionState();
      expect(state.history).toHaveLength(1);
      expect(state.currentRound).toBeNull();
    });
  });

  describe('_reset', () => {
    it('clears all state', () => {
      addParticipant(makeUser({ id: 'u1' }));
      startRound('A story');
      selectCard('u1', 5);

      _reset();

      expect(getParticipants()).toEqual([]);
      expect(getCurrentRound()).toBeNull();
      expect(getHistory()).toEqual([]);
    });
  });
});
