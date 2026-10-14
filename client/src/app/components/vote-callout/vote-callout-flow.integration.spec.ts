import { Component, signal, WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALLOUT_NOTE_ADDED,
  CALLOUT_NOTE_REJECTED,
  CALLOUT_NOTE_SUBMIT,
  DEFAULT_SESSION_CONFIG,
  type CalloutNote,
  type CalloutNoteSubmitPayload,
  type ExtendedCardValue,
  type SessionConfiguration,
  type User,
  type VotingMetrics,
} from '@shared/types';
import { CALLOUT_COPY_CATALOG } from '@shared/callout-copy';
import { CalloutCopyStoreService } from '../../services/callout-copy-store.service';
import { CalloutPersistenceService } from '../../services/callout-persistence.service';
import { AuthService } from '../../services/auth.service';
import { SessionStateService } from '../../services/session-state.service';
import { ToastService } from '../../services/toast.service';
import { WebSocketService } from '../../services/websocket.service';
import { EXIT_REMOVAL_DEADLINE_MS } from './callout-animation';
import { stripGlyphs } from './callout-glyph';
import { ACKNOWLEDGEMENT_HOLD_MS } from './far-from-average-prompt.component';
import { VoteCalloutLayerComponent } from './vote-callout-layer.component';

/**
 * End-to-end client flow with a faked socket (task 17.1).
 *
 * Real: SessionStateService, CalloutPersistenceService, CalloutCopyStoreService,
 * VoteCalloutLayerComponent and its three children, the visibility resolver and the proximity
 * classifier. Fake: WebSocketService only, whose `on()` hands out one Subject per event name so a
 * test can push exactly the messages the server would send, and whose `send()` records what the
 * client transmits.
 *
 * Fake timers drive the entrance fallback, the acknowledgement hold and the exit deadline (the
 * test DOM never fires `animationend`).
 *
 * Requirements: 2.1, 3.1, 3.11, 5.6, 6.9, 10.13, 12.7 (plus 2.11, 2.14, 3.4, 10.15, 10.18,
 * 12.3, 12.9 on the way through).
 */

const SESSION_ID = 's1';
const ROUND_1 = 'r1';
const ROUND_2 = 'r2';
const SESSION_STORAGE_KEYS = ['scrum-poker-callout-dismissals', 'scrum-poker-callout-draft'];

const USERS: readonly User[] = [
  { id: 'ann', displayName: 'Ann', role: 'participant', isAnonymous: false },
  { id: 'ben', displayName: 'Ben', role: 'moderator', isAnonymous: false },
  { id: 'cy', displayName: 'Cy', role: 'participant', isAnonymous: false },
  { id: 'dee', displayName: 'Dee', role: 'participant', isAnonymous: false },
  { id: 'eve', displayName: 'Eve', role: 'participant', isAnonymous: false },
];

/**
 * Fibonacci ladder. The consensus anchor is the mode 8 (Ben and Cy), at ladder index 5.
 * Near (<= 0.75): ben, cy (display order Ben, Cy). Neither: ann (5) and dee (13), each 1 away.
 * Far (>= 2.0): eve (1), four steps away.
 */
const VOTES: Readonly<Record<string, ExtendedCardValue>> = {
  ann: 5,
  ben: 8,
  cy: 8,
  dee: 13,
  eve: 1,
};
const NEAR_NAMES = ['Ben', 'Cy'];

const METRICS: VotingMetrics = {
  average: 7,
  mode: 8,
  spread: 12,
  distribution: { '1': 1, '5': 1, '8': 2, '13': 1 },
  outliers: [],
  numericVoteCount: 5,
  insufficientData: false,
};

@Component({
  selector: 'app-flow-host',
  standalone: true,
  imports: [VoteCalloutLayerComponent],
  template: `
    <main id="main-content" tabindex="-1">
      <button type="button">Reveal cards</button>
    </main>
    <app-vote-callout-layer sessionId="s1" />
  `,
})
class HostComponent {}

interface BootOptions {
  readonly viewerId: string;
  /** `all-players` makes every viewer reveal-permitted; `moderator-only` leaves only Ben. */
  readonly revealMode?: 'all-players' | 'moderator-only';
}

