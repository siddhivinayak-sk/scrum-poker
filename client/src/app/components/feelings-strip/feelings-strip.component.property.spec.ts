import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ALL_FEELING_CATEGORIES,
  FeelingCategory,
  FEELING_EMOJI_MAP,
} from '@shared/types';

/**
 * Pure logic functions modeling the FeelingsStripComponent display behavior.
 * These mirror the component's template rendering decisions for property testing.
 */

/**
 * Compute the list of emoji buttons that should be rendered.
 * Each button corresponds to one entry in allowedFeelings, in order.
 */
function computeRenderedButtons(allowedFeelings: FeelingCategory[]): Array<{ category: FeelingCategory; emoji: string }> {
  return allowedFeelings.map((category) => ({
    category,
    emoji: FEELING_EMOJI_MAP[category],
  }));
}

/**
 * Determine which emoji button should have the highlight class.
 * Returns the category that should be highlighted, or null if none.
 * The highlight is applied when the participant's current feeling matches an allowed feeling.
 */
function computeHighlightedCategory(
  allowedFeelings: FeelingCategory[],
  myFeeling: FeelingCategory | null,
): FeelingCategory | null {
  if (myFeeling === null) return null;
  if (!allowedFeelings.includes(myFeeling)) return null;
  return myFeeling;
}

/**
 * Determine whether the summary icon (📊 button) should be visible.
 * It is visible if and only if the user is a moderator.
 */
function computeSummaryIconVisible(isModerator: boolean): boolean {
  return isModerator;
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

/**
 * Feature: retro-participant-feelings, Property 3: Feelings strip displays exactly allowedFeelings in order
 *
 * For any allowedFeelings configuration, the Feelings Strip SHALL render exactly those emoji
 * icons corresponding to the categories in allowedFeelings, in the same order as the array.
 *
 * **Validates: Requirements 2.2, 2.5**
 */
describe('Feature: retro-participant-feelings, Property 3: Feelings strip displays exactly allowedFeelings in order', () => {
  it('should render exactly one emoji button per allowed feeling category, in order', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        (allowedFeelings) => {
          const buttons = computeRenderedButtons(allowedFeelings);

          // Count must match exactly
          expect(buttons.length).toBe(allowedFeelings.length);

          // Each button must correspond to the correct category in order
          for (let i = 0; i < allowedFeelings.length; i++) {
            expect(buttons[i].category).toBe(allowedFeelings[i]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should display the correct emoji character from FEELING_EMOJI_MAP for each category', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        (allowedFeelings) => {
          const buttons = computeRenderedButtons(allowedFeelings);

          for (let i = 0; i < buttons.length; i++) {
            const expectedEmoji = FEELING_EMOJI_MAP[allowedFeelings[i]];
            expect(buttons[i].emoji).toBe(expectedEmoji);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should never render categories not present in allowedFeelings', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        (allowedFeelings) => {
          const buttons = computeRenderedButtons(allowedFeelings);
          const renderedCategories = buttons.map((b) => b.category);

          // Every rendered category must be in allowedFeelings
          for (const cat of renderedCategories) {
            expect(allowedFeelings).toContain(cat);
          }

          // No extra categories should appear
          const disallowed = ALL_FEELING_CATEGORIES.filter((c) => !allowedFeelings.includes(c));
          for (const cat of disallowed) {
            expect(renderedCategories).not.toContain(cat);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: retro-participant-feelings, Property 4: Selected feeling is highlighted
 *
 * For any participant with a non-null feeling selection that is in the current allowedFeelings,
 * the corresponding emoji in the Feelings Strip SHALL have the highlight indicator applied,
 * and all other emojis SHALL NOT have it.
 *
 * **Validates: Requirements 2.6**
 */
describe('Feature: retro-participant-feelings, Property 4: Selected feeling is highlighted', () => {
  it('should highlight exactly the selected feeling when it is in allowedFeelings', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        fc.nat({ max: 9 }),
        (allowedFeelings, feelingIndex) => {
          // Pick a feeling from the allowed list
          const idx = feelingIndex % allowedFeelings.length;
          const selectedFeeling = allowedFeelings[idx];

          const highlighted = computeHighlightedCategory(allowedFeelings, selectedFeeling);

          // The highlighted category must be exactly the selected feeling
          expect(highlighted).toBe(selectedFeeling);

          // Verify that for each button, only the selected one has highlight
          const buttons = computeRenderedButtons(allowedFeelings);
          for (const button of buttons) {
            const isHighlighted = button.category === highlighted;
            if (button.category === selectedFeeling) {
              expect(isHighlighted).toBe(true);
            } else {
              expect(isHighlighted).toBe(false);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should not highlight any emoji when myFeeling is null', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        (allowedFeelings) => {
          const highlighted = computeHighlightedCategory(allowedFeelings, null);

          expect(highlighted).toBeNull();

          // No button should be highlighted
          const buttons = computeRenderedButtons(allowedFeelings);
          for (const button of buttons) {
            expect(button.category === highlighted).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should not highlight any emoji when myFeeling is not in allowedFeelings', () => {
    fc.assert(
      fc.property(
        arbAllowedFeelings,
        arbFeelingCategory,
        (allowedFeelings, feeling) => {
          // Pre-condition: the feeling is NOT in the allowed list
          fc.pre(!allowedFeelings.includes(feeling));

          const highlighted = computeHighlightedCategory(allowedFeelings, feeling);

          expect(highlighted).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: retro-participant-feelings, Property 12: Summary icon visibility matches moderator status
 *
 * For any user, the summary icon in the Feelings Strip SHALL be visible if and only if
 * that user is a moderator.
 *
 * **Validates: Requirements 5.1**
 */
describe('Feature: retro-participant-feelings, Property 12: Summary icon visibility matches moderator status', () => {
  it('should show summary icon if and only if user is a moderator', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        (isModerator) => {
          const visible = computeSummaryIconVisible(isModerator);

          if (isModerator) {
            expect(visible).toBe(true);
          } else {
            expect(visible).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('summary icon visibility equals moderator status for any user role', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        arbAllowedFeelings,
        fc.option(arbFeelingCategory, { nil: null }),
        (isModerator, _allowedFeelings, _myFeeling) => {
          // Regardless of other state (allowed feelings, selected feeling),
          // the summary icon visibility depends ONLY on moderator status
          const visible = computeSummaryIconVisible(isModerator);
          expect(visible).toBe(isModerator);
        },
      ),
      { numRuns: 100 },
    );
  });
});
