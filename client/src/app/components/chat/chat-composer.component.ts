import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { CHAT_MESSAGE_MAX_LENGTH } from '@shared/types';
import { CHAT_TIMERS, ChatStore } from '../../services/chat-store.service';
import { clampPaste, counterText, rateLimitSeconds } from './chat-format';

/** Visible lines the text area grows to before it scrolls internally (R7.1). */
export const CHAT_COMPOSER_MAX_LINES = 5;

/** Rate-limit notice of R8.9; `seconds` is the remaining time rounded up. */
export function chatRateLimitText(seconds: number): string {
  return `You're sending messages too fast. Try again in ${seconds} s.`;
}

/**
 * Composer of the Chat_Panel (Deferred chat chunk).
 *
 * - `<textarea aria-label="Message" maxlength="500" rows="1">` that grows with its rendered lines
 *   up to 5 and then scrolls (R7.1, R7.8), and the "Send message" button, disabled while the
 *   Draft is not sendable (R7.6, R7.7, R11.10). The text area stays editable offline (R9.2).
 * - Enter without Shift and outside an IME composition sends when sendable and never inserts a
 *   line break; Shift+Enter keeps the native line break (R7.2–R7.4). `keyCode 229` covers Safari,
 *   which reports `isComposing === false` on the Enter that ends some compositions.
 * - A paste that would overflow 500 code units inserts `clampPaste(…)` instead (R7.12).
 * - Counter from 400 code units (R7.9) and the rate-limit text, ticking with `CHAT_TIMERS` so it
 *   changes when N changes and disappears when the limit has elapsed (R8.9). `aria-describedby`
 *   names only the elements currently shown (R11.10).
 * - Draft and caret live in `ChatStore` (memory only) and are written on every input, so the
 *   panel restores both when it is recreated (R3.8, R3.10).
 */
