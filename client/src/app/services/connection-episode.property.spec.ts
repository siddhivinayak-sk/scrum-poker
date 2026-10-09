import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ConnectionEvent,
  EpisodeEffect,
  EpisodeState,
  GIVE_UP_THRESHOLD,
  RESERVED_CLOSE_CODES,
  calculateBackoff,
  initialEpisodeState,
  isReservedCloseCode,
  reduceEpisode,
} from './connection-episode';

// Feature: poker-retro-ux-improvements, Properties 18 and 19 over the pure
// connection episode reducer. No Angular, no socket, no timer: every decision is
// read off the event sequence alone.

/** The effect kinds that put a message on screen. */
const NOTIFICATION_KINDS: readonly EpisodeEffect['kind'][] = ['toast-give-up', 'toast-close-code'];

/**
 * Text a connection notification must never carry: no report of a loss and no
 * attempt number (R11.26).
 */
const FORBIDDEN_NOTIFICATION_TEXT = /lost|attempt \d/i;

function isNotification(effect: EpisodeEffect): boolean {
  return NOTIFICATION_KINDS.includes(effect.kind);
}

function countKind(effects: EpisodeEffect[], kind: EpisodeEffect['kind']): number {
  return effects.filter((effect) => effect.kind === kind).length;
}

/** Every string an effect carries, including its own kind. */
function effectStrings(effect: EpisodeEffect): string[] {
  return Object.values(effect).filter((value): value is string => typeof value === 'string');
}

/** One reduction, kept with its input so the transition can be inspected. */
interface Step {
  before: EpisodeState;
  event: ConnectionEvent;
  after: EpisodeState;
  effects: EpisodeEffect[];
}

function run(events: ConnectionEvent[], from: EpisodeState = initialEpisodeState): Step[] {
  let state = from;
  const steps: Step[] = [];
  for (const event of events) {
    const { state: after, effects } = reduceEpisode(state, event);
    steps.push({ before: state, event, after, effects });
    state = after;
  }
  return steps;
}

function finalState(steps: Step[]): EpisodeState {
  return steps.length === 0 ? initialEpisodeState : steps[steps.length - 1].after;
}

/**
 * Arbitrary interleaving of the four events either WebSocket service can report.
 * `close` is generated without a code, so the sequences describe ordinary drops;
 * reserved codes are the subject of Property 19. `attempt` is weighted so that
 * sequences actually reach the give-up threshold rather than only approaching it.
 */
const connectionEventArb: fc.Arbitrary<ConnectionEvent> = fc.oneof(
  { arbitrary: fc.constant<ConnectionEvent>({ kind: 'attempt' }), weight: 8 },
  { arbitrary: fc.constant<ConnectionEvent>({ kind: 'close' }), weight: 2 },
  { arbitrary: fc.constant<ConnectionEvent>({ kind: 'open' }), weight: 1 },
  { arbitrary: fc.constant<ConnectionEvent>({ kind: 'manual-disconnect' }), weight: 1 },
);

/**
 * Stated upper bound on a generated sequence. `size: 'max'` is required:
 * fast-check's default sizing caps a generated array near ten entries whatever
 * `maxLength` says, and a ten-event sequence can essentially never stack the
 * ten consecutive attempts the give-up threshold needs — so without it the
 * threshold-crossing branch of this property is never reached at all.
 */
const MAX_SEQUENCE_LENGTH = 60;

const eventSequenceArb: fc.Arbitrary<ConnectionEvent[]> = fc.array(connectionEventArb, {
  minLength: 1,
  maxLength: MAX_SEQUENCE_LENGTH,
  size: 'max',
});

/**
 * Episodes that resolve: a drop, 1–9 failed attempts, then a restored connection.
 * This is the shape R11.15 names explicitly — such an episode must stay silent.
 */
const resolvedEpisodeArb: fc.Arbitrary<ConnectionEvent[]> = fc
  .array(
    fc
      .integer({ min: 1, max: 9 })
      .map<
        ConnectionEvent[]
      >((attempts) => [{ kind: 'close' }, ...Array.from({ length: attempts }, (): ConnectionEvent => ({ kind: 'attempt' })), { kind: 'open' }]),
    { minLength: 1, maxLength: 5 },
  )
  .map((episodes) => episodes.flat());

/** Counted outcome of a whole run, checked once the sequence is exhausted. */
interface RunTally {
  notifications: number;
  thresholdCrossings: number;
}

/**
 * Asserts the per-transition half of Property 18 and returns the run totals.
 *
 * Two documented departures from the literal "dismissal on every exit from
 * `connected`" wording, both from the design's transition table: a reserved-code
 * close emits only its own cause notification, and a user-initiated close arrives
 * as `manual-disconnect` and emits nothing at all. In neither case is a connection
 * notification on screen to dismiss, so both are asserted as they stand.
 */
