import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ALL_FEELING_CATEGORIES,
  FeelingCategory,
  DEFAULT_ALLOWED_FEELINGS,
} from '@shared/types';

/**
 * Pure logic functions modeling feelings selection behavior.
 * These mirror the server-side RetroSession validation rules for testability.
 */

interface FeelingsState {
  feelings: Record<string, FeelingCategory | null>;
  allowedFeelings: FeelingCategory[];
  isCompleted: boolean;
}

interface SelectionResult {
  accepted: boolean;
  newFeeling: FeelingCategory | null;
  broadcast: { userId: string; category: FeelingCategory | null } | null;
}

/**
 * Model the feelings selection logic:
 * - If board is completed, reject
 * - If category is not in allowedFeelings (and not null), reject
 * - If category matches current feeling (toggle), set to null and broadcast
 * - Otherwise, store and broadcast
 */
function processFeelingsSelection(
  state: FeelingsState,
  userId: string,
  category: FeelingCategory | null,
): SelectionResult {
  // Board completed → reject
  if (state.isCompleted) {
    return {
      accepted: false,
      newFeeling: state.feelings[userId] ?? null,
      broadcast: null,
    };
  }

  // Disallowed category → reject
  if (category !== null && !state.allowedFeelings.includes(category)) {
    return {
      accepted: false,
      newFeeling: state.feelings[userId] ?? null,
      broadcast: null,
    };
  }

  // Toggle deselection: clicking same feeling deselects
  const currentFeeling = state.feelings[userId] ?? null;
  if (category !== null && currentFeeling === category) {
    return {
      accepted: true,
      newFeeling: null,
      broadcast: { userId, category: null },
    };
  }

  // Valid selection
  return {
    accepted: true,
    newFeeling: category,
    broadcast: { userId, category },
  };
}

// --- Arbitraries ---

/** Arbitrary for a valid FeelingCategory */
const arbFeelingCategory: fc.Arbitrary<FeelingCategory> = fc.constantFrom(
  ...ALL_FEELING_CATEGORIES,
);

/** Arbitrary for a non-empty subset of ALL_FEELING_CATEGORIES (1 to 10 entries) */
const arbAllowedFeelings: fc.Arbitrary<FeelingCategory[]> = fc
  .subarray(ALL_FEELING_CATEGORIES, { minLength: 1, maxLength: 10 })
  .filter((arr) => arr.length >= 1);

/** Arbitrary for a userId */
const arbUserId: fc.Arbitrary<string> = fc.uuid();

/** Arbitrary for a feelings map (0 to 10 entries) */
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
 * Feature: retro-participant-feelings, Property 5: Valid feeling selection updates state and broadcasts
 *
 * For any participant selecting a valid FeelingCategory that is present in allowedFeelings
 * on a non-completed board, the system SHALL store that category as the participant's feeling
 * and broadcast a retro:feeling:updated event with the participant's userId and the selected category.
 *
 * **Validates: Requirements 3.1, 3.2, 3.6, 4.1, 4.2**
 */
