/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Component, Type, inject, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { render, screen } from '@testing-library/angular';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Subject } from 'rxjs';
import {
  BoardKind,
  ChatMessage,
  ChatMessageSendPayload,
  ConnectionState,
  User,
} from '@shared/types';
import { CHAT_TIMERS, ChatStore, ChatTimers } from '../../services/chat-store.service';
import { CHAT_READ_MARKER_STORE, ReadMarkerStore } from '../../services/chat-read-marker';
import {
  CHAT_TRANSPORT,
  ChatTransport,
  PokerChatTransport,
  RetroChatTransport,
} from '../../services/chat-transport';
import { PANEL_CHUNK_LOADER_DEPS } from '../../services/panel-chunk-loader';
import {
  WCAG_AA_NON_TEXT_CONTRAST,
  mixColors,
  relativeLuminance,
  wcagContrastRatio,
} from '../../testing/contrast';
import { REDUCED_MOTION_MEDIA, stylesFor } from '../../testing/declared-css';
import {
  ATTENTION_DURATION_MS,
  ATTENTION_ITERATIONS,
  ATTENTION_ITERATION_MS,
} from './chat-attention';
import { CHAT_NARROW_QUERY, chatPanelId } from './chat-format';
import { ChatHostComponent } from './chat-host.component';
import { CHAT_REDUCED_MOTION_QUERY, ChatLauncherComponent } from './chat-launcher.component';
import { ChatPanelHeaderComponent } from './chat-panel-header.component';

/**
 * Unit tests of the Chat_Launcher and the New_Message_Attention_Animation (task 14.5;
 * R1.6, R1.7, R2.1–R2.3, R4.4, R11.1, R11.2, R22.3, R22.14, R24.1–R24.12).
 *
 * The store runs for real over a fake transport and a manual clock; `matchMedia` and
 * `document.visibilityState` are stubbed so the reduced-motion preference, the Narrow_Viewport
 * and the tab visibility can be changed mid-test. The toggle rules live in
 * `ChatHostComponent.toggleFromLauncher()`, so they are exercised through a rendered host with a
 * stub panel class handed out by a controlled importer.
 *
 * The test DOM neither runs CSS animations nor resolves custom properties, so the pulse keyframes,
 * the animation longhands and the Unread_Ring bands are read from the sources (the compiled
 * component styles and `chat.keyframes.scss`), and the R24.5 contrast pairs are computed from the
 * colour values declared in `client/src/styles.scss`. Vitest runs with `process.cwd()` = `client/`.
 */

// --- Controlled clock, transport and environment -----------------------------------------------

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
  constructor(readonly boardKind: BoardKind) {}
  readonly connectionState = signal<ConnectionState>('connected');
  readonly connectionGeneration = signal(1);
  readonly participants = signal<readonly User[]>([]);
  readonly currentUserId = signal<string | null>('me');
  readonly added$ = new Subject<unknown>();
  readonly history$ = new Subject<unknown>();
  readonly rejected$ = new Subject<unknown>();
  send(_payload: ChatMessageSendPayload): boolean {
    return true;
  }
}

function message(seq: number, authorId = 'other'): ChatMessage {
  return {
    id: `10000000-0000-4000-8000-${seq.toString().padStart(12, '0')}`,
    seq,
    clientMessageId: `20000000-0000-4000-8000-${seq.toString().padStart(12, '0')}`,
    authorId,
    authorName: `Person ${authorId}`,
    text: `text ${seq}`,
    sentAt: new Date(1_000_000 + seq).toISOString(),
  };
}

const messages = (count: number): ChatMessage[] =>
  Array.from({ length: count }, (_, i) => message(i + 1));

interface MediaStub {
  /** Changes what `query` matches and notifies its `change` listeners. */
  set(query: string, matches: boolean): void;
}

const windows = (): Window[] => {
  const view = document.defaultView;
  return view !== null && view !== window ? [window, view] : [window];
};

