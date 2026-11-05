import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  ALL_EXACT_LINES,
  CLOSEST_LINES,
  CLOSEST_TITLES,
  FURTHEST_LINES,
  FURTHEST_TITLES,
  bandFor,
  fillCopy,
  pickCopy,
} from '@shared/final-weight-copy';
import { computeStandings } from '@shared/final-weight';
import type { Standing, VoterDistance } from '@shared/final-weight';
import { SessionStateService } from '../../services/session-state.service';
import { BoardOverlayLayoutService } from '../../services/board-overlay-layout.service';

/** How long the balloon stays before it auto-dismisses (R7.3). */
export const FINAL_WEIGHT_BALLOON_AUTO_DISMISS_MS = 20000;
/** Most names listed in one block before "and N more" (R9.5). */
export const FINAL_WEIGHT_MAX_NAMES = 3;

/** One result block (closest or furthest) ready to render as plain text. */
interface ResultBlock {
  readonly title: string;
  readonly line: string;
}

/**
 * Result balloon for the Final Weight feature, shown to every participant.
 *
 * Pops up when `SessionStateService.accuracyAnnounced$` emits and can be reopened with
 * `reopen()` (header icon) from the latest restored result. All text is rendered with Angular
 * interpolation, never as HTML, so voter names are escaped (R9.9).
 *
 * Placement: top centre, under the board header. The bottom-left corner belongs to the
 * vote-callout layer (z 900) and the moderator note balloons (z 905), and the bottom-right to the
 * chat launcher (z 910) and panel (z 920). This balloon uses z 906, above the callouts and notes
 * and below the chat, history backdrop (999) and dialogs (1000), and its height is capped so it
 * never reaches the bottom corners (R7.9).
 */