function assertEpisodeInvariants(steps: Step[]): RunTally {
  let notifications = 0;
  let thresholdCrossings = 0;
  // Mirrors the design wording "after a crossing": set at the crossing, cleared
  // when the episode is resolved by a restored connection or ended by the user.
  let crossed = false;

  for (const step of steps) {
    // R11.26: nothing emitted may report a loss or an attempt number.
    for (const text of step.effects.flatMap(effectStrings)) {
      expect(FORBIDDEN_NOTIFICATION_TEXT.test(text)).toBe(false);
    }

    const stepNotifications = step.effects.filter(isNotification);
    notifications += stepNotifications.length;

    // R11.23: once the threshold was crossed no further reconnection is scheduled.
    if (crossed) {
      expect(countKind(step.effects, 'schedule-reconnect')).toBe(0);
      expect(step.before.gaveUp).toBe(true);
    }

    switch (step.event.kind) {
      case 'attempt': {
        if (step.before.gaveUp) {
          // Nothing left to do for this episode (R11.23).
          expect(step.effects).toEqual([]);
          expect(step.after).toEqual(step.before);
          break;
        }

        if (step.after.gaveUp) {
          thresholdCrossings += 1;
          crossed = true;

          // R11.16: exactly one notification, on exactly this transition.
          expect(stepNotifications).toEqual([{ kind: 'toast-give-up' }]);
          // R11.23/R11.24: down, no reconnection, login navigation.
          expect(step.after.connection).toBe('disconnected');
          expect(step.after.attempt).toBe(GIVE_UP_THRESHOLD);
          expect(step.after.episodeActive).toBe(false);
          expect(countKind(step.effects, 'schedule-reconnect')).toBe(0);
          expect(countKind(step.effects, 'navigate-login')).toBe(1);
          break;
        }

        // R11.14/R11.15: below the threshold an attempt is silent.
        expect(step.effects).toEqual([]);
        expect(step.after.connection).toBe('reconnecting');
        expect(step.after.attempt).toBe(step.before.attempt + 1);
        expect(step.after.attempt).toBeLessThan(GIVE_UP_THRESHOLD);
        break;
      }

      case 'close': {
        if (step.before.gaveUp) {
          expect(step.effects).toEqual([]);
          expect(step.after.connection).toBe('disconnected');
          break;
        }

        // R11.14: a drop is conveyed by the indicator alone.
        expect(stepNotifications).toEqual([]);
        expect(step.after.connection).toBe('reconnecting');
        expect(step.after.episodeActive).toBe(true);
        // R11.27: the dismissal accompanies the exit from `connected`.
        expect(countKind(step.effects, 'dismiss-connection-toasts')).toBe(1);
        // R11.19: the reconnection is scheduled off the episode's attempt count.
        expect(countKind(step.effects, 'schedule-reconnect')).toBe(1);
        expect(step.effects).toContainEqual({
          kind: 'schedule-reconnect',
          delayMs: calculateBackoff(step.before.attempt),
        });
        break;
      }

      case 'open': {
        crossed = false;
        // R11.25: the counter restarts, so the next episode counts from zero.
        expect(step.after).toEqual({
          connection: 'connected',
          attempt: 0,
          episodeActive: false,
          gaveUp: false,
        });
        // R11.27: returning to `connected` clears any connection notification.
        expect(countKind(step.effects, 'dismiss-connection-toasts')).toBe(1);
        expect(stepNotifications).toEqual([]);
        expect(countKind(step.effects, 'schedule-reconnect')).toBe(0);
        break;
      }

      case 'manual-disconnect': {
        crossed = false;
        expect(step.effects).toEqual([]);
        expect(step.after).toEqual({
          connection: 'disconnected',
          attempt: 0,
          episodeActive: false,
          gaveUp: false,
        });
        break;
      }
    }

    // The counter is never carried past the threshold.
    expect(step.after.attempt).toBeGreaterThanOrEqual(0);
    expect(step.after.attempt).toBeLessThanOrEqual(GIVE_UP_THRESHOLD);
  }

  return { notifications, thresholdCrossings };
}

/**
 * Property 18: Zero notifications before the give-up threshold, exactly one at it
 *
 * For any interleaving of drop and reconnection-attempt events, the reducer emits
 * no notification while the attempt count stays below ten, emits exactly one on the
 * transition that reaches ten, emits no further reconnection effect afterwards,
 * resets the attempt count on every return to `connected`, emits a dismissal on
 * every exit from `connected` through a drop, and never emits a notification whose
 * text reports a connection loss or an attempt number.
 *
 * **Validates: Requirements 11.14, 11.15, 11.16, 11.23, 11.25, 11.26, 11.27, 14.13**
 */
