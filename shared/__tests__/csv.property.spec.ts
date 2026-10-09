import * as fc from 'fast-check';
import { parseCsv, quoteCsvField, serializeCsvRow } from '../csv';

// Feature: poker-retro-ux-improvements, Property 1: For any list of field values,
// parsing the serialized row produced by `quoteCsvField` with an RFC 4180 parser
// recovers every original field value unchanged.
//
// **Validates: Requirements 1.16, 14.8**
//
// The round trip is exact only because every character that could otherwise be
// read as structure is quoted by the writer. `parseCsv` treats CR, LF and CRLF
// alike as record terminators, so a field holding a bare CR is only recoverable
// if the writer quoted it — the `rows.length === 1` assertion below is what
// pins that down.

/** Characters that carry structural meaning in RFC 4180 output. */
const STRUCTURAL_CHARS = [',', '"', '\r', '\n'];

/** Whitespace that is preserved verbatim inside a field. */
const SPACE_CHARS = [' ', '\t', '  ', '\u00a0'];

/** Plain ASCII payload characters. */
const ASCII_CHARS = ['a', 'B', 'z', '0', '9', '-', '_', ';', '=', '.', "'", '|'];

/**
 * Unicode payload including combining marks, CJK, an astral-plane emoji and a
 * right-to-left letter, so the round trip is exercised across surrogate pairs.
 */
const UNICODE_CHARS = ['é', 'ü', 'ß', 'e\u0301', '漢', '日本語', 'Ω', '→', '«', '»', '😀', '𝄞', 'ا'];

/**
 * One unit of field content. Structural characters are weighted heavily so a
 * typical generated field stresses the quoting path rather than the pass-through
 * path; `'\r\n'` and the multi-character unicode units mean a field's character
 * length can exceed the number of generated units, which is intentional.
 */
const fieldUnitArb = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...STRUCTURAL_CHARS, '""', '\r\n') },
  { weight: 3, arbitrary: fc.constantFrom(...ASCII_CHARS) },
  { weight: 2, arbitrary: fc.constantFrom(...SPACE_CHARS) },
  { weight: 2, arbitrary: fc.constantFrom(...UNICODE_CHARS) }
);

/** Upper bound on generated field length (R14.8). */
const MAX_FIELD_LENGTH = 1000;

/**
 * A single field value, 0–1,000 characters drawn from the units above.
 *
 * `size: 'max'` is required: without it fast-check's default sizing caps the
 * unit count near ten regardless of `maxLength`, so the generated fields would
 * never approach the 1,000-character bound R14.8 states and the round trip
 * would pass without ever being exercised over a long field.
 */
const fieldArb = fc
  .array(fieldUnitArb, { minLength: 0, maxLength: MAX_FIELD_LENGTH, size: 'max' })
  .map((units) => units.join('').slice(0, MAX_FIELD_LENGTH));

/** A record of 1–10 fields. */
const fieldsArb = fc.array(fieldArb, { minLength: 1, maxLength: 10 });

/**
 * Hand-picked records that the random generator would reach only rarely but
 * which sit exactly on the boundaries of the quoting rules.
 */
const EXAMPLES: [string[]][] = [
  [['']],
  [['"']],
  [['""']],
  [['\r']],
  [['\n']],
  [['\r\n']],
  [[',']],
  [['', '']],
  [['\r', '']],
  [['', '\n']],
  [['a', '\r', 'b']],
  [['plain', 'has,comma', 'has"quote', 'has\r\nbreak', '  padded  ']],
  [[' ', '\t', '\u00a0']],
  [['😀,😀', '"𝄞"']],
  [['x'.repeat(1000)]],
  [[`${'a,'.repeat(499)}a`]],
];

describe('Property 1: CSV field quoting round trip', () => {
  it('R1.16/R14.8: parsing a serialized row recovers every original field value unchanged', () => {
    fc.assert(
      fc.property(fieldsArb, (fields) => {
        const document = serializeCsvRow(fields.map(quoteCsvField));
        const rows = parseCsv(document);

        // No field value may leak structure into the document: a quoted field
        // containing a comma, CR, LF or CRLF must not split the record.
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual(fields);
      }),
      { numRuns: 100, examples: EXAMPLES }
    );
  });

  it('R14.8: the field generator actually reaches the stated 1,000-character bound', () => {
    // A coverage guard, not a behaviour claim. `EXAMPLES` above holds a
    // hand-written 1,000-character field, so measuring the length inside the
    // property would stay satisfied even if the generator silently collapsed.
    // Sampling the generator on its own is what makes a collapse fail loudly.
    const lengths = fc.sample(fieldArb, 200).map((field) => field.length);

    expect(Math.max(...lengths)).toBeGreaterThanOrEqual(900);
    expect(Math.min(...lengths)).toBeLessThanOrEqual(10);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(MAX_FIELD_LENGTH);
  });
});
