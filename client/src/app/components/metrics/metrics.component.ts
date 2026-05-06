import { Component, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SessionStateService } from '../../services/session-state.service';
import { VotingMetrics, CardValue } from '@shared/types';

/**
 * Pure function: derive display-ready metrics data from VotingMetrics.
 * Returns null if metrics are null or not yet available.
 */
export interface MetricsDisplay {
  average: string;
  mode: string;
  spread: string;
  distribution: { label: string; count: number }[];
  outlierCount: number;
  insufficientData: boolean;
}

export function deriveMetricsDisplay(metrics: VotingMetrics | null): MetricsDisplay | null {
  if (!metrics) return null;

  if (metrics.insufficientData) {
    return {
      average: '—',
      mode: '—',
      spread: '—',
      distribution: [],
      outlierCount: 0,
      insufficientData: true,
    };
  }

  const distribution = Object.entries(metrics.distribution)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  return {
    average: metrics.average !== null ? metrics.average.toFixed(1) : '—',
    mode: metrics.mode !== null ? String(metrics.mode) : '—',
    spread: metrics.spread !== null ? String(metrics.spread) : '—',
    distribution,
    outlierCount: metrics.outliers.length,
    insufficientData: false,
  };
}

@Component({
  selector: 'app-metrics',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (visible()) {
      <section class="metrics" role="region" aria-label="Voting metrics">
        @if (metricsDisplay()?.insufficientData) {
          <p class="metrics__insufficient" role="status">
            Insufficient data — fewer than 2 numeric votes
          </p>
        } @else if (metricsDisplay(); as m) {
          <div class="metrics__summary">
            <div class="metrics__stat">
              <span class="metrics__stat-label">Average</span>
              <span class="metrics__stat-value" aria-label="Average value">{{ m.average }}</span>
            </div>
            <div class="metrics__stat">
              <span class="metrics__stat-label">Mode</span>
              <span class="metrics__stat-value" aria-label="Mode value">{{ m.mode }}</span>
            </div>
            <div class="metrics__stat">
              <span class="metrics__stat-label">Spread</span>
              <span class="metrics__stat-value" aria-label="Spread value">{{ m.spread }}</span>
            </div>
            @if (m.outlierCount > 0) {
              <div class="metrics__stat metrics__stat--outlier">
                <span class="metrics__stat-label">Outliers</span>
                <span class="metrics__stat-value" aria-label="Outlier count">{{ m.outlierCount }}</span>
              </div>
            }
          </div>
          @if (m.distribution.length > 0) {
            <div class="metrics__distribution" aria-label="Vote distribution">
              <h3 class="metrics__distribution-title">Distribution</h3>
              <ul class="metrics__distribution-list">
                @for (entry of m.distribution; track entry.label) {
                  <li class="metrics__distribution-item">
                    <span class="metrics__distribution-label">{{ entry.label }}</span>
                    <span class="metrics__distribution-bar" [style.width.%]="getBarWidth(entry.count)" aria-hidden="true"></span>
                    <span class="metrics__distribution-count">{{ entry.count }}</span>
                  </li>
                }
              </ul>
            </div>
          }
        }
      </section>
    }
  `,
  styles: [
    `
      .metrics {
        padding: 0.5rem 0;
      }

      .metrics__insufficient {
        color: #595959;
        font-style: italic;
        padding: 0.5rem 0;
      }

      .metrics__summary {
        display: flex;
        gap: 1rem;
        flex-wrap: wrap;
        margin-bottom: 0.75rem;
      }

      .metrics__stat {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 0.5rem 0.75rem;
        background: #f5f5f5;
        border-radius: 8px;
        min-width: 70px;
      }

      .metrics__stat--outlier {
        background: #fff3e0;
        border: 1px solid #f57c00;
      }

      .metrics__stat-label {
        font-size: 0.8rem;
        color: #595959;
        font-weight: 600;
        text-transform: uppercase;
      }

      .metrics__stat-value {
        font-size: 1.25rem;
        font-weight: 700;
        color: #333;
      }

      .metrics__distribution {
        margin-top: 0.5rem;
      }

      .metrics__distribution-title {
        font-size: 0.8rem;
        font-weight: 600;
        margin: 0 0 0.375rem;
      }

      .metrics__distribution-list {
        list-style: none;
        padding: 0;
        margin: 0;
      }

      .metrics__distribution-item {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.25rem 0;
      }

      .metrics__distribution-label {
        min-width: 50px;
        font-weight: 600;
        font-size: 0.8rem;
      }

      .metrics__distribution-bar {
        height: 16px;
        background: #1976d2;
        border-radius: 4px;
        min-width: 4px;
        transition: width 0.3s ease;
      }

      .metrics__distribution-count {
        font-size: 0.85rem;
        color: #595959;
      }
    `,
  ],
})
export class MetricsComponent {
  private readonly sessionState = inject(SessionStateService);

  readonly visible = computed(() => {
    return this.sessionState.isRevealed() && this.sessionState.metrics() !== null;
  });

  readonly metricsDisplay = computed(() => {
    return deriveMetricsDisplay(this.sessionState.metrics());
  });

  private readonly maxCount = computed(() => {
    const display = this.metricsDisplay();
    if (!display || display.distribution.length === 0) return 1;
    return Math.max(...display.distribution.map((d) => d.count), 1);
  });

  getBarWidth(count: number): number {
    return (count / this.maxCount()) * 100;
  }
}
