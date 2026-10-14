/**
 * Pure animation helpers for the vote callouts: the lifecycle reducer, the simultaneous
 * animation budget and the name stagger arithmetic.
 *
 * No Angular, DOM, clock, timer or storage dependency lives here. The reducer returns
 * effects as data; the component owns the timers and the DOM and interprets those effects.
 *
 * Requirements: 5.3, 5.6, 5.8, 5.9, 5.10, 5.12, 5.13, 5.15, 5.16, 5.17, 6.1, 6.2, 6.9, 11.15
 */

// ---------------------------------------------------------------------------
// Timing constants
// ---------------------------------------------------------------------------

/** Entrance duration in ms; mirrors `--callout-entrance-ms` (R5.1, R5.2). */
export const ENTRANCE_MS = 420;
/** The whole staggered sequence must finish inside this window (R5.3). */
export const STAGGER_WINDOW_MS = 900;
export const STAGGER_MIN_MS = 40;
export const STAGGER_MAX_MS = 90;

/** An exit that has not reported completion by this deadline is removed anyway (R5.17). */
export const EXIT_REMOVAL_DEADLINE_MS = 700;

/** Maximum number of elements animated simultaneously inside one layer (R5.12). */
export const ANIMATION_BUDGET = 24;

// ---------------------------------------------------------------------------
// Lifecycle reducer
// ---------------------------------------------------------------------------

export type CalloutPhase = 'entering' | 'idle' | 'exiting' | 'removed';

export type ExitCause =
  | 'round-started'
  | 'board-cleared'
  | 'revote'
  | 'left-revealed'
  | 'dismissed'
  | 'suppressed'
  | 'fun-callouts-off';

export type LifecycleEvent =
  | {
      readonly kind: 'show';
      readonly reducedMotion: boolean;
      /** Budget share the layer acquired for this callout before `show`. Defaults to 1. */
      readonly budgetHeld?: number;
    }
  | { readonly kind: 'entrance-end' }
  | { readonly kind: 'exit-trigger'; readonly cause: ExitCause }
  | { readonly kind: 'exit-end' }
  | { readonly kind: 'exit-deadline' };

export interface LifecycleState {
  readonly phase: CalloutPhase;
  readonly reducedMotion: boolean;
  readonly idleStarted: boolean;
  /** Number of removals in the current show cycle; never exceeds 1 (R5.10). */
  readonly removalCount: number;
  /** Budget share still held by this callout; released with the removal. */
  readonly budgetHeld: number;
}

export type LifecycleEffect =
  | { readonly kind: 'start-idle' }
  | { readonly kind: 'capture-transform' }
  | { readonly kind: 'arm-exit-deadline'; readonly ms: number }
  | { readonly kind: 'remove' }
  | { readonly kind: 'release-budget'; readonly count: number };

export interface LifecycleResult {
  readonly state: LifecycleState;
  readonly effects: readonly LifecycleEffect[];
}

/** State of a callout that has never been shown. Exit triggers on it are no-ops. */
export const INITIAL_LIFECYCLE_STATE: LifecycleState = {
  phase: 'removed',
  reducedMotion: false,
  idleStarted: false,
  removalCount: 0,
  budgetHeld: 0,
};

function unchanged(state: LifecycleState): LifecycleResult {
  return { state, effects: [] };
}

