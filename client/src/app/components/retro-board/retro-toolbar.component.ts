import { Component, input, inject, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { RetroStateService } from '../../services/retro-state.service';
import { RetroExportService } from '../../services/retro-export.service';
import { RetroScreenshotService } from '../../services/retro-screenshot.service';
import { ToastService } from '../../services/toast.service';

/**
 * Toolbar component for the retrospective board.
 * Displays icon-only buttons with title and aria-label attributes.
 * Moderator buttons: Reveal Cards, Enable Voting, Complete Retrospective, Import CSV
 * Shared buttons: Copy Link, Export CSV, Screenshot, Add Column
 *
 * Requirements: 5.2, 11.1, 11.2, 11.3, 13.1, 14.1, 21.1, 21.2, 21.3, 21.4, 21.5, 22.1
 */
@Component({
  selector: 'app-retro-toolbar',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="retro-toolbar" role="toolbar" aria-label="Board actions">
      <!-- Moderator-only buttons -->
      @if (isModerator()) {
        <button
          class="retro-toolbar__btn"
          title="Reveal Cards"
          aria-label="Reveal Cards"
          [disabled]="isCompleted() || cardsRevealed()"
          (click)="onRevealCards()"
        >👁️</button>

        <button
          class="retro-toolbar__btn"
          title="Enable Voting"
          aria-label="Enable Voting"
          [disabled]="isCompleted() || votingEnabled()"
          (click)="onEnableVoting()"
        >🗳️</button>

        <button
          class="retro-toolbar__btn"
          title="Complete Retrospective"
          aria-label="Complete Retrospective"
          [disabled]="isCompleted()"
          (click)="onCompleteBoard()"
        >✅</button>
      }

      <!-- Shared buttons -->
      <button
        class="retro-toolbar__btn"
        title="Export CSV"
        aria-label="Export CSV"
        (click)="onExportCSV()"
      >📥</button>

      @if (isModerator()) {
        <button
          class="retro-toolbar__btn"
          title="Import CSV"
          aria-label="Import CSV"
          [disabled]="isCompleted()"
          (click)="onImportCSV()"
        >📤</button>
      }

      <button
        class="retro-toolbar__btn"
        title="Screenshot"
        aria-label="Screenshot"
        (click)="onScreenshot()"
      >📸</button>

      <button
        class="retro-toolbar__btn"
        title="Add Column"
        aria-label="Add Column"
        [disabled]="isCompleted()"
        (click)="showAddColumnDialog.set(true)"
      >➕</button>

      <!-- Hidden file input for CSV import -->
      <input
        #fileInput
        type="file"
        accept=".csv"
        class="retro-toolbar__file-input"
        (change)="onFileSelected($event)"
        aria-hidden="true"
      />
    </div>

    <!-- Add Column Dialog -->
    @if (showAddColumnDialog()) {
      <div class="retro-dialog-backdrop" (click)="showAddColumnDialog.set(false)">
        <div class="retro-dialog" (click)="$event.stopPropagation()" role="dialog" aria-label="Add column">
          <h3 class="retro-dialog__title">Add Column</h3>
          <input
            #dialogColumnInput
            class="retro-dialog__input"
            type="text"
            placeholder="Enter column name"
            aria-label="Column name"
            (keydown.enter)="onDialogSubmit($event)"
            (keydown.escape)="showAddColumnDialog.set(false)"
          />
          <div class="retro-dialog__actions">
            <button class="retro-dialog__btn retro-dialog__btn--cancel" (click)="showAddColumnDialog.set(false)">Cancel</button>
            <button class="retro-dialog__btn retro-dialog__btn--ok" (click)="onDialogOk()">OK</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .retro-toolbar {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 0.25rem;
      padding: 0.25rem 0.5rem;
      margin-bottom: 0.375rem;
      background: #fff;
      border: 1px solid #e0e0e0;
      border-radius: 6px;
      flex-shrink: 0;
      flex-wrap: wrap;
    }

    .retro-toolbar__btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 32px;
      min-height: 32px;
      width: 32px;
      height: 32px;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: transparent;
      cursor: pointer;
      font-size: 1rem;
      line-height: 1;
      transition: background-color 0.15s ease;
    }

    .retro-toolbar__btn:hover:not(:disabled) {
      background: #f0f0f0;
    }

    .retro-toolbar__btn:active:not(:disabled) {
      background: #e0e0e0;
    }

    .retro-toolbar__btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .retro-toolbar__btn:focus-visible {
      outline: 2px solid var(--color-primary, #667eea);
      outline-offset: 2px;
    }

    .retro-toolbar__file-input {
      display: none;
    }

    /* Dialog styles */
    .retro-dialog-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .retro-dialog {
      background: #fff;
      border-radius: 10px;
      padding: 1.5rem;
      min-width: 300px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
    }

    .retro-dialog__title {
      margin: 0 0 1rem;
      font-size: 1rem;
      font-weight: 600;
      color: #1a1a2e;
    }

    .retro-dialog__input {
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: 1px solid #d0d5dd;
      border-radius: 6px;
      font-size: 0.9rem;
      outline: none;
      box-sizing: border-box;
    }

    .retro-dialog__input:focus {
      border-color: #667eea;
      box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.2);
    }

    .retro-dialog__actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      margin-top: 1rem;
    }

    .retro-dialog__btn {
      padding: 0.4rem 1rem;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      min-height: 36px;
    }

    .retro-dialog__btn--cancel {
      border: 1px solid #d0d5dd;
      background: #fff;
      color: #555;
    }

    .retro-dialog__btn--cancel:hover {
      background: #f5f5f5;
    }

    .retro-dialog__btn--ok {
      border: none;
      background: #667eea;
      color: #fff;
    }

    .retro-dialog__btn--ok:hover {
      background: #5a6fd6;
    }

    @media (prefers-reduced-motion: reduce) {
      .retro-toolbar__btn {
        transition: none;
      }
    }
  `],
})
export class RetroToolbarComponent {
  private readonly ws = inject(RetroWebSocketService);
  private readonly retroState = inject(RetroStateService);
  private readonly exportService = inject(RetroExportService);
  private readonly screenshotService = inject(RetroScreenshotService);
  private readonly toastService = inject(ToastService);

  /** Whether the current user is the moderator */
  readonly isModerator = input<boolean>(false);

  /** Whether the board is completed (locked) */
  readonly isCompleted = input<boolean>(false);

  /** Output event for screenshot capture (parent provides board element) */
  readonly screenshotRequested = output<void>();

  /** Computed state from RetroStateService */
  readonly cardsRevealed = this.retroState.cardsRevealed;
  readonly votingEnabled = this.retroState.votingEnabled;

  /** Column input state */
  readonly showAddColumnDialog = signal(false);

  /** File input reference (managed via event) */
  private fileInputElement: HTMLInputElement | null = null;

  // --- Moderator actions ---

  onRevealCards(): void {
    this.ws.sendCardsReveal();
  }

  onEnableVoting(): void {
    this.ws.sendVotingEnable();
  }

  onCompleteBoard(): void {
    this.ws.sendBoardComplete();
  }

  // --- Shared actions ---

  onExportCSV(): void {
    const state = this.retroState.state();
    if (!state) return;
    this.exportService.exportCSV(state.sessionId).catch(() => {
      this.toastService.show('error', 'Failed to export CSV');
    });
  }

  onImportCSV(): void {
    // Trigger the hidden file input
    const input = document.querySelector<HTMLInputElement>(
      'app-retro-toolbar .retro-toolbar__file-input'
    );
    if (input) {
      input.value = '';
      input.click();
    }
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const state = this.retroState.state();
    if (!state) return;

    this.exportService.importCSV(state.sessionId, file).then(
      () => this.toastService.show('info', 'CSV imported successfully'),
      () => this.toastService.show('error', 'Failed to import CSV. Check file format.')
    );
  }

  onScreenshot(): void {
    // Find the board element in the DOM for screenshot capture
    const boardElement = document.querySelector<HTMLElement>('.retro-board');
    if (boardElement) {
      this.screenshotService.captureBoard(boardElement);
    } else {
      this.toastService.show('error', 'Board element not found for screenshot');
    }
  }

  onAddColumn(): void {
    this.showAddColumnDialog.set(true);
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('.retro-dialog__input');
      input?.focus();
    }, 0);
  }

  onDialogSubmit(event: Event): void {
    const input = event.target as HTMLInputElement;
    const name = input.value.trim();
    if (name) {
      this.ws.sendColumnAdd(name);
    }
    this.showAddColumnDialog.set(false);
  }

  onDialogOk(): void {
    const input = document.querySelector<HTMLInputElement>('.retro-dialog__input');
    const name = input?.value.trim();
    if (name) {
      this.ws.sendColumnAdd(name);
    }
    this.showAddColumnDialog.set(false);
  }
}
