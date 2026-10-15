/**
 * Pure helpers that separate decorative glyphs (emoji) from the words of a Callout_Phrase.
 *
 * The glyph is rendered in an `aria-hidden` span and is excluded from every accessible name and
 * live-region announcement, while the remaining text carries the full message (R4.10).
 *
 * No Angular, DOM, clock or storage dependency lives here.
 */

/** One emoji code point, its modifiers, variation selector, joiner or keycap mark. */
const GLYPH_PART = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D\u20E3]+/gu;

export interface PhraseParts {
  /** The phrase with every decorative glyph removed and whitespace normalised. */
  readonly text: string;
  /** Every decorative glyph of the phrase in order, or an empty string when there is none. */
  readonly glyph: string;
}

/** Splits a phrase into its glyph-free text and its decorative glyphs. */
export function splitPhraseGlyphs(phrase: string): PhraseParts {
  const glyphs = phrase.match(GLYPH_PART);
  const text = phrase.replace(GLYPH_PART, '').replace(/\s+/g, ' ').trim();
  return { text, glyph: glyphs === null ? '' : glyphs.join('') };
}

/** The phrase with every decorative glyph removed; suitable for an announcement (R4.10). */
export function stripGlyphs(phrase: string): string {
  return splitPhraseGlyphs(phrase).text;
}
