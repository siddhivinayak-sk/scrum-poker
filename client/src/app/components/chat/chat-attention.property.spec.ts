import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ATTENTION_DURATION_MS,
  type AttentionEvent,
  type AttentionOutput,
  type AttentionState,
  type ChatPanelState,
  attentionOutput,
  createAttentionState,
  reduceAttention,
} from './chat-attention';

// Feature: session-chat, Property 32: The attention animation follows the Unread_Increase rules

const NUM_RUNS = 300;

// ---------------------------------------------------------------------------
// Independent model, written from the requirement text (R2.13, R24)
// ---------------------------------------------------------------------------

interface ModelState {
  unread: number;
  panelState: ChatPanelState;
  visible: boolean;
  reducedMotion: boolean;
  /** Time of the latest start of a run that has not been stopped, or `null`. */
  lastStart: number | null;
  /** At least one Unread_Increase occurred since the document last became hidden (R24.10). */
  increaseWhileHidden: boolean;
}

/** One generated step; values that depend on the current count are resolved at run time. */
type Action =
  | { kind: 'increase'; by: number }
  | { kind: 'nonIncrease'; seed: number }
  | { kind: 'panelState'; panelState: ChatPanelState }
  | { kind: 'visibility'; visible: boolean }
  | { kind: 'reducedMotion'; reducedMotion: boolean }
  | { kind: 'tick' };

interface Step {
  dt: number;
  action: Action;
}

/** R24.1 / R24.10: the conditions under which a start is allowed at all. */
function modelMayStart(m: ModelState): boolean {
  return m.panelState !== 'open' && m.visible && !m.reducedMotion && m.unread > 0;
}

/** Property 32: running exactly when the conditions hold and < 3,600 ms since the latest start. */
function modelRunning(m: ModelState, now: number): boolean {
  return (
    m.lastStart !== null &&
    now - m.lastStart < ATTENTION_DURATION_MS &&
    m.panelState !== 'open' &&
    m.visible &&
    !m.reducedMotion &&
    m.unread > 0
  );
}

/** Applies one action to the model at time `now`; returns whether a (re)start happened. */
function modelApply(m: ModelState, action: Action, now: number, nextUnread: number): boolean {
  switch (action.kind) {
    case 'increase':
      m.unread = nextUnread;
      if (!m.visible) {
        m.increaseWhileHidden = true;
        return false;
      }
      // R24.1 start / R24.2 restart from the first iteration at each Unread_Increase.
      // R24.4 never while open; R24.7 never under reduced motion.
      if (modelMayStart(m)) {
        m.lastStart = now;
        return true;
      }
      return false;
    case 'nonIncrease':
      // R24.2: a decrease or an unchanged count neither starts nor restarts.
      m.unread = nextUnread;
      if (m.unread === 0) m.lastStart = null; // R24.6
      return false;
    case 'panelState':
      m.panelState = action.panelState;
      // R24.4: open stops. R24.12: closed ↔ minimized continues without restart.
      if (action.panelState === 'open') m.lastStart = null;
      return false;
    case 'visibility': {
      if (action.visible === m.visible) return false;
      m.visible = action.visible;
      if (!action.visible) {
        m.increaseWhileHidden = false; // a new hidden period begins
        return false;
      }
      // R24.10: start exactly once on becoming visible after an increase while hidden.
      const pending = m.increaseWhileHidden;
      m.increaseWhileHidden = false;
      if (pending && modelMayStart(m)) {
        m.lastStart = now;
        return true;
      }
      return false;
    }
    case 'reducedMotion':
      m.reducedMotion = action.reducedMotion;
      if (action.reducedMotion) m.lastStart = null; // R24.7 stops a running animation
      return false;
    case 'tick':
      // R24.1: the run ends after 3,600 ms; `modelRunning` checks elapsed time directly.
      if (m.lastStart !== null && now - m.lastStart >= ATTENTION_DURATION_MS) m.lastStart = null;
      return false;
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const panelStateArb: fc.Arbitrary<ChatPanelState> = fc.constantFrom('closed', 'open', 'minimized');

/** Time deltas weighted around the 3,600 ms boundary; always ≥ 0 so `now` never decreases. */
const dtArb: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.integer({ min: 1, max: 1_000 }),
  fc.integer({ min: 1_000, max: 5_000 }),
  fc.constantFrom(
    ATTENTION_DURATION_MS - 1,
    ATTENTION_DURATION_MS,
    ATTENTION_DURATION_MS + 1,
  ),
);

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 3 }).map((by) => ({ kind: 'increase', by }) as const) },
  { weight: 2, arbitrary: fc.nat().map((seed) => ({ kind: 'nonIncrease', seed }) as const) },
  { weight: 3, arbitrary: panelStateArb.map((panelState) => ({ kind: 'panelState', panelState }) as const) },
  { weight: 3, arbitrary: fc.boolean().map((visible) => ({ kind: 'visibility', visible }) as const) },
  {
    weight: 1,
    arbitrary: fc.boolean().map((reducedMotion) => ({ kind: 'reducedMotion', reducedMotion }) as const),
  },
  { weight: 2, arbitrary: fc.constant({ kind: 'tick' } as const) },
);

