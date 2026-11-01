import { EventEmitter } from 'events';
import { IncomingMessage } from 'http';
import { format } from 'util';
import WebSocket from 'ws';
import * as fc from 'fast-check';
import {
  BoardKind,
  CHAT_HISTORY,
  CHAT_MESSAGE_ADDED,
  CHAT_MESSAGE_REJECTED,
  CHAT_MESSAGE_SEND,
  RETRO_CHAT_HISTORY,
  RETRO_CHAT_MESSAGE_ADDED,
  RETRO_CHAT_MESSAGE_REJECTED,
  RETRO_CHAT_MESSAGE_SEND,
  CHAT_HISTORY_LIMIT,
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_RATE_LIMIT_COUNT,
  CHAT_RATE_LIMIT_WINDOW_MS,
  CHAT_RAW_TEXT_MAX_LENGTH,
  ChatMessage,
  ChatMessageRejectedPayload,
  ChatRejection,
  DEFAULT_SESSION_CONFIG,
  PermissionMode,
  RetroConfiguration,
  SessionConfiguration,
  User,
} from '../../../../shared/types';
import { validateChatText } from '../../../../shared/chat-text';
import { ChatRoom, ChatRoomOptions } from '../../services/chat-room';
import { GameSession } from '../../services/game-session';
import { RetroSession } from '../../services/retro-session';
import { CHAT_REJECTION_MESSAGES, ChatSendContext, ChatSendOutcome, evaluateChatSend } from '../chat-send';
import { handleWebSocket, _reset as resetPokerHandler } from '../handler';
import { handleRetroWebSocket, _resetRetroHandler } from '../retro-handler';
import { login, _resetStore as resetAuthStore } from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';
import { retroSessionRegistry } from '../../services/retro-session-registry';

/**
 * Property tests for the chat send decision (server/src/websocket/chat-send.ts).
 *
 * Generators and helpers live at module scope so later properties can append
 * their own `describe` blocks to this file without redefining them.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fixed epoch-ms reading used by rooms built without an explicit clock. */
const FIXED_NOW_MS = Date.UTC(2026, 4, 1, 12, 0, 0);

/** Deterministic canonical-UUID factory: `00000000-0000-4000-8000-000000000001`, `…02`, … */
function sequentialIdFactory(): () => string {
  let n = 0;
  return () => {
    n++;
    return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  };
}

/** A fresh ChatRoom with an injected clock and id factory (no dedup or rate-limit history). */
function createRoom(options: ChatRoomOptions = {}): ChatRoom {
  return new ChatRoom({
    clock: options.clock ?? (() => FIXED_NOW_MS),
    idFactory: options.idFactory ?? sequentialIdFactory(),
    onAccepted: options.onAccepted,
  });
}

const DEFAULT_AUTHOR = { id: 'user-1', displayName: 'Alice' };

function createContext(
  connectionSessionId: string,
  room: ChatRoom = createRoom(),
  author: { id: string; displayName: string } = DEFAULT_AUTHOR,
): ChatSendContext {
  return { connectionSessionId, author, room };
}

interface PayloadParts {
  sessionId: unknown;
  clientMessageId: unknown;
  text: unknown;
  /** When true, the `text` key is left out of the payload entirely. */
  omitText?: boolean;
}

/** Builds a chat send payload as a client would put it on the wire. */
function buildPayload({ sessionId, clientMessageId, text, omitText }: PayloadParts): Record<string, unknown> {
  const payload: Record<string, unknown> = { sessionId, clientMessageId };
  if (!omitText) payload['text'] = text;
  return payload;
}

