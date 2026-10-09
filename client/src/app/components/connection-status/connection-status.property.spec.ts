import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CONNECTION_LABEL, ConnectionState } from '@shared/types';
import { declared, stylesFor } from '../../testing/declared-css';
import {
  WCAG_AA_NON_TEXT_CONTRAST,
  WCAG_AA_TEXT_CONTRAST,
  wcagContrastRatio,
} from '../../testing/contrast';
import { ConnectionStatusComponent } from './connection-status.component';

/**
 * Property 16 — the indicator maps state to colour and label *totally*
 * (R11.4, R11.5, R11.6, R11.7, R11.8, R14.12).
 *
 * `ConnectionStatusComponent` is a pure projection of one input: the state
 * drives `healthy`, `healthy` drives the modifier class, and `label` drives the
 * `title`, the accessible name and the visible text all at once. The property
 * worth proving is therefore not that one state renders correctly but that
 * *every* state does, after *any* history of states — no value falling through
 * to an empty label, and none landing on a chip with no fill declared for it.
 *
 * ## Generators
 *
 * `arbStateSequence` draws 1–50 states from `CONNECTION_STATES`, which is
 * pinned to the whole `ConnectionState` union both at compile time (see
 * `StatesAreTotal`) and at run time (see the totality test below), so the
 * generator cannot silently stop covering a state the union gains. Sequences
 * rather than single states because the component is driven by signals and a
 * stale `computed` would only show up on a *transition*: a run replays its
 * whole sequence through one fixture, asserting every invariant after each
 * step, so repeats (`connected` → `connected`) and round trips
 * (`connected` → `reconnecting` → `connected`) are both exercised.
 * `numRuns: 100`, per R14.12.
 *
 * ## How colour is asserted
 *
 * The client test runner performs no layout and resolves no custom property,
 * so "renders with the healthy green fill" is asserted in three linked hops
 * instead of by reading a pixel:
 *
 *   1. the rendered chip's class list (does it carry the healthy modifier?),
 *   2. the selector that class list selects, read out of the component's
 *      compiled `styles` by `testing/declared-css` — which *throws* when the
 *      selector declares no `background`, so an unstyled state fails rather
 *      than passes quietly,
 *   3. the token that declaration names, resolved through `TOKEN_VALUE` —
 *      which throws on a literal colour or on a token outside the status set.
 *
 * Only then is the resolved colour compared against what the requirement asks
 * for that state, and handed to `testing/contrast` for R11.8.
 *
 * ## Timing
 *
 * R11.4-R11.6 allow 500 ms to reach the new rendering. The component uses no
 * timer and no async pipe: every assertion below runs immediately after the
 * synchronous change-detection pass that follows `setInput`, with no timers
 * advanced, which is strictly stronger than the 500 ms budget.
 *
 * **Validates: Requirements R11.4, R11.5, R11.6, R11.7, R11.8**
 */

// --- The state space, pinned to the union ------------------------------------------

/** Every `ConnectionState`, in the order R11.4-R11.6 introduces them. */
const CONNECTION_STATES = [
  'connected',
  'reconnecting',
  'disconnected',
] as const satisfies readonly ConnectionState[];

type CoveredState = (typeof CONNECTION_STATES)[number];

/**
 * Compile-time totality: this alias only resolves while every member of
 * `ConnectionState` appears in `CONNECTION_STATES`. Add a fourth state to
 * `shared/types.ts` and this file stops type-checking, which is the point —
 * the generator below must never quantify over a strict subset of the union.
 */
type AssertAssignable<T extends U, U> = true;
type StatesAreTotal = AssertAssignable<ConnectionState, CoveredState>;
const STATES_ARE_TOTAL: StatesAreTotal = true;

const arbState: fc.Arbitrary<ConnectionState> = fc.constantFrom(...CONNECTION_STATES);

/** Transition sequences of length 1 through 50 over the three states (R14.12). */
const arbStateSequence: fc.Arbitrary<readonly ConnectionState[]> = fc.array(arbState, {
  minLength: 1,
  maxLength: 50,
  size: 'max',
});

const NUM_RUNS = { numRuns: 100 } as const;

// --- The design tokens, mirrored from client/src/styles.scss -----------------------

/**
 * The four status tokens. Mirrored rather than read, because the test runner
 * resolves no custom property; `pins the declared fills to the status tokens`
 * below keeps the mirror honest about *which* token each part names, and
 * `client/src/styles.scss` carries the same ratios in a comment beside them.
 */
const TOKEN_VALUE: Readonly<Record<string, string>> = {
  '--status-chip-bg': '#ffffff',
  '--status-connected': '#1b7f3b',
  '--status-fault': '#b3261e',
  '--text-on-status': '#ffffff',
};

const BARE_TOKEN_REFERENCE = /^var\(\s*(--[\w-]+)\s*\)$/;

/**
 * The colour a declared value resolves to.
 *
 * @throws Error when the value is not a bare `var(--token)` (a literal colour,
 * or a `var()` carrying a fallback that would smuggle one back in), or names a
 * token outside the status set.
 */
