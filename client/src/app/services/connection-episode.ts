/**
 * Pure connection episode reducer (design Stream 9).
 *
 * A Connection_Loss_Episode starts when the connection leaves `connected` and ends
 * when it returns to `connected` or when the give-up threshold is reached. Which
 * notification is allowed to appear is a property of the episode, not of a single
 * socket event, so the decision lives here as a state machine rather than inside
 * either WebSocket service: `WebSocketService` and `RetroWebSocketService` keep their
 * own socket plumbing, feed their events through `reduceEpisode` and then execute the
 * returned effects.
 *
 * The module is deliberately free of Angular and of socket imports — every
 * toast / navigation / reconnect decision is provable from the event sequence alone,
 * with no timers and no DOM (R11.14, R11.15, R11.16, R11.23, R11.25, R11.26, R11.27).
 */

import { ConnectionState } from '@shared/types';

/** Consecutive failed reconnection attempts after which restoring is given up (R11.16, R11.23). */
export const GIVE_UP_THRESHOLD = 10;

/** Longest reconnection delay, in milliseconds (R11.19). */
export const MAX_BACKOFF_MS = 30000;

/**
 * Close codes that carry their own cause and must never be retried: 4009 duplicate
 * display name, 4010 removed by the moderator, 4004 missing retrospective session
 * (R11.17, R11.18).
 */
export const RESERVED_CLOSE_CODES = [4009, 4010, 4004] as const;

/** A close code with a reported cause and no reconnection. */
export type ReservedCloseCode = (typeof RESERVED_CLOSE_CODES)[number];

/** Everything either service can tell the reducer about its socket. */
export type ConnectionEvent =
  | { kind: 'open' }
  | { kind: 'close'; code?: number }
  | { kind: 'attempt' }
  | { kind: 'manual-disconnect' };

export interface EpisodeState {
  /** The state the indicator renders (R11.4–R11.7). */
  connection: ConnectionState;
  /** Reconnection attempts made within the current episode. */
  attempt: number;
  /** `true` while an episode is open, i.e. a drop has not yet been resolved. */
  episodeActive: boolean;
  /** `true` once the threshold was reached; no further attempt is made (R11.23). */
  gaveUp: boolean;
}

export type EpisodeEffect =
  | { kind: 'schedule-reconnect'; delayMs: number }
  | { kind: 'dismiss-connection-toasts' }
  | { kind: 'toast-give-up' }
  | { kind: 'navigate-login' }
  | { kind: 'toast-close-code'; code: number };

/** Result of one reduction: the next state and the effects the caller must run. */
export interface EpisodeReduction {
  state: EpisodeState;
  effects: EpisodeEffect[];
}

/**
 * Both services start out `disconnected` with no episode open, which is the value
 * their `connectionState` signal already reports before `connect()` (R11.1).
 */
export const initialEpisodeState: EpisodeState = {
  connection: 'disconnected',
  attempt: 0,
  episodeActive: false,
  gaveUp: false,
};

/** `true` for 4009, 4010 and 4004. */
export function isReservedCloseCode(code: number | undefined): code is ReservedCloseCode {
  return code !== undefined && (RESERVED_CLOSE_CODES as readonly number[]).includes(code);
}

/**
 * Exponential backoff, unchanged from the two services it replaces:
 * `min(2^attempt * 1000, 30000)` ms (R11.19).
 */
export function calculateBackoff(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 0) {
    return 1000;
  }
  return Math.min(Math.pow(2, attempt) * 1000, MAX_BACKOFF_MS);
}

/** The episode is closed: nothing is pending and nothing is counted. */
function closedEpisode(gaveUp: boolean): EpisodeState {
  return { connection: 'disconnected', attempt: 0, episodeActive: false, gaveUp };
}

/**
 * The single transition table of the design, in code.
 *
 * | Event               | Guard                      | Next state                          | Effects                                            |
 * |---------------------|----------------------------|-------------------------------------|----------------------------------------------------|
 * | `close`             | reserved code              | `disconnected`, episode closed      | `toast-close-code` (exactly one), no reconnect     |
 * | `close`             | gave up earlier            | `disconnected`, episode closed      | none                                               |
 * | `close`             | otherwise                  | `reconnecting`, episode open        | `dismiss-connection-toasts`, `schedule-reconnect`  |
 * | `attempt`           | `attempt + 1 < 10`         | `attempt + 1`, still `reconnecting` | none — **no toast**                                |
 * | `attempt`           | `attempt + 1 === 10`       | `disconnected`, `gaveUp`            | `toast-give-up` (exactly one), `navigate-login`    |
 * | `open`              | —                          | `connected`, `attempt = 0`          | `dismiss-connection-toasts`                        |
 * | `manual-disconnect` | —                          | `disconnected`, episode closed      | none                                               |
 *
 * No branch emits a notification for a drop or for an attempt, so any sequence that
 * returns to `open` before the tenth attempt produces zero notification effects
 * (R11.14, R11.15, R11.25, R11.26); a manual close is reported through
 * `manual-disconnect` rather than `close`, which is the table's "not manual" guard.
 */
export function reduceEpisode(state: EpisodeState, event: ConnectionEvent): EpisodeReduction {
  switch (event.kind) {
    case 'open':
      // Returning to `connected` ends the episode and clears its counter, so the
      // next episode counts attempts from zero (R11.25). The dismissal accompanies
      // every change of connection state, which keeps the indicator the only
      // channel for the loss (R11.27).
      return {
        state: { connection: 'connected', attempt: 0, episodeActive: false, gaveUp: false },
        effects: [{ kind: 'dismiss-connection-toasts' }],
      };

    case 'close': {
      if (isReservedCloseCode(event.code)) {
        // The cause is known and final: report it once and make no attempt (R11.18).
        return {
          state: closedEpisode(state.gaveUp),
          effects: [{ kind: 'toast-close-code', code: event.code }],
        };
      }

      if (state.gaveUp) {
        // The threshold was already reached for this episode: stay down silently,
        // the give-up notification has been shown once already (R11.23).
        return { state: closedEpisode(true), effects: [] };
      }

      return {
        state: {
          connection: 'reconnecting',
          attempt: state.attempt,
          episodeActive: true,
          gaveUp: false,
        },
        effects: [
          { kind: 'dismiss-connection-toasts' },
          { kind: 'schedule-reconnect', delayMs: calculateBackoff(state.attempt) },
        ],
      };
    }

    case 'attempt': {
      if (state.gaveUp) {
        return { state, effects: [] };
      }

      const attempt = state.attempt + 1;

      if (attempt >= GIVE_UP_THRESHOLD) {
        // Exactly the transition that reaches the threshold carries the one
        // notification of the episode, plus the navigation to login (R11.16, R11.24).
        return {
          state: {
            connection: 'disconnected',
            attempt,
            episodeActive: false,
            gaveUp: true,
          },
          effects: [{ kind: 'toast-give-up' }, { kind: 'navigate-login' }],
        };
      }

      return {
        state: { connection: 'reconnecting', attempt, episodeActive: true, gaveUp: false },
        effects: [],
      };
    }

    case 'manual-disconnect':
      return { state: closedEpisode(false), effects: [] };
  }
}
