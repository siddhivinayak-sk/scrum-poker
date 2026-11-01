import { beforeEach, describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular';
import { Subject } from 'rxjs';
import { CHAT_MESSAGE_MAX_LENGTH, ChatMessageSendPayload, ConnectionState, User } from '@shared/types';
import { CHAT_TIMERS, ChatStore, ChatTimers } from '../../services/chat-store.service';
import { CHAT_READ_MARKER_STORE, ReadMarkerStore } from '../../services/chat-read-marker';
import { CHAT_TRANSPORT, ChatTransport } from '../../services/chat-transport';
import { ChatComposerComponent, chatRateLimitText } from './chat-composer.component';

/** Manual clock: timers fire only through `advance`. */
class ManualTimers implements ChatTimers {
  time = 1_000_000;
  private nextHandle = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }
  setTimeout(callback: () => void, ms: number): number {
    const handle = this.nextHandle++;
    this.pending.set(handle, { at: this.time + ms, callback });
    return handle;
  }
  clearTimeout(handle: number): void {
    this.pending.delete(handle);
  }
  advance(ms: number): void {
    this.time += ms;
    for (const [handle, timer] of [...this.pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= this.time && this.pending.delete(handle)) timer.callback();
    }
  }
}

class FakeTransport implements ChatTransport {
  readonly boardKind = 'poker' as const;
  readonly connectionState = signal<ConnectionState>('connected');
  readonly connectionGeneration = signal(1);
  readonly participants = signal<readonly User[]>([]);
  readonly currentUserId = signal<string | null>('me');
  readonly added$ = new Subject<unknown>();
  readonly history$ = new Subject<unknown>();
  readonly rejected$ = new Subject<unknown>();
  readonly sent: ChatMessageSendPayload[] = [];
  send(payload: ChatMessageSendPayload): boolean {
    this.sent.push(payload);
    return true;
  }
}

const COUNTER_ID = 'chat-composer-counter-poker';
const RATE_LIMIT_ID = 'chat-composer-rate-limit-poker';

interface Harness {
  readonly transport: FakeTransport;
  readonly timers: ManualTimers;
  readonly store: ChatStore;
  readonly textArea: HTMLTextAreaElement;
  readonly button: HTMLButtonElement;
  /** Runs effects and change detection after a signal or DOM change. */
  readonly flush: () => void;
}

async function setup(): Promise<Harness> {
  const transport = new FakeTransport();
  const timers = new ManualTimers();
  const storage = new Map<string, string>();
  const { fixture } = await render(ChatComposerComponent, {
    providers: [
      ChatStore,
      { provide: CHAT_TRANSPORT, useValue: transport },
      { provide: CHAT_TIMERS, useValue: timers },
      {
        provide: CHAT_READ_MARKER_STORE,
        useValue: new ReadMarkerStore(() => ({
          getItem: (k: string) => storage.get(k) ?? null,
          setItem: (k: string, v: string) => void storage.set(k, v),
        })),
      },
    ],
  });
  const store = TestBed.inject(ChatStore);
  store.reset('s1');
  const flush = (): void => {
    TestBed.tick();
    fixture.detectChanges();
  };
  flush();
  return {
    transport,
    timers,
    store,
    textArea: screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement,
    button: screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement,
    flush,
  };
}

/** Types `value` into the text area the way the browser reports it: value change, then `input`. */
function type(h: Harness, value: string): void {
  h.textArea.value = value;
  h.textArea.setSelectionRange(value.length, value.length);
  h.textArea.dispatchEvent(new Event('input', { bubbles: true }));
  h.flush();
}

interface EnterOptions {
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

/** Dispatches a cancelable Enter keydown on the text area and returns it for `defaultPrevented`. */
function pressEnter(h: Harness, options: EnterOptions = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
    shiftKey: options.shiftKey ?? false,
    isComposing: options.isComposing ?? false,
  });
  const keyCode = options.keyCode ?? 13;
  // `keyCode` is legacy and not settable through every DOM implementation's init dictionary.
  Object.defineProperty(event, 'keyCode', { configurable: true, get: () => keyCode });
  h.textArea.dispatchEvent(event);
  h.flush();
  return event;
}

