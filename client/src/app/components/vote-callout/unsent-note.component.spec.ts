import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, WritableSignal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALLOUT_NOTE_ADDED,
  CALLOUT_NOTE_REJECTED,
  CALLOUT_NOTE_SUBMIT,
  CalloutNote,
  CalloutNoteAddedPayload,
  CalloutNoteRejectedPayload,
} from '@shared/types';
import { UnsentNoteComponent } from './unsent-note.component';
import {
  CalloutPersistenceService,
  NoteDraft,
} from '../../services/callout-persistence.service';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';

/**
 * Unsent_Note_Element (R10.13, R10.14, R10.15, R10.18, R12.10).
 *
 * The WebSocket and session-state services are minimal fakes; the persistence service is the REAL
 * one, backed by jsdom's `sessionStorage`, so "restored from storage" is exercised end to end.
 */

const DRAFT_KEY = 'scrum-poker-callout-draft';
const DISMISSAL_KEY = 'scrum-poker-callout-dismissals';

const SESSION_ID = 'session-1';
const STORED_ROUND = 'round-1';
const USER_ID = 'user-1';
const DRAFT_TEXT = 'I assumed the API already existed';

/** Interface the component reads from the fake socket. */
interface FakeWs {
  send: ReturnType<typeof vi.fn>;
  on: <T>(event: string) => Observable<T>;
}

