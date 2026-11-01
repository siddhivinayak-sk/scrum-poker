import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Component, Type, inject, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Subject } from 'rxjs';
import { BoardKind, ChatMessageSendPayload, ConnectionState, User } from '@shared/types';
import { BoardOverlayLayoutService } from '../../services/board-overlay-layout.service';
import { CHAT_TIMERS, ChatStore, ChatTimers } from '../../services/chat-store.service';
import { CHAT_READ_MARKER_STORE, ReadMarkerStore } from '../../services/chat-read-marker';
import { ChatTransport, PokerChatTransport, RetroChatTransport } from '../../services/chat-transport';
import { PANEL_CHUNK_LOADER_DEPS, PanelChunkLoader } from '../../services/panel-chunk-loader';
import { CHAT_NARROW_QUERY, chatPanelId } from './chat-format';
import { ChatHostComponent } from './chat-host.component';

/**
 * Smoke tests of the ChatHost wiring (task 14.2). The full host and page-wiring spec is
 * `chat-host.component.spec.ts` (task 14.7). The store and loader run for real over fake
 * transports, a manual clock and a controllable importer; the panel is a stub class handed out
 * by the importer, as the real one is only reachable through the Deferred chat chunk.
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

/** Stand-in for the Chat_Panel: the same id, a close control, and the host's store. */
@Component({
  selector: 'app-stub-chat-panel',
  template: `
    <section class="stub-panel" [id]="id">
      <button type="button" class="stub-panel__close" (click)="close()">Close chat</button>
    </section>
  `,
})
class StubPanelComponent {
  readonly store = inject(ChatStore);
  protected readonly id = chatPanelId(this.store.boardKind);
  close(): void {
    this.store.panelState.set('closed');
  }
}

@Component({
  imports: [ChatHostComponent],
  template: `
    @if (found()) {
      <app-chat-host boardKind="poker" [sessionId]="sessionId()" />
    }
  `,
})
class PokerPageComponent {
  readonly sessionId = signal('s1');
  /** Stands in for the page's session-found branch. */
  readonly found = signal(true);
}

@Component({
  imports: [ChatHostComponent],
  template: `<app-chat-host boardKind="retro" [sessionId]="sessionId()" />`,
})
class RetroPageComponent {
  readonly sessionId = signal('r1');
}

/** A promise per importer call, settled by the test. */
class ControlledImporter {
  readonly calls: { resolve(cls: Type<unknown>): void; reject(error: unknown): void }[] = [];
  readonly importer = (): Promise<Type<unknown>> =>
    new Promise<Type<unknown>>((resolve, reject) => this.calls.push({ resolve, reject }));
}

const windows = (): Window[] => {
  const view = document.defaultView;
  return view !== null && view !== window ? [window, view] : [window];
};

