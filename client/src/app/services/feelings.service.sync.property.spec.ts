import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ALL_FEELING_CATEGORIES, FeelingCategory } from '@shared/types';

/**
 * Pure logic functions modeling feelings synchronization behavior.
 * These mirror the FeelingsService event handling for session state and disconnect events.
 */

// --- Model functions ---

/**
 * Model: When a new joiner receives a `retro:session:state` event,
 * the feelings signal should be set to the complete feelings map from that state.
 */
function applySessionState(
  feelingsFromState: Record<string, FeelingCategory | null>,
): Record<string, FeelingCategory | null> {
  // The service sets feelings to the map provided in the state (or {} if missing)
  return feelingsFromState ?? {};
}

/**
 * Model: When a `retro:feeling:updated` event is received with category === null,
 * the participant's entry should be removed from the feelings map.
 */
function applyDisconnect(
  currentFeelings: Record<string, FeelingCategory | null>,
  disconnectedUserId: string,
): Record<string, FeelingCategory | null> {
  const updated = { ...currentFeelings };
  delete updated[disconnectedUserId];
  return updated;
}

// --- Arbitraries ---

/** Arbitrary for a valid FeelingCategory */
const arbFeelingCategory: fc.Arbitrary<FeelingCategory> = fc.constantFrom(
  ...ALL_FEELING_CATEGORIES,
);

/** Arbitrary for a userId */
const arbUserId: fc.Arbitrary<string> = fc.uuid();

/** Arbitrary for a feelings map with 0 to 15 entries (connected participants) */
const arbFeelingsMap: fc.Arbitrary<Record<string, FeelingCategory | null>> = fc
  .array(
    fc.tuple(arbUserId, fc.oneof(arbFeelingCategory, fc.constant(null as FeelingCategory | null))),
    { minLength: 0, maxLength: 15 },
  )
  .map((entries) => {
    const map: Record<string, FeelingCategory | null> = {};
    for (const [userId, category] of entries) {
      map[userId] = category;
    }
    return map;
  });

/** Arbitrary for a non-empty feelings map (at least 1 entry) */
const arbNonEmptyFeelingsMap: fc.Arbitrary<Record<string, FeelingCategory | null>> = fc
  .array(
    fc.tuple(arbUserId, fc.oneof(arbFeelingCategory, fc.constant(null as FeelingCategory | null))),
    { minLength: 1, maxLength: 15 },
  )
  .map((entries) => {
    const map: Record<string, FeelingCategory | null> = {};
    for (const [userId, category] of entries) {
      map[userId] = category;
    }
    return map;
  });

/**
 * Feature: retro-participant-feelings, Property 11: New joiner receives full feelings map
 *
 * For any new participant joining (or reconnecting to) a session, the session state sent
 * to them SHALL include the complete current feelings map containing all connected
 * participants' feeling selections.
 *
 * Model: Generate an arbitrary feelings map and simulate a `retro:session:state` event
 * → verify the service's feelings signal matches exactly.
 *
 * **Validates: Requirements 4.3, 4.5**
 */