describe('UnsentNoteComponent', () => {
  let fixture: ComponentFixture<UnsentNoteComponent>;
  let persistence: CalloutPersistenceService;
  let ws: FakeWs;
  let events: Map<string, Subject<unknown>>;
  let currentUser: WritableSignal<{ id: string } | null>;

  function subjectFor(event: string): Subject<unknown> {
    let subject = events.get(event);
    if (!subject) {
      subject = new Subject<unknown>();
      events.set(event, subject);
    }
    return subject;
  }

  function note(overrides: Partial<CalloutNote> = {}): CalloutNote {
    return {
      id: 'note-1',
      roundId: STORED_ROUND,
      authorId: USER_ID,
      authorName: 'Alex',
      text: DRAFT_TEXT,
      storedAt: '2026-05-01T10:00:00.000Z',
      ...overrides,
    };
  }

  function emitAdded(overrides: Partial<CalloutNote> = {}): void {
    const n = note(overrides);
    const payload: CalloutNoteAddedPayload = { roundId: n.roundId, note: n };
    subjectFor(CALLOUT_NOTE_ADDED).next(payload);
    fixture.detectChanges();
  }

  function emitRejected(roundId = STORED_ROUND): void {
    const payload: CalloutNoteRejectedPayload = {
      roundId,
      code: 'NOTE_TOO_LONG',
      message: 'too long',
    };
    subjectFor(CALLOUT_NOTE_REJECTED).next(payload);
    fixture.detectChanges();
  }

  /** Seeds the tab's draft through the real service and mounts the component bound to it. */
  function mount(): void {
    const draft = persistence.draft();
    if (draft === null) throw new Error('test setup: no draft to mount');
    fixture = TestBed.createComponent(UnsentNoteComponent);
    fixture.componentRef.setInput('draft', draft);
    fixture.detectChanges();
  }

  function seedDraft(roundId = STORED_ROUND, text = DRAFT_TEXT): void {
    persistence.dispatchDraft({ kind: 'typed', sessionId: SESSION_ID, roundId, text });
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const submitBtn = (): HTMLButtonElement =>
    el().querySelector<HTMLButtonElement>('.unsent-note__action--submit') as HTMLButtonElement;
  const discardBtn = (): HTMLButtonElement =>
    el().querySelector<HTMLButtonElement>('.unsent-note__action--discard') as HTMLButtonElement;
  const sends = (): unknown[][] => ws.send.mock.calls as unknown[][];

  function configure(): void {
    events = new Map();
    currentUser = signal<{ id: string } | null>({ id: USER_ID });
    ws = {
      send: vi.fn(),
      on: <T>(event: string): Observable<T> => subjectFor(event).asObservable() as Observable<T>,
    };
    TestBed.configureTestingModule({
      imports: [UnsentNoteComponent],
      providers: [
        { provide: WebSocketService, useValue: ws },
        { provide: SessionStateService, useValue: { currentUser } },
      ],
    });
    persistence = TestBed.inject(CalloutPersistenceService);
  }

  beforeEach(() => {
    sessionStorage.clear();
    configure();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  describe('rendering and survival', () => {
    it('renders the retained text read-only with the two labelled controls', () => {
      seedDraft();
      mount();

      expect(el().querySelector('.unsent-note__text')?.textContent).toBe(DRAFT_TEXT);
      expect(el().querySelector('textarea, input')).toBeNull();
      expect(submitBtn().getAttribute('aria-label')).toBe(
        'Share your saved note on its original round'
      );
      expect(discardBtn().getAttribute('aria-label')).toBe('Discard your saved note');
    });

    it('keeps the draft and its original round across repeated round starts (R10.14)', () => {
      seedDraft();
      mount();

      for (let i = 2; i <= 25; i++) {
        persistence.dispatchDraft({ kind: 'round-changed', roundId: `round-${i}` });
        fixture.detectChanges();
      }

      expect(persistence.draft()).toEqual({
        sessionId: SESSION_ID,
        roundId: STORED_ROUND,
        text: DRAFT_TEXT,
      });
      expect(el().querySelector('.unsent-note__text')?.textContent).toBe(DRAFT_TEXT);
      expect(sends()).toHaveLength(0);
    });

    it('shows a stale draft restored from storage bound to its original round (R12.10)', () => {
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({ sessionId: SESSION_ID, roundId: 'round-before-reload', text: 'carried over' })
      );

      // A fresh injector, as after a page reload: the service hydrates in its constructor.
      TestBed.resetTestingModule();
      configure();

      const restored = persistence.draft();
      expect(restored).toEqual({
        sessionId: SESSION_ID,
        roundId: 'round-before-reload',
        text: 'carried over',
      });

      mount();
      expect(el().querySelector('.unsent-note__text')?.textContent).toBe('carried over');

      submitBtn().click();
      expect(sends()).toEqual([
        [
          CALLOUT_NOTE_SUBMIT,
          { sessionId: SESSION_ID, roundId: 'round-before-reload', text: 'carried over' },
        ],
      ]);
    });

    it('renders markup in the retained text literally', () => {
      seedDraft(STORED_ROUND, '<b>bold</b> & <script>x</script>');
      mount();

      expect(el().querySelector('.unsent-note__text')?.textContent).toBe(
        '<b>bold</b> & <script>x</script>'
      );
      expect(el().querySelector('b, script')).toBeNull();
    });
  });

  describe('submit (R10.15)', () => {
    it('sends against the stored round id and session id, not the current round', () => {
      seedDraft('round-written-for');
      mount();
      // The routed session has moved on to later rounds.
      persistence.dispatchDraft({ kind: 'round-changed', roundId: 'round-current' });

      submitBtn().click();

      expect(sends()).toHaveLength(1);
      expect(sends()[0]).toEqual([
        CALLOUT_NOTE_SUBMIT,
        { sessionId: SESSION_ID, roundId: 'round-written-for', text: DRAFT_TEXT },
      ]);
    });

    it('sends the trimmed text', () => {
      seedDraft(STORED_ROUND, '   padded note \n');
      mount();

      submitBtn().click();

      expect(sends()[0][1]).toEqual({
        sessionId: SESSION_ID,
        roundId: STORED_ROUND,
        text: 'padded note',
      });
    });

    it('keeps the draft and disables submit while awaiting the server', () => {
      seedDraft();
      mount();

      submitBtn().click();
      fixture.detectChanges();

      expect(persistence.draft()?.text).toBe(DRAFT_TEXT);
      expect(submitBtn().disabled).toBe(true);

      submitBtn().click();
      expect(sends()).toHaveLength(1);
    });

    it('clears the draft only after callout:note:added for that round and author', () => {
      seedDraft();
      mount();
      submitBtn().click();
      fixture.detectChanges();

      // Unrelated acknowledgements must not clear it.
      emitAdded({ roundId: 'some-other-round' });
      expect(persistence.draft()).not.toBeNull();
      emitAdded({ authorId: 'someone-else' });
      expect(persistence.draft()).not.toBeNull();

      emitAdded();
      expect(persistence.draft()).toBeNull();
      expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    });

    it('ignores callout:note:added when no submission is in flight', () => {
      seedDraft();
      mount();

      emitAdded();

      expect(persistence.draft()?.text).toBe(DRAFT_TEXT);
    });

    it('ignores callout:note:added when no user is signed in', () => {
      seedDraft();
      mount();
      submitBtn().click();
      currentUser.set(null);

      emitAdded();

      expect(persistence.draft()?.text).toBe(DRAFT_TEXT);
    });
  });

  describe('rejection (R10.15)', () => {
    it('keeps the draft, shows an error and re-enables submit', () => {
      seedDraft();
      mount();
      submitBtn().click();
      fixture.detectChanges();
      expect(submitBtn().disabled).toBe(true);

      emitRejected();

      expect(persistence.draft()).toEqual({
        sessionId: SESSION_ID,
        roundId: STORED_ROUND,
        text: DRAFT_TEXT,
      });
      expect(el().querySelector('.unsent-note__error')?.textContent).toContain('not saved');
      expect(el().querySelector('.unsent-note__text')?.textContent).toBe(DRAFT_TEXT);
      expect(submitBtn().disabled).toBe(false);
    });

    it('allows a retry that sends again against the same stored round and then succeeds', () => {
      seedDraft();
      mount();
      submitBtn().click();
      emitRejected();

      submitBtn().click();
      fixture.detectChanges();
      expect(el().querySelector('.unsent-note__error')).toBeNull();
      expect(sends()).toHaveLength(2);
      expect(sends()[1]).toEqual(sends()[0]);

      emitAdded();
      expect(persistence.draft()).toBeNull();
    });

    it('ignores a rejection for a different round or with nothing in flight', () => {
      seedDraft();
      mount();

      emitRejected(); // nothing in flight
      expect(el().querySelector('.unsent-note__error')).toBeNull();

      submitBtn().click();
      emitRejected('some-other-round');
      fixture.detectChanges();
      expect(el().querySelector('.unsent-note__error')).toBeNull();
      expect(submitBtn().disabled).toBe(true);
    });
  });

  describe('discard (R10.18)', () => {
    it('clears the draft from the service and storage and sends nothing', () => {
      seedDraft();
      mount();

      discardBtn().click();

      expect(persistence.draft()).toBeNull();
      expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
      expect(sends()).toHaveLength(0);
    });

    it('sends nothing even after a prior rejection', () => {
      seedDraft();
      mount();
      submitBtn().click();
      emitRejected();
      ws.send.mockClear();

      discardBtn().click();

      expect(persistence.draft()).toBeNull();
      expect(sends()).toHaveLength(0);
    });
  });

  describe('no animation and no dismissal record', () => {
    it('carries no entrance, idle, exiting or animate.* classes or inline animation', () => {
      seedDraft();
      mount();
      submitBtn().click();
      fixture.detectChanges();
      emitRejected();

      const nodes: Element[] = [el(), ...Array.from(el().querySelectorAll('*'))];
      for (const node of nodes) {
        const cls = Array.from(node.classList);
        expect(cls.filter((c) => /^callout(-|_)/.test(c) || /enter|exit|idle|anim/.test(c))).toEqual(
          []
        );
        expect(node.getAttribute('style') ?? '').not.toMatch(/animation|transition/);
        expect(node.hasAttribute('animate.enter')).toBe(false);
        expect(node.hasAttribute('animate.leave')).toBe(false);
      }
    });

    it('declares no animation, keyframes or transition in its stylesheet', () => {
      const def = (UnsentNoteComponent as unknown as { ɵcmp: { styles: readonly string[] } }).ɵcmp;
      const css = def.styles.join('\n');
      expect(css.length).toBeGreaterThan(0);
      expect(css).not.toMatch(/@keyframes|animation|transition/);
    });

    it('writes no Dismissal_Record across submit, rejection, acceptance and discard', () => {
      seedDraft();
      mount();
      submitBtn().click();
      emitRejected();
      submitBtn().click();
      emitAdded();

      seedDraft();
      fixture = TestBed.createComponent(UnsentNoteComponent);
      fixture.componentRef.setInput('draft', persistence.draft() as NoteDraft);
      fixture.detectChanges();
      discardBtn().click();

      expect(persistence.dismissals()).toEqual([]);
      expect(sessionStorage.getItem(DISMISSAL_KEY)).toBeNull();
    });
  });

  describe('teardown', () => {
    it('stops reacting to server events after destroy', () => {
      seedDraft();
      mount();
      submitBtn().click();
      fixture.destroy();

      const payload: CalloutNoteAddedPayload = { roundId: STORED_ROUND, note: note() };
      subjectFor(CALLOUT_NOTE_ADDED).next(payload);

      expect(persistence.draft()?.text).toBe(DRAFT_TEXT);
    });
  });
});
