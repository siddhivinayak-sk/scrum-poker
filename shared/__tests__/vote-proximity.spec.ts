import { readFileSync } from 'fs';
import { join } from 'path';
import type { ExtendedCardValue } from '../types';
import {
  EMPTY_PROXIMITY,
  FAR_THRESHOLD,
  NEAR_THRESHOLD,
  classifyProximity,
  consensusReference,
} from '../vote-proximity';

/**
 * Boundary examples and source scans for the proximity classifier.
 * Fibonacci ladder: [0,1,2,3,5,8,13,21,34,55,89], indices 0..10.
 */

function classify(
  votes: Record<string, ExtendedCardValue>,
  average: number,
  votingSystem = 'fibonacci'
) {
  const selections = new Map<string, ExtendedCardValue>(Object.entries(votes));
  const displayNames = new Map<string, string>(Object.keys(votes).map((id) => [id, id]));
  return classifyProximity({ selections, average, votingSystem, displayNames });
}

const ids = (list: readonly { userId: string }[]) => list.map((p) => p.userId);

describe('classifyProximity boundaries (R1.7, R1.8, R1.9, R13.11)', () => {
  it('exposes the documented thresholds', () => {
    expect(NEAR_THRESHOLD).toBe(0.75);
    expect(FAR_THRESHOLD).toBe(2.0);
  });

  it('distance exactly 0.75 is near (inclusive)', () => {
    // average 4.5 -> position 3 + (4.5-3)/(5-3) = 3.75; card 3 sits at index 3.
    const result = classify({ a: 3 }, 4.5);
    expect(result.distances.get('a')).toBe(0.75);
    expect(ids(result.near)).toEqual(['a']);
    expect(result.far).toEqual([]);
  });

  it('distance exactly 2.0 is far (inclusive)', () => {
    // average 3 -> position 3 exactly; card 8 sits at index 5.
    const result = classify({ a: 8 }, 3);
    expect(result.distances.get('a')).toBe(2);
    expect(ids(result.far)).toEqual(['a']);
    expect(result.near).toEqual([]);
  });

  it('distance 0.750001 is in neither set', () => {
    // average 4.500002 -> position 3.750001; card 3 sits at index 3.
    const result = classify({ a: 3 }, 4.500002);
    expect(result.distances.get('a')).toBe(0.750001);
    expect(result.near).toEqual([]);
    expect(result.far).toEqual([]);
  });

  it('distance 1.999999 is in neither set', () => {
    // average 3.000002 -> position 3.000001; card 8 sits at index 5.
    const result = classify({ a: 8 }, 3.000002);
    expect(result.distances.get('a')).toBe(1.999999);
    expect(result.near).toEqual([]);
    expect(result.far).toEqual([]);
  });
});

describe('consensusReference (mode-based anchor, robust to a single outlier)', () => {
  const ref = (votes: Record<string, ExtendedCardValue>) =>
    consensusReference(new Map<string, ExtendedCardValue>(Object.entries(votes)));

  it('is the mode value, not the mean, when one vote is extreme', () => {
    // mean of 2,2,13 is 5.67; the consensus the callouts care about is 2.
    expect(ref({ a: 2, b: 2, c: 13 })).toBe(2);
  });

  it('breaks a mode tie toward the least value', () => {
    expect(ref({ a: 1, b: 1, c: 8, d: 8 })).toBe(1);
  });

  it('ignores special, t-shirt and absent selections', () => {
    expect(ref({ a: 3, b: 3, c: '?' as ExtendedCardValue })).toBe(3);
  });

  it('is undefined when no numeric vote exists', () => {
    expect(ref({ a: '?' as ExtendedCardValue })).toBeUndefined();
  });
});

describe('classifyProximity anchored on the consensus reference (the reported bug)', () => {
  it('flags the lone extreme voter as far, not the consensus voters', () => {
    // Two votes of 2 (index 2) and one of 13 (index 6). Anchored on the consensus value 2.
    const selections = new Map<string, ExtendedCardValue>([
      ['alice', 2],
      ['bob', 2],
      ['carol', 13],
    ]);
    const displayNames = new Map<string, string>([
      ['alice', 'Alice'],
      ['bob', 'Bob'],
      ['carol', 'Carol'],
    ]);
    const reference = consensusReference(selections)!;
    const result = classifyProximity({
      selections,
      reference,
      votingSystem: 'fibonacci',
      displayNames,
    });

    expect(ids(result.near)).toEqual(['alice', 'bob']);
    expect(ids(result.far)).toEqual(['carol']);
  });
});

describe('classifyProximity ladder handling (R1.14, R1.18)', () => {
  it("modified-fibonacci votes 0, '½', 1 give distances 1, 0, 1", () => {
    const result = classify({ zero: 0, half: '½', one: 1 }, 0.5, 'modified-fibonacci');
    expect(result.distances.get('zero')).toBe(1);
    expect(result.distances.get('half')).toBe(0);
    expect(result.distances.get('one')).toBe(1);
    expect(ids(result.near)).toEqual(['half']);
    expect(result.far).toEqual([]);
  });

  it('t-shirt returns EMPTY_PROXIMITY by value', () => {
    const result = classify({ a: 'M', b: 'L' }, 2, 't-shirt');
    expect(result).toEqual(EMPTY_PROXIMITY);
    expect(result.near).toEqual([]);
    expect(result.far).toEqual([]);
    expect(result.distances.size).toBe(0);
  });
});

describe('classifyProximity performance (R1.20)', () => {
  it('classifies 100 selections in under 50 ms', () => {
    const votes: Record<string, ExtendedCardValue> = {};
    const cards: ExtendedCardValue[] = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
    for (let i = 0; i < 100; i++) votes[`user-${i}`] = cards[i % cards.length];

    const start = performance.now();
    const result = classify(votes, 12.5);
    const elapsed = performance.now() - start;

    expect(result.distances.size).toBe(100);
    expect(elapsed).toBeLessThan(50);
  });
});

describe('vote-proximity.ts source scans', () => {
  const source = readFileSync(join(__dirname, '..', 'vote-proximity.ts'), 'utf8');

  it('never mentions `outliers` (R1.15)', () => {
    expect(source).not.toContain('outliers');
  });

  it.each([
    ['Date', /\bDate\b/],
    ['Math.random', /\bMath\s*\.\s*random\b/],
    ['window', /\bwindow\b/],
    ['process', /\bprocess\b/],
  ])('has no `%s` reference (R1.17)', (_name, pattern) => {
    expect(source).not.toMatch(pattern);
  });
});
