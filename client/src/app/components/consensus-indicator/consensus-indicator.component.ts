import { Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  VotingMetrics,
  VotingSystemType,
  ConsensusLevel,
  computeConsensusLevel,
} from '@shared/types';

@Component({
  selector: 'app-consensus-indicator',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (consensusLevel() !== 'none') {
      <div class="consensus-indicator" [class]="'consensus-indicator--' + consensusLevel()" role="status" [attr.aria-label]="ariaLabel()">
        <span class="consensus-indicator__icon" aria-hidden="true">{{ icon() }}</span>
        <span class="consensus-indicator__label">{{ label() }}</span>
      </div>
    }
  `,
  styles: [
    `
      .consensus-indicator {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.375rem 0.75rem;
        border-radius: 6px;
        font-size: 0.875rem;
        font-weight: 600;
      }

      .consensus-indicator--full {
        background: #e6f4ea;
        color: #1e7e34;
        border: 1px solid #a3d9a5;
      }

      .consensus-indicator--partial {
        background: #fff8e1;
        color: #f9a825;
        border: 1px solid #ffe082;
      }

      .consensus-indicator--high-divergence {
        background: #fbe9e7;
        color: #d32f2f;
        border: 1px solid #ef9a9a;
      }

      .consensus-indicator__icon {
        font-size: 1rem;
      }

      .consensus-indicator__label {
        white-space: nowrap;
      }
    `,
  ],
})
export class ConsensusIndicatorComponent {
  readonly metrics = input<VotingMetrics | null>(null);
  readonly votingSystem = input<VotingSystemType>('fibonacci');

  readonly consensusLevel = computed<ConsensusLevel>(() => {
    return computeConsensusLevel(this.metrics(), this.votingSystem());
  });

  readonly icon = computed<string>(() => {
    switch (this.consensusLevel()) {
      case 'full':
        return '✓';
      case 'partial':
        return '~';
      case 'high-divergence':
        return '⚠';
      default:
        return '';
    }
  });

  readonly label = computed<string>(() => {
    switch (this.consensusLevel()) {
      case 'full':
        return 'Full Agreement';
      case 'partial':
        return 'Partial Agreement';
      case 'high-divergence':
        return 'High Divergence';
      default:
        return '';
    }
  });

  readonly ariaLabel = computed<string>(() => {
    switch (this.consensusLevel()) {
      case 'full':
        return 'Consensus: Full Agreement';
      case 'partial':
        return 'Consensus: Partial Agreement';
      case 'high-divergence':
        return 'Consensus: High Divergence';
      default:
        return '';
    }
  });
}
