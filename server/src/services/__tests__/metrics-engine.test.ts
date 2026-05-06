import { calculate } from '../metrics-engine';
import { CardValue, NumericCardValue } from '../../../../shared/types';

function makeSelections(
  entries: Array<[string, CardValue]>
): Map<string, CardValue> {
  return new Map(entries);
}

describe('MetricsEngine - calculate', () => {
  describe('insufficient data', () => {
    it('returns insufficientData true for empty selections', () => {
      const result = calculate(new Map());
      expect(result.insufficientData).toBe(true);
      expect(result.average).toBeNull();
      expect(result.mode).toBeNull();
      expect(result.spread).toBeNull();
      expect(result.outliers).toEqual([]);
      expect(result.numericVoteCount).toBe(0);
    });

    it('returns insufficientData true for a single numeric vote', () => {
      const result = calculate(makeSelections([['u1', 5]]));
      expect(result.insufficientData).toBe(true);
      expect(result.numericVoteCount).toBe(1);
    });

    it('returns insufficientData true when all votes are special cards', () => {
      const result = calculate(
        makeSelections([
          ['u1', 'coffee'],
          ['u2', 'no-clue'],
          ['u3', 'break'],
        ])
      );
      expect(result.insufficientData).toBe(true);
      expect(result.numericVoteCount).toBe(0);
    });

    it('returns insufficientData true for 1 numeric + special cards', () => {
      const result = calculate(
        makeSelections([
          ['u1', 8],
          ['u2', 'coffee'],
          ['u3', 'break'],
        ])
      );
      expect(result.insufficientData).toBe(true);
      expect(result.numericVoteCount).toBe(1);
    });
  });

  describe('basic calculations with 2+ numeric votes', () => {
    it('calculates average, mode, spread for [1, 2, 3]', () => {
      const result = calculate(
        makeSelections([
          ['u1', 1],
          ['u2', 2],
          ['u3', 3],
        ])
      );
      expect(result.insufficientData).toBe(false);
      expect(result.numericVoteCount).toBe(3);
      expect(result.average).toBe(2);
      expect(result.spread).toBe(2); // 3 - 1
    });

    it('calculates average for [5, 13]', () => {
      const result = calculate(
        makeSelections([
          ['u1', 5],
          ['u2', 13],
        ])
      );
      expect(result.average).toBe(9);
      expect(result.spread).toBe(8); // 13 - 5
    });

    it('calculates mode as the most frequent numeric value', () => {
      const result = calculate(
        makeSelections([
          ['u1', 5],
          ['u2', 5],
          ['u3', 8],
        ])
      );
      expect(result.mode).toBe(5);
    });

    it('picks lowest value when there is a tie for mode', () => {
      const result = calculate(
        makeSelections([
          ['u1', 8],
          ['u2', 3],
        ])
      );
      // Both have count 1, so lowest (3) wins
      expect(result.mode).toBe(3);
    });

    it('picks lowest value in a multi-way tie', () => {
      const result = calculate(
        makeSelections([
          ['u1', 13],
          ['u2', 5],
          ['u3', 8],
        ])
      );
      // All have count 1, lowest is 5
      expect(result.mode).toBe(5);
    });

    it('calculates spread as max - min', () => {
      const result = calculate(
        makeSelections([
          ['u1', 0],
          ['u2', 89],
        ])
      );
      expect(result.spread).toBe(89);
    });

    it('calculates spread as 0 when all votes are the same', () => {
      const result = calculate(
        makeSelections([
          ['u1', 5],
          ['u2', 5],
        ])
      );
      expect(result.spread).toBe(0);
    });
  });

  describe('distribution', () => {
    it('counts all card values including special cards', () => {
      const result = calculate(
        makeSelections([
          ['u1', 5],
          ['u2', 5],
          ['u3', 'coffee'],
          ['u4', 8],
          ['u5', 'no-clue'],
        ])
      );
      expect(result.distribution).toEqual({
        '5': 2,
        '8': 1,
        'coffee': 1,
        'no-clue': 1,
      });
    });

    it('returns empty distribution for empty selections', () => {
      const result = calculate(new Map());
      expect(result.distribution).toEqual({});
    });

    it('counts only special cards when no numeric votes', () => {
      const result = calculate(
        makeSelections([
          ['u1', 'coffee'],
          ['u2', 'coffee'],
        ])
      );
      expect(result.distribution).toEqual({ coffee: 2 });
    });
  });

  describe('outlier detection', () => {
    // Fibonacci sequence: [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]
    // Indices:             0  1  2  3  4  5   6   7   8   9  10

    it('does not flag votes within 2 Fibonacci steps of mode', () => {
      // Mode = 5 (index 4). Votes at index 2 (value 2) and index 6 (value 13) are exactly 2 steps away
      const result = calculate(
        makeSelections([
          ['u1', 5],
          ['u2', 5],
          ['u3', 2],  // index 2, distance = 2 from mode index 4
          ['u4', 13], // index 6, distance = 2 from mode index 4
        ])
      );
      expect(result.mode).toBe(5);
      expect(result.outliers).toEqual([]);
    });

    it('flags votes more than 2 Fibonacci steps from mode', () => {
      // Mode = 5 (index 4). Vote at index 1 (value 1) is 3 steps away → outlier
      const result = calculate(
        makeSelections([
          ['u1', 5],
          ['u2', 5],
          ['u3', 1], // index 1, distance = 3 from mode index 4 → outlier
        ])
      );
      expect(result.mode).toBe(5);
      expect(result.outliers).toEqual(['u3']);
    });

    it('flags multiple outliers', () => {
      // Mode = 8 (index 5). Votes: 0 (index 0, dist 5), 1 (index 1, dist 4) → both outliers
      const result = calculate(
        makeSelections([
          ['u1', 8],
          ['u2', 8],
          ['u3', 0],  // index 0, distance = 5 → outlier
          ['u4', 1],  // index 1, distance = 4 → outlier
        ])
      );
      expect(result.mode).toBe(8);
      expect(result.outliers).toContain('u3');
      expect(result.outliers).toContain('u4');
      expect(result.outliers).toHaveLength(2);
    });

    it('does not flag special card voters as outliers', () => {
      const result = calculate(
        makeSelections([
          ['u1', 5],
          ['u2', 5],
          ['u3', 'coffee'],
        ])
      );
      expect(result.outliers).toEqual([]);
    });

    it('returns no outliers when all votes are the same', () => {
      const result = calculate(
        makeSelections([
          ['u1', 13],
          ['u2', 13],
          ['u3', 13],
        ])
      );
      expect(result.outliers).toEqual([]);
    });
  });

  describe('mixed numeric and special cards', () => {
    it('excludes special cards from average, mode, spread calculations', () => {
      const result = calculate(
        makeSelections([
          ['u1', 3],
          ['u2', 5],
          ['u3', 'coffee'],
          ['u4', 'break'],
        ])
      );
      expect(result.numericVoteCount).toBe(2);
      expect(result.average).toBe(4); // (3 + 5) / 2
      expect(result.spread).toBe(2); // 5 - 3
      expect(result.insufficientData).toBe(false);
    });
  });
});
