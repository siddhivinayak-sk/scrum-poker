import {
  ExtendedCardValue,
  VotingMetrics,
  VotingSystemType,
  cardLadderFor,
  cardNumericValue,
  ladderIndexOf,
} from '../../../shared/types';

/** A numeric vote: who cast it, the card they chose, and that card's Card_Numeric_Value. */
interface NumericVote {
  userId: string;
  card: ExtendedCardValue;
  numeric: number;
}

/** Outlier threshold: ladder-index distance from the mode must be strictly greater than this. */
const OUTLIER_INDEX_THRESHOLD = 2;

/**
 * Calculate voting metrics from a map of user selections.
 *
 * - distribution counts ALL card values (specials, t-shirt sizes and unknown values included)
 * - a vote is numeric only when its card has a Card_Numeric_Value
 * - average, spread and mode are computed over Card_Numeric_Values; mode is returned as the
 *   representative card value (so '½' is reported as '½', not 0.5)
 * - insufficientData is true when fewer than 2 numeric votes exist
 * - a mode tie resolves to the least Card_Numeric_Value
 * - outliers are voters whose index on the active system's Card_Ladder is more than 2 steps
 *   from the mode's index; empty when the ladder has fewer than 2 entries or the mode is
 *   not on the ladder
 *
 * `votingSystem` is optional with a 'fibonacci' default only so that legacy one-argument
 * test calls keep compiling; every production call site passes it explicitly.
 */
export function calculate(
  selections: ReadonlyMap<string, ExtendedCardValue>,
  votingSystem: VotingSystemType | string = 'fibonacci'
): VotingMetrics {
  // Distribution counts every entry, whatever its card value.
  const distribution: Record<string, number> = {};
  for (const [, cardValue] of selections) {
    const key = String(cardValue);
    distribution[key] = (distribution[key] ?? 0) + 1;
  }

  // Numeric votes are the entries whose card has a Card_Numeric_Value.
  const numericVotes: NumericVote[] = [];
  for (const [userId, card] of selections) {
    const numeric = cardNumericValue(card);
    if (numeric !== undefined) {
      numericVotes.push({ userId, card, numeric });
    }
  }

  const numericVoteCount = numericVotes.length;

  if (numericVoteCount < 2) {
    return {
      average: null,
      mode: null,
      spread: null,
      distribution,
      outliers: [],
      numericVoteCount,
      insufficientData: true,
    };
  }

  // Average and spread over mapped values.
  let sum = 0;
  let min = numericVotes[0].numeric;
  let max = numericVotes[0].numeric;
  for (const { numeric } of numericVotes) {
    sum += numeric;
    if (numeric < min) min = numeric;
    if (numeric > max) max = numeric;
  }
  const average = sum / numericVoteCount;
  const spread = max - min;

  // Mode over mapped values: greatest count wins, ties go to the least mapped value.
  // Remember the first card observed for each mapped value as its representative.
  const counts = new Map<number, { count: number; card: ExtendedCardValue }>();
  for (const { card, numeric } of numericVotes) {
    const entry = counts.get(numeric);
    if (entry) {
      entry.count += 1;
    } else {
      counts.set(numeric, { count: 1, card });
    }
  }

  let modeNumeric = numericVotes[0].numeric;
  let modeCard: ExtendedCardValue = numericVotes[0].card;
  let maxCount = 0;
  for (const [numeric, { count, card }] of counts) {
    if (count > maxCount || (count === maxCount && numeric < modeNumeric)) {
      modeNumeric = numeric;
      modeCard = card;
      maxCount = count;
    }
  }

  // Outliers: ladder-index distance from the mode's index, on the active system's ladder.
  const outliers: string[] = [];
  const ladder = cardLadderFor(votingSystem);
  if (ladder.length >= 2) {
    const modeIndex = ladderIndexOf(ladder, modeCard);
    if (modeIndex >= 0) {
      for (const { userId, card } of numericVotes) {
        const voteIndex = ladderIndexOf(ladder, card);
        if (voteIndex >= 0 && Math.abs(voteIndex - modeIndex) > OUTLIER_INDEX_THRESHOLD) {
          outliers.push(userId);
        }
      }
    }
  }

  return {
    average,
    mode: modeCard,
    spread,
    distribution,
    outliers,
    numericVoteCount,
    insufficientData: false,
  };
}
