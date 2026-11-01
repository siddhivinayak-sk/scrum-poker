import {
  ChatAuthor,
  ChatBuffer,
  ChatDedupRecord,
  ChatRateLimiter,
  ChatRoom,
  ChatSubmitDecision,
} from '../chat-room';
import { GameSession } from '../game-session';
import { RetroSession } from '../retro-session';
import {
  CHAT_DEDUP_PER_AUTHOR,
  CHAT_HISTORY_LIMIT,
  CHAT_RATE_LIMIT_COUNT,
  CHAT_RATE_LIMIT_WINDOW_MS,
  ChatMessage,
  DEFAULT_SESSION_CONFIG,
  RetroConfiguration,
} from '../../../../shared/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mutable fake clock; tests move time by assigning `clock.now`. No real timers. */
function makeClock(start = 0): { now: number; read: () => number } {
  const clock = {
    now: start,
    read: (): number => clock.now,
  };
  return clock;
}

/** Deterministic canonical-form UUID for index n. */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

function makeMessage(seq: number): ChatMessage {
  return {
    id: uuid(seq),
    seq,
    clientMessageId: uuid(100000 + seq),
    authorId: 'author-1',
    authorName: 'Alice',
    text: `message ${seq}`,
    sentAt: new Date(seq).toISOString(),
  };
}

function makeRoom(clock: () => number): ChatRoom {
  let next = 0;
  return new ChatRoom({ clock, idFactory: () => uuid(++next) });
}

const alice: ChatAuthor = { id: 'alice', displayName: 'Alice' };
const bob: ChatAuthor = { id: 'bob', displayName: 'Bob' };

/** Prepares and commits; fails the test unless the send is accepted. */
function acceptSend(room: ChatRoom, author: ChatAuthor, clientMessageId: string, text = 'hi'): ChatMessage {
  const decision = room.prepare(author, clientMessageId, text);
  if (decision.kind !== 'accepted') {
    throw new Error(`expected accepted, got ${JSON.stringify(decision)}`);
  }
  decision.commit();
  return decision.message;
}

function expectRateLimited(decision: ChatSubmitDecision, retryAfterMs: number): void {
  expect(decision).toEqual({ kind: 'rejected', code: 'CHAT_RATE_LIMITED', retryAfterMs });
}

function makeRetroConfig(): RetroConfiguration {
  return {
    boardName: 'Test Retro',
    maxVotesPerUser: 6,
    templateId: 'start-stop-continue',
    hideCardsInitially: false,
    disableVotingInitially: false,
    hideVoteCount: false,
    oneVotePerCard: false,
    showCardAuthor: false,
    password: null,
    enableGifEmoji: true,
    columnLayout: 'vertical',
    allowedFeelings: ['Happy', 'Sad', 'No_Feeling'],
  };
}

// ---------------------------------------------------------------------------
// ChatBuffer (R18.1, R18.2, R22.1)
// ---------------------------------------------------------------------------

