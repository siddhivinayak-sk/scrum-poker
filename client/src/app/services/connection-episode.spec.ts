import { describe, it, expect } from 'vitest';
import { WS_PAYLOAD_TOO_LARGE_CLOSE_LIMIT } from '@shared/types';
import {
  ConnectionEvent,
  EpisodeEffect,
  EpisodeReduction,
  EpisodeState,
  GIVE_UP_THRESHOLD,
  PAYLOAD_TOO_LARGE_CLOSE_CODE,
  calculateBackoff,
  initialEpisodeState,
  reduceEpisode,
} from './connection-episode';

// Feature: session-chat, example tests for the 1009 rules of the
// Connection_Episode_Reducer (R22.13, R23.11, R23.12, R23.13).

const OPEN: ConnectionEvent = { kind: 'open' };
const ATTEMPT: ConnectionEvent = { kind: 'attempt' };
const MANUAL: ConnectionEvent = { kind: 'manual-disconnect' };
const close = (code?: number): ConnectionEvent => ({ kind: 'close', code });
const TOO_LARGE = close(PAYLOAD_TOO_LARGE_CLOSE_CODE);

/** Effects that put something on screen or move the user away from the board. */
const VISIBLE_KINDS: readonly EpisodeEffect['kind'][] = [
  'toast-give-up',
  'toast-close-code',
  'toast-payload-too-large',
  'navigate-login',
];

interface Run {
  state: EpisodeState;
  /** The reduction of every event, in order. */
  steps: EpisodeReduction[];
  /** All effects of the run, flattened. */
  effects: EpisodeEffect[];
}

function run(events: ConnectionEvent[], from: EpisodeState = initialEpisodeState): Run {
  let state = from;
  const steps: EpisodeReduction[] = [];
  for (const event of events) {
    const reduction = reduceEpisode(state, event);
    steps.push(reduction);
    state = reduction.state;
  }
  return { state, steps, effects: steps.flatMap((step) => step.effects) };
}

function kinds(effects: EpisodeEffect[]): EpisodeEffect['kind'][] {
  return effects.map((effect) => effect.kind);
}

function visible(effects: EpisodeEffect[]): EpisodeEffect[] {
  return effects.filter((effect) => VISIBLE_KINDS.includes(effect.kind));
}

function reconnects(effects: EpisodeEffect[]): EpisodeEffect[] {
  return effects.filter((effect) => effect.kind === 'schedule-reconnect');
}

/** A connected socket that has already been through `limit - 1` 1009 closes, each followed by `open`. */
function oneBelowLimit(): EpisodeState {
  const events: ConnectionEvent[] = [OPEN];
  for (let i = 0; i < WS_PAYLOAD_TOO_LARGE_CLOSE_LIMIT - 1; i++) {
    events.push(TOO_LARGE, ATTEMPT, OPEN);
  }
  return run(events).state;
}

/** A socket halted by `limit` consecutive 1009 closes with `open` between each pair. */
function halted(): EpisodeState {
  return reduceEpisode(oneBelowLimit(), TOO_LARGE).state;
}

