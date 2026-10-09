import {
  Component,
  input,
  inject,
  signal,
  computed,
  ElementRef,
  viewChild,
  HostListener,
  afterNextRender,
  afterRenderEffect,
  DestroyRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RetroCard, resolveFluidCardHeight } from '@shared/types';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { RetroStateService } from '../../services/retro-state.service';
import { computeTextAreaHeightPx, measureLineCount } from '../../services/retro-card-height';

/**
 * What the render effect reads off the live text area and hands to
 * `computeTextAreaHeightPx`. Kept as one record so the applied height is a single
 * `computed` over "measured geometry × fluid mode": flipping `fluidCardHeight`
 * re-clamps the already measured line count without touching the DOM (R6.16).
 */
interface TextAreaGeometry {
  /** Rendered line count of the current text, DOM-measured or wrap-estimated. */
  lineCount: number;
  /** Rendered height of one line, or `NaN` when the environment reports no layout. */
  lineHeightPx: number;
  /** Top + bottom padding of the text area. */
  verticalPaddingPx: number;
}

/** Before the first measurement: no lines, no usable metrics — the height module's own
 *  defaults and the minimum clamp then decide the first painted height. */
const UNMEASURED_GEOMETRY: TextAreaGeometry = {
  lineCount: 0,
  lineHeightPx: Number.NaN,
  verticalPaddingPx: Number.NaN,
};

function geometryEquals(a: TextAreaGeometry, b: TextAreaGeometry): boolean {
  // Object.is so an unchanged `NaN` metric does not look like a change and keep the
  // render effect writing on every pass.
  return (
    a.lineCount === b.lineCount &&
    Object.is(a.lineHeightPx, b.lineHeightPx) &&
    Object.is(a.verticalPaddingPx, b.verticalPaddingPx)
  );
}

/**
 * Every browser reports computed length properties in px. A value in any other unit
 * means the environment performed no layout (the test DOM echoes the authored
 * `0.85rem` / `1.4`), so it is rejected and the caller falls back.
 */