/** Narrows an outcome to `accepted` or fails the test with the actual outcome. */
function expectAccepted(outcome: ChatSendOutcome): Extract<ChatSendOutcome, { kind: 'accepted' }> {
  if (outcome.kind !== 'accepted') {
    throw new Error(`expected accepted, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Non-empty session id strings. */
const sessionIdArb: fc.Arbitrary<string> = fc.oneof(
  fc.uuid(),
  fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/),
);

/** Canonical 8-4-4-4-12 hex UUIDs in lower, upper or mixed case (R14.9). */
const canonicalUuidArb: fc.Arbitrary<string> = fc
  .tuple(fc.uuid(), fc.constantFrom('lower', 'upper', 'mixed'))
  .map(([uuid, casing]) => {
    if (casing === 'upper') return uuid.toUpperCase();
    if (casing === 'mixed') {
      return [...uuid].map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch)).join('');
    }
    return uuid;
  });

/** Unicode general category Zs. */
const ZS_CHARS = [
  0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000,
].map((cu) => String.fromCharCode(cu));
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
  fc
    .integer({ min: 0x0000, max: 0x001f })
    .filter((cu) => cu !== 0x09 && cu !== 0x0a && cu !== 0x0d)
    .map((cu) => String.fromCharCode(cu)),
);

/** Line-break forms that normalisation step 1 rewrites. */
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
      fc.integer({ min: CHAT_MESSAGE_MAX_LENGTH - 6, max: CHAT_MESSAGE_MAX_LENGTH + 6 }),
      fc.integer({ min: CHAT_RAW_TEXT_MAX_LENGTH - 30, max: CHAT_RAW_TEXT_MAX_LENGTH + 6 }),
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
    fc.integer({ min: CHAT_MESSAGE_MAX_LENGTH - 2, max: CHAT_MESSAGE_MAX_LENGTH + 2 }),
    fc.integer({ min: CHAT_RAW_TEXT_MAX_LENGTH - 2, max: CHAT_RAW_TEXT_MAX_LENGTH + 2 }),
  )
  .map((len) => 'x'.repeat(len));

/** Values that are not strings (R14.2). */
const nonStringArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.array(fc.string()),
  fc.dictionary(fc.string(), fc.string()),
  fc.anything().filter((v) => typeof v !== 'string'),
);

/** Any string a client may submit as chat text. */
const chatTextStringArb: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: mixedStringArb, weight: 4 },
  { arbitrary: blankStringArb, weight: 2 },
  { arbitrary: nearLimitStringArb, weight: 3 },
  { arbitrary: exactLengthStringArb, weight: 1 },
  { arbitrary: fc.string({ unit: 'binary', maxLength: 2100 }), weight: 1 },
);

/** Any value that may arrive in the `text` field of a chat send payload. */
const chatTextInputArb: fc.Arbitrary<unknown> = fc.oneof(
  { arbitrary: nonStringArb, weight: 1 },
  { arbitrary: chatTextStringArb, weight: 10 },
);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

// Feature: session-chat, Property 5: Client and server reach the same text verdict
describe('Property 5: Client and server reach the same text verdict', () => {
  /** **Validates: Requirements 14.14** */
  it('the server outcome matches the client validator verdict for any text value', () => {
    fc.assert(
      fc.property(
        sessionIdArb,
        canonicalUuidArb,
        chatTextInputArb,
        fc.boolean(),
        (sessionId, clientMessageId, text, omitText) => {
          // Leaving the key out is only meaningful for an undefined text value.
          const omit = omitText && text === undefined;
          const clientVerdict = validateChatText(omit ? undefined : text);
          // The composer's sendable decision while connected (R7.6).
          const connected = true;
          const sendable = connected && clientVerdict.ok;

          const outcome = evaluateChatSend(
            buildPayload({ sessionId, clientMessageId, text, omitText: omit }),
            createContext(sessionId),
          );

          expect(outcome.kind === 'accepted').toBe(sendable);
          if (clientVerdict.ok) {
            const accepted = expectAccepted(outcome);
            expect(accepted.message.text).toBe(clientVerdict.text);
          } else {
            expect(outcome.kind).toBe('rejected');
            if (outcome.kind === 'rejected') {
              expect(outcome.payload.code).toBe(clientVerdict.code);
              expect(outcome.payload.clientMessageId).toBe(clientMessageId);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  /** **Validates: Requirements 14.14** */
  it('the Normalised_Text the ChatStore sends is accepted with identical text', () => {
    fc.assert(
      fc.property(sessionIdArb, canonicalUuidArb, chatTextStringArb, (sessionId, clientMessageId, draft) => {
        const clientVerdict = validateChatText(draft);
        fc.pre(clientVerdict.ok);
        if (!clientVerdict.ok) return;

        const room = createRoom();
        const outcome = evaluateChatSend(
          buildPayload({ sessionId, clientMessageId, text: clientVerdict.text }),
          createContext(sessionId, room),
        );

        const accepted = expectAccepted(outcome);
        expect(accepted.message.text).toBe(clientVerdict.text);

        // The stored text after commit is the same Normalised_Text.
        accepted.commit();
        expect(room.history().map((m) => m.text)).toEqual([clientVerdict.text]);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 8 helpers and generators
// ---------------------------------------------------------------------------

/** The payload keys `evaluateChatSend` is allowed to read; spoofed fields never reuse them. */
const REAL_PAYLOAD_KEYS = new Set(['sessionId', 'clientMessageId', 'text']);

/** Author-ish and message-ish keys a malicious client might add, plus prototype-ish keys. */
const SPOOF_KEYS = [
  'authorId',
  'authorName',
  'author',
  'userId',
  'displayName',
  'id',
  'seq',
  'sentAt',
  'role',
  'user',
  'participant',
  '__proto__',
  'constructor',
  'prototype',
] as const;

const spoofKeyArb: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: fc.constantFrom(...SPOOF_KEYS), weight: 5 },
  { arbitrary: fc.string({ minLength: 1, maxLength: 12 }).filter((k) => !REAL_PAYLOAD_KEYS.has(k)), weight: 1 },
);

/** Non-empty author ids and display names, including arbitrary unicode. */
const authorTextArb: fc.Arbitrary<string> = fc.oneof(
  fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/),
  fc.uuid(),
  fc.string({ unit: 'grapheme', minLength: 1, maxLength: 20 }),
  fc.string({ unit: 'binary', minLength: 1, maxLength: 20 }),
);

/** The Authenticated_Identity of a sending Board_Connection. */
const connectionAuthorArb: fc.Arbitrary<{ id: string; displayName: string }> = fc.record({
  id: authorTextArb,
  displayName: authorTextArb,
});

/** A nested object shaped like an author or a message, to tempt a merge. */
const authorShapedJsonArb: fc.Arbitrary<Record<string, string | number>> = fc.record({
  id: fc.string(),
  displayName: fc.string(),
  authorId: fc.string(),
  authorName: fc.string(),
  seq: fc.integer(),
  sentAt: fc.string(),
});

/** Spoofed field values that survive the JSON wire format. */
const spoofJsonValueArb: fc.Arbitrary<unknown> = fc.oneof(
  { arbitrary: fc.jsonValue(), weight: 3 },
  { arbitrary: authorTextArb, weight: 2 },
  { arbitrary: authorShapedJsonArb, weight: 2 },
);

/** Spoofed field values that only an in-process caller could pass (any JS value). */
const spoofAnyValueArb: fc.Arbitrary<unknown> = fc.oneof(
  { arbitrary: fc.anything(), weight: 3 },
  { arbitrary: spoofJsonValueArb, weight: 2 },
);

type SpoofEntries = [string, unknown][];

function spoofEntriesArb(valueArb: fc.Arbitrary<unknown>): fc.Arbitrary<SpoofEntries> {
  return fc.uniqueArray(fc.tuple(spoofKeyArb, valueArb), {
    selector: ([key]) => key,
    minLength: 1,
    maxLength: 8,
  });
}

/**
 * Payload as `JSON.parse` would produce it from the wire, so `__proto__`,
 * `constructor` and `prototype` arrive as own properties. Spoofed keys come
 * first, the real keys last.
 */
function wirePayloadWithSpoof(parts: PayloadParts, spoof: SpoofEntries): unknown {
  const entries: [string, unknown][] = [
    ...spoof,
    ['sessionId', parts.sessionId],
    ['clientMessageId', parts.clientMessageId],
    ['text', parts.text],
  ];
  const json = `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',')}}`;
  return JSON.parse(json);
}

/** In-process payload with spoofed own properties holding any JS value. */
function memoryPayloadWithSpoof(parts: PayloadParts, spoof: SpoofEntries): Record<string, unknown> {
  const payload = buildPayload(parts);
  for (const [key, value] of spoof) {
    // defineProperty keeps `__proto__` an own data property instead of changing the prototype.
    Object.defineProperty(payload, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return payload;
}

/** Text the Chat_Validator accepts, so every send reaches the room. */
const acceptedTextArb: fc.Arbitrary<string> = chatTextStringArb.filter((t) => validateChatText(t).ok);

/** Clock readings that `Date#toISOString` can format. */
const nowMsArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: Date.UTC(2100, 0, 1) });

interface SpoofedSend {
  author: { id: string; displayName: string };
  clientMessageId: string;
  text: string;
  wire: boolean;
  spoof: SpoofEntries;
}

/**
 * 1–5 sends with distinct Client_Message_Ids (so none is a replay) and at
 * most CHAT_RATE_LIMIT_COUNT in total (so none is rate limited).
 */
const spoofedSendsArb: fc.Arbitrary<SpoofedSend[]> = fc.uniqueArray(
  fc
    .record({
      author: connectionAuthorArb,
      clientMessageId: canonicalUuidArb,
      text: acceptedTextArb,
      wire: fc.boolean(),
      jsonSpoof: spoofEntriesArb(spoofJsonValueArb),
      anySpoof: spoofEntriesArb(spoofAnyValueArb),
    })
    .map(({ jsonSpoof, anySpoof, wire, ...rest }) => ({ ...rest, wire, spoof: wire ? jsonSpoof : anySpoof })),
  { selector: (s) => s.clientMessageId.toLowerCase(), minLength: 1, maxLength: 5 },
);

function spoofedPayload(sessionId: string, send: SpoofedSend): unknown {
  const parts: PayloadParts = { sessionId, clientMessageId: send.clientMessageId, text: send.text };
  return send.wire ? wirePayloadWithSpoof(parts, send.spoof) : memoryPayloadWithSpoof(parts, send.spoof);
}

