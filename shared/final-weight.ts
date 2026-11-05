// Pure final-weight logic: scoring ladder, candidate options, accuracy and standings.
//
// Every function here is total (never throws) and treats `0` as a normal card:
// presence is always tested with `=== null`, `=== -1` or `!== undefined`, never truthiness.
import {
  VOTING_SYSTEMS,
  cardLadderFor,
  cardNumericValue,
  ladderIndexOf,
  type ExtendedCardValue,
  type FinalWeightRecord,
  type HistoryEntry,
  type ParticipantVote,
  type User,
  type VotingSystemType,
} from './types';

export type OptionReason = 'voted' | 'most-voted' | 'nearest-average' | 'between';

export interface FinalWeightOption {
  value: ExtendedCardValue;
  reasons: OptionReason[];
  suggested: boolean;
}

export interface VoterDistance {
  userId: string;
  name: string;
  card: ExtendedCardValue;
  distance: number;
}

export interface AccuracyResult {
  finalWeight: ExtendedCardValue;
  /** Scorable voters only. */
  voters: VoterDistance[];
  closestIds: string[];
  /** Empty when there is no spread or the result is not comparable. */
  furthestIds: string[];
  allExact: boolean;
  /** At least 2 scorable voters and the weight is on the ladder. */
  comparable: boolean;
}

export interface Standing {
  userId: string;
  name: string;
  rounds: number;
  avgDistance: number;
  warmingUp: boolean;
}

/** Payload of the `finalweight:set` event (lives here, next to AccuracyResult, to avoid a circular import). */
export interface FinalWeightSetPayload {
  roundId: string;
  record: FinalWeightRecord;
  result: AccuracyResult;
}

const MAX_BETWEEN = 3;

/** Ladder used for scoring: CARD_LADDERS, or the t-shirt deck (scoring only). Empty for an unknown system. */
export function scoringLadder(system: VotingSystemType): readonly ExtendedCardValue[] {
  const ladder = cardLadderFor(system);
  if (ladder.length > 0) return ladder;
  if (system === 't-shirt') return VOTING_SYSTEMS['t-shirt'];
  return [];
}

/** Builds votes exactly as GameSession.clearBoard does: current participants only, null = no vote. */
export function votesFromRound(
  selections: ReadonlyMap<string, ExtendedCardValue>,
  participants: readonly User[]
): ParticipantVote[] {
  return participants.map((user) => ({
    userId: user.id,
    displayName: user.displayName,
    cardValue: selections.get(user.id) ?? null,
  }));
}

/** Votes on the ladder, paired with their ladder index. */
function scorableVotes(
  votes: readonly ParticipantVote[],
  ladder: readonly ExtendedCardValue[]
): { vote: ParticipantVote; card: ExtendedCardValue; index: number }[] {
  const result: { vote: ParticipantVote; card: ExtendedCardValue; index: number }[] = [];
  for (const vote of votes) {
    const card = vote.cardValue;
    if (card === null || card === undefined) continue;
    const index = ladderIndexOf(ladder, card);
    if (index === -1) continue;
    result.push({ vote, card, index });
  }
  return result;
}

/** Position of a ladder card for averaging: its numeric value, or its index when it has none (t-shirt). */
function positionOf(card: ExtendedCardValue, index: number): number {
  const numeric = cardNumericValue(card);
  return numeric !== undefined ? numeric : index;
}

const EMPTY_OPTIONS = (ladder: readonly ExtendedCardValue[]) => ({
  options: [] as FinalWeightOption[],
  ladder,
  hasScorable: false,
});

