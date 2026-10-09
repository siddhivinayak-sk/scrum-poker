import { parseCsv } from '../csv';
import {
  NOT_AVAILABLE,
  NO_VOTE_LABEL,
  SUMMARY_HEADER,
  VOTE_HEADER,
  buildEstimateExportCsv,
  buildEstimateExportRows,
  buildSummaryRow,
  buildVoteRows,
  formatAverage,
  formatDistribution,
  formatVotingDuration,
  sortCompletedEstimates,
} from '../estimate-export';
import type { HistoryEntry, ParticipantVote, VotingMetrics } from '../types';

/**
 * Example unit tests for the pure estimate-export document builder.
 *
 * Validates: Requirements 1.10, 1.12, 1.15, 1.21, 14.1, 14.2
 *
 * The property tests cover statistics agreement and document shape over
 * generated histories; these examples pin the literal things a generated
 * invariant cannot see: the exact header text and column order of both header
 * rows, every branch that renders the single character `-`, the `No Vote`
 * branch, and the duration boundary where the minute part carries the total
 * elapsed minutes (60 minutes renders as `60:00`, not `00:00`).
 */

/** RFC 4180 record terminator, spelled out so the assertions read literally. */
const CRLF = '\r\n';

/** Index of each Summary_Row field, in the order Requirement 1.10 states. */
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

/** Index of each Vote_Row field, in the order Requirement 1.11 states. */
const VOTE = { story: 0, participant: 1, vote: 2 } as const;

function buildMetrics(overrides: Partial<VotingMetrics> = {}): VotingMetrics {
  return {
    average: 5,
    mode: 5,
    spread: 3,
    distribution: { '3': 1, '5': 2 },
    outliers: [],
    numericVoteCount: 3,
    insufficientData: false,
    ...overrides,
  };
}

function buildVote(displayName: string, cardValue: ParticipantVote['cardValue']): ParticipantVote {
  return { userId: `user-${displayName.toLowerCase()}`, displayName, cardValue };
}

function buildEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    roundId: 'round-1',
    storyDescription: 'Checkout flow',
    participants: [buildVote('Ada', 5)],
    metrics: buildMetrics(),
    completedAt: '2026-05-01T10:00:00.000Z',
    votingDurationMs: 95_000,
    ...overrides,
  };
}

describe('header rows', () => {
  it('R1.10, R1.21: SUMMARY_HEADER names the ten summary fields in order', () => {
    expect(SUMMARY_HEADER).toEqual([
      'Story',
      'Participants',
      'Numeric Votes',
      'Average',
      'Mode',
      'Spread',
      'Distribution',
      'Outliers',
      'Duration',
      'Completed At',
    ]);
  });

  it('R1.21: VOTE_HEADER names the three vote fields in order', () => {
    expect(VOTE_HEADER).toEqual(['Story', 'Participant', 'Vote']);
  });

  it('R1.15: NOT_AVAILABLE is the single character hyphen-minus', () => {
    expect(NOT_AVAILABLE).toBe('-');
    expect(NOT_AVAILABLE).toHaveLength(1);
  });

  it('R1.12: NO_VOTE_LABEL is the exact text "No Vote"', () => {
    expect(NO_VOTE_LABEL).toBe('No Vote');
  });
});

