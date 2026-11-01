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

import { ConnectionState, WS_PAYLOAD_TOO_LARGE_CLOSE_LIMIT } from '@shared/types';

/** Close code the server uses for a frame above `WS_MAX_PAYLOAD_BYTES` (R23.5). */
export const PAYLOAD_TOO_LARGE_CLOSE_CODE = 1009;

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
  /**
   * Consecutive 1009 closes of this Board_Connection. Kept across `open` and reset by
   * any other close code, a manual disconnect and `connect()` (R23.11, R23.13).
   */
  consecutiveTooLarge: number;
  /**
   * `true` once `WS_PAYLOAD_TOO_LARGE_CLOSE_LIMIT` consecutive 1009 closes were seen:
   * no reconnection and no further notification until a new connection (R23.12).
   */
  haltedTooLarge: boolean;
}

export type EpisodeEffect =
  | { kind: 'schedule-reconnect'; delayMs: number }
  | { kind: 'dismiss-connection-toasts' }
  | { kind: 'toast-give-up' }
  | { kind: 'navigate-login' }
  | { kind: 'toast-close-code'; code: number }
  | { kind: 'toast-payload-too-large' };

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
  consecutiveTooLarge: 0,
  haltedTooLarge: false,
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
  return {
    connection: 'disconnected',
    attempt: 0,
    episodeActive: false,
    gaveUp,
    consecutiveTooLarge: 0,
    haltedTooLarge: false,
  };
}

/** The drop is retried: the episode is open and the next attempt is scheduled (R11.19). */
function reconnectAfterDrop(state: EpisodeState, consecutiveTooLarge: number): EpisodeReduction {
  return {
    state: {
      connection: 'reconnecting',
      attempt: state.attempt,
      episodeActive: true,
      gaveUp: false,
      consecutiveTooLarge,
      haltedTooLarge: false,
    },
    effects: [
      { kind: 'dismiss-connection-toasts' },
      { kind: 'schedule-reconnect', delayMs: calculateBackoff(state.attempt) },
    ],
  };
}

/**
 * The single transition table of the design, in code.
 *
 * | Event               | Guard                      | Next state                          | Effects                                            |
 * |---------------------|----------------------------|-------------------------------------|----------------------------------------------------|
 * | `close`             | `haltedTooLarge`           | `disconnected`, still halted        | none                                               |
 * | `close`             | reserved code              | `disconnected`, episode closed      | `toast-close-code` (exactly one), no reconnect     |
 * | `close` 1009        | count + 1 >= 3             | `disconnected`, `haltedTooLarge`    | `toast-payload-too-large` (exactly one)            |
 * | `close`             | gave up earlier            | `disconnected`, episode closed      | none                                               |
 * | `close`             | otherwise                  | `reconnecting`, episode open        | `dismiss-connection-toasts`, `schedule-reconnect`  |
 * | `attempt`           | `attempt + 1 < 10`         | `attempt + 1`, still `reconnecting` | none — **no toast**                                |
 * | `attempt`           | `attempt + 1 === 10`       | `disconnected`, `gaveUp`            | `toast-give-up` (exactly one), `navigate-login`    |
 * | `open`              | —                          | `connected`, `attempt = 0`          | `dismiss-connection-toasts`                        |
 * | `manual-disconnect` | —                          | `disconnected`, episode closed      | none                                               |
 *
 * The consecutive 1009 count (R23.11–R23.13) is incremented by a 1009 close, kept by
 * `open`, and reset to 0 by any other close code and by `manual-disconnect`;
 * `connect()` resets it by starting again from `initialEpisodeState`. A 1009 close
 * below `WS_PAYLOAD_TOO_LARGE_CLOSE_LIMIT` is an ordinary drop, so at most
 * `limit − 1` reconnections are scheduled within one run of 1009 closes (R23.14).
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
      // channel for the loss (R11.27). The 1009 count survives `open`, because the
      // server accepts the connection and closes it again on the next oversized
      // frame (R23.11).
      return {
        state: {
          connection: 'connected',
          attempt: 0,
          episodeActive: false,
          gaveUp: false,
          consecutiveTooLarge: state.consecutiveTooLarge,
          haltedTooLarge: state.haltedTooLarge,
        },
        effects: [{ kind: 'dismiss-connection-toasts' }],
      };

    case 'close': {
      if (state.haltedTooLarge) {
        // The payload-too-large notification was shown once; stay down silently until
        // `connect()` starts a new connection (R23.12). A code other than 1009 still
        // resets the count (R23.13); the halt itself holds.
        return {
          state: {
            ...state,
            connection: 'disconnected',
            attempt: 0,
            episodeActive: false,
            consecutiveTooLarge:
              event.code === PAYLOAD_TOO_LARGE_CLOSE_CODE ? state.consecutiveTooLarge : 0,
          },
          effects: [],
        };
      }

      if (isReservedCloseCode(event.code)) {
        // The cause is known and final: report it once and make no attempt (R11.18).
        return {
          state: closedEpisode(state.gaveUp),
          effects: [{ kind: 'toast-close-code', code: event.code }],
        };
      }

      if (event.code === PAYLOAD_TOO_LARGE_CLOSE_CODE) {
        const consecutiveTooLarge = state.consecutiveTooLarge + 1;

        if (consecutiveTooLarge >= WS_PAYLOAD_TOO_LARGE_CLOSE_LIMIT) {
          // Repeated oversized frames: stop the loop with one notification, no
          // navigation and no reconnection (R23.12).
          return {
            state: {
              connection: 'disconnected',
              attempt: 0,
              episodeActive: false,
              gaveUp: state.gaveUp,
              consecutiveTooLarge: WS_PAYLOAD_TOO_LARGE_CLOSE_LIMIT,
              haltedTooLarge: true,
            },
            effects: [{ kind: 'toast-payload-too-large' }],
          };
        }

        if (state.gaveUp) {
          return { state: { ...closedEpisode(true), consecutiveTooLarge }, effects: [] };
        }

        // Below the limit a 1009 close is an ordinary, silent drop (R23.11).
        return reconnectAfterDrop(state, consecutiveTooLarge);
      }

      if (state.gaveUp) {
        // The threshold was already reached for this episode: stay down silently,
        // the give-up notification has been shown once already (R11.23).
        return { state: closedEpisode(true), effects: [] };
      }

      // Any code other than 1009 breaks the run of consecutive 1009 closes (R23.13).
      return reconnectAfterDrop(state, 0);
    }

    case 'attempt': {
      if (state.gaveUp || state.haltedTooLarge) {
        return { state, effects: [] };
      }

      const attempt = state.attempt + 1;

      if (attempt >= GIVE_UP_THRESHOLD) {
        // Exactly the transition that reaches the threshold carries the one
        // notification of the episode, plus the navigation to login (R11.16, R11.24).
        return {
          state: {
            ...state,
            connection: 'disconnected',
            attempt,
            episodeActive: false,
            gaveUp: true,
          },
          effects: [{ kind: 'toast-give-up' }, { kind: 'navigate-login' }],
        };
      }

      return {
        state: { ...state, connection: 'reconnecting', attempt, episodeActive: true, gaveUp: false },
        effects: [],
      };
    }

    case 'manual-disconnect':
      // A manual close is never counted and clears both the count and the halt (R23.13).
      return { state: closedEpisode(false), effects: [] };
  }
}
