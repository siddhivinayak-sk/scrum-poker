import {
  DestroyRef,
  Injectable,
  InjectionToken,
  Signal,
  WritableSignal,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BoardKind, CHAT_ACK_TIMEOUT_MS, ChatMessage, ConnectionState } from '@shared/types';
import { validateChatText } from '@shared/chat-text';
import {
  ChatAction,
  ChatEffect,
  ChatEntry,
  ChatHistoryStatus,
  ChatState,
  createChatState,
  reduceChat,
  selectEntries,
  selectUnreadCount,
} from './chat-store';
import { CHAT_READ_MARKER_STORE } from './chat-read-marker';
import { CHAT_TRANSPORT } from './chat-transport';

/**
 * Page-scoped chat store (design "ChatStore service", D8).
 *
 * The service runs the pure `reduceChat` reducer and executes its effects: frames go out through
 * the Board_Page's `ChatTransport`, acknowledgement timers run through `CHAT_TIMERS`, and the
 * Read_Marker is written through `CHAT_READ_MARKER_STORE`. It also holds the UI state that must
 * survive the Chat_Panel component being destroyed (Panel_State, Draft, caret, scroll position,
 * New_Messages_Indicator count). `ChatHostComponent` provides one instance per Board_Page, so a
 * new page instance starts empty and poker and retro never share a store (R1.8, R15.11, R18.11).
 *
 * Nothing here writes message text or Draft text to the console or to any storage (R3.10, R19.3);
 * the only stored value is the Read_Marker (R19.7).
 */

/** Clock and timer functions used by the store, injectable so tests can drive time. */
export interface ChatTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

/** Defaults to the window clock and timers. */
export const CHAT_TIMERS = new InjectionToken<ChatTimers>('CHAT_TIMERS', {
  providedIn: 'root',
  factory: () => ({
    now: () => Date.now(),
    setTimeout: (callback: () => void, ms: number) => window.setTimeout(callback, ms),
    clearTimeout: (handle: number) => window.clearTimeout(handle),
  }),
});

export type ChatPanelState = 'closed' | 'open' | 'minimized';

/** Scroll position of the Message_List, kept while the panel is not rendered (R3.8, R6.9). */
export interface ChatScrollState {
  readonly top: number;
  readonly atBottom: boolean;
}

/**
 * Latest text for the panel's `role="status"` region (R11.18). `id` grows with each
 * announcement, so the same text announced twice is still a change the panel can render.
 */
export interface ChatAnnouncement {
  readonly id: number;
  readonly text: string;
}

@Injectable()
export class ChatStore {
  private readonly transport = inject(CHAT_TRANSPORT);
  private readonly timers = inject(CHAT_TIMERS);
  private readonly readMarkers = inject(CHAT_READ_MARKER_STORE);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  readonly boardKind: BoardKind = this.transport.boardKind;

  private readonly state = signal<ChatState>(
    createChatState({
      boardKind: this.boardKind,
      sessionId: '',
      me: untracked(this.transport.currentUserId),
      connection: untracked(this.transport.connectionState),
    }),
  );

  // --- Reducer-owned (read-only) -----------------------------------------------------------

  /** Confirmed messages by seq, then outbox entries in first-send order (R5.1). */
  readonly entries: Signal<readonly ChatEntry[]> = computed(() => selectEntries(this.state()));
  readonly unreadCount: Signal<number> = computed(() => selectUnreadCount(this.state()));
  readonly historyStatus: Signal<ChatHistoryStatus> = computed(() => this.state().historyStatus);
  readonly rateLimitUntil: Signal<number | null> = computed(() => this.state().rateLimitUntil);
  readonly connectionState: Signal<ConnectionState> = computed(() => this.state().connection);
  /**
   * Highest Connection_Generation whose Chat_History was applied; null before the first history
   * and after a reset. It changes exactly when a history is applied, so the Message_List can set
   * `aria-busy` for that render (R11.17).
   */
  readonly historyGeneration: Signal<number | null> = computed(() => this.state().historyGeneration);
  /** The Board_Session ID the store is bound to; empty until the host calls `reset`. */
  readonly sessionId: Signal<string> = computed(() => this.state().sessionId);

  // --- UI state that must survive the panel being destroyed --------------------------------

  /** Starts `closed` and is never read from storage (R1.8). */
  readonly panelState: WritableSignal<ChatPanelState> = signal<ChatPanelState>('closed');
  /** Held in memory only (R3.10). */
  readonly draft: WritableSignal<string> = signal('');
  readonly caret: WritableSignal<number> = signal(0);
  /** Null until the Message_List reports a position; null counts as At_Bottom. */
  readonly scroll: WritableSignal<ChatScrollState | null> = signal<ChatScrollState | null>(null);
  readonly newIndicatorCount: WritableSignal<number> = signal(0);
  readonly presenceOpen: WritableSignal<boolean> = signal(false);
  readonly everOpened: WritableSignal<boolean> = signal(false);

