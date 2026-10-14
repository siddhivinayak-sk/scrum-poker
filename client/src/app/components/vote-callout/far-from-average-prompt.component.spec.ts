import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, WritableSignal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALLOUT_COPY_CATALOG } from '@shared/callout-copy';
import {
  CALLOUT_NOTE_SUBMIT,
  CalloutNote,
  CalloutNoteAddedPayload,
  CalloutNoteRejectedPayload,
  CalloutNoteRejection,
  NOTE_MAX_LENGTH,
} from '@shared/types';
import {
  ACKNOWLEDGEMENT_HOLD_MS,
  FAR_PROMPT_COPY,
  FAR_PROMPT_REJECTION_MESSAGES,
  FarFromAveragePromptComponent,
} from './far-from-average-prompt.component';
import { EXIT_REMOVAL_DEADLINE_MS } from './callout-animation';
import type { FarPromptModel } from './callout-visibility';
import { CalloutPersistenceService } from '../../services/callout-persistence.service';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';

/**
 * Far_From_Average_Prompt (R3.3, R3.6 to R3.13, R9.1, R10.1, R10.3, R10.12).
 *
 * The WebSocket and session-state services are minimal fakes. The persistence and copy-store
 * services are the REAL ones (jsdom `sessionStorage`), so draft handling and the acknowledgement
 * phrase are exercised end to end. Fake timers drive the acknowledgement hold and exit deadline.
 */

const SESSION_ID = 'session-1';
const ROUND_ID = 'round-1';
const USER_ID = 'user-1';
const PHRASE = CALLOUT_COPY_CATALOG.farFromAverage[0];
const REJECTION_CODES = Object.keys(FAR_PROMPT_REJECTION_MESSAGES) as CalloutNoteRejection[];

interface FakeWs {
  send: ReturnType<typeof vi.fn>;
  on: <T>(event: string) => Observable<T>;
}

