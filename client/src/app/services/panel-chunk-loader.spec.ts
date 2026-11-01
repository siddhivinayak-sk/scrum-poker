import { Component, Type, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { within } from '@testing-library/angular';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS,
  CHAT_PANEL_LOAD_RETRY_DELAYS_MS,
  ChatMessage,
  ChatMessageSendPayload,
  ConnectionState,
  User,
} from '@shared/types';
import { CHAT_TIMERS, ChatStore, ChatTimers } from './chat-store.service';
import { CHAT_READ_MARKER_STORE, ReadMarkerStore } from './chat-read-marker';
import { ChatTransport, PokerChatTransport } from './chat-transport';
import { PANEL_CHUNK_LOADER_DEPS, PanelChunkLoader, PanelChunkLoaderDeps } from './panel-chunk-loader';
import { ChatHostComponent } from '../components/chat/chat-host.component';
import { CHAT_LAUNCHER_LOADING_TEXT } from '../components/chat/chat-launcher.component';
import {
  CHAT_LOAD_ERROR_TEXT,
  ChatLoadErrorNoticeComponent,
} from '../components/chat/chat-load-error-notice.component';
// Specs are not bundled, so importing the Deferred chat chunk's entry here is fine.
import { ChatPanelComponent } from '../components/chat/chat-panel.component';

/**
 * Unit tests of the Panel_Chunk_Loader, the Chat_Launcher busy state and the
 * Chat_Load_Error_Notice (task 14.6; R22.18, R20.10, R20.11, R20.13–R20.18).
 *
 * - The loader tests drive the service alone with an injected importer, an injected `importUrl`
 *   and Vitest fake timers behind `PanelChunkLoaderTimers`.
 * - The host tests render `ChatHostComponent` with the real `ChatStore`, launcher, notice and
 *   `ChatPanelComponent` (handed out by the controlled importer) over a fake poker transport and a
 *   manual clock shared by the store and the loader.
 * - The notice's z-index and 44 px targets are read from its compiled stylesheet (`ɵcmp.styles`),
 *   because happy-dom does not compute component styles.
 */

const DELAYS = CHAT_PANEL_LOAD_RETRY_DELAYS_MS;
/** Initial attempt plus the automatic retries (R20.10). */
const ATTEMPTS_PER_SEQUENCE = DELAYS.length + 1;
const BASE_URL = 'https://example.test/base/chunk-IMPORTER.js';
/** The Chunk_URL resolved from the readable importer's specifier against `BASE_URL` (R20.13). */
const CHUNK_URL = 'https://example.test/base/chunk-ABC123.js';

class FakePanel {}

interface Deferred {
  readonly promise: Promise<Type<unknown>>;
  resolve(cls: Type<unknown>): void;
  reject(error: unknown): void;
}

