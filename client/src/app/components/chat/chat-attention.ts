/**
 * Pure state machine for the New_Message_Attention_Animation and the Unread_Ring
 * of the Chat_Launcher (design `ChatLauncherComponent`, Property 32, R2.13, R24).
 *
 * The module has no Angular, DOM or timer dependency. Time enters only through the
 * `now` carried by events, so every start, restart and stop is provable from the
 * event sequence alone. `ChatLauncherComponent` feeds the reducer from its signals,
 * renders the pulse span keyed by `attentionRun` (re-keying restarts the CSS
 * animation from its first iteration) and schedules a timer that dispatches
 * `tick(endsAt)` to end a run.
 */

/** Length of one pulse iteration, in milliseconds (R24.1). */
export const ATTENTION_ITERATION_MS = 1200;

/** Number of pulse iterations per run (R24.1). */
export const ATTENTION_ITERATIONS = 3;

/** Total length of one run: 3 × 1,200 ms = 3,600 ms (R24.1, R24.2). */
export const ATTENTION_DURATION_MS = ATTENTION_ITERATION_MS * ATTENTION_ITERATIONS;

/** The Panel_State values of the chat (same union as `ChatStore.panelState`). */
export type ChatPanelState = 'closed' | 'open' | 'minimized';

/** Everything the launcher can tell the reducer. */
export type AttentionEvent =
  /** An Unread_Increase occurred; `unread` is the new Unread_Count (R24.1, R24.2). */
  | { kind: 'unreadIncrease'; unread: number; now: number }
  /**
   * The Unread_Count changed without an Unread_Increase (a decrease, or a Chat_History
   * that left it unchanged). It never starts or restarts a run (R24.2) and stops one
   * at 0 (R24.6).
   */
  | { kind: 'unread'; unread: number }
  | { kind: 'panelState'; panelState: ChatPanelState }
  /** `document.visibilityState` changed; `now` is needed for a pending start (R24.10). */
  | { kind: 'visibility'; visible: boolean; now: number }
  /** `prefers-reduced-motion: reduce` changed (R24.7). */
  | { kind: 'reducedMotion'; reducedMotion: boolean }
  /** The clock reached `now`; a run whose 3,600 ms have elapsed ends (R24.1). */
  | { kind: 'tick'; now: number };

export interface AttentionState {
  /** The latest Unread_Count reported. */
  unread: number;
  panelState: ChatPanelState;
  /** `document.visibilityState === 'visible'`. */
  visible: boolean;
  /** The operating system reports `prefers-reduced-motion: reduce`. */
  reducedMotion: boolean;
  /** Number of runs started so far; the key of the current run while one is live. */
  run: number;
  /** Start time of the live run, or `null` when no run is live. */
  startedAt: number | null;
  /** An Unread_Increase occurred since the document last became hidden (R24.10). */
  pendingStart: boolean;
}

/** What the launcher renders and schedules. */
export interface AttentionOutput {
  /**
   * Key of the live run, or `null` when no run is live. The pulse span is rendered
   * while this is non-null and re-keyed when it changes. A live run is kept while
   * the document is hidden, so returning to the tab continues it instead of
   * re-creating the span and replaying it.
   */
  attentionRun: number | null;
  /**
   * `true` exactly when the animation is seen as running (Property 32): a run is
   * live, Panel_State is `closed` or `minimized`, the document is visible, reduced
   * motion is off and the Unread_Count is greater than 0.
   */
  running: boolean;
  /** When the live run ends (`startedAt + 3600`), for the launcher's timer; else `null`. */
  endsAt: number | null;
  /** The static Unread_Ring: Unread_Count > 0 and Panel_State not `open` (R2.13, R24.5). */
  unreadRing: boolean;
}

/** Result of one reduction: the next state and what to render. */
export interface AttentionReduction {
  state: AttentionState;
  output: AttentionOutput;
}

/** Defaults for a freshly created launcher: closed, visible, motion allowed, nothing unread. */
export const initialAttentionState: AttentionState = {
  unread: 0,
  panelState: 'closed',
  visible: true,
  reducedMotion: false,
  run: 0,
  startedAt: null,
  pendingStart: false,
};

/** Builds the initial state from the environment the launcher observes at creation. */
export function createAttentionState(
  init: Partial<Pick<AttentionState, 'unread' | 'panelState' | 'visible' | 'reducedMotion'>> = {},
): AttentionState {
  return { ...initialAttentionState, ...init };
}

