import { RetroSessionRegistry } from '../retro-session-registry';
import { RetroConfiguration } from '../../../../shared/types';

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

describe('RetroSessionRegistry', () => {
  let registry: RetroSessionRegistry;

  beforeEach(() => {
    registry = new RetroSessionRegistry();
  });

  afterEach(() => {
    registry._reset();
  });

  describe('createSession', () => {
    it('returns session info with a valid sessionId', () => {
      const info = registry.createSession('owner-1', makeConfig());

      expect(info.sessionId).toBeDefined();
      expect(typeof info.sessionId).toBe('string');
      expect(info.sessionId.length).toBeGreaterThan(0);
    });

    it('returns session info with the correct ownerId', () => {
      const info = registry.createSession('owner-42', makeConfig());

      expect(info.ownerId).toBe('owner-42');
    });

    it('returns session info with the provided config', () => {
      const config = makeConfig({ boardName: 'Sprint 5 Retro' });
      const info = registry.createSession('owner-1', config);

      expect(info.config.boardName).toBe('Sprint 5 Retro');
    });

    it('returns session info with a valid createdAt timestamp', () => {
      const info = registry.createSession('owner-1', makeConfig());

      expect(info.createdAt).toBeDefined();
      expect(() => new Date(info.createdAt)).not.toThrow();
      expect(new Date(info.createdAt).toISOString()).toBe(info.createdAt);
    });
  });

  describe('getSession', () => {
    it('returns the created session', () => {
      const info = registry.createSession('owner-1', makeConfig());

      const session = registry.getSession(info.sessionId);

      expect(session).toBeDefined();
      expect(session!.sessionId).toBe(info.sessionId);
      expect(session!.ownerId).toBe('owner-1');
    });

    it('returns undefined for a non-existent session', () => {
      const session = registry.getSession('non-existent-id');

      expect(session).toBeUndefined();
    });
  });

  describe('hasSession', () => {
    it('returns true for an existing session', () => {
      const info = registry.createSession('owner-1', makeConfig());

      expect(registry.hasSession(info.sessionId)).toBe(true);
    });

    it('returns false for a non-existent session', () => {
      expect(registry.hasSession('non-existent-id')).toBe(false);
    });
  });

  describe('removeSession', () => {
    it('deletes the session and returns true', () => {
      const info = registry.createSession('owner-1', makeConfig());

      const result = registry.removeSession(info.sessionId);

      expect(result).toBe(true);
      expect(registry.hasSession(info.sessionId)).toBe(false);
      expect(registry.getSession(info.sessionId)).toBeUndefined();
    });

    it('returns false for a non-existent session', () => {
      const result = registry.removeSession('non-existent-id');

      expect(result).toBe(false);
    });
  });

  describe('getSessionCount', () => {
    it('returns 0 when no sessions exist', () => {
      expect(registry.getSessionCount()).toBe(0);
    });

    it('returns the correct count after creating sessions', () => {
      registry.createSession('owner-1', makeConfig());
      registry.createSession('owner-2', makeConfig());
      registry.createSession('owner-3', makeConfig());

      expect(registry.getSessionCount()).toBe(3);
    });

    it('decrements after removing a session', () => {
      const info = registry.createSession('owner-1', makeConfig());
      registry.createSession('owner-2', makeConfig());

      registry.removeSession(info.sessionId);

      expect(registry.getSessionCount()).toBe(1);
    });
  });

  describe('multiple concurrent sessions', () => {
    it('creates independent sessions with unique IDs', () => {
      const info1 = registry.createSession('owner-1', makeConfig({ boardName: 'Retro A' }));
      const info2 = registry.createSession('owner-2', makeConfig({ boardName: 'Retro B' }));
      const info3 = registry.createSession('owner-3', makeConfig({ boardName: 'Retro C' }));

      expect(info1.sessionId).not.toBe(info2.sessionId);
      expect(info2.sessionId).not.toBe(info3.sessionId);
      expect(info1.sessionId).not.toBe(info3.sessionId);
    });

    it('retrieves the correct session for each ID', () => {
      const info1 = registry.createSession('owner-1', makeConfig({ boardName: 'Retro A' }));
      const info2 = registry.createSession('owner-2', makeConfig({ boardName: 'Retro B' }));

      const session1 = registry.getSession(info1.sessionId);
      const session2 = registry.getSession(info2.sessionId);

      expect(session1!.config.boardName).toBe('Retro A');
      expect(session2!.config.boardName).toBe('Retro B');
    });

    it('removing one session does not affect others', () => {
      const info1 = registry.createSession('owner-1', makeConfig());
      const info2 = registry.createSession('owner-2', makeConfig());

      registry.removeSession(info1.sessionId);

      expect(registry.hasSession(info1.sessionId)).toBe(false);
      expect(registry.hasSession(info2.sessionId)).toBe(true);
      expect(registry.getSession(info2.sessionId)).toBeDefined();
    });
  });

  describe('cleanup of inactive sessions', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('removes sessions with 0 participants and >30 min inactive', () => {
      const info = registry.createSession('owner-1', makeConfig());
      const session = registry.getSession(info.sessionId)!;

      // Set lastActivityAt to 31 minutes ago
      session.lastActivityAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();

      // Start cleanup and advance time to trigger the interval (5 minutes)
      registry.startCleanup();
      jest.advanceTimersByTime(5 * 60 * 1000);

      expect(registry.hasSession(info.sessionId)).toBe(false);
    });

    it('does NOT remove sessions with participants', () => {
      const info = registry.createSession('owner-1', makeConfig());
      const session = registry.getSession(info.sessionId)!;

      // Add a participant
      session.addParticipant({
        id: 'user-1',
        displayName: 'Alice',
        role: 'participant',
        isAnonymous: false,
      });

      // Set lastActivityAt to 60 minutes ago
      session.lastActivityAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      registry.startCleanup();
      jest.advanceTimersByTime(5 * 60 * 1000);

      expect(registry.hasSession(info.sessionId)).toBe(true);
    });

    it('does NOT remove recently active sessions with 0 participants', () => {
      const info = registry.createSession('owner-1', makeConfig());
      const session = registry.getSession(info.sessionId)!;

      // Set lastActivityAt to 10 minutes ago (within 30-minute threshold)
      session.lastActivityAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      registry.startCleanup();
      jest.advanceTimersByTime(5 * 60 * 1000);

      expect(registry.hasSession(info.sessionId)).toBe(true);
    });
  });

  describe('stopCleanup', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('stops the cleanup timer so no further cleanups occur', () => {
      const info = registry.createSession('owner-1', makeConfig());
      const session = registry.getSession(info.sessionId)!;

      // Set lastActivityAt to 31 minutes ago
      session.lastActivityAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();

      registry.startCleanup();
      registry.stopCleanup();

      // Advance time past the cleanup interval
      jest.advanceTimersByTime(10 * 60 * 1000);

      // Session should still exist because cleanup was stopped
      expect(registry.hasSession(info.sessionId)).toBe(true);
    });
  });

  describe('_reset', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('clears all sessions', () => {
      registry.createSession('owner-1', makeConfig());
      registry.createSession('owner-2', makeConfig());

      registry._reset();

      expect(registry.getSessionCount()).toBe(0);
    });

    it('stops the cleanup timer', () => {
      const info = registry.createSession('owner-1', makeConfig());
      const session = registry.getSession(info.sessionId)!;

      session.lastActivityAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();

      registry.startCleanup();
      registry._reset();

      // Create a new session after reset
      const info2 = registry.createSession('owner-2', makeConfig());
      const session2 = registry.getSession(info2.sessionId)!;
      session2.lastActivityAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();

      // Advance time — cleanup should not run since _reset stopped it
      jest.advanceTimersByTime(10 * 60 * 1000);

      // The new session should still exist (cleanup timer was stopped by _reset)
      expect(registry.hasSession(info2.sessionId)).toBe(true);
    });
  });

  describe('session independence from poker SessionRegistry', () => {
    it('RetroSessionRegistry is a separate class from poker SessionRegistry', () => {
      // Import both registries to verify they are distinct classes
      const { SessionRegistry } = require('../session-registry');

      expect(RetroSessionRegistry).not.toBe(SessionRegistry);
      expect(registry).not.toBeInstanceOf(SessionRegistry);
    });

    it('retro sessions do not appear in poker SessionRegistry', () => {
      const { SessionRegistry } = require('../session-registry');
      const pokerRegistry = new SessionRegistry();

      const retroInfo = registry.createSession('owner-1', makeConfig());

      // Poker registry should not have the retro session
      expect(pokerRegistry.hasSession(retroInfo.sessionId)).toBe(false);

      pokerRegistry._reset();
    });
  });
});