describe('ChatBuffer', () => {
  it('uses CHAT_HISTORY_LIMIT (200) as its default capacity', () => {
    expect(CHAT_HISTORY_LIMIT).toBe(200);
  });

  it('holds 200 messages after 200 pushes without evicting', () => {
    const buffer = new ChatBuffer();
    for (let seq = 1; seq <= 200; seq++) {
      expect(buffer.push(makeMessage(seq))).toBeNull();
    }
    expect(buffer.size).toBe(200);
    expect(buffer.toArray().map((m) => m.seq)).toEqual(
      Array.from({ length: 200 }, (_, i) => i + 1),
    );
  });

  it('evicts seq 1 on the 201st push and keeps seqs 2..201 in order', () => {
    const buffer = new ChatBuffer();
    for (let seq = 1; seq <= 200; seq++) buffer.push(makeMessage(seq));

    const evicted = buffer.push(makeMessage(201));

    expect(evicted?.seq).toBe(1);
    expect(buffer.size).toBe(200);
    expect(buffer.getBySeq(1)).toBeUndefined();
    expect(buffer.getBySeq(2)?.seq).toBe(2);
    expect(buffer.getBySeq(201)?.seq).toBe(201);
    const seqs = buffer.toArray().map((m) => m.seq);
    expect(seqs[0]).toBe(2);
    expect(seqs[seqs.length - 1]).toBe(201);
  });

  it('throws RangeError on a non-contiguous seq and leaves the buffer unchanged', () => {
    const buffer = new ChatBuffer(3);
    buffer.push(makeMessage(1));
    buffer.push(makeMessage(2));

    expect(() => buffer.push(makeMessage(4))).toThrow(RangeError);
    expect(() => buffer.push(makeMessage(2))).toThrow(RangeError);
    expect(buffer.toArray().map((m) => m.seq)).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// ChatDedupRecord (R16.4–R16.6, R16.11, R22.1)
// ---------------------------------------------------------------------------

describe('ChatDedupRecord', () => {
  it('uses CHAT_DEDUP_PER_AUTHOR (50) as its default per-author size', () => {
    expect(CHAT_DEDUP_PER_AUTHOR).toBe(50);
  });

  it('keeps 50 ids per author and drops that author\'s first on the 51st', () => {
    const dedup = new ChatDedupRecord();
    for (let i = 1; i <= 50; i++) dedup.record('alice', uuid(i), i);
    dedup.record('bob', uuid(1), 999);

    for (let i = 1; i <= 50; i++) expect(dedup.get('alice', uuid(i))).toBe(i);

    dedup.record('alice', uuid(51), 51);

    expect(dedup.get('alice', uuid(1))).toBeUndefined();
    for (let i = 2; i <= 51; i++) expect(dedup.get('alice', uuid(i))).toBe(i);
    // Another author's entry with the same id is untouched.
    expect(dedup.get('bob', uuid(1))).toBe(999);
  });

  it('treats ids differing only in hex case as the same id', () => {
    const dedup = new ChatDedupRecord();
    dedup.record('alice', 'ABCDEF00-0000-4000-8000-00000000000A', 7);
    expect(dedup.get('alice', 'abcdef00-0000-4000-8000-00000000000a')).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// ChatRateLimiter (R17.1–R17.3)
// ---------------------------------------------------------------------------

describe('ChatRateLimiter', () => {
  it('uses 5 messages per 5,000 ms by default', () => {
    expect(CHAT_RATE_LIMIT_COUNT).toBe(5);
    expect(CHAT_RATE_LIMIT_WINDOW_MS).toBe(5000);
  });

  it('allows 5 in the window, rejects the 6th with the exact retryAfterMs, and check never records', () => {
    const clock = makeClock(10_000);
    const limiter = new ChatRateLimiter(clock.read);

    for (const t of [10_000, 11_000, 12_000, 13_000, 14_000]) {
      clock.now = t;
      expect(limiter.check('alice')).toEqual({ ok: true });
      limiter.record('alice');
    }

    clock.now = 14_500;
    expect(limiter.check('alice')).toEqual({ ok: false, retryAfterMs: 500 });
    // Repeated checks are not counted.
    expect(limiter.check('alice')).toEqual({ ok: false, retryAfterMs: 500 });
    expect(limiter.check('bob')).toEqual({ ok: true });

    clock.now = 15_000; // 10,000 has left the half-open window
    expect(limiter.check('alice')).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// ChatRoom
// ---------------------------------------------------------------------------

describe('ChatRoom', () => {
  it('changes nothing until commit() and refuses a second commit', () => {
    const clock = makeClock(1_000);
    const onAccepted = jest.fn();
    const room = new ChatRoom({ clock: clock.read, idFactory: () => uuid(1), onAccepted });

    const decision = room.prepare(alice, uuid(500), 'hello');
    if (decision.kind !== 'accepted') throw new Error('expected accepted');
    expect(decision.message.seq).toBe(1);
    expect(room.history()).toEqual([]);
    expect(onAccepted).not.toHaveBeenCalled();

    decision.commit();
    expect(room.history()).toEqual([decision.message]);
    expect(onAccepted).toHaveBeenCalledWith(1_000);

    expect(() => decision.commit()).toThrow('stale accepted decision');
    expect(room.history()).toHaveLength(1);
  });

  describe('buffer through ChatRoom (R18.1, R18.2)', () => {
    it('200 accepts fill the buffer and the 201st evicts seq 1', () => {
      const clock = makeClock(0);
      const room = makeRoom(clock.read);

      for (let i = 1; i <= 200; i++) {
        clock.now += CHAT_RATE_LIMIT_WINDOW_MS; // stay clear of the rate limit
        expect(acceptSend(room, alice, uuid(i)).seq).toBe(i);
      }
      expect(room.history()).toHaveLength(200);
      expect(room.history()[0].seq).toBe(1);

      clock.now += CHAT_RATE_LIMIT_WINDOW_MS;
      expect(acceptSend(room, alice, uuid(201)).seq).toBe(201);

      const history = room.history();
      expect(history).toHaveLength(200);
      expect(history[0].seq).toBe(2);
      expect(history[199].seq).toBe(201);
    });
  });

  describe('dedup through ChatRoom (R16.5, R16.6)', () => {
    it('the 51st id of one author evicts that author\'s first, so the first id is accepted again as new', () => {
      const clock = makeClock(0);
      const room = makeRoom(clock.read);
      const step = (): void => {
        clock.now += CHAT_RATE_LIMIT_WINDOW_MS;
      };

      for (let i = 1; i <= 50; i++) {
        step();
        acceptSend(room, alice, uuid(i));
      }
      step();
      acceptSend(room, bob, uuid(1));

      // Before eviction the first id is answered as a replay of seq 1.
      const replay = room.prepare(alice, uuid(1), 'again');
      expect(replay.kind).toBe('replay');
      if (replay.kind === 'replay') expect(replay.message.seq).toBe(1);

      step();
      acceptSend(room, alice, uuid(51));

      // Alice's first id was dropped: a resend is a new message with a new seq.
      step();
      const resent = acceptSend(room, alice, uuid(1), 'again');
      expect(resent.seq).toBe(53);

      // Recording uuid(1) again evicted uuid(2); uuid(3) and Bob's entry are still recorded.
      expect(room.prepare(alice, uuid(2), 'x').kind).toBe('accepted');
      expect(room.prepare(alice, uuid(3), 'x').kind).toBe('replay');
      const bobReplay = room.prepare(bob, uuid(1), 'x');
      expect(bobReplay.kind).toBe('replay');
      if (bobReplay.kind === 'replay') expect(bobReplay.message.seq).toBe(51);
    });
  });

  describe('rate limit through ChatRoom (R17.1–R17.3, R17.7)', () => {
    it('accepts 5 sends in 5,000 ms, rejects the 6th with the exact retryAfterMs, then accepts after it; another author is unaffected', () => {
      const clock = makeClock(100_000);
      const room = makeRoom(clock.read);

      const times = [100_000, 100_250, 101_000, 102_500, 104_000];
      times.forEach((t, i) => {
        clock.now = t;
        acceptSend(room, alice, uuid(i + 1));
      });

      // Oldest in-window acceptance is 100,000: retryAfterMs = 100,000 + 5,000 − 104,300.
      clock.now = 104_300;
      expectRateLimited(room.prepare(alice, uuid(6), 'sixth'), 700);
      expect(room.history()).toHaveLength(5);

      // Another author at the same instant is accepted.
      expect(acceptSend(room, bob, uuid(6)).seq).toBe(6);

      // Still limited 1 ms before the oldest time leaves the window.
      clock.now = 104_999;
      expectRateLimited(room.prepare(alice, uuid(6), 'sixth'), 1);

      // At exactly retryAfterMs later the send is accepted (half-open window).
      clock.now = 105_000;
      expect(acceptSend(room, alice, uuid(6)).seq).toBe(7);

      // The rejected attempts recorded nothing: the next limit is set by 100,250.
      clock.now = 105_100;
      expectRateLimited(room.prepare(alice, uuid(7), 'eighth'), 150);
    });

    it('answers a duplicate without consulting the limiter while the author is at the limit', () => {
      const clock = makeClock(0);
      const room = makeRoom(clock.read);
      for (let i = 1; i <= 5; i++) acceptSend(room, alice, uuid(i));

      const decision = room.prepare(alice, uuid(3), 'dup');
      expect(decision.kind).toBe('replay');
    });
  });
});

// ---------------------------------------------------------------------------
// Session integration (R18.6, R18.10)
// ---------------------------------------------------------------------------

describe.each([
  [
    'GameSession',
    (chatClock: () => number) =>
      new GameSession('poker-1', 'owner-1', { ...DEFAULT_SESSION_CONFIG }, { chatClock }),
  ],
  [
    'RetroSession',
    (chatClock: () => number) =>
      new RetroSession('retro-1', 'owner-1', makeRetroConfig(), { chatClock }),
  ],
] as const)('%s chat', (_name, create) => {
  const T0 = Date.parse('2031-03-04T05:06:07.000Z');

  it('a new session starts with an empty chat whose next seq is 1', () => {
    const clock = makeClock(T0);
    const session = create(clock.read);

    expect(session.chat.history()).toEqual([]);
    const first = session.chat.prepare(alice, uuid(1), 'first');
    expect(first.kind).toBe('accepted');
    if (first.kind === 'accepted') expect(first.message.seq).toBe(1);
  });

  it('two sessions hold separate chat state', () => {
    const clock = makeClock(T0);
    const a = create(clock.read);
    const b = create(clock.read);
    for (let i = 1; i <= 5; i++) acceptSend(a.chat, alice, uuid(i));

    expect(b.chat.history()).toEqual([]);
    const decision = b.chat.prepare(alice, uuid(1), 'x');
    expect(decision.kind).toBe('accepted');
    if (decision.kind === 'accepted') expect(decision.message.seq).toBe(1);
  });

  it('sets lastActivityAt to the clock time of acceptance on commit only', () => {
    const clock = makeClock(T0);
    const session = create(clock.read);
    const initial = session.lastActivityAt;

    // Prepared but not committed: unchanged.
    const pending = session.chat.prepare(alice, uuid(1), 'hello');
    expect(session.lastActivityAt).toBe(initial);
    if (pending.kind !== 'accepted') throw new Error('expected accepted');

    pending.commit();
    expect(session.lastActivityAt).toBe(new Date(T0).toISOString());

    // Duplicate resend answered as a replay: unchanged.
    clock.now = T0 + 1_000;
    expect(session.chat.prepare(alice, uuid(1), 'hello').kind).toBe('replay');
    expect(session.lastActivityAt).toBe(new Date(T0).toISOString());

    // Rate-limited rejection: unchanged.
    for (let i = 2; i <= 5; i++) acceptSend(session.chat, alice, uuid(i));
    expect(session.lastActivityAt).toBe(new Date(T0 + 1_000).toISOString());
    clock.now = T0 + 2_000;
    expectRateLimited(session.chat.prepare(alice, uuid(6), 'sixth'), 3_000);
    expect(session.lastActivityAt).toBe(new Date(T0 + 1_000).toISOString());
  });

  it('leaves lastActivityAt unchanged on CHAT_DUPLICATE for an id whose message was evicted', () => {
    const clock = makeClock(T0);
    const session = create(clock.read);

    for (let i = 1; i <= CHAT_HISTORY_LIMIT + 1; i++) {
      clock.now += CHAT_RATE_LIMIT_WINDOW_MS;
      // Rotate authors so seq 1's author keeps its id in the dedup record.
      const author = i === 1 ? alice : bob;
      acceptSend(session.chat, author, uuid(i));
    }
    const after = session.lastActivityAt;

    clock.now += CHAT_RATE_LIMIT_WINDOW_MS;
    expect(session.chat.prepare(alice, uuid(1), 'again')).toEqual({
      kind: 'rejected',
      code: 'CHAT_DUPLICATE',
    });
    expect(session.lastActivityAt).toBe(after);
  });
});
