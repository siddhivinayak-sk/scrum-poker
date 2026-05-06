import { Component, inject, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { HistoryEntry } from '@shared/types';

/**
 * Pure function: format a history entry for summary display.
 */
export interface HistorySummary {
  roundId: string;
  storyDescription: string;
  average: string;
  mode: string;
  completedAt: string;
}

export function deriveHistorySummary(entry: HistoryEntry): HistorySummary {
  return {
    roundId: entry.roundId,
    storyDescription: entry.storyDescription,
    average:
      entry.metrics.average !== null ? entry.metrics.average.toFixed(1) : '—',
    mode: entry.metrics.mode !== null ? String(entry.metrics.mode) : '—',
    completedAt: entry.completedAt,
  };
}

@Component({
  selector: 'app-session-history',
  standalone: true,
  imports: [CommonModule],
  template: `
    <aside class="session-history" role="complementary" aria-label="Session history">
      <div class="session-history__header">
        <h2 class="session-history__title">History</h2>
        @if (isModerator()) {
          <button
            class="session-history__clear-btn"
            (click)="promptClearHistory()"
            aria-label="Clear session history"
            [disabled]="history().length === 0"
          >
            Clear History
          </button>
        }
      </div>

      @if (showConfirmDialog()) {
        <div class="session-history__confirm" role="alertdialog" aria-label="Confirm clear history">
          <p>Clear all history entries?</p>
          <div class="session-history__confirm-actions">
            <button
              class="session-history__confirm-btn session-history__confirm-btn--yes"
              (click)="confirmClear()"
              aria-label="Confirm clear history"
            >
              Yes, Clear
            </button>
            <button
              class="session-history__confirm-btn session-history__confirm-btn--no"
              (click)="cancelClear()"
              aria-label="Cancel clear history"
            >
              Cancel
            </button>
          </div>
        </div>
      }

      @if (history().length === 0) {
        <p class="session-history__empty">No completed rounds yet.</p>
      } @else {
        <ul class="session-history__list" role="list">
          @for (entry of history(); track entry.roundId) {
            <li class="session-history__item">
              <button
                class="session-history__item-header"
                (click)="toggleExpand(entry.roundId)"
                [attr.aria-expanded]="isExpanded(entry.roundId)"
                aria-label="Toggle details for {{ entry.storyDescription }}"
              >
                <span class="session-history__story">{{ entry.storyDescription }}</span>
                <span class="session-history__summary">
                  Avg: {{ getSummary(entry).average }} | Mode: {{ getSummary(entry).mode }}
                </span>
              </button>

              @if (isExpanded(entry.roundId)) {
                <div class="session-history__detail" role="region" aria-label="Round details">
                  <h4>Votes</h4>
                  <ul class="session-history__votes">
                    @for (vote of entry.participants; track vote.userId) {
                      <li class="session-history__vote">
                        <span class="session-history__vote-name">{{ vote.displayName }}</span>
                        <span class="session-history__vote-value">
                          {{ vote.cardValue !== null ? vote.cardValue : 'No Vote' }}
                        </span>
                      </li>
                    }
                  </ul>
                  <div class="session-history__metrics">
                    <span>Average: {{ getSummary(entry).average }}</span>
                    <span>Mode: {{ getSummary(entry).mode }}</span>
                    @if (entry.metrics.spread !== null) {
                      <span>Spread: {{ entry.metrics.spread }}</span>
                    }
                    @if (entry.metrics.outliers.length > 0) {
                      <span>Outliers: {{ entry.metrics.outliers.length }}</span>
                    }
                  </div>
                </div>
              }
            </li>
          }
        </ul>
      }
    </aside>
  `,
  styles: [
    `
      .session-history {
        padding: 0.75rem;
        border-left: 2px solid #e0e0e0;
        height: 100%;
        overflow-y: auto;
      }

      .session-history__header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 0.75rem;
      }

      .session-history__title {
        margin: 0;
        font-size: 1rem;
      }

      .session-history__clear-btn {
        padding: 0.3rem 0.625rem;
        border: 1px solid #d32f2f;
        border-radius: 6px;
        background: #fff;
        color: #d32f2f;
        font-size: 0.75rem;
        font-weight: 600;
        cursor: pointer;
        min-height: 44px;
        min-width: 44px;
      }

      .session-history__clear-btn:hover:not(:disabled) {
        background: #ffebee;
      }

      .session-history__clear-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .session-history__clear-btn:focus-visible {
        outline: 2px solid #1976d2;
        outline-offset: 2px;
      }

      .session-history__confirm {
        background: #fff3e0;
        border: 1px solid #f57c00;
        border-radius: 6px;
        padding: 0.75rem;
        margin-bottom: 1rem;
      }

      .session-history__confirm p {
        margin: 0 0 0.5rem;
        font-weight: 600;
      }

      .session-history__confirm-actions {
        display: flex;
        gap: 0.5rem;
      }

      .session-history__confirm-btn {
        padding: 0.4rem 0.75rem;
        border: none;
        border-radius: 6px;
        font-size: 0.85rem;
        font-weight: 600;
        cursor: pointer;
        min-height: 44px;
        min-width: 44px;
      }

      .session-history__confirm-btn:focus-visible {
        outline: 2px solid #1976d2;
        outline-offset: 2px;
      }

      .session-history__confirm-btn--yes {
        background: #d32f2f;
        color: #fff;
      }

      .session-history__confirm-btn--no {
        background: #e0e0e0;
        color: #333;
      }

      .session-history__empty {
        color: #595959;
        font-style: italic;
      }

      .session-history__list {
        list-style: none;
        padding: 0;
        margin: 0;
      }

      .session-history__item {
        border-bottom: 1px solid #eee;
      }

      .session-history__item-header {
        display: flex;
        flex-direction: column;
        width: 100%;
        padding: 0.75rem 0.5rem;
        border: none;
        background: none;
        cursor: pointer;
        text-align: left;
        min-height: 44px;
      }

      .session-history__item-header:hover {
        background: #f5f5f5;
      }

      .session-history__item-header:focus-visible {
        outline: 2px solid #1976d2;
        outline-offset: -2px;
      }

      .session-history__story {
        font-weight: 600;
        font-size: 0.8rem;
        margin-bottom: 0.25rem;
      }

      .session-history__summary {
        font-size: 0.75rem;
        color: #595959;
      }

      .session-history__detail {
        padding: 0.5rem 0.75rem 0.75rem;
        background: #fafafa;
      }

      .session-history__detail h4 {
        margin: 0 0 0.375rem;
        font-size: 0.8rem;
      }

      .session-history__votes {
        list-style: none;
        padding: 0;
        margin: 0 0 0.5rem;
      }

      .session-history__vote {
        display: flex;
        justify-content: space-between;
        padding: 0.2rem 0;
        font-size: 0.8rem;
      }

      .session-history__vote-name {
        font-weight: 500;
      }

      .session-history__vote-value {
        color: #1976d2;
        font-weight: 600;
      }

      .session-history__metrics {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
        font-size: 0.75rem;
        color: #595959;
        margin-top: 0.375rem;
      }
    `,
  ],
})
export class SessionHistoryComponent {
  private readonly sessionState = inject(SessionStateService);
  private readonly wsService = inject(WebSocketService);

  private readonly _expandedRounds = signal<Set<string>>(new Set());
  private readonly _showConfirmDialog = signal(false);

  readonly isModerator = computed(() => {
    const user = this.sessionState.currentUser();
    return user?.role === 'moderator';
  });

  readonly history = this.sessionState.history;

  showConfirmDialog(): boolean {
    return this._showConfirmDialog();
  }

  isExpanded(roundId: string): boolean {
    return this._expandedRounds().has(roundId);
  }

  toggleExpand(roundId: string): void {
    const current = new Set(this._expandedRounds());
    if (current.has(roundId)) {
      current.delete(roundId);
    } else {
      current.add(roundId);
    }
    this._expandedRounds.set(current);
  }

  getSummary(entry: HistoryEntry): HistorySummary {
    return deriveHistorySummary(entry);
  }

  promptClearHistory(): void {
    this._showConfirmDialog.set(true);
  }

  confirmClear(): void {
    this._showConfirmDialog.set(false);
    this.wsService.send('history:clear', {});
  }

  cancelClear(): void {
    this._showConfirmDialog.set(false);
  }
}
