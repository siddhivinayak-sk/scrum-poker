import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  linkedSignal,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { CHAT_TIMERS, ChatStore } from '../../services/chat-store.service';
import {
  AVATAR_PALETTE,
  avatarColorIndex,
  avatarInitials,
  formatChatTime,
  indicatorText,
} from './chat-format';

/** One entry of `ChatStore.entries` (confirmed message or outbox entry). */
export type ChatListEntry = ReturnType<ChatStore['entries']>[number];

/** Distance from the end within which the Message_List counts as At_Bottom. */
export const CHAT_AT_BOTTOM_PX = 48;
/** While a smooth scroll to the end runs, the list keeps counting as At_Bottom. */
const FOLLOW_MS = 400;
/** Visible rows remembered as scroll anchors, so an evicted first row has fallbacks. */
const MAX_ANCHORS = 8;

export const CHAT_SENDING_TEXT = 'Sending…';
export const CHAT_NOT_SENT_TEXT = 'Not sent';
export const CHAT_EMPTY_TEXT = 'No messages yet. Say hello to your team.';
export const CHAT_LOADING_TEXT = 'Loading messages…';
export const CHAT_HISTORY_TIMED_OUT_TEXT = 'Earlier messages could not be loaded.';

/** What one Message_List row shows. All strings are rendered by interpolation (R5.8). */
export interface ChatRowView {
  readonly own: boolean;
  /** "You" for an Own_Message, otherwise `authorName` (R5.6, R11.9). */
  readonly author: string;
  /** Avatar initials and colour; only rendered for other participants' rows. */
  readonly initials: string;
  readonly color: string;
  readonly text: string;
  /** `datetime` of the `<time>` element; '' while a delivery text replaces the time. */
  readonly datetime: string;
  readonly time: string;
  /** "Sending…" for `pending`, "Not sent" for `failed`, '' otherwise (R8.10). */
  readonly delivery: string;
  /** Client_Message_Id of a `failed` entry (Retry and Discard shown, R8.6), else null. */
  readonly failedId: string | null;
  /** Rejection or timeout text of a `failed` entry. */
  readonly notice: string;
}

/**
 * Pure row model. A confirmed message shows `formatChatTime(sentAt, now)`; a `sent` outbox entry
 * (after `CHAT_DUPLICATE`) shows the local time of its first send (R8.3).
 */
export function chatRowView(entry: ChatListEntry, now: number): ChatRowView {
  if (entry.kind === 'confirmed') {
    const { message, own } = entry;
    return {
      own,
      author: own ? 'You' : message.authorName,
      initials: own ? '' : avatarInitials(message.authorName),
      color: own ? '' : AVATAR_PALETTE[avatarColorIndex(message.authorId)],
      text: message.text,
      datetime: message.sentAt,
      time: formatChatTime(message.sentAt, now),
      delivery: '',
      failedId: null,
      notice: '',
    };
  }
  const { entry: out } = entry;
  const sent = out.state === 'sent';
  const failed = out.state === 'failed';
  const firstSent = new Date(out.firstSentAt);
  return {
    own: true,
    author: 'You',
    initials: '',
    color: '',
    text: out.text,
    datetime: sent ? firstSent.toISOString() : '',
    time: sent ? formatChatTime(firstSent, now) : '',
    delivery: sent ? '' : failed ? CHAT_NOT_SENT_TEXT : CHAT_SENDING_TEXT,
    failedId: failed ? out.clientMessageId : null,
    notice: failed ? (out.notice ?? '') : '',
  };
}

interface RowAnchor {
  readonly key: string;
  /** Row top minus list top, in CSS pixels. */
  readonly offset: number;
}

interface ListSnapshot {
  readonly atBottom: boolean;
  readonly anchors: readonly RowAnchor[];
}

/**
 * Message_List (design "ChatMessageListComponent"): the `role="log"` scroll container, message
 * rows, empty / loading / timed-out texts, manual scroll anchoring and the
 * New_Messages_Indicator. It must be the panel's flexible middle child (`:host` is a flex item
 * with `min-height: 0`).
 *
 * Scroll handling runs only while `panelState` is `open`. On each entry into `open` (first render
 * or `minimized → open`) it restores the position kept in `store.scroll`: the end when it was
 * At_Bottom or nothing was stored, otherwise the stored offset (R3.8, R3.9, R6.9).
 */
