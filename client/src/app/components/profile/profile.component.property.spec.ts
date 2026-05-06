import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { toggleRole, applyRoleChange } from './profile.component';
import { User } from '@shared/types';

/**
 * Arbitrary for generating a User with participant role.
 */
const arbUser: fc.Arbitrary<User> = fc.record({
  id: fc.uuid(),
  displayName: fc.string({ minLength: 1, maxLength: 50 }),
  role: fc.constant('participant' as const),
  isAnonymous: fc.boolean(),
});

/**
 * Property 2: Role change round-trip
 *
 * For any user, changing their role from 'participant' to 'moderator'
 * and then back to 'participant' SHALL restore the original role state
 * with participant-level privileges.
 *
 * **Validates: Requirements 4.3, 4.4**
 */
describe('Property 2: Role change round-trip', () => {
  it('should restore original role after participant → moderator → participant', () => {
    fc.assert(
      fc.property(arbUser, (user) => {
        // Start as participant
        expect(user.role).toBe('participant');

        // Change to moderator
        const moderatorRole = toggleRole(user.role);
        expect(moderatorRole).toBe('moderator');
        const asModerator = applyRoleChange(user, moderatorRole);
        expect(asModerator.role).toBe('moderator');

        // Change back to participant
        const participantRole = toggleRole(asModerator.role);
        expect(participantRole).toBe('participant');
        const asParticipant = applyRoleChange(asModerator, participantRole);
        expect(asParticipant.role).toBe('participant');

        // Verify full round-trip: all other fields unchanged, role restored
        expect(asParticipant.id).toBe(user.id);
        expect(asParticipant.displayName).toBe(user.displayName);
        expect(asParticipant.isAnonymous).toBe(user.isAnonymous);
        expect(asParticipant.role).toBe(user.role);
      }),
      { numRuns: 100 }
    );
  });

  it('should be idempotent: double toggle returns to original role', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('participant' as const, 'moderator' as const),
        (startRole) => {
          const toggled = toggleRole(startRole);
          const doubleToggled = toggleRole(toggled);
          expect(doubleToggled).toBe(startRole);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('should always produce the opposite role on a single toggle', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('participant' as const, 'moderator' as const),
        (role) => {
          const toggled = toggleRole(role);
          expect(toggled).not.toBe(role);
          expect(['moderator', 'participant']).toContain(toggled);
        }
      ),
      { numRuns: 100 }
    );
  });
});
