import * as fc from 'fast-check';
import {
  BoardKind,
  CHAT_DEDUP_PER_AUTHOR,
  CHAT_HISTORY_LIMIT,
  CHAT_RATE_LIMIT_COUNT,
  CHAT_RATE_LIMIT_WINDOW_MS,
  ChatMessage,
  isCanonicalUuid,
  isChatMessage,
} from '../../../../shared/types';
import { ChatAuthor, ChatBuffer, ChatRateLimiter, ChatRoom, ChatSubmitDecision } from '../chat-room';

/**
 * Property tests for ChatRoom (session-chat Properties 10–14).
 *
 * Tasks 2.6–2.9 append Properties 11–14 to this file; the generators and the
 * send driver below sit at module scope so every property can reuse them.
 */

// ---------------------------------------------------------------------------
// Module-scope fixtures
// ---------------------------------------------------------------------------

/**
 * Clock readings stay in [1970-01-01, ~2096] so `toISOString()` never throws
 * and always yields a 4-digit year (the form `isChatSentAt` accepts).
 */
const CLOCK_MIN_MS = 0;
const CLOCK_MAX_MS = 4_000_000_000_000;

/** Several authors, so the per-author rate limiter does not reject every send. */
const AUTHORS: readonly ChatAuthor[] = Object.freeze([
  { id: 'author-1', displayName: 'Alice' },
  { id: 'author-2', displayName: 'Bob' },
  { id: 'author-3', displayName: 'Carol' },
  { id: 'author-4', displayName: 'Dave' },
  { id: 'author-5', displayName: 'Eve' },
]);

function clampClock(ms: number): number {
  return Math.min(CLOCK_MAX_MS, Math.max(CLOCK_MIN_MS, ms));
}

/** Flips the case of each hex letter in `uuid` where the matching flag is true. */
function flipCase(uuid: string, flags: readonly boolean[]): string {
  let out = '';
  for (let i = 0; i < uuid.length; i++) {
    const ch = uuid[i];
    out += flags[i % flags.length] ? (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()) : ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Module-scope generators
// ---------------------------------------------------------------------------

/** Start time of the generated clock. */
const startMsArb: fc.Arbitrary<number> = fc.integer({ min: CLOCK_MIN_MS, max: CLOCK_MAX_MS });

/**
 * Step applied to the clock before a send. Mostly small forward steps, some
 * jumps past the 5 s rate-limit window, and backward jumps (R16.2).
 */
const clockStepArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 2, arbitrary: fc.constant(0) },
  { weight: 6, arbitrary: fc.integer({ min: 1, max: 2_000 }) },
  { weight: 2, arbitrary: fc.integer({ min: 5_000, max: 120_000 }) },
  { weight: 3, arbitrary: fc.integer({ min: -600_000, max: -1 }) },
);

/** Index into AUTHORS. */
const authorIndexArb: fc.Arbitrary<number> = fc.integer({ min: 0, max: AUTHORS.length - 1 });

/** Canonical lower-case UUID. */
const uuidArb: fc.Arbitrary<string> = fc.uuid();

/** Canonical UUID with the case of some hex letters flipped (still the same id, R16.11). */
const caseFlippedUuidArb: fc.Arbitrary<string> = fc
  .tuple(uuidArb, fc.array(fc.boolean(), { minLength: 36, maxLength: 36 }))
  .map(([uuid, flags]) => flipCase(uuid, flags));

/**
 * Client_Message_Id choice for one send: a fresh UUID (maybe case-flipped), or
 * a reuse of an id already sent in this run, picked by index and optionally
 * case-flipped.
 */
type ClientIdChoice =
  | { kind: 'fresh'; id: string }
  | { kind: 'reuse'; pick: number; flags: boolean[] };

const clientIdChoiceArb: fc.Arbitrary<ClientIdChoice> = fc.oneof(
  { weight: 8, arbitrary: fc.oneof(uuidArb, caseFlippedUuidArb).map((id): ClientIdChoice => ({ kind: 'fresh', id })) },
  {
    weight: 2,
    arbitrary: fc
      .record({ pick: fc.nat(), flags: fc.array(fc.boolean(), { minLength: 36, maxLength: 36 }) })
      .map(({ pick, flags }): ClientIdChoice => ({ kind: 'reuse', pick, flags })),
  },
);

/** Normalised_Text stand-in: ChatRoom stores whatever text it is given. */
const textArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 20 });

interface SendCommand {
  clockStep: number;
  authorIndex: number;
  clientId: ClientIdChoice;
  text: string;
}

const sendCommandArb: fc.Arbitrary<SendCommand> = fc.record({
  clockStep: clockStepArb,
  authorIndex: authorIndexArb,
  clientId: clientIdChoiceArb,
  text: textArb,
});

/** Up to 400 sends, uniformly sized so many runs pass the 200-message buffer and evict. */
const sendCommandsArb: fc.Arbitrary<SendCommand[]> = fc.array(sendCommandArb, {
  minLength: 1,
  maxLength: 400,
  size: 'max',
});

// ---------------------------------------------------------------------------
// Module-scope driver
// ---------------------------------------------------------------------------

interface SendStep {
  /** Clock reading in effect while this send was prepared. */
  clockMs: number;
  author: ChatAuthor;
  clientMessageId: string;
  text: string;
  decision: ChatSubmitDecision;
}

/**
 * Plays `commands` against a fresh ChatRoom driven by a generated clock,
 * committing every accepted decision. Returns one step per command.
 */
function runSends(startMs: number, commands: readonly SendCommand[]): { room: ChatRoom; steps: SendStep[] } {
  let nowMs = startMs;
  const room = new ChatRoom({ clock: () => nowMs });
  const usedIds: string[] = [];
  const steps: SendStep[] = [];

  for (const cmd of commands) {
    nowMs = clampClock(nowMs + cmd.clockStep);
    const author = AUTHORS[cmd.authorIndex];

    let clientMessageId: string;
    if (cmd.clientId.kind === 'fresh') {
      clientMessageId = cmd.clientId.id;
    } else if (usedIds.length > 0) {
      clientMessageId = flipCase(usedIds[cmd.clientId.pick % usedIds.length], cmd.clientId.flags);
    } else {
      // A 'reuse' before anything was sent: fall back to a fixed id.
      clientMessageId = '00000000-0000-4000-8000-000000000000';
    }
    usedIds.push(clientMessageId);

    const decision = room.prepare(author, clientMessageId, cmd.text);
    if (decision.kind === 'accepted') decision.commit();
    steps.push({ clockMs: nowMs, author, clientMessageId, text: cmd.text, decision });
  }

  return { room, steps };
}

// ---------------------------------------------------------------------------
// Property 10
// ---------------------------------------------------------------------------