function parseComputedPx(raw: string): number {
  if (!raw.endsWith('px')) {
    return Number.NaN;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

function orZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Average glyph advance as a fraction of the font size, for the DOM-free wrap only. */
const AVERAGE_CHAR_WIDTH_RATIO = 0.5;

/**
 * Content width assumed when the element reports none (pre-layout, test DOM). Close to
 * the 200 px the horizontal column layout pins a card to, so the fallback height stays
 * plausible rather than degenerating to one character per line.
 */
const FALLBACK_AVAILABLE_WIDTH_PX = 200;

@Component({
  selector: 'app-retro-card',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div
      class="retro-card"
      [class.owner-highlight]="isOwnerHighlighted()"
      [attr.data-card-id]="card().id"
      draggable="true"
      (dragstart)="onDragStart($event)"
      (dragend)="onDragEnd($event)"
    >
      <!-- Editable text area. There is deliberately no value binding: the text is
           written from the render effect, and only while the element is unfocused, so an
           inbound update can never disturb a caret, a scroll offset or uncommitted
           typing (R5.8, R5.9). -->
      <textarea
        #textArea
        class="retro-card__text"
        [style.height.px]="textAreaHeightPx()"
        [disabled]="isCompleted()"
        (input)="onTextInput()"
        (focus)="onTextFocus()"
        (blur)="onTextBlur($event)"
        (keydown.enter)="onTextEnter($event)"
        (mousedown)="$event.stopPropagation()"
        draggable="false"
        placeholder="Enter your thought..."
        aria-label="Card text"
      ></textarea>

      <!-- Author name (when showCardAuthor config is active) -->
      @if (showCardAuthor()) {
        <span class="retro-card__author">— {{ card().authorName }}</span>
      }

      <!-- Card actions row -->
      <div class="retro-card__actions">
        <!-- Vote button and count -->
        <div class="retro-card__vote-section">
          <button
            class="retro-card__vote-btn"
            type="button"
            title="Vote"
            aria-label="Vote"
            [disabled]="isCompleted() || !votingEnabled() || votesRemaining() <= 0"
            (click)="onVote()"
          >
            👍
          </button>
          @if (!hideVoteCount()) {
            <span class="retro-card__vote-count" aria-label="Vote count: {{ card().votes }}">
              {{ card().votes }}
            </span>
          }
        </div>

        <!-- Comment toggle -->
        <button
          class="retro-card__comment-btn"
          type="button"
          title="Comments"
          aria-label="Comments"
          (click)="toggleComments()"
        >
          💬 {{ card().comments.length }}
        </button>

        <!-- Emoji button (beside comment icon) -->
        @if (enableGifEmoji() && !isCompleted()) {
          <div class="retro-card__emoji-wrapper">
            <button
              class="retro-card__emoji-btn"
              type="button"
              title="Insert emoji"
              aria-label="Insert emoji"
              (click)="toggleEmojiPicker()"
            >
              😀
            </button>
            @if (showEmojiPicker()) {
              <div class="retro-card__emoji-picker">
                @for (emoji of commonEmojis; track emoji) {
                  <button
                    class="retro-card__emoji-option"
                    type="button"
                    [title]="'Insert ' + emoji"
                    [attr.aria-label]="'Insert ' + emoji"
                    (click)="insertEmoji(emoji)"
                  >
                    {{ emoji }}
                  </button>
                }
              </div>
            }
          </div>
        }

        <!-- Delete button (visible only to card author or moderator) -->
        @if (canDelete()) {
          <button
            class="retro-card__delete-btn"
            type="button"
            title="Delete card"
            aria-label="Delete card"
            [disabled]="isCompleted()"
            (click)="onDelete()"
          >
            🗑️
          </button>
        }
      </div>

      <!-- Comment section -->
      @if (showComments()) {
        <div class="retro-card__comments">
          @for (comment of card().comments; track comment.id) {
            <div class="retro-card__comment">
              <span class="retro-card__comment-text">
                <strong>{{ comment.authorName }}:</strong> {{ comment.text }}
              </span>
              @if (canDeleteComment(comment.authorId)) {
                <button
                  class="retro-card__comment-delete"
                  type="button"
                  title="Delete comment"
                  aria-label="Delete comment"
                  [disabled]="isCompleted()"
                  (click)="onDeleteComment(comment.id)"
                >
                  ✕
                </button>
              }
            </div>
          }
          @if (!isCompleted()) {
            <div class="retro-card__comment-add">
              <input
                class="retro-card__comment-input"
                type="text"
                placeholder="Add a comment..."
                aria-label="Add a comment"
                [value]="newCommentText()"
                (input)="onCommentInput($event)"
                (keydown.enter)="onAddComment()"
              />
              <button
                class="retro-card__comment-submit"
                type="button"
                title="Add comment"
                aria-label="Add comment"
                [disabled]="!newCommentText().trim()"
                (click)="onAddComment()"
              >
                ↵
              </button>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .retro-card {
      /* Column stack so the text area, author line, action row and comment section
         each take their own band of the card box and cannot overlap at any text
         length (R7.18). */
      display: flex;
      flex-direction: column;
      padding: 8px 0;
      background: var(--surface-board);
      border: 1px solid var(--color-primary-light);
      border-radius: 6px;
      font-size: 0.75rem;
      transition: box-shadow 0.15s ease, opacity 0.15s ease;
      position: relative;
      cursor: grab;
    }

    .retro-card:active {
      cursor: grabbing;
    }

    .retro-card.owner-highlight {
      /* No token for the own-card tint: mixed from the primary palette over the
         card-deck surface so it stays distinct from --surface-board while keeping
         --text-primary above 4.5:1. */
      background: var(--surface-card-selected);
      border-color: var(--color-primary);
    }

    .retro-card.dragging {
      opacity: 0.4;
      box-shadow: var(--shadow-md);
    }

    /* Text area */
    .retro-card__text {
      width: 100%;
      border: none;
      background: transparent;
      /* 12.8px, above the 12px floor R7.3 sets for every retro font size */
      font-size: 0.8rem;
      font-family: inherit;
      resize: none;
      outline: none;
      padding: 4px 8px;
      margin: 0 0 4px;
      line-height: 1.4;
      color: var(--text-primary);
      /* The height is bound inline from the measured line count; overflow therefore
         scrolls inside this box only, never over the author line, action row or
         comment section below it (R5.11, R6.5, R6.6). */
      overflow-y: auto;
      scrollbar-gutter: stable;
      box-sizing: border-box;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .retro-card__text:focus {
      background: var(--surface-card-deck);
      border-radius: 3px;
    }

    .retro-card__text:disabled {
      color: var(--text-secondary);
      cursor: default;
    }

    /* Author */
    .retro-card__author {
      display: block;
      font-size: 0.75rem;
      color: var(--text-secondary);
      margin-bottom: 4px;
      font-style: italic;
      padding: 0 8px;
    }

    /* Actions row */
    .retro-card__actions {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-top: 0;
      padding: 0 8px;
    }

    .retro-card__vote-section {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .retro-card__vote-btn,
    .retro-card__comment-btn,
    .retro-card__emoji-btn,
    .retro-card__delete-btn {
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 0.75rem;
      padding: 0;
      min-width: 32px;
      min-height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 3px;
      transition: background 0.1s ease;
    }

    .retro-card__vote-btn:hover:not(:disabled),
    .retro-card__comment-btn:hover,
    .retro-card__emoji-btn:hover,
    .retro-card__delete-btn:hover:not(:disabled) {
      /* No token for a neutral hover wash: mixed from the text token so it tints
         whichever card background is underneath. */
      background: var(--wash-neutral-weak);
    }

    .retro-card__vote-btn:disabled,
    .retro-card__delete-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .retro-card__vote-count {
      font-size: 0.75rem;
      color: var(--text-secondary);
      font-weight: 500;
    }

    .retro-card__delete-btn {
      margin-left: auto;
    }

    /* Emoji wrapper (inline in actions row) */
    .retro-card__emoji-wrapper {
      position: relative;
      display: inline-flex;
    }

    .retro-card__emoji-picker {
      position: absolute;
      bottom: 100%;
      left: 50%;
      transform: translateX(-50%);
      background: var(--surface-card-deck);
      border: 1px solid var(--color-primary-light);
      border-radius: 6px;
      padding: 4px;
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 0;
      /* 6 columns x 32px option + 2x4px padding (R7.5) */
      width: 200px;
      box-shadow: var(--shadow-md);
      z-index: 100;
      margin-bottom: 4px;
    }

    .retro-card__emoji-option {
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 0.9rem;
      padding: 0;
      min-width: 32px;
      min-height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 3px;
    }

    .retro-card__emoji-option:hover {
      background: var(--wash-neutral-weak);
    }

    /* Comments section */
    .retro-card__comments {
      margin-top: 8px;
      padding: 4px 8px 0;
      border-top: 1px solid var(--color-primary-light);
    }

    .retro-card__comment {
      display: flex;
      align-items: flex-start;
      gap: 4px;
      margin-bottom: 4px;
      font-size: 0.75rem;
      color: var(--text-primary);
    }

    .retro-card__comment-text {
      flex: 1;
      word-break: break-word;
      line-height: 1.3;
    }

    .retro-card__comment-delete {
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 0.75rem;
      color: var(--text-secondary);
      padding: 0;
      min-width: 32px;
      min-height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .retro-card__comment-delete:hover:not(:disabled) {
      /* Darkened destructive red so the glyph keeps 4.5:1 on the card surface */
      color: var(--error-ink-hover);
    }

    .retro-card__comment-delete:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* Add comment */
    .retro-card__comment-add {
      display: flex;
      gap: 4px;
      margin-top: 4px;
    }

    .retro-card__comment-input {
      flex: 1;
      border: 1px solid var(--color-primary-light);
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 0.75rem;
      font-family: inherit;
      outline: none;
      background: var(--surface-card-deck);
      color: var(--text-primary);
      min-height: 32px;
      box-sizing: border-box;
    }

    .retro-card__comment-input:focus {
      border-color: var(--color-primary);
    }

    .retro-card__comment-submit {
      border: none;
      /* --color-primary-dark, not --color-primary: white on #667eea is 3.66:1,
         below the 4.5:1 the label needs; on #5a67d8 it is 4.81:1 (R7.4) */
      background: var(--color-primary-dark);
      color: var(--text-on-primary);
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 0.75rem;
      cursor: pointer;
      min-width: 32px;
      min-height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .retro-card__comment-submit:disabled {
      background: var(--color-primary-light);
      color: var(--text-primary);
      cursor: not-allowed;
    }

    .retro-card__comment-submit:hover:not(:disabled) {
      background: var(--primary-ink-hover);
    }

    @media (prefers-reduced-motion: reduce) {
      .retro-card,
      .retro-card * {
        transition: none;
        transition-duration: 0s;
        animation-duration: 0s;
      }
    }
  `],
})
export class RetroCardComponent {
  private readonly ws = inject(RetroWebSocketService);
  private readonly retroState = inject(RetroStateService);
  private readonly elementRef = inject(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  readonly card = input.required<RetroCard>();

  /** Text area element reference */
  readonly textAreaRef = viewChild<ElementRef<HTMLTextAreaElement>>('textArea');

  /**
   * Whether the text area currently holds keyboard focus. Driven by `(focus)`/`(blur)`
   * and read by the render effect, so a focus change schedules exactly one pass that
   * re-evaluates both guards below (R5.1, R5.4, R5.8).
   */
  readonly focused = signal(false);

  /**
   * The text this component last wrote into the element — what the removed `[value]`
   * binding used to remember. Comparing against it keeps the write change-detection
   * shaped: an inbound text that is already applied is not re-written, so locally typed
   * but not yet echoed text survives the blur pass (R5.4, R5.6).
   */
  private lastAppliedText: string | null = null;

  /** UI state signals */
  readonly showComments = signal(false);
  readonly showEmojiPicker = signal(false);
  readonly newCommentText = signal('');

  /** Common emojis for quick insertion */
  readonly commonEmojis = ['👍', '👎', '❤️', '🎉', '🤔', '😊', '🔥', '⭐', '✅', '❌', '💡', '🚀'];

  /**
   * Bumped whenever something other than `card().text` invalidates the measurement —
   * the text area width changing, or the user typing uncommitted text (R6.7). The
   * render effect tracks it, so a bump schedules exactly one re-measure.
   */
  private readonly measurementRevision = signal(0);

  /** Last geometry read off the rendered text area. */
  private readonly textAreaGeometry = signal<TextAreaGeometry>(UNMEASURED_GEOMETRY, {
    equal: geometryEquals,
  });

  /** Fluid unless the received configuration explicitly says otherwise (R6.3, R13.11). */
  readonly fluidCardHeight = computed(() =>
    resolveFluidCardHeight(this.retroState.config()?.fluidCardHeight)
  );

  /**
   * Applied text area height: `clamp(lines) × lineHeight + padding`, where the clamp is
   * `(3, 12)` when fluid and `(4, 4)` when not (R6.4, R6.5, R6.6). Independent of the
   * column layout — only `availableWidthPx` differs between layouts (R6.14).
   */
  readonly textAreaHeightPx = computed(() => {
    const geometry = this.textAreaGeometry();
    return computeTextAreaHeightPx(geometry.lineCount, {
      lineHeightPx: geometry.lineHeightPx,
      verticalPaddingPx: geometry.verticalPaddingPx,
      fluid: this.fluidCardHeight(),
    });
  });

  constructor() {
    afterNextRender(() => {
      const lastAddedId = this.retroState.lastAddedOwnCardId();
      if (lastAddedId && lastAddedId === this.card().id) {
        const textAreaEl = this.textAreaRef()?.nativeElement;
        if (textAreaEl) {
          textAreaEl.focus();
          textAreaEl.selectionStart = 0;
          textAreaEl.selectionEnd = 0;
        }
        this.retroState.lastAddedOwnCardId.set(null);
      }

      this.observeTextAreaWidth();
    });

    // Tracks the text, the fluid mode, the focus flag and the revision counter, so each
    // of them schedules exactly one pass. The line count itself comes from the rendered
    // element rather than being predicted (R6.7).
    afterRenderEffect(() => {
      const text = this.card().text;
      const fluid = this.fluidCardHeight();
      const focused = this.focused();
      this.measurementRevision();

      // The inbound text lands before the measurement so the height describes what is
      // actually in the element; while focused the element is left entirely alone.
      if (!focused) {
        this.applyIncomingText(text);
      }
      this.measureTextArea(text, fluid);
      if (!focused) {
        this.pinScrollToTop();
      }
    });
  }

  /**
   * Writes an inbound text into the unfocused element. Skipped when the same text is
   * already applied, which is what preserves text the user typed and committed but that
   * the server has not echoed back yet.
   */
  private applyIncomingText(text: string): void {
    const el = this.textAreaRef()?.nativeElement;
    if (!el || this.lastAppliedText === text) {
      return;
    }
    this.lastAppliedText = text;
    if (el.value !== text) {
      el.value = text;
    }
  }

  /**
   * Pins the first line of an unfocused text area to the top of its box, on first
   * render and after every inbound update, whether the text overflows or not
   * (R5.1, R5.2, R5.3, R5.10). The text itself is untouched by the reset.
   */
  private pinScrollToTop(): void {
    const el = this.textAreaRef()?.nativeElement;
    if (el && el.scrollTop !== 0) {
      el.scrollTop = 0;
    }
  }

  /**
   * Re-measures when the text area's content width changes — a column layout switch, a
   * window resize or a scrollbar appearing (R6.7, R6.14). Height changes are ignored on
   * purpose: the applied height is itself an output of the measurement, so reacting to
   * it would feed back into this observer.
   */
  private observeTextAreaWidth(): void {
    const el = this.textAreaRef()?.nativeElement;
    if (!el || typeof ResizeObserver === 'undefined') {
      return;
    }

    let lastWidthPx = -1;
    const observer = new ResizeObserver(entries => {
      const widthPx = entries[0]?.contentRect.width ?? 0;
      if (widthPx === lastWidthPx) {
        return;
      }
      lastWidthPx = widthPx;
      this.measurementRevision.update(revision => revision + 1);
    });
    observer.observe(el);
    this.destroyRef.onDestroy(() => observer.disconnect());
  }

  /**
   * Reads the rendered line count and feeds it to the shared clamp.
   *
   * The element is collapsed to a zero content box for the read so `scrollHeight`
   * reports the height the text actually occupies instead of the height already
   * applied — otherwise a card could only ever grow. The read and the restore happen in
   * the same task, so nothing is painted at the intermediate height. Where the
   * environment performs no layout (`scrollHeight === 0`), the DOM-free greedy wrap
   * stands in.
   */
  private measureTextArea(text: string, fluid: boolean): void {
    const el = this.textAreaRef()?.nativeElement;
    if (!el) {
      return;
    }

    const style = getComputedStyle(el);
    const fontSizePx = parseComputedPx(style.fontSize);
    const lineHeightPx = parseComputedPx(style.lineHeight);
    const verticalPaddingPx =
      orZero(parseComputedPx(style.paddingTop)) + orZero(parseComputedPx(style.paddingBottom));

    const inlinePaddingPx =
      orZero(parseComputedPx(style.paddingLeft)) + orZero(parseComputedPx(style.paddingRight));
    const contentWidthPx = el.clientWidth - inlinePaddingPx;
    const availableWidthPx = contentWidthPx > 0 ? contentWidthPx : FALLBACK_AVAILABLE_WIDTH_PX;

    const appliedHeight = el.style.height;
    el.style.height = '0px';
    const contentHeightPx = el.scrollHeight;
    el.style.height = appliedHeight;

    const lineCount =
      contentHeightPx > 0 && lineHeightPx > 0
        ? (contentHeightPx - verticalPaddingPx) / lineHeightPx
        : measureLineCount(text, {
            availableWidthPx,
            charWidthPx: fontSizePx * AVERAGE_CHAR_WIDTH_RATIO,
          });

    // Apply straight away so the measured height is the one that gets painted; the
    // `[style.height.px]` binding writes the same value on the next change pass.
    const heightPx = computeTextAreaHeightPx(lineCount, {
      lineHeightPx,
      verticalPaddingPx,
      fluid,
    });
    el.style.height = `${heightPx}px`;

    this.textAreaGeometry.set({ lineCount, lineHeightPx, verticalPaddingPx });
  }

  /** Computed: whether board is completed */
  readonly isCompleted = this.retroState.isCompleted;

  /** Computed: whether this card is highlighted as owned by the current user */
  readonly isOwnerHighlighted = computed(() => {
    return this.retroState.ownNewCardIds().has(this.card().id);
  });

  /** Computed: whether voting is enabled */
  readonly votingEnabled = this.retroState.votingEnabled;

  /** Computed: remaining votes for current user */
  readonly votesRemaining = this.retroState.votesRemaining;

  /** Computed: whether to hide vote count */
  readonly hideVoteCount = computed(() => {
    const config = this.retroState.config();
    return config?.hideVoteCount ?? false;
  });

  /** Computed: whether to show card author */
  readonly showCardAuthor = computed(() => {
    const config = this.retroState.config();
    return config?.showCardAuthor ?? false;
  });

  /** Computed: whether GIF/emoji is enabled */
  readonly enableGifEmoji = computed(() => {
    const config = this.retroState.config();
    return config?.enableGifEmoji ?? true;
  });

  /** Computed: whether current user can delete this card (author or moderator) */
  readonly canDelete = computed(() => {
    const userId = this.retroState.currentUserId();
    const isModerator = this.retroState.isModerator();
    const cardData = this.card();
    if (!userId) return false;
    return cardData.authorId === userId || isModerator;
  });

  // --- Text editing ---

  /**
   * Uncommitted typing does not change `card().text`, so the height is re-measured from
   * the revision counter instead (R6.7).
   */
  onTextInput(): void {
    this.measurementRevision.update(revision => revision + 1);
  }

  onTextFocus(): void {
    this.focused.set(true);
  }

  /**
   * Clears the focus flag and resets the scroll offset in the same turn as the focus
   * loss, without touching the text (R5.4), then keeps the existing "send an edit when
   * the text differs from the one last received" behaviour (R5.6).
   */
  onTextBlur(event: FocusEvent): void {
    const target = event.target as HTMLTextAreaElement;
    const newText = target.value;
    const cardData = this.card();

    this.focused.set(false);
    target.scrollTop = 0;

    if (newText !== cardData.text) {
      this.ws.sendCardEdit(cardData.id, newText);
    }
  }

  onTextEnter(event: Event): void {
    const keyEvent = event as KeyboardEvent;
    if (!keyEvent.shiftKey) {
      keyEvent.preventDefault();
      (keyEvent.target as HTMLTextAreaElement).blur();
    }
  }

  // --- Voting ---

  onVote(): void {
    const cardData = this.card();
    this.ws.sendCardVote(cardData.id);
  }

  // --- Comments ---

  toggleComments(): void {
    this.showComments.update(v => !v);
  }

  onCommentInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.newCommentText.set(target.value);
  }

  onAddComment(): void {
    const text = this.newCommentText().trim();
    if (!text) return;
    const cardData = this.card();
    this.ws.sendCommentAdd(cardData.id, text);
    this.newCommentText.set('');
  }

  onDeleteComment(commentId: string): void {
    const cardData = this.card();
    this.ws.sendCommentRemove(cardData.id, commentId);
  }

  canDeleteComment(commentAuthorId: string): boolean {
    const userId = this.retroState.currentUserId();
    const isModerator = this.retroState.isModerator();
    if (!userId) return false;
    return commentAuthorId === userId || isModerator;
  }

  // --- Delete card ---

  onDelete(): void {
    const cardData = this.card();
    this.ws.sendCardRemove(cardData.id);
  }

  // --- Emoji ---

  toggleEmojiPicker(): void {
    this.showEmojiPicker.update(v => !v);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.showEmojiPicker() && !this.elementRef.nativeElement.contains(event.target)) {
      this.showEmojiPicker.set(false);
    }
  }

  insertEmoji(emoji: string): void {
    const textAreaEl = this.textAreaRef()?.nativeElement;
    if (textAreaEl) {
      const start = textAreaEl.selectionStart;
      const end = textAreaEl.selectionEnd;
      const currentValue = textAreaEl.value;
      const newValue = currentValue.substring(0, start) + emoji + currentValue.substring(end);
      textAreaEl.value = newValue;
      textAreaEl.selectionStart = textAreaEl.selectionEnd = start + emoji.length;
      textAreaEl.focus();
      // A direct value write fires no `input` event, so invalidate the measurement here.
      this.onTextInput();
    }
    this.showEmojiPicker.set(false);
  }

  // --- Drag and Drop ---

  onDragStart(event: DragEvent): void {
    const cardData = this.card();
    event.dataTransfer!.setData('text/retro-card-id', cardData.id);
    event.dataTransfer!.setData('text/retro-source-column-id', cardData.columnId);
    event.dataTransfer!.effectAllowed = 'move';
    (event.currentTarget as HTMLElement).classList.add('dragging');
    // Stop propagation so the column header drag doesn't interfere
    event.stopPropagation();
  }

  onDragEnd(event: DragEvent): void {
    (event.currentTarget as HTMLElement).classList.remove('dragging');
  }
}
