import * as fc from 'fast-check';
import { DEFAULT_SESSION_CONFIG, CardValue, FIBONACCI_SEQUENCE } from '../../../../shared/types';
import { GameSession } from '../game-session';

/**
 * Arbitrary generator for a list of participants (non-moderator).
 * Each participant has a unique UUID and a display name.
 */
function arbParticipants(): fc.Arbitrary<Array<{ id: string; displayName: string }>> {
  return fc.array(
    fc.record({
      id: fc.uuid(),
      displayName: fc.string({ minLength: 1, maxLength: 50 }),
    }),
    { minLength: 1, maxLength: 10 },
  );
}

/**
 * Arbitrary generator for card selections: a set of indices into the participant
 * array indicating which participants have voted, paired with a card value.
 */
function arbSelections(maxParticipants: number): fc.Arbitrary<Array<{ index: number; cardValue: CardValue }>> {
  return fc.array(
    fc.record({
      index: fc.nat({ max: Math.max(0, maxParticipants - 1) }),
      cardValue: fc.constantFrom(...FIBONACCI_SEQUENCE) as fc.Arbitrary<CardValue>,
    }),
    { minLength: 0, maxLength: maxParticipants },
  );
}

/**
 * Property 2: Participant removal discards selection and removes from list
 *
 * For any game session with an active voting round and a set of participants
 * (some of whom have voted), when a participant is removed by a moderator,
 * that participant SHALL no longer appear in the participant list AND their
 * card selection (if any) SHALL no longer exist in the current round's
 * selections map.
 *
 * **Validates: Requirements 1.2, 1.6**
 */
describe('Property 2: Participant removal discards selection and removes from list', () => {
  it('removing a participant removes them from the participant list and discards their selection', () => {
    fc.assert(
      fc.property(
        fc.record({
          participants: arbParticipants(),
          targetIndex: fc.nat(),
        }),
        fc.array(
          fc.record({
            participantIndex: fc.nat(),
            cardValue: fc.constantFrom(...FIBONACCI_SEQUENCE) as fc.Arbitrary<CardValue>,
          }),
          { minLength: 0, maxLength: 10 },
        ),
        ({ participants, targetIndex }, selectionEntries) => {
          const session = new GameSession('test-session', 'owner-1', DEFAULT_SESSION_CONFIG);

          // Add a moderator
          const moderatorId = 'moderator-user';
          session.addParticipant({
            id: moderatorId,
            displayName: 'Moderator',
            role: 'moderator',
            isAnonymous: false,
          });

          // Add random participants
          for (const p of participants) {
            session.addParticipant({
              id: p.id,
              displayName: p.displayName,
              role: 'participant',
              isAnonymous: false,
            });
          }

          // Start a round
          session.startRound('Test Story');

          // Have some participants make card selections
          for (const entry of selectionEntries) {
            const idx = entry.participantIndex % participants.length;
            session.selectCard(participants[idx].id, entry.cardValue);
          }

          // Pick a random non-moderator participant to remove
          const targetIdx = targetIndex % participants.length;
          const targetUserId = participants[targetIdx].id;

          // Record state before removal
          const otherParticipantIds = participants
            .filter((_, i) => i !== targetIdx)
            .map((p) => p.id);

          // Record other participants' selections before removal
          const otherSelections = new Map<string, CardValue>();
          const currentRound = session.getCurrentRound()!;
          for (const otherId of otherParticipantIds) {
            if (currentRound.selections.has(otherId)) {
              otherSelections.set(otherId, currentRound.selections.get(otherId)!);
            }
          }

          // Call removeParticipantByModerator
          session.removeParticipantByModerator(targetUserId);

          // 1. Target no longer in getParticipants()
          const participantIds = session.getParticipants().map((p) => p.id);
          expect(participantIds).not.toContain(targetUserId);

          // 2. Target's selection no longer in currentRound.selections
          const roundAfter = session.getCurrentRound()!;
          expect(roundAfter.selections.has(targetUserId)).toBe(false);

          // 3. Other participants are still present
          for (const otherId of otherParticipantIds) {
            expect(participantIds).toContain(otherId);
          }

          // 4. Other participants' selections are unchanged
          for (const [otherId, cardValue] of otherSelections) {
            expect(roundAfter.selections.get(otherId)).toBe(cardValue);
          }

          // 5. Moderator is still present
          expect(participantIds).toContain(moderatorId);
        },
      ),
      { numRuns: 100 },
    );
  });
});
