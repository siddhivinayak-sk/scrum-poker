import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { CalloutNoteAddedPayload } from '@shared/types';
import { SessionStateService } from '../../services/session-state.service';

/** How long a single balloon stays on screen before it auto-dismisses. */
export const BALLOON_AUTO_DISMISS_MS = 9000;
/** Most balloons shown at once; older ones beyond this drop off the top. */
export const MAX_BALLOONS = 4;

/** One moderator-facing balloon: a note a participant attached to the current round. */
export interface ModeratorNoteBalloon {
  /** Stable key for the @for track; the note id. */
  readonly id: string;
  readonly authorName: string;
  readonly text: string;
}

/**
 * Floating balloon shown to the moderator (anyone with reveal permission) when a participant who
 * voted far from the consensus submits a note explaining their estimate.
 *
 * It surfaces WHY a vote diverged, in the moment, so the moderator can open a discussion. Notes
 * are also persisted per round and visible later in session history; this is the live, ephemeral
 * surface on top of that.
 *
 * Only notes for the CURRENT revealed round are shown, and the moderator's own notes are skipped
 * (they wrote them). Each balloon auto-dismisses after a readable interval or on manual dismiss.
 */
@Component({
  selector: 'app-moderator-note-balloon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div
        class="note-balloons"
        role="region"
        aria-label="Notes from participants who estimated differently"
      >
        <p class="note-balloons__sr" role="status" aria-live="polite" aria-atomic="true">
          {{ announcement() }}
        </p>

        @for (balloon of balloons(); track balloon.id) {
          <div class="note-balloon">
            <button
              type="button"
              class="note-balloon__dismiss"
              aria-label="Dismiss this note"
              (click)="dismiss(balloon.id)"
            >
              &times;
            </button>
            <p class="note-balloon__author">
              <span class="note-balloon__badge" aria-hidden="true">💬</span>
              {{ balloon.authorName }} explained their estimate
            </p>
            <p class="note-balloon__text">{{ balloon.text }}</p>
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

      .note-balloons {
        position: fixed;
        left: 16px;
        bottom: 16px;
        z-index: 905; /* just above the vote-callout layer (900), below dialogs */
        display: flex;
        flex-direction: column-reverse; /* newest nearest the anchored edge */
        align-items: flex-start;
        gap: 8px;
        max-width: min(360px, calc(100vw - 32px));
        max-height: 50vh;
        overflow-y: auto;
        overscroll-behavior: contain;
        pointer-events: none;
      }

      .note-balloon {
        position: relative;
        box-sizing: border-box;
        width: 100%;
        padding: 12px 36px 12px 14px;
        border-radius: 12px;
        background: #fff8e1;
        border: 1px solid #f5a623;
        color: #1a1a2e;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
        pointer-events: auto;
        animation: note-balloon-in 220ms ease-out;
      }

      @media (prefers-reduced-motion: reduce) {
        .note-balloon {
          animation: none;
        }
      }

      .note-balloon__author {
        margin: 0 0 4px;
        font-size: 0.85rem;
        font-weight: 700;
        color: #8a5a00;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .note-balloon__badge {
        font-size: 1rem;
      }

      .note-balloon__text {
        margin: 0;
        font-size: 0.95rem;
        line-height: 1.4;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }

      .note-balloon__dismiss {
        position: absolute;
        top: 6px;
        right: 6px;
        width: 24px;
        height: 24px;
        padding: 0;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: #8a5a00;
        font-size: 1.2rem;
        line-height: 1;
        cursor: pointer;
      }

      .note-balloon__dismiss:focus-visible {
        outline: 2px solid #1b3fa8;
        outline-offset: 2px;
      }

      .note-balloons__sr {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        padding: 0;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      @keyframes note-balloon-in {
        from {
          opacity: 0;
          transform: translateY(8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
    `,
  ],
})
export class ModeratorNoteBalloonComponent {
  private readonly sessionState = inject(SessionStateService);
  private readonly destroyRef = inject(DestroyRef);

  /** The routed Poker_Session; balloons for any other session are ignored. */
  readonly sessionId = input.required<string>();

  private readonly _balloons = signal<readonly ModeratorNoteBalloon[]>([]);
  protected readonly balloons = this._balloons.asReadonly();

  /** Only the moderator (reveal permission) sees the balloons at all. */
  protected readonly visible = computed(
    () => this.sessionState.hasRevealPermission() && this._balloons().length > 0
  );

  protected readonly announcement = computed(() => {
    const latest = this._balloons()[this._balloons().length - 1];
    return latest ? `${latest.authorName} added a note: ${latest.text}` : '';
  });

  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor() {
    this.sessionState.calloutNoteAdded$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload) => this.onNoteAdded(payload));

    this.destroyRef.onDestroy(() => {
      for (const handle of this.timers.values()) clearTimeout(handle);
      this.timers.clear();
    });
  }

  private onNoteAdded(payload: CalloutNoteAddedPayload): void {
    // Only the moderator cares about this surface.
    if (!this.sessionState.hasRevealPermission()) return;

    const note = payload?.note;
    if (!note) return;

    // Only for the round currently on the board, and never the moderator's own note.
    const round = this.sessionState.currentRound();
    if (!round || round.id !== note.roundId) return;
    if (note.authorId === this.sessionState.currentUser()?.id) return;

    // De-dupe by note id (a resync can replay an added note).
    if (this._balloons().some((b) => b.id === note.id)) return;

    const balloon: ModeratorNoteBalloon = {
      id: note.id,
      authorName: note.authorName,
      text: note.text,
    };

    const next = [...this._balloons(), balloon];
    // Drop the oldest beyond the cap and release their timers.
    while (next.length > MAX_BALLOONS) {
      const dropped = next.shift();
      if (dropped) this.clearTimer(dropped.id);
    }
    this._balloons.set(next);

    const handle = setTimeout(() => this.dismiss(note.id), BALLOON_AUTO_DISMISS_MS);
    this.timers.set(note.id, handle);
  }

  protected dismiss(id: string): void {
    this.clearTimer(id);
    const next = this._balloons().filter((b) => b.id !== id);
    if (next.length !== this._balloons().length) this._balloons.set(next);
  }

  private clearTimer(id: string): void {
    const handle = this.timers.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      this.timers.delete(id);
    }
  }
}
