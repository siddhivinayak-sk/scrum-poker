import { Component, input, inject, signal, computed, ElementRef, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RetroColumn, RetroCard } from '@shared/types';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { RetroStateService } from '../../services/retro-state.service';
import { RetroCardComponent } from './retro-card.component';
import { MergePopupComponent } from './merge-popup.component';
import { CardRect, computeDropIndex, adjustDropIndexForSameColumn } from './drop-index';

@Component({
  selector: 'app-retro-column',
  standalone: true,
  imports: [CommonModule, RetroCardComponent, MergePopupComponent],
  host: {
    '[class.is-horizontal]': 'isHorizontalLayout()'
  },
  template: `
    <div
      class="retro-column"
      [attr.data-column-id]="column().id"
      (dragover)="onDragOver($event)"
      (dragleave)="onDragLeave($event)"
      (drop)="onDrop($event)"
    >
      <header
        class="retro-column__header"
        draggable="true"
        (dragstart)="onColumnDragStart($event)"
        (dragend)="onColumnDragEnd($event)"
      >
        <h3
          class="retro-column__name"
          [title]="column().name"
          [attr.aria-label]="column().name"
        >{{ column().name }}</h3>
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
          >+</button>
          <button
            class="retro-column__delete-btn"
            type="button"
            title="Delete Column"
            aria-label="Delete Column"
            (click)="showDeleteConfirm.set(true)"
            [disabled]="isCompleted()"
          >🗑️</button>
        </div>
      </header>

      <div #cardsContainer class="retro-column__cards">
        @if (cardsVisible() || isModerator()) {
          @for (card of column().cards; track card.id) {
            <app-retro-card [card]="card" />
          }
        } @else {
          @for (card of ownCards(); track card.id) {
            <app-retro-card [card]="card" />
          }
          @if (hiddenCardCount() > 0) {
            <div class="retro-column__hidden-count" aria-live="polite">
              {{ hiddenCardCount() }} hidden {{ hiddenCardCount() === 1 ? 'card' : 'cards' }}
            </div>
          }
        }
      </div>
    </div>

    <!-- Delete Column Confirmation Dialog -->
    @if (showDeleteConfirm()) {
      <div class="retro-column__dialog-backdrop" (click)="showDeleteConfirm.set(false)">
        <div class="retro-column__dialog" (click)="$event.stopPropagation()" role="alertdialog" aria-label="Confirm delete column">
          <p class="retro-column__dialog-text">Delete column "{{ column().name }}" and all its cards?</p>
          <div class="retro-column__dialog-actions">
            <button class="retro-column__dialog-btn retro-column__dialog-btn--cancel" (click)="showDeleteConfirm.set(false)">Cancel</button>
            <button class="retro-column__dialog-btn retro-column__dialog-btn--delete" (click)="confirmDeleteColumn()">Delete</button>
          </div>
        </div>
      </div>
    }

    <!-- Merge Popup -->
    @if (showMergePopup()) {
      <app-merge-popup
        [sourceCardText]="mergeSourceCardText()"
        [targetCardText]="mergeTargetCardText()"
        (confirmed)="onMergeConfirmed()"
        (cancelled)="onMergeCancelled()"
      />
    }
  `,
  styles: [`
    :host {
      display: block;
      min-width: 300px;
      width: 300px;
      flex: 0 0 300px;
      /* Fills the board height so an empty column reads as a full drop target,
         and a populated one scrolls its own cards instead of overflowing the
         board (R7.16) */
      align-self: stretch;
      min-height: 0;
    }

    /* Horizontal layout: each aspect spans full width, cards flow left-to-right */
    :host.is-horizontal {
      width: 100%;
      min-width: unset;
      flex: 0 0 auto;
      /* Stacked layout: the container scrolls, so a column sizes to its cards */
      align-self: flex-start;
    }

    .retro-column {
      display: flex;
      flex-direction: column;
      /* Fills the stretched host; the card list is the only part that scrolls */
      height: 100%;
      min-height: 0;
      background: var(--surface-board);
      border: 2px solid var(--color-primary-light);
      border-radius: 6px;
      overflow: hidden;
      transition: border-color 0.15s ease;
    }

    /* Stacked layout keeps content sizing */
    :host.is-horizontal .retro-column {
      height: auto;
    }

    .retro-column.drag-over {
      border-color: var(--color-primary);
      background: var(--surface-column-drag-over);
    }

    /* Header */
    .retro-column__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      /* Name, count, add and delete stay on one row (R7.6) */
      flex-wrap: nowrap;
      padding: 4px 8px;
      background: var(--surface-card-deck);
      border-bottom: 1px solid var(--color-primary-light);
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
      color: var(--text-primary);
      /* Single line with an ellipsis; the full name lives on title/aria-label (R7.7) */
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1 1 auto;
      min-width: 0;
    }

    .retro-column__actions {
      display: flex;
      align-items: center;
      flex-wrap: nowrap;
      gap: 4px;
      flex-shrink: 0;
    }

    .retro-column__card-count {
      font-size: 0.75rem;
      color: var(--text-primary);
      background: var(--color-primary-light);
      padding: 4px 8px;
      border-radius: 8px;
      font-weight: 500;
      white-space: nowrap;
    }

    .retro-column__add-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      min-width: 32px;
      min-height: 32px;
      border: none;
      /* --color-primary-dark, not --color-primary: white on #667eea is 3.66:1,
         below the 4.5:1 the glyph needs; on #5a67d8 it is 4.81:1 (R7.4) */
      background: var(--color-primary-dark);
      color: var(--text-on-primary);
      border-radius: 4px;
      font-size: 1rem;
      font-weight: 700;
      cursor: pointer;
      line-height: 1;
    }

    .retro-column__add-btn:hover:not(:disabled) {
      background: var(--primary-ink-hover);
    }

    .retro-column__add-btn:disabled {
      background: var(--color-primary-light);
      color: var(--text-primary);
      cursor: not-allowed;
    }

    .retro-column__delete-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      min-width: 32px;
      min-height: 32px;
      border: none;
      background: var(--surface-card-deck);
      color: var(--text-secondary);
      border-radius: 4px;
      font-size: 0.75rem;
      cursor: pointer;
    }

    .retro-column__delete-btn:hover:not(:disabled) {
      /* Darkened destructive red so the icon keeps 4.5:1 on the header surface */
      color: var(--error-ink-hover);
      background: var(--wash-error-on-card);
    }

    .retro-column__delete-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* Cards area */
    .retro-column__cards {
      /* Takes the leftover height under the pinned header and scrolls its own
         overflow, so every card stays reachable (R7.16) */
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 0;
    }

    /* Horizontal mode: cards flow left-to-right */
    :host.is-horizontal .retro-column__cards {
      /* Content-sized in the stacked layout, so no grow factor */
      flex: 0 0 auto;
      flex-direction: row;
      flex-wrap: nowrap;
      overflow-x: auto;
      overflow-y: hidden;
      align-items: flex-start;
      min-height: unset;
    }

    /* Fixed card width when displayed in a horizontal row */
    :host.is-horizontal .retro-column__cards > app-retro-card {
      flex: 0 0 200px;
      min-width: 200px;
      max-width: 200px;
    }

    .retro-column__cards::-webkit-scrollbar {
      width: 6px;
    }

    .retro-column__cards::-webkit-scrollbar-track {
      background: var(--color-primary-light);
      border-radius: 3px;
    }

    .retro-column__cards::-webkit-scrollbar-thumb {
      background: var(--text-secondary);
      border-radius: 3px;
    }

    .retro-column__cards::-webkit-scrollbar-thumb:hover {
      background: var(--text-primary);
    }

    .retro-column__hidden-count {
      text-align: center;
      font-size: 0.75rem;
      color: var(--text-secondary);
      padding: 8px;
      background: var(--surface-board);
      border-radius: 4px;
      border: 1px dashed var(--color-primary-light);
    }

    /* Drop indicator injected via DOM — vertical layout (default) */
    :host ::ng-deep .retro-drop-indicator {
      height: 3px;
      background: var(--color-primary);
      border-radius: 2px;
      margin: 4px 0;
      transition: none;
      flex-shrink: 0;
    }

    /* Drop indicator — horizontal layout (vertical bar between cards) */
    :host.is-horizontal ::ng-deep .retro-drop-indicator {
      width: 3px;
      height: auto;
      align-self: stretch;
      min-height: 80px;
      margin: 0 4px;
    }

    /* Delete confirmation dialog */
    .retro-column__dialog-backdrop {
      position: fixed;
      inset: 0;
      background: var(--scrim-dialog);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .retro-column__dialog {
      background: var(--surface-card-deck);
      border-radius: 10px;
      padding: 20px;
      min-width: 280px;
      box-shadow: var(--shadow-lg);
    }

    .retro-column__dialog-text {
      margin: 0 0 16px;
      font-size: 0.9rem;
      color: var(--text-primary);
    }

    .retro-column__dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .retro-column__dialog-btn {
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      min-width: 64px;
      min-height: 36px;
    }

    .retro-column__dialog-btn--cancel {
      border: 1px solid var(--color-primary-light);
      background: var(--surface-card-deck);
      color: var(--text-secondary);
    }

    .retro-column__dialog-btn--cancel:hover {
      background: var(--surface-board);
    }

    .retro-column__dialog-btn--delete {
      border: none;
      background: var(--error-ink-hover);
      color: var(--text-on-primary);
    }

    .retro-column__dialog-btn--delete:hover {
      background: var(--error-ink-active);
    }
  `],
})
export class RetroColumnComponent {
  private readonly ws = inject(RetroWebSocketService);
  private readonly retroState = inject(RetroStateService);
  private readonly elementRef = inject(ElementRef);

