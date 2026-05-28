import { SessionRegistry } from '../session-registry';
import {
  SessionConfiguration,
  DEFAULT_SESSION_CONFIG,
} from '../../../../shared/types';

function makeConfig(overrides: Partial<SessionConfiguration> = {}): SessionConfiguration {
  return { ...DEFAULT_SESSION_CONFIG, ...overrides };
}

describe('SessionRegistry', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    jest.useFakeTimers();
    registry = new SessionRegistry();
  });

  afterEach(() => {
    registry._reset();
    jest.useRealTimers();
  });

  describe('createSession', () => {
    it('creates a session and returns session info with correct owner', () => {
      const config = makeConfig({ votingSystem: 't-shirt' });
      const info = registry.createSession('owner-1', config);

      expect(info.sessionId).toBeDefined();
      expect(info.sessionId.length).toBe(8);
      expect(info.ownerId).toBe('owner-1');
      expect(info.config.votingSystem).toBe('t-shirt');
      expect(info.createdAt).toBeDefined();
    });

    it('creates a session that is retrievable by its ID', () => {
      const info = registry.createSession('owner-1', makeConfig());
      const session = registry.getSession(info.sessionId);

      expect(session).toBeDefined();
      expect(session!.sessionId).toBe(info.sessionId);
      expect(session!.ownerId).toBe('owner-1');
    });

    it('increments active session count', () => {
      expect(registry.getActiveSessionCount()).toBe(0);
      registry.createSession('owner-1', makeConfig());
      expect(registry.getActiveSessionCount()).toBe(1);
      registry.createSession('owner-2', makeConfig());
      expect(registry.getActiveSessionCount()).toBe(2);
    });
  });

  describe('getSession', () => {
    it('returns the session for a valid ID', () => {
      const info = registry.createSession('owner-1', makeConfig());
      const session = registry.getSession(info.sessionId);
      expect(session).toBeDefined();
      expect(session!.ownerId).toBe('owner-1');
    });

    it('returns undefined for a non-existent ID', () => {
      expect(registry.getSession('nonexistent')).toBeUndefined();
    });
  });

  describe('deleteSession', () => {
    it('deletes an existing session and returns true', () => {
      const info = registry.createSession('owner-1', makeConfig());
      const result = registry.deleteSession(info.sessionId);

      expect(result).toBe(true);
      expect(registry.getSession(info.sessionId)).toBeUndefined();
      expect(registry.getActiveSessionCount()).toBe(0);
    });

    it('returns false when deleting a non-existent session', () => {
      expect(registry.deleteSession('nonexistent')).toBe(false);
    });
  });

  describe('hasSession', () => {
    it('returns true for an existing session', () => {
      const info = registry.createSession('owner-1', makeConfig());
      expect(registry.hasSession(info.sessionId)).toBe(true);
    });

    it('returns false for a non-existent session', () => {
      expect(registry.hasSession('nonexistent')).toBe(false);
    });

    it('returns false after a session is deleted', () => {
      const info = registry.createSession('owner-1', makeConfig());
      registry.deleteSession(info.sessionId);
      expect(registry.hasSession(info.sessionId)).toBe(false);
    });
  });

  describe('session ID uniqueness', () => {
    it('generates unique IDs across multiple creations', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const info = registry.createSession(`owner-${i}`, makeConfig());
        ids.add(info.sessionId);
      }
      expect(ids.size).toBe(50);
    });

    it('all session IDs are 8-character base-36 strings', () => {
      for (let i = 0; i < 20; i++) {
        const info = registry.createSession(`owner-${i}`, makeConfig());
        expect(info.sessionId).toMatch(/^[0-9a-z]{8}$/);
      }
    });
  });

  describe('concurrent session support', () => {
    it('supports multiple active sessions simultaneously', () => {
      const info1 = registry.createSession('owner-1', makeConfig({ votingSystem: 'fibonacci' }));
      const info2 = registry.createSession('owner-2', makeConfig({ votingSystem: 't-shirt' }));
      const info3 = registry.createSession('owner-3', makeConfig({ votingSystem: 'power-of-2' }));

      expect(registry.getActiveSessionCount()).toBe(3);

      const session1 = registry.getSession(info1.sessionId)!;
      const session2 = registry.getSession(info2.sessionId)!;
      const session3 = registry.getSession(info3.sessionId)!;

      expect(session1.config.votingSystem).toBe('fibonacci');
      expect(session2.config.votingSystem).toBe('t-shirt');
      expect(session3.config.votingSystem).toBe('power-of-2');
    });

    it('operations on one session do not affect another', () => {
      const info1 = registry.createSession('owner-1', makeConfig());
      const info2 = registry.createSession('owner-2', makeConfig());

      const session1 = registry.getSession(info1.sessionId)!;
      const session2 = registry.getSession(info2.sessionId)!;

      session1.addParticipant({
        id: 'u1',
        displayName: 'Alice',
        role: 'moderator',
        isAnonymous: false,
      });
      session1.startRound('Story for session 1');

      expect(session1.getParticipantCount()).toBe(1);
      expect(session1.getCurrentRound()).not.toBeNull();
      expect(session2.getParticipantCount()).toBe(0);
      expect(session2.getCurrentRound()).toBeNull();
    });

    it('deleting one session does not affect others', () => {
      const info1 = registry.createSession('owner-1', makeConfig());
      const info2 = registry.createSession('owner-2', makeConfig());

      registry.deleteSession(info1.sessionId);

      expect(registry.hasSession(info1.sessionId)).toBe(false);
      expect(registry.hasSession(info2.sessionId)).toBe(true);
      expect(registry.getActiveSessionCount()).toBe(1);
    });
  });

  describe('updateSessionConfig', () => {
    it('delegates config update to the GameSession', () => {
      const info = registry.createSession('owner-1', makeConfig({ autoReveal: false }));
      const updatedConfig = registry.updateSessionConfig(info.sessionId, { autoReveal: true });

      expect(updatedConfig.autoReveal).toBe(true);
      expect(updatedConfig.votingSystem).toBe('fibonacci');
    });

    it('returns the full updated configuration', () => {
      const info = registry.createSession('owner-1', makeConfig());
      const updatedConfig = registry.updateSessionConfig(info.sessionId, {
        votingSystem: 'modified-fibonacci',
        countdownAnimation: true,
      });

      expect(updatedConfig.votingSystem).toBe('modified-fibonacci');
      expect(updatedConfig.countdownAnimation).toBe(true);
      expect(updatedConfig.autoReveal).toBe(DEFAULT_SESSION_CONFIG.autoReveal);
    });

    it('persists the update in the session', () => {
      const info = registry.createSession('owner-1', makeConfig());
      registry.updateSessionConfig(info.sessionId, { votingSystem: 'power-of-2' });

      const session = registry.getSession(info.sessionId)!;
      expect(session.config.votingSystem).toBe('power-of-2');
    });

    it('throws when session does not exist', () => {
      expect(() =>
        registry.updateSessionConfig('nonexistent', { autoReveal: true })
      ).toThrow('Session not found: nonexistent');
    });
  });

  describe('cleanup timer', () => {
    it('removes inactive sessions with 0 participants after 30 days', () => {
      const info = registry.createSession('owner-1', makeConfig());
      // Session has 0 participants by default

      registry.startCleanupTimer();

      // Advance time by 31 days (past the 30-day threshold)
      jest.advanceTimersByTime(31 * 24 * 60 * 60 * 1000);

      // Advance to the next cleanup interval (1 hour)
      jest.advanceTimersByTime(60 * 60 * 1000);

      expect(registry.hasSession(info.sessionId)).toBe(false);
      expect(registry.getActiveSessionCount()).toBe(0);
    });

    it('skips sessions with active participants', () => {
      const info = registry.createSession('owner-1', makeConfig());
      const session = registry.getSession(info.sessionId)!;
      session.addParticipant({
        id: 'u1',
        displayName: 'Alice',
        role: 'moderator',
        isAnonymous: false,
      });

      registry.startCleanupTimer();

      // Advance time well past the threshold
      jest.advanceTimersByTime(31 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000);

      // Session should still exist because it has participants
      expect(registry.hasSession(info.sessionId)).toBe(true);
    });

    it('does not remove sessions that are still within the 30-day window', () => {
      const info = registry.createSession('owner-1', makeConfig());

      registry.startCleanupTimer();

      // Advance only 1 hour (one cleanup cycle, but session is still fresh)
      jest.advanceTimersByTime(60 * 60 * 1000);

      expect(registry.hasSession(info.sessionId)).toBe(true);
    });

    it('removes only inactive sessions, keeping active ones', () => {
      const infoInactive = registry.createSession('owner-1', makeConfig());
      const infoActive = registry.createSession('owner-2', makeConfig());

      const activeSession = registry.getSession(infoActive.sessionId)!;
      activeSession.addParticipant({
        id: 'u1',
        displayName: 'Alice',
        role: 'moderator',
        isAnonymous: false,
      });

      registry.startCleanupTimer();

      // Advance past the threshold + cleanup interval (31 days + 1 hour)
      jest.advanceTimersByTime(31 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000);

      expect(registry.hasSession(infoInactive.sessionId)).toBe(false);
      expect(registry.hasSession(infoActive.sessionId)).toBe(true);
    });

    it('startCleanupTimer is idempotent — calling multiple times does not create multiple timers', () => {
      const info = registry.createSession('owner-1', makeConfig());

      registry.startCleanupTimer();
      registry.startCleanupTimer();
      registry.startCleanupTimer();

      // Advance past threshold (31 days + 1 hour)
      jest.advanceTimersByTime(31 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000);

      // Session should be cleaned up exactly once (no errors from multiple timers)
      expect(registry.hasSession(info.sessionId)).toBe(false);
    });

    it('stopCleanupTimer prevents further cleanup', () => {
      const info = registry.createSession('owner-1', makeConfig());

      registry.startCleanupTimer();
      registry.stopCleanupTimer();

      // Advance past threshold
      jest.advanceTimersByTime(60 * 60 * 1000);

      // Session should still exist because timer was stopped
      expect(registry.hasSession(info.sessionId)).toBe(true);
    });

    it('_reset stops the cleanup timer and clears all sessions', () => {
      registry.createSession('owner-1', makeConfig());
      registry.createSession('owner-2', makeConfig());
      registry.startCleanupTimer();

      registry._reset();

      expect(registry.getActiveSessionCount()).toBe(0);

      // Advancing time should not cause errors (timer was stopped)
      jest.advanceTimersByTime(60 * 60 * 1000);
    });
  });
});