describe('buildSummaryRow column order', () => {
  it('R1.10: emits the ten fields in the order the requirement states', () => {
    const row = buildSummaryRow(
      buildEntry({
        storyDescription: 'Checkout flow',
        participants: [buildVote('Ada', 5), buildVote('Linus', 8), buildVote('Grace', null)],
        metrics: buildMetrics({
          average: 6.5,
          mode: 5,
          spread: 3,
          distribution: { '5': 1, '8': 1 },
          outliers: ['user-linus'],
          numericVoteCount: 2,
        }),
        completedAt: '2026-05-01T10:15:30.000Z',
        votingDurationMs: 95_000,
      }),
      'fibonacci'
    );

    expect(row).toHaveLength(SUMMARY_HEADER.length);
    expect(row[SUMMARY.story]).toBe('Checkout flow');
    expect(row[SUMMARY.participants]).toBe('3');
    expect(row[SUMMARY.numericVotes]).toBe('2');
    expect(row[SUMMARY.average]).toBe('6.5');
    expect(row[SUMMARY.mode]).toBe('5');
    expect(row[SUMMARY.spread]).toBe('3');
    expect(row[SUMMARY.distribution]).toBe('5=1; 8=1');
    expect(row[SUMMARY.outliers]).toBe('1');
    expect(row[SUMMARY.duration]).toBe('01:35');
    expect(row[SUMMARY.completedAt]).toBe('2026-05-01T10:15:30.000Z');
  });

  it('R1.10: counts participants and outliers rather than listing them', () => {
    const row = buildSummaryRow(
      buildEntry({
        participants: [buildVote('Ada', 5), buildVote('Grace', null)],
        metrics: buildMetrics({ outliers: ['user-ada', 'user-grace'] }),
      }),
      'fibonacci'
    );

    expect(row[SUMMARY.participants]).toBe('2');
    expect(row[SUMMARY.outliers]).toBe('2');
  });

  it('R1.10, R1.16: quotes a story description that holds a comma', () => {
    const row = buildSummaryRow(buildEntry({ storyDescription: 'Checkout, redesign' }), 'fibonacci');
    expect(row[SUMMARY.story]).toBe('"Checkout, redesign"');
  });
});

describe('formatAverage', () => {
  it('R1.13: renders one decimal place with a full stop separator', () => {
    expect(formatAverage(5, false)).toBe('5.0');
    expect(formatAverage(6.5, false)).toBe('6.5');
  });

  it('R1.13: rounds half up at the .x5 boundary', () => {
    expect(formatAverage(2.45, false)).toBe('2.5');
    expect(formatAverage(7.26, false)).toBe('7.3');
    expect(formatAverage(4.44, false)).toBe('4.4');
  });

  it('R1.15: renders "-" when the round holds insufficient data', () => {
    expect(formatAverage(4.2, true)).toBe(NOT_AVAILABLE);
  });

  it('R1.15: renders "-" when the average is null', () => {
    expect(formatAverage(null, false)).toBe(NOT_AVAILABLE);
  });
});

describe('insufficient data branches', () => {
  it('R1.15: renders average, mode and spread as "-" while keeping distribution and outlier count', () => {
    const row = buildSummaryRow(
      buildEntry({
        participants: [buildVote('Ada', 'coffee')],
        metrics: buildMetrics({
          average: null,
          mode: null,
          spread: null,
          distribution: { coffee: 1 },
          outliers: ['user-ada'],
          numericVoteCount: 0,
          insufficientData: true,
        }),
      }),
      'fibonacci'
    );

    expect(row[SUMMARY.average]).toBe(NOT_AVAILABLE);
    expect(row[SUMMARY.mode]).toBe(NOT_AVAILABLE);
    expect(row[SUMMARY.spread]).toBe(NOT_AVAILABLE);
    // insufficientData blanks only the three statistics above.
    expect(row[SUMMARY.distribution]).toBe('coffee=1');
    expect(row[SUMMARY.outliers]).toBe('1');
    expect(row[SUMMARY.numericVotes]).toBe('0');
  });

  it('R1.15: blanks mode and spread on insufficient data even when the values are present', () => {
    const row = buildSummaryRow(
      buildEntry({
        metrics: buildMetrics({ average: 5, mode: 5, spread: 0, insufficientData: true }),
      }),
      'fibonacci'
    );

    expect(row[SUMMARY.average]).toBe(NOT_AVAILABLE);
    expect(row[SUMMARY.mode]).toBe(NOT_AVAILABLE);
    expect(row[SUMMARY.spread]).toBe(NOT_AVAILABLE);
  });

  it('R1.14: renders a zero spread as "0" when the data is sufficient', () => {
    const row = buildSummaryRow(
      buildEntry({ metrics: buildMetrics({ spread: 0, insufficientData: false }) }),
      'fibonacci'
    );
    expect(row[SUMMARY.spread]).toBe('0');
  });
});

