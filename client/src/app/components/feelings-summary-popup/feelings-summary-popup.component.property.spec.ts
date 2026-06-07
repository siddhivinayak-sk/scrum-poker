import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ALL_FEELING_CATEGORIES,
  FeelingCategory,
  FEELING_EMOJI_MAP,
} from '@shared/types';

/**
 * Pure logic modeling the FeelingsSummaryPopupComponent's sorting and display behavior.
 * This mirrors the `sortedParticipants` computed signal logic in the component.
 */

interface Participant {
  id: string;
  displayName: string;
}

interface SortedEntry {
  userId: string;
  displayName: string;
  feeling: FeelingCategory | null;
}

/**
 * Derives sorted participant entries exactly as the component does:
 * - Maps participants with their feelings from the feelings map
 * - Sorts by displayName using case-insensitive locale comparison
 */
function deriveSortedParticipants(
  participants: Participant[],
  feelings: Record<string, FeelingCategory | null>,
): SortedEntry[] {
  const entries = participants.map((p) => ({
    userId: p.id,
    displayName: p.displayName,
    feeling: feelings[p.id] ?? null,
  }));

  return entries.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
  );
}

/**
 * Returns the display text for a participant's feeling:
 * - If feeling is non-null, returns the emoji from FEELING_EMOJI_MAP
 * - If feeling is null, returns "No feeling"
 */
function getFeelingDisplay(feeling: FeelingCategory | null): string {
  if (feeling === null) return 'No feeling';
  return FEELING_EMOJI_MAP[feeling] ?? '';
}

// --- Arbitraries ---

/** Arbitrary for a valid FeelingCategory */
const arbFeelingCategory: fc.Arbitrary<FeelingCategory> = fc.constantFrom(
  ...ALL_FEELING_CATEGORIES,
);

/**
 * Arbitrary for a participant with a unique id and arbitrary displayName (including mixed case).
 * Uses string with printable characters to test case-insensitive sorting.
 */
const arbParticipant: fc.Arbitrary<Participant> = fc.record({
  id: fc.uuid(),
  displayName: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0),
});

/**
 * Arbitrary for a list of participants with unique IDs and arbitrary display names (including mixed case).
 * Generates 1–20 participants to test sorting behavior.
 */
const arbParticipants: fc.Arbitrary<Participant[]> = fc
  .array(arbParticipant, { minLength: 1, maxLength: 20 })
  .map((participants) => {
    // Ensure unique IDs
    const seen = new Set<string>();
    return participants.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  })
  .filter((arr) => arr.length >= 1);

/**
 * Arbitrary for generating a participant list paired with a feelings map.
 * Each participant may or may not have a feeling selected (null for "No feeling").
 */
const arbParticipantsWithFeelings: fc.Arbitrary<{
  participants: Participant[];
  feelings: Record<string, FeelingCategory | null>;
}> = arbParticipants.chain((participants) =>
  fc
    .array(
      fc.option(arbFeelingCategory, { nil: null }),
      { minLength: participants.length, maxLength: participants.length },
    )
    .map((feelingChoices) => {
      const feelings: Record<string, FeelingCategory | null> = {};
      participants.forEach((p, i) => {
        feelings[p.id] = feelingChoices[i];
      });
      return { participants, feelings };
    }),
);

/**
 * Feature: retro-participant-feelings, Property 13: Popup displays participants in case-insensitive alphabetical order
 *
 * For any set of participants (with arbitrary displayNames including mixed case),
 * the popup's `sortedParticipants` list is in case-insensitive alphabetical order
 * by displayName, and each participant shows the correct feeling emoji (or "No feeling" for null).
 *
 * **Validates: Requirements 5.4, 5.5**
 */
describe('Feature: retro-participant-feelings, Property 13: Popup displays participants in case-insensitive alphabetical order', () => {
  it('should sort participants in case-insensitive alphabetical order by displayName', () => {
    fc.assert(
      fc.property(
        arbParticipantsWithFeelings,
        ({ participants, feelings }) => {
          const sorted = deriveSortedParticipants(participants, feelings);

          // Verify the list is sorted in case-insensitive order
          for (let i = 0; i < sorted.length - 1; i++) {
            const cmp = sorted[i].displayName.localeCompare(
              sorted[i + 1].displayName,
              undefined,
              { sensitivity: 'base' },
            );
            expect(cmp).toBeLessThanOrEqual(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should display the correct feeling emoji for each participant or "No feeling" for null', () => {
    fc.assert(
      fc.property(
        arbParticipantsWithFeelings,
        ({ participants, feelings }) => {
          const sorted = deriveSortedParticipants(participants, feelings);

          for (const entry of sorted) {
            const display = getFeelingDisplay(entry.feeling);

            if (entry.feeling === null) {
              // Must show "No feeling"
              expect(display).toBe('No feeling');
            } else {
              // Must show the correct emoji from FEELING_EMOJI_MAP
              expect(display).toBe(FEELING_EMOJI_MAP[entry.feeling]);
              // Emoji must be non-empty
              expect(display.length).toBeGreaterThan(0);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should preserve all participants in the sorted output (no entries lost or duplicated)', () => {
    fc.assert(
      fc.property(
        arbParticipantsWithFeelings,
        ({ participants, feelings }) => {
          const sorted = deriveSortedParticipants(participants, feelings);

          // Same length — no entries lost or duplicated
          expect(sorted.length).toBe(participants.length);

          // All participant IDs must be present
          const sortedIds = sorted.map((e) => e.userId).sort();
          const inputIds = participants.map((p) => p.id).sort();
          expect(sortedIds).toEqual(inputIds);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should correctly associate each participant with their feeling from the feelings map', () => {
    fc.assert(
      fc.property(
        arbParticipantsWithFeelings,
        ({ participants, feelings }) => {
          const sorted = deriveSortedParticipants(participants, feelings);

          for (const entry of sorted) {
            // The feeling for this entry must match the feelings map
            const expectedFeeling = feelings[entry.userId] ?? null;
            expect(entry.feeling).toBe(expectedFeeling);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should handle mixed-case names correctly (e.g., "alice" before "Bob" before "CHARLIE")', () => {
    // Arbitrary generating names with mixed casing from a controlled alphabet
    const arbMixedCaseName: fc.Arbitrary<string> = fc
      .array(
        fc.constantFrom(
          'a', 'b', 'c', 'd', 'e', 'A', 'B', 'C', 'D', 'E',
          'f', 'g', 'h', 'F', 'G', 'H',
        ),
        { minLength: 1, maxLength: 10 },
      )
      .map((chars) => chars.join(''));

    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.uuid(),
            arbMixedCaseName,
            fc.option(arbFeelingCategory, { nil: null }),
          ),
          { minLength: 1, maxLength: 20 },
        ).map((tuples) => {
          // Ensure unique IDs
          const seen = new Set<string>();
          const filtered = tuples.filter(([id]) => {
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
          });
          return filtered;
        }).filter((arr) => arr.length >= 1),
        (tuples) => {
          const participants: Participant[] = tuples.map(([id, name]) => ({
            id,
            displayName: name,
          }));
          const feelings: Record<string, FeelingCategory | null> = {};
          tuples.forEach(([id, , feeling]) => {
            feelings[id] = feeling;
          });

          const sorted = deriveSortedParticipants(participants, feelings);

          // Verify case-insensitive ordering
          for (let i = 0; i < sorted.length - 1; i++) {
            const cmp = sorted[i].displayName.localeCompare(
              sorted[i + 1].displayName,
              undefined,
              { sensitivity: 'base' },
            );
            expect(cmp).toBeLessThanOrEqual(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
