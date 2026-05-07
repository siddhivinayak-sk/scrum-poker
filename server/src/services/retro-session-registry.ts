import crypto from 'crypto';
import { RetroConfiguration } from '../../../shared/types';
import { RetroSession } from './retro-session';

/**
 * Information returned when a retro session is created.
 */
export interface RetroSessionInfo {
  sessionId: string;
  ownerId: string;
  config: RetroConfiguration;
  createdAt: string;
}

/**
 * Generates a unique 8-character base-36 session ID.
 * Converts random bytes to a big integer, then to a base-36 string.
 * Checks against active sessions to guarantee uniqueness.
 */
function generateSessionId(activeSessions: Map<string, RetroSession>): string {
  let id: string;
  do {
    const bytes = crypto.randomBytes(6);
    const num = bytes.readUIntBE(0, 6);
    id = num.toString(36).slice(0, 8).padStart(8, '0');
  } while (activeSessions.has(id));
  return id;
}

/** Cleanup interval: 5 minutes in milliseconds */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** Inactive threshold: 30 minutes in milliseconds */
const INACTIVE_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Central manager for all retrospective board sessions.
 * Creates, stores, retrieves, and deletes RetroSession instances.
 * Runs a periodic cleanup timer to remove inactive sessions.
 *
 * Completely independent from the poker SessionRegistry (Requirement 15.4).
 */
export class RetroSessionRegistry {
  private sessions: Map<string, RetroSession> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Create a new retro session with a unique ID.
   * @param ownerId - The user ID of the session creator
   * @param config - The retro board configuration
   * @returns RetroSessionInfo with the created session details
   */
  createSession(ownerId: string, config: RetroConfiguration): RetroSessionInfo {
    const sessionId = generateSessionId(this.sessions);
    const session = new RetroSession(sessionId, ownerId, config);
    this.sessions.set(sessionId, session);

    console.log(`Retro session created: ${sessionId} by owner ${ownerId}`);

    return {
      sessionId: session.sessionId,
      ownerId: session.ownerId,
      config: session.config,
      createdAt: session.createdAt,
    };
  }

  /**
   * Retrieve a retro session by its ID.
   * @returns The RetroSession instance, or undefined if not found
   */
  getSession(sessionId: string): RetroSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Delete a retro session by its ID.
   * @returns true if the session was found and deleted, false otherwise
   */
  removeSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /**
   * Check whether a session with the given ID exists.
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Get the number of currently active retro sessions.
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Start the periodic cleanup timer that removes inactive sessions.
   * Idempotent: calling multiple times does not create multiple timers.
   */
  startCleanup(): void {
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
  stopCleanup(): void {
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
            `Retro session removed (inactive): ${sessionId} — last activity at ${session.lastActivityAt}`
          );
        }
      }
    }
  }

  /**
   * Reset all state. Used for test isolation.
   */
  _reset(): void {
    this.stopCleanup();
    this.sessions.clear();
  }
}

/** Singleton instance for use by routes and WebSocket handler */
export const retroSessionRegistry = new RetroSessionRegistry();
