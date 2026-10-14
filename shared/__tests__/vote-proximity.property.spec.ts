import * as fc from 'fast-check';
import {
  CARD_LADDERS,
  SPECIAL_CARDS,
  VOTING_SYSTEMS,
  cardLadderFor,
  cardNumericValue,
} from '../types';
import type { ExtendedCardValue, VotingSystemType } from '../types';
import { FAR_THRESHOLD, NEAR_THRESHOLD, classifyProximity } from '../vote-proximity';
import type { ClassifiedParticipant } from '../vote-proximity';

/**
 * Shared property-test file for the proximity classifier (Properties 1-6).
 * Generators live at module scope so later properties append their own `describe`
 * blocks without redefining them.
 */

// ---------------------------------------------------------------------------
// Module-scope generators
// ---------------------------------------------------------------------------

const VOTING_SYSTEM_IDS: readonly VotingSystemType[] = [
  'fibonacci',
  'modified-fibonacci',
  'power-of-2',
  't-shirt',
];

/** Every distinct card value that exists in any deck, plus the special cards. */
const ALL_CARD_KINDS: readonly ExtendedCardValue[] = Array.from(
  new Set<ExtendedCardValue>([
    ...VOTING_SYSTEMS.fibonacci,
    ...VOTING_SYSTEMS['modified-fibonacci'],
    ...VOTING_SYSTEMS['power-of-2'],
    ...VOTING_SYSTEMS['t-shirt'],
    ...SPECIAL_CARDS,
  ])
);

/** One of the four voting systems. */
const votingSystemArb: fc.Arbitrary<VotingSystemType> = fc.constantFrom(...VOTING_SYSTEM_IDS);

/** A selection value: any card kind (numeric, half, special, t-shirt, cross-deck) or no selection. */
const selectionValueArb: fc.Arbitrary<ExtendedCardValue | null | undefined> = fc.oneof(
  { arbitrary: fc.constantFrom(...ALL_CARD_KINDS), weight: 8 },
  { arbitrary: fc.constant(null), weight: 1 },
  { arbitrary: fc.constant(undefined), weight: 1 }
);

/** A selection value drawn only from the cards of one system (so many participants are classifiable). */
function systemSelectionValueArb(
  system: VotingSystemType
): fc.Arbitrary<ExtendedCardValue | null | undefined> {
  return fc.oneof(
    { arbitrary: fc.constantFrom(...VOTING_SYSTEMS[system]), weight: 6 },
    { arbitrary: selectionValueArb, weight: 2 }
  );
}

/** Round input shape shared by every classifier property. */
interface ProximityScenario {
  readonly selections: Map<string, ExtendedCardValue | null | undefined>;
  readonly displayNames: Map<string, string>;
}

/**
 * Selection maps over all card kinds for the given system; 0..100 participants with unique ids and
 * display names that may collide (so name-based tie-breaks are exercised).
 */
function scenarioArb(system: VotingSystemType): fc.Arbitrary<ProximityScenario> {
  return fc
    .uniqueArray(fc.stringMatching(/^[a-z0-9]{1,6}$/), { minLength: 0, maxLength: 100 })
    .chain((userIds) =>
      fc.tuple(
        fc.array(systemSelectionValueArb(system), {
          minLength: userIds.length,
          maxLength: userIds.length,
        }),
        fc.array(fc.constantFrom('Ann', 'ann', 'Bob', 'Cy', 'Dee', 'dee', 'Eve'), {
          minLength: userIds.length,
          maxLength: userIds.length,
        })
      ).map(([values, names]) => {
        const selections = new Map<string, ExtendedCardValue | null | undefined>();
        const displayNames = new Map<string, string>();
        userIds.forEach((id, i) => {
          selections.set(id, values[i]);
          displayNames.set(id, names[i]);
        });
        return { selections, displayNames };
      })
    );
}

