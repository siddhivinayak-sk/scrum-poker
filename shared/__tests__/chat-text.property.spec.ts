import * as fc from 'fast-check';
import { normaliseChatText, validateChatText } from '../chat-text';
import type { ChatTextResult } from '../chat-text';

/**
 * Property tests for the Chat_Validator (shared/chat-text.ts).
 * Generators live at module scope so later properties (Property 4) can append
 * their own `describe` blocks to this file without redefining them.
 */

// ---------------------------------------------------------------------------
// Reference model, written from the requirement text (R14.2–R14.6 and the
// Disallowed_Characters glossary entry). It works on UTF-16 code units with
// explicit numeric sets and no regular expressions. Every code point named by
// R14.4 and the glossary is in the BMP and none is a surrogate, so a code-unit
// walk classifies exactly the same characters as a code-point walk, and lone
// surrogates pass through untouched.
// ---------------------------------------------------------------------------

/** CHAT_MESSAGE_MAX_LENGTH and CHAT_RAW_TEXT_MAX_LENGTH as stated in R14.3 and R14.6. */
const REF_MESSAGE_MAX = 500;
const REF_RAW_MAX = 2000;

const CR = 0x000d;
const LF = 0x000a;

/** Glossary: U+0000–U+0008, U+000B–U+001F, U+007F, U+202A–U+202E, U+2066–U+2069. */
function refIsDisallowed(cu: number): boolean {
  return (
    (cu >= 0x0000 && cu <= 0x0008) ||
    (cu >= 0x000b && cu <= 0x001f) ||
    cu === 0x007f ||
    (cu >= 0x202a && cu <= 0x202e) ||
    (cu >= 0x2066 && cu <= 0x2069)
  );
}

/** Unicode general category Zs (unchanged since Unicode 6.3). */
const REF_ZS = new Set<number>([
  0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000,
]);

/** R14.4 whitespace: U+0009, U+000A, U+FEFF, U+2028, U+2029 and every Zs character. */
function refIsWhitespace(cu: number): boolean {
  return cu === 0x0009 || cu === LF || cu === 0xfeff || cu === 0x2028 || cu === 0x2029 || REF_ZS.has(cu);
}

function refNormalise(raw: string): string {
  // Step 1: each `\r\n` pair and each remaining lone `\r` becomes `\n`.
  const step1: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const cu = raw.charCodeAt(i);
    if (cu === CR) {
      step1.push(LF);
      if (i + 1 < raw.length && raw.charCodeAt(i + 1) === LF) i++;
    } else {
      step1.push(cu);
    }
  }

  // Step 2: remove every Disallowed_Character.
  const step2: number[] = [];
  for (const cu of step1) {
    if (!refIsDisallowed(cu)) step2.push(cu);
  }

  // Step 3: remove leading and trailing whitespace; interior is untouched.
  let start = 0;
  let end = step2.length;
  while (start < end && refIsWhitespace(step2[start])) start++;
  while (end > start && refIsWhitespace(step2[end - 1])) end--;

  let out = '';
  for (let i = start; i < end; i++) out += String.fromCharCode(step2[i]);
  return out;
}

function refValidate(value: unknown): ChatTextResult {
  if (typeof value !== 'string') return { ok: false, code: 'CHAT_INVALID' }; // R14.2
  if (value.length > REF_RAW_MAX) return { ok: false, code: 'CHAT_TOO_LONG' }; // R14.3
  const text = refNormalise(value); // R14.4
  if (text.length === 0) return { ok: false, code: 'CHAT_EMPTY' }; // R14.5
  if (text.length > REF_MESSAGE_MAX) return { ok: false, code: 'CHAT_TOO_LONG' }; // R14.6
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// Module-scope generators
// ---------------------------------------------------------------------------

const ZS_CHARS = [...REF_ZS].map((cu) => String.fromCharCode(cu));
const BIDI_CHARS = ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069'];
const C0_DISALLOWED_CHARS = ['\u0000', '\u0001', '\u0008', '\u000B', '\u000C', '\u000E', '\u001B', '\u001F', '\u007F'];

/** Characters R14.4 trims from both ends. */
const whitespaceCharArb: fc.Arbitrary<string> = fc.constantFrom(
  '\t',
  '\n',
  '\uFEFF',
  '\u2028',
  '\u2029',
  ...ZS_CHARS,
);

/** Disallowed_Characters, weighted towards the bidi controls. */
const disallowedCharArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...BIDI_CHARS),
  fc.constantFrom(...C0_DISALLOWED_CHARS),
  fc.integer({ min: 0x0000, max: 0x001f }).filter((cu) => cu !== 0x09 && cu !== 0x0a && cu !== 0x0d).map((cu) => String.fromCharCode(cu)),
);

/** Line-break forms that step 1 rewrites. */
const lineBreakArb: fc.Arbitrary<string> = fc.constantFrom('\r\n', '\r', '\n', '\r\r\n', '\n\r');

/** Unpaired high or low surrogates. */
const loneSurrogateArb: fc.Arbitrary<string> = fc
  .integer({ min: 0xd800, max: 0xdfff })
  .map((cu) => String.fromCharCode(cu));

/** Ordinary visible text, including a non-BMP pair. */
const visibleCharArb: fc.Arbitrary<string> = fc.constantFrom('a', 'Z', '7', 'é', '中', '😀', '<', '"', '\u200B');

/** Any single UTF-16 code unit. */
const anyCodeUnitArb: fc.Arbitrary<string> = fc
  .integer({ min: 0x0000, max: 0xffff })
  .map((cu) => String.fromCharCode(cu));

