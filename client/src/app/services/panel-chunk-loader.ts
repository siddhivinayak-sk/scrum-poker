import { Injectable, InjectionToken, Signal, Type, inject, signal } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS, CHAT_PANEL_LOAD_RETRY_DELAYS_MS } from '@shared/types';
import {
  CHAT_PANEL_IMPORTER_BASE_URL,
  importChatPanel,
} from '../components/chat/chat-panel-importer';
import { resolveChunkUrl, withRetryParam } from './chunk-url';

/**
 * Loader of the Deferred chat chunk (design "PanelChunkLoader", D7, D12, C12, C15;
 * R20.4, R20.10–R20.18).
 *
 * A Load_Sequence is 1 initial attempt plus `CHAT_PANEL_LOAD_RETRY_DELAYS_MS.length` retries.
 * Each attempt races its `import()` against `CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS`. Every attempt
 * made after any failure in this document is a Cache_Busted_Import of the Chunk_URL with a
 * document-wide `retry=<n>` counter, because Chromium-based browsers answer a plain retry of a
 * failed module fetch from the module map (C6). When the Chunk_URL cannot be read from the
 * importer, a retry calls the importer unchanged (R20.18).
 *
 * The service is `providedIn: 'root'` so the loaded class, the failure flag and the counter
 * outlive one Board_Page (D12).
 */

/** Clock and timer functions used by the loader, injectable so tests can drive time. */
export interface PanelChunkLoaderTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export interface PanelChunkLoaderDeps {
  /** The compiled importer of the Chat_Panel; used for the first attempt and for the R20.18 fallback. */
  readonly importer: () => Promise<Type<unknown>>;
  /** `import.meta.url` of the module that holds `importer` (R20.13). */
  readonly baseUrl: string;
  /** Imports a Cache_Busted_Import URL and returns the panel class from its module. */
  readonly importUrl: (url: string) => Promise<Type<unknown>>;
  readonly timers: PanelChunkLoaderTimers;
  /** `requestIdleCallback` wrapper, or `null` where the browser does not define it (C12). */
  readonly requestIdle: ((callback: () => void) => void) | null;
}

/** Imports `url` as a module and returns its `ChatPanelComponent` export. */
export function importPanelFromUrl(url: string): Promise<Type<unknown>> {
  return import(/* @vite-ignore */ url).then((module: Record<string, unknown>) => {
    const cls = module['ChatPanelComponent'];
    if (typeof cls !== 'function') {
      throw new Error('The chat chunk has no ChatPanelComponent export.');
    }
    return cls as Type<unknown>;
  });
}

function defaultRequestIdle(): ((callback: () => void) => void) | null {
  if (typeof window === 'undefined' || typeof window.requestIdleCallback !== 'function') {
    return null;
  }
  return (callback) => {
    window.requestIdleCallback(() => callback());
  };
}

function defaultDeps(): PanelChunkLoaderDeps {
  return {
    importer: importChatPanel,
    baseUrl: CHAT_PANEL_IMPORTER_BASE_URL,
    importUrl: importPanelFromUrl,
    timers: {
      now: () => Date.now(),
      setTimeout: (callback: () => void, ms: number) => window.setTimeout(callback, ms),
      clearTimeout: (handle: number) => window.clearTimeout(handle),
    },
    requestIdle: defaultRequestIdle(),
  };
}

export const PANEL_CHUNK_LOADER_DEPS = new InjectionToken<PanelChunkLoaderDeps>(
  'PANEL_CHUNK_LOADER_DEPS',
  { providedIn: 'root', factory: defaultDeps },
);

/** One attempt of a Load_Sequence. */
interface Attempt {
  /** The attempt's timeout timer while it is pending. */
  timeoutTimer: number | null;
  /** True once the attempt rejected or timed out. */
  failed: boolean;
}

