import * as fc from 'fast-check';
import { isChatMessage } from '../types';
import type { ChatHistoryPayload, ChatMessage } from '../types';

/**
 * Shared property-test file for the ChatMessage contract (Properties 1-2).
 * Generators live at module scope so later properties append their own `describe`
 * blocks without redefining them.
 */

// ---------------------------------------------------------------------------
// Module-scope generators
// ---------------------------------------------------------------------------

const CHAT_MESSAGE_FIELDS = [
  'id',
  'seq',
  'clientMessageId',
  'authorId',
  'authorName',
  'text',
  'sentAt',
] as const;

type ChatMessageField = (typeof CHAT_MESSAGE_FIELDS)[number];

/** `sentAt` in `YYYY-MM-DDTHH:mm:ss.sssZ`; the year range keeps the 4-digit form. */
const sentAtArb: fc.Arbitrary<string> = fc
  .date({ min: new Date('2000-01-01'), max: new Date('2099-12-31'), noInvalidDate: true })
  .map((d) => d.toISOString());

/** A well-formed ChatMessage with no extra fields. */
const chatMessageArb: fc.Arbitrary<ChatMessage> = fc.record({
  id: fc.uuid(),
  seq: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  clientMessageId: fc.uuid(),
  authorId: fc.string({ minLength: 1 }),
  authorName: fc.string(),
  text: fc.string({ unit: 'binary' }),
  sentAt: sentAtArb,
});

/** Own properties whose names are not ChatMessage fields. */
const extraFieldsArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.string().filter((k) => !(CHAT_MESSAGE_FIELDS as readonly string[]).includes(k)),
  fc.anything(),
  { maxKeys: 5 },
);

/** Values that are not strings; used to break every string-typed field. */
const nonStringArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.string(), { maxLength: 3 }),
  fc.object({ maxDepth: 1 }),
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Values outside the canonical-UUID constraint. */
const nonUuidArb: fc.Arbitrary<unknown> = fc.oneof(
  nonStringArb,
  fc.string().filter((s) => !UUID_RE.test(s)),
  // Near misses derived from a real UUID.
  fc.uuid().map((u) => u.replace(/-/g, '')),
  fc.uuid().map((u) => `{${u}}`),
  fc.uuid().map((u) => ` ${u}`),
  fc.uuid().map((u) => u.slice(0, -1)),
  fc.uuid().map((u) => `${u}0`),
  fc.uuid().map((u) => `g${u.slice(1)}`),
);

/** Values outside `seq`: safe integer >= 1. */
const badSeqArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(0),
  fc.constant(-0),
  fc.integer({ min: Number.MIN_SAFE_INTEGER, max: -1 }),
  fc
    .double({ min: -1e9, max: 1e9, noNaN: true, noDefaultInfinity: true })
    .filter((n) => !Number.isInteger(n)),
  fc.constantFrom(
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER * 4,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NaN,
  ),
  fc.integer({ min: 1, max: 1000 }).map(String),
  fc.integer({ min: 1, max: 1000 }).map((n) => BigInt(n)),
  fc.constant(null),
  fc.constant(undefined),
);

const badAuthorIdArb: fc.Arbitrary<unknown> = fc.oneof(fc.constant(''), nonStringArb);

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** `sentAt` values in another format, or in the right format but naming an impossible date. */
const badSentAtArb: fc.Arbitrary<unknown> = fc.oneof(
  nonStringArb,
  // Other formats of a real instant.
  fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31'), noInvalidDate: true }).chain((d) =>
    fc.constantFrom<unknown>(
      d,
      d.getTime(),
      String(d.getTime()),
      d.toString(),
      d.toUTCString(),
      d.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      d.toISOString().replace('Z', '+00:00'),
      d.toISOString().replace('T', ' '),
      d.toISOString().slice(0, 10),
      d.toISOString().toLowerCase(),
      ` ${d.toISOString()}`,
    ),
  ),
  // Right shape, impossible calendar or clock values.
  fc
    .record({
      year: fc.integer({ min: 2000, max: 2099 }),
      month: fc.integer({ min: 1, max: 12 }),
      day: fc.integer({ min: 1, max: 28 }),
      hour: fc.integer({ min: 0, max: 23 }),
      minute: fc.integer({ min: 0, max: 59 }),
      second: fc.integer({ min: 0, max: 59 }),
      ms: fc.integer({ min: 0, max: 999 }),
      breakWhich: fc.constantFrom('month', 'day', 'feb', 'hour', 'minute', 'second'),
      badMonth: fc.oneof(fc.constant(0), fc.integer({ min: 13, max: 99 })),
      badDay: fc.oneof(fc.constant(0), fc.integer({ min: 32, max: 99 })),
      badFebDay: fc.integer({ min: 30, max: 31 }),
      badHour: fc.integer({ min: 25, max: 99 }),
      badMinSec: fc.integer({ min: 60, max: 99 }),
    })
    .map((p) => {
      let { month, day, hour, minute, second } = p;
      switch (p.breakWhich) {
        case 'month': month = p.badMonth; break;
        case 'day': day = p.badDay; break;
        case 'feb': month = 2; day = p.badFebDay; break;
        case 'hour': hour = p.badHour; break;
        case 'minute': minute = p.badMinSec; break;
        case 'second': second = p.badMinSec; break;
      }
      return (
        `${pad(p.year, 4)}-${pad(month, 2)}-${pad(day, 2)}` +
        `T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(p.ms, 3)}Z`
      );
    }),
);