  readonly cardsContainer = viewChild<ElementRef>('cardsContainer');

  /** Required input: the column data */
  readonly column = input.required<RetroColumn>();

  /** UI state */
  readonly showDeleteConfirm = signal(false);

  /** Merge popup state */
  readonly showMergePopup = signal(false);
  readonly mergeSourceCardText = signal('');
  readonly mergeTargetCardText = signal('');
  private mergeSourceCardId: string | null = null;
  private mergeTargetCardId: string | null = null;

  /** Computed: whether cards are revealed */
  readonly cardsRevealed = this.retroState.cardsRevealed;

  /** Computed: whether all cards should be visible to everyone */
  readonly cardsVisible = computed(() => {
    const config = this.retroState.config();
    if (!config?.hideCardsInitially) return true;
    return this.retroState.cardsRevealed();
  });

  /** Computed: whether current user is moderator */
  readonly isModerator = this.retroState.isModerator;

  /** Computed: whether board is completed */
  readonly isCompleted = this.retroState.isCompleted;

  /** Computed: whether the board is in horizontal layout mode */
  readonly isHorizontalLayout = computed(() => {
    return this.retroState.config()?.columnLayout === 'horizontal';
  });

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

  /** Track the drop indicator element for cleanup */
  private dropIndicator: HTMLElement | null = null;