/** One Load_Sequence (design "Panel_Chunk_Loader state"). */
interface LoadSequence {
  /** Index of the latest started attempt, 0 to `CHAT_PANEL_LOAD_RETRY_DELAYS_MS.length`. */
  attemptIndex: number;
  /** False for the idle prefetch until an activation adopts it (R20.15). */
  userStarted: boolean;
  /** The timer that starts the next attempt, while waiting between attempts. */
  retryTimer: number | null;
  /** Attempts of this sequence whose timeout timer is still pending. */
  readonly pending: Set<Attempt>;
}

@Injectable({ providedIn: 'root' })
export class PanelChunkLoader {
  private readonly deps = inject(PANEL_CHUNK_LOADER_DEPS);

  private readonly _panelClass = signal<Type<unknown> | null>(null);
  private readonly _busy = signal(false);
  private readonly _errorShown = signal(false);
  private readonly openedSubject = new Subject<void>();

  /** The loaded Chat_Panel class; set once and kept for the document (R20.17). */
  readonly panelClass: Signal<Type<unknown> | null> = this._panelClass.asReadonly();
  /** True exactly while a user-started Load_Sequence runs, waits included (R20.11). */
  readonly busy: Signal<boolean> = this._busy.asReadonly();
  /** True while the Chat_Load_Error_Notice is shown (R20.14). */
  readonly errorShown: Signal<boolean> = this._errorShown.asReadonly();
  /** Emits when an activation should open the panel: at once when loaded, or when a user-started sequence succeeds. */
  readonly opened: Observable<void> = this.openedSubject.asObservable();

  /** Some attempt in this document failed, idle prefetch included (R20.13, R20.15). */
  private anyFailed = false;
  /** The last `n` used in `retry=<n>` (R20.13). */
  private retryCounter = 0;
  /** Cached Chunk_URL; `undefined` until first needed, `null` selects the R20.18 fallback. */
  private chunkUrl: string | null | undefined = undefined;
  /** An attempt has started in this document; the idle prefetch then does nothing (R20.4). */
  private anyStarted = false;
  private prefetchRequested = false;
  private sequence: LoadSequence | null = null;

  /**
   * Schedules the idle prefetch once per document, where `requestIdleCallback` exists (R20.4, C12).
   * The prefetch is skipped if an activation started loading first or the class is loaded.
   */
  prefetchWhenIdle(): void {
    if (this.prefetchRequested) {
      return;
    }
    this.prefetchRequested = true;
    const requestIdle = this.deps.requestIdle;
    if (requestIdle === null || this._panelClass() !== null) {
      return;
    }
    requestIdle(() => {
      if (this._panelClass() !== null || this.anyStarted) {
        return;
      }
      this.startSequence(false);
    });
  }

  /** Activation of the Chat_Launcher or of "Try again" (R20.11, R20.14, R20.15, R20.17). */
  requestOpen(): void {
    if (this._panelClass() !== null) {
      this.openedSubject.next();
      return;
    }
    const running = this.sequence;
    if (running !== null && running.userStarted) {
      return;
    }
    this._errorShown.set(false);
    if (running !== null) {
      // The idle prefetch attempt becomes the initial attempt of this Load_Sequence (R20.15).
      running.userStarted = true;
      this._busy.set(true);
      return;
    }
    this.startSequence(true);
  }

  /** "Dismiss": hides the notice and starts nothing (R20.14). */
  dismissError(): void {
    this._errorShown.set(false);
  }

  private startSequence(userStarted: boolean): void {
    const sequence: LoadSequence = {
      attemptIndex: 0,
      userStarted,
      retryTimer: null,
      pending: new Set<Attempt>(),
    };
    this.sequence = sequence;
    if (userStarted) {
      this._busy.set(true);
    }
    this.startAttempt(sequence, 0);
  }

