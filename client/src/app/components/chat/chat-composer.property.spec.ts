import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular';
import { Subject } from 'rxjs';
import {
  CHAT_MESSAGE_MAX_LENGTH,
  ChatMessage,
  ChatMessageSendPayload,
  ConnectionState,
  User,
  isCanonicalUuid,
} from '@shared/types';
import { normaliseChatText, validateChatText } from '@shared/chat-text';
import { CHAT_TIMERS, ChatPanelState, ChatStore, ChatTimers } from '../../services/chat-store.service';
import { CHAT_READ_MARKER_STORE, ReadMarkerStore } from '../../services/chat-read-marker';
import { CHAT_TRANSPORT, ChatTransport } from '../../services/chat-transport';
import { ChatComposerComponent } from './chat-composer.component';

// ---------------------------------------------------------------------------
// Harness (module scope, shared by every property in this file)
// ---------------------------------------------------------------------------

/** Manual clock: timers fire only through `advance`. */
class ManualTimers implements ChatTimers {
  time = 1_000_000;
  private nextHandle = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }
  setTimeout(callback: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.pending.set(handle, { at: this.time + ms, callback });
    return handle;
  }
  clearTimeout(handle: number): void {
    this.pending.delete(handle);
  }
  advance(ms: number): void {
    this.time += ms;
    for (const [handle, timer] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= this.time && this.pending.delete(handle)) timer.callback();
    }
  }
}

class FakeTransport implements ChatTransport {
  readonly boardKind = 'poker' as const;
  readonly connectionState = signal<ConnectionState>('connected');
  readonly connectionGeneration = signal(1);
  readonly participants = signal<readonly User[]>([]);
  readonly currentUserId = signal<string | null>('me');
  readonly added$ = new Subject<unknown>();
  readonly history$ = new Subject<unknown>();
  readonly rejected$ = new Subject<unknown>();
  readonly sent: ChatMessageSendPayload[] = [];
  send(payload: ChatMessageSendPayload): boolean {
    this.sent.push(payload);
    return true;
  }
}

interface Harness {
  readonly transport: FakeTransport;
  readonly timers: ManualTimers;
  readonly store: ChatStore;
  readonly textArea: HTMLTextAreaElement;
  readonly button: HTMLButtonElement;
  /** Runs effects and change detection after a signal or DOM change. */
  readonly flush: () => void;
}

async function setup(): Promise<Harness> {
  const transport = new FakeTransport();
  const timers = new ManualTimers();
  const storage = new Map<string, string>();
  const { fixture } = await render(ChatComposerComponent, {
    providers: [
      ChatStore,
      { provide: CHAT_TRANSPORT, useValue: transport },
      { provide: CHAT_TIMERS, useValue: timers },
      {
        provide: CHAT_READ_MARKER_STORE,
        useValue: new ReadMarkerStore(() => ({
          getItem: (k: string) => storage.get(k) ?? null,
          setItem: (k: string, v: string) => void storage.set(k, v),
        })),
      },
    ],
  });
  const store = TestBed.inject(ChatStore);
  store.reset('s1');
  const flush = (): void => {
    TestBed.tick();
    fixture.detectChanges();
  };
  flush();
  return {
    transport,
    timers,
    store,
    textArea: screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement,
    button: screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement,
    flush,
  };
}

/** Types `value` into the text area the way the browser reports it: value change, then `input`. */
function type(h: Harness, value: string): void {
  h.textArea.value = value;
  h.textArea.setSelectionRange(value.length, value.length);
  h.textArea.dispatchEvent(new Event('input', { bubbles: true }));
  h.flush();
}

/** Dispatches a cancelable Enter keydown (no Shift, not composing) on the text area. */
function pressEnter(h: Harness): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
    shiftKey: false,
    isComposing: false,
  });
  // `keyCode` is legacy and not settable through every DOM implementation's init dictionary.
  Object.defineProperty(event, 'keyCode', { configurable: true, get: () => 13 });
  h.textArea.dispatchEvent(event);
  h.flush();
  return event;
}

