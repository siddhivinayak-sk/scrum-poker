import { IncomingMessage } from 'http';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  DEFAULT_SESSION_CONFIG,
  NOTE_MAX_LENGTH,
  CALLOUT_NOTE_SUBMIT,
  CALLOUT_NOTE_ADDED,
  CalloutNote,
  HistoryEntry,
  User,
  WebSocketMessage,
} from '../../../../shared/types';
import { buildEstimateExportCsv } from '../../../../shared/estimate-export';
import { GameSession } from '../game-session';
import { handleWebSocket, _reset as resetHandler } from '../../websocket/handler';
import * as authService from '../auth-service';
import { sessionRegistry } from '../session-registry';

/**
 * Example tests for Callout_Note storage, history carry-over and transport.
 * Covers the 280/281 boundary, empty-after-trim, unknown round, storage against the
 * current round and a history entry, clearBoard() copy semantics, handler serialisation
 * and export-format invariance (R10.16).
 */

const AUTHOR = { authorId: 'author-1', authorName: 'Alice' };

/** Non-whitespace text of exactly `length` characters. */
function textOfLength(length: number): string {
  return 'x'.repeat(length);
}

function newSession(): GameSession {
  return new GameSession('test-session', 'owner-1', DEFAULT_SESSION_CONFIG);
}

describe('GameSession.addCalloutNote — validation', () => {
  it('accepts a note of exactly 280 trimmed characters', () => {
    const session = newSession();
    const round = session.startRound('Story');

    const result = session.addCalloutNote({
      roundId: round.id,
      ...AUTHOR,
      text: textOfLength(NOTE_MAX_LENGTH),
    });

    expect(NOTE_MAX_LENGTH).toBe(280);
    expect(result.ok).toBe(true);
    expect(session.getCurrentRound()?.calloutNotes).toHaveLength(1);
  });

  it('accepts 280 trimmed characters even when padded with whitespace beyond 280', () => {
    const session = newSession();
    const round = session.startRound('Story');

    const result = session.addCalloutNote({
      roundId: round.id,
      ...AUTHOR,
      text: `   ${textOfLength(280)}\n\t `,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.note.text).toBe(textOfLength(280));
    }
  });

  it('rejects 281 trimmed characters with NOTE_TOO_LONG and stores nothing', () => {
    const session = newSession();
    const round = session.startRound('Story');

    const result = session.addCalloutNote({
      roundId: round.id,
      ...AUTHOR,
      text: textOfLength(NOTE_MAX_LENGTH + 1),
    });

    expect(result).toEqual({ ok: false, code: 'NOTE_TOO_LONG' });
    expect(session.getCurrentRound()?.calloutNotes ?? []).toHaveLength(0);
  });

  it.each([
    ['empty string', ''],
    ['spaces only', '     '],
    ['mixed whitespace only', ' \t\r\n\u00a0\u2003 '],
  ])('rejects %s with NOTE_EMPTY and stores nothing', (_label, text) => {
    const session = newSession();
    const round = session.startRound('Story');

    const result = session.addCalloutNote({ roundId: round.id, ...AUTHOR, text });

    expect(result).toEqual({ ok: false, code: 'NOTE_EMPTY' });
    expect(session.getCurrentRound()?.calloutNotes ?? []).toHaveLength(0);
  });

  it('rejects an unknown round id with NOTE_ROUND_UNKNOWN and stores nothing', () => {
    const session = newSession();
    session.startRound('Story');

    const result = session.addCalloutNote({
      roundId: 'no-such-round',
      ...AUTHOR,
      text: 'A valid note',
    });

    expect(result).toEqual({ ok: false, code: 'NOTE_ROUND_UNKNOWN' });
    expect(session.getCurrentRound()?.calloutNotes ?? []).toHaveLength(0);
    expect(session.getHistory()).toHaveLength(0);
  });

  it('rejects any round id when there is no current round and no history', () => {
    const session = newSession();

    const result = session.addCalloutNote({ roundId: 'anything', ...AUTHOR, text: 'Hello' });

    expect(result).toEqual({ ok: false, code: 'NOTE_ROUND_UNKNOWN' });
  });
});

