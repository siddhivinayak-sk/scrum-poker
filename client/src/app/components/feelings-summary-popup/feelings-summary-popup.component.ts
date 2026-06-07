import {
  Component,
  input,
  output,
  inject,
  computed,
  signal,
  ElementRef,
  HostListener,
  afterNextRender,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FeelingCategory, FEELING_EMOJI_MAP, User } from '@shared/types';
import { FeelingsService } from '../../services/feelings.service';
import { RetroStateService } from '../../services/retro-state.service';
import { ToastService } from '../../services/toast.service';

@Component({
  selector: 'app-feelings-summary-popup',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (open()) {
      <div
        class="feelings-summary__backdrop"
        (click)="close()"
        aria-hidden="true"
      ></div>
      <div
        class="feelings-summary__dialog"
        role="dialog"
        aria-label="Feelings Summary"
        aria-modal="true"
        (click)="$event.stopPropagation()"
      >
        <div class="feelings-summary__header">
          <h2 class="feelings-summary__title">Feelings Summary</h2>
          <button
            class="feelings-summary__close-btn"
            type="button"
            (click)="close()"
            aria-label="Close feelings summary"
          >×</button>
        </div>

        <div class="feelings-summary__content" #popupContent>
          <ul class="feelings-summary__list" role="list">
            @for (entry of sortedParticipants(); track entry.userId) {
              <li class="feelings-summary__item">
                <span class="feelings-summary__name">{{ entry.displayName }}</span>
                <span class="feelings-summary__feeling">
                  @if (entry.feeling) {
                    <span class="feelings-summary__emoji">{{ getEmoji(entry.feeling) }}</span>
                    <span class="feelings-summary__category">{{ entry.feeling }}</span>
                  } @else {
                    <span class="feelings-summary__no-feeling">No feeling</span>
                  }
                </span>
              </li>
            }
          </ul>
        </div>

        <div class="feelings-summary__footer">
          <button
            class="feelings-summary__screenshot-btn"
            type="button"
            [disabled]="capturing()"
            (click)="captureScreenshot()"
            aria-label="Take screenshot of feelings summary"
          >
            @if (capturing()) {
              <span class="feelings-summary__spinner" aria-hidden="true"></span>
              Capturing…
            } @else {
              📷 Screenshot
            }
          </button>
        </div>
      </div>
    }
  `,
  styles: [`
    .feelings-summary__backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.4);
      z-index: 1000;
    }

    .feelings-summary__dialog {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: #fff;
      border-radius: 12px;
      padding: 1.5rem;
      min-width: 360px;
      max-width: 500px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
      z-index: 1001;
    }

    .feelings-summary__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1rem;
    }

    .feelings-summary__title {
      margin: 0;
      font-size: 1.1rem;
      font-weight: 600;
      color: #333;
    }

    .feelings-summary__close-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: 36px;
      min-height: 36px;
      width: 36px;
      height: 36px;
      padding: 0;
      border: none;
      background: transparent;
      font-size: 1.5rem;
      color: #666;
      cursor: pointer;
      border-radius: 6px;
    }

    .feelings-summary__close-btn:hover {
      background: #f0f0f0;
      color: #333;
    }

    .feelings-summary__close-btn:focus-visible {
      outline: 2px solid #667eea;
      outline-offset: -2px;
    }

    .feelings-summary__content {
      overflow-y: auto;
      flex: 1;
    }

    .feelings-summary__list {
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .feelings-summary__item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.6rem 0.5rem;
      border-bottom: 1px solid #f0f0f0;
    }

    .feelings-summary__item:last-child {
      border-bottom: none;
    }

    .feelings-summary__name {
      font-size: 0.9rem;
      font-weight: 500;
      color: #333;
    }

    .feelings-summary__feeling {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .feelings-summary__emoji {
      font-size: 1.2rem;
    }

    .feelings-summary__category {
      font-size: 0.8rem;
      color: #666;
    }

    .feelings-summary__no-feeling {
      font-size: 0.8rem;
      color: #999;
      font-style: italic;
    }

    .feelings-summary__footer {
      margin-top: 1rem;
      display: flex;
      justify-content: flex-end;
    }

    .feelings-summary__screenshot-btn {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.5rem 1rem;
      border: 1px solid #d0d5dd;
      background: #fff;
      border-radius: 6px;
      font-size: 0.85rem;
      font-weight: 500;
      color: #333;
      cursor: pointer;
      min-height: 36px;
    }

    .feelings-summary__screenshot-btn:hover:not(:disabled) {
      background: #f5f5f5;
    }

    .feelings-summary__screenshot-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .feelings-summary__screenshot-btn:focus-visible {
      outline: 2px solid #667eea;
      outline-offset: -2px;
    }

    .feelings-summary__spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid #ccc;
      border-top-color: #667eea;
      border-radius: 50%;
      animation: feelings-spin 0.6s linear infinite;
    }

    @keyframes feelings-spin {
      to { transform: rotate(360deg); }
    }

    @media (prefers-reduced-motion: reduce) {
      .feelings-summary__spinner {
        animation: none;
      }
    }
  `],
})
export class FeelingsSummaryPopupComponent {
  private readonly feelingsService = inject(FeelingsService);
  private readonly retroState = inject(RetroStateService);
  private readonly toastService = inject(ToastService);
  private readonly elementRef = inject(ElementRef);

  @ViewChild('popupContent') popupContent!: ElementRef<HTMLElement>;

  /** Whether the popup is open */
  readonly open = input<boolean>(false);

  /** Emitted when the popup should close */
  readonly closed = output<void>();

  /** Loading state for screenshot capture */
  readonly capturing = signal(false);

  /** Sorted list of participants with their feelings */
  readonly sortedParticipants = computed(() => {
    const participants = this.retroState.participants();
    const feelings = this.feelingsService.feelings();

    const entries = participants.map((p: User) => ({
      userId: p.id,
      displayName: p.displayName,
      feeling: feelings[p.id] ?? null,
    }));

    return entries.sort((a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    );
  });

  constructor() {
    afterNextRender(() => {
      const dialog = this.elementRef.nativeElement.querySelector('.feelings-summary__dialog');
      dialog?.focus();
    });
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.open()) {
      this.close();
    }
  }

  getEmoji(category: FeelingCategory): string {
    return FEELING_EMOJI_MAP[category] ?? '';
  }

  close(): void {
    this.closed.emit();
  }

  async captureScreenshot(): Promise<void> {
    const contentEl = this.popupContent?.nativeElement;
    if (!contentEl) return;

    this.capturing.set(true);
    try {
      const html2canvas = (await import('html2canvas')).default;

      const canvas = await html2canvas(contentEl, {
        useCORS: true,
        allowTaint: true,
        scrollX: 0,
        scrollY: 0,
        windowWidth: contentEl.scrollWidth,
        windowHeight: contentEl.scrollHeight,
        width: contentEl.scrollWidth,
        height: contentEl.scrollHeight,
      });

      const blob = await this.canvasToBlob(canvas);
      const filename = this.generateFilename();
      this.downloadBlob(blob, filename);
    } catch {
      this.toastService.show('error', 'Failed to capture screenshot');
    } finally {
      this.capturing.set(false);
    }
  }

  private canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to convert canvas to blob'));
          }
        },
        'image/png'
      );
    });
  }

  private generateFilename(): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `feelings-summary-${yyyy}-${mm}-${dd}.png`;
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }
}