describe('connection-episode reducer: 1009 rules', () => {
  it('uses the limit of 3 from shared types and close code 1009', () => {
    expect(WS_PAYLOAD_TOO_LARGE_CLOSE_LIMIT).toBe(3);
    expect(PAYLOAD_TOO_LARGE_CLOSE_CODE).toBe(1009);
  });

  it('starts out with a zero 1009 count and not halted', () => {
    expect(initialEpisodeState.consecutiveTooLarge).toBe(0);
    expect(initialEpisodeState.haltedTooLarge).toBe(false);
  });

  describe('a 1009 close below the limit (R23.11)', () => {
    it('starts a reconnect episode with the existing backoff and no notification', () => {
      const connected = reduceEpisode(initialEpisodeState, OPEN).state;
      const { state, effects } = reduceEpisode(connected, TOO_LARGE);

      expect(state.connection).toBe('reconnecting');
      expect(state.episodeActive).toBe(true);
      expect(state.haltedTooLarge).toBe(false);
      expect(state.consecutiveTooLarge).toBe(1);
      expect(effects).toEqual([
        { kind: 'dismiss-connection-toasts' },
        { kind: 'schedule-reconnect', delayMs: calculateBackoff(0) },
      ]);
    });

    it('continues an open episode with the backoff of the current attempt', () => {
      // Drop with 1006, two failed attempts, then a 1009 close of the third socket.
      const { state: before } = run([OPEN, close(1006), ATTEMPT, close(1006), ATTEMPT]);
      expect(before.attempt).toBe(2);

      const { state, effects } = reduceEpisode(before, TOO_LARGE);

      expect(state.connection).toBe('reconnecting');
      expect(state.episodeActive).toBe(true);
      expect(state.attempt).toBe(2);
      expect(state.consecutiveTooLarge).toBe(1);
      expect(visible(effects)).toEqual([]);
      expect(reconnects(effects)).toEqual([
        { kind: 'schedule-reconnect', delayMs: calculateBackoff(2) },
      ]);
    });

    it('keeps the count across open while open resets the attempt counter', () => {
      const { state } = run([OPEN, TOO_LARGE, ATTEMPT, OPEN]);

      expect(state.connection).toBe('connected');
      expect(state.attempt).toBe(0);
      expect(state.consecutiveTooLarge).toBe(1);
    });

    it('treats the second 1009 close as a silent drop that still reconnects', () => {
      const { state, steps } = run([OPEN, TOO_LARGE, ATTEMPT, OPEN, TOO_LARGE]);
      const last = steps[steps.length - 1];

      expect(state.connection).toBe('reconnecting');
      expect(state.consecutiveTooLarge).toBe(2);
      expect(state.haltedTooLarge).toBe(false);
      expect(visible(last.effects)).toEqual([]);
      expect(reconnects(last.effects)).toEqual([
        { kind: 'schedule-reconnect', delayMs: calculateBackoff(0) },
      ]);
    });
  });

  describe('three 1009 closes with open between each pair (R23.12)', () => {
    const events: ConnectionEvent[] = [
      OPEN,
      TOO_LARGE,
      ATTEMPT,
      OPEN,
      TOO_LARGE,
      ATTEMPT,
      OPEN,
      TOO_LARGE,
    ];

    it('ends the episode disconnected with exactly one notification and no navigation', () => {
      const { state, effects, steps } = run(events);

      expect(state.connection).toBe('disconnected');
      expect(state.episodeActive).toBe(false);
      expect(state.haltedTooLarge).toBe(true);
      expect(state.consecutiveTooLarge).toBe(WS_PAYLOAD_TOO_LARGE_CLOSE_LIMIT);
      expect(steps[steps.length - 1].effects).toEqual([{ kind: 'toast-payload-too-large' }]);
      expect(visible(effects)).toEqual([{ kind: 'toast-payload-too-large' }]);
      expect(kinds(effects)).not.toContain('navigate-login');
    });

    it('schedules at most limit - 1 reconnections and none after the third close', () => {
      const { effects, steps } = run(events);

      expect(reconnects(effects)).toHaveLength(WS_PAYLOAD_TOO_LARGE_CLOSE_LIMIT - 1);
      expect(reconnects(steps[steps.length - 1].effects)).toEqual([]);
    });

    it('makes no attempt and no notification for later attempt and close events', () => {
      const after = run(
        [ATTEMPT, TOO_LARGE, close(1006), ATTEMPT, close(1000), TOO_LARGE, ATTEMPT],
        halted(),
      );

      expect(after.effects).toEqual([]);
      expect(after.state.connection).toBe('disconnected');
      expect(after.state.haltedTooLarge).toBe(true);
      expect(after.state.attempt).toBe(0);
    });

    it('also stays silent for a reserved close code after the halt', () => {
      const { state, effects } = reduceEpisode(halted(), close(4010));

      expect(effects).toEqual([]);
      expect(state.connection).toBe('disconnected');
      expect(state.haltedTooLarge).toBe(true);
    });
  });

  describe('a close with any other code resets the count (R23.13)', () => {
    it('does not end the episode for the sequence 1009, 1006, 1009, 1009', () => {
      // The 1006 is the failed reconnect attempt between the first two 1009 closes.
      const { state, effects } = run([
        OPEN,
        TOO_LARGE,
        ATTEMPT,
        close(1006),
        ATTEMPT,
        OPEN,
        TOO_LARGE,
        ATTEMPT,
        OPEN,
        TOO_LARGE,
      ]);

      expect(state.connection).toBe('reconnecting');
      expect(state.episodeActive).toBe(true);
      expect(state.haltedTooLarge).toBe(false);
      expect(state.consecutiveTooLarge).toBe(2);
      expect(visible(effects)).toEqual([]);
      expect(kinds(effects)).not.toContain('toast-payload-too-large');
    });

    it.each([1000, 1006, 1011])('resets the count to 0 on a %i close', (code) => {
      const { state } = reduceEpisode(oneBelowLimit(), close(code));

      expect(state.consecutiveTooLarge).toBe(0);
      expect(state.connection).toBe('reconnecting');
    });

    it('resets the count to 0 on a close without a code', () => {
      expect(reduceEpisode(oneBelowLimit(), close()).state.consecutiveTooLarge).toBe(0);
    });

    it.each([4009, 4010, 4004])('resets the count to 0 on a reserved %i close', (code) => {
      const { state, effects } = reduceEpisode(oneBelowLimit(), close(code));

      expect(state.consecutiveTooLarge).toBe(0);
      expect(effects).toEqual([{ kind: 'toast-close-code', code }]);
    });
  });

  describe('connect() and manual disconnect reset the count (R23.13)', () => {
    it('starts again from initialEpisodeState on connect(), which clears count and halt', () => {
      // `connect()` replaces the episode with `initialEpisodeState`; one more 1009
      // close afterwards is a silent drop again.
      const { state, effects } = run([OPEN, TOO_LARGE], initialEpisodeState);

      expect(halted().haltedTooLarge).toBe(true);
      expect(state.consecutiveTooLarge).toBe(1);
      expect(state.connection).toBe('reconnecting');
      expect(visible(effects)).toEqual([]);
    });

    it('resets the count on manual disconnect, so two more 1009 closes do not halt', () => {
      const { state: afterManual } = reduceEpisode(oneBelowLimit(), MANUAL);
      expect(afterManual.consecutiveTooLarge).toBe(0);

      const { state, effects } = run([OPEN, TOO_LARGE, ATTEMPT, OPEN, TOO_LARGE], afterManual);

      expect(state.haltedTooLarge).toBe(false);
      expect(state.consecutiveTooLarge).toBe(2);
      expect(visible(effects)).toEqual([]);
    });

    it('clears the halt on manual disconnect', () => {
      const { state, effects } = reduceEpisode(halted(), MANUAL);

      expect(effects).toEqual([]);
      expect(state).toEqual(initialEpisodeState);
    });

    it('does not count a manual-disconnect as a 1009 close', () => {
      const { state, effects } = run([OPEN, TOO_LARGE, ATTEMPT, OPEN, MANUAL, MANUAL]);

      expect(state.consecutiveTooLarge).toBe(0);
      expect(state.haltedTooLarge).toBe(false);
      expect(effects.filter((effect) => effect.kind === 'toast-payload-too-large')).toEqual([]);
    });
  });

  describe('unchanged behaviour (R23.13)', () => {
    it.each([4009, 4010, 4004])(
      'reports a reserved %i close once with no reconnect and no navigation',
      (code) => {
        const { state, effects } = run([OPEN, close(code)]);

        expect(state.connection).toBe('disconnected');
        expect(state.episodeActive).toBe(false);
        expect(state.gaveUp).toBe(false);
        expect(effects.slice(1)).toEqual([{ kind: 'toast-close-code', code }]);
      },
    );

    it('gives up after 10 attempts with one toast and the navigation to /login', () => {
      const events: ConnectionEvent[] = [OPEN, close(1006)];
      for (let i = 0; i < GIVE_UP_THRESHOLD; i++) {
        events.push(ATTEMPT);
      }
      const { state, effects, steps } = run(events);

      expect(GIVE_UP_THRESHOLD).toBe(10);
      expect(state.connection).toBe('disconnected');
      expect(state.gaveUp).toBe(true);
      expect(state.attempt).toBe(GIVE_UP_THRESHOLD);
      expect(steps[steps.length - 1].effects).toEqual([
        { kind: 'toast-give-up' },
        { kind: 'navigate-login' },
      ]);
      expect(visible(effects)).toEqual([{ kind: 'toast-give-up' }, { kind: 'navigate-login' }]);
    });

    it('gives up on the 10th attempt even when the episode began with a 1009 close', () => {
      const events: ConnectionEvent[] = [OPEN, TOO_LARGE];
      for (let i = 0; i < GIVE_UP_THRESHOLD; i++) {
        events.push(ATTEMPT);
      }
      const { state, effects } = run(events);

      expect(state.gaveUp).toBe(true);
      expect(state.haltedTooLarge).toBe(false);
      expect(visible(effects)).toEqual([{ kind: 'toast-give-up' }, { kind: 'navigate-login' }]);
    });

    it('stays silent for a close after give-up, including a 1006', () => {
      const events: ConnectionEvent[] = [OPEN, close(1006)];
      for (let i = 0; i < GIVE_UP_THRESHOLD; i++) {
        events.push(ATTEMPT);
      }
      const gaveUp = run(events).state;
      const { state, effects } = reduceEpisode(gaveUp, close(1006));

      expect(effects).toEqual([]);
      expect(state.connection).toBe('disconnected');
      expect(state.gaveUp).toBe(true);
    });
  });
});
