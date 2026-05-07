import { Component, input, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RetroColumn } from '@shared/types';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { RetroStateService } from '../../services/retro-state.service';
import { RetroCardComponent } from './retro-card.component';

@Component({
  selector: 'app-retro-column',
  standalone: true,
  imports: [CommonModule, RetroCardComponent],
  template: `
    <div
      class="retro-column"
      [class.retro-column--drag-over]="isDragOverColumn()"
      [attr.data-column-id]="column().id"
      (dragover)="onColumnDragOver($event)"
      (dragleave)="onColumnDragLeave($event)"
      (drop)="onColumnDrop($event)"
    >
      <header
        class="retro-column__header"
        draggable="true"
        (dragstart)="onColumnDragStart($event)"
        (dragend)="onColumnDragEnd($event)"
      >
        <h3 class="retro-column__name">{{ column().name }}</h3>
        <div class="retro-column__actions">
          <span class="retro-column__card-count" [attr.aria-label]="column().cards.length + ' cards'">
            {{ column().cards.length }}
          </span>
          <button
            class="retro-column__add-btn"
            type="button"
            title="Add Card"
            aria-label="Add Card"
            (click)="onAddCard()"
            [disabled]="isCompleted()"
          >
            +
          </button>
          <button
            class="retro-column__delete-btn"
            type="button"
            title="Delete Column"
            aria-label="Delete Column"
            (click)="onDeleteColumn()"
            [disabled]="isCompleted()"
          >
            🗑️
          </button>
        </div>
      </header>

      <div
        class="retro-column__cards"
        (dragover)="onCardAreaDragOver($event)"
        (dragleave)="onCardAreaDragLeave($event)"
        (drop)="onCardAreaDrop($event)"
      >
        @if (cardsRevealed() || isModerator()) {
          @for (card of column().cards; track card.id; let idx = $index) {
            <div
              class="retro-column__card-wrapper"
              [class.retro-column__card-wrapper--drop-above]="dropIndex() === idx"
              [class.retro-column__card-wrapper--revealed]="cardsRevealed()"
              [style.animation-delay]="(idx * 0.05) + 's'"
              (dragover)="onCardDragOver($event, idx)"
            >
              <app-retro-card [card]="card" />
            </div>
          }
          @if (dropIndex() === column().cards.length) {
            <div class="retro-column__drop-indicator"></div>
          }
        } @else {
          @for (card of ownCards(); track card.id; let idx = $index) {
            <div
              class="retro-column__card-wrapper"
              [class.retro-column__card-wrapper--drop-above]="dropIndex() === idx"
              (dragover)="onCardDragOver($event, idx)"
            >
              <app-retro-card [card]="card" />
            </div>
          }
          @if (hiddenCardCount() > 0) {
            <div class="retro-column__hidden-count" aria-live="polite">
              {{ hiddenCardCount() }} hidden {{ hiddenCardCount() === 1 ? 'card' : 'cards' }}
            </div>
          }
        }
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      min-width: 220px;
      max-width: 320px;
      flex: 1 0 220px;
    }

    .retro-column {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: #f8f9fa;
      border: 1px solid #e0e0e0;
      border-radius: 6px;
      overflow: hidden;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }

    .retro-column--drag-over {
      border-color: #667eea;
      box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.2);
    }

    /* Header */
    .retro-column__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.375rem 0.5rem;
      background: #fff;
      border-bottom: 1px solid #e8e8e8;
      cursor: grab;
      flex-shrink: 0;
    }

    .retro-column__header:active {
      cursor: grabbing;
    }

    .retro-column__name {
      margin: 0;
      font-size: 0.75rem;
      font-weight: 600;
      color: #333;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      min-width: 0;
    }

    .retro-column__actions {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      flex-shrink: 0;
    }

    .retro-column__card-count {
      font-size: 0.65rem;
      color: #888;
      background: #eee;
      padding: 0.1rem 0.35rem;
      border-radius: 8px;
      font-weight: 500;
    }

    .retro-column__add-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      min-width: 32px;
      min-height: 32px;
      border: none;
      background: #667eea;
      color: #fff;
      border-radius: 4px;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      line-height: 1;
      transition: background 0.15s ease;
    }

    .retro-column__add-btn:hover:not(:disabled) {
      background: #5a6fd6;
    }

    .retro-column__add-btn:disabled {
      background: #ccc;
      cursor: not-allowed;
    }

    .retro-column__delete-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      min-width: 28px;
      min-height: 28px;
      border: none;
      background: transparent;
      color: #999;
      border-radius: 4px;
      font-size: 0.7rem;
      cursor: pointer;
      transition: color 0.15s ease, background 0.15s ease;
    }

    .retro-column__delete-btn:hover:not(:disabled) {
      color: #d32f2f;
      background: rgba(211, 47, 47, 0.08);
    }

    .retro-column__delete-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* Cards area */
    .retro-column__cards {
      flex: 1;
      overflow-y: auto;
      padding: 0.375rem;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      min-height: 40px;
    }

    .retro-column__cards::-webkit-scrollbar {
      width: 6px;
    }

    .retro-column__cards::-webkit-scrollbar-track {
      background: #e8e8e8;
      border-radius: 3px;
    }

    .retro-column__cards::-webkit-scrollbar-thumb {
      background: #999;
      border-radius: 3px;
    }

    .retro-column__cards::-webkit-scrollbar-thumb:hover {
      background: #666;
    }

    .retro-column__card-wrapper {
      position: relative;
    }

    .retro-column__card-wrapper--drop-above::before {
      content: '';
      position: absolute;
      top: -2px;
      left: 0;
      right: 0;
      height: 2px;
      background: #667eea;
      border-radius: 1px;
    }

    .retro-column__card-wrapper--revealed {
      animation: cardReveal 0.4s ease-out both;
    }

    @keyframes cardReveal {
      0% {
        opacity: 0;
        transform: scale(0.8) rotateX(10deg);
      }
      50% {
        transform: scale(1.02);
      }
      100% {
        opacity: 1;
        transform: scale(1) rotateX(0);
      }
    }

    .retro-column__drop-indicator {
      height: 2px;
      background: #667eea;
      border-radius: 1px;
      margin-top: 0.125rem;
    }

    .retro-column__hidden-count {
      text-align: center;
      font-size: 0.7rem;
      color: #888;
      padding: 0.5rem;
      background: #f0f0f0;
      border-radius: 4px;
      border: 1px dashed #ddd;
    }

    @media (prefers-reduced-motion: reduce) {
      .retro-column,
      .retro-column__add-btn {
        transition: none;
      }
    }
  `],
})
export class RetroColumnComponent {
  private readonly ws = inject(RetroWebSocketService);
  private readonly retroState = inject(RetroStateService);