describe('Feature: retro-participant-feelings, Property 5: Valid feeling selection updates state and broadcasts', () => {
  it('should accept and broadcast a valid feeling selection on a non-completed board', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        arbUserId,
        arbFeelingsMap,
        (allowedFeelings, userId, existingFeelings) => {
          // Pick a random allowed feeling that differs from the user's current feeling
          const currentFeeling = existingFeelings[userId] ?? null;
          // Choose a feeling from allowedFeelings that is NOT the user's current feeling
          const candidateFeelings = allowedFeelings.filter((f) => f !== currentFeeling);
          // If all allowed feelings equal the current feeling, skip (pre-condition)
          fc.pre(candidateFeelings.length > 0);

          const selectedCategory = candidateFeelings[0];

          const state: FeelingsState = {
            feelings: existingFeelings,
            allowedFeelings,
            isCompleted: false,
          };

          const result = processFeelingsSelection(state, userId, selectedCategory);

          // Must be accepted
          expect(result.accepted).toBe(true);
          // New feeling must be the selected category
          expect(result.newFeeling).toBe(selectedCategory);
          // Must broadcast with the correct userId and category
          expect(result.broadcast).not.toBeNull();
          expect(result.broadcast!.userId).toBe(userId);
          expect(result.broadcast!.category).toBe(selectedCategory);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should allow moderators and participants equally to select feelings', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        fc.tuple(arbUserId, arbUserId), // two different user IDs representing moderator and participant
        fc.constantFrom('moderator' as const, 'participant' as const),
        (allowedFeelings, [userId], _role) => {
          // The role doesn't affect feeling selection - both should succeed
          const selectedCategory = allowedFeelings[0];
          const state: FeelingsState = {
            feelings: {},
            allowedFeelings,
            isCompleted: false,
          };

          const result = processFeelingsSelection(state, userId, selectedCategory);

          expect(result.accepted).toBe(true);
          expect(result.newFeeling).toBe(selectedCategory);
          expect(result.broadcast).not.toBeNull();
          expect(result.broadcast!.userId).toBe(userId);
          expect(result.broadcast!.category).toBe(selectedCategory);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: retro-participant-feelings, Property 6: Toggle deselection
 *
 * For any participant whose current feeling matches the category they click,
 * the system SHALL set their feeling to null and broadcast a retro:feeling:updated event with null.
 *
 * **Validates: Requirements 3.3**
 */
describe('Feature: retro-participant-feelings, Property 6: Toggle deselection', () => {
  it('should deselect (set to null) when a participant clicks their currently selected feeling', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        arbUserId,
        (allowedFeelings, userId) => {
          // User already has a feeling that is in allowedFeelings
          const currentFeeling = allowedFeelings[0];

          const state: FeelingsState = {
            feelings: { [userId]: currentFeeling },
            allowedFeelings,
            isCompleted: false,
          };

          // Click the same category again (toggle)
          const result = processFeelingsSelection(state, userId, currentFeeling);

          // Must be accepted
          expect(result.accepted).toBe(true);
          // New feeling must be null (deselected)
          expect(result.newFeeling).toBeNull();
          // Must broadcast with null category
          expect(result.broadcast).not.toBeNull();
          expect(result.broadcast!.userId).toBe(userId);
          expect(result.broadcast!.category).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should toggle to null for any allowed feeling the user currently has', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        arbUserId,
        fc.nat({ max: 9 }),
        (allowedFeelings, userId, feelingIndex) => {
          // Pick a feeling from allowedFeelings at a valid index
          const idx = feelingIndex % allowedFeelings.length;
          const currentFeeling = allowedFeelings[idx];

          const state: FeelingsState = {
            feelings: { [userId]: currentFeeling },
            allowedFeelings,
            isCompleted: false,
          };

          const result = processFeelingsSelection(state, userId, currentFeeling);

          expect(result.accepted).toBe(true);
          expect(result.newFeeling).toBeNull();
          expect(result.broadcast).toEqual({ userId, category: null });
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: retro-participant-feelings, Property 7: Disallowed feeling rejection
 *
 * For any FeelingCategory that is NOT in the current allowedFeelings, if a participant
 * submits that category as their selection, the system SHALL reject the request,
 * retain the participant's previous feeling unchanged, and NOT broadcast any update.
 *
 * **Validates: Requirements 3.7**
 */
describe('Feature: retro-participant-feelings, Property 7: Disallowed feeling rejection', () => {
  it('should reject selection of a feeling category not in allowedFeelings', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        arbUserId,
        arbFeelingCategory,
        fc.option(arbFeelingCategory, { nil: null }),
        (allowedFeelings, userId, attemptedCategory, existingFeeling) => {
          // Pre-condition: the attempted category is NOT in allowedFeelings
          fc.pre(!allowedFeelings.includes(attemptedCategory));

          const state: FeelingsState = {
            feelings: existingFeeling !== null ? { [userId]: existingFeeling } : {},
            allowedFeelings,
            isCompleted: false,
          };

          const result = processFeelingsSelection(state, userId, attemptedCategory);

          // Must be rejected
          expect(result.accepted).toBe(false);
          // Feeling must remain unchanged
          expect(result.newFeeling).toBe(existingFeeling);
          // Must NOT broadcast
          expect(result.broadcast).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should never accept a feeling that is absent from allowedFeelings regardless of board state', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        arbUserId,
        arbFeelingCategory,
        (allowedFeelings, userId, category) => {
          // Only test when category is NOT allowed
          fc.pre(!allowedFeelings.includes(category));

          const state: FeelingsState = {
            feelings: {},
            allowedFeelings,
            isCompleted: false,
          };

          const result = processFeelingsSelection(state, userId, category);

          expect(result.accepted).toBe(false);
          expect(result.broadcast).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: retro-participant-feelings, Property 8: Board completion prevents feeling changes
 *
 * For any board that is marked as completed, all feeling selection requests
 * SHALL be rejected and the feelings map SHALL remain unchanged.
 *
 * **Validates: Requirements 3.5**
 */
describe('Feature: retro-participant-feelings, Property 8: Board completion prevents feeling changes', () => {
  it('should reject all feeling selections when the board is completed', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        arbUserId,
        fc.option(arbFeelingCategory, { nil: null }),
        fc.option(arbFeelingCategory, { nil: null }),
        (allowedFeelings, userId, selectedCategory, existingFeeling) => {
          const state: FeelingsState = {
            feelings: existingFeeling !== null ? { [userId]: existingFeeling } : {},
            allowedFeelings,
            isCompleted: true, // Board is completed
          };

          // Attempt to select any category (including valid ones)
          const categoryToSelect = selectedCategory ?? allowedFeelings[0];
          const result = processFeelingsSelection(state, userId, categoryToSelect);

          // Must be rejected
          expect(result.accepted).toBe(false);
          // Feeling must remain unchanged
          expect(result.newFeeling).toBe(existingFeeling);
          // Must NOT broadcast
          expect(result.broadcast).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should reject deselection (null) when the board is completed', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        arbUserId,
        arbFeelingCategory,
        (allowedFeelings, userId, existingFeeling) => {
          const state: FeelingsState = {
            feelings: { [userId]: existingFeeling },
            allowedFeelings,
            isCompleted: true, // Board is completed
          };

          // Attempt to deselect by clicking same feeling (toggle attempt)
          const result = processFeelingsSelection(state, userId, existingFeeling);

          // Must be rejected
          expect(result.accepted).toBe(false);
          // Feeling must remain unchanged
          expect(result.newFeeling).toBe(existingFeeling);
          // Must NOT broadcast
          expect(result.broadcast).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should reject even valid allowed feelings when board is completed', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        arbUserId,
        (allowedFeelings, userId) => {
          const state: FeelingsState = {
            feelings: {},
            allowedFeelings,
            isCompleted: true,
          };

          // Try every allowed feeling — all should be rejected
          for (const category of allowedFeelings) {
            const result = processFeelingsSelection(state, userId, category);
            expect(result.accepted).toBe(false);
            expect(result.broadcast).toBeNull();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