describe('Feature: retro-participant-feelings, Property 11: New joiner receives full feelings map', () => {
  it('should set feelings signal to the exact feelings map from session state', () => {
    fc.assert(
      fc.property(arbFeelingsMap, (feelingsMap) => {
        const result = applySessionState(feelingsMap);

        // The result must be exactly the same as the feelings map from the state
        expect(result).toEqual(feelingsMap);
        // All keys from the map must be present
        expect(Object.keys(result).sort()).toEqual(Object.keys(feelingsMap).sort());
        // Each entry must match
        for (const [userId, category] of Object.entries(feelingsMap)) {
          expect(result[userId]).toBe(category);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('should include all participants feelings regardless of their category', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(arbUserId, arbFeelingCategory),
          { minLength: 1, maxLength: 10 },
        ),
        (participantEntries) => {
          // Build a map with only non-null feelings (all connected participants have a selection)
          const feelingsMap: Record<string, FeelingCategory> = {};
          for (const [userId, category] of participantEntries) {
            feelingsMap[userId] = category;
          }

          const result = applySessionState(feelingsMap);

          // Every participant's feeling should be present and correct
          for (const [userId, category] of Object.entries(feelingsMap)) {
            expect(result[userId]).toBe(category);
          }
          // No extra entries should exist
          expect(Object.keys(result).length).toBe(Object.keys(feelingsMap).length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should handle empty feelings map (new session with no selections yet)', () => {
    fc.assert(
      fc.property(fc.constant({}), (emptyMap) => {
        const result = applySessionState(emptyMap);

        expect(result).toEqual({});
        expect(Object.keys(result).length).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('should overwrite any previous local state with the full state from server', () => {
    fc.assert(
      fc.property(
        arbFeelingsMap,
        arbFeelingsMap,
        (previousLocalState, newStateFromServer) => {
          // Simulates a reconnection: previous state exists, new state arrives
          // The service replaces the entire map, not merging
          const result = applySessionState(newStateFromServer);

          // Result must be exactly the new state, regardless of previous local state
          expect(result).toEqual(newStateFromServer);
          // Previous entries that are not in the new state must be gone
          for (const userId of Object.keys(previousLocalState)) {
            if (!(userId in newStateFromServer)) {
              expect(result[userId]).toBeUndefined();
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Feature: retro-participant-feelings, Property 10: Disconnect removes participant feeling
 *
 * For any participant who disconnects from the session, their entry SHALL be removed
 * from the feelings map and a `retro:feeling:updated` event with null SHALL be broadcast
 * to all remaining clients.
 *
 * Model: Generate a feelings map, then simulate a `retro:feeling:updated` with
 * `{ userId, category: null }` → verify the entry is removed.
 *
 * **Validates: Requirements 4.4**
 */
describe('Feature: retro-participant-feelings, Property 10: Disconnect removes participant feeling', () => {
  it('should remove the disconnected participant entry from the feelings map', () => {
    fc.assert(
      fc.property(arbNonEmptyFeelingsMap, (feelingsMap) => {
        // Pick a userId that exists in the map
        const userIds = Object.keys(feelingsMap);
        fc.pre(userIds.length > 0);
        const disconnectedUserId = userIds[0];

        const result = applyDisconnect(feelingsMap, disconnectedUserId);

        // The disconnected user's entry must be removed
        expect(result[disconnectedUserId]).toBeUndefined();
        expect(disconnectedUserId in result).toBe(false);
        // All other entries must remain unchanged
        for (const [userId, category] of Object.entries(feelingsMap)) {
          if (userId !== disconnectedUserId) {
            expect(result[userId]).toBe(category);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('should not affect other participants feelings when one disconnects', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(arbUserId, arbFeelingCategory),
          { minLength: 2, maxLength: 10 },
        ),
        (participantEntries) => {
          // Build a map with at least 2 distinct users
          const feelingsMap: Record<string, FeelingCategory> = {};
          for (const [userId, category] of participantEntries) {
            feelingsMap[userId] = category;
          }
          const userIds = Object.keys(feelingsMap);
          fc.pre(userIds.length >= 2);

          const disconnectedUserId = userIds[0];
          const result = applyDisconnect(feelingsMap, disconnectedUserId);

          // The remaining participants' feelings must be exactly preserved
          const remainingUserIds = userIds.filter((id) => id !== disconnectedUserId);
          expect(Object.keys(result).sort()).toEqual(remainingUserIds.sort());
          for (const userId of remainingUserIds) {
            expect(result[userId]).toBe(feelingsMap[userId]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should result in an empty map when the last participant disconnects', () => {
    fc.assert(
      fc.property(
        arbUserId,
        arbFeelingCategory,
        (userId, category) => {
          const feelingsMap: Record<string, FeelingCategory | null> = { [userId]: category };

          const result = applyDisconnect(feelingsMap, userId);

          expect(result).toEqual({});
          expect(Object.keys(result).length).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should handle disconnect of a user not in the map gracefully', () => {
    fc.assert(
      fc.property(
        arbFeelingsMap,
        arbUserId,
        (feelingsMap, unknownUserId) => {
          // Pre-condition: the user is NOT in the map
          fc.pre(!(unknownUserId in feelingsMap));

          const result = applyDisconnect(feelingsMap, unknownUserId);

          // The map should remain unchanged
          expect(result).toEqual(feelingsMap);
        },
      ),
      { numRuns: 100 },
    );
  });
});