/** Canonical UUID built from a counter, so generated ids never collide within a test. */
function uuidFrom(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

let nextId = 1;
let nextSeq = 1;

function chatMessage(authorId: string, text: string): ChatMessage {
  return {
    id: uuidFrom(nextId++),
    seq: nextSeq++,
    clientMessageId: uuidFrom(nextId++),
    authorId,
    authorName: authorId === 'me' ? 'Me' : 'Someone',
    text,
    sentAt: '2026-05-01T10:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------
// Draft generators (modelled on the Chat_Validator generators)
// ---------------------------------------------------------------------------

const ZS_CHARS = [
  '\u0020', '\u00A0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005',
  '\u2006', '\u2007', '\u2008', '\u2009', '\u200A', '\u202F', '\u205F', '\u3000',
];
const BIDI_CHARS = ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069'];
const C0_DISALLOWED_CHARS = ['\u0000', '\u0001', '\u0008', '\u000B', '\u000C', '\u000E', '\u001B', '\u001F', '\u007F'];

/** Characters the validator trims from both ends. */
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
);

const lineBreakArb: fc.Arbitrary<string> = fc.constantFrom('\r\n', '\r', '\n', '\r\r\n', '\n\r');

const loneSurrogateArb: fc.Arbitrary<string> = fc
  .integer({ min: 0xd800, max: 0xdfff })
  .map((cu) => String.fromCharCode(cu));

/** Ordinary visible text, including emoji (surrogate pairs). */
const visibleCharArb: fc.Arbitrary<string> = fc.constantFrom('a', 'Z', '7', 'é', '中', '😀', '👍🏽', '<', '"', '\u200B');

const fragmentArb: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: visibleCharArb, weight: 4 },
  { arbitrary: whitespaceCharArb, weight: 3 },
  { arbitrary: disallowedCharArb, weight: 2 },
  { arbitrary: lineBreakArb, weight: 2 },
  { arbitrary: loneSurrogateArb, weight: 1 },
  { arbitrary: fc.string({ unit: 'binary', maxLength: 6 }), weight: 1 },
);

/** Short strings mixing every interesting character class. */
const mixedDraftArb: fc.Arbitrary<string> = fc
  .array(fragmentArb, { maxLength: 40 })
  .map((parts) => parts.join(''));

/** Whitespace, Disallowed_Characters and line breaks only: never sendable. */
const blankDraftArb: fc.Arbitrary<string> = fc
  .array(fc.oneof(whitespaceCharArb, disallowedCharArb, lineBreakArb), { maxLength: 60 })
  .map((parts) => parts.join(''));

const bodyCharArb: fc.Arbitrary<string> = fc.constantFrom('a', 'é', '😀', ' ', '\t', '\u0001', '\u202E', '\n', '\r\n');

/** blank padding + repeated body + mixed tail + blank padding, of a chosen raw length. */
function paddedDraftArb(minBody: number, maxBody: number): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.array(fc.oneof(whitespaceCharArb, disallowedCharArb), { maxLength: 30 }),
      bodyCharArb,
      fc.integer({ min: minBody, max: maxBody }),
      mixedDraftArb,
      fc.array(fc.oneof(whitespaceCharArb, disallowedCharArb, lineBreakArb), { maxLength: 30 }),
    )
    .map(([lead, body, count, tail, trail]) => lead.join('') + body.repeat(count) + tail + trail.join(''));
}

/** Drafts a user can type: at most CHAT_MESSAGE_MAX_LENGTH code units (the text area's maxlength). */
const typedDraftArb: fc.Arbitrary<string> = fc
  .oneof(
    { arbitrary: mixedDraftArb, weight: 4 },
    { arbitrary: blankDraftArb, weight: 2 },
    { arbitrary: paddedDraftArb(200, 520), weight: 2 },
    { arbitrary: fc.constant(''), weight: 1 },
  )
  .map((s) => s.slice(0, CHAT_MESSAGE_MAX_LENGTH));

/** Drafts set on the store directly, including ones longer than 500 and 2,000 code units. */
const programmaticDraftArb: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: mixedDraftArb, weight: 2 },
  { arbitrary: paddedDraftArb(480, 560), weight: 2 },
  { arbitrary: paddedDraftArb(1950, 2100), weight: 1 },
);

type DraftInput = { readonly via: 'typed' | 'store'; readonly text: string };

const draftInputArb: fc.Arbitrary<DraftInput> = fc.oneof(
  { arbitrary: typedDraftArb.map((text) => ({ via: 'typed' as const, text })), weight: 3 },
  { arbitrary: programmaticDraftArb.map((text) => ({ via: 'store' as const, text })), weight: 1 },
);

