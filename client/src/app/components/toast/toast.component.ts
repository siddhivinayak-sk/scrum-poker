import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToastService, ToastMessage } from '../../services/toast.service';

@Component({
  selector: 'app-toast',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="toast-container" aria-label="Notifications">
      @for (toast of toastService.toasts(); track toast.id) {
        <div
          class="toast"
          [class.toast--error]="toast.type === 'error'"
          [class.toast--warning]="toast.type === 'warning'"
          [class.toast--info]="toast.type === 'info'"
          [attr.role]="toast.type === 'error' ? 'alert' : 'status'"
          [attr.aria-live]="toast.type === 'error' ? 'assertive' : 'polite'"
          [attr.aria-atomic]="true"
        >
          <span class="toast__message">{{ toast.message }}</span>
          <button
            class="toast__dismiss"
            (click)="dismiss(toast.id)"
            [attr.aria-label]="'Dismiss ' + toast.type + ' notification: ' + toast.message"
          >
            ×
          </button>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .toast-container {
        position: fixed;
        top: 1rem;
        right: 1rem;
        z-index: 10000;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        max-width: 400px;
        pointer-events: none;
      }

      .toast {
        display: flex;
        align-items: flex-start;
        gap: 0.75rem;
        padding: 0.75rem 1rem;
        border-radius: 8px;
        background: #ffffff;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        border-left: 4px solid transparent;
        pointer-events: auto;
        animation: toastSlideIn 300ms ease-out;
      }

      @keyframes toastSlideIn {
        from {
          opacity: 0;
          transform: translateX(100%);
        }
        to {
          opacity: 1;
          transform: translateX(0);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .toast {
          animation: none;
        }
      }

      .toast--error {
        border-left-color: var(--toast-error, #e53e3e);
      }

      .toast--warning {
        border-left-color: var(--toast-warning, #dd6b20);
      }

      .toast--info {
        border-left-color: var(--toast-info, #3182ce);
      }

      .toast__message {
        flex: 1;
        font-size: 0.875rem;
        line-height: 1.4;
        color: var(--text-primary, #1a1a2e);
        padding-top: 2px;
      }

      .toast__dismiss {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 44px;
        min-height: 44px;
        width: 44px;
        height: 44px;
        padding: 0;
        border: none;
        background: transparent;
        font-size: 1.25rem;
        line-height: 1;
        color: var(--text-secondary, #4a5568);
        cursor: pointer;
        border-radius: 4px;
        flex-shrink: 0;
        transition: background-color 0.15s, color 0.15s;
      }

      .toast__dismiss:hover {
        background: rgba(0, 0, 0, 0.05);
        color: var(--text-primary, #1a1a2e);
      }

      .toast__dismiss:focus-visible {
        outline: 2px solid var(--color-primary, #667eea);
        outline-offset: -2px;
      }
    `,
  ],
})
export class ToastComponent {
  readonly toastService = inject(ToastService);

  dismiss(id: string): void {
    this.toastService.dismiss(id);
  }
}
