import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  AVATAR_PALETTE,
  avatarColorIndex,
  avatarInitials,
  badgeText,
  clampPaste,
  counterText,
  formatChatTime,
  indicatorText,
  launcherLabel,
  onlineLabel,
  presenceEntries,
  rateLimitSeconds,
} from './chat-format';
import type { PresenceEntry, PresenceParticipant } from './chat-format';
import { CHAT_MESSAGE_MAX_LENGTH } from '@shared/types';

// ---------------------------------------------------------------------------
// Shared generators (module scope so later properties in this file can reuse them)
// ---------------------------------------------------------------------------

const NUM_RUNS = 200;

/**
 * Non-negative integer counts, weighted so that every band of the count formats
 * is hit: 0, 1, 2–99, the 99/100 boundary, and large values up to MAX_SAFE_INTEGER.
 */
const countArb: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.constant(1),
  fc.integer({ min: 2, max: 99 }),
  fc.constantFrom(98, 99, 100, 101),
  fc.integer({ min: 100, max: 10_000 }),
  fc.integer({ min: 100, max: Number.MAX_SAFE_INTEGER }),
);

/** Draft lengths in UTF-16 code units, 0–500, weighted around the 400 threshold. */
const draftLengthArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 0, max: 500 }),
  fc.integer({ min: 395, max: 405 }),
  fc.constantFrom(0, 399, 400, 500),
);

/** Epoch-millisecond moments. */
const epochMsArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: 4_102_444_800_000 });

/** Offsets of a rate-limit end from "now": already elapsed, sub-second, whole seconds, long. */
const rateLimitOffsetArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -120_000, max: 0 }),
  fc.integer({ min: 1, max: 999 }),
  fc.integer({ min: 0, max: 120 }).map((s) => s * 1000),
  fc.integer({ min: -2, max: 2 }).chain((d) =>
    fc.integer({ min: 1, max: 120 }).map((s) => s * 1000 + d),
  ),
  fc.integer({ min: 1, max: 3_600_000 }),
);

// ---------------------------------------------------------------------------
// Property 23
// ---------------------------------------------------------------------------

// Feature: session-chat, Property 23: Count texts follow their formats
/**
 * Property 23: Count texts follow their formats
 *
 * Expected strings are written from the requirement wording:
 * - R2.1–R2.3, R2.9: badge shows the decimal count for 1–99, `99+` above 99, nothing at 0.
 * - R11.2: launcher name "Open chat" / "Open chat, 1 unread message" /
 *   "Open chat, N unread messages" with the exact N, also above 99.
 * - R6.7: indicator "1 new message" / "N new messages" (2–99) / "99+ new messages" (>99).
 * - R7.9: counter `<length>/500` while the Draft holds 400 or more code units, hidden below.
 * - R8.9: remaining rate-limit time rounded up to whole seconds.
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.9, 6.7, 7.9, 8.9, 11.2**
 */
