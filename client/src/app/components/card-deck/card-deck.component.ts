import { Component, inject, computed, signal, effect, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  CardValue,
  NumericCardValue,
  SpecialCardValue,
  ALL_CARDS,
  ExtendedCardValue,
} from '@shared/types';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { Subscription } from 'rxjs';

// --- Color mapping ---

export const CARD_COLOR_MAP: Record<NumericCardValue, string> = {
  0: 'var(--card-color-0)',
  1: 'var(--card-color-1)',
  2: 'var(--card-color-2)',
  3: 'var(--card-color-3)',
  5: 'var(--card-color-5)',
  8: 'var(--card-color-8)',
  13: 'var(--card-color-13)',
  21: 'var(--card-color-21)',
  34: 'var(--card-color-34)',
  55: 'var(--card-color-55)',
  89: 'var(--card-color-89)',
};

/** Color map for extended numeric values from other voting systems */
export const EXTENDED_NUMERIC_COLOR_MAP: Record<number, string> = {
  4: 'var(--card-color-3)',    // between 3 and 5
  16: 'var(--card-color-13)',  // between 13 and 21
  20: 'var(--card-color-21)',  // near 21
  32: 'var(--card-color-34)',  // near 34
  40: 'var(--card-color-55)',  // near 55
  64: 'var(--card-color-89)',  // near 89
  100: 'var(--card-color-89)', // highest warm
};

/** Color map for T-shirt sizes (cool to warm) */
export const TSHIRT_COLOR_MAP: Record<string, string> = {
  'XS': 'var(--card-color-0)',
  'S': 'var(--card-color-2)',
  'M': 'var(--card-color-5)',
  'L': 'var(--card-color-8)',
  'XL': 'var(--card-color-13)',
  'XXL': 'var(--card-color-34)',
};

export const SPECIAL_CARD_COLOR_MAP: Record<SpecialCardValue, string> = {
  coffee: 'var(--card-color-coffee)',
  'no-clue': 'var(--card-color-no-clue)',
  break: 'var(--card-color-break)',
};

export function getExtendedCardColor(value: ExtendedCardValue): string {
  // Special cards
  if (value === 'coffee' || value === 'no-clue' || value === 'break') {
    return SPECIAL_CARD_COLOR_MAP[value];
  }
  // Half
  if (value === '½') {
    return 'var(--card-color-0)'; // cool blue
  }
  // T-shirt sizes
  if (typeof value === 'string' && value in TSHIRT_COLOR_MAP) {
    return TSHIRT_COLOR_MAP[value];
  }
  // Standard numeric
  if (typeof value === 'number' && value in CARD_COLOR_MAP) {
    return CARD_COLOR_MAP[value as NumericCardValue];
  }
  // Extended numeric
  if (typeof value === 'number' && value in EXTENDED_NUMERIC_COLOR_MAP) {
    return EXTENDED_NUMERIC_COLOR_MAP[value];
  }
  // Fallback
  return '#888';
}

/** @deprecated Use getExtendedCardColor instead */
export function getCardColor(value: CardValue): string {
  return getExtendedCardColor(value);
}

// --- Special card labels ---

export const SPECIAL_CARD_LABELS: Record<SpecialCardValue, { icon: string; label: string }> = {
  'coffee': { icon: '☕', label: 'Coffee' },
  'no-clue': { icon: '?', label: 'Unknown' },
  'break': { icon: '⏸', label: 'Break' },
};

// --- Card display helpers ---

export interface CardDisplay {
  value: ExtendedCardValue;
  label: string;
  ariaLabel: string;
  color: string;
  textLabel?: string;
}

const CARD_DISPLAYS: CardDisplay[] = ALL_CARDS.map((value) => buildCardDisplay(value));

export function buildCardDisplay(value: ExtendedCardValue): CardDisplay {
  return {
    value,
    label: getExtendedCardLabel(value),
    ariaLabel: getExtendedCardAriaLabel(value),
    color: getExtendedCardColor(value),
    ...(typeof value === 'string' && value in SPECIAL_CARD_LABELS
      ? { textLabel: SPECIAL_CARD_LABELS[value as SpecialCardValue].label }
      : {}),
  };
}

function getExtendedCardLabel(value: ExtendedCardValue): string {
  switch (value) {
    case 'coffee':
      return '☕';
    case 'no-clue':
      return '?';
    case 'break':
      return '⏸';
    default:
      return String(value);
  }
}

function getExtendedCardAriaLabel(value: ExtendedCardValue): string {
  if (value === 'coffee' || value === 'no-clue' || value === 'break') {
    return SPECIAL_CARD_LABELS[value].label;
  }
  if (typeof value === 'string') {
    // T-shirt sizes and ½
    return `Estimate ${value}`;
  }
  return `Estimate ${value} points`;
}

/** @deprecated Use getExtendedCardLabel */
function getCardLabel(value: CardValue): string {
  return getExtendedCardLabel(value);
}

/** @deprecated Use getExtendedCardAriaLabel */
function getCardAriaLabel(value: CardValue): string {
  return getExtendedCardAriaLabel(value);
}

