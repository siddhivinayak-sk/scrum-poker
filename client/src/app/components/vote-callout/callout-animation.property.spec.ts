/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import {
  ANIMATION_BUDGET,
  AnimationBudget,
  ENTRANCE_MS,
  ExitCause,
  INITIAL_LIFECYCLE_STATE,
  LifecycleEffect,
  LifecycleEvent,
  LifecycleState,
  STAGGER_MAX_MS,
  STAGGER_MIN_MS,
  STAGGER_WINDOW_MS,
  computeStagger,
  reduceCalloutLifecycle,
} from './callout-animation';

/**
 * Property tests for the pure callout lifecycle reducer.
 *
 * This file is shared by the animation properties (10, 11, 17, 18, 19, 12, 13); each
 * property lives in its own `describe` block below.
 */

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Every exit cause the layer can derive from existing signals (design §7.6). */
const ALL_EXIT_CAUSES: readonly ExitCause[] = [
  'round-started',
  'board-cleared',
  'revote',
  'left-revealed',
  'dismissed',
  'suppressed',
  'fun-callouts-off',
];

const exitCauseArb: fc.Arbitrary<ExitCause> = fc.constantFrom(...ALL_EXIT_CAUSES);

const showEventArb: fc.Arbitrary<LifecycleEvent> = fc.record({
  kind: fc.constant('show' as const),
  reducedMotion: fc.boolean(),
  budgetHeld: fc.integer({ min: 0, max: 24 }),
});

const entranceEndArb: fc.Arbitrary<LifecycleEvent> = fc.constant({ kind: 'entrance-end' as const });
const exitTriggerArb: fc.Arbitrary<LifecycleEvent> = exitCauseArb.map((cause) => ({
  kind: 'exit-trigger' as const,
  cause,
}));
const exitEndArb: fc.Arbitrary<LifecycleEvent> = fc.constant({ kind: 'exit-end' as const });
const exitDeadlineArb: fc.Arbitrary<LifecycleEvent> = fc.constant({
  kind: 'exit-deadline' as const,
});

/**
 * Any lifecycle event, including `show`. Shared by the other reducer properties in this file.
 */
export const lifecycleEventArb: fc.Arbitrary<LifecycleEvent> = fc.oneof(
  showEventArb,
  entranceEndArb,
  exitTriggerArb,
  exitEndArb,
  exitDeadlineArb
);

