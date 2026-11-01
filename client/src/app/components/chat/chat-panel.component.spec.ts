import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { render, screen, within } from '@testing-library/angular';
import { Subject } from 'rxjs';
import { ChatMessage, ChatMessageSendPayload, ConnectionState, User } from '@shared/types';
import { CHAT_TIMERS, ChatStore, ChatTimers } from '../../services/chat-store.service';
import { CHAT_READ_MARKER_STORE, ReadMarkerStore } from '../../services/chat-read-marker';
import { CHAT_TRANSPORT, ChatTransport } from '../../services/chat-transport';
import {
  CHAT_NARROW_QUERY,
  CHAT_OFFLINE_TEXT,
  ChatPanelComponent,
  chatPanelId,
} from './chat-panel.component';
import { presenceListId } from './chat-presence-list.component';

/**
 * Example tests of the Chat_Panel shell and the Panel_Header (task 12.12): the Panel_State
 * transitions of R3.4–R3.7 (R22.3), focus targets (R3.12, R11.6), the dialog role and control
 * names (R11.3), `aria-modal` and the narrow focus trap with the page-dialog exception (R11.4,
 * R11.5, R12.10), the status region (R11.18), Draft / caret / scroll restore (R3.8) and the
 * Presence_List toggle (R10.2, R10.7). The store runs for real over a fake transport and a manual
 * clock; a small host recreates the panel exactly like `ChatHostComponent` does (only while
 * `panelState !== 'closed'`, R3.3). Focus return to the launcher (R11.7) and the scroll lock
 * (R4.10) belong to the host and are not tested here.
 */

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

/** Creates the panel only while `panelState !== 'closed'`, as `ChatHostComponent` does (R3.3). */
@Component({
  selector: 'app-test-panel-host',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChatPanelComponent],
  template: `
    @if (store.panelState() !== 'closed') {
      <app-chat-panel />
    }
  `,
})
class PanelHostComponent {
  protected readonly store = inject(ChatStore);
}

function message(seq: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `10000000-0000-4000-8000-${seq.toString().padStart(12, '0')}`,
    seq,
    clientMessageId: `20000000-0000-4000-8000-${seq.toString().padStart(12, '0')}`,
    authorId: 'other',
    authorName: 'Other Person',
    text: `text ${seq}`,
    sentAt: new Date(1_000_000 + seq).toISOString(),
    ...overrides,
  };
}

function range(from: number, to: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let seq = from; seq <= to; seq++) messages.push(message(seq));
  return messages;
}

// --- matchMedia stub -----------------------------------------------------------------------

interface MediaStub {
  setNarrow(matches: boolean): void;
}

const windows = (): Window[] => {
  const view = document.defaultView;
  return view !== null && view !== window ? [window, view] : [window];
};

/** `CHAT_NARROW_QUERY` follows `setNarrow`; every other query (reduced motion) does not match. */
function installMatchMedia(narrow: boolean): MediaStub {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const state = { matches: narrow };
  const list = (media: string) => ({
    get matches(): boolean {
      return media === CHAT_NARROW_QUERY ? state.matches : false;
    },
    media,
    addEventListener: (type: string, listener: (event: MediaQueryListEvent) => void): void => {
      if (type === 'change' && media === CHAT_NARROW_QUERY) listeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: MediaQueryListEvent) => void): void => {
      if (type === 'change') listeners.delete(listener);
    },
  });
  for (const win of windows()) {
    Object.defineProperty(win, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (media: string) => list(media),
    });
  }
  return {
    setNarrow(matches: boolean): void {
      state.matches = matches;
      const event = Object.assign(new Event('change'), { matches }) as MediaQueryListEvent;
      for (const listener of [...listeners]) listener(event);
    },
  };
}

// --- Message_List geometry stub ------------------------------------------------------------

const ROW_H = 50;
const VIEW_H = 200;

function isLog(el: Element): boolean {
  return el.getAttribute('role') === 'log';
}