/** Numeric positions on a ladder: below min, above max, exactly on each entry, or between entries. */
function ladderAverageArb(system: VotingSystemType): fc.Arbitrary<number> {
  const ladder = cardLadderFor(system);
  const values = ladder
    .map((card) => cardNumericValue(card))
    .filter((v): v is number => v !== undefined);

  if (values.length < 2) {
    return fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true });
  }

  const min = values[0];
  const max = values[values.length - 1];
  const span = max - min;

  const below = fc.double({ min: min - span - 1, max: min, noNaN: true, noDefaultInfinity: true });
  const above = fc.double({ min: max, max: max + span + 1, noNaN: true, noDefaultInfinity: true });
  const exact = fc.constantFrom(...values);
  const between = fc
    .tuple(fc.integer({ min: 0, max: values.length - 2 }), fc.double({ min: 0, max: 1, noNaN: true }))
    .map(([i, t]) => values[i] + t * (values[i + 1] - values[i]));
  // Fractions of a step that land on / around the 0.75 and 2.0 thresholds.
  const boundary = fc
    .tuple(
      fc.integer({ min: 0, max: values.length - 2 }),
      fc.constantFrom(0.25, 0.5, 0.75, 0.999999, 0.000001)
    )
    .map(([i, t]) => values[i] + t * (values[i + 1] - values[i]));

  return fc.oneof(below, above, exact, between, boundary);
}

/** A (system, scenario, average) triple with the average generated against that system's ladder. */
const proximityCaseArb: fc.Arbitrary<{
  system: VotingSystemType;
  scenario: ProximityScenario;
  average: number;
}> = votingSystemArb.chain((system) =>
  fc
    .tuple(scenarioArb(system), ladderAverageArb(system))
    .map(([scenario, average]) => ({ system, scenario, average }))
);

/** Averages that are not usable finite numbers (and a few that are not numbers at all). */
const averageArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(NaN),
  fc.constant(Infinity),
  fc.constant(-Infinity),
  fc.constant(null),
  fc.constant(undefined),
  fc.string(),
  fc.object(),
  fc.array(fc.integer()),
  fc.boolean()
);

// Referenced by later properties (3-6) appended to this file.
void CARD_LADDERS;

// ---------------------------------------------------------------------------
// Property 1
// ---------------------------------------------------------------------------

