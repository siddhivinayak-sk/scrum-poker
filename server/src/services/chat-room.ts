import crypto from 'crypto';
import {
  CHAT_DEDUP_PER_AUTHOR,
  CHAT_HISTORY_LIMIT,
  CHAT_RATE_LIMIT_COUNT,
  CHAT_RATE_LIMIT_WINDOW_MS,
  ChatMessage,
} from '../../../shared/types';

/**
 * Per-session chat state for one Board_Session (poker or retro).
 *
 * Every class here is instantiated by a `GameSession` / `RetroSession`; this
 * module holds no mutable state of its own (R17.5, R18.7).
 */

/** Current time in epoch milliseconds. Injected so tests can control time (R17.7). */
export type Clock = () => number;

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

// ---------------------------------------------------------------------------
// ChatBuffer
// ---------------------------------------------------------------------------

/**
 * Fixed-capacity ring buffer of the most recent Chat_Messages (R18.1, R18.2, R20.2).
 *
 * Messages are pushed in strictly contiguous ascending `seq` order, so the slot
 * of any held seq is computed directly from `lowestSeq` and `head`.
 */
export class ChatBuffer {
  private readonly slots: (ChatMessage | undefined)[];
  private readonly capacity: number;
  /** Slot index of the message with the lowest seq. */
  private head = 0;
  private count = 0;
  /** Seq of the message at `head`; meaningful only while `count > 0`. */
  private lowestSeq = 0;