/** Any event that does not start a new show cycle; keeps one cycle per generated run. */
const nonShowEventArb: fc.Arbitrary<LifecycleEvent> = fc.oneof(
  entranceEndArb,
  exitTriggerArb,
  exitEndArb,
  exitDeadlineArb
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunResult {
  readonly state: LifecycleState;
  readonly effects: LifecycleEffect[];
}

function run(initial: LifecycleState, events: readonly LifecycleEvent[]): RunResult {
  let state = initial;
  const effects: LifecycleEffect[] = [];
  for (const event of events) {
    const result = reduceCalloutLifecycle(state, event);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

const isVisible = (state: LifecycleState): boolean => state.phase !== 'removed';

const countEffects = (effects: readonly LifecycleEffect[], kind: LifecycleEffect['kind']): number =>
  effects.filter((effect) => effect.kind === kind).length;

// ---------------------------------------------------------------------------
// Property 10: Exit totality
// ---------------------------------------------------------------------------

describe('callout lifecycle reducer', () => {
  // Feature: vote-reveal-fun-callouts, Property 10: Exit totality
  describe('Property 10: Exit totality', () => {
    /**
     * **Validates: Requirements 5.6, 5.8, 5.9, 6.9, 11.15**
     */
    it('every exit cause drives a visible callout to removed, whatever happened before it', () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.integer({ min: 0, max: 24 }),
          fc.array(nonShowEventArb, { maxLength: 12 }),
          exitCauseArb,
          fc.constantFrom<LifecycleEvent>({ kind: 'exit-end' }, { kind: 'exit-deadline' }),
          (reducedMotion, budgetHeld, prefix, cause, completion) => {
            const shown = reduceCalloutLifecycle(INITIAL_LIFECYCLE_STATE, {
              kind: 'show',
              reducedMotion,
              budgetHeld,
            });
            const afterPrefix = run(shown.state, prefix);

            // Exit trigger for the cause, then the exit completes (animationend or deadline).
            const exited = run(afterPrefix.state, [{ kind: 'exit-trigger', cause }, completion]);

            const allEffects = [...afterPrefix.effects, ...exited.effects];

            // The callout is gone and no element is left in the document.
            expect(exited.state.phase).toBe('removed');
            // Removal is exactly once across the whole run and its budget share is returned.
            expect(countEffects(allEffects, 'remove')).toBe(1);
            expect(countEffects(allEffects, 'release-budget')).toBe(1);
            expect(exited.state.removalCount).toBe(1);
            expect(exited.state.budgetHeld).toBe(0);
          }
        ),
        { numRuns: 200 }
      );
    });

    /**
     * **Validates: Requirements 5.6, 5.8, 5.9, 6.9, 11.15**
     */
    it('an exit trigger on a visible callout always starts an exit that arms the removal deadline', () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.array(nonShowEventArb, { maxLength: 12 }),
          exitCauseArb,
          (reducedMotion, prefix, cause) => {
            const shown = reduceCalloutLifecycle(INITIAL_LIFECYCLE_STATE, {
              kind: 'show',
              reducedMotion,
            });
            const before = run(shown.state, prefix);
            fc.pre(isVisible(before.state));

            const result = reduceCalloutLifecycle(before.state, { kind: 'exit-trigger', cause });

            // A visible callout is never left in a non-exiting visible phase after a trigger.
            expect(result.state.phase).toBe('exiting');
            if (before.state.phase !== 'exiting') {
              expect(result.effects).toContainEqual({ kind: 'arm-exit-deadline', ms: 700 });
            }
            // An exit never starts the idle loop.
            expect(countEffects(result.effects, 'start-idle')).toBe(0);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  // Feature: vote-reveal-fun-callouts, Property 11: Exit idempotence
  describe('Property 11: Exit idempotence', () => {
    /**
     * **Validates: Requirements 5.10**
     */
    it('two or more exit triggers produce exactly one remove and one release-budget', () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.integer({ min: 0, max: 24 }),
          fc.array(nonShowEventArb, { maxLength: 8 }),
          exitCauseArb,
          fc.array(nonShowEventArb, { maxLength: 8 }),
          exitCauseArb,
          fc.array(nonShowEventArb, { maxLength: 8 }),
          fc.constantFrom<LifecycleEvent>({ kind: 'exit-end' }, { kind: 'exit-deadline' }),
          (reducedMotion, budgetHeld, before, firstCause, between, secondCause, after, completion) => {
            const shown = reduceCalloutLifecycle(INITIAL_LIFECYCLE_STATE, {
              kind: 'show',
              reducedMotion,
              budgetHeld,
            });

            // At least two exit triggers, arbitrary non-show events around them, and a
            // final completion so the exit is guaranteed to have finished.
            const events: LifecycleEvent[] = [
              ...before,
              { kind: 'exit-trigger', cause: firstCause },
              ...between,
              { kind: 'exit-trigger', cause: secondCause },
              ...after,
              completion,
            ];
            const result = run(shown.state, events);

            expect(result.state.phase).toBe('removed');
            expect(countEffects(result.effects, 'remove')).toBe(1);
            expect(countEffects(result.effects, 'release-budget')).toBe(1);
            expect(result.state.removalCount).toBe(1);
            // The single release returns the whole share the callout held.
            const released = result.effects.find((effect) => effect.kind === 'release-budget');
            expect(released).toEqual({ kind: 'release-budget', count: budgetHeld });
            expect(result.state.budgetHeld).toBe(0);
          }
        ),
        { numRuns: 200 }
      );
    });

    /**
     * **Validates: Requirements 5.10**
     */
    it('a second exit trigger while exiting changes nothing and emits no effects', () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.array(nonShowEventArb, { maxLength: 8 }),
          exitCauseArb,
          exitCauseArb,
          (reducedMotion, prefix, firstCause, secondCause) => {
            const shown = reduceCalloutLifecycle(INITIAL_LIFECYCLE_STATE, {
              kind: 'show',
              reducedMotion,
            });
            const before = run(shown.state, prefix);
            fc.pre(isVisible(before.state));

            const first = reduceCalloutLifecycle(before.state, {
              kind: 'exit-trigger',
              cause: firstCause,
            });
            const second = reduceCalloutLifecycle(first.state, {
              kind: 'exit-trigger',
              cause: secondCause,
            });

            expect(first.state.phase).toBe('exiting');
            expect(second.state).toEqual(first.state);
            expect(second.effects).toEqual([]);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  // Feature: vote-reveal-fun-callouts, Property 17: Entrance-to-idle handoff termination
  describe('Property 17: Entrance-to-idle handoff termination', () => {
    /** Events that cannot move an idle callout: none of them is an exit trigger or a show. */
    const idleNoOpEventArb: fc.Arbitrary<LifecycleEvent> = fc.oneof(
      entranceEndArb,
      exitEndArb,
      exitDeadlineArb
    );

    /**
     * **Validates: Requirements 5.8, 5.15**
     */
    it('an entrance that completes without an exit trigger reaches idle and starts the idle loop unless reduced motion', () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.integer({ min: 0, max: 24 }),
          fc.array(idleNoOpEventArb, { maxLength: 8 }),
          (reducedMotion, budgetHeld, afterwards) => {
            const shown = reduceCalloutLifecycle(INITIAL_LIFECYCLE_STATE, {
              kind: 'show',
              reducedMotion,
              budgetHeld,
            });
            expect(shown.state.phase).toBe('entering');

            const entered = reduceCalloutLifecycle(shown.state, { kind: 'entrance-end' });
            expect(entered.state.phase).toBe('idle');
            expect(entered.effects).toEqual(reducedMotion ? [] : [{ kind: 'start-idle' }]);

            // Stray completion events leave the idle callout alone: still idle, no removal.
            const settled = run(entered.state, afterwards);
            expect(settled.state).toEqual(entered.state);
            expect(settled.effects).toEqual([]);
          }
        ),
        { numRuns: 200 }
      );
    });

    /**
     * **Validates: Requirements 5.8, 5.15**
     */
    it('any exit trigger after the handoff still removes the callout exactly once', () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.integer({ min: 0, max: 24 }),
          fc.array(idleNoOpEventArb, { maxLength: 8 }),
          exitCauseArb,
          fc.array(nonShowEventArb, { maxLength: 8 }),
          fc.constantFrom<LifecycleEvent>({ kind: 'exit-end' }, { kind: 'exit-deadline' }),
          (reducedMotion, budgetHeld, afterwards, cause, tail, completion) => {
            const events: LifecycleEvent[] = [
              { kind: 'show', reducedMotion, budgetHeld },
              { kind: 'entrance-end' },
              ...afterwards,
              { kind: 'exit-trigger', cause },
              ...tail,
              completion,
            ];
            const result = run(INITIAL_LIFECYCLE_STATE, events);

            expect(result.state.phase).toBe('removed');
            expect(countEffects(result.effects, 'remove')).toBe(1);
            expect(countEffects(result.effects, 'release-budget')).toBe(1);
            expect(result.state.removalCount).toBe(1);
            expect(result.state.budgetHeld).toBe(0);
            // The idle loop started at most once, and only outside reduced motion.
            expect(countEffects(result.effects, 'start-idle')).toBe(reducedMotion ? 0 : 1);
            // The transform is only captured for exits during the entrance, never after handoff.
            expect(countEffects(result.effects, 'capture-transform')).toBe(0);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  // Feature: vote-reveal-fun-callouts, Property 18: Exit-during-entrance cancellation
  describe('Property 18: Exit-during-entrance cancellation', () => {
    /** Events that cannot move an entering callout: no exit trigger, no entrance-end, no show. */
    const enteringNoOpEventArb: fc.Arbitrary<LifecycleEvent> = fc.oneof(exitEndArb, exitDeadlineArb);

    /**
     * **Validates: Requirements 5.8, 5.16**
     */
    it('an exit trigger during the entrance captures the transform, never starts idle, and removes exactly once', () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.integer({ min: 0, max: 24 }),
          fc.array(enteringNoOpEventArb, { maxLength: 6 }),
          exitCauseArb,
          fc.array(nonShowEventArb, { maxLength: 8 }),
          fc.constantFrom<LifecycleEvent>({ kind: 'exit-end' }, { kind: 'exit-deadline' }),
          (reducedMotion, budgetHeld, beforeExit, cause, tail, completion) => {
            const shown = reduceCalloutLifecycle(INITIAL_LIFECYCLE_STATE, {
              kind: 'show',
              reducedMotion,
              budgetHeld,
            });
            expect(shown.state.phase).toBe('entering');

            // Stray events do not end the entrance; the callout is still entering at the trigger.
            const stillEntering = run(shown.state, beforeExit);
            expect(stillEntering.state.phase).toBe('entering');

            const trigger = reduceCalloutLifecycle(stillEntering.state, {
              kind: 'exit-trigger',
              cause,
            });
            // Straight from entering to exiting, capturing the held transform, never idle.
            expect(trigger.state.phase).toBe('exiting');
            expect(countEffects(trigger.effects, 'capture-transform')).toBe(1);
            expect(trigger.effects).toContainEqual({ kind: 'arm-exit-deadline', ms: 700 });
            expect(countEffects(trigger.effects, 'start-idle')).toBe(0);

            // Whatever follows (further events, then a completion), removal happens exactly once.
            const finished = run(trigger.state, [...tail, completion]);
            const allEffects = [
              ...shown.effects,
              ...stillEntering.effects,
              ...trigger.effects,
              ...finished.effects,
            ];

            expect(finished.state.phase).toBe('removed');
            expect(countEffects(allEffects, 'start-idle')).toBe(0);
            expect(countEffects(allEffects, 'capture-transform')).toBe(1);
            expect(countEffects(allEffects, 'remove')).toBe(1);
            expect(countEffects(allEffects, 'release-budget')).toBe(1);
            expect(finished.state.removalCount).toBe(1);
            expect(finished.state.budgetHeld).toBe(0);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  // Feature: vote-reveal-fun-callouts, Property 19: Exit removal deadline
  describe('Property 19: Exit removal deadline', () => {
    /** Events that never report exit completion: no `exit-end`, no `exit-deadline`, no `show`. */
    const noCompletionEventArb: fc.Arbitrary<LifecycleEvent> = fc.oneof(
      entranceEndArb,
      exitTriggerArb
    );

    /**
     * **Validates: Requirements 5.17**
     */
    it('with no exit-end, the exit trigger arms the 700 ms deadline and exit-deadline removes exactly once and releases the budget share', () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.integer({ min: 0, max: 24 }),
          fc.array(entranceEndArb, { maxLength: 4 }),
          exitCauseArb,
          fc.array(noCompletionEventArb, { maxLength: 8 }),
          (reducedMotion, budgetHeld, before, cause, between) => {
            const shown = reduceCalloutLifecycle(INITIAL_LIFECYCLE_STATE, {
              kind: 'show',
              reducedMotion,
              budgetHeld,
            });
            const beforeExit = run(shown.state, before);
            // The callout is still on screen when the trigger arrives (nothing completed it).
            expect(isVisible(beforeExit.state)).toBe(true);

            const trigger = reduceCalloutLifecycle(beforeExit.state, {
              kind: 'exit-trigger',
              cause,
            });
            expect(trigger.state.phase).toBe('exiting');
            // The deadline is armed with the 700 ms budget measured from the exit trigger.
            expect(trigger.effects).toContainEqual({ kind: 'arm-exit-deadline', ms: 700 });

            // No exit-end ever arrives; only further non-completion events precede the deadline.
            const waiting = run(trigger.state, between);
            expect(waiting.state.phase).toBe('exiting');
            expect(countEffects(waiting.effects, 'remove')).toBe(0);

            const expired = reduceCalloutLifecycle(waiting.state, { kind: 'exit-deadline' });
            const allEffects = [
              ...shown.effects,
              ...beforeExit.effects,
              ...trigger.effects,
              ...waiting.effects,
              ...expired.effects,
            ];

            // The element is removed exactly once and the whole budget share is returned.
            expect(expired.state.phase).toBe('removed');
            expect(expired.state.removalCount).toBe(1);
            expect(expired.state.budgetHeld).toBe(0);
            expect(countEffects(expired.effects, 'remove')).toBe(1);
            expect(countEffects(allEffects, 'remove')).toBe(1);
            expect(countEffects(allEffects, 'release-budget')).toBe(1);
            expect(expired.effects).toContainEqual({ kind: 'release-budget', count: budgetHeld });
          }
        ),
        { numRuns: 200 }
      );
    });

    /**
     * **Validates: Requirements 5.17**
     */
    it('a late exit-end or repeated deadline after the deadline removal changes nothing', () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.integer({ min: 0, max: 24 }),
          exitCauseArb,
          fc.array(nonShowEventArb, { maxLength: 8 }),
          (reducedMotion, budgetHeld, cause, late) => {
            const expired = run(INITIAL_LIFECYCLE_STATE, [
              { kind: 'show', reducedMotion, budgetHeld },
              { kind: 'exit-trigger', cause },
              { kind: 'exit-deadline' },
            ]);
            expect(expired.state.phase).toBe('removed');

            const afterwards = run(expired.state, late);
            expect(afterwards.state).toEqual(expired.state);
            expect(afterwards.effects).toEqual([]);
          }
        ),
        { numRuns: 200 }
      );
    });
  });

  // Feature: vote-reveal-fun-callouts, Property 12: Reduced-motion safety
  describe('Property 12: Reduced-motion safety', () => {
    // ----- Stylesheet parsing (plain text, no SCSS toolchain) -----

    interface CssBlock {
      readonly header: string;
      readonly body: string;
    }

    const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

    /** Splits `css` into its top-level `header { body }` blocks, honouring nested braces. */
    function topLevelBlocks(css: string): CssBlock[] {
      const blocks: CssBlock[] = [];
      let depth = 0;
      let headerStart = 0;
      let bodyStart = -1;
      for (let i = 0; i < css.length; i++) {
        const ch = css[i];
        if (ch === '{') {
          if (depth === 0) bodyStart = i + 1;
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0) {
            blocks.push({
              header: css.slice(headerStart, bodyStart - 1).trim(),
              body: css.slice(bodyStart, i),
            });
            headerStart = i + 1;
          }
        }
      }
      return blocks;
    }

    interface Declaration {
      readonly selector: string;
      readonly property: string;
      readonly value: string;
    }

    function declarationsOf(selector: string, body: string): Declaration[] {
      return body
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.includes(':'))
        .map((part) => {
          const idx = part.indexOf(':');
          return {
            selector,
            property: part.slice(0, idx).trim().toLowerCase(),
            value: part.slice(idx + 1).trim(),
          };
        });
    }

    const scssPath = join(
      process.cwd(),
      'src',
      'app',
      'components',
      'vote-callout',
      'vote-callout.keyframes.scss'
    );
    const css = stripComments(readFileSync(scssPath, 'utf8'));
    const topBlocks = topLevelBlocks(css);

    /** `@keyframes` name -> the properties set in any of its frames. */
    const keyframeProperties = new Map<string, Set<string>>();
    for (const block of topBlocks) {
      const match = /^@keyframes\s+([\w-]+)$/.exec(block.header);
      if (!match) continue;
      const props = new Set<string>();
      for (const frame of topLevelBlocks(block.body)) {
        for (const decl of declarationsOf(frame.header, frame.body)) props.add(decl.property);
      }
      keyframeProperties.set(match[1], props);
    }

    // Reduced-motion media block: every rule inside it.
    const mediaBlocks = topBlocks.filter((b) =>
      /^@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/.test(b.header)
    );
    const mediaDeclarations: Declaration[] = mediaBlocks.flatMap((media) =>
      topLevelBlocks(media.body).flatMap((rule) => declarationsOf(rule.header, rule.body))
    );

    // `--still` class rules, at the top level.
    const stillDeclarations: Declaration[] = topBlocks
      .filter((b) => b.header.includes('vote-callout-layer--still'))
      .flatMap((rule) => declarationsOf(rule.header, rule.body));

    const reducedDeclarations: Declaration[] = [...mediaDeclarations, ...stillDeclarations];

    const FORBIDDEN_MOTION = /\b(transform|translate|rotate|scale)\b/i;
    const MOTION_PROPERTIES = new Set(['translate', 'rotate', 'scale']);
    const isAnimationOrTransition = (property: string): boolean =>
      property.startsWith('animation') || property.startsWith('transition');

    /** Keyframe names referenced by an `animation` / `animation-name` value. */
    const referencedKeyframes = (value: string): string[] =>
      value.split(/[\s,]+/).filter((token) => keyframeProperties.has(token));

    // ----- Guards against a vacuous pass -----

    it('finds the reduced-motion media block and the --still rules in the stylesheet', () => {
      expect(mediaBlocks).toHaveLength(1);
      expect(mediaDeclarations.length).toBeGreaterThan(0);
      expect(stillDeclarations.length).toBeGreaterThan(0);
      expect(reducedDeclarations.some((d) => d.property === 'animation')).toBe(true);
      expect(reducedDeclarations.some((d) => d.property === 'transform')).toBe(true);
    });

    // ----- Plan: no looping phase -----

    /**
     * **Validates: Requirements 6.1, 6.2, 6.3**
     */
    it('while reducedMotion is true the lifecycle plan never contains start-idle', () => {
      const reducedShowArb: fc.Arbitrary<LifecycleEvent> = fc.record({
        kind: fc.constant('show' as const),
        reducedMotion: fc.constant(true),
        budgetHeld: fc.integer({ min: 0, max: 24 }),
      });
      const eventArb = fc.oneof(
        reducedShowArb,
        entranceEndArb,
        exitTriggerArb,
        exitEndArb,
        exitDeadlineArb
      );

      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 24 }),
          fc.array(eventArb, { maxLength: 24 }),
          (budgetHeld, events) => {
            const all: LifecycleEvent[] = [
              { kind: 'show', reducedMotion: true, budgetHeld },
              ...events,
              // Guarantee the entrance has been given the chance to hand off to idle.
              { kind: 'entrance-end' },
            ];
            let state = INITIAL_LIFECYCLE_STATE;
            for (const event of all) {
              const result = reduceCalloutLifecycle(state, event);
              expect(result.effects.some((e) => e.kind === 'start-idle')).toBe(false);
              if (event.kind === 'show' && state.phase === 'removed') {
                expect(result.state.reducedMotion).toBe(true);
              }
              state = result.state;
              // reducedMotion stays on for the whole cycle: nothing switches it back off.
              if (state.phase !== 'removed') expect(state.reducedMotion).toBe(true);
            }
          }
        ),
        { numRuns: 200 }
      );
    });

    /**
     * Turning funCallouts off is part of Reduced_Motion_Mode by definition, so a callout that
     * started with full motion must never start its idle loop after that exit cause.
     *
     * **Validates: Requirements 6.1, 6.2**
     */
    it('a fun-callouts-off exit switches the callout into reduced motion and never starts idle', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 24 }),
          fc.boolean(),
          fc.array(nonShowEventArb, { maxLength: 12 }),
          (budgetHeld, enterFirst, tail) => {
            const events: LifecycleEvent[] = [
              { kind: 'show', reducedMotion: false, budgetHeld },
              ...(enterFirst ? ([{ kind: 'entrance-end' }] as LifecycleEvent[]) : []),
              { kind: 'exit-trigger', cause: 'fun-callouts-off' },
            ];
            const head = run(INITIAL_LIFECYCLE_STATE, events);
            expect(head.state.phase).toBe('exiting');
            expect(head.state.reducedMotion).toBe(true);

            const rest = run(head.state, tail);
            // Idle can only have been started by the entrance handoff before the exit.
            expect(countEffects(rest.effects, 'start-idle')).toBe(0);
          }
        ),
        { numRuns: 200 }
      );
    });

    // ----- Stylesheet: no transform-family motion in reduced-motion rules -----

    /**
     * **Validates: Requirements 6.1, 6.2, 6.3**
     */
    it('no animation or transition declaration in the reduced-motion and --still rules targets transform, translate, rotate or scale', () => {
      const motionDeclarations = reducedDeclarations.filter((d) =>
        isAnimationOrTransition(d.property)
      );
      expect(motionDeclarations.length).toBeGreaterThan(0);

      fc.assert(
        fc.property(fc.constantFrom(...motionDeclarations), (decl) => {
          // The declaration text itself names no transform-family property.
          expect(decl.value).not.toMatch(FORBIDDEN_MOTION);
          expect(decl.property).not.toMatch(FORBIDDEN_MOTION);
        }),
        { numRuns: 100 }
      );
    });

    /**
     * **Validates: Requirements 6.1, 6.3**
     */
    it('every keyframe a reduced-motion rule can start animates opacity only', () => {
      const referenced = new Set<string>();
      for (const decl of reducedDeclarations) {
        if (decl.property === 'animation' || decl.property === 'animation-name') {
          for (const name of referencedKeyframes(decl.value)) referenced.add(name);
        }
      }
      expect(referenced.size).toBeGreaterThan(0);

      fc.assert(
        fc.property(fc.constantFrom(...referenced), (name) => {
          const props = keyframeProperties.get(name);
          expect(props).toBeDefined();
          expect([...(props as Set<string>)]).toEqual(['opacity']);
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Reduced-motion rules may reset `transform` to `none`, but must never apply motion, and
     * must not introduce the individual transform properties at all. Any `transition` limits
     * itself to opacity.
     *
     * **Validates: Requirements 6.1, 6.3**
     */
    it('reduced-motion rules only reset transform to none and transition nothing but opacity', () => {
      fc.assert(
        fc.property(fc.constantFrom(...reducedDeclarations), (decl) => {
          expect(MOTION_PROPERTIES.has(decl.property)).toBe(false);
          if (decl.property === 'transform') {
            expect(decl.value.replace(/\s*!important\s*$/i, '').trim()).toBe('none');
          }
          if (decl.property.startsWith('transition')) {
            expect(decl.value).toMatch(/\bopacity\b/);
          }
          // Idle is dropped entirely in these rules.
          if (decl.selector.includes('callout--idle') && decl.property === 'animation') {
            expect(decl.value.replace(/\s*!important\s*$/i, '').trim()).toBe('none');
          }
          // The fade duration never exceeds the 150 ms token (R6.1).
          if (isAnimationOrTransition(decl.property)) {
            expect(decl.value).not.toMatch(/\binfinite\b/);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('declares the reduced-motion duration token as at most 150 ms', () => {
      const token = /--callout-reduced-ms\s*:\s*(\d+)ms/.exec(css);
      expect(token).not.toBeNull();
      expect(Number((token as RegExpExecArray)[1])).toBeLessThanOrEqual(150);
    });
  });

  // Feature: vote-reveal-fun-callouts, Property 13: Animation budget
  describe('Property 13: Animation budget', () => {
    type BudgetOp =
      | { readonly kind: 'acquire'; readonly count: number }
      | { readonly kind: 'release'; readonly count: number }
      | { readonly kind: 'layout'; readonly names: readonly string[] };

    /** Participant display names; the real list is capped at 8, a surplus needs more than that. */
    const namesArb = (maxLength: number): fc.Arbitrary<string[]> =>
      fc.array(fc.string({ minLength: 1, maxLength: 12 }), { maxLength });

    const opArb = (maxNames: number): fc.Arbitrary<BudgetOp> =>
      fc.oneof(
        fc.record({ kind: fc.constant('acquire' as const), count: fc.integer({ min: 0, max: 40 }) }),
        fc.record({ kind: fc.constant('release' as const), count: fc.integer({ min: 0, max: 40 }) }),
        fc.record({ kind: fc.constant('layout' as const), names: namesArb(maxNames) })
      );

    /**
     * Mirrors how the layer lays names out: the first `plan(n)` names animate, every later name
     * is marked at-rest (design §7.7).
     */
    function layoutNames(
      budget: AnimationBudget,
      names: readonly string[]
    ): { readonly animatedCount: number; readonly atRest: readonly boolean[] } {
      const animatedCount = budget.plan(names.length);
      return { animatedCount, atRest: names.map((_, index) => index >= animatedCount) };
    }

    /**
     * Runs the operations against a fresh budget, checking the invariants after each step.
     * A small synthetic capacity is used because the real 8-name cap can never reach 24.
     */
    function checkOps(capacity: number, ops: readonly BudgetOp[]): void {
      const budget = new AnimationBudget(capacity);
      expect(budget.capacity).toBe(capacity);
      let model = 0;

      for (const op of ops) {
        if (op.kind === 'acquire') {
          const free = capacity - model;
          const granted = budget.acquire(op.count);
          // Never more than asked, never more than what was free.
          expect(granted).toBe(Math.min(op.count, free));
          model += granted;
        } else if (op.kind === 'release') {
          budget.release(op.count);
          model = Math.max(0, model - op.count);
        } else {
          const before = budget.inFlight;
          const { animatedCount, atRest } = layoutNames(budget, op.names);

          expect(animatedCount).toBe(Math.min(op.names.length, capacity - before));
          expect(animatedCount).toBeLessThanOrEqual(op.names.length);
          // Planning is read-only.
          expect(budget.inFlight).toBe(before);
          // Everything beyond the granted count is at rest; everything within it animates.
          expect(atRest.filter(Boolean)).toHaveLength(op.names.length - animatedCount);
          atRest.forEach((rest, index) => expect(rest).toBe(index >= animatedCount));
          // Animating the planned names on top of what is held never exceeds the capacity.
          expect(before + animatedCount).toBeLessThanOrEqual(capacity);
        }

        expect(budget.inFlight).toBe(model);
        expect(budget.inFlight).toBeGreaterThanOrEqual(0);
        expect(budget.inFlight).toBeLessThanOrEqual(capacity);
      }
    }

    /**
     * **Validates: Requirements 5.12, 5.13**
     */
    it('in-flight never exceeds a small synthetic capacity and every surplus name is marked at rest', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 6 }),
          fc.array(opArb(16), { maxLength: 30 }),
          (capacity, ops) => {
            checkOps(capacity, ops);
          }
        ),
        { numRuns: 200 }
      );
    });

    /**
     * **Validates: Requirements 5.12, 5.13**
     */
    it('in-flight never exceeds the real 24-element budget, including lists longer than 24', () => {
      fc.assert(
        fc.property(fc.array(opArb(40), { maxLength: 30 }), (ops) => {
          checkOps(ANIMATION_BUDGET, ops);
        }),
        { numRuns: 200 }
      );
      expect(new AnimationBudget().capacity).toBe(24);
    });

    /**
     * **Validates: Requirements 5.12, 5.13**
     */
    it('a name list longer than the free budget animates exactly the free count in display order and rests the rest', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 6 }),
          fc.integer({ min: 0, max: 6 }),
          namesArb(20),
          (capacity, heldRequest, names) => {
            const budget = new AnimationBudget(capacity);
            const held = budget.acquire(heldRequest);
            fc.pre(names.length > capacity - held);

            const { animatedCount, atRest } = layoutNames(budget, names);

            expect(animatedCount).toBe(capacity - held);
            expect(atRest.slice(0, animatedCount).every((rest) => !rest)).toBe(true);
            expect(atRest.slice(animatedCount).every((rest) => rest)).toBe(true);
            // The surplus branch was really reached.
            expect(atRest.some(Boolean)).toBe(true);
          }
        ),
        { numRuns: 200 }
      );
    });

    /**
     * Callouts that took a share and then exit hand back exactly that share, so a budget shared
     * by several callouts returns to zero once they are all removed.
     *
     * **Validates: Requirements 5.12**
     */
    it('releasing the share named by each callout\'s release-budget effect returns the budget to zero', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 24 }),
          fc.array(fc.integer({ min: 0, max: 10 }), { minLength: 1, maxLength: 6 }),
          fc.array(exitCauseArb, { minLength: 6, maxLength: 6 }),
          (capacity, requests, causes) => {
            const budget = new AnimationBudget(capacity);
            const callouts = requests.map((requested, index) => {
              const granted = budget.acquire(requested);
              expect(budget.inFlight).toBeLessThanOrEqual(capacity);
              return { granted, cause: causes[index] };
            });

            for (const { granted, cause } of callouts) {
              const result = run(INITIAL_LIFECYCLE_STATE, [
                { kind: 'show', reducedMotion: false, budgetHeld: granted },
                { kind: 'exit-trigger', cause },
                { kind: 'exit-deadline' },
              ]);
              for (const effect of result.effects) {
                if (effect.kind === 'release-budget') budget.release(effect.count);
              }
            }

            expect(budget.inFlight).toBe(0);
          }
        ),
        { numRuns: 200 }
      );
    });

    /**
     * The stagger shares the budget's name counts: it stays inside 40-90 ms, and while the
     * 40 ms floor is not binding the whole sequence fits the 900 ms window.
     *
     * **Validates: Requirements 5.12, 5.13**
     */
    it('computeStagger stays within 40-90 ms and keeps the sequence inside 900 ms for the names that animate', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 100 }), (nameCount) => {
          const stagger = computeStagger(nameCount);
          expect(stagger).toBeGreaterThanOrEqual(STAGGER_MIN_MS);
          expect(stagger).toBeLessThanOrEqual(STAGGER_MAX_MS);
          expect(Number.isInteger(stagger)).toBe(true);
        }),
        { numRuns: 200 }
      );

      const windowSteps = Math.floor((STAGGER_WINDOW_MS - ENTRANCE_MS) / STAGGER_MIN_MS);
      fc.assert(
        fc.property(fc.integer({ min: 0, max: windowSteps + 1 }), (nameCount) => {
          const steps = Math.max(0, nameCount - 1);
          expect(ENTRANCE_MS + steps * computeStagger(nameCount)).toBeLessThanOrEqual(
            STAGGER_WINDOW_MS
          );
        }),
        { numRuns: 100 }
      );
    });
  });
});