function installMatchMedia(narrow: boolean): void {
  const list = (media: string) => ({
    matches: media === CHAT_NARROW_QUERY ? narrow : false,
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
  installMatchMedia(false);
});

afterEach(() => {
  for (const win of windows()) {
    if (originalMatchMedia) Object.defineProperty(win, 'matchMedia', originalMatchMedia);
    else Reflect.deleteProperty(win, 'matchMedia');
  }
  document.documentElement.style.overflow = '';
});

function setup<T>(page: Type<T>, options: { narrow?: boolean } = {}) {
  if (options.narrow === true) installMatchMedia(true);
  const timers = new ManualTimers();
  const importer = new ControlledImporter();
  const poker = new FakeTransport('poker');
  const retro = new FakeTransport('retro');
  TestBed.configureTestingModule({
    providers: [
      { provide: PokerChatTransport, useValue: poker },
      { provide: RetroChatTransport, useValue: retro },
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
  const fixture: ComponentFixture<T> = TestBed.createComponent(page);
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
  /** Lets the importer promises settle, then renders. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    flush();
  };
  return { fixture, flush, settle, host, store, root, launcher, timers, importer, poker, retro };
}

describe('ChatHostComponent (smoke)', () => {
  it('binds the poker transport, starts closed and resets the store on a sessionId change', () => {
    const h = setup(PokerPageComponent);
    expect(h.store.boardKind).toBe('poker');
    expect(h.launcher().getAttribute('aria-controls')).toBe('chat-panel-poker');
    expect(h.store.panelState()).toBe('closed');
    expect(h.store.sessionId()).toBe('s1');
    expect(h.root.querySelector('.stub-panel')).toBeNull();

    h.store.draft.set('half-written');
    (h.fixture.componentInstance as PokerPageComponent).sessionId.set('s2');
    h.flush();
    expect(h.store.sessionId()).toBe('s2');
    expect(h.store.draft()).toBe('');
  });

  it('binds the retro transport from boardKind="retro"', () => {
    const h = setup(RetroPageComponent);
    expect(h.store.boardKind).toBe('retro');
    expect(h.launcher().getAttribute('aria-controls')).toBe('chat-panel-retro');
    expect(h.store.sessionId()).toBe('r1');
  });

  it('loads on the first activation, ignores activations while busy, then toggles on wide', async () => {
    const h = setup(PokerPageComponent);
    h.launcher().click();
    h.flush();
    expect(TestBed.inject(PanelChunkLoader).busy()).toBe(true);
    expect(h.launcher().getAttribute('aria-busy')).toBe('true');
    h.launcher().click();
    expect(h.importer.calls).toHaveLength(1);
    expect(h.store.panelState()).toBe('closed');

    h.importer.calls[0].resolve(StubPanelComponent);
    await h.settle();
    expect(h.store.panelState()).toBe('open');
    const panel = h.root.querySelector('app-chat-host .stub-panel');
    expect(panel?.id).toBe('chat-panel-poker');

    h.launcher().click();
    h.flush();
    expect(h.store.panelState()).toBe('closed');
    expect(h.root.querySelector('.stub-panel')).toBeNull();

    // Later activations open at once, with no busy state and no new request (R20.17).
    h.launcher().click();
    h.flush();
    expect(h.store.panelState()).toBe('open');
    expect(h.launcher().hasAttribute('aria-busy')).toBe(false);
    expect(h.importer.calls).toHaveLength(1);

    h.store.panelState.set('minimized');
    h.flush();
    h.launcher().click();
    h.flush();
    expect(h.store.panelState()).toBe('open');
  });

  it('returns focus to the launcher when the panel closes', async () => {
    const h = setup(PokerPageComponent);
    h.launcher().click();
    h.importer.calls[0].resolve(StubPanelComponent);
    await h.settle();
    const close = h.root.querySelector<HTMLButtonElement>('.stub-panel__close');
    close?.focus();
    expect(document.activeElement).toBe(close);

    close?.click();
    h.flush();
    expect(h.store.panelState()).toBe('closed');
    expect(document.activeElement).toBe(h.launcher());
  });

  it('shows the notice after a failed Load_Sequence and focuses the launcher on Dismiss', async () => {
    const h = setup(PokerPageComponent);
    h.launcher().click();
    for (const delay of [1000, 2000, 4000]) {
      h.importer.calls[h.importer.calls.length - 1].reject(new Error('chunk failed'));
      await h.settle();
      h.timers.advance(delay);
    }
    h.importer.calls[h.importer.calls.length - 1].reject(new Error('chunk failed'));
    await h.settle();
    expect(h.importer.calls).toHaveLength(4);
    expect(h.store.panelState()).toBe('closed');
    const notice = h.root.querySelector('app-chat-load-error-notice');
    expect(notice?.querySelector('[role="alert"]')?.textContent).toContain('Chat could not be loaded.');

    const dismiss = Array.from(notice?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent?.trim() === 'Dismiss',
    );
    dismiss?.click();
    h.flush();
    expect(h.root.querySelector('app-chat-load-error-notice')).toBeNull();
    expect(document.activeElement).toBe(h.launcher());
  });

  it('locks page scrolling while open on narrow, publishes the minimized dock top, and restores both', async () => {
    document.documentElement.style.overflow = 'auto';
    const h = setup(PokerPageComponent, { narrow: true });
    const layout = TestBed.inject(BoardOverlayLayoutService);
    h.launcher().click();
    h.importer.calls[0].resolve(StubPanelComponent);
    await h.settle();
    expect(h.store.panelState()).toBe('open');
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(layout.chatDockTopPx()).toBeNull();

    // The launcher is hidden while narrow and open; an activation does nothing (R4.4).
    h.host.toggleFromLauncher();
    h.flush();
    expect(h.store.panelState()).toBe('open');

    h.store.panelState.set('minimized');
    h.flush();
    expect(document.documentElement.style.overflow).toBe('auto');
    expect(layout.chatDockTopPx()).not.toBeNull();

    h.store.panelState.set('closed');
    h.flush();
    expect(layout.chatDockTopPx()).toBeNull();
  });

  it('removes the chat and releases the scroll lock when the host is destroyed while open', async () => {
    const h = setup(PokerPageComponent, { narrow: true });
    h.launcher().click();
    h.importer.calls[0].resolve(StubPanelComponent);
    await h.settle();
    expect(document.documentElement.style.overflow).toBe('hidden');

    (h.fixture.componentInstance as PokerPageComponent).found.set(false);
    h.flush();
    expect(document.documentElement.style.overflow).toBe('');
    expect(h.root.querySelector('.chat-launcher')).toBeNull();
    expect(h.root.querySelector('.stub-panel')).toBeNull();
  });
});
