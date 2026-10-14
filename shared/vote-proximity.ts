/**
 * Proximity classifier for the vote-reveal fun callouts.
 *
 * Measures how close each participant's vote sits to the computed AVERAGE, on a continuous
 * position along the active voting system's card ladder. It is a pure function: it reads its
 * inputs, never mutates them, and allocates fresh result arrays on every call.
 *
 * This is deliberately independent of the mode-relative divergence notion used by the metrics
 * panel. The input carries no metrics record, so there is nothing of that kind to read or write.
 */
import { cardLadderFor, cardNumericValue } from './types';
import type { ExtendedCardValue, VotingSystemType } from './types';

/** A ladder distance at or below this value (after rounding) is "near". */
export const NEAR_THRESHOLD = 0.75;
/** A ladder distance at or above this value (after rounding) is "far". */
export const FAR_THRESHOLD = 2.0;
/** Decimal places the distance is rounded to, once, before any threshold comparison. */
export const DISTANCE_PRECISION = 6;

export interface ProximityInput {
  /** userId -> selected card. Absent keys and null/undefined values mean "no selection". */
  readonly selections: ReadonlyMap<string, ExtendedCardValue | null | undefined>;
  /** The computed average. Accepts anything so a bad value is a guarded case, not a type error. */
  readonly average: unknown;
  /** Accepts a bare string so an unknown identifier is data, not a type error. */
  readonly votingSystem: VotingSystemType | string;
  /** userId -> display name, used for the result entries and the ordering tie-break. */
  readonly displayNames: ReadonlyMap<string, string>;
}

export interface ClassifiedParticipant {
  readonly userId: string;
  readonly displayName: string;
  /** Already rounded to DISTANCE_PRECISION decimal places. */
  readonly ladderDistance: number;
}

export interface ProximityResult {
  /** Ascending distance, then case-insensitive name, then userId. */
  readonly near: readonly ClassifiedParticipant[];
  /** Same comparator as `near`. */
  readonly far: readonly ClassifiedParticipant[];
  /** Every classified participant's rounded distance, keyed by userId. */
  readonly distances: ReadonlyMap<string, number>;
}

/** Result for every guarded case (bad average, short ladder, unknown system). */
export const EMPTY_PROXIMITY: ProximityResult = {
  near: [],
  far: [],
  distances: new Map<string, number>(),
};

const ROUNDING_FACTOR = 10 ** DISTANCE_PRECISION;

function roundDistance(value: number): number {
  return Math.round(value * ROUNDING_FACTOR) / ROUNDING_FACTOR;
}

/** Fresh empty result, so callers can never share or mutate the exported constant's contents. */
function emptyResult(): ProximityResult {
  return { near: [], far: [], distances: new Map<string, number>() };
}

/**
 * Locates the average on the ladder as a real-valued index.
 * Clamps first (non-strict comparisons), so an average exactly equal to the first or last ladder
 * value lands on that exact index; only a strictly-between average is interpolated.
 * Ladder values are strictly ascending, so the interpolation divisor is never zero.
 */
function averageLadderPosition(average: number, ladderValues: readonly number[]): number {
  const last = ladderValues.length - 1;
  if (average <= ladderValues[0]) return 0;
  if (average >= ladderValues[last]) return last;

  let lower = 0;
  for (let i = 0; i <= last; i++) {
    if (ladderValues[i] <= average) {
      lower = i;
    } else {
      break;
    }
  }
  if (ladderValues[lower] === average) return lower;
  return (
    lower + (average - ladderValues[lower]) / (ladderValues[lower + 1] - ladderValues[lower])
  );
}

/** Code-unit comparison (not locale-aware) so ordering is identical across runtimes. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareParticipants(a: ClassifiedParticipant, b: ClassifiedParticipant): number {
  if (a.ladderDistance !== b.ladderDistance) return a.ladderDistance - b.ladderDistance;
  const byName = compareStrings(a.displayName.toLowerCase(), b.displayName.toLowerCase());
  if (byName !== 0) return byName;
  return compareStrings(a.userId, b.userId);
}

export function classifyProximity(input: ProximityInput): ProximityResult {
  const { selections, average, votingSystem, displayNames } = input;

  // Guards first; each returns an empty result and none can throw.
  if (typeof average !== 'number' || !Number.isFinite(average)) return emptyResult();
  if (typeof votingSystem !== 'string') return emptyResult();

  const ladder = cardLadderFor(votingSystem);
  if (ladder.length < 2) return emptyResult();

  const ladderValues: number[] = [];
  for (const card of ladder) {
    const numeric = cardNumericValue(card);
    if (numeric === undefined) return emptyResult();
    ladderValues.push(numeric);
  }

  const averagePosition = averageLadderPosition(average, ladderValues);

  const near: ClassifiedParticipant[] = [];
  const far: ClassifiedParticipant[] = [];
  const distances = new Map<string, number>();

  for (const [userId, card] of selections) {
    if (card === null || card === undefined) continue;
    if (cardNumericValue(card) === undefined) continue;
    const index = ladder.indexOf(card);
    if (index < 0) continue;

    const distance = roundDistance(Math.abs(index - averagePosition));
    const entry: ClassifiedParticipant = {
      userId,
      displayName: displayNames.get(userId) ?? userId,
      ladderDistance: distance,
    };
    distances.set(userId, distance);

    if (distance <= NEAR_THRESHOLD) {
      near.push(entry);
    } else if (distance >= FAR_THRESHOLD) {
      far.push(entry);
    }
  }

  near.sort(compareParticipants);
  far.sort(compareParticipants);
  return { near, far, distances };
}