  constructor(capacity: number = CHAT_HISTORY_LIMIT) {
    assertPositiveInteger('capacity', capacity);
    this.capacity = capacity;
    this.slots = new Array<ChatMessage | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  /**
   * Adds `message` in O(1). When full, evicts the message with the lowest seq
   * and returns it; otherwise returns null.
   *
   * `message.seq` must be exactly one more than the highest seq held (any seq
   * when empty). A violation throws before anything is mutated.
   */
  push(message: ChatMessage): ChatMessage | null {
    if (this.count > 0 && message.seq !== this.lowestSeq + this.count) {
      throw new RangeError('ChatBuffer.push: seq must follow the highest held seq');
    }

    if (this.count === 0) {
      this.slots[this.head] = message;
      this.lowestSeq = message.seq;
      this.count = 1;
      return null;
    }

    if (this.count < this.capacity) {
      this.slots[(this.head + this.count) % this.capacity] = message;
      this.count++;
      return null;
    }

    // Full: (head + count) % capacity === head, so overwrite the lowest seq.
    const evicted = this.slots[this.head] as ChatMessage;
    this.slots[this.head] = message;
    this.head = (this.head + 1) % this.capacity;
    this.lowestSeq++;
    return evicted;
  }

  /** O(1) lookup of a held message by seq; undefined if not (or no longer) held. */
  getBySeq(seq: number): ChatMessage | undefined {
    if (this.count === 0 || !Number.isInteger(seq)) return undefined;
    const offset = seq - this.lowestSeq;
    if (offset < 0 || offset >= this.count) return undefined;
    return this.slots[(this.head + offset) % this.capacity];
  }

  /** All held messages in ascending seq order, as a fresh array. */
  toArray(): ChatMessage[] {
    const result: ChatMessage[] = new Array<ChatMessage>(this.count);
    for (let i = 0; i < this.count; i++) {
      result[i] = this.slots[(this.head + i) % this.capacity] as ChatMessage;
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// ChatDedupRecord
// ---------------------------------------------------------------------------

/**
 * Per-author record of accepted Client_Message_Ids and their seq (R16.4–R16.6, R16.11).
 *
 * `clientMessageId` is lower-cased so ids differing only in hex case are one id.
 * Each inner Map keeps insertion order, so the author's oldest entry is the
 * first key and is evicted in O(1).
 */
export class ChatDedupRecord {
  private readonly perAuthor: number;
  private readonly byAuthor = new Map<string, Map<string, number>>();

  constructor(perAuthor: number = CHAT_DEDUP_PER_AUTHOR) {
    assertPositiveInteger('perAuthor', perAuthor);
    this.perAuthor = perAuthor;
  }

  /** Recorded seq for this author's `clientMessageId`, or undefined. */
  get(authorId: string, clientMessageId: string): number | undefined {
    return this.byAuthor.get(authorId)?.get(clientMessageId.toLowerCase());
  }

  /**
   * Records `clientMessageId → seq` for `authorId`. When that author already
   * holds `perAuthor` entries, their oldest entry is removed first; other
   * authors' entries are never touched.
   */
  record(authorId: string, clientMessageId: string, seq: number): void {
    const key = clientMessageId.toLowerCase();
    let entries = this.byAuthor.get(authorId);
    if (!entries) {
      entries = new Map<string, number>();
      this.byAuthor.set(authorId, entries);
    }
    if (!entries.has(key) && entries.size >= this.perAuthor) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
    entries.set(key, seq);
  }
}

// ---------------------------------------------------------------------------
// ChatRateLimiter
// ---------------------------------------------------------------------------

export type ChatRateLimitCheck = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * Sliding-window limiter keyed by author user ID only (R17.1, R17.2, R17.3, R17.9).
 *
 * Holds at most `count` acceptance times per author: if more than `count`
 * times were inside the window, the `count` largest would be too, so older
 * times never change a decision. `check` never mutates state; only `record`
 * (called on acceptance) does.
 */
export class ChatRateLimiter {
  private readonly clock: Clock;
  private readonly count: number;
  private readonly windowMs: number;
  /** Ascending acceptance times, at most `count` per author. */
  private readonly times = new Map<string, number[]>();

  constructor(
    clock: Clock,
    count: number = CHAT_RATE_LIMIT_COUNT,
    windowMs: number = CHAT_RATE_LIMIT_WINDOW_MS,
  ) {
    assertPositiveInteger('count', count);
    assertPositiveInteger('windowMs', windowMs);
    this.clock = clock;
    this.count = count;
    this.windowMs = windowMs;
  }

  /**
   * Decides whether `authorId` may have one more message accepted. `nowMs`
   * defaults to `clock()`; callers pass an explicit reading so that one clock
   * reading drives both the check and the later `record` (R17.7).
   */
  check(authorId: string, nowMs?: number): ChatRateLimitCheck {
    const recorded = this.times.get(authorId);
    if (!recorded) return { ok: true };

    const now = nowMs ?? this.clock();
    const inWindow = recorded.filter((t) => now - t < this.windowMs);
    if (inWindow.length < this.count) return { ok: true };

    // `recorded` is ascending, so the first in-window time is the oldest.
    const oldest = inWindow[0];
    const raw = Math.ceil(oldest + this.windowMs - now);
    const retryAfterMs = Math.min(this.windowMs, Math.max(1, raw));
    return { ok: false, retryAfterMs };
  }

  /** Records `atMs` (default `clock()`) as an acceptance time for `authorId`. */
  record(authorId: string, atMs?: number): void {
    const now = atMs ?? this.clock();
    let recorded = this.times.get(authorId);
    if (!recorded) {
      recorded = [];
      this.times.set(authorId, recorded);
    }
    // Insert keeping ascending order (the clock may move backwards).
    let i = recorded.length;
    while (i > 0 && recorded[i - 1] > now) i--;
    recorded.splice(i, 0, now);
    // Keep only the `count` largest times.
    if (recorded.length > this.count) {
      recorded.splice(0, recorded.length - this.count);
    }
  }
}

// ---------------------------------------------------------------------------
// ChatRoom
// ---------------------------------------------------------------------------

export type ChatSubmitDecision =
  | { kind: 'accepted'; message: ChatMessage; commit: () => void }
  | { kind: 'replay'; message: ChatMessage }
  | { kind: 'rejected'; code: 'CHAT_DUPLICATE' | 'CHAT_RATE_LIMITED'; retryAfterMs?: number };

export interface ChatRoomOptions {
  /** Epoch-ms clock for `sentAt`, rate limiting and `onAccepted` (R17.7). Default `Date.now`. */
  clock?: Clock;
  /** Message id factory (R16.1). Default `crypto.randomUUID`. */
  idFactory?: () => string;
  /** Called last in `commit()` with the clock reading of the acceptance (R18.10). */
  onAccepted?: (atMs: number) => void;
}

export interface ChatAuthor {
  id: string;
  displayName: string;
}

/**
 * All chat state of one Board_Session: Chat_Buffer, Sequence_Number counter,
 * Dedup_Record and Chat_Rate_Limiter (R18.6, R18.7).
 *
 * `prepare` decides and builds without mutating; the caller serialises the
 * outgoing frame and only then runs `commit()`, so an exception before the
 * commit leaves every part of the state unchanged (R16.3, R20.7).
 */
export class ChatRoom {
  private readonly clock: Clock;
  private readonly idFactory: () => string;
  private readonly onAccepted: (atMs: number) => void;
  private readonly buffer = new ChatBuffer();
  private readonly dedup = new ChatDedupRecord();
  private readonly rateLimiter: ChatRateLimiter;
  /** Sequence_Number the next accepted message gets (R16.2, R18.6). */
  private nextSeq = 1;
  /** `sentAt` of the last accepted message in epoch ms; keeps `sentAt` non-decreasing (R16.1, R16.2). */
  private lastSentAtMs = -Infinity;

  constructor(options: ChatRoomOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.onAccepted = options.onAccepted ?? (() => undefined);
    this.rateLimiter = new ChatRateLimiter(this.clock);
  }

  /**
   * Steps 5 (duplicate) and 6 (rate limit) of R14.11, plus message
   * construction. Mutates nothing; an `accepted` result applies its state
   * change only when its `commit()` runs.
   *
   * `text` must already be the Normalised_Text.
   */
  prepare(author: ChatAuthor, clientMessageId: string, text: string): ChatSubmitDecision {
    // Duplicate check first (R16.5, R16.6, R17.4). The record is keyed by
    // author, so another author's use of the same id is a miss (R16.11).
    const recordedSeq = this.dedup.get(author.id, clientMessageId);
    if (recordedSeq !== undefined) {
      const stored = this.buffer.getBySeq(recordedSeq);
      if (stored) return { kind: 'replay', message: stored };
      return { kind: 'rejected', code: 'CHAT_DUPLICATE' };
    }

    // One clock reading drives the check, the recorded time and onAccepted.
    const now = this.clock();
    const limit = this.rateLimiter.check(author.id, now);
    if (!limit.ok) {
      return { kind: 'rejected', code: 'CHAT_RATE_LIMITED', retryAfterMs: limit.retryAfterMs };
    }

    // Everything that can throw (id factory, toISOString on a bad clock
    // reading) runs here, before any mutation.
    const sentAtMs = Math.max(now, this.lastSentAtMs);
    const message: ChatMessage = {
      id: this.idFactory(),
      seq: this.nextSeq,
      clientMessageId,
      authorId: author.id,
      authorName: author.displayName,
      text,
      sentAt: new Date(sentAtMs).toISOString(),
    };

    const commit = (): void => {
      // A decision is only valid against the state it was prepared from. A
      // second commit, or a commit after another accept, would break seq
      // contiguity (and ChatBuffer.push would throw mid-commit), so refuse it
      // before the first mutation.
      if (message.seq !== this.nextSeq) {
        throw new Error('ChatRoom: stale accepted decision; prepare again');
      }
      // No call below this point throws before the last mutation (R20.7):
      // push cannot throw because message.seq === highest held seq + 1.
      this.buffer.push(message); // evicts the lowest seq at capacity (R18.2)
      this.nextSeq++;
      this.lastSentAtMs = sentAtMs;
      this.dedup.record(author.id, clientMessageId, message.seq);
      this.rateLimiter.record(author.id, now);
      this.onAccepted(now);
    };

    return { kind: 'accepted', message, commit };
  }

  /** Every buffered Chat_Message in ascending seq order, as a fresh array (R18.4, R18.5). */
  history(): ChatMessage[] {
    return this.buffer.toArray();
  }
}