function deferred(): Deferred {
  let resolve!: (cls: Type<unknown>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Type<unknown>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A real function whose source text holds a bundled-style `import("./chunk-ABC123.js")`, which
 * `resolveChunkUrl` reads, but which calls `next` instead (the `import()` is never evaluated).
 */
function readableImporter(next: () => Promise<Type<unknown>>): () => Promise<Type<unknown>> {
  return new Function('next', 'return () => (false && import("./chunk-ABC123.js"), next())')(next) as () => Promise<
    Type<unknown>
  >;
}

/** The `retry` query value of a Cache_Busted_Import URL. */
function retryOf(url: string): string | null {
  return new URL(url).searchParams.get('retry');
}

// =================================================================================================
// PanelChunkLoader alone (fake timers)
// =================================================================================================

/** One attempt as the loader made it: through the importer (`url === null`) or `importUrl`. */
interface LoaderAttempt {
  readonly url: string | null;
  readonly d: Deferred;
}

describe('PanelChunkLoader', () => {
  let importerCalls: Deferred[];
  let urlCalls: { url: string; d: Deferred }[];
  /** Every attempt in the order the loader started it. */
  let attempts: LoaderAttempt[];
  let idleCallbacks: (() => void)[];
  let opened: number;

  function setup(options: { readableSpecifier: boolean; idle: boolean }): PanelChunkLoader {
    importerCalls = [];
    urlCalls = [];
    attempts = [];
    idleCallbacks = [];
    opened = 0;
    const next = (): Promise<Type<unknown>> => {
      const d = deferred();
      importerCalls.push(d);
      attempts.push({ url: null, d });
      return d.promise;
    };
    // A `vi.fn` / plain arrow has no readable specifier, which selects the R20.18 fallback.
    const importer = options.readableSpecifier ? readableImporter(next) : vi.fn(next);
    const deps: PanelChunkLoaderDeps = {
      importer,
      baseUrl: BASE_URL,
      importUrl: vi.fn((url: string): Promise<Type<unknown>> => {
        const d = deferred();
        urlCalls.push({ url, d });
        attempts.push({ url, d });
        return d.promise;
      }),
      timers: {
        now: () => Date.now(),
        setTimeout: (callback: () => void, ms: number) => window.setTimeout(callback, ms),
        clearTimeout: (handle: number) => window.clearTimeout(handle),
      },
      requestIdle: options.idle ? (callback) => idleCallbacks.push(callback) : null,
    };
    TestBed.configureTestingModule({ providers: [{ provide: PANEL_CHUNK_LOADER_DEPS, useValue: deps }] });
    const loader = TestBed.inject(PanelChunkLoader);
    loader.opened.subscribe(() => (opened += 1));
    return loader;
  }

  const latest = (): LoaderAttempt => attempts[attempts.length - 1];

  /** Rejects the latest attempt of a running user-started sequence and waits out each retry delay. */
  async function failRemainingAttempts(loader: PanelChunkLoader, from: number): Promise<void> {
    for (let i = from; i < ATTEMPTS_PER_SEQUENCE; i++) {
      latest().d.reject(new Error('net'));
      await vi.advanceTimersByTimeAsync(0);
      if (i < DELAYS.length) {
        expect(loader.busy()).toBe(true);
        await vi.advanceTimersByTimeAsync(DELAYS[i]);
      }
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('opens on the first successful attempt and never loads again', async () => {
    const loader = setup({ readableSpecifier: true, idle: false });
    loader.requestOpen();
    expect(loader.busy()).toBe(true);
    loader.requestOpen();
    expect(importerCalls).toHaveLength(1);

    importerCalls[0].resolve(FakePanel);
    await vi.advanceTimersByTimeAsync(0);
    expect(loader.panelClass()).toBe(FakePanel);
    expect(loader.busy()).toBe(false);
    expect(opened).toBe(1);

    // Later activations open at once with no busy state and no request (R20.17).
    loader.requestOpen();
    expect(loader.busy()).toBe(false);
    expect(opened).toBe(2);
    expect(importerCalls).toHaveLength(1);
    expect(urlCalls).toHaveLength(0);
  });

  for (const n of [1, 2, 3]) {
    it(`opens on attempt ${n + 1} after ${n} failure(s), retrying exactly 1,000 / 2,000 / 4,000 ms after each failure`, async () => {
      const loader = setup({ readableSpecifier: true, idle: false });
      loader.requestOpen();

      for (let i = 0; i < n; i++) {
        // The delay counts from the failure, not from the attempt's start.
        await vi.advanceTimersByTimeAsync(300);
        latest().d.reject(new Error('net'));
        await vi.advanceTimersByTimeAsync(DELAYS[i] - 1);
        expect(attempts).toHaveLength(i + 1);
        expect(loader.busy()).toBe(true);
        expect(loader.errorShown()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(attempts).toHaveLength(i + 2);
        expect(latest().url).toBe(`${CHUNK_URL}?retry=${i + 1}`);
      }

      latest().d.resolve(FakePanel);
      await vi.advanceTimersByTimeAsync(0);
      expect(loader.panelClass()).toBe(FakePanel);
      expect(opened).toBe(1);
      expect(loader.busy()).toBe(false);
      expect(loader.errorShown()).toBe(false);

      // The sequence ended: no further attempt, ever.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toHaveLength(n + 1);
      expect(loader.errorShown()).toBe(false);
    });
  }

  it('shows the notice after 4 failed attempts; "Try again" runs a new Load_Sequence that opens', async () => {
    const loader = setup({ readableSpecifier: true, idle: false });
    loader.requestOpen();
    await failRemainingAttempts(loader, 0);

    expect(attempts).toHaveLength(ATTEMPTS_PER_SEQUENCE);
    expect(loader.busy()).toBe(false);
    expect(loader.errorShown()).toBe(true);
    expect(loader.panelClass()).toBeNull();
    expect(opened).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(ATTEMPTS_PER_SEQUENCE);

    // "Try again" calls requestOpen (see ChatLoadErrorNoticeComponent).
    loader.requestOpen();
    expect(loader.errorShown()).toBe(false);
    expect(loader.busy()).toBe(true);
    expect(attempts).toHaveLength(ATTEMPTS_PER_SEQUENCE + 1);
    expect(latest().url).toBe(`${CHUNK_URL}?retry=4`);

    latest().d.resolve(FakePanel);
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toBe(1);
    expect(loader.busy()).toBe(false);
    expect(loader.panelClass()).toBe(FakePanel);
  });

  it('uses a retry value different from every earlier one, also across Load_Sequences', async () => {
    const loader = setup({ readableSpecifier: true, idle: false });
    loader.requestOpen();
    await failRemainingAttempts(loader, 0);
    loader.requestOpen();
    await failRemainingAttempts(loader, 0);
    loader.requestOpen();
    latest().d.resolve(FakePanel);
    await vi.advanceTimersByTimeAsync(0);

    expect(attempts[0].url).toBeNull();
    const urls = attempts.slice(1).map((a) => a.url ?? '');
    expect(urls).toHaveLength(2 * ATTEMPTS_PER_SEQUENCE);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.map(retryOf)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    for (const url of urls) expect(url.split('?')[0]).toBe(CHUNK_URL);
    expect(opened).toBe(1);
  });

  it('counts an attempt that does not settle as failed after exactly 10,000 ms', async () => {
    expect(CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS).toBe(10_000);
    const loader = setup({ readableSpecifier: true, idle: false });
    loader.requestOpen();

    await vi.advanceTimersByTimeAsync(CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS - 1);
    await vi.advanceTimersByTimeAsync(DELAYS[0]);
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(2);
    expect(latest().url).toBe(`${CHUNK_URL}?retry=1`);

    // Every attempt hangs: the sequence ends after 4 timeouts and 3 waits.
    await vi.advanceTimersByTimeAsync(CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS + DELAYS[1]);
    await vi.advanceTimersByTimeAsync(CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS + DELAYS[2]);
    expect(attempts).toHaveLength(4);
    expect(loader.busy()).toBe(true);
    await vi.advanceTimersByTimeAsync(CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS - 1);
    expect(loader.errorShown()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(loader.busy()).toBe(false);
    expect(loader.errorShown()).toBe(true);
  });

  it('retries as Cache_Busted_Imports after 1,000 / 2,000 / 4,000 ms, then shows the notice; a late success hides it without opening (C15)', async () => {
    const loader = setup({ readableSpecifier: true, idle: false });
    loader.requestOpen();
    importerCalls[0].reject(new Error('net'));
    await vi.advanceTimersByTimeAsync(999);
    expect(urlCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(urlCalls.map((c) => c.url)).toEqual([`${CHUNK_URL}?retry=1`]);

    // Attempt 2 times out; attempt 3 starts 2,000 ms later.
    await vi.advanceTimersByTimeAsync(CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS + 2000);
    expect(urlCalls).toHaveLength(2);
    urlCalls[1].d.reject(new Error('net'));
    await vi.advanceTimersByTimeAsync(4000);
    expect(urlCalls).toHaveLength(3);
    urlCalls[2].d.reject(new Error('net'));
    await vi.advanceTimersByTimeAsync(0);

    expect(urlCalls.map((c) => c.url.split('?')[1])).toEqual(['retry=1', 'retry=2', 'retry=3']);
    expect(loader.busy()).toBe(false);
    expect(loader.errorShown()).toBe(true);
    expect(opened).toBe(0);

    // The timed-out attempt 2 resolves late.
    urlCalls[0].d.resolve(FakePanel);
    await vi.advanceTimersByTimeAsync(0);
    expect(loader.panelClass()).toBe(FakePanel);
    expect(loader.errorShown()).toBe(false);
    expect(opened).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(urlCalls).toHaveLength(3);
  });

  it('uses a timed-out attempt that settles late while the sequence still runs, and opens', async () => {
    const loader = setup({ readableSpecifier: true, idle: false });
    loader.requestOpen();
    await vi.advanceTimersByTimeAsync(CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS + DELAYS[0]);
    expect(attempts).toHaveLength(2);

    attempts[0].d.resolve(FakePanel);
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toBe(1);
    expect(loader.busy()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(2);
  });

  it('fails a silent idle prefetch and starts the next activation with a Cache_Busted_Import', async () => {
    const loader = setup({ readableSpecifier: true, idle: true });
    loader.prefetchWhenIdle();
    idleCallbacks[0]();
    expect(loader.busy()).toBe(false);
    importerCalls[0].reject(new Error('net'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(1);
    expect(loader.busy()).toBe(false);
    expect(loader.errorShown()).toBe(false);

    loader.requestOpen();
    expect(loader.busy()).toBe(true);
    expect(importerCalls).toHaveLength(1);
    expect(urlCalls.map((c) => c.url)).toEqual([`${CHUNK_URL}?retry=1`]);
    urlCalls[0].d.resolve(FakePanel);
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toBe(1);
    expect(loader.busy()).toBe(false);
  });

  it('fails a silent idle prefetch that times out, with no retry and no notice', async () => {
    const loader = setup({ readableSpecifier: true, idle: true });
    loader.prefetchWhenIdle();
    idleCallbacks[0]();
    await vi.advanceTimersByTimeAsync(CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS + 60_000);
    expect(attempts).toHaveLength(1);
    expect(loader.errorShown()).toBe(false);
    expect(loader.busy()).toBe(false);
  });

  it('falls back to the importer when the specifier is unreadable (R20.18)', async () => {
    const loader = setup({ readableSpecifier: false, idle: true });
    loader.prefetchWhenIdle();
    loader.prefetchWhenIdle();
    expect(idleCallbacks).toHaveLength(1);
    idleCallbacks[0]();
    expect(loader.busy()).toBe(false);
    importerCalls[0].reject(new Error('net'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(importerCalls).toHaveLength(1);
    expect(loader.errorShown()).toBe(false);

    loader.requestOpen();
    expect(importerCalls).toHaveLength(2);
    expect(urlCalls).toHaveLength(0);
    importerCalls[1].resolve(FakePanel);
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toBe(1);
  });

  it('keeps the timing, busy state and notice when every retry calls the importer unchanged (R20.18)', async () => {
    const loader = setup({ readableSpecifier: false, idle: false });
    loader.requestOpen();
    for (let i = 0; i < DELAYS.length; i++) {
      latest().d.reject(new Error('net'));
      await vi.advanceTimersByTimeAsync(DELAYS[i] - 1);
      expect(attempts).toHaveLength(i + 1);
      expect(loader.busy()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(i + 2);
    }
    latest().d.reject(new Error('net'));
    await vi.advanceTimersByTimeAsync(0);

    expect(importerCalls).toHaveLength(ATTEMPTS_PER_SEQUENCE);
    expect(urlCalls).toHaveLength(0);
    expect(loader.busy()).toBe(false);
    expect(loader.errorShown()).toBe(true);

    loader.requestOpen();
    expect(importerCalls).toHaveLength(ATTEMPTS_PER_SEQUENCE + 1);
    latest().d.resolve(FakePanel);
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toBe(1);
    expect(urlCalls).toHaveLength(0);
  });

  it('starts no extra attempt on a second activation, during an attempt or a wait', async () => {
    const loader = setup({ readableSpecifier: true, idle: false });
    loader.requestOpen();
    loader.requestOpen();
    expect(attempts).toHaveLength(1);

    latest().d.reject(new Error('net'));
    await vi.advanceTimersByTimeAsync(500);
    loader.requestOpen();
    expect(attempts).toHaveLength(1);
    expect(loader.busy()).toBe(true);
    // The wait is neither restarted nor shortened.
    await vi.advanceTimersByTimeAsync(DELAYS[0] - 501);
    expect(attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveLength(2);

    loader.requestOpen();
    expect(attempts).toHaveLength(2);
    latest().d.resolve(FakePanel);
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toBe(1);
  });

  it('adopts a running idle prefetch as the initial attempt', async () => {
    const loader = setup({ readableSpecifier: true, idle: true });
    loader.prefetchWhenIdle();
    idleCallbacks[0]();
    loader.requestOpen();
    expect(loader.busy()).toBe(true);
    expect(importerCalls).toHaveLength(1);
    importerCalls[0].reject(new Error('net'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(urlCalls).toHaveLength(1);
    urlCalls[0].d.resolve(FakePanel);
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toBe(1);
    expect(loader.busy()).toBe(false);
  });

  it('"Dismiss" hides the notice and starts nothing', async () => {
    const loader = setup({ readableSpecifier: true, idle: false });
    loader.requestOpen();
    await failRemainingAttempts(loader, 0);
    expect(loader.errorShown()).toBe(true);

    loader.dismissError();
    expect(loader.errorShown()).toBe(false);
    expect(loader.busy()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempts).toHaveLength(ATTEMPTS_PER_SEQUENCE);
  });
});

// =================================================================================================
// Host, launcher and notice (manual clock, real panel)
// =================================================================================================

/** Manual clock: timers fire only through `advance`. Shared by the store and the loader. */
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
    const target = this.time + ms;
    for (;;) {
      const due = [...this.pending]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.pending.delete(due[0]);
      this.time = due[1].at;
      due[1].callback();
    }
    this.time = target;
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
  send(_payload: ChatMessageSendPayload): boolean {
    return true;
  }
}

/** The Deferred chat chunk as the loader sees it: every attempt waits for the test to settle it. */
class ChunkSource {
  readonly attempts: { readonly url: string | null; readonly d: Deferred }[] = [];
  readonly importer = readableImporter(() => this.push(null));
  readonly importUrl = (url: string): Promise<Type<unknown>> => this.push(url);
  latest(): { readonly url: string | null; readonly d: Deferred } {
    return this.attempts[this.attempts.length - 1];
  }
  private push(url: string | null): Promise<Type<unknown>> {
    const d = deferred();
    this.attempts.push({ url, d });
    return d.promise;
  }
}

@Component({
  imports: [ChatHostComponent],
  template: `<app-chat-host boardKind="poker" [sessionId]="'s1'" />`,
})
class PokerPageComponent {}

function message(seq: number): ChatMessage {
  return {
    id: `10000000-0000-4000-8000-${seq.toString().padStart(12, '0')}`,
    seq,
    clientMessageId: `20000000-0000-4000-8000-${seq.toString().padStart(12, '0')}`,
    authorId: 'other',
    authorName: 'Other Person',
    text: `while loading ${seq}`,
    sentAt: new Date(1_000_000 + seq).toISOString(),
  };
}

const windows = (): Window[] => {
  const view = document.defaultView;
  return view !== null && view !== window ? [window, view] : [window];
};

/** Wide viewport: neither the narrow query nor reduced motion matches. */
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

function setupHost() {
  const timers = new ManualTimers();
  const source = new ChunkSource();
  const transport = new FakeTransport();
  TestBed.configureTestingModule({
    providers: [
      { provide: PokerChatTransport, useValue: transport },
      { provide: CHAT_TIMERS, useValue: timers },
      { provide: CHAT_READ_MARKER_STORE, useValue: new ReadMarkerStore(() => null) },
      {
        provide: PANEL_CHUNK_LOADER_DEPS,
        useValue: {
          importer: source.importer,
          baseUrl: BASE_URL,
          importUrl: source.importUrl,
          timers,
          requestIdle: null,
        } satisfies PanelChunkLoaderDeps,
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
  const store = hostDebug.injector.get(ChatStore);
  const loader = TestBed.inject(PanelChunkLoader);
  const root = fixture.nativeElement as HTMLElement;
  const launcher = (): HTMLButtonElement => {
    const el = root.querySelector<HTMLButtonElement>('button.chat-launcher');
    if (el === null) throw new Error('Chat_Launcher not rendered');
    return el;
  };
  const notice = (): HTMLElement | null => root.querySelector<HTMLElement>('app-chat-load-error-notice');
  const noticeButton = (name: string): HTMLButtonElement => {
    const el = notice();
    if (el === null) throw new Error('Chat_Load_Error_Notice not rendered');
    return within(el).getByRole('button', { name }) as HTMLButtonElement;
  };
  const dialog = (): HTMLElement | null => root.querySelector<HTMLElement>('[role="dialog"]');
  /** Lets the importer promises settle, then renders. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    flush();
  };
  const advance = (ms: number): void => {
    timers.advance(ms);
    flush();
  };
  /** Pushes a confirmed Chat_Message from another participant on the added event. */
  const deliver = (seq: number): void => {
    transport.added$.next({ message: message(seq) });
    flush();
  };
  /** The launcher shows the busy state of R20.11. */
  const expectBusy = (busy: boolean): void => {
    if (busy) {
      expect(launcher().getAttribute('aria-busy')).toBe('true');
      expect(launcher().textContent).toContain(CHAT_LAUNCHER_LOADING_TEXT);
    } else {
      expect(launcher().hasAttribute('aria-busy')).toBe(false);
      expect(launcher().textContent).not.toContain(CHAT_LAUNCHER_LOADING_TEXT);
    }
  };
  /**
   * Fails all 4 attempts of the running sequence, waiting out each delay and checking the busy
   * state in its middle; calls `duringWait(i)` there for the i-th wait.
   */
  const failSequence = async (duringWait: (i: number) => void = () => undefined): Promise<void> => {
    for (let i = 0; i < ATTEMPTS_PER_SEQUENCE; i++) {
      source.latest().d.reject(new Error('chunk failed'));
      await settle();
      if (i < DELAYS.length) {
        advance(DELAYS[i] / 2);
        expectBusy(true);
        duringWait(i);
        advance(DELAYS[i] / 2);
      }
    }
  };
  return {
    fixture,
    flush,
    settle,
    advance,
    deliver,
    expectBusy,
    failSequence,
    store,
    loader,
    root,
    launcher,
    notice,
    noticeButton,
    dialog,
    timers,
    source,
    transport,
  };
}

describe('PanelChunkLoader with the Chat_Launcher and the Chat_Load_Error_Notice', () => {
  let originalMatchMedia: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    installMatchMedia();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    for (const win of windows()) {
      if (originalMatchMedia) Object.defineProperty(win, 'matchMedia', originalMatchMedia);
      else Reflect.deleteProperty(win, 'matchMedia');
    }
    document.documentElement.style.overflow = '';
  });

  it('shows aria-busy and "Loading chat…" during attempts and waits, ignores a second activation, and opens with no busy state', async () => {
    const h = setupHost();
    expect(CHAT_LAUNCHER_LOADING_TEXT).toBe('Loading chat…');
    h.expectBusy(false);

    h.launcher().click();
    h.flush();
    h.expectBusy(true);
    expect(h.source.attempts).toHaveLength(1);

    h.source.latest().d.reject(new Error('chunk failed'));
    await h.settle();
    h.advance(DELAYS[0] - 1);
    h.expectBusy(true);
    // The launcher stays operable; activating it starts nothing new.
    expect(h.launcher().disabled).toBe(false);
    h.launcher().click();
    h.flush();
    expect(h.source.attempts).toHaveLength(1);

    h.advance(1);
    expect(h.source.attempts).toHaveLength(2);
    expect(h.source.latest().url).toBe(`${CHUNK_URL}?retry=1`);
    h.launcher().click();
    h.flush();
    expect(h.source.attempts).toHaveLength(2);
    expect(h.store.panelState()).toBe('closed');

    h.source.latest().d.resolve(ChatPanelComponent);
    await h.settle();
    expect(h.store.panelState()).toBe('open');
    expect(h.dialog()).not.toBeNull();
    h.expectBusy(false);
    expect(h.notice()).toBeNull();

    // Close and reopen: no busy state and no further request (R20.17).
    h.launcher().click();
    h.flush();
    expect(h.store.panelState()).toBe('closed');
    h.launcher().click();
    h.flush();
    expect(h.store.panelState()).toBe('open');
    h.expectBusy(false);
    expect(h.source.attempts).toHaveLength(2);
  });

  it('keeps the panel closed and shows the notice after 4 failures; "Try again" opens it without a reload', async () => {
    const h = setupHost();
    h.launcher().click();
    h.flush();
    await h.failSequence();

    expect(h.source.attempts).toHaveLength(ATTEMPTS_PER_SEQUENCE);
    expect(h.store.panelState()).toBe('closed');
    expect(h.dialog()).toBeNull();
    h.expectBusy(false);
    expect(h.launcher().disabled).toBe(false);
    expect(h.notice()).not.toBeNull();

    h.noticeButton('Try again').click();
    h.flush();
    expect(h.notice()).toBeNull();
    h.expectBusy(true);
    expect(h.source.attempts).toHaveLength(ATTEMPTS_PER_SEQUENCE + 1);
    expect(h.source.latest().url).toBe(`${CHUNK_URL}?retry=${ATTEMPTS_PER_SEQUENCE}`);

    h.source.latest().d.resolve(ChatPanelComponent);
    await h.settle();
    expect(h.store.panelState()).toBe('open');
    expect(h.dialog()).not.toBeNull();
    h.expectBusy(false);
  });

  it('activating the launcher while the notice is shown hides it and starts a new Load_Sequence', async () => {
    const h = setupHost();
    h.launcher().click();
    h.flush();
    await h.failSequence();
    expect(h.notice()).not.toBeNull();

    h.launcher().click();
    h.flush();
    expect(h.notice()).toBeNull();
    h.expectBusy(true);
    expect(h.source.attempts).toHaveLength(ATTEMPTS_PER_SEQUENCE + 1);
  });

  it('"Dismiss" hides the notice, returns focus to the launcher and starts no Load_Sequence', async () => {
    const h = setupHost();
    h.launcher().click();
    h.flush();
    await h.failSequence();

    const dismiss = h.noticeButton('Dismiss');
    dismiss.focus();
    expect(document.activeElement).toBe(dismiss);
    dismiss.click();
    h.flush();

    expect(h.notice()).toBeNull();
    expect(document.activeElement).toBe(h.launcher());
    h.expectBusy(false);
    h.advance(60_000);
    expect(h.source.attempts).toHaveLength(ATTEMPTS_PER_SEQUENCE);
    expect(h.store.panelState()).toBe('closed');
  });

  it('counts and shows Chat_Messages delivered during and after a failed Load_Sequence once the panel opens', async () => {
    const h = setupHost();
    h.launcher().click();
    h.flush();
    h.deliver(1);
    await h.failSequence((i) => h.deliver(i + 2));
    // Messages 1 to 4 arrived during the sequence; 5 and 6 after it failed.
    h.deliver(5);
    h.deliver(6);

    expect(h.notice()).not.toBeNull();
    expect(h.store.unreadCount()).toBe(6);
    expect(h.launcher().getAttribute('aria-label')).toBe('Open chat, 6 unread messages');
    expect(h.launcher().querySelector('.chat-launcher__badge')?.textContent?.trim()).toBe('6');

    h.noticeButton('Try again').click();
    h.flush();
    h.deliver(7);
    expect(h.launcher().getAttribute('aria-label')).toBe('Open chat, 7 unread messages');
    h.source.latest().d.resolve(ChatPanelComponent);
    await h.settle();

    const dialog = h.dialog();
    expect(dialog).not.toBeNull();
    const log = dialog?.querySelector<HTMLElement>('[role="log"]');
    expect(log).not.toBeNull();
    for (let seq = 1; seq <= 7; seq++) {
      expect(log?.textContent).toContain(`while loading ${seq}`);
    }
  });

  it('renders the notice text in a role="alert" element with native "Try again" and "Dismiss" buttons', async () => {
    const h = setupHost();
    h.launcher().click();
    h.flush();
    await h.failSequence();

    const notice = h.notice();
    if (notice === null) throw new Error('Chat_Load_Error_Notice not rendered');
    const alert = within(notice).getByRole('alert');
    expect(alert.textContent?.trim()).toBe(CHAT_LOAD_ERROR_TEXT);
    expect(CHAT_LOAD_ERROR_TEXT).toBe('Chat could not be loaded.');
    for (const name of ['Try again', 'Dismiss']) {
      const button = h.noticeButton(name);
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('type')).toBe('button');
      expect(button.classList.contains('chat-load-error__button')).toBe(true);
    }
    expect(within(notice).getAllByRole('button')).toHaveLength(2);
    // The host element is the fixed box styled by the `:host` rule.
    expect(notice.getAttributeNames().some((name) => name.startsWith('_nghost-'))).toBe(true);
  });
});

// =================================================================================================
// Notice stylesheet (compiled component styles)
// =================================================================================================

interface StyledComponentType {
  readonly ɵcmp?: { readonly styles?: readonly string[] };
}

/** Top-level rules of the notice's compiled stylesheet (outside `@media`), as selector → body. */
function noticeRules(): { selector: string; body: string }[] {
  const css = ((ChatLoadErrorNoticeComponent as unknown as StyledComponentType).ɵcmp?.styles ?? [])
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const rules: { selector: string; body: string }[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ selector: match[1].trim(), body: match[2].replace(/\s+/g, ' ').trim() });
  }
  return rules;
}

function declarationsOf(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon > 0) map.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
  }
  return map;
}

describe('Chat_Load_Error_Notice stylesheet', () => {
  it('is a fixed box with z-index 920', () => {
    const host = noticeRules().filter((r) => /^\[_nghost-[^\]]*\]$/.test(r.selector));
    expect(host).toHaveLength(1);
    const decl = declarationsOf(host[0].body);
    expect(decl.get('position')).toBe('fixed');
    expect(decl.get('z-index')).toBe('920');
  });

  it('gives both buttons a target of at least 44 × 44 px', () => {
    const rules = noticeRules();
    const button = rules.filter((r) => /^\.chat-load-error__button\[_ngcontent-[^\]]*\]$/.test(r.selector));
    expect(button).toHaveLength(1);
    const decl = declarationsOf(button[0].body);
    expect(decl.get('min-width')).toBe('44px');
    expect(decl.get('min-height')).toBe('44px');
    expect(decl.get('box-sizing')).toBe('border-box');
    // No other rule shrinks the buttons.
    for (const rule of rules) {
      if (rule === button[0]) continue;
      const other = declarationsOf(rule.body);
      if (rule.selector.includes('chat-load-error__button')) {
        expect(other.has('min-width')).toBe(false);
        expect(other.has('min-height')).toBe(false);
        expect(other.has('width')).toBe(false);
        expect(other.has('height')).toBe(false);
      }
    }
  });
});
