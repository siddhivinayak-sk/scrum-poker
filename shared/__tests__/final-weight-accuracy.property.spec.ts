import * as fc from 'fast-check';
import { computeAccuracy, computeStandings, scoringLadder } from '../final-weight';
import type { ExtendedCardValue, FinalWeightRecord, HistoryEntry, ParticipantVote, VotingSystemType } from '../types';
import { ladderIndexOf } from '../types';

const RUNS = { numRuns: 100 };

const SYSTEMS: readonly VotingSystemType[] = ['fibonacci', 'modified-fibonacci', 't-shirt', 'power-of-2'];

const systemArb = fc.constantFrom(...SYSTEMS);
const userIds = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];

/** A card that is on the ladder, or an off-ladder / special value. */
const OFF_LADDER: ExtendedCardValue[] = ['coffee', 'no-clue', 'break', 'zzz', 9999, -7] as unknown as ExtendedCardValue[];

function cardArb(system: VotingSystemType): fc.Arbitrary<ExtendedCardValue> {
  const ladder = scoringLadder(system);
  return fc.oneof(
    { arbitrary: fc.constantFrom(...ladder), weight: 4 },
    { arbitrary: fc.constantFrom(...OFF_LADDER), weight: 1 }
  );
}

function votesArb(system: VotingSystemType): fc.Arbitrary<ParticipantVote[]> {
  return fc
    .uniqueArray(fc.constantFrom(...userIds), { maxLength: userIds.length })
    .chain((ids) =>
      fc.tuple(...ids.map((id) =>
        fc.option(cardArb(system), { nil: null }).map((cardValue): ParticipantVote => ({
          userId: id,
          displayName: `name-${id}`,
          cardValue,
        }))
      )) as fc.Arbitrary<ParticipantVote[]>
    );
}

function weightArb(system: VotingSystemType, allowOffLadder: boolean): fc.Arbitrary<ExtendedCardValue> {
  const ladder = scoringLadder(system);
  return allowOffLadder
    ? fc.oneof({ arbitrary: fc.constantFrom(...ladder), weight: 4 }, { arbitrary: fc.constantFrom(...OFF_LADDER), weight: 1 })
    : fc.constantFrom(...ladder);
}

function recordArb(allowOffLadder: boolean): fc.Arbitrary<{ record: FinalWeightRecord; votes: ParticipantVote[] }> {
  return systemArb.chain((system) =>
    fc.record({
      record: fc.record({
        value: weightArb(system, allowOffLadder),
        votingSystem: fc.constant(system),
        showFunniest: fc.boolean(),
      }),
      votes: votesArb(system),
    })
  );
}

/** Independent reference: scorable voters with their ladder distance. */
function scorable(votes: readonly ParticipantVote[], record: FinalWeightRecord) {
  const ladder = scoringLadder(record.votingSystem);
  const w = ladderIndexOf(ladder, record.value);
  const out: { userId: string; card: ExtendedCardValue; distance: number }[] = [];
  if (w === -1) return { w, out };
  for (const v of votes) {
    if (v.cardValue === null) continue;
    const i = ladderIndexOf(ladder, v.cardValue);
    if (i === -1) continue;
    out.push({ userId: v.userId, card: v.cardValue, distance: Math.abs(i - w) });
  }
  return { w, out };
}

// Feature: final-weight-accuracy, Property 3: Accuracy result invariants
describe('Property 3: Accuracy result invariants', () => {
  it('never throws and satisfies closest/furthest/allExact/comparable invariants', () => {
    // **Validates: Requirements 6.4, 6.5, 6.6, 6.7, 6.8, 6.9**
    fc.assert(
      fc.property(recordArb(true), ({ record, votes }) => {
        const result = computeAccuracy(votes, record);
        const { w, out } = scorable(votes, record);

        const expectComparable = w !== -1 && out.length >= 2;
        expect(result.comparable).toBe(expectComparable);
        if (!expectComparable) {
          expect(result.closestIds).toEqual([]);
          expect(result.furthestIds).toEqual([]);
          expect(result.allExact).toBe(false);
          return;
        }

        const distances = result.voters.map((v) => v.distance);
        const min = Math.min(...distances);
        const max = Math.max(...distances);
        expect(result.voters.length).toBe(out.length);

        expect(result.closestIds.length).toBeGreaterThan(0);
        for (const id of result.closestIds) {
          expect(result.voters.find((v) => v.userId === id)!.distance).toBe(min);
        }
        for (const id of result.furthestIds) {
          expect(result.voters.find((v) => v.userId === id)!.distance).toBe(max);
        }
        if (max === min) expect(result.furthestIds).toEqual([]);
        else expect(result.furthestIds.length).toBeGreaterThan(0);

        expect(result.allExact).toBe(out.every((v) => v.distance === 0));
        expect(result.allExact).toBe(result.voters.every((v) => v.card === record.value));
      }),
      RUNS
    );
  });
});

