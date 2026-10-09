import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { SPECIAL_CARDS, VOTING_SYSTEMS, VotingSystemType, ExtendedCardValue } from '@shared/types';
import {
  DECK_PADDING_TOP_PX,
  DeckGeometry,
  SELECTION_LIFT_PX,
  SELECTION_SCALE,
  isSelectionContained,
  requiredHeadroomPx,
  selectedCardTopOffsetPx,
} from './card-deck-geometry';

// Feature: poker-retro-ux-improvements, Property 6: For any card index of any
// voting-system card set, the top edge of the transformed border box of the
// selected card lies at or below the container top edge

/**
 * Declared hover lift for a non-selected card, mirroring
 * `.card-deck__card:hover:not(:disabled):not(.card-deck__card--selected)`.
 */
const HOVER_LIFT_PX = 4;

/**
 * Vertical space the focus indicator needs above the card's border box:
 * `outline: 2px` plus `outline-offset: 2px` from `.card-deck__card:focus-visible`.
 */
const FOCUS_RING_ALLOWANCE_PX = 4;

/** Every voting system card set, extended with the special cards (R3.5). */
const VOTING_SYSTEM_NAMES = Object.keys(VOTING_SYSTEMS) as VotingSystemType[];

function extendedCardSet(system: VotingSystemType): ExtendedCardValue[] {
  return [...VOTING_SYSTEMS[system], ...SPECIAL_CARDS];
}

/**
 * One generated deck state: a card set drawn from `VOTING_SYSTEMS` extended
 * with specials and truncated to 2–20 cards, a card position inside that set,
 * a card height in the declared range, and a supported viewport width.
 */
interface DeckState {
  cards: ExtendedCardValue[];
  cardIndex: number;
  cardHeightPx: number;
  viewportWidth: number;
}

const deckStateArb: fc.Arbitrary<DeckState> = fc
  .constantFrom(...VOTING_SYSTEM_NAMES)
  .chain((system) => {
    const fullSet = extendedCardSet(system);
    // No defined system exceeds 20 cards once extended, so the upper bound of
    // R3.5 is the set size itself; the lower bound of 2 is generated directly.
    const maxCount = Math.min(20, fullSet.length);
    return fc
      .integer({ min: 2, max: maxCount })
      .chain((cardCount) =>
        fc.record({
          cards: fc.constant(fullSet.slice(0, cardCount)),
          cardIndex: fc.integer({ min: 0, max: cardCount - 1 }),
          cardHeightPx: fc.integer({ min: 56, max: 96 }),
          viewportWidth: fc.integer({ min: 360, max: 1920 }),
        }),
      );
  });

/**
 * Property 6: Selected card stays inside the deck container
 *
 * For any card index of any voting-system card set (2–20 cards), any card
 * height in 56–96 px, and any viewport width 360–1920 px, the top edge of the
 * transformed border box of the selected card lies at or below the container's
 * top edge, and the reserved headroom is at least the lift plus half the scale
 * growth. The same holds for a non-selected card carrying the hover lift plus
 * its focus-ring allowance.
 *
 * **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 14.15**
 */
describe('Property 6: Selected card stays inside the deck container', () => {
  it('R3.2/R3.3/R3.4/R3.5: keeps the selected card and the hovered focused card inside the deck for every card position, height and viewport width', () => {
    fc.assert(
      fc.property(deckStateArb, ({ cards, cardIndex, cardHeightPx, viewportWidth }) => {
        expect(cards.length).toBeGreaterThanOrEqual(2);
        expect(cards.length).toBeLessThanOrEqual(20);
        expect(cardIndex).toBeLessThan(cards.length);
        expect(viewportWidth).toBeGreaterThanOrEqual(360);
        expect(viewportWidth).toBeLessThanOrEqual(1920);

        const selected: DeckGeometry = {
          cardHeightPx,
          liftPx: SELECTION_LIFT_PX,
          scale: SELECTION_SCALE,
          paddingTopPx: DECK_PADDING_TOP_PX,
        };

        // Hovered or keyboard-focused non-selected card: the declared hover
        // lift plus the space its focus indicator occupies above the border box.
        const hoveredAndFocused: DeckGeometry = {
          cardHeightPx,
          liftPx: HOVER_LIFT_PX + FOCUS_RING_ALLOWANCE_PX,
          scale: 1,
          paddingTopPx: DECK_PADDING_TOP_PX,
        };

        // R3.5 reduces to the first, any middle, and the last card because the
        // geometry is independent of card position; assert each explicitly.
        const positions = [0, cardIndex, cards.length - 1];

        for (const position of positions) {
          expect(position).toBeGreaterThanOrEqual(0);
          expect(position).toBeLessThan(cards.length);

          // R3.2: the transformed top edge stays at or below the container top.
          expect(selectedCardTopOffsetPx(selected)).toBeGreaterThanOrEqual(0);
          expect(isSelectionContained(selected)).toBe(true);

          // R3.4: reserved space covers the lift plus half the scale growth.
          expect(requiredHeadroomPx(selected)).toBeLessThanOrEqual(DECK_PADDING_TOP_PX);
          expect(requiredHeadroomPx(selected)).toBeGreaterThanOrEqual(SELECTION_LIFT_PX);
          expect(requiredHeadroomPx(selected)).toBeCloseTo(
            SELECTION_LIFT_PX + (cardHeightPx * (SELECTION_SCALE - 1)) / 2,
            10,
          );

          // R3.3: the hovered, focused non-selected card is contained too.
          expect(selectedCardTopOffsetPx(hoveredAndFocused)).toBeGreaterThanOrEqual(0);
          expect(isSelectionContained(hoveredAndFocused)).toBe(true);
          expect(requiredHeadroomPx(hoveredAndFocused)).toBeLessThanOrEqual(DECK_PADDING_TOP_PX);
        }
      }),
      { numRuns: 100 },
    );
  });
});
