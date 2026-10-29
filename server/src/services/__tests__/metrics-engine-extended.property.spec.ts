import * as fc from 'fast-check';
import { calculate } from '../metrics-engine';
import {
  ExtendedCardValue,
  SPECIAL_CARDS,
  VOTING_SYSTEMS,
  VotingSystemType,
  cardLadderFor,
  cardNumericValue,
  getCardsForVotingSystem,
  ladderIndexOf,
} from '../../../../shared/types';

// ---------------------------------------------------------------------------
// Shared module-scope generators (used by Properties 25, 26, 28, 29, 30, 31)
// ---------------------------------------------------------------------------

/** The four known voting systems. */
export const VOTING_SYSTEM_IDS = Object.keys(VOTING_SYSTEMS) as VotingSystemType[];

/** Every card of every voting system plus the special cards, de-duplicated. */
export const ALL_EXTENDED_CARDS: ExtendedCardValue[] = Array.from(
  new Set<ExtendedCardValue>([
    ...VOTING_SYSTEM_IDS.flatMap((system) => getCardsForVotingSystem(system)),
    ...SPECIAL_CARDS,
  ])
);

/** Any card the application knows about, in any voting system. */
export const extendedCardArb: fc.Arbitrary<ExtendedCardValue> =
  fc.constantFrom<ExtendedCardValue>(...ALL_EXTENDED_CARDS);

const KNOWN_CARD_KEYS = new Set<string>(ALL_EXTENDED_CARDS.map((card) => String(card)));

/**
 * Card values that belong to no known voting system. They can only reach the
 * engine through corrupted data, so they are cast through `unknown` to the
 * parameter type the engine accepts.
 */
export const foreignCardArb: fc.Arbitrary<ExtendedCardValue> = fc
  .oneof(
    fc.string({ minLength: 1, maxLength: 10 }).map((s) => `foreign-${s}`),
    fc.constantFrom<number>(-1, 0.3, 6, 7, 10, 1000),
    fc.constantFrom<string>('?', 'XXXL', '1/2', 'NaN', 'Infinity')
  )
  .filter((value) => !KNOWN_CARD_KEYS.has(String(value)))
  .map((value) => value as unknown as ExtendedCardValue);

/** Mostly in-deck cards, with occasional foreign ones. */
const cardWithForeignArb: fc.Arbitrary<ExtendedCardValue> = fc.oneof(
  { weight: 9, arbitrary: extendedCardArb },
  { weight: 1, arbitrary: foreignCardArb }
);

const userIdArb = fc.string({ minLength: 1, maxLength: 8 });

/** Up to 50 participants, unique user ids, sized to reach the maximum. */
export function selectionsArb(
  cardArb: fc.Arbitrary<ExtendedCardValue>
): fc.Arbitrary<Map<string, ExtendedCardValue>> {
  return fc
    .uniqueArray(fc.tuple(userIdArb, cardArb), {
      minLength: 0,
      maxLength: 50,
      size: 'max',
      selector: ([userId]) => userId,
    })
    .map((entries) => new Map<string, ExtendedCardValue>(entries));
}

/** Selection maps for one voting system: its own cards, specials, then cross-deck and foreign noise. */
export function systemSelectionsArb(
  system: VotingSystemType
): fc.Arbitrary<Map<string, ExtendedCardValue>> {
  const ownCards = getCardsForVotingSystem(system);
  return fc.oneof(
    selectionsArb(fc.constantFrom<ExtendedCardValue>(...ownCards)),
    selectionsArb(fc.constantFrom<ExtendedCardValue>(...VOTING_SYSTEMS[system])),
    selectionsArb(extendedCardArb),
    selectionsArb(cardWithForeignArb),
    selectionsArb(foreignCardArb)
  );
}

/** A voting system identifier paired with selections drawn for that system. */
export const systemAndSelectionsArb: fc.Arbitrary<{
  system: VotingSystemType;
  selections: Map<string, ExtendedCardValue>;
}> = fc
  .constantFrom<VotingSystemType>(...VOTING_SYSTEM_IDS)
  .chain((system) =>
    systemSelectionsArb(system).map((selections) => ({ system, selections }))
  );

