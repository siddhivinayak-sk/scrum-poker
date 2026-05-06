import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { User } from '@shared/types';

/**
 * Pure function that computes the list of removable participants.
 * A moderator can remove all participants except themselves.
 */
export function getRemovableParticipants(
  participants: User[],
  moderatorId: string
): User[] {
  return participants.filter((p) => p.id !== moderatorId);
}

/**
 * Arbitrary for generating a User with a unique id and non-empty displayName.
 */
const arbUser: fc.Arbitrary<User> = fc.record({
  id: fc.uuid(),
  displayName: fc.string({ minLength: 1, maxLength: 30 }),
  role: fc.constantFrom('moderator' as const, 'participant' as const),
  isAnonymous: fc.boolean(),
});

/**
 * Arbitrary for generating a participant list with exactly one moderator.
 * Returns { participants, moderatorId }.
 */
const arbParticipantsWithModerator = fc
  .tuple(
    fc.uuid(), // moderator ID
    fc.string({ minLength: 1, maxLength: 30 }), // moderator display name
    fc.boolean(), // moderator isAnonymous
    fc.array(arbUser, { minLength: 0, maxLength: 20 }) // other participants
  )
  .map(([moderatorId, moderatorName, moderatorAnon, others]) => {
    const moderator: User = {
      id: moderatorId,
      displayName: moderatorName,
      role: 'moderator',
      isAnonymous: moderatorAnon,
    };
    // Ensure no other participant has the same ID as the moderator
    const filteredOthers = others
      .filter((u) => u.id !== moderatorId)
      .map((u) => ({ ...u, role: 'participant' as const }));
    // Ensure unique IDs among others
    const seen = new Set<string>([moderatorId]);
    const uniqueOthers = filteredOthers.filter((u) => {
      if (seen.has(u.id)) return false;
      seen.add(u.id);
      return true;
    });
    return {
      participants: [moderator, ...uniqueOthers],
      moderatorId,
    };
  });

/**
 * Property 1: Removable participants excludes self
 *
 * For any participant list containing a moderator, the set of participants
 * eligible for removal SHALL include all participants except the moderator
 * themselves. The moderator's own ID SHALL never appear in the removable set.
 *
 * **Validates: Requirements 1.1, 1.5**
 */
describe('Property 1: Removable participants excludes self', () => {
  it('should never include the moderator ID in the removable set', () => {
    fc.assert(
      fc.property(arbParticipantsWithModerator, ({ participants, moderatorId }) => {
        const removable = getRemovableParticipants(participants, moderatorId);

        // The moderator's own ID should never appear in the removable set
        const removableIds = removable.map((p) => p.id);
        expect(removableIds).not.toContain(moderatorId);
      }),
      { numRuns: 200 }
    );
  });

  it('should include all non-moderator participants in the removable set', () => {
    fc.assert(
      fc.property(arbParticipantsWithModerator, ({ participants, moderatorId }) => {
        const removable = getRemovableParticipants(participants, moderatorId);

        // All participants except the moderator should be removable
        const expectedRemovable = participants.filter((p) => p.id !== moderatorId);
        expect(removable.length).toBe(expectedRemovable.length);

        // Every non-moderator participant should be in the removable set
        for (const p of expectedRemovable) {
          expect(removable.some((r) => r.id === p.id)).toBe(true);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('should return empty set when moderator is the only participant', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 30 }),
        (moderatorId, displayName) => {
          const participants: User[] = [
            { id: moderatorId, displayName, role: 'moderator', isAnonymous: false },
          ];
          const removable = getRemovableParticipants(participants, moderatorId);
          expect(removable.length).toBe(0);
        }
      ),
      { numRuns: 50 }
    );
  });
});