  /** Required input: the column data */
  readonly column = input.required<RetroColumn>();

  /** Internal drag state */
  readonly isDragOverColumn = signal(false);
  readonly dropIndex = signal<number | null>(null);

  /** Computed: whether cards are revealed */
  readonly cardsRevealed = this.retroState.cardsRevealed;

  /** Computed: whether current user is moderator */
  readonly isModerator = this.retroState.isModerator;

  /** Computed: whether board is completed */
  readonly isCompleted = this.retroState.isCompleted;

  /** Computed: current user's own cards in this column (when cards are hidden) */
  readonly ownCards = computed(() => {
    const col = this.column();
    const userId = this.retroState.currentUserId();
    if (!userId) return [];
    return col.cards.filter(card => card.authorId === userId);
  });

  /** Computed: count of hidden cards (cards by other users) */
  readonly hiddenCardCount = computed(() => {
    const col = this.column();
    const userId = this.retroState.currentUserId();
    if (!userId) return col.cards.length;
    return col.cards.filter(card => card.authorId !== userId).length;
  });

  // --- Add Card ---

  onAddCard(): void {
    const col = this.column();
    this.ws.sendCardAdd(col.id, '');
  }

  // --- Delete Column ---

  onDeleteColumn(): void {
    const col = this.column();
    if (confirm(`Delete column "${col.name}" and all its cards?`)) {
      this.ws.sendColumnRemove(col.id);
    }
  }

  // --- Column Drag-and-Drop (for reordering columns) ---

  onColumnDragStart(event: DragEvent): void {
    const col = this.column();
    event.dataTransfer?.setData('application/retro-column-id', col.id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
    }
  }

  onColumnDragEnd(_event: DragEvent): void {
    this.isDragOverColumn.set(false);
    this.dropIndex.set(null);
  }

  onColumnDragOver(event: DragEvent): void {
    const types = Array.from(event.dataTransfer?.types ?? []);
    // Accept column drops for reordering
    if (types.includes('application/retro-column-id')) {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
      this.isDragOverColumn.set(true);
    }
    // Accept card drops for moving between columns
    if (types.includes('application/retro-card-id')) {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
    }
  }

  onColumnDragLeave(event: DragEvent): void {
    // Only reset if leaving the column element itself
    const relatedTarget = event.relatedTarget as HTMLElement | null;
    const currentTarget = event.currentTarget as HTMLElement;
    if (!relatedTarget || !currentTarget.contains(relatedTarget)) {
      this.isDragOverColumn.set(false);
    }
  }

  onColumnDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragOverColumn.set(false);

    const columnId = event.dataTransfer?.getData('application/retro-column-id');
    if (columnId && columnId !== this.column().id) {
      // Reorder columns: move dragged column to this column's position
      const columns = this.retroState.columns();
      const currentOrder = columns.map(c => c.id);
      const fromIndex = currentOrder.indexOf(columnId);
      const toIndex = currentOrder.indexOf(this.column().id);

      if (fromIndex !== -1 && toIndex !== -1) {
        const newOrder = [...currentOrder];
        newOrder.splice(fromIndex, 1);
        newOrder.splice(toIndex, 0, columnId);
        this.ws.sendColumnReorder(newOrder);
      }
    }
  }

  // --- Card Drag-and-Drop (within and between columns) ---

  onCardAreaDragOver(event: DragEvent): void {
    const types = event.dataTransfer?.types;
    if (types && (Array.from(types).includes('application/retro-card-id'))) {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
      // If no specific card position, drop at end
      if (this.dropIndex() === null) {
        this.dropIndex.set(this.column().cards.length);
      }
    }
  }

  onCardAreaDragLeave(event: DragEvent): void {
    const relatedTarget = event.relatedTarget as HTMLElement | null;
    const currentTarget = event.currentTarget as HTMLElement;
    if (!relatedTarget || !currentTarget.contains(relatedTarget)) {
      this.dropIndex.set(null);
    }
  }

  onCardAreaDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const cardId = event.dataTransfer?.getData('application/retro-card-id');
    if (!cardId) {
      this.dropIndex.set(null);
      return;
    }

    const targetIndex = this.dropIndex() ?? this.column().cards.length;
    this.ws.sendCardMove(cardId, this.column().id, targetIndex);
    this.dropIndex.set(null);
  }

  onCardDragOver(event: DragEvent, index: number): void {
    const types = Array.from(event.dataTransfer?.types ?? []);
    if (types.includes('application/retro-card-id')) {
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
      this.dropIndex.set(index);
    }
  }
}