function rowCount(log: Element): number {
  return Array.from(log.children).filter(
    (child) => child instanceof HTMLElement && child.dataset['key'] !== undefined,
  ).length;
}

/**
 * Gives every `role="log"` element, including one created after a reopen, a layout: each row is
 * 50 px high and the viewport is 200 px. `scrollTop` is the DOM's stored value.
 */
function installLogGeometry(): () => void {
  const names = ['scrollHeight', 'clientHeight'] as const;
  const own = names.map((name) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
  for (const name of names) {
    const base = Object.getOwnPropertyDescriptor(Element.prototype, name)?.get;
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement): number {
        if (isLog(this)) return name === 'scrollHeight' ? rowCount(this) * ROW_H : VIEW_H;
        return base === undefined ? 0 : Number(base.call(this));
      },
    });
  }
  return () => {
    names.forEach((name, i) => {
      const original = own[i];
      if (original === undefined) Reflect.deleteProperty(HTMLElement.prototype, name);
      else Object.defineProperty(HTMLElement.prototype, name, original);
    });
  };
}

// --- Harness -------------------------------------------------------------------------------

interface Harness {
  readonly transport: FakeTransport;
  readonly timers: ManualTimers;
  readonly store: ChatStore;
  readonly fixture: ComponentFixture<PanelHostComponent>;
  /** Runs effects, change detection and after-render hooks. */
  readonly flush: () => void;
}

