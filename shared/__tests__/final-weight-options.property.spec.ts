import * as fc from 'fast-check';
import { buildFinalWeightOptions, scoringLadder } from '../final-weight';
import {
  ALL_CARDS,
  VOTING_SYSTEMS,
  ladderIndexOf,
  resolveFinalWeightEnabled,
  type ExtendedCardValue,
  type ParticipantVote,
  type VotingSystemType,
} from '../types';

// Feature: final-weight-accuracy — Properties 1 and 2 (flag resolution and
// candidate option building). Validates: Requirements 1.2, 5.2, 5.3, 5.7, 6.4.

const NUM_RUNS = 100;

const systemArb: fc.Arbitrary<VotingSystemType> = fc.constantFrom(
  'fibonacci',
  'modified-fibonacci',
  't-shirt',
  'power-of-2'
);

/** Any card from any system (including specials and off-ladder cards) or null. */
const anyCards: ExtendedCardValue[] = Array.from(
  new Set<ExtendedCardValue>([
    ...ALL_CARDS,
    ...Object.values(VOTING_SYSTEMS).flat(),
  ])
);
const cardArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom<ExtendedCardValue | null>(...anyCards) },
  { weight: 1, arbitrary: fc.constant<ExtendedCardValue | null>(null) },
  { weight: 1, arbitrary: fc.constant<ExtendedCardValue | null>(0) }
);

const votesArb: fc.Arbitrary<ParticipantVote[]> = fc
  .array(cardArb, { maxLength: 15 })
  .map((cards) =>
    cards.map((cardValue, i) => ({ userId: `u${i}`, displayName: `User ${i}`, cardValue }))
  );

const vote = (cardValue: ExtendedCardValue | null, i = 0): ParticipantVote => ({
  userId: `u${i}`,
  displayName: `User ${i}`,
  cardValue,
});

describe('Property 1: resolveFinalWeightEnabled is true iff the value is boolean true', () => {
  // Feature: final-weight-accuracy, Property 1: Feature flag resolves to on only for boolean true
  it('returns true only for boolean true', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(resolveFinalWeightEnabled(value)).toBe(value === true);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('is off for common truthy non-boolean values and absent', () => {
    for (const v of [undefined, null, 'true', 1, 'yes', {}, [], 0, '']) {
      expect(resolveFinalWeightEnabled(v)).toBe(false);
    }
    expect(resolveFinalWeightEnabled(true)).toBe(true);
    expect(resolveFinalWeightEnabled(false)).toBe(false);
  });
});

describe('Property 2: buildFinalWeightOptions invariants', () => {
  // Feature: final-weight-accuracy, Property 2: Candidate options are unique, on-ladder, complete and ordered
  it('never throws, has no duplicates, only ladder values, covers every scorable vote, ordered by ladder', () => {
    fc.assert(
      fc.property(votesArb, systemArb, (votes, system) => {
        const result = buildFinalWeightOptions(votes, system);
        const ladder = scoringLadder(system);
        const indexes = result.options.map((o) => ladderIndexOf(ladder, o.value));

        // only ladder values
        expect(indexes.every((i) => i !== -1)).toBe(true);
        // no duplicates
        expect(new Set(indexes).size).toBe(indexes.length);
        // ordered by ladder position
        for (let i = 1; i < indexes.length; i++) {
          expect(indexes[i]).toBeGreaterThan(indexes[i - 1]);
        }
        // includes every distinct scorable vote
        const scorableIdx = new Set<number>();
        for (const v of votes) {
          if (v.cardValue === null) continue;
          const idx = ladderIndexOf(ladder, v.cardValue);
          if (idx !== -1) scorableIdx.add(idx);
        }
        for (const idx of scorableIdx) {
          expect(indexes).toContain(idx);
        }
        expect(result.hasScorable).toBe(scorableIdx.size > 0);
        if (!result.hasScorable) expect(result.options).toEqual([]);
        // at most one suggested option, and one when there are scorable votes
        const suggested = result.options.filter((o) => o.suggested).length;
        expect(suggested).toBe(result.hasScorable ? 1 : 0);
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('handles the card 0 as a normal scorable vote', () => {
    fc.assert(
      fc.property(fc.constantFrom<VotingSystemType>('fibonacci', 'modified-fibonacci', 'power-of-2'), (system) => {
        const ladder = scoringLadder(system);
        fc.pre(ladderIndexOf(ladder, 0) !== -1);
        const result = buildFinalWeightOptions([vote(0)], system);
        expect(result.hasScorable).toBe(true);
        expect(result.options.map((o) => o.value)).toContain(0);
      }),
      { numRuns: NUM_RUNS }
    );
  });
});

describe('buildFinalWeightOptions examples', () => {
  it('suggests 3 for votes 2, 3, 5 in fibonacci', () => {
    const { options, hasScorable } = buildFinalWeightOptions(
      [vote(2, 0), vote(3, 1), vote(5, 2)],
      'fibonacci'
    );
    expect(hasScorable).toBe(true);
    expect(options.map((o) => o.value)).toEqual([2, 3, 5]);
    expect(options.filter((o) => o.suggested).map((o) => o.value)).toEqual([3]);
  });

  it('returns no options when there are no scorable votes', () => {
    const votes = [vote(null, 0), vote('coffee', 1), vote('no-clue', 2)];
    const result = buildFinalWeightOptions(votes, 'fibonacci');
    expect(result.hasScorable).toBe(false);
    expect(result.options).toEqual([]);
    expect(buildFinalWeightOptions([], 't-shirt').options).toEqual([]);
  });
});