/** One fragment of a mixed string. */
const fragmentArb: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: visibleCharArb, weight: 4 },
  { arbitrary: whitespaceCharArb, weight: 3 },
  { arbitrary: disallowedCharArb, weight: 2 },
  { arbitrary: lineBreakArb, weight: 2 },
  { arbitrary: loneSurrogateArb, weight: 1 },
  { arbitrary: anyCodeUnitArb, weight: 1 },
  { arbitrary: fc.string({ unit: 'binary', maxLength: 6 }), weight: 1 },
);

/** Short strings mixing every interesting character class. */
const mixedStringArb: fc.Arbitrary<string> = fc
  .array(fragmentArb, { maxLength: 40 })
  .map((parts) => parts.join(''));

/** Strings made only of whitespace, Disallowed_Characters and line breaks (normalise to empty). */
const blankStringArb: fc.Arbitrary<string> = fc
  .array(fc.oneof(whitespaceCharArb, disallowedCharArb, lineBreakArb), { maxLength: 60 })
  .map((parts) => parts.join(''));

/** Character repeated to build the body of a near-limit string. */
const bodyCharArb: fc.Arbitrary<string> = fc.constantFrom('a', 'é', ' ', '\t', '\u0001', '\u202E', '\n', '\r\n');

/**
 * Strings whose raw or normalised length sits near 500 or 2,000 code units:
 * blank padding + a mixed interior + a repeated body char + blank padding.
 */
const nearLimitStringArb: fc.Arbitrary<string> = fc
  .record({
    bodyLen: fc.oneof(
      fc.integer({ min: REF_MESSAGE_MAX - 6, max: REF_MESSAGE_MAX + 6 }),
      fc.integer({ min: REF_RAW_MAX - 30, max: REF_RAW_MAX + 6 }),
    ),
    bodyChar: bodyCharArb,
    lead: blankStringArb,
    interior: mixedStringArb,
    trail: blankStringArb,
  })
  .map(({ bodyLen, bodyChar, lead, interior, trail }) => {
    const repeats = Math.max(0, Math.ceil((bodyLen - interior.length) / bodyChar.length));
    return lead + interior + bodyChar.repeat(repeats) + trail;
  });

/** Exact-length strings of non-trim text around both limits. */
const exactLengthStringArb: fc.Arbitrary<string> = fc
  .oneof(
    fc.integer({ min: REF_MESSAGE_MAX - 2, max: REF_MESSAGE_MAX + 2 }),
    fc.integer({ min: REF_RAW_MAX - 2, max: REF_RAW_MAX + 2 }),
  )
  .map((len) => 'x'.repeat(len));

/** Values that are not strings (R14.2). */
const nonStringArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.bigInt(),
  fc.array(fc.string()),
  fc.dictionary(fc.string(), fc.string()),
  fc.constant(new String('hello')),
  fc.anything().filter((v) => typeof v !== 'string'),
);

/** Any value the Chat_Validator may receive. */
const chatTextInputArb: fc.Arbitrary<unknown> = fc.oneof(
  { arbitrary: nonStringArb, weight: 1 },
  { arbitrary: mixedStringArb, weight: 4 },
  { arbitrary: blankStringArb, weight: 2 },
  { arbitrary: nearLimitStringArb, weight: 3 },
  { arbitrary: exactLengthStringArb, weight: 1 },
  { arbitrary: fc.string({ unit: 'binary', maxLength: 2100 }), weight: 1 },
);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

// Feature: session-chat, Property 3: Chat_Validator agrees with the reference specification
describe('Property 3: Chat_Validator agrees with the reference specification', () => {
  /** **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.8** */
  it('returns the reference result, satisfies the accepted-text invariant and is deterministic', () => {
    fc.assert(
      fc.property(chatTextInputArb, (value) => {
        const result = validateChatText(value);

        // R14.2–R14.6: same Normalised_Text or the same single rejection code.
        expect(result).toEqual(refValidate(value));

        // R14.1: same result on every call.
        expect(validateChatText(value)).toEqual(result);

        // R14.8: invariant of every accepted text.
        if (result.ok) {
          const { text } = result;
          expect(text.length).toBeGreaterThanOrEqual(1);
          expect(text.length).toBeLessThanOrEqual(REF_MESSAGE_MAX);
          for (let i = 0; i < text.length; i++) {
            const cu = text.charCodeAt(i);
            expect(cu).not.toBe(CR);
            expect(refIsDisallowed(cu)).toBe(false);
          }
          expect(refIsWhitespace(text.charCodeAt(0))).toBe(false);
          expect(refIsWhitespace(text.charCodeAt(text.length - 1))).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });
});

/** Any string the normaliser may receive (Property 4 is defined for strings only). */
const anyChatStringArb: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: mixedStringArb, weight: 4 },
  { arbitrary: blankStringArb, weight: 2 },
  { arbitrary: nearLimitStringArb, weight: 3 },
  { arbitrary: exactLengthStringArb, weight: 1 },
  { arbitrary: fc.string({ unit: 'binary', maxLength: 2100 }), weight: 1 },
);

// Feature: session-chat, Property 4: Normalisation is idempotent
describe('Property 4: Normalisation is idempotent', () => {
  /** **Validates: Requirements 14.7** */
  it('normalising an already Normalised_Text returns the same Normalised_Text', () => {
    fc.assert(
      fc.property(anyChatStringArb, (s) => {
        const once = normaliseChatText(s);
        expect(normaliseChatText(once)).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  /** **Validates: Requirements 14.7** */
  it('validating an accepted Normalised_Text accepts it again with the same text', () => {
    fc.assert(
      fc.property(anyChatStringArb, (s) => {
        const first = validateChatText(s);
        if (!first.ok) return;
        expect(validateChatText(first.text)).toEqual({ ok: true, text: first.text });
      }),
      { numRuns: 500 },
    );
  });
});
