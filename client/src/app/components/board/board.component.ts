import { Component, inject, computed, signal, OnInit, OnDestroy, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { StarsAnimationComponent } from '../stars-animation/stars-animation.component';
import { User, CardValue, HistoryEntry } from '@shared/types';

/**
 * Represents a single participant's card on the board.
 */
export interface BoardCard {
  userId: string;
  displayName: string;
  hasVoted: boolean;
  cardValue: CardValue | null;
}

/**
 * Derives the board cards from participants, selections, reveal state, and voted user IDs.
 * This is a pure function extracted for testability.
 */
export function deriveBoardCards(
  participants: User[],
  selections: Map<string, CardValue>,
  isRevealed: boolean,
  votedUserIds: Set<string> = new Set()
): BoardCard[] {
  return participants.map((participant) => {
    const selection = selections.get(participant.id) ?? null;
    return {
      userId: participant.id,
      displayName: participant.displayName,
      hasVoted: votedUserIds.has(participant.id) || selection !== null,
      cardValue: isRevealed ? selection : null,
    };
  });
}

/**
 * Returns the display text for a board card.
 * - Pre-reveal with vote: "Voted ✓"
 * - Pre-reveal without vote: empty string
 * - Post-reveal with value: the card value as string
 * - Post-reveal without value: "No Vote"
 */
export function getCardDisplayText(card: BoardCard, isRevealed: boolean): string {
  if (!isRevealed) {
    return card.hasVoted ? 'Voted ✓' : '';
  }
  return card.cardValue !== null ? String(card.cardValue) : 'No Vote';
}

/**
 * Calculates the stagger delay for a card at a given index.
 * Each card's animation-delay = index * 50ms.
 */
export function calculateStaggerDelay(index: number): number {
  return index * 50;
}

/**
 * Calculates the total clear animation duration for n cards.
 * Total = 400 + (n - 1) * 50 ms.
 * Returns 0 for 0 cards.
 */
export function calculateClearAnimationDuration(cardCount: number): number {
  if (cardCount <= 0) return 0;
  return 400 + (cardCount - 1) * 50;
}

/**
 * Checks if the user prefers reduced motion.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

@Component({
  selector: 'app-board',
  standalone: true,
  imports: [CommonModule, StarsAnimationComponent],
  template: `
    <div class="board" role="region" aria-label="Voting board">
      <app-stars-animation [active]="starsActive()" />
      <div class="board__grid">
        @if (clearing()) {
          @for (card of clearingCards(); track card.userId; let i = $index) {
            <div
              class="board__card board__card--revealed board__card--clearing"
              [class.board__card--no-vote]="card.cardValue === null"
              [style.animation-delay]="i * 50 + 'ms'"
            >
              <div class="board__card-inner">
                <div class="board__card-face board__card-front">
                  <div class="board__card-name">{{ card.displayName }}</div>
                  <div class="board__card-value">
                    {{ getFaceDownText(card) }}
                  </div>
                </div>
                <div class="board__card-face board__card-back">
                  <div class="board__card-name">{{ card.displayName }}</div>
                  <div class="board__card-value">
                    {{ getFaceUpText(card) }}
                  </div>
                </div>
              </div>
            </div>
          }
        } @else {
          @for (card of boardCards(); track card.userId) {
            <div
              class="board__card"
              [class.board__card--voted]="!isRevealed() && card.hasVoted"
              [class.board__card--revealed]="isRevealed()"
              [class.board__card--no-vote]="isRevealed() && card.cardValue === null"
            >
              <div class="board__card-inner">
                <div class="board__card-face board__card-front">
                  <div class="board__card-name">{{ card.displayName }}</div>
                  <div class="board__card-value">
                    {{ getFaceDownText(card) }}
                  </div>
                  @if (canRemoveParticipant(card.userId)) {
                    <button
                      class="board__card-remove"
                      (click)="removeParticipant(card.userId)"
                      title="Remove {{ card.displayName }} from session"
                      aria-label="Remove {{ card.displayName }} from session"
                    >✕</button>
                  }
                </div>
                <div class="board__card-face board__card-back">
                  <div class="board__card-name">{{ card.displayName }}</div>
                  <div class="board__card-value">
                    {{ getFaceUpText(card) }}
                  </div>
                  @if (canRemoveParticipant(card.userId)) {
                    <button
                      class="board__card-remove"
                      (click)="removeParticipant(card.userId)"
                      title="Remove {{ card.displayName }} from session"
                      aria-label="Remove {{ card.displayName }} from session"
                    >✕</button>
                  }
                </div>
              </div>
            </div>
          }
        }
      </div>
      <div
        class="board__announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {{ announcement() }}
      </div>
    </div>
  `,
  styles: [
    `
      .board {
        padding: 0.5rem 0;
        position: relative;
      }

      .board__grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
        gap: 0.5rem;
        justify-items: center;
        perspective: 800px;
      }

      .board__card {
        width: 80px;
        height: 110px;
      }

      .board__card-inner {
        position: relative;
        width: 100%;
        height: 100%;
        transform-style: preserve-3d;
        transition: transform 600ms ease-in-out;
      }

      .board__card--revealed .board__card-inner {
        transform: rotateY(180deg);
      }

      .board__card-face {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        border: 2px solid #ccc;
        border-radius: 8px;
        background: #f5f5f5;
        padding: 0.5rem;
        text-align: center;
        backface-visibility: hidden;
        box-sizing: border-box;
      }

      .board__card-front {
        /* Front face is visible by default (rotateY(0)) */
      }

      .board__card--voted .board__card-front {
        border-color: #4caf50;
        background: #e8f5e9;
      }

      .board__card-back {
        transform: rotateY(180deg);
        border-color: #1976d2;
        background: #e3f2fd;
      }

      .board__card--no-vote .board__card-back {
        border-color: #ff9800;
        background: #fff3e0;
      }

      .board__card-name {
        font-size: 0.75rem;
        font-weight: 600;
        margin-bottom: 0.5rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 90px;
      }

      .board__card-value {
        font-size: 1rem;
        font-weight: 700;
        min-height: 1.5em;
      }

      .board__card-remove {
        position: absolute;
        top: 2px;
        right: 2px;
        width: 18px;
        height: 18px;
        border: none;
        border-radius: 50%;
        background: rgba(211, 47, 47, 0.8);
        color: #fff;
        font-size: 0.6rem;
        line-height: 1;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 0.15s ease;
        pointer-events: auto;
      }

      .board__card:hover .board__card-remove {
        opacity: 1;
      }

      .board__card-remove:hover {
        background: rgba(211, 47, 47, 1);
      }

      .board__announcer {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      /* Board clear animation */
      .board__card--clearing {
        animation: boardCardClear 400ms ease-in forwards;
      }

      @keyframes boardCardClear {
        0% {
          opacity: 1;
          transform: translateY(0);
        }
        100% {
          opacity: 0;
          transform: translateY(30px);
        }
      }

      /* Reduced motion: skip animations, show values immediately */
      @media (prefers-reduced-motion: reduce) {
        .board__card-inner {
          transition: none;
        }

        .board__card--clearing {
          animation: none;
          opacity: 0;
        }
      }
    `,
  ],
})
export class BoardComponent implements OnInit, OnDestroy {
  private readonly sessionState = inject(SessionStateService);
  private readonly ws = inject(WebSocketService);
  private clearSubscription: Subscription | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether the board is currently playing the clear animation. */
  readonly clearing = signal(false);

  /** Snapshot of cards to display during the clearing animation. */
  readonly clearingCards = signal<BoardCard[]>([]);

  /** Whether the stars animation should be active (reveal transition only). */
  readonly starsActive = signal(false);

  /** Track previous reveal state to avoid triggering on reconnect. */
  private previousRevealState: boolean | null = null;

  readonly isRevealed = this.sessionState.isRevealed;

  constructor() {
    // Track reveal transitions: only trigger stars when going from false → true
    effect(() => {
      const currentRevealed = this.sessionState.isRevealed();
      if (this.previousRevealState === false && currentRevealed === true) {
        this.starsActive.set(true);
      } else if (!currentRevealed) {
        this.starsActive.set(false);
      }
      this.previousRevealState = currentRevealed;
    });
  }

  readonly boardCards = computed(() =>
    deriveBoardCards(
      this.sessionState.participants(),
      this.sessionState.selections(),
      this.sessionState.isRevealed(),
      this.sessionState.votedUserIds()
    )
  );

  readonly announcement = computed(() => {
    const revealed = this.sessionState.isRevealed();
    const cards = this.boardCards();
    if (revealed && cards.length > 0) {
      return 'Cards have been revealed';
    }
    const votedCount = cards.filter((c) => c.hasVoted).length;
    if (votedCount > 0) {
      return `${votedCount} of ${cards.length} participants have voted`;
    }
    return '';
  });

  ngOnInit(): void {
    this.clearSubscription = this.ws
      .on<{ historyEntry: HistoryEntry }>('board:cleared')
      .subscribe(() => {
        this.triggerClearAnimation();
      });
  }

  ngOnDestroy(): void {
    this.clearSubscription?.unsubscribe();
    if (this.clearTimer !== null) {
      clearTimeout(this.clearTimer);
    }
  }

  /**
   * Triggers the board clear animation.
   * Snapshots the current cards, sets clearing state, and schedules
   * the reset after the animation completes.
   * For reduced-motion users, resets immediately without animation.
   */
  triggerClearAnimation(): void {
    const currentCards = this.boardCards();

    if (currentCards.length === 0) {
      return;
    }

    if (prefersReducedMotion()) {
      // Skip animation, reset immediately
      this.clearing.set(false);
      this.clearingCards.set([]);
      return;
    }

    // Snapshot the current cards for the clearing animation
    this.clearingCards.set([...currentCards]);
    this.clearing.set(true);

    // Calculate total animation duration: 400ms + (n-1) * 50ms stagger
    const totalDuration = calculateClearAnimationDuration(currentCards.length);

    this.clearTimer = setTimeout(() => {
      this.clearing.set(false);
      this.clearingCards.set([]);
      this.clearTimer = null;
    }, totalDuration);
  }

  getDisplayText(card: BoardCard): string {
    return getCardDisplayText(card, this.sessionState.isRevealed());
  }

  getFaceDownText(card: BoardCard): string {
    return card.hasVoted ? 'Voted ✓' : '';
  }

  getFaceUpText(card: BoardCard): string {
    return card.cardValue !== null ? String(card.cardValue) : 'No Vote';
  }

  /**
   * Check if the current user (moderator) can remove a given participant.
   * Only moderators can remove others, and they cannot remove themselves.
   */
  canRemoveParticipant(userId: string): boolean {
    const currentUser = this.sessionState.currentUser();
    if (!currentUser || currentUser.role !== 'moderator') return false;
    return userId !== currentUser.id;
  }

  /**
   * Send a participant:remove event to the server.
   */
  removeParticipant(userId: string): void {
    this.ws.send('participant:remove', { userId });
  }
}
