import {
  Component,
  input,
  output,
  signal,
  effect,
  OnDestroy,
} from '@angular/core';

@Component({
  selector: 'app-countdown-overlay',
  standalone: true,
  template: `
    @if (active() && !done()) {
      <div class="overlay" role="status" aria-live="assertive" aria-atomic="true">
        <span class="countdown-number" [class.animate]="!prefersReducedMotion">
          {{ currentNumber() }}
        </span>
      </div>
    }
  `,
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.6);
      }

      .countdown-number {
        font-size: 6rem;
        font-weight: 700;
        color: #fff;
        user-select: none;
      }

      .countdown-number.animate {
        animation: pulse 1s ease-in-out;
      }

      @keyframes pulse {
        0% {
          transform: scale(0.5);
          opacity: 0;
        }
        30% {
          transform: scale(1.2);
          opacity: 1;
        }
        100% {
          transform: scale(1);
          opacity: 1;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .countdown-number.animate {
          animation: none;
        }
      }
    `,
  ],
})
export class CountdownOverlayComponent implements OnDestroy {
  readonly active = input<boolean>(false);
  readonly onComplete = output<void>();

  readonly currentNumber = signal<number>(3);
  readonly done = signal<boolean>(false);

  readonly prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor() {
    effect(() => {
      const isActive = this.active();

      if (isActive) {
        this.startCountdown();
      } else {
        this.reset();
      }
    });
  }

  ngOnDestroy(): void {
    this.clearTimers();
  }

  private startCountdown(): void {
    this.clearTimers();
    this.done.set(false);
    this.currentNumber.set(3);

    // 3 -> 2 after 1s
    this.timers.push(
      setTimeout(() => {
        this.currentNumber.set(2);
      }, 1000)
    );

    // 2 -> 1 after 2s
    this.timers.push(
      setTimeout(() => {
        this.currentNumber.set(1);
      }, 2000)
    );

    // Complete after 3s
    this.timers.push(
      setTimeout(() => {
        this.done.set(true);
        this.onComplete.emit();
      }, 3000)
    );
  }

  private reset(): void {
    this.clearTimers();
    this.currentNumber.set(3);
    this.done.set(false);
  }

  private clearTimers(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];
  }
}