describe('formatVotingDuration', () => {
  it('R1.10: renders "-" when the completed estimate holds no recorded duration', () => {
    expect(formatVotingDuration(undefined)).toBe(NOT_AVAILABLE);
  });

  it('R1.10: renders a 60-minute duration as 60:00, the minute part holding total minutes', () => {
    expect(formatVotingDuration(3_600_000)).toBe('60:00');
  });

  it('R1.10: keeps counting minutes beyond the hour', () => {
    expect(formatVotingDuration(3_661_000)).toBe('61:01');
    expect(formatVotingDuration(7_200_000)).toBe('120:00');
  });

  it('R1.10: zero-pads both parts below ten', () => {
    expect(formatVotingDuration(0)).toBe('00:00');
    expect(formatVotingDuration(9_000)).toBe('00:09');
    expect(formatVotingDuration(95_000)).toBe('01:35');
    expect(formatVotingDuration(3_599_000)).toBe('59:59');
  });

  it('R1.10: the summary duration column carries "-" for an estimate without a duration', () => {
    const row = buildSummaryRow(buildEntry({ votingDurationMs: undefined }), 'fibonacci');
    expect(row[SUMMARY.duration]).toBe(NOT_AVAILABLE);
  });

  it('R1.10: the summary duration column renders an hour-long round as 60:00', () => {
    const row = buildSummaryRow(buildEntry({ votingDurationMs: 3_600_000 }), 'fibonacci');
    expect(row[SUMMARY.duration]).toBe('60:00');
  });
});

describe('formatDistribution', () => {
  it('R1.10: pairs each distinct card value with its count, joined by "; "', () => {
    expect(formatDistribution({ '5': 2, '3': 1 }, 'fibonacci')).toBe('3=1; 5=2');
  });

  it('R1.10: orders entries by the card sequence of the session voting system', () => {
    expect(formatDistribution({ '13': 1, '2': 3, '8': 2 }, 'fibonacci')).toBe('2=3; 8=2; 13=1');
    expect(formatDistribution({ L: 1, S: 2, XS: 1 }, 't-shirt')).toBe('XS=1; S=2; L=1');
  });

  it('R1.10: places special cards after the numeric cards of the system', () => {
    expect(formatDistribution({ coffee: 1, '5': 2 }, 'fibonacci')).toBe('5=2; coffee=1');
  });

  it('R1.10: appends keys the voting system does not define rather than dropping them', () => {
    // 34 belongs to fibonacci, not to power-of-2, so it follows the known keys.
    expect(formatDistribution({ '34': 1, '4': 2 }, 'power-of-2')).toBe('4=2; 34=1');
  });

  it('R1.10: renders an empty distribution as an empty field', () => {
    expect(formatDistribution({}, 'fibonacci')).toBe('');
  });
});

