import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ALL_CARDS, CardValue, FIBONACCI_SEQUENCE, NumericCardValue } from '@shared/types';
import { CARD_COLOR_MAP, SPECIAL_CARD_COLOR_MAP, getCardColor } from './card-deck.component';

/**
 * Build a color index mapping: each CSS custom property color maps to its
 * position in the FIBONACCI_SEQUENCE (cool→warm scale).
 *
 * Index 0 = coolest (--card-color-0), Index 10 = warmest (--card-color-89).
 */
const COLOR_INDEX_MAP = new Map<string, number>();
FIBONACCI_SEQUENCE.forEach((value, index) => {
  const color = CARD_COLOR_MAP[value];
  COLOR_INDEX_MAP.set(color, index);
});

/**
 * Property 16: Card value-to-color monotonicity
 *
 * For any two numeric card values `a` and `b` where `a < b`, the color
 * assigned to card `a` by the color-coding function SHALL have a cooler hue
 * (lower index in the color scale) than the color assigned to card `b`.
 * Specifically, the Fibonacci index of `a` SHALL map to a lower index in
 * the warm color scale than the Fibonacci index of `b`.
 *
 * **Validates: Requirements 21.3**
 */
describe('Property 16: Card value-to-color monotonicity', () => {
  it('should assign a cooler color index to the smaller value in any pair (a, b) where a < b', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.constantFrom(...FIBONACCI_SEQUENCE),
          fc.constantFrom(...FIBONACCI_SEQUENCE),
        ).filter(([a, b]) => a < b),
        ([a, b]) => {
          const colorA = getCardColor(a);
          const colorB = getCardColor(b);

          const indexA = COLOR_INDEX_MAP.get(colorA);
          const indexB = COLOR_INDEX_MAP.get(colorB);

          // Both colors must exist in the mapping
          expect(indexA).toBeDefined();
          expect(indexB).toBeDefined();

          // The color index for the smaller value must be strictly less
          // than the color index for the larger value (cooler < warmer)
          expect(indexA!).toBeLessThan(indexB!);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// --- WCAG 2.1 contrast ratio helpers ---

/**
 * Resolve a CSS custom property reference like 'var(--card-color-0)' to its
 * actual hex color value. This mirrors the values defined in styles.scss.
 */
const CSS_VAR_TO_HEX: Record<string, string> = {
  'var(--card-color-0)': '#3182ce',
  'var(--card-color-1)': '#2b6cb0',
  'var(--card-color-2)': '#2f855a',
  'var(--card-color-3)': '#38a169',
  'var(--card-color-5)': '#d69e2e',
  'var(--card-color-8)': '#dd6b20',
  'var(--card-color-13)': '#e53e3e',
  'var(--card-color-21)': '#c53030',
  'var(--card-color-34)': '#b83280',
  'var(--card-color-55)': '#9b2c2c',
  'var(--card-color-89)': '#742a2a',
  'var(--card-color-coffee)': '#b7791f',
  'var(--card-color-no-clue)': '#6b46c1',
  'var(--card-color-break)': '#2c7a7b',
};

/** Text color used on cards: --text-primary */
const TEXT_COLOR_HEX = '#1a1a2e';

type CardVisualState = 'unselected' | 'selected' | 'hovered' | 'disabled';

/**
 * Parse a hex color string (#RRGGBB) into [R, G, B] in the 0-1 range.
 */
function hexToSrgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}

/**
 * Linearize an sRGB channel value per WCAG 2.1.
 */
function linearize(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Compute relative luminance per WCAG 2.1.
 */
function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToSrgb(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * Compute WCAG 2.1 contrast ratio between two hex colors.
 * Returns a value >= 1 (lighter / darker).
 */
function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Mix an accent color with white at a given percentage (0-1).
 * result = accent * pct + white * (1 - pct)
 * Returns a hex string.
 */
function mixWithWhite(accentHex: string, pct: number): string {
  const [ar, ag, ab] = hexToSrgb(accentHex);
  const r = Math.round((ar * pct + 1 * (1 - pct)) * 255);
  const g = Math.round((ag * pct + 1 * (1 - pct)) * 255);
  const b = Math.round((ab * pct + 1 * (1 - pct)) * 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * Compute the effective background color for a card given its accent hex
 * and visual state.
 *
 * - Unselected: gradient from white to 8% accent tint → worst case is 8%
 * - Selected: gradient from 15% to 25% accent tint → worst case is 25%
 * - Hovered: same background as unselected (border changes, not bg)
 * - Disabled: same background as unselected (opacity 0.5 applied on top,
 *   but over a white page background the effective color is a lighter tint,
 *   which only increases contrast with dark text)
 */
function effectiveBackground(accentHex: string, state: CardVisualState): string {
  switch (state) {
    case 'unselected':
    case 'hovered':
    case 'disabled':
      // Worst-case tint is the 8% accent mix at the bottom of the gradient
      return mixWithWhite(accentHex, 0.08);
    case 'selected':
      // Worst-case tint is the 25% accent mix at the bottom of the gradient
      return mixWithWhite(accentHex, 0.25);
  }
}

/**
 * Property 17: Card text-background contrast ratio
 *
 * For any card value and for any card visual state (unselected, selected,
 * hovered, disabled), the contrast ratio between the card text color and
 * the card background color SHALL be at least 4.5:1 as defined by WCAG 2.1
 * Level AA.
 *
 * **Validates: Requirements 21.6**
 */
describe('Property 17: Card text-background contrast ratio', () => {
  it('should maintain >= 4.5:1 contrast between text and background for all card values and visual states', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.constantFrom(...ALL_CARDS),
          fc.constantFrom<CardVisualState>('unselected', 'selected', 'hovered', 'disabled'),
        ),
        ([cardValue, state]: [CardValue, CardVisualState]) => {
          const cssVar = getCardColor(cardValue);
          const accentHex = CSS_VAR_TO_HEX[cssVar];

          // Accent hex must be resolvable
          expect(accentHex).toBeDefined();

          const bgHex = effectiveBackground(accentHex, state);
          const ratio = contrastRatio(TEXT_COLOR_HEX, bgHex);

          // WCAG 2.1 Level AA requires >= 4.5:1 for normal text
          expect(ratio).toBeGreaterThanOrEqual(4.5);
        },
      ),
      { numRuns: 200 },
    );
  });
});