  // --- Add Card ---

  onAddCard(): void {
    this.ws.sendCardAdd(this.column().id, '');
  }

  // --- Delete Column ---

  confirmDeleteColumn(): void {
    this.ws.sendColumnRemove(this.column().id);
    this.showDeleteConfirm.set(false);
  }

  // --- Column Drag Start (for reordering columns) ---

  onColumnDragStart(event: DragEvent): void {
    event.dataTransfer!.setData('text/retro-column-id', this.column().id);
    event.dataTransfer!.effectAllowed = 'move';
    // Don't propagate to the column's own dragover
    event.stopPropagation();
  }

  onColumnDragEnd(_event: DragEvent): void {
    this.removeDropIndicator();
    this.elementRef.nativeElement.querySelector('.retro-column')?.classList.remove('drag-over');
  }

  // --- Unified Drag Over / Drop for both cards and columns ---

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'move';

    const types = Array.from(event.dataTransfer?.types ?? []);

    if (types.includes('text/retro-column-id')) {
      // Column reorder - highlight the whole column
      this.elementRef.nativeElement.querySelector('.retro-column')?.classList.add('drag-over');
      return;
    }

    if (types.includes('text/retro-card-id')) {
      // Card move - show drop indicator at the correct position
      this.showDropIndicator(event);
    }
  }

  onDragLeave(event: DragEvent): void {
    const related = event.relatedTarget as HTMLElement | null;
    const columnEl = this.elementRef.nativeElement.querySelector('.retro-column') as HTMLElement;
    if (!related || !columnEl.contains(related)) {
      columnEl.classList.remove('drag-over');
      this.removeDropIndicator();
    }
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const columnEl = this.elementRef.nativeElement.querySelector('.retro-column');
    columnEl?.classList.remove('drag-over');

    // Handle column reorder
    const droppedColumnId = event.dataTransfer?.getData('text/retro-column-id');
    if (droppedColumnId && droppedColumnId !== this.column().id) {
      const columns = this.retroState.columns();
      const currentOrder = columns.map(c => c.id);
      const fromIndex = currentOrder.indexOf(droppedColumnId);
      const toIndex = currentOrder.indexOf(this.column().id);
      if (fromIndex !== -1 && toIndex !== -1) {
        const newOrder = [...currentOrder];
        newOrder.splice(fromIndex, 1);
        newOrder.splice(toIndex, 0, droppedColumnId);
        this.ws.sendColumnReorder(newOrder);
      }
      this.removeDropIndicator();
      return;
    }

    // Handle card drop
    const cardId = event.dataTransfer?.getData('text/retro-card-id');
    if (cardId) {
      // Detect card-on-card drop: check if the drop target has a data-card-id attribute
      const targetCardId = this.getTargetCardId(event);

      if (targetCardId && targetCardId !== cardId) {
        // Card-on-card drop detected — show merge popup (if board is not completed)
        if (this.isCompleted()) {
          // Prevent merge on completed boards
          this.removeDropIndicator();
          return;
        }

        // Find the source and target card texts
        const sourceCard = this.findCardById(cardId);
        const targetCard = this.findCardById(targetCardId);

        if (sourceCard && targetCard) {
          this.mergeSourceCardId = cardId;
          this.mergeTargetCardId = targetCardId;
          this.mergeSourceCardText.set(sourceCard.text);
          this.mergeTargetCardText.set(targetCard.text);
          this.showMergePopup.set(true);
        }
      } else {
        // Card-on-column drop — move the card as before
        const cards = this.column().cards;
        const originalIndex = cards.findIndex((c) => c.id === cardId);
        const dropIdx = adjustDropIndexForSameColumn(this.getDropIndex(event), originalIndex);
        this.ws.sendCardMove(cardId, this.column().id, dropIdx);
      }
    }

    this.removeDropIndicator();
  }

  // --- Drop indicator logic (pure DOM, no signals) ---

  private showDropIndicator(event: DragEvent): void {
    const container = this.cardsContainer()?.nativeElement as HTMLElement;
    if (!container) return;

    const isHorizontal = this.isHorizontalLayout();
    const cardElements = this.renderedCardElements(container);
    const dropIndex = computeDropIndex(
      this.measureCardRects(cardElements, isHorizontal),
      this.pointerPosition(event, isHorizontal)
    );
    const insertBeforeEl: Element | null = cardElements[dropIndex] ?? null;

    // Create or reuse the indicator
    if (!this.dropIndicator) {
      this.dropIndicator = document.createElement('div');
      this.dropIndicator.className = 'retro-drop-indicator';
    }

    if (insertBeforeEl) {
      container.insertBefore(this.dropIndicator, insertBeforeEl);
    } else {
      container.appendChild(this.dropIndicator);
    }
  }

  private removeDropIndicator(): void {
    if (this.dropIndicator && this.dropIndicator.parentNode) {
      this.dropIndicator.parentNode.removeChild(this.dropIndicator);
    }
    this.dropIndicator = null;
  }

  private getDropIndex(event: DragEvent): number {
    const container = this.cardsContainer()?.nativeElement as HTMLElement;
    if (!container) return 0;

    const isHorizontal = this.isHorizontalLayout();
    const cardElements = this.renderedCardElements(container);

    return computeDropIndex(
      this.measureCardRects(cardElements, isHorizontal),
      this.pointerPosition(event, isHorizontal)
    );
  }

  /**
   * The column's own rendered card elements, in document order. Direct children
   * only, so the drop indicator and the hidden-card notice are never measured.
   */
  private renderedCardElements(container: HTMLElement): Element[] {
    return Array.from(container.children).filter(
      (child) => child.tagName.toLowerCase() === 'app-retro-card'
    );
  }

  /**
   * Each card's measured extent along the active layout axis, read at drag
   * time: left/width for horizontal columns, top/height for vertical ones.
   */
  private measureCardRects(cardElements: readonly Element[], isHorizontal: boolean): CardRect[] {
    return cardElements.map((cardEl) => {
      const rect = cardEl.getBoundingClientRect();
      return isHorizontal
        ? { start: rect.left, size: rect.width }
        : { start: rect.top, size: rect.height };
    });
  }

  /** Pointer position along the active layout axis. */
  private pointerPosition(event: DragEvent, isHorizontal: boolean): number {
    return isHorizontal ? event.clientX : event.clientY;
  }

  // --- Card-on-card drop detection ---

  /**
   * Detect if the drop target is a card element.
   * Returns the target card's ID if the drop happened on a card, otherwise null.
   */
  private getTargetCardId(event: DragEvent): string | null {
    const target = event.target as HTMLElement;
    if (!target) return null;

    // Walk up from the drop target to find the closest element with data-card-id
    const cardElement = target.closest('[data-card-id]');
    if (cardElement) {
      return cardElement.getAttribute('data-card-id');
    }

    return null;
  }

  /**
   * Find a card by ID across all columns.
   */
  private findCardById(cardId: string): RetroCard | null {
    const columns = this.retroState.columns();
    for (const col of columns) {
      const card = col.cards.find(c => c.id === cardId);
      if (card) return card;
    }
    return null;
  }

  // --- Merge popup handlers ---

  onMergeConfirmed(): void {
    if (this.mergeSourceCardId && this.mergeTargetCardId) {
      this.ws.sendCardMerge(this.mergeSourceCardId, this.mergeTargetCardId);
    }
    this.dismissMergePopup();
  }

  onMergeCancelled(): void {
    this.dismissMergePopup();
  }

  private dismissMergePopup(): void {
    this.showMergePopup.set(false);
    this.mergeSourceCardId = null;
    this.mergeTargetCardId = null;
    this.mergeSourceCardText.set('');
    this.mergeTargetCardText.set('');
  }
}
