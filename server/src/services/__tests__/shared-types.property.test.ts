import * as fc from 'fast-check';
import {
  VotingSystemType,
  VOTING_SYSTEMS,
  SPECIAL_CARDS,
  ExtendedCardValue,
  getCardsForVotingSystem,
  PermissionMode,
  PermissionConfig,
  hasPermission,
  formatDuration,
} from '../../../../shared/types';

/**
 * Property 5: Voting system card mapping
 *
 * For any voting system type (fibonacci, modified-fibonacci, t-shirt, power-of-2),
 * the function `getCardsForVotingSystem` SHALL return exactly the card values
 * defined for that system plus the three special cards (coffee, no-clue, break),
 * with no duplicates and no missing values.
 *
 * Validates: Requirements 7.3, 7.4, 7.5, 7.6, 7.7
 */
describe('Property 5: Voting system card mapping', () => {
  it('returns exactly the defined card values plus the three special cards, with no duplicates and no missing values', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<VotingSystemType>('fibonacci', 'modified-fibonacci', 't-shirt', 'power-of-2'),
        (system: VotingSystemType) => {
          const result = getCardsForVotingSystem(system);
          const systemCards = VOTING_SYSTEMS[system];
          const expectedCards: ExtendedCardValue[] = [...systemCards, ...SPECIAL_CARDS];

          // Result should contain exactly the expected number of cards
          expect(result.length).toBe(expectedCards.length);

          // All system-specific cards should be present
          for (const card of systemCards) {
            expect(result).toContainEqual(card);
          }

          // All three special cards should be present
          for (const special of SPECIAL_CARDS) {
            expect(result).toContainEqual(special);
          }

          // No duplicates: convert to strings for comparison since values can be numbers or strings
          const resultAsStrings = result.map((v) => String(v));
          const uniqueValues = new Set(resultAsStrings);
          expect(uniqueValues.size).toBe(result.length);

          // Result should match expected cards exactly (same elements, same order)
          expect(result).toEqual(expectedCards);
        },
      ),
      { numRuns: 100 },
    );
  });
});
/**
 * Property 6: Permission evaluation correctness
 *
 * For any user with a role (moderator or participant), and for any permission
 * configuration (moderator-only, all-players, or select-specific with a set of
 * allowed user IDs), the `hasPermission` function SHALL return `true` if and only if:
 *   (a) the mode is `moderator-only` and the user's role is `moderator`, OR
 *   (b) the mode is `all-players`, OR
 *   (c) the mode is `select-specific` and the user is either a moderator or
 *       their ID is in the allowed list.
 *
 * Validates: Requirements 8.3, 8.4, 8.5, 9.3, 9.4, 9.5
 */
describe('Property 6: Permission evaluation correctness', () => {
  const arbPermissionInput = fc.record({
    role: fc.constantFrom<'moderator' | 'participant'>('moderator', 'participant'),
    userId: fc.uuid(),
    mode: fc.constantFrom<PermissionMode>('moderator-only', 'all-players', 'select-specific'),
    allowedIds: fc.array(fc.uuid()),
  });

  it('hasPermission returns true iff the specification conditions are met', () => {
    fc.assert(
      fc.property(arbPermissionInput, ({ role, userId, mode, allowedIds }) => {
        const permissionConfig: PermissionConfig = {
          mode,
          allowedUserIds: allowedIds,
        };

        const result = hasPermission(userId, role, permissionConfig);

        // Compute expected result based on the specification
        let expected: boolean;
        switch (mode) {
          case 'moderator-only':
            expected = role === 'moderator';
            break;
          case 'all-players':
            expected = true;
            break;
          case 'select-specific':
            expected = role === 'moderator' || allowedIds.includes(userId);
            break;
        }

        expect(result).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it('select-specific mode grants access when userId is in allowedUserIds', () => {
    fc.assert(
      fc.property(
        fc.record({
          role: fc.constantFrom<'moderator' | 'participant'>('moderator', 'participant'),
          userId: fc.uuid(),
          otherIds: fc.array(fc.uuid()),
        }),
        ({ role, userId, otherIds }) => {
          // Ensure userId is in the allowed list
          const allowedIds = [...otherIds, userId];
          const permissionConfig: PermissionConfig = {
            mode: 'select-specific',
            allowedUserIds: allowedIds,
          };

          const result = hasPermission(userId, role, permissionConfig);

          // Should always be true: moderator always has access, and participant's ID is in the list
          expect(result).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('select-specific mode denies participant access when userId is NOT in allowedUserIds', () => {
    fc.assert(
      fc.property(
        fc.record({
          userId: fc.uuid(),
          otherIds: fc.array(fc.uuid()),
        }),
        ({ userId, otherIds }) => {
          // Filter out the userId to ensure it's not in the allowed list
          const allowedIds = otherIds.filter((id) => id !== userId);
          const permissionConfig: PermissionConfig = {
            mode: 'select-specific',
            allowedUserIds: allowedIds,
          };

          const result = hasPermission(userId, 'participant', permissionConfig);

          // Participant not in the list should be denied
          expect(result).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 9: Timer format display
 *
 * For any non-negative duration in milliseconds, the `formatDuration` function
 * SHALL produce a string in `MM:SS` format where MM is the total minutes
 * (zero-padded to 2 digits) and SS is the remaining seconds (zero-padded to
 * 2 digits).
 *
 * Validates: Requirements 12.5
 */
describe('Property 9: Timer format display', () => {
  it('produces MM:SS format with zero-padded minutes and seconds for any non-negative duration', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5999000 }),
        (ms: number) => {
          const result = formatDuration(ms);

          // Output always matches MM:SS pattern
          expect(result).toMatch(/^\d{2}:\d{2}$/);

          // Parse the result
          const [minuteStr, secondStr] = result.split(':');
          const minutes = parseInt(minuteStr, 10);
          const seconds = parseInt(secondStr, 10);

          // Compute expected values from input
          const totalSeconds = Math.floor(ms / 1000);
          const expectedMinutes = Math.floor(totalSeconds / 60);
          const expectedSeconds = totalSeconds % 60;

          // Minutes and seconds are correctly computed
          expect(minutes).toBe(expectedMinutes);
          expect(seconds).toBe(expectedSeconds);

          // Seconds are always in range 0-59
          expect(seconds).toBeGreaterThanOrEqual(0);
          expect(seconds).toBeLessThanOrEqual(59);

          // Format is always zero-padded to 2 digits
          expect(minuteStr.length).toBe(2);
          expect(secondStr.length).toBe(2);
        },
      ),
      { numRuns: 100 },
    );
  });
});
