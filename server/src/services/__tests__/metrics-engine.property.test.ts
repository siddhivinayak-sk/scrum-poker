import * as fc from 'fast-check';
import { calculate } from '../metrics-engine';
import {
  CardValue,
  NumericCardValue,
  ALL_CARDS,
  FIBONACCI_SEQUENCE,
  SPECIAL_CARDS,
  SpecialCardValue,
} from '../../../../shared/types';

const SPECIAL_CARD_SET = new Set<string>(SPECIAL_CARDS);

function isNumericCard(value: CardValue): value is NumericCardValue {
  return !SPECIAL_CARD_SET.has(value as string);
}

/**
 * Property 8: Metrics calculation correctness
 *
 * For any set of card selections containing at least two numeric votes,
 * the Metrics_Engine SHALL produce:
 * - An average equal to the arithmetic mean of all numeric card values (excluding special cards)
 * - A mode equal to the most frequently occurring numeric card value
 * - A spread equal to the difference between the maximum and minimum numeric card values
 * - A distribution where each card value's count equals its actual number of occurrences
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4
 */
describe('Property 8: Metrics calculation correctness', () => {
  it('average equals arithmetic mean of numeric values', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...ALL_CARDS), { minLength: 2, maxLength: 50 }),
        (cards: CardValue[]) => {
          // Build selections map with unique user IDs
          const selections = new Map<string, CardValue>();
          cards.forEach((card, i) => {
            selections.set(`user-${i}`, card);
          });

          const numericValues = cards.filter(isNumericCard) as NumericCardValue[];
          if (numericValues.length < 2) return; // skip when insufficient numeric votes

          const result = calculate(selections);

          const expectedAverage =
            numericValues.reduce((sum: number, v) => sum + v, 0 as number) / numericValues.length;
          expect(result.average).toBeCloseTo(expectedAverage, 10);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('mode equals the most frequently occurring numeric value (lowest breaks ties)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...ALL_CARDS), { minLength: 2, maxLength: 50 }),
        (cards: CardValue[]) => {
          const selections = new Map<string, CardValue>();
          cards.forEach((card, i) => {
            selections.set(`user-${i}`, card);
          });

          const numericValues = cards.filter(isNumericCard) as NumericCardValue[];
          if (numericValues.length < 2) return;

          const result = calculate(selections);

          // Compute expected mode: most frequent numeric value, lowest breaks ties
          const counts = new Map<NumericCardValue, number>();
          for (const v of numericValues) {
            counts.set(v, (counts.get(v) ?? 0) + 1);
          }

          let expectedMode = numericValues[0];
          let maxCount = 0;
          for (const [value, count] of counts) {
            if (count > maxCount || (count === maxCount && value < expectedMode)) {
              expectedMode = value;
              maxCount = count;
            }
          }

          expect(result.mode).toBe(expectedMode);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('spread equals max minus min of numeric values', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...ALL_CARDS), { minLength: 2, maxLength: 50 }),
        (cards: CardValue[]) => {
          const selections = new Map<string, CardValue>();
          cards.forEach((card, i) => {
            selections.set(`user-${i}`, card);
          });

          const numericValues = cards.filter(isNumericCard) as NumericCardValue[];
          if (numericValues.length < 2) return;

          const result = calculate(selections);

          const expectedSpread =
            Math.max(...numericValues) - Math.min(...numericValues);
          expect(result.spread).toBe(expectedSpread);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('distribution counts match actual occurrences of each card value', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...ALL_CARDS), { minLength: 2, maxLength: 50 }),
        (cards: CardValue[]) => {
          const selections = new Map<string, CardValue>();
          cards.forEach((card, i) => {
            selections.set(`user-${i}`, card);
          });

          const numericValues = cards.filter(isNumericCard) as NumericCardValue[];
          if (numericValues.length < 2) return;

          const result = calculate(selections);

          // Compute expected distribution over ALL card values (including special)
          const expectedDistribution: Record<string, number> = {};
          for (const card of cards) {
            const key = String(card);
            expectedDistribution[key] = (expectedDistribution[key] ?? 0) + 1;
          }

          expect(result.distribution).toEqual(expectedDistribution);
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 9: Outlier detection correctness
 *
 * For any set of revealed numeric card selections and the computed mode,
 * a vote SHALL be identified as an outlier if and only if the absolute
 * difference between its Fibonacci sequence index and the mode's Fibonacci
 * sequence index is greater than 2.
 *
 * Validates: Requirements 11.5
 */
describe('Property 9: Outlier detection correctness', () => {
  const FIBONACCI_INDEX = new Map<NumericCardValue, number>(
    FIBONACCI_SEQUENCE.map((value, index) => [value, index])
  );

  it('a vote is an outlier iff its Fibonacci index differs from mode index by more than 2', () => {
    fc.assert(
      fc.property(
        fc.record({
          selections: fc.array(fc.constantFrom(...FIBONACCI_SEQUENCE), { minLength: 3 }),
        }),
        ({ selections }) => {
          // Build selections map with unique user IDs
          const selectionsMap = new Map<string, CardValue>();
          selections.forEach((card, i) => {
            selectionsMap.set(`user-${i}`, card);
          });

          const result = calculate(selectionsMap);

          // With >= 3 numeric votes, we should have sufficient data
          expect(result.insufficientData).toBe(false);
          expect(result.mode).not.toBeNull();

          const mode = result.mode as NumericCardValue;
          const modeIndex = FIBONACCI_INDEX.get(mode)!;

          // Verify each vote: outlier iff |voteIndex - modeIndex| > 2
          selections.forEach((card, i) => {
            const userId = `user-${i}`;
            const voteIndex = FIBONACCI_INDEX.get(card)!;
            const isOutlier = Math.abs(voteIndex - modeIndex) > 2;

            if (isOutlier) {
              expect(result.outliers).toContain(userId);
            } else {
              expect(result.outliers).not.toContain(userId);
            }
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 10: Insufficient data detection
 *
 * For any set of card selections, the Metrics_Engine SHALL set
 * `insufficientData` to `true` if and only if fewer than 2 participants
 * have made numeric card selections (excluding special cards).
 *
 * Validates: Requirements 11.6
 */
describe('Property 10: Insufficient data detection', () => {
  it('insufficientData is true when 0–1 numeric votes exist', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...SPECIAL_CARDS), { minLength: 0, maxLength: 10 }),
        fc.array(fc.constantFrom(...FIBONACCI_SEQUENCE), { minLength: 0, maxLength: 1 }),
        (specialCards: SpecialCardValue[], numericCards: NumericCardValue[]) => {
          const allCards: CardValue[] = [...specialCards, ...numericCards];

          const selections = new Map<string, CardValue>();
          allCards.forEach((card, i) => {
            selections.set(`user-${i}`, card);
          });

          const result = calculate(selections);

          // With 0 or 1 numeric votes, insufficientData must be true
          expect(result.insufficientData).toBe(true);
          expect(result.average).toBeNull();
          expect(result.mode).toBeNull();
          expect(result.spread).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('insufficientData is false when 2+ numeric votes exist', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...SPECIAL_CARDS), { minLength: 0, maxLength: 10 }),
        fc.array(fc.constantFrom(...FIBONACCI_SEQUENCE), { minLength: 2, maxLength: 10 }),
        (specialCards: SpecialCardValue[], numericCards: NumericCardValue[]) => {
          const allCards: CardValue[] = [...specialCards, ...numericCards];

          const selections = new Map<string, CardValue>();
          allCards.forEach((card, i) => {
            selections.set(`user-${i}`, card);
          });

          const result = calculate(selections);

          // With 2+ numeric votes, insufficientData must be false
          expect(result.insufficientData).toBe(false);
          expect(result.average).not.toBeNull();
          expect(result.mode).not.toBeNull();
          expect(result.spread).not.toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});