@Component({
  selector: 'app-card-deck',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="card-deck" role="radiogroup" aria-label="Estimation cards">
      @for (card of cards; track card.value) {
        <button
          class="card-deck__card"
          [class.card-deck__card--selected]="isSelected(card.value)"
          [style.--card-accent]="card.color"
          [disabled]="!isRoundActive()"
          [attr.aria-label]="card.ariaLabel"
          [attr.aria-pressed]="isSelected(card.value)"
          (click)="selectCard(card.value)"
          (keydown.enter)="selectCard(card.value)"
          (keydown.space)="selectCard(card.value); $event.preventDefault()"
        >
          <span class="card-deck__card-value">{{ card.label }}</span>
          @if (card.textLabel) {
            <span class="card-deck__card-text-label">{{ card.textLabel }}</span>
          }
        </button>
      }
      <div
        class="card-deck__announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {{ selectionAnnouncement() }}
      </div>
    </div>
  `,
  styles: [
    `
      .card-deck {
        display: flex;
        flex-wrap: wrap;
        gap: 0.375rem;
        justify-content: center;
        padding: 0.5rem 0;
        position: relative;
      }

      .card-deck__card {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        width: 52px;
        height: 72px;
        border: 2px solid var(--card-accent, #ccc);
        border-radius: 12px;
        background: linear-gradient(
          180deg,
          #ffffff 0%,
          color-mix(in srgb, var(--card-accent, #ccc) 8%, #ffffff) 100%
        );
        box-shadow: var(--shadow-card);
        cursor: pointer;
        font-size: 1rem;
        font-weight: 600;
        color: var(--text-primary);
        transition:
          transform 300ms ease-out,
          box-shadow 300ms ease-out,
          border-color 300ms ease-out,
          background 0.1s;
        min-width: 44px;
        min-height: 44px;
      }

      .card-deck__card:hover:not(:disabled):not(.card-deck__card--selected) {
        border-color: color-mix(in srgb, var(--card-accent, #666) 80%, #000);
        box-shadow: var(--shadow-card-hover);
        transform: translateY(-4px);
      }

      .card-deck__card:focus-visible {
        outline: 2px solid #1976d2;
        outline-offset: 2px;
      }

      .card-deck__card:not(.card-deck__card--selected) {
        transform: translateY(0) scale(1);
        transition: transform 300ms ease-out, box-shadow 300ms ease-out, border-color 300ms ease-out;
      }

      .card-deck__card--selected {
        border-color: var(--card-accent, #1976d2);
        border-width: 3px;
        background: linear-gradient(
          180deg,
          color-mix(in srgb, var(--card-accent, #1976d2) 15%, #ffffff) 0%,
          color-mix(in srgb, var(--card-accent, #1976d2) 25%, #ffffff) 100%
        );
        box-shadow: var(--shadow-card-selected);
        transform: translateY(-20px) scale(1.05);
        transition: transform 300ms ease-out, box-shadow 300ms ease-out, border-color 300ms ease-out;
      }

      @media (prefers-reduced-motion: reduce) {
        .card-deck__card,
        .card-deck__card--selected {
          transition: none;
        }
      }

      .card-deck__card:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none;
      }

      .card-deck__card-value {
        user-select: none;
      }

      .card-deck__card-text-label {
        font-size: 0.65rem;
        font-weight: 500;
        color: var(--text-secondary, #4a5568);
        user-select: none;
        line-height: 1;
        margin-top: 2px;
      }

      /* Mobile: scrollable horizontal strip */
      @media (max-width: 767px) {
        .card-deck {
          flex-wrap: nowrap;
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
          scroll-snap-type: x mandatory;
          padding: 0.5rem 0;
          gap: 0.5rem;
          justify-content: flex-start;
        }

        .card-deck__card {
          flex-shrink: 0;
          scroll-snap-align: start;
          width: 56px;
          height: 76px;
          font-size: 1.1rem;
        }
      }

      .card-deck__announcer {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
    `,
  ],
})
export class CardDeckComponent implements OnDestroy {
  private readonly sessionState = inject(SessionStateService);
  private readonly wsService = inject(WebSocketService);
  private readonly subscriptions: Subscription[] = [];

  /**
   * Dynamic card set: uses votingSystemCards from session config when available,
   * falls back to the static ALL_CARDS (Fibonacci + specials) when no session config exists.
   */
  readonly dynamicCards = computed<CardDisplay[]>(() => {
    const votingCards = this.sessionState.votingSystemCards();
    if (votingCards.length > 0) {
      return votingCards.map((v) => buildCardDisplay(v));
    }
    // Fallback to existing hardcoded cards
    return CARD_DISPLAYS;
  });

  get cards(): CardDisplay[] {
    return this.dynamicCards();
  }

  private selectedCard: ExtendedCardValue | null = null;
  readonly selectionAnnouncement = signal('');

  readonly isRoundActive = computed(() => {
    const round = this.sessionState.currentRound();
    return round !== null && round.status === 'voting';
  });

  constructor() {
    // Reset selectedCard when a new round starts
    this.subscriptions.push(
      this.wsService.on('round:started').subscribe(() => {
        this.selectedCard = null;
      })
    );

    // Reset selectedCard when the board is cleared
    this.subscriptions.push(
      this.wsService.on('board:cleared').subscribe(() => {
        this.selectedCard = null;
      })
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.forEach((sub) => sub.unsubscribe());
  }

  isSelected(value: ExtendedCardValue): boolean {
    return this.selectedCard === value;
  }

  selectCard(value: ExtendedCardValue): void {
    if (!this.isRoundActive()) {
      return;
    }
    this.selectedCard = value;
    const card = this.cards.find((c) => c.value === value);
    this.selectionAnnouncement.set(
      card ? `Selected: ${card.ariaLabel}` : `Selected: ${value}`
    );
    this.wsService.send('card:select', { cardValue: value });
  }
}
