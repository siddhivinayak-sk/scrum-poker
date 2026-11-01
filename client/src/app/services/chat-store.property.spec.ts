// Feature: session-chat, property tests for the pure chat reducer (tasks 8.5–8.14).
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { DOCUMENT } from '@angular/common';
import { EnvironmentInjector, createEnvironmentInjector, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import type { BoardKind, ChatMessage, ChatMessageSendPayload, ChatRejection, ConnectionState, User } from '@shared/types';
import { isChatMessage } from '@shared/types';
import { validateChatText } from '@shared/chat-text';
import {
  CHAT_ACK_TIMEOUT_NOTICE,
  CHAT_NOT_SENT_ANNOUNCEMENT,
  ChatAction,
  ChatState,
  OutboxState,
  createChatState,
  reduceChat,
  selectEntries,
  selectUnreadCount,
} from './chat-store';
import { CHAT_TIMERS, ChatPanelState, ChatStore, ChatTimers } from './chat-store.service';
import {
  CHAT_READ_MARKER_STORE,
  ReadMarkerStorageProvider,
  ReadMarkerStore,
  parseReadMarker,
  readMarkerKey,
  serializeReadMarker,
} from './chat-read-marker';
import { CHAT_TRANSPORT, ChatTransport } from './chat-transport';

// ---------------------------------------------------------------------------
// Shared constants, generators and helpers (used by every property below)
// ---------------------------------------------------------------------------

/** The history limit as stated in R18.12. */
const REF_HISTORY_LIMIT = 200;

const ME = 'user-me';
const AUTHOR_IDS = [ME, 'user-a', 'user-b'] as const;
const SESSION_ID = 's1';

/** Canonical 8-4-4-4-12 UUIDs. */
const uuidArb = fc.uuid();

/** Valid `sentAt` strings (`YYYY-MM-DDTHH:mm:ss.sssZ`, calendar-valid). */
const sentAtArb = fc
  .date({ min: new Date('2000-01-01T00:00:00.000Z'), max: new Date('2099-12-31T23:59:59.999Z'), noInvalidDate: true })
  .map((d) => d.toISOString());

/** Seqs from a small range (so ties occur) or the full valid range. */
const seqArb = fc.oneof(fc.integer({ min: 1, max: 300 }), fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }));

/** A message that passes `isChatMessage`. */
const chatMessageArb: fc.Arbitrary<ChatMessage> = fc.record({
  id: uuidArb,
  seq: seqArb,
  clientMessageId: uuidArb,
  authorId: fc.constantFrom(...AUTHOR_IDS),
  authorName: fc.string({ maxLength: 20 }),
  text: fc.string({ maxLength: 40 }),
  sentAt: sentAtArb,
});

/**
 * A universe of messages with distinct ids, so the same id always maps to the same message.
 * Sizes are either small or around the history limit so the 200 cap is exercised.
 */
const messageUniverseArb: fc.Arbitrary<ChatMessage[]> = fc.oneof(
  fc.uniqueArray(chatMessageArb, { selector: (m) => m.id, minLength: 0, maxLength: 30 }),
  fc.uniqueArray(chatMessageArb, { selector: (m) => m.id, minLength: 180, maxLength: 260 }),
);

type DeliveryStep =
  | { readonly kind: 'added'; readonly message: ChatMessage }
  | { readonly kind: 'history'; readonly messages: readonly ChatMessage[] };

/**
 * Every message of the universe at least once plus duplicates, in random order, split into
 * single `added` deliveries and `history` chunks of any size (possibly empty).
 */
function deliveryArb(universe: readonly ChatMessage[]): fc.Arbitrary<DeliveryStep[]> {
  const extras =
    universe.length === 0
      ? fc.constant<number[]>([])
      : fc.array(fc.nat({ max: universe.length - 1 }), { maxLength: 40 });
  return extras.chain((extra) => {
    const indices = [...universe.keys(), ...extra];
    return fc.tuple(
      fc.shuffledSubarray(indices, { minLength: indices.length, maxLength: indices.length }),
      fc.array(fc.record({ asHistory: fc.boolean(), newChunk: fc.boolean() }), {
        minLength: indices.length,
        maxLength: indices.length,
      }),
      fc.array(fc.nat({ max: indices.length }), { maxLength: 3 }),
    ).map(([order, labels, emptyAt]) => {
      const steps: DeliveryStep[] = [];
      let chunk: ChatMessage[] | null = null;
      const flush = (): void => {
        if (chunk !== null) steps.push({ kind: 'history', messages: chunk });
        chunk = null;
      };
      order.forEach((index, i) => {
        if (emptyAt.includes(i)) {
          flush();
          steps.push({ kind: 'history', messages: [] });
        }
        const message = universe[index];
        if (!labels[i].asHistory) {
          flush();
          steps.push({ kind: 'added', message });
          return;
        }
        if (chunk === null || labels[i].newChunk) {
          flush();
          chunk = [];
        }
        chunk.push(message);
      });
      flush();
      return steps;
    });
  });
}

/** A universe together with one delivery of it. */
const universeAndDeliveryArb = messageUniverseArb.chain((universe) =>
  deliveryArb(universe).map((steps) => ({ universe, steps })),
);

/** Outbox entries to create before delivery: each `pending`, or `failed` after an ack timeout. */
const outboxPlanArb = fc.uniqueArray(fc.record({ clientMessageId: uuidArb, failed: fc.boolean() }), {
  selector: (e) => e.clientMessageId,
  maxLength: 4,
});

function compareRef(a: ChatMessage, b: ChatMessage): number {
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Reference confirmed list: dedupe by id, sort by seq then id, keep the last 200. */
function referenceConfirmed(delivered: readonly ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of delivered) if (!byId.has(m.id)) byId.set(m.id, m);
  const sorted = [...byId.values()].sort(compareRef);
  return sorted.slice(Math.max(0, sorted.length - REF_HISTORY_LIMIT));
}

function apply(state: ChatState, actions: readonly ChatAction[]): ChatState {
  for (const action of actions) state = reduceChat(state, action).state;
  return state;
}

/** A connected state of the current user `ME`. */
function connectedState(): ChatState {
  return apply(createChatState({ boardKind: 'poker', sessionId: SESSION_ID, me: ME }), [
    { kind: 'connection', state: 'connected', now: 0 },
  ]);
}

/** Actions for the delivery steps; histories carry increasing generations so every one applies. */
function deliveryActions(steps: readonly DeliveryStep[], firstGeneration = 1): ChatAction[] {
  let generation = firstGeneration;
  return steps.map((step, i): ChatAction =>
    step.kind === 'added'
      ? { kind: 'added', raw: { message: step.message } }
      : { kind: 'history', raw: { messages: step.messages }, generation: generation++, now: 1000 + i },
  );
}

function delivered(steps: readonly DeliveryStep[]): ChatMessage[] {
  return steps.flatMap((s) => (s.kind === 'added' ? [s.message] : s.messages));
}

// ---------------------------------------------------------------------------
// Property 15
// ---------------------------------------------------------------------------

