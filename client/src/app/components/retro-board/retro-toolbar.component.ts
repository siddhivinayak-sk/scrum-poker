import { Component, input, inject, output, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RetroWebSocketService } from '../../services/retro-websocket.service';
import { RetroStateService } from '../../services/retro-state.service';
import { RetroExportService } from '../../services/retro-export.service';
import { RetroScreenshotService } from '../../services/retro-screenshot.service';
import { ToastService } from '../../services/toast.service';
import {
  ALL_FEELING_CATEGORIES,
  FEELING_EMOJI_MAP,
  FeelingCategory,
  resolveFluidCardHeight,
} from '@shared/types';
import { FeelingsStripComponent } from '../feelings-strip/feelings-strip.component';

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
  imports: [CommonModule, FeelingsStripComponent],
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
        [disabled]="capturing()"
        (click)="onScreenshot()"
      >📸</button>

      <button
        class="retro-toolbar__btn"
        title="Add Column"
        aria-label="Add Column"
        [disabled]="isCompleted()"
        (click)="showAddColumnDialog.set(true)"
      >➕</button>

      @if (isModerator()) {
        <button
          class="retro-toolbar__btn"
          title="Board Settings"
          aria-label="Board Settings"
          (click)="showSettingsDialog.set(true)"
        >⚙️</button>
      }

      <!-- Spacer pushes feelings strip to the right -->
      <div class="retro-toolbar__spacer"></div>

      <!-- Feelings strip - renders regardless of retro template -->
      <app-feelings-strip />

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

    <!-- Board Settings Dialog -->
    @if (showSettingsDialog()) {
      <div class="retro-dialog-backdrop" (click)="showSettingsDialog.set(false)">
        <div class="retro-dialog retro-dialog--settings" (click)="$event.stopPropagation()" role="dialog" aria-label="Board settings">
          <h3 class="retro-dialog__title">Board Settings</h3>
          <div class="retro-settings">
            <label class="retro-settings__toggle">
              <input type="checkbox" [checked]="currentConfig()?.hideCardsInitially" (change)="onSettingChange('hideCardsInitially', $event)" />
              <span>Hide cards initially</span>
            </label>
            <label class="retro-settings__toggle">
              <input type="checkbox" [checked]="currentConfig()?.disableVotingInitially" (change)="onSettingChange('disableVotingInitially', $event)" />
              <span>Disable voting initially</span>
            </label>
            <label class="retro-settings__toggle">
              <input type="checkbox" [checked]="currentConfig()?.hideVoteCount" (change)="onSettingChange('hideVoteCount', $event)" />
              <span>Hide vote count on cards</span>
            </label>
            <label class="retro-settings__toggle">
              <input type="checkbox" [checked]="currentConfig()?.oneVotePerCard" (change)="onSettingChange('oneVotePerCard', $event)" />
              <span>One vote per card</span>
            </label>
            <label class="retro-settings__toggle">
              <input type="checkbox" [checked]="currentConfig()?.showCardAuthor" (change)="onSettingChange('showCardAuthor', $event)" />
              <span>Show card author</span>
            </label>
            <label class="retro-settings__toggle">
              <input type="checkbox" [checked]="currentConfig()?.enableGifEmoji" (change)="onSettingChange('enableGifEmoji', $event)" />
              <span>Enable GIF/emoji</span>
            </label>
            <!-- Moderator-only: only a moderator may change the card height rule, so
                 nobody else is offered the control (R6.10, R6.15). -->
            @if (isModerator()) {
              <label class="retro-settings__toggle">
                <input type="checkbox" [checked]="fluidCardHeightSetting()" (change)="onSettingChange('fluidCardHeight', $event)" />
                <span>Fluid card height</span>
              </label>
            }
            <div class="retro-settings__layout">
              <span>Column layout:</span>
              <label><input type="radio" name="layout" value="vertical" [checked]="currentConfig()?.columnLayout === 'vertical'" (change)="onLayoutChange('vertical')" /> Vertical</label>
              <label><input type="radio" name="layout" value="horizontal" [checked]="currentConfig()?.columnLayout === 'horizontal'" (change)="onLayoutChange('horizontal')" /> Horizontal</label>
            </div>

            <!-- Feelings Configuration -->
            <div class="retro-settings__section-label">Feelings</div>
            <div class="retro-settings__feelings">
              @for (category of allFeelingCategories; track category) {
                <label class="retro-settings__toggle">
                  <input
                    type="checkbox"
                    [checked]="isFeelingAllowed(category)"
                    [disabled]="isFeelingDisabled(category)"
                    (change)="onFeelingToggle(category, $event)"
                    [attr.aria-label]="getFeelingEmoji(category) + ' ' + category"
                  />
                  <span>{{ getFeelingEmoji(category) }} {{ category }}</span>
                </label>
              }
            </div>
          </div>
          <div class="retro-dialog__actions">
            <button class="retro-dialog__btn retro-dialog__btn--ok" (click)="showSettingsDialog.set(false)">Close</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      flex-shrink: 0;
    }

    /* Single compact row. box-sizing keeps max-height the *outer* bounding box,
       so padding and border are inside the 40px cap required by R10.1:
       4px + 32px control + 4px = 40px. */
    .retro-toolbar {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      margin-bottom: 8px;
      box-sizing: border-box;
      max-height: 40px;
      background: var(--surface-card-deck);
      border: 1px solid var(--color-primary-light);
      border-radius: 6px;
      flex-shrink: 0;
      /* Controls stay on one row; surplus width scrolls inside the toolbar's own
         box so the page keeps overflow-x: hidden (R10.8) */
      flex-wrap: nowrap;
      overflow-x: auto;
      overflow-y: hidden;
    }

    /* Sub-768px: wrap to at most three 40px rows (R10.2) */
    @media (max-width: 767px) {
      .retro-toolbar {
        max-height: 120px;
        flex-wrap: wrap;
        row-gap: 0;
        overflow-x: hidden;
      }
    }

    .retro-toolbar__btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      /* 32x32 minimum pointer target (R10.3) */
      min-width: 32px;
      min-height: 32px;
      width: 32px;
      height: 32px;
      flex: 0 0 auto;
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
      /* No token for a neutral hover wash: mixed from the text token so it tints
         whichever toolbar surface is underneath. */
      background: var(--wash-neutral-weak);
    }

    .retro-toolbar__btn:active:not(:disabled) {
      background: var(--wash-neutral-strong);
    }

    .retro-toolbar__btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .retro-toolbar__btn:focus-visible {
      outline: 2px solid var(--color-primary-dark);
      outline-offset: 2px;
    }

    .retro-toolbar__file-input {
      display: none;
    }

    .retro-toolbar__spacer {
      flex: 1;
    }

    /* The strip is a toolbar row item that never stretches, so no empty bordered
       region can grow past the controls it holds (R10.10) */
    .retro-toolbar app-feelings-strip {
      flex: 0 0 auto;
      min-width: 0;
    }

    /* Dialog styles */
    .retro-dialog-backdrop {
      position: fixed;
      inset: 0;
      background: var(--scrim-dialog);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .retro-dialog {
      background: var(--surface-card-deck);
      border-radius: 10px;
      padding: 24px;
      min-width: 300px;
      box-shadow: var(--shadow-lg);
    }

    .retro-dialog__title {
      margin: 0 0 16px;
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .retro-dialog__input {
      width: 100%;
      padding: 8px 12px;
      border: 1px solid var(--color-primary-light);
      border-radius: 6px;
      font-size: 0.9rem;
      color: var(--text-primary);
      background: var(--surface-board);
      outline: none;
      box-sizing: border-box;
      min-height: 32px;
    }

    .retro-dialog__input:focus {
      border-color: var(--color-primary);
      box-shadow: 0 0 0 2px var(--focus-ring-primary);
    }

    .retro-dialog__actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    }

    .retro-dialog__btn {
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      min-width: 64px;
      min-height: 36px;
    }

    .retro-dialog__btn--cancel {
      border: 1px solid var(--color-primary-light);
      background: var(--surface-card-deck);
      color: var(--text-secondary);
    }

    .retro-dialog__btn--cancel:hover {
      background: var(--surface-board);
    }

    .retro-dialog__btn--ok {
      border: none;
      /* --color-primary-dark, not --color-primary: white on #667eea is 3.66:1,
         below the 4.5:1 the label needs; on #5a67d8 it is 4.81:1 (R10.6) */
      background: var(--color-primary-dark);
      color: var(--text-on-primary);
    }

    .retro-dialog__btn--ok:hover {
      background: var(--primary-ink-hover);
    }

    .retro-dialog__btn:focus-visible {
      outline: 2px solid var(--color-primary-dark);
      outline-offset: 2px;
    }

    /* Height-capped flex column. The backdrop is a centred fixed box, so an
       unbounded body is clipped at BOTH ends rather than scrolled; the cap plus
       the scrolling body below keeps the title and the Close button in view. */
    .retro-dialog--settings {
      min-width: 320px;
      width: min(620px, calc(100vw - 32px));
      max-height: calc(100dvh - 48px);
      display: flex;
      flex-direction: column;
    }

    /* Responsive multi-column grid: auto-fit collapses to a single column on a
       narrow viewport with no media query. min-height: 0 is load-bearing, since
       a grid item's automatic minimum size would otherwise defeat the cap. */
    .retro-settings {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 8px 20px;
      align-content: start;
      margin-bottom: 16px;
      overflow-y: auto;
      min-height: 0;
    }

    /* The label is the activation target, so it carries the 32px minimum; the
       native checkbox keeps its platform size inside it. */
    .retro-settings__toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 32px;
      font-size: 0.85rem;
      color: var(--text-primary);
      cursor: pointer;
    }

    .retro-settings__toggle input[type="checkbox"] {
      width: 16px;
      height: 16px;
      accent-color: var(--color-primary);
      cursor: pointer;
    }

    .retro-settings__layout {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 0.85rem;
      color: var(--text-primary);
    }

    .retro-settings__layout label {
      display: flex;
      align-items: center;
      gap: 4px;
      min-height: 32px;
      cursor: pointer;
    }

    .retro-settings__layout input[type="radio"] {
      accent-color: var(--color-primary);
      cursor: pointer;
    }

    .retro-settings__section-label {
      grid-column: 1 / -1;
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-primary);
      margin-top: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--color-primary-light);
    }

    .retro-settings__feelings {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 8px 20px;
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

  /**
   * True while a board capture is in progress; renders the screenshot action
   * in the disabled state so no second capture can start (R4.10).
   */
  readonly capturing = this.screenshotService.capturing;

  /** Computed state from RetroStateService */
  readonly cardsRevealed = this.retroState.cardsRevealed;
  readonly votingEnabled = this.retroState.votingEnabled;

  /** Column input state */
  readonly showAddColumnDialog = signal(false);
  readonly showSettingsDialog = signal(false);

  /** Current config for settings dialog */
  readonly currentConfig = this.retroState.config;

  /**
   * Stored `fluidCardHeight` value for the settings dialog checkbox.
   * A config that omits the field (or carries a non-boolean) reads as `true`.
   */
  readonly fluidCardHeightSetting = computed<boolean>(() =>
    resolveFluidCardHeight(this.currentConfig()?.fluidCardHeight)
  );

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
      // Error toast with specific server message is handled by RetroExportService
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
      () => {
        // Error toast with specific server message is handled by RetroExportService
      }
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

  // --- Settings ---

  onSettingChange(key: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.ws.sendConfigUpdate({ [key]: checked });
  }

  onLayoutChange(layout: 'vertical' | 'horizontal'): void {
    this.ws.sendConfigUpdate({ columnLayout: layout });
  }

  // --- Feelings settings ---

  /** All feeling categories for the settings checkboxes */
  readonly allFeelingCategories = ALL_FEELING_CATEGORIES;

  /** Computed allowed feelings from current config */
  readonly allowedFeelings = computed<FeelingCategory[]>(() => {
    return this.currentConfig()?.allowedFeelings ?? [];
  });

  /** Check if a feeling category is currently allowed */
  isFeelingAllowed(category: FeelingCategory): boolean {
    return this.allowedFeelings().includes(category);
  }

  /** Disable the last remaining checked checkbox to enforce minimum-one constraint */
  isFeelingDisabled(category: FeelingCategory): boolean {
    const allowed = this.allowedFeelings();
    return allowed.length === 1 && allowed.includes(category);
  }

  /** Get emoji for a feeling category */
  getFeelingEmoji(category: FeelingCategory): string {
    return FEELING_EMOJI_MAP[category];
  }

  /** Handle toggling a feeling category checkbox */
  onFeelingToggle(category: FeelingCategory, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    const current = this.allowedFeelings();

    let updated: FeelingCategory[];
    if (checked) {
      // Add category (maintain order from ALL_FEELING_CATEGORIES)
      updated = ALL_FEELING_CATEGORIES.filter(
        (c) => current.includes(c) || c === category
      );
    } else {
      // Remove category (enforce minimum-one should prevent this from going to 0)
      updated = current.filter((c) => c !== category);
      if (updated.length === 0) return; // safety guard
    }

    this.ws.sendConfigUpdate({ allowedFeelings: updated });
  }
}
