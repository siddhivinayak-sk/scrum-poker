import * as fc from 'fast-check';
import { DEFAULT_SESSION_CONFIG } from '../../../../shared/types';
import { GameSession } from '../game-session';

/**
 * Property 3: Display name uniqueness with case-insensitive comparison
 *
 * For any game session with a set of participants, `hasDisplayName(name)` SHALL return
 * `true` if and only if there exists a participant whose display name, when trimmed and
 * lowercased, equals the trimmed and lowercased input name. Furthermore, after removing
 * a participant, `hasDisplayName` with that participant's name SHALL return `false`.
 *
 * **Validates: Requirements 2.1, 2.4, 2.5**
 */
describe('Property 3: Display name uniqueness with case-insensitive comparison', () => {
  it('hasDisplayName returns true iff a participant with matching trimmed+lowercased name exists', () => {
    fc.assert(
      fc.property(
        fc.record({
          existingNames: fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 10 }),
          candidateName: fc.string({ minLength: 1 }),
        }),
        ({ existingNames, candidateName }) => {
          const session = new GameSession('test-session', 'owner-1', DEFAULT_SESSION_CONFIG);

          // Add participants with the existing names
          for (let i = 0; i < existingNames.length; i++) {
            session.addParticipant({
              id: `user-${i}`,
              displayName: existingNames[i],
              role: 'participant',
              isAnonymous: false,
            });
          }

          // Check: hasDisplayName should return true iff any existing name matches
          // the candidate when both are trimmed and lowercased
          const normalizedCandidate = candidateName.trim().toLowerCase();
          const expectedMatch = existingNames.some(
            (name) => name.trim().toLowerCase() === normalizedCandidate,
          );

          expect(session.hasDisplayName(candidateName)).toBe(expectedMatch);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('hasDisplayName is case-insensitive: upper/lower/mixed case variants all match', () => {
    fc.assert(
      fc.property(
        fc.record({
          existingNames: fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 10 }),
        }),
        fc.constantFrom('toUpperCase', 'toLowerCase') as fc.Arbitrary<'toUpperCase' | 'toLowerCase'>,
        ({ existingNames }, caseTransform) => {
          const session = new GameSession('test-session', 'owner-1', DEFAULT_SESSION_CONFIG);

          // Add participants with the existing names
          for (let i = 0; i < existingNames.length; i++) {
            session.addParticipant({
              id: `user-${i}`,
              displayName: existingNames[i],
              role: 'participant',
              isAnonymous: false,
            });
          }

          // For each existing name, applying a case transformation should still match
          for (const name of existingNames) {
            const transformed = name[caseTransform]();
            // If the name has non-empty trimmed content, the transformed version should match
            if (name.trim().length > 0) {
              expect(session.hasDisplayName(transformed)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('hasDisplayName returns false after removing the participant with that name', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 10 }),
        fc.nat(),
        (names, removeIndexRaw) => {
          const session = new GameSession('test-session', 'owner-1', DEFAULT_SESSION_CONFIG);

          // Use unique normalized names to avoid ambiguity
          const uniqueNames: Array<{ id: string; name: string }> = [];
          const seenNormalized = new Set<string>();
          for (let i = 0; i < names.length; i++) {
            const normalized = names[i].trim().toLowerCase();
            if (normalized.length > 0 && !seenNormalized.has(normalized)) {
              seenNormalized.add(normalized);
              uniqueNames.push({ id: `user-${i}`, name: names[i] });
            }
          }

          // Need at least one unique participant to test removal
          if (uniqueNames.length === 0) return;

          // Add participants
          for (const { id, name } of uniqueNames) {
            session.addParticipant({
              id,
              displayName: name,
              role: 'participant',
              isAnonymous: false,
            });
          }

          // Pick a participant to remove
          const removeIndex = removeIndexRaw % uniqueNames.length;
          const removedParticipant = uniqueNames[removeIndex];

          // Verify name exists before removal
          expect(session.hasDisplayName(removedParticipant.name)).toBe(true);

          // Remove the participant
          session.removeParticipant(removedParticipant.id);

          // After removal, hasDisplayName should return false for that name
          expect(session.hasDisplayName(removedParticipant.name)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});
