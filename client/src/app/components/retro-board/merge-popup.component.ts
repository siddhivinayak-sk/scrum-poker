import { Component, input, output, ElementRef, inject, HostListener, afterNextRender } from '@angular/core';

@Component({
  selector: 'app-merge-popup',
  standalone: true,
  imports: [],
  template: `
    <div class="merge-popup__backdrop" (click)="onCancel()">
      <div
        class="merge-popup__dialog"
        role="alertdialog"
        aria-label="Confirm card merge"
        (click)="$event.stopPropagation()"
      >
        <p class="merge-popup__title">Merge Cards?</p>
        <p class="merge-popup__description">
          The source card text will be appended to the target card, separated by a line.
        </p>
        <div class="merge-popup__preview">
          <div class="merge-popup__card-preview">
            <span class="merge-popup__label">Target:</span>
            <span class="merge-popup__text">{{ targetCardText() }}</span>
          </div>
          <div class="merge-popup__separator">--------</div>
          <div class="merge-popup__card-preview">
            <span class="merge-popup__label">Source:</span>
            <span class="merge-popup__text">{{ sourceCardText() }}</span>
          </div>
        </div>
        <div class="merge-popup__actions">
          <button
            #cancelBtn
            class="merge-popup__btn merge-popup__btn--cancel"
            type="button"
            (click)="onCancel()"
          >Cancel</button>
          <button
            #mergeBtn
            class="merge-popup__btn merge-popup__btn--merge"
            type="button"
            (click)="onConfirm()"
          >Merge</button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .merge-popup__backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .merge-popup__dialog {
      background: #fff;
      border-radius: 10px;
      padding: 1.25rem;
      min-width: 320px;
      max-width: 420px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
    }

    .merge-popup__title {
      margin: 0 0 0.5rem;
      font-size: 1rem;
      font-weight: 600;
      color: #333;
    }

    .merge-popup__description {
      margin: 0 0 1rem;
      font-size: 0.85rem;
      color: #666;
    }

    .merge-popup__preview {
      background: #f8f9fa;
      border: 1px solid #e0e0e0;
      border-radius: 6px;
      padding: 0.75rem;
      margin-bottom: 1rem;
    }

    .merge-popup__card-preview {
      display: flex;
      gap: 0.5rem;
      font-size: 0.8rem;
      color: #333;
    }

    .merge-popup__label {
      font-weight: 600;
      flex-shrink: 0;
    }

    .merge-popup__text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .merge-popup__separator {
      text-align: center;
      font-size: 0.7rem;
      color: #999;
      margin: 0.25rem 0;
    }

    .merge-popup__actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
    }

    .merge-popup__btn {
      padding: 0.4rem 1rem;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
      min-height: 36px;
    }

    .merge-popup__btn--cancel {
      border: 1px solid #d0d5dd;
      background: #fff;
      color: #555;
    }

    .merge-popup__btn--cancel:hover {
      background: #f5f5f5;
    }

    .merge-popup__btn--merge {
      border: none;
      background: #667eea;
      color: #fff;
    }

    .merge-popup__btn--merge:hover {
      background: #5a6fd6;
    }
  `],
})
export class MergePopupComponent {
  private readonly elementRef = inject(ElementRef);

  /** Input: source card text */
  readonly sourceCardText = input.required<string>();

  /** Input: target card text */
  readonly targetCardText = input.required<string>();

  /** Output: user confirmed the merge */
  readonly confirmed = output<void>();

  /** Output: user cancelled the merge */
  readonly cancelled = output<void>();

  constructor() {
    afterNextRender(() => {
      // Focus the dialog for accessibility
      const dialog = this.elementRef.nativeElement.querySelector('.merge-popup__dialog');
      dialog?.focus();
    });
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    this.onCancel();
  }

  onConfirm(): void {
    this.confirmed.emit();
  }

  onCancel(): void {
    this.cancelled.emit();
  }
}
