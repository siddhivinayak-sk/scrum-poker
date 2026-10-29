import * as fc from 'fast-check';
import {
  CALLOUT_COPY_CATALOG,
  RESTRICTED_TERMS,
  containsRestrictedTerm,
  selectCalloutPhrase,
  type CalloutSection,
  type RestrictedTerm,
} from '../callout-copy';

/**
 * Property tests for the callout copy catalog (shared file: Properties 7, 8, 20, 21).
 * Each property lives in its own `describe` block.
 */

const SECTIONS = Object.keys(CALLOUT_COPY_CATALOG) as CalloutSection[];

const sectionArb: fc.Arbitrary<CalloutSection> = fc.constantFrom(...SECTIONS);

/** Voting_Round identifiers: arbitrary strings, including empty and non-ASCII ones. */
const roundIdArb: fc.Arbitrary<string> = fc.oneof(fc.string(), fc.string({ unit: 'binary' }), fc.uuid());

/**
 * Previous-entry indexes: valid indexes, -1, other out-of-range integers, non-integers
 * (fractions, NaN, infinities) and extreme magnitudes.
 */
const previousIndexArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 0, max: 50 }),
  fc.constant(-1),
  fc.integer(),
  fc.double({ noNaN: false }),
  fc.double({ min: -10, max: 50, noNaN: true }),
  fc.constantFrom(
    NaN,
    Infinity,
    -Infinity,
    0.5,
    -0.5,
    1.5,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_VALUE,
    Number.MIN_VALUE
  )
);

// Feature: vote-reveal-fun-callouts, Property 7: Copy selection totality
/**
 * **Validates: Requirements 4.3, 4.4**
 *
 * For every Voting_Round identifier, every section of the catalog and every previous-entry
 * index (including -1, non-integers and out-of-range values), the selection function returns
 * exactly one entry that belongs to the requested section and has a non-whitespace character.
 */
describe('Property 7: Copy selection totality', () => {
  it('returns exactly one non-blank entry of the requested section for any input', () => {
    fc.assert(
      fc.property(roundIdArb, sectionArb, previousIndexArb, (roundId, section, previousIndex) => {
        const entries = CALLOUT_COPY_CATALOG[section];
        const result = selectCalloutPhrase(CALLOUT_COPY_CATALOG, section, roundId, previousIndex);

        expect(result).not.toBeNull();
        if (result === null) return;

        // The index addresses a real entry of the requested section...
        expect(Number.isInteger(result.index)).toBe(true);
        expect(result.index).toBeGreaterThanOrEqual(0);
        expect(result.index).toBeLessThan(entries.length);

        // ...and the text is exactly that entry, which is non-blank.
        expect(typeof result.text).toBe('string');
        expect(result.text).toBe(entries[result.index]);
        expect(entries).toContain(result.text);
        expect(result.text.trim().length).toBeGreaterThan(0);
      }),
      { numRuns: 200 }
    );
  });
});

// Feature: vote-reveal-fun-callouts, Property 8: Copy non-repetition
/**
 * **Validates: Requirements 4.5**
 *
 * For every Voting_Round identifier, every section of the catalog and every previous-entry
 * index within that section's range, the selected entry's index differs from that previous index.
 */
describe('Property 8: Copy non-repetition', () => {
  it('selects an index different from any in-range previous index', () => {
    fc.assert(
      fc.property(
        roundIdArb,
        sectionArb.chain((section) =>
          fc.tuple(
            fc.constant(section),
            fc.integer({ min: 0, max: CALLOUT_COPY_CATALOG[section].length - 1 })
          )
        ),
        (roundId, [section, previousIndex]) => {
          const result = selectCalloutPhrase(CALLOUT_COPY_CATALOG, section, roundId, previousIndex);

          expect(result).not.toBeNull();
          if (result === null) return;

          expect(result.index).not.toBe(previousIndex);
          expect(result.text).not.toBe(CALLOUT_COPY_CATALOG[section][previousIndex]);
        }
      ),
      { numRuns: 200 }
    );
  });
});

// Feature: vote-reveal-fun-callouts, Property 20: Restricted term check totality
/**
 * **Validates: Requirements 4.13**
 *
 * For every catalog entry and every form of every term of every group of the Restricted_Term_List,
 * the whole-word, case-insensitive presence check terminates and returns a boolean. It matches a
 * declared form in any letter case when the form is embedded in a sentence, and rejects
 * substring-only near misses (letters glued onto a single-word form so it is no longer a whole word).
 */
