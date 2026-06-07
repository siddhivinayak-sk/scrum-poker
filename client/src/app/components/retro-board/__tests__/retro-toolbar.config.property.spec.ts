import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ALL_FEELING_CATEGORIES,
  FeelingCategory,
} from '@shared/types';

/**
 * Pure logic functions modeling the configuration update behavior.
 * These mirror the server-side RetroSession and retro-handler validation
 * rules for property testing.
 */

/**
 * Model the onFeelingToggle logic from the toolbar + server-side bounds validation.
 * Returns the updated allowedFeelings list or null if the update is rejected.
 *
 * Rules:
 * - Resulting list must have at least 1 entry (min bound)
 * - Resulting list must have at most 10 entries (max bound)
 * - If a removal would result in 0 entries, the removal is rejected
 * - Additions maintain ALL_FEELING_CATEGORIES order
 */
function processConfigUpdate(
  currentAllowed: FeelingCategory[],
  category: FeelingCategory,
  checked: boolean,
): { accepted: boolean; result: FeelingCategory[] } {
  if (checked) {
    // Add category — maintain order from ALL_FEELING_CATEGORIES
    if (currentAllowed.includes(category)) {
      // Already included, no change
      return { accepted: true, result: currentAllowed };
    }
    const updated = ALL_FEELING_CATEGORIES.filter(
      (c) => currentAllowed.includes(c) || c === category,
    );
    // Max bound check (should not exceed 10)
    if (updated.length > 10) {
      return { accepted: false, result: currentAllowed };
    }
    return { accepted: true, result: updated };
  } else {
    // Remove category — enforce minimum-one constraint
    const updated = currentAllowed.filter((c) => c !== category);
    if (updated.length === 0) {
      // Removal rejected: would result in empty list
      return { accepted: false, result: currentAllowed };
    }
    return { accepted: true, result: updated };
  }
}

/**
 * Model the server-side moderator check for config updates.
 * Non-moderators are rejected with UNAUTHORIZED.
 */
interface ConfigUpdateAttempt {
  userId: string;
  role: 'moderator' | 'participant';
  ownerId: string;
  allowedFeelings: FeelingCategory[];
}

function processConfigUpdatePermission(
  attempt: ConfigUpdateAttempt,
): { accepted: boolean; errorCode: string | null } {
  // The server checks if the user is the moderator (owner) of the session
  const isModerator = attempt.role === 'moderator';
  if (!isModerator) {
    return { accepted: false, errorCode: 'UNAUTHORIZED' };
  }
  return { accepted: true, errorCode: null };
}

/**
 * Model the server-side updateConfig logic that clears affected feelings
 * when categories are removed from allowedFeelings.
 */
interface ConfigUpdateState {
  allowedFeelings: FeelingCategory[];
  feelings: Record<string, FeelingCategory | null>;
}

interface ConfigUpdateResult {
  newAllowedFeelings: FeelingCategory[];
  clearedUserIds: string[];
  broadcasts: Array<{ userId: string; category: null }>;
}

function processConfigUpdateWithClearing(
  state: ConfigUpdateState,
  newAllowedFeelings: FeelingCategory[],
): ConfigUpdateResult {
  const removedCategories = state.allowedFeelings.filter(
    (cat) => !newAllowedFeelings.includes(cat),
  );

  const clearedUserIds: string[] = [];
  const broadcasts: Array<{ userId: string; category: null }> = [];

  for (const category of removedCategories) {
    for (const [userId, feeling] of Object.entries(state.feelings)) {
      if (feeling === category) {
        clearedUserIds.push(userId);
        broadcasts.push({ userId, category: null });
      }
    }
  }

  return {
    newAllowedFeelings,
    clearedUserIds,
    broadcasts,
  };
}

// --- Arbitraries ---