@Component({
  selector: 'app-chat-message-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      #log
      class="chat-list"
      role="log"
      aria-label="Chat messages"
      aria-live="polite"
      aria-relevant="additions"
      tabindex="0"
      [attr.aria-busy]="busy()"
    >
      @if (store.historyStatus() === 'timed-out') {
        <p class="chat-list__note">{{ timedOutText }}</p>
      } @else if (store.entries().length === 0) {
        <p class="chat-list__note">{{ store.historyStatus() === 'loading' ? loadingText : emptyText }}</p>
      }
      @for (entry of store.entries(); track entry.key) {
        @let row = rowView(entry);
        <div class="chat-msg" [class.chat-msg--own]="row.own" [attr.data-key]="entry.key">
          <div class="chat-msg__main">
            @if (!row.own) {
              <span class="chat-msg__avatar" aria-hidden="true" [style.background-color]="row.color">{{ row.initials }}</span>
            }
            <div class="chat-msg__bubble">
              <div class="chat-msg__meta">
                <span class="chat-msg__author">{{ row.author }}</span>
                @if (row.delivery) {
                  <span class="chat-msg__time">{{ row.delivery }}</span>
                } @else {
                  <time class="chat-msg__time" [attr.datetime]="row.datetime">{{ row.time }}</time>
                }
              </div>
              <p class="chat-msg__text">{{ row.text }}</p>
            </div>
          </div>
          @if (row.failedId; as id) {
            <div class="chat-msg__failed">
              @if (row.notice) {
                <p class="chat-msg__notice">{{ row.notice }}</p>
              }
              <button
                type="button"
                class="chat-msg__action"
                aria-label="Retry sending message"
                [disabled]="!connected()"
                (click)="store.retry(id)"
              >Retry</button>
              <button
                type="button"
                class="chat-msg__action"
                aria-label="Discard message"
                (click)="store.discard(id)"
              >Discard</button>
            </div>
          }
        </div>
      }
      @if (indicator(); as text) {
        <div class="chat-list__dock">
          <button type="button" class="chat-list__indicator" (click)="onIndicator()">{{ text }}</button>
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0; }
    .chat-list {
      flex: 1 1 auto; min-height: 0; overflow-x: hidden; overflow-y: auto;
      overflow-anchor: none; scroll-behavior: auto;
      display: flex; flex-direction: column; gap: 8px; padding: 12px;
    }
    .chat-list:focus-visible { outline-offset: -2px; }
    .chat-list__note { margin: 0; padding: 8px 0; text-align: center; color: var(--text-secondary); }
    .chat-msg {
      display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
      align-self: flex-start; max-width: 85%; min-width: 0;
    }
    .chat-msg--own { align-self: flex-end; align-items: flex-end; }
    .chat-msg__main { display: flex; align-items: flex-start; gap: 8px; max-width: 100%; min-width: 0; }
    .chat-msg__avatar {
      flex: none; width: 32px; height: 32px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--text-on-primary); font-size: 0.75rem; font-weight: 600;
    }
    .chat-msg__bubble {
      min-width: 0; max-width: 100%; padding: 8px 12px; border-radius: 12px;
      background: var(--chat-bubble-other); color: var(--text-primary); overflow-wrap: anywhere;
    }
    .chat-msg--own .chat-msg__bubble { background: var(--color-primary-dark); color: var(--text-on-primary); }
    .chat-msg__meta { display: flex; flex-wrap: wrap; gap: 0 8px; font-size: 0.75rem; }
    .chat-msg__author { min-width: 0; font-weight: 600; }
    .chat-msg__time { color: var(--text-secondary); }
    .chat-msg--own .chat-msg__time { color: inherit; }
    .chat-msg__text { margin: 4px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .chat-msg__failed {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px 8px;
    }
    .chat-msg__notice {
      flex-basis: 100%; margin: 0; text-align: end; font-size: 0.75rem;
      color: var(--status-fault); overflow-wrap: anywhere;
    }
    .chat-msg__action {
      min-width: 44px; min-height: 44px; padding: 0 12px; border: 1px solid var(--text-secondary);
      border-radius: 8px; background: var(--surface-card-deck); color: var(--text-primary); font: inherit; cursor: pointer;
    }
    .chat-msg__action:disabled { color: var(--text-secondary); cursor: not-allowed; }
    .chat-list__dock { position: sticky; bottom: 0; flex: none; height: 0; margin-top: -8px; }
    .chat-list__indicator {
      position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%);
      width: max-content; max-width: calc(100% - 16px); min-height: 44px; padding: 0 16px;
      border: none; border-radius: 22px; background: var(--color-primary-dark);
      color: var(--text-on-primary); font: inherit; font-weight: 600;
      box-shadow: var(--shadow-md); cursor: pointer;
    }
    .chat-list__indicator:focus-visible {
      outline: none; box-shadow: 0 0 0 2px var(--text-on-primary), 0 0 0 4px var(--text-primary);
    }
  `,
})
export class ChatMessageListComponent {
  protected readonly store = inject(ChatStore);
  private readonly timers = inject(CHAT_TIMERS);
  private readonly destroyRef = inject(DestroyRef);
  private readonly reducedMotion: MediaQueryList | null = reducedMotionQuery(
    inject(DOCUMENT).defaultView,
  );

  /**
   * Emits when the New_Messages_Indicator is activated, after the list has started scrolling to
   * its end and reset the count. The panel moves focus to the Composer text area (R6.4).
   */
  readonly focusComposer = output<void>();

  protected readonly timedOutText = CHAT_HISTORY_TIMED_OUT_TEXT;
  protected readonly loadingText = CHAT_LOADING_TEXT;
  protected readonly emptyText = CHAT_EMPTY_TEXT;

  private readonly logRef = viewChild.required<ElementRef<HTMLElement>>('log');

  /** Reference time for timestamps; refreshed just after each local midnight (R5.5). */
  private readonly now = signal(this.timers.now());
  protected readonly connected = computed(() => this.store.connectionState() === 'connected');
  protected readonly indicator = computed(() => indicatorText(this.store.newIndicatorCount()));

  /**
   * True for the render that inserts a Chat_History, false after it (R11.17): it turns true when
   * `historyGeneration` changes to a new value and the after-render step sets it back.
   */
  protected readonly busy = linkedSignal<number | null, boolean>({
    source: this.store.historyGeneration,
    computation: (generation, previous) =>
      previous !== undefined && generation !== null && generation !== previous.source,
  });

  private snapshot: ListSnapshot | null = null;
  private renderedKeys: ReadonlySet<string> = new Set();
  private processedEntries: readonly ChatListEntry[] | null = null;
  private shownOpen = false;
  private followUntil = 0;
  private dayTimer: number | null = null;

  constructor() {
    this.scheduleDayTick();
    this.destroyRef.onDestroy(() => {
      if (this.dayTimer !== null) this.timers.clearTimeout(this.dayTimer);
    });

    afterNextRender(() => {
      const el = this.logRef().nativeElement;
      const onScroll = (): void => this.onScroll(el);
      el.addEventListener('scroll', onScroll, { passive: true });
      this.destroyRef.onDestroy(() => el.removeEventListener('scroll', onScroll));
    });

    afterRenderEffect(() => {
      const entries = this.store.entries();
      const open = this.store.panelState() === 'open';
      const busy = this.busy();
      untracked(() => this.afterRender(entries, open, busy));
    });
  }

  protected rowView(entry: ChatListEntry): ChatRowView {
    return chatRowView(entry, this.now());
  }

  /** New_Messages_Indicator activation (R6.4). */
  protected onIndicator(): void {
    this.scrollToEnd(this.logRef().nativeElement, true);
    this.focusComposer.emit();
  }

  // --- Scroll anchoring --------------------------------------------------------------------

  private afterRender(entries: readonly ChatListEntry[], open: boolean, busy: boolean): void {
    if (entries !== this.processedEntries || open !== this.shownOpen) {
      const previousKeys = this.renderedKeys;
      this.renderedKeys = new Set(entries.map((e) => e.key));
      this.processedEntries = entries;
      const el = this.logRef().nativeElement;
      if (!open) {
        // Hidden (minimized): keep the last snapshot and `store.scroll` for the next open.
        this.shownOpen = false;
      } else if (!this.shownOpen) {
        this.shownOpen = true;
        this.restore(el);
      } else {
        const ownSend = entries.some(
          (e) => e.kind === 'outbox' && e.entry.state === 'pending' && !previousKeys.has(e.key),
        );
        if (ownSend || this.snapshot === null || this.snapshot.atBottom) {
          // R6.1, R6.3; a whole history is inserted with one jump.
          this.scrollToEnd(el, !busy);
        } else {
          this.reanchor(el); // R6.2, R6.8
          this.snapshot = this.measure(el);
        }
      }
    }
    if (busy) this.busy.set(false);
  }

  /** Entering `open`: the end when At_Bottom or nothing stored, else the stored offset. */
  private restore(el: HTMLElement): void {
    const saved = this.store.scroll();
    if (saved === null || saved.atBottom) {
      this.scrollToEnd(el, false);
      return;
    }
    el.scrollTop = saved.top;
    // Same instance after `minimized`: correct for rows added or evicted above while hidden.
    this.reanchor(el);
    this.snapshot = this.measure(el);
  }

  /**
   * Scrolls to the end: one `scrollTop` assignment under reduced motion or when `smooth` is false
   * (R6.6), otherwise `behavior: 'smooth'`. Marks the list At_Bottom and clears the count.
   */
  private scrollToEnd(el: HTMLElement, smooth: boolean): void {
    const target = el.scrollHeight;
    if (smooth && !this.reducedMotion?.matches && typeof el.scrollTo === 'function') {
      this.followUntil = this.timers.now() + FOLLOW_MS;
      el.scrollTo({ top: target, behavior: 'smooth' });
    } else {
      this.followUntil = 0;
      el.scrollTop = target;
    }
    this.snapshot = { atBottom: true, anchors: this.measure(el).anchors };
    this.writeScroll(el.scrollTop, true);
  }

  /** Moves `scrollTop` so the first remembered row that still exists keeps its offset. */
  private reanchor(el: HTMLElement): void {
    const anchors = this.snapshot?.anchors ?? [];
    if (anchors.length === 0) return;
    const rows = rowsByKey(el);
    const listTop = el.getBoundingClientRect().top;
    for (const anchor of anchors) {
      const row = rows.get(anchor.key);
      if (row === undefined) continue;
      const delta = row.getBoundingClientRect().top - listTop - anchor.offset;
      if (delta !== 0) el.scrollTop += delta;
      return;
    }
  }

  /** At_Bottom state plus the rows whose bottom is below the viewport top (first ones first). */
  private measure(el: HTMLElement): ListSnapshot {
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight <= CHAT_AT_BOTTOM_PX || this.following();
    const list = el.getBoundingClientRect();
    const anchors: RowAnchor[] = [];
    for (const [key, row] of rowsByKey(el)) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= list.top) continue;
      if (rect.top >= list.bottom && anchors.length > 0) break;
      anchors.push({ key, offset: rect.top - list.top });
      if (anchors.length >= MAX_ANCHORS) break;
    }
    return { atBottom, anchors };
  }

  private following(): boolean {
    return this.timers.now() < this.followUntil;
  }

  /** Every `scroll` event while open writes `store.scroll` (R3.8, R6.9) and resets on At_Bottom (R6.5). */
  private onScroll(el: HTMLElement): void {
    if (untracked(this.store.panelState) !== 'open') return;
    this.snapshot = this.measure(el);
    this.writeScroll(el.scrollTop, this.snapshot.atBottom);
  }

  private writeScroll(top: number, atBottom: boolean): void {
    const current = untracked(this.store.scroll);
    if (current === null || current.top !== top || current.atBottom !== atBottom) {
      this.store.scroll.set({ top, atBottom });
    }
    if (atBottom && untracked(this.store.newIndicatorCount) !== 0) {
      this.store.newIndicatorCount.set(0);
    }
  }

  // --- Timestamp reference -----------------------------------------------------------------

  /** Refreshes `now` one second after the next local midnight, when same-day labels change. */
  private scheduleDayTick(): void {
    const current = this.timers.now();
    const today = new Date(current);
    const nextMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime();
    this.dayTimer = this.timers.setTimeout(() => {
      this.now.set(this.timers.now());
      this.scheduleDayTick();
    }, Math.max(1000, nextMidnight - current + 1000));
  }
}

function reducedMotionQuery(view: Window | null): MediaQueryList | null {
  return view !== null && typeof view.matchMedia === 'function'
    ? view.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
}

/** Rendered rows in DOM order, keyed by `data-key` (no selector built from message data). */
function rowsByKey(el: HTMLElement): Map<string, HTMLElement> {
  const rows = new Map<string, HTMLElement>();
  for (const child of Array.from(el.children)) {
    if (!(child instanceof HTMLElement)) continue;
    const key = child.dataset['key'];
    if (key !== undefined) rows.set(key, child);
  }
  return rows;
}