describe('FarFromAveragePromptComponent', () => {
  let fixture: ComponentFixture<FarFromAveragePromptComponent>;
  let persistence: CalloutPersistenceService;
  let ws: FakeWs;
  let added$: Subject<CalloutNoteAddedPayload>;
  let rejected$: Subject<CalloutNoteRejectedPayload>;
  let currentUser: WritableSignal<{ id: string } | null>;
  let dismissedSpy: ReturnType<typeof vi.fn<() => void>>;
  let removedSpy: ReturnType<typeof vi.fn<() => void>>;

  const model: FarPromptModel = { roundId: ROUND_ID, replayEntrance: true };

  function mount(
    options: { phrase?: string; modelOverride?: FarPromptModel; reducedMotion?: boolean } = {}
  ): void {
    fixture = TestBed.createComponent(FarFromAveragePromptComponent);
    fixture.componentRef.setInput('model', options.modelOverride ?? model);
    fixture.componentRef.setInput('phrase', options.phrase ?? PHRASE);
    fixture.componentRef.setInput('sessionId', SESSION_ID);
    fixture.componentRef.setInput('reducedMotion', options.reducedMotion ?? false);
    dismissedSpy = vi.fn<() => void>();
    removedSpy = vi.fn<() => void>();
    fixture.componentInstance.dismissed.subscribe(() => dismissedSpy());
    fixture.componentInstance.removed.subscribe(() => removedSpy());
    fixture.detectChanges();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const panel = (): HTMLElement | null => el().querySelector<HTMLElement>('.callout');
  const textarea = (): HTMLTextAreaElement =>
    el().querySelector<HTMLTextAreaElement>('textarea') as HTMLTextAreaElement;
  const submitBtn = (): HTMLButtonElement =>
    el().querySelector<HTMLButtonElement>('.callout__action--submit') as HTMLButtonElement;
  const dismissBtn = (): HTMLButtonElement =>
    el().querySelector<HTMLButtonElement>('.callout__action--dismiss') as HTMLButtonElement;
  const errorEl = (): HTMLElement | null => el().querySelector<HTMLElement>('.callout__error');
  const sends = (): unknown[][] => ws.send.mock.calls as unknown[][];

  function type(text: string): void {
    const input = textarea();
    input.value = text;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function clickSubmit(): void {
    submitBtn().click();
    fixture.detectChanges();
  }

  function advance(ms: number): void {
    vi.advanceTimersByTime(ms);
    fixture.detectChanges();
  }

  /** Lets the entrance settle so later assertions concern only the step under test. */
  function settleEntrance(): void {
    advance(1000);
  }

  function note(overrides: Partial<CalloutNote> = {}): CalloutNote {
    return {
      id: 'note-1',
      roundId: ROUND_ID,
      authorId: USER_ID,
      authorName: 'Alex',
      text: 'my reasoning',
      storedAt: '2026-05-01T10:00:00.000Z',
      ...overrides,
    };
  }

  function emitAdded(overrides: Partial<CalloutNote> = {}): void {
    const n = note(overrides);
    added$.next({ roundId: n.roundId, note: n });
    fixture.detectChanges();
  }

  function emitRejected(code: CalloutNoteRejection, roundId = ROUND_ID): void {
    rejected$.next({ roundId, code, message: 'server text' });
    fixture.detectChanges();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    added$ = new Subject<CalloutNoteAddedPayload>();
    rejected$ = new Subject<CalloutNoteRejectedPayload>();
    currentUser = signal<{ id: string } | null>({ id: USER_ID });
    ws = {
      send: vi.fn(),
      on: <T>(): Observable<T> => new Subject<T>().asObservable(),
    };
    TestBed.configureTestingModule({
      imports: [FarFromAveragePromptComponent],
      providers: [
        { provide: WebSocketService, useValue: ws },
        {
          provide: SessionStateService,
          useValue: {
            currentUser,
            calloutNoteAdded$: added$.asObservable(),
            calloutNoteRejected$: rejected$.asObservable(),
          },
        },
      ],
    });
    persistence = TestBed.inject(CalloutPersistenceService);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    sessionStorage.clear();
    document.body.querySelectorAll('[data-test-host]').forEach((n) => n.remove());
  });

  describe('appearance (R3.7, R9.1, R3.3)', () => {
    it('renders the phrase, an empty note field limited to 280 characters, and both controls', () => {
      mount();

      expect(el().querySelector('.callout__phrase')?.textContent?.trim()).toBe(PHRASE);
      expect(textarea().value).toBe('');
      expect(textarea().getAttribute('maxlength')).toBe(String(NOTE_MAX_LENGTH));
      expect(NOTE_MAX_LENGTH).toBe(280);
      expect(submitBtn().textContent?.trim()).toBe(FAR_PROMPT_COPY.submitLabel);
      expect(dismissBtn().textContent?.trim()).toBe(FAR_PROMPT_COPY.dismissLabel);
    });

    it('presents the field empty on each appearance, even when a draft exists for the round', () => {
      mount();
      type('half-written thought');
      expect(persistence.draft()?.text).toBe('half-written thought');
      fixture.destroy();

      mount();
      expect(textarea().value).toBe('');
      expect(fixture.componentInstance.draft()).toBe('');

      fixture.destroy();
      mount();
      expect(textarea().value).toBe('');
    });

    it('sends nothing on appearance', () => {
      mount();
      settleEntrance();

      expect(sends()).toHaveLength(0);
    });

    it('takes no focus when it appears and leaves the focused element untouched', () => {
      const host = document.createElement('div');
      host.setAttribute('data-test-host', '');
      const other = document.createElement('input');
      host.appendChild(other);
      document.body.appendChild(host);
      other.focus();
      other.value = 'hello';
      other.setSelectionRange(1, 3);
      const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');

      mount();
      settleEntrance();

      expect(focusSpy).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(other);
      expect(other.selectionStart).toBe(1);
      expect(other.selectionEnd).toBe(3);
      expect(el().contains(document.activeElement)).toBe(false);
      focusSpy.mockRestore();
    });
  });

  describe('no distance, card or average exposure (R3.6)', () => {
    it('shows nothing beyond the phrase, the field and two labelled controls', () => {
      mount({ modelOverride: { roundId: 'round-7-secret', replayEntrance: true } });

      const forbidden = /average|distance|\bcards?\b|rank|score|\d/i;
      const nodes: Element[] = [el(), ...Array.from(el().querySelectorAll('*'))];
      const visibleTextOutsidePhrase = nodes
        .filter((n) => !n.closest('.callout__phrase'))
        .flatMap((n) =>
          Array.from(n.childNodes)
            .filter((c) => c.nodeType === Node.TEXT_NODE)
            .map((c) => c.textContent ?? '')
        )
        .join(' ');
      const labels = nodes
        .map((n) => n.getAttribute('aria-label') ?? '')
        .filter((l) => l.length > 0)
        .join(' ');

      expect(visibleTextOutsidePhrase).not.toMatch(forbidden);
      expect(labels).not.toMatch(forbidden);
      expect(el().innerHTML).not.toContain('round-7-secret');
      expect(el().textContent).not.toContain(SESSION_ID);
    });

    it('renders every far-from-average catalog phrase as its only variable text', () => {
      for (const phrase of CALLOUT_COPY_CATALOG.farFromAverage) {
        mount({ phrase });
        expect(el().querySelector('.callout__phrase')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
          phrase
        );
        expect(el().querySelectorAll('.callout__phrase')).toHaveLength(1);
        fixture.destroy();
      }
    });

    it('marks decorative glyphs aria-hidden and keeps the words readable', () => {
      mount({ phrase: 'You saw this differently. Care to say more? 🙂' });

      const hidden = Array.from(el().querySelectorAll('.callout__phrase [aria-hidden="true"]'));
      expect(hidden.map((n) => n.textContent)).toEqual(['🙂']);
      const readable = Array.from(el().querySelectorAll('.callout__phrase span:not([aria-hidden])'))
        .map((n) => n.textContent)
        .join('');
      expect(readable.trim()).toBe('You saw this differently. Care to say more?');
    });
  });

  describe('submit control (R3.13, R10.2, R10.3)', () => {
    it('is disabled while the field is empty or whitespace only', () => {
      mount();
      expect(submitBtn().disabled).toBe(true);

      type('   \n\t  ');
      expect(submitBtn().disabled).toBe(true);
      clickSubmit();
      expect(sends()).toHaveLength(0);

      type('real words');
      expect(submitBtn().disabled).toBe(false);

      type('');
      expect(submitBtn().disabled).toBe(true);
    });

    it('disables immediately and sends exactly one trimmed note for the round and session', () => {
      mount();
      type('  because the API was missing \n');

      clickSubmit();

      expect(submitBtn().disabled).toBe(true);
      expect(sends()).toHaveLength(1);
      expect(sends()[0]).toEqual([
        CALLOUT_NOTE_SUBMIT,
        { sessionId: SESSION_ID, roundId: ROUND_ID, text: 'because the API was missing' },
      ]);

      // Further activations while pending produce nothing more.
      submitBtn().click();
      submitBtn().click();
      textarea().dispatchEvent(new Event('input'));
      fixture.detectChanges();
      expect(sends()).toHaveLength(1);
      expect(submitBtn().disabled).toBe(true);
    });

    it('caps typed or pasted text at 280 characters', () => {
      mount();
      type('x'.repeat(NOTE_MAX_LENGTH + 40));

      expect(fixture.componentInstance.draft()).toHaveLength(NOTE_MAX_LENGTH);
      expect(persistence.draft()?.text).toHaveLength(NOTE_MAX_LENGTH);

      clickSubmit();
      const payload = sends()[0][1] as { text: string };
      expect(payload.text).toHaveLength(NOTE_MAX_LENGTH);
    });
  });

  describe('acceptance (R3.11, R10.12)', () => {
    it('shows the acknowledgement, removes input and submit, then exits after the hold', () => {
      mount();
      settleEntrance();
      type('my reasoning');
      clickSubmit();
      expect(persistence.draft()?.text).toBe('my reasoning');

      emitAdded();

      expect(el().querySelector('textarea')).toBeNull();
      expect(el().querySelector('.callout__action--submit')).toBeNull();
      const ack = el().querySelector('.callout__phrase--ack');
      expect(ack).not.toBeNull();
      const ackText = ack?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      expect(CALLOUT_COPY_CATALOG.acknowledgement).toContain(ackText);
      expect(el().querySelector('.callout__sr')?.textContent?.trim()).not.toBe('');
      expect(persistence.draft()).toBeNull();

      // Still readable through the hold; nothing reported yet.
      advance(ACKNOWLEDGEMENT_HOLD_MS - 1);
      expect(panel()).not.toBeNull();
      expect(panel()?.classList.contains('callout--exiting')).toBe(false);
      expect(dismissedSpy).not.toHaveBeenCalled();
      expect(removedSpy).not.toHaveBeenCalled();

      advance(1);
      expect(dismissedSpy).toHaveBeenCalledTimes(1);
      expect(panel()?.classList.contains('callout--exiting')).toBe(true);
      expect(removedSpy).not.toHaveBeenCalled();

      advance(EXIT_REMOVAL_DEADLINE_MS);
      expect(removedSpy).toHaveBeenCalledTimes(1);
      expect(panel()).toBeNull();
      expect(sends()).toHaveLength(1);
    });

    it('ignores an acknowledgement for another round or author, or with nothing in flight', () => {
      mount();
      type('my reasoning');

      emitAdded(); // nothing in flight yet
      expect(el().querySelector('textarea')).not.toBeNull();

      clickSubmit();
      emitAdded({ roundId: 'some-other-round' });
      emitAdded({ authorId: 'someone-else' });
      expect(el().querySelector('textarea')).not.toBeNull();
      expect(el().querySelector('.callout__phrase--ack')).toBeNull();

      emitAdded();
      expect(el().querySelector('.callout__phrase--ack')).not.toBeNull();
    });
  });

  describe('rejection (R3.12, R10.6 to R10.8)', () => {
    it.each(REJECTION_CODES)(
      'keeps the prompt and the text, shows the error and re-enables submit for %s',
      (code) => {
        mount();
        settleEntrance();
        type('keep this text');
        clickSubmit();
        expect(submitBtn().disabled).toBe(true);

        emitRejected(code);

        expect(panel()).not.toBeNull();
        expect(textarea().value).toBe('keep this text');
        expect(fixture.componentInstance.draft()).toBe('keep this text');
        expect(persistence.draft()?.text).toBe('keep this text');
        expect(submitBtn().disabled).toBe(false);
        expect(errorEl()?.textContent?.trim()).toBe(FAR_PROMPT_REJECTION_MESSAGES[code]);
        expect(errorEl()?.getAttribute('role')).toBe('alert');
        expect(errorEl()?.textContent).toContain('not saved');
        expect(dismissedSpy).not.toHaveBeenCalled();
        expect(removedSpy).not.toHaveBeenCalled();
      }
    );

    it('falls back to a generic "not saved" message for an unknown code', () => {
      mount();
      type('text');
      clickSubmit();

      emitRejected('NOTE_FROM_THE_FUTURE' as unknown as CalloutNoteRejection);

      expect(errorEl()?.textContent?.trim()).toBe(FAR_PROMPT_COPY.errorFallback);
      expect(errorEl()?.textContent).toContain('not saved');
    });

    it('allows a retry that clears the error, sends again, and then succeeds', () => {
      mount();
      type('retry me');
      clickSubmit();
      emitRejected('NOTE_ROUND_UNKNOWN');

      clickSubmit();
      expect(errorEl()).toBeNull();
      expect(sends()).toHaveLength(2);
      expect(sends()[1]).toEqual(sends()[0]);

      emitAdded({ text: 'retry me' });
      expect(el().querySelector('.callout__phrase--ack')).not.toBeNull();
    });

    it('ignores a rejection for a different round or with nothing in flight', () => {
      mount();
      type('text');

      emitRejected('NOTE_INVALID'); // nothing in flight
      expect(errorEl()).toBeNull();

      clickSubmit();
      emitRejected('NOTE_INVALID', 'some-other-round');
      expect(errorEl()).toBeNull();
      expect(submitBtn().disabled).toBe(true);
    });
  });

  describe('dismiss (R3.8, R3.9)', () => {
    it('discards unsent text, sends nothing, reports the dismissal once and removes the panel', () => {
      mount();
      settleEntrance();
      type('words I will not share');
      expect(persistence.draft()?.text).toBe('words I will not share');

      dismissBtn().click();
      fixture.detectChanges();

      expect(persistence.draft()).toBeNull();
      expect(sessionStorage.getItem('scrum-poker-callout-draft')).toBeNull();
      expect(sends()).toHaveLength(0);
      expect(dismissedSpy).toHaveBeenCalledTimes(1);
      expect(panel()?.classList.contains('callout--exiting')).toBe(true);

      advance(EXIT_REMOVAL_DEADLINE_MS);
      expect(removedSpy).toHaveBeenCalledTimes(1);
      expect(panel()).toBeNull();
      expect(sends()).toHaveLength(0);
    });

    it('treats Escape exactly like the dismiss control', () => {
      mount();
      settleEntrance();
      type('private words');

      panel()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      fixture.detectChanges();

      expect(persistence.draft()).toBeNull();
      expect(sends()).toHaveLength(0);
      expect(dismissedSpy).toHaveBeenCalledTimes(1);
      expect(panel()?.classList.contains('callout--exiting')).toBe(true);
    });

    it('leaves a draft that belongs to another round alone', () => {
      persistence.dispatchDraft({
        kind: 'typed',
        sessionId: SESSION_ID,
        roundId: 'older-round',
        text: 'kept for its own round',
      });
      mount();

      dismissBtn().click();

      expect(persistence.draft()?.text).toBe('kept for its own round');
      expect(sends()).toHaveLength(0);
    });

    it('removes exactly once when the animation end and the deadline both arrive', () => {
      mount();
      settleEntrance();
      dismissBtn().click();
      fixture.detectChanges();

      const ended = Object.assign(new Event('animationend'), { animationName: 'callout-pop-out' });
      panel()?.dispatchEvent(ended);
      fixture.detectChanges();
      expect(removedSpy).toHaveBeenCalledTimes(1);
      expect(panel()).toBeNull();

      advance(EXIT_REMOVAL_DEADLINE_MS * 2);
      expect(removedSpy).toHaveBeenCalledTimes(1);
      expect(dismissedSpy).toHaveBeenCalledTimes(1);
    });

    it('moves focus to the main board region when focus was inside the removed panel', () => {
      const main = document.createElement('main');
      main.id = 'main-content';
      main.setAttribute('data-test-host', '');
      document.body.appendChild(main);

      mount();
      settleEntrance();
      textarea().focus();
      expect(el().contains(document.activeElement)).toBe(true);

      dismissBtn().click();
      fixture.detectChanges();
      advance(EXIT_REMOVAL_DEADLINE_MS);

      expect(document.activeElement).toBe(main);
    });

    it('leaves focus alone when it was outside the panel at removal', () => {
      const host = document.createElement('div');
      host.setAttribute('data-test-host', '');
      const other = document.createElement('input');
      host.appendChild(other);
      document.body.appendChild(host);

      mount();
      settleEntrance();
      other.focus();

      dismissBtn().click();
      fixture.detectChanges();
      advance(EXIT_REMOVAL_DEADLINE_MS);

      expect(document.activeElement).toBe(other);
    });
  });

  describe('dismiss label and control parity (R3.8)', () => {
    it('states declining as complete, with none of the forbidden words', () => {
      mount();

      const forbidden = /\b(cancel|skip|ignore|later)\b/i;
      expect(dismissBtn().textContent?.trim()).toBe('No thanks, all good');
      expect(dismissBtn().textContent).not.toMatch(forbidden);
      expect(dismissBtn().getAttribute('aria-label')).not.toMatch(forbidden);
      expect(FAR_PROMPT_COPY.dismissLabel).not.toMatch(forbidden);
      expect(FAR_PROMPT_COPY.dismissAriaLabel).not.toMatch(forbidden);
    });

    it('gives the dismiss and submit controls distinct, non-empty accessible names', () => {
      mount();

      const submitName = submitBtn().getAttribute('aria-label') ?? '';
      const dismissName = dismissBtn().getAttribute('aria-label') ?? '';
      expect(submitName.length).toBeGreaterThan(0);
      expect(dismissName.length).toBeGreaterThan(0);
      expect(submitName).not.toBe(dismissName);
    });

    it('renders both controls from one class with the same text size and target size', () => {
      mount();

      expect(submitBtn().classList.contains('callout__action')).toBe(true);
      expect(dismissBtn().classList.contains('callout__action')).toBe(true);

      const submitStyle = getComputedStyle(submitBtn());
      const dismissStyle = getComputedStyle(dismissBtn());
      expect(submitStyle.fontSize).not.toBe('');
      expect(dismissStyle.fontSize).toBe(submitStyle.fontSize);
      expect(dismissStyle.minWidth).toBe(submitStyle.minWidth);
      expect(dismissStyle.minHeight).toBe(submitStyle.minHeight);
      expect(dismissStyle.paddingTop).toBe(submitStyle.paddingTop);
      expect(dismissStyle.paddingLeft).toBe(submitStyle.paddingLeft);
      expect(dismissStyle.lineHeight).toBe(submitStyle.lineHeight);
    });

    it('lets only colour, never size, differ between the two control modifiers', () => {
      const def = (
        FarFromAveragePromptComponent as unknown as { ɵcmp: { styles: readonly string[] } }
      ).ɵcmp;
      const css = def.styles.join('\n');
      const rule = (selector: string): string =>
        // Tolerates the emulated-encapsulation attribute Angular appends to each selector.
        new RegExp(`${selector.replace(/[.]/g, '\\.')}(?:\\[[^\\]]*\\])*\\s*\\{([^}]*)\\}`).exec(
          css
        )?.[1] ?? '';

      const shared = rule('.callout__action');
      expect(shared).toMatch(/font-size:/);
      expect(shared).toMatch(/min-width:\s*44px/);
      expect(shared).toMatch(/min-height:\s*44px/);

      const sizing = /(font|width|height|padding|margin|line-height|border-width)/;
      expect(rule('.callout__action--submit')).not.toMatch(sizing);
      expect(css).not.toMatch(/\.callout__action--dismiss(?:\[[^\]]*\])*\s*\{/);
    });
  });

  describe('no automatic timeout (R3.10)', () => {
    it('stays visible, silent and unsent far beyond any plausible auto-dismiss', () => {
      mount();
      type('still thinking');

      advance(10 * 60 * 1000);

      expect(panel()).not.toBeNull();
      expect(panel()?.classList.contains('callout--exiting')).toBe(false);
      expect(textarea().value).toBe('still thinking');
      expect(dismissedSpy).not.toHaveBeenCalled();
      expect(removedSpy).not.toHaveBeenCalled();
      expect(sends()).toHaveLength(0);
    });

    it('stays visible in Reduced_Motion_Mode as well', () => {
      mount({ reducedMotion: true });

      advance(60 * 60 * 1000);

      expect(panel()).not.toBeNull();
      expect(removedSpy).not.toHaveBeenCalled();
    });
  });

  describe('host-driven exit and teardown', () => {
    it('plays the exit and removes once when the host sets an exit cause', () => {
      mount();
      settleEntrance();

      fixture.componentRef.setInput('exitCause', 'round-started');
      fixture.detectChanges();
      expect(panel()?.classList.contains('callout--exiting')).toBe(true);

      advance(EXIT_REMOVAL_DEADLINE_MS);
      expect(removedSpy).toHaveBeenCalledTimes(1);
      expect(panel()).toBeNull();
      expect(dismissedSpy).not.toHaveBeenCalled();
      expect(sends()).toHaveLength(0);
    });

    it('leaves no pending timers and ignores server events after destroy', () => {
      mount();
      type('text');
      clickSubmit();
      fixture.destroy();

      added$.next({ roundId: ROUND_ID, note: note() });
      advance(ACKNOWLEDGEMENT_HOLD_MS * 2);

      expect(vi.getTimerCount()).toBe(0);
      expect(dismissedSpy).not.toHaveBeenCalled();
      expect(persistence.draft()?.text).toBe('text');
    });
  });
});
