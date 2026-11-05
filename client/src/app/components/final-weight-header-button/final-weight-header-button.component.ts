import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { buildFinalWeightOptions, votesFromRound } from '@shared/final-weight';
import { SessionStateService } from '../../services/session-state.service';
import type { FinalWeightEditTarget } from '../final-weight-dialog/final-weight-dialog.component';

/** Minimal surface of the balloon this button needs (`FinalWeightBalloonComponent`). */
export interface FinalWeightBalloonHandle {
  reopen(): void;
}

const MODERATOR_EDIT_TITLE = 'Set or change the final weight';
const REOPEN_TITLE = 'Show the latest accuracy result';
const NOTHING_TITLE_MODERATOR = 'Nothing to show yet: reveal a round to set a final weight';
const NOTHING_TITLE_PARTICIPANT = 'Nothing to show yet: the moderator has not set a final weight';

/**
 * Header icon for the Final Weight feature (R8).
 * - Weight moderator with a revealed round (or, after Clear, a newest history entry): asks the page
 *   to open the dialog in edit mode via `edit`.
 * - Everyone else, or when a result exists and nothing can be edited: reopens the balloon.
 * - Nothing to show: disabled with a tooltip that says why.
 * Rendered only while the setting is on.
 */
@Component({
  selector: 'app-final-weight-header-button',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <button
        type="button"
        class="fw-header-btn"
        aria-label="Final weight and accuracy"
        [attr.title]="tooltip()"
        [disabled]="!enabled()"
        (click)="activate()"
      >
        <span aria-hidden="true">🎯</span>
      </button>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }

      /* Same footprint as the export button, so the header does not shift on narrow screens. */
      .fw-header-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 32px;
        min-height: 32px;
        padding: 0.25rem 0.5rem;
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.15);
        color: var(--text-on-primary);
        font-size: 1rem;
        line-height: 1;
        cursor: pointer;
        transition: background-color 200ms ease, box-shadow 200ms ease, transform 100ms ease;
      }

      .fw-header-btn:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.25);
        box-shadow: var(--shadow-sm);
      }

      .fw-header-btn:active:not(:disabled) {
        transform: scale(0.97);
      }

      .fw-header-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .fw-header-btn:focus-visible {
        outline: 2px solid var(--text-on-primary);
        outline-offset: 2px;
      }

      @media (prefers-reduced-motion: reduce) {
        .fw-header-btn {
          transition: none;
        }
      }
    `,
  ],
})
export class FinalWeightHeaderButtonComponent {
  private readonly state = inject(SessionStateService);

  /** The balloon to reopen (template reference to `<app-final-weight-balloon>`). */
  readonly balloon = input<FinalWeightBalloonHandle | null>(null);
  /** Moderator pressed the icon: open the dialog in edit mode for this target. */
  readonly edit = output<FinalWeightEditTarget>();

  private readonly isModerator = computed(() => this.state.currentUser()?.role === 'moderator');

  /** Edit target for the revealed round, else the newest history entry; null when none (R8.2, R8.4). */
  readonly editTarget = computed<FinalWeightEditTarget | null>(() => {
    if (!this.state.finalWeightEnabled() || !this.isModerator()) return null;
    const config = this.state.sessionConfig();
    if (!config) return null;

    const round = this.state.currentRound();
    if (round && this.state.isRevealed()) {
      const votes = votesFromRound(this.state.selections(), this.state.participants());
      const { options, ladder } = buildFinalWeightOptions(votes, config.votingSystem);
      return { roundId: round.id, options, ladder, current: round.finalWeight ?? null };
    }

    const entry = this.state.history()[0];
    if (!round && entry) {
      // The weight is scored on the system stored with it, else the current one.
      const system = entry.finalWeight?.votingSystem ?? config.votingSystem;
      const { options, ladder } = buildFinalWeightOptions(entry.participants, system);
      return { roundId: entry.roundId, options, ladder, current: entry.finalWeight ?? null };
    }
    return null;
  });

  private readonly hasResult = computed(() => this.state.latestAccuracy() !== null);

  readonly visible = computed(() => this.state.finalWeightEnabled());
  readonly enabled = computed(() => this.editTarget() !== null || this.hasResult());

  readonly tooltip = computed(() => {
    if (this.editTarget() !== null) return MODERATOR_EDIT_TITLE;
    if (this.hasResult()) return REOPEN_TITLE;
    return this.isModerator() ? NOTHING_TITLE_MODERATOR : NOTHING_TITLE_PARTICIPANT;
  });

  activate(): void {
    if (!this.visible()) return;
    const target = this.editTarget();
    if (target) {
      this.edit.emit(target);
      return;
    }
    if (this.hasResult()) this.balloon()?.reopen();
  }
}
