import {
  CardValue,
  NumericCardValue,
  VotingMetrics,
  FIBONACCI_SEQUENCE,
  SPECIAL_CARDS,
  SpecialCardValue,
} from '../../../shared/types';

/**
 * Fibonacci index lookup: maps each Fibonacci card value to its position
 * in the sequence [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89].
 */
const FIBONACCI_INDEX = new Map<NumericCardValue, number>(
  FIBONACCI_SEQUENCE.map((value, index) => [value, index])
);

const SPECIAL_CARD_SET = new Set<string>(SPECIAL_CARDS);

function isSpecialCard(value: CardValue): value is SpecialCardValue {
  return SPECIAL_CARD_SET.has(value as string);
}

function isNumericCard(value: CardValue): value is NumericCardValue {
  return !isSpecialCard(value);
}

/**
 * Calculate voting metrics from a map of user selections.
 *
 * - distribution counts ALL card values (including special cards)
 * - average, mode, spread, and outlier detection only use numeric card values
 * - insufficientData is true when fewer than 2 numeric votes exist
 * - When there's a tie for mode, the lowest numeric value wins
 * - Outliers are voters whose Fibonacci index distance from the mode's index is > 2
 */
export function calculate(
  selections: Map<string, CardValue>
): VotingMetrics {
  // Build distribution for ALL card values (including special cards)
  const distribution: Record<string, number> = {};
  for (const [, cardValue] of selections) {
    const key = String(cardValue);
    distribution[key] = (distribution[key] ?? 0) + 1;
  }

  // Separate numeric votes (userId -> numericValue)
  const numericVotes: Array<{ userId: string; value: NumericCardValue }> = [];
  for (const [userId, cardValue] of selections) {
    if (isNumericCard(cardValue)) {
      numericVotes.push({ userId, value: cardValue });
    }
  }

  const numericVoteCount = numericVotes.length;
  const insufficientData = numericVoteCount < 2;

  // When insufficient data, return early with nulls
  if (insufficientData) {
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

  // Calculate average of numeric votes
  const sum = numericVotes.reduce((acc, v) => acc + v.value, 0);
  const average = sum / numericVoteCount;

  // Calculate mode: most frequent numeric value, lowest value breaks ties
  const numericCounts = new Map<NumericCardValue, number>();
  for (const { value } of numericVotes) {
    numericCounts.set(value, (numericCounts.get(value) ?? 0) + 1);
  }

  let mode: NumericCardValue = numericVotes[0].value;
  let maxCount = 0;
  for (const [value, count] of numericCounts) {
    if (count > maxCount || (count === maxCount && value < mode)) {
      mode = value;
      maxCount = count;
    }
  }

  // Calculate spread: max - min of numeric values
  const numericValues = numericVotes.map((v) => v.value);
  const min = Math.min(...numericValues);
  const max = Math.max(...numericValues);
  const spread = max - min;

  // Outlier detection: Fibonacci index distance > 2 from mode's index
  const modeIndex = FIBONACCI_INDEX.get(mode)!;
  const outliers: string[] = [];
  for (const { userId, value } of numericVotes) {
    const voteIndex = FIBONACCI_INDEX.get(value);
    if (voteIndex !== undefined && Math.abs(voteIndex - modeIndex) > 2) {
      outliers.push(userId);
    }
  }

  return {
    average,
    mode,
    spread,
    distribution,
    outliers,
    numericVoteCount,
    insufficientData: false,
  };
}
