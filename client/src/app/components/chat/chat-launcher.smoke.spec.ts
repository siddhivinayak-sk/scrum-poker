import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Type, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render, screen } from '@testing-library/angular';
import { Subject } from 'rxjs';
import { ChatMessage, ChatMessageSendPayload, ConnectionState, User } from '@shared/types';
import { CHAT_TIMERS, ChatStore, ChatTimers } from '../../services/chat-store.service';
import { CHAT_READ_MARKER_STORE, ReadMarkerStore } from '../../services/chat-read-marker';
import { CHAT_TRANSPORT, ChatTransport } from '../../services/chat-transport';
import { PANEL_CHUNK_LOADER_DEPS, PanelChunkLoader } from '../../services/panel-chunk-loader';
import { ATTENTION_DURATION_MS } from './chat-attention';
import { ChatLauncherComponent } from './chat-launcher.component';

/**
 * Smoke tests of the Chat_Launcher wiring (task 14.1). The full launcher spec, with the toggle
 * rules, the R22.14 clock scenarios and the stylesheet scans, is `chat-launcher.component.spec.ts`
 * (task 14.5). The store runs for real over a fake transport and a manual clock.
 */

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
  readonly boardKind = 'retro' as const;
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

function message(seq: number): ChatMessage {
  return {
    id: `10000000-0000-4000-8000-${seq.toString().padStart(12, '0')}`,
    seq,
    clientMessageId: `20000000-0000-4000-8000-${seq.toString().padStart(12, '0')}`,
    authorId: 'other',
    authorName: 'Other Person',
    text: `text ${seq}`,
    sentAt: new Date(1_000_000 + seq).toISOString(),
  };
}

const windows = (): Window[] => {
  const view = document.defaultView;
  return view !== null && view !== window ? [window, view] : [window];
};

/** Wide viewport, no reduced motion: every query is unmatched and never changes. */
function installMatchMedia(): void {
  const list = (media: string) => ({
    matches: false,
    media,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  });
  for (const win of windows()) {
    Object.defineProperty(win, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (media: string) => list(media),
    });
  }
}

let originalMatchMedia: PropertyDescriptor | undefined;

beforeEach(() => {
  originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  installMatchMedia();
});

afterEach(() => {
  for (const win of windows()) {
    if (originalMatchMedia) Object.defineProperty(win, 'matchMedia', originalMatchMedia);
    else Reflect.deleteProperty(win, 'matchMedia');
  }
});

async function setup() {
  const transport = new FakeTransport();
  const timers = new ManualTimers();
  const { fixture } = await render(ChatLauncherComponent, {
    providers: [
      ChatStore,
      { provide: CHAT_TRANSPORT, useValue: transport },
      { provide: CHAT_TIMERS, useValue: timers },
      {
        provide: CHAT_READ_MARKER_STORE,
        useValue: new ReadMarkerStore(() => null),
      },
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
    ],
  });
  const store = TestBed.inject(ChatStore);
  store.reset('s1');
  const flush = (): void => {
    TestBed.tick();
    fixture.detectChanges();
  };
  flush();
  const launcher = (): HTMLButtonElement => screen.getByRole('button', { hidden: true });
  const pulses = (): NodeListOf<Element> =>
    fixture.nativeElement.querySelectorAll('.chat-launcher__pulse');
  return { transport, timers, store, fixture, flush, launcher, pulses };
}

describe('ChatLauncherComponent (smoke)', () => {
  it('renders a native button wired to the panel, closed and without a badge', async () => {
    const h = await setup();
    const button = h.launcher();
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-controls')).toBe('chat-panel-retro');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Open chat');
    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(h.fixture.nativeElement.querySelector('.chat-launcher__badge')).toBeNull();
    expect(button.classList.contains('chat-launcher--ring')).toBe(false);
  });

  it('shows the badge, ring and pulse on an Unread_Increase and ends the pulse after 3,600 ms', async () => {
    const h = await setup();
    h.transport.added$.next({ message: message(1) });
    h.flush();

    const button = h.launcher();
    expect(button.getAttribute('aria-label')).toBe('Open chat, 1 unread message');
    const badge = h.fixture.nativeElement.querySelector('.chat-launcher__badge') as HTMLElement;
    expect(badge.textContent?.trim()).toBe('1');
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(button.classList.contains('chat-launcher--ring')).toBe(true);
    expect(h.pulses()).toHaveLength(1);
    expect(h.pulses()[0].getAttribute('aria-hidden')).toBe('true');

    h.timers.advance(ATTENTION_DURATION_MS - 1);
    h.flush();
    expect(h.pulses()).toHaveLength(1);
    h.timers.advance(1);
    h.flush();
    expect(h.pulses()).toHaveLength(0);
    expect(button.classList.contains('chat-launcher--ring')).toBe(true);
  });

  it('re-keys the pulse on a second increase and removes it when the panel opens', async () => {
    const h = await setup();
    h.transport.added$.next({ message: message(1) });
    h.flush();
    const first = h.pulses()[0];

    h.timers.advance(1000);
    h.transport.added$.next({ message: message(2) });
    h.flush();
    expect(h.pulses()).toHaveLength(1);
    expect(h.pulses()[0]).not.toBe(first);

    h.store.panelState.set('open');
    h.flush();
    expect(h.pulses()).toHaveLength(0);
    expect(h.launcher().getAttribute('aria-expanded')).toBe('true');
  });

  it('is busy with "Loading chat…" while a Load_Sequence runs and emits on every activation', async () => {
    const h = await setup();
    let activations = 0;
    h.fixture.componentInstance.activated.subscribe(() => activations++);

    TestBed.inject(PanelChunkLoader).requestOpen();
    h.flush();
    const button = h.launcher();
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toContain('Loading chat…');

    button.click();
    button.click();
    expect(activations).toBe(2);
  });

  it('focus() moves keyboard focus to the button', async () => {
    const h = await setup();
    h.fixture.componentInstance.focus();
    expect(document.activeElement).toBe(h.launcher());
  });
});