// Feature: session-chat, Property 8: Authorship comes only from the connection
describe('Property 8: Authorship comes only from the connection', () => {
  /** **Validates: Requirements 15.1** */
  it('author, id, seq and sentAt come from the connection and the room, never the payload', () => {
    fc.assert(
      fc.property(sessionIdArb, nowMsArb, spoofedSendsArb, (sessionId, nowMs, sends) => {
        const room = createRoom({ clock: () => nowMs });
        const expectedId = sequentialIdFactory();
        const expectedSentAt = new Date(nowMs).toISOString();

        sends.forEach((send, i) => {
          const outcome = evaluateChatSend(spoofedPayload(sessionId, send), createContext(sessionId, room, send.author));
          const { message, commit } = expectAccepted(outcome);

          expect(message.authorId).toBe(send.author.id);
          expect(message.authorName).toBe(send.author.displayName);
          expect(message.id).toBe(expectedId());
          expect(message.seq).toBe(i + 1);
          expect(message.sentAt).toBe(expectedSentAt);
          expect(message.clientMessageId).toBe(send.clientMessageId);

          commit();
        });

        // The stored messages carry the same connection authors.
        const history = room.history();
        expect(history.map((m) => ({ authorId: m.authorId, authorName: m.authorName, seq: m.seq }))).toEqual(
          sends.map((s, i) => ({ authorId: s.author.id, authorName: s.author.displayName, seq: i + 1 })),
        );
      }),
      { numRuns: 200 },
    );
  });

  /** **Validates: Requirements 15.1** */
  it('spoofed fields change nothing: outcome and history equal those of the clean payload', () => {
    fc.assert(
      fc.property(sessionIdArb, nowMsArb, spoofedSendsArb, (sessionId, nowMs, sends) => {
        // Two fresh rooms with identical clocks and id factories.
        const cleanRoom = createRoom({ clock: () => nowMs, idFactory: sequentialIdFactory() });
        const spoofedRoom = createRoom({ clock: () => nowMs, idFactory: sequentialIdFactory() });

        for (const send of sends) {
          const clean = expectAccepted(
            evaluateChatSend(
              buildPayload({ sessionId, clientMessageId: send.clientMessageId, text: send.text }),
              createContext(sessionId, cleanRoom, send.author),
            ),
          );
          const spoofed = expectAccepted(
            evaluateChatSend(spoofedPayload(sessionId, send), createContext(sessionId, spoofedRoom, send.author)),
          );

          expect(spoofed.message).toEqual(clean.message);

          clean.commit();
          spoofed.commit();
        }

        expect(spoofedRoom.history()).toEqual(cleanRoom.history());
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 7 helpers and generators
// ---------------------------------------------------------------------------

/** The oracle's own copy of the R14.9 form: 8-4-4-4-12 hex, any version, any case. */
const ORACLE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every fixed rejection text (R14.15). */
const FIXED_REJECTION_TEXTS: readonly string[] = Object.values(CHAT_REJECTION_MESSAGES);

/** Canonical id the probe send uses when the original payload had no canonical id. */
const PROBE_ID = '99999999-9999-4999-8999-999999999999';

/** Mutable fake clock injected as the session's `chatClock`; no real timers. */
interface FakeClock {
  now: number;
  read: () => number;
}

function makeClock(start: number): FakeClock {
  const clock: FakeClock = { now: start, read: () => clock.now };
  return clock;
}

/** Deterministic canonical id `<prefix>-0000-4000-8000-<n>` for prior sends. */
function priorId(prefix: string, n: number): string {
  return `${prefix}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

type Casing = 'lower' | 'upper' | 'mixed';

function applyCasing(id: string, casing: Casing): string {
  if (casing === 'upper') return id.toUpperCase();
  if (casing === 'mixed') return [...id].map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch)).join('');
  return id.toLowerCase();
}

type PokerRoundState = 'none' | 'voting' | 'voted' | 'revealed';

/** Session state that must not matter for chat (R1.12, R15.8, R18.9). */
type BoardSetup =
  | {
      kind: 'poker';
      role: User['role'];
      revealMode: PermissionMode;
      issueMode: PermissionMode;
      senderAllowed: boolean;
      autoReveal: boolean;
      round: PokerRoundState;
    }
  | {
      kind: 'retro';
      role: User['role'];
      hideCardsInitially: boolean;
      disableVotingInitially: boolean;
      cardsRevealed: boolean;
      enableVoting: boolean;
      completed: boolean;
    };

const roleArb: fc.Arbitrary<User['role']> = fc.constantFrom('moderator', 'participant');
const permissionModeArb: fc.Arbitrary<PermissionMode> = fc.constantFrom(
  'moderator-only',
  'all-players',
  'select-specific',
);

const boardSetupArb: fc.Arbitrary<BoardSetup> = fc.oneof(
  fc.record({
    kind: fc.constant('poker' as const),
    role: roleArb,
    revealMode: permissionModeArb,
    issueMode: permissionModeArb,
    senderAllowed: fc.boolean(),
    autoReveal: fc.boolean(),
    round: fc.constantFrom<PokerRoundState>('none', 'voting', 'voted', 'revealed'),
  }),
  fc.record({
    kind: fc.constant('retro' as const),
    role: roleArb,
    hideCardsInitially: fc.boolean(),
    disableVotingInitially: fc.boolean(),
    cardsRevealed: fc.boolean(),
    enableVoting: fc.boolean(),
    completed: fc.boolean(),
  }),
);

/**
 * Prior room state: `others` accepts by distinct other authors, then `self`
 * accepts by the sender (all at `startMs`), then — when `evict` — a full
 * buffer of filler messages so the sender's messages leave the Chat_Buffer
 * while their Dedup_Record entries stay. The send happens at `startMs + advanceMs`.
 */
interface PriorState {
  others: number;
  self: number;
  evict: boolean;
  startMs: number;
  advanceMs: number;
}

const priorStateArb: fc.Arbitrary<PriorState> = fc.record({
  others: fc.integer({ min: 0, max: 4 }),
  self: fc.oneof(fc.constant(CHAT_RATE_LIMIT_COUNT), fc.integer({ min: 0, max: CHAT_RATE_LIMIT_COUNT - 1 })),
  evict: fc.oneof({ arbitrary: fc.constant(false), weight: 7 }, { arbitrary: fc.constant(true), weight: 3 }),
  startMs: fc.integer({ min: 0, max: Date.UTC(2100, 0, 1) }),
  advanceMs: fc.oneof(
    fc.integer({ min: 0, max: CHAT_RATE_LIMIT_WINDOW_MS - 1 }),
    fc.integer({ min: CHAT_RATE_LIMIT_WINDOW_MS, max: CHAT_RATE_LIMIT_WINDOW_MS * 10 }),
  ),
});

type ShapeChoice = { kind: 'object' } | { kind: 'array' } | { kind: 'primitive'; value: unknown };

const shapeChoiceArb: fc.Arbitrary<ShapeChoice> = fc.oneof(
  { arbitrary: fc.constant<ShapeChoice>({ kind: 'object' }), weight: 12 },
  { arbitrary: fc.constant<ShapeChoice>({ kind: 'array' }), weight: 2 },
  {
    arbitrary: fc
      .oneof(fc.constant(null), fc.constant(undefined), fc.string(), fc.integer(), fc.double(), fc.boolean())
      .map((value): ShapeChoice => ({ kind: 'primitive', value })),
    weight: 3,
  },
);

type SessionIdChoice =
  | { kind: 'match' }
  | { kind: 'otherString'; value: string }
  | { kind: 'variant'; how: 'upper' | 'lower' | 'space' | 'prefix' }
  | { kind: 'nonString'; value: unknown }
  | { kind: 'omitted' };

const sessionIdChoiceArb: fc.Arbitrary<SessionIdChoice> = fc.oneof(
  { arbitrary: fc.constant<SessionIdChoice>({ kind: 'match' }), weight: 14 },
  { arbitrary: sessionIdArb.map((value): SessionIdChoice => ({ kind: 'otherString', value })), weight: 2 },
  {
    arbitrary: fc
      .constantFrom<'upper' | 'lower' | 'space' | 'prefix'>('upper', 'lower', 'space', 'prefix')
      .map((how): SessionIdChoice => ({ kind: 'variant', how })),
    weight: 2,
  },
  { arbitrary: nonStringArb.map((value): SessionIdChoice => ({ kind: 'nonString', value })), weight: 1 },
  { arbitrary: fc.constant<SessionIdChoice>({ kind: 'omitted' }), weight: 1 },
);

/** Strings that miss the canonical form (R14.9), including near misses. */
const nonCanonicalIdArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    '',
    'not-a-uuid',
    '00000000000040008000000000000001',
    '{00000000-0000-4000-8000-000000000001}',
    '00000000-0000-4000-8000-00000000000g',
    '00000000-0000-4000-8000-0000000000001',
    '0000000-00000-4000-8000-000000000001',
  ),
  fc.uuid().map((u) => `${u} `),
  fc.uuid().map((u) => ` ${u}`),
  fc.uuid().map((u) => `${u}\n`),
  fc.uuid().map((u) => u.replace(/-/g, '')),
  fc.uuid().map((u) => u.slice(1)),
  fc.string({ maxLength: 40 }),
);

type IdKind = 'fresh' | 'selfHeld' | 'otherHeld' | 'nonCanonical' | 'nonString';

interface IdChoice {
  kind: IdKind;
  fresh: string;
  index: number;
  casing: Casing;
  nonCanonical: string;
  nonString: unknown;
}

const idChoiceArb: fc.Arbitrary<IdChoice> = fc.record({
  kind: fc.oneof(
    { arbitrary: fc.constant<IdKind>('fresh'), weight: 4 },
    { arbitrary: fc.constant<IdKind>('selfHeld'), weight: 4 },
    { arbitrary: fc.constant<IdKind>('otherHeld'), weight: 1 },
    { arbitrary: fc.constant<IdKind>('nonCanonical'), weight: 2 },
    { arbitrary: fc.constant<IdKind>('nonString'), weight: 1 },
  ),
  fresh: canonicalUuidArb,
  index: fc.nat(),
  casing: fc.constantFrom<Casing>('lower', 'upper', 'mixed'),
  nonCanonical: nonCanonicalIdArb,
  nonString: nonStringArb,
});

/** Text weighted towards values that pass the Chat_Validator, so later checks are reached. */
const sendTextArb: fc.Arbitrary<unknown> = fc.oneof(
  { arbitrary: acceptedTextArb, weight: 3 },
  { arbitrary: chatTextInputArb, weight: 2 },
);

interface CheckOrderCase {
  setup: BoardSetup;
  prior: PriorState;
  sessionId: string;
  senderId: string;
  shape: ShapeChoice;
  sessionIdChoice: SessionIdChoice;
  idChoice: IdChoice;
  text: unknown;
  omitText: boolean;
}

const checkOrderCaseArb: fc.Arbitrary<CheckOrderCase> = fc.record({
  setup: boardSetupArb,
  prior: priorStateArb,
  sessionId: sessionIdArb,
  senderId: fc.uuid(),
  shape: shapeChoiceArb,
  sessionIdChoice: sessionIdChoiceArb,
  idChoice: idChoiceArb,
  text: sendTextArb,
  omitText: fc.boolean(),
});

/** What the oracle knows about the room before the send. */
interface RoomModel {
  /** Seq the next accepted message gets. */
  nextSeq: number;
  /** Lowest seq still in the Chat_Buffer. */
  lowestHeldSeq: number;
  /** Sender's accepted Client_Message_Ids (lower case) → seq. */
  selfSeqById: Map<string, number>;
  /** Sender's accepted ids in accept order, as sent. */
  selfIds: string[];
  /** Other authors' accepted ids. */
  otherIds: string[];
  /** Number of the sender's accepts, all at `selfAcceptAtMs`. */
  selfAcceptCount: number;
  selfAcceptAtMs: number;
}

type CheckStep = 'shape' | 'session' | 'clientMessageId' | 'text' | 'duplicate' | 'rateLimit' | 'replay' | 'accepted';

const ALL_CHECK_STEPS: readonly CheckStep[] = [
  'shape',
  'session',
  'clientMessageId',
  'text',
  'duplicate',
  'rateLimit',
  'replay',
  'accepted',
];

type Expected = { step: CheckStep } & (
  | { kind: 'rejected'; clientMessageId: string; code: ChatRejection; retryAfterMs?: number }
  | { kind: 'replay'; seq: number }
  | { kind: 'accepted'; seq: number; text: string }
);

/** Independent oracle: the first failing check of R14.11, or replay / accept when none fails. */
function firstFailingCheck(raw: unknown, connectionSessionId: string, model: RoomModel, nowMs: number): Expected {
  // (1) R14.10
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { step: 'shape', kind: 'rejected', clientMessageId: '', code: 'CHAT_INVALID' };
  }
  const payload = raw as Record<string, unknown>;
  const clientMessageId = payload['clientMessageId'];
  const echo = typeof clientMessageId === 'string' ? clientMessageId : '';
  // (2) R15.2: strict equality with a string implies the value is a string.
  if (payload['sessionId'] !== connectionSessionId) {
    return { step: 'session', kind: 'rejected', clientMessageId: echo, code: 'CHAT_SESSION_MISMATCH' };
  }
  // (3) R14.9
  if (typeof clientMessageId !== 'string' || !ORACLE_UUID_RE.test(clientMessageId)) {
    return { step: 'clientMessageId', kind: 'rejected', clientMessageId: echo, code: 'CHAT_INVALID' };
  }
  // (4) R14.2–R14.6
  const verdict = validateChatText(payload['text']);
  if (!verdict.ok) {
    return { step: 'text', kind: 'rejected', clientMessageId, code: verdict.code };
  }
  // (5) R16.5, R16.6: the sender's own record only (R16.11).
  const heldSeq = model.selfSeqById.get(clientMessageId.toLowerCase());
  if (heldSeq !== undefined) {
    if (heldSeq >= model.lowestHeldSeq) return { step: 'replay', kind: 'replay', seq: heldSeq };
    return { step: 'duplicate', kind: 'rejected', clientMessageId, code: 'CHAT_DUPLICATE' };
  }
  // (6) R17.2: every prior self accept is at selfAcceptAtMs.
  const elapsed = nowMs - model.selfAcceptAtMs;
  if (model.selfAcceptCount >= CHAT_RATE_LIMIT_COUNT && elapsed < CHAT_RATE_LIMIT_WINDOW_MS) {
    return {
      step: 'rateLimit',
      kind: 'rejected',
      clientMessageId,
      code: 'CHAT_RATE_LIMITED',
      retryAfterMs: CHAT_RATE_LIMIT_WINDOW_MS - elapsed,
    };
  }
  return { step: 'accepted', kind: 'accepted', seq: model.nextSeq, text: verdict.text };
}

function retroConfigFor(setup: Extract<BoardSetup, { kind: 'retro' }>): RetroConfiguration {
  return {
    boardName: 'Test Retro',
    maxVotesPerUser: 6,
    templateId: 'start-stop-continue',
    hideCardsInitially: setup.hideCardsInitially,
    disableVotingInitially: setup.disableVotingInitially,
    hideVoteCount: false,
    oneVotePerCard: false,
    showCardAuthor: false,
    password: null,
    enableGifEmoji: true,
    columnLayout: 'vertical',
    allowedFeelings: ['Happy', 'Sad', 'No_Feeling'],
  };
}

/** A real GameSession / RetroSession in the generated state, with the sender joined. */
function buildBoardSession(
  setup: BoardSetup,
  sessionId: string,
  sender: User,
  clock: FakeClock,
): GameSession | RetroSession {
  const ownerId = setup.role === 'moderator' ? sender.id : 'owner-1';
  if (setup.kind === 'poker') {
    const allowed = setup.senderAllowed ? [sender.id] : [];
    const config: SessionConfiguration = {
      ...DEFAULT_SESSION_CONFIG,
      revealPermission: { mode: setup.revealMode, allowedUserIds: allowed },
      issuePermission: { mode: setup.issueMode, allowedUserIds: allowed },
      autoReveal: setup.autoReveal,
    };
    const session = new GameSession(sessionId, ownerId, config, { chatClock: clock.read });
    session.addParticipant(sender);
    if (setup.round !== 'none') session.startRound('Story');
    if (setup.round === 'voted' || setup.round === 'revealed') session.selectCard(sender.id, 5);
    if (setup.round === 'revealed') session.revealCards();
    return session;
  }
  const session = new RetroSession(sessionId, ownerId, retroConfigFor(setup), { chatClock: clock.read });
  session.addParticipant(sender);
  if (setup.cardsRevealed) session.revealCards();
  if (setup.enableVoting) session.enableVoting();
  if (setup.completed) session.completeBoard();
  return session;
}

function boardContext(session: GameSession | RetroSession, author: { id: string; displayName: string }): ChatSendContext {
  return { connectionSessionId: session.sessionId, author, room: session.chat };
}

function acceptPrior(
  session: GameSession | RetroSession,
  author: { id: string; displayName: string },
  clientMessageId: string,
  text: string,
): void {
  const outcome = evaluateChatSend(
    buildPayload({ sessionId: session.sessionId, clientMessageId, text }),
    boardContext(session, author),
  );
  expectAccepted(outcome).commit();
}

/** Runs the prior sends and returns the oracle's model of the room. */
function seedRoom(
  session: GameSession | RetroSession,
  sender: { id: string; displayName: string },
  prior: PriorState,
): RoomModel {
  const otherIds: string[] = [];
  const selfIds: string[] = [];
  const selfSeqById = new Map<string, number>();
  let accepted = 0;

  for (let i = 0; i < prior.others; i++) {
    const id = priorId('aaaaaaaa', i + 1);
    acceptPrior(session, { id: `other-${i}`, displayName: `Other ${i}` }, id, `other ${i}`);
    otherIds.push(id);
    accepted++;
  }
  for (let i = 0; i < prior.self; i++) {
    const id = priorId('bbbbbbbb', i + 1);
    acceptPrior(session, sender, id, `mine ${i}`);
    accepted++;
    selfIds.push(id);
    selfSeqById.set(id.toLowerCase(), accepted);
  }
  if (prior.evict) {
    for (let i = 0; i < CHAT_HISTORY_LIMIT; i++) {
      acceptPrior(session, { id: `filler-${i}`, displayName: `Filler ${i}` }, priorId('cccccccc', i + 1), 'filler');
      accepted++;
    }
  }
  return {
    nextSeq: accepted + 1,
    lowestHeldSeq: Math.max(1, accepted - CHAT_HISTORY_LIMIT + 1),
    selfSeqById,
    selfIds,
    otherIds,
    selfAcceptCount: prior.self,
    selfAcceptAtMs: prior.startMs,
  };
}

function resolveSessionId(choice: SessionIdChoice, sessionId: string): { present: boolean; value: unknown } {
  switch (choice.kind) {
    case 'match':
      return { present: true, value: sessionId };
    case 'otherString':
      return { present: true, value: choice.value };
    case 'variant': {
      if (choice.how === 'upper') return { present: true, value: sessionId.toUpperCase() };
      if (choice.how === 'lower') return { present: true, value: sessionId.toLowerCase() };
      if (choice.how === 'space') return { present: true, value: `${sessionId} ` };
      return { present: true, value: `x${sessionId}` };
    }
    case 'nonString':
      return { present: true, value: choice.value };
    case 'omitted':
      return { present: false, value: undefined };
  }
}

function resolveClientMessageId(choice: IdChoice, model: RoomModel): unknown {
  switch (choice.kind) {
    case 'fresh':
      return choice.fresh;
    case 'selfHeld':
      return model.selfIds.length === 0
        ? choice.fresh
        : applyCasing(model.selfIds[choice.index % model.selfIds.length], choice.casing);
    case 'otherHeld':
      return model.otherIds.length === 0 ? choice.fresh : model.otherIds[choice.index % model.otherIds.length];
    case 'nonCanonical':
      return choice.nonCanonical;
    case 'nonString':
      return choice.nonString;
  }
}

/** The raw value as the handler would receive it after parsing. */
function buildRaw(c: CheckOrderCase, sessionId: string, model: RoomModel): unknown {
  const fields: Record<string, unknown> = {};
  const sid = resolveSessionId(c.sessionIdChoice, sessionId);
  if (sid.present) fields['sessionId'] = sid.value;
  fields['clientMessageId'] = resolveClientMessageId(c.idChoice, model);
  if (!c.omitText) fields['text'] = c.text;

  switch (c.shape.kind) {
    case 'object':
      return fields;
    case 'array':
      // An array that also carries the real keys must still be unreadable.
      return Object.assign([], fields);
    case 'primitive':
      return c.shape.value;
  }
}

function readPayloadField(raw: unknown, key: string): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  return (raw as Record<string, unknown>)[key];
}

/** History, its message objects and `lastActivityAt` are exactly as before. */
function expectSessionUnchanged(
  session: GameSession | RetroSession,
  historyBefore: ChatMessage[],
  activityBefore: string,
): void {
  const after = session.chat.history();
  expect(after).toEqual(historyBefore);
  after.forEach((m, i) => expect(m).toBe(historyBefore[i]));
  expect(session.lastActivityAt).toBe(activityBefore);
}

function expectOutcomeMatches(
  outcome: ChatSendOutcome,
  expected: Expected,
  historyBefore: ChatMessage[],
  submittedText: unknown,
): void {
  switch (expected.kind) {
    case 'accepted': {
      const accepted = expectAccepted(outcome);
      expect(accepted.message.seq).toBe(expected.seq);
      expect(accepted.message.text).toBe(expected.text);
      return;
    }
    case 'replay': {
      if (outcome.kind !== 'replay') throw new Error(`expected replay, got ${JSON.stringify(outcome)}`);
      // The stored message itself, unchanged (R16.5).
      expect(outcome.message).toBe(historyBefore.find((m) => m.seq === expected.seq));
      return;
    }
    case 'rejected': {
      if (outcome.kind !== 'rejected') throw new Error(`expected rejected, got ${JSON.stringify(outcome)}`);
      const want: ChatMessageRejectedPayload = {
        clientMessageId: expected.clientMessageId,
        code: expected.code,
        message: CHAT_REJECTION_MESSAGES[expected.code],
      };
      // retryAfterMs is present only for CHAT_RATE_LIMITED (toStrictEqual checks absence).
      if (expected.retryAfterMs !== undefined) want.retryAfterMs = expected.retryAfterMs;
      expect(outcome.payload).toStrictEqual(want);
      // R14.15: the fixed text carries none of the submitted text.
      if (
        typeof submittedText === 'string' &&
        submittedText.length >= 3 &&
        !FIXED_REJECTION_TEXTS.some((fixed) => fixed.includes(submittedText))
      ) {
        expect(outcome.payload.message.includes(submittedText)).toBe(false);
      }
      return;
    }
  }
}

// Feature: session-chat, Property 7: The first failing check decides, and a rejection changes nothing
describe('Property 7: The first failing check decides, and a rejection changes nothing', () => {
  /** **Validates: Requirements 14.9, 14.10, 14.11, 14.12, 14.15, 15.2, 15.8, 1.12, 16.3, 18.10** */
  it('the outcome is the first failing check of R14.11, and a rejection or replay leaves the session untouched', () => {
    const stepsSeen = new Set<CheckStep>();

    fc.assert(
      fc.property(checkOrderCaseArb, (c) => {
        const clock = makeClock(c.prior.startMs);
        const sender: User = { id: c.senderId, displayName: 'Sender', role: c.setup.role, isAnonymous: false };
        const author = { id: sender.id, displayName: sender.displayName };
        const session = buildBoardSession(c.setup, c.sessionId, sender, clock);
        const model = seedRoom(session, author, c.prior);
        clock.now = c.prior.startMs + c.prior.advanceMs;

        const raw = buildRaw(c, session.sessionId, model);
        const ctx = boardContext(session, author);
        const expected = firstFailingCheck(raw, session.sessionId, model, clock.now);
        stepsSeen.add(expected.step);

        const historyBefore = session.chat.history();
        const activityBefore = session.lastActivityAt;

        const outcome = evaluateChatSend(raw, ctx);
        expectOutcomeMatches(outcome, expected, historyBefore, readPayloadField(raw, 'text'));
        // Deciding never mutates, whatever the outcome (R16.3).
        expectSessionUnchanged(session, historyBefore, activityBefore);

        if (outcome.kind === 'accepted') {
          outcome.commit();
          // R18.10: lastActivityAt comes from the acceptance's clock reading.
          expect(session.lastActivityAt).toBe(new Date(clock.now).toISOString());
          const after = session.chat.history();
          expect(after[after.length - 1]).toBe(outcome.message);
          expect(after.length).toBe(Math.min(historyBefore.length + 1, CHAT_HISTORY_LIMIT));
          return;
        }

        // Probe: the seq counter, Dedup_Record and rate limiter are as before
        // the send, so a clean follow-up gets the outcome the pre-send model
        // predicts. Reusing the payload's id shows a rejected id was not consumed.
        const sentId = readPayloadField(raw, 'clientMessageId');
        const probeId = typeof sentId === 'string' && ORACLE_UUID_RE.test(sentId) ? sentId : PROBE_ID;
        const probeRaw = buildPayload({ sessionId: session.sessionId, clientMessageId: probeId, text: 'probe message' });
        const probeExpected = firstFailingCheck(probeRaw, session.sessionId, model, clock.now);
        const probe = evaluateChatSend(probeRaw, ctx);
        expectOutcomeMatches(probe, probeExpected, historyBefore, 'probe message');
        expectSessionUnchanged(session, historyBefore, activityBefore);

        if (probe.kind === 'accepted') {
          probe.commit();
          expect(session.lastActivityAt).toBe(new Date(clock.now).toISOString());
          const after = session.chat.history();
          expect(after[after.length - 1]).toBe(probe.message);
        }
      }),
      { numRuns: 400 },
    );

    // Every check of R14.11, plus replay and accept, was the deciding one in some run.
    expect([...stepsSeen].sort()).toEqual([...ALL_CHECK_STEPS].sort());
  });
});

// ---------------------------------------------------------------------------
// Property 36 helpers and generators
// ---------------------------------------------------------------------------

/**
 * Every secret a run generates (text, author name, payload value, exception
 * message) carries this character. A permitted chat log line never holds it:
 * Board_Kind, session IDs, event names, rejection codes, numbers and the
 * injected error names are all ASCII.
 */
const LOG_MARK = '\u00A4';

const logMarkerArb: fc.Arbitrary<string> = fc.stringMatching(/^[g-z]{10}$/).map((s) => `${LOG_MARK}${s}`);

/** Minimal `ws` stand-in the handlers can register, send to and close. */
class LogMockSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  readonly sent: string[] = [];
  /** When set, `send` throws the value this returns instead of recording the frame. */
  sendFailure: (() => unknown) | null = null;

  send(data: string): void {
    if (this.sendFailure) throw this.sendFailure();
    this.sent.push(data);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

function asWs(socket: LogMockSocket): WebSocket {
  return socket as unknown as WebSocket;
}

const LOG_EVENTS: Record<BoardKind, { send: string; all: readonly string[] }> = {
  poker: {
    send: CHAT_MESSAGE_SEND,
    all: [CHAT_MESSAGE_SEND, CHAT_MESSAGE_ADDED, CHAT_MESSAGE_REJECTED, CHAT_HISTORY],
  },
  retro: {
    send: RETRO_CHAT_MESSAGE_SEND,
    all: [RETRO_CHAT_MESSAGE_SEND, RETRO_CHAT_MESSAGE_ADDED, RETRO_CHAT_MESSAGE_REJECTED, RETRO_CHAT_HISTORY],
  },
};

/** Names given to injected `Error` instances; the name is a permitted field (R19.6). */
const INJECTED_ERROR_NAMES = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ChatStoreFailure'] as const;
/** Names the handlers log for a thrown value that is not an `Error`. */
const FALLBACK_ERROR_NAMES = ['Error', 'UnknownError'];
const ALLOWED_ERROR_NAMES = new Set<string>([...INJECTED_ERROR_NAMES, ...FALLBACK_ERROR_NAMES]);

/** The whitelisted shape of `formatChatLogLine` output (R19.2). */
const CHAT_LOG_LINE_RE = new RegExp(
  '^chat (poker|retro) session=(\\S+) event=(\\S+)' +
    `(?: code=(?:${Object.keys(CHAT_REJECTION_MESSAGES).join('|')}))?` +
    '(?: buffer=\\d+)?(?: broadcast=\\d+)?(?: textLength=\\d+)?(?: error=(\\S+))?$',
);

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

type InjectionPoint = 'none' | 'prepare' | 'commit' | 'senderSend' | 'peerSend';
type ThrownSpec = { form: 'error'; name: string } | { form: 'string' } | { form: 'object' };

interface Injection {
  at: InjectionPoint;
  thrown: ThrownSpec;
  noise: string;
  marker: string;
}

const injectionArb: fc.Arbitrary<Injection> = fc.record({
  at: fc.oneof(
    { arbitrary: fc.constant<InjectionPoint>('none'), weight: 2 },
    { arbitrary: fc.constantFrom<InjectionPoint>('prepare', 'commit', 'senderSend', 'peerSend'), weight: 5 },
  ),
  thrown: fc.oneof(
    {
      arbitrary: fc.constantFrom(...INJECTED_ERROR_NAMES).map((name): ThrownSpec => ({ form: 'error', name })),
      weight: 4,
    },
    { arbitrary: fc.constant<ThrownSpec>({ form: 'string' }), weight: 1 },
    { arbitrary: fc.constant<ThrownSpec>({ form: 'object' }), weight: 1 },
  ),
  noise: fc.string({ unit: 'binary', maxLength: 30 }),
  marker: logMarkerArb,
});

/** The value to throw; its message holds the run's secrets so a leaked message is caught. */
function makeThrown(spec: ThrownSpec, message: string): unknown {
  switch (spec.form) {
    case 'error': {
      const err = new Error(message);
      err.name = spec.name;
      return err;
    }
    case 'string':
      return message;
    case 'object':
      return { name: 'Error', message };
  }
}

/** Chat text: mostly marked strings, some near or over the limits, some blank or non-string. */
const logTextArb: fc.Arbitrary<unknown> = fc.oneof(
  {
    arbitrary: fc.tuple(mixedStringArb, logMarkerArb, mixedStringArb).map(([a, m, b]) => `${a}${m}${b}`),
    weight: 6,
  },
  {
    arbitrary: fc
      .tuple(logMarkerArb, fc.integer({ min: CHAT_MESSAGE_MAX_LENGTH - 20, max: CHAT_RAW_TEXT_MAX_LENGTH + 20 }))
      .map(([m, n]) => `${m}${'y'.repeat(n)}`),
    weight: 2,
  },
  { arbitrary: blankStringArb, weight: 1 },
  { arbitrary: nonStringArb, weight: 1 },
);

const logSpoofValueArb: fc.Arbitrary<unknown> = fc
  .tuple(fc.string({ maxLength: 8 }), logMarkerArb, fc.constantFrom('plain', 'nested', 'array'))
  .map(([noise, m, form]) => {
    const v = `${noise}${m}`;
    if (form === 'nested') return { authorName: v, text: v };
    if (form === 'array') return [v, 1, null];
    return v;
  });

/** Extra payload fields a client might add, including a copy of its own JWT. */
const logSpoofArb: fc.Arbitrary<[string, unknown][]> = fc.uniqueArray(
  fc.tuple(
    fc.constantFrom('authorName', 'displayName', 'author', 'user', 'jwt', 'authorization', 'note', 'error'),
    logSpoofValueArb,
  ),
  { selector: ([k]) => k, maxLength: 4 },
);

interface LogSend {
  shape: 'object' | 'array' | 'primitive';
  session: 'match' | 'foreign' | 'missing';
  foreignSessionId: string;
  idKind: 'pool' | 'bad' | 'nonString';
  idIndex: number;
  badId: string;
  nonStringId: unknown;
  text: unknown;
  spoof: [string, unknown][];
  echoToken: boolean;
}

const logSendArb: fc.Arbitrary<LogSend> = fc.record({
  shape: fc.oneof(
    { arbitrary: fc.constant<LogSend['shape']>('object'), weight: 8 },
    { arbitrary: fc.constantFrom<LogSend['shape']>('array', 'primitive'), weight: 1 },
  ),
  session: fc.oneof(
    { arbitrary: fc.constant<LogSend['session']>('match'), weight: 6 },
    { arbitrary: fc.constantFrom<LogSend['session']>('foreign', 'missing'), weight: 1 },
  ),
  foreignSessionId: logMarkerArb,
  idKind: fc.oneof(
    { arbitrary: fc.constant<LogSend['idKind']>('pool'), weight: 6 },
    { arbitrary: fc.constantFrom<LogSend['idKind']>('bad', 'nonString'), weight: 1 },
  ),
  idIndex: fc.nat(2),
  badId: logMarkerArb.map((m) => `${m}-not-a-uuid`),
  nonStringId: nonStringArb,
  text: logTextArb,
  spoof: logSpoofArb,
  echoToken: fc.boolean(),
});

interface LogScenario {
  kind: BoardKind;
  /** Display names; the first is the sender of every chat event. */
  names: string[];
  /** Client_Message_Id pool, small so replays happen. */
  ids: string[];
  injection: Injection;
  sends: LogSend[];
}

const logScenarioArb: fc.Arbitrary<LogScenario> = fc.record({
  kind: fc.constantFrom<BoardKind>('poker', 'retro'),
  names: fc
    .array(fc.tuple(fc.string({ unit: 'grapheme', maxLength: 10 }), logMarkerArb), { minLength: 1, maxLength: 3 })
    .map((list) => list.map(([g, m], i) => `${g} ${m}${i}`)),
  ids: fc.uniqueArray(fc.uuid(), { minLength: 3, maxLength: 3 }),
  injection: injectionArb,
  sends: fc.array(logSendArb, { minLength: 1, maxLength: 6 }),
});

/** The chat send payload exactly as the client puts it on the wire. */
function buildLogPayload(send: LogSend, sessionId: string, ids: string[], token: string): unknown {
  const sid = send.session === 'match' ? sessionId : send.foreignSessionId;
  const clientMessageId =
    send.idKind === 'pool' ? ids[send.idIndex] : send.idKind === 'bad' ? send.badId : send.nonStringId;
  const extras: [string, unknown][] = [...send.spoof];
  if (send.echoToken) extras.push(['token', token]);

  switch (send.shape) {
    case 'object': {
      const payload: Record<string, unknown> = {};
      for (const [key, value] of extras) payload[key] = value;
      if (send.session !== 'missing') payload['sessionId'] = sid;
      payload['clientMessageId'] = clientMessageId;
      payload['text'] = send.text;
      return payload;
    }
    case 'array':
      return [sid, clientMessageId, send.text, ...extras.map(([, value]) => value)];
    case 'primitive':
      return send.text;
  }
}

/** Collects every string holding LOG_MARK, at any depth of a payload value. */
function collectMarked(value: unknown, out: string[], depth = 0): void {
  if (depth > 8) return;
  if (typeof value === 'string') {
    if (value.includes(LOG_MARK)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMarked(item, out, depth + 1);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collectMarked(item, out, depth + 1);
  }
}

function resetLogWorld(): void {
  resetPokerHandler();
  _resetRetroHandler();
  sessionRegistry._reset();
  retroSessionRegistry._reset();
  resetAuthStore();
}

interface LogRunResult {
  lines: string[];
  sessionId: string;
  /** Strings that must not appear in any line: texts, names, payload values, exception messages. */
  secrets: string[];
  /** The JWT of every Board_Connection. */
  tokens: string[];
}

/** Drives one scenario through the real handler and returns every console line it wrote. */
function runLogScenario(s: LogScenario): LogRunResult {
  jest.restoreAllMocks();
  resetLogWorld();

  const lines: string[] = [];
  let capturing = false;
  for (const method of CONSOLE_METHODS) {
    jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      if (capturing) lines.push(format(...args));
    });
  }

  const sessionId =
    s.kind === 'poker'
      ? sessionRegistry.createSession('log-owner', DEFAULT_SESSION_CONFIG).sessionId
      : retroSessionRegistry.createSession(
          'log-owner',
          retroConfigFor({
            kind: 'retro',
            role: 'participant',
            hideCardsInitially: false,
            disableVotingInitially: false,
            cardsRevealed: false,
            enableVoting: false,
            completed: false,
          }),
        ).sessionId;
  const room = s.kind === 'poker' ? sessionRegistry.getSession(sessionId)!.chat : retroSessionRegistry.getSession(sessionId)!.chat;

  // Everything from here on (connect, chat sends, close) is captured.
  capturing = true;

  const tokens: string[] = [];
  const secrets: string[] = [];
  const sockets: LogMockSocket[] = [];
  for (const name of s.names) {
    const { token, user } = login(name, false);
    tokens.push(token);
    secrets.push(user.displayName);
    const socket = new LogMockSocket();
    const path = s.kind === 'poker' ? '/' : '/retro';
    const request = {
      url: `${path}?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sessionId)}`,
      headers: { host: 'localhost:3000' },
    } as unknown as IncomingMessage;
    if (s.kind === 'poker') handleWebSocket(asWs(socket), request);
    else handleRetroWebSocket(asWs(socket), request);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    sockets.push(socket);
  }

  const { injection } = s;
  const senderToken = tokens[0];
  const message = `${injection.noise} ${injection.marker} name=${s.names[0]} token=${senderToken}`;
  secrets.push(message);
  const thrown = (): unknown => makeThrown(injection.thrown, message);

  switch (injection.at) {
    case 'none':
      break;
    case 'prepare':
      jest.spyOn(room, 'prepare').mockImplementation(() => {
        throw thrown();
      });
      break;
    case 'commit': {
      const original = room.prepare.bind(room);
      jest.spyOn(room, 'prepare').mockImplementation((author, clientMessageId, text) => {
        const decision = original(author, clientMessageId, text);
        if (decision.kind !== 'accepted') return decision;
        return {
          ...decision,
          commit: () => {
            throw thrown();
          },
        };
      });
      break;
    }
    case 'senderSend':
      sockets[0].sendFailure = thrown;
      break;
    case 'peerSend':
      sockets[sockets.length - 1].sendFailure = thrown;
      break;
  }

  for (const send of s.sends) {
    const data = buildLogPayload(send, sessionId, s.ids, senderToken);
    collectMarked(data, secrets);
    if (typeof send.text === 'string') {
      const verdict = validateChatText(send.text);
      if (verdict.ok) collectMarked(verdict.text, secrets);
    }
    sockets[0].emit(
      'message',
      Buffer.from(JSON.stringify({ event: LOG_EVENTS[s.kind].send, data, timestamp: new Date().toISOString() })),
    );
  }

  // Disarm every injection before closing: the close path is not chat handling.
  for (const socket of sockets) socket.sendFailure = null;
  for (const socket of sockets) {
    socket.readyState = WebSocket.CLOSED;
    socket.emit('close');
  }
  capturing = false;

  // Client_Message_Ids are payload values too; they have no LOG_MARK.
  secrets.push(...s.ids);
  return { lines, sessionId, secrets, tokens };
}

// Feature: session-chat, Property 36: Chat logs carry only permitted fields
describe('Property 36: Chat logs carry only permitted fields', () => {
  beforeEach(() => {
    resetLogWorld();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetLogWorld();
  });

  /** **Validates: Requirements 19.1, 19.2, 19.6, 23.2** */
  it('console output from either chat handler holds no text, author name, payload value, JWT or exception message', () => {
    const loggedKinds = new Set<BoardKind>();
    const loggedErrorNames = new Set<string>();

    fc.assert(
      fc.property(logScenarioArb, (s) => {
        const { lines, sessionId, secrets, tokens } = runLogScenario(s);

        for (const line of lines) {
          // R19.2 / R19.6: only the whitelisted keys, for this board and session.
          const match = CHAT_LOG_LINE_RE.exec(line);
          expect({ line, match: match !== null }).toEqual({ line, match: true });
          if (!match) return;
          const [, kind, loggedSession, event, errorName] = match;
          expect(kind).toBe(s.kind);
          expect(loggedSession).toBe(sessionId);
          expect(LOG_EVENTS[s.kind].all).toContain(event);
          if (errorName !== undefined) {
            expect(ALLOWED_ERROR_NAMES.has(errorName)).toBe(true);
            loggedErrorNames.add(errorName);
          }

          // R19.1 / R19.6: no text, author name, payload value or exception message.
          expect(line.includes(LOG_MARK)).toBe(false);
          for (const secret of secrets) {
            expect(line.includes(secret)).toBe(false);
          }
          // R23.2: no JWT, nor any of its three segments.
          for (const token of tokens) {
            for (const part of [token, ...token.split('.')]) {
              expect(line.includes(part)).toBe(false);
            }
          }
          expect(line.includes('token=')).toBe(false);
          loggedKinds.add(s.kind);
        }

        // D11: no line per chat message; only an exception writes one.
        if (s.injection.at === 'none') {
          expect(lines).toEqual([]);
        }
      }),
      { numRuns: 200 },
    );

    // The injected exceptions reached the log path of both handlers.
    expect([...loggedKinds].sort()).toEqual(['poker', 'retro']);
    expect(loggedErrorNames.size).toBeGreaterThan(1);
  });
});