// Feature: final-weight-accuracy, Property 4: Distance equals ladder index difference
describe('Property 4: Distance equals ladder index difference', () => {
  it('distance is the absolute ladder index difference, symmetric and non-negative', () => {
    // **Validates: Requirements 6.1, 6.2**
    fc.assert(
      fc.property(
        systemArb.chain((system) => {
          const ladder = scoringLadder(system);
          return fc.tuple(
            fc.constant(system),
            fc.nat({ max: ladder.length - 1 }),
            fc.nat({ max: ladder.length - 1 })
          );
        }),
        ([system, i, j]) => {
          const ladder = scoringLadder(system);
          const distance = (voteIdx: number, weightIdx: number): number => {
            const votes: ParticipantVote[] = [
              { userId: 'a', displayName: 'A', cardValue: ladder[voteIdx] },
              { userId: 'b', displayName: 'B', cardValue: ladder[voteIdx] },
            ];
            const record: FinalWeightRecord = { value: ladder[weightIdx], votingSystem: system, showFunniest: false };
            const result = computeAccuracy(votes, record);
            expect(result.comparable).toBe(true);
            return result.voters[0].distance;
          };
          const d = distance(i, j);
          expect(d).toBe(Math.abs(i - j));
          expect(d).toBeGreaterThanOrEqual(0);
          expect(distance(j, i)).toBe(d);
        }
      ),
      RUNS
    );
  });

  it('covers the t-shirt ladder', () => {
    const ladder = scoringLadder('t-shirt');
    expect(ladder.length).toBeGreaterThan(1);
  });
});

// Feature: final-weight-accuracy, Property 5: Standings are the per-round mean distance
describe('Property 5: Standings are the per-round mean distance', () => {
  const entryArb: fc.Arbitrary<HistoryEntry> = fc
    .tuple(recordArb(true), fc.boolean(), fc.nat({ max: 1000 }))
    .map(([{ record, votes }, hasWeight, n]) => ({
      roundId: `r${n}`,
      storyDescription: '',
      participants: votes,
      metrics: {
        average: null,
        mode: null,
        spread: null,
        distribution: {},
        outliers: [],
        numericVoteCount: 0,
        insufficientData: true,
      },
      completedAt: '2026-01-01T00:00:00.000Z',
      ...(hasWeight ? { finalWeight: record } : {}),
    }));

  it('averages per-round distances, ignores unscored entries, and sorts with warming-up voters last', () => {
    // **Validates: Requirements 6.12, 10.3, 10.4, 10.6**
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 8 }), (history) => {
        const standings = computeStandings(history);

        // Reference model: only entries with a record, comparable, scored on their own system.
        const expected = new Map<string, number[]>();
        for (const entry of history) {
          if (entry.finalWeight === undefined) continue;
          const { w, out } = scorable(entry.participants, entry.finalWeight);
          if (w === -1 || out.length < 2) continue;
          for (const v of out) expected.set(v.userId, [...(expected.get(v.userId) ?? []), v.distance]);
        }

        expect(standings.length).toBe(expected.size);
        for (const s of standings) {
          const ds = expected.get(s.userId)!;
          expect(ds).toBeDefined();
          expect(s.rounds).toBe(ds.length);
          expect(s.avgDistance).toBeCloseTo(ds.reduce((a, b) => a + b, 0) / ds.length, 9);
          expect(s.warmingUp).toBe(ds.length < 2);
        }

        // Ordering: all voters with >= 2 rounds first, ascending by avgDistance, then the rest ascending.
        const firstWarming = standings.findIndex((s) => s.warmingUp);
        if (firstWarming !== -1) {
          expect(standings.slice(firstWarming).every((s) => s.warmingUp)).toBe(true);
        }
        for (let k = 1; k < standings.length; k++) {
          if (standings[k - 1].warmingUp === standings[k].warmingUp) {
            expect(standings[k - 1].avgDistance).toBeLessThanOrEqual(standings[k].avgDistance);
          }
        }
      }),
      RUNS
    );
  });
});
