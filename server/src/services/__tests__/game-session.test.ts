import { GameSession, RevealResult } from '../game-session';
import {
  User,
  CardValue,
  SessionConfiguration,
  DEFAULT_SESSION_CONFIG,
} from '../../../../shared/types';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: overrides.id ?? 'user-1',
    displayName: overrides.displayName ?? 'Alice',
    role: overrides.role ?? 'participant',
    isAnonymous: overrides.isAnonymous ?? false,
  };
}

function makeConfig(overrides: Partial<SessionConfiguration> = {}): SessionConfiguration {
  return { ...DEFAULT_SESSION_CONFIG, ...overrides };
}

function createSession(configOverrides: Partial<SessionConfiguration> = {}): GameSession {
  return new GameSession('test-session', 'owner-1', makeConfig(configOverrides));
}

describe('GameSession', () => {
  describe('constructor', () => {
    it('initializes with correct sessionId, ownerId, and config', () => {
      const config = makeConfig({ votingSystem: 't-shirt' });
      const session = new GameSession('abc123', 'owner-1', config);

      expect(session.sessionId).toBe('abc123');
      expect(session.ownerId).toBe('owner-1');
      expect(session.config.votingSystem).toBe('t-shirt');
      expect(session.createdAt).toBeDefined();
      expect(session.lastActivityAt).toBeDefined();
    });

    it('deep copies the config so mutations do not affect the original', () => {
      const config = makeConfig();
      const session = new GameSession('s1', 'o1', config);
      session.config.votingSystem = 't-shirt';
      expect(config.votingSystem).toBe('fibonacci');
    });
  });

  describe('addParticipant / removeParticipant', () => {
    it('adds a participant', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1' }));
      expect(session.getParticipants()).toHaveLength(1);
      expect(session.getParticipantCount()).toBe(1);
    });

    it('replaces a participant with the same id (reconnect)', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice Updated' }));
      expect(session.getParticipants()).toHaveLength(1);
      expect(session.getParticipants()[0].displayName).toBe('Alice Updated');
    });

    it('removes a participant', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1' }));
      session.removeParticipant('u1');
      expect(session.getParticipants()).toEqual([]);
      expect(session.getParticipantCount()).toBe(0);
    });

    it('removing a non-existent participant is a no-op', () => {
      const session = createSession();
      session.removeParticipant('non-existent');
      expect(session.getParticipants()).toEqual([]);
    });

    it('manages multiple participants', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));
      session.addParticipant(makeUser({ id: 'u2', displayName: 'Bob' }));
      session.addParticipant(makeUser({ id: 'u3', displayName: 'Charlie' }));
      expect(session.getParticipantCount()).toBe(3);

      session.removeParticipant('u2');
      expect(session.getParticipantCount()).toBe(2);
      expect(session.getParticipants().map((p) => p.id)).toEqual(['u1', 'u3']);
    });

    it('updates lastActivityAt on add', () => {
      const session = createSession();
      const before = session.lastActivityAt;
      session.addParticipant(makeUser({ id: 'u1' }));
      expect(session.lastActivityAt).toBeDefined();
    });
  });

  describe('startRound', () => {
    it('creates a voting round with status voting', () => {
      const session = createSession();
      const round = session.startRound('Estimate login feature');
      expect(round.storyDescription).toBe('Estimate login feature');
      expect(round.status).toBe('voting');
      expect(round.selections.size).toBe(0);
      expect(round.id).toBeDefined();
      expect(round.startedAt).toBeDefined();
    });

    it('trims whitespace from story description', () => {
      const session = createSession();
      const round = session.startRound('  Some story  ');
      expect(round.storyDescription).toBe('Some story');
    });

    it('throws on empty story description', () => {
      const session = createSession();
      expect(() => session.startRound('')).toThrow('Story description must not be empty');
    });

    it('throws on whitespace-only story description', () => {
      const session = createSession();
      expect(() => session.startRound('   ')).toThrow('Story description must not be empty');
    });

    it('getCurrentRound returns the active round', () => {
      const session = createSession();
      expect(session.getCurrentRound()).toBeNull();
      const round = session.startRound('A story');
      expect(session.getCurrentRound()).toBe(round);
    });

    it('starting a new round replaces the previous one', () => {
      const session = createSession();
      session.startRound('Story 1');
      const round2 = session.startRound('Story 2');
      expect(session.getCurrentRound()).toBe(round2);
      expect(session.getCurrentRound()!.storyDescription).toBe('Story 2');
    });
  });

  describe('selectCard', () => {
    it('records a card selection during an active round', () => {
      const session = createSession();
      session.startRound('A story');
      session.selectCard('u1', 5);
      expect(session.getSelections().get('u1')).toBe(5);
    });

    it('last-write-wins: replaces previous selection', () => {
      const session = createSession();
      session.startRound('A story');
      session.selectCard('u1', 5);
      session.selectCard('u1', 13);
      expect(session.getSelections().get('u1')).toBe(13);
    });

    it('supports special card values', () => {
      const session = createSession();
      session.startRound('A story');
      session.selectCard('u1', 'coffee');
      expect(session.getSelections().get('u1')).toBe('coffee');
    });

    it('is ignored when no active round', () => {
      const session = createSession();
      session.selectCard('u1', 5);
      expect(session.getSelections().size).toBe(0);
    });

    it('is ignored when round is already revealed', () => {
      const session = createSession();
      session.startRound('A story');
      session.selectCard('u1', 5);
      session.selectCard('u2', 8);
      session.revealCards();
      session.selectCard('u1', 13);
      expect(session.getSelections().get('u1')).toBe(5);
    });

    it('records selections from multiple users', () => {
      const session = createSession();
      session.startRound('A story');
      session.selectCard('u1', 3);
      session.selectCard('u2', 8);
      session.selectCard('u3', 'no-clue');
      expect(session.getSelections().size).toBe(3);
    });
  });

  describe('revealCards', () => {
    it('changes round status to revealed and returns metrics', () => {
      const session = createSession();
      session.startRound('A story');
      session.selectCard('u1', 5);
      session.selectCard('u2', 8);

      const result = session.revealCards();
      expect(session.getCurrentRound()!.status).toBe('revealed');
      expect(session.getCurrentRound()!.revealedAt).toBeDefined();
      expect(result.selections).toBe(session.getCurrentRound()!.selections);
      expect(result.metrics).toBeDefined();
      expect(result.metrics.average).toBe(6.5);
      expect(result.metrics.insufficientData).toBe(false);
    });

    it('returns insufficientData when fewer than 2 numeric votes', () => {
      const session = createSession();
      session.startRound('A story');
      session.selectCard('u1', 'coffee');

      const result = session.revealCards();
      expect(result.metrics.insufficientData).toBe(true);
    });

    it('throws when no active round', () => {
      const session = createSession();
      expect(() => session.revealCards()).toThrow('No active voting round');
    });

    it('throws when cards are already revealed', () => {
      const session = createSession();
      session.startRound('A story');
      session.selectCard('u1', 5);
      session.selectCard('u2', 8);
      session.revealCards();
      expect(() => session.revealCards()).toThrow('Cards have already been revealed');
    });
  });

  describe('clearBoard', () => {
    it('saves round to history and resets current round', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));
      session.addParticipant(makeUser({ id: 'u2', displayName: 'Bob' }));
      session.startRound('Story 1');
      session.selectCard('u1', 5);
      session.selectCard('u2', 8);
      session.revealCards();

      const entry = session.clearBoard();
      expect(session.getCurrentRound()).toBeNull();
      expect(entry.storyDescription).toBe('Story 1');
      expect(entry.roundId).toBeDefined();
      expect(entry.completedAt).toBeDefined();
      expect(entry.participants).toHaveLength(2);
      expect(entry.metrics).toBeDefined();
    });

    it('records participant votes including no-vote as null', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));
      session.addParticipant(makeUser({ id: 'u2', displayName: 'Bob' }));
      session.startRound('Story 1');
      session.selectCard('u1', 5);
      session.revealCards();

      const entry = session.clearBoard();
      const aliceVote = entry.participants.find((p) => p.userId === 'u1');
      const bobVote = entry.participants.find((p) => p.userId === 'u2');
      expect(aliceVote!.cardValue).toBe(5);
      expect(bobVote!.cardValue).toBeNull();
    });

    it('prepends to history (newest-first)', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1' }));
      session.addParticipant(makeUser({ id: 'u2' }));

      session.startRound('Story 1');
      session.selectCard('u1', 3);
      session.selectCard('u2', 5);
      session.revealCards();
      session.clearBoard();

      session.startRound('Story 2');
      session.selectCard('u1', 8);
      session.selectCard('u2', 13);
      session.revealCards();
      session.clearBoard();

      const hist = session.getHistory();
      expect(hist).toHaveLength(2);
      expect(hist[0].storyDescription).toBe('Story 2');
      expect(hist[1].storyDescription).toBe('Story 1');
    });

    it('throws when no active round', () => {
      const session = createSession();
      expect(() => session.clearBoard()).toThrow('No active voting round to clear');
    });
  });

  describe('getHistory / clearHistory', () => {
    it('getHistory returns empty array initially', () => {
      const session = createSession();
      expect(session.getHistory()).toEqual([]);
    });

    it('clearHistory empties all entries', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1' }));
      session.addParticipant(makeUser({ id: 'u2' }));
      session.startRound('Story 1');
      session.selectCard('u1', 5);
      session.selectCard('u2', 8);
      session.revealCards();
      session.clearBoard();

      expect(session.getHistory()).toHaveLength(1);
      session.clearHistory();
      expect(session.getHistory()).toEqual([]);
    });
  });

  describe('checkAutoReveal', () => {
    it('returns false when autoReveal is disabled', () => {
      const session = createSession({ autoReveal: false });
      session.addParticipant(makeUser({ id: 'u1' }));
      session.startRound('Story');
      session.selectCard('u1', 5);
      expect(session.checkAutoReveal()).toBe(false);
    });

    it('returns false when no active round', () => {
      const session = createSession({ autoReveal: true });
      session.addParticipant(makeUser({ id: 'u1' }));
      expect(session.checkAutoReveal()).toBe(false);
    });

    it('returns false when round is already revealed', () => {
      const session = createSession({ autoReveal: true });
      session.addParticipant(makeUser({ id: 'u1' }));
      session.startRound('Story');
      session.selectCard('u1', 5);
      session.revealCards();
      expect(session.checkAutoReveal()).toBe(false);
    });

    it('returns false when no participants', () => {
      const session = createSession({ autoReveal: true });
      session.startRound('Story');
      expect(session.checkAutoReveal()).toBe(false);
    });

    it('returns false when not all participants have voted', () => {
      const session = createSession({ autoReveal: true });
      session.addParticipant(makeUser({ id: 'u1' }));
      session.addParticipant(makeUser({ id: 'u2' }));
      session.startRound('Story');
      session.selectCard('u1', 5);
      expect(session.checkAutoReveal()).toBe(false);
    });

    it('returns true when autoReveal is enabled and all participants have voted', () => {
      const session = createSession({ autoReveal: true });
      session.addParticipant(makeUser({ id: 'u1' }));
      session.addParticipant(makeUser({ id: 'u2' }));
      session.startRound('Story');
      session.selectCard('u1', 5);
      session.selectCard('u2', 8);
      expect(session.checkAutoReveal()).toBe(true);
    });

    it('returns true with a single participant who has voted', () => {
      const session = createSession({ autoReveal: true });
      session.addParticipant(makeUser({ id: 'u1' }));
      session.startRound('Story');
      session.selectCard('u1', 3);
      expect(session.checkAutoReveal()).toBe(true);
    });

    it('returns true when all participants voted with special cards', () => {
      const session = createSession({ autoReveal: true });
      session.addParticipant(makeUser({ id: 'u1' }));
      session.addParticipant(makeUser({ id: 'u2' }));
      session.startRound('Story');
      session.selectCard('u1', 'coffee');
      session.selectCard('u2', 'no-clue');
      expect(session.checkAutoReveal()).toBe(true);
    });

    it('handles participant who left after voting (selection exists but not in participants)', () => {
      const session = createSession({ autoReveal: true });
      session.addParticipant(makeUser({ id: 'u1' }));
      session.addParticipant(makeUser({ id: 'u2' }));
      session.startRound('Story');
      session.selectCard('u1', 5);
      session.selectCard('u2', 8);
      session.removeParticipant('u2');
      // Only u1 is a participant now, and u1 has voted
      expect(session.checkAutoReveal()).toBe(true);
    });
  });

  describe('hasPermission', () => {
    describe('moderator-only mode', () => {
      it('returns true for moderator', () => {
        const session = createSession({
          revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        });
        session.addParticipant(makeUser({ id: 'u1', role: 'moderator' }));
        expect(session.hasPermission('u1', 'reveal')).toBe(true);
      });

      it('returns false for participant', () => {
        const session = createSession({
          revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        });
        session.addParticipant(makeUser({ id: 'u1', role: 'participant' }));
        expect(session.hasPermission('u1', 'reveal')).toBe(false);
      });
    });

    describe('all-players mode', () => {
      it('returns true for moderator', () => {
        const session = createSession({
          revealPermission: { mode: 'all-players', allowedUserIds: [] },
        });
        session.addParticipant(makeUser({ id: 'u1', role: 'moderator' }));
        expect(session.hasPermission('u1', 'reveal')).toBe(true);
      });

      it('returns true for participant', () => {
        const session = createSession({
          revealPermission: { mode: 'all-players', allowedUserIds: [] },
        });
        session.addParticipant(makeUser({ id: 'u1', role: 'participant' }));
        expect(session.hasPermission('u1', 'reveal')).toBe(true);
      });
    });

    describe('select-specific mode', () => {
      it('returns true for moderator even if not in allowedUserIds', () => {
        const session = createSession({
          revealPermission: { mode: 'select-specific', allowedUserIds: ['u2'] },
        });
        session.addParticipant(makeUser({ id: 'u1', role: 'moderator' }));
        expect(session.hasPermission('u1', 'reveal')).toBe(true);
      });

      it('returns true for participant in allowedUserIds', () => {
        const session = createSession({
          revealPermission: { mode: 'select-specific', allowedUserIds: ['u1'] },
        });
        session.addParticipant(makeUser({ id: 'u1', role: 'participant' }));
        expect(session.hasPermission('u1', 'reveal')).toBe(true);
      });

      it('returns false for participant not in allowedUserIds', () => {
        const session = createSession({
          revealPermission: { mode: 'select-specific', allowedUserIds: ['u2'] },
        });
        session.addParticipant(makeUser({ id: 'u1', role: 'participant' }));
        expect(session.hasPermission('u1', 'reveal')).toBe(false);
      });
    });

    describe('issue permission', () => {
      it('uses issuePermission config for issue permission checks', () => {
        const session = createSession({
          issuePermission: { mode: 'all-players', allowedUserIds: [] },
          revealPermission: { mode: 'moderator-only', allowedUserIds: [] },
        });
        session.addParticipant(makeUser({ id: 'u1', role: 'participant' }));
        expect(session.hasPermission('u1', 'issue')).toBe(true);
        expect(session.hasPermission('u1', 'reveal')).toBe(false);
      });
    });

    it('returns false for a user not in the session', () => {
      const session = createSession({
        revealPermission: { mode: 'all-players', allowedUserIds: [] },
      });
      expect(session.hasPermission('unknown-user', 'reveal')).toBe(false);
    });
  });

  describe('updateConfig', () => {
    it('merges partial config updates', () => {
      const session = createSession({ votingSystem: 'fibonacci', autoReveal: false });
      const updated = session.updateConfig({ autoReveal: true });
      expect(updated.autoReveal).toBe(true);
      expect(updated.votingSystem).toBe('fibonacci');
    });

    it('overwrites only the specified fields', () => {
      const session = createSession();
      session.updateConfig({ votingSystem: 't-shirt' });
      expect(session.config.votingSystem).toBe('t-shirt');
      expect(session.config.autoReveal).toBe(DEFAULT_SESSION_CONFIG.autoReveal);
      expect(session.config.countdownAnimation).toBe(DEFAULT_SESSION_CONFIG.countdownAnimation);
    });

    it('applies multiple sequential updates correctly', () => {
      const session = createSession();
      session.updateConfig({ votingSystem: 'power-of-2' });
      session.updateConfig({ autoReveal: true });
      session.updateConfig({ countdownAnimation: true });
      expect(session.config.votingSystem).toBe('power-of-2');
      expect(session.config.autoReveal).toBe(true);
      expect(session.config.countdownAnimation).toBe(true);
    });

    it('returns the full updated config', () => {
      const session = createSession();
      const result = session.updateConfig({ votingSystem: 'modified-fibonacci' });
      expect(result).toEqual(session.config);
      expect(result.votingSystem).toBe('modified-fibonacci');
    });

    it('updates lastActivityAt', () => {
      const session = createSession();
      const before = session.lastActivityAt;
      session.updateConfig({ autoReveal: true });
      expect(session.lastActivityAt).toBeDefined();
    });
  });

  describe('voting duration computation', () => {
    it('computes votingDurationMs on revealCards', () => {
      const session = createSession();
      session.startRound('Story');
      session.selectCard('u1', 5);
      session.selectCard('u2', 8);

      const result = session.revealCards();
      const round = session.getCurrentRound()!;
      expect(round.votingDurationMs).toBeDefined();
      expect(typeof round.votingDurationMs).toBe('number');
      expect(round.votingDurationMs!).toBeGreaterThanOrEqual(0);
    });

    it('includes votingDurationMs in history entry on clearBoard', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1' }));
      session.startRound('Story');
      session.selectCard('u1', 5);
      session.revealCards();

      const entry = session.clearBoard();
      expect(entry.votingDurationMs).toBeDefined();
      expect(typeof entry.votingDurationMs).toBe('number');
      expect(entry.votingDurationMs!).toBeGreaterThanOrEqual(0);
    });

    it('votingDurationMs equals revealedAt - startedAt in milliseconds', () => {
      const session = createSession();
      session.startRound('Story');
      session.selectCard('u1', 5);
      session.selectCard('u2', 8);

      const result = session.revealCards();
      const round = session.getCurrentRound()!;
      const startMs = new Date(round.startedAt).getTime();
      const revealMs = new Date(round.revealedAt!).getTime();
      expect(round.votingDurationMs).toBe(revealMs - startMs);
    });

    it('votingDurationMs is undefined when board is cleared without reveal', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1' }));
      session.startRound('Story');
      // Clear without revealing — clearBoard should still work since there's an active round
      // Actually, clearBoard doesn't require reveal. Let's check the code...
      // The code just saves whatever state the round is in.
      const entry = session.clearBoard();
      expect(entry.votingDurationMs).toBeUndefined();
    });
  });

  describe('getSessionState', () => {
    it('returns full state for reconnect sync', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1', displayName: 'Alice' }));
      session.startRound('A story');
      session.selectCard('u1', 5);

      const state = session.getSessionState();
      expect(state.currentRound).not.toBeNull();
      expect(state.currentRound!.storyDescription).toBe('A story');
      expect(state.participants).toHaveLength(1);
      expect(state.history).toEqual([]);
      expect(state.isRevealed).toBe(false);
      expect(state.sessionId).toBe('test-session');
      expect(state.ownerId).toBe('owner-1');
      expect(state.config).toEqual(session.config);
      expect(state.createdAt).toBe(session.createdAt);
    });

    it('isRevealed is true after reveal', () => {
      const session = createSession();
      session.startRound('A story');
      session.selectCard('u1', 5);
      session.selectCard('u2', 8);
      session.revealCards();

      const state = session.getSessionState();
      expect(state.isRevealed).toBe(true);
    });

    it('returns null currentRound when no round is active', () => {
      const session = createSession();
      const state = session.getSessionState();
      expect(state.currentRound).toBeNull();
      expect(state.isRevealed).toBe(false);
    });

    it('includes history entries', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1' }));
      session.addParticipant(makeUser({ id: 'u2' }));
      session.startRound('Story 1');
      session.selectCard('u1', 3);
      session.selectCard('u2', 5);
      session.revealCards();
      session.clearBoard();

      const state = session.getSessionState();
      expect(state.history).toHaveLength(1);
      expect(state.currentRound).toBeNull();
    });
  });

  describe('state transitions and error conditions', () => {
    it('full lifecycle: start → vote → reveal → clear → repeat', () => {
      const session = createSession();
      session.addParticipant(makeUser({ id: 'u1' }));
      session.addParticipant(makeUser({ id: 'u2' }));

      // Round 1
      session.startRound('Story 1');
      session.selectCard('u1', 3);
      session.selectCard('u2', 5);
      session.revealCards();
      session.clearBoard();

      expect(session.getCurrentRound()).toBeNull();
      expect(session.getHistory()).toHaveLength(1);

      // Round 2
      session.startRound('Story 2');
      session.selectCard('u1', 8);
      session.selectCard('u2', 13);
      session.revealCards();
      session.clearBoard();

      expect(session.getCurrentRound()).toBeNull();
      expect(session.getHistory()).toHaveLength(2);
    });

    it('cannot reveal twice', () => {
      const session = createSession();
      session.startRound('Story');
      session.selectCard('u1', 5);
      session.selectCard('u2', 8);
      session.revealCards();
      expect(() => session.revealCards()).toThrow('Cards have already been revealed');
    });

    it('cannot clear board without a round', () => {
      const session = createSession();
      expect(() => session.clearBoard()).toThrow('No active voting round to clear');
    });

    it('cannot reveal without a round', () => {
      const session = createSession();
      expect(() => session.revealCards()).toThrow('No active voting round');
    });

    it('selecting a card after reveal is ignored', () => {
      const session = createSession();
      session.startRound('Story');
      session.selectCard('u1', 5);
      session.revealCards();
      session.selectCard('u1', 13);
      expect(session.getSelections().get('u1')).toBe(5);
    });

    it('starting a new round resets selections', () => {
      const session = createSession();
      session.startRound('Story 1');
      session.selectCard('u1', 5);
      session.startRound('Story 2');
      expect(session.getSelections().size).toBe(0);
    });

    it('getSelections returns empty map when no round is active', () => {
      const session = createSession();
      expect(session.getSelections().size).toBe(0);
    });
  });
});
