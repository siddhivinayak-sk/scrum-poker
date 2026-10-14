/**
 * Catalog scan for the vote-reveal callout copy (Property 9: Copy tone constraints).
 *
 * Exhaustively walks every entry of every section of CALLOUT_COPY_CATALOG and checks the tone
 * constraints that R4 makes decidable by an automated scan. Also pins the whole-word behaviour of
 * `containsRestrictedTerm` with near-miss negative cases.
 *
 * **Validates: Requirements 4.6, 4.7, 4.9, 4.11**
 */
import {
  CALLOUT_COPY_CATALOG,
  RESTRICTED_TERMS,
  containsRestrictedTerm,
  type CalloutSection,
} from '../callout-copy';

const SECTIONS = Object.keys(CALLOUT_COPY_CATALOG) as CalloutSection[];

/** R4.2 inclusive size bounds per section; the acknowledgement section is held to the same ceiling. */
const SIZE_BOUNDS: Record<CalloutSection, { min: number; max: number }> = {
  nearAverage: { min: 6, max: 40 },
  farFromAverage: { min: 6, max: 40 },
  fullAgreement: { min: 2, max: 40 },
  wideSpread: { min: 2, max: 40 },
  acknowledgement: { min: 2, max: 40 },
};

/** Labels of the existing consensus indicator (R2.9); no catalog entry may restate them. */
const CONSENSUS_LABELS = ['full agreement', 'partial agreement', 'high divergence'];

const SECOND_PERSON = /\b(?:you|your|yours|yourself|yourselves|y'all)\b/i;
const GLYPH = /\p{Extended_Pictographic}/gu;

const charCount = (entry: string): number => Array.from(entry).length;
const glyphCount = (entry: string): number => (entry.match(GLYPH) ?? []).length;
const normalise = (entry: string): string => entry.trim().replace(/\s+/g, ' ').toLowerCase();

const entriesOf = (section: CalloutSection): readonly string[] => CALLOUT_COPY_CATALOG[section];
const allEntries: ReadonlyArray<readonly [CalloutSection, string]> = SECTIONS.flatMap(
  (section) => entriesOf(section).map((entry) => [section, entry] as const)
);

describe('Callout copy catalog scan (Property 9: copy tone constraints)', () => {
  it('exposes exactly the five expected sections', () => {
    expect([...SECTIONS].sort()).toEqual(
      ['acknowledgement', 'farFromAverage', 'fullAgreement', 'nearAverage', 'wideSpread']
    );
  });

  describe.each(SECTIONS)('section %s', (section) => {
    it('has a size within its R4.2 bounds and at least 2 entries', () => {
      const { min, max } = SIZE_BOUNDS[section];
      const size = entriesOf(section).length;
      expect(size).toBeGreaterThanOrEqual(Math.max(min, 2));
      expect(size).toBeLessThanOrEqual(max);
    });

    it('has entries that are distinct after case folding and whitespace normalisation', () => {
      const normalised = entriesOf(section).map(normalise);
      expect(new Set(normalised).size).toBe(normalised.length);
    });
  });

  describe.each(allEntries)('[%s] %j', (section, entry) => {
    it('is 12 to 90 characters long, inclusive (R4.9)', () => {
      expect(charCount(entry)).toBeGreaterThanOrEqual(12);
      expect(charCount(entry)).toBeLessThanOrEqual(90);
    });

    it('carries no leading or trailing whitespace and has a non-blank body', () => {
      expect(entry).toBe(entry.trim());
      expect(entry.trim().length).toBeGreaterThan(0);
    });

    it('carries at most 2 decorative glyphs (R4.9)', () => {
      expect(glyphCount(entry)).toBeLessThanOrEqual(2);
    });

    it('contains no region-specific idiom (R4.9)', () => {
      expect(containsRestrictedTerm(entry, RESTRICTED_TERMS.regionSpecificIdiom)).toBe(false);
    });

    it('is not identical to a consensus indicator label (R2.9)', () => {
      expect(CONSENSUS_LABELS).not.toContain(normalise(entry));
    });

    if (section === 'farFromAverage') {
      it('ends in a question mark (R4.6)', () => {
        expect(entry.trimEnd().endsWith('?')).toBe(true);
      });

      it('contains a second-person pronoun (R4.11)', () => {
        expect(SECOND_PERSON.test(entry)).toBe(true);
      });

      it('contains no error-attributing term (R4.6)', () => {
        expect(containsRestrictedTerm(entry, RESTRICTED_TERMS.errorAttributing)).toBe(false);
      });
    }

    if (section === 'nearAverage') {
      it('contains no second-person pronoun (R4.11)', () => {
        expect(SECOND_PERSON.test(entry)).toBe(false);
      });

      it('contains no digit (R4.7)', () => {
        expect(/\d/u.test(entry)).toBe(false);
      });

      it('contains no ranking or comparison term (R4.7)', () => {
        expect(containsRestrictedTerm(entry, RESTRICTED_TERMS.rankingAndComparison)).toBe(false);
      });
    }
  });
});

describe('containsRestrictedTerm whole-word behaviour', () => {
  describe('near-miss negatives: a longer word that merely starts with a term is not a match', () => {
    it('does not match "offer" against "off"', () => {
      expect(containsRestrictedTerm('A fair offer was made', RESTRICTED_TERMS.errorAttributing)).toBe(
        false
      );
    });

    it('does not match "topic" against "top"', () => {
      expect(
        containsRestrictedTerm('Next topic on the table', RESTRICTED_TERMS.rankingAndComparison)
      ).toBe(false);
    });

    it('does not match "leaden" against "lead"', () => {
      expect(
        containsRestrictedTerm('A leaden sky hangs overhead', RESTRICTED_TERMS.rankingAndComparison)
      ).toBe(false);
    });
  });

  describe('positives: the real term is matched whole-word and case-insensitively', () => {
    it('matches "off" with punctuation and mixed case', () => {
      expect(containsRestrictedTerm('That felt OFF, somehow', RESTRICTED_TERMS.errorAttributing)).toBe(
        true
      );
    });

    it('matches "top" at the end of an entry', () => {
      expect(containsRestrictedTerm('Straight to the top.', RESTRICTED_TERMS.rankingAndComparison)).toBe(
        true
      );
    });

    it('matches an enumerated inflection such as "leader"', () => {
      expect(containsRestrictedTerm('The leader waves', RESTRICTED_TERMS.rankingAndComparison)).toBe(
        true
      );
    });

    it('matches a multi-word idiom as a consecutive run', () => {
      expect(containsRestrictedTerm('A real Hail Mary, that one', RESTRICTED_TERMS.regionSpecificIdiom)).toBe(
        true
      );
      expect(containsRestrictedTerm('Hail the Mary', RESTRICTED_TERMS.regionSpecificIdiom)).toBe(false);
    });
  });

  it('returns false for an empty entry or an empty group without throwing', () => {
    expect(containsRestrictedTerm('', RESTRICTED_TERMS.errorAttributing)).toBe(false);
    expect(containsRestrictedTerm('anything at all', [])).toBe(false);
  });
});
