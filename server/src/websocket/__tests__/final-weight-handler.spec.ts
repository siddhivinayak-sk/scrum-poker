import { IncomingMessage } from 'http';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  DEFAULT_SESSION_CONFIG,
  ExtendedCardValue,
  SessionConfiguration,
  User,
  WebSocketMessage,
} from '../../../../shared/types';
import { handleWebSocket, _reset as resetHandler } from '../handler';
import * as authService from '../../services/auth-service';
import { sessionRegistry } from '../../services/session-registry';

/**
 * Handler tests for `finalweight:submit` (final-weight-accuracy).
 * Validates: Requirements 1.3, 1.4, 1.7, 3.3, 3.4, 4.11, 4.16, 11.2-11.5
 */

type MockWs = WebSocket & { sentMessages: string[] };

function createMockWs(): MockWs {
  const mock = new EventEmitter() as unknown as MockWs;
  Object.assign(mock, {
    readyState: WebSocket.OPEN,
    sentMessages: [] as string[],
    send: jest.fn((data: string) => {
      mock.sentMessages.push(data);
    }),
    close: jest.fn(),
  });
  return mock;
}

function createRequest(token: string, sessionId: string): IncomingMessage {
  return {
    url: `/?token=${token}&sessionId=${sessionId}`,
    headers: { host: 'localhost:3000' },
  } as unknown as IncomingMessage;
}

function user(id: string, displayName: string, role: User['role'] = 'participant'): User {
  return { id, displayName, role, isAnonymous: false };
}

function connect(sessionId: string, u: User): MockWs {
  jest.spyOn(authService, 'validateToken').mockReturnValueOnce({ ...u });
  const ws = createMockWs();
  handleWebSocket(ws, createRequest(`token-${u.id}`, sessionId));
  return ws;
}

function send(ws: MockWs, event: string, data: unknown): void {
  ws.emit('message', JSON.stringify({ event, data, timestamp: new Date().toISOString() }));
}

function msgs(ws: MockWs, event: string): WebSocketMessage[] {
  return ws.sentMessages.map((r) => JSON.parse(r) as WebSocketMessage).filter((m) => m.event === event);
}

function lastError(ws: MockWs): string {
  const errs = msgs(ws, 'error');
  expect(errs.length).toBeGreaterThan(0);
  return (errs[errs.length - 1].data as { code: string }).code;
}

const mod = user('fw-mod', 'Mod', 'moderator');
const mod2 = user('fw-mod2', 'Mod2', 'moderator');
const alice = user('fw-alice', 'Alice');
const bob = user('fw-bob', 'Bob');
const carol = user('fw-carol', 'Carol');

interface Room {
  sessionId: string;
  mod: MockWs;
  mod2: MockWs;
  alice: MockWs;
  bob: MockWs;
  carol: MockWs;
  all: MockWs[];
}

function createRoom(config: Partial<SessionConfiguration> = {}): Room {
  const { sessionId } = sessionRegistry.createSession(mod.id, {
    ...DEFAULT_SESSION_CONFIG,
    finalWeightEnabled: true,
    // Alice may only reveal; Bob may only manage issues; Carol has neither.
    revealPermission: { mode: 'select-specific', allowedUserIds: [alice.id] },
    issuePermission: { mode: 'select-specific', allowedUserIds: [bob.id] },
    ...config,
  });
  const room = {
    sessionId,
    mod: connect(sessionId, mod),
    mod2: connect(sessionId, mod2),
    alice: connect(sessionId, alice),
    bob: connect(sessionId, bob),
    carol: connect(sessionId, carol),
  };
  return { ...room, all: [room.mod, room.mod2, room.alice, room.bob, room.carol] };
}

function startStory(room: Room, story = 'Story'): string {
  send(room.mod, 'story:submit', { storyDescription: story });
  const started = msgs(room.mod, 'round:started');
  return (started[started.length - 1].data as { round: { id: string } }).round.id;
}

function revealedRound(room: Room, story = 'Story'): string {
  const roundId = startStory(room, story);
  send(room.alice, 'card:select', { cardValue: 5 as ExtendedCardValue });
  send(room.bob, 'card:select', { cardValue: 8 as ExtendedCardValue });
  send(room.mod, 'cards:reveal', {});
  return roundId;
}

function count(room: Room, event: string): number[] {
  return room.all.map((w) => msgs(w, event).length);
}