function sanitiseCount(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/**
 * Pure lifecycle transition (design §7.6).
 *
 * - `entering` + `entrance-end` -> `idle`, emitting `start-idle` unless Reduced_Motion_Mode (R6.2, R5.15)
 * - `entering` + exit trigger -> `exiting` with `capture-transform`, never `start-idle` (R5.16)
 * - `idle` + exit trigger -> `exiting`
 * - `exiting` + exit trigger -> no-op, the running exit completes once (R5.10)
 * - `exiting` + `exit-end` | `exit-deadline` -> `removed` with one `remove` and one `release-budget` (R5.8, R5.17)
 * - `removed` ignores everything except a fresh `show`
 *
 * The cause `fun-callouts-off` switches the state into Reduced_Motion_Mode, because the setting
 * being disabled is part of that mode's definition; the exit is then realised as the
 * opacity-only transition (R6.1, R6.9).
 */
export function reduceCalloutLifecycle(
  state: LifecycleState,
  event: LifecycleEvent
): LifecycleResult {
  switch (event.kind) {
    case 'show': {
      if (state.phase !== 'removed') return unchanged(state);
      return {
        state: {
          phase: 'entering',
          reducedMotion: event.reducedMotion,
          idleStarted: false,
          removalCount: 0,
          budgetHeld: sanitiseCount(event.budgetHeld, 1),
        },
        effects: [],
      };
    }

    case 'entrance-end': {
      if (state.phase !== 'entering') return unchanged(state);
      if (state.reducedMotion) {
        return { state: { ...state, phase: 'idle' }, effects: [] };
      }
      return {
        state: { ...state, phase: 'idle', idleStarted: true },
        effects: [{ kind: 'start-idle' }],
      };
    }

    case 'exit-trigger': {
      if (state.phase !== 'entering' && state.phase !== 'idle') return unchanged(state);
      const effects: LifecycleEffect[] = [];
      if (state.phase === 'entering') effects.push({ kind: 'capture-transform' });
      effects.push({ kind: 'arm-exit-deadline', ms: EXIT_REMOVAL_DEADLINE_MS });
      return {
        state: {
          ...state,
          phase: 'exiting',
          reducedMotion: state.reducedMotion || event.cause === 'fun-callouts-off',
        },
        effects,
      };
    }

    case 'exit-end':
    case 'exit-deadline': {
      if (state.phase !== 'exiting' || state.removalCount >= 1) return unchanged(state);
      return {
        state: {
          ...state,
          phase: 'removed',
          removalCount: state.removalCount + 1,
          budgetHeld: 0,
        },
        effects: [{ kind: 'remove' }, { kind: 'release-budget', count: state.budgetHeld }],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Animation budget
// ---------------------------------------------------------------------------

/**
 * Tracks how many elements a single Vote_Callout_Layer is animating at once (R5.12).
 * One instance per layer; never shared through a root service.
 */
export class AnimationBudget {
  private held = 0;
  private readonly limit: number;

  constructor(capacity: number = ANIMATION_BUDGET) {
    this.limit = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : ANIMATION_BUDGET;
  }

  get capacity(): number {
    return this.limit;
  }

  /** Elements currently holding a share of the budget. Never exceeds `capacity`. */
  get inFlight(): number {
    return this.held;
  }

  /** Grants as many of the requested shares as remain and returns the number granted. */
  acquire(requested: number): number {
    const wanted = sanitiseCount(requested, 0);
    const granted = Math.min(wanted, this.limit - this.held);
    this.held += granted;
    return granted;
  }

  /** Returns shares to the budget; releasing more than is held clamps at zero. */
  release(count: number): void {
    this.held = Math.max(0, this.held - sanitiseCount(count, 0));
  }

  /**
   * How many of `nameCount` names may play the Entrance_Flourish given the shares still free.
   * Names beyond this number render at rest (R5.13). Does not change the held count.
   */
  plan(nameCount: number): number {
    return Math.min(sanitiseCount(nameCount, 0), this.limit - this.held);
  }
}

// ---------------------------------------------------------------------------
// Name stagger
// ---------------------------------------------------------------------------

/**
 * Per-name stagger interval in ms (R5.3): 40-90 ms, reduced toward 40 as the name count grows
 * so that the whole sequence (entrance plus steps) stays inside the 900 ms window.
 */
export function computeStagger(nameCount: number): number {
  const count = sanitiseCount(nameCount, 0);
  const steps = Math.max(1, count - 1);
  const budget = Math.floor((STAGGER_WINDOW_MS - ENTRANCE_MS) / steps);
  return Math.min(STAGGER_MAX_MS, Math.max(STAGGER_MIN_MS, budget));
}