/** Derives the render output from a state. */
export function attentionOutput(state: AttentionState): AttentionOutput {
  const { startedAt } = state;
  const live = startedAt !== null;
  return {
    attentionRun: live ? state.run : null,
    running:
      live &&
      state.visible &&
      !state.reducedMotion &&
      state.unread > 0 &&
      state.panelState !== 'open',
    endsAt: startedAt === null ? null : startedAt + ATTENTION_DURATION_MS,
    unreadRing: state.unread > 0 && state.panelState !== 'open',
  };
}

/** A start may happen: closed or minimized, visible, motion allowed and something unread. */
function canStart(state: AttentionState): boolean {
  return (
    state.panelState !== 'open' && state.visible && !state.reducedMotion && state.unread > 0
  );
}

/** Starts a new run (or restarts the live one) from its first iteration at `now`. */
function start(state: AttentionState, now: number): AttentionState {
  return { ...state, run: state.run + 1, startedAt: now, pendingStart: false };
}

function stop(state: AttentionState): AttentionState {
  return state.startedAt === null ? state : { ...state, startedAt: null };
}

function next(state: AttentionState, event: AttentionEvent): AttentionState {
  switch (event.kind) {
    case 'unreadIncrease': {
      const unread = Math.max(0, event.unread);
      if (unread === 0) {
        return stop({ ...state, unread });
      }
      const updated = { ...state, unread };
      if (!state.visible) {
        // Remember the increase; the start happens once on becoming visible (R24.10).
        return { ...updated, pendingStart: true };
      }
      // Start, or restart from the first iteration so the run ends 3,600 ms after the
      // latest increase (R24.1, R24.2). Open or reduced motion: no start (R24.4, R24.7).
      return canStart(updated) ? start(updated, event.now) : updated;
    }

    case 'unread': {
      const unread = Math.max(0, event.unread);
      // Never a start or restart (R24.2); a count of 0 ends the run (R24.6).
      const updated = { ...state, unread };
      return unread === 0 ? stop({ ...updated, pendingStart: false }) : updated;
    }

    case 'panelState': {
      const updated = { ...state, panelState: event.panelState };
      // `open` stops the run (R24.4); `closed` ↔ `minimized` leaves it alone (R24.12).
      return event.panelState === 'open' ? stop(updated) : updated;
    }

    case 'visibility': {
      if (event.visible === state.visible) {
        return state;
      }
      if (!event.visible) {
        // A new hidden period: only increases from now on count for R24.10.
        return { ...state, visible: false, pendingStart: false };
      }
      const updated = { ...state, visible: true };
      if (state.pendingStart && canStart(updated)) {
        return start(updated, event.now);
      }
      return { ...updated, pendingStart: false };
    }

    case 'reducedMotion': {
      const updated = { ...state, reducedMotion: event.reducedMotion };
      // Turning reduce on stops a running animation (R24.7); turning it off starts nothing.
      return event.reducedMotion ? stop({ ...updated, pendingStart: false }) : updated;
    }

    case 'tick':
      if (state.startedAt !== null && event.now >= state.startedAt + ATTENTION_DURATION_MS) {
        return stop(state);
      }
      return state;
  }
}

/**
 * The transition table of the design, in code.
 *
 * | Event            | Guard                                                   | Result                           |
 * |------------------|---------------------------------------------------------|----------------------------------|
 * | `unreadIncrease` | visible, not `open`, motion allowed, unread > 0         | start / restart at `now`         |
 * | `unreadIncrease` | hidden                                                  | `pendingStart = true`            |
 * | `unread`         | count 0                                                 | stop                             |
 * | `panelState`     | `open`                                                  | stop                             |
 * | `panelState`     | `closed` ↔ `minimized`                                  | run continues unchanged          |
 * | `visibility`     | becomes visible, pending, not `open`, motion, unread>0  | start once at `now`              |
 * | `visibility`     | becomes hidden                                          | `pendingStart = false`           |
 * | `reducedMotion`  | turns on                                                | stop                             |
 * | `tick`           | `now >= startedAt + 3600`                               | stop                             |
 */
export function reduceAttention(state: AttentionState, event: AttentionEvent): AttentionReduction {
  const nextState = next(state, event);
  return { state: nextState, output: attentionOutput(nextState) };
}
