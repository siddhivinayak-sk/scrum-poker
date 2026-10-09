import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { getAvatarLetter } from './user-menu.component';

/**
 * Property 18: Avatar initial extraction
 *
 * For any user display name, the avatar SHALL display the uppercase form of
 * the first non-whitespace character of the display name, and no initial at
 * all when the name holds no non-whitespace character.
 *
 * **Validates: Requirements 12.3, 12.10**
 */
describe('Property 18: Avatar initial extraction', () => {
  it('should return the uppercase first non-whitespace character of any display name', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 50 }), (name) => {
        const leading = name.trimStart();
        const expected = leading === '' ? '' : [...leading][0].toUpperCase();
        expect(getAvatarLetter(name)).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  it('should return no initial for whitespace-only display names', () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(' ', '\t', '\n', '\r', '\u00a0'),
          minLength: 1,
          maxLength: 20,
        }),
        (name) => {
          expect(getAvatarLetter(name)).toBe('');
        }
      ),
      { numRuns: 100 }
    );
  });
});
