import * as fc from 'fast-check';
import { login, _resetStore } from '../auth-service';

/**
 * Property 1: Default role assignment
 *
 * For any user who authenticates (whether with a username or as an anonymous
 * user with a display name), the assigned role SHALL be 'participant'.
 *
 * Validates: Requirements 1.4, 2.4
 */
describe('Property 1: Default role assignment', () => {
  beforeEach(() => {
    _resetStore();
  });

  it('should always assign participant role for any valid username and anonymous flag', () => {
    fc.assert(
      fc.property(
        fc.record({
          username: fc.string({ minLength: 1 }).filter(s => s.trim().length > 0),
          isAnonymous: fc.boolean(),
        }),
        ({ username, isAnonymous }) => {
          const result = login(username, isAnonymous);
          expect(result.user.role).toBe('participant');
        },
      ),
      { numRuns: 100 },
    );
  });
});