export function buildFinalWeightOptions(
  votes: readonly ParticipantVote[],
  system: VotingSystemType
): { options: FinalWeightOption[]; ladder: readonly ExtendedCardValue[]; hasScorable: boolean } {
  try {
    const ladder = scoringLadder(system);
    const scorable = scorableVotes(votes, ladder);
    if (scorable.length === 0) return EMPTY_OPTIONS(ladder);

    const counts = new Map<number, number>(); // ladder index -> vote count
    let sum = 0;
    let minIdx = Infinity;
    let maxIdx = -Infinity;
    for (const { card, index } of scorable) {
      counts.set(index, (counts.get(index) ?? 0) + 1);
      sum += positionOf(card, index);
      minIdx = Math.min(minIdx, index);
      maxIdx = Math.max(maxIdx, index);
    }
    const average = sum / scorable.length;
    const maxCount = Math.max(...counts.values());

    // Nearest ladder card to the average; ties pick the higher card.
    let nearestIdx = 0;
    let nearestDiff = Infinity;
    ladder.forEach((card, index) => {
      const diff = Math.abs(positionOf(card, index) - average);
      if (diff <= nearestDiff) {
        nearestDiff = diff;
        nearestIdx = index;
      }
    });

    // Unvoted cards strictly between the lowest and highest vote, closest to the average first.
    const betweenIdx = ladder
      .map((card, index) => ({ index, diff: Math.abs(positionOf(card, index) - average) }))
      .filter(({ index }) => index > minIdx && index < maxIdx && !counts.has(index))
      .sort((a, b) => a.diff - b.diff || a.index - b.index)
      .slice(0, MAX_BETWEEN)
      .map(({ index }) => index);

    const reasonsByIdx = new Map<number, OptionReason[]>();
    const addReason = (index: number, reason: OptionReason): void => {
      const list = reasonsByIdx.get(index) ?? [];
      if (!list.includes(reason)) list.push(reason);
      reasonsByIdx.set(index, list);
    };
    for (const [index, count] of counts) {
      addReason(index, 'voted');
      if (count === maxCount) addReason(index, 'most-voted');
    }
    addReason(nearestIdx, 'nearest-average');
    for (const index of betweenIdx) addReason(index, 'between');

    const mostVotedIdx = [...counts.entries()]
      .filter(([, count]) => count === maxCount)
      .map(([index]) => index)
      .sort((a, b) => a - b);
    const suggestedIdx = counts.has(nearestIdx) ? nearestIdx : mostVotedIdx[0];

    const options: FinalWeightOption[] = [...reasonsByIdx.keys()]
      .sort((a, b) => a - b)
      .map((index) => ({
        value: ladder[index],
        reasons: reasonsByIdx.get(index) ?? [],
        suggested: index === suggestedIdx,
      }));
    return { options, ladder, hasScorable: true };
  } catch {
    return EMPTY_OPTIONS(scoringLadder(system));
  }
}

function notComparable(record: FinalWeightRecord): AccuracyResult {
  return {
    finalWeight: record.value,
    voters: [],
    closestIds: [],
    furthestIds: [],
    allExact: false,
    comparable: false,
  };
}

/** Accuracy of a round against its final weight. Scores on the ladder of `record.votingSystem`. Never throws. */
export function computeAccuracy(
  votes: readonly ParticipantVote[],
  record: FinalWeightRecord
): AccuracyResult {
  try {
    const ladder = scoringLadder(record.votingSystem);
    const weightIdx = ladderIndexOf(ladder, record.value);
    if (weightIdx === -1) return notComparable(record);

    const voters: VoterDistance[] = scorableVotes(votes, ladder).map(({ vote, card, index }) => ({
      userId: vote.userId,
      name: vote.displayName,
      card,
      distance: Math.abs(index - weightIdx),
    }));
    if (voters.length < 2) {
      return { ...notComparable(record), voters };
    }

    const distances = voters.map((v) => v.distance);
    const min = Math.min(...distances);
    const max = Math.max(...distances);
    return {
      finalWeight: record.value,
      voters,
      closestIds: voters.filter((v) => v.distance === min).map((v) => v.userId),
      furthestIds: max > min ? voters.filter((v) => v.distance === max).map((v) => v.userId) : [],
      allExact: max === 0,
      comparable: true,
    };
  } catch {
    return notComparable(record);
  }
}

/** Per-voter average distance across history; each entry is scored with its own stored voting system. */
export function computeStandings(history: readonly HistoryEntry[]): Standing[] {
  const totals = new Map<string, { name: string; rounds: number; sum: number }>();
  for (const entry of history) {
    const record = entry.finalWeight;
    if (record === undefined) continue;
    const result = computeAccuracy(entry.participants, record);
    if (!result.comparable) continue;
    for (const voter of result.voters) {
      const t = totals.get(voter.userId) ?? { name: voter.name, rounds: 0, sum: 0 };
      t.name = voter.name;
      t.rounds += 1;
      t.sum += voter.distance;
      totals.set(voter.userId, t);
    }
  }
  const standings: Standing[] = [...totals.entries()].map(([userId, t]) => ({
    userId,
    name: t.name,
    rounds: t.rounds,
    avgDistance: t.sum / t.rounds,
    warmingUp: t.rounds < 2,
  }));
  return standings.sort(
    (a, b) =>
      Number(a.warmingUp) - Number(b.warmingUp) ||
      a.avgDistance - b.avgDistance ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)
  );
}