const stepsArb: fc.Arbitrary<Step[]> = fc.array(
  fc.record({ dt: dtArb, action: actionArb }),
  { minLength: 1, maxLength: 40 },
);

const initArb = fc.record({
  unread: fc.integer({ min: 0, max: 5 }),
  panelState: panelStateArb,
  visible: fc.boolean(),
  reducedMotion: fc.boolean(),
});

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('chat-attention (Property 32)', () => {
  // **Validates: Requirements 2.13, 24.1, 24.2, 24.4, 24.6, 24.7, 24.10, 24.12**
  it('Property 32: The attention animation follows the Unread_Increase rules', () => {
    fc.assert(
      fc.property(initArb, stepsArb, (init, steps) => {
        let state: AttentionState = createAttentionState(init);
        let output: AttentionOutput = attentionOutput(state);
        const model: ModelState = { ...init, lastStart: null, increaseWhileHidden: false };
        let now = 0;

        expect(output.running).toBe(false);
        expect(output.unreadRing).toBe(init.unread > 0 && init.panelState !== 'open');

        for (const { dt, action } of steps) {
          now += dt;

          // The launcher's timer dispatches tick(endsAt) when a run's 3,600 ms elapse.
          if (output.endsAt !== null && output.endsAt <= now) {
            ({ state, output } = reduceAttention(state, { kind: 'tick', now: output.endsAt }));
          }

          const prevRun = output.attentionRun;
          let nextUnread = model.unread;
          let event: AttentionEvent;
          switch (action.kind) {
            case 'increase':
              nextUnread = model.unread + action.by;
              event = { kind: 'unreadIncrease', unread: nextUnread, now };
              break;
            case 'nonIncrease':
              nextUnread = action.seed % (model.unread + 1); // a decrease or the same value
              event = { kind: 'unread', unread: nextUnread };
              break;
            case 'panelState':
              event = { kind: 'panelState', panelState: action.panelState };
              break;
            case 'visibility':
              event = { kind: 'visibility', visible: action.visible, now };
              break;
            case 'reducedMotion':
              event = { kind: 'reducedMotion', reducedMotion: action.reducedMotion };
              break;
            case 'tick':
              event = { kind: 'tick', now };
              break;
          }

          ({ state, output } = reduceAttention(state, event));
          const modelStarted = modelApply(model, action, now, nextUnread);

          // Running exactly when the model says so (R24.1, R24.2, R24.4, R24.6, R24.7, R24.10).
          expect(output.running).toBe(modelRunning(model, now));

          // A new run key appears exactly when the model starts or restarts (R24.2, R24.10,
          // R24.12: closed ↔ minimized and non-increases never re-key the run).
          const newRun = output.attentionRun !== null && output.attentionRun !== prevRun;
          expect(newRun).toBe(modelStarted);
          if (modelStarted) {
            expect(output.endsAt).toBe(now + ATTENTION_DURATION_MS);
          }
          // While running, the run ends 3,600 ms after the latest start (R24.2).
          if (output.running) {
            expect(output.endsAt).toBe((model.lastStart ?? NaN) + ATTENTION_DURATION_MS);
          }

          // R2.13 / R24.5: the static Unread_Ring.
          expect(output.unreadRing).toBe(model.unread > 0 && model.panelState !== 'open');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
