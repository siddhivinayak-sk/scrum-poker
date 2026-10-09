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
    /* Sits as a non-stretching item in the retro toolbar row (R10.10) */
    :host {
      display: inline-flex;
      flex: 0 0 auto;
      min-width: 0;
    }

    /* 32px block size so the strip fits a single 40px toolbar row (R10.4, R10.10).
       --card-color-5 (#d69e2e) is the token nearest the strip's golden accent. */
    .feelings-strip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 32px;
      padding: 0 4px;
      box-sizing: border-box;
      border: 1px solid var(--card-color-5);
      border-radius: 6px;
      background: var(--surface-card-deck);
    }

    .feelings-strip__label {
      /* 12px floor on --surface-card-deck for >= 4.5:1 (R10.6) */
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      user-select: none;
    }

    .feelings-strip__emojis {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .feelings-strip__emoji-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      /* 32x32 minimum pointer target (R10.3) */
      width: 32px;
      height: 32px;
      min-width: 32px;
      min-height: 32px;
      flex: 0 0 auto;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;
      cursor: pointer;
      font-size: 1.1rem;
      line-height: 1;
      transition: transform 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
    }

    .feelings-strip__emoji-btn:hover:not(:disabled) {
      /* No token for a golden wash: mixed from the accent token over transparent. */
      background: var(--wash-accent-weak);
      transform: scale(1.15);
    }

    .feelings-strip__emoji-btn--selected {
      border-color: var(--card-color-5);
      background: var(--wash-accent-medium);
      transform: scale(1.1);
    }

    .feelings-strip__emoji-btn--selected:hover:not(:disabled) {
      background: var(--wash-accent-strong);
      transform: scale(1.15);
    }

    .feelings-strip__emoji-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none;
    }

    .feelings-strip__emoji-btn:focus-visible {
      /* --color-primary-dark clears 3:1 against the strip surface (R10.6) */
      outline: 2px solid var(--color-primary-dark);
      outline-offset: 2px;
    }

    .feelings-strip__summary-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      min-width: 32px;
      min-height: 32px;
      flex: 0 0 auto;
      padding: 0;
      border: 1px solid var(--color-primary-light);
      border-radius: 4px;
      background: transparent;
      cursor: pointer;
      font-size: 0.85rem;
      line-height: 1;
      margin-left: 4px;
      transition: background-color 0.15s ease;
    }

    .feelings-strip__summary-btn:hover {
      background: var(--wash-neutral-weak);
    }

    .feelings-strip__summary-btn:focus-visible {
      outline: 2px solid var(--color-primary-dark);
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
