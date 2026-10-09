import * as fc from 'fast-check';
import { calculate } from '../../server/src/services/metrics-engine';
import { quoteCsvField } from '../csv';
import {
  NOT_AVAILABLE,
  NO_VOTE_LABEL,
  SUMMARY_HEADER,
  VOTE_HEADER,
  buildEstimateExportRows,
  buildSummaryRow,
  buildVoteRows,
  formatAverage,
  formatVotingDuration,
  sortCompletedEstimates,
} from '../estimate-export';
import {
  ALL_CARDS,
  FIBONACCI_SEQUENCE,
  SPECIAL_CARDS,
  formatDuration,
  getCardsForVotingSystem,
  type CardValue,
  type ExtendedCardValue,
  type HistoryEntry,
  type ParticipantVote,
  type VotingSystemType,
} from '../types';

// Feature: poker-retro-ux-improvements — Properties 2, 3, 4 and 24 of the
// estimate Export_Document builder.
//
// The pure units under test live in `shared/estimate-export.ts`; the reference
// metrics come from the real metrics engine (`server/src/services/metrics-engine.ts`)
// so the export fields are compared against computed values rather than against
// a re-implementation.

/** The four voting systems the session configuration can hold. */
const votingSystemArb: fc.Arbitrary<VotingSystemType> = fc.constantFrom(
  'fibonacci',
  'modified-fibonacci',
  't-shirt',
  'power-of-2'
);

/**
 * The metrics engine's signature predates the extended voting systems: it
 * accepts `CardValue` while `getCardsForVotingSystem` yields the wider
 * `ExtendedCardValue`. The narrowing happens in one place so the call sites
 * stay readable, and no `any` is introduced.
 */
function asCardValue(value: ExtendedCardValue): CardValue {
  return value as CardValue;
}

function participantId(index: number): string {
  return `participant-${index}`;
}

/**
 * Half of the one-decimal rounding step, with a slack for binary
 * representation error at the .x5 boundary.
 */
const ROUNDING_TOLERANCE = 0.05 + 1e-9;

/** Positional column indices of the Summary_Row (Requirement 1.10). */
const SUMMARY = {
  story: 0,
  participants: 1,
  numericVotes: 2,
  average: 3,
  mode: 4,
  spread: 5,
  distribution: 6,
  outliers: 7,
  duration: 8,
  completedAt: 9,
} as const;

/**
 * Reads a `value=count; value=count` distribution field back into a record.
 *
 * Card values never contain `=` or `;`, so splitting is unambiguous; the last
 * `=` is used as the separator to stay safe if that ever changes.
 */
function parseDistributionField(field: string): Record<string, number> {
  if (field === '') {
    return {};
  }
  const parsed: Record<string, number> = {};
  for (const entry of field.split('; ')) {
    const separator = entry.lastIndexOf('=');
    parsed[entry.slice(0, separator)] = Number(entry.slice(separator + 1));
  }
  return parsed;
}

/** The distinct card values of a distribution field, in emitted order. */
function distributionKeys(field: string): string[] {
  if (field === '') {
    return [];
  }
  return field.split('; ').map((entry) => entry.slice(0, entry.lastIndexOf('=')));
}

/** Builds a Completed_Estimate from cards whose participants all voted. */
function entryFromCards(
  cards: readonly ExtendedCardValue[],
  overrides: Partial<HistoryEntry> = {}
): HistoryEntry {
  const selections = new Map<string, CardValue>();
  cards.forEach((card, index) => selections.set(participantId(index), asCardValue(card)));

  const participants: ParticipantVote[] = cards.map((card, index) => ({
    userId: participantId(index),
    displayName: `Participant ${index}`,
    cardValue: asCardValue(card),
  }));

  return {
    roundId: 'round-0',
    storyDescription: 'Story',
    participants,
    metrics: calculate(selections),
    completedAt: '2026-01-01T09:00:00.000Z',
    ...overrides,
  };
}

