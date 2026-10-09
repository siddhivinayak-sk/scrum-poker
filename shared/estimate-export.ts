// Pure estimate-export document builder.
//
// This module turns a game session's completed-estimate history into the CSV
// Export_Document described by Requirement 1. It is pure and side-effect free so
// the server route, and the property tests, can exercise it directly: the server
// Jest suite reaches it through `roots: ['<rootDir>/../shared']` and the client
// Vitest suite through the `@shared/*` alias.
//
// Field quoting and record serialization are delegated to `shared/csv.ts`;
// duration formatting and card ordering are delegated to `shared/types.ts`.

import { quoteCsvField, serializeCsvDocument } from './csv';
import {
  formatDuration,
  getCardsForVotingSystem,
  type HistoryEntry,
  type VotingSystemType,
} from './types';

/** Header naming the Summary_Row fields, emitted once before the first summary. */
export const SUMMARY_HEADER: readonly string[] = [
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
];

/** Header naming the Vote_Row fields, emitted once per completed estimate. */
export const VOTE_HEADER: readonly string[] = ['Story', 'Participant', 'Vote'];

/** Rendered for a participant recorded with a null card value. */
export const NO_VOTE_LABEL = 'No Vote';

/** Rendered for an absent average, mode, spread or voting duration. */
export const NOT_AVAILABLE = '-';

/** Separator between distribution entries. */
const DISTRIBUTION_SEPARATOR = '; ';

export interface EstimateExportInput {
  /** History as the session stores it (newest-first); this module does not mutate it. */
  history: readonly HistoryEntry[];
  /** Voting system of the session, used to order the distribution entries. */
  votingSystem: VotingSystemType;
}

/**
 * Compares two values by code unit, which keeps ordering deterministic across
 * runtimes and locales (unlike `localeCompare`).
 */
function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * Orders completed estimates by `completedAt` ascending, keeping the stored
 * order of records that carry equal timestamps.
 *
 * The sort is made stable explicitly by decorating each entry with its stored
 * index and using that index as the tie-break, so the result does not depend on
 * the engine's `Array.prototype.sort` stability.
 */
export function sortCompletedEstimates(history: readonly HistoryEntry[]): HistoryEntry[] {
  return history
    .map((entry, storedIndex) => ({ entry, storedIndex }))
    .sort((left, right) => {
      const byCompletedAt = compareStrings(left.entry.completedAt, right.entry.completedAt);
      return byCompletedAt !== 0 ? byCompletedAt : left.storedIndex - right.storedIndex;
    })
    .map(({ entry }) => entry);
}

/**
 * Formats the average as a half-up value with exactly one decimal place and a
 * full stop separator, or `-` when the round holds insufficient data.
 *
 * `Number.EPSILON` nudges values whose binary representation sits just below
 * the .x5 boundary (for example 2.45) so they round up rather than down.
 */
export function formatAverage(average: number | null, insufficientData: boolean): string {
  if (insufficientData || average === null || !Number.isFinite(average)) {
    return NOT_AVAILABLE;
  }
  return (Math.round((average + Number.EPSILON) * 10) / 10).toFixed(1);
}

/**
 * Formats a metrics value that is blanked when the round holds insufficient
 * data (mode and spread).
 */
function formatMetricValue(value: number | string | null, insufficientData: boolean): string {
  if (insufficientData || value === null) {
    return NOT_AVAILABLE;
  }
  return String(value);
}

/**
 * Renders the vote distribution as `value=count` entries joined by `; `.
 *
 * Entries follow the card sequence of the session voting system. Keys that the
 * sequence does not contain — rounds recorded while the session used a
 * different voting system — are appended afterwards in `Object.keys` order so
 * that no recorded vote is dropped. Only keys actually present in the
 * distribution are emitted, one entry per distinct key.
 */
export function formatDistribution(
  distribution: Record<string, number>,
  votingSystem: VotingSystemType
): string {
  const presentKeys = Object.keys(distribution);
  const ordered: string[] = [];
  const emitted = new Set<string>();

  for (const card of getCardsForVotingSystem(votingSystem)) {
    const key = String(card);
    if (!emitted.has(key) && Object.prototype.hasOwnProperty.call(distribution, key)) {
      ordered.push(key);
      emitted.add(key);
    }
  }

  for (const key of presentKeys) {
    if (!emitted.has(key)) {
      ordered.push(key);
      emitted.add(key);
    }
  }

  return ordered.map((key) => `${key}=${distribution[key]}`).join(DISTRIBUTION_SEPARATOR);
}

/**
 * Formats the voting duration as `MM:SS`, or `-` when the completed estimate
 * holds no recorded duration. Minutes carry the total elapsed minutes, so an
 * hour renders as `60:00`.
 */
export function formatVotingDuration(ms: number | undefined): string {
  if (ms === undefined) {
    return NOT_AVAILABLE;
  }
  return formatDuration(ms);
}

/**
 * Builds the quoted Summary_Row of one completed estimate.
 *
 * Distribution and outlier count always carry their real values: only the
 * average, mode and spread are blanked on insufficient data.
 */
export function buildSummaryRow(entry: HistoryEntry, votingSystem: VotingSystemType): string[] {
  const metrics = entry.metrics;
  const insufficient = metrics.insufficientData;

  return [
    entry.storyDescription,
    String(entry.participants.length),
    String(metrics.numericVoteCount),
    formatAverage(metrics.average, insufficient),
    formatMetricValue(metrics.mode, insufficient),
    formatMetricValue(metrics.spread, insufficient),
    formatDistribution(metrics.distribution, votingSystem),
    String(metrics.outliers.length),
    formatVotingDuration(entry.votingDurationMs),
    entry.completedAt,
  ].map(quoteCsvField);
}

/**
 * Builds the quoted Vote_Row records of one completed estimate, ordered by
 * participant display name ascending with the recorded order as tie-break.
 */
export function buildVoteRows(entry: HistoryEntry): string[][] {
  return entry.participants
    .map((participant, recordedIndex) => ({ participant, recordedIndex }))
    .sort((left, right) => {
      const byName = compareStrings(left.participant.displayName, right.participant.displayName);
      return byName !== 0 ? byName : left.recordedIndex - right.recordedIndex;
    })
    .map(({ participant }) =>
      [
        entry.storyDescription,
        participant.displayName,
        participant.cardValue === null ? NO_VOTE_LABEL : String(participant.cardValue),
      ].map(quoteCsvField)
    );
}

/**
 * Builds every quoted record of the Export_Document.
 *
 * Shape: one summary header, then for each completed estimate in ascending
 * `completedAt` order its summary row, one vote header, and its vote rows.
 */
export function buildEstimateExportRows(input: EstimateExportInput): string[][] {
  const rows: string[][] = [[...SUMMARY_HEADER].map(quoteCsvField)];

  for (const entry of sortCompletedEstimates(input.history)) {
    rows.push(buildSummaryRow(entry, input.votingSystem));
    // A fresh array per estimate, so a consumer mutating one record cannot
    // reach the vote header of another.
    rows.push([...VOTE_HEADER].map(quoteCsvField));
    rows.push(...buildVoteRows(entry));
  }

  return rows;
}

/** Serializes the Export_Document as an RFC 4180 CSV text. */
export function buildEstimateExportCsv(input: EstimateExportInput): string {
  return serializeCsvDocument(buildEstimateExportRows(input));
}