function resolveToken(value: string): string {
  const match = BARE_TOKEN_REFERENCE.exec(value.trim());
  if (match === null) {
    throw new Error(`not a bare design-token reference: "${value}"`);
  }
  const resolved = TOKEN_VALUE[match[1]];
  if (resolved === undefined) {
    throw new Error(`${match[1]} is not one of the status tokens of client/src/styles.scss`);
  }
  return resolved;
}

/** The fill each state is required to render, per R11.4-R11.6. */
function requiredFill(state: ConnectionState): string {
  return state === 'connected'
    ? TOKEN_VALUE['--status-connected']
    : TOKEN_VALUE['--status-fault'];
}

// --- The rendered chip -------------------------------------------------------------

const CHIP = '.connection-status';
const HEALTHY_MODIFIER = 'connection-status--healthy';
/** The two parts that carry the fill colour: the dot and the label pill. */
const FILLED_PARTS = ['dot', 'label'] as const;

interface RenderedChip {
  readonly chip: HTMLElement;
  readonly label: HTMLElement;
  readonly dot: HTMLElement;
}

function queryChip(fixture: ComponentFixture<ConnectionStatusComponent>): RenderedChip {
  const host = fixture.nativeElement as HTMLElement;
  const chip = host.querySelector<HTMLElement>(CHIP);
  const label = host.querySelector<HTMLElement>('.connection-status__label');
  const dot = host.querySelector<HTMLElement>('.connection-status__dot');
  if (chip === null || label === null || dot === null) {
    throw new Error('the indicator rendered no chip, label or dot');
  }
  return { chip, label, dot };
}

/**
 * The fill one part of the *rendered* chip resolves to.
 *
 * The selector is chosen by the class list the component actually put on the
 * chip, not by the state, so a modifier class that failed to track the state
 * surfaces here as the wrong colour rather than being assumed away.
 */
function renderedFill(chip: HTMLElement, part: (typeof FILLED_PARTS)[number]): string {
  const base = `.connection-status__${part}`;
  const selector = chip.classList.contains(HEALTHY_MODIFIER)
    ? `${CHIP}--healthy ${base}`
    : base;
  return resolveToken(declared(ConnectionStatusComponent, selector, 'background'));
}