describe('Property 23: Count texts follow their formats', () => {
  it('badgeText: decimal count for 1–99, "99+" above 99, hidden at 0 (R2.1–R2.3, R2.9)', () => {
    fc.assert(
      fc.property(countArb, (n) => {
        const text = badgeText(n);
        if (n === 0) {
          expect(text).toBe('');
        } else if (n <= 99) {
          expect(text).toMatch(/^[1-9][0-9]?$/);
          expect(Number(text)).toBe(n);
        } else {
          expect(text).toBe('99+');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('launcherLabel: "Open chat" at 0, singular at 1, exact N otherwise (R11.2)', () => {
    fc.assert(
      fc.property(countArb, (n) => {
        const label = launcherLabel(n);
        if (n === 0) {
          expect(label).toBe('Open chat');
        } else if (n === 1) {
          expect(label).toBe('Open chat, 1 unread message');
        } else {
          const match = /^Open chat, ([1-9][0-9]*) unread messages$/.exec(label);
          expect(match).not.toBeNull();
          // The exact count, never capped at 99+.
          expect(Number(match![1])).toBe(n);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('indicatorText: "1 new message", "N new messages" for 2–99, "99+ new messages" above 99 (R6.7)', () => {
    fc.assert(
      fc.property(countArb.filter((n) => n >= 1), (n) => {
        const text = indicatorText(n);
        if (n === 1) {
          expect(text).toBe('1 new message');
        } else if (n <= 99) {
          const match = /^([1-9][0-9]?) new messages$/.exec(text);
          expect(match).not.toBeNull();
          expect(Number(match![1])).toBe(n);
        } else {
          expect(text).toBe('99+ new messages');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('counterText: "<length>/500" exactly when the Draft holds 400 or more code units (R7.9)', () => {
    fc.assert(
      fc.property(draftLengthArb, (length) => {
        const text = counterText(length);
        if (length >= 400) {
          const match = /^([0-9]+)\/500$/.exec(text);
          expect(match).not.toBeNull();
          expect(Number(match![1])).toBe(length);
        } else {
          expect(text).toBe('');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('counterText: the counter is driven by the actual Draft length in UTF-16 code units (R7.9)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 500 }), (draft) => {
        const text = counterText(draft.length);
        expect(text === '').toBe(draft.length < 400);
        if (draft.length >= 400) {
          expect(text).toBe(`${draft.length}/500`);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('rateLimitSeconds: remaining time rounded up to whole seconds, 0 once elapsed (R8.9)', () => {
    fc.assert(
      fc.property(epochMsArb, rateLimitOffsetArb, (now, offset) => {
        const until = now + offset;
        const seconds = rateLimitSeconds(until, now);
        const remainingMs = until - now;

        expect(Number.isInteger(seconds)).toBe(true);
        if (remainingMs <= 0) {
          expect(seconds).toBe(0);
        } else {
          // Smallest whole number of seconds that covers the remaining time.
          expect(seconds).toBeGreaterThanOrEqual(1);
          expect(seconds * 1000).toBeGreaterThanOrEqual(remainingMs);
          expect((seconds - 1) * 1000).toBeLessThan(remainingMs);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 24
// ---------------------------------------------------------------------------

/** English three-letter month abbreviations, January first (R5.5). */
const MONTH_ABBREVIATIONS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** A local calendar day; `day` is always valid for its month. */
interface LocalDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Local wall-clock time of day. */
interface LocalTime {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly ms: number;
}

/** Valid local days 1971–2099, weighted toward the first and last day of a month. */
const localDayArb: fc.Arbitrary<LocalDay> = fc
  .record({ year: fc.integer({ min: 1971, max: 2099 }), month: fc.integer({ min: 0, max: 11 }) })
  .chain(({ year, month }) => {
    // Day 0 of the next month is the last day of this one (local calendar).
    const lastDay = new Date(year, month + 1, 0).getDate();
    return fc
      .oneof(fc.integer({ min: 1, max: lastDay }), fc.constantFrom(1, lastDay))
      .map((day) => ({ year, month, day }));
  });

/** Local times of day, weighted toward midnight, 23:59 and single-digit hours/minutes. */
const localTimeArb: fc.Arbitrary<LocalTime> = fc.record({
  hour: fc.oneof(fc.integer({ min: 0, max: 23 }), fc.constantFrom(0, 9, 23)),
  minute: fc.oneof(fc.integer({ min: 0, max: 59 }), fc.constantFrom(0, 5, 59)),
  second: fc.integer({ min: 0, max: 59 }),
  ms: fc.integer({ min: 0, max: 999 }),
});

/** Builds a moment from local-time components, so the local day is the one given. */
function localMoment(day: LocalDay, time: LocalTime, dayOffset = 0): Date {
  return new Date(
    day.year,
    day.month,
    day.day + dayOffset,
    time.hour,
    time.minute,
    time.second,
    time.ms,
  );
}

/** `now` is accepted as a `Date` or as epoch milliseconds; exercise both. */
const nowFormArb: fc.Arbitrary<'date' | 'number'> = fc.constantFrom('date', 'number');

function asNow(moment: Date, form: 'date' | 'number'): Date | number {
  return form === 'date' ? new Date(moment.getTime()) : moment.getTime();
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Independent model of R5.5, built from the local `Date` getters:
 * `HH:mm` on the same local calendar day, otherwise `MMM d, HH:mm`.
 */
function expectedChatTime(sentAt: string, now: Date): string {
  const sent = new Date(sentAt);
  const time = `${pad2(sent.getHours())}:${pad2(sent.getMinutes())}`;
  if (isSameLocalDay(sent, now)) {
    return time;
  }
  return `${MONTH_ABBREVIATIONS[sent.getMonth()]} ${sent.getDate()}, ${time}`;
}

const SHORT_FORM = /^([0-9]{2}):([0-9]{2})$/;
const LONG_FORM = /^([A-Z][a-z]{2}) ([1-9][0-9]?), ([0-9]{2}):([0-9]{2})$/;

/** Asserts the short form and that its fields are the local hour and minute of `sentAt`. */
function expectShortForm(text: string, sentAt: string): void {
  const sent = new Date(sentAt);
  const match = SHORT_FORM.exec(text);
  expect(match).not.toBeNull();
  expect(Number(match![1])).toBe(sent.getHours());
  expect(Number(match![2])).toBe(sent.getMinutes());
}

/** Asserts the long form and that its fields are the local month, day, hour and minute. */
function expectLongForm(text: string, sentAt: string): void {
  const sent = new Date(sentAt);
  const match = LONG_FORM.exec(text);
  expect(match).not.toBeNull();
  expect(match![1]).toBe(MONTH_ABBREVIATIONS[sent.getMonth()]);
  expect(Number(match![2])).toBe(sent.getDate());
  expect(Number(match![3])).toBe(sent.getHours());
  expect(Number(match![4])).toBe(sent.getMinutes());
}

// Feature: session-chat, Property 24: Timestamps follow the two display forms
/**
 * Property 24: Timestamps follow the two display forms
 *
 * Expected strings are written from R5.5: zero-padded 24-hour local `HH:mm` when
 * `sentAt` falls on the same local calendar day as the moment of rendering, and
 * otherwise `MMM d, HH:mm` with an English three-letter month and an unpadded day.
 * Same-day pairs are built with local-time constructors so the test holds in the
 * time zone the process runs in.
 *
 * **Validates: Requirements 5.5**
 */
describe('Property 24: Timestamps follow the two display forms', () => {
  it('same local calendar day: zero-padded 24-hour HH:mm of the local time', () => {
    fc.assert(
      fc.property(localDayArb, localTimeArb, localTimeArb, nowFormArb, (day, sentTime, nowTime, form) => {
        const sentAt = localMoment(day, sentTime).toISOString();
        const now = localMoment(day, nowTime);
        // Local constructors keep both moments on the given local day, also across DST shifts.
        expect(isSameLocalDay(new Date(sentAt), now)).toBe(true);

        const text = formatChatTime(sentAt, asNow(now, form));
        expectShortForm(text, sentAt);
        expect(text).toBe(expectedChatTime(sentAt, now));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('adjacent local days around midnight: MMM d, HH:mm in both directions', () => {
    fc.assert(
      fc.property(
        localDayArb,
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 0, max: 59 }),
        fc.boolean(),
        nowFormArb,
        (day, lateMinute, earlyMinute, sentBeforeMidnight, form) => {
          const beforeMidnight = localMoment(day, { hour: 23, minute: lateMinute, second: 59, ms: 999 });
          const afterMidnight = localMoment(day, { hour: 0, minute: earlyMinute, second: 0, ms: 0 }, 1);
          const sent = sentBeforeMidnight ? beforeMidnight : afterMidnight;
          const now = sentBeforeMidnight ? afterMidnight : beforeMidnight;
          const sentAt = sent.toISOString();
          expect(isSameLocalDay(sent, now)).toBe(false);

          const text = formatChatTime(sentAt, asNow(now, form));
          expectLongForm(text, sentAt);
          expect(text).toBe(expectedChatTime(sentAt, now));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('same month and day in a different year: MMM d, HH:mm', () => {
    fc.assert(
      fc.property(
        localDayArb.filter((d) => !(d.month === 1 && d.day === 29)),
        localTimeArb,
        localTimeArb,
        fc.integer({ min: -50, max: 50 }).filter((k) => k !== 0),
        nowFormArb,
        (day, sentTime, nowTime, yearDelta, form) => {
          const sentAt = localMoment(day, sentTime).toISOString();
          const now = localMoment({ ...day, year: day.year + yearDelta }, nowTime);
          expect(isSameLocalDay(new Date(sentAt), now)).toBe(false);

          const text = formatChatTime(sentAt, asNow(now, form));
          expectLongForm(text, sentAt);
          expect(text).toBe(expectedChatTime(sentAt, now));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('different local days at any distance: MMM d, HH:mm', () => {
    fc.assert(
      fc.property(
        localDayArb,
        localTimeArb,
        localTimeArb,
        fc.oneof(fc.integer({ min: 1, max: 400 }), fc.integer({ min: -400, max: -1 })),
        nowFormArb,
        (day, sentTime, nowTime, dayOffset, form) => {
          const sentAt = localMoment(day, sentTime).toISOString();
          const now = localMoment(day, nowTime, dayOffset);
          expect(isSameLocalDay(new Date(sentAt), now)).toBe(false);

          const text = formatChatTime(sentAt, asNow(now, form));
          expectLongForm(text, sentAt);
          expect(text).toBe(expectedChatTime(sentAt, now));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('arbitrary moments: the form is decided by the local calendar day alone', () => {
    fc.assert(
      fc.property(epochMsArb, epochMsArb, nowFormArb, (sentMs, nowMs, form) => {
        const sentAt = new Date(sentMs).toISOString();
        const now = new Date(nowMs);

        const text = formatChatTime(sentAt, asNow(now, form));
        if (isSameLocalDay(new Date(sentAt), now)) {
          expectShortForm(text, sentAt);
        } else {
          expectLongForm(text, sentAt);
        }
        expect(text).toBe(expectedChatTime(sentAt, now));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 25
// ---------------------------------------------------------------------------

/** The avatar palette as listed in the design's presentation-helper table (R5.3, R5.4). */
const DESIGN_AVATAR_PALETTE = [
  '#2b6cb0',
  '#276749',
  '#6b46c1',
  '#c53030',
  '#b83280',
  '#2c7a7b',
  '#975a16',
  '#4a5568',
];

/**
 * R5.3 does not define "whitespace" itself, so the reference uses Unicode
 * whitespace: the White_Space code points plus U+FEFF (the set ECMAScript `\s`
 * matches), listed explicitly so the model does not depend on the regex engine.
 */
const WHITESPACE_CODE_POINTS: ReadonlySet<number> = new Set([
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

const WHITESPACE_CHARS: readonly string[] = [...WHITESPACE_CODE_POINTS].map((cp) =>
  String.fromCodePoint(cp),
);

/**
 * Word characters whose upper-case form is a single code point: ASCII, accented
 * Latin, Greek, Cyrillic, CJK, astral letters with case mappings (Deseret, Osage),
 * astral non-letters (math bold, emoji) and punctuation.
 */
const WORD_CHARS: readonly string[] = [
  'a', 'z', 'A', 'Z', 'm', 'Q', '0', '7', '-', "'", '.', '_',
  'é', 'É', 'ñ', 'ö', 'ç', 'ø', 'å', 'ł', 'ğ', 'ı', 'ÿ',
  'α', 'ω', 'Σ', 'ж', 'я', 'Ж',
  '山', '田', '李', '王', 'の', '한',
  '\u{10428}', '\u{10400}', '\u{104d8}', // Deseret small/capital, Osage small
  '\u{1d400}', // MATHEMATICAL BOLD CAPITAL A
  '😀', '👍', '🎉', '🦊', '🇩🇪',
];

/** Code points of a string, iterated by the string iterator (surrogate pairs kept whole). */
function codePoints(value: string): string[] {
  return Array.from(value);
}

function isWhitespace(codePoint: string): boolean {
  return WHITESPACE_CODE_POINTS.has(codePoint.codePointAt(0)!);
}

/** Words of `name`: maximal runs of non-whitespace code points (R5.3). */
function referenceWords(name: string): string[][] {
  const words: string[][] = [];
  let current: string[] = [];
  for (const cp of codePoints(name)) {
    if (isWhitespace(cp)) {
      if (current.length > 0) {
        words.push(current);
        current = [];
      }
    } else {
      current.push(cp);
    }
  }
  if (current.length > 0) {
    words.push(current);
  }
  return words;
}

/** Independent model of R5.3 initials. */
function referenceInitials(name: string): string {
  const words = referenceWords(name);
  if (words.length === 0) {
    return '?';
  }
  return words
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
}

/** Independent FNV-1a 32-bit over UTF-16 code units, computed with BigInt arithmetic. */
function referenceFnv1a32(value: string): bigint {
  let hash = 0x811c9dc5n;
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = (hash * 0x01000193n) & 0xffffffffn;
  }
  return hash;
}

function referenceColorIndex(authorId: string): number {
  return Number(referenceFnv1a32(authorId) % 8n);
}

/** True when the string contains no lone surrogate. */
function isWellFormedUtf16(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const whitespaceRunArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...WHITESPACE_CHARS), { minLength: 1, maxLength: 4 })
  .map((chars) => chars.join(''));

const optionalWhitespaceArb: fc.Arbitrary<string> = fc.oneof(fc.constant(''), whitespaceRunArb);

const wordArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...WORD_CHARS), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(''));

/** Names built from words and whitespace runs, with optional leading/trailing whitespace. */
const structuredNameArb: fc.Arbitrary<{ name: string; words: string[] }> = fc
  .record({
    leading: optionalWhitespaceArb,
    words: fc.array(wordArb, { minLength: 1, maxLength: 5 }),
    separators: fc.array(whitespaceRunArb, { minLength: 4, maxLength: 4 }),
    trailing: optionalWhitespaceArb,
  })
  .map(({ leading, words, separators, trailing }) => ({
    name: leading + words.map((w, i) => (i === 0 ? w : separators[i - 1] + w)).join('') + trailing,
    words,
  }));

/** Empty or whitespace-only names (tabs, newlines, NBSP, ideographic space, BOM…). */
const blankNameArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...WHITESPACE_CHARS), { minLength: 0, maxLength: 8 })
  .map((chars) => chars.join(''));

/** Unconstrained names: arbitrary code units, full Unicode graphemes, and the structured mix. */
const anyNameArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc.string({ unit: 'grapheme', maxLength: 20 }),
  structuredNameArb.map((n) => n.name),
  blankNameArb,
);

const authorIdArb: fc.Arbitrary<string> = fc.oneof(
  fc.uuid(),
  fc.string({ unit: 'binary', maxLength: 64 }),
  fc.string({ maxLength: 36 }),
);

// Feature: session-chat, Property 25: Avatars are deterministic
/**
 * Property 25: Avatars are deterministic
 *
 * The initials model is written from R5.3: the upper-cased first Unicode code
 * point of each of the first two whitespace-separated words, one initial for a
 * one-word name and `?` when the name has no non-whitespace character. The
 * colour model is an independent BigInt FNV-1a 32-bit hash over the UTF-16 code
 * units, mod 8, so the same `authorId` maps to the same palette colour on every
 * client and after every reload.
 *
 * **Validates: Requirements 5.3**
 */
describe('Property 25: Avatars are deterministic', () => {
  it('AVATAR_PALETTE holds exactly the 8 distinct colours listed in the design', () => {
    expect(AVATAR_PALETTE).toHaveLength(8);
    expect(new Set(AVATAR_PALETTE.map((c) => c.toLowerCase())).size).toBe(8);
    expect([...AVATAR_PALETTE]).toEqual(DESIGN_AVATAR_PALETTE);
  });

  it('avatarColorIndex matches published FNV-1a 32-bit vectors (mod 8)', () => {
    // FNV-1a 32: "" = 0x811c9dc5, "a" = 0xe40c292c, "foobar" = 0xbf9cf968.
    expect(referenceFnv1a32('')).toBe(0x811c9dc5n);
    expect(referenceFnv1a32('a')).toBe(0xe40c292cn);
    expect(referenceFnv1a32('foobar')).toBe(0xbf9cf968n);
    expect(avatarColorIndex('')).toBe(0x811c9dc5 % 8);
    expect(avatarColorIndex('a')).toBe(0xe40c292c % 8);
    expect(avatarColorIndex('foobar')).toBe(0xbf9cf968 % 8);
  });

  it('avatarColorIndex: same index in 0–7 on every call, equal to the reference FNV-1a mod 8', () => {
    fc.assert(
      fc.property(authorIdArb, (authorId) => {
        const first = avatarColorIndex(authorId);
        // A copy built from code units stands in for the same ID on another client.
        const sameIdElsewhere = String.fromCharCode(
          ...Array.from({ length: authorId.length }, (_, i) => authorId.charCodeAt(i)),
        );

        expect(Number.isInteger(first)).toBe(true);
        expect(first).toBeGreaterThanOrEqual(0);
        expect(first).toBeLessThanOrEqual(7);
        expect(avatarColorIndex(authorId)).toBe(first);
        expect(avatarColorIndex(sameIdElsewhere)).toBe(first);
        expect(first).toBe(referenceColorIndex(authorId));

        const colour = AVATAR_PALETTE[first];
        expect(DESIGN_AVATAR_PALETTE).toContain(colour);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('avatarInitials: upper-cased first code point of the first two words, astral characters kept whole', () => {
    fc.assert(
      fc.property(structuredNameArb, ({ name, words }) => {
        const initials = avatarInitials(name);
        const expected = words
          .slice(0, 2)
          .map((w) => String.fromCodePoint(w.codePointAt(0)!).toUpperCase())
          .join('');

        expect(initials).toBe(expected);
        expect(initials).toBe(referenceInitials(name));
        expect(avatarInitials(name)).toBe(initials);
        // Every word character upper-cases to one code point, so one per initial.
        expect(codePoints(initials)).toHaveLength(Math.min(2, words.length));
        expect(isWellFormedUtf16(initials)).toBe(true);
        expect(initials).not.toBe('?');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('avatarInitials: "?" for empty and whitespace-only names', () => {
    fc.assert(
      fc.property(blankNameArb, (name) => {
        expect(avatarInitials(name)).toBe('?');
        expect(referenceInitials(name)).toBe('?');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('avatarInitials: deterministic and equal to the R5.3 model for any string', () => {
    fc.assert(
      fc.property(anyNameArb, (name) => {
        const initials = avatarInitials(name);
        expect(avatarInitials(name)).toBe(initials);
        expect(initials).toBe(referenceInitials(name));

        const wordCount = referenceWords(name).length;
        if (wordCount === 0) {
          expect(initials).toBe('?');
        } else {
          expect(initials.length).toBeGreaterThan(0);
        }
        // A well-formed name never yields a split surrogate pair.
        if (isWellFormedUtf16(name)) {
          expect(isWellFormedUtf16(initials)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 26
// ---------------------------------------------------------------------------

/**
 * R10.3 orders entries by "case-insensitive alphabetical comparison of display
 * names". The model reads that literally: alphabetical (locale collation of the
 * default locale) with only case ignored, so accents still count. That is the
 * collator's `accent` sensitivity, not `base`, which would also ignore accents.
 */
const caseInsensitiveCollator = new Intl.Collator(undefined, { sensitivity: 'accent' });

function compareNamesPerRequirement(a: string, b: string): number {
  return caseInsensitiveCollator.compare(a, b);
}

/** User IDs ascending in UTF-16 code-unit order. */
function compareIds(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Independent model of R10.1: distinct user IDs. */
function distinctIds(participants: readonly PresenceParticipant[]): string[] {
  const ids: string[] = [];
  for (const p of participants) {
    if (!ids.includes(p.id)) {
      ids.push(p.id);
    }
  }
  return ids;
}

/** First participant record for each user ID, in input order. */
function firstOccurrences(participants: readonly PresenceParticipant[]): PresenceParticipant[] {
  return distinctIds(participants).map((id) => participants.find((p) => p.id === id)!);
}

/** Independent model of R10.3 and R10.6. */
function expectedPresence(
  participants: readonly PresenceParticipant[],
  me: string | null,
): PresenceEntry[] {
  return firstOccurrences(participants)
    .map((p) => ({
      userId: p.id,
      displayName: p.displayName,
      isYou: me !== null && p.id === me,
      isModerator: p.role === 'moderator',
    }))
    .sort(
      (a, b) =>
        compareNamesPerRequirement(a.displayName, b.displayName) || compareIds(a.userId, b.userId),
    );
}

/** A small ID pool forces duplicates; arbitrary strings add unicode and empty IDs. */
const presenceIdArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom('u1', 'u2', 'u3', 'U1', 'a', 'b', 'é', '😀', '') },
  { weight: 1, arbitrary: fc.uuid() },
  { weight: 1, arbitrary: fc.string({ unit: 'grapheme', maxLength: 6 }) },
);

/** Names equal up to case, accented variants, empty names and unicode. */
const presenceNameArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      'alice', 'Alice', 'ALICE', 'Álice', 'álice',
      'jose', 'Jose', 'José', 'JOSÉ', 'josé',
      'emile', 'Émile', 'zoe', 'Zoë', 'Bob', 'bob',
      '', ' ', 'ß', 'SS', 'ss', '李', '😀', 'Ωmega', 'ωmega',
    ),
  },
  { weight: 1, arbitrary: fc.string({ unit: 'grapheme', maxLength: 10 }) },
  { weight: 1, arbitrary: fc.string({ maxLength: 10 }) },
);

const presenceRoleArb: fc.Arbitrary<PresenceParticipant['role']> = fc.constantFrom(
  'moderator',
  'participant',
);

const presenceParticipantArb: fc.Arbitrary<PresenceParticipant> = fc.record({
  id: presenceIdArb,
  displayName: presenceNameArb,
  role: presenceRoleArb,
});

const participantListArb: fc.Arbitrary<PresenceParticipant[]> = fc.array(presenceParticipantArb, {
  maxLength: 12,
});

/** A list with `me`: null, an ID in the list, or an ID that may be absent from it. */
const presenceCaseArb: fc.Arbitrary<{ participants: PresenceParticipant[]; me: string | null }> =
  participantListArb.chain((participants) =>
    fc
      .oneof(
        fc.constant<string | null>(null),
        participants.length > 0
          ? fc.constantFrom<string | null>(...participants.map((p) => p.id))
          : fc.constant<string | null>(null),
        presenceIdArb.map<string | null>((id) => id),
      )
      .map((me) => ({ participants, me })),
  );

// Feature: session-chat, Property 26: Presence is derived from the participant list
/**
 * Property 26: Presence is derived from the participant list
 *
 * The model is written from the requirement wording:
 * - R10.1: "N online", N = distinct user IDs in the participant list.
 * - R10.3: exactly one entry per distinct user ID, ordered by case-insensitive
 *   alphabetical comparison of display names, ties by user ID ascending.
 * - R10.6: "(you)" only on the signed-in user's entry, "Moderator" on each
 *   entry whose user holds the `moderator` role.
 * The first record of a duplicated user ID supplies the name and role.
 *
 * **Validates: Requirements 10.1, 10.3, 10.6**
 */
describe('Property 26: Presence is derived from the participant list', () => {
  it('online count, one entry per distinct ID, first occurrence wins, markers and order (R10.1, R10.3, R10.6)', () => {
    fc.assert(
      fc.property(presenceCaseArb, ({ participants, me }) => {
        const ids = distinctIds(participants);
        const firsts = firstOccurrences(participants);

        expect(onlineLabel(participants)).toBe(`${ids.length} online`);

        const entries = presenceEntries(participants, me);

        // Exactly one entry per distinct user ID.
        expect(entries).toHaveLength(ids.length);
        expect(new Set(entries.map((e) => e.userId)).size).toBe(ids.length);
        expect([...entries.map((e) => e.userId)].sort(compareIds)).toEqual([...ids].sort(compareIds));

        for (const entry of entries) {
          const first = firsts.find((p) => p.id === entry.userId)!;
          // The first occurrence supplies name and role.
          expect(entry.displayName).toBe(first.displayName);
          expect(entry.isModerator).toBe(first.role === 'moderator');
          expect(entry.isYou).toBe(me !== null && entry.userId === me);
        }
        expect(entries.filter((e) => e.isYou)).toHaveLength(me !== null && ids.includes(me) ? 1 : 0);

        // Adjacent entries follow the required order.
        for (let i = 1; i < entries.length; i++) {
          const prev = entries[i - 1];
          const next = entries[i];
          const byName = compareNamesPerRequirement(prev.displayName, next.displayName);
          expect(
            byName < 0 || (byName === 0 && compareIds(prev.userId, next.userId) < 0),
            `order of ${JSON.stringify(prev)} before ${JSON.stringify(next)}`,
          ).toBe(true);
        }

        expect(entries).toEqual(expectedPresence(participants, me));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('output does not depend on input order beyond the first-occurrence rule', () => {
    fc.assert(
      fc.property(
        presenceCaseArb.chain(({ participants, me }) => {
          const firsts = firstOccurrences(participants);
          const rest = participants.filter((p, i) => participants.findIndex((q) => q.id === p.id) !== i);
          return fc
            .tuple(fc.shuffledSubarray(firsts, { minLength: firsts.length }), fc.shuffledSubarray(rest, { minLength: rest.length }))
            .map(([shuffledFirsts, shuffledRest]) => ({
              participants,
              me,
              // Every first occurrence stays ahead of every later duplicate.
              reordered: [...shuffledFirsts, ...shuffledRest],
            }));
        }),
        ({ participants, me, reordered }) => {
          expect(onlineLabel(reordered)).toBe(onlineLabel(participants));
          expect(presenceEntries(reordered, me)).toEqual(presenceEntries(participants, me));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('example: names equal up to case are ordered by user ID, accents are not ignored (R10.3)', () => {
    const entries = presenceEntries(
      [
        { id: 'u2', displayName: 'alice', role: 'participant' },
        { id: 'u1', displayName: 'ALICE', role: 'moderator' },
        { id: 'u2', displayName: 'Zed', role: 'moderator' },
        { id: 'u0', displayName: 'José', role: 'participant' },
        { id: 'u9', displayName: 'Jose', role: 'participant' },
      ],
      'u2',
    );
    expect(entries).toEqual([
      { userId: 'u1', displayName: 'ALICE', isYou: false, isModerator: true },
      { userId: 'u2', displayName: 'alice', isYou: true, isModerator: false },
      { userId: 'u9', displayName: 'Jose', isYou: false, isModerator: false },
      { userId: 'u0', displayName: 'José', isYou: false, isModerator: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Property 27
// ---------------------------------------------------------------------------

/** The Draft limit of R7.12, in UTF-16 code units (`CHAT_MESSAGE_MAX_LENGTH`). */
const PASTE_LIMIT = 500;

function isHighUnit(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowUnit(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** True when cutting `text` after `k` code units separates a high surrogate from its low surrogate. */
function cutSplitsPair(text: string, k: number): boolean {
  return k > 0 && k < text.length && isHighUnit(text.charCodeAt(k - 1)) && isLowUnit(text.charCodeAt(k));
}

/**
 * Text pieces: ASCII, BMP (accented Latin, CJK, symbols), astral characters
 * (surrogate pairs, two code units) and lone high and low surrogates.
 */
const textPieceArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom('a', 'Z', '7', ' ', '\n', '.', '-') },
  { weight: 2, arbitrary: fc.constantFrom('é', 'ß', 'Ω', 'ж', '山', '한', '€', '\u00a0', '\ufeff') },
  { weight: 3, arbitrary: fc.constantFrom('😀', '👍', '🎉', '🦊', '\u{10400}', '\u{1d400}', '\u{20000}') },
  { weight: 1, arbitrary: fc.constantFrom('\ud800', '\udbff', '\ud83d') },
  { weight: 1, arbitrary: fc.constantFrom('\udc00', '\udfff', '\ude00') },
);

/** A string of exactly `length` code units (the last piece may be cut, leaving a lone surrogate). */
function textOfLength(length: number): fc.Arbitrary<string> {
  return fc
    .array(textPieceArb, { minLength: length, maxLength: length })
    .map((pieces) => pieces.join('').slice(0, length));
}

/** Draft lengths 0–500, weighted toward a full or almost full Draft. */
const pasteDraftLengthArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 1, arbitrary: fc.integer({ min: 0, max: PASTE_LIMIT }) },
  { weight: 2, arbitrary: fc.integer({ min: PASTE_LIMIT - 20, max: PASTE_LIMIT }) },
  { weight: 1, arbitrary: fc.constantFrom(0, 1, PASTE_LIMIT - 2, PASTE_LIMIT - 1, PASTE_LIMIT) },
);

/** A selection bound for a Draft of `length`: in range, at the ends, negative or beyond the end. */
function selectionBoundArb(length: number): fc.Arbitrary<number> {
  return fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: 0, max: length }) },
    { weight: 1, arbitrary: fc.constantFrom(0, length) },
    { weight: 1, arbitrary: fc.integer({ min: -50, max: -1 }) },
    { weight: 1, arbitrary: fc.integer({ min: length + 1, max: length + 50 }) },
  );
}

/** The selection the user sees: bounds clamped into the Draft and put in order. */
function visibleSelection(length: number, selStart: number, selEnd: number): [number, number] {
  const clamp = (v: number): number => (v < 0 ? 0 : v > length ? length : v);
  const a = clamp(selStart);
  const b = clamp(selEnd);
  return a <= b ? [a, b] : [b, a];
}

interface PasteCase {
  readonly draft: string;
  readonly selStart: number;
  readonly selEnd: number;
  readonly pasted: string;
}

/** Pasted lengths around the space left by the unselected part of the Draft. */
function pastedLengthArb(remaining: number): fc.Arbitrary<number> {
  return fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: Math.max(0, remaining - 3), max: remaining + 3 }) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: remaining }) },
    { weight: 1, arbitrary: fc.integer({ min: remaining + 1, max: remaining + 60 }) },
    { weight: 1, arbitrary: fc.constantFrom(0, remaining, remaining + 1) },
  );
}

const pasteCaseArb: fc.Arbitrary<PasteCase> = pasteDraftLengthArb
  .chain((length) =>
    fc.tuple(textOfLength(length), selectionBoundArb(length), selectionBoundArb(length)),
  )
  .chain(([draft, selStart, selEnd]) => {
    const [start, end] = visibleSelection(draft.length, selStart, selEnd);
    const remaining = Math.max(0, PASTE_LIMIT - (draft.length - (end - start)));
    return pastedLengthArb(remaining)
      .chain(textOfLength)
      .map((pasted) => ({ draft, selStart, selEnd, pasted }));
  });

/**
 * Independent model of R7.12: the longest prefix of the pasted text that keeps
 * the Draft within 500 code units and does not end between the two halves of a
 * surrogate pair of the pasted text. Found by searching down from the whole paste.
 */
function expectedInsertion(before: string, after: string, pasted: string): string {
  for (let k = pasted.length; k >= 0; k--) {
    const fits = before.length + k + after.length <= PASTE_LIMIT;
    if (fits && !cutSplitsPair(pasted, k)) {
      return pasted.slice(0, k);
    }
  }
  return '';
}

/** Checks one paste against R7.12; `before`/`after` are the unselected parts of the Draft. */
function checkPaste({ draft, selStart, selEnd, pasted }: PasteCase): void {
  const [start, end] = visibleSelection(draft.length, selStart, selEnd);
  const before = draft.slice(0, start);
  const after = draft.slice(end);

  const result = clampPaste(draft, selStart, selEnd, pasted);

  // The Draft never grows past the limit.
  expect(result.draft.length).toBeLessThanOrEqual(PASTE_LIMIT);

  // Only the selection is replaced; the text around it is unchanged.
  expect(result.draft.length).toBeGreaterThanOrEqual(before.length + after.length);
  expect(result.draft.startsWith(before)).toBe(true);
  expect(result.draft.endsWith(after)).toBe(true);
  const inserted = result.draft.slice(before.length, result.draft.length - after.length);

  // The inserted text is the leading part of the pasted text; the rest is discarded.
  expect(pasted.startsWith(inserted)).toBe(true);

  // No surrogate pair of the pasted text is split at the cut.
  expect(cutSplitsPair(pasted, inserted.length)).toBe(false);

  const space = PASTE_LIMIT - before.length - after.length;
  if (pasted.length <= space) {
    // The whole paste fits: nothing is cut.
    expect(inserted).toBe(pasted);
  } else if (cutSplitsPair(pasted, space)) {
    // One code unit fewer than the space, exactly when the cut would split a pair.
    expect(inserted.length).toBe(space - 1);
    expect(result.draft.length).toBe(PASTE_LIMIT - 1);
  } else {
    // Brings the Draft to exactly the limit.
    expect(inserted.length).toBe(space);
    expect(result.draft.length).toBe(PASTE_LIMIT);
  }

  expect(inserted).toBe(expectedInsertion(before, after, pasted));

  // The caret ends right after the inserted text.
  expect(result.caret).toBe(start + inserted.length);
}

// Feature: session-chat, Property 27: Paste never overfills the draft
/**
 * Property 27: Paste never overfills the draft
 *
 * The model is written from R7.12: a paste replaces the selection with the
 * leading part of the pasted text that brings the Draft to exactly 500 UTF-16
 * code units, or 1 code unit fewer when the cut would split a surrogate pair,
 * and discards the rest; a paste that fits is inserted whole. The caret ends
 * after the inserted text. Selection bounds outside the Draft are clamped to it
 * and reversed bounds are put in order, as a text area reports them.
 *
 * **Validates: Requirements 7.12**
 */
describe('Property 27: Paste never overfills the draft', () => {
  it('uses CHAT_MESSAGE_MAX_LENGTH = 500 as the Draft limit', () => {
    expect(CHAT_MESSAGE_MAX_LENGTH).toBe(PASTE_LIMIT);
  });

  it('any Draft of at most 500 code units, selection and pasted text (R7.12)', () => {
    fc.assert(fc.property(pasteCaseArb, checkPaste), { numRuns: NUM_RUNS });
  });

  it('a surrogate pair straddling the cut is dropped whole (R7.12)', () => {
    const splitCaseArb: fc.Arbitrary<PasteCase> = pasteDraftLengthArb
      .chain((length) =>
        fc.tuple(textOfLength(length), selectionBoundArb(length), selectionBoundArb(length)),
      )
      .map(([draft, selStart, selEnd]) => {
        const [start, end] = visibleSelection(draft.length, selStart, selEnd);
        // A full Draft with no selection leaves no space; select it all instead.
        return PASTE_LIMIT - (draft.length - (end - start)) >= 1
          ? { draft, selStart, selEnd }
          : { draft, selStart: 0, selEnd: draft.length };
      })
      .chain(({ draft, selStart, selEnd }) => {
        const [start, end] = visibleSelection(draft.length, selStart, selEnd);
        const space = PASTE_LIMIT - (draft.length - (end - start));
        return fc
          .tuple(
            fc.constantFrom('😀', '👍', '\u{10400}', '\u{20000}'),
            textOfLength(space - 1),
            fc.integer({ min: 0, max: 20 }).chain(textOfLength),
          )
          .map(([astral, head, tail]) => ({
            draft,
            selStart,
            selEnd,
            // The astral character starts at the last free code unit.
            pasted: head + astral + tail,
          }));
      });

    fc.assert(
      fc.property(splitCaseArb, (c) => {
        checkPaste(c);
        const [start, end] = visibleSelection(c.draft.length, c.selStart, c.selEnd);
        const space = PASTE_LIMIT - (c.draft.length - (end - start));
        const result = clampPaste(c.draft, c.selStart, c.selEnd, c.pasted);
        // The astral character's high half sits at the last free unit, so the cut always splits it.
        expect(cutSplitsPair(c.pasted, space)).toBe(true);
        expect(result.draft.length).toBe(PASTE_LIMIT - 1);
        expect(result.caret).toBe(start + space - 1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('examples: full Draft, exact fit, split pair, lone surrogates, reversed and out-of-range bounds', () => {
    const full = 'x'.repeat(500);
    expect(clampPaste(full, 500, 500, 'abc')).toEqual({ draft: full, caret: 500 });
    expect(clampPaste('x'.repeat(497), 497, 497, 'abc')).toEqual({ draft: 'x'.repeat(497) + 'abc', caret: 500 });
    expect(clampPaste('x'.repeat(497), 497, 497, 'abcd')).toEqual({ draft: 'x'.repeat(497) + 'abc', caret: 500 });
    // '😀' is two code units; one free unit cannot hold it.
    expect(clampPaste('x'.repeat(499), 499, 499, '😀')).toEqual({ draft: 'x'.repeat(499), caret: 499 });
    expect(clampPaste('x'.repeat(498), 498, 498, 'a😀')).toEqual({ draft: 'x'.repeat(498) + 'a', caret: 499 });
    // A lone high surrogate at the cut is not part of a pair and is kept.
    expect(clampPaste('x'.repeat(499), 499, 499, '\ud800a')).toEqual({ draft: 'x'.repeat(499) + '\ud800', caret: 500 });
    // Reversed bounds replace the same selection; out-of-range bounds are clamped.
    expect(clampPaste('hello world', 11, 6, 'there')).toEqual({ draft: 'hello there', caret: 11 });
    expect(clampPaste('abc', -5, 99, 'Z')).toEqual({ draft: 'Z', caret: 1 });
    // Replacing a selection frees its space.
    expect(clampPaste(full, 0, 500, full + 'y')).toEqual({ draft: full, caret: 500 });
  });

  it('Draft already over 500 outside the selection: nothing is inserted (R7.12 is silent here)', () => {
    // R7.12 cannot be met ("exactly 500" is out of reach); the implementation inserts nothing
    // and leaves the rest of the Draft unchanged.
    const overfullCaseArb = fc
      .integer({ min: PASTE_LIMIT + 1, max: PASTE_LIMIT + 100 })
      .chain((length) =>
        fc.tuple(textOfLength(length), fc.integer({ min: 0, max: 100 }).chain(textOfLength)),
      )
      .chain(([draft, pasted]) => {
        const excess = draft.length - PASTE_LIMIT;
        return fc
          .integer({ min: 0, max: draft.length })
          .chain((start) =>
            fc
              .integer({ min: start, max: Math.min(draft.length, start + excess) })
              .map((end) => ({ draft, selStart: start, selEnd: end, pasted })),
          );
      });

    fc.assert(
      fc.property(overfullCaseArb, ({ draft, selStart, selEnd, pasted }) => {
        const result = clampPaste(draft, selStart, selEnd, pasted);
        expect(result.draft).toBe(draft.slice(0, selStart) + draft.slice(selEnd));
        expect(result.caret).toBe(selStart);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
