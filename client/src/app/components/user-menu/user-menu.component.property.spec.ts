import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { getAvatarLetter } from './user-menu.component';

/**
 * Property 18: Avatar first-letter extraction
 *
 * For any non-empty user display name, the avatar SHALL display
 * the uppercase form of the first character of the display name.
 *
 * **Validates: Requirements 23.1**
 */
describe('Property 18: Avatar first-letter extraction', () => {
  it('should return the uppercase first character of any non-empty display name', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        (name) => {
          const result = getAvatarLetter(name);
          const expected = name.charAt(0).toUpperCase();
          expect(result).toBe(expected);
        }
      ),
      { numRuns: 100 }
    );
  });
});
