import { Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';

export type FlowState = 'idle' | 'voting' | 'revealed';

export interface FlowProgress {
  estimated: number;
  total: number;
}

/**
 * Pure function to compute facilitator progress from an issue list.
 */
export function computeProgress(issues: { status: string }[]): FlowProgress {
  const total = issues.length;
  const estimated = issues.filter((i) => i.status === 'estimated').length;
  return { estimated, total };
}

@Component({
  selector: 'app-facilitator-flow',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (hasRevealPermission()) {
      <div class="facilitator-flow" role="region" aria-label="Facilitator controls">
        @if (progress().total > 0) {
          <div class="facilitator-flow__progress" aria-label="Estimation progress">
            <span class="facilitator-flow__progress-text">
              {{ progress().estimated }} / {{ progress().total }}
            </span>
            <span class="facilitator-flow__progress-label">estimated</span>
          </div>
        }

        <div class="facilitator-flow__state">
          @switch (flowState()) {
            @case ('idle') {
              <p class="facilitator-flow__prompt">Select or enter the next story</p>
            }
            @case ('voting') {
              <p class="facilitator-flow__prompt">Voting in progress</p>
              <button
                class="facilitator-flow__btn facilitator-flow__btn--reveal"
                (click)="revealCards()"
                type="button"
                title="Reveal all cards"
              >
                Reveal Cards
              </button>
            }
            @case ('revealed') {
              <p class="facilitator-flow__prompt">Cards revealed — discuss and decide</p>
              <div class="facilitator-flow__actions">
                <button
                  class="facilitator-flow__btn facilitator-flow__btn--revote"
                  (click)="revote()"
                  type="button"
                  title="Re-vote on current story"
                >
                  Re-Vote
                </button>
                <button
                  class="facilitator-flow__btn facilitator-flow__btn--clear"
                  (click)="clearAndNext()"
                  type="button"
                  title="Clear the board and move to next story"
                >
                  Clear & Next Story
                </button>
              </div>
            }
          }
        </div>
      </div>
    }
  `,
  styles: [
    `
      .facilitator-flow {
        padding: 0.75rem;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        background: #fafafa;
      }

      .facilitator-flow__progress {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        margin-bottom: 0.5rem;
        font-size: 0.85rem;
        color: #555;
      }

      .facilitator-flow__progress-text {
        font-weight: 700;
        color: #333;
      }

      .facilitator-flow__prompt {
        margin: 0 0 0.5rem;
        font-size: 0.9rem;
        color: #444;
      }

      .facilitator-flow__actions {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
      }

      .facilitator-flow__btn {
        padding: 0.5rem 1rem;
        border: none;
        border-radius: 6px;
        font-size: 0.85rem;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.2s;
      }

      .facilitator-flow__btn--reveal {
        background: #1976d2;
        color: #fff;
      }

      .facilitator-flow__btn--reveal:hover {
        background: #1565c0;
      }

      .facilitator-flow__btn--revote {
        background: #f57c00;
        color: #fff;
      }

      .facilitator-flow__btn--revote:hover {
        background: #ef6c00;
      }

      .facilitator-flow__btn--clear {
        background: #388e3c;
        color: #fff;
      }

      .facilitator-flow__btn--clear:hover {
        background: #2e7d32;
      }
    `,
  ],
})
export class FacilitatorFlowComponent {
  private readonly sessionState = inject(SessionStateService);
  private readonly ws = inject(WebSocketService);

  readonly hasRevealPermission = computed(() => this.sessionState.hasRevealPermission());

  readonly flowState = computed<FlowState>(() => {
    const round = this.sessionState.currentRound();
    if (!round) return 'idle';
    if (this.sessionState.isRevealed()) return 'revealed';
    return 'voting';
  });

  readonly progress = computed<FlowProgress>(() => {
    return computeProgress(this.sessionState.issueList());
  });

  revealCards(): void {
    this.ws.send('cards:reveal', {});
  }

  revote(): void {
    this.ws.send('round:revote', {});
  }

  clearAndNext(): void {
    this.ws.send('board:clear', {});
  }
}
