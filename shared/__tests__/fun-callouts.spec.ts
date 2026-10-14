import * as fc from 'fast-check';
import { DEFAULT_SESSION_CONFIG, resolveFunCallouts } from '../types';

/**
 * **Validates: Requirements 6.5, 6.6, 6.11**
 *
 * `resolveFunCallouts` is the single coercion point for the `funCallouts` default:
 * the supplied boolean when it is a boolean, otherwise `true`.
 */

/** Every shape a `funCallouts` value can arrive in across the WS/REST boundary. */
const funCalloutsValueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.boolean(),
  fc.constant(undefined),
  fc.constant(null),
  fc.string(),
  fc.integer(),
  fc.double(),
  fc.object(),
  fc.array(fc.anything())
);

describe('resolveFunCallouts', () => {
  it('property: returns the boolean when given a boolean, otherwise true', () => {
    fc.assert(
      fc.property(funCalloutsValueArb, (value) => {
        const expected = typeof value === 'boolean' ? value : true;
        expect(resolveFunCallouts(value)).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  it('keeps explicit booleans and defaults everything else to true', () => {
    expect(resolveFunCallouts(true)).toBe(true);
    expect(resolveFunCallouts(false)).toBe(false);
    expect(resolveFunCallouts(undefined)).toBe(true);
    expect(resolveFunCallouts(null)).toBe(true);
    expect(resolveFunCallouts('false')).toBe(true);
    expect(resolveFunCallouts(0)).toBe(true);
    expect(resolveFunCallouts({})).toBe(true);
    expect(resolveFunCallouts([])).toBe(true);
  });
});

describe('DEFAULT_SESSION_CONFIG.funCallouts', () => {
  it('defaults to true', () => {
    expect(DEFAULT_SESSION_CONFIG.funCallouts).toBe(true);
  });
});
