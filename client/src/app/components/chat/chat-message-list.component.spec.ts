import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { fireEvent, render, within } from '@testing-library/angular';
import { Subject } from 'rxjs';
import { ChatMessage, ChatMessageSendPayload, ConnectionState, User } from '@shared/types';
import { CHAT_TIMERS, ChatStore, ChatTimers } from '../../services/chat-store.service';
import { CHAT_READ_MARKER_STORE, ReadMarkerStore } from '../../services/chat-read-marker';
import { CHAT_TRANSPORT, ChatTransport } from '../../services/chat-transport';
import {
  CHAT_EMPTY_TEXT,
  CHAT_HISTORY_TIMED_OUT_TEXT,
  CHAT_LOADING_TEXT,
  ChatMessageListComponent,
} from './chat-message-list.component';

/**
 * Example tests of the Message_List (task 12.10): literal rendering of markup (R22.4), the empty,
 * loading and timed-out texts (R5.10, R5.11, R5.13), DOM identity across an add and an eviction
 * (R20.3), scroll anchoring (R6.1, R6.2), the New_Messages_Indicator (R6.4) and the log role and
 * name (R11.8, R22.3). The store runs for real over a fake transport and a manual clock.
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

function id(seq: number): string {
  return `10000000-0000-4000-8000-${seq.toString().padStart(12, '0')}`;
}

function message(seq: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: id(seq),
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

interface Harness {
  readonly transport: FakeTransport;
  readonly timers: ManualTimers;
  readonly store: ChatStore;
  readonly fixture: ComponentFixture<ChatMessageListComponent>;
  readonly container: HTMLElement;
  readonly log: HTMLElement;
}

/** Renders the list over a store bound to `s1`, connected at Connection_Generation 1. */
async function setup(): Promise<Harness> {
  const transport = new FakeTransport();
  const timers = new ManualTimers();
  const storage = new Map<string, string>();
  const { fixture, container } = await render(ChatMessageListComponent, {
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
  fixture.detectChanges();
  const log = container.querySelector<HTMLElement>('[role="log"]');
  if (log === null) throw new Error('Message_List log element not rendered');
  return { transport, timers, store, fixture, container: container as HTMLElement, log };
}

function flush(h: Harness): void {
  h.fixture.detectChanges();
}

function open(h: Harness): void {
  h.store.panelState.set('open');
  flush(h);
}

/** Rendered rows by `data-key`, in DOM order. */
function rows(log: HTMLElement): Map<string, HTMLElement> {
  const result = new Map<string, HTMLElement>();
  for (const child of Array.from(log.children)) {
    if (child instanceof HTMLElement && child.dataset['key'] !== undefined) {
      result.set(child.dataset['key'], child);
    }
  }
  return result;
}

// --- Scroll geometry stub ----------------------------------------------------------------

/** Every row is 50 px high; the log viewport is 200 px high with its top at 0. */
const ROW_H = 50;
const VIEW_H = 200;

function rect(top: number, bottom: number): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 300,
    width: 300,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

/**
 * Gives the log a layout: `scrollTop` is stored, `scrollHeight` is rows × 50, `clientHeight` is
 * 200, `scrollTo` jumps to `top`, and each row's rect is `index × 50 − scrollTop`.
 */
function stubGeometry(log: HTMLElement): void {
  let top = 0;
  const rowList = (): HTMLElement[] => [...rows(log).values()];
  Object.defineProperty(log, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  Object.defineProperty(log, 'scrollHeight', {
    configurable: true,
    get: () => rowList().length * ROW_H,
  });
  Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => VIEW_H });
  Object.defineProperty(log, 'scrollTo', {
    configurable: true,
    value: (arg?: ScrollToOptions | number, y?: number) => {
      top = typeof arg === 'number' ? (y ?? 0) : (arg?.top ?? top);
    },
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ): DOMRect {
    if (this === log) return rect(0, VIEW_H);
    if (this.parentElement === log && this instanceof HTMLElement) {
      const index = rowList().indexOf(this);
      if (index >= 0) {
        const rowTop = index * ROW_H - top;
        return rect(rowTop, rowTop + ROW_H);
      }
    }
    return rect(0, 0);
  });
}

/** Row top relative to the log viewport top. */
function offsetOf(log: HTMLElement, key: string): number {
  const row = rows(log).get(key);
  if (row === undefined) throw new Error(`row ${key} not rendered`);
  return row.getBoundingClientRect().top - log.getBoundingClientRect().top;
}

/** The user scrolls the log to `top`. */
function userScroll(log: HTMLElement, top: number): void {
  log.scrollTop = top;
  log.dispatchEvent(new Event('scroll'));
}

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------------------

describe('ChatMessageListComponent: literal rendering (R22.4)', () => {
  it('renders <script> and <img onerror> in text and authorName as literal text', async () => {
    const h = await setup();
    const text = '<script>alert(1)</script> <img src=x onerror=alert(1)>';
    const authorName = '<img src=x onerror=alert(2)><script>alert(2)</script>';
    h.transport.history$.next({ messages: [message(1, { text, authorName })] });
    flush(h);

    const row = rows(h.log).get(id(1));
    expect(row).toBeDefined();
    expect(row?.querySelector('.chat-msg__text')?.textContent).toBe(text);
    expect(row?.querySelector('.chat-msg__author')?.textContent).toBe(authorName);
    expect(h.container.querySelector('script')).toBeNull();
    expect(h.container.querySelector('img')).toBeNull();
    expect(h.container.querySelector('[onerror]')).toBeNull();
    expect(h.log.innerHTML).toContain('&lt;script');
    expect(h.log.innerHTML).toContain('&lt;img');
  });
});

describe('ChatMessageListComponent: empty, loading and timed-out texts (R5.10, R5.11, R5.13)', () => {
  it('shows the loading text until a Chat_History arrives, then the empty text', async () => {
    const h = await setup();
    const view = within(h.container);
    expect(view.getByText(CHAT_LOADING_TEXT)).toBeTruthy();
    expect(view.queryByText(CHAT_EMPTY_TEXT)).toBeNull();

    h.transport.history$.next({ messages: [] });
    flush(h);
    expect(view.getByText(CHAT_EMPTY_TEXT)).toBeTruthy();
    expect(view.queryByText(CHAT_LOADING_TEXT)).toBeNull();
  });

  it('replaces the loading text 10,000 ms after connected and still renders a later history', async () => {
    const h = await setup();
    const view = within(h.container);

    h.timers.advance(9_999);
    flush(h);
    expect(view.getByText(CHAT_LOADING_TEXT)).toBeTruthy();

    h.timers.advance(1);
    flush(h);
    expect(view.getByText(CHAT_HISTORY_TIMED_OUT_TEXT)).toBeTruthy();
    expect(view.queryByText(CHAT_LOADING_TEXT)).toBeNull();
    expect(view.queryByText(CHAT_EMPTY_TEXT)).toBeNull();

    h.transport.history$.next({ messages: [message(1)] });
    flush(h);
    expect(rows(h.log).has(id(1))).toBe(true);
  });
});

describe('ChatMessageListComponent: DOM identity (R20.3)', () => {
  it('keeps the row elements of other messages across an add and an eviction', async () => {
    const h = await setup();
    h.transport.history$.next({ messages: range(1, 199) });
    flush(h);
    const before = rows(h.log);
    expect(before.size).toBe(199);

    h.transport.added$.next({ message: message(200) });
    flush(h);
    const afterAdd = rows(h.log);
    expect([...afterAdd.keys()]).toEqual(range(1, 200).map((m) => m.id));
    for (const [key, element] of before) expect(afterAdd.get(key)).toBe(element);

    // The 201st message evicts the oldest (CHAT_HISTORY_LIMIT = 200).
    h.transport.added$.next({ message: message(201) });
    flush(h);
    const afterEvict = rows(h.log);
    expect([...afterEvict.keys()]).toEqual(range(2, 201).map((m) => m.id));
    expect(before.get(id(1))?.isConnected).toBe(false);
    for (const [key, element] of afterAdd) {
      if (key !== id(1)) expect(afterEvict.get(key)).toBe(element);
    }
  });
});

describe('ChatMessageListComponent: scroll anchoring (R6.1, R6.2)', () => {
  it('keeps the anchored row in place when an older and a newer message are added', async () => {
    const h = await setup();
    stubGeometry(h.log);
    h.transport.history$.next({ messages: range(10, 19) });
    open(h);
    expect(h.log.scrollTop).toBe(h.log.scrollHeight);

    userScroll(h.log, 120);
    expect(h.store.scroll()).toEqual({ top: 120, atBottom: false });
    expect(offsetOf(h.log, id(12))).toBe(-20);

    // A reconnect history inserts an older message above the viewport.
    h.transport.connectionGeneration.set(2);
    h.transport.history$.next({ messages: [message(5), ...range(10, 19)] });
    flush(h);
    expect(rows(h.log).size).toBe(11);
    expect(h.log.scrollTop).toBe(170);
    expect(offsetOf(h.log, id(12))).toBe(-20);

    // A newer message below the viewport moves nothing and shows the indicator.
    h.transport.added$.next({ message: message(20) });
    flush(h);
    expect(h.log.scrollTop).toBe(170);
    expect(offsetOf(h.log, id(12))).toBe(-20);
    expect(h.store.newIndicatorCount()).toBe(1);
    expect(within(h.container).getByRole('button', { name: '1 new message' })).toBeTruthy();
  });

  it('keeps the anchored row in place when the oldest message is evicted', async () => {
    const h = await setup();
    stubGeometry(h.log);
    h.transport.history$.next({ messages: range(1, 200) });
    open(h);

    userScroll(h.log, 5_000);
    expect(offsetOf(h.log, id(101))).toBe(0);

    h.transport.added$.next({ message: message(201) });
    flush(h);
    expect(rows(h.log).has(id(1))).toBe(false);
    expect(h.log.scrollTop).toBe(4_950);
    expect(offsetOf(h.log, id(101))).toBe(0);
  });

  it('scrolls to the end on an addition while At_Bottom', async () => {
    const h = await setup();
    stubGeometry(h.log);
    h.transport.history$.next({ messages: range(10, 19) });
    open(h);
    expect(h.log.scrollTop).toBe(500);

    h.transport.added$.next({ message: message(20) });
    flush(h);
    expect(h.log.scrollHeight).toBe(550);
    expect(h.log.scrollTop).toBe(550);
    expect(h.store.scroll()?.atBottom).toBe(true);
    expect(h.store.newIndicatorCount()).toBe(0);
  });
});

describe('ChatMessageListComponent: New_Messages_Indicator (R6.4)', () => {
  it('scrolls to the end, resets the count and then asks for Composer focus', async () => {
    const h = await setup();
    stubGeometry(h.log);
    h.transport.history$.next({ messages: range(1, 10) });
    open(h);
    userScroll(h.log, 0);
    h.store.newIndicatorCount.set(3);
    flush(h);

    const seen: { top: number; count: number }[] = [];
    const subscription = h.fixture.componentInstance.focusComposer.subscribe(() =>
      seen.push({ top: h.log.scrollTop, count: h.store.newIndicatorCount() }),
    );
    fireEvent.click(within(h.container).getByRole('button', { name: '3 new messages' }));
    flush(h);
    subscription.unsubscribe();

    expect(seen).toEqual([{ top: h.log.scrollHeight, count: 0 }]);
    expect(h.store.newIndicatorCount()).toBe(0);
    expect(within(h.container).queryByRole('button', { name: /new message/ })).toBeNull();
  });
});

describe('ChatMessageListComponent: role and name (R11.8, R22.3)', () => {
  it('is a polite log named "Chat messages" announcing additions', async () => {
    const h = await setup();
    const log = within(h.container).getByRole('log', { name: 'Chat messages' });
    expect(log).toBe(h.log);
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(log.getAttribute('aria-relevant')).toBe('additions');
    expect(log.getAttribute('tabindex')).toBe('0');
  });
});
