import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeProgress } from './facilitator-flow.component';

/**
 * Property 12: Facilitator progress computation
 *
 * For any issue list, the progress indicator SHALL report `estimated` as the
 * count of issues with status `'estimated'` and `total` as the total number
 * of issues in the list.
 *
 * **Validates: Requirements 10.5**
 */
describe('Property 12: Facilitator progress computation', () => {
  const issueStatusArb = fc.constantFrom('pending', 'estimating', 'estimated');

  const issueArb = fc.record({
    status: issueStatusArb,
  });

  const issueListArb = fc.array(issueArb, { minLength: 0, maxLength: 50 });

  it('should report estimated count equal to the number of issues with status "estimated"', () => {
    fc.assert(
      fc.property(issueListArb, (issues) => {
        const result = computeProgress(issues);
        const expectedEstimated = issues.filter((i) => i.status === 'estimated').length;
        expect(result.estimated).toBe(expectedEstimated);
      }),
      { numRuns: 200 },
    );
  });

  it('should report total equal to the total number of issues in the list', () => {
    fc.assert(
      fc.property(issueListArb, (issues) => {
        const result = computeProgress(issues);
        expect(result.total).toBe(issues.length);
      }),
      { numRuns: 200 },
    );
  });

  it('should return { estimated: 0, total: 0 } for an empty list', () => {
    const result = computeProgress([]);
    expect(result.estimated).toBe(0);
    expect(result.total).toBe(0);
  });

  it('should satisfy estimated <= total for any issue list', () => {
    fc.assert(
      fc.property(issueListArb, (issues) => {
        const result = computeProgress(issues);
        expect(result.estimated).toBeLessThanOrEqual(result.total);
      }),
      { numRuns: 200 },
    );
  });
});
