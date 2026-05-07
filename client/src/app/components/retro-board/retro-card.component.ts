import { Component, input, inject, signal, computed, ElementRef, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RetroCard } from '@shared/types';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { RetroStateService } from '../../services/retro-state.service';

@Component({
  selector: 'app-retro-card',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div
      class="retro-card"
      [attr.data-card-id]="card().id"
      draggable="true"
      (dragstart)="onDragStart($event)"
      (dragend)="onDragEnd($event)"
    >
      <!-- Editable text area -->
      <textarea
        #textArea
        class="retro-card__text"
        [value]="card().text"
        [disabled]="isCompleted()"
        (blur)="onTextBlur($event)"
        (keydown.enter)="onTextEnter($event)"
        (mousedown)="$event.stopPropagation()"
        draggable="false"
        rows="2"
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
      padding: 0.5rem;
      background: #e8ecf0;
      border: 1px solid #d0d5dd;
      border-radius: 6px;
      font-size: 0.75rem;
      transition: box-shadow 0.15s ease, opacity 0.15s ease;
      position: relative;
      cursor: grab;
    }

    .retro-card:active {
      cursor: grabbing;
    }

    .retro-card.dragging {
      opacity: 0.4;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    }

    /* Text area */
    .retro-card__text {
      width: 100%;
      border: none;
      background: transparent;
      font-size: 0.8rem;
      font-family: inherit;
      resize: none;
      outline: none;
      padding: 0.125rem 0;
      margin: 0 0 0.25rem;
      word-break: break-word;
      line-height: 1.4;
      color: #1a1a2e;
    }

    .retro-card__text:focus {
      background: #fff;
      border-radius: 3px;
      padding: 0.125rem 0.25rem;
    }

    .retro-card__text:disabled {
      color: #333;
      cursor: default;
    }

    /* Author */
    .retro-card__author {
      display: block;
      font-size: 0.65rem;
      color: #666;
      margin-bottom: 0.25rem;
      font-style: italic;
    }

    /* Actions row */
    .retro-card__actions {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      margin-top: 0.125rem;
    }

    .retro-card__vote-section {
      display: flex;
      align-items: center;
      gap: 0.125rem;
    }

    .retro-card__vote-btn,
    .retro-card__comment-btn,
    .retro-card__emoji-btn,
    .retro-card__delete-btn {
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 0.75rem;
      padding: 0.125rem;
      min-width: 28px;
      min-height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      transition: background 0.1s ease;
    }

    .retro-card__vote-btn:hover:not(:disabled),
    .retro-card__comment-btn:hover,
    .retro-card__emoji-btn:hover,
    .retro-card__delete-btn:hover:not(:disabled) {
      background: rgba(0, 0, 0, 0.08);
    }

    .retro-card__vote-btn:disabled,
    .retro-card__delete-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .retro-card__vote-count {
      font-size: 0.65rem;
      color: #555;
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
      top: 100%;
      left: 0;
      background: #fff;
      border: 1px solid #d0d5dd;
      border-radius: 6px;
      padding: 0.375rem;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 0.125rem;
      width: 160px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 100;
    }

    .retro-card__emoji-option {
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 1rem;
      padding: 0.2rem;
      min-width: 30px;
      min-height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
    }

    .retro-card__emoji-option:hover {
      background: #f0f0f0;
    }

    /* Comments section */
    .retro-card__comments {
      margin-top: 0.375rem;
      padding-top: 0.25rem;
      border-top: 1px solid #ccc;
    }

    .retro-card__comment {
      display: flex;
      align-items: flex-start;
      gap: 0.25rem;
      margin-bottom: 0.25rem;
      font-size: 0.7rem;
      color: #444;
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
      font-size: 0.65rem;
      color: #999;
      padding: 0;
      min-width: 18px;
      min-height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .retro-card__comment-delete:hover:not(:disabled) {
      color: #d32f2f;
    }

    .retro-card__comment-delete:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* Add comment */
    .retro-card__comment-add {
      display: flex;
      gap: 0.25rem;
      margin-top: 0.25rem;
    }

    .retro-card__comment-input {
      flex: 1;
      border: 1px solid #d0d5dd;
      border-radius: 4px;
      padding: 0.25rem 0.375rem;
      font-size: 0.7rem;
      font-family: inherit;
      outline: none;
      background: #fff;
    }

    .retro-card__comment-input:focus {
      border-color: #667eea;
    }

    .retro-card__comment-submit {
      border: none;
      background: #667eea;
      color: #fff;
      border-radius: 4px;
      padding: 0.25rem 0.5rem;
      font-size: 0.7rem;
      cursor: pointer;
      min-width: 28px;
      min-height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .retro-card__comment-submit:disabled {
      background: #ccc;
      cursor: not-allowed;
    }

    .retro-card__comment-submit:hover:not(:disabled) {
      background: #5a6fd6;
    }

    @media (prefers-reduced-motion: reduce) {
      .retro-card,
      .retro-card__vote-btn,
      .retro-card__comment-btn,
      .retro-card__delete-btn {
        transition: none;
      }
    }
  `],
})
export class RetroCardComponent {
  private readonly ws = inject(RetroWebSocketService);
  private readonly retroState = inject(RetroStateService);

  readonly card = input.required<RetroCard>();

  /** Text area element reference */
  readonly textAreaRef = viewChild<ElementRef<HTMLTextAreaElement>>('textArea');

  /** UI state signals */
  readonly showComments = signal(false);
  readonly showEmojiPicker = signal(false);
  readonly newCommentText = signal('');

  /** Common emojis for quick insertion */
  readonly commonEmojis = ['👍', '👎', '❤️', '🎉', '🤔', '😊', '🔥', '⭐', '✅', '❌', '💡', '🚀'];

  /** Computed: whether board is completed */
  readonly isCompleted = this.retroState.isCompleted;

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

  onTextBlur(event: FocusEvent): void {
    const target = event.target as HTMLTextAreaElement;
    const newText = target.value;
    const cardData = this.card();
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
    }
    this.showEmojiPicker.set(false);
  }

  // --- Drag and Drop ---

  onDragStart(event: DragEvent): void {
    const cardData = this.card();
    event.dataTransfer?.setData('application/retro-card-id', cardData.id);
    event.dataTransfer?.setData('application/retro-source-column-id', cardData.columnId);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
    }
    (event.currentTarget as HTMLElement).classList.add('dragging');
  }

  onDragEnd(event: DragEvent): void {
    (event.currentTarget as HTMLElement).classList.remove('dragging');
  }
}
