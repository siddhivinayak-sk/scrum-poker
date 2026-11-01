import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@shared/types';
import {
  CHAT_ACK_TIMEOUT_NOTICE,
  ChatAction,
  ChatEffect,
  ChatState,
  createChatState,
  reduceChat,
  selectEntries,
  selectUnreadCount,
} from './chat-store';
// Feature: session-chat, unit examples for the pure chat reducer.
// The properties (8.5–8.14) live in chat-store.property.spec.ts.

const ME = 'user-me';
const OTHER = 'user-other';
const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';

function msg(seq: number, authorId = OTHER, clientMessageId = `10000000-0000-4000-8000-${String(seq).padStart(12, '0')}`): ChatMessage {
  return {
    id: `20000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    seq,
    clientMessageId,
    authorId,
    authorName: authorId,
    text: `m${seq}`,
    sentAt: new Date(Date.UTC(2026, 4, 1, 0, 0, seq)).toISOString(),
  };
}

function run(state: ChatState, ...actions: ChatAction[]): { state: ChatState; effects: ChatEffect[] } {
  const effects: ChatEffect[] = [];
  for (const action of actions) {
    const r = reduceChat(state, action);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

function connected(): ChatState {
  return run(createChatState({ boardKind: 'poker', sessionId: 's1', me: ME }), { kind: 'connection', state: 'connected', now: 0 }).state;
}

describe('reduceChat', () => {
  it('send then matching added replaces the outbox entry and cancels its timer', () => {
    const sent = run(connected(), { kind: 'send', clientMessageId: ID_A, text: '  hi  ', now: 5 });
    expect(sent.effects).toEqual([
      { kind: 'send', payload: { sessionId: 's1', clientMessageId: ID_A, text: 'hi' } },
      { kind: 'startAckTimer', clientMessageId: ID_A, ms: 10000 },
    ]);
    const added = run(sent.state, { kind: 'added', raw: { message: msg(1, ME, ID_A) } });
    expect(added.state.outbox).toEqual([]);
    expect(selectEntries(added.state)).toMatchObject([{ kind: 'confirmed', own: true }]);
    expect(added.effects).toEqual([{ kind: 'cancelAckTimer', clientMessageId: ID_A }]);
  });

  it('ignores malformed added and history payloads', () => {
    const s = connected();
    expect(reduceChat(s, { kind: 'added', raw: { message: { ...msg(1), sentAt: '2026-13-01T00:00:00.000Z' } } }).state).toBe(s);
    expect(reduceChat(s, { kind: 'history', raw: { messages: 'x' }, generation: 1, now: 0 }).state).toBe(s);
  });

  it('keeps the 200 highest seqs and counts unread above the Read_Marker', () => {
    const many = Array.from({ length: 205 }, (_, i) => msg(i + 1));
    const { state } = run(connected(), { kind: 'history', raw: { messages: many }, generation: 1, now: 0 });
    expect(state.confirmed).toHaveLength(200);
    expect(state.confirmed[0].seq).toBe(6);
    expect(selectUnreadCount(state)).toBe(200);
    const read = run(state, { kind: 'markRead', seq: 200 });
    expect(selectUnreadCount(read.state)).toBe(5);
    expect(read.effects).toEqual([{ kind: 'writeReadMarker', boardKind: 'poker', sessionId: 's1', seq: 200 }]);
    expect(run(read.state, { kind: 'markRead', seq: 100 }).state.readMarker).toBe(200);
  });

  it('applies the generation gate: first no resend, higher resends once, equal ignored', () => {
    let s = run(connected(), { kind: 'send', clientMessageId: ID_A, text: 'a', now: 0 }).state;
    const first = run(s, { kind: 'history', raw: { messages: [] }, generation: 1, now: 1 });
    expect(first.effects).toEqual([]);
    expect(first.state.historyStatus).toBe('loaded');
    s = run(first.state, { kind: 'connection', state: 'reconnecting', now: 2 }, { kind: 'connection', state: 'connected', now: 3 }).state;
    const reconnect = run(s, { kind: 'history', raw: { messages: [] }, generation: 2, now: 4 });
    expect(reconnect.effects.filter((e) => e.kind === 'send')).toHaveLength(1);
    expect(reconnect.effects).toContainEqual({ kind: 'startAckTimer', clientMessageId: ID_A, ms: 10000 });
    const stale = reduceChat(reconnect.state, { kind: 'history', raw: { messages: [msg(1)] }, generation: 2, now: 5 });
    expect(stale.state).toBe(reconnect.state);
    expect(stale.effects).toEqual([]);
  });

  it('counts only connected time toward the acknowledgement timeout', () => {
    const s = run(
      connected(),
      { kind: 'send', clientMessageId: ID_A, text: 'a', now: 0 },
      { kind: 'connection', state: 'reconnecting', now: 6000 },
      { kind: 'connection', state: 'connected', now: 60000 },
    );
    expect(s.effects).toContainEqual({ kind: 'startAckTimer', clientMessageId: ID_A, ms: 4000 });
    expect(s.state.outbox[0].state).toBe('pending');
    const timedOut = run(s.state, { kind: 'ackTimeout', clientMessageId: ID_A });
    expect(timedOut.state.outbox[0]).toMatchObject({ state: 'failed', notice: CHAT_ACK_TIMEOUT_NOTICE });
    expect(timedOut.effects).toEqual([{ kind: 'announce', text: 'Message not sent.' }]);
  });

  it('handles rejections, retry and discard', () => {
    const s = run(
      connected(),
      { kind: 'send', clientMessageId: ID_A, text: 'a', now: 1 },
      { kind: 'send', clientMessageId: ID_B, text: 'b', now: 2 },
    ).state;
    const dup = run(s, { kind: 'rejected', raw: { clientMessageId: ID_A, code: 'CHAT_DUPLICATE', message: 'dup' }, now: 3 });
    expect(dup.state.outbox[0]).toMatchObject({ state: 'sent', firstSentAt: 1, notice: null });
    const limited = run(dup.state, {
      kind: 'rejected',
      raw: { clientMessageId: ID_B, code: 'CHAT_RATE_LIMITED', message: 'Too fast.', retryAfterMs: 1500 },
      now: 10,
    });
    expect(limited.state.rateLimitUntil).toBe(1510);
    expect(limited.state.outbox[1]).toMatchObject({ state: 'failed', notice: 'Too fast.' });
    expect(limited.effects).toContainEqual({ kind: 'announce', text: 'Message not sent.' });
    const retried = run(limited.state, { kind: 'retry', clientMessageId: ID_B, now: 20 });
    expect(retried.state.outbox[1]).toMatchObject({ state: 'pending', notice: null, ackElapsedMs: 0 });
    expect(retried.effects[0]).toEqual({ kind: 'send', payload: { sessionId: 's1', clientMessageId: ID_B, text: 'b' } });
    const discarded = run(limited.state, { kind: 'discard', clientMessageId: ID_B });
    expect(discarded.state.outbox.map((e) => e.clientMessageId)).toEqual([ID_A]);
  });

  it('reset empties the state and cancels every timer', () => {
    const s = run(connected(), { kind: 'send', clientMessageId: ID_A, text: 'a', now: 0 }).state;
    const r = reduceChat(s, { kind: 'reset', sessionId: 's2', readMarker: 7 });
    expect(r.state).toMatchObject({ sessionId: 's2', outbox: [], confirmed: [], historyGeneration: null, readMarker: 7, connection: 'connected' });
    expect(r.effects).toEqual([{ kind: 'cancelAckTimer', clientMessageId: ID_A }]);
  });
});