  private startAttempt(sequence: LoadSequence, index: number): void {
    this.anyStarted = true;
    sequence.attemptIndex = index;
    sequence.retryTimer = null;
    const attempt: Attempt = { timeoutTimer: null, failed: false };
    sequence.pending.add(attempt);
    attempt.timeoutTimer = this.deps.timers.setTimeout(() => {
      attempt.timeoutTimer = null;
      this.onAttemptFailed(sequence, attempt);
    }, CHAT_PANEL_LOAD_ATTEMPT_TIMEOUT_MS);

    this.nextImport().then(
      (cls) => this.onAttemptResolved(sequence, attempt, cls),
      () => this.onAttemptFailed(sequence, attempt),
    );
  }

  /** The import of the next attempt (R20.13, R20.18); a synchronous throw becomes a rejection. */
  private nextImport(): Promise<Type<unknown>> {
    try {
      if (!this.anyFailed) {
        return this.deps.importer();
      }
      if (this.chunkUrl === undefined) {
        this.chunkUrl = resolveChunkUrl(this.deps.importer, this.deps.baseUrl);
      }
      if (this.chunkUrl === null) {
        return this.deps.importer();
      }
      this.retryCounter += 1;
      return this.deps.importUrl(withRetryParam(this.chunkUrl, this.retryCounter));
    } catch (error: unknown) {
      return Promise.reject(error);
    }
  }

  private onAttemptResolved(sequence: LoadSequence, attempt: Attempt, cls: Type<unknown>): void {
    this.clearAttemptTimer(sequence, attempt);
    if (this._panelClass() !== null) {
      return;
    }
    // A late success of a timed-out attempt is used too, while no other attempt succeeded (R20.10).
    this._panelClass.set(cls);
    this._errorShown.set(false);
    const running = this.sequence;
    if (running === null) {
      // The sequence already ended (exhausted or a silent prefetch): keep the class, open nothing (C15).
      return;
    }
    this.endSequence(running);
    this._busy.set(false);
    if (running.userStarted) {
      this.openedSubject.next();
    }
  }

  private onAttemptFailed(sequence: LoadSequence, attempt: Attempt): void {
    if (attempt.failed) {
      return;
    }
    attempt.failed = true;
    this.clearAttemptTimer(sequence, attempt);
    this.anyFailed = true;
    if (this._panelClass() !== null || this.sequence !== sequence) {
      return;
    }
    if (!sequence.userStarted) {
      // A failed idle prefetch that nobody adopted ends silently (R20.15).
      this.endSequence(sequence);
      return;
    }
    const index = sequence.attemptIndex;
    if (index < CHAT_PANEL_LOAD_RETRY_DELAYS_MS.length) {
      sequence.retryTimer = this.deps.timers.setTimeout(() => {
        sequence.retryTimer = null;
        if (this.sequence === sequence && this._panelClass() === null) {
          this.startAttempt(sequence, index + 1);
        }
      }, CHAT_PANEL_LOAD_RETRY_DELAYS_MS[index]);
      return;
    }
    // Every attempt failed (R20.14).
    this.endSequence(sequence);
    this._busy.set(false);
    this._errorShown.set(true);
  }

  private clearAttemptTimer(sequence: LoadSequence, attempt: Attempt): void {
    if (attempt.timeoutTimer !== null) {
      this.deps.timers.clearTimeout(attempt.timeoutTimer);
      attempt.timeoutTimer = null;
    }
    sequence.pending.delete(attempt);
  }

  /** Ends `sequence`: cancels its retry timer and the timeout timers of its pending attempts. */
  private endSequence(sequence: LoadSequence): void {
    if (sequence.retryTimer !== null) {
      this.deps.timers.clearTimeout(sequence.retryTimer);
      sequence.retryTimer = null;
    }
    for (const attempt of sequence.pending) {
      if (attempt.timeoutTimer !== null) {
        this.deps.timers.clearTimeout(attempt.timeoutTimer);
        attempt.timeoutTimer = null;
      }
    }
    sequence.pending.clear();
    if (this.sequence === sequence) {
      this.sequence = null;
    }
  }
}
