import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  CALLOUT_NOTE_ADDED,
  CALLOUT_NOTE_REJECTED,
  CALLOUT_NOTE_SUBMIT,
  CalloutNoteAddedPayload,
  CalloutNoteRejectedPayload,
  CalloutNoteSubmitPayload,
} from '@shared/types';
import {
  CalloutPersistenceService,
  NoteDraft,
} from '../../services/callout-persistence.service';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';

/**
 * The Unsent_Note_Element (R10.13).
 *
 * A compact, deliberately non-animated element: it has no entrance, idle or exit flourish and it
 * writes no Dismissal_Record. Its visibility is decided by the host layer from the persisted draft
 * (a draft whose `roundId` differs from the current round and whose `sessionId` matches the routed
 * session), so it survives any number of round starts (R10.14) and a page reload (R12.10).
 *
 * Submit sends the note against the STORED round id, never the current one (R10.15), and the draft
 * is cleared only after the server's `callout:note:added` arrives. A rejection keeps the draft.
 * Discard clears the draft and sends nothing (R10.18).
 */
@Component({
  selector: 'app-unsent-note',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="unsent-note" aria-label="Saved note">
      <p class="unsent-note__text">{{ draft().text }}</p>
      @if (errorMessage(); as message) {
        <p class="unsent-note__error" role="alert">{{ message }}</p>
      }
      <div class="unsent-note__actions">
        <button
          type="button"
          class="unsent-note__action unsent-note__action--submit"
          aria-label="Share your saved note on its original round"
          [disabled]="pending()"
          (click)="submit()"
        >
          Share this
        </button>
        <button
          type="button"
          class="unsent-note__action unsent-note__action--discard"
          aria-label="Discard your saved note"
          (click)="discard()"
        >
          Discard
        </button>
      </div>
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
        pointer-events: none;
      }

      .unsent-note {
        box-sizing: border-box;
        width: 100%;
        padding: 8px 12px;
        border-radius: 8px;
        background: #ffffff;
        color: #1a1a2e;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        pointer-events: none;
      }

      .unsent-note__text {
        margin: 0 0 8px;
        font-size: 0.875rem;
        line-height: 1.4;
        color: #4a5568;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-height: 6em;
        overflow-y: auto;
      }

      .unsent-note__error {
        margin: 0 0 8px;
        font-size: 0.8125rem;
        color: #1a1a2e;
      }

      .unsent-note__actions {
        display: flex;
        gap: 8px;
      }

      .unsent-note__action {
        min-width: 32px;
        min-height: 32px;
        padding: 4px 12px;
        border: 1px solid #1b3fa8;
        border-radius: 6px;
        background: #ffffff;
        color: #1b3fa8;
        font: inherit;
        font-size: 0.875rem;
        cursor: pointer;
        pointer-events: auto;
      }

      .unsent-note__action--submit {
        background: #1b3fa8;
        color: #ffffff;
      }

      .unsent-note__action:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .unsent-note__action:focus-visible {
        outline: 2px solid #1b3fa8;
        outline-offset: 2px;
      }
    `,
  ],
})
export class UnsentNoteComponent {
  private readonly ws = inject(WebSocketService);
  private readonly sessionState = inject(SessionStateService);
  private readonly persistence = inject(CalloutPersistenceService);
  private readonly destroyRef = inject(DestroyRef);

  /** The retained draft; carries the round the text was written for (R10.15). */
  readonly draft = input.required<NoteDraft>();

  /** True from the submit click until the server answers (accepted or rejected). */
  readonly pending = signal<boolean>(false);
  readonly errorMessage = signal<string | null>(null);

  constructor() {
    // WS-event bridges: the only subscriptions this component holds.
    this.ws
      .on<CalloutNoteAddedPayload>(CALLOUT_NOTE_ADDED)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload) => this.onAdded(payload));

    this.ws
      .on<CalloutNoteRejectedPayload>(CALLOUT_NOTE_REJECTED)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload) => this.onRejected(payload));
  }

  submit(): void {
    if (this.pending()) return;
    const draft = this.draft();
    const text = draft.text.trim();
    if (text.length === 0) return;

    this.pending.set(true);
    this.errorMessage.set(null);
    this.persistence.dispatchDraft({ kind: 'submitted' });

    // Always the stored round id and session id, never the current round (R10.15).
    const payload: CalloutNoteSubmitPayload = {
      sessionId: draft.sessionId,
      roundId: draft.roundId,
      text,
    };
    this.ws.send(CALLOUT_NOTE_SUBMIT, payload);
  }

  /** Clears the draft and transmits nothing (R10.18). */
  discard(): void {
    this.persistence.dispatchDraft({ kind: 'discarded' });
  }

  private onAdded(payload: CalloutNoteAddedPayload): void {
    if (!this.pending()) return;
    const userId = this.sessionState.currentUser()?.id;
    if (!userId) return;
    if (payload.roundId !== this.draft().roundId || payload.note.authorId !== userId) return;

    this.pending.set(false);
    // Removal happens only here, after the server accepted the note (R10.15).
    this.persistence.dispatchDraft({ kind: 'accepted' });
  }

  private onRejected(payload: CalloutNoteRejectedPayload): void {
    if (!this.pending()) return;
    if (payload.roundId !== this.draft().roundId) return;

    this.pending.set(false);
    this.errorMessage.set('Your note was not saved. Please try again.');
    // Keeps the draft: the element survives a rejection (R10.15).
    this.persistence.dispatchDraft({ kind: 'rejected' });
  }
}