/** Arbitrary for a non-empty subset of ALL_FEELING_CATEGORIES (1 to 10 entries), preserving order */
const arbAllowedFeelings: fc.Arbitrary<FeelingCategory[]> = fc
  .subarray(ALL_FEELING_CATEGORIES, { minLength: 1, maxLength: 10 })
  .filter((arr) => arr.length >= 1);

/** Arbitrary for a valid FeelingCategory */
const arbFeelingCategory: fc.Arbitrary<FeelingCategory> = fc.constantFrom(
  ...ALL_FEELING_CATEGORIES,
);

/** Arbitrary for a userId */
const arbUserId: fc.Arbitrary<string> = fc.uuid();

/** Arbitrary for a feelings map keyed by userId */
const arbFeelingsMap: fc.Arbitrary<Record<string, FeelingCategory | null>> = fc
  .array(
    fc.tuple(
      fc.uuid(),
      fc.option(arbFeelingCategory, { nil: null }),
    ),
    { minLength: 0, maxLength: 10 },
  )
  .map((entries) => Object.fromEntries(entries));

/**
 * Feature: retro-participant-feelings, Property 1: allowedFeelings bounds enforcement
 *
 * For any allowedFeelings update attempt, the resulting list SHALL contain at least 1
 * and at most 10 entries. If a removal would result in an empty list, the removal is rejected.
 *
 * **Validates: Requirements 1.1, 1.4**
 */
