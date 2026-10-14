import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Subject, Observable } from 'rxjs';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { SessionStateService } from './session-state.service';
import { WebSocketService } from './websocket.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { CalloutPersistenceService } from './callout-persistence.service';
import { CalloutCopyStoreService } from './callout-copy-store.service';
import {
  CALLOUT_NOTE_ADDED,
  CALLOUT_NOTE_REJECTED,
  CalloutNote,
  CalloutNoteRejectedPayload,
  DEFAULT_SESSION_CONFIG,
  User,
} from '@shared/types';

describe('SessionStateService callout notes', () => {
  let service: SessionStateService;
  let persistence: CalloutPersistenceService;
  let copyStore: CalloutCopyStoreService;
  let toast: { show: ReturnType<typeof vi.fn> };
  let subjects: Map<string, Subject<unknown>>;

  const user: User = { id: 'user-1', displayName: 'Ada', role: 'participant', isAnonymous: false };

  function emit(event: string, data: unknown): void {
    if (!subjects.has(event)) subjects.set(event, new Subject<unknown>());
    subjects.get(event)!.next(data);
  }

  function note(overrides: Partial<CalloutNote> = {}): CalloutNote {
    return {
      id: 'n1',
      roundId: 'r1',
      authorId: 'user-1',
      authorName: 'Ada',
      text: 'because of the migration',
      storedAt: '2026-05-01T10:00:00.000Z',
      ...overrides,
    };
  }

  function sessionState(extra: Record<string, unknown> = {}): { state: unknown } {
    return {
      state: {
        sessionId: 's1',
        config: DEFAULT_SESSION_CONFIG,
        ownerId: 'user-1',
        createdAt: '2026-05-01T09:00:00.000Z',
        issueList: [],
        participants: [user],
        history: [],
        isRevealed: false,
        currentRound: null,
        ...extra,
      },
    };
  }

  beforeEach(() => {
    sessionStorage.clear();
    subjects = new Map();
    toast = { show: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        {
          provide: WebSocketService,
          useValue: {
            connect: vi.fn(),
            disconnect: vi.fn(),
            send: vi.fn(),
            on: vi.fn(<T>(event: string): Observable<T> => {
              if (!subjects.has(event)) subjects.set(event, new Subject<unknown>());
              return subjects.get(event)!.asObservable() as Observable<T>;
            }),
            connectionState: signal('disconnected' as const),
          },
        },
        {
          provide: AuthService,
          useValue: { getCurrentUser: vi.fn().mockReturnValue(signal(user)) },
        },
        { provide: ToastService, useValue: toast },
      ],
    });
    service = TestBed.inject(SessionStateService);
    persistence = TestBed.inject(CalloutPersistenceService);
    copyStore = TestBed.inject(CalloutCopyStoreService);
  });

  afterEach(() => sessionStorage.clear());

  it('callout:note:added updates the notes signal, ignores duplicates, and emits on the bridge', () => {
    const added: string[] = [];
    service.calloutNoteAdded$.subscribe((p) => added.push(p.note.id));

    emit(CALLOUT_NOTE_ADDED, { roundId: 'r1', note: note() });
    emit(CALLOUT_NOTE_ADDED, { roundId: 'r1', note: note({ id: 'n2', authorId: 'user-2' }) });
    emit(CALLOUT_NOTE_ADDED, { roundId: 'r1', note: note() });

    expect(service.calloutNotes().get('r1')?.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(added).toEqual(['n1', 'n2', 'n1']);
  });

  it('ignores a malformed callout:note:added payload', () => {
    emit(CALLOUT_NOTE_ADDED, { roundId: 'r1', note: { id: 5 } });
    emit(CALLOUT_NOTE_ADDED, null);
    expect(service.calloutNotes().size).toBe(0);
  });

  it('callout:note:rejected is exposed on its own stream and does not raise a toast', () => {
    const rejected: CalloutNoteRejectedPayload[] = [];
    service.calloutNoteRejected$.subscribe((p) => rejected.push(p));
    const payload: CalloutNoteRejectedPayload = {
      roundId: 'r1',
      code: 'NOTE_EMPTY',
      message: 'Note is empty',
    };

    emit(CALLOUT_NOTE_REJECTED, payload);

    expect(rejected).toEqual([payload]);
    expect(toast.show).not.toHaveBeenCalled();
  });

  it('the existing error event still raises an error toast', () => {
    emit('error', { message: 'Nope', code: 'X' });
    expect(toast.show).toHaveBeenCalledWith('error', 'Nope');
  });

  it('normalises calloutNotes from session:state rounds and history entries', () => {
    const good = note();
    emit(
      'session:state',
      sessionState({
        currentRound: {
          id: 'r2',
          status: 'voting',
          selections: {},
          calloutNotes: 'not-an-array',
        },
        history: [
          { id: 'h1', roundId: 'r1', storyDescription: 'A', calloutNotes: [good, { bad: true }] },
          { id: 'h2', roundId: 'r0', storyDescription: 'B', calloutNotes: { nope: 1 } },
        ],
      })
    );

    expect(service.currentRound()?.calloutNotes).toEqual([]);
    expect(service.currentRound()?.status).toBe('voting');
    expect(service.history()[0].calloutNotes).toEqual([good]);
    expect(service.history()[1].calloutNotes).toEqual([]);
    expect(service.calloutNotes().get('r1')).toEqual([good]);
    expect(service.calloutNotes().has('r0')).toBe(false);
    expect(service.calloutNotes().has('r2')).toBe(false);
  });

  it('applies every other session:state field when calloutNotes is malformed, without throwing', () => {
    expect(() =>
      emit(
        'session:state',
        sessionState({
          isRevealed: true,
          currentRound: { id: 'r2', status: 'revealed', selections: {}, calloutNotes: null },
          history: [
            { id: 'h1', roundId: 'r1', storyDescription: 'Story A', calloutNotes: 42 },
            { id: 'h2', roundId: 'r0', storyDescription: 'Story B' },
          ],
        })
      )
    ).not.toThrow();

    expect(service.isRevealed()).toBe(true);
    expect(service.participants()).toEqual([user]);
    expect(service.currentRound()?.id).toBe('r2');
    expect(service.currentRound()?.calloutNotes).toEqual([]);
    expect(service.history().map((h) => h.storyDescription)).toEqual(['Story A', 'Story B']);
    expect(service.history()[0].calloutNotes).toEqual([]);
    expect(service.calloutNotes().size).toBe(0);
  });

  it('keeps persistence state when the same session is re-synced', () => {
    emit('session:state', sessionState());
    persistence.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'draft' });

    emit('session:state', sessionState());

    expect(persistence.draft()?.text).toBe('draft');
  });

  it('clears the draft, notes and phrase memo when the routed session changes', () => {
    emit('session:state', sessionState());
    emit(CALLOUT_NOTE_ADDED, { roundId: 'r1', note: note() });
    persistence.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'draft' });
    const sessionChanged = vi.spyOn(persistence, 'sessionChanged');
    const reset = vi.spyOn(copyStore, 'reset');

    emit('session:state', sessionState({ sessionId: 's2' }));

    expect(sessionChanged).toHaveBeenCalledWith('s2');
    expect(reset).toHaveBeenCalled();
    expect(persistence.draft()).toBeNull();
    expect(service.calloutNotes().size).toBe(0);
  });

  it('keeps a draft restored from storage for the same session after reload (first sync)', () => {
    persistence.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'draft' });
    emit('session:state', sessionState());
    expect(persistence.draft()?.text).toBe('draft');
  });

  it('reset() clears persistence, copy store and note state', () => {
    emit(CALLOUT_NOTE_ADDED, { roundId: 'r1', note: note() });
    persistence.recordDismissal({ sessionId: 's1', roundId: 'r1', callout: 'near', at: 1 });
    persistence.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'draft' });
    const clearAll = vi.spyOn(persistence, 'clearAll');
    const reset = vi.spyOn(copyStore, 'reset');

    service.reset();

    expect(clearAll).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(persistence.dismissals()).toEqual([]);
    expect(persistence.draft()).toBeNull();
    expect(service.calloutNotes().size).toBe(0);
  });

  it('reset() transmits nothing to the server', () => {
    const ws = TestBed.inject(WebSocketService);
    persistence.dispatchDraft({ kind: 'typed', sessionId: 's1', roundId: 'r1', text: 'draft' });

    service.reset();

    expect(ws.send).not.toHaveBeenCalled();
  });
});