@Component({
  selector: 'app-final-weight-balloon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'onEscape($event)' },
  template: `
    @if (shown(); as view) {
      <div
        class="fw-balloon"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label="Final weight and accuracy"
        [style.top.px]="topPx()"
        (pointerenter)="pause()"
        (pointerleave)="resume()"
        (focusin)="pause()"
        (focusout)="resume()"
      >
        <button
          type="button"
          class="fw-balloon__close"
          aria-label="Close final weight result"
          (click)="dismiss()"
        >
          &times;
        </button>

        <p class="fw-balloon__weight">
          <span aria-hidden="true">🎯</span>
          Final weight: <strong class="fw-balloon__value">{{ view.weight }}</strong>
        </p>

        @if (view.neutral) {
          <p class="fw-balloon__line">{{ view.neutral }}</p>
        } @else if (view.allExact) {
          <p class="fw-balloon__title">Hive mind!</p>
          <p class="fw-balloon__line">{{ view.allExact }}</p>
        } @else {
          @if (view.closest; as closest) {
            <section class="fw-balloon__block">
              <p class="fw-balloon__title">
                <span aria-hidden="true">🏹</span> {{ closest.title }}
              </p>
              <p class="fw-balloon__line">{{ closest.line }}</p>
            </section>
          }
          @if (view.furthest; as furthest) {
            <section class="fw-balloon__block fw-balloon__block--fun">
              <p class="fw-balloon__label">Just for fun</p>
              <p class="fw-balloon__title">
                <span aria-hidden="true">🧭</span> {{ furthest.title }}
              </p>
              <p class="fw-balloon__line">{{ furthest.line }}</p>
            </section>
          }
        }

        <button
          type="button"
          class="fw-balloon__toggle"
          [attr.aria-expanded]="standingsOpen()"
          aria-controls="fw-balloon-standings"
          (click)="toggleStandings()"
        >
          Session standings
        </button>
        @if (standingsOpen()) {
          <div id="fw-balloon-standings" class="fw-balloon__standings">
            @if (standings().length === 0) {
              <p class="fw-balloon__line">No scored rounds yet.</p>
            } @else {
              <ol class="fw-balloon__list">
                @for (row of standings(); track row.userId) {
                  <li class="fw-balloon__row">
                    <span class="fw-balloon__name">{{ row.name }}</span>
                    <span class="fw-balloon__score">
                      @if (row.warmingUp) {
                        warming up
                      } @else {
                        avg {{ row.avgDistance.toFixed(1) }} steps
                      }
                      ({{ row.rounds }} {{ row.rounds === 1 ? 'round' : 'rounds' }})
                    </span>
                  </li>
                }
              </ol>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }

      /* top is bound from BoardOverlayLayoutService header measurement */
      .fw-balloon {
        position: fixed;
        left: 50%;
        transform: translateX(-50%);
        z-index: 906; /* above callouts (900) and notes (905); below chat (910/920), dialogs (1000) */
        box-sizing: border-box;
        width: min(420px, calc(100vw - 32px));
        max-height: min(60vh, calc(100vh - 160px));
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 14px 40px 14px 16px;
        border-radius: 12px;
        border: 1px solid var(--color-primary-dark, #1b3fa8);
        background: var(--surface-elevated, #ffffff);
        color: var(--text-primary, #1a1a2e);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
        animation: fw-balloon-in 220ms ease-out;
      }

      @media (prefers-reduced-motion: reduce) {
        .fw-balloon {
          animation: none;
        }
      }

      .fw-balloon p {
        margin: 0;
      }

      .fw-balloon__close {
        position: absolute;
        top: 6px;
        right: 6px;
        width: 28px;
        height: 28px;
        padding: 0;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font-size: 1.3rem;
        line-height: 1;
        cursor: pointer;
      }

      .fw-balloon__weight {
        font-size: 1rem;
        font-weight: 700;
        margin-bottom: 8px;
      }

      .fw-balloon__value {
        font-size: 1.25rem;
      }

      .fw-balloon__block {
        margin-bottom: 10px;
      }

      .fw-balloon__block--fun {
        padding-top: 8px;
        border-top: 1px dashed var(--text-secondary, #5a5a6e);
      }

      .fw-balloon__label {
        font-size: 0.7rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--text-secondary, #5a5a6e);
      }

      .fw-balloon__title {
        font-size: 0.9rem;
        font-weight: 700;
        margin-bottom: 2px;
      }

      .fw-balloon__line {
        font-size: 0.9rem;
        line-height: 1.4;
        overflow-wrap: anywhere;
      }

      .fw-balloon__toggle {
        margin-top: 4px;
        min-height: 32px;
        padding: 0 4px;
        border: none;
        background: transparent;
        color: var(--color-primary-dark, #1b3fa8);
        font: inherit;
        font-size: 0.85rem;
        font-weight: 600;
        text-decoration: underline;
        cursor: pointer;
      }

      .fw-balloon__list {
        margin: 6px 0 0;
        padding: 0 0 0 20px;
      }

      .fw-balloon__row {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        font-size: 0.85rem;
        padding: 2px 0;
      }

      .fw-balloon__name {
        overflow-wrap: anywhere;
        font-weight: 600;
      }

      .fw-balloon__score {
        flex: none;
        color: var(--text-secondary, #5a5a6e);
      }

      .fw-balloon__close:focus-visible,
      .fw-balloon__toggle:focus-visible {
        outline: 2px solid var(--color-primary-dark, #1b3fa8);
        outline-offset: 2px;
      }

      @keyframes fw-balloon-in {
        from {
          opacity: 0;
          margin-top: -8px;
        }
        to {
          opacity: 1;
          margin-top: 0;
        }
      }
    `,
  ],
})
export class FinalWeightBalloonComponent {
  private readonly sessionState = inject(SessionStateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly layout = inject(BoardOverlayLayoutService);

  /** Emits when the balloon closes (button, Esc or auto-dismiss). */
  readonly closed = output<void>();

  private readonly _visible = signal(false);
  protected readonly standingsOpen = signal(false);

  /** Visible state for hosts that want to know (read only). */
  readonly visible = this._visible.asReadonly();

  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Distance from the viewport top: just under the header, with a fallback when untracked. */
  protected readonly topPx = computed(() => {
    const header = this.layout.headerBottomPx();
    return header > 0 ? header + 12 : 72;
  });

  protected readonly standings = computed<readonly Standing[]>(() =>
    this._visible() ? computeStandings(this.sessionState.history()) : []
  );

  /** The view model; null hides the balloon (setting off, no result, or dismissed). */
  protected readonly shown = computed(() => {
    if (!this._visible() || !this.sessionState.finalWeightEnabled()) return null;
    const data = this.sessionState.latestAccuracy();
    if (data === null) return null;

    const { roundId, record, result } = data;
    const weight = String(result.finalWeight);
    const byId = new Map<string, VoterDistance>(result.voters.map((v) => [v.userId, v]));
    const pick = (ids: readonly string[]): VoterDistance[] =>
      ids.map((id) => byId.get(id)).filter((v): v is VoterDistance => v !== undefined);

    if (!result.comparable) {
      return {
        weight,
        neutral: 'Not enough comparable votes for an accuracy result this round.',
        allExact: '',
        closest: null,
        furthest: null,
      };
    }
    if (result.allExact) {
      const line = pickCopy(ALL_EXACT_LINES, roundId, 0);
      return {
        weight,
        neutral: '',
        allExact: fillCopy(line, { name: '', card: weight }),
        closest: null,
        furthest: null,
      };
    }

    const closestVoters = pick(result.closestIds);
    const closest = this.block(
      closestVoters,
      roundId,
      CLOSEST_TITLES,
      (distance) => CLOSEST_LINES[distance === 0 ? 'exact' : bandFor(distance)]
    );
    const furthestVoters = record.showFunniest ? pick(result.furthestIds) : [];
    const furthest = this.block(
      furthestVoters,
      roundId,
      FURTHEST_TITLES,
      (distance) => FURTHEST_LINES[bandFor(distance)]
    );

    return { weight, neutral: '', allExact: '', closest, furthest };
  });

  constructor() {
    this.sessionState.accuracyAnnounced$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.show());

    this.destroyRef.onDestroy(() => this.clearTimer());
  }

