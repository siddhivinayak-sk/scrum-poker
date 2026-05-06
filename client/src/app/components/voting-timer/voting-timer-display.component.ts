import { Component, input, signal, OnDestroy, effect } from '@angular/core';
import { formatDuration } from '@shared/types';

@Component({
  selector: 'app-voting-timer-display',
  standalone: true,
  template: `
    <div class="timer-display" aria-label="Voting timer" role="timer">
      {{ display() }}
    </div>
  `,
  styles: [
    `
      .timer-display {
        font-family: 'Courier New', Courier, monospace;
        font-size: 1rem;
        font-weight: 600;
        color: var(--text-primary);
        padding: 0.25rem 0.5rem;
        border-radius: 8px;
        background: var(--surface-metrics);
        box-shadow: var(--shadow-sm);
        display: inline-block;
        min-width: 4.5rem;
        text-align: center;
        letter-spacing: 0.05em;
      }
    `,
  ],
})
export class VotingTimerDisplayComponent implements OnDestroy {
  readonly startedAt = input<string | null>(null);
  readonly revealedAt = input<string | null>(null);

  readonly display = signal<string>('00:00');

  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    effect(() => {
      const started = this.startedAt();
      const revealed = this.revealedAt();

      this.clearInterval();

      if (!started) {
        // Both null — reset display
        this.display.set('00:00');
        return;
      }

      if (revealed) {
        // Round is revealed — show final elapsed time
        const elapsed = new Date(revealed).getTime() - new Date(started).getTime();
        this.display.set(formatDuration(Math.max(0, elapsed)));
        return;
      }

      // Round is active — start ticking
      const startTime = new Date(started).getTime();
      this.updateElapsed(startTime);
      this.intervalId = setInterval(() => {
        this.updateElapsed(startTime);
      }, 1000);
    });
  }

  ngOnDestroy(): void {
    this.clearInterval();
  }

  private updateElapsed(startTime: number): void {
    const elapsed = Date.now() - startTime;
    this.display.set(formatDuration(Math.max(0, elapsed)));
  }

  private clearInterval(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