describe('Property 16: the connection indicator maps every state to a colour and a label', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ConnectionStatusComponent] });
  });

  /** Renders the indicator, then replays `states` through it one at a time. */
  function replay(
    states: readonly ConnectionState[],
    assertAfterEachState: (
      state: ConnectionState,
      fixture: ComponentFixture<ConnectionStatusComponent>,
    ) => void,
  ): void {
    const fixture = TestBed.createComponent(ConnectionStatusComponent);
    try {
      for (const state of states) {
        fixture.componentRef.setInput('state', state);
        fixture.detectChanges();
        assertAfterEachState(state, fixture);
      }
    } finally {
      fixture.destroy();
    }
  }

  // --- Totality of the state space and the label table ---------------------------

  it('quantifies over every ConnectionState, with a non-empty distinct label each', () => {
    expect(STATES_ARE_TOTAL).toBe(true);

    // Run-time half of the totality claim: the generator's state list and the
    // label table agree, so neither can gain a member the other misses.
    expect([...CONNECTION_STATES].sort()).toEqual(Object.keys(CONNECTION_LABEL).sort());

    for (const state of CONNECTION_STATES) {
      const label = CONNECTION_LABEL[state];
      expect(label, `${state} has no label`).toBeTypeOf('string');
      expect(label.trim(), `${state} maps to a blank label`).not.toBe('');
    }

    // Distinct labels, or two states would be indistinguishable by text (R11.7).
    const labels = CONNECTION_STATES.map(state => CONNECTION_LABEL[state]);
    expect(new Set(labels).size).toBe(CONNECTION_STATES.length);

    // The exact strings R11.4-R11.6 name.
    expect(CONNECTION_LABEL.connected).toBe('Connected');
    expect(CONNECTION_LABEL.reconnecting).toBe('Trying to restore connection');
    expect(CONNECTION_LABEL.disconnected).toBe('Disconnected');
  });

  // --- Invariant 1: healthy is exactly `connected` (R11.4, R11.5, R11.6) ----------

  it('derives healthy, and the modifier class, as exactly state === connected', () => {
    fc.assert(
      fc.property(arbStateSequence, states => {
        replay(states, (state, fixture) => {
          const expectedHealthy = state === 'connected';
          const { chip } = queryChip(fixture);

          expect(
            fixture.componentInstance.healthy(),
            `healthy() is wrong after ${state}`,
          ).toBe(expectedHealthy);

          expect(
            chip.classList.contains(HEALTHY_MODIFIER),
            `the healthy modifier class is wrong after ${state}`,
          ).toBe(expectedHealthy);
        });
      }),
      NUM_RUNS,
    );
  });

  // --- Invariant 2: one label text, in all three channels (R11.4-R11.7) ----------

  it('renders title, accessible name and visible text all equal to the state label', () => {
    fc.assert(
      fc.property(arbStateSequence, states => {
        replay(states, (state, fixture) => {
          const expectedLabel = CONNECTION_LABEL[state];
          const { chip, label } = queryChip(fixture);

          const title = chip.getAttribute('title');
          const ariaLabel = chip.getAttribute('aria-label');
          const visible = label.textContent?.trim() ?? '';

          expect(title, `title is wrong after ${state}`).toBe(expectedLabel);
          expect(ariaLabel, `aria-label is wrong after ${state}`).toBe(expectedLabel);
          expect(visible, `visible label is wrong after ${state}`).toBe(expectedLabel);

          // R11.7: the visible channel carries the same text as the title, so
          // the state is never conveyed by colour alone — and never blank.
          expect(visible).toBe(title);
          expect(visible).toBe(ariaLabel);
          expect(visible.length).toBeGreaterThan(0);

          expect(
            fixture.componentInstance.label(),
            `label() is wrong after ${state}`,
          ).toBe(expectedLabel);
        });
      }),
      NUM_RUNS,
    );
  });

  // --- Invariant 3: a declared, tokened fill for every state (R11.4-R11.6) -------

  it('resolves both filled parts to the green token when connected and the red token otherwise', () => {
    fc.assert(
      fc.property(arbStateSequence, states => {
        replay(states, (state, fixture) => {
          const { chip } = queryChip(fixture);
          const expectedFill = requiredFill(state);

          for (const part of FILLED_PARTS) {
            // Throws — and so fails the property — if this state's selector
            // declares no background, or declares a non-token colour.
            expect(
              renderedFill(chip, part),
              `the ${part} fill is wrong after ${state}`,
            ).toBe(expectedFill);
          }
        });
      }),
      NUM_RUNS,
    );
  });

  // --- Invariant 4: the chip stays readable in every state (R11.8) ----------------

  it('keeps every state at 3:1 fill-on-chip and 4.5:1 label-on-fill', () => {
    const chipSurface = resolveToken(declared(ConnectionStatusComponent, CHIP, 'background'));
    const labelColour = resolveToken(
      declared(ConnectionStatusComponent, '.connection-status__label', 'color'),
    );

    fc.assert(
      fc.property(arbStateSequence, states => {
        replay(states, (state, fixture) => {
          const { chip } = queryChip(fixture);

          for (const part of FILLED_PARTS) {
            const fill = renderedFill(chip, part);

            const fillRatio = wcagContrastRatio(fill, chipSurface);
            expect(
              fillRatio,
              `the ${part} fill after ${state} is ${fillRatio.toFixed(2)}:1 on the chip surface`,
            ).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_CONTRAST);
          }

          const textRatio = wcagContrastRatio(labelColour, renderedFill(chip, 'label'));
          expect(
            textRatio,
            `the label text after ${state} is ${textRatio.toFixed(2)}:1 on its fill`,
          ).toBeGreaterThanOrEqual(WCAG_AA_TEXT_CONTRAST);
        });
      }),
      NUM_RUNS,
    );
  });

  // --- Invariant 5: the semantics the channels hang off ---------------------------

  it('keeps the chip a role=status region with an aria-hidden dot in every state', () => {
    fc.assert(
      fc.property(arbStateSequence, states => {
        replay(states, (state, fixture) => {
          const { chip, dot } = queryChip(fixture);

          expect(chip.getAttribute('role'), `role changed after ${state}`).toBe('status');
          // The dot repeats the label's information in colour only, so it must
          // stay out of the accessible name (R11.7).
          expect(dot.getAttribute('aria-hidden'), `the dot is exposed after ${state}`).toBe(
            'true',
          );
        });
      }),
      NUM_RUNS,
    );
  });

  // --- The pin behind the mirrored token table ------------------------------------

  it('pins the declared fills to the status tokens the table mirrors', () => {
    // The token *values* above are a mirror of client/src/styles.scss; these
    // assertions pin which token each part names, so a stylesheet edit that
    // repainted the chip with a different (or literal) colour would fail here
    // instead of leaving the invariants above measuring a stale pair.
    expect(stylesFor(ConnectionStatusComponent, CHIP).get('background')).toBe(
      'var(--status-chip-bg)',
    );
    for (const part of FILLED_PARTS) {
      expect(
        stylesFor(ConnectionStatusComponent, `.connection-status__${part}`).get('background'),
        `the ${part} base fill`,
      ).toBe('var(--status-fault)');
      expect(
        stylesFor(
          ConnectionStatusComponent,
          `${CHIP}--healthy .connection-status__${part}`,
        ).get('background'),
        `the ${part} healthy fill`,
      ).toBe('var(--status-connected)');
    }
    expect(
      stylesFor(ConnectionStatusComponent, '.connection-status__label').get('color'),
    ).toBe('var(--text-on-status)');
  });
});
