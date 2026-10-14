import { describe, it, expect } from 'vitest';
import {
  ANIMATION_BUDGET,
  AnimationBudget,
  ENTRANCE_MS,
  STAGGER_MAX_MS,
  STAGGER_MIN_MS,
  STAGGER_WINDOW_MS,
  computeStagger,
} from './callout-animation';

/** Total time for the staggered sequence: entrance of the last name starts after (n - 1) steps. */
function sequenceMs(nameCount: number): number {
  return ENTRANCE_MS + Math.max(0, nameCount - 1) * computeStagger(nameCount);
}

describe('computeStagger (R5.3)', () => {
  it('stays within 40-90 ms for every name count from 1 to 8', () => {
    for (let n = 1; n <= 8; n++) {
      const step = computeStagger(n);
      expect(step).toBeGreaterThanOrEqual(STAGGER_MIN_MS);
      expect(step).toBeLessThanOrEqual(STAGGER_MAX_MS);
    }
  });

  it('keeps the whole sequence inside 900 ms for every name count from 1 to 8', () => {
    for (let n = 1; n <= 8; n++) {
      expect(sequenceMs(n)).toBeLessThanOrEqual(STAGGER_WINDOW_MS);
    }
  });

  it('uses the maximum interval for one or two names and shrinks as names are added', () => {
    expect(computeStagger(1)).toBe(STAGGER_MAX_MS);
    expect(computeStagger(2)).toBe(STAGGER_MAX_MS);
    expect(computeStagger(8)).toBeLessThan(computeStagger(4));
    expect(computeStagger(8)).toBe(68);
  });

  it('never increases as the name count grows', () => {
    for (let n = 1; n < 40; n++) {
      expect(computeStagger(n + 1)).toBeLessThanOrEqual(computeStagger(n));
    }
  });

  it('keeps the whole sequence inside 900 ms up to 13 names, the last count the 40 ms floor can serve', () => {
    for (let n = 1; n <= 13; n++) {
      expect(sequenceMs(n)).toBeLessThanOrEqual(STAGGER_WINDOW_MS);
    }
  });

  it('clamps to the 40 ms floor for large counts', () => {
    for (const n of [14, 24, 25, 100, 1000]) {
      expect(computeStagger(n)).toBe(STAGGER_MIN_MS);
    }
  });

  it('returns a value inside 40-90 ms for zero, negative, fractional and non-finite counts', () => {
    for (const n of [0, -1, -100, 2.7, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const step = computeStagger(n);
      expect(step).toBeGreaterThanOrEqual(STAGGER_MIN_MS);
      expect(step).toBeLessThanOrEqual(STAGGER_MAX_MS);
    }
  });
});

describe('AnimationBudget (R5.12, R5.13)', () => {
  it('defaults to the 24-element capacity', () => {
    const budget = new AnimationBudget();
    expect(ANIMATION_BUDGET).toBe(24);
    expect(budget.capacity).toBe(24);
    expect(budget.inFlight).toBe(0);
  });

  it('grants a request that fits and tracks it as in flight', () => {
    const budget = new AnimationBudget();
    expect(budget.acquire(10)).toBe(10);
    expect(budget.inFlight).toBe(10);
  });

  it('grants only what remains and never exceeds capacity', () => {
    const budget = new AnimationBudget(5);
    expect(budget.acquire(3)).toBe(3);
    expect(budget.acquire(4)).toBe(2);
    expect(budget.inFlight).toBe(5);
    expect(budget.acquire(1)).toBe(0);
    expect(budget.inFlight).toBe(5);
  });

  it('frees shares on release so they can be acquired again', () => {
    const budget = new AnimationBudget(5);
    budget.acquire(5);
    budget.release(2);
    expect(budget.inFlight).toBe(3);
    expect(budget.acquire(4)).toBe(2);
    expect(budget.inFlight).toBe(5);
  });

  it('clamps an over-release at zero', () => {
    const budget = new AnimationBudget(5);
    budget.acquire(2);
    budget.release(10);
    expect(budget.inFlight).toBe(0);
  });

  it('treats negative, fractional and non-finite requests safely', () => {
    const budget = new AnimationBudget(5);
    expect(budget.acquire(-3)).toBe(0);
    expect(budget.acquire(Number.NaN)).toBe(0);
    expect(budget.acquire(Number.POSITIVE_INFINITY)).toBe(0);
    expect(budget.inFlight).toBe(0);
    expect(budget.acquire(2.9)).toBe(2);
    budget.release(-4);
    budget.release(Number.NaN);
    expect(budget.inFlight).toBe(2);
  });

  it('plans all names when the budget is free', () => {
    const budget = new AnimationBudget();
    expect(budget.plan(8)).toBe(8);
    expect(budget.plan(0)).toBe(0);
  });

  it('plans only the first 24 names and leaves the surplus at rest', () => {
    const budget = new AnimationBudget();
    expect(budget.plan(24)).toBe(24);
    expect(budget.plan(25)).toBe(24);
    expect(budget.plan(100)).toBe(24);
  });

  it('plans against the shares still free and does not change the held count', () => {
    const budget = new AnimationBudget(10);
    budget.acquire(7);
    expect(budget.plan(8)).toBe(3);
    expect(budget.plan(2)).toBe(2);
    expect(budget.inFlight).toBe(7);
  });

  it('plans zero names when the budget is exhausted', () => {
    const budget = new AnimationBudget(4);
    budget.acquire(4);
    expect(budget.plan(6)).toBe(0);
  });

  it('plans zero for negative and non-finite name counts', () => {
    const budget = new AnimationBudget();
    expect(budget.plan(-5)).toBe(0);
    expect(budget.plan(Number.NaN)).toBe(0);
  });

  it('falls back to the default or zero capacity for invalid capacities', () => {
    expect(new AnimationBudget(Number.NaN).capacity).toBe(ANIMATION_BUDGET);
    expect(new AnimationBudget(Number.POSITIVE_INFINITY).capacity).toBe(ANIMATION_BUDGET);
    expect(new AnimationBudget(-3).capacity).toBe(0);
    expect(new AnimationBudget(3.9).capacity).toBe(3);
    expect(new AnimationBudget(0).acquire(1)).toBe(0);
  });
});
