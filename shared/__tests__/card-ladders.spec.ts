import {
  CARD_LADDERS,
  FIBONACCI_SEQUENCE,
  SPECIAL_CARDS,
  VOTING_SYSTEMS,
  cardLadderFor,
  cardNumericValue,
  ExtendedCardValue,
} from '../types';

/**
 * Example tests for Card_Numeric_Value and Card_Ladder.
 * Validates: Requirements 1.2, 14.1, 14.2, 15.2
 */

describe('CARD_LADDERS', () => {
  it('fibonacci ladder is the literal Fibonacci sequence', () => {
    expect([...CARD_LADDERS.fibonacci]).toEqual([0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]);
  });

  it('modified-fibonacci ladder places ½ between 0 and 1', () => {
    expect([...CARD_LADDERS['modified-fibonacci']]).toEqual([
      0, '½', 1, 2, 3, 5, 8, 13, 20, 40, 100,
    ]);
  });

  it('power-of-2 ladder is the literal power-of-2 sequence', () => {
    expect([...CARD_LADDERS['power-of-2']]).toEqual([0, 1, 2, 4, 8, 16, 32, 64]);
  });

  it('t-shirt ladder is empty', () => {
    expect(CARD_LADDERS['t-shirt']).toEqual([]);
    expect(CARD_LADDERS['t-shirt']).toHaveLength(0);
  });

  it('CARD_LADDERS.fibonacci equals FIBONACCI_SEQUENCE element-for-element', () => {
    const ladder = CARD_LADDERS.fibonacci;
    expect(ladder).toHaveLength(FIBONACCI_SEQUENCE.length);
    FIBONACCI_SEQUENCE.forEach((card, i) => {
      expect(ladder[i]).toBe(card);
    });
  });
});

describe('cardLadderFor', () => {
  it('returns the ladder of a known voting system', () => {
    expect(cardLadderFor('fibonacci')).toBe(CARD_LADDERS.fibonacci);
    expect(cardLadderFor('power-of-2')).toBe(CARD_LADDERS['power-of-2']);
  });

  it('returns an empty ladder for an unknown identifier', () => {
    expect(cardLadderFor('nonsense')).toEqual([]);
  });

  it('does not resolve inherited object properties as ladders', () => {
    expect(cardLadderFor('toString')).toEqual([]);
    expect(cardLadderFor('__proto__')).toEqual([]);
  });
});

describe('cardNumericValue', () => {
  it('maps ½ to 0.5', () => {
    expect(cardNumericValue('½')).toBe(0.5);
  });

  it('maps numeric cards to themselves', () => {
    expect(cardNumericValue(0)).toBe(0);
    expect(cardNumericValue(13)).toBe(13);
    expect(cardNumericValue(100)).toBe(100);
    expect(cardNumericValue(64)).toBe(64);
  });

  it('has no value for special cards', () => {
    for (const card of SPECIAL_CARDS) {
      expect(cardNumericValue(card)).toBeUndefined();
    }
  });

  it('has no value for t-shirt sizes', () => {
    for (const size of VOTING_SYSTEMS['t-shirt'] as ExtendedCardValue[]) {
      expect(cardNumericValue(size)).toBeUndefined();
    }
  });
});