describe('ChatRoom property tests', () => {
  // Feature: session-chat, Property 10: Sequence numbers are contiguous and sentAt never decreases
  describe('Property 10: Sequence numbers are contiguous and sentAt never decreases', () => {
    /**
     * **Validates: Requirements 16.1, 16.2**
     */
    it('assigns seq 1, 2, 3, … with unique canonical UUID ids and non-decreasing sentAt', () => {
      fc.assert(
        fc.property(startMsArb, sendCommandsArb, (startMs, commands) => {
          const { steps } = runSends(startMs, commands);

          const accepted: { message: ChatMessage; clockMs: number }[] = [];
          for (const step of steps) {
            if (step.decision.kind === 'accepted') {
              accepted.push({ message: step.decision.message, clockMs: step.clockMs });
            }
          }

          const seenIds = new Set<string>();
          let previousSentAtMs: number | undefined;

          accepted.forEach(({ message, clockMs }, index) => {
            // Contiguous from 1 in acceptance order, never reused after eviction (R16.2).
            expect(message.seq).toBe(index + 1);

            // Distinct canonical UUID id (R16.1).
            expect(isCanonicalUuid(message.id)).toBe(true);
            expect(seenIds.has(message.id.toLowerCase())).toBe(false);
            seenIds.add(message.id.toLowerCase());

            // Well-formed Chat_Message, including the ISO 8601 ms sentAt form (R16.1).
            expect(isChatMessage(message)).toBe(true);

            // sentAt = max(clock reading, previous sentAt), hence non-decreasing (R16.1, R16.2).
            const sentAtMs = Date.parse(message.sentAt);
            const expectedMs = previousSentAtMs === undefined ? clockMs : Math.max(clockMs, previousSentAtMs);
            expect(sentAtMs).toBe(expectedMs);
            if (previousSentAtMs !== undefined) {
              expect(sentAtMs).toBeGreaterThanOrEqual(previousSentAtMs);
            }
            previousSentAtMs = sentAtMs;
          });
        }),
        { numRuns: 100 },
      );
    });
  });

  // Feature: session-chat, Property 11: The Chat_Buffer matches a list model
  describe('Property 11: The Chat_Buffer matches a list model', () => {
    /** True when both arrays hold the same message objects in the same order. */
    function sameMessages(actual: readonly ChatMessage[], expected: readonly ChatMessage[]): boolean {
      return actual.length === expected.length && actual.every((m, i) => m === expected[i]);
    }

    function makeMessage(seq: number, text: string): ChatMessage {
      return {
        id: `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`,
        seq,
        clientMessageId: `10000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`,
        authorId: 'author-1',
        authorName: 'Alice',
        text,
        sentAt: new Date(seq * 1000).toISOString(),
      };
    }

    // --- (a) ChatBuffer driven directly --------------------------------------

    /** `undefined` = default constructor (CHAT_HISTORY_LIMIT); small capacities evict fast. */
    const capacityArb: fc.Arbitrary<number | undefined> = fc.oneof(
      fc.constant(undefined),
      fc.constant(CHAT_HISTORY_LIMIT),
      fc.integer({ min: 1, max: 8 }),
    );

    /** Seq of the first push; an empty buffer accepts any seq. */
    const startSeqArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 1_000_000 });

    type ProbeTarget =
      | { kind: 'held'; pick: number }
      | { kind: 'evicted'; pick: number }
      | { kind: 'neverAbove'; distance: number }
      | { kind: 'neverBelow'; distance: number }
      | { kind: 'fraction'; pick: number; frac: number }
      | { kind: 'special'; value: number };

    type ArrayMutation = 'pop' | 'shift' | 'append' | 'reverse' | 'overwrite' | 'clear';

    type BufferCommand =
      | { kind: 'push'; text: string }
      | { kind: 'probe'; target: ProbeTarget }
      | { kind: 'toArray'; mutation: ArrayMutation };

    const probeTargetArb: fc.Arbitrary<ProbeTarget> = fc.oneof(
      fc.nat().map((pick): ProbeTarget => ({ kind: 'held', pick })),
      fc.nat().map((pick): ProbeTarget => ({ kind: 'evicted', pick })),
      fc.integer({ min: 0, max: 10 }).map((distance): ProbeTarget => ({ kind: 'neverAbove', distance })),
      fc.integer({ min: 0, max: 10 }).map((distance): ProbeTarget => ({ kind: 'neverBelow', distance })),
      fc
        .record({ pick: fc.nat(), frac: fc.double({ min: 0.001, max: 0.999, noNaN: true }) })
        .map(({ pick, frac }): ProbeTarget => ({ kind: 'fraction', pick, frac })),
      fc.constantFrom(NaN, Infinity, -Infinity).map((value): ProbeTarget => ({ kind: 'special', value })),
    );

    const bufferCommandArb: fc.Arbitrary<BufferCommand> = fc.oneof(
      { weight: 8, arbitrary: textArb.map((text): BufferCommand => ({ kind: 'push', text })) },
      { weight: 2, arbitrary: probeTargetArb.map((target): BufferCommand => ({ kind: 'probe', target })) },
      {
        weight: 1,
        arbitrary: fc
          .constantFrom<ArrayMutation>('pop', 'shift', 'append', 'reverse', 'overwrite', 'clear')
          .map((mutation): BufferCommand => ({ kind: 'toArray', mutation })),
      },
    );

    /** Up to 500 commands, so default-capacity runs often pass 200 pushes and evict. */
    const bufferCommandsArb: fc.Arbitrary<BufferCommand[]> = fc.array(bufferCommandArb, {
      minLength: 1,
      maxLength: 500,
      size: 'max',
    });

    /**
     * **Validates: Requirements 18.1, 18.2, 18.3, 20.2**
     */
    it('ChatBuffer push / size / toArray / getBySeq match an append-and-drop-head list model', () => {
      let defaultCapacityEvictions = 0;

      fc.assert(
        fc.property(capacityArb, startSeqArb, bufferCommandsArb, (capacityOpt, startSeq, commands) => {
          const capacity = capacityOpt ?? CHAT_HISTORY_LIMIT;
          const buffer = capacityOpt === undefined ? new ChatBuffer() : new ChatBuffer(capacityOpt);

          // Model: a plain list; append, drop the head when over capacity.
          const model: ChatMessage[] = [];
          let nextSeq = startSeq;
          let evictedCount = 0;

          const expectMatchesModel = (): void => {
            expect(buffer.size).toBe(model.length);
            expect(buffer.size).toBeLessThanOrEqual(capacity);
            const arr = buffer.toArray();
            if (!sameMessages(arr, model)) {
              expect(arr.map((m) => m.seq)).toEqual(model.map((m) => m.seq));
              expect(sameMessages(arr, model)).toBe(true);
            }
          };

          expectMatchesModel();

          for (const cmd of commands) {
            switch (cmd.kind) {
              case 'push': {
                const message = makeMessage(nextSeq, cmd.text);
                nextSeq++;
                model.push(message);
                const expectedDropped = model.length > capacity ? (model.shift() as ChatMessage) : null;
                if (expectedDropped) {
                  evictedCount++;
                  if (capacityOpt === undefined) defaultCapacityEvictions++;
                }

                const dropped = buffer.push(message);
                expect(dropped).toBe(expectedDropped);
                expectMatchesModel();
                break;
              }

              case 'probe': {
                const t = cmd.target;
                let seq: number;
                switch (t.kind) {
                  case 'held':
                    seq = model.length > 0 ? model[t.pick % model.length].seq : startSeq;
                    break;
                  case 'evicted':
                    seq = evictedCount > 0 ? startSeq + (t.pick % evictedCount) : startSeq - 1;
                    break;
                  case 'neverAbove':
                    seq = nextSeq + t.distance;
                    break;
                  case 'neverBelow':
                    seq = startSeq - 1 - t.distance;
                    break;
                  case 'fraction':
                    seq = (model.length > 0 ? model[t.pick % model.length].seq : startSeq) + t.frac;
                    break;
                  case 'special':
                    seq = t.value;
                    break;
                }
                const expected = model.find((m) => m.seq === seq);
                expect(buffer.getBySeq(seq)).toBe(expected);
                break;
              }

              case 'toArray': {
                const first = buffer.toArray();
                const second = buffer.toArray();
                expect(first).not.toBe(second);
                expect(sameMessages(first, model)).toBe(true);

                switch (cmd.mutation) {
                  case 'pop':
                    first.pop();
                    break;
                  case 'shift':
                    first.shift();
                    break;
                  case 'append':
                    first.push(makeMessage(nextSeq + 1000, 'injected'));
                    break;
                  case 'reverse':
                    first.reverse();
                    break;
                  case 'overwrite':
                    if (first.length > 0) first[0] = makeMessage(nextSeq + 2000, 'overwritten');
                    break;
                  case 'clear':
                    first.length = 0;
                    break;
                }

                // Mutating a returned array changes neither the buffer nor another returned array.
                expect(sameMessages(second, model)).toBe(true);
                expectMatchesModel();
                if (model.length > 0) {
                  expect(buffer.getBySeq(model[0].seq)).toBe(model[0]);
                  expect(buffer.getBySeq(model[model.length - 1].seq)).toBe(model[model.length - 1]);
                }
                break;
              }
            }
          }
        }),
        { numRuns: 100 },
      );

      // The generated runs must actually exercise eviction at CHAT_HISTORY_LIMIT.
      expect(defaultCapacityEvictions).toBeGreaterThan(0);
    });

    // --- (b) ChatRoom.history() through runSends -----------------------------

    /**
     * Mostly forward steps of at least 1 s, so few sends hit the rate limit and
     * many runs accept more than CHAT_HISTORY_LIMIT messages.
     */
    const evictingClockStepArb: fc.Arbitrary<number> = fc.oneof(
      { weight: 8, arbitrary: fc.integer({ min: 1_000, max: 3_000 }) },
      { weight: 1, arbitrary: fc.integer({ min: 0, max: 999 }) },
      { weight: 1, arbitrary: fc.integer({ min: -2_000, max: -1 }) },
    );

    const evictingSendCommandsArb: fc.Arbitrary<SendCommand[]> = fc.array(
      fc.record({
        clockStep: evictingClockStepArb,
        authorIndex: authorIndexArb,
        clientId: clientIdChoiceArb,
        text: textArb,
      }),
      { minLength: 1, maxLength: 400, size: 'max' },
    );

    /**
     * **Validates: Requirements 18.1, 18.2, 18.3, 20.2**
     */
    it('room.history() equals the last min(n, 200) accepted messages in ascending seq', () => {
      let evictingRuns = 0;

      fc.assert(
        fc.property(startMsArb, fc.oneof(sendCommandsArb, evictingSendCommandsArb), (startMs, commands) => {
          const { room, steps } = runSends(startMs, commands);

          // n counts only sends that produced a new message: rejections and replays are excluded.
          const accepted: ChatMessage[] = [];
          for (const step of steps) {
            if (step.decision.kind === 'accepted') accepted.push(step.decision.message);
          }
          if (accepted.length > CHAT_HISTORY_LIMIT) evictingRuns++;

          const expected = accepted.slice(-CHAT_HISTORY_LIMIT);
          const history = room.history();

          expect(history.length).toBeLessThanOrEqual(CHAT_HISTORY_LIMIT);
          expect(history.length).toBe(Math.min(accepted.length, CHAT_HISTORY_LIMIT));
          expect(history.map((m) => m.seq)).toEqual(expected.map((m) => m.seq));
          expect(sameMessages(history, expected)).toBe(true);
          for (let i = 1; i < history.length; i++) {
            expect(history[i].seq).toBe(history[i - 1].seq + 1);
          }
        }),
        { numRuns: 100 },
      );

      expect(evictingRuns).toBeGreaterThan(0);
    });
  });

  // Feature: session-chat, Property 12: Duplicate sends match the dedup model
  describe('Property 12: Duplicate sends match the dedup model', () => {
    /** Model capacities, written out independently of the implementation. */
    const MODEL_DEDUP_PER_AUTHOR = 50;
    const MODEL_HISTORY_LIMIT = 200;

    /** Never committed: probing with it reveals the next seq / rate-limit state without changing anything. */
    const PROBE_AUTHOR: ChatAuthor = { id: 'probe-author', displayName: 'Probe' };
    const PROBE_ID = 'ffffffff-ffff-4fff-bfff-fffffffffffe';

    /**
     * Client_Message_Id choice for one send, resolved against the ids sent so
     * far in the run (never against the model's prediction):
     * - fresh: a new UUID (maybe case-flipped)
     * - ownRecent: one of this author's last 10 sent ids (mostly replays)
     * - ownAny: any id this author sent (reaches buffer-evicted duplicates)
     * - ownFirst: one of this author's first 3 sent ids (dedup-evicted once the author passes 50)
     * - other: an id another author sent (R16.11)
     * Reuses are case-flipped by `flags`; with no candidate they fall back to `freshId`.
     */
    type DedupIdChoice =
      | { kind: 'fresh' }
      | { kind: 'ownRecent' | 'ownAny' | 'ownFirst' | 'other'; pick: number; flags: boolean[] };

    interface DedupCommand {
      clockStep: number;
      authorIndex: number;
      freshId: string;
      idChoice: DedupIdChoice;
      text: string;
    }

    const flagsArb = fc.array(fc.boolean(), { minLength: 36, maxLength: 36 });

    const dedupIdChoiceArb: fc.Arbitrary<DedupIdChoice> = fc.oneof(
      { weight: 6, arbitrary: fc.constant<DedupIdChoice>({ kind: 'fresh' }) },
      ...(['ownRecent', 'ownAny', 'ownFirst', 'other'] as const).map((kind) => ({
        weight: 1,
        arbitrary: fc
          .record({ pick: fc.nat(), flags: flagsArb })
          .map(({ pick, flags }): DedupIdChoice => ({ kind, pick, flags })),
      })),
    );

    /** Skewed authors: busy ones pass 50 ids (dedup eviction), quiet ones keep ids past buffer eviction. */
    const skewedAuthorIndexArb: fc.Arbitrary<number> = fc.oneof(
      { weight: 4, arbitrary: fc.constant(0) },
      { weight: 4, arbitrary: fc.constant(1) },
      { weight: 3, arbitrary: fc.constant(2) },
      { weight: 2, arbitrary: fc.constant(3) },
      { weight: 1, arbitrary: fc.constant(4) },
    );

    /** Long runs with mostly ≥ 1 s steps: many accepts, so both buffer and dedup eviction happen. */
    const evictingDedupCommandsArb: fc.Arbitrary<DedupCommand[]> = fc.array(
      fc.record({
        clockStep: fc.oneof(
          { weight: 8, arbitrary: fc.integer({ min: 1_000, max: 3_000 }) },
          { weight: 1, arbitrary: fc.integer({ min: 0, max: 999 }) },
          { weight: 1, arbitrary: fc.integer({ min: -2_000, max: -1 }) },
        ),
        authorIndex: skewedAuthorIndexArb,
        freshId: fc.oneof(uuidArb, caseFlippedUuidArb),
        idChoice: dedupIdChoiceArb,
        text: textArb,
      }),
      { minLength: 1, maxLength: 500, size: 'max' },
    );

    /** Short bursts by two authors: authors hit the rate limit while resending held ids (R17.4). */
    const burstyDedupCommandsArb: fc.Arbitrary<DedupCommand[]> = fc.array(
      fc.record({
        clockStep: fc.oneof(
          { weight: 6, arbitrary: fc.integer({ min: 0, max: 200 }) },
          { weight: 1, arbitrary: fc.integer({ min: 5_000, max: 10_000 }) },
          { weight: 1, arbitrary: fc.integer({ min: -2_000, max: -1 }) },
        ),
        authorIndex: fc.integer({ min: 0, max: 1 }),
        freshId: fc.oneof(uuidArb, caseFlippedUuidArb),
        idChoice: dedupIdChoiceArb,
        text: textArb,
      }),
      { minLength: 1, maxLength: 120 },
    );

    type Probe =
      | { kind: 'accepted'; seq: number }
      | { kind: 'rejected'; code: string; retryAfterMs: number | undefined }
      | { kind: 'replay' };

    function probe(room: ChatRoom, author: ChatAuthor): Probe {
      const d = room.prepare(author, PROBE_ID, 'probe');
      if (d.kind === 'accepted') return { kind: 'accepted', seq: d.message.seq };
      if (d.kind === 'rejected') return { kind: 'rejected', code: d.code, retryAfterMs: d.retryAfterMs };
      return { kind: 'replay' };
    }

    function seqsOf(messages: readonly ChatMessage[]): number[] {
      return messages.map((m) => m.seq);
    }

    /**
     * **Validates: Requirements 16.4, 16.5, 16.6, 16.7, 16.11, 17.4**
     */
    it('replay / CHAT_DUPLICATE / new-message decisions match a per-author FIFO dedup model', () => {
      expect(CHAT_DEDUP_PER_AUTHOR).toBe(MODEL_DEDUP_PER_AUTHOR);
      expect(CHAT_HISTORY_LIMIT).toBe(MODEL_HISTORY_LIMIT);

      const coverage = {
        replay: 0,
        bufferEvictedDuplicate: 0,
        dedupEvictedReaccepted: 0,
        crossAuthorMiss: 0,
        caseFlippedHit: 0,
        hitWhileRateLimited: 0,
        idempotentResends: 0,
      };

      fc.assert(
        fc.property(
          startMsArb,
          fc.oneof({ weight: 3, arbitrary: evictingDedupCommandsArb }, { weight: 1, arbitrary: burstyDedupCommandsArb }),
          (startMs, commands) => {
            let nowMs = startMs;
            const room = new ChatRoom({ clock: () => nowMs });

            // ---- Independent model ------------------------------------------
            /** authorId → (lower-cased clientMessageId → seq), insertion order = FIFO age. */
            const modelDedup = new Map<string, Map<string, number>>();
            /** Accepted messages by seq - 1, with a JSON snapshot taken at acceptance. */
            const accepted: { message: ChatMessage; snapshot: string }[] = [];
            /** authorId → every lower-cased id this author ever had accepted. */
            const everAccepted = new Map<string, Set<string>>();

            const modelRecord = (authorId: string, lowerId: string, seq: number): void => {
              let entries = modelDedup.get(authorId);
              if (!entries) {
                entries = new Map<string, number>();
                modelDedup.set(authorId, entries);
              }
              if (!entries.has(lowerId) && entries.size >= MODEL_DEDUP_PER_AUTHOR) {
                const oldest = entries.keys().next().value as string;
                entries.delete(oldest);
              }
              entries.set(lowerId, seq);
            };
            const isBuffered = (seq: number): boolean => seq > accepted.length - MODEL_HISTORY_LIMIT;

            // ---- Run records used to resolve id choices and check R16.7 -------
            const sentByAuthor = new Map<string, string[]>(AUTHORS.map((a) => [a.id, []]));
            const authorAccepts = new Map<string, number>(AUTHORS.map((a) => [a.id, 0]));
            /** `${authorId}|${lowerId}` → idempotence bookkeeping. */
            const pairs = new Map<
              string,
              { sends: number; acceptedCount: number; firstAcceptIdx?: number; lastSendAcceptsBefore: number }
            >();

            for (const cmd of commands) {
              nowMs = clampClock(nowMs + cmd.clockStep);
              const author = AUTHORS[cmd.authorIndex];
              const own = sentByAuthor.get(author.id) as string[];

              // Resolve the Client_Message_Id from what was sent so far.
              let clientMessageId = cmd.freshId;
              const choice = cmd.idChoice;
              if (choice.kind !== 'fresh') {
                let candidates: readonly string[] = [];
                if (choice.kind === 'ownRecent') candidates = own.slice(-10);
                else if (choice.kind === 'ownAny') candidates = own;
                else if (choice.kind === 'ownFirst') candidates = own.slice(0, 3);
                else {
                  const otherIndex = (cmd.authorIndex + 1 + (choice.pick % (AUTHORS.length - 1))) % AUTHORS.length;
                  candidates = sentByAuthor.get(AUTHORS[otherIndex].id) as string[];
                }
                if (candidates.length > 0) {
                  clientMessageId = flipCase(candidates[choice.pick % candidates.length], choice.flags);
                }
              }
              const lowerId = clientMessageId.toLowerCase();
              own.push(clientMessageId);

              const pairKey = `${author.id}|${lowerId}`;
              const pair = pairs.get(pairKey) ?? { sends: 0, acceptedCount: 0, lastSendAcceptsBefore: 0 };
              pairs.set(pairKey, pair);
              pair.sends++;
              pair.lastSendAcceptsBefore = authorAccepts.get(author.id) as number;

              // Observable state before the send.
              const rateBefore = probe(room, author);
              expect(rateBefore.kind).not.toBe('replay');
              const authorLimited = rateBefore.kind === 'rejected';

              // ---- Prediction -----------------------------------------------
              const heldSeq = modelDedup.get(author.id)?.get(lowerId);

              if (heldSeq !== undefined) {
                const historyBefore = room.history();
                const decision = room.prepare(author, clientMessageId, cmd.text);
                const original = accepted[heldSeq - 1];

                if (isBuffered(heldSeq)) {
                  // R16.5: the stored message, unchanged, regardless of the new text.
                  expect(decision.kind).toBe('replay');
                  if (decision.kind !== 'replay') return;
                  expect(decision.message).toBe(original.message);
                  expect(JSON.stringify(decision.message)).toBe(original.snapshot);
                  coverage.replay++;
                } else {
                  // R16.6: recorded but evicted from the Chat_Buffer.
                  expect(decision.kind).toBe('rejected');
                  if (decision.kind !== 'rejected') return;
                  expect(decision.code).toBe('CHAT_DUPLICATE');
                  expect(decision.retryAfterMs).toBeUndefined();
                  coverage.bufferEvictedDuplicate++;
                }
                if (clientMessageId !== original.message.clientMessageId) coverage.caseFlippedHit++;
                if (authorLimited) coverage.hitWhileRateLimited++;

                // R16.3 / R17.4: no state change, rate limiter neither consulted nor counted.
                const historyAfter = room.history();
                expect(seqsOf(historyAfter)).toEqual(seqsOf(historyBefore));
                expect(historyAfter.every((m, i) => m === historyBefore[i])).toBe(true);
                expect(probe(room, author)).toEqual(rateBefore);
              } else {
                // Miss for this author: new message, subject only to the rate limit.
                if (everAccepted.get(author.id)?.has(lowerId)) coverage.dedupEvictedReaccepted++;
                const otherHolder = AUTHORS.find(
                  (a) => a.id !== author.id && modelDedup.get(a.id)?.has(lowerId),
                );
                if (otherHolder) coverage.crossAuthorMiss++;

                const historyBefore = room.history();
                const decision = room.prepare(author, clientMessageId, cmd.text);
                expect(decision.kind).not.toBe('replay');

                if (decision.kind === 'accepted') {
                  // The rate-limit outcome as observed by the probe decides; no dedup hit.
                  expect(rateBefore.kind).toBe('accepted');
                  const seq = accepted.length + 1;
                  expect(decision.message.seq).toBe(seq);
                  expect(decision.message.clientMessageId).toBe(clientMessageId);
                  expect(decision.message.authorId).toBe(author.id);
                  expect(decision.message.text).toBe(cmd.text);
                  decision.commit();

                  accepted.push({ message: decision.message, snapshot: JSON.stringify(decision.message) });
                  modelRecord(author.id, lowerId, seq);
                  let ever = everAccepted.get(author.id);
                  if (!ever) {
                    ever = new Set<string>();
                    everAccepted.set(author.id, ever);
                  }
                  ever.add(lowerId);
                  if (pair.firstAcceptIdx === undefined) pair.firstAcceptIdx = authorAccepts.get(author.id) as number;
                  pair.acceptedCount++;
                  authorAccepts.set(author.id, (authorAccepts.get(author.id) as number) + 1);
                } else if (decision.kind === 'rejected') {
                  expect(decision.code).toBe('CHAT_RATE_LIMITED');
                  expect(rateBefore).toEqual({
                    kind: 'rejected',
                    code: 'CHAT_RATE_LIMITED',
                    retryAfterMs: decision.retryAfterMs,
                  });
                  const historyAfter = room.history();
                  expect(seqsOf(historyAfter)).toEqual(seqsOf(historyBefore));
                }

                // R16.11: the other author's entry still answers for them, unchanged.
                if (otherHolder) {
                  const otherSeq = modelDedup.get(otherHolder.id)?.get(lowerId) as number;
                  const otherDecision = room.prepare(otherHolder, clientMessageId, 'other');
                  if (isBuffered(otherSeq)) {
                    expect(otherDecision.kind).toBe('replay');
                    if (otherDecision.kind === 'replay') {
                      expect(otherDecision.message).toBe(accepted[otherSeq - 1].message);
                    }
                  } else {
                    expect(otherDecision).toMatchObject({ kind: 'rejected', code: 'CHAT_DUPLICATE' });
                  }
                }
              }

              // The next seq is the model's: only acceptances move it.
              expect(probe(room, PROBE_AUTHOR)).toEqual({ kind: 'accepted', seq: accepted.length + 1 });
            }

            // Final buffer is the last 200 accepted messages.
            expect(seqsOf(room.history())).toEqual(seqsOf(accepted.slice(-MODEL_HISTORY_LIMIT).map((a) => a.message)));

            // R16.7: fewer than 50 other accepts by the author between the first
            // acceptance and the last send ⇒ exactly one message for that id.
            for (const p of pairs.values()) {
              if (p.firstAcceptIdx === undefined) continue;
              const others = Math.max(0, p.lastSendAcceptsBefore - (p.firstAcceptIdx + 1));
              if (others < MODEL_DEDUP_PER_AUTHOR) {
                expect(p.acceptedCount).toBe(1);
                if (p.sends > 1) coverage.idempotentResends++;
              }
            }
          },
        ),
        { numRuns: 100 },
      );

      // Every branch of the model was exercised.
      expect(coverage.replay).toBeGreaterThan(0);
      expect(coverage.bufferEvictedDuplicate).toBeGreaterThan(0);
      expect(coverage.dedupEvictedReaccepted).toBeGreaterThan(0);
      expect(coverage.crossAuthorMiss).toBeGreaterThan(0);
      expect(coverage.caseFlippedHit).toBeGreaterThan(0);
      expect(coverage.hitWhileRateLimited).toBeGreaterThan(0);
      expect(coverage.idempotentResends).toBeGreaterThan(0);
    });
  });

  // Feature: session-chat, Property 13: The rate limiter allows at most five per window
  describe('Property 13: The rate limiter allows at most five per window', () => {
    /** Model constants, written out independently of the implementation. */
    const MODEL_COUNT = 5;
    const MODEL_WINDOW_MS = 5000;

    type Role = 'moderator' | 'participant';

    /**
     * Authors with a role the test knows but never passes in: neither
     * `ChatRoom.prepare` nor `ChatRateLimiter` takes a role (R17.9).
     */
    const RATE_AUTHORS: readonly { author: ChatAuthor; role: Role }[] = Object.freeze([
      { author: { id: 'owner-moderator', displayName: 'Mona' }, role: 'moderator' },
      { author: { id: 'participant-1', displayName: 'Pat' }, role: 'participant' },
      { author: { id: 'anon-participant', displayName: 'Guest 7' }, role: 'participant' },
    ]);

    /** Exact type equality, for compile-time API checks (ts-jest type-checks this file). */
    type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

    // ---- Independent sliding-window model ---------------------------------

    type ModelLimit =
      | { limited: false }
      | {
          limited: true;
          /** Number of acceptance times with `now - t < windowMs` (all of them, none dropped). */
          inWindow: number;
          /** `t + windowMs - now` for the count-th most recent in-window time, before rounding/clamping. */
          raw: number;
          /** `t + windowMs - now` for the earliest in-window time (the literal t_oldest of R17.2). */
          earliestRaw: number;
          /** Some in-window time lies after `now` (only after the clock moved backwards). */
          future: boolean;
        };

    /** Model decision for an author whose every acceptance time is in `times`. */
    function modelLimit(times: readonly number[], now: number, count: number, windowMs: number): ModelLimit {
      const inWindow = times.filter((t) => now - t < windowMs).sort((a, b) => b - a);
      if (inWindow.length < count) return { limited: false };
      return {
        limited: true,
        inWindow: inWindow.length,
        raw: inWindow[count - 1] + windowMs - now,
        earliestRaw: inWindow[inWindow.length - 1] + windowMs - now,
        future: inWindow[0] > now,
      };
    }

    function clampRetry(raw: number, windowMs: number): number {
      return Math.min(windowMs, Math.max(1, Math.ceil(raw)));
    }

    // ---- (1) ChatRoom driven with a generated clock ------------------------

    interface RateCommand {
      clockStep: number;
      authorIndex: number;
    }

    /** Mostly 0 and small forward steps so authors hit the limit; some window-clearing jumps and backward steps. */
    const rateClockStepArb: fc.Arbitrary<number> = fc.oneof(
      { weight: 4, arbitrary: fc.constant(0) },
      { weight: 10, arbitrary: fc.integer({ min: 1, max: 400 }) },
      { weight: 3, arbitrary: fc.integer({ min: 401, max: 2_500 }) },
      { weight: 1, arbitrary: fc.integer({ min: 5_000, max: 12_000 }) },
      { weight: 2, arbitrary: fc.integer({ min: -8_000, max: -1 }) },
    );

    const rateAuthorIndexArb: fc.Arbitrary<number> = fc.oneof(
      { weight: 3, arbitrary: fc.constant(0) },
      { weight: 2, arbitrary: fc.constant(1) },
      { weight: 1, arbitrary: fc.constant(2) },
    );

    /**
     * Long mixed sequences. `size: 'max'` matters: without it fast-check caps the
     * generated length near 10 regardless of `maxLength`, too short for most
     * authors to reach five accepts in one window.
     */
    const mixedRateCommandsArb: fc.Arbitrary<RateCommand[]> = fc.array(
      fc.record({ clockStep: rateClockStepArb, authorIndex: rateAuthorIndexArb }),
      { minLength: 1, maxLength: 150, size: 'max' },
    );

    /**
     * Bursts by one author: `clockStep` before the first send, then `burstGapMs`
     * before each later one. A burst of six or more within 2,000 ms always hits
     * the limit, so every role is rejected on every seed (as in Property 14).
     */
    const burstyRateCommandsArb: fc.Arbitrary<RateCommand[]> = fc
      .array(
        fc.record({
          clockStep: rateClockStepArb,
          authorIndex: rateAuthorIndexArb,
          burst: fc.integer({ min: 1, max: 8 }),
          burstGapMs: fc.integer({ min: 0, max: 400 }),
        }),
        { minLength: 1, maxLength: 20, size: 'max' },
      )
      .map((bursts) =>
        bursts.flatMap((b) =>
          Array.from({ length: b.burst }, (_, i): RateCommand => ({
            clockStep: i === 0 ? b.clockStep : b.burstGapMs,
            authorIndex: b.authorIndex,
          })),
        ),
      );

    const rateCommandsArb: fc.Arbitrary<RateCommand[]> = fc.oneof(
      { weight: 3, arbitrary: mixedRateCommandsArb },
      { weight: 1, arbitrary: burstyRateCommandsArb },
    );

    type RateProbe =
      | { kind: 'accepted' }
      | { kind: 'rejected'; code: string; retryAfterMs: number | undefined }
      | { kind: 'replay' };

    function summarize(d: ChatSubmitDecision): RateProbe {
      if (d.kind === 'accepted') return { kind: 'accepted' };
      if (d.kind === 'rejected') return { kind: 'rejected', code: d.code, retryAfterMs: d.retryAfterMs };
      return { kind: 'replay' };
    }

    /**
     * **Validates: Requirements 17.1, 17.2, 17.3, 17.6, 17.8, 17.9**
     */
    it('ChatRoom accepts / rejects with retryAfterMs exactly as a per-author sliding-window model', () => {
      expect(CHAT_RATE_LIMIT_COUNT).toBe(MODEL_COUNT);
      expect(CHAT_RATE_LIMIT_WINDOW_MS).toBe(MODEL_WINDOW_MS);

      const coverage = {
        rejectedModerator: 0,
        rejectedParticipant: 0,
        acceptedAfterWait: 0,
        futureDatedRejections: 0,
      };

      fc.assert(
        fc.property(startMsArb, rateCommandsArb, (startMs, commands) => {
          let nowMs = startMs;
          const room = new ChatRoom({ clock: () => nowMs });
          let idCounter = 0;
          // Distinct ids for every send and probe, so the dedup check never hits.
          const freshId = (): string => `00000000-0000-4000-8000-${(idCounter++).toString(16).padStart(12, '0')}`;

          /** authorId → every acceptance time, never trimmed. */
          const modelTimes = new Map<string, number[]>(RATE_AUTHORS.map((a) => [a.author.id, []]));
          /** authorId → clock reading of every send the room actually accepted. */
          const acceptedAt = new Map<string, number[]>(RATE_AUTHORS.map((a) => [a.author.id, []]));

          /** Prepares (never commits) a fresh-id send at `atMs`, then restores the clock. */
          const probeAt = (author: ChatAuthor, atMs: number): RateProbe => {
            const saved = nowMs;
            nowMs = atMs;
            try {
              return summarize(room.prepare(author, freshId(), 'probe'));
            } finally {
              nowMs = saved;
            }
          };

          for (const cmd of commands) {
            nowMs = clampClock(nowMs + cmd.clockStep);
            const { author: base, role } = RATE_AUTHORS[cmd.authorIndex];
            // A new author object per send: any Board_Connection of the same user (R17.1).
            const author: ChatAuthor = { ...base };
            const times = modelTimes.get(author.id) as number[];
            const expected = modelLimit(times, nowMs, MODEL_COUNT, MODEL_WINDOW_MS);

            const others = RATE_AUTHORS.filter((a) => a.author.id !== author.id).map((a) => a.author);
            const othersBefore = others.map((o) => probeAt(o, nowMs));
            const historyBefore = room.history();

            const decision = room.prepare(author, freshId(), 'hello');
            expect(decision.kind).not.toBe('replay');

            if (decision.kind === 'accepted') {
              // (b) accepted iff fewer than 5 of this author's accepts satisfy now - t < 5000.
              expect(expected.limited).toBe(false);
              decision.commit();
              times.push(nowMs);
              (acceptedAt.get(author.id) as number[]).push(nowMs);
            } else if (decision.kind === 'rejected') {
              expect(expected.limited).toBe(true);
              if (!expected.limited) return;
              expect(decision.code).toBe('CHAT_RATE_LIMITED');

              // (b) retryAfterMs: whole ms in [1, 5000], equal to the model's value (R17.2).
              const retry = decision.retryAfterMs as number;
              expect(Number.isInteger(retry)).toBe(true);
              expect(retry).toBeGreaterThanOrEqual(1);
              expect(retry).toBeLessThanOrEqual(MODEL_WINDOW_MS);
              expect(retry).toBe(clampRetry(expected.raw, MODEL_WINDOW_MS));
              if (!expected.future) {
                // Forward-moving clock: exactly 5 in the window, and the value is
                // the literal (t_oldest + 5000) − now with no clamping.
                expect(expected.inWindow).toBe(MODEL_COUNT);
                expect(expected.raw).toBe(expected.earliestRaw);
                expect(retry).toBe(expected.raw);
              } else {
                coverage.futureDatedRejections++;
              }
              if (role === 'moderator') coverage.rejectedModerator++;
              else coverage.rejectedParticipant++;

              // (c) A rejected send changes nothing and records no time (R17.3).
              const historyAfter = room.history();
              expect(historyAfter.length).toBe(historyBefore.length);
              expect(historyAfter.every((m, i) => m === historyBefore[i])).toBe(true);
              expect(probeAt(author, nowMs)).toEqual(summarize(decision));

              // (d) After waiting retryAfterMs the next send is accepted, and not 1 ms
              // earlier (R17.8). Holds whenever no clamp was needed; a clamp is only
              // needed after the clock moved back before a recorded time.
              if (expected.raw <= MODEL_WINDOW_MS) {
                expect(probeAt(author, nowMs + retry - 1)).toEqual({
                  kind: 'rejected',
                  code: 'CHAT_RATE_LIMITED',
                  retryAfterMs: 1,
                });
                expect(probeAt(author, nowMs + retry)).toEqual({ kind: 'accepted' });
                coverage.acceptedAfterWait++;
              }
            }

            // (e) Other authors' outcomes are untouched by this send.
            expect(others.map((o) => probeAt(o, nowMs))).toEqual(othersBefore);
          }

          // (a) Invariant (R17.6): every half-open [t, t + 5000) holds at most 5 of
          // one author's accepts. The fullest such interval can always be shifted
          // to start at an accept time, so checking those starts covers all t.
          for (const ts of acceptedAt.values()) {
            for (const t of ts) {
              const inInterval = ts.filter((u) => u >= t && u < t + MODEL_WINDOW_MS).length;
              expect(inInterval).toBeLessThanOrEqual(MODEL_COUNT);
            }
          }
        }),
        { numRuns: 100 },
      );

      // Both roles hit the limit, waits were checked, and backward clocks reached the limiter.
      expect(coverage.rejectedModerator).toBeGreaterThan(0);
      expect(coverage.rejectedParticipant).toBeGreaterThan(0);
      expect(coverage.acceptedAfterWait).toBeGreaterThan(0);
      expect(coverage.futureDatedRejections).toBeGreaterThan(0);
    });

    // ---- (2) ChatRateLimiter driven directly --------------------------------

    type LimiterConfig = { useDefaults: true } | { useDefaults: false; count: number; windowMs: number };

    const limiterConfigArb: fc.Arbitrary<LimiterConfig> = fc.oneof(
      { weight: 2, arbitrary: fc.constant<LimiterConfig>({ useDefaults: true }) },
      {
        weight: 1,
        arbitrary: fc
          .record({ count: fc.integer({ min: 1, max: 6 }), windowMs: fc.integer({ min: 1, max: 8_000 }) })
          .map((c): LimiterConfig => ({ useDefaults: false, ...c })),
      },
    );

    interface LimiterOp {
      kind: 'check' | 'record';
      authorIndex: number;
      clockStep: number;
      /** Pass the reading as `nowMs` / `atMs` while the clock shows a decoy value. */
      explicit: boolean;
    }

    /** Arbitrary clock movement, backwards included, with some quarter-ms readings. */
    const limiterClockStepArb: fc.Arbitrary<number> = fc.oneof(
      { weight: 3, arbitrary: fc.constant(0) },
      { weight: 6, arbitrary: fc.integer({ min: -300, max: 1_000 }) },
      { weight: 2, arbitrary: fc.integer({ min: -20_000, max: 20_000 }) },
      { weight: 1, arbitrary: fc.integer({ min: -12_000, max: 12_000 }).map((n) => n / 4) },
    );

    const limiterOpsArb: fc.Arbitrary<LimiterOp[]> = fc.array(
      fc.record({
        kind: fc.constantFrom<'check' | 'record'>('check', 'record'),
        authorIndex: fc.integer({ min: 0, max: RATE_AUTHORS.length - 1 }),
        clockStep: limiterClockStepArb,
        explicit: fc.boolean(),
      }),
      // `size: 'max'`: without it fast-check caps the length near 10, which on
      // some seeds never reaches a limited, clamped check.
      { minLength: 1, maxLength: 200, size: 'max' },
    );

    /** Swaps the moderator and a participant for the relabelled limiter. */
    const SWAP: readonly number[] = [1, 0, 2];
    const DECOY_OFFSET_MS = 987_654;

    /**
     * **Validates: Requirements 17.1, 17.2, 17.3, 17.6, 17.8, 17.9**
     */
    it('ChatRateLimiter.check matches the model for any clock, never mutates, and ignores role', () => {
      let limitedChecks = 0;
      let clampedChecks = 0;

      fc.assert(
        fc.property(limiterConfigArb, fc.integer({ min: 0, max: 1_000_000_000_000 }), limiterOpsArb, (config, startMs, ops) => {
          let clockMs = startMs;
          const clock = (): number => clockMs;
          const count = config.useDefaults ? MODEL_COUNT : config.count;
          const windowMs = config.useDefaults ? MODEL_WINDOW_MS : config.windowMs;
          const make = (): ChatRateLimiter =>
            config.useDefaults ? new ChatRateLimiter(clock) : new ChatRateLimiter(clock, config.count, config.windowMs);
          const limiter = make();
          // Same operations with the moderator's and a participant's ids swapped (R17.9).
          const relabelled = make();
          const model = new Map<string, number[]>();

          let reading = startMs;
          for (const op of ops) {
            reading += op.clockStep;
            clockMs = op.explicit ? reading + DECOY_OFFSET_MS : reading;
            const arg = op.explicit ? reading : undefined;
            const id = RATE_AUTHORS[op.authorIndex].author.id;
            const swappedId = RATE_AUTHORS[SWAP[op.authorIndex]].author.id;

            if (op.kind === 'record') {
              limiter.record(id, arg);
              relabelled.record(swappedId, arg);
              const times = model.get(id) ?? [];
              times.push(reading);
              model.set(id, times);
              continue;
            }

            const m = modelLimit(model.get(id) ?? [], reading, count, windowMs);
            const expected = m.limited ? { ok: false, retryAfterMs: clampRetry(m.raw, windowMs) } : { ok: true };

            const first = limiter.check(id, arg);
            expect(first).toEqual(expected);
            // check never mutates: an immediate repeat gives the same answer, and
            // every later answer still matches a model that check never touches.
            expect(limiter.check(id, arg)).toEqual(first);
            expect(relabelled.check(swappedId, arg)).toEqual(first);

            if (!first.ok) {
              limitedChecks++;
              if (m.limited && m.raw > windowMs) clampedChecks++;
              expect(Number.isInteger(first.retryAfterMs)).toBe(true);
              expect(first.retryAfterMs).toBeGreaterThanOrEqual(1);
              expect(first.retryAfterMs).toBeLessThanOrEqual(windowMs);
            }
          }
        }),
        { numRuns: 100 },
      );

      expect(limitedChecks).toBeGreaterThan(0);
      expect(clampedChecks).toBeGreaterThan(0);
    });

    /**
     * **Validates: Requirements 17.9**
     */
    it('has no role input anywhere in the rate-limit path', () => {
      // Compile-time: adding a role to the author or to the limiter API breaks these.
      const authorKeysOnly: Equals<keyof ChatAuthor, 'id' | 'displayName'> = true;
      const checkParams: Equals<Parameters<ChatRateLimiter['check']>, [authorId: string, nowMs?: number]> = true;
      const recordParams: Equals<Parameters<ChatRateLimiter['record']>, [authorId: string, atMs?: number]> = true;
      const prepareParams: Equals<
        Parameters<ChatRoom['prepare']>,
        [author: ChatAuthor, clientMessageId: string, text: string]
      > = true;
      expect([authorKeysOnly, checkParams, recordParams, prepareParams]).toEqual([true, true, true, true]);
    });
  });

  // Feature: session-chat, Property 14: Rate limits are isolated per author and session
  describe('Property 14: Rate limits are isolated per author and session', () => {
    /** Model constants, written out independently of the implementation. */
    const MODEL_COUNT = 5;
    const MODEL_WINDOW_MS = 5000;

    /**
     * The same user IDs take part in every session, so one user is an author
     * in several poker and retro sessions at once.
     */
    const ISOLATION_AUTHORS: readonly ChatAuthor[] = Object.freeze([
      { id: 'user-a', displayName: 'Ann' },
      { id: 'user-b', displayName: 'Ben' },
      { id: 'user-c', displayName: 'Cleo' },
    ]);

    /** Two to four Board_Sessions of either kind, one ChatRoom each (as GameSession / RetroSession hold). */
    const boardKindsArb: fc.Arbitrary<BoardKind[]> = fc.array(fc.constantFrom<BoardKind>('poker', 'retro'), {
      minLength: 2,
      maxLength: 4,
    });

    /**
     * A burst of `burst` sends by one author in one session: the clock moves by
     * `clockStep` before the first send and by `burstGapMs` before each later one.
     * Bursts let a pair reach the limit while other pairs stay below it.
     */
    interface IsolationCommand {
      clockStep: number;
      /** Index into the generated sessions, taken modulo their number. */
      roomPick: number;
      authorIndex: number;
      burst: number;
      burstGapMs: number;
    }

    /** Mostly small forward steps; some window-clearing jumps and backward steps. */
    const isolationCommandsArb: fc.Arbitrary<IsolationCommand[]> = fc.array(
      fc.record({
        clockStep: fc.oneof(
          { weight: 4, arbitrary: fc.constant(0) },
          { weight: 10, arbitrary: fc.integer({ min: 1, max: 300 }) },
          { weight: 2, arbitrary: fc.integer({ min: 301, max: 2_500 }) },
          { weight: 1, arbitrary: fc.integer({ min: 5_000, max: 12_000 }) },
          { weight: 1, arbitrary: fc.integer({ min: -8_000, max: -1 }) },
        ),
        roomPick: fc.nat(),
        authorIndex: fc.oneof(
          { weight: 3, arbitrary: fc.constant(0) },
          { weight: 2, arbitrary: fc.constant(1) },
          { weight: 1, arbitrary: fc.constant(2) },
        ),
        burst: fc.integer({ min: 1, max: 8 }),
        burstGapMs: fc.integer({ min: 0, max: 400 }),
      }),
      { minLength: 1, maxLength: 40 },
    );

    type Outcome = { kind: 'accepted' } | { kind: 'rejected'; code: string; retryAfterMs: number | undefined } | { kind: 'replay' };

    function summarize(d: ChatSubmitDecision): Outcome {
      if (d.kind === 'accepted') return { kind: 'accepted' };
      if (d.kind === 'rejected') return { kind: 'rejected', code: d.code, retryAfterMs: d.retryAfterMs };
      return { kind: 'replay' };
    }

    /**
     * Expected outcome computed only from one author's acceptance times in one
     * session: limited iff at least 5 satisfy `now - t < 5000`; retryAfterMs
     * from the 5th most recent of those, rounded up and clamped to [1, 5000].
     */
    function modelOutcome(times: readonly number[], now: number): Outcome {
      const inWindow = times.filter((t) => now - t < MODEL_WINDOW_MS).sort((a, b) => b - a);
      if (inWindow.length < MODEL_COUNT) return { kind: 'accepted' };
      const raw = inWindow[MODEL_COUNT - 1] + MODEL_WINDOW_MS - now;
      const retryAfterMs = Math.min(MODEL_WINDOW_MS, Math.max(1, Math.ceil(raw)));
      return { kind: 'rejected', code: 'CHAT_RATE_LIMITED', retryAfterMs };
    }

    /**
     * **Validates: Requirements 17.10**
     */
    it("a send is rate-limited only by that author's own accepts in that same session", () => {
      expect(CHAT_RATE_LIMIT_COUNT).toBe(MODEL_COUNT);
      expect(CHAT_RATE_LIMIT_WINDOW_MS).toBe(MODEL_WINDOW_MS);

      const coverage = {
        rejectedSends: 0,
        /** One author limited in one session and free in another at the same moment. */
        crossSessionSplit: 0,
        /** As above, with one poker and one retro session. */
        crossKindSplit: 0,
        /** In one session, one author limited while another is free. */
        crossAuthorSplit: 0,
      };

      fc.assert(
        fc.property(startMsArb, boardKindsArb, isolationCommandsArb, (startMs, kinds, commands) => {
          // One clock for all sessions, as on one server.
          let nowMs = startMs;
          const clock = (): number => nowMs;
          const rooms = kinds.map((kind) => ({ kind, room: new ChatRoom({ clock }) }));
          /** modelTimes[session][author]: acceptance times of that author in that session only. */
          const modelTimes: number[][][] = rooms.map(() => ISOLATION_AUTHORS.map(() => []));

          let idCounter = 0;
          // Distinct ids for every send and probe, so the dedup check never hits.
          const freshId = (): string => `00000000-0000-4000-8000-${(idCounter++).toString(16).padStart(12, '0')}`;

          for (const cmd of commands) {
            for (let b = 0; b < cmd.burst; b++) {
              nowMs = clampClock(nowMs + (b === 0 ? cmd.clockStep : cmd.burstGapMs));
              const r = cmd.roomPick % rooms.length;
              // A new author object per send: any Board_Connection of that user.
              const author: ChatAuthor = { ...ISOLATION_AUTHORS[cmd.authorIndex] };
              const times = modelTimes[r][cmd.authorIndex];

              const decision = rooms[r].room.prepare(author, freshId(), 'hello');
              expect(summarize(decision)).toEqual(modelOutcome(times, nowMs));
              if (decision.kind === 'accepted') {
                decision.commit();
                times.push(nowMs);
              } else {
                coverage.rejectedSends++;
              }

              // Every (session, author) pair still answers from its own accepts only.
              // Probes prepare without committing, so they change nothing.
              const limited: boolean[][] = rooms.map(({ room }, i) =>
                ISOLATION_AUTHORS.map((a, j) => {
                  const actual = summarize(room.prepare({ ...a }, freshId(), 'probe'));
                  expect(actual).toEqual(modelOutcome(modelTimes[i][j], nowMs));
                  return actual.kind === 'rejected';
                }),
              );

              for (let j = 0; j < ISOLATION_AUTHORS.length; j++) {
                for (let i = 0; i < rooms.length; i++) {
                  for (let k = 0; k < rooms.length; k++) {
                    if (!limited[i][j] || limited[k][j]) continue;
                    coverage.crossSessionSplit++;
                    if (rooms[i].kind !== rooms[k].kind) coverage.crossKindSplit++;
                  }
                }
              }
              for (const row of limited) {
                if (row.some((x) => x) && row.some((x) => !x)) coverage.crossAuthorSplit++;
              }
            }
          }
        }),
        { numRuns: 100 },
      );

      expect(coverage.rejectedSends).toBeGreaterThan(0);
      expect(coverage.crossSessionSplit).toBeGreaterThan(0);
      expect(coverage.crossKindSplit).toBeGreaterThan(0);
      expect(coverage.crossAuthorSplit).toBeGreaterThan(0);
    });
  });
});