describe('Property 2: Summary_Row statistics equal the computed metrics', () => {
  // *For any* selection set over the card values of any voting system, the
  // exported average, mode, spread, distribution and outlier count equal the
  // `VotingMetrics` values computed by the metrics engine for the same
  // selections.
  //
  // **Validates: Requirements 1.13, 1.14, 14.9**

  /**
   * 1–50 participants drawing cards from the selected system's card set.
   *
   * `size: 'max'` is required: fast-check's default sizing caps a generated
   * array near ten entries whatever `maxLength` says, so without it the
   * 1-through-50-participant range R14.9 states would never be reached and the
   * outlier and spread fields would only ever be checked over small sets.
   */
  const selectionArb = votingSystemArb.chain((votingSystem) =>
    fc
      .array(fc.constantFrom(...getCardsForVotingSystem(votingSystem)), {
        minLength: 1,
        maxLength: 50,
        size: 'max',
      })
      .map((cards) => ({ votingSystem, cards }))
  );

  /** Largest participant count the property actually saw (coverage guard). */
  let widestSelection = 0;

  it('R1.13/R1.14/R14.9: every statistic field carries the computed metrics value', () => {
    fc.assert(
      fc.property(selectionArb, ({ votingSystem, cards }) => {
        widestSelection = Math.max(widestSelection, cards.length);
        const entry = entryFromCards(cards);
        const metrics = entry.metrics;
        const row = buildSummaryRow(entry, votingSystem);

        expect(row[SUMMARY.participants]).toBe(String(cards.length));
        expect(Number(row[SUMMARY.numericVotes])).toBe(metrics.numericVoteCount);

        if (metrics.insufficientData) {
          // Covered in full by Property 3; asserted here so the insufficient
          // tail of the generated space does not escape unchecked.
          expect(row[SUMMARY.average]).toBe(NOT_AVAILABLE);
          expect(row[SUMMARY.mode]).toBe(NOT_AVAILABLE);
          expect(row[SUMMARY.spread]).toBe(NOT_AVAILABLE);
        } else {
          if (metrics.average === null || !Number.isFinite(metrics.average)) {
            // The engine yields a non-finite average for card sets it cannot
            // add up (the t-shirt system); there is no numeric value to render.
            expect(row[SUMMARY.average]).toBe(NOT_AVAILABLE);
          } else {
            // Half-up rounding to one decimal place moves a value sitting
            // exactly on a .x5 boundary (13.75 -> 13.8) by a full 0.05, which
            // binary floating point reports as marginally more than 0.05.
            expect(Math.abs(Number(row[SUMMARY.average]) - metrics.average)).toBeLessThanOrEqual(
              ROUNDING_TOLERANCE
            );
            expect(row[SUMMARY.average]).toMatch(/^-?\d+\.\d$/);
          }
          expect(row[SUMMARY.mode]).toBe(String(metrics.mode));
          expect(row[SUMMARY.spread]).toBe(String(metrics.spread));
        }

        expect(parseDistributionField(row[SUMMARY.distribution])).toEqual(metrics.distribution);
        expect(Number(row[SUMMARY.outliers])).toBe(metrics.outliers.length);

        // R1.10: distribution entries follow the card sequence of the session
        // voting system, one entry per distinct card value received.
        const presentInSequence = getCardsForVotingSystem(votingSystem)
          .map(String)
          .filter((key) => Object.prototype.hasOwnProperty.call(metrics.distribution, key));
        expect(distributionKeys(row[SUMMARY.distribution])).toEqual(presentInSequence);
      }),
      { numRuns: 200 }
    );
  });

  it('R14.9: the selection generator actually reaches the stated 50-participant bound', () => {
    // A coverage guard over the run above: if the generator ever collapses back
    // to fast-check's default sizing this fails instead of quietly shrinking the
    // exercised input space.
    expect(widestSelection).toBeGreaterThanOrEqual(45);
    expect(widestSelection).toBeLessThanOrEqual(50);
  });
});