describe('Property 18: Zero notifications before the give-up threshold, exactly one at it', () => {
  /** What the generated sequences actually reached (coverage guard). */
  const coverage = { longestSequence: 0, crossings: 0 };

  it('R11.14/R11.16/R11.23/R11.25/R11.26/R11.27: emits one notification per threshold crossing and none otherwise, over arbitrary event sequences', () => {
    fc.assert(
      fc.property(eventSequenceArb, (events) => {
        const steps = run(events);
        expect(steps).toHaveLength(events.length);
        coverage.longestSequence = Math.max(coverage.longestSequence, events.length);

        const { notifications, thresholdCrossings } = assertEpisodeInvariants(steps);
        coverage.crossings += thresholdCrossings;

        // Counted over the whole run: notifications equal threshold crossings.
        expect(notifications).toBe(thresholdCrossings);
      }),
      { numRuns: 200 },
    );
  });

  it('R14.12: the generated sequences reach the stated length bound and actually cross the threshold', () => {
    // A coverage guard over the run above. `notifications === crossings` is
    // satisfied trivially by a run that never crosses, so without this the
    // property would still pass on a collapsed generator that only ever
    // produces short, sub-threshold sequences.
    expect(coverage.longestSequence).toBeGreaterThanOrEqual(54);
    expect(coverage.longestSequence).toBeLessThanOrEqual(MAX_SEQUENCE_LENGTH);
    expect(coverage.crossings).toBeGreaterThan(0);
  });

  it('R11.15/R14.13: an episode holding 1 through 9 attempts that ends with a restored connection produces zero notifications', () => {
    fc.assert(
      fc.property(resolvedEpisodeArb, (events) => {
        const steps = run(events);

        const { notifications, thresholdCrossings } = assertEpisodeInvariants(steps);

        expect(thresholdCrossings).toBe(0);
        expect(notifications).toBe(0);
        // Resolved: connected again with the counter back at zero.
        expect(finalState(steps)).toEqual({
          connection: 'connected',
          attempt: 0,
          episodeActive: false,
          gaveUp: false,
        });
      }),
      { numRuns: 100 },
    );
  });

  it('R11.16/R11.23: ten consecutive attempts cross the threshold exactly once and stop reconnecting', () => {
    const events: ConnectionEvent[] = [
      { kind: 'close' },
      ...Array.from({ length: 12 }, (): ConnectionEvent => ({ kind: 'attempt' })),
      { kind: 'close' },
    ];
    const steps = run(events);

    const { notifications, thresholdCrossings } = assertEpisodeInvariants(steps);

    expect(thresholdCrossings).toBe(1);
    expect(notifications).toBe(1);
    expect(finalState(steps).gaveUp).toBe(true);
    expect(finalState(steps).connection).toBe('disconnected');
    // Only the drop that opened the episode ever scheduled a reconnection.
    expect(
      steps.reduce((total, step) => total + countKind(step.effects, 'schedule-reconnect'), 0),
    ).toBe(1);
  });
});

/**
 * Property 19: Reserved close codes end the episode without reconnection
 *
 * For any close event carrying code 4009, 4010 or 4004, the reducer yields state
 * `disconnected`, exactly one notification for that cause, and no reconnection
 * effect; and for any attempt number 0–20 the backoff delay equals
 * `min(2^attempt * 1000, 30000)`.
 *
 * **Validates: Requirements 11.18, 11.19**
 */
describe('Property 19: Reserved close codes end the episode without reconnection', () => {
  it('R11.18: ends the episode with exactly one cause notification and no reconnection, from any reachable state', () => {
    fc.assert(
      fc.property(
        fc.array(connectionEventArb, {
          minLength: 0,
          maxLength: MAX_SEQUENCE_LENGTH,
          size: 'max',
        }),
        fc.constantFrom(...RESERVED_CLOSE_CODES),
        (events, code) => {
          expect(isReservedCloseCode(code)).toBe(true);

          const before = finalState(run(events));
          const { state, effects } = reduceEpisode(before, { kind: 'close', code });

          // The cause is known and final.
          expect(state.connection).toBe('disconnected');
          expect(state.attempt).toBe(0);
          expect(state.episodeActive).toBe(false);

          // Exactly one notification, carrying the close code.
          expect(effects.filter(isNotification)).toEqual([{ kind: 'toast-close-code', code }]);
          // No reconnection for this closure.
          expect(countKind(effects, 'schedule-reconnect')).toBe(0);

          // R11.26 holds for this branch too.
          for (const text of effects.flatMap(effectStrings)) {
            expect(FORBIDDEN_NOTIFICATION_TEXT.test(text)).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('R11.19: the reconnection delay equals min(2^attempt * 1000, 30000) for attempts 0 through 20', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (attempt) => {
        expect(calculateBackoff(attempt)).toBe(Math.min(Math.pow(2, attempt) * 1000, 30000));
      }),
      { numRuns: 100 },
    );

    // Every attempt in the range, so the 30-second ceiling is covered explicitly.
    for (let attempt = 0; attempt <= 20; attempt += 1) {
      expect(calculateBackoff(attempt)).toBe(Math.min(Math.pow(2, attempt) * 1000, 30000));
    }
    expect(calculateBackoff(0)).toBe(1000);
    expect(calculateBackoff(5)).toBe(30000);
  });
});
