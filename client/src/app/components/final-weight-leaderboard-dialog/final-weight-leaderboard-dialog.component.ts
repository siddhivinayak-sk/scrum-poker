import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { computeStandings, type Standing } from '@shared/final-weight';
import { SessionStateService } from '../../services/session-state.service';

/** One ranked row the template renders, with a 1-based rank and the "most accurate" flag. */
interface LeaderboardRow {
  readonly rank: number;
  readonly userId: string;
  readonly name: string;
  readonly rounds: number;
  readonly avgDistance: number;
  readonly warmingUp: boolean;
  readonly isTopRanked: boolean;
  readonly isSelf: boolean;
}

const FOCUSABLE =
  'button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]';

/**
 * Accuracy leaderboard dialog (Final Weight feature).
 *
 * Opened from the header trophy icon. Lists every voter ranked from most accurate (smallest
 * average distance to the final weight across the session) to least, so a team can see who has
 * guessed closest so far. Voters with fewer than two scored rounds are shown separately as
 * "warming up" and are not ranked.
 *
 * The ranking reuses the shared `computeStandings`, the same source the balloon's inline
 * standings use, so the two always agree. All text is Angular interpolation, never HTML, so
 * voter names are escaped.
 */
@Component({
  selector: 'app-final-weight-leaderboard-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div class="fwlb__backdrop" aria-hidden="true" (click)="close()"></div>
      <div
        class="fwlb"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fwlb-title"
        aria-describedby="fwlb-desc"
        tabindex="-1"
        (keydown)="onKeydown($event)"
      >
        <button type="button" class="fwlb__close" aria-label="Close accuracy leaderboard" (click)="close()">
          &times;
        </button>

        <h2 id="fwlb-title" class="fwlb__title">
          <span aria-hidden="true">{{ trophy }}</span> Accuracy leaderboard
        </h2>
        <p id="fwlb-desc" class="fwlb__desc">
          Who has estimated closest to the final weight so far. Lower average distance is better.
        </p>

        @if (ranked().length === 0 && warmingUp().length === 0) {
          <p class="fwlb__empty">
            No scored rounds yet. Set a final weight on a revealed round to start the ranking.
          </p>
        } @else {
          @if (ranked().length > 0) {
            <ol class="fwlb__list" aria-label="Ranked voters, most accurate first">
              @for (row of ranked(); track row.userId) {
                <li
                  class="fwlb__row"
                  [class.fwlb__row--top]="row.isTopRanked"
                  [class.fwlb__row--self]="row.isSelf"
                >
                  <span class="fwlb__rank" aria-hidden="true">
                    {{ medal(row.rank) }}
                  </span>
                  <span class="fwlb__name">
                    {{ row.name }}
                    @if (row.isSelf) {<span class="fwlb__you">(you)</span>}
                  </span>
                  <span class="fwlb__score">
                    <span class="fwlb__avg">{{ row.avgDistance.toFixed(2) }}</span>
                    <span class="fwlb__unit">avg steps</span>
                    <span class="fwlb__rounds">{{ row.rounds }} {{ row.rounds === 1 ? 'round' : 'rounds' }}</span>
                  </span>
                </li>
              }
            </ol>
          }

          @if (warmingUp().length > 0) {
            <h3 class="fwlb__subtitle">Warming up</h3>
            <p class="fwlb__hint">Need at least 2 scored rounds to be ranked.</p>
            <ul class="fwlb__list fwlb__list--plain" aria-label="Voters still warming up">
              @for (row of warmingUp(); track row.userId) {
                <li class="fwlb__row fwlb__row--warming" [class.fwlb__row--self]="row.isSelf">
                  <span class="fwlb__rank" aria-hidden="true">{{ bullet }}</span>
                  <span class="fwlb__name">
                    {{ row.name }}
                    @if (row.isSelf) {<span class="fwlb__you">(you)</span>}
                  </span>
                  <span class="fwlb__score">
                    <span class="fwlb__rounds">{{ row.rounds }} {{ row.rounds === 1 ? 'round' : 'rounds' }}</span>
                  </span>
                </li>
              }
            </ul>
          }
        }

        <div class="fwlb__footer">
          <button type="button" class="fwlb__btn" (click)="close()">Close</button>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .fwlb__backdrop {
        position: fixed;
        inset: 0;
        background: var(--scrim-dialog, rgba(0, 0, 0, 0.45));
        z-index: 1000;
      }

      .fwlb {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: min(460px, calc(100vw - 2rem));
        max-height: calc(100vh - 2rem);
        overflow-y: auto;
        box-sizing: border-box;
        padding: 1.5rem;
        background: var(--surface-elevated, #fff);
        color: var(--text-primary, #1a1a2e);
        border-radius: 12px;
        box-shadow: var(--shadow-lg, 0 10px 30px rgba(0, 0, 0, 0.3));
        z-index: 1001;
        animation: fwlb-in 180ms ease-out;
      }

      @media (prefers-reduced-motion: reduce) {
        .fwlb {
          animation: none;
        }
      }

      .fwlb:focus {
        outline: none;
      }

      .fwlb__close {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 32px;
        height: 32px;
        padding: 0;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font-size: 1.4rem;
        line-height: 1;
        cursor: pointer;
      }

      .fwlb__title {
        margin: 0 0 0.25rem;
        font-size: 1.15rem;
        font-weight: 700;
      }

      .fwlb__desc {
        margin: 0 0 1rem;
        font-size: 0.85rem;
        color: var(--text-secondary, #5a5a6e);
      }

      .fwlb__empty {
        margin: 1rem 0;
        font-size: 0.9rem;
        color: var(--text-secondary, #5a5a6e);
      }

      .fwlb__subtitle {
        margin: 1.25rem 0 0.1rem;
        font-size: 0.95rem;
        font-weight: 700;
      }

      .fwlb__hint {
        margin: 0 0 0.5rem;
        font-size: 0.78rem;
        color: var(--text-secondary, #5a5a6e);
      }

      .fwlb__list {
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .fwlb__row {
        display: grid;
        grid-template-columns: 2.2rem 1fr auto;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.6rem;
        border-radius: 8px;
        border: 1px solid transparent;
      }

      .fwlb__row + .fwlb__row {
        margin-top: 4px;
      }

      .fwlb__row--top {
        background: var(--surface-card-selected, rgba(27, 63, 168, 0.08));
        border-color: var(--color-primary-light, #7a95e8);
      }

      .fwlb__row--self {
        border-color: var(--color-primary, #1b3fa8);
      }

      .fwlb__rank {
        font-size: 1.1rem;
        font-weight: 700;
        text-align: center;
      }

      .fwlb__name {
        font-weight: 600;
        overflow-wrap: anywhere;
      }

      .fwlb__you {
        margin-left: 0.3rem;
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--text-secondary, #5a5a6e);
      }

      .fwlb__score {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        line-height: 1.2;
        text-align: right;
      }

      .fwlb__avg {
        font-size: 1rem;
        font-weight: 700;
      }

      .fwlb__unit {
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-secondary, #5a5a6e);
      }

      .fwlb__rounds {
        font-size: 0.75rem;
        color: var(--text-secondary, #5a5a6e);
      }

      .fwlb__footer {
        display: flex;
        justify-content: flex-end;
        margin-top: 1.25rem;
      }

      .fwlb__btn {
        min-height: 36px;
        padding: 0.5rem 1.1rem;
        border: 1px solid var(--wash-neutral-strong, #cdd3e3);
        border-radius: 6px;
        background: var(--color-primary-dark, #1b3fa8);
        color: var(--text-on-primary, #fff);
        font-size: 0.85rem;
        font-weight: 600;
        cursor: pointer;
      }

      .fwlb__close:focus-visible,
      .fwlb__btn:focus-visible {
        outline: 2px solid var(--color-primary, #1b3fa8);
        outline-offset: 2px;
      }

      @keyframes fwlb-in {
        from {
          opacity: 0;
          transform: translate(-50%, calc(-50% + 8px));
        }
        to {
          opacity: 1;
          transform: translate(-50%, -50%);
        }
      }
    `,
  ],
})
export class FinalWeightLeaderboardDialogComponent {
  private readonly state = inject(SessionStateService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  private readonly _open = signal(false);
  /** True while the dialog is shown. */
  readonly open = this._open.asReadonly();

  private returnFocusTo: HTMLElement | null = null;

  /** Standings recomputed from history while open; the shared sort already puts the most accurate first. */
  private readonly standings = computed<readonly Standing[]>(() =>
    this._open() ? computeStandings(this.state.history()) : [],
  );

  private readonly rows = computed<readonly LeaderboardRow[]>(() => {
    const selfId = this.state.currentUser()?.id ?? null;
    const standings = this.standings();
    const bestAvg = standings.find((s) => !s.warmingUp)?.avgDistance ?? null;
    let rank = 0;
    return standings.map((s) => {
      if (!s.warmingUp) rank += 1;
      return {
        rank,
        userId: s.userId,
        name: s.name,
        rounds: s.rounds,
        avgDistance: s.avgDistance,
        warmingUp: s.warmingUp,
        isTopRanked: !s.warmingUp && bestAvg !== null && s.avgDistance === bestAvg,
        isSelf: s.userId === selfId,
      };
    });
  });

  readonly ranked = computed(() => this.rows().filter((r) => !r.warmingUp));
  readonly warmingUp = computed(() => this.rows().filter((r) => r.warmingUp));

  constructor() {
    // The leaderboard is a Final Weight surface: if the setting is turned off, close it.
    effect(() => {
      const enabled = this.state.finalWeightEnabled();
      if (!enabled && untracked(() => this._open())) {
        untracked(() => this.close());
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.returnFocusTo = null;
    });
  }

  /** Opens the dialog and remembers the trigger so focus can return to it on close. */
  show(): void {
    if (this._open()) return;
    const active = document.activeElement;
    this.returnFocusTo = active instanceof HTMLElement ? active : null;
    this._open.set(true);
    afterNextRender(() => this.focusInitial(), { injector: this.injector });
  }

  close(): void {
    if (!this._open()) return;
    this._open.set(false);
    const el = this.returnFocusTo;
    this.returnFocusTo = null;
    if (el && el.isConnected) el.focus();
  }

  /** Glyphs via code points so the source file carries no raw emoji bytes. */
  readonly trophy = '\u{1F3C6}';
  readonly bullet = '\u00B7';

  medal(rank: number): string {
    switch (rank) {
      case 1:
        return '\u{1F947}'; // gold medal
      case 2:
        return '\u{1F948}'; // silver medal
      case 3:
        return '\u{1F949}'; // bronze medal
      default:
        return String(rank);
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this._open()) this.close();
  }

  /** Keeps Tab / Shift+Tab inside the dialog. */
  onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget as HTMLElement;
    const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private focusInitial(): void {
    const root = this.host.nativeElement;
    const target =
      root.querySelector<HTMLElement>('.fwlb__btn') ??
      root.querySelector<HTMLElement>('.fwlb');
    target?.focus();
  }
}