describe('Property 3: Insufficient data renders as a dash', () => {
  // *For any* Completed_Estimate whose metrics hold `insufficientData === true`,
  // the exported average, mode and spread fields each equal `-`, while the
  // distribution and outlier-count fields still carry their computed values.
  //
  // **Validates: Requirements 1.15, 14.10**

  /** At most one numeric vote, so `insufficientData` always holds. */
  const insufficientArb = fc.record({
    votingSystem: votingSystemArb,
    numericCards: fc.array(fc.constantFrom(...FIBONACCI_SEQUENCE), {
      minLength: 0,
      maxLength: 1,
    }),
    specialCards: fc.array(fc.constantFrom(...SPECIAL_CARDS), { minLength: 0, maxLength: 10 }),
    noVoteCount: fc.nat({ max: 39 }),
  });

  it('R1.15/R14.10: average, mode and spread blank while distribution and outliers stay', () => {
    fc.assert(
      fc.property(
        insufficientArb,
        ({ votingSystem, numericCards, specialCards, noVoteCount }) => {
          const voted: CardValue[] = [...numericCards, ...specialCards];
          const selections = new Map<string, CardValue>();
          voted.forEach((card, index) => selections.set(participantId(index), card));

          const participants: ParticipantVote[] = [
            ...voted.map((card, index) => ({
              userId: participantId(index),
              displayName: `Voter ${index}`,
              cardValue: card,
            })),
            ...Array.from({ length: noVoteCount }, (_unused, index) => ({
              userId: participantId(voted.length + index),
              displayName: `Silent ${index}`,
              cardValue: null,
            })),
          ];

          const metrics = calculate(selections);
          const entry: HistoryEntry = {
            roundId: 'round-0',
            storyDescription: 'Story',
            participants,
            metrics,
            completedAt: '2026-01-01T09:00:00.000Z',
          };
          const row = buildSummaryRow(entry, votingSystem);

          expect(metrics.insufficientData).toBe(true);
          expect(row[SUMMARY.average]).toBe(NOT_AVAILABLE);
          expect(row[SUMMARY.mode]).toBe(NOT_AVAILABLE);
          expect(row[SUMMARY.spread]).toBe(NOT_AVAILABLE);

          // The real values survive the blanking.
          expect(parseDistributionField(row[SUMMARY.distribution])).toEqual(metrics.distribution);
          expect(Number(row[SUMMARY.outliers])).toBe(metrics.outliers.length);
          expect(row[SUMMARY.participants]).toBe(String(participants.length));
          expect(Number(row[SUMMARY.numericVotes])).toBe(metrics.numericVoteCount);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('R1.13/R1.15: formatAverage blanks on insufficient data and rounds half up otherwise', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ min: 0, max: 1000, noNaN: true }),
          fc.constant(null),
          fc.constant(Number.NaN)
        ),
        (average) => {
          expect(formatAverage(average, true)).toBe(NOT_AVAILABLE);

          const rendered = formatAverage(average, false);
          if (average === null || !Number.isFinite(average)) {
            expect(rendered).toBe(NOT_AVAILABLE);
          } else {
            expect(rendered).toMatch(/^\d+\.\d$/);
            expect(Math.abs(Number(rendered) - average)).toBeLessThanOrEqual(ROUNDING_TOLERANCE);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe('Property 4: Export document shape and ordering', () => {
  // *For any* session history, the document starts with exactly one Summary
  // header, holds exactly one Summary_Row per Completed_Estimate in
  // non-decreasing `completedAt` order with ties keeping their stored relative
  // order, and places after each Summary_Row exactly one Vote header followed
  // by that estimate's Vote_Rows in ascending display-name order, each carrying
  // that estimate's story description and rendering a null card as `No Vote`.
  //
  // **Validates: Requirements 1.9, 1.11, 1.12, 1.20, 1.21**

  /** A small pool so equal timestamps — the tie-stability case — are frequent. */
  const COMPLETED_AT_POOL = [
    '2026-01-01T09:00:00.000Z',
    '2026-01-01T09:05:00.000Z',
    '2026-01-01T09:10:00.000Z',
  ];

  /** Names including duplicates, unicode, CSV-structural characters and blanks. */
  const nameArb = fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom('Ada', 'ada', 'Bob', 'Zoë', 'Ωmega', 'æon', '') },
    { weight: 2, arbitrary: fc.constantFrom('name,with,comma', 'quote"name', 'line\nbreak', '  ') },
    { weight: 1, arbitrary: fc.string({ maxLength: 12, size: 'max' }) }
  );

  const storyArb = fc.constantFrom(
    'Story',
    'Story, with comma',
    'Story "quoted"',
    'Story\r\nwrapped',
    ''
  );

  const participantArb: fc.Arbitrary<ParticipantVote> = fc.record({
    userId: fc.uuid(),
    displayName: nameArb,
    cardValue: fc.oneof(fc.constantFrom(...ALL_CARDS), fc.constant(null)),
  });

  /**
   * `size: 'max'` on both the participant list and the history list: fast-check's
   * default sizing would cap each near ten entries whatever `maxLength` says, so
   * without it neither the 50-participant estimate nor the 30-estimate history
   * this property claims to walk would ever be generated.
   */
  const entryArb = fc
    .record({
      storyDescription: storyArb,
      participants: fc.array(participantArb, { minLength: 0, maxLength: 50, size: 'max' }),
      completedAt: fc.constantFrom(...COMPLETED_AT_POOL),
      votingDurationMs: fc.oneof(fc.nat({ max: 600_000 }), fc.constant(undefined)),
    })
    .map(({ storyDescription, participants, completedAt, votingDurationMs }) => {
      const selections = new Map<string, CardValue>();
      for (const participant of participants) {
        if (participant.cardValue !== null) {
          selections.set(participant.userId, participant.cardValue);
        }
      }
      const entry: HistoryEntry = {
        roundId: 'round',
        storyDescription,
        participants,
        metrics: calculate(selections),
        completedAt,
        ...(votingDurationMs === undefined ? {} : { votingDurationMs }),
      };
      return entry;
    });

  const historyArb = fc
    .array(entryArb, { minLength: 0, maxLength: 30, size: 'max' })
    // Unique round ids make the stored position of each record identifiable,
    // which is what the tie-stability assertion needs.
    .map((entries) => entries.map((entry, index) => ({ ...entry, roundId: `round-${index}` })));

  function isRow(row: readonly string[], expected: readonly string[]): boolean {
    return row.length === expected.length && row.every((field, index) => field === expected[index]);
  }

  /** Largest history and participant counts the property actually saw. */
  let widestHistory = 0;
  let widestParticipants = 0;

  it('R1.9/R1.11/R1.12/R1.20/R1.21: headers, ordering, adjacency and ownership hold', () => {
    fc.assert(
      fc.property(historyArb, votingSystemArb, (history, votingSystem) => {
        widestHistory = Math.max(widestHistory, history.length);
        for (const entry of history) {
          widestParticipants = Math.max(widestParticipants, entry.participants.length);
        }
        const rows = buildEstimateExportRows({ history, votingSystem });

        // R1.21: exactly one Summary header, at the very start.
        expect(rows[0]).toEqual([...SUMMARY_HEADER]);
        expect(rows.filter((row) => isRow(row, SUMMARY_HEADER))).toHaveLength(1);

        // R1.21: exactly one Vote header per Completed_Estimate.
        expect(rows.filter((row) => isRow(row, VOTE_HEADER))).toHaveLength(history.length);

        const sorted = sortCompletedEstimates(history);
        expect(sorted).toHaveLength(history.length);

        const storedIndex = new Map(history.map((entry, index) => [entry.roundId, index]));
        for (let i = 1; i < sorted.length; i += 1) {
          // R1.9: non-decreasing completedAt, ties keeping their stored order.
          expect(sorted[i - 1].completedAt <= sorted[i].completedAt).toBe(true);
          if (sorted[i - 1].completedAt === sorted[i].completedAt) {
            const previous = storedIndex.get(sorted[i - 1].roundId);
            const current = storedIndex.get(sorted[i].roundId);
            expect(previous).toBeLessThan(current as number);
          }
        }

        let cursor = 1;
        for (const entry of sorted) {
          // R1.9: one Summary_Row per estimate, in sorted position.
          expect(rows[cursor]).toEqual(buildSummaryRow(entry, votingSystem));
          cursor += 1;

          // R1.20/R1.21: the Vote header, then the estimate's own Vote_Rows,
          // immediately after its Summary_Row.
          expect(rows[cursor]).toEqual([...VOTE_HEADER]);
          cursor += 1;

          const voteRows = rows.slice(cursor, cursor + entry.participants.length);
          expect(voteRows).toEqual(buildVoteRows(entry));
          cursor += entry.participants.length;

          const quotedStory = quoteCsvField(entry.storyDescription);
          const expectedNames = entry.participants
            .map((participant) => participant.displayName)
            .sort()
            .map(quoteCsvField);

          voteRows.forEach((voteRow, index) => {
            // R1.11: story description, display name, card value.
            expect(voteRow).toHaveLength(VOTE_HEADER.length);
            expect(voteRow[0]).toBe(quotedStory);
            // R1.20: ascending display-name order.
            expect(voteRow[1]).toBe(expectedNames[index]);
          });

          // R1.11: the Vote_Rows of an estimate carry exactly that estimate's
          // (name, vote) pairs — no vote leaks between estimates.
          const renderVote = (cardValue: CardValue | null): string =>
            cardValue === null ? NO_VOTE_LABEL : String(cardValue);
          const expectedPairs = entry.participants
            .map((participant) =>
              [
                quoteCsvField(participant.displayName),
                quoteCsvField(renderVote(participant.cardValue)),
              ].join('\u0000')
            )
            .sort();
          const actualPairs = voteRows.map((voteRow) => [voteRow[1], voteRow[2]].join('\u0000'));
          expect([...actualPairs].sort()).toEqual(expectedPairs);

          // R1.12: a null card value renders as `No Vote`.
          expect(voteRows.filter((voteRow) => voteRow[2] === NO_VOTE_LABEL)).toHaveLength(
            entry.participants.filter((participant) => participant.cardValue === null).length
          );
        }

        // Nothing beyond the walked blocks: no stray row, no missing row.
        expect(cursor).toBe(rows.length);
      }),
      { numRuns: 200 }
    );
  });

  it('R1.9/R1.11: the history generator actually reaches its stated entry and participant bounds', () => {
    // A coverage guard over the run above, so a future return to fast-check's
    // default sizing fails here rather than shrinking the walked document.
    expect(widestHistory).toBeGreaterThanOrEqual(27);
    expect(widestHistory).toBeLessThanOrEqual(30);
    expect(widestParticipants).toBeGreaterThanOrEqual(45);
    expect(widestParticipants).toBeLessThanOrEqual(50);
  });
});

describe('Property 24: Voting duration formatting', () => {
  // *For any* duration in 0–10^8 ms, or an absent duration, the exported field
  // is `-` when absent and otherwise `MM:SS` with two zero-padded digits per
  // part, the minute part holding the total elapsed minutes.
  //
  // **Validates: Requirements 1.10**

  const durationArb: fc.Arbitrary<number | undefined> = fc.oneof(
    fc.nat({ max: 100_000_000 }),
    fc.constant(undefined)
  );

  const EXAMPLES: [number | undefined][] = [
    [undefined],
    [0],
    [999],
    [59_999],
    [60_000],
    [3_600_000],
    [100_000_000],
  ];

  it('R1.10: absent durations blank and present durations render as MM:SS', () => {
    fc.assert(
      fc.property(durationArb, (ms) => {
        const field = formatVotingDuration(ms);

        if (ms === undefined) {
          expect(field).toBe(NOT_AVAILABLE);
          return;
        }

        expect(field).toBe(formatDuration(ms));
        // Minutes carry the total elapsed minutes, so the part grows past two
        // digits rather than wrapping at an hour.
        expect(field).toMatch(/^\d{2,}:\d{2}$/);

        const [minutes, seconds] = field.split(':');
        expect(minutes).toBe(String(Math.floor(ms / 60_000)).padStart(2, '0'));
        expect(seconds).toBe(String(Math.floor(ms / 1000) % 60).padStart(2, '0'));
      }),
      { numRuns: 200, examples: EXAMPLES }
    );
  });
});