  /** Exactly when the Chat_Validator accepts the Draft and Connection_State is `connected` (R7.6). */
  readonly sendable: Signal<boolean> = computed(
    () => this.state().connection === 'connected' && validateChatText(this.draft()).ok,
  );

  private readonly _unreadIncreaseCount = signal(0);
  /** Counts Unread_Increase events: each rise of `unreadCount` above its previous value. */
  readonly unreadIncreaseCount: Signal<number> = this._unreadIncreaseCount.asReadonly();

  private readonly _documentVisible = signal(this.document.visibilityState !== 'hidden');
  /** `document.visibilityState === 'visible'`, kept current by `visibilitychange`. */
  readonly documentVisible: Signal<boolean> = this._documentVisible.asReadonly();

  private readonly _announcement = signal<ChatAnnouncement | null>(null);
  /** The latest status announcement for the panel's `role="status"` region (R11.18). */
  readonly announcement: Signal<ChatAnnouncement | null> = this._announcement.asReadonly();

  private readonly ackTimers = new Map<string, number>();
  private historyTimer: number | null = null;
  private historyTimerStarted = false;
  private sessionBound = false;
  private destroyed = false;

  constructor() {
    const onVisibilityChange = (): void =>
      this._documentVisible.set(this.document.visibilityState !== 'hidden');
    this.document.addEventListener('visibilitychange', onVisibilityChange);

    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.document.removeEventListener('visibilitychange', onVisibilityChange);
      for (const handle of this.ackTimers.values()) this.timers.clearTimeout(handle);
      this.ackTimers.clear();
      this.clearHistoryTimer();
    });

    this.transport.added$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((raw) => this.dispatch({ kind: 'added', raw }));
    this.transport.history$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((raw) =>
      this.dispatch({
        kind: 'history',
        raw,
        generation: untracked(this.transport.connectionGeneration),
        now: this.timers.now(),
      }),
    );
    this.transport.rejected$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((raw) => this.dispatch({ kind: 'rejected', raw, now: this.timers.now() }));

    effect(() => {
      const me = this.transport.currentUserId();
      untracked(() => this.dispatch({ kind: 'identity', me }));
    });

    effect(() => {
      const connection = this.transport.connectionState();
      untracked(() => {
        this.dispatch({ kind: 'connection', state: connection, now: this.timers.now() });
        if (connection === 'connected') this.startHistoryTimer();
      });
    });

    // Read_Marker on entering the readable state (R2.4); `dispatch` covers additions in it.
    effect(() => {
      this.panelState();
      this._documentVisible();
      this.state();
      untracked(() => this.markReadIfReadable());
    });
  }

  // --- Intents -----------------------------------------------------------------------------

  /**
   * Binds the store to a Board_Session (R18.11). On a change of session the previous session's
   * messages, outbox, timers, Draft, caret, scroll position and New_Messages_Indicator count are
   * discarded and its Read_Marker is left in storage; the new session's Read_Marker is loaded.
   */
  reset(sessionId: string): void {
    untracked(() => {
      if (this.sessionBound && sessionId === this.state().sessionId) return;
      const firstBinding = !this.sessionBound;
      this.sessionBound = true;
      this.dispatch({
        kind: 'reset',
        sessionId,
        readMarker: this.readMarkers.read(this.boardKind, sessionId),
      });
      this.draft.set('');
      this.caret.set(0);
      this.scroll.set(null);
      this.newIndicatorCount.set(0);
      this._announcement.set(null);
      if (!firstBinding) {
        // The new session's history timeout starts on its next `connected` (R5.13).
        this.clearHistoryTimer();
        this.historyTimerStarted = false;
      }
    });
  }

  /**
   * Sends the Normalised_Text of the Draft with a fresh Client_Message_Id (R7.11), then clears
   * the Draft, the caret and the New_Messages_Indicator count (R6.3, R7.2). No-op while the
   * Draft is not sendable (R7.6, R7.7).
   */
  sendDraft(): void {
    untracked(() => {
      if (!this.sendable()) return;
      const validated = validateChatText(this.draft());
      if (!validated.ok) return;
      this.dispatch({
        kind: 'send',
        clientMessageId: crypto.randomUUID(),
        text: validated.text,
        now: this.timers.now(),
      });
      this.draft.set('');
      this.caret.set(0);
      this.newIndicatorCount.set(0);
    });
  }

  /** Resends a `failed` Own_Message with the same id and text (R8.7). */
  retry(clientMessageId: string): void {
    this.dispatch({ kind: 'retry', clientMessageId, now: this.timers.now() });
  }

  /** Removes a `failed` Own_Message (R8.8). */
  discard(clientMessageId: string): void {
    this.dispatch({ kind: 'discard', clientMessageId });
  }

  // --- Reducer driver ----------------------------------------------------------------------

  private dispatch(action: ChatAction): void {
    if (this.destroyed) return;
    untracked(() => {
      const previous = this.state();
      const reduction = reduceChat(previous, action);
      let next = reduction.state;
      const effects: ChatEffect[] = [...reduction.effects];

      // An addition while readable moves the Read_Marker at once, so it is never counted (R2.4).
      const seq = this.readableSeq(next);
      if (seq !== null) {
        const marked = reduceChat(next, { kind: 'markRead', seq });
        next = marked.state;
        effects.push(...marked.effects);
      }

      if (next !== previous) {
        this.countNewIndicator(previous, next, action);
        this.state.set(next);
        if (selectUnreadCount(next) > selectUnreadCount(previous)) {
          this._unreadIncreaseCount.update((n) => n + 1);
        }
        if (next.historyStatus !== 'loading') this.clearHistoryTimer();
      }

      for (const item of effects) this.run(item);
    });
  }

  private run(effect: ChatEffect): void {
    switch (effect.kind) {
      case 'send':
        this.transport.send(effect.payload);
        return;
      case 'startAckTimer': {
        this.cancelAckTimer(effect.clientMessageId);
        const id = effect.clientMessageId;
        const handle = this.timers.setTimeout(() => {
          this.ackTimers.delete(id);
          this.dispatch({ kind: 'ackTimeout', clientMessageId: id });
        }, effect.ms);
        this.ackTimers.set(id, handle);
        return;
      }
      case 'cancelAckTimer':
        this.cancelAckTimer(effect.clientMessageId);
        return;
      case 'writeReadMarker':
        this.readMarkers.write(effect.boardKind, effect.sessionId, effect.seq);
        return;
      case 'announce':
        this._announcement.update((previous) => ({ id: (previous?.id ?? 0) + 1, text: effect.text }));
        return;
    }
  }

  private cancelAckTimer(clientMessageId: string): void {
    const handle = this.ackTimers.get(clientMessageId);
    if (handle === undefined) return;
    this.timers.clearTimeout(handle);
    this.ackTimers.delete(clientMessageId);
  }

  /** Starts the R5.13 timeout once, on the first `connected` since render or session change. */
  private startHistoryTimer(): void {
    if (this.historyTimerStarted || this.destroyed) return;
    this.historyTimerStarted = true;
    if (this.state().historyStatus !== 'loading') return;
    this.historyTimer = this.timers.setTimeout(() => {
      this.historyTimer = null;
      this.dispatch({ kind: 'historyTimeout' });
    }, CHAT_ACK_TIMEOUT_MS);
  }

  private clearHistoryTimer(): void {
    if (this.historyTimer === null) return;
    this.timers.clearTimeout(this.historyTimer);
    this.historyTimer = null;
  }

  // --- Read_Marker -------------------------------------------------------------------------

  /** Highest confirmed seq while `open`, visible and non-empty (R2.4); otherwise null. */
  private readableSeq(state: ChatState): number | null {
    if (this.panelState() !== 'open' || !this._documentVisible()) return null;
    const last = state.confirmed[state.confirmed.length - 1];
    return last === undefined ? null : last.seq;
  }

  private markReadIfReadable(): void {
    const seq = this.readableSeq(this.state());
    if (seq !== null) this.dispatch({ kind: 'markRead', seq });
  }

  // --- New_Messages_Indicator --------------------------------------------------------------

  /**
   * R6.2, R6.8, R6.9: while the Message_List is not At_Bottom, each new non-Own confirmed message
   * of an added event counts, and so does each new non-Own message of a reconnect history whose
   * seq is above the highest seq held before it. This also runs while the panel is not `open`.
   * The first history after render or reset is not a reconnect and counts nothing.
   */
  private countNewIndicator(previous: ChatState, next: ChatState, action: ChatAction): void {
    if (action.kind !== 'added' && action.kind !== 'history') return;
    if (action.kind === 'history' && previous.historyGeneration === null) return;
    if (this.scroll()?.atBottom ?? true) return;

    const knownIds = new Set(previous.confirmed.map((m) => m.id));
    const previousMaxSeq = previous.confirmed[previous.confirmed.length - 1]?.seq ?? 0;
    let added = 0;
    for (const message of next.confirmed) {
      if (knownIds.has(message.id) || isOwnMessage(next, message)) continue;
      if (action.kind === 'history' && message.seq <= previousMaxSeq) continue;
      added++;
    }
    if (added > 0) this.newIndicatorCount.update((n) => n + added);
  }
}

function isOwnMessage(state: ChatState, message: ChatMessage): boolean {
  return state.me !== null && message.authorId === state.me;
}