@Component({
  selector: 'app-chat-composer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:resize)': 'resize()' },
  template: `
    <div class="chat-composer">
      <div class="chat-composer__row">
        <textarea
          #textArea
          class="chat-composer__input"
          aria-label="Message"
          rows="1"
          placeholder="Type a message"
          [attr.maxlength]="maxLength"
          [attr.aria-describedby]="describedBy()"
          (input)="onInput($event)"
          (keydown)="onKeydown($event)"
          (paste)="onPaste($event)"
          (select)="storeCaret()"
          (keyup)="storeCaret()"
          (pointerup)="storeCaret()"
        ></textarea>
        <button
          type="button"
          class="chat-composer__send"
          aria-label="Send message"
          [disabled]="!store.sendable()"
          (click)="send()"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
            <path d="M4 12l16-8-6 16-2.5-6.5z" />
            <path d="M11.5 13.5L20 4" />
          </svg>
        </button>
      </div>
      @if (counter() || rateLimitText()) {
        <div class="chat-composer__meta">
          @if (rateLimitText()) {
            <p class="chat-composer__notice" [id]="rateLimitId">{{ rateLimitText() }}</p>
          }
          @if (counter()) {
            <span class="chat-composer__counter" [id]="counterId">{{ counter() }}</span>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        flex: none;
      }

      .chat-composer {
        padding: 8px;
        color: var(--text-primary);
      }

      .chat-composer__row {
        display: flex;
        align-items: flex-end;
        gap: 8px;
      }

      .chat-composer__input {
        flex: 1 1 auto;
        box-sizing: border-box;
        min-width: 0;
        min-height: 44px;
        margin: 0;
        padding: 9px 12px;
        border: 1px solid var(--text-secondary);
        border-radius: 8px;
        background: var(--surface-card-deck);
        color: var(--text-primary);
        font: inherit;
        font-size: 1rem;
        line-height: 1.5;
        overflow-x: hidden;
        overflow-y: hidden;
        overflow-wrap: anywhere;
        resize: none;
      }

      .chat-composer__input::placeholder {
        color: var(--text-secondary);
        opacity: 1;
      }

      .chat-composer__input:focus-visible,
      .chat-composer__send:focus-visible {
        outline: none;
        box-shadow:
          0 0 0 3px var(--text-on-primary),
          0 0 0 6px var(--text-primary);
      }

      .chat-composer__send {
        display: inline-flex;
        flex: none;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        width: 44px;
        min-width: 44px;
        height: 44px;
        min-height: 44px;
        margin: 0;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 8px;
        background: var(--color-primary-dark);
        color: var(--text-on-primary);
        cursor: pointer;
      }

      .chat-composer__send:hover:not(:disabled) {
        background: var(--color-primary);
      }

      .chat-composer__send:disabled {
        background: var(--wash-neutral-strong);
        color: var(--text-secondary);
        cursor: not-allowed;
      }

      .chat-composer__send svg {
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .chat-composer__meta {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 4px 8px;
        margin-top: 4px;
        font-size: 0.875rem;
        line-height: 1.4;
        color: var(--text-secondary);
      }

      .chat-composer__notice {
        flex: 1 1 12rem;
        margin: 0;
      }

      .chat-composer__counter {
        margin-left: auto;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export class ChatComposerComponent {
  protected readonly store = inject(ChatStore);
  private readonly timers = inject(CHAT_TIMERS);

  protected readonly maxLength = CHAT_MESSAGE_MAX_LENGTH;
  protected readonly counterId = `chat-composer-counter-${this.store.boardKind}`;
  protected readonly rateLimitId = `chat-composer-rate-limit-${this.store.boardKind}`;

  private readonly textArea = viewChild.required<ElementRef<HTMLTextAreaElement>>('textArea');

  /** Clock for the rate-limit text, refreshed by the tick below (R8.9). */
  private readonly now = signal(this.timers.now());
  private tickHandle: number | null = null;
  private initialised = false;
  /** The rendered text area, kept for the caret write on destroy. */
  private element: HTMLTextAreaElement | null = null;

  protected readonly counter = computed(() => counterText(this.store.draft().length));
  protected readonly rateLimitText = computed(() => {
    const until = this.store.rateLimitUntil();
    if (until === null) return '';
    const seconds = rateLimitSeconds(until, this.now());
    return seconds > 0 ? chatRateLimitText(seconds) : '';
  });
  /** Ids of the shown counter and rate-limit text only; null when neither is shown (R11.10). */
  protected readonly describedBy = computed(() => {
    const ids: string[] = [];
    if (this.rateLimitText()) ids.push(this.rateLimitId);
    if (this.counter()) ids.push(this.counterId);
    return ids.length > 0 ? ids.join(' ') : null;
  });

  constructor() {
    effect(() => {
      const until = this.store.rateLimitUntil();
      untracked(() => {
        this.clearTick();
        this.now.set(this.timers.now());
        this.scheduleTick(until);
      });
    });

    // Applies Draft changes made outside this text area (restore on init, send, session reset).
    afterRenderEffect(() => {
      const draft = this.store.draft();
      const el = this.textArea().nativeElement;
      untracked(() => {
        this.element = el;
        if (el.value !== draft) {
          el.value = draft;
          const caret = Math.min(Math.max(0, this.store.caret()), draft.length);
          el.setSelectionRange(caret, caret);
          this.resize();
        } else if (!this.initialised) {
          this.resize();
        }
        this.initialised = true;
      });
    });

    inject(DestroyRef).onDestroy(() => {
      this.clearTick();
      // The caret may have moved without an input event; keep its final position (R3.8).
      if (this.element) this.store.caret.set(this.element.selectionEnd);
    });
  }

  /** Moves keyboard focus to the text area (R3.12, R6.4, R11.6). */
  focusTextArea(): void {
    this.textArea().nativeElement.focus();
  }

  /** Fits the text area to its rendered lines, 1 to 5, scrolling beyond 5 (R7.1). */
  protected resize(): void {
    const el = this.element;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight === 0) {
      // No layout (detached or not rendered): let the CSS one-line height apply.
      el.style.height = '';
      return;
    }
    const style = getComputedStyle(el);
    const px = (value: string): number => parseFloat(value) || 0;
    const fontSize = px(style.fontSize);
    const lineHeight = style.lineHeight.endsWith('px') ? px(style.lineHeight) : fontSize * 1.5;
    const border = px(style.borderTopWidth) + px(style.borderBottomWidth);
    const padding = px(style.paddingTop) + px(style.paddingBottom);
    const max = lineHeight * CHAT_COMPOSER_MAX_LINES + padding + border;
    const needed = el.scrollHeight + border;
    el.style.height = `${Math.min(needed, max)}px`;
    el.style.overflowY = needed > max + 0.5 ? 'auto' : 'hidden';
  }

  /** Writes the caret to the store so a recreated panel restores it (R3.8). */
  protected storeCaret(): void {
    const el = this.textArea().nativeElement;
    this.store.caret.set(el.selectionEnd);
  }

  /** Draft and caret go to the store on every input, never to storage (R3.10). */
  protected onInput(event: Event): void {
    const el = this.textArea().nativeElement;
    const composing = 'isComposing' in event && event.isComposing === true;
    if (!composing && el.value.length > CHAT_MESSAGE_MAX_LENGTH) {
      // Input that bypassed `maxlength` (some IMEs) is cut back, never splitting a pair (R7.8).
      const clamped = clampPaste('', 0, 0, el.value);
      el.value = clamped.draft;
      el.setSelectionRange(clamped.caret, clamped.caret);
    }
    this.store.draft.set(el.value);
    this.store.caret.set(el.selectionEnd);
    this.resize();
  }

  /** Enter sends (R7.2, R7.7); Shift+Enter and IME Enter keep their default (R7.3, R7.4). */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    this.send();
  }

  /** Inserts only the part of an overflowing paste that fits (R7.12). */
  protected onPaste(event: ClipboardEvent): void {
    const data = event.clipboardData;
    if (!data) return;
    const pasted = data.getData('text/plain').replace(/\r\n?/g, '\n');
    const el = this.textArea().nativeElement;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const clamped = clampPaste(el.value, start, end, pasted);
    const inserted = clamped.caret - Math.min(start, end);
    if (inserted >= pasted.length) return; // Fits: the native paste keeps the undo history.
    event.preventDefault();
    el.value = clamped.draft;
    el.setSelectionRange(clamped.caret, clamped.caret);
    this.store.draft.set(clamped.draft);
    this.store.caret.set(clamped.caret);
    this.resize();
  }

  /** Sends when sendable, then leaves focus in (or returns it to) the text area (R7.5, R7.10). */
  protected send(): void {
    if (!this.store.sendable()) return;
    this.store.sendDraft();
    const el = this.textArea().nativeElement;
    const draft = this.store.draft();
    if (el.value !== draft) {
      el.value = draft;
      el.setSelectionRange(draft.length, draft.length);
    }
    this.resize();
    el.focus();
  }

  /** Next tick when N drops or the limit ends, at most 1 s away (R8.9). */
  private scheduleTick(until: number | null): void {
    if (until === null) return;
    const left = until - this.now();
    if (left <= 0) return;
    const delay = left % 1000 || 1000;
    this.tickHandle = this.timers.setTimeout(() => {
      this.tickHandle = null;
      this.now.set(this.timers.now());
      this.scheduleTick(until);
    }, delay);
  }

  private clearTick(): void {
    if (this.tickHandle !== null) {
      this.timers.clearTimeout(this.tickHandle);
      this.tickHandle = null;
    }
  }
}