// Feature: session-chat, Property 15: Merging confirmed messages is confluent
describe('Property 15: Merging confirmed messages is confluent', () => {
  /** **Validates: Requirements 16.8, 16.9, 18.12** */
  it('yields the deduplicated, seq-sorted 200 highest messages for any arrival order and split', () => {
    fc.assert(
      fc.property(universeAndDeliveryArb, outboxPlanArb, ({ universe, steps }, outboxPlan) => {
        // Pending and failed outbox entries exist before delivery and must not count toward the 200.
        const setup: ChatAction[] = [];
        outboxPlan.forEach((entry, i) => {
          setup.push({ kind: 'send', clientMessageId: entry.clientMessageId, text: `draft ${i}`, now: 10 + i });
          if (entry.failed) setup.push({ kind: 'ackTimeout', clientMessageId: entry.clientMessageId });
        });
        const state = apply(apply(connectedState(), setup), deliveryActions(steps));

        const expected = referenceConfirmed(universe);
        expect(referenceConfirmed(delivered(steps))).toEqual(expected);
        expect(state.confirmed).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Property 16
// ---------------------------------------------------------------------------

type PlannedOutboxState = 'pending' | 'failed' | 'sent';

/**
 * Outbox entries for Property 16: each reaches `pending`, `failed` (ack timeout) or `sent`
 * (`CHAT_DUPLICATE`), and may be confirmed by an own message inside the history H.
 */
const idempotenceOutboxArb = fc.uniqueArray(
  fc.record({
    clientMessageId: uuidArb,
    state: fc.constantFrom<PlannedOutboxState>('pending', 'failed', 'sent'),
    confirmedByHistory: fc.boolean(),
    ownMessage: chatMessageArb,
  }),
  { selector: (e) => e.clientMessageId, maxLength: 5 },
);

/** Any store state: outbox entries, earlier deliveries, a Read_Marker and a Connection_State. */
const idempotenceScenarioArb = fc
  .record({
    prior: universeAndDeliveryArb,
    outbox: idempotenceOutboxArb,
    readMarker: fc.option(fc.integer({ min: 1, max: 400 }), { nil: null }),
    connectedAtHistory: fc.boolean(),
    extraMessages: fc.array(chatMessageArb, { maxLength: 10 }),
    firstGap: fc.nat({ max: 3 }),
    secondGap: fc.nat({ max: 3 }),
  })
  .chain((scenario) =>
    fc
      .tuple(
        fc.subarray(scenario.prior.universe),
        fc.array(fc.nat({ max: Math.max(0, scenario.prior.universe.length - 1) }), { maxLength: 5 }),
      )
      .chain(([known, duplicates]) => {
        const own = scenario.outbox
          .filter((e) => e.confirmedByHistory)
          .map((e): ChatMessage => ({ ...e.ownMessage, authorId: ME, clientMessageId: e.clientMessageId }));
        const repeated = scenario.prior.universe.length === 0 ? [] : duplicates.map((i) => scenario.prior.universe[i]);
        const pool = [...known, ...repeated, ...own, ...scenario.extraMessages];
        return fc
          .shuffledSubarray(pool, { minLength: pool.length, maxLength: pool.length })
          .map((history) => ({ ...scenario, history }));
      }),
  );

/** Delivery_State of every outbox entry, in order. */
function deliveryStates(state: ChatState): { clientMessageId: string; state: string }[] {
  return state.outbox.map((e) => ({ clientMessageId: e.clientMessageId, state: e.state }));
}

// Feature: session-chat, Property 16: Applying the same Chat_History twice equals applying it once
describe('Property 16: Applying the same Chat_History twice equals applying it once', () => {
  /** **Validates: Requirements 16.10** */
  it('leaves confirmed, Delivery_States and Unread_Count as after one application; same generation resends nothing', () => {
    fc.assert(
      fc.property(idempotenceScenarioArb, (scenario) => {
        // Build the store state before H.
        const setup: ChatAction[] = [];
        scenario.outbox.forEach((entry, i) => {
          setup.push({ kind: 'send', clientMessageId: entry.clientMessageId, text: `draft ${i}`, now: 10 + i });
          if (entry.state === 'failed') setup.push({ kind: 'ackTimeout', clientMessageId: entry.clientMessageId });
          if (entry.state === 'sent') {
            setup.push({
              kind: 'rejected',
              raw: { clientMessageId: entry.clientMessageId, code: 'CHAT_DUPLICATE', message: 'Already sent.' },
              now: 20 + i,
            });
          }
        });
        const priorSteps = scenario.prior.steps;
        setup.push(...deliveryActions(priorSteps));
        if (scenario.readMarker !== null) setup.push({ kind: 'markRead', seq: scenario.readMarker });
        if (!scenario.connectedAtHistory) setup.push({ kind: 'connection', state: 'disconnected', now: 500 });
        const before = apply(connectedState(), setup);

        // Generations: the first application of H passes the gate; the second is the same or later.
        const priorHistories = priorSteps.filter((s) => s.kind === 'history').length;
        const firstGeneration = 1 + priorHistories + scenario.firstGap;
        const secondGeneration = firstGeneration + scenario.secondGap;
        const raw = { messages: scenario.history };

        const once = reduceChat(before, { kind: 'history', raw, generation: firstGeneration, now: 2000 }).state;
        const twice = reduceChat(once, { kind: 'history', raw, generation: secondGeneration, now: 3000 });

        expect(twice.state.confirmed).toEqual(once.confirmed);
        expect(deliveryStates(twice.state)).toEqual(deliveryStates(once));
        expect(selectUnreadCount(twice.state)).toBe(selectUnreadCount(once));

        if (secondGeneration === firstGeneration) {
          expect(twice.effects.filter((e) => e.kind === 'send')).toEqual([]);
          expect(twice.state).toBe(once);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 17
// ---------------------------------------------------------------------------

/**
 * How a command picks a Client_Message_Id: from the scenario's id pool (ids the server can
 * confirm), from the current outbox (an id already held), a fresh UUID, or a non-canonical string.
 */
type P17IdRef =
  | { readonly from: 'pool' | 'outbox'; readonly index: number }
  | { readonly from: 'fresh' | 'nonCanonical'; readonly id: string };

type P17Command =
  | { readonly kind: 'send'; readonly ref: P17IdRef; readonly text: string }
  /** `malformed` selects a corruption that makes the payload fail `isChatMessage`. */
  | { readonly kind: 'added'; readonly index: number; readonly malformed: number | null }
  | {
      readonly kind: 'rejected';
      readonly ref: P17IdRef;
      readonly code: ChatRejection;
      readonly message: string;
      readonly retryAfterMs: number | undefined;
    }
  | { readonly kind: 'rejectedMalformed'; readonly ref: P17IdRef; readonly variant: number }
  | { readonly kind: 'ackTimeout' | 'retry' | 'discard'; readonly ref: P17IdRef }
  | { readonly kind: 'connection'; readonly state: ConnectionState }
  | { readonly kind: 'history'; readonly indices: readonly number[]; readonly malformed: readonly number[] };

const P17_CODES: readonly ChatRejection[] = [
  'CHAT_SESSION_MISMATCH',
  'CHAT_INVALID',
  'CHAT_EMPTY',
  'CHAT_TOO_LONG',
  'CHAT_RATE_LIMITED',
  'CHAT_DUPLICATE',
];

const p17PoolRefArb = fc.nat({ max: 20 }).map((index): P17IdRef => ({ from: 'pool', index }));
const p17OutboxRefArb = fc.nat({ max: 20 }).map((index): P17IdRef => ({ from: 'outbox', index }));
const p17FreshRefArb = uuidArb.map((id): P17IdRef => ({ from: 'fresh', id }));
const p17NonCanonicalRefArb = fc
  .oneof(
    fc.constantFrom('', 'not-a-uuid'),
    uuidArb.map((u) => u.replace(/-/g, '')),
    uuidArb.map((u) => `{${u}}`),
  )
  .map((id): P17IdRef => ({ from: 'nonCanonical', id }));

/** Targets of rejections, timeouts, retries and discards: mostly ids the outbox holds. */
const p17TargetRefArb: fc.Arbitrary<P17IdRef> = fc.oneof(
  { weight: 4, arbitrary: p17OutboxRefArb },
  { weight: 2, arbitrary: p17PoolRefArb },
  { weight: 1, arbitrary: p17FreshRefArb },
);

/** Send ids: pool ids (fresh at first, reused later), fresh ids, held ids and non-canonical ones. */
const p17SendRefArb: fc.Arbitrary<P17IdRef> = fc.oneof(
  { weight: 4, arbitrary: p17PoolRefArb },
  { weight: 2, arbitrary: p17FreshRefArb },
  { weight: 1, arbitrary: p17OutboxRefArb },
  { weight: 1, arbitrary: p17NonCanonicalRefArb },
);

/** Drafts: arbitrary strings plus texts that normalise, and texts that are not sendable. */
const p17TextArb = fc.oneof(
  { weight: 4, arbitrary: fc.string({ minLength: 1, maxLength: 30 }) },
  {
    weight: 2,
    arbitrary: fc.constantFrom('', '   ', '\r\n\t', '  hello  ', 'line one\r\nline two', 'a\u0000b\u202Ec'),
  },
);

const p17CommandArb: fc.Arbitrary<P17Command> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('send' as const), ref: p17SendRefArb, text: p17TextArb }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('added' as const),
      index: fc.nat({ max: 50 }),
      malformed: fc.oneof({ weight: 4, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: fc.nat({ max: 3 }) }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('rejected' as const),
      ref: p17TargetRefArb,
      code: fc.constantFrom(...P17_CODES),
      message: fc.string({ maxLength: 20 }),
      retryAfterMs: fc.option(
        fc.oneof(fc.nat({ max: 60000 }), fc.constantFrom(-1, Number.NaN, Number.POSITIVE_INFINITY)),
        { nil: undefined },
      ),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('rejectedMalformed' as const),
      ref: p17TargetRefArb,
      variant: fc.nat({ max: 5 }),
    }),
  },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constantFrom('ackTimeout' as const, 'retry' as const, 'discard' as const),
      ref: p17TargetRefArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('connection' as const),
      state: fc.constantFrom<ConnectionState>('connected', 'disconnected', 'reconnecting'),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('history' as const),
      indices: fc.array(fc.nat({ max: 50 }), { maxLength: 6 }),
      malformed: fc.array(fc.nat({ max: 50 }), { maxLength: 2 }),
    }),
  },
);

/**
 * An id pool, a server message universe and a command sequence. Each pool id has exactly one own
 * server message (the server never confirms one Client_Message_Id twice for an author, R16.7);
 * other authors' messages may reuse pool ids (R16.11).
 */
const p17ScenarioArb = fc
  .uniqueArray(uuidArb, { minLength: 1, maxLength: 4 })
  .chain((pool) =>
    fc.record({
      pool: fc.constant(pool),
      messages: fc.uniqueArray(chatMessageArb, {
        selector: (m) => m.id,
        minLength: pool.length,
        maxLength: pool.length + 6,
      }),
      shares: fc.array(fc.option(fc.nat({ max: pool.length - 1 }), { nil: null }), { minLength: 6, maxLength: 6 }),
      commands: fc.array(p17CommandArb, { minLength: 1, maxLength: 40 }),
    }),
  )
  .map(({ pool, messages, shares, commands }) => {
    const universe = messages.map((m, i): ChatMessage => {
      if (i < pool.length) return { ...m, authorId: ME, clientMessageId: pool[i] };
      const share = shares[i - pool.length];
      return {
        ...m,
        authorId: m.authorId === ME ? 'user-a' : m.authorId,
        clientMessageId: share === null ? m.clientMessageId : pool[share],
      };
    });
    return { pool, universe, commands };
  });

type P17Scenario = { readonly pool: readonly string[]; readonly universe: readonly ChatMessage[] };

interface P17Entry {
  readonly clientMessageId: string;
  readonly text: string;
  readonly firstSentAt: number;
  readonly state: OutboxState;
  readonly notice: string | null;
}

/** The independent model: what the store must hold after each command. */
interface P17Model {
  readonly connected: boolean;
  readonly historyApplied: boolean;
  readonly generation: number;
  readonly delivered: readonly ChatMessage[];
  readonly outbox: readonly P17Entry[];
  readonly rateLimitUntil: number | null;
}

interface P17Step {
  readonly action: ChatAction;
  readonly next: P17Model;
  /** Send effects expected, in order. */
  readonly sends: readonly ChatMessageSendPayload[];
  /** Entries that change into `failed` from `pending` (each must be announced once). */
  readonly intoFailed: number;
}

function p17Resolve(ref: P17IdRef, scenario: P17Scenario, model: P17Model): string {
  switch (ref.from) {
    case 'pool':
      return scenario.pool[ref.index % scenario.pool.length];
    case 'outbox':
      return model.outbox.length > 0
        ? model.outbox[ref.index % model.outbox.length].clientMessageId
        : scenario.pool[ref.index % scenario.pool.length];
    case 'fresh':
    case 'nonCanonical':
      return ref.id;
  }
}

function p17Payload(entry: P17Entry): ChatMessageSendPayload {
  return { sessionId: SESSION_ID, clientMessageId: entry.clientMessageId, text: entry.text };
}

function p17Update(model: P17Model, id: string, patch: Partial<P17Entry>): readonly P17Entry[] {
  return model.outbox.map((e) => (e.clientMessageId === id ? { ...e, ...patch } : e));
}

/** Rejection payloads that fail validation and so must change nothing (R13). */
function p17MalformedRejection(id: string, variant: number): unknown {
  switch (variant) {
    case 0:
      return { clientMessageId: id, code: 'CHAT_UNKNOWN', message: 'Nope.' };
    case 1:
      return { clientMessageId: id, code: 'CHAT_INVALID' };
    case 2:
      return { code: 'CHAT_DUPLICATE', message: 'Already sent.' };
    case 3:
      return null;
    case 4:
      return [id, 'CHAT_DUPLICATE'];
    default:
      return { clientMessageId: id, code: 42, message: 'Slow down.', retryAfterMs: 1000 };
  }
}

/** Added payloads whose message fails `isChatMessage`. */
function p17MalformedAdded(message: ChatMessage, variant: number): unknown {
  switch (variant) {
    case 0:
      return { message: { ...message, seq: 0 } };
    case 1:
      return { message: { ...message, id: 'not-a-uuid' } };
    case 2:
      return { message: { ...message, clientMessageId: 42 } };
    default:
      return { message: null };
  }
}

function p17Step(model: P17Model, scenario: P17Scenario, command: P17Command, now: number): P17Step {
  const none = { sends: [], intoFailed: 0 };
  switch (command.kind) {
    case 'send': {
      const id = p17Resolve(command.ref, scenario, model);
      const action: ChatAction = { kind: 'send', clientMessageId: id, text: command.text, now };
      const validated = validateChatText(command.text);
      const held =
        model.outbox.some((e) => e.clientMessageId === id) ||
        model.delivered.some((m) => m.authorId === ME && m.clientMessageId === id);
      if (command.ref.from === 'nonCanonical' || held || !validated.ok) return { action, next: model, ...none };
      const entry: P17Entry = { clientMessageId: id, text: validated.text, firstSentAt: now, state: 'pending', notice: null };
      return {
        action,
        next: { ...model, outbox: [...model.outbox, entry] },
        sends: model.connected ? [p17Payload(entry)] : [],
        intoFailed: 0,
      };
    }
    case 'added': {
      const message = scenario.universe[command.index % scenario.universe.length];
      if (command.malformed !== null) {
        return { action: { kind: 'added', raw: p17MalformedAdded(message, command.malformed) }, next: model, ...none };
      }
      const outbox =
        message.authorId === ME ? model.outbox.filter((e) => e.clientMessageId !== message.clientMessageId) : model.outbox;
      return {
        action: { kind: 'added', raw: { message } },
        next: { ...model, delivered: [...model.delivered, message], outbox },
        ...none,
      };
    }
    case 'rejected': {
      const id = p17Resolve(command.ref, scenario, model);
      const raw =
        command.retryAfterMs === undefined
          ? { clientMessageId: id, code: command.code, message: command.message }
          : { clientMessageId: id, code: command.code, message: command.message, retryAfterMs: command.retryAfterMs };
      const action: ChatAction = { kind: 'rejected', raw, now };
      const retryAfter = command.retryAfterMs;
      const rateLimitUntil =
        command.code === 'CHAT_RATE_LIMITED' && retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0
          ? now + retryAfter
          : model.rateLimitUntil;
      const target = model.outbox.find(
        (e) => e.clientMessageId === id && (e.state === 'pending' || e.state === 'failed'),
      );
      if (target === undefined) return { action, next: { ...model, rateLimitUntil }, ...none };
      if (command.code === 'CHAT_DUPLICATE') {
        return {
          action,
          next: { ...model, rateLimitUntil, outbox: p17Update(model, id, { state: 'sent', notice: null }) },
          ...none,
        };
      }
      return {
        action,
        next: { ...model, rateLimitUntil, outbox: p17Update(model, id, { state: 'failed', notice: command.message }) },
        sends: [],
        intoFailed: target.state === 'pending' ? 1 : 0,
      };
    }
    case 'rejectedMalformed': {
      const id = p17Resolve(command.ref, scenario, model);
      return { action: { kind: 'rejected', raw: p17MalformedRejection(id, command.variant), now }, next: model, ...none };
    }
    case 'ackTimeout': {
      const id = p17Resolve(command.ref, scenario, model);
      const action: ChatAction = { kind: 'ackTimeout', clientMessageId: id };
      const target = model.outbox.find((e) => e.clientMessageId === id && e.state === 'pending');
      if (!model.connected || target === undefined) return { action, next: model, ...none };
      return {
        action,
        next: { ...model, outbox: p17Update(model, id, { state: 'failed', notice: CHAT_ACK_TIMEOUT_NOTICE }) },
        sends: [],
        intoFailed: 1,
      };
    }
    case 'retry': {
      const id = p17Resolve(command.ref, scenario, model);
      const action: ChatAction = { kind: 'retry', clientMessageId: id, now };
      const target = model.outbox.find((e) => e.clientMessageId === id && e.state === 'failed');
      if (!model.connected || target === undefined) return { action, next: model, ...none };
      return {
        action,
        next: { ...model, outbox: p17Update(model, id, { state: 'pending', notice: null }) },
        sends: [p17Payload(target)],
        intoFailed: 0,
      };
    }
    case 'discard': {
      const id = p17Resolve(command.ref, scenario, model);
      const action: ChatAction = { kind: 'discard', clientMessageId: id };
      const target = model.outbox.find((e) => e.clientMessageId === id && e.state === 'failed');
      if (target === undefined) return { action, next: model, ...none };
      return { action, next: { ...model, outbox: model.outbox.filter((e) => e !== target) }, ...none };
    }
    case 'connection':
      // Every `now` stays far below CHAT_ACK_TIMEOUT_MS, so leaving `connected` never fails an entry.
      return {
        action: { kind: 'connection', state: command.state, now },
        next: { ...model, connected: command.state === 'connected' },
        ...none,
      };
    case 'history': {
      const valid = command.indices.map((i) => scenario.universe[i % scenario.universe.length]);
      const invalid = command.malformed.map((i) => ({ ...scenario.universe[i % scenario.universe.length], seq: -1 }));
      const generation = model.generation + 1;
      const action: ChatAction = { kind: 'history', raw: { messages: [...invalid, ...valid] }, generation, now };
      const ownIds = new Set(valid.filter((m) => m.authorId === ME).map((m) => m.clientMessageId));
      const outbox = model.outbox.filter((e) => !ownIds.has(e.clientMessageId));
      return {
        action,
        next: {
          ...model,
          generation,
          historyApplied: true,
          delivered: [...model.delivered, ...valid],
          outbox,
        },
        // Only a later (reconnect) history resends the remaining pending entries, in send order.
        sends: model.historyApplied ? outbox.filter((e) => e.state === 'pending').map(p17Payload) : [],
        intoFailed: 0,
      };
    }
  }
}

/** Delivery_State transitions of the design's state machine. */
const P17_ALLOWED_TRANSITIONS: ReadonlySet<string> = new Set([
  'pending>pending',
  'pending>failed',
  'pending>sent',
  'failed>failed',
  'failed>pending',
  'failed>sent',
  'sent>sent',
]);

function p17OutboxView(state: ChatState): P17Entry[] {
  return state.outbox.map((e) => ({
    clientMessageId: e.clientMessageId,
    text: e.text,
    firstSentAt: e.firstSentAt,
    state: e.state,
    notice: e.notice,
  }));
}

// Feature: session-chat, Property 17: Outbox entries follow the delivery state machine
describe('Property 17: Outbox entries follow the delivery state machine', () => {
  /** **Validates: Requirements 5.1, 8.1, 8.2, 8.3, 8.4, 8.7, 8.8, 8.12, 16.12** */
  it('matches the delivery model after every send, arrival, rejection, timeout, retry, discard, connection change and history', () => {
    fc.assert(
      fc.property(p17ScenarioArb, (scenario) => {
        let state = connectedState();
        let model: P17Model = {
          connected: true,
          historyApplied: false,
          generation: 0,
          delivered: [],
          outbox: [],
          rateLimitUntil: null,
        };

        scenario.commands.forEach((command, i) => {
          const now = 100 + 10 * i;
          const step = p17Step(model, scenario, command, now);
          const before = state;
          const { state: after, effects } = reduceChat(before, step.action);
          const expectedConfirmed = referenceConfirmed(step.next.delivered);

          // Only allowed transitions; new entries start `pending` and only a send creates them;
          // removals are an own arrival (any state) or a discard of a `failed` entry.
          for (const entry of after.outbox) {
            const prev = before.outbox.find((e) => e.clientMessageId === entry.clientMessageId);
            if (prev === undefined) {
              expect(command.kind).toBe('send');
              expect(entry.state).toBe('pending');
            } else {
              expect(P17_ALLOWED_TRANSITIONS.has(`${prev.state}>${entry.state}`)).toBe(true);
              expect(entry.firstSentAt).toBe(prev.firstSentAt);
            }
          }
          for (const prev of before.outbox) {
            if (after.outbox.some((e) => e.clientMessageId === prev.clientMessageId)) continue;
            if (command.kind === 'discard') {
              expect(prev.state).toBe('failed');
            } else {
              expect(['added', 'history']).toContain(command.kind);
              expect(
                after.confirmed.some((m) => m.authorId === ME && m.clientMessageId === prev.clientMessageId),
              ).toBe(true);
            }
          }

          // The store equals the model.
          expect(p17OutboxView(after)).toEqual(step.next.outbox);
          expect(after.confirmed).toEqual(expectedConfirmed);
          expect(after.rateLimitUntil).toBe(step.next.rateLimitUntil);

          // Effects: sends carry the entry's id and Normalised_Text; announces mark entries into `failed`.
          expect(effects.flatMap((e) => (e.kind === 'send' ? [e.payload] : []))).toEqual(step.sends);
          const announces = effects.filter((e) => e.kind === 'announce');
          expect(announces).toHaveLength(step.intoFailed);
          for (const a of announces) expect(a).toEqual({ kind: 'announce', text: CHAT_NOT_SENT_ANNOUNCEMENT });

          // entries(): confirmed by seq, then outbox in first-send order, one entry per own id (R16.12).
          const list = selectEntries(after);
          expect(list.slice(0, expectedConfirmed.length).map((e) => (e.kind === 'confirmed' ? e.message : null))).toEqual(
            expectedConfirmed,
          );
          expect(list.slice(expectedConfirmed.length).map((e) => (e.kind === 'outbox' ? e.entry.clientMessageId : null))).toEqual(
            step.next.outbox.map((e) => e.clientMessageId),
          );
          const ownIds = list.flatMap((e) =>
            e.kind === 'outbox' ? [e.entry.clientMessageId] : e.message.authorId === ME ? [e.message.clientMessageId] : [],
          );
          expect(new Set(ownIds).size).toBe(ownIds.length);

          state = after;
          model = step.next;
        });
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 18
// ---------------------------------------------------------------------------

/** The acknowledgement timeout as stated in R8.5 and the design (10,000 ms). */
const REF_ACK_TIMEOUT_MS = 10_000;

const P18_FIRST_HISTORY_AT = 50;
const P18_DISCONNECT_AT = 200;
const P18_RECONNECT_AT = 300;
const P18_HISTORY_AT = 400;

/**
 * One outbox entry of the scenario: its Delivery_State before the reconnect, whether it was sent
 * while offline (only for `pending`; held without a frame), and whether the reconnect history
 * carries its own confirmed copy.
 */
interface P18PlanEntry {
  readonly clientMessageId: string;
  readonly state: PlannedOutboxState;
  readonly offline: boolean;
  readonly confirmed: boolean;
  readonly text: string;
}

/** Sendable drafts, including ones whose Normalised_Text differs from the draft. */
const p18DraftArb = fc
  .oneof(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.constantFrom('  hello  ', 'line one\r\nline two', '\tTabbed\t', 'a\u0000b\u202Ec'),
  )
  .filter((s) => validateChatText(s).ok);

const p18ScenarioArb = fc
  .record({
    plan: fc.uniqueArray(
      fc.record({
        clientMessageId: uuidArb,
        state: fc.constantFrom<PlannedOutboxState>('pending', 'failed', 'sent'),
        offline: fc.boolean(),
        confirmed: fc.boolean(),
        text: p18DraftArb,
      }),
      { selector: (e) => e.clientMessageId, minLength: 1, maxLength: 6 },
    ),
    // Distinct ids across every message; the first 6 are templates for own confirmations.
    messages: fc.uniqueArray(chatMessageArb, { selector: (m) => m.id, minLength: 6, maxLength: 36 }),
    // Whether each other author's message is in the first history (else only in the reconnect one).
    inFirst: fc.array(fc.boolean(), { minLength: 30, maxLength: 30 }),
    // Whether an earlier message is repeated in the reconnect history.
    repeatedInReconnect: fc.array(fc.boolean(), { minLength: 30, maxLength: 30 }),
    // Other authors may reuse an outbox Client_Message_Id (R16.11); it must not confirm the entry.
    shareId: fc.array(fc.option(fc.nat({ max: 5 }), { nil: null, freq: 4 }), { minLength: 30, maxLength: 30 }),
    extraDuplicates: fc.array(fc.nat({ max: 100 }), { maxLength: 5 }),
    offlineState: fc.constantFrom<ConnectionState>('disconnected', 'reconnecting'),
    viaReconnecting: fc.boolean(),
    firstGeneration: fc.nat({ max: 5 }),
    gap: fc.integer({ min: 1, max: 4 }),
  })
  .chain((s) => {
    const plan: P18PlanEntry[] = s.plan.map((e) => ({ ...e, offline: e.state === 'pending' && e.offline }));
    const own = plan.flatMap((e, i): ChatMessage[] =>
      e.confirmed ? [{ ...s.messages[i], authorId: ME, clientMessageId: e.clientMessageId }] : [],
    );
    const others = s.messages.slice(6).map((m, i): ChatMessage => {
      const share = s.shareId[i];
      return {
        ...m,
        authorId: m.authorId === ME ? 'user-a' : m.authorId,
        clientMessageId: share === null ? m.clientMessageId : plan[share % plan.length].clientMessageId,
      };
    });
    const first = others.filter((_, i) => s.inFirst[i]);
    const newOthers = others.filter((_, i) => !s.inFirst[i]);
    const repeated = first.filter((_, i) => s.repeatedInReconnect[i]);
    const pool = [...repeated, ...newOthers, ...own];
    const duplicates = pool.length === 0 ? [] : s.extraDuplicates.map((i) => pool[i % pool.length]);
    const all = [...pool, ...duplicates];
    return fc
      .shuffledSubarray(all, { minLength: all.length, maxLength: all.length })
      .map((reconnect) => ({ ...s, plan, first, own, reconnect }));
  });

// Feature: session-chat, Property 18: Reconnect merge resends each pending message once
describe('Property 18: Reconnect merge resends each pending message once', () => {
  /** **Validates: Requirements 9.4, 9.5, 9.6, 9.7** */
  it('merges the reconnect history, replaces confirmed own entries, resends each pending once and keeps failed ones', () => {
    fc.assert(
      fc.property(p18ScenarioArb, (s) => {
        // First history: applies without resend.
        const setup: ChatAction[] = [
          { kind: 'history', raw: { messages: s.first }, generation: s.firstGeneration, now: P18_FIRST_HISTORY_AT },
        ];
        // Connected sends (later failed by timeout or marked sent by CHAT_DUPLICATE), then the
        // disconnect, offline sends (held pending) and the reconnect.
        const online = s.plan.filter((e) => !e.offline);
        const offline = s.plan.filter((e) => e.offline);
        online.forEach((e, i) => {
          setup.push({ kind: 'send', clientMessageId: e.clientMessageId, text: e.text, now: 100 + i });
          if (e.state === 'failed') setup.push({ kind: 'ackTimeout', clientMessageId: e.clientMessageId });
          if (e.state === 'sent') {
            setup.push({
              kind: 'rejected',
              raw: { clientMessageId: e.clientMessageId, code: 'CHAT_DUPLICATE', message: 'Already sent.' },
              now: 150 + i,
            });
          }
        });
        setup.push({ kind: 'connection', state: s.offlineState, now: P18_DISCONNECT_AT });
        offline.forEach((e, i) => {
          setup.push({ kind: 'send', clientMessageId: e.clientMessageId, text: e.text, now: 250 + i });
        });
        if (s.viaReconnecting && s.offlineState === 'disconnected') {
          setup.push({ kind: 'connection', state: 'reconnecting', now: 280 });
        }
        setup.push({ kind: 'connection', state: 'connected', now: P18_RECONNECT_AT });
        const before = apply(connectedState(), setup);

        // First-send order and the Delivery_States the setup produced.
        const sendOrder = [...online, ...offline];
        expect(before.historyGeneration).toBe(s.firstGeneration);
        expect(before.outbox.map((e) => [e.clientMessageId, e.state])).toEqual(
          sendOrder.map((e) => [e.clientMessageId, e.state]),
        );

        const generation = s.firstGeneration + s.gap;
        const raw = { messages: s.reconnect };
        const { state: after, effects } = reduceChat(before, {
          kind: 'history',
          raw,
          generation,
          now: P18_HISTORY_AT,
        });

        // R9.4: confirmed = history messages plus earlier ones, by seq; then the remaining outbox
        // entries in first-send order.
        const expectedConfirmed = referenceConfirmed([...s.first, ...s.reconnect]);
        expect(after.confirmed).toEqual(expectedConfirmed);
        for (const m of s.reconnect) expect(after.confirmed.some((c) => c.id === m.id)).toBe(true);
        const remaining = sendOrder.filter((e) => !e.confirmed);
        const list = selectEntries(after);
        expect(list.map((e) => (e.kind === 'confirmed' ? `c:${e.message.id}` : `o:${e.entry.clientMessageId}`))).toEqual([
          ...expectedConfirmed.map((m) => `c:${m.id}`),
          ...remaining.map((e) => `o:${e.clientMessageId}`),
        ]);

        // R9.5: each confirmed own copy replaces its outbox entry; one entry per own id.
        for (const m of s.own) {
          expect(after.outbox.some((e) => e.clientMessageId === m.clientMessageId)).toBe(false);
          const entry = list.find((e) => e.kind === 'confirmed' && e.message.id === m.id);
          expect(entry).toEqual({ key: m.id, kind: 'confirmed', message: m, own: true });
        }
        const ownIds = list.flatMap((e) =>
          e.kind === 'outbox' ? [e.entry.clientMessageId] : e.own ? [e.message.clientMessageId] : [],
        );
        expect(new Set(ownIds).size).toBe(ownIds.length);

        // R9.6: each remaining pending entry is resent once, in first-send order, with its
        // original id and Normalised_Text and a fresh full timer; nothing else is sent.
        const resent = remaining.filter((e) => e.state === 'pending');
        const normalised = (text: string): string => {
          const v = validateChatText(text);
          if (!v.ok) throw new Error('generated draft is not sendable');
          return v.text;
        };
        expect(effects.flatMap((e) => (e.kind === 'send' ? [e.payload] : []))).toEqual(
          resent.map((e) => ({ sessionId: SESSION_ID, clientMessageId: e.clientMessageId, text: normalised(e.text) })),
        );
        expect(effects.filter((e) => e.kind === 'startAckTimer')).toEqual(
          resent.map((e) => ({ kind: 'startAckTimer', clientMessageId: e.clientMessageId, ms: REF_ACK_TIMEOUT_MS })),
        );
        for (const e of resent) {
          const entry = after.outbox.find((o) => o.clientMessageId === e.clientMessageId);
          expect(entry?.state).toBe('pending');
          expect(entry?.text).toBe(normalised(e.text));
          expect(entry?.ackElapsedMs).toBe(0);
          expect(entry?.segmentStart).toBe(P18_HISTORY_AT);
        }

        // R9.7: failed entries stay failed with their notice and are not resent; sent entries stay.
        for (const e of remaining.filter((r) => r.state !== 'pending')) {
          const prev = before.outbox.find((o) => o.clientMessageId === e.clientMessageId);
          const entry = after.outbox.find((o) => o.clientMessageId === e.clientMessageId);
          expect(entry).toEqual(prev);
          expect(entry?.state).toBe(e.state);
          if (e.state === 'failed') expect(entry?.notice).toBe(CHAT_ACK_TIMEOUT_NOTICE);
        }

        // A second history at the same generation is ignored: no sends, state unchanged.
        for (const again of [raw, { messages: s.first }]) {
          const repeat = reduceChat(after, { kind: 'history', raw: again, generation, now: P18_HISTORY_AT + 100 });
          expect(repeat.effects).toEqual([]);
          expect(repeat.state).toBe(after);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 19
// ---------------------------------------------------------------------------

type P19Command =
  | { readonly kind: 'wait'; readonly ms: number }
  | { readonly kind: 'connection'; readonly state: ConnectionState }
  | { readonly kind: 'send' }
  /** A reconnect Chat_History (higher generation), delivered only while connected. */
  | { readonly kind: 'history' }
  | { readonly kind: 'retry'; readonly index: number };

/** Short waits, waits at the 10,000 ms boundary, and long waits (long disconnects). */
const p19WaitArb = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 0, max: 3000 }) },
  { weight: 2, arbitrary: fc.constantFrom(1, 4999, 5000, 9999, 10_000, 10_001) },
  { weight: 1, arbitrary: fc.integer({ min: 10_000, max: 120_000 }) },
);

const p19CommandArb: fc.Arbitrary<P19Command> = fc.oneof(
  { weight: 6, arbitrary: p19WaitArb.map((ms): P19Command => ({ kind: 'wait', ms })) },
  {
    weight: 3,
    arbitrary: fc
      .constantFrom<ConnectionState>('connected', 'disconnected', 'reconnecting')
      .map((state): P19Command => ({ kind: 'connection', state })),
  },
  { weight: 2, arbitrary: fc.constant<P19Command>({ kind: 'send' }) },
  { weight: 1, arbitrary: fc.constant<P19Command>({ kind: 'history' }) },
  { weight: 2, arbitrary: fc.nat({ max: 5 }).map((index): P19Command => ({ kind: 'retry', index })) },
);

const p19ScenarioArb = fc.record({
  ids: fc.uniqueArray(uuidArb, { minLength: 1, maxLength: 5 }),
  commands: fc.array(p19CommandArb, { minLength: 1, maxLength: 40 }),
});

interface P19Failure {
  readonly clientMessageId: string;
  readonly at: number;
}

/**
 * Runs the reducer and its timer effects the way `ChatStore` does: one punctual timer per id,
 * a start replaces the running timer of that id, a firing dispatches `ackTimeout` at its deadline.
 * Records each `pending → failed` transition with the virtual time it happened at.
 */
class P19Driver {
  now = 0;
  generation = 1;
  readonly timers = new Map<string, number>();
  readonly failures: P19Failure[] = [];

  state: ChatState;

  constructor(state: ChatState) {
    this.state = state;
  }

  dispatch(action: ChatAction): void {
    const before = this.state;
    const { state, effects } = reduceChat(before, action);
    this.state = state;
    for (const effect of effects) {
      if (effect.kind === 'startAckTimer') this.timers.set(effect.clientMessageId, this.now + effect.ms);
      if (effect.kind === 'cancelAckTimer') this.timers.delete(effect.clientMessageId);
    }
    for (const entry of state.outbox) {
      const prev = before.outbox.find((e) => e.clientMessageId === entry.clientMessageId);
      if (prev?.state === 'pending' && entry.state === 'failed') {
        this.failures.push({ clientMessageId: entry.clientMessageId, at: this.now });
      }
    }
  }

  /** Advances the clock by `ms`, firing every timer due on the way at its deadline. */
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      let due: [string, number] | null = null;
      for (const timer of this.timers) {
        if (timer[1] <= until && (due === null || timer[1] < due[1])) due = timer;
      }
      if (due === null) break;
      this.timers.delete(due[0]);
      this.now = due[1];
      this.dispatch({ kind: 'ackTimeout', clientMessageId: due[0] });
    }
    this.now = until;
  }
}

interface P19ModelEntry {
  readonly clientMessageId: string;
  state: 'pending' | 'failed';
  /** Connected time since the most recent send or resend. */
  elapsedMs: number;
}

/** The independent model: connected time accumulates per pending entry; 10,000 ms fails it. */
class P19Model {
  connected = true;
  readonly entries: P19ModelEntry[] = [];
  readonly failures: P19Failure[] = [];

  wait(now: number, ms: number): void {
    if (!this.connected) return;
    for (const entry of this.entries) {
      if (entry.state !== 'pending') continue;
      const remaining = REF_ACK_TIMEOUT_MS - entry.elapsedMs;
      if (ms >= remaining) {
        entry.state = 'failed';
        entry.elapsedMs = REF_ACK_TIMEOUT_MS;
        this.failures.push({ clientMessageId: entry.clientMessageId, at: now + remaining });
      } else {
        entry.elapsedMs += ms;
      }
    }
  }
}

function p19SortFailures(failures: readonly P19Failure[]): P19Failure[] {
  return [...failures].sort((a, b) =>
    a.at !== b.at ? a.at - b.at : a.clientMessageId < b.clientMessageId ? -1 : a.clientMessageId > b.clientMessageId ? 1 : 0,
  );
}

function p19Check(driver: P19Driver, model: P19Model): void {
  expect(driver.state.outbox.map((e) => [e.clientMessageId, e.state])).toEqual(
    model.entries.map((e) => [e.clientMessageId, e.state]),
  );
  expect(p19SortFailures(driver.failures)).toEqual(p19SortFailures(model.failures));
  // Timers run exactly for the pending entries while connected and never while not connected.
  const expectedTimers = model.connected
    ? model.entries.filter((e) => e.state === 'pending').map((e) => e.clientMessageId)
    : [];
  expect([...driver.timers.keys()].sort()).toEqual([...expectedTimers].sort());
}

// Feature: session-chat, Property 19: The acknowledgement timer counts only connected time
describe('Property 19: The acknowledgement timer counts only connected time', () => {
  /** **Validates: Requirements 8.5, 9.3** */
  it('fails a pending entry exactly when its connected time since the last (re)send reaches 10,000 ms', () => {
    fc.assert(
      fc.property(p19ScenarioArb, ({ ids, commands }) => {
        // Connected, with the first Chat_History applied so later histories are reconnect merges.
        const driver = new P19Driver(connectedState());
        driver.dispatch({ kind: 'history', raw: { messages: [] }, generation: driver.generation, now: 0 });
        const model = new P19Model();
        let nextId = 0;

        const run = (command: P19Command): void => {
          switch (command.kind) {
            case 'wait':
              model.wait(driver.now, command.ms);
              driver.advance(command.ms);
              return;
            case 'connection':
              model.connected = command.state === 'connected';
              driver.dispatch({ kind: 'connection', state: command.state, now: driver.now });
              return;
            case 'send': {
              if (nextId >= ids.length) return;
              const clientMessageId = ids[nextId];
              driver.dispatch({ kind: 'send', clientMessageId, text: `draft ${nextId}`, now: driver.now });
              nextId++;
              model.entries.push({ clientMessageId, state: 'pending', elapsedMs: 0 });
              return;
            }
            case 'history':
              if (!model.connected) return;
              driver.generation++;
              driver.dispatch({ kind: 'history', raw: { messages: [] }, generation: driver.generation, now: driver.now });
              for (const entry of model.entries) if (entry.state === 'pending') entry.elapsedMs = 0;
              return;
            case 'retry': {
              if (model.entries.length === 0) return;
              const entry = model.entries[command.index % model.entries.length];
              driver.dispatch({ kind: 'retry', clientMessageId: entry.clientMessageId, now: driver.now });
              if (model.connected && entry.state === 'failed') {
                entry.state = 'pending';
                entry.elapsedMs = 0;
              }
              return;
            }
          }
        };

        for (const command of commands) {
          run(command);
          p19Check(driver, model);
        }

        // Finally 10,000 ms of connected time: every remaining pending entry fails on its deadline.
        run({ kind: 'connection', state: 'connected' });
        p19Check(driver, model);
        run({ kind: 'wait', ms: REF_ACK_TIMEOUT_MS });
        p19Check(driver, model);
        expect(driver.state.outbox.every((e) => e.state === 'failed')).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 20
// ---------------------------------------------------------------------------

/**
 * Property 20 drives the real `ChatStore` service, because Panel_State, visibility and the
 * Read_Marker write live there. The transport, clock, storage and document are test doubles.
 */
class P20Transport implements ChatTransport {
  readonly boardKind = 'poker' as const;
  readonly connectionState = signal<ConnectionState>('connected');
  readonly connectionGeneration = signal(1);
  readonly participants = signal<readonly User[]>([]);
  readonly currentUserId = signal<string | null>(ME);
  readonly added$ = new Subject<unknown>();
  readonly history$ = new Subject<unknown>();
  readonly rejected$ = new Subject<unknown>();
  send(_payload: ChatMessageSendPayload): boolean {
    return true;
  }
}

/** A clock whose timers never fire: no acknowledgement or history timeout happens in Property 20. */
class P20Timers implements ChatTimers {
  private nextHandle = 1;
  now(): number {
    return 1_000_000;
  }
  setTimeout(_callback: () => void, _ms: number): number {
    return this.nextHandle++;
  }
  clearTimeout(_handle: number): void {
    // Nothing is scheduled.
  }
}

/** The part of `Document` the store reads: `visibilityState` and `visibilitychange`. */
class P20Document extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';

  setVisible(visible: boolean): void {
    this.visibilityState = visible ? 'visible' : 'hidden';
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

type P20Command =
  | { readonly kind: 'added'; readonly index: number }
  /** `complete`: the history also holds every message delivered so far, as a real server's does. */
  | { readonly kind: 'history'; readonly indices: readonly number[]; readonly complete: boolean }
  | { readonly kind: 'send'; readonly text: string }
  | { readonly kind: 'panel'; readonly state: ChatPanelState }
  | { readonly kind: 'visibility'; readonly visible: boolean };

/** A stored value for the session's Read_Marker key: a valid marker, junk (no marker), or absent. */
type P20Stored = { readonly raw: string; readonly marker: number | null } | null;

const p20StoredArb: fc.Arbitrary<P20Stored> = fc.oneof(
  { weight: 2, arbitrary: fc.constant<P20Stored>(null) },
  {
    weight: 3,
    arbitrary: fc.integer({ min: 1, max: 320 }).map((n): P20Stored => ({ raw: String(n), marker: n })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom('', '0', '-5', '007', '1.5', ' 12', 'abc', '1e3')
      .map((raw): P20Stored => ({ raw, marker: null })),
  },
);

/** Small seqs so stored markers fall above, inside and below the delivered range; ties occur. */
const p20MessageArb: fc.Arbitrary<ChatMessage> = fc
  .tuple(chatMessageArb, fc.integer({ min: 1, max: 300 }))
  .map(([m, seq]) => ({ ...m, seq }));

const p20CommandArb: fc.Arbitrary<P20Command> = fc.oneof(
  { weight: 5, arbitrary: fc.nat({ max: 40 }).map((index): P20Command => ({ kind: 'added', index })) },
  {
    weight: 2,
    arbitrary: fc
      .record({ indices: fc.array(fc.nat({ max: 40 }), { maxLength: 8 }), complete: fc.boolean() })
      .map(({ indices, complete }): P20Command => ({ kind: 'history', indices, complete })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom('hello', '  spaced  ', 'line one\r\nline two')
      .map((text): P20Command => ({ kind: 'send', text })),
  },
  {
    weight: 2,
    arbitrary: fc
      .constantFrom<ChatPanelState>('closed', 'open', 'minimized')
      .map((state): P20Command => ({ kind: 'panel', state })),
  },
  { weight: 2, arbitrary: fc.boolean().map((visible): P20Command => ({ kind: 'visibility', visible })) },
);

/**
 * Universes stay below the 200-message limit, so no message is evicted (the limit is covered by
 * Property 15) and the count changes only through the rules under test.
 */
const p20ScenarioArb = fc.record({
  universe: fc.uniqueArray(p20MessageArb, { selector: (m) => m.id, minLength: 1, maxLength: 40 }),
  stored: p20StoredArb,
  initialPanel: fc.constantFrom<ChatPanelState>('closed', 'open', 'minimized'),
  initiallyVisible: fc.boolean(),
  commands: fc.array(p20CommandArb, { minLength: 1, maxLength: 30 }),
});

/** Non-own messages above the marker, counted once per id. */
function p20Unread(messages: readonly ChatMessage[], marker: number | null): number {
  const ids = new Set<string>();
  for (const m of messages) if (m.authorId !== ME && m.seq > (marker ?? 0)) ids.add(m.id);
  return ids.size;
}

// Feature: session-chat, Property 20: The Unread_Count matches its definition
describe('Property 20: The Unread_Count matches its definition', () => {
  /** **Validates: Requirements 2.4, 2.5, 2.6, 2.7, 2.8** */
  it('counts non-own confirmed messages above a never-decreasing Read_Marker that catches up while open and visible', () => {
    const parent = TestBed.inject(EnvironmentInjector);
    const key = readMarkerKey('poker', SESSION_ID);

    fc.assert(
      fc.property(p20ScenarioArb, (s) => {
        const transport = new P20Transport();
        const doc = new P20Document();
        doc.visibilityState = s.initiallyVisible ? 'visible' : 'hidden';
        const storage = new Map<string, string>();
        if (s.stored !== null) storage.set(key, s.stored.raw);
        const markers = new ReadMarkerStore(() => ({
          getItem: (k: string) => storage.get(k) ?? null,
          setItem: (k: string, v: string) => void storage.set(k, v),
        }));
        const injector = createEnvironmentInjector(
          [
            ChatStore,
            { provide: CHAT_TRANSPORT, useValue: transport },
            { provide: CHAT_TIMERS, useValue: new P20Timers() },
            { provide: CHAT_READ_MARKER_STORE, useValue: markers },
            { provide: DOCUMENT, useValue: doc },
          ],
          parent,
        );

        try {
          const store = injector.get(ChatStore);
          store.panelState.set(s.initialPanel);
          store.reset(SESSION_ID);
          TestBed.tick();

          // The independent model.
          const delivered: ChatMessage[] = [];
          let marker: number | null = s.stored?.marker ?? null;
          let panel: ChatPanelState = s.initialPanel;
          let visible = s.initiallyVisible;
          let generation = 1;

          const readable = (): boolean => panel === 'open' && visible;
          const settleModel = (): ChatMessage[] => {
            const confirmed = referenceConfirmed(delivered);
            const last = confirmed[confirmed.length - 1];
            if (readable() && last !== undefined) marker = Math.max(marker ?? 0, last.seq);
            return confirmed;
          };

          const check = (confirmed: readonly ChatMessage[]): void => {
            expect(store.unreadCount()).toBe(p20Unread(confirmed, marker));
            expect(markers.read('poker', SESSION_ID)).toBe(marker);
            const last = confirmed[confirmed.length - 1];
            if (readable() && last !== undefined) {
              // R2.4: the greater of the current marker and the highest confirmed seq, so nothing is unread.
              expect(markers.read('poker', SESSION_ID) ?? 0).toBeGreaterThanOrEqual(last.seq);
              expect(store.unreadCount()).toBe(0);
            }
          };

          check(settleModel());

          for (const command of s.commands) {
            const unreadBefore = store.unreadCount();
            const markerBefore = markers.read('poker', SESSION_ID) ?? 0;
            const heldIds = new Set(referenceConfirmed(delivered).map((m) => m.id));
            const wasReadable = readable();
            const modelMarkerBefore = marker;

            switch (command.kind) {
              case 'added': {
                const message = s.universe[command.index % s.universe.length];
                transport.added$.next({ message });
                delivered.push(message);
                break;
              }
              case 'history': {
                const picked = command.indices.map((i) => s.universe[i % s.universe.length]);
                const messages = command.complete ? [...delivered, ...picked] : picked;
                transport.connectionGeneration.set(++generation);
                transport.history$.next({ messages });
                delivered.push(...messages);
                break;
              }
              case 'send':
                store.draft.set(command.text);
                store.sendDraft();
                break;
              case 'panel':
                store.panelState.set(command.state);
                panel = command.state;
                break;
              case 'visibility':
                doc.setVisible(command.visible);
                visible = command.visible;
                break;
            }
            TestBed.tick();

            const confirmed = settleModel();
            check(confirmed);

            // R2.4: the Read_Marker never decreases.
            expect(markers.read('poker', SESSION_ID) ?? 0).toBeGreaterThanOrEqual(markerBefore);

            if (command.kind === 'added') {
              const message = s.universe[command.index % s.universe.length];
              if (message.authorId === ME) {
                // R2.6: an Own_Message never changes the count.
                expect(store.unreadCount()).toBe(unreadBefore);
              } else if (!wasReadable && !heldIds.has(message.id) && message.seq > (modelMarkerBefore ?? 0)) {
                // R2.5: a new non-own message while closed, minimized or hidden counts exactly once.
                expect(store.unreadCount()).toBe(unreadBefore + 1);
              } else if (heldIds.has(message.id)) {
                // A duplicate id changes nothing.
                expect(store.unreadCount()).toBe(unreadBefore);
              }
            }
            if (command.kind === 'send') {
              // R2.6: a pending Own_Message never changes the count.
              expect(store.unreadCount()).toBe(unreadBefore);
            }
            if (command.kind === 'history' && command.complete && !wasReadable) {
              // R2.7, R2.8: a history holding every message sets the count from its own messages
              // and the stored marker (or none), replacing the earlier count.
              const picked = command.indices.map((i) => s.universe[i % s.universe.length]);
              expect(store.unreadCount()).toBe(p20Unread([...delivered, ...picked], modelMarkerBefore));
            }
          }
        } finally {
          injector.destroy();
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 21
// ---------------------------------------------------------------------------

function p21Omit(message: ChatMessage, field: keyof ChatMessage): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...message };
  delete copy[field];
  return copy;
}

/** `sentAt` values in another format, naming an impossible date, or not a string (R5.14). */
const P21_BAD_SENT_AT: readonly unknown[] = [
  '2024-13-01T00:00:00.000Z',
  '2023-02-29T12:00:00.000Z',
  '2024-02-30T00:00:00.000Z',
  '2024-01-01T24:00:00.000Z',
  '2024-01-01T00:00:60.000Z',
  '2024-01-01T00:00:00Z',
  '2024-01-01',
  '2024-01-01T00:00:00.000+00:00',
  ' 2024-01-01T00:00:00.000Z',
  1_700_000_000_000,
  null,
];

/** Turns a valid message into a value `isChatMessage` rejects: one field out of constraint, or not an object. */
const P21_CORRUPTIONS: readonly ((m: ChatMessage) => unknown)[] = [
  (m) => ({ ...m, id: 'not-a-uuid' }),
  (m) => ({ ...m, id: `{${m.id}}` }),
  (m) => ({ ...m, id: m.id.replace(/-/g, '') }),
  (m) => p21Omit(m, 'id'),
  (m) => ({ ...m, seq: 0 }),
  (m) => ({ ...m, seq: -m.seq }),
  // Kept small: above 2^52 adding 0.5 rounds back to an integer.
  (m) => ({ ...m, seq: (m.seq % 1000) + 0.5 }),
  (m) => ({ ...m, seq: Number.MAX_SAFE_INTEGER + 1 }),
  (m) => ({ ...m, seq: Number.NaN }),
  (m) => ({ ...m, seq: String(m.seq) }),
  (m) => p21Omit(m, 'seq'),
  (m) => ({ ...m, clientMessageId: 'abc' }),
  (m) => ({ ...m, clientMessageId: 42 }),
  (m) => p21Omit(m, 'clientMessageId'),
  (m) => ({ ...m, authorId: '' }),
  (m) => ({ ...m, authorId: 7 }),
  (m) => p21Omit(m, 'authorId'),
  (m) => ({ ...m, authorName: null }),
  (m) => p21Omit(m, 'authorName'),
  (m) => ({ ...m, text: 42 }),
  (m) => p21Omit(m, 'text'),
  ...P21_BAD_SENT_AT.map((sentAt) => (m: ChatMessage): unknown => ({ ...m, sentAt })),
  (m) => p21Omit(m, 'sentAt'),
  () => null,
  () => undefined,
  (m) => [m],
  (m) => JSON.stringify(m),
  (m) => m.seq,
  () => true,
];

/** `messages` values that are not arrays, and raw payloads that hold no `messages` at all (R13.13). */
const P21_NON_ARRAY_HISTORIES: readonly ((sample: readonly ChatMessage[]) => unknown)[] = [
  () => ({}),
  () => ({ messages: null }),
  () => ({ messages: undefined }),
  (sample) => ({ messages: sample[0] ?? {} }),
  (sample) => ({ messages: { ...Object.fromEntries(sample.map((m, i) => [String(i), m])), length: sample.length } }),
  (sample) => ({ messages: JSON.stringify(sample) }),
  (sample) => ({ messages: sample.length }),
  (sample) => ({ messages: new Set(sample) }),
  () => ({ messages: true }),
  (sample) => ({ sessionId: SESSION_ID, message: sample }),
  () => null,
  (sample) => [...sample],
  (sample) => JSON.stringify({ messages: sample }),
  () => 42,
];

/**
 * A malformed value: a corruption of a template message, optionally first turned into an own
 * message carrying an outbox entry's Client_Message_Id (it must not confirm that entry). `at` is
 * where it is inserted among the valid entries of a history.
 */
const p21BadArb = fc.record({
  template: fc.nat(),
  ownOutbox: fc.option(fc.nat(), { nil: null }),
  corruption: fc.nat({ max: P21_CORRUPTIONS.length - 1 }),
  at: fc.nat(),
});

type P21Bad = typeof p21BadArb extends fc.Arbitrary<infer T> ? T : never;

/** Added payloads whose `message` fails `isChatMessage`: wrapped bad values, or raws without a message. */
function p21AddedRaw(variant: number, bad: unknown, template: ChatMessage): unknown {
  switch (variant % 6) {
    case 0:
      return { message: bad };
    case 1:
      return { sessionId: SESSION_ID, message: bad };
    case 2:
      return {};
    case 3:
      return null;
    case 4:
      return [{ message: template }];
    default:
      return JSON.stringify({ message: template });
  }
}

const p21ScenarioArb = fc.record({
  prior: universeAndDeliveryArb,
  outbox: idempotenceOutboxArb,
  readMarker: fc.option(fc.integer({ min: 1, max: 400 }), { nil: null }),
  connected: fc.boolean(),
  extra: fc.array(chatMessageArb, { minLength: 1, maxLength: 8 }),
  extraInHistory: fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
  priorPicks: fc.array(fc.nat(), { maxLength: 6 }),
  gap: fc.nat({ max: 3 }),
  badAdded: fc.array(fc.record({ bad: p21BadArb, variant: fc.nat({ max: 5 }) }), { minLength: 1, maxLength: 4 }),
  nonArray: fc.array(fc.nat({ max: P21_NON_ARRAY_HISTORIES.length - 1 }), { minLength: 1, maxLength: 3 }),
  badHistory: fc.array(p21BadArb, { minLength: 1, maxLength: 6 }),
});

// Feature: session-chat, Property 21: Malformed inbound events change nothing they should not
describe('Property 21: Malformed inbound events change nothing they should not', () => {
  /** **Validates: Requirements 5.14, 13.12, 13.13** */
  it('ignores bad added events and non-array histories, and applies a mixed history as its valid entries alone', () => {
    fc.assert(
      fc.property(p21ScenarioArb, (s) => {
        // Any store state: outbox entries in every Delivery_State, earlier deliveries (with or
        // without an applied Chat_History), a Read_Marker and a Connection_State.
        const setup: ChatAction[] = [];
        s.outbox.forEach((entry, i) => {
          setup.push({ kind: 'send', clientMessageId: entry.clientMessageId, text: `draft ${i}`, now: 10 + i });
          if (entry.state === 'failed') setup.push({ kind: 'ackTimeout', clientMessageId: entry.clientMessageId });
          if (entry.state === 'sent') {
            setup.push({
              kind: 'rejected',
              raw: { clientMessageId: entry.clientMessageId, code: 'CHAT_DUPLICATE', message: 'Already sent.' },
              now: 20 + i,
            });
          }
        });
        setup.push(...deliveryActions(s.prior.steps));
        if (s.readMarker !== null) setup.push({ kind: 'markRead', seq: s.readMarker });
        if (!s.connected) setup.push({ kind: 'connection', state: 'disconnected', now: 500 });
        const before = apply(connectedState(), setup);
        expect(before.outbox).toHaveLength(s.outbox.length);

        // The valid entries of the history: own confirmations of outbox entries, repeats of earlier
        // messages and new messages.
        const universe = s.prior.universe;
        const valid: ChatMessage[] = [
          ...s.outbox
            .filter((e) => e.confirmedByHistory)
            .map((e): ChatMessage => ({ ...e.ownMessage, authorId: ME, clientMessageId: e.clientMessageId })),
          ...(universe.length === 0 ? [] : s.priorPicks.map((i) => universe[i % universe.length])),
          ...s.extra.filter((_, i) => s.extraInHistory[i]),
        ];
        const templates = [...universe, ...valid, ...s.extra];
        const corrupt = (bad: P21Bad): { readonly template: ChatMessage; readonly value: unknown } => {
          let template = templates[bad.template % templates.length];
          if (bad.ownOutbox !== null && before.outbox.length > 0) {
            const target = before.outbox[bad.ownOutbox % before.outbox.length];
            template = { ...template, authorId: ME, clientMessageId: target.clientMessageId };
          }
          const value = P21_CORRUPTIONS[bad.corruption](template);
          expect(isChatMessage(value)).toBe(false);
          return { template, value };
        };

        // R13.12, R5.14: an added event whose message fails `isChatMessage` changes nothing.
        for (const { bad, variant } of s.badAdded) {
          const { template, value } = corrupt(bad);
          const result = reduceChat(before, { kind: 'added', raw: p21AddedRaw(variant, value, template) });
          expect(result.state).toBe(before);
          expect(result.effects).toEqual([]);
          expect(selectUnreadCount(result.state)).toBe(selectUnreadCount(before));
        }

        // Generation of the test history: equal to the applied one (gate closed) or above it.
        const generation = (before.historyGeneration ?? 0) + s.gap;
        const gateOpen = before.historyGeneration === null || generation > before.historyGeneration;

        // R13.13: a history whose `messages` is not an array changes nothing, whatever its generation.
        for (const variant of s.nonArray) {
          const raw = P21_NON_ARRAY_HISTORIES[variant](valid);
          const result = reduceChat(before, { kind: 'history', raw, generation, now: 5000 });
          expect(result.state).toBe(before);
          expect(result.effects).toEqual([]);
        }

        // R13.13, R5.14: a history mixing valid and invalid entries equals the valid entries alone.
        const mixed: unknown[] = [...valid];
        for (const bad of s.badHistory) mixed.splice(bad.at % (mixed.length + 1), 0, corrupt(bad).value);
        const fromMixed = reduceChat(before, { kind: 'history', raw: { messages: mixed }, generation, now: 5000 });
        const fromValid = reduceChat(before, { kind: 'history', raw: { messages: valid }, generation, now: 5000 });
        expect(fromMixed.state).toEqual(fromValid.state);
        expect(fromMixed.effects).toEqual(fromValid.effects);
        for (const m of fromMixed.state.confirmed) expect(isChatMessage(m)).toBe(true);
        if (gateOpen) {
          // Every valid entry is kept unless the 200-message limit evicted it.
          for (const m of valid) {
            const kept = fromMixed.state.confirmed.some((c) => c.id === m.id);
            if (!kept) expect(fromMixed.state.confirmed).toHaveLength(REF_HISTORY_LIMIT);
          }
        } else {
          expect(fromMixed.state).toBe(before);
          expect(fromMixed.effects).toEqual([]);
        }
      }),
      { numRuns: 100 },
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Property 22
// ---------------------------------------------------------------------------

const P22_MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * The independent oracle: the value of `raw` when it is the decimal form of a positive safe
 * integer (ASCII digits only, no leading zero, at most `MAX_SAFE_INTEGER`), otherwise null.
 */
function p22Canonical(raw: string): number | null {
  if (raw.length === 0 || raw[0] === '0') return null;
  for (const c of raw) if (c < '0' || c > '9') return null;
  return BigInt(raw) <= P22_MAX_SAFE ? Number(raw) : null;
}

/** Positive safe integers, small or anywhere up to `MAX_SAFE_INTEGER`. */
const p22PositiveArb = fc.oneof(
  fc.integer({ min: 1, max: 999 }),
  fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
  fc.constantFrom(1, Number.MAX_SAFE_INTEGER),
);

const p22DecimalArb = p22PositiveArb.map(String);

/** Strings that are not the decimal form of a positive safe integer (R2.11). */
const p22JunkArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  fc.constantFrom('0', '00', '-0', '+0', '0.0'),
  fc.tuple(fc.constantFrom('+', '-'), p22DecimalArb).map(([sign, n]) => `${sign}${n}`),
  fc.tuple(fc.integer({ min: 1, max: 3 }), p22DecimalArb).map(([zeros, n]) => `${'0'.repeat(zeros)}${n}`),
  fc.tuple(p22DecimalArb, fc.nat({ max: 999 })).map(([n, f]) => `${n}.${f}`),
  fc.tuple(p22DecimalArb, fc.constantFrom('e', 'E', 'e+', 'e-'), fc.nat({ max: 20 })).map(([n, e, k]) => `${n}${e}${k}`),
  fc
    .tuple(fc.constantFrom(' ', '\t', '\n', '\r\n', '\u00a0', '\u3000', '\ufeff'), p22DecimalArb, fc.constantFrom('before', 'after', 'inside'))
    .map(([ws, n, at]) => (at === 'before' ? `${ws}${n}` : at === 'after' ? `${n}${ws}` : `${n}${ws}${n}`)),
  fc.bigInt({ min: P22_MAX_SAFE + 1n, max: P22_MAX_SAFE * 1_000_000n }).map(String),
  fc.constantFrom('0x10', '0b1', 'Infinity', 'NaN', '1_000', '1,000', '\uff11\uff12', '\u0663', '12abc', 'null', 'undefined'),
  fc.string({ maxLength: 20 }).filter((raw) => p22Canonical(raw) === null),
);

/** How the backing store behaves: working, unavailable (provider or every access throws), or full. */
type P22StorageMode = 'ok' | 'providerThrows' | 'accessThrows' | 'setThrows';

function p22Provider(storage: Map<string, string>, mode: P22StorageMode): ReadMarkerStorageProvider {
  const blocked = (): never => {
    throw new DOMException('Storage is blocked', 'SecurityError');
  };
  return () => {
    if (mode === 'providerThrows') blocked();
    return {
      getItem: (k: string) => (mode === 'accessThrows' ? blocked() : (storage.get(k) ?? null)),
      setItem: (k: string, v: string) => {
        if (mode === 'accessThrows') blocked();
        if (mode === 'setThrows') throw new DOMException('Storage is full', 'QuotaExceededError');
        storage.set(k, v);
      },
    };
  };
}

/** A transport of either Board_Kind; the clock and document doubles are those of Property 20. */
class P22Transport implements ChatTransport {
  readonly connectionState = signal<ConnectionState>('connected');
  readonly connectionGeneration = signal(1);
  readonly participants = signal<readonly User[]>([]);
  readonly currentUserId = signal<string | null>(ME);
  readonly added$ = new Subject<unknown>();
  readonly history$ = new Subject<unknown>();
  readonly rejected$ = new Subject<unknown>();
  constructor(readonly boardKind: BoardKind) {}
  send(_payload: ChatMessageSendPayload): boolean {
    return true;
  }
}

const p22ScenarioArb = fc.record({
  kind: fc.constantFrom<BoardKind>('poker', 'retro'),
  sessionId: fc.oneof(uuidArb, fc.string({ minLength: 1, maxLength: 24 })),
  /** The value already under the key: a valid marker, junk, or nothing. */
  stored: fc.option(fc.oneof(p22DecimalArb, p22JunkArb), { nil: null }),
  /** A marker stored for the other Board_Kind and for another session; it must stay untouched. */
  neighbour: p22DecimalArb,
  mode: fc.constantFrom<P22StorageMode>('ok', 'providerThrows', 'accessThrows', 'setThrows'),
  messages: fc.uniqueArray(chatMessageArb, { selector: (m) => m.id, minLength: 1, maxLength: 20 }),
});

function p22Entries(storage: ReadonlyMap<string, string>): [string, string][] {
  return [...storage.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// Feature: session-chat, Property 22: Read_Marker storage round trip
describe('Property 22: Read_Marker storage round trip', () => {
  /** **Validates: Requirements 2.10, 2.11** */
  it('parses the stored form of every positive safe integer back to it and every other string to no Read_Marker', () => {
    fc.assert(
      fc.property(p22PositiveArb, p22JunkArb, fc.string({ maxLength: 20 }), (n, junk, any) => {
        const stored = serializeReadMarker(n);
        expect(stored).toBe(n.toString(10));
        expect(p22Canonical(stored)).toBe(n);
        expect(parseReadMarker(stored)).toBe(n);

        expect(p22Canonical(junk)).toBeNull();
        expect(parseReadMarker(junk)).toBeNull();

        expect(parseReadMarker(any)).toBe(p22Canonical(any));
      }),
      { numRuns: 100 },
    );
  });

  /** **Validates: Requirements 2.10, 2.11** */
  it('loads, overwrites and reloads the marker under its Board_Kind and session key, with a throwing store falling back to memory', () => {
    const parent = TestBed.inject(EnvironmentInjector);

    fc.assert(
      fc.property(p22ScenarioArb, (s) => {
        const key = readMarkerKey(s.kind, s.sessionId);
        const otherKind: BoardKind = s.kind === 'poker' ? 'retro' : 'poker';
        const storage = new Map<string, string>([
          [readMarkerKey(otherKind, s.sessionId), s.neighbour],
          [readMarkerKey(s.kind, `${s.sessionId}-other`), s.neighbour],
        ]);
        if (s.stored !== null) storage.set(key, s.stored);
        const initial = p22Entries(storage);
        const provider = p22Provider(storage, s.mode);
        const markers = new ReadMarkerStore(provider);

        const readable = s.mode === 'ok' || s.mode === 'setThrows';
        const writable = s.mode === 'ok';
        // R2.11: junk (or an unreadable store) is "no Read_Marker".
        const loaded = readable && s.stored !== null ? p22Canonical(s.stored) : null;

        const transport = new P22Transport(s.kind);
        const doc = new P20Document();
        const injector = createEnvironmentInjector(
          [
            ChatStore,
            { provide: CHAT_TRANSPORT, useValue: transport },
            { provide: CHAT_TIMERS, useValue: new P20Timers() },
            { provide: CHAT_READ_MARKER_STORE, useValue: markers },
            { provide: DOCUMENT, useValue: doc },
          ],
          parent,
        );

        try {
          const store = injector.get(ChatStore);
          expect(store.boardKind).toBe(s.kind);
          store.reset(s.sessionId);
          TestBed.tick();
          expect(markers.read(s.kind, s.sessionId)).toBe(loaded);

          // A history while closed: counted against the loaded marker (criterion 8 for junk), no write.
          transport.history$.next({ messages: s.messages });
          TestBed.tick();
          const above = (marker: number | null): number =>
            s.messages.filter((m) => m.authorId !== ME && m.seq > (marker ?? 0)).length;
          expect(store.unreadCount()).toBe(above(loaded));
          expect(p22Entries(storage)).toEqual(initial);

          // Opening the panel moves the marker to the highest seq; only a change is written (R2.10).
          store.panelState.set('open');
          TestBed.tick();
          const highest = Math.max(...s.messages.map((m) => m.seq));
          const changed = highest > (loaded ?? 0);
          const marker = changed ? highest : loaded;
          expect(markers.read(s.kind, s.sessionId)).toBe(marker);
          expect(store.unreadCount()).toBe(0);

          const expected = new Map(initial);
          if (writable && changed) expected.set(key, String(highest));
          // Only this Board_Kind and session's key changes, and it holds the decimal seq alone,
          // overwriting any junk (R2.11); a throwing store is left as it was.
          expect(p22Entries(storage)).toEqual(p22Entries(expected));

          // A later page load in the same tab reads back what storage holds.
          const reloaded = new ReadMarkerStore(provider).read(s.kind, s.sessionId);
          expect(reloaded).toBe(writable && changed ? highest : loaded);
          expect(new ReadMarkerStore(provider).read(otherKind, s.sessionId)).toBe(
            readable ? p22Canonical(s.neighbour) : null,
          );
        } finally {
          injector.destroy();
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 38
// ---------------------------------------------------------------------------

/** A Client_Message_Id from the scenario's pool, from the current outbox, or a fresh UUID. */
type P38IdRef =
  | { readonly from: 'pool' | 'outbox'; readonly index: number }
  | { readonly from: 'fresh'; readonly id: string };

type P38Command =
  | { readonly kind: 'history'; readonly indices: readonly number[]; readonly generation: number }
  | { readonly kind: 'added'; readonly index: number }
  | { readonly kind: 'send'; readonly ref: P38IdRef }
  | { readonly kind: 'rejected'; readonly ref: P38IdRef; readonly code: ChatRejection }
  | { readonly kind: 'reset'; readonly sessionId: string; readonly readMarker: number | null };

const p38RefArb: fc.Arbitrary<P38IdRef> = fc.oneof(
  { weight: 3, arbitrary: fc.nat({ max: 20 }).map((index): P38IdRef => ({ from: 'pool', index })) },
  { weight: 2, arbitrary: fc.nat({ max: 20 }).map((index): P38IdRef => ({ from: 'outbox', index })) },
  { weight: 1, arbitrary: uuidArb.map((id): P38IdRef => ({ from: 'fresh', id })) },
);

/** A small range, so generations repeat, increase and decrease; rarely the largest safe integer. */
const p38GenerationArb = fc.oneof(
  { weight: 8, arbitrary: fc.nat({ max: 6 }) },
  { weight: 1, arbitrary: fc.constant(Number.MAX_SAFE_INTEGER) },
);

const p38CommandArb: fc.Arbitrary<P38Command> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('history' as const),
      indices: fc.array(fc.nat({ max: 40 }), { maxLength: 6 }),
      generation: p38GenerationArb,
    }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('added' as const), index: fc.nat({ max: 40 }) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('send' as const), ref: p38RefArb }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('rejected' as const), ref: p38RefArb, code: fc.constantFrom(...P17_CODES) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('reset' as const),
      sessionId: fc.constantFrom(SESSION_ID, 's2', 's3'),
      readMarker: fc.option(fc.integer({ min: 1, max: 300 }), { nil: null }),
    }),
  },
);

/**
 * An id pool, a server message universe (small seqs, below the 200 limit) and a command sequence.
 * Each pool id has exactly one own server message (R16.7); other authors may reuse pool ids (R16.11).
 */
const p38ScenarioArb = fc
  .uniqueArray(uuidArb, { minLength: 1, maxLength: 4 })
  .chain((pool) =>
    fc.record({
      pool: fc.constant(pool),
      messages: fc.uniqueArray(p20MessageArb, {
        selector: (m) => m.id,
        minLength: pool.length,
        maxLength: pool.length + 12,
      }),
      shares: fc.array(fc.option(fc.nat({ max: pool.length - 1 }), { nil: null }), { minLength: 12, maxLength: 12 }),
      commands: fc.array(p38CommandArb, { minLength: 1, maxLength: 50 }),
    }),
  )
  .map(({ pool, messages, shares, commands }) => {
    const universe = messages.map((m, i): ChatMessage => {
      if (i < pool.length) return { ...m, authorId: ME, clientMessageId: pool[i] };
      const share = shares[i - pool.length];
      return {
        ...m,
        authorId: m.authorId === ME ? 'user-a' : m.authorId,
        clientMessageId: share === null ? m.clientMessageId : pool[share],
      };
    });
    return { pool, universe, commands };
  });

interface P38Entry {
  readonly clientMessageId: string;
  readonly text: string;
  readonly state: OutboxState;
}

/** The independent model of the generation gate. */
interface P38Model {
  readonly sessionId: string;
  readonly readMarker: number | null;
  /** Highest generation applied since the start or the last reset; null while none was applied. */
  readonly applied: number | null;
  /** Every message applied since the start or the last reset. */
  readonly delivered: readonly ChatMessage[];
  readonly outbox: readonly P38Entry[];
}

interface P38Step {
  readonly action: ChatAction;
  readonly next: P38Model;
  readonly sends: readonly ChatMessageSendPayload[];
  /** A history the gate must ignore: same state object, no effects (R25.12). */
  readonly ignored: boolean;
}

function p38Resolve(ref: P38IdRef, pool: readonly string[], model: P38Model): string {
  switch (ref.from) {
    case 'pool':
      return pool[ref.index % pool.length];
    case 'outbox':
      return model.outbox.length > 0
        ? model.outbox[ref.index % model.outbox.length].clientMessageId
        : pool[ref.index % pool.length];
    case 'fresh':
      return ref.id;
  }
}

function p38Payload(sessionId: string, entry: P38Entry): ChatMessageSendPayload {
  return { sessionId, clientMessageId: entry.clientMessageId, text: entry.text };
}

function p38Step(
  model: P38Model,
  scenario: { readonly pool: readonly string[]; readonly universe: readonly ChatMessage[] },
  command: P38Command,
  i: number,
): P38Step {
  const now = 100 + 10 * i;
  const quiet = { sends: [], ignored: false };
  switch (command.kind) {
    case 'history': {
      const messages = command.indices.map((k) => scenario.universe[k % scenario.universe.length]);
      const action: ChatAction = { kind: 'history', raw: { messages }, generation: command.generation, now };
      const first = model.applied === null;
      const reconnect = model.applied !== null && command.generation > model.applied;
      if (!first && !reconnect) return { action, next: model, sends: [], ignored: true };
      const ownIds = new Set(messages.filter((m) => m.authorId === ME).map((m) => m.clientMessageId));
      const outbox = model.outbox.filter((e) => !ownIds.has(e.clientMessageId));
      return {
        action,
        next: { ...model, applied: command.generation, delivered: [...model.delivered, ...messages], outbox },
        // A first history resends nothing (R18.13, R25.9); a reconnect history resends each
        // remaining pending entry once, in send order (R9.6, R25.11).
        sends: reconnect ? outbox.filter((e) => e.state === 'pending').map((e) => p38Payload(model.sessionId, e)) : [],
        ignored: false,
      };
    }
    case 'added': {
      const message = scenario.universe[command.index % scenario.universe.length];
      const outbox =
        message.authorId === ME ? model.outbox.filter((e) => e.clientMessageId !== message.clientMessageId) : model.outbox;
      return {
        action: { kind: 'added', raw: { message } },
        next: { ...model, delivered: [...model.delivered, message], outbox },
        ...quiet,
      };
    }
    case 'send': {
      const id = p38Resolve(command.ref, scenario.pool, model);
      const text = `draft ${i}`;
      const action: ChatAction = { kind: 'send', clientMessageId: id, text, now };
      const held =
        model.outbox.some((e) => e.clientMessageId === id) ||
        referenceConfirmed(model.delivered).some((m) => m.authorId === ME && m.clientMessageId === id);
      if (held) return { action, next: model, ...quiet };
      const entry: P38Entry = { clientMessageId: id, text, state: 'pending' };
      return {
        action,
        next: { ...model, outbox: [...model.outbox, entry] },
        sends: [p38Payload(model.sessionId, entry)],
        ignored: false,
      };
    }
    case 'rejected': {
      const id = p38Resolve(command.ref, scenario.pool, model);
      const action: ChatAction = {
        kind: 'rejected',
        raw: { clientMessageId: id, code: command.code, message: 'Rejected.' },
        now,
      };
      const target = model.outbox.find(
        (e) => e.clientMessageId === id && (e.state === 'pending' || e.state === 'failed'),
      );
      if (target === undefined) return { action, next: model, ...quiet };
      const state: OutboxState = command.code === 'CHAT_DUPLICATE' ? 'sent' : 'failed';
      const outbox = model.outbox.map((e) => (e === target ? { ...e, state } : e));
      return { action, next: { ...model, outbox }, ...quiet };
    }
    case 'reset':
      // R18.11: nothing of the previous session survives and the gate reopens for a first history.
      return {
        action: { kind: 'reset', sessionId: command.sessionId, readMarker: command.readMarker },
        next: { sessionId: command.sessionId, readMarker: command.readMarker, applied: null, delivered: [], outbox: [] },
        ...quiet,
      };
  }
}

// Feature: session-chat, Property 38: The generation gate decides how each Chat_History is applied
describe('Property 38: The generation gate decides how each Chat_History is applied', () => {
  /** **Validates: Requirements 9.4, 18.13, 25.9, 25.11, 25.12** */
  it('applies a first history without resend, a higher generation with one resend per pending entry, and ignores the rest', () => {
    fc.assert(
      fc.property(p38ScenarioArb, (scenario) => {
        let state = connectedState();
        let model: P38Model = { sessionId: SESSION_ID, readMarker: null, applied: null, delivered: [], outbox: [] };

        scenario.commands.forEach((command, i) => {
          const step = p38Step(model, scenario, command, i);
          const before = state;
          const { state: after, effects } = reduceChat(before, step.action);
          const confirmed = referenceConfirmed(step.next.delivered);

          expect(after.sessionId).toBe(step.next.sessionId);
          expect(after.confirmed).toEqual(confirmed);
          expect(after.outbox.map((e) => ({ clientMessageId: e.clientMessageId, text: e.text, state: e.state }))).toEqual(
            step.next.outbox,
          );
          expect(effects.flatMap((e) => (e.kind === 'send' ? [e.payload] : []))).toEqual(step.sends);
          expect(selectUnreadCount(after)).toBe(p20Unread(confirmed, step.next.readMarker));
          expect(after.historyGeneration).toBe(step.next.applied);
          expect(after.historyStatus).toBe(step.next.applied === null ? 'loading' : 'loaded');

          if (step.ignored) {
            // R25.12: messages, Own_Messages, Delivery_States, timers and Unread_Count unchanged.
            expect(after).toBe(before);
            expect(effects).toEqual([]);
          }

          state = after;
          model = step.next;
        });
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 30
// ---------------------------------------------------------------------------

/**
 * Property 30 drives the real `ChatStore` with the Property 20 doubles. The count lives in the
 * store, but the Message_List owns the scroll position: it writes `store.scroll` on every scroll
 * event while `open`, resets the count when that position is At_Bottom (R6.5), and scrolls to the
 * end after an own send (R6.3). The `scroll` and `send` commands below do exactly that.
 */
type P30Command =
  | { readonly kind: 'added'; readonly index: number }
  /** `gen`: the Connection_Generation of the history relative to the transport's current one. */
  | {
      readonly kind: 'history';
      readonly indices: readonly number[];
      readonly complete: boolean;
      readonly gen: 'higher' | 'same' | 'lower';
    }
  | { readonly kind: 'scroll'; readonly atBottom: boolean; readonly top: number }
  | { readonly kind: 'panel'; readonly state: ChatPanelState }
  | { readonly kind: 'send' };

const p30CommandArb: fc.Arbitrary<P30Command> = fc.oneof(
  { weight: 6, arbitrary: fc.nat({ max: 40 }).map((index): P30Command => ({ kind: 'added', index })) },
  {
    weight: 3,
    arbitrary: fc
      .record({
        indices: fc.array(fc.nat({ max: 40 }), { maxLength: 8 }),
        complete: fc.boolean(),
        gen: fc.constantFrom<'higher' | 'same' | 'lower'>('higher', 'higher', 'higher', 'same', 'lower'),
      })
      .map(({ indices, complete, gen }): P30Command => ({ kind: 'history', indices, complete, gen })),
  },
  {
    weight: 4,
    arbitrary: fc
      .record({ atBottom: fc.boolean(), top: fc.nat({ max: 5000 }) })
      .map(({ atBottom, top }): P30Command => ({ kind: 'scroll', atBottom, top })),
  },
  {
    weight: 2,
    arbitrary: fc
      .constantFrom<ChatPanelState>('closed', 'open', 'minimized')
      .map((state): P30Command => ({ kind: 'panel', state })),
  },
  { weight: 1, arbitrary: fc.constant<P30Command>({ kind: 'send' }) },
);

/** Universes stay below the 200-message limit, so no new message is evicted on arrival. */
const p30ScenarioArb = fc.record({
  universe: fc.uniqueArray(p20MessageArb, { selector: (m) => m.id, minLength: 1, maxLength: 40 }),
  initialPanel: fc.constantFrom<ChatPanelState>('closed', 'open', 'minimized'),
  commands: fc.array(p30CommandArb, { minLength: 1, maxLength: 40 }),
});

// Feature: session-chat, Property 30: The New_Messages_Indicator counts what arrived out of view
describe('Property 30: The New_Messages_Indicator counts what arrived out of view', () => {
  /** **Validates: Requirements 6.2, 6.8** */
  it('equals the number of non-own messages added since the list was last At_Bottom, counting a history only above the previous highest seq', () => {
    const parent = TestBed.inject(EnvironmentInjector);

    fc.assert(
      fc.property(p30ScenarioArb, (s) => {
        const transport = new P20Transport();
        const storage = new Map<string, string>();
        const markers = new ReadMarkerStore(() => ({
          getItem: (k: string) => storage.get(k) ?? null,
          setItem: (k: string, v: string) => void storage.set(k, v),
        }));
        const injector = createEnvironmentInjector(
          [
            ChatStore,
            { provide: CHAT_TRANSPORT, useValue: transport },
            { provide: CHAT_TIMERS, useValue: new P20Timers() },
            { provide: CHAT_READ_MARKER_STORE, useValue: markers },
            { provide: DOCUMENT, useValue: new P20Document() },
          ],
          parent,
        );

        try {
          const store = injector.get(ChatStore);
          store.panelState.set(s.initialPanel);
          store.reset(SESSION_ID);
          TestBed.tick();

          // The independent model: what is held, where the list is, and what arrived since At_Bottom.
          const held = new Set<string>();
          let maxSeq = 0;
          let appliedGeneration: number | null = null;
          let transportGeneration = 1;
          let panel: ChatPanelState = s.initialPanel;
          let scroll: { readonly atBottom: boolean; readonly top: number } | null = null;
          const arrivedOutOfView = new Set<string>();
          const atBottom = (): boolean => scroll === null || scroll.atBottom;
          const delivered: ChatMessage[] = [];

          /** A message entering the list; `counts` says whether it may count at all (R6.2, R6.8). */
          const admit = (m: ChatMessage, counts: boolean): void => {
            if (held.has(m.id)) return;
            held.add(m.id);
            if (counts && m.authorId !== ME && !atBottom()) arrivedOutOfView.add(m.id);
          };

          expect(store.newIndicatorCount()).toBe(0);

          for (const command of s.commands) {
            const countBefore = store.newIndicatorCount();
            const wasAtBottom = atBottom();

            switch (command.kind) {
              case 'added': {
                const message = s.universe[command.index % s.universe.length];
                transport.added$.next({ message });
                delivered.push(message);
                admit(message, true);
                maxSeq = Math.max(maxSeq, message.seq);
                break;
              }
              case 'history': {
                const picked = command.indices.map((i) => s.universe[i % s.universe.length]);
                const messages = command.complete ? [...delivered, ...picked] : picked;
                if (command.gen === 'higher') transportGeneration += 1;
                if (command.gen === 'lower') transportGeneration = Math.max(0, transportGeneration - 1);
                transport.connectionGeneration.set(transportGeneration);
                transport.history$.next({ messages });

                const applies = appliedGeneration === null || transportGeneration > appliedGeneration;
                if (applies) {
                  // The first history after render is not a reconnect and counts nothing (R6.8).
                  const reconnect = appliedGeneration !== null;
                  const previousMax = maxSeq;
                  for (const m of messages) {
                    admit(m, reconnect && m.seq > previousMax);
                    maxSeq = Math.max(maxSeq, m.seq);
                  }
                  delivered.push(...messages);
                  appliedGeneration = transportGeneration;
                }
                break;
              }
              case 'scroll':
                // The Message_List reports scroll positions only while it is shown `open`.
                if (panel !== 'open') break;
                store.scroll.set({ top: command.top, atBottom: command.atBottom });
                if (command.atBottom) store.newIndicatorCount.set(0);
                scroll = { top: command.top, atBottom: command.atBottom };
                if (command.atBottom) arrivedOutOfView.clear();
                break;
              case 'panel':
                store.panelState.set(command.state);
                panel = command.state;
                break;
              case 'send':
                // The Composer is reachable only while `open`; the list then scrolls to its end (R6.3).
                if (panel !== 'open') break;
                store.draft.set('hello');
                store.sendDraft();
                store.scroll.set({ top: 5000, atBottom: true });
                scroll = { top: 5000, atBottom: true };
                arrivedOutOfView.clear();
                break;
            }
            TestBed.tick();

            expect(store.newIndicatorCount()).toBe(arrivedOutOfView.size);

            if (command.kind === 'added') {
              const message = s.universe[command.index % s.universe.length];
              if (message.authorId === ME || wasAtBottom) {
                // R6.2: an Own_Message from another tab, or any arrival while At_Bottom, leaves it unchanged.
                expect(store.newIndicatorCount()).toBe(countBefore);
              }
            }
            if (command.kind === 'history') {
              // R6.8: a history only ever adds to the count, and nothing while At_Bottom.
              expect(store.newIndicatorCount()).toBeGreaterThanOrEqual(countBefore);
              if (wasAtBottom) expect(store.newIndicatorCount()).toBe(countBefore);
            }
            if (command.kind === 'panel') {
              // Panel_State changes neither reset nor bump the count (R6.9 counts while not open).
              expect(store.newIndicatorCount()).toBe(countBefore);
            }
          }
        } finally {
          injector.destroy();
        }
      }),
      { numRuns: 100 },
    );
  });
});