const connectionArb: fc.Arbitrary<ConnectionState> = fc.constantFrom('connected', 'reconnecting', 'disconnected');

/**
 * State that R1.11 and R7.6 say must not affect sendability and that can reach the composer:
 * the user's role and identity, Panel_State, the Presence_List, an active rate limit, the
 * Unread_Count, the history status, the scroll position and New_Messages_Indicator count.
 * Board state named by R1.11 (round, votes, countdown, issue, retro phase, `isCompleted`) has
 * no path into `ChatStore` or the composer, whose only inputs are the store and CHAT_TRANSPORT.
 */
interface OtherState {
  readonly role: User['role'];
  readonly currentUserId: string | null;
  readonly panelState: ChatPanelState;
  readonly presenceOpen: boolean;
  readonly rateLimitMs: number | null;
  readonly advanceMs: number;
  readonly incoming: readonly ('me' | 'other')[];
  readonly deliverHistory: boolean;
  readonly atBottom: boolean;
  readonly newIndicatorCount: number;
}

const otherStateArb: fc.Arbitrary<OtherState> = fc.record({
  role: fc.constantFrom<User['role']>('moderator', 'participant'),
  currentUserId: fc.constantFrom<string | null>('me', 'me', 'someone-else', null),
  panelState: fc.constantFrom<ChatPanelState>('closed', 'open', 'minimized'),
  presenceOpen: fc.boolean(),
  rateLimitMs: fc.option(fc.integer({ min: 1, max: 5000 }), { nil: null }),
  advanceMs: fc.integer({ min: 0, max: 6000 }),
  incoming: fc.array(fc.constantFrom<'me' | 'other'>('me', 'other', 'other'), { maxLength: 3 }),
  deliverHistory: fc.boolean(),
  atBottom: fc.boolean(),
  newIndicatorCount: fc.integer({ min: 0, max: 5 }),
});