describe('Property 20: Restricted term check totality', () => {
  const groups = Object.entries(RESTRICTED_TERMS) as [string, readonly RestrictedTerm[]][];

  const groupArb: fc.Arbitrary<readonly RestrictedTerm[]> = fc.constantFrom(...groups.map(([, g]) => g));

  /** Every (group, form) pair, so each declared form is reachable by the generators. */
  const allForms: { group: readonly RestrictedTerm[]; form: string }[] = groups.flatMap(([, group]) =>
    group.flatMap((term) => term.forms.map((form) => ({ group, form })))
  );
  const groupFormArb = fc.constantFrom(...allForms);
  const singleWordForms = allForms.filter(({ form }) => !/\s/.test(form));
  const singleWordFormArb = fc.constantFrom(...singleWordForms);

  /** Neutral words that appear in no group, used as sentence padding. */
  const fillerArb = fc.array(
    fc.constantFrom('the', 'team', 'talks', 'together', 'about', 'cards', 'today', 'and', 'then', 'moves', 'on'),
    { minLength: 0, maxLength: 4 }
  );
  const punctuationArb = fc.constantFrom('', '.', '!', '?', ',', ' ...');

  /** Applies an arbitrary per-character letter case to a string. */
  const withCase = (text: string, flags: boolean[]): string =>
    [...text].map((ch, i) => (flags[i % Math.max(flags.length, 1)] ? ch.toUpperCase() : ch.toLowerCase())).join('');
  const caseFlagsArb = fc.array(fc.boolean(), { minLength: 1, maxLength: 24 });

  /** Letters that never turn a declared form into another declared form of the lists. */
  const gluedLettersArb = fc
    .array(fc.constantFrom('q', 'x', 'z', 'j', 'k', 'v'), { minLength: 1, maxLength: 3 })
    .map((letters) => letters.join(''));

  const knownForms = new Set(allForms.map(({ form }) => form));

  it('terminates with a boolean for every catalog entry and every group', () => {
    const sections = Object.keys(CALLOUT_COPY_CATALOG) as CalloutSection[];
    for (const section of sections) {
      for (const entry of CALLOUT_COPY_CATALOG[section]) {
        for (const [, group] of groups) {
          expect(typeof containsRestrictedTerm(entry, group)).toBe('boolean');
        }
      }
    }
  });

  it('terminates with a boolean for arbitrary text and any group', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: 'binary' })), groupArb, (text, group) => {
        expect(typeof containsRestrictedTerm(text, group)).toBe('boolean');
      }),
      { numRuns: 200 }
    );
  });

  it('matches every declared form embedded in a sentence in any letter case', () => {
    fc.assert(
      fc.property(
        groupFormArb,
        fillerArb,
        fillerArb,
        caseFlagsArb,
        punctuationArb,
        ({ group, form }, before, after, flags, punctuation) => {
          const sentence = [...before, withCase(form, flags), ...after].join(' ') + punctuation;
          expect(containsRestrictedTerm(sentence, group)).toBe(true);
        }
      ),
      { numRuns: 300 }
    );
  });

  it('rejects a single-word form with letters prefixed or suffixed to it', () => {
    fc.assert(
      fc.property(
        singleWordFormArb,
        fillerArb,
        fillerArb,
        caseFlagsArb,
        gluedLettersArb,
        fc.constantFrom('prefix', 'suffix', 'both'),
        ({ group, form }, before, after, flags, glue, where) => {
          const glued =
            where === 'prefix' ? glue + form : where === 'suffix' ? form + glue : glue + form + glue;
          fc.pre(!knownForms.has(glued));
          const sentence = [...before, withCase(glued, flags), ...after].join(' ');
          expect(containsRestrictedTerm(sentence, group)).toBe(false);
        }
      ),
      { numRuns: 300 }
    );
  });
});

// Feature: vote-reveal-fun-callouts, Property 21: Copy coverage within twice the section length
/**
 * **Validates: Requirements 4.14**
 *
 * For every section of the catalog and every generated sequence of consecutive appearances
 * (each result's index fed back as the next previousIndex, starting from -1, with varied
 * Voting_Round identifiers), a sequence of 2 x n appearances, where n is the number of entries
 * of the section, selects every entry of that section at least once.
 */
describe('Property 21: Copy coverage within twice the section length', () => {
  /** Runs `length` consecutive appearances, feeding each index back as the next previousIndex. */
  const runChain = (section: CalloutSection, roundIds: readonly string[], length: number): number[] => {
    const indexes: number[] = [];
    let previousIndex = -1;
    for (let i = 0; i < length; i++) {
      const result = selectCalloutPhrase(CALLOUT_COPY_CATALOG, section, roundIds[i % roundIds.length], previousIndex);
      expect(result).not.toBeNull();
      if (result === null) break;
      indexes.push(result.index);
      previousIndex = result.index;
    }
    return indexes;
  };

  it('selects every entry at least once within 2 x n consecutive appearances', () => {
    fc.assert(
      fc.property(
        sectionArb,
        fc.array(roundIdArb, { minLength: 1, maxLength: 40 }),
        (section, roundIds) => {
          const n = CALLOUT_COPY_CATALOG[section].length;
          const indexes = runChain(section, roundIds, 2 * n);

          expect(indexes).toHaveLength(2 * n);
          const selected = new Set(indexes);
          for (let entry = 0; entry < n; entry++) {
            expect(selected.has(entry)).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('covers every entry in any window of 2 x n consecutive appearances of a longer chain', () => {
    fc.assert(
      fc.property(
        sectionArb,
        fc.array(roundIdArb, { minLength: 1, maxLength: 40 }),
        fc.nat({ max: 100 }),
        (section, roundIds, offset) => {
          const n = CALLOUT_COPY_CATALOG[section].length;
          const indexes = runChain(section, roundIds, offset + 2 * n);
          const window = new Set(indexes.slice(offset, offset + 2 * n));

          for (let entry = 0; entry < n; entry++) {
            expect(window.has(entry)).toBe(true);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