describe('buildVoteRows', () => {
  it('R1.11: emits story, participant and vote in that order', () => {
    const rows = buildVoteRows(
      buildEntry({ storyDescription: 'Checkout flow', participants: [buildVote('Ada', 5)] })
    );

    expect(rows).toHaveLength(1);
    expect(rows[0][VOTE.story]).toBe('Checkout flow');
    expect(rows[0][VOTE.participant]).toBe('Ada');
    expect(rows[0][VOTE.vote]).toBe('5');
  });

  it('R1.12: renders a null card value as "No Vote"', () => {
    const rows = buildVoteRows(buildEntry({ participants: [buildVote('Grace', null)] }));
    expect(rows[0][VOTE.vote]).toBe(NO_VOTE_LABEL);
  });

  it('R1.12: renders a zero card value as "0", not as "No Vote"', () => {
    const rows = buildVoteRows(buildEntry({ participants: [buildVote('Grace', 0)] }));
    expect(rows[0][VOTE.vote]).toBe('0');
  });

  it('R1.12: renders a special card value by its own name', () => {
    const rows = buildVoteRows(buildEntry({ participants: [buildVote('Ada', 'coffee')] }));
    expect(rows[0][VOTE.vote]).toBe('coffee');
  });

  it('R1.20: orders rows by participant display name ascending', () => {
    const rows = buildVoteRows(
      buildEntry({
        participants: [
          buildVote('Linus', 8),
          buildVote('Ada', 5),
          buildVote('Grace', null),
          buildVote('Barbara', 'coffee'),
        ],
      })
    );

    expect(rows.map((row) => row[VOTE.participant])).toEqual(['Ada', 'Barbara', 'Grace', 'Linus']);
    expect(rows.map((row) => row[VOTE.vote])).toEqual(['5', 'coffee', NO_VOTE_LABEL, '8']);
  });

  it('R1.11: emits one row per recorded participant, including duplicate display names', () => {
    const rows = buildVoteRows(
      buildEntry({ participants: [buildVote('Ada', 5), buildVote('Ada', null)] })
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row[VOTE.vote])).toEqual(['5', NO_VOTE_LABEL]);
  });

  it('R1.11: emits no rows for an estimate recorded without participants', () => {
    expect(buildVoteRows(buildEntry({ participants: [] }))).toEqual([]);
  });
});

describe('sortCompletedEstimates', () => {
  it('R1.9: orders a newest-first history by completedAt ascending', () => {
    const history = [
      buildEntry({ roundId: 'c', completedAt: '2026-05-01T12:00:00.000Z' }),
      buildEntry({ roundId: 'b', completedAt: '2026-05-01T11:00:00.000Z' }),
      buildEntry({ roundId: 'a', completedAt: '2026-05-01T10:00:00.000Z' }),
    ];

    expect(sortCompletedEstimates(history).map((entry) => entry.roundId)).toEqual(['a', 'b', 'c']);
  });

  it('R1.9: keeps the stored order of records carrying equal completedAt values', () => {
    const tied = '2026-05-01T10:00:00.000Z';
    const history = [
      buildEntry({ roundId: 'first-stored', completedAt: tied }),
      buildEntry({ roundId: 'second-stored', completedAt: tied }),
      buildEntry({ roundId: 'earlier', completedAt: '2026-05-01T09:00:00.000Z' }),
    ];

    expect(sortCompletedEstimates(history).map((entry) => entry.roundId)).toEqual([
      'earlier',
      'first-stored',
      'second-stored',
    ]);
  });

  it('R1.9: leaves the stored history array untouched', () => {
    const history = [
      buildEntry({ roundId: 'late', completedAt: '2026-05-01T12:00:00.000Z' }),
      buildEntry({ roundId: 'early', completedAt: '2026-05-01T10:00:00.000Z' }),
    ];

    sortCompletedEstimates(history);

    expect(history.map((entry) => entry.roundId)).toEqual(['late', 'early']);
  });
});