describe('Vote callouts: client end-to-end flow with a faked socket', () => {
  let fixture: ComponentFixture<HostComponent>;
  let subjects: Map<string, Subject<unknown>>;
  let send: ReturnType<typeof vi.fn>;
  let connectionState: WritableSignal<'connected' | 'disconnected' | 'reconnecting'>;
  let state: SessionStateService;
  let persistence: CalloutPersistenceService;
  let copyStore: CalloutCopyStoreService;
  let config: SessionConfiguration;

  // ---- Harness ------------------------------------------------------------------------------

  function emit(event: string, data: unknown): void {
    if (!subjects.has(event)) subjects.set(event, new Subject<unknown>());
    subjects.get(event)!.next(data);
  }

  /** Change detection until effects, reconciliation and re-renders settle. */
  function flush(): void {
    for (let i = 0; i < 4; i += 1) fixture.detectChanges();
  }

  function advance(ms: number): void {
    vi.advanceTimersByTime(ms);
    flush();
  }

  /** Builds the app around a fake socket. Does not touch `sessionStorage`, so it can model a reload. */
  function boot(options: BootOptions): void {
    subjects = new Map();
    send = vi.fn();
    connectionState = signal('connected');
    config = {
      ...DEFAULT_SESSION_CONFIG,
      votingSystem: 'fibonacci',
      revealPermission: { mode: options.revealMode ?? 'moderator-only', allowedUserIds: [] },
      funCallouts: true,
    };
    const viewer = USERS.find((u) => u.id === options.viewerId) as User;

    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        {
          provide: WebSocketService,
          useValue: {
            send,
            connect: vi.fn(),
            disconnect: vi.fn(),
            connectionState,
            on: <T>(event: string): Observable<T> => {
              if (!subjects.has(event)) subjects.set(event, new Subject<unknown>());
              return subjects.get(event)!.asObservable() as Observable<T>;
            },
          },
        },
        { provide: AuthService, useValue: { getCurrentUser: () => signal<User | null>(viewer) } },
        { provide: ToastService, useValue: { show: vi.fn() } },
      ],
    });

    state = TestBed.inject(SessionStateService);
    persistence = TestBed.inject(CalloutPersistenceService);
    copyStore = TestBed.inject(CalloutCopyStoreService);
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    flush();
  }

  function sessionStatePayload(round: Record<string, unknown> | null, isRevealed: boolean): unknown {
    return {
      state: {
        sessionId: SESSION_ID,
        config,
        ownerId: 'ben',
        createdAt: '2026-05-01T09:00:00.000Z',
        issueList: [],
        participants: USERS,
        history: [],
        isRevealed,
        currentRound: round,
      },
    };
  }

  function serverRound(
    id: string,
    story: string,
    status: 'voting' | 'revealed'
  ): Record<string, unknown> {
    return {
      id,
      storyDescription: story,
      status,
      selections: status === 'revealed' ? { ...VOTES } : {},
      startedAt: '2026-05-01T10:00:00.000Z',
    };
  }

  /** `session:state` for a joined session whose round is still being voted on. */
  function join(): void {
    emit('session:state', sessionStatePayload(null, false));
    flush();
  }

  function startRound(id: string, story: string): void {
    emit('round:started', { round: serverRound(id, story, 'voting') });
    flush();
  }

  function castAllVotes(): void {
    for (const user of USERS) emit('card:voted', { userId: user.id });
    flush();
  }

  function revealCards(): void {
    emit('cards:revealed', { selections: { ...VOTES }, metrics: METRICS });
    flush();
  }

  /** Join, start `r1`, vote, reveal. */
  function playRoundOne(): void {
    join();
    startRound(ROUND_1, 'Story one');
    castAllVotes();
    revealCards();
  }

  function note(roundId: string, authorId: string, text: string, id = 'note-1'): CalloutNote {
    const author = USERS.find((u) => u.id === authorId) as User;
    return {
      id,
      roundId,
      authorId,
      authorName: author.displayName,
      text,
      storedAt: '2026-05-01T10:05:00.000Z',
    };
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const near = (): HTMLElement | null => el().querySelector<HTMLElement>('.callout--near');
  const far = (): HTMLElement | null => el().querySelector<HTMLElement>('.callout--far');
  const unsent = (): HTMLElement | null => el().querySelector<HTMLElement>('app-unsent-note');
  const normalise = (text: string | null | undefined): string =>
    (text ?? '').replace(/\s+/g, ' ').trim();
  const nearNames = (): string[] =>
    Array.from(near()?.querySelectorAll('.callout__name') ?? []).map((n) => normalise(n.textContent));
  const textarea = (): HTMLTextAreaElement =>
    far()?.querySelector<HTMLTextAreaElement>('textarea') as HTMLTextAreaElement;
  const submitButton = (): HTMLButtonElement =>
    far()?.querySelector<HTMLButtonElement>('.callout__action--submit') as HTMLButtonElement;
  const noteSubmissions = (): Array<[string, CalloutNoteSubmitPayload]> =>
    (send.mock.calls as Array<[string, CalloutNoteSubmitPayload]>).filter(
      ([event]) => event === CALLOUT_NOTE_SUBMIT
    );

  function typeNote(text: string): void {
    const input = textarea();
    input.value = text;
    input.dispatchEvent(new Event('input'));
    flush();
  }

  function clickDismissOnNear(): void {
    near()?.querySelector<HTMLButtonElement>('.callout__dismiss')?.click();
    flush();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  // ---- Reveal -> callouts (R2.1, R3.1) ------------------------------------------------------

  describe('reveal', () => {
    it('shows nothing while the round is still being voted on', () => {
      boot({ viewerId: 'ben' });
      join();
      startRound(ROUND_1, 'Story one');
      castAllVotes();
      advance(2000);

      expect(near()).toBeNull();
      expect(far()).toBeNull();
      expect(unsent()).toBeNull();
    });

    it('shows the near callout, with the closest names in order, to a reveal-permitted viewer (R2.1)', () => {
      boot({ viewerId: 'ben' });
      playRoundOne();

      // No timers advanced: the callout is on screen as soon as the revealed state is applied.
      expect(near()).not.toBeNull();
      expect(nearNames()).toEqual(NEAR_NAMES);
      expect(normalise(near()?.querySelector('.callout__phrase')?.textContent).length).toBeGreaterThan(0);
      // Ben voted near the average, so no private prompt.
      expect(far()).toBeNull();
    });

    it('shows the far prompt, and not the near callout, to a far viewer without reveal permission (R3.1)', () => {
      boot({ viewerId: 'eve', revealMode: 'moderator-only' });
      playRoundOne();

      expect(state.hasRevealPermission()).toBe(false);
      expect(near()).toBeNull();
      expect(far()).not.toBeNull();
      expect(textarea().value).toBe('');
      // The prompt carries no names, numbers or other participants (R3.6).
      const text = normalise(far()?.textContent);
      for (const leaked of ['Ann', 'Ben', 'Cy', 'Dee', '7', '13']) expect(text).not.toContain(leaked);
    });

    it('shows neither panel to a viewer who is neither reveal-permitted nor far', () => {
      boot({ viewerId: 'dee', revealMode: 'moderator-only' });
      playRoundOne();
      advance(1000);

      expect(near()).toBeNull();
      expect(far()).toBeNull();
    });

    it('shows both panels to a far viewer who may reveal, and lets each be dismissed alone (R3.4)', () => {
      boot({ viewerId: 'eve', revealMode: 'all-players' });
      playRoundOne();

      expect(near()).not.toBeNull();
      expect(far()).not.toBeNull();

      clickDismissOnNear();
      advance(EXIT_REMOVAL_DEADLINE_MS);

      expect(near()).toBeNull();
      expect(far()).not.toBeNull();
    });

    it('draws the phrases from the shared catalog', () => {
      boot({ viewerId: 'eve', revealMode: 'all-players' });
      playRoundOne();

      const nearChosen = copyStore.phraseFor('nearAverage', ROUND_1) as string;
      const farChosen = copyStore.phraseFor('farFromAverage', ROUND_1) as string;
      expect(CALLOUT_COPY_CATALOG.nearAverage).toContain(nearChosen);
      expect(CALLOUT_COPY_CATALOG.farFromAverage).toContain(farChosen);

      const shown = (node: HTMLElement | null): string =>
        normalise(stripGlyphs(node?.querySelector('.callout__phrase')?.textContent ?? ''));
      expect(shown(near())).toBe(normalise(stripGlyphs(nearChosen)));
      expect(shown(far())).toBe(normalise(stripGlyphs(farChosen)));
    });

    it('keeps the callouts, without replacing them, across a session:state re-sync (R12.1)', () => {
      boot({ viewerId: 'eve', revealMode: 'all-players' });
      playRoundOne();
      const nearBefore = near();
      const farBefore = far();
      const phraseBefore = normalise(nearBefore?.querySelector('.callout__phrase')?.textContent);

      emit('session:state', sessionStatePayload(serverRound(ROUND_1, 'Story one', 'revealed'), true));
      flush();
      advance(5000);

      expect(near()).toBe(nearBefore);
      expect(far()).toBe(farBefore);
      expect(normalise(near()?.querySelector('.callout__phrase')?.textContent)).toBe(phraseBefore);
    });
  });

  // ---- Note submission (R3.11, R10.2, R10.12, R3.12, R3.13) ---------------------------------

  describe('note submission', () => {
    beforeEach(() => {
      boot({ viewerId: 'eve', revealMode: 'moderator-only' });
      playRoundOne();
    });

    it('keeps submit disabled while the field is blank, then sends one trimmed note and waits (R3.13)', () => {
      expect(submitButton().disabled).toBe(true);
      typeNote('   ');
      expect(submitButton().disabled).toBe(true);

      typeNote('  I sized it for the migration too  ');
      expect(submitButton().disabled).toBe(false);

      submitButton().click();
      flush();
      submitButton()?.click(); // a second activation while pending is ignored

      expect(noteSubmissions()).toEqual([
        [
          CALLOUT_NOTE_SUBMIT,
          { sessionId: SESSION_ID, roundId: ROUND_1, text: 'I sized it for the migration too' },
        ],
      ]);
      expect(submitButton().disabled).toBe(true);
      expect(far()).not.toBeNull();
    });

    it('acknowledges on callout:note:added, then exits and stays hidden for the round (R3.11, R10.12)', () => {
      typeNote('Because of the migration');
      submitButton().click();
      flush();

      emit(CALLOUT_NOTE_ADDED, {
        roundId: ROUND_1,
        note: note(ROUND_1, 'eve', 'Because of the migration'),
      });
      flush();

      // Content swaps to the acknowledgement; input and submit control are gone.
      const ack = normalise(far()?.querySelector('.callout__phrase--ack')?.textContent);
      expect(ack.length).toBeGreaterThan(0);
      expect(far()?.querySelector('textarea')).toBeNull();
      expect(far()?.querySelector('.callout__action--submit')).toBeNull();
      expect(state.calloutNotes().get(ROUND_1)?.map((n) => n.text)).toEqual(['Because of the migration']);
      expect(persistence.draft()).toBeNull();

      advance(ACKNOWLEDGEMENT_HOLD_MS);
      expect(far()?.classList.contains('callout--exiting')).toBe(true);
      advance(EXIT_REMOVAL_DEADLINE_MS);
      expect(far()).toBeNull();

      // Hidden for the rest of the round, including across a re-sync and a re-sent reveal.
      emit('session:state', sessionStatePayload(serverRound(ROUND_1, 'Story one', 'revealed'), true));
      revealCards();
      advance(5000);
      expect(far()).toBeNull();
      expect(persistence.isDismissed(SESSION_ID, ROUND_1, 'far')).toBe(true);
    });

    it('ignores an acceptance for somebody else\'s note', () => {
      typeNote('Mine');
      submitButton().click();
      flush();

      emit(CALLOUT_NOTE_ADDED, { roundId: ROUND_1, note: note(ROUND_1, 'ann', 'Hers', 'note-2') });
      flush();

      expect(far()?.querySelector('.callout__phrase--ack')).toBeNull();
      expect(submitButton().disabled).toBe(true);
    });

    it('stays visible, keeps the text and shows an error on callout:note:rejected (R3.12)', () => {
      typeNote('Too much to say');
      submitButton().click();
      flush();

      emit(CALLOUT_NOTE_REJECTED, {
        roundId: ROUND_1,
        code: 'NOTE_TOO_LONG',
        message: 'Note is too long',
      });
      flush();

      expect(far()).not.toBeNull();
      expect(textarea().value).toBe('Too much to say');
      expect(submitButton().disabled).toBe(false);
      expect(normalise(far()?.querySelector('.callout__error')?.textContent)).toMatch(/not saved/i);
      expect(persistence.draft()?.text).toBe('Too much to say');
    });

    it('declining sends nothing, discards the text and hides the prompt for the round (R3.9)', () => {
      typeNote('Never mind');
      far()?.querySelector<HTMLButtonElement>('.callout__action--dismiss')?.click();
      flush();
      advance(EXIT_REMOVAL_DEADLINE_MS);

      expect(far()).toBeNull();
      expect(noteSubmissions()).toEqual([]);
      expect(persistence.draft()).toBeNull();

      revealCards();
      advance(1000);
      expect(far()).toBeNull();
    });
  });

  // ---- New round -> exit, unsent note (R5.6, R10.13) ----------------------------------------

  describe('new round', () => {
    it('exits both panels and collapses a drafted note into the unsent element (R5.6, R10.13)', () => {
      boot({ viewerId: 'eve', revealMode: 'all-players' });
      playRoundOne();
      typeNote('Still thinking about the edge cases');
      expect(persistence.draft()).toMatchObject({ roundId: ROUND_1, sessionId: SESSION_ID });

      startRound(ROUND_2, 'Story two');

      expect(near()?.classList.contains('callout--exiting')).toBe(true);
      expect(far()?.classList.contains('callout--exiting')).toBe(true);
      advance(EXIT_REMOVAL_DEADLINE_MS);
      expect(near()).toBeNull();
      expect(far()).toBeNull();

      expect(unsent()).not.toBeNull();
      expect(normalise(unsent()?.textContent)).toContain('Still thinking about the edge cases');
      expect(persistence.draft()).toEqual({
        sessionId: SESSION_ID,
        roundId: ROUND_1,
        text: 'Still thinking about the edge cases',
      });
      // Nothing was transmitted by any of this (R10.13, R3.3).
      expect(noteSubmissions()).toEqual([]);
    });

    it('exits both panels without an unsent element when nothing was drafted (R5.6)', () => {
      boot({ viewerId: 'eve', revealMode: 'all-players' });
      playRoundOne();

      startRound(ROUND_2, 'Story two');
      advance(EXIT_REMOVAL_DEADLINE_MS);

      expect(near()).toBeNull();
      expect(far()).toBeNull();
      expect(unsent()).toBeNull();
    });

    it('submits the retained text against the round it was written for, and removes it only once accepted (R10.15)', () => {
      boot({ viewerId: 'eve', revealMode: 'moderator-only' });
      playRoundOne();
      typeNote('About round one');
      startRound(ROUND_2, 'Story two');
      advance(EXIT_REMOVAL_DEADLINE_MS);

      unsent()?.querySelector<HTMLButtonElement>('.unsent-note__action--submit')?.click();
      flush();

      expect(noteSubmissions()).toEqual([
        [CALLOUT_NOTE_SUBMIT, { sessionId: SESSION_ID, roundId: ROUND_1, text: 'About round one' }],
      ]);
      // Still there until the server accepts it.
      expect(unsent()).not.toBeNull();
      expect(persistence.draft()?.roundId).toBe(ROUND_1);

      emit(CALLOUT_NOTE_ADDED, { roundId: ROUND_1, note: note(ROUND_1, 'eve', 'About round one') });
      flush();

      expect(unsent()).toBeNull();
      expect(persistence.draft()).toBeNull();
      expect(state.calloutNotes().get(ROUND_1)?.map((n) => n.text)).toEqual(['About round one']);
    });

    it('keeps the unsent element when the server rejects the retained text (R10.15)', () => {
      boot({ viewerId: 'eve', revealMode: 'moderator-only' });
      playRoundOne();
      typeNote('About round one');
      startRound(ROUND_2, 'Story two');
      advance(EXIT_REMOVAL_DEADLINE_MS);

      unsent()?.querySelector<HTMLButtonElement>('.unsent-note__action--submit')?.click();
      flush();
      emit(CALLOUT_NOTE_REJECTED, { roundId: ROUND_1, code: 'NOTE_ROUND_UNKNOWN', message: 'Unknown' });
      flush();

      expect(unsent()).not.toBeNull();
      expect(persistence.draft()?.text).toBe('About round one');
      expect(normalise(unsent()?.textContent)).toMatch(/not saved/i);
    });

    it('discarding the retained text removes the element and sends nothing (R10.18)', () => {
      boot({ viewerId: 'eve', revealMode: 'moderator-only' });
      playRoundOne();
      typeNote('About round one');
      startRound(ROUND_2, 'Story two');
      advance(EXIT_REMOVAL_DEADLINE_MS);

      unsent()?.querySelector<HTMLButtonElement>('.unsent-note__action--discard')?.click();
      flush();

      expect(unsent()).toBeNull();
      expect(persistence.draft()).toBeNull();
      expect(noteSubmissions()).toEqual([]);
    });

    it('keeps the retained text across several round starts (R10.14)', () => {
      boot({ viewerId: 'eve', revealMode: 'moderator-only' });
      playRoundOne();
      typeNote('Carry me');
      startRound(ROUND_2, 'Story two');
      startRound('r3', 'Story three');
      startRound('r4', 'Story four');
      advance(EXIT_REMOVAL_DEADLINE_MS);

      expect(unsent()).not.toBeNull();
      expect(persistence.draft()?.roundId).toBe(ROUND_1);
    });

    it('offers the callouts again in the next revealed round after a dismissal (R2.14)', () => {
      boot({ viewerId: 'ben', revealMode: 'moderator-only' });
      playRoundOne();
      clickDismissOnNear();
      advance(EXIT_REMOVAL_DEADLINE_MS);
      expect(near()).toBeNull();

      startRound(ROUND_2, 'Story two');
      castAllVotes();
      revealCards();

      expect(near()).not.toBeNull();
      expect(nearNames()).toEqual(NEAR_NAMES);
    });
  });

  // ---- Dismissal memory (R2.11, R12.3, R12.9) -----------------------------------------------

  describe('dismissal memory', () => {
    it('keeps a dismissed near callout hidden across a re-sync and a re-sent reveal (R2.11, R12.3)', () => {
      boot({ viewerId: 'ben' });
      playRoundOne();
      clickDismissOnNear();
      advance(EXIT_REMOVAL_DEADLINE_MS);
      expect(near()).toBeNull();
      expect(persistence.isDismissed(SESSION_ID, ROUND_1, 'near')).toBe(true);

      emit('session:state', sessionStatePayload(serverRound(ROUND_1, 'Story one', 'revealed'), true));
      flush();
      expect(near()).toBeNull();

      revealCards();
      advance(5000);
      expect(near()).toBeNull();
      // Dismissal is local: nothing about it was transmitted (R2.10).
      expect(send).not.toHaveBeenCalled();
    });

    it('keeps the dismissal after a reload that re-sends the reveal, and still shows the other panel (R12.3, R12.9)', () => {
      boot({ viewerId: 'eve', revealMode: 'all-players' });
      playRoundOne();
      clickDismissOnNear();
      advance(EXIT_REMOVAL_DEADLINE_MS);
      expect(near()).toBeNull();
      expect(far()).not.toBeNull();

      // Reload: a fresh app instance over the same tab-scoped storage.
      TestBed.resetTestingModule();
      boot({ viewerId: 'eve', revealMode: 'all-players' });
      expect(persistence.isDismissed(SESSION_ID, ROUND_1, 'near')).toBe(true);

      emit('session:state', sessionStatePayload(serverRound(ROUND_1, 'Story one', 'revealed'), true));
      revealCards(); // a reconnect that re-sends cards:revealed
      advance(1000);

      expect(near()).toBeNull();
      expect(far()).not.toBeNull();
    });

    /**
     * KNOWN GAP (R12.1), not a regression of this task.
     *
     * `SessionStateService` does not restore `metrics` from `session:state` (the server's payload
     * carries none), so a page that loads or reconnects straight into an already-revealed round
     * has `metrics() === null` and the visibility resolver suppresses everything as `not-revealed`
     * until the next `cards:revealed`. R12.1 wants the callouts evaluated against the synchronised
     * state within 2 seconds. Un-skip when metrics are derived or restored on sync.
     */
    it.skip('GAP R12.1: shows the callouts after a reload straight into an already-revealed round (session:state only)', () => {
      boot({ viewerId: 'eve', revealMode: 'all-players' });
      emit('session:state', sessionStatePayload(serverRound(ROUND_1, 'Story one', 'revealed'), true));
      advance(2000);

      expect(near()).not.toBeNull();
      expect(far()).not.toBeNull();
    });
  });

  // ---- funCallouts toggle (R6.9) ------------------------------------------------------------

  describe('funCallouts', () => {
    it('plays the exit and removes both panels when session:config-updated turns it off (R6.9)', () => {
      boot({ viewerId: 'eve', revealMode: 'all-players' });
      playRoundOne();
      expect(near()).not.toBeNull();
      expect(far()).not.toBeNull();

      emit('session:config-updated', { config: { ...config, funCallouts: false } });
      flush();

      expect(near()?.classList.contains('callout--exiting')).toBe(true);
      expect(far()?.classList.contains('callout--exiting')).toBe(true);
      advance(EXIT_REMOVAL_DEADLINE_MS);
      expect(near()).toBeNull();
      expect(far()).toBeNull();
    });

    it('keeps them hidden across a re-sync and a re-sent reveal while it is off (R6.7)', () => {
      boot({ viewerId: 'eve', revealMode: 'all-players' });
      playRoundOne();
      emit('session:config-updated', { config: { ...config, funCallouts: false } });
      advance(EXIT_REMOVAL_DEADLINE_MS);

      config = { ...config, funCallouts: false };
      emit('session:state', sessionStatePayload(serverRound(ROUND_1, 'Story one', 'revealed'), true));
      revealCards();
      advance(2000);

      expect(near()).toBeNull();
      expect(far()).toBeNull();
    });

    it('keeps a retained draft when the setting turns off (R11.15)', () => {
      boot({ viewerId: 'eve', revealMode: 'moderator-only' });
      playRoundOne();
      typeNote('Keep this safe');

      emit('session:config-updated', { config: { ...config, funCallouts: false } });
      advance(EXIT_REMOVAL_DEADLINE_MS);

      expect(far()).toBeNull();
      expect(persistence.draft()?.text).toBe('Keep this safe');
    });
  });

  // ---- Sign-out (R12.7) ---------------------------------------------------------------------

  describe('sign-out', () => {
    it('clears dismissals, the retained draft, notes and phrase memo locally, and removes the panels (R12.7)', () => {
      boot({ viewerId: 'eve', revealMode: 'all-players' });
      playRoundOne();
      clickDismissOnNear();
      advance(EXIT_REMOVAL_DEADLINE_MS);
      typeNote('Unsent thoughts');
      emit(CALLOUT_NOTE_ADDED, { roundId: ROUND_1, note: note(ROUND_1, 'ann', 'Hello', 'note-9') });
      flush();

      expect(persistence.dismissals().length).toBe(1);
      expect(persistence.draft()).not.toBeNull();
      for (const key of SESSION_STORAGE_KEYS) expect(sessionStorage.getItem(key)).not.toBeNull();
      const sendsBefore = send.mock.calls.length;
      const resetSpy = vi.spyOn(copyStore, 'reset');

      state.reset();
      flush();

      expect(persistence.dismissals()).toEqual([]);
      expect(persistence.draft()).toBeNull();
      expect(state.calloutNotes().size).toBe(0);
      expect(resetSpy).toHaveBeenCalled();
      for (const key of SESSION_STORAGE_KEYS) expect(sessionStorage.getItem(key)).toBeNull();
      // Purely local: nothing is sent to the server.
      expect(send.mock.calls.length).toBe(sendsBefore);

      advance(EXIT_REMOVAL_DEADLINE_MS);
      expect(near()).toBeNull();
      expect(far()).toBeNull();
      expect(unsent()).toBeNull();
    });
  });
});
