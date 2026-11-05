import * as fc from 'fast-check';
import { calculate } from '../../server/src/services/metrics-engine';
import { quoteCsvField, serializeCsvDocument } from '../csv';
import {
  FINAL_WEIGHT_HEADER,
  NOT_AVAILABLE,
  SUMMARY_HEADER,
  VOTE_HEADER,
  buildEstimateExportCsv,
  buildEstimateExportRows,
  buildSummaryRow,
  buildVoteRows,
  sortCompletedEstimates,
} from '../estimate-export';
import {
  ALL_CARDS,
  type ExtendedCardValue,
  type FinalWeightRecord,
  type HistoryEntry,
  type ParticipantVote,
  type VotingSystemType,
} from '../types';

// Feature: final-weight-accuracy, Property 8: Export column is last and absent output is unchanged
//
// **Validates: Requirements 12.2, 12.3, 12.4**

const votingSystemArb: fc.Arbitrary<VotingSystemType> = fc.constantFrom(
  'fibonacci',
  'modified-fibonacci',
  't-shirt',
  'power-of-2'
);

const COMPLETED_AT_POOL = [
  '2026-01-01T09:00:00.000Z',
  '2026-01-01T09:05:00.000Z',
  '2026-01-01T09:10:00.000Z',
];

/** Card values including 0, which must render as '0' rather than '-'. */
const weightValueArb: fc.Arbitrary<ExtendedCardValue> = fc.oneof(
  fc.constant<ExtendedCardValue>(0),
  fc.constantFrom(...ALL_CARDS)
);

const finalWeightArb: fc.Arbitrary<FinalWeightRecord> = fc.record({
  value: weightValueArb,
  votingSystem: votingSystemArb,
  showFunniest: fc.boolean(),
});

const participantArb: fc.Arbitrary<ParticipantVote> = fc.record({
  userId: fc.uuid(),
  displayName: fc.constantFrom('Ada', 'Bob', 'Zoë', 'name,with,comma', 'quote"name', ''),
  cardValue: fc.oneof(fc.constantFrom(...ALL_CARDS), fc.constant(null)),
});

const storyArb = fc.constantFrom('Story', 'Story, with comma', 'Story "quoted"', 'Story\r\nwrap', '');

