import { readFileSync } from 'fs';
import { join } from 'path';
import type { ExtendedCardValue } from '../types';
import {
  EMPTY_PROXIMITY,
  FAR_THRESHOLD,
  NEAR_THRESHOLD,
  classifyProximity,
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
