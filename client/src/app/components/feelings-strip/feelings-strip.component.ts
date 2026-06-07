import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FeelingCategory, FEELING_EMOJI_MAP } from '@shared/types';
import { RetroStateService } from '../../services/retro-state.service';
import { FeelingsService } from '../../services/feelings.service';
import { FeelingsSummaryPopupComponent } from '../feelings-summary-popup/feelings-summary-popup.component';

/**
 * Feelings Strip component displays a golden/yellow bordered container
 * with emoji buttons for participants to select their current mood.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.3, 3.5, 3.6, 5.1
 */
@Component({
  selector: 'app-feelings-strip',
  standalone: true,
  imports: [CommonModule, FeelingsSummaryPopupComponent],
  template: `
    <div class="feelings-strip" role="group" aria-label="Your feeling">
      <span class="feelings-strip__label">Your feeling</span>
      <div class="feelings-strip__emojis">
        @for (category of allowedFeelings(); track category) {
          <button
            class="feelings-strip__emoji-btn"
            [class.feelings-strip__emoji-btn--selected]="category === myFeeling()"
            [title]="formatCategory(category)"
            [attr.aria-label]="formatCategory(category)"
            [attr.aria-pressed]="category === myFeeling()"
            [disabled]="isCompleted()"
            (click)="onEmojiClick(category)"
          >{{ getEmoji(category) }}</button>
        }
      </div>
      @if (isModerator()) {
        <button
          class="feelings-strip__summary-btn"
          title="Feelings Summary"
          aria-label="Feelings Summary"
          (click)="showSummaryPopup.set(true)"
        >📊</button>
      }
    </div>

    @if (showSummaryPopup()) {
      <app-feelings-summary-popup
        [open]="showSummaryPopup()"
        (closed)="showSummaryPopup.set(false)"
      />
    }
  `,
  styles: [`
    .feelings-strip {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.125rem 0.5rem;
      border: 1.5px solid #d4a017;
      border-radius: 6px;
      background: #fffef5;
    }

    .feelings-strip__label {
      font-size: 0.75rem;
      font-weight: 600;
      color: #8b6914;
      white-space: nowrap;
      user-select: none;
    }

    .feelings-strip__emojis {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .feelings-strip__emoji-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      padding: 0;
      border: 1.5px solid transparent;
      border-radius: 4px;
      background: transparent;
      cursor: pointer;
      font-size: 1.1rem;
      line-height: 1;
      transition: transform 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
    }

    .feelings-strip__emoji-btn:hover:not(:disabled) {
      background: rgba(212, 160, 23, 0.1);
      transform: scale(1.15);
    }

    .feelings-strip__emoji-btn--selected {
      border-color: #d4a017;
      background: rgba(212, 160, 23, 0.2);
      transform: scale(1.1);
    }

    .feelings-strip__emoji-btn--selected:hover:not(:disabled) {
      background: rgba(212, 160, 23, 0.3);
      transform: scale(1.15);
    }

    .feelings-strip__emoji-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none;
    }

    .feelings-strip__emoji-btn:focus-visible {
      outline: 2px solid #d4a017;
      outline-offset: 2px;
    }

    .feelings-strip__summary-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      padding: 0;
      border: 1px solid #d0d5dd;
      border-radius: 4px;
      background: transparent;
      cursor: pointer;
      font-size: 0.85rem;
      line-height: 1;
      margin-left: 0.125rem;
      transition: background-color 0.15s ease;
    }

    .feelings-strip__summary-btn:hover {
      background: #f0f0f0;
    }

    .feelings-strip__summary-btn:focus-visible {
      outline: 2px solid #d4a017;
      outline-offset: 2px;
    }

    @media (prefers-reduced-motion: reduce) {
      .feelings-strip__emoji-btn,
      .feelings-strip__summary-btn {
        transition: none;
      }

      .feelings-strip__emoji-btn:hover:not(:disabled),
      .feelings-strip__emoji-btn--selected,
      .feelings-strip__emoji-btn--selected:hover:not(:disabled) {
        transform: none;
      }
    }
  `],
})
export class FeelingsStripComponent {
  private readonly retroState = inject(RetroStateService);
  private readonly feelingsService = inject(FeelingsService);

  /** Whether the summary popup is open */
  readonly showSummaryPopup = signal(false);

  /** Whether the current user is a moderator */
  readonly isModerator = this.retroState.isModerator;

  /** Whether the board is completed */
  readonly isCompleted = this.retroState.isCompleted;

  /** Current user's selected feeling */
  readonly myFeeling = this.feelingsService.myFeeling;

  /** Allowed feelings from configuration */
  readonly allowedFeelings = computed<FeelingCategory[]>(() => {
    const config = this.retroState.config();
    return config?.allowedFeelings ?? [];
  });

  /**
   * Get the emoji character for a given feeling category.
   */
  getEmoji(category: FeelingCategory): string {
    return FEELING_EMOJI_MAP[category];
  }

  /**
   * Format category name for display in tooltips (replace underscores with spaces).
   */
  formatCategory(category: FeelingCategory): string {
    return category.replace(/_/g, ' ');
  }

  /**
   * Handle emoji button click.
   * Toggle logic: if clicking the same feeling as current, deselect (pass null).
   */
  onEmojiClick(category: FeelingCategory): void {
    const current = this.myFeeling();
    if (current === category) {
      this.feelingsService.selectFeeling(null);
    } else {
      this.feelingsService.selectFeeling(category);
    }
  }
}