describe('Feature: retro-participant-feelings, Property 1: allowedFeelings bounds enforcement', () => {
  it('should always produce a list with at least 1 entry after any toggle operation', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        arbFeelingCategory,
        fc.boolean(),
        (currentAllowed, category, checked) => {
          const { result } = processConfigUpdate(currentAllowed, category, checked);

          // The result must always have at least 1 entry
          expect(result.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should always produce a list with at most 10 entries after any toggle operation', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        arbFeelingCategory,
        fc.boolean(),
        (currentAllowed, category, checked) => {
          const { result } = processConfigUpdate(currentAllowed, category, checked);

          // The result must never exceed 10 entries
          expect(result.length).toBeLessThanOrEqual(10);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should reject removal when it would leave the list empty', () => {
    fc.assert(
      fc.property(
        arbFeelingCategory,
        (category) => {
          // Start with a single-item list containing this category
          const currentAllowed: FeelingCategory[] = [category];

          const { accepted, result } = processConfigUpdate(currentAllowed, category, false);

          // Removal must be rejected
          expect(accepted).toBe(false);
          // The list must remain unchanged
          expect(result).toEqual(currentAllowed);
          // Still has at least 1 entry
          expect(result.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should accept removal when the list has more than one entry', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        (currentAllowed) => {
          // Pre-condition: list has more than 1 entry
          fc.pre(currentAllowed.length > 1);

          // Remove the first category
          const categoryToRemove = currentAllowed[0];
          const { accepted, result } = processConfigUpdate(currentAllowed, categoryToRemove, false);

          // Removal must be accepted
          expect(accepted).toBe(true);
          // Result must not contain the removed category
          expect(result).not.toContain(categoryToRemove);
          // Result must still have at least 1 entry
          expect(result.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should accept addition when the list is below maximum', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        arbFeelingCategory,
        (currentAllowed, category) => {
          // Pre-condition: category is not already in the list
          fc.pre(!currentAllowed.includes(category));
          // Pre-condition: list is below max (can add one more)
          fc.pre(currentAllowed.length < 10);

          const { accepted, result } = processConfigUpdate(currentAllowed, category, true);

          // Addition must be accepted
          expect(accepted).toBe(true);
          // Result must contain the new category
          expect(result).toContain(category);
          // Result length is previous + 1
          expect(result.length).toBe(currentAllowed.length + 1);
          // Result must maintain ALL_FEELING_CATEGORIES order
          const indices = result.map((c) => ALL_FEELING_CATEGORIES.indexOf(c));
          for (let i = 1; i < indices.length; i++) {
            expect(indices[i]).toBeGreaterThan(indices[i - 1]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: retro-participant-feelings, Property 2: Non-moderator configuration rejection
 *
 * For any user who is not a moderator, any attempt to modify the allowedFeelings
 * configuration SHALL be rejected and the configuration SHALL remain unchanged.
 *
 * **Validates: Requirements 1.8**
 */
describe('Feature: retro-participant-feelings, Property 2: Non-moderator configuration rejection', () => {
  it('should reject any config update attempt from a non-moderator user', () => {
    fc.assert(
      fc.property(
        arbUserId,
        arbUserId,
        arbAllowedFeelings,
        (userId, ownerId, allowedFeelings) => {
          const attempt: ConfigUpdateAttempt = {
            userId,
            role: 'participant',
            ownerId,
            allowedFeelings,
          };

          const { accepted, errorCode } = processConfigUpdatePermission(attempt);

          // Must be rejected
          expect(accepted).toBe(false);
          // Error code must be UNAUTHORIZED
          expect(errorCode).toBe('UNAUTHORIZED');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should accept config update attempts from a moderator user', () => {
    fc.assert(
      fc.property(
        arbUserId,
        arbUserId,
        arbAllowedFeelings,
        (userId, ownerId, allowedFeelings) => {
          const attempt: ConfigUpdateAttempt = {
            userId,
            role: 'moderator',
            ownerId,
            allowedFeelings,
          };

          const { accepted, errorCode } = processConfigUpdatePermission(attempt);

          // Must be accepted
          expect(accepted).toBe(true);
          // No error code
          expect(errorCode).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should always reject non-moderators regardless of the allowedFeelings content', () => {
    fc.assert(
      fc.property(
        arbUserId,
        arbUserId,
        arbAllowedFeelings,
        arbFeelingCategory,
        fc.boolean(),
        (userId, ownerId, allowedFeelings, _category, _checked) => {
          // Regardless of what change they're trying to make,
          // a non-moderator is always rejected
          const attempt: ConfigUpdateAttempt = {
            userId,
            role: 'participant',
            ownerId,
            allowedFeelings,
          };

          const { accepted, errorCode } = processConfigUpdatePermission(attempt);

          expect(accepted).toBe(false);
          expect(errorCode).toBe('UNAUTHORIZED');
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: retro-participant-feelings, Property 9: Removing a feeling from allowed clears affected participants
 *
 * For any category removed from allowedFeelings, all participants whose current feeling
 * matches that category SHALL have their feeling cleared to null, and a retro:feeling:updated
 * event with null SHALL be broadcast for each affected participant.
 *
 * **Validates: Requirements 1.6, 2.7**
 */
describe('Feature: retro-participant-feelings, Property 9: Removing a feeling from allowed clears affected participants', () => {
  it('should clear all participants whose feeling matches a removed category', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        fc.array(fc.tuple(arbUserId, arbFeelingCategory), { minLength: 1, maxLength: 10 }),
        (allowedFeelings, participants) => {
          // Pre-condition: at least one category can be removed (list has > 1)
          fc.pre(allowedFeelings.length > 1);

          // Build feelings map from participants
          const feelings: Record<string, FeelingCategory | null> = {};
          for (const [userId, category] of participants) {
            feelings[userId] = category;
          }

          // Remove the first category from allowedFeelings
          const categoryToRemove = allowedFeelings[0];
          const newAllowed = allowedFeelings.slice(1);

          const state: ConfigUpdateState = {
            allowedFeelings,
            feelings,
          };

          const result = processConfigUpdateWithClearing(state, newAllowed);

          // Every participant whose feeling was the removed category must be in clearedUserIds
          for (const [userId, feeling] of Object.entries(feelings)) {
            if (feeling === categoryToRemove) {
              expect(result.clearedUserIds).toContain(userId);
            }
          }

          // Every clearedUserId must have had the removed category
          for (const userId of result.clearedUserIds) {
            expect(feelings[userId]).toBe(categoryToRemove);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should broadcast a null feeling update for each affected participant', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        fc.array(fc.tuple(arbUserId, arbFeelingCategory), { minLength: 1, maxLength: 10 }),
        (allowedFeelings, participants) => {
          fc.pre(allowedFeelings.length > 1);

          const feelings: Record<string, FeelingCategory | null> = {};
          for (const [userId, category] of participants) {
            feelings[userId] = category;
          }

          const categoryToRemove = allowedFeelings[0];
          const newAllowed = allowedFeelings.slice(1);

          const state: ConfigUpdateState = {
            allowedFeelings,
            feelings,
          };

          const result = processConfigUpdateWithClearing(state, newAllowed);

          // Each cleared user must have a corresponding broadcast with null
          for (const userId of result.clearedUserIds) {
            const broadcast = result.broadcasts.find((b) => b.userId === userId);
            expect(broadcast).toBeDefined();
            expect(broadcast!.category).toBeNull();
          }

          // Number of broadcasts must equal number of cleared users
          expect(result.broadcasts.length).toBe(result.clearedUserIds.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should not clear participants whose feeling is still in the allowed list', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        fc.array(fc.tuple(arbUserId, arbFeelingCategory), { minLength: 1, maxLength: 10 }),
        (allowedFeelings, participants) => {
          fc.pre(allowedFeelings.length > 1);

          const feelings: Record<string, FeelingCategory | null> = {};
          for (const [userId, category] of participants) {
            feelings[userId] = category;
          }

          const categoryToRemove = allowedFeelings[0];
          const newAllowed = allowedFeelings.slice(1);

          const state: ConfigUpdateState = {
            allowedFeelings,
            feelings,
          };

          const result = processConfigUpdateWithClearing(state, newAllowed);

          // Participants whose feeling is still in the new allowed list must NOT be cleared
          for (const [userId, feeling] of Object.entries(feelings)) {
            if (feeling !== null && newAllowed.includes(feeling)) {
              expect(result.clearedUserIds).not.toContain(userId);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should not clear participants with null feeling when categories are removed', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        fc.array(arbUserId, { minLength: 1, maxLength: 5 }),
        (allowedFeelings, userIds) => {
          fc.pre(allowedFeelings.length > 1);

          // All participants have null feeling
          const feelings: Record<string, FeelingCategory | null> = {};
          for (const userId of userIds) {
            feelings[userId] = null;
          }

          const categoryToRemove = allowedFeelings[0];
          const newAllowed = allowedFeelings.slice(1);

          const state: ConfigUpdateState = {
            allowedFeelings,
            feelings,
          };

          const result = processConfigUpdateWithClearing(state, newAllowed);

          // No participants should be cleared (they all had null)
          expect(result.clearedUserIds.length).toBe(0);
          expect(result.broadcasts.length).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should clear participants when multiple categories are removed at once', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        fc.array(fc.tuple(arbUserId, arbFeelingCategory), { minLength: 1, maxLength: 10 }),
        (allowedFeelings, participants) => {
          // Need at least 3 entries so we can remove 2
          fc.pre(allowedFeelings.length >= 3);

          const feelings: Record<string, FeelingCategory | null> = {};
          for (const [userId, category] of participants) {
            feelings[userId] = category;
          }

          // Remove the first two categories
          const removedCategories = allowedFeelings.slice(0, 2);
          const newAllowed = allowedFeelings.slice(2);

          const state: ConfigUpdateState = {
            allowedFeelings,
            feelings,
          };

          const result = processConfigUpdateWithClearing(state, newAllowed);

          // All participants whose feeling matches any removed category should be cleared
          for (const [userId, feeling] of Object.entries(feelings)) {
            if (feeling !== null && removedCategories.includes(feeling)) {
              expect(result.clearedUserIds).toContain(userId);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