describe('buildEstimateExportRows document shape', () => {
  const history: HistoryEntry[] = [
    buildEntry({
      roundId: 'round-2',
      storyDescription: 'Password reset',
      participants: [buildVote('Linus', null), buildVote('Ada', 8)],
      metrics: buildMetrics({
        average: null,
        mode: null,
        spread: null,
        distribution: { '8': 1 },
        outliers: [],
        numericVoteCount: 1,
        insufficientData: true,
      }),
      completedAt: '2026-05-01T11:00:00.000Z',
      votingDurationMs: undefined,
    }),
    buildEntry({
      roundId: 'round-1',
      storyDescription: 'Checkout flow',
      participants: [buildVote('Ada', 5), buildVote('Grace', 3)],
      metrics: buildMetrics({
        average: 4,
        mode: 3,
        spread: 2,
        distribution: { '3': 1, '5': 1 },
        outliers: [],
        numericVoteCount: 2,
        insufficientData: false,
      }),
      completedAt: '2026-05-01T10:00:00.000Z',
      votingDurationMs: 3_600_000,
    }),
  ];

  it('R1.21: starts with exactly one summary header and precedes each vote block with one vote header', () => {
    const rows = buildEstimateExportRows({ history, votingSystem: 'fibonacci' });

    expect(rows[0]).toEqual([...SUMMARY_HEADER]);
    const summaryHeaderRows = rows.filter((row) => row[0] === 'Story' && row.length === 10);
    const voteHeaderRows = rows.filter((row) => row[0] === 'Story' && row.length === 3);
    expect(summaryHeaderRows).toHaveLength(1);
    expect(voteHeaderRows).toHaveLength(history.length);
  });

  it('R1.9, R1.20, R1.21: lays out summary, vote header and vote rows per estimate in ascending order', () => {
    const rows = buildEstimateExportRows({ history, votingSystem: 'fibonacci' });

    expect(rows).toEqual([
      [...SUMMARY_HEADER],
      ['Checkout flow', '2', '2', '4.0', '3', '2', '3=1; 5=1', '0', '60:00', '2026-05-01T10:00:00.000Z'],
      [...VOTE_HEADER],
      ['Checkout flow', 'Ada', '5'],
      ['Checkout flow', 'Grace', '3'],
      ['Password reset', '2', '1', '-', '-', '-', '8=1', '0', '-', '2026-05-01T11:00:00.000Z'],
      [...VOTE_HEADER],
      ['Password reset', 'Ada', '8'],
      ['Password reset', 'Linus', NO_VOTE_LABEL],
    ]);
  });

  it('R1.21: emits the summary header alone for an empty history', () => {
    expect(buildEstimateExportRows({ history: [], votingSystem: 'fibonacci' })).toEqual([
      [...SUMMARY_HEADER],
    ]);
  });
});

describe('buildEstimateExportCsv', () => {
  it('R1.21: serializes the header row first, with CRLF record terminators', () => {
    const csv = buildEstimateExportCsv({
      history: [buildEntry({ votingDurationMs: 3_600_000 })],
      votingSystem: 'fibonacci',
    });

    expect(csv.startsWith(`Story,Participants,Numeric Votes,Average,Mode,Spread,Distribution,Outliers,Duration,Completed At${CRLF}`)).toBe(
      true
    );
    expect(csv.split(CRLF)).toEqual([
      'Story,Participants,Numeric Votes,Average,Mode,Spread,Distribution,Outliers,Duration,Completed At',
      // The `; ` separator holds no comma, quote or line break, so the
      // distribution field is emitted unquoted.
      'Checkout flow,1,3,5.0,5,3,3=1; 5=2,0,60:00,2026-05-01T10:00:00.000Z',
      'Story,Participant,Vote',
      'Checkout flow,Ada,5',
    ]);
  });

  it('R1.10, R1.12, R1.15: an RFC 4180 parser recovers the "-" and "No Vote" fields unchanged', () => {
    const csv = buildEstimateExportCsv({
      history: [
        buildEntry({
          storyDescription: 'Has,comma and "quote"',
          participants: [buildVote('Grace', null)],
          metrics: buildMetrics({
            average: null,
            mode: null,
            spread: null,
            distribution: { coffee: 1 },
            outliers: [],
            numericVoteCount: 0,
            insufficientData: true,
          }),
          votingDurationMs: undefined,
        }),
      ],
      votingSystem: 'fibonacci',
    });

    expect(parseCsv(csv)).toEqual([
      [...SUMMARY_HEADER],
      [
        'Has,comma and "quote"',
        '1',
        '0',
        '-',
        '-',
        '-',
        'coffee=1',
        '0',
        '-',
        '2026-05-01T10:00:00.000Z',
      ],
      [...VOTE_HEADER],
      ['Has,comma and "quote"', 'Grace', 'No Vote'],
    ]);
  });
});