/** For each field, the values that violate its R13.1 constraint. */
const BAD_VALUE_BY_FIELD: Readonly<Record<ChatMessageField, fc.Arbitrary<unknown>>> = {
  id: nonUuidArb,
  seq: badSeqArb,
  clientMessageId: nonUuidArb,
  authorId: badAuthorIdArb,
  authorName: nonStringArb,
  text: nonStringArb,
  sentAt: badSentAtArb,
};

/** A valid message with exactly one field changed to an out-of-constraint value, or removed. */
const singleFieldMutationArb: fc.Arbitrary<{ field: ChatMessageField; value: Record<string, unknown> }> = fc
  .tuple(chatMessageArb, extraFieldsArb, fc.constantFrom(...CHAT_MESSAGE_FIELDS), fc.boolean())
  .chain(([message, extras, field, remove]) =>
    BAD_VALUE_BY_FIELD[field].map((bad) => {
      const value: Record<string, unknown> = { ...extras, ...message };
      if (remove) delete value[field];
      else value[field] = bad;
      return { field, value };
    }),
  );

/** Values that are not non-null, non-array objects. */
const nonObjectArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.string(),
  fc.bigInt(),
  fc.array(fc.anything(), { maxLength: 3 }),
  // An array that carries every valid field is still not a message.
  chatMessageArb.map((m) => Object.assign([] as unknown[], m)),
);

// ---------------------------------------------------------------------------
// Property 1
// ---------------------------------------------------------------------------

describe('isChatMessage', () => {
  // Feature: session-chat, Property 1: isChatMessage accepts exactly well-formed messages
  // **Validates: Requirements 13.7, 5.14**
  it('accepts exactly well-formed messages, ignoring extra fields', () => {
    const caseArb = fc.oneof(
      // Valid messages, with or without extra fields, are accepted.
      fc
        .tuple(chatMessageArb, extraFieldsArb)
        .map(([message, extras]) => ({ value: { ...extras, ...message } as unknown, expected: true })),
      // One field outside its constraint (or missing) is rejected.
      singleFieldMutationArb.map(({ value }) => ({ value: value as unknown, expected: false })),
      // Non-objects, null and arrays are rejected.
      nonObjectArb.map((value) => ({ value, expected: false })),
    );

    fc.assert(
      fc.property(caseArb, ({ value, expected }) => {
        expect(isChatMessage(value)).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2
// ---------------------------------------------------------------------------

describe('Chat payload JSON round trip', () => {
  const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

  /** A plain array: `Array.isArray` and the `Array.prototype` prototype, so not a Map, Set or keyed object. */
  const expectPlainArray = (value: unknown): void => {
    expect(Array.isArray(value)).toBe(true);
    expect(Object.getPrototypeOf(value)).toBe(Array.prototype);
  };

  // Feature: session-chat, Property 2: Chat payload JSON round trip
  // **Validates: Requirements 13.8, 13.9**
  it('round-trips a single ChatMessage to a deeply equal, accepted message', () => {
    fc.assert(
      fc.property(chatMessageArb, (message) => {
        expect(isChatMessage(message)).toBe(true);

        const parsed = roundTrip(message);

        expect(parsed).toStrictEqual(message);
        expect(isChatMessage(parsed)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: session-chat, Property 2: Chat payload JSON round trip
  // **Validates: Requirements 13.8, 13.9**
  it('round-trips a ChatHistoryPayload with messages kept as a plain array of accepted messages', () => {
    const historyArb: fc.Arbitrary<ChatHistoryPayload> = fc
      .array(chatMessageArb, { maxLength: 20 })
      .map((messages) => ({ messages }));

    fc.assert(
      fc.property(historyArb, (payload) => {
        const parsed = roundTrip(payload) as ChatHistoryPayload;

        expect(parsed).toStrictEqual(payload);
        expectPlainArray(parsed.messages);
        expect(parsed.messages).toHaveLength(payload.messages.length);
        for (const message of parsed.messages) {
          expect(isChatMessage(message)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