/** Every query starts unmatched; `set` changes one and fires its `change` listeners. */
function installMatchMedia(): MediaStub {
  const state = new Map<string, boolean>();
  const listeners = new Map<string, Set<(event: MediaQueryListEvent) => void>>();
  const listenersOf = (media: string): Set<(event: MediaQueryListEvent) => void> => {
    let set = listeners.get(media);
    if (set === undefined) {
      set = new Set();
      listeners.set(media, set);
    }
    return set;
  };
  const list = (media: string) => ({
    get matches(): boolean {
      return state.get(media) ?? false;
    },
    media,
    addEventListener: (type: string, listener: (event: MediaQueryListEvent) => void): void => {
      if (type === 'change') listenersOf(media).add(listener);
    },
    removeEventListener: (type: string, listener: (event: MediaQueryListEvent) => void): void => {
      if (type === 'change') listenersOf(media).delete(listener);
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
    set(query: string, matches: boolean): void {
      state.set(query, matches);
      const event = Object.assign(new Event('change'), { matches }) as MediaQueryListEvent;
      for (const listener of [...listenersOf(query)]) listener(event);
    },
  };
}

let media: MediaStub;
let originalMatchMedia: PropertyDescriptor | undefined;
let visibility: DocumentVisibilityState = 'visible';

/** Sets `document.visibilityState` and fires `visibilitychange`, as a tab switch does. */
function setVisible(visible: boolean): void {
  visibility = visible ? 'visible' : 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  media = installMatchMedia();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  for (const win of windows()) {
    if (originalMatchMedia) Object.defineProperty(win, 'matchMedia', originalMatchMedia);
    else Reflect.deleteProperty(win, 'matchMedia');
  }
  Reflect.deleteProperty(document, 'visibilityState');
  document.documentElement.style.overflow = '';
});

function chatProviders(transport: FakeTransport, timers: ManualTimers) {
  return [
    ChatStore,
    { provide: CHAT_TRANSPORT, useValue: transport },
    { provide: CHAT_TIMERS, useValue: timers },
    { provide: CHAT_READ_MARKER_STORE, useValue: new ReadMarkerStore(() => null) },
    {
      provide: PANEL_CHUNK_LOADER_DEPS,
      useValue: {
        importer: () => new Promise<Type<unknown>>(() => undefined),
        baseUrl: 'http://localhost/chunk-importer.js',
        importUrl: () => new Promise<Type<unknown>>(() => undefined),
        timers,
        requestIdle: null,
      },
    },
  ];
}

/** The launcher alone, over the page-scoped store it reads. */
async function renderLauncher(boardKind: BoardKind = 'retro') {
  const transport = new FakeTransport(boardKind);
  const timers = new ManualTimers();
  const { fixture } = await render(ChatLauncherComponent, {
    providers: chatProviders(transport, timers),
  });
  const store = TestBed.inject(ChatStore);
  store.reset('s1');
  const flush = (): void => {
    TestBed.tick();
    fixture.detectChanges();
  };
  flush();
  const root = fixture.nativeElement as HTMLElement;
  const launcher = (): HTMLButtonElement => screen.getByRole('button', { hidden: true });
  const pulses = (): Element[] => Array.from(root.querySelectorAll('.chat-launcher__pulse'));
  const badge = (): HTMLElement | null => root.querySelector('.chat-launcher__badge');
  const ring = (): boolean => launcher().classList.contains('chat-launcher--ring');
  const run = (): number | null => fixture.componentInstance.attentionRun();
  const add = (...items: ChatMessage[]): void => {
    for (const item of items) transport.added$.next({ message: item });
    flush();
  };
  const history = (items: ChatMessage[]): void => {
    transport.history$.next({ messages: items });
    flush();
  };
  const advance = (ms: number): void => {
    timers.advance(ms);
    flush();
  };
  const setPanel = (state: 'closed' | 'open' | 'minimized'): void => {
    store.panelState.set(state);
    flush();
  };
  return {
    transport, timers, store, fixture, flush, launcher, pulses, badge, ring, run,
    add, history, advance, setPanel,
  };
}

// --- Unread_Badge and accessible name (R2.1–R2.3, R11.2, R22.3) -------------------------------

describe('ChatLauncherComponent: Unread_Badge and accessible name', () => {
  it.each([
    { unread: 0, text: null, name: 'Open chat' },
    { unread: 1, text: '1', name: 'Open chat, 1 unread message' },
    { unread: 99, text: '99', name: 'Open chat, 99 unread messages' },
    { unread: 100, text: '99+', name: 'Open chat, 100 unread messages' },
  ])('at an Unread_Count of $unread shows $text and is named "$name"', async ({ unread, text, name }) => {
    const h = await renderLauncher();
    if (unread > 0) h.history(messages(unread));
    expect(h.store.unreadCount()).toBe(unread);

    expect(screen.getByRole('button', { name })).toBe(h.launcher());
    const badge = h.badge();
    if (text === null) {
      expect(badge).toBeNull();
    } else {
      expect(badge?.textContent?.trim()).toBe(text);
      // The name already carries the exact count (R24.9).
      expect(badge?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('shows each new count as it changes and hides the badge again at 0', async () => {
    const h = await renderLauncher();
    h.add(message(1));
    expect(h.badge()?.textContent?.trim()).toBe('1');
    h.add(message(2));
    expect(h.badge()?.textContent?.trim()).toBe('2');
    expect(h.launcher().getAttribute('aria-label')).toBe('Open chat, 2 unread messages');

    // Opening reads everything (R2.4); the badge and the count in the name go.
    h.setPanel('open');
    expect(h.store.unreadCount()).toBe(0);
    expect(h.badge()).toBeNull();
    expect(h.launcher().getAttribute('aria-label')).toBe('Open chat');
  });
});

// --- Roles, aria-controls and aria-expanded (R11.1) --------------------------------------------

describe('ChatLauncherComponent: roles and states', () => {
  it.each(['poker', 'retro'] as const)(
    'is a native button whose aria-controls names the %s Chat_Panel',
    async (boardKind) => {
      const h = await renderLauncher(boardKind);
      const button = h.launcher();
      expect(button.tagName).toBe('BUTTON');
      expect(button.type).toBe('button');
      expect(button.getAttribute('aria-controls')).toBe(chatPanelId(boardKind));
      expect(button.getAttribute('aria-controls')).toBe(`chat-panel-${boardKind}`);
    },
  );

  it('has aria-expanded="true" only while open', async () => {
    const h = await renderLauncher();
    expect(h.launcher().getAttribute('aria-expanded')).toBe('false');
    h.setPanel('open');
    expect(h.launcher().getAttribute('aria-expanded')).toBe('true');
    h.setPanel('minimized');
    expect(h.launcher().getAttribute('aria-expanded')).toBe('false');
    h.setPanel('closed');
    expect(h.launcher().getAttribute('aria-expanded')).toBe('false');
  });

  it('emits activated on every click, whatever the Panel_State', async () => {
    const h = await renderLauncher();
    let activations = 0;
    h.fixture.componentInstance.activated.subscribe(() => activations++);
    h.launcher().click();
    h.setPanel('minimized');
    h.launcher().click();
    expect(activations).toBe(2);
    // The launcher only reports; the host owns Panel_State (R1.6, R1.7, C16).
    expect(h.store.panelState()).toBe('minimized');
  });
});

// --- Toggle rules through the host (R1.6, R1.7, R4.4) ------------------------------------------

/** Stand-in for the Chat_Panel: the same id as the real one, and the host's store. */
@Component({
  selector: 'app-stub-chat-panel',
  template: `<section class="stub-panel" [id]="id"></section>`,
})
class StubPanelComponent {
  readonly store = inject(ChatStore);
  protected readonly id = chatPanelId(this.store.boardKind);
}

@Component({
  imports: [ChatHostComponent],
  template: `<app-chat-host boardKind="poker" sessionId="s1" />`,
})
class PokerPageComponent {}

/** A promise per importer call, settled by the test. */
class ControlledImporter {
  readonly calls: { resolve(cls: Type<unknown>): void; reject(error: unknown): void }[] = [];
  readonly importer = (): Promise<Type<unknown>> =>
    new Promise<Type<unknown>>((resolve, reject) => this.calls.push({ resolve, reject }));
}

function setupHost(narrow: boolean) {
  media.set(CHAT_NARROW_QUERY, narrow);
  const timers = new ManualTimers();
  const importer = new ControlledImporter();
  TestBed.configureTestingModule({
    providers: [
      { provide: PokerChatTransport, useValue: new FakeTransport('poker') },
      { provide: RetroChatTransport, useValue: new FakeTransport('retro') },
      { provide: CHAT_TIMERS, useValue: timers },
      { provide: CHAT_READ_MARKER_STORE, useValue: new ReadMarkerStore(() => null) },
      {
        provide: PANEL_CHUNK_LOADER_DEPS,
        useValue: {
          importer: importer.importer,
          baseUrl: 'http://localhost/chunk-importer.js',
          importUrl: () => new Promise<Type<unknown>>(() => undefined),
          timers,
          requestIdle: null,
        },
      },
    ],
  });
  const fixture: ComponentFixture<PokerPageComponent> = TestBed.createComponent(PokerPageComponent);
  const flush = (): void => {
    TestBed.tick();
    fixture.detectChanges();
  };
  flush();
  const hostDebug = fixture.debugElement.query(By.directive(ChatHostComponent));
  const host = hostDebug.componentInstance as ChatHostComponent;
  const store = hostDebug.injector.get(ChatStore);
  const root = fixture.nativeElement as HTMLElement;
  const launcher = (): HTMLButtonElement =>
    root.querySelector<HTMLButtonElement>('button.chat-launcher') as HTMLButtonElement;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    flush();
  };
  const click = (): void => {
    launcher().click();
    flush();
  };
  /** First activation: the Load_Sequence, then the panel opens on success (R20.11). */
  const firstOpen = async (): Promise<void> => {
    click();
    importer.calls[0].resolve(StubPanelComponent);
    await settle();
  };
  return { fixture, flush, host, store, launcher, click, firstOpen, importer };
}

describe('ChatLauncherComponent: toggle rules (through ChatHostComponent)', () => {
  it('on a Wide_Viewport opens from closed and minimized and closes from open', async () => {
    const h = setupHost(false);
    expect(h.store.panelState()).toBe('closed');
    await h.firstOpen();
    expect(h.store.panelState()).toBe('open');
    expect(h.launcher().getAttribute('aria-expanded')).toBe('true');

    h.click();
    expect(h.store.panelState()).toBe('closed');
    expect(h.launcher().getAttribute('aria-expanded')).toBe('false');

    h.click();
    expect(h.store.panelState()).toBe('open');

    h.store.panelState.set('minimized');
    h.flush();
    expect(h.launcher().hidden).toBe(false);
    h.click();
    expect(h.store.panelState()).toBe('open');
    expect(h.importer.calls).toHaveLength(1);
  });

  it('on a Narrow_Viewport opens from closed and minimized and is hidden while open', async () => {
    const h = setupHost(true);
    await h.firstOpen();
    expect(h.store.panelState()).toBe('open');
    // Hidden, so it cannot be activated; the toggle rule does nothing in this case (R4.4).
    expect(h.launcher().hidden).toBe(true);
    h.host.toggleFromLauncher();
    h.flush();
    expect(h.store.panelState()).toBe('open');

    h.store.panelState.set('minimized');
    h.flush();
    expect(h.launcher().hidden).toBe(false);
    h.click();
    expect(h.store.panelState()).toBe('open');

    h.store.panelState.set('closed');
    h.flush();
    expect(h.launcher().hidden).toBe(false);
    h.click();
    expect(h.store.panelState()).toBe('open');
  });

  it('closes the panel once a narrow viewport becomes wide while open', async () => {
    const h = setupHost(true);
    await h.firstOpen();
    expect(h.launcher().hidden).toBe(true);

    media.set(CHAT_NARROW_QUERY, false);
    h.flush();
    expect(h.launcher().hidden).toBe(false);
    h.click();
    expect(h.store.panelState()).toBe('closed');
  });
});

// --- New_Message_Attention_Animation under a controlled clock (R22.14, R24) --------------------

describe('ChatLauncherComponent: New_Message_Attention_Animation', () => {
  it('starts on an Unread_Increase while closed and visible, without touching focus or Panel_State', async () => {
    const h = await renderLauncher();
    const focused = document.activeElement;
    h.add(message(1));
    expect(h.pulses()).toHaveLength(1);
    expect(h.pulses()[0].getAttribute('aria-hidden')).toBe('true');
    expect(h.run()).toBe(1);
    // R24.11: no change of focus, Panel_State or aria-expanded.
    expect(document.activeElement).toBe(focused);
    expect(h.store.panelState()).toBe('closed');
    expect(h.launcher().getAttribute('aria-expanded')).toBe('false');

    h.advance(ATTENTION_DURATION_MS - 1);
    expect(h.pulses()).toHaveLength(1);
    h.advance(1);
    expect(h.pulses()).toHaveLength(0);
    expect(h.run()).toBeNull();
    expect(h.ring()).toBe(true);
  });

  it('starts on an Unread_Increase while minimized', async () => {
    const h = await renderLauncher();
    h.setPanel('minimized');
    h.add(message(1));
    expect(h.pulses()).toHaveLength(1);
    expect(h.ring()).toBe(true);
  });

  it('starts on an Unread_Increase caused by a Chat_History', async () => {
    const h = await renderLauncher();
    h.history([message(1), message(2), message(3, 'me')]);
    expect(h.store.unreadCount()).toBe(2);
    expect(h.pulses()).toHaveLength(1);
    expect(h.run()).toBe(1);
  });

  it('restarts from its first iteration on a further increase and ends 3,600 ms after the latest one', async () => {
    const h = await renderLauncher();
    h.add(message(1));
    const first = h.pulses()[0];

    h.advance(1000);
    h.add(message(2));
    expect(h.pulses()).toHaveLength(1);
    // A new element replays the CSS animation from its first iteration (R24.2).
    expect(h.pulses()[0]).not.toBe(first);
    expect(h.run()).toBe(2);

    // Past the end of the first run, still running.
    h.advance(ATTENTION_DURATION_MS - 1);
    expect(h.pulses()).toHaveLength(1);
    h.advance(1);
    expect(h.pulses()).toHaveLength(0);
  });

  it('neither starts nor restarts on a decrease of the Unread_Count', async () => {
    const h = await renderLauncher();
    h.add(message(1, 'a'), message(2, 'c'), message(3, 'b'), message(4, 'b'));
    expect(h.store.unreadCount()).toBe(4);
    const live = h.pulses()[0];
    const run = h.run();

    h.advance(1000);
    // The message of `c` becomes an Own_Message: the count falls without an Unread_Increase.
    h.transport.currentUserId.set('c');
    h.flush();
    expect(h.store.unreadCount()).toBe(3);
    expect(h.pulses()[0]).toBe(live);
    expect(h.run()).toBe(run);

    h.advance(ATTENTION_DURATION_MS - 1000);
    expect(h.pulses()).toHaveLength(0);

    // Now the two messages of `b` are own and the one of `c` is not: 3 → 2.
    h.transport.currentUserId.set('b');
    h.flush();
    expect(h.store.unreadCount()).toBe(2);
    expect(h.pulses()).toHaveLength(0);
    expect(h.run()).toBeNull();
  });

  it('neither starts nor restarts on a Chat_History that leaves the Unread_Count unchanged', async () => {
    const h = await renderLauncher();
    h.add(message(1), message(2));
    const live = h.pulses()[0];
    const run = h.run();

    h.advance(1000);
    h.history([message(1), message(2)]);
    expect(h.store.unreadCount()).toBe(2);
    expect(h.pulses()[0]).toBe(live);
    expect(h.run()).toBe(run);

    h.advance(ATTENTION_DURATION_MS - 1000);
    expect(h.pulses()).toHaveLength(0);

    // A later history of a new connection, again with the same unread messages.
    h.transport.connectionGeneration.set(2);
    h.flush();
    h.history([message(1), message(2)]);
    expect(h.store.unreadCount()).toBe(2);
    expect(h.pulses()).toHaveLength(0);
    expect(h.run()).toBeNull();
  });

  it('continues without restarting when Panel_State moves between closed and minimized', async () => {
    const h = await renderLauncher();
    h.add(message(1));
    const live = h.pulses()[0];

    h.advance(1000);
    h.setPanel('minimized');
    expect(h.pulses()[0]).toBe(live);
    expect(h.ring()).toBe(true);

    h.advance(1000);
    h.setPanel('closed');
    expect(h.pulses()[0]).toBe(live);
    expect(h.ring()).toBe(true);

    h.advance(ATTENTION_DURATION_MS - 2000 - 1);
    expect(h.pulses()[0]).toBe(live);
    h.advance(1);
    expect(h.pulses()).toHaveLength(0);
    expect(h.ring()).toBe(true);
  });

  it('does not start while hidden and starts exactly once when the document becomes visible', async () => {
    const h = await renderLauncher();
    setVisible(false);
    h.flush();
    h.add(message(1));
    h.add(message(2));
    expect(h.store.unreadCount()).toBe(2);
    expect(h.pulses()).toHaveLength(0);
    expect(h.run()).toBeNull();
    expect(h.ring()).toBe(true);

    setVisible(true);
    h.flush();
    expect(h.pulses()).toHaveLength(1);
    expect(h.run()).toBe(1);

    h.advance(ATTENTION_DURATION_MS);
    expect(h.pulses()).toHaveLength(0);

    // A further hidden period without an Unread_Increase starts nothing (R24.10).
    setVisible(false);
    h.flush();
    setVisible(true);
    h.flush();
    expect(h.pulses()).toHaveLength(0);
    expect(h.run()).toBeNull();
  });

  it('stops at once when Panel_State becomes open and does not start while open', async () => {
    const h = await renderLauncher();
    h.add(message(1));
    expect(h.pulses()).toHaveLength(1);

    h.setPanel('open');
    expect(h.pulses()).toHaveLength(0);
    expect(h.run()).toBeNull();

    // An Unread_Increase while open and hidden starts nothing, before or after becoming visible.
    setVisible(false);
    h.flush();
    h.add(message(2));
    expect(h.store.unreadCount()).toBe(1);
    expect(h.pulses()).toHaveLength(0);
    setVisible(true);
    h.flush();
    expect(h.pulses()).toHaveLength(0);
    expect(h.run()).toBeNull();
  });

  it('does not play under prefers-reduced-motion: reduce and shows the static Unread_Ring instead', async () => {
    media.set(CHAT_REDUCED_MOTION_QUERY, true);
    const h = await renderLauncher();
    h.add(message(1));
    expect(h.pulses()).toHaveLength(0);
    expect(h.run()).toBeNull();
    expect(h.ring()).toBe(true);
    expect(h.badge()?.textContent?.trim()).toBe('1');
  });

  it('stops a running animation as soon as the preference changes to reduce', async () => {
    const h = await renderLauncher();
    h.add(message(1));
    expect(h.pulses()).toHaveLength(1);

    h.advance(500);
    media.set(CHAT_REDUCED_MOTION_QUERY, true);
    h.flush();
    expect(h.pulses()).toHaveLength(0);
    expect(h.run()).toBeNull();
    expect(h.ring()).toBe(true);

    // Turning the preference off again starts nothing on its own.
    media.set(CHAT_REDUCED_MOTION_QUERY, false);
    h.flush();
    expect(h.pulses()).toHaveLength(0);
  });

  it('hides the Unread_Ring at an Unread_Count of 0', async () => {
    const h = await renderLauncher();
    expect(h.ring()).toBe(false);
    h.add(message(1));
    expect(h.ring()).toBe(true);

    // Not while open, and not once the Read_Marker has caught up (R24.6).
    h.setPanel('open');
    expect(h.store.unreadCount()).toBe(0);
    expect(h.ring()).toBe(false);
    h.setPanel('closed');
    expect(h.ring()).toBe(false);
    expect(h.pulses()).toHaveLength(0);
  });

  it('hides the Unread_Dot of the minimized Panel_Header at an Unread_Count of 0', async () => {
    const transport = new FakeTransport('poker');
    const timers = new ManualTimers();
    const { fixture } = await render(ChatPanelHeaderComponent, {
      providers: chatProviders(transport, timers),
    });
    const store = TestBed.inject(ChatStore);
    store.reset('s1');
    const flush = (): void => {
      TestBed.tick();
      fixture.detectChanges();
    };
    const root = fixture.nativeElement as HTMLElement;
    const dot = (): Element | null => root.querySelector('.chat-header__dot');

    store.panelState.set('minimized');
    flush();
    expect(dot()).toBeNull();

    transport.added$.next({ message: message(1) });
    flush();
    expect(dot()?.getAttribute('aria-hidden')).toBe('true');

    store.panelState.set('open');
    flush();
    store.panelState.set('minimized');
    flush();
    expect(store.unreadCount()).toBe(0);
    expect(dot()).toBeNull();
  });
});

// --- Stylesheet scans (R24.1, R24.3, R24.5, R24.7) ---------------------------------------------

const CHAT_DIR = join(process.cwd(), 'src', 'app', 'components', 'chat');
const KEYFRAMES_PATH = join(CHAT_DIR, 'chat.keyframes.scss');
const STYLES_PATH = join(process.cwd(), 'src', 'styles.scss');

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** Index of the `}` closing the block opened by the `{` at `open`. */
function matchingBrace(css: string, open: number): number {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces');
}

/** The body of the first block whose prelude is `prelude`. */
function blockBody(css: string, prelude: RegExp): string {
  const match = prelude.exec(css);
  if (match === null) throw new Error(`no block ${prelude}`);
  const open = css.indexOf('{', match.index);
  return css.slice(open + 1, matchingBrace(css, open));
}

/** The `selector { declarations }` children of a block body, declarations as a map. */
function childBlocks(body: string): Map<string, Map<string, string>> {
  const blocks = new Map<string, Map<string, string>>();
  let cursor = 0;
  for (;;) {
    const open = body.indexOf('{', cursor);
    if (open === -1) return blocks;
    const close = matchingBrace(body, open);
    const declarations = new Map<string, string>();
    for (const part of body.slice(open + 1, close).split(';')) {
      const colon = part.indexOf(':');
      if (colon === -1) continue;
      declarations.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
    }
    blocks.set(body.slice(cursor, open).trim(), declarations);
    cursor = close + 1;
  }
}

/** Splits a value at its top-level commas (not inside parentheses). */
function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')') depth--;
    else if (value[i] === ',' && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

interface ShadowLayer {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly blur: number;
  readonly spread: number;
  /** The custom property the colour comes from, e.g. `--text-primary`. */
  readonly token: string;
}

const pxOf = (length: string): number => (length === '0' ? 0 : Number.parseFloat(length));

/** `0 0 0 2px var(--x), …` into its layers, innermost first. */
function shadowLayers(value: string): ShadowLayer[] {
  return splitTopLevel(value).map((layer) => {
    const match = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+var\(\s*(--[\w-]+)\s*\)$/.exec(layer);
    if (match === null) throw new Error(`unexpected box-shadow layer "${layer}"`);
    return {
      offsetX: pxOf(match[1]),
      offsetY: pxOf(match[2]),
      blur: pxOf(match[3]),
      spread: pxOf(match[4]),
      token: match[5],
    };
  });
}

/** Two-tone ring bands from stacked spread shadows: band n spans spread[n-1]..spread[n]. */
function ringBands(value: string): { token: string; thickness: number }[] {
  let previous = 0;
  return shadowLayers(value).map((layer) => {
    expect(layer.offsetX, 'band offset').toBe(0);
    expect(layer.offsetY, 'band offset').toBe(0);
    expect(layer.blur, 'band blur').toBe(0);
    const band = { token: layer.token, thickness: layer.spread - previous };
    previous = layer.spread;
    return band;
  });
}

describe('ChatLauncherComponent: stylesheet scans', () => {
  it('chat-pulse animates only transform and opacity, from scale 1 at 0.6 to scale 1.25 at 0', () => {
    const css = stripComments(readFileSync(KEYFRAMES_PATH, 'utf8'));
    const frames = childBlocks(blockBody(css, /@keyframes\s+chat-pulse\b/));
    expect(frames.size).toBeGreaterThan(0);
    for (const [selector, declarations] of frames) {
      for (const property of declarations.keys()) {
        expect(['transform', 'opacity'], `${selector} animates ${property}`).toContain(property);
      }
    }
    const from = frames.get('from') ?? frames.get('0%');
    const to = frames.get('to') ?? frames.get('100%');
    expect(from?.get('transform')).toBe('scale(1)');
    expect(Number(from?.get('opacity'))).toBe(0.6);
    expect(to?.get('transform')).toBe('scale(1.25)');
    expect(Number(to?.get('opacity'))).toBe(0);
  });

  it('the pulse plays chat-pulse for 3 iterations of 1200ms with no delay, outside the hit target', () => {
    const pulse = stylesFor(ChatLauncherComponent, '.chat-launcher__pulse');
    expect(pulse.get('animation-name')).toBe('chat-pulse');
    expect(pulse.get('animation-duration')).toBe('1200ms');
    expect(pulse.get('animation-iteration-count')).toBe('3');
    expect(pulse.get('animation-delay')).toBe('0ms');
    expect(pulse.get('pointer-events')).toBe('none');
    expect(pulse.has('animation')).toBe(false);
    // The stylesheet and the reducer's timer agree on the 3,600 ms run (R24.1).
    expect(Number.parseFloat(pulse.get('animation-duration') ?? '')).toBe(ATTENTION_ITERATION_MS);
    expect(Number(pulse.get('animation-iteration-count'))).toBe(ATTENTION_ITERATIONS);

    const reduced = stylesFor(ChatLauncherComponent, '.chat-launcher__pulse', REDUCED_MOTION_MEDIA);
    expect(reduced.get('display')).toBe('none');
  });

  it('the Unread_Ring is an Inner_Band of --text-on-primary and an Outer_Band of --text-primary, each 2px', () => {
    const shadow = stylesFor(ChatLauncherComponent, '.chat-launcher--ring').get('box-shadow');
    expect(shadow).toBeDefined();
    const bands = ringBands(shadow ?? '');
    expect(bands.map((b) => b.token)).toEqual(['--text-on-primary', '--text-primary']);
    for (const band of bands) expect(band.thickness).toBeGreaterThanOrEqual(2);
    expect(bands.map((b) => b.thickness)).toEqual([2, 2]);
    const total = bands.reduce((sum, b) => sum + b.thickness, 0);
    expect(total).toBeGreaterThanOrEqual(4);
    expect(total).toBeLessThanOrEqual(7);
    // Static: no transition when the ring shows or hides (R24.7).
    expect(stylesFor(ChatLauncherComponent, '.chat-launcher').has('transition')).toBe(false);
    expect(stylesFor(ChatLauncherComponent, '.chat-launcher--ring').has('transition')).toBe(false);
  });

  it('the focus ring uses the same two tones, each at least 2px and within 7px (C11)', () => {
    const shadow = stylesFor(ChatLauncherComponent, '.chat-launcher:focus-visible').get('box-shadow');
    const bands = ringBands(shadow ?? '');
    expect(bands.map((b) => b.token)).toEqual(['--text-on-primary', '--text-primary']);
    for (const band of bands) expect(band.thickness).toBeGreaterThanOrEqual(2);
    expect(bands.reduce((sum, b) => sum + b.thickness, 0)).toBeLessThanOrEqual(7);
  });
});

// --- Contrast of the R24.5 pairs from styles.scss --------------------------------------------

/** The custom properties of the first `:root` block of `styles.scss`. */
function rootTokens(): Map<string, string> {
  const css = stripComments(readFileSync(STYLES_PATH, 'utf8'));
  const tokens = new Map<string, string>();
  for (const match of blockBody(css, /:root\s*\{/).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (!tokens.has(match[1])) tokens.set(match[1], match[2].trim());
  }
  return tokens;
}

function token(tokens: Map<string, string>, name: string): string {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`styles.scss declares no ${name}`);
  return value;
}

const gradientStops = (value: string): string[] =>
  [...value.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)].map((m) => m[0]);

/** A declared colour painted over an opaque `backdrop`: `rgba()` is alpha-composited. */
function over(value: string, backdrop: string): string {
  const rgba = /^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i.exec(value);
  if (rgba === null) return value;
  return mixColors(`rgb(${rgba[1]}, ${rgba[2]}, ${rgba[3]})`, backdrop, Number(rgba[4]));
}

describe('Unread_Ring contrast (R24.5, values from styles.scss)', () => {
  const tokens = rootTokens();
  const ring = stylesFor(ChatLauncherComponent, '.chat-launcher--ring').get('box-shadow') ?? '';
  const [innerToken, outerToken] = shadowLayers(ring).map((layer) => layer.token);
  const inner = token(tokens, innerToken);
  const outer = token(tokens, outerToken);
  const launcherStops = gradientStops(token(tokens, '--gradient-primary'));
  const pageStops = gradientStops(token(tokens, '--gradient-page-bg'));

  it('resolves the bands to #ffffff and #1a1a2e', () => {
    expect(inner.toLowerCase()).toBe('#ffffff');
    expect(outer.toLowerCase()).toBe('#1a1a2e');
    expect(launcherStops.map((s) => s.toLowerCase())).toEqual(['#667eea', '#764ba2']);
    expect(pageStops.map((s) => s.toLowerCase())).toEqual(['#1a1a2e', '#16213e', '#0f3460']);
  });

  it('(a) the Inner_Band reaches 3:1 against every point of --gradient-primary', () => {
    const [first, last] = launcherStops;
    expect(wcagContrastRatio(inner, first)).toBeCloseTo(3.66, 1);
    expect(wcagContrastRatio(inner, last)).toBeCloseTo(6.37, 1);
    for (let i = 0; i <= 20; i++) {
      const point = mixColors(last, first, i / 20);
      const ratio = wcagContrastRatio(inner, point);
      expect(ratio, `${inner} on ${point} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        WCAG_AA_NON_TEXT_CONTRAST,
      );
    }
  });

  it('(b) the Inner_Band reaches 3:1 against the Outer_Band', () => {
    const ratio = wcagContrastRatio(inner, outer);
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_CONTRAST);
    expect(ratio).toBeGreaterThan(16.5);
  });

  it('(c) the Outer_Band reaches 3:1 against every page background of luminance >= 0.135', () => {
    const backgrounds: { where: string; colour: string; minimum: number }[] = [
      { where: 'white dialogs and menus', colour: '#ffffff', minimum: WCAG_AA_NON_TEXT_CONTRAST },
      {
        where: '--color-primary-light',
        colour: token(tokens, '--color-primary-light'),
        minimum: WCAG_AA_NON_TEXT_CONTRAST,
      },
    ];
    const surfaces = [...tokens].filter(([name]) => name.startsWith('--surface-'));
    expect(surfaces.length).toBeGreaterThan(0);
    for (const [name, value] of surfaces) {
      for (const stop of pageStops) {
        // R24.5(c): every --surface-* token over --gradient-page-bg reaches at least 8:1.
        backgrounds.push({ where: `${name} over ${stop}`, colour: over(value, stop), minimum: 8 });
      }
    }
    for (const { where, colour, minimum } of backgrounds) {
      expect(relativeLuminance(colour), `${where} luminance`).toBeGreaterThanOrEqual(0.135);
      const ratio = wcagContrastRatio(outer, colour);
      expect(ratio, `${outer} on ${where} (${colour}) is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        minimum,
      );
    }
  });

  it('exempts only the dark --gradient-page-bg stops, where pairs (a) and (b) bound the ring', () => {
    for (const stop of pageStops) {
      expect(relativeLuminance(stop), `${stop} luminance`).toBeLessThan(0.135);
    }
    expect(wcagContrastRatio(inner, outer)).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_CONTRAST);
  });
});