async function setup(): Promise<Harness> {
  const transport = new FakeTransport();
  const timers = new ManualTimers();
  const storage = new Map<string, string>();
  const { fixture } = await render(PanelHostComponent, {
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
  return { transport, timers, store, fixture, flush };
}

function setState(h: Harness, state: 'open' | 'minimized' | 'closed'): void {
  h.store.panelState.set(state);
  h.flush();
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Session chat' });
}

function button(name: string): HTMLButtonElement {
  return within(dialog()).getByRole('button', { name }) as HTMLButtonElement;
}

function textArea(): HTMLTextAreaElement {
  return within(dialog()).getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
}

function messageLog(): HTMLElement {
  const log = dialog().querySelector<HTMLElement>('[role="log"]');
  if (log === null) throw new Error('Message_List not rendered');
  return log;
}

function click(h: Harness, el: HTMLElement): void {
  el.click();
  h.flush();
}

/** Types `value` and leaves the caret at its end, as the browser reports it. */
function type(h: Harness, value: string): void {
  const el = textArea();
  el.value = value;
  el.setSelectionRange(value.length, value.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  h.flush();
}

interface KeyOptions {
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

/** Dispatches a cancelable, bubbling keydown on `target` and returns it for `defaultPrevented`. */
function keydown(h: Harness, target: Element, key: string, options: KeyOptions = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    shiftKey: options.shiftKey ?? false,
    isComposing: options.isComposing ?? false,
  });
  const keyCode = options.keyCode ?? (key === 'Escape' ? 27 : key === 'Tab' ? 9 : 0);
  Object.defineProperty(event, 'keyCode', { configurable: true, get: () => keyCode });
  target.dispatchEvent(event);
  h.flush();
  return event;
}

/** Adds an element to the Board_Page outside the panel; removed in `afterEach`. */
const outside: HTMLElement[] = [];
function addOutside(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  outside.push(host);
  return host;
}

let media: MediaStub;
let originalMatchMedia: PropertyDescriptor | undefined;

beforeEach(() => {
  originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  media = installMatchMedia(false);
});

afterEach(() => {
  for (const el of outside.splice(0)) el.remove();
  for (const win of windows()) {
    if (originalMatchMedia) Object.defineProperty(win, 'matchMedia', originalMatchMedia);
    else Reflect.deleteProperty(win, 'matchMedia');
  }
});

// --- Tests ---------------------------------------------------------------------------------

describe('ChatPanelComponent: Panel_State transitions (R3.4–R3.7, R22.3)', () => {
  for (const connection of ['connected', 'reconnecting', 'disconnected'] as const) {
    it(`minimizes, restores and closes from the header while ${connection}`, async () => {
      const h = await setup();
      h.transport.connectionState.set(connection);
      setState(h, 'open');

      click(h, button('Minimize chat'));
      expect(h.store.panelState()).toBe('minimized');

      click(h, button('Restore chat'));
      expect(h.store.panelState()).toBe('open');

      click(h, button('Close chat'));
      expect(h.store.panelState()).toBe('closed');
      expect(screen.queryByRole('dialog')).toBeNull();

      setState(h, 'minimized');
      click(h, button('Close chat'));
      expect(h.store.panelState()).toBe('closed');
    });
  }

  it('closes on Escape from inside the panel and keeps the Draft (R3.7)', async () => {
    const h = await setup();
    setState(h, 'open');
    type(h, 'keep me');

    const event = keydown(h, textArea(), 'Escape');
    expect(event.defaultPrevented).toBe(true);
    expect(h.store.panelState()).toBe('closed');
    expect(h.store.draft()).toBe('keep me');
  });

  it('closes on Escape while minimized (R3.7)', async () => {
    const h = await setup();
    setState(h, 'open');
    setState(h, 'minimized');

    keydown(h, button('Restore chat'), 'Escape');
    expect(h.store.panelState()).toBe('closed');
  });

  it('ignores Escape during an input-method composition (isComposing, keyCode 229)', async () => {
    const h = await setup();
    setState(h, 'open');
    type(h, 'にほん');

    const composing = keydown(h, textArea(), 'Escape', { isComposing: true });
    expect(composing.defaultPrevented).toBe(false);
    expect(h.store.panelState()).toBe('open');

    const safari = keydown(h, textArea(), 'Escape', { keyCode: 229 });
    expect(safari.defaultPrevented).toBe(false);
    expect(h.store.panelState()).toBe('open');
    expect(h.store.draft()).toBe('にほん');
  });

  it('ignores Escape while focus is outside the panel', async () => {
    const h = await setup();
    setState(h, 'open');
    const other = addOutside('<button type="button">Vote</button>').querySelector('button');
    if (other === null) throw new Error('outside button missing');
    other.focus();

    keydown(h, other, 'Escape');
    expect(h.store.panelState()).toBe('open');
  });
});

describe('ChatPanelComponent: focus targets (R3.12, R11.6, R11.16)', () => {
  it('focuses the Composer text area on closed → open', async () => {
    const h = await setup();
    setState(h, 'open');
    expect(document.activeElement).toBe(textArea());
  });

  it('focuses Restore on open → minimized and the Composer on minimized → open', async () => {
    const h = await setup();
    setState(h, 'open');

    click(h, button('Minimize chat'));
    expect(document.activeElement).toBe(button('Restore chat'));

    click(h, button('Restore chat'));
    expect(document.activeElement).toBe(textArea());
  });
});

describe('ChatPanelComponent: dialog role and names (R11.3)', () => {
  it('is a dialog named "Session chat" with the launcher target id', async () => {
    const h = await setup();
    setState(h, 'open');
    expect(dialog().id).toBe(chatPanelId('poker'));
    expect(dialog().tagName).toBe('SECTION');
  });

  it('names the open header controls and hides Restore', async () => {
    const h = await setup();
    setState(h, 'open');
    for (const name of ['Show participants', 'Minimize chat', 'Close chat']) {
      expect(button(name).tagName).toBe('BUTTON');
    }
    expect(within(dialog()).queryByRole('button', { name: 'Restore chat' })).toBeNull();
  });

  it('shows only Restore and Close while minimized, Restore described by the Unread_Count', async () => {
    const h = await setup();
    h.transport.history$.next({ messages: [] });
    setState(h, 'open');
    setState(h, 'minimized');

    const view = within(dialog());
    expect(view.queryByRole('button', { name: 'Minimize chat' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Show participants' })).toBeNull();
    expect(button('Close chat')).toBeTruthy();
    expect(button('Restore chat').hasAttribute('aria-describedby')).toBe(false);

    h.transport.added$.next({ message: message(1) });
    h.flush();
    const restore = button('Restore chat');
    const describedBy = restore.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? '')?.textContent?.trim()).toBe('1 unread message');
    expect(restore.contains(button('Close chat'))).toBe(false);

    h.transport.added$.next({ message: message(2) });
    h.flush();
    expect(document.getElementById(describedBy ?? '')?.textContent?.trim()).toBe(
      '2 unread messages',
    );
    // The name stays fixed whatever the Unread_Count.
    expect(button('Restore chat')).toBe(restore);
  });
});

describe('ChatPanelComponent: aria-modal and focus containment (R11.4, R11.5, R12.10)', () => {
  it('is non-modal on a Wide_Viewport and leaves Tab and outside focus alone', async () => {
    const h = await setup();
    setState(h, 'open');
    expect(dialog().getAttribute('aria-modal')).toBe('false');

    type(h, 'hello');
    const send = button('Send message');
    send.focus();
    expect(keydown(h, send, 'Tab').defaultPrevented).toBe(false);

    const other = addOutside('<button type="button">Vote</button>').querySelector('button');
    other?.focus();
    expect(document.activeElement).toBe(other);
  });

  it('is modal only while open on a Narrow_Viewport and follows breakpoint changes', async () => {
    media.setNarrow(true);
    const h = await setup();
    setState(h, 'open');
    expect(dialog().getAttribute('aria-modal')).toBe('true');

    setState(h, 'minimized');
    expect(dialog().getAttribute('aria-modal')).toBe('false');

    setState(h, 'open');
    const panel = dialog();
    expect(panel.getAttribute('aria-modal')).toBe('true');

    // The panel stays mounted across the switch.
    media.setNarrow(false);
    h.flush();
    expect(dialog()).toBe(panel);
    expect(panel.getAttribute('aria-modal')).toBe('false');
  });

  it('wraps Tab and Shift+Tab inside the panel on a Narrow_Viewport', async () => {
    media.setNarrow(true);
    const h = await setup();
    setState(h, 'open');
    type(h, 'hello');
    const first = button('Show participants');
    const last = button('Send message');
    expect(last.disabled).toBe(false);

    last.focus();
    expect(keydown(h, last, 'Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    expect(keydown(h, first, 'Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    // Between the ends the browser's own Tab order applies.
    const middle = button('Minimize chat');
    middle.focus();
    expect(keydown(h, middle, 'Tab').defaultPrevented).toBe(false);
  });

  it('returns focus that leaves the panel on a Narrow_Viewport', async () => {
    media.setNarrow(true);
    const h = await setup();
    setState(h, 'open');
    const close = button('Close chat');
    close.focus();

    const other = addOutside('<button type="button">Vote</button>').querySelector('button');
    other?.focus();
    expect(document.activeElement).toBe(close);
  });

  it('leaves a page dialog alone while it is open, then contains focus again', async () => {
    media.setNarrow(true);
    const h = await setup();
    setState(h, 'open');
    expect(document.activeElement).toBe(textArea());

    const pageDialog = addOutside('<div role="dialog"><button type="button">OK</button></div>');
    const ok = pageDialog.querySelector('button');
    if (ok === null) throw new Error('dialog button missing');
    ok.focus();
    expect(document.activeElement).toBe(ok);
    expect(keydown(h, ok, 'Tab').defaultPrevented).toBe(false);
    expect(keydown(h, ok, 'Escape').defaultPrevented).toBe(false);
    expect(h.store.panelState()).toBe('open');

    pageDialog.remove();
    const other = addOutside('<button type="button">Vote</button>').querySelector('button');
    other?.focus();
    expect(document.activeElement).toBe(textArea());
  });
});

describe('ChatPanelComponent: status region (R11.18)', () => {
  it('renders an empty role="status" element while open and fills it with the offline text', async () => {
    const h = await setup();
    setState(h, 'open');
    const status = within(dialog()).getByRole('status');
    expect(status.textContent?.trim()).toBe('');

    h.transport.connectionState.set('reconnecting');
    h.flush();
    expect(within(dialog()).getByRole('status')).toBe(status);
    expect(status.textContent?.trim()).toBe(CHAT_OFFLINE_TEXT);

    h.transport.connectionState.set('connected');
    h.flush();
    expect(status.textContent?.trim()).toBe('');
  });
});

describe('ChatPanelComponent: Draft, caret and scroll restore (R3.8)', () => {
  let restoreGeometry: () => void = () => undefined;

  afterEach(() => restoreGeometry());

  it('restores the Draft and caret after close → open in a recreated panel', async () => {
    const h = await setup();
    setState(h, 'open');
    type(h, 'hello world');
    const first = textArea();
    first.setSelectionRange(5, 5);
    first.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
    h.flush();
    expect(h.store.caret()).toBe(5);

    setState(h, 'closed');
    setState(h, 'open');
    const second = textArea();
    expect(second).not.toBe(first);
    expect(second.value).toBe('hello world');
    expect(second.selectionStart).toBe(5);
    expect(second.selectionEnd).toBe(5);
    expect(document.activeElement).toBe(second);
  });

  it('restores the Draft and caret after minimized → open', async () => {
    const h = await setup();
    setState(h, 'open');
    type(h, 'abc def');
    textArea().setSelectionRange(3, 3);
    textArea().dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
    h.flush();

    click(h, button('Minimize chat'));
    click(h, button('Restore chat'));
    expect(textArea().value).toBe('abc def');
    expect(textArea().selectionEnd).toBe(3);
  });

  it('restores a stored scroll offset, or the end when the list was At_Bottom', async () => {
    restoreGeometry = installLogGeometry();
    const h = await setup();
    h.transport.history$.next({ messages: range(1, 20) });
    setState(h, 'open');
    const firstLog = messageLog();
    expect(firstLog.scrollTop).toBe(20 * ROW_H);

    // Not At_Bottom: the offset comes back in a recreated panel.
    firstLog.scrollTop = 120;
    firstLog.dispatchEvent(new Event('scroll'));
    expect(h.store.scroll()).toEqual({ top: 120, atBottom: false });
    setState(h, 'closed');
    setState(h, 'open');
    const secondLog = messageLog();
    expect(secondLog).not.toBe(firstLog);
    expect(Math.abs(secondLog.scrollTop - 120)).toBeLessThanOrEqual(1);

    // At_Bottom: the end, including messages that arrived while closed.
    secondLog.scrollTop = 20 * ROW_H - VIEW_H;
    secondLog.dispatchEvent(new Event('scroll'));
    expect(h.store.scroll()?.atBottom).toBe(true);
    setState(h, 'closed');
    h.transport.added$.next({ message: message(21) });
    h.transport.added$.next({ message: message(22) });
    h.flush();
    setState(h, 'open');
    const thirdLog = messageLog();
    expect(rowCount(thirdLog)).toBe(22);
    expect(thirdLog.scrollTop).toBe(22 * ROW_H);
  });
});

describe('ChatPanelComponent: Presence_List toggle (R10.2, R10.7)', () => {
  it('starts hidden and keeps its visibility across Panel_State changes', async () => {
    const h = await setup();
    setState(h, 'open');
    const listId = presenceListId('poker');
    const toggle = button('Show participants');
    expect(toggle.getAttribute('aria-controls')).toBe(listId);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(listId)?.hidden).toBe(true);

    click(h, toggle);
    expect(h.store.presenceOpen()).toBe(true);
    expect(button('Show participants').getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(listId)?.hidden).toBe(false);

    click(h, button('Minimize chat'));
    click(h, button('Restore chat'));
    expect(button('Show participants').getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(listId)?.hidden).toBe(false);

    setState(h, 'closed');
    setState(h, 'open');
    expect(button('Show participants').getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(listId)?.hidden).toBe(false);

    click(h, button('Show participants'));
    expect(button('Show participants').getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(listId)?.hidden).toBe(true);
  });
});