function applyOtherState(h: Harness, s: OtherState): void {
  h.transport.participants.set([
    { id: 'me', displayName: 'Me', role: s.role, isAnonymous: false },
    { id: 'other', displayName: 'Someone', role: s.role === 'moderator' ? 'participant' : 'moderator', isAnonymous: false },
  ]);
  h.transport.currentUserId.set(s.currentUserId);
  h.store.panelState.set(s.panelState);
  h.store.presenceOpen.set(s.presenceOpen);
  h.store.scroll.set({ atBottom: s.atBottom, top: s.atBottom ? 0 : 40 });
  h.store.newIndicatorCount.set(s.newIndicatorCount);
  h.flush();
  if (s.deliverHistory) {
    h.transport.connectionGeneration.update((g) => g + 1);
    h.transport.history$.next({ messages: [chatMessage('other', 'from history')] });
  }
  for (const author of s.incoming) {
    h.transport.added$.next({ message: chatMessage(author, 'hello') });
  }
  if (s.rateLimitMs !== null) {
    h.transport.rejected$.next({
      clientMessageId: uuidFrom(nextId++),
      code: 'CHAT_RATE_LIMITED',
      message: 'Too fast.',
      retryAfterMs: s.rateLimitMs,
    });
  }
  h.timers.advance(s.advanceMs);
  h.flush();
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

// Feature: session-chat, Property 6: Sendability depends only on the validator and the connection
describe('Property 6: Sendability depends only on the validator and the connection', () => {
  /** **Validates: Requirements 7.6, 1.11** */
  it('disables the send button and gates Enter exactly by validateChatText(draft).ok and connected', async () => {
    const h = await setup();
    const seen = new Set<string>();

    fc.assert(
      fc.property(draftInputArb, connectionArb, otherStateArb, (draft, connection, other) => {
        applyOtherState(h, other);
        h.transport.connectionState.set(connection);
        h.flush();

        if (draft.via === 'typed') {
          type(h, draft.text);
        } else {
          h.store.draft.set(draft.text);
          h.store.caret.set(draft.text.length);
          h.flush();
        }

        const current = h.store.draft();
        if (draft.via === 'typed') expect(current).toBe(h.textArea.value);
        else expect(current).toBe(draft.text);

        const verdict = validateChatText(current);
        const expected = connection === 'connected' && verdict.ok;
        seen.add(`${expected}:${verdict.ok}:${connection}`);

        expect(h.store.sendable()).toBe(expected);
        expect(h.button.disabled).toBe(!expected);

        const sentBefore = h.transport.sent.length;
        const event = pressEnter(h);

        expect(event.defaultPrevented).toBe(true);
        expect(h.transport.sent.length).toBe(sentBefore + (expected ? 1 : 0));
        if (expected && verdict.ok) {
          const payload = h.transport.sent[h.transport.sent.length - 1];
          expect(payload.text).toBe(verdict.text);
          expect(payload.sessionId).toBe('s1');
          expect(h.store.draft()).toBe('');
        } else {
          expect(h.store.draft()).toBe(current);
        }

        // Leave the next run an empty Draft and a known connection.
        h.store.draft.set('');
        h.store.caret.set(0);
        h.transport.connectionState.set('connected');
        h.flush();
      }),
      { numRuns: 150 },
    );

    // Guard against a vacuous run: sendable drafts, rejected drafts and every offline state occurred.
    expect(seen).toContain('true:true:connected');
    expect(seen).toContain('false:false:connected');
    expect(seen).toContain('false:true:reconnecting');
    expect(seen).toContain('false:true:disconnected');
  });
});

// Feature: session-chat, Property 28: Sent payloads carry normalised text and fresh ids
describe('Property 28: Sent payloads carry normalised text and fresh ids', () => {
  /** Canonical 36-character UUID in the lower-case form `crypto.randomUUID()` produces (R7.11). */
  const LOWER_CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  type SendVia = 'enter' | 'button';

  /** A sendable Draft, how it reaches the store, and how the user sends it. */
  const sendableSendArb: fc.Arbitrary<DraftInput & { readonly send: SendVia }> = fc
    .tuple(
      draftInputArb.filter((d) => validateChatText(d.text).ok),
      fc.constantFrom<SendVia>('enter', 'button'),
    )
    .map(([draft, send]) => ({ ...draft, send }));

  /** Board_Session IDs; a run counter is appended so each run binds a different session. */
  const sessionIdArb: fc.Arbitrary<string> = fc.oneof(
    fc.uuid(),
    fc.stringMatching(/^[A-Za-z0-9-]{1,16}$/),
  );

  /** **Validates: Requirements 7.11** */
  it('sends the Normalised_Text, the page session ID and a canonical Client_Message_Id never used before in the tab', async () => {
    const h = await setup();
    // Every Client_Message_Id the tab has generated, across runs and sessions.
    const seenIds = new Set<string>();
    let run = 0;
    let sends = 0;
    let rawDiffered = 0;

    fc.assert(
      fc.property(sessionIdArb, fc.array(sendableSendArb, { minLength: 1, maxLength: 6 }), (rawSessionId, drafts) => {
        const sessionId = `${rawSessionId}-${run++}`;
        h.store.reset(sessionId);
        h.transport.connectionState.set('connected');
        h.flush();

        for (const draft of drafts) {
          if (draft.via === 'typed') {
            type(h, draft.text);
          } else {
            h.store.draft.set(draft.text);
            h.store.caret.set(draft.text.length);
            h.flush();
          }
          const raw = h.store.draft();
          const normalised = normaliseChatText(raw);
          if (normalised !== raw) rawDiffered++;

          const sentBefore = h.transport.sent.length;
          if (draft.send === 'enter') {
            pressEnter(h);
          } else {
            h.button.click();
            h.flush();
          }

          expect(h.transport.sent.length).toBe(sentBefore + 1);
          const payload = h.transport.sent[h.transport.sent.length - 1];

          expect(payload.text).toBe(normalised);
          expect(payload.sessionId).toBe(sessionId);
          expect(payload.clientMessageId).toHaveLength(36);
          expect(isCanonicalUuid(payload.clientMessageId)).toBe(true);
          expect(payload.clientMessageId).toMatch(LOWER_CANONICAL_UUID_RE);
          expect(seenIds.has(payload.clientMessageId)).toBe(false);
          seenIds.add(payload.clientMessageId);
          sends++;

          expect(h.store.draft()).toBe('');
        }
      }),
      { numRuns: 100 },
    );

    // Guard against a vacuous run: many sends, and drafts whose raw text normalisation changed.
    expect(sends).toBeGreaterThanOrEqual(100);
    expect(seenIds.size).toBe(sends);
    expect(rawDiffered).toBeGreaterThan(0);
  });
});
