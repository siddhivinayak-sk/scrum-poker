import * as fc from 'fast-check';
import { resolveFluidCardHeight } from '../types';

/**
 * **Validates: Requirements 6.1, 6.3, 13.4**
 *
 * Property 10: fluidCardHeight default resolution
 *
 * For any value supplied for `fluidCardHeight` — absent, `true`, `false`, or any
 * non-boolean — the resolved value is the supplied boolean when it is a boolean
 * and `true` otherwise.
 */

/** Every shape a `fluidCardHeight` value can arrive in across the WS/REST boundary. */
const fluidCardHeightValueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.boolean(),
  fc.constant(undefined),
  fc.string(),
  fc.integer(),
  fc.constant(null),
  fc.object()
);

describe('Property 10: fluidCardHeight default resolution', () => {
  it('resolves to the supplied boolean, and to true for every non-boolean', () => {
    fc.assert(
      fc.property(fluidCardHeightValueArb, (value) => {
        const expected = typeof value === 'boolean' ? value : true;
        expect(resolveFluidCardHeight(value)).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  it('is idempotent: resolving a resolved value yields the same boolean', () => {
    fc.assert(
      fc.property(fluidCardHeightValueArb, (value) => {
        const once = resolveFluidCardHeight(value);
        expect(resolveFluidCardHeight(once)).toBe(once);
      }),
      { numRuns: 100 }
    );
  });
});
