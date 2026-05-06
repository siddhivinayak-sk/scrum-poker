import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { calculateBackoff } from './websocket.service';

/**
 * Property 15: Exponential backoff calculation
 *
 * For any sequence of consecutive failed WebSocket reconnection attempts
 * (indexed 0, 1, 2, ...), the backoff delay for attempt n SHALL equal
 * min(2^n * 1000, 30000) milliseconds.
 *
 * **Validates: Requirements 15.4**
 */
describe('Property 15: Exponential backoff calculation', () => {
  it('should compute delay = min(2^n * 1000, 30000) for any attempt index 0–20', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (attempt) => {
        const expected = Math.min(Math.pow(2, attempt) * 1000, 30000);
        const actual = calculateBackoff(attempt);
        expect(actual).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });
});
