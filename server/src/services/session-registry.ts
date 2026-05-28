import crypto from 'crypto';
import { SessionConfiguration } from '../../../shared/types';
import { GameSession } from './game-session';

/**
 * Information returned when a session is created.
 */
export interface GameSessionInfo {
  sessionId: string;
  ownerId: string;
  config: SessionConfiguration;
  createdAt: string;
}

/**
 * Generates a unique 8-character base-36 session ID.
 * Converts random bytes to a big integer, then to a base-36 string.
 * Checks against active sessions to guarantee uniqueness.
 */
function generateSessionId(activeSessions: Map<string, GameSession>): string {
  let id: string;
  do {
    const bytes = crypto.randomBytes(6);
    // Convert bytes to a numeric value and then to base-36
    const num = bytes.readUIntBE(0, 6);
    id = num.toString(36).slice(0, 8).padStart(8, '0');
  } while (activeSessions.has(id));
  return id;
}

/** Cleanup interval: 1 hour in milliseconds */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Inactive threshold: 30 days in milliseconds */
const INACTIVE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Central manager for all game sessions.
 * Creates, stores, retrieves, and deletes GameSession instances.
 * Runs a periodic cleanup timer to remove inactive sessions.
 */
export class SessionRegistry {
  private sessions: Map<string, GameSession> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Create a new game session with a unique ID.
   * @param ownerId - The user ID of the session creator
   * @param config - The session configuration
   * @returns GameSessionInfo with the created session details
   */
  createSession(ownerId: string, config: SessionConfiguration): GameSessionInfo {
    const sessionId = generateSessionId(this.sessions);
    const session = new GameSession(sessionId, ownerId, config);
    this.sessions.set(sessionId, session);

    console.log(`Session created: ${sessionId} by owner ${ownerId}`);

    return {
      sessionId: session.sessionId,
      ownerId: session.ownerId,
      config: session.config,
      createdAt: session.createdAt,
    };
  }

  /**
   * Retrieve a game session by its ID.
   * @returns The GameSession instance, or undefined if not found
   */
  getSession(sessionId: string): GameSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Delete a game session by its ID.
   * @returns true if the session was found and deleted, false otherwise
   */
  deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * Check whether a session with the given ID exists.
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get all sessions owned by a specific user.
   * @param ownerId - The user ID of the session owner
   * @returns Array of GameSession instances owned by the user
   */
  getSessionsByOwner(ownerId: string): GameSession[] {
    const result: GameSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.ownerId === ownerId) {
        result.push(session);
      }
    }
    return result;
  }

  /**
   * Get the number of currently active sessions.
   */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Update the configuration of an existing session.
   * Delegates to GameSession.updateConfig.
   * @throws Error if the session does not exist
   */
  updateSessionConfig(
    sessionId: string,
    partialConfig: Partial<SessionConfiguration>
  ): SessionConfiguration {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session.updateConfig(partialConfig);
  }

  /**
   * Start the periodic cleanup timer that removes inactive sessions.
   * Idempotent: calling multiple times does not create multiple timers.
   */
  startCleanupTimer(): void {
    if (this.cleanupTimer !== null) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanupInactiveSessions();
    }, CLEANUP_INTERVAL_MS);
  }

  /**
   * Stop the periodic cleanup timer.
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Remove sessions that have 0 participants and whose lastActivityAt
   * is older than 30 minutes.
   */
  private cleanupInactiveSessions(): void {
    const now = Date.now();

    for (const [sessionId, session] of this.sessions) {
      if (session.getParticipantCount() === 0) {
        const lastActivity = new Date(session.lastActivityAt).getTime();
        if (now - lastActivity > INACTIVE_THRESHOLD_MS) {
          this.sessions.delete(sessionId);
          console.log(
            `Session removed (inactive): ${sessionId} — last activity at ${session.lastActivityAt}`
          );
        }
      }
    }
  }

  /**
   * Reset all state. Used for test isolation.
   */
  _reset(): void {
    this.stopCleanupTimer();
    this.sessions.clear();
  }
}

/** Singleton instance for use by routes and WebSocket handler */
export const sessionRegistry = new SessionRegistry();
