import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { WS_PAYLOAD_TOO_LARGE_CLOSE_LIMIT } from '@shared/types';
import {
  ConnectionEvent,
  EpisodeEffect,
  EpisodeState,
  GIVE_UP_THRESHOLD,
  PAYLOAD_TOO_LARGE_CLOSE_CODE,
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
          consecutiveTooLarge: 0,
          haltedTooLarge: false,
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
          consecutiveTooLarge: 0,
          haltedTooLarge: false,
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
          consecutiveTooLarge: 0,
          haltedTooLarge: false,
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

// Feature: session-chat, Property 33: Reconnection is bounded on repeated oversized-frame closes

/**
 * Harness-only event: the service calls `connect()`, which restarts the reducer from
 * `initialEpisodeState` (R23.13). It is not a `ConnectionEvent`, so the harness
 * applies it itself instead of passing it to `reduceEpisode`.
 */
type HarnessEvent = ConnectionEvent | { kind: 'connect' };

/** Close codes: 1009 weighted so runs reach the limit, plus ordinary, reserved and other codes. */
const closeCodeArb: fc.Arbitrary<number | undefined> = fc.oneof(
  { arbitrary: fc.constant(PAYLOAD_TOO_LARGE_CLOSE_CODE), weight: 6 },
  { arbitrary: fc.constantFrom(1006, 1000), weight: 3 },
  { arbitrary: fc.constantFrom(...RESERVED_CLOSE_CODES), weight: 1 },
  { arbitrary: fc.constantFrom(1001, 1011, 4001), weight: 1 },
  { arbitrary: fc.constant(undefined), weight: 1 },
);

/**
 * One chunk of a sequence. Attempts come in bursts of 1–10, so sequences also reach
 * the give-up threshold and the "unchanged give-up behaviour" half is exercised.
 */
const tooLargeChunkArb: fc.Arbitrary<HarnessEvent[]> = fc.oneof(
  {
    arbitrary: closeCodeArb.map<HarnessEvent[]>((code) => [
      code === undefined ? { kind: 'close' } : { kind: 'close', code },
    ]),
    weight: 6,
  },
  {
    arbitrary: fc
      .integer({ min: 1, max: GIVE_UP_THRESHOLD })
      .map((n) => Array.from({ length: n }, (): HarnessEvent => ({ kind: 'attempt' }))),
    weight: 3,
  },
  { arbitrary: fc.constant<HarnessEvent[]>([{ kind: 'open' }]), weight: 3 },
  { arbitrary: fc.constant<HarnessEvent[]>([{ kind: 'manual-disconnect' }]), weight: 1 },
  { arbitrary: fc.constant<HarnessEvent[]>([{ kind: 'connect' }]), weight: 1 },
);

const tooLargeSequenceArb: fc.Arbitrary<HarnessEvent[]> = fc
  .array(tooLargeChunkArb, { minLength: 1, maxLength: 30, size: 'max' })
  .map((chunks) => chunks.flat());

/**
 * Independent model of the 1009 rules: the length of the current run of consecutive
 * 1009 closes (since the last non-1009 close, manual disconnect or `connect()`), the
 * reconnections scheduled within that run, and whether the limit was reached.
 */
interface TooLargeModel {
  run: number;
  scheduledInRun: number;
  openInRun: boolean;
  halted: boolean;
}

function freshTooLargeModel(): TooLargeModel {
  return { run: 0, scheduledInRun: 0, openInRun: false, halted: false };
}

interface TooLargeTally {
  halts: number;
  haltsAcrossOpen: number;
  giveUps: number;
}

/** The effects a notification, navigation or reconnection would add. */
function nonDismissEffects(effects: EpisodeEffect[]): EpisodeEffect[] {
  return effects.filter((effect) => effect.kind !== 'dismiss-connection-toasts');
}

function assertBoundedReconnect(events: HarnessEvent[]): TooLargeTally {
  const tally: TooLargeTally = { halts: 0, haltsAcrossOpen: 0, giveUps: 0 };
  let state = initialEpisodeState;
  let model = freshTooLargeModel();

  for (const event of events) {
    if (event.kind === 'connect') {
      // R23.13: a new connection starts from the initial state with count 0.
      state = initialEpisodeState;
      model = freshTooLargeModel();
      expect(state.consecutiveTooLarge).toBe(0);
      expect(state.haltedTooLarge).toBe(false);
      continue;
    }

    const before = state;
    const { state: after, effects } = reduceEpisode(before, event);
    state = after;

    const scheduled = countKind(effects, 'schedule-reconnect');
    const wasHalted = model.halted;
    const isTooLargeClose = event.kind === 'close' && event.code === PAYLOAD_TOO_LARGE_CLOSE_CODE;

    // R23.12: the too-large notification comes only from a 1009 close.
    if (!isTooLargeClose) {
      expect(countKind(effects, 'toast-payload-too-large')).toBe(0);
    }
    // R23.12/R23.13: navigation to login only ever comes from the give-up attempt.
    if (event.kind !== 'attempt') {
      expect(countKind(effects, 'navigate-login')).toBe(0);
    }

    // R23.12: once halted, nothing but a reset produces a reconnection, a notification
    // or a navigation; closes and attempts produce no effect at all.
    if (wasHalted && event.kind !== 'manual-disconnect') {
      expect(nonDismissEffects(effects)).toEqual([]);
      if (event.kind !== 'open') {
        expect(effects).toEqual([]);
      }
      if (event.kind === 'close') {
        expect(after.connection).toBe('disconnected');
      }
    }

    switch (event.kind) {
      case 'close': {
        if (isTooLargeClose) {
          model.run += 1;
          model.scheduledInRun += scheduled;

          if (!wasHalted && model.run === WS_PAYLOAD_TOO_LARGE_CLOSE_LIMIT) {
            // R23.12: the limit ends the episode with exactly one notification,
            // no navigation and no reconnection.
            model.halted = true;
            tally.halts += 1;
            if (model.openInRun) {
              tally.haltsAcrossOpen += 1;
            }
            expect(effects).toEqual([{ kind: 'toast-payload-too-large' }]);
            expect(after.connection).toBe('disconnected');
            expect(after.episodeActive).toBe(false);
          } else if (!wasHalted) {
            // R23.11: below the limit a 1009 close is an ordinary, silent drop.
            expect(model.run).toBeLessThan(WS_PAYLOAD_TOO_LARGE_CLOSE_LIMIT);
            if (before.gaveUp) {
              expect(effects).toEqual([]);
              expect(after.connection).toBe('disconnected');
            } else {
              expect(effects).toEqual([
                { kind: 'dismiss-connection-toasts' },
                { kind: 'schedule-reconnect', delayMs: calculateBackoff(before.attempt) },
              ]);
              expect(after.connection).toBe('reconnecting');
              expect(after.episodeActive).toBe(true);
            }
          }

          if (!model.halted) {
            expect(after.consecutiveTooLarge).toBe(model.run);
          }
          // R23.14: at most limit − 1 reconnections within one run of 1009 closes.
          expect(model.scheduledInRun).toBeLessThanOrEqual(WS_PAYLOAD_TOO_LARGE_CLOSE_LIMIT - 1);
          break;
        }

        // R23.13: any other close code ends the run and resets the count.
        model.run = 0;
        model.scheduledInRun = 0;
        model.openInRun = false;
        expect(after.consecutiveTooLarge).toBe(0);

        if (!wasHalted) {
          if (isReservedCloseCode(event.code)) {
            // R23.13: reserved-code behaviour is unchanged (R11.18).
            expect(effects).toEqual([{ kind: 'toast-close-code', code: event.code }]);
            expect(after.connection).toBe('disconnected');
          } else if (before.gaveUp) {
            expect(effects).toEqual([]);
            expect(after.connection).toBe('disconnected');
          } else {
            expect(effects).toEqual([
              { kind: 'dismiss-connection-toasts' },
              { kind: 'schedule-reconnect', delayMs: calculateBackoff(before.attempt) },
            ]);
            expect(after.connection).toBe('reconnecting');
          }
        }
        break;
      }

      case 'open': {
        // R23.11: `open` keeps the count and the halt.
        if (model.run > 0) {
          model.openInRun = true;
        }
        expect(after.consecutiveTooLarge).toBe(before.consecutiveTooLarge);
        expect(after.haltedTooLarge).toBe(before.haltedTooLarge);
        expect(scheduled).toBe(0);
        break;
      }

      case 'attempt': {
        expect(scheduled).toBe(0);
        expect(after.consecutiveTooLarge).toBe(before.consecutiveTooLarge);
        if (!wasHalted && !before.gaveUp) {
          if (before.attempt + 1 >= GIVE_UP_THRESHOLD) {
            // R23.13: the give-up threshold and the login navigation are unchanged.
            tally.giveUps += 1;
            expect(effects).toEqual([{ kind: 'toast-give-up' }, { kind: 'navigate-login' }]);
            expect(after.gaveUp).toBe(true);
          } else {
            expect(effects).toEqual([]);
          }
        }
        break;
      }

      case 'manual-disconnect': {
        // R23.13: a manual disconnect is not counted and resets count and halt.
        model = freshTooLargeModel();
        expect(effects).toEqual([]);
        expect(after.consecutiveTooLarge).toBe(0);
        expect(after.haltedTooLarge).toBe(false);
        break;
      }
    }

    expect(after.haltedTooLarge).toBe(model.halted);
    // R23.14: no episode makes more than the give-up threshold of attempts.
    expect(after.attempt).toBeGreaterThanOrEqual(0);
    expect(after.attempt).toBeLessThanOrEqual(GIVE_UP_THRESHOLD);
  }

  return tally;
}

/**
 * Property 33: Reconnection is bounded on repeated oversized-frame closes
 *
 * For any sequence of `open`, `attempt`, `manual-disconnect` and `close` events (codes
 * mixing 1009, 1006, 1000, 4004, 4009, 4010 and others), fed to `reduceEpisode` from
 * `initialEpisodeState`: at most `WS_PAYLOAD_TOO_LARGE_CLOSE_LIMIT − 1` reconnections
 * are scheduled within any run of consecutive 1009 closes; reaching the limit ends the
 * episode `disconnected` with exactly one too-large notification, no navigation and no
 * later reconnection or notification; any non-1009 close, manual disconnect or new
 * initial state resets the count while `open` does not; no episode makes more than 10
 * attempts; reserved-code and give-up behaviour is unchanged.
 *
 * **Validates: Requirements 23.11, 23.12, 23.13, 23.14**
 */
describe('Property 33: Reconnection is bounded on repeated oversized-frame closes', () => {
  const coverage: TooLargeTally = { halts: 0, haltsAcrossOpen: 0, giveUps: 0 };

  it('R23.11–R23.14: bounds reconnections within a run of 1009 closes and halts once at the limit, over arbitrary event sequences', () => {
    fc.assert(
      fc.property(tooLargeSequenceArb, (events) => {
        const tally = assertBoundedReconnect(events);
        coverage.halts += tally.halts;
        coverage.haltsAcrossOpen += tally.haltsAcrossOpen;
        coverage.giveUps += tally.giveUps;
      }),
      { numRuns: 200 },
    );
  });

  it('the generated sequences reach the 1009 limit (also across `open`) and the give-up threshold', () => {
    // Coverage guard over the run above: without halts the bound is satisfied trivially.
    expect(coverage.halts).toBeGreaterThan(0);
    expect(coverage.haltsAcrossOpen).toBeGreaterThan(0);
    expect(coverage.giveUps).toBeGreaterThan(0);
  });
});