  /** Opens the balloon with the latest result (header icon). No-op when there is none. */
  reopen(): void {
    if (this.sessionState.latestAccuracy() === null || !this.sessionState.finalWeightEnabled()) {
      return;
    }
    this.show();
  }

  protected dismiss(): void {
    if (!this._visible()) return;
    this.clearTimer();
    this._visible.set(false);
    this.closed.emit();
  }

  protected toggleStandings(): void {
    this.standingsOpen.update((open) => !open);
  }

  protected pause(): void {
    this.clearTimer();
  }

  protected resume(): void {
    if (this._visible()) this.startTimer();
  }

  protected onEscape(event: Event): void {
    if (!this._visible() || event.defaultPrevented) return;
    // Leave Escape to an open modal dialog (final weight dialog, narrow chat).
    const doc = (event.target as Node | null)?.ownerDocument;
    if (doc?.querySelector('[aria-modal="true"]')) return;
    this.dismiss();
  }

  private show(): void {
    this._visible.set(true);
    this.startTimer();
  }

  private startTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.dismiss(), FINAL_WEIGHT_BALLOON_AUTO_DISMISS_MS);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Builds a titled, plain-text block for a group of tied voters; null when the group is empty. */
  private block(
    voters: readonly VoterDistance[],
    roundId: string,
    titles: readonly string[],
    poolFor: (distance: number) => readonly string[]
  ): ResultBlock | null {
    if (voters.length === 0) return null;
    const distance = voters[0].distance;
    const shownNames = voters.slice(0, FINAL_WEIGHT_MAX_NAMES).map((v) => v.name);
    const extra = voters.length - shownNames.length;
    const name = extra > 0 ? `${shownNames.join(', ')} and ${extra} more` : shownNames.join(', ');
    const card = [...new Set(voters.map((v) => String(v.card)))].join(' / ');
    return {
      title: pickCopy(titles, roundId, 1),
      line: fillCopy(pickCopy(poolFor(distance), roundId, 2), { name, card }),
    };
  }
}
