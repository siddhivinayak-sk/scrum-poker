/**
 * Proximity classifier for the vote-reveal fun callouts.
 *
 * Measures how close each participant's vote sits to a CONSENSUS REFERENCE point, on a continuous
 * position along the active voting system's card ladder. It is a pure function: it reads its
 * inputs, never mutates them, and allocates fresh result arrays on every call.
 *
 * The reference point is supplied by the caller. The caller is expected to pass a consensus
 * anchor that is robust against a single extreme vote (the mode's numeric value), NOT the plain
 * mean. Using the mean here was wrong: when one participant casts a far-off card, the mean is
 * dragged toward it, so the consensus cluster looks "far" and the real outlier looks "near".
 * Anchoring on the consensus value fixes that inversion.
 *
 * For backwards compatibility the input still accepts an `average` field, which is treated as the
 * reference when `reference` is not supplied.
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
  /**
   * The consensus reference value divergence is measured from. Accepts anything so a bad value is
   * a guarded case, not a type error. Prefer a value robust to a single outlier (the mode's
   * numeric value) rather than the plain mean.
   */
  readonly reference?: unknown;
  /**
   * Backwards-compatible alias for `reference`. Used only when `reference` is not supplied.
   * @deprecated Pass `reference` (a consensus anchor) instead of the mean.
   */
  readonly average?: unknown;
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
 * Locates a numeric value on the ladder as a real-valued index.
 * Clamps first (non-strict comparisons), so a value exactly equal to the first or last ladder
 * entry lands on that exact index; only a strictly-between value is interpolated.
 * Ladder values are strictly ascending, so the interpolation divisor is never zero.
 */
function ladderPosition(value: number, ladderValues: readonly number[]): number {
  const last = ladderValues.length - 1;
  if (value <= ladderValues[0]) return 0;
  if (value >= ladderValues[last]) return last;

  let lower = 0;
  for (let i = 0; i <= last; i++) {
    if (ladderValues[i] <= value) {
      lower = i;
    } else {
      break;
    }
  }
  if (ladderValues[lower] === value) return lower;
  return lower + (value - ladderValues[lower]) / (ladderValues[lower + 1] - ladderValues[lower]);
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

/**
 * Computes the consensus reference value for proximity classification. Both candidates are robust
 * against a single extreme vote, so the consensus cluster stays "near" and a lone divergent vote
 * reads as "far" (which the plain mean got backwards):
 *
 *   - When a real mode exists (some numeric value shared by at least two voters), the most common
 *     value is the consensus. Mode ties resolve to the least numeric value, matching the metrics
 *     engine.
 *   - When every numeric vote is distinct there is no mode to speak of, so the median numeric
 *     value is used instead: it sits at the centre of the spread and is still unmoved by one
 *     extreme vote.
 *
 * Returns undefined when there is no numeric vote at all; the caller then has nothing to anchor on.
 */
export function consensusReference(
  selections: ReadonlyMap<string, ExtendedCardValue | null | undefined>
): number | undefined {
  const numerics: number[] = [];
  const counts = new Map<number, number>();
  for (const card of selections.values()) {
    if (card === null || card === undefined) continue;
    const numeric = cardNumericValue(card);
    if (numeric === undefined) continue;
    numerics.push(numeric);
    counts.set(numeric, (counts.get(numeric) ?? 0) + 1);
  }

  if (numerics.length === 0) return undefined;

  // Mode: greatest count wins, ties go to the least value.
  let mode: number | undefined;
  let modeCount = 0;
  for (const [numeric, count] of counts) {
    if (mode === undefined || count > modeCount || (count === modeCount && numeric < mode)) {
      mode = numeric;
      modeCount = count;
    }
  }
  if (modeCount >= 2) return mode;

  // No real mode (all votes distinct): fall back to the median of the numeric votes.
  const sorted = [...numerics].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function classifyProximity(input: ProximityInput): ProximityResult {
  const { selections, votingSystem, displayNames } = input;
  // `reference` is the consensus anchor; fall back to the legacy `average` alias.
  const reference = input.reference !== undefined ? input.reference : input.average;

  // Guards first; each returns an empty result and none can throw.
  if (typeof reference !== 'number' || !Number.isFinite(reference)) return emptyResult();
  if (typeof votingSystem !== 'string') return emptyResult();

  const ladder = cardLadderFor(votingSystem);
  if (ladder.length < 2) return emptyResult();

  const ladderValues: number[] = [];
  for (const card of ladder) {
    const numeric = cardNumericValue(card);
    if (numeric === undefined) return emptyResult();
    ladderValues.push(numeric);
  }

  const referencePosition = ladderPosition(reference, ladderValues);

  const near: ClassifiedParticipant[] = [];
  const far: ClassifiedParticipant[] = [];
  const distances = new Map<string, number>();

  for (const [userId, card] of selections) {
    if (card === null || card === undefined) continue;
    if (cardNumericValue(card) === undefined) continue;
    const index = ladder.indexOf(card);
    if (index < 0) continue;

    const distance = roundDistance(Math.abs(index - referencePosition));
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