// Feature: vote-reveal-fun-callouts, Property 1: Near and Far sets are disjoint
describe('Property 1: Near and Far sets are disjoint', () => {
  /**
   * **Validates: Requirements 1.1, 1.7, 1.8, 1.9**
   */
  it('no participant appears in both the near and far sets, and each set respects its threshold', () => {
    fc.assert(
      fc.property(proximityCaseArb, ({ system, scenario, average }) => {
        const result = classifyProximity({
          selections: scenario.selections,
          average,
          votingSystem: system,
          displayNames: scenario.displayNames,
        });

        const nearIds = new Set(result.near.map((p) => p.userId));
        const farIds = result.far.map((p) => p.userId);

        // Disjoint
        for (const id of farIds) {
          expect(nearIds.has(id)).toBe(false);
        }
        // No duplicates inside either set
        expect(nearIds.size).toBe(result.near.length);
        expect(new Set(farIds).size).toBe(farIds.length);

        // Thresholds (R1.7, R1.8, R1.9): near <= 0.75, far >= 2.0, so the bands cannot overlap
        for (const p of result.near) {
          expect(p.ladderDistance).toBeLessThanOrEqual(NEAR_THRESHOLD);
        }
        for (const p of result.far) {
          expect(p.ladderDistance).toBeGreaterThanOrEqual(FAR_THRESHOLD);
        }

        // Every classified participant has a recorded distance
        for (const p of [...result.near, ...result.far]) {
          expect(result.distances.get(p.userId)).toBe(p.ladderDistance);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('holds for averages that sit exactly on a ladder entry', () => {
    fc.assert(
      fc.property(
        votingSystemArb.filter((s) => CARD_LADDERS[s].length >= 2).chain((system) =>
          fc.tuple(
            fc.constant(system),
            scenarioArb(system),
            fc.constantFrom(
              ...CARD_LADDERS[system].map((c) => cardNumericValue(c) as number)
            )
          )
        ),
        ([system, scenario, average]) => {
          const result = classifyProximity({
            selections: scenario.selections,
            average,
            votingSystem: system,
            displayNames: scenario.displayNames,
          });
          const nearIds = new Set(result.near.map((p) => p.userId));
          expect(result.far.some((p) => nearIds.has(p.userId))).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2
// ---------------------------------------------------------------------------

// Feature: vote-reveal-fun-callouts, Property 2: Classification soundness
describe('Property 2: Classification soundness', () => {
  /**
   * **Validates: Requirements 1.10, 1.11, 1.12, 15.8, 15.9**
   */
  it('every classified participant cast a selection with a numeric value that is on the active ladder', () => {
    fc.assert(
      fc.property(proximityCaseArb, ({ system, scenario, average }) => {
        const ladder = cardLadderFor(system);
        const result = classifyProximity({
          selections: scenario.selections,
          average,
          votingSystem: system,
          displayNames: scenario.displayNames,
        });

        const classified = [...result.near, ...result.far];
        for (const p of classified) {
          // Present in the input with an actual selection (R1.10)
          expect(scenario.selections.has(p.userId)).toBe(true);
          const card = scenario.selections.get(p.userId);
          expect(card === null || card === undefined).toBe(false);
          // Has a Card_Numeric_Value: no specials or t-shirt sizes (R1.11, R15.8)
          expect(cardNumericValue(card as ExtendedCardValue)).not.toBeUndefined();
          // On the active ladder: no cross-deck cards (R1.12, R15.9)
          expect(ladder).toContain(card);
        }

        // Nothing is classified twice
        expect(new Set(classified.map((p) => p.userId)).size).toBe(classified.length);
      }),
      { numRuns: 100 }
    );
  });

  it('never classifies participants whose only selections are missing, special, t-shirt or cross-deck', () => {
    fc.assert(
      fc.property(
        votingSystemArb.chain((system) => {
          const ladder = cardLadderFor(system);
          const ineligible = ALL_CARD_KINDS.filter(
            (card) => cardNumericValue(card) === undefined || !ladder.includes(card)
          );
          const ineligibleValueArb: fc.Arbitrary<ExtendedCardValue | null | undefined> = fc.oneof(
            fc.constantFrom(...ineligible),
            fc.constant(null),
            fc.constant(undefined)
          );
          return fc.tuple(
            fc.constant(system),
            fc.array(ineligibleValueArb, { minLength: 0, maxLength: 20 }),
            ladderAverageArb(system)
          );
        }),
        ([system, values, average]) => {
          const selections = new Map<string, ExtendedCardValue | null | undefined>();
          const displayNames = new Map<string, string>();
          values.forEach((value, i) => {
            selections.set(`u${i}`, value);
            displayNames.set(`u${i}`, `User ${i}`);
          });

          const result = classifyProximity({
            selections,
            average,
            votingSystem: system,
            displayNames,
          });

          expect(result.near).toHaveLength(0);
          expect(result.far).toHaveLength(0);
          expect(result.distances.size).toBe(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3
// ---------------------------------------------------------------------------

/** Small scenario (0..8 participants) so the suppression checks stay quick. */
const smallScenarioArb: fc.Arbitrary<ProximityScenario> = fc
  .uniqueArray(fc.stringMatching(/^[a-z0-9]{1,4}$/), { minLength: 0, maxLength: 8 })
  .chain((userIds) =>
    fc
      .array(selectionValueArb, { minLength: userIds.length, maxLength: userIds.length })
      .map((values) => {
        const selections = new Map<string, ExtendedCardValue | null | undefined>();
        const displayNames = new Map<string, string>();
        userIds.forEach((id, i) => {
          selections.set(id, values[i]);
          displayNames.set(id, `User ${id}`);
        });
        return { selections, displayNames };
      })
  );

/** A finite average, including values that sit on or between ladder entries. */
const finiteAverageArb: fc.Arbitrary<number> = fc.double({
  min: -1000,
  max: 1000,
  noNaN: true,
  noDefaultInfinity: true,
});

/** Generated strings that are not the identifier of any known voting system. */
const unknownSystemIdArb: fc.Arbitrary<string> = fc
  .oneof(fc.string(), fc.stringMatching(/^[a-z-]{1,20}$/))
  .filter((id) => !VOTING_SYSTEM_IDS.includes(id as VotingSystemType));

/** Asserts the fully-empty result: no near, no far, no distances. */
function expectFullyEmpty(result: ReturnType<typeof classifyProximity>): void {
  expect(result.near).toHaveLength(0);
  expect(result.far).toHaveLength(0);
  expect(result.distances.size).toBe(0);
}

// Feature: vote-reveal-fun-callouts, Property 3: Suppression under insufficient data
describe('Property 3: Suppression under insufficient data', () => {
  /**
   * **Validates: Requirements 1.13, 1.14, 1.19**
   */
  it('returns a fully empty result for a non-finite or non-numeric average, on any system', () => {
    fc.assert(
      fc.property(
        fc.oneof(votingSystemArb, unknownSystemIdArb),
        smallScenarioArb,
        averageArb,
        (system, scenario, average) => {
          const result = classifyProximity({
            selections: scenario.selections,
            average,
            votingSystem: system,
            displayNames: scenario.displayNames,
          });
          expectFullyEmpty(result);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns a fully empty result when the ladder has fewer than two entries', () => {
    const shortLadderSystems = VOTING_SYSTEM_IDS.filter((s) => CARD_LADDERS[s].length < 2);
    // t-shirt has an empty ladder; guard against the set silently becoming empty
    expect(shortLadderSystems.length).toBeGreaterThan(0);

    fc.assert(
      fc.property(
        fc.constantFrom(...shortLadderSystems),
        smallScenarioArb,
        finiteAverageArb,
        (system, scenario, average) => {
          const result = classifyProximity({
            selections: scenario.selections,
            average,
            votingSystem: system,
            displayNames: scenario.displayNames,
          });
          expectFullyEmpty(result);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns a fully empty result for an unknown voting system id, even with a valid average', () => {
    fc.assert(
      fc.property(
        unknownSystemIdArb,
        smallScenarioArb,
        finiteAverageArb,
        (system, scenario, average) => {
          const result = classifyProximity({
            selections: scenario.selections,
            average,
            votingSystem: system,
            displayNames: scenario.displayNames,
          });
          expectFullyEmpty(result);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 4
// ---------------------------------------------------------------------------

/** Small scenario (0..12 participants) drawn mostly from one system's deck so many are classifiable. */
function monotonicityScenarioArb(system: VotingSystemType): fc.Arbitrary<ProximityScenario> {
  return fc
    .uniqueArray(fc.stringMatching(/^[a-z0-9]{1,4}$/), { minLength: 0, maxLength: 12 })
    .chain((userIds) =>
      fc
        .array(systemSelectionValueArb(system), {
          minLength: userIds.length,
          maxLength: userIds.length,
        })
        .map((values) => {
          const selections = new Map<string, ExtendedCardValue | null | undefined>();
          const displayNames = new Map<string, string>();
          userIds.forEach((id, i) => {
            selections.set(id, values[i]);
            displayNames.set(id, `User ${id}`);
          });
          return { selections, displayNames };
        })
    );
}

// Feature: vote-reveal-fun-callouts, Property 4: Distance monotonicity
describe('Property 4: Distance monotonicity', () => {
  /**
   * **Validates: Requirements 1.7, 1.8, 1.9**
   */
  it('near-membership of the farther implies near for the nearer; far-membership of the nearer implies far for the farther', () => {
    fc.assert(
      fc.property(
        votingSystemArb.chain((system) =>
          fc
            .tuple(monotonicityScenarioArb(system), ladderAverageArb(system))
            .map(([scenario, average]) => ({ system, scenario, average }))
        ),
        ({ system, scenario, average }) => {
          const result = classifyProximity({
            selections: scenario.selections,
            average,
            votingSystem: system,
            displayNames: scenario.displayNames,
          });

          const nearIds = new Set(result.near.map((p) => p.userId));
          const farIds = new Set(result.far.map((p) => p.userId));
          const classified = Array.from(result.distances.entries());

          for (const [nearerId, nearerDistance] of classified) {
            for (const [fartherId, fartherDistance] of classified) {
              if (!(nearerDistance < fartherDistance)) continue;
              if (nearIds.has(fartherId)) {
                expect(nearIds.has(nearerId)).toBe(true);
              }
              if (farIds.has(nearerId)) {
                expect(farIds.has(fartherId)).toBe(true);
              }
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5
// ---------------------------------------------------------------------------

/**
 * Small scenario (0..12 participants) drawn mostly from one system's deck. Display names collide
 * on purpose, including case-only differences ('Ann'/'ann'/'ANN'), so every tie-break level
 * (distance, case-insensitive name, userId) is exercised.
 */
function orderingScenarioArb(system: VotingSystemType): fc.Arbitrary<ProximityScenario> {
  return fc
    .uniqueArray(fc.stringMatching(/^[a-z0-9]{1,3}$/), { minLength: 0, maxLength: 12 })
    .chain((userIds) =>
      fc
        .tuple(
          fc.array(systemSelectionValueArb(system), {
            minLength: userIds.length,
            maxLength: userIds.length,
          }),
          fc.array(fc.constantFrom('Ann', 'ann', 'ANN', 'Bob', 'bob', 'Cy'), {
            minLength: userIds.length,
            maxLength: userIds.length,
          })
        )
        .map(([values, names]) => {
          const selections = new Map<string, ExtendedCardValue | null | undefined>();
          const displayNames = new Map<string, string>();
          userIds.forEach((id, i) => {
            selections.set(id, values[i]);
            displayNames.set(id, names[i]);
          });
          return { selections, displayNames };
        })
    );
}

/** Code-unit comparison, mirroring the documented ordering rule (not localeCompare). */
function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Asserts consecutive members are ordered by distance, then lower-cased name, then userId. */
function expectOrdered(
  list: ReadonlyArray<{ userId: string; displayName: string; ladderDistance: number }>
): void {
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    const next = list[i];
    expect(prev.ladderDistance).toBeLessThanOrEqual(next.ladderDistance);
    if (prev.ladderDistance === next.ladderDistance) {
      const byName = codeUnitCompare(prev.displayName.toLowerCase(), next.displayName.toLowerCase());
      expect(byName).toBeLessThanOrEqual(0);
      if (byName === 0) {
        expect(codeUnitCompare(prev.userId, next.userId)).toBeLessThan(0);
      }
    }
  }
}

// Feature: vote-reveal-fun-callouts, Property 5: Near ordering is stable and non-decreasing
describe('Property 5: Near ordering is stable and non-decreasing', () => {
  /**
   * **Validates: Requirements 1.16**
   */
  it('near and far are non-decreasing in distance with ties broken by lower-cased name then userId, and repeat calls agree', () => {
    fc.assert(
      fc.property(
        votingSystemArb.chain((system) =>
          fc
            .tuple(orderingScenarioArb(system), ladderAverageArb(system))
            .map(([scenario, average]) => ({ system, scenario, average }))
        ),
        ({ system, scenario, average }) => {
          const input = {
            selections: scenario.selections,
            average,
            votingSystem: system,
            displayNames: scenario.displayNames,
          };
          const first = classifyProximity(input);
          const second = classifyProximity(input);

          expectOrdered(first.near);
          expectOrdered(first.far);

          // Two calls give the same order
          expect(second.near.map((p) => p.userId)).toEqual(first.near.map((p) => p.userId));
          expect(second.far.map((p) => p.userId)).toEqual(first.far.map((p) => p.userId));
        }
      ),
      { numRuns: 100 }
    );
  });

  it('the order does not depend on the insertion order of the selections', () => {
    fc.assert(
      fc.property(
        votingSystemArb.chain((system) =>
          fc
            .tuple(orderingScenarioArb(system), ladderAverageArb(system))
            .map(([scenario, average]) => ({ system, scenario, average }))
        ),
        ({ system, scenario, average }) => {
          const forward = classifyProximity({
            selections: scenario.selections,
            average,
            votingSystem: system,
            displayNames: scenario.displayNames,
          });
          const reversed = classifyProximity({
            selections: new Map(Array.from(scenario.selections.entries()).reverse()),
            average,
            votingSystem: system,
            displayNames: scenario.displayNames,
          });

          expect(reversed.near.map((p) => p.userId)).toEqual(forward.near.map((p) => p.userId));
          expect(reversed.far.map((p) => p.userId)).toEqual(forward.far.map((p) => p.userId));
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6
// ---------------------------------------------------------------------------

/** Mix of usable ladder positions and unusable averages, so the guarded (empty) paths are covered. */
function purityCaseArb(): fc.Arbitrary<{
  system: VotingSystemType;
  scenario: ProximityScenario;
  average: unknown;
}> {
  return votingSystemArb.chain((system) =>
    fc
      .tuple(
        orderingScenarioArb(system),
        fc.oneof(
          { arbitrary: ladderAverageArb(system) as fc.Arbitrary<unknown>, weight: 8 },
          { arbitrary: averageArb, weight: 1 }
        )
      )
      .map(([scenario, average]) => ({ system, scenario, average }))
  );
}

// Feature: vote-reveal-fun-callouts, Property 6: Classifier purity and idempotence
describe('Property 6: Classifier purity and idempotence', () => {
  /**
   * **Validates: Requirements 1.17**
   */
  it('two calls deep-equal each other and leave the selections and displayNames maps unmodified', () => {
    fc.assert(
      fc.property(purityCaseArb(), ({ system, scenario, average }) => {
        const selectionsBefore = Array.from(scenario.selections.entries());
        const displayNamesBefore = Array.from(scenario.displayNames.entries());

        const input = {
          selections: scenario.selections,
          average,
          votingSystem: system,
          displayNames: scenario.displayNames,
        };
        const first = classifyProximity(input);
        const second = classifyProximity(input);

        // Idempotent: near, far and distances all agree
        expect(second).toEqual(first);
        expect(second.near).toEqual(first.near);
        expect(second.far).toEqual(first.far);
        expect(second.distances).toEqual(first.distances);

        // Inputs untouched: same entries, same order, same size
        expect(Array.from(scenario.selections.entries())).toEqual(selectionsBefore);
        expect(Array.from(scenario.displayNames.entries())).toEqual(displayNamesBefore);
      }),
      { numRuns: 100 }
    );
  });

  it('result arrays are fresh allocations: mutating one result does not affect a later call', () => {
    fc.assert(
      fc.property(purityCaseArb(), ({ system, scenario, average }) => {
        const input = {
          selections: scenario.selections,
          average,
          votingSystem: system,
          displayNames: scenario.displayNames,
        };
        const first = classifyProximity(input);
        const second = classifyProximity(input);

        // Distinct containers per call
        expect(second.near).not.toBe(first.near);
        expect(second.far).not.toBe(first.far);
        expect(second.distances).not.toBe(first.distances);

        // Plain-data snapshot of the expected result, taken before any mutation
        const expectedNear = first.near.map((p) => ({ ...p }));
        const expectedFar = first.far.map((p) => ({ ...p }));
        const expectedDistances = Array.from(first.distances.entries());

        // Vandalise the first result's containers
        (first.near as ClassifiedParticipant[]).length = 0;
        (first.far as ClassifiedParticipant[]).push({
          userId: 'intruder',
          displayName: 'Intruder',
          ladderDistance: 99,
        });
        (first.distances as Map<string, number>).set('intruder', 99);
        (first.distances as Map<string, number>).clear();

        const third = classifyProximity(input);

        expect(third.near).toEqual(expectedNear);
        expect(third.far).toEqual(expectedFar);
        expect(Array.from(third.distances.entries())).toEqual(expectedDistances);
        // The earlier second call's result is also unaffected
        expect(second.near).toEqual(expectedNear);
        expect(second.far).toEqual(expectedFar);
        expect(Array.from(second.distances.entries())).toEqual(expectedDistances);
      }),
      { numRuns: 100 }
    );
  });
});
