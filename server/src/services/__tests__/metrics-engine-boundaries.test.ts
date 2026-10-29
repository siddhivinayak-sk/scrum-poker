import { calculate } from '../metrics-engine';
import { ExtendedCardValue } from '../../../../shared/types';

/** Builds a selections map from [userId, card] pairs, preserving insertion order. */
function votes(...entries: [string, ExtendedCardValue][]): Map<string, ExtendedCardValue> {
  return new Map(entries);
}

/** A card value that belongs to no known voting system. */
const FOREIGN = 'banana' as unknown as ExtendedCardValue;

describe('metrics-engine boundaries (reworked engine)', () => {
  describe('mode fidelity (Requirement 14.14)', () => {
    it("returns the card '½' (not 0.5) when '½' is the modal vote", () => {
      const metrics = calculate(
        votes(['a', '½'], ['b', '½'], ['c', 1]),
        'modified-fibonacci'
      );
      expect(metrics.mode).toBe('½');
      expect(metrics.mode).not.toBe(0.5);
    });
  });

  describe('finite averages for non-integer cards (Requirement 14.9)', () => {
    it("gives a finite average of 0.5 for modified-fibonacci votes 0, '½', 1", () => {
      const metrics = calculate(
        votes(['a', 0], ['b', '½'], ['c', 1]),
        'modified-fibonacci'
      );
      expect(Number.isFinite(metrics.average)).toBe(true);
      expect(metrics.average).toBe(0.5);
      expect(metrics.spread).toBe(1);
      expect(metrics.insufficientData).toBe(false);
      // three-way tie resolves to the least mapped value
      expect(metrics.mode).toBe(0);
    });
  });

  describe('outliers on non-Fibonacci systems (Requirements 15.4, 15.5)', () => {
    it('flags the 64 voter in a power-of-2 round of 0 and 64', () => {
      // Tie 1-1 resolves to the least value: mode 0 (ladder index 0).
      // 64 is ladder index 7 -> 7 steps from the mode, which is > 2.
      const metrics = calculate(votes(['a', 0], ['b', 64]), 'power-of-2');
      expect(metrics.mode).toBe(0);
      expect(metrics.outliers).toEqual(['b']);
    });

    it("flags the 100 voter in a modified-fibonacci round of '½' and 100", () => {
      // Tie 1-1 resolves to the least value: mode '½' (ladder index 1).
      // 100 is ladder index 10 -> 9 steps from the mode, which is > 2.
      const metrics = calculate(votes(['a', '½'], ['b', 100]), 'modified-fibonacci');
      expect(metrics.mode).toBe('½');
      expect(metrics.outliers).toEqual(['b']);
    });

    it('does not flag a vote exactly 2 ladder steps from the mode', () => {
      // power-of-2 ladder [0,1,2,4,8,...]: mode 1 (index 1), 4 is index 3 -> distance 2.
      const metrics = calculate(votes(['a', 1], ['b', 1], ['c', 4]), 'power-of-2');
      expect(metrics.mode).toBe(1);
      expect(metrics.outliers).toEqual([]);
    });
  });

  describe('t-shirt rounds (Requirements 14.9, 15.11)', () => {
    it('reports insufficientData with null average, mode and spread', () => {
      const metrics = calculate(votes(['a', 'S'], ['b', 'M'], ['c', 'L']), 't-shirt');
      expect(metrics.insufficientData).toBe(true);
      expect(metrics.average).toBeNull();
      expect(metrics.mode).toBeNull();
      expect(metrics.spread).toBeNull();
      expect(metrics.outliers).toEqual([]);
      expect(metrics.numericVoteCount).toBe(0);
      expect(metrics.distribution).toEqual({ S: 1, M: 1, L: 1 });
    });
  });

  describe('foreign card values (Requirement 14.17)', () => {
    it('counts a foreign value in distribution only', () => {
      const metrics = calculate(votes(['a', 3], ['b', 5], ['c', FOREIGN]), 'fibonacci');
      expect(metrics.distribution).toEqual({ '3': 1, '5': 1, banana: 1 });
      expect(metrics.numericVoteCount).toBe(2);
      expect(metrics.average).toBe(4);
      expect(metrics.spread).toBe(2);
      expect(metrics.mode).toBe(3);
      expect(metrics.outliers).not.toContain('c');
    });

    it('treats a round of only foreign values as insufficient data', () => {
      const metrics = calculate(votes(['a', FOREIGN], ['b', FOREIGN]), 'fibonacci');
      expect(metrics.distribution).toEqual({ banana: 2 });
      expect(metrics.numericVoteCount).toBe(0);
      expect(metrics.insufficientData).toBe(true);
      expect(metrics.average).toBeNull();
      expect(metrics.mode).toBeNull();
      expect(metrics.spread).toBeNull();
    });
  });

  describe('unknown voting-system id (Requirement 15.11)', () => {
    it('returns empty outliers without throwing', () => {
      // On power-of-2 these same votes would flag 'b'.
      const selections = votes(['a', 0], ['b', 64]);
      expect(calculate(selections, 'power-of-2').outliers).toEqual(['b']);

      let metrics: ReturnType<typeof calculate> | undefined;
      expect(() => {
        metrics = calculate(selections, 'no-such-system');
      }).not.toThrow();
      expect(metrics?.outliers).toEqual([]);
      // numeric statistics are unaffected by the unknown system id
      expect(metrics?.average).toBe(32);
      expect(metrics?.spread).toBe(64);
    });
  });
});