/** Ids named by the text area's `aria-describedby`, empty when the attribute is absent. */
function describedByIds(h: Harness): string[] {
  const value = h.textArea.getAttribute('aria-describedby');
  return value === null ? [] : value.split(/\s+/).filter((id) => id.length > 0);
}

describe('ChatComposerComponent', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await setup();
  });

  describe('accessible names (R11.10)', () => {
    it('labels the text area "Message" and names the send button "Send message"', () => {
      expect(h.textArea.tagName).toBe('TEXTAREA');
      expect(h.button.tagName).toBe('BUTTON');
      expect(h.button.getAttribute('type')).toBe('button');
    });
  });

  describe('Enter and Shift+Enter (R7.2, R7.3, R7.4)', () => {
    it('sends the Normalised_Text exactly once on Enter, clears the Draft and keeps focus', () => {
      h.textArea.focus();
      type(h, '  hello\n ');
      const event = pressEnter(h);

      expect(event.defaultPrevented).toBe(true);
      expect(h.transport.sent).toHaveLength(1);
      expect(h.transport.sent[0].text).toBe('hello');
      expect(h.transport.sent[0].sessionId).toBe('s1');
      expect(h.store.draft()).toBe('');
      expect(h.textArea.value).toBe('');
      expect(document.activeElement).toBe(h.textArea);
    });

    it('moves focus to the text area when the send button sends', () => {
      type(h, 'hello');
      h.button.focus();
      h.button.click();
      h.flush();

      expect(h.transport.sent).toHaveLength(1);
      expect(h.store.draft()).toBe('');
      expect(document.activeElement).toBe(h.textArea);
    });

    it('does not send on Shift+Enter and leaves the native line break alone', () => {
      type(h, 'hello');
      const event = pressEnter(h, { shiftKey: true });

      expect(event.defaultPrevented).toBe(false);
      expect(h.transport.sent).toHaveLength(0);
      expect(h.store.draft()).toBe('hello');
    });

    it('sends nothing and keeps the default for Enter with isComposing', () => {
      type(h, 'hello');
      const event = pressEnter(h, { isComposing: true });

      expect(event.defaultPrevented).toBe(false);
      expect(h.transport.sent).toHaveLength(0);
      expect(h.store.draft()).toBe('hello');
    });

    it('sends nothing and keeps the default for Enter with keyCode 229', () => {
      type(h, 'hello');
      const event = pressEnter(h, { keyCode: 229 });

      expect(event.defaultPrevented).toBe(false);
      expect(h.transport.sent).toHaveLength(0);
      expect(h.store.draft()).toBe('hello');
    });

    it('treats Enter as a no-op without a line break while the Draft is not sendable (R7.7)', () => {
      type(h, '   ');
      const event = pressEnter(h);

      expect(event.defaultPrevented).toBe(true);
      expect(h.transport.sent).toHaveLength(0);
      expect(h.store.draft()).toBe('   ');
    });
  });

  describe('send button (R7.7)', () => {
    it('is disabled while the Draft is empty', () => {
      expect(h.store.draft()).toBe('');
      expect(h.button.disabled).toBe(true);
    });

    it('is disabled while the Draft is whitespace only', () => {
      type(h, ' \n\t ');
      expect(h.button.disabled).toBe(true);
    });

    it('is enabled while the Draft is sendable', () => {
      type(h, 'hi');
      expect(h.button.disabled).toBe(false);
    });

    it('is disabled while Connection_State is not connected, and re-enabled on reconnect', () => {
      type(h, 'hi');
      for (const state of ['reconnecting', 'disconnected'] as const) {
        h.transport.connectionState.set(state);
        h.flush();
        expect(h.button.disabled).toBe(true);
      }
      h.transport.connectionState.set('connected');
      h.flush();
      expect(h.button.disabled).toBe(false);
      expect(h.store.draft()).toBe('hi');
    });
  });

  describe('length limit (R7.8, R7.12)', () => {
    it('carries maxlength="500"', () => {
      expect(CHAT_MESSAGE_MAX_LENGTH).toBe(500);
      expect(h.textArea.getAttribute('maxlength')).toBe('500');
    });

    it('inserts only the part of an overflowing paste that fits', () => {
      type(h, 'a'.repeat(490));
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', {
        value: { getData: (format: string) => (format === 'text/plain' ? 'b'.repeat(20) : '') },
      });
      h.textArea.dispatchEvent(paste);
      h.flush();

      expect(paste.defaultPrevented).toBe(true);
      expect(h.store.draft()).toBe('a'.repeat(490) + 'b'.repeat(10));
      expect(h.textArea.value).toHaveLength(500);
      expect(h.store.caret()).toBe(500);
    });

    it('keeps the native paste when the pasted text fits', () => {
      type(h, 'abc');
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'def' } });
      h.textArea.dispatchEvent(paste);

      expect(paste.defaultPrevented).toBe(false);
    });
  });

  describe('offline editing (R9.2)', () => {
    it('keeps the text area editable and updates the Draft while offline, sending nothing', () => {
      h.transport.connectionState.set('reconnecting');
      h.flush();

      expect(h.textArea.disabled).toBe(false);
      expect(h.textArea.readOnly).toBe(false);
      type(h, 'typed offline');
      expect(h.store.draft()).toBe('typed offline');

      const enter = pressEnter(h);
      const shiftEnter = pressEnter(h, { shiftKey: true });
      expect(enter.defaultPrevented).toBe(true);
      expect(shiftEnter.defaultPrevented).toBe(false);
      expect(h.transport.sent).toHaveLength(0);
      expect(h.store.draft()).toBe('typed offline');
    });
  });

  describe('counter, rate-limit text and aria-describedby (R7.9, R8.9, R11.10)', () => {
    it('references only the shown counter and rate-limit text', () => {
      // Neither shown: no attribute.
      type(h, 'a'.repeat(399));
      expect(h.textArea.hasAttribute('aria-describedby')).toBe(false);
      expect(document.getElementById(COUNTER_ID)).toBeNull();

      // Counter only.
      type(h, 'a'.repeat(400));
      expect(describedByIds(h)).toEqual([COUNTER_ID]);
      expect(document.getElementById(COUNTER_ID)?.textContent?.trim()).toBe('400/500');

      // Counter and rate-limit text.
      h.transport.rejected$.next({
        clientMessageId: '00000000-0000-4000-8000-000000000000',
        code: 'CHAT_RATE_LIMITED',
        message: 'Too fast.',
        retryAfterMs: 1500,
      });
      h.flush();
      expect(describedByIds(h)).toEqual([RATE_LIMIT_ID, COUNTER_ID]);
      expect(document.getElementById(RATE_LIMIT_ID)?.textContent?.trim()).toBe(chatRateLimitText(2));

      // N updates as time passes, then the text disappears with its reference.
      h.timers.advance(500);
      h.flush();
      expect(document.getElementById(RATE_LIMIT_ID)?.textContent?.trim()).toBe(chatRateLimitText(1));
      h.timers.advance(1000);
      h.flush();
      expect(document.getElementById(RATE_LIMIT_ID)).toBeNull();
      expect(describedByIds(h)).toEqual([COUNTER_ID]);

      // Back below 400: nothing shown, nothing referenced.
      type(h, 'short');
      expect(h.textArea.hasAttribute('aria-describedby')).toBe(false);
      expect(document.getElementById(COUNTER_ID)).toBeNull();

      for (const id of describedByIds(h)) expect(document.getElementById(id)).not.toBeNull();
    });

    it('references the rate-limit text alone while the counter is hidden', () => {
      type(h, 'hi');
      h.transport.rejected$.next({
        clientMessageId: '00000000-0000-4000-8000-000000000000',
        code: 'CHAT_RATE_LIMITED',
        message: 'Too fast.',
        retryAfterMs: 3000,
      });
      h.flush();

      expect(describedByIds(h)).toEqual([RATE_LIMIT_ID]);
      expect(document.getElementById(RATE_LIMIT_ID)?.textContent?.trim()).toBe(
        "You're sending messages too fast. Try again in 3 s.",
      );
      expect(document.getElementById(COUNTER_ID)).toBeNull();
    });
  });
});
