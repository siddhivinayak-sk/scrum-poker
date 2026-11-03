import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { SessionStateService } from '../../services/session-state.service';

/**
 * Header icon that opens the accuracy leaderboard (Final Weight feature).
 *
 * Rendered only while the setting is on. The page owns the dialog instance and opens it from the
 * `openLeaderboard` output, so this button stays a thin, testable trigger. It is always enabled
 * when visible: the dialog itself handles the empty "no scored rounds yet" case.
 */
@Component({
  selector: 'app-final-weight-leaderboard-button',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <button
        type="button"
        class="fwlb-btn"
        aria-label="Accuracy leaderboard"
        title="Accuracy leaderboard: who estimates closest"
        (click)="openLeaderboard.emit()"
      >
        <span aria-hidden="true">{{ trophy }}</span>
      </button>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }

      /* Same footprint as the export / final-weight buttons, so the header does not shift. */
      .fwlb-btn {
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

      .fwlb-btn:hover {
        background: rgba(255, 255, 255, 0.25);
        box-shadow: var(--shadow-sm);
      }

      .fwlb-btn:active {
        transform: scale(0.97);
      }

      .fwlb-btn:focus-visible {
        outline: 2px solid var(--text-on-primary);
        outline-offset: 2px;
      }

      @media (prefers-reduced-motion: reduce) {
        .fwlb-btn {
          transition: none;
        }
      }
    `,
  ],
})
export class FinalWeightLeaderboardButtonComponent {
  private readonly state = inject(SessionStateService);

  /** Emitted when the user asks to see the leaderboard. */
  readonly openLeaderboard = output<void>();

  /** Trophy glyph via code point so the source file carries no raw emoji bytes. */
  readonly trophy = '\u{1F3C6}';

  readonly visible = computed(() => this.state.finalWeightEnabled());
}