describe('GameSession.addCalloutNote — storage', () => {
  it('stores a note against the current round with trimmed text and server fields', () => {
    const session = newSession();
    const round = session.startRound('Story');

    const result = session.addCalloutNote({
      roundId: round.id,
      ...AUTHOR,
      text: '  Edge case in the importer  ',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note).toMatchObject({
      roundId: round.id,
      authorId: AUTHOR.authorId,
      authorName: AUTHOR.authorName,
      text: 'Edge case in the importer',
    });
    expect(result.note.id).toEqual(expect.any(String));
    expect(result.note.id.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(result.note.storedAt))).toBe(false);
    expect(session.getCurrentRound()?.calloutNotes).toEqual([result.note]);
  });

  it('stores a note against a history entry', () => {
    const session = newSession();
    const savedRound = session.startRound('Saved story');
    session.revealCards();
    session.clearBoard();
    session.startRound('Next story');

    const result = session.addCalloutNote({
      roundId: savedRound.id,
      ...AUTHOR,
      text: 'Late thought about the saved story',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = session.getHistory().find((e) => e.roundId === savedRound.id);
    expect(entry?.calloutNotes).toEqual([result.note]);
    expect(result.note.roundId).toBe(savedRound.id);
    // The note belongs to the saved round, not the one in progress.
    expect(session.getCurrentRound()?.calloutNotes ?? []).toHaveLength(0);
  });

  it('stores notes from different authors on the same round, oldest first', () => {
    const session = newSession();
    const round = session.startRound('Story');

    const first = session.addCalloutNote({ roundId: round.id, authorId: 'a', authorName: 'A', text: 'one' });
    const second = session.addCalloutNote({ roundId: round.id, authorId: 'b', authorName: 'B', text: 'two' });

    expect(first.ok && second.ok).toBe(true);
    expect(session.getCurrentRound()?.calloutNotes?.map((n) => n.text)).toEqual(['one', 'two']);
  });

  it('rejects a second note from the same author and leaves the stored note unchanged', () => {
    const session = newSession();
    const round = session.startRound('Story');
    session.addCalloutNote({ roundId: round.id, ...AUTHOR, text: 'original' });

    const result = session.addCalloutNote({ roundId: round.id, ...AUTHOR, text: 'replacement' });

    expect(result).toEqual({ ok: false, code: 'NOTE_DUPLICATE' });
    expect(session.getCurrentRound()?.calloutNotes?.map((n) => n.text)).toEqual(['original']);
  });

  it('stores markup literally, without interpretation', () => {
    const session = newSession();
    const round = session.startRound('Story');

    const result = session.addCalloutNote({
      roundId: round.id,
      ...AUTHOR,
      text: '<b>bold</b> & <script>alert(1)</script>',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.note.text).toBe('<b>bold</b> & <script>alert(1)</script>');
    }
  });
});

describe('GameSession.clearBoard — notes carried into history', () => {
  it('copies the round notes into the history entry unchanged', () => {
    const session = newSession();
    const round = session.startRound('Story');
    const a = session.addCalloutNote({ roundId: round.id, authorId: 'a', authorName: 'A', text: 'first' });
    const b = session.addCalloutNote({ roundId: round.id, authorId: 'b', authorName: 'B', text: 'second' });
    session.revealCards();

    const entry = session.clearBoard();

    expect(a.ok && b.ok).toBe(true);
    const expected: CalloutNote[] = [
      (a as { ok: true; note: CalloutNote }).note,
      (b as { ok: true; note: CalloutNote }).note,
    ];
    expect(entry.calloutNotes).toEqual(expected);
    expect(entry.calloutNotes?.every((n) => n.roundId === round.id)).toBe(true);
    expect(session.getHistory()[0].calloutNotes).toEqual(expected);
  });

  it('leaves calloutNotes undefined when the round had no notes', () => {
    const session = newSession();
    session.startRound('Story');
    session.revealCards();

    const entry = session.clearBoard();

    expect(entry.calloutNotes).toBeUndefined();
  });

  it('copies the array, so later mutation of the round array does not reach the entry', () => {
    const session = newSession();
    const round = session.startRound('Story');
    session.addCalloutNote({ roundId: round.id, ...AUTHOR, text: 'kept' });
    session.revealCards();
    const roundNotes = session.getCurrentRound()!.calloutNotes!;

    const entry = session.clearBoard();
    const snapshot = JSON.stringify(entry.calloutNotes);

    expect(entry.calloutNotes).not.toBe(roundNotes);
    roundNotes.push({
      id: 'late',
      roundId: round.id,
      authorId: 'someone',
      authorName: 'Someone',
      text: 'added after clear',
      storedAt: new Date().toISOString(),
    });
    roundNotes.length = 0;

    expect(entry.calloutNotes).toHaveLength(1);
    expect(JSON.stringify(entry.calloutNotes)).toBe(snapshot);
  });

  it('still accepts a note for the round after it moved to history', () => {
    const session = newSession();
    const round = session.startRound('Story');
    session.addCalloutNote({ roundId: round.id, authorId: 'a', authorName: 'A', text: 'before' });
    session.revealCards();
    session.clearBoard();

    const late = session.addCalloutNote({ roundId: round.id, authorId: 'b', authorName: 'B', text: 'after' });

    expect(late.ok).toBe(true);
    expect(session.getHistory()[0].calloutNotes?.map((n) => n.text)).toEqual(['before', 'after']);
  });
});

describe('Estimate export is unaffected by callout notes (R10.16)', () => {
  it('produces byte-identical CSV with and without calloutNotes attached', () => {
    const session = newSession();
    session.addParticipant({ id: 'p1', displayName: 'Alice', role: 'participant', isAnonymous: false });
    session.addParticipant({ id: 'p2', displayName: 'Bob', role: 'participant', isAnonymous: false });
    const round = session.startRound('Export story');
    session.selectCard('p1', 5);
    session.selectCard('p2', 13);
    session.revealCards();
    session.clearBoard();

    const withoutNotes: HistoryEntry[] = JSON.parse(JSON.stringify(session.getHistory()));
    expect(withoutNotes[0].calloutNotes).toBeUndefined();
    const csvWithout = buildEstimateExportCsv({
      history: withoutNotes,
      votingSystem: DEFAULT_SESSION_CONFIG.votingSystem,
    });

    const added = session.addCalloutNote({
      roundId: round.id,
      authorId: 'p2',
      authorName: 'Bob',
      text: 'Needs "quotes", commas, and\nnewlines',
    });
    expect(added.ok).toBe(true);
    const withNotes: HistoryEntry[] = JSON.parse(JSON.stringify(session.getHistory()));
    expect(withNotes[0].calloutNotes).toHaveLength(1);
    const csvWith = buildEstimateExportCsv({
      history: withNotes,
      votingSystem: DEFAULT_SESSION_CONFIG.votingSystem,
    });

    expect(csvWith).toBe(csvWithout);
    expect(csvWith).not.toContain('Needs');
  });
});

// ---------------------------------------------------------------------------
// Handler serialisation: notes cross the WebSocket boundary as plain JSON arrays
// ---------------------------------------------------------------------------

function createMockWs(): WebSocket & { sentMessages: string[] } {
  const emitter = new EventEmitter();
  const mock = emitter as unknown as WebSocket & { sentMessages: string[] };
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

function messagesOf(ws: { sentMessages: string[] }, event: string): WebSocketMessage[] {
  return ws.sentMessages.map((m) => JSON.parse(m) as WebSocketMessage).filter((m) => m.event === event);
}

describe('Handler serialisation of callout notes', () => {
  const owner: User = { id: 'mod-1', displayName: 'Moderator', role: 'moderator', isAnonymous: false };
  const alice: User = { id: 'user-a', displayName: 'Alice', role: 'participant', isAnonymous: false };

  let sessionId: string;

  function connect(user: User): ReturnType<typeof createMockWs> {
    jest.spyOn(authService, 'validateToken').mockReturnValueOnce(user);
    const ws = createMockWs();
    handleWebSocket(ws, createRequest(`token-${user.id}`, sessionId));
    return ws;
  }

  function send(ws: WebSocket, event: string, data: unknown): void {
    ws.emit('message', JSON.stringify({ event, data, timestamp: new Date().toISOString() }));
  }

  beforeEach(() => {
    resetHandler();
    sessionRegistry._reset();
    jest.restoreAllMocks();
    sessionId = sessionRegistry.createSession(owner.id, DEFAULT_SESSION_CONFIG).sessionId;
  });

  it('broadcasts callout:note:added with the stored note as plain JSON', () => {
    const session = sessionRegistry.getSession(sessionId)!;
    const wsOwner = connect(owner);
    const wsAlice = connect(alice);
    const round = session.startRound('Story');

    send(wsAlice, CALLOUT_NOTE_SUBMIT, { sessionId, roundId: round.id, text: '  my reasoning  ' });

    const added = messagesOf(wsOwner, CALLOUT_NOTE_ADDED);
    expect(added).toHaveLength(1);
    const data = added[0].data as { roundId: string; note: CalloutNote };
    expect(data.roundId).toBe(round.id);
    expect(data.note).toMatchObject({
      roundId: round.id,
      authorId: alice.id,
      authorName: alice.displayName,
      text: 'my reasoning',
    });
    expect(messagesOf(wsAlice, CALLOUT_NOTE_ADDED)).toHaveLength(1);
  });

  it('sends current-round and history notes as JSON arrays in session:state', () => {
    const session = sessionRegistry.getSession(sessionId)!;
    const wsAlice = connect(alice);
    const savedRound = session.startRound('Saved');
    send(wsAlice, CALLOUT_NOTE_SUBMIT, { sessionId, roundId: savedRound.id, text: 'saved note' });
    session.revealCards();
    session.clearBoard();
    const currentRound = session.startRound('Current');
    send(wsAlice, CALLOUT_NOTE_SUBMIT, { sessionId, roundId: currentRound.id, text: 'current note' });

    // A client joining now receives the serialised state.
    const wsLate = connect(owner);
    const state = (messagesOf(wsLate, 'session:state')[0].data as {
      state: {
        currentRound: { selections: unknown; calloutNotes?: unknown };
        history: Array<{ roundId: string; calloutNotes?: unknown }>;
      };
    }).state;

    expect(Array.isArray(state.currentRound.calloutNotes)).toBe(true);
    expect(state.currentRound.calloutNotes).toHaveLength(1);
    expect((state.currentRound.calloutNotes as CalloutNote[])[0].text).toBe('current note');
    expect(Array.isArray(state.history[0].calloutNotes)).toBe(true);
    expect((state.history[0].calloutNotes as CalloutNote[])[0]).toMatchObject({
      roundId: savedRound.id,
      authorId: alice.id,
      text: 'saved note',
    });
    // Selections remain a plain object (Map serialised), notes are never a Map.
    expect(Array.isArray(state.currentRound.selections)).toBe(false);
  });

  it('leaves calloutNotes absent from the serialised round when no note exists', () => {
    const session = sessionRegistry.getSession(sessionId)!;
    session.startRound('Story');

    const wsLate = connect(owner);
    const state = (messagesOf(wsLate, 'session:state')[0].data as {
      state: { currentRound: Record<string, unknown> };
    }).state;

    expect(state.currentRound.calloutNotes).toBeUndefined();
  });
});