/** An entry with no finalWeight key at all. */
const plainEntryArb: fc.Arbitrary<HistoryEntry> = fc
  .record({
    storyDescription: storyArb,
    participants: fc.array(participantArb, { minLength: 0, maxLength: 12 }),
    completedAt: fc.constantFrom(...COMPLETED_AT_POOL),
    votingDurationMs: fc.oneof(fc.nat({ max: 600_000 }), fc.constant(undefined)),
  })
  .map(({ storyDescription, participants, completedAt, votingDurationMs }) => {
    const selections = new Map<string, ExtendedCardValue>();
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

function withRoundIds(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.map((entry, index) => ({ ...entry, roundId: `round-${index}` }));
}

const noWeightHistoryArb = fc
  .array(plainEntryArb, { minLength: 0, maxLength: 10 })
  .map(withRoundIds);

/** History where every entry optionally carries a weight, with at least one that does. */
const someWeightHistoryArb = fc
  .tuple(
    fc.array(fc.tuple(plainEntryArb, fc.option(finalWeightArb, { nil: undefined })), {
      minLength: 0,
      maxLength: 10,
    }),
    plainEntryArb,
    finalWeightArb,
    fc.nat({ max: 10 })
  )
  .map(([optional, forced, forcedWeight, position]) => {
    const entries = optional.map(([entry, weight]) =>
      weight === undefined ? entry : { ...entry, finalWeight: weight }
    );
    entries.splice(Math.min(position, entries.length), 0, { ...forced, finalWeight: forcedWeight });
    return withRoundIds(entries);
  });

/** The legacy document, rebuilt from the unchanged building blocks. */
function legacyRows(history: readonly HistoryEntry[], votingSystem: VotingSystemType): string[][] {
  const rows: string[][] = [[...SUMMARY_HEADER].map(quoteCsvField)];
  for (const entry of sortCompletedEstimates(history)) {
    rows.push(buildSummaryRow(entry, votingSystem));
    rows.push([...VOTE_HEADER].map(quoteCsvField));
    rows.push(...buildVoteRows(entry));
  }
  return rows;
}

describe('Property 8: Export column is last and absent output is unchanged', () => {
  it('R12.4: SUMMARY_HEADER constant keeps its ten legacy columns', () => {
    expect(SUMMARY_HEADER).toHaveLength(10);
    expect(SUMMARY_HEADER[9]).toBe('Completed At');
    expect(SUMMARY_HEADER).not.toContain(FINAL_WEIGHT_HEADER);
    expect(FINAL_WEIGHT_HEADER).toBe('Final Weight');
  });

  it('R12.3: with no finalWeight on any entry, rows and CSV equal the legacy output', () => {
    fc.assert(
      fc.property(noWeightHistoryArb, votingSystemArb, (history, votingSystem) => {
        const rows = buildEstimateExportRows({ history, votingSystem });
        const expected = legacyRows(history, votingSystem);

        expect(rows).toEqual(expected);
        expect(rows[0]).toHaveLength(10);
        for (const entry of history) {
          expect(buildSummaryRow(entry, votingSystem)).toHaveLength(10);
        }
        expect(buildEstimateExportCsv({ history, votingSystem })).toBe(
          serializeCsvDocument(expected)
        );
      }),
      { numRuns: 100 }
    );
  });

  it('R12.2/R12.4: with a weight, Final Weight is the last summary column and others are unchanged', () => {
    fc.assert(
      fc.property(someWeightHistoryArb, votingSystemArb, (history, votingSystem) => {
        const rows = buildEstimateExportRows({ history, votingSystem });
        const legacy = legacyRows(history, votingSystem);
        const sorted = sortCompletedEstimates(history);

        expect(rows).toHaveLength(legacy.length);
        expect(rows[0]).toEqual([...SUMMARY_HEADER, FINAL_WEIGHT_HEADER].map(quoteCsvField));
        expect(rows[0][rows[0].length - 1]).toBe(quoteCsvField(FINAL_WEIGHT_HEADER));
        expect(rows[0].slice(0, 10)).toEqual(legacy[0]);

        let cursor = 1;
        for (const entry of sorted) {
          const summary = rows[cursor];
          expect(summary).toHaveLength(11);
          // First ten columns identical to the legacy summary row.
          expect(summary.slice(0, 10)).toEqual(legacy[cursor]);
          // Last column: the weight, '0' for zero, '-' when absent.
          const expectedWeight =
            entry.finalWeight === undefined ? NOT_AVAILABLE : String(entry.finalWeight.value);
          expect(summary[10]).toBe(quoteCsvField(expectedWeight));
          if (entry.finalWeight !== undefined && entry.finalWeight.value === 0) {
            expect(summary[10]).toBe('0');
          }
          if (entry.finalWeight === undefined) {
            expect(summary[10]).toBe(NOT_AVAILABLE);
          }
          cursor += 1;

          // Vote header and vote rows stay as they were.
          expect(rows[cursor]).toEqual(legacy[cursor]);
          expect(rows[cursor]).toEqual([...VOTE_HEADER].map(quoteCsvField));
          cursor += 1;
          const voteRows = buildVoteRows(entry);
          expect(rows.slice(cursor, cursor + voteRows.length)).toEqual(voteRows);
          cursor += voteRows.length;
        }
        expect(cursor).toBe(rows.length);

        // Constant is untouched by building a weighted document.
        expect(SUMMARY_HEADER).toHaveLength(10);
      }),
      { numRuns: 100 }
    );
  });

  it('R12.2: a weight of 0 renders as 0 and a missing weight renders as -', () => {
    const base = (fc.sample(plainEntryArb, 1)[0] as HistoryEntry);
    const history: HistoryEntry[] = [
      { ...base, roundId: 'a', completedAt: COMPLETED_AT_POOL[0], finalWeight: { value: 0, votingSystem: 'fibonacci', showFunniest: false } },
      { ...base, roundId: 'b', completedAt: COMPLETED_AT_POOL[1] },
    ];
    const rows = buildEstimateExportRows({ history, votingSystem: 'fibonacci' });
    const summaries = rows.filter((row) => row.length === 11).slice(1); // drop header
    expect(summaries.map((row) => row[10])).toEqual(['0', '-']);
  });
});