describe('finalweight:submit handler', () => {
  beforeEach(() => {
    resetHandler();
    sessionRegistry._reset();
    jest.restoreAllMocks();
  });

  describe('authorisation (R3.3, R3.4)', () => {
    it.each([
      ['a plain participant', 'carol'],
      ['a participant with only reveal permission', 'alice'],
      ['a participant with only issue permission', 'bob'],
    ] as const)('rejects %s with UNAUTHORIZED and stores nothing', (_l, who) => {
      const room = createRoom();
      const roundId = revealedRound(room);
      const before = count(room, 'finalweight:set');

      send(room[who], 'finalweight:submit', { roundId, value: 5, showFunniest: false });

      expect(lastError(room[who])).toBe('UNAUTHORIZED');
      expect(count(room, 'finalweight:set')).toEqual(before);
      expect(sessionRegistry.getSession(room.sessionId)!.getCurrentRound()!.finalWeight).toBeUndefined();
    });
  });

  describe('rejections', () => {
    it('answers FEATURE_DISABLED when the setting is off or absent (R1.3, R1.4)', () => {
      const { finalWeightEnabled: _omit, ...withoutKey } = { ...DEFAULT_SESSION_CONFIG, finalWeightEnabled: true };
      for (const cfg of [{ finalWeightEnabled: false }, withoutKey]) {
        sessionRegistry._reset();
        const room = createRoom(cfg as Partial<SessionConfiguration>);
        if (!('finalWeightEnabled' in cfg)) {
          // createRoom spreads finalWeightEnabled: true first; make the key truly absent.
          delete (sessionRegistry.getSession(room.sessionId)!.config as Partial<SessionConfiguration>)
            .finalWeightEnabled;
        }
        const roundId = revealedRound(room);

        send(room.mod, 'finalweight:submit', { roundId, value: 5, showFunniest: false });

        expect(lastError(room.mod)).toBe('FEATURE_DISABLED');
        expect(count(room, 'finalweight:set')).toEqual([0, 0, 0, 0, 0]);
      }
    });

    it.each([
      ['null payload', null],
      ['missing roundId', { value: 5 }],
      ['empty roundId', { roundId: '', value: 5 }],
      ['missing value', { roundId: 'x' }],
      ['boolean value', { roundId: 'x', value: true }],
      ['non-boolean showFunniest', { roundId: 'x', value: 5, showFunniest: 'yes' }],
    ])('rejects a bad shape (%s) with INVALID_FINAL_WEIGHT', (_l, payload) => {
      const room = createRoom();
      revealedRound(room);

      send(room.mod, 'finalweight:submit', payload);

      expect(lastError(room.mod)).toBe('INVALID_FINAL_WEIGHT');
      expect(count(room, 'finalweight:set')).toEqual([0, 0, 0, 0, 0]);
    });

    it.each([
      ['an off-ladder number', 4],
      ['a far off-ladder number', 999],
      ['the string "5" (no coercion)', '5'],
      ['an unknown string', 'banana'],
    ])('rejects %s with INVALID_FINAL_WEIGHT (R3.3 strict match)', (_l, value) => {
      const room = createRoom();
      const roundId = revealedRound(room);

      send(room.mod, 'finalweight:submit', { roundId, value, showFunniest: false });

      expect(lastError(room.mod)).toBe('INVALID_FINAL_WEIGHT');
      expect(sessionRegistry.getSession(room.sessionId)!.getCurrentRound()!.finalWeight).toBeUndefined();
    });

    it('rejects a stale or unknown round with ROUND_NOT_FOUND', () => {
      const room = createRoom();
      const oldId = revealedRound(room);
      send(room.mod, 'board:clear', {});
      const newId = revealedRound(room, 'Second');
      expect(newId).not.toBe(oldId);

      send(room.mod, 'finalweight:submit', { roundId: 'unknown', value: 5, showFunniest: false });
      expect(lastError(room.mod)).toBe('ROUND_NOT_FOUND');

      // Entry two rounds back is immutable once a newer one exists.
      send(room.mod, 'board:clear', {});
      send(room.mod, 'finalweight:submit', { roundId: oldId, value: 5, showFunniest: false });
      expect(lastError(room.mod)).toBe('ROUND_NOT_FOUND');
      expect(count(room, 'finalweight:set')).toEqual([0, 0, 0, 0, 0]);
    });

    it('rejects a round that is still in the voting state with ROUND_NOT_FOUND', () => {
      const room = createRoom();
      const roundId = startStory(room);

      send(room.mod, 'finalweight:submit', { roundId, value: 5, showFunniest: false });

      expect(lastError(room.mod)).toBe('ROUND_NOT_FOUND');
      expect(sessionRegistry.getSession(room.sessionId)!.getCurrentRound()!.finalWeight).toBeUndefined();
    });
  });

  describe('success (R11.2-R11.5)', () => {
    it('broadcasts finalweight:set to every participant with a server-computed result', () => {
      const room = createRoom();
      const roundId = revealedRound(room);

      send(room.mod, 'finalweight:submit', { roundId, value: 5, showFunniest: true });

      expect(count(room, 'finalweight:set')).toEqual([1, 1, 1, 1, 1]);
      const data = msgs(room.carol, 'finalweight:set')[0].data as {
        roundId: string;
        record: { value: number; votingSystem: string; showFunniest: boolean };
        result: { finalWeight: number; closestIds: string[]; furthestIds: string[]; comparable: boolean };
      };
      expect(data.roundId).toBe(roundId);
      expect(data.record).toEqual({ value: 5, votingSystem: 'fibonacci', showFunniest: true });
      expect(data.result.finalWeight).toBe(5);
      expect(data.result.comparable).toBe(true);
      expect(data.result.closestIds).toEqual([alice.id]);
      expect(data.result.furthestIds).toEqual([bob.id]);
    });

    it('ignores a client-supplied result or distance', () => {
      const room = createRoom();
      const roundId = revealedRound(room);

      send(room.mod, 'finalweight:submit', {
        roundId,
        value: 8,
        showFunniest: false,
        result: { closestIds: [carol.id] },
      });

      const data = msgs(room.alice, 'finalweight:set')[0].data as { result: { closestIds: string[] } };
      expect(data.result.closestIds).toEqual([bob.id]);
    });

    it('accepts weight 0 (R3.4)', () => {
      const room = createRoom();
      const roundId = revealedRound(room);

      send(room.mod, 'finalweight:submit', { roundId, value: 0, showFunniest: false });

      expect(count(room, 'finalweight:set')).toEqual([1, 1, 1, 1, 1]);
      expect(sessionRegistry.getSession(room.sessionId)!.getCurrentRound()!.finalWeight?.value).toBe(0);
    });

    it('defaults showFunniest to false when omitted', () => {
      const room = createRoom();
      const roundId = revealedRound(room);

      send(room.mod, 'finalweight:submit', { roundId, value: 5 });

      const data = msgs(room.mod, 'finalweight:set')[0].data as { record: { showFunniest: boolean } };
      expect(data.record.showFunniest).toBe(false);
    });

    it('two moderators: the last valid submission wins and is what history stores', () => {
      const room = createRoom();
      const roundId = revealedRound(room);

      send(room.mod, 'finalweight:submit', { roundId, value: 5, showFunniest: false });
      send(room.mod2, 'finalweight:submit', { roundId, value: 8, showFunniest: true });

      expect(count(room, 'finalweight:set')).toEqual([2, 2, 2, 2, 2]);
      send(room.mod, 'board:clear', {});
      const cleared = msgs(room.alice, 'board:cleared');
      const entry = (cleared[0].data as { historyEntry: Record<string, unknown> }).historyEntry;
      expect(entry.finalWeight).toEqual({ value: 8, votingSystem: 'fibonacci', showFunniest: true });
    });

    it('broadcasts issue:list-updated when an estimating issue matches the round', () => {
      const room = createRoom();
      send(room.mod, 'issue:add', { titles: ['Issue 1'] });
      const issues = (msgs(room.mod, 'issue:list-updated')[0].data as { issues: Array<{ id: string }> }).issues;
      send(room.mod, 'issue:select', { issueId: issues[0].id });
      const started = msgs(room.mod, 'round:started');
      const roundId = (started[started.length - 1].data as { round: { id: string } }).round.id;
      send(room.alice, 'card:select', { cardValue: 5 });
      send(room.bob, 'card:select', { cardValue: 8 });
      send(room.mod, 'cards:reveal', {});
      const before = count(room, 'issue:list-updated');

      send(room.mod, 'finalweight:submit', { roundId, value: 8, showFunniest: false });

      expect(count(room, 'issue:list-updated')).toEqual(before.map((n) => n + 1));
      const list = msgs(room.carol, 'issue:list-updated');
      const updated = (list[list.length - 1].data as { issues: Array<{ finalWeight?: number }> }).issues;
      expect(updated[0].finalWeight).toBe(8);
    });

    it('does not broadcast issue:list-updated when no issue matches', () => {
      const room = createRoom();
      const roundId = revealedRound(room);
      const before = count(room, 'issue:list-updated');

      send(room.mod, 'finalweight:submit', { roundId, value: 5, showFunniest: false });

      expect(count(room, 'issue:list-updated')).toEqual(before);
    });
  });

  describe('board:cleared history entry (R11.7, R11.8)', () => {
    it('includes finalWeight when a weight was set', () => {
      const room = createRoom();
      const roundId = revealedRound(room);
      send(room.mod, 'finalweight:submit', { roundId, value: 5, showFunniest: false });

      send(room.mod, 'board:clear', {});

      const entry = (msgs(room.bob, 'board:cleared')[0].data as { historyEntry: Record<string, unknown> })
        .historyEntry;
      expect(entry.finalWeight).toEqual({ value: 5, votingSystem: 'fibonacci', showFunniest: false });
    });

    it('omits the finalWeight key when none was set', () => {
      const room = createRoom();
      revealedRound(room);

      send(room.mod, 'board:clear', {});

      const entry = (msgs(room.bob, 'board:cleared')[0].data as { historyEntry: Record<string, unknown> })
        .historyEntry;
      expect('finalWeight' in entry).toBe(false);
    });

    it('accepts a weight for the newest history entry right after the clear', () => {
      const room = createRoom();
      const roundId = revealedRound(room);
      send(room.mod, 'board:clear', {});

      send(room.mod, 'finalweight:submit', { roundId, value: 8, showFunniest: false });

      expect(count(room, 'finalweight:set')).toEqual([1, 1, 1, 1, 1]);
      expect(sessionRegistry.getSession(room.sessionId)!.getHistory()[0].finalWeight?.value).toBe(8);
    });
  });
});
