import { Component, inject, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';

@Component({
  selector: 'app-story-manager',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    @if (canManageStories() || isModerator()) {
      <section class="story-manager" role="region" aria-label="Story management">
        @if (isRoundActive()) {
          <div class="story-manager__current-story">
            <span class="story-manager__label">Current Story</span>
            <p class="story-manager__story-text">{{ currentStoryDescription() }}</p>
          </div>
        }

        @if (!isRoundActive()) {
          <form class="story-manager__form" (ngSubmit)="submitStory()" novalidate>
            <label class="story-manager__label" for="story-input">
              Story Description
            </label>
            <input
              id="story-input"
              class="story-manager__input"
              type="text"
              [(ngModel)]="storyDescription"
              name="storyDescription"
              placeholder="Enter story description..."
              aria-label="Story description"
              [attr.aria-invalid]="showValidationError()"
              aria-describedby="story-error"
              (keydown.enter)="submitStory()"
            />
            @if (showValidationError()) {
              <span id="story-error" class="story-manager__error" role="alert">
                Story description is required
              </span>
            }
            <button
              type="submit"
              class="story-manager__btn story-manager__btn--submit"
              aria-label="Submit story for estimation"
              title="Submit story for estimation"
            >
              Submit Story
            </button>
          </form>
        }

        <div class="story-manager__actions">
        </div>
      </section>
    }
  `,
  styles: [
    `
      .story-manager {
        padding: 0.5rem 0;
      }

      .story-manager__form {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }

      .story-manager__label {
        font-weight: 600;
        font-size: 0.8rem;
      }

      .story-manager__input {
        padding: 0.375rem 0.625rem;
        border: 2px solid #ccc;
        border-radius: 6px;
        font-size: 1rem;
        min-height: 36px;
      }

      .story-manager__input:focus {
        outline: 2px solid #1976d2;
        outline-offset: 2px;
        border-color: #1976d2;
      }

      .story-manager__input[aria-invalid='true'] {
        border-color: #d32f2f;
      }

      .story-manager__error {
        color: #d32f2f;
        font-size: 0.85rem;
      }

      .story-manager__actions {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
        margin-top: 0.75rem;
        padding-top: 0.75rem;
        border-top: 1px solid #e5e7eb;
      }

      .story-manager__btn {
        padding: 0.375rem 0.75rem;
        border: none;
        border-radius: 6px;
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
        min-width: 44px;
        min-height: 44px;
        transition: background-color 0.2s, opacity 0.2s;
      }

      .story-manager__btn:focus-visible {
        outline: 2px solid #1976d2;
        outline-offset: 2px;
      }

      .story-manager__btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .story-manager__btn--submit {
        background-color: #1976d2;
        color: #fff;
      }

      .story-manager__btn--submit:hover:not(:disabled) {
        background-color: #1565c0;
      }

      .story-manager__btn--reveal {
        background-color: #388e3c;
        color: #fff;
      }

      .story-manager__btn--reveal:hover:not(:disabled) {
        background-color: #2e7d32;
      }

      .story-manager__btn--clear {
        background-color: #f57c00;
        color: #fff;
      }

      .story-manager__btn--clear:hover:not(:disabled) {
        background-color: #ef6c00;
      }

      .story-manager__btn--revote {
        background-color: #7b1fa2;
        color: #fff;
      }

      .story-manager__btn--revote:hover:not(:disabled) {
        background-color: #6a1b9a;
      }

      .story-manager__current-story {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        padding: 0.75rem;
        background: #e3f2fd;
        border-radius: 6px;
        border: 1px solid #90caf9;
        margin-bottom: 0.5rem;
      }

      .story-manager__story-text {
        font-size: 1rem;
        font-weight: 500;
        color: var(--text-primary, #1a1a2e);
        margin: 0;
      }
    `,
  ],
})
export class StoryManagerComponent {
  private readonly sessionState = inject(SessionStateService);
  private readonly wsService = inject(WebSocketService);

  storyDescription = '';
  private readonly _showValidationError = signal(false);

  readonly isModerator = computed(() => {
    const user = this.sessionState.currentUser();
    return user?.role === 'moderator';
  });

  /**
   * Whether the current user can manage stories (submit).
   * Uses session-based issuePermission when available, falls back to moderator-only.
   */
  readonly canManageStories = computed(() => {
    const hasSessionPermission = this.sessionState.hasIssuePermission();
    if (hasSessionPermission) return true;
    // If no session config is available, hasIssuePermission returns false.
    // Fall back to moderator-only behavior when there's no session config.
    const config = this.sessionState.sessionConfig();
    if (!config) {
      return this.isModerator();
    }
    return false;
  });

  /**
   * Whether the current user can reveal cards.
   * Uses session-based revealPermission when available, falls back to moderator-only.
   */
  readonly canRevealCards = computed(() => {
    const hasSessionPermission = this.sessionState.hasRevealPermission();
    if (hasSessionPermission) return true;
    // Fall back to moderator-only when no session config
    const config = this.sessionState.sessionConfig();
    if (!config) {
      return this.isModerator();
    }
    return false;
  });

  readonly isRoundActive = computed(() => {
    const round = this.sessionState.currentRound();
    return round !== null && (round.status === 'voting' || round.status === 'revealed');
  });

  readonly currentStoryDescription = computed(() => {
    return this.sessionState.currentRound()?.storyDescription ?? '';
  });

  readonly canReveal = computed(() => {
    const round = this.sessionState.currentRound();
    return round !== null && round.status === 'voting';
  });

  readonly canClear = computed(() => {
    return this.sessionState.isRevealed();
  });

  readonly isRevealed = computed(() => {
    return this.sessionState.isRevealed();
  });

  showValidationError(): boolean {
    return this._showValidationError();
  }

  submitStory(): void {
    const description = this.storyDescription.trim();
    if (!description) {
      this._showValidationError.set(true);
      return;
    }
    this._showValidationError.set(false);
    this.wsService.send('story:submit', { storyDescription: description });
    this.storyDescription = '';
  }

  revealCards(): void {
    this.wsService.send('cards:reveal', {});
  }

  clearBoard(): void {
    this.wsService.send('board:clear', {});
  }

  revote(): void {
    this.wsService.send('round:revote', {});
  }
}