// ---------------------------------------------------------------------------
// Property 25
// ---------------------------------------------------------------------------

// Feature: vote-reveal-fun-callouts, Property 25: No NaN metrics
/**
 * Property 25: No NaN metrics
 *
 * For every generated selection map (all extended cards, foreign values,
 * 0..50 participants) and every voting system, `average` and `spread` are
 * either null or a finite number, and never NaN.
 *
 * **Validates: Requirements 14.4, 14.5, 14.10, 14.11, 14.17**
 */
describe('Property 25: No NaN metrics', () => {
  const isNullOrFinite = (value: number | null): boolean =>
    value === null || (typeof value === 'number' && Number.isFinite(value));

  for (const system of VOTING_SYSTEM_IDS) {
    it(`average and spread are null or finite for ${system}`, () => {
      fc.assert(
        fc.property(systemSelectionsArb(system), (selections) => {
          const metrics = calculate(selections, system);

          expect(Number.isNaN(metrics.average)).toBe(false);
          expect(Number.isNaN(metrics.spread)).toBe(false);
          expect(isNullOrFinite(metrics.average)).toBe(true);
          expect(isNullOrFinite(metrics.spread)).toBe(true);
        }),
        { numRuns: 200 }
      );
    });
  }

  it('average and spread are null or finite for any selection map under any voting system', () => {
    fc.assert(
      fc.property(
        selectionsArb(cardWithForeignArb),
        fc.constantFrom<VotingSystemType>(...VOTING_SYSTEM_IDS),
        (selections, system) => {
          const metrics = calculate(selections, system);

          expect(isNullOrFinite(metrics.average)).toBe(true);
          expect(isNullOrFinite(metrics.spread)).toBe(true);
        }
      ),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 26
// ---------------------------------------------------------------------------

// Feature: vote-reveal-fun-callouts, Property 26: Null metrics exactly on insufficient numeric votes
/**
 * Property 26: Null metrics exactly on insufficient numeric votes
 *
 * For every generated selection map and voting system, `average` and `spread`
 * are null exactly when fewer than two selections have a Card_Numeric_Value,
 * and finite otherwise. `insufficientData` agrees with that condition, and a
 * t-shirt round always takes the null branch.
 *
 * **Validates: Requirements 14.7, 14.8, 14.9**
 */
describe('Property 26: Null metrics exactly on insufficient numeric votes', () => {
  const countNumeric = (selections: ReadonlyMap<string, ExtendedCardValue>): number => {
    let count = 0;
    for (const card of selections.values()) {
      if (cardNumericValue(card) !== undefined) count += 1;
    }
    return count;
  };

  const isFinite = (value: number | null): boolean =>
    typeof value === 'number' && Number.isFinite(value);

  it('average and spread are null exactly when fewer than two selections are numeric', () => {
    fc.assert(
      fc.property(systemAndSelectionsArb, ({ system, selections }) => {
        const numericCount = countNumeric(selections);
        const insufficient = numericCount < 2;
        const metrics = calculate(selections, system);

        if (insufficient) {
          expect(metrics.average).toBeNull();
          expect(metrics.spread).toBeNull();
        } else {
          expect(isFinite(metrics.average)).toBe(true);
          expect(isFinite(metrics.spread)).toBe(true);
        }

        expect(metrics.insufficientData).toBe(insufficient);
        expect(metrics.numericVoteCount).toBe(numericCount);
      }),
      { numRuns: 300 }
    );
  });

  it('agrees for selection maps mixing in-deck, cross-deck and foreign cards under any system', () => {
    fc.assert(
      fc.property(
        selectionsArb(cardWithForeignArb),
        fc.constantFrom<VotingSystemType>(...VOTING_SYSTEM_IDS),
        (selections, system) => {
          const insufficient = countNumeric(selections) < 2;
          const metrics = calculate(selections, system);

          expect(metrics.average === null).toBe(insufficient);
          expect(metrics.spread === null).toBe(insufficient);
          expect(metrics.insufficientData).toBe(insufficient);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('a t-shirt round always takes the null branch', () => {
    const tShirtSelectionsArb = selectionsArb(
      fc.constantFrom<ExtendedCardValue>(...VOTING_SYSTEMS['t-shirt'], ...SPECIAL_CARDS)
    );

    fc.assert(
      fc.property(tShirtSelectionsArb, (selections) => {
        const metrics = calculate(selections, 't-shirt');

        expect(countNumeric(selections)).toBe(0);
        expect(metrics.average).toBeNull();
        expect(metrics.spread).toBeNull();
        expect(metrics.insufficientData).toBe(true);
      }),
      { numRuns: 200 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 28
// ---------------------------------------------------------------------------

// Feature: vote-reveal-fun-callouts, Property 28: Outlier soundness
/**
 * Property 28: Outlier soundness
 *
 * For every generated selection map and voting system, every member of
 * `outliers` has a Card_Numeric_Value, sits on the active Card_Ladder and is
 * more than 2 ladder steps from the mode's index. Every non-member fails at
 * least one of those conditions. When the returned mode is null or off the
 * ladder, `outliers` is empty.
 *
 * **Validates: Requirements 15.2, 15.3, 15.4, 15.5, 15.8, 15.9**
 */
describe('Property 28: Outlier soundness', () => {
  const OUTLIER_DISTANCE = 2;

  /** Index of the returned mode on the ladder, or -1 when null / off-ladder. */
  const modeIndexOf = (
    mode: ExtendedCardValue | null,
    ladder: readonly ExtendedCardValue[]
  ): number => (mode === null ? -1 : ladderIndexOf(ladder, mode));

  const checkSoundness = (
    selections: Map<string, ExtendedCardValue>,
    system: VotingSystemType
  ): void => {
    const metrics = calculate(selections, system);
    const ladder = cardLadderFor(system);
    const modeIndex = modeIndexOf(metrics.mode, ladder);
    const outlierSet = new Set(metrics.outliers);

    // No duplicates, and every outlier is a participant.
    expect(outlierSet.size).toBe(metrics.outliers.length);
    for (const userId of metrics.outliers) {
      expect(selections.has(userId)).toBe(true);
    }

    // A null or off-ladder mode (or a ladder too short to measure) yields none.
    if (modeIndex < 0 || ladder.length < 2) {
      expect(metrics.outliers).toEqual([]);
    }

    for (const [userId, card] of selections) {
      const numeric = cardNumericValue(card) !== undefined;
      const voteIndex = ladderIndexOf(ladder, card);
      const onLadder = voteIndex >= 0;
      const far = modeIndex >= 0 && onLadder && Math.abs(voteIndex - modeIndex) > OUTLIER_DISTANCE;

      if (outlierSet.has(userId)) {
        // Member: every condition holds.
        expect(numeric).toBe(true);
        expect(onLadder).toBe(true);
        expect(modeIndex).toBeGreaterThanOrEqual(0);
        expect(Math.abs(voteIndex - modeIndex)).toBeGreaterThan(OUTLIER_DISTANCE);
      } else {
        // Non-member: at least one condition fails.
        expect(numeric && onLadder && far).toBe(false);
      }
    }
  };

  it('members satisfy every condition and non-members fail at least one', () => {
    fc.assert(
      fc.property(systemAndSelectionsArb, ({ system, selections }) => {
        checkSoundness(selections, system);
      }),
      { numRuns: 300 }
    );
  });

  it('holds for mixed in-deck, cross-deck and foreign cards under any system', () => {
    fc.assert(
      fc.property(
        selectionsArb(cardWithForeignArb),
        fc.constantFrom<VotingSystemType>(...VOTING_SYSTEM_IDS),
        (selections, system) => {
          checkSoundness(selections, system);
        }
      ),
      { numRuns: 200 }
    );
  });

  for (const system of VOTING_SYSTEM_IDS) {
    it(`holds for ${system} rounds drawn from that system's own cards`, () => {
      const ownCards = getCardsForVotingSystem(system);
      fc.assert(
        fc.property(
          selectionsArb(fc.constantFrom<ExtendedCardValue>(...ownCards, ...SPECIAL_CARDS)),
          (selections) => {
            checkSoundness(selections, system);
          }
        ),
        { numRuns: 200 }
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Property 29
// ---------------------------------------------------------------------------

// Feature: vote-reveal-fun-callouts, Property 29: Outlier emptiness on short ladders
/**
 * Property 29: Outlier emptiness on short ladders
 *
 * For every generated selection map and every voting system whose Card_Ladder
 * holds fewer than two entries (`t-shirt` and every unknown identifier,
 * including prototype-ish names such as `__proto__`), `outliers` is `[]` and
 * the remaining fields are returned without throwing.
 *
 * **Validates: Requirements 15.6, 15.11**
 */
describe('Property 29: Outlier emptiness on short ladders', () => {
  const PROTOTYPE_ISH_IDS = [
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    'valueOf',
    'prototype',
    '',
  ];

  const isKnownSystem = (id: string): boolean =>
    Object.prototype.hasOwnProperty.call(VOTING_SYSTEMS, id);

  /** Identifiers that are not own keys of VOTING_SYSTEMS. */
  const unknownSystemIdArb: fc.Arbitrary<string> = fc
    .oneof(
      fc.constantFrom<string>(...PROTOTYPE_ISH_IDS),
      fc.string({ maxLength: 20 }),
      fc.string({ minLength: 1, maxLength: 10 }).map((s) => `${s}-system`)
    )
    .filter((id) => !isKnownSystem(id));

  const mixedSelectionsArb = selectionsArb(
    fc.oneof(
      { weight: 9, arbitrary: extendedCardArb },
      { weight: 1, arbitrary: foreignCardArb }
    )
  );

  const isNullOrFinite = (value: number | null): boolean =>
    value === null || (typeof value === 'number' && Number.isFinite(value));

  const countNumeric = (selections: ReadonlyMap<string, ExtendedCardValue>): number => {
    let count = 0;
    for (const card of selections.values()) {
      if (cardNumericValue(card) !== undefined) count += 1;
    }
    return count;
  };

  /** Outliers are empty and every other field is well-formed. */
  const checkShortLadder = (
    selections: Map<string, ExtendedCardValue>,
    system: string
  ): void => {
    expect(cardLadderFor(system).length).toBeLessThan(2);

    const metrics = calculate(selections, system);
    const numericCount = countNumeric(selections);

    expect(metrics.outliers).toEqual([]);

    expect(metrics.numericVoteCount).toBe(numericCount);
    expect(metrics.insufficientData).toBe(numericCount < 2);
    expect(isNullOrFinite(metrics.average)).toBe(true);
    expect(isNullOrFinite(metrics.spread)).toBe(true);
    expect(metrics.average === null).toBe(numericCount < 2);
    expect(metrics.spread === null).toBe(numericCount < 2);
    expect(metrics.mode === null).toBe(numericCount < 2);

    const distributionTotal = Object.values(metrics.distribution).reduce((a, b) => a + b, 0);
    expect(distributionTotal).toBe(selections.size);

    // Everything other than `outliers` is independent of the ladder.
    const reference = calculate(selections, 'fibonacci');
    expect({ ...metrics, outliers: [] }).toEqual({ ...reference, outliers: [] });
  };

  it('t-shirt has a ladder of fewer than two entries', () => {
    expect(cardLadderFor('t-shirt').length).toBeLessThan(2);
  });

  it('outliers is [] and other fields are well-formed for t-shirt', () => {
    fc.assert(
      fc.property(mixedSelectionsArb, (selections) => {
        checkShortLadder(selections, 't-shirt');
      }),
      { numRuns: 200 }
    );
  });

  it('outliers is [] for t-shirt rounds drawn from its own cards and specials', () => {
    const tShirtSelectionsArb = selectionsArb(
      fc.constantFrom<ExtendedCardValue>(...VOTING_SYSTEMS['t-shirt'], ...SPECIAL_CARDS)
    );

    fc.assert(
      fc.property(tShirtSelectionsArb, (selections) => {
        checkShortLadder(selections, 't-shirt');
      }),
      { numRuns: 200 }
    );
  });

  it('outliers is [] and other fields are well-formed for generated unknown identifiers', () => {
    fc.assert(
      fc.property(mixedSelectionsArb, unknownSystemIdArb, (selections, system) => {
        checkShortLadder(selections, system);
      }),
      { numRuns: 300 }
    );
  });

  for (const system of PROTOTYPE_ISH_IDS) {
    it(`does not throw and returns no outliers for the identifier ${JSON.stringify(system)}`, () => {
      fc.assert(
        fc.property(
          selectionsArb(
            fc.oneof(
              { weight: 9, arbitrary: extendedCardArb },
              { weight: 1, arbitrary: foreignCardArb }
            )
          ),
          (selections) => {
            checkShortLadder(selections, system);
          }
        ),
        { numRuns: 100 }
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Property 30
// ---------------------------------------------------------------------------

// Feature: vote-reveal-fun-callouts, Property 30: Distribution totality
/**
 * Property 30: Distribution totality
 *
 * For every generated selection map and voting system, the sum of the counts in
 * `distribution` equals the number of selections. There is exactly one key per
 * distinct card value present (`String(card)`), including special cards,
 * t-shirt sizes and values belonging to no known system, and each count equals
 * the number of selections holding that card.
 *
 * **Validates: Requirements 14.12, 14.17**
 */
describe('Property 30: Distribution totality', () => {
  /** Expected distribution computed independently of the engine. */
  const expectedDistribution = (
    selections: ReadonlyMap<string, ExtendedCardValue>
  ): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const card of selections.values()) {
      const key = String(card);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };

  const checkTotality = (
    selections: Map<string, ExtendedCardValue>,
    system: VotingSystemType
  ): void => {
    const { distribution } = calculate(selections, system);
    const expected = expectedDistribution(selections);

    // Sum of counts equals the number of selections.
    const total = Object.values(distribution).reduce((sum, count) => sum + count, 0);
    expect(total).toBe(selections.size);

    // One key per distinct card value, no more and no fewer.
    expect(Object.keys(distribution).sort()).toEqual(Array.from(expected.keys()).sort());

    // Each count equals the number of selections with that card.
    for (const [key, count] of expected) {
      expect(distribution[key]).toBe(count);
    }
  };

  for (const system of VOTING_SYSTEM_IDS) {
    it(`sums to the selection count with one key per distinct card for ${system}`, () => {
      fc.assert(
        fc.property(systemSelectionsArb(system), (selections) => {
          checkTotality(selections, system);
        }),
        { numRuns: 200 }
      );
    });
  }

  it('holds for any voting system with in-deck, cross-deck and foreign cards', () => {
    fc.assert(
      fc.property(
        selectionsArb(cardWithForeignArb),
        fc.constantFrom<VotingSystemType>(...VOTING_SYSTEM_IDS),
        (selections, system) => {
          checkTotality(selections, system);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('counts special cards, t-shirt sizes and foreign values under their String(card) key', () => {
    const tShirtCards = VOTING_SYSTEMS['t-shirt'] as readonly ExtendedCardValue[];

    fc.assert(
      fc.property(
        selectionsArb(
          fc.oneof(
            fc.constantFrom<ExtendedCardValue>(...SPECIAL_CARDS),
            fc.constantFrom<ExtendedCardValue>(...tShirtCards),
            foreignCardArb
          )
        ),
        fc.constantFrom<VotingSystemType>(...VOTING_SYSTEM_IDS),
        (selections, system) => {
          checkTotality(selections, system);

          const { distribution } = calculate(selections, system);
          for (const card of selections.values()) {
            expect(Object.prototype.hasOwnProperty.call(distribution, String(card))).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('returns an empty distribution for an empty selection map', () => {
    for (const system of VOTING_SYSTEM_IDS) {
      expect(calculate(new Map<string, ExtendedCardValue>(), system).distribution).toEqual({});
    }
  });
});

// ---------------------------------------------------------------------------
// Property 31
// ---------------------------------------------------------------------------

// Feature: vote-reveal-fun-callouts, Property 31: Mode card-value fidelity
/**
 * Property 31: Mode card-value fidelity
 *
 * For every generated selection map whose `mode` is non-null, the returned
 * `mode` is a card value present in the selections whose Card_Numeric_Value is
 * the modal Card_Numeric_Value, with ties resolved to the least
 * Card_Numeric_Value. A round whose modal value is the `modified-fibonacci`
 * '½' card reports `mode` as '½' (a string), not as 0.5.
 *
 * **Validates: Requirements 14.13, 14.14, 14.18**
 */
describe('Property 31: Mode card-value fidelity', () => {
  /** Mapped values of the numeric selections, in iteration order. */
  const mappedValues = (selections: ReadonlyMap<string, ExtendedCardValue>): number[] => {
    const values: number[] = [];
    for (const card of selections.values()) {
      const numeric = cardNumericValue(card);
      if (numeric !== undefined) values.push(numeric);
    }
    return values;
  };

  /** Modal mapped value (least value on ties), computed independently of the engine. */
  const expectedModalValue = (values: readonly number[]): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    let best = sorted[0];
    let bestCount = 0;
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j < sorted.length && sorted[j] === sorted[i]) j += 1;
      const runLength = j - i;
      // Ascending scan with a strict comparison keeps the least value on ties.
      if (runLength > bestCount) {
        best = sorted[i];
        bestCount = runLength;
      }
      i = j;
    }
    return best;
  };

  const checkFidelity = (
    selections: Map<string, ExtendedCardValue>,
    system: VotingSystemType
  ): void => {
    const metrics = calculate(selections, system);
    const values = mappedValues(selections);

    if (metrics.mode === null) {
      // A null mode only happens on insufficient numeric data.
      expect(values.length).toBeLessThan(2);
      return;
    }

    expect(values.length).toBeGreaterThanOrEqual(2);

    // The mode is a card present in the selections, returned unmapped.
    const presentCards = new Set<ExtendedCardValue>(selections.values());
    expect(presentCards.has(metrics.mode)).toBe(true);

    // Its mapped value is the modal mapped value (ties to the least).
    expect(cardNumericValue(metrics.mode)).toBe(expectedModalValue(values));

    // A '½' mode is never converted to its mapped number.
    if (cardNumericValue(metrics.mode) === 0.5) {
      expect(metrics.mode).toBe('½');
      expect(typeof metrics.mode).toBe('string');
    }
  };

  it('a non-null mode is a present card carrying the modal mapped value, ties to the least', () => {
    fc.assert(
      fc.property(systemAndSelectionsArb, ({ system, selections }) => {
        checkFidelity(selections, system);
      }),
      { numRuns: 300 }
    );
  });

  it('holds for mixed in-deck, cross-deck and foreign cards under any system', () => {
    fc.assert(
      fc.property(
        selectionsArb(cardWithForeignArb),
        fc.constantFrom<VotingSystemType>(...VOTING_SYSTEM_IDS),
        (selections, system) => {
          checkFidelity(selections, system);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('resolves ties to the least mapped value on small, collision-prone rounds', () => {
    const smallCardArb = fc.constantFrom<ExtendedCardValue>(0, '½', 1, 2, 'coffee');
    fc.assert(
      fc.property(
        selectionsArb(smallCardArb),
        fc.constantFrom<VotingSystemType>(...VOTING_SYSTEM_IDS),
        (selections, system) => {
          checkFidelity(selections, system);
        }
      ),
      { numRuns: 300 }
    );
  });

  it("reports a modal '½' as the string '½', not 0.5", () => {
    // '½' is guaranteed to be the strict plurality: fewer than `halves` other cards in total.
    const halfModalArb = fc
      .tuple(fc.integer({ min: 2, max: 20 }), fc.array(extendedCardArb, { maxLength: 10 }))
      .map(([halves, others]) => {
        const cards: ExtendedCardValue[] = [
          ...Array<ExtendedCardValue>(halves).fill('½'),
          ...others.filter((card) => card !== '½').slice(0, halves - 1),
        ];
        return new Map<string, ExtendedCardValue>(
          cards.map((card, index) => [`user-${index}`, card] as [string, ExtendedCardValue])
        );
      });

    fc.assert(
      fc.property(halfModalArb, (selections) => {
        const metrics = calculate(selections, 'modified-fibonacci');

        // Fewer than `halves` other cards, so no other mapped value can match or beat '½'.
        expect(metrics.mode).toBe('½');
        expect(typeof metrics.mode).toBe('string');
        expect(metrics.mode).not.toBe(0.5);
      }),
      { numRuns: 200 }
    );
  });
});
