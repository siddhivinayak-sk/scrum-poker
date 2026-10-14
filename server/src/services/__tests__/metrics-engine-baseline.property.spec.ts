import * as fc from 'fast-check';
import { calculate } from '../metrics-engine';
import { calculateBaseline } from './metrics-engine.baseline';
import {
  CardValue,
  FIBONACCI_SEQUENCE,
  SPECIAL_CARDS,
} from '../../../../shared/types';

const ALL_FIBONACCI_DECK_CARDS: CardValue[] = [...FIBONACCI_SEQUENCE, ...SPECIAL_CARDS];

const userIdArb = fc.string({ minLength: 1, maxLength: 8 });

/** Cards drawn from the full Fibonacci deck (numeric + special). */
const anyCardArb = fc.constantFrom<CardValue>(...ALL_FIBONACCI_DECK_CARDS);

/** Cards biased towards numeric values so >= 2 numeric voters are common. */
const numericHeavyCardArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom<CardValue>(...FIBONACCI_SEQUENCE) },
  { weight: 1, arbitrary: fc.constantFrom<CardValue>(...SPECIAL_CARDS) }
);

function selectionsArb(cardArb: fc.Arbitrary<CardValue>, maxSize: number) {
  return fc
    .uniqueArray(fc.tuple(userIdArb, cardArb), {
      minLength: 0,
      maxLength: maxSize,
      selector: ([userId]) => userId,
    })
    .map((entries) => new Map<string, CardValue>(entries));
}

/** Participant counts 0, 1 and many; mixed, numeric-heavy and full-range decks. */
const selectionMapArb = fc.oneof(
  selectionsArb(anyCardArb, 12),
  selectionsArb(numericHeavyCardArb, 20),
  selectionsArb(anyCardArb, 1),
  fc.constant(new Map<string, CardValue>())
);

// Feature: vote-reveal-fun-callouts, Property 27: Fibonacci metrics non-regression
/**
 * Property 27: Fibonacci metrics non-regression
 *
 * For any selection map drawn only from the Fibonacci deck (Fibonacci values
 * plus special cards), `calculate(selections)` equals the frozen baseline
 * `calculateBaseline(selections)` on all seven fields, with outlier order
 * preserved.
 *
 * **Validates: Requirements 13.2, 14.15, 15.7**
 */
describe('Property 27: Fibonacci metrics non-regression', () => {
  it('calculate(selections) equals calculateBaseline(selections) on all seven fields', () => {
    fc.assert(
      fc.property(selectionMapArb, (selections) => {
        const actual = calculate(selections);
        const expected = calculateBaseline(selections);

        expect(actual.average).toEqual(expected.average);
        expect(actual.mode).toEqual(expected.mode);
        expect(actual.spread).toEqual(expected.spread);
        expect(actual.distribution).toEqual(expected.distribution);
        // toEqual on arrays is order-sensitive, so outlier order is preserved
        expect(actual.outliers).toEqual(expected.outliers);
        expect(actual.numericVoteCount).toEqual(expected.numericVoteCount);
        expect(actual.insufficientData).toEqual(expected.insufficientData);
      }),
      { numRuns: 200 }
    );
  });

  // Extension (task 4.3): the explicit voting-system parameter must not change Fibonacci results.
  it("calculate(selections, 'fibonacci') equals calculateBaseline(selections) on all seven fields", () => {
    fc.assert(
      fc.property(selectionMapArb, (selections) => {
        const actual = calculate(selections, 'fibonacci');
        const expected = calculateBaseline(selections);

        expect(actual.average).toEqual(expected.average);
        expect(actual.mode).toEqual(expected.mode);
        expect(actual.spread).toEqual(expected.spread);
        expect(actual.distribution).toEqual(expected.distribution);
        // toEqual on arrays is order-sensitive, so outlier order is preserved
        expect(actual.outliers).toEqual(expected.outliers);
        expect(actual.numericVoteCount).toEqual(expected.numericVoteCount);
        expect(actual.insufficientData).toEqual(expected.insufficientData);
      }),
      { numRuns: 200 }
    );
  });
});
