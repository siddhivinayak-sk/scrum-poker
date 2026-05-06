import { SessionRegistry } from '../session-registry';
import { DEFAULT_SESSION_CONFIG, SessionConfiguration } from '../../../../shared/types';

function makeConfig(overrides: Partial<SessionConfiguration> = {}): SessionConfiguration {
  return { ...DEFAULT_SESSION_CONFIG, ...overrides };
}

describe('SessionRegistry - getSessionsByOwner', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
  });

  afterEach(() => {
    registry._reset();
  });

  it('returns correct sessions for a given owner', () => {
    const info = registry.createSession('owner-1', makeConfig());

    const sessions = registry.getSessionsByOwner('owner-1');

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(info.sessionId);
    expect(sessions[0].ownerId).toBe('owner-1');
  });

  it('returns empty array for unknown owner', () => {
    registry.createSession('owner-1', makeConfig());

    const sessions = registry.getSessionsByOwner('unknown-owner');

    expect(sessions).toHaveLength(0);
  });

  it('returns multiple sessions for same owner', () => {
    const info1 = registry.createSession('owner-1', makeConfig());
    const info2 = registry.createSession('owner-1', makeConfig({ votingSystem: 't-shirt' }));
    const info3 = registry.createSession('owner-1', makeConfig({ votingSystem: 'power-of-2' }));

    const sessions = registry.getSessionsByOwner('owner-1');

    expect(sessions).toHaveLength(3);
    const sessionIds = sessions.map(s => s.sessionId);
    expect(sessionIds).toContain(info1.sessionId);
    expect(sessionIds).toContain(info2.sessionId);
    expect(sessionIds).toContain(info3.sessionId);
  });

  it('does not return sessions owned by other users', () => {
    registry.createSession('owner-1', makeConfig());
    const info2 = registry.createSession('owner-2', makeConfig());
    registry.createSession('owner-3', makeConfig());

    const sessions = registry.getSessionsByOwner('owner-2');

    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(info2.sessionId);
    expect(sessions[0].ownerId).toBe('owner-2');
  });

  it('returns empty array when registry has no sessions', () => {
    const sessions = registry.getSessionsByOwner('owner-1');

    expect(sessions).toHaveLength(0);
  });

  it('returns GameSession instances with correct properties', () => {
    registry.createSession('owner-1', makeConfig({ votingSystem: 'modified-fibonacci' }));

    const sessions = registry.getSessionsByOwner('owner-1');

    expect(sessions[0].config.votingSystem).toBe('modified-fibonacci');
    expect(sessions[0].createdAt).toBeDefined();
    expect(sessions[0].lastActivityAt).toBeDefined();
  });
});
