import { Injectable, OnDestroy, Signal, effect, inject, signal, untracked } from '@angular/core';
import { Subscription } from 'rxjs';
import {
  FINAL_WEIGHT_SUBMIT,
  FINAL_WEIGHT_SET,
  type ExtendedCardValue,
  type FinalWeightRecord,
} from '@shared/types';
import {
  buildFinalWeightOptions,
  votesFromRound,
  type FinalWeightOption,
  type FinalWeightSetPayload,
} from '@shared/final-weight';
import { SessionStateService } from './session-state.service';
import { WebSocketService } from './websocket.service';

/** How long the gate waits for `finalweight:set` before offering Retry / Skip / Cancel (R11.10). */
export const FINAL_WEIGHT_ACK_TIMEOUT_MS = 5000;
/** How long End Session waits for `board:cleared` before it deletes anyway (R4.4). */
export const END_SESSION_CLEAR_TIMEOUT_MS = 3000;

/** Rejections after which the dialog stays open (R11.10). */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'UNAUTHORIZED',
  'FEATURE_DISABLED',
  'INVALID_FINAL_WEIGHT',
]);

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  UNAUTHORIZED: 'Only a moderator can set the final weight.',
  FEATURE_DISABLED: 'The final weight setting is turned off.',
  INVALID_FINAL_WEIGHT: 'That weight is not valid for this voting system.',
};
const TIMEOUT_MESSAGE = 'The final weight was not confirmed in time. Try again, skip or cancel.';
const NOT_SENT_MESSAGE = 'Not connected. Try again, skip or cancel.';

/** State consumed by the Final Weight dialog component. */
export interface FinalWeightDialogState {
  readonly mode: 'gate';
  readonly roundId: string;
  readonly options: readonly FinalWeightOption[];
  readonly ladder: readonly ExtendedCardValue[];
  /** Weight already set on this round (for example from the header icon), if any. */
  readonly current: FinalWeightRecord | null;
  /** True while waiting for the server acknowledgement. */
  readonly submitting: boolean;
  /** Inline message after a rejection or timeout; null otherwise. */
  readonly error: string | null;
}

export interface FinalWeightSelection {
  value: ExtendedCardValue;
  showFunniest: boolean;
}

interface WireError {
  message?: string;
  code?: string;
}

/**
 * Single entry point that asks the moderator for a final weight before a round-completing
 * action runs. With the setting off (or for non-moderators / non-revealed rounds) the action
 * runs synchronously, exactly as before.
 */
@Injectable({ providedIn: 'root' })
export class FinalWeightGateService implements OnDestroy {
  private readonly state = inject(SessionStateService);
  private readonly ws = inject(WebSocketService);

  private readonly _dialog = signal<FinalWeightDialogState | null>(null);
  /** Non-null while the gate dialog should be shown. */
  readonly dialog: Signal<FinalWeightDialogState | null> = this._dialog.asReadonly();

  /** Action waiting for the dialog outcome; cleared as soon as it ran or was cancelled. */
  private pending: (() => void) | null = null;
  private lastSelection: FinalWeightSelection | null = null;
  private submitSubs: Subscription[] = [];
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private archiveSubs: Subscription[] = [];
  private archiveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Close as Skip when the round changes or stops being revealed, or the setting is turned off (R4.12).
    effect(() => {
      const enabled = this.state.finalWeightEnabled();
      const revealed = this.state.isRevealed();
      const roundId = this.state.currentRound()?.id ?? null;
      const dialog = untracked(() => this._dialog());
      if (!dialog) return;
      if (!enabled || !revealed || roundId !== dialog.roundId) {
        untracked(() => this.resolve(true));
      }
    });
  }

  /** Runs `action` after the moderator confirmed or skipped; drops it on cancel. */
  guard(action: () => void): void {
    if (this._dialog()) return; // a prompt is already open
    if (!this.shouldAsk()) {
      action();
      return;
    }
    this.open(action);
  }

  /**
   * End Session: without a prompt, `deleteSession` runs immediately. With a prompt, after
   * confirm/skip the round is archived (`board:clear`) and `deleteSession` runs once
   * `board:cleared`, an `error` or a 3 s timeout arrives, so the delete cannot overtake it.
   */
  guardEndSession(deleteSession: () => void): void {
    if (this._dialog()) return;
    if (!this.shouldAsk()) {
      deleteSession();
      return;
    }
    this.open(() => this.archiveThen(deleteSession));
  }

  /** Dialog output: send the chosen weight and continue once it is acknowledged. */
  confirm(selection: FinalWeightSelection): void {
    const dialog = this._dialog();
    if (!dialog || dialog.submitting) return;
    this.lastSelection = selection;
    this.submit(dialog.roundId, selection);
  }

  /** Dialog output: repeat the last submit after an inline error. */
  retry(): void {
    const dialog = this._dialog();
    if (!dialog || dialog.submitting || !this.lastSelection) return;
    this.submit(dialog.roundId, this.lastSelection);
  }

  /** Dialog output: continue the original action without a new weight (R4.13). */
  skip(): void {
    if (!this._dialog()) return;
    this.resolve(true);
  }

  /** Dialog output: close and drop the original action; the round stays revealed (R4.14). */
  cancel(): void {
    if (!this._dialog()) return;
    this.resolve(false);
  }

  ngOnDestroy(): void {
    this.clearSubmitWait();
    this.clearArchiveWait();
    this.pending = null;
  }

  // ---------------------------------------------------------------------------

  private shouldAsk(): boolean {
    return (
      this.state.finalWeightEnabled() &&
      this.state.currentUser()?.role === 'moderator' &&
      this.state.isRevealed() &&
      this.state.currentRound() !== null
    );
  }

  private open(action: () => void): void {
    const round = this.state.currentRound();
    const config = this.state.sessionConfig();
    if (!round || !config) {
      action();
      return;
    }
    const votes = votesFromRound(this.state.selections(), this.state.participants());
    const { options, ladder } = buildFinalWeightOptions(votes, config.votingSystem);
    this.pending = action;
    this.lastSelection = null;
    this._dialog.set({
      mode: 'gate',
      roundId: round.id,
      options,
      ladder,
      current: round.finalWeight ?? null,
      submitting: false,
      error: null,
    });
  }

  private submit(roundId: string, selection: FinalWeightSelection): void {
    this.clearSubmitWait();
    this.patchDialog({ submitting: true, error: null });

    this.submitSubs.push(
      this.ws.on<FinalWeightSetPayload>(FINAL_WEIGHT_SET).subscribe((payload) => {
        if (payload?.roundId === roundId) this.resolve(true);
      }),
      this.ws.on<WireError>('error').subscribe((err) => {
        const code = err?.code;
        if (code === 'ROUND_NOT_FOUND') {
          this.resolve(true); // round already cleared or re-voted: same as Skip (R11.11)
        } else if (code !== undefined && RETRYABLE_CODES.has(code)) {
          this.failSubmit(ERROR_MESSAGES[code] ?? 'The final weight was rejected.');
        }
      })
    );
    this.ackTimer = setTimeout(() => this.failSubmit(TIMEOUT_MESSAGE), FINAL_WEIGHT_ACK_TIMEOUT_MS);

    const sent = this.ws.send(FINAL_WEIGHT_SUBMIT, {
      roundId,
      value: selection.value,
      showFunniest: selection.showFunniest,
    });
    if (!sent) this.failSubmit(NOT_SENT_MESSAGE);
  }

  private failSubmit(message: string): void {
    this.clearSubmitWait();
    this.patchDialog({ submitting: false, error: message });
  }

  /** Closes the dialog; runs the pending action when `proceed`, drops it otherwise. */
  private resolve(proceed: boolean): void {
    const action = this.pending;
    this.pending = null;
    this.lastSelection = null;
    this.clearSubmitWait();
    this._dialog.set(null);
    if (proceed && action) action();
  }

  private patchDialog(patch: Partial<FinalWeightDialogState>): void {
    const dialog = this._dialog();
    if (dialog) this._dialog.set({ ...dialog, ...patch });
  }

  private clearSubmitWait(): void {
    for (const sub of this.submitSubs) sub.unsubscribe();
    this.submitSubs = [];
    if (this.ackTimer !== null) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
  }

  private archiveThen(deleteSession: () => void): void {
    this.clearArchiveWait();
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      this.clearArchiveWait();
      deleteSession();
    };
    this.archiveSubs.push(
      this.ws.on<unknown>('board:cleared').subscribe(finish),
      this.ws.on<unknown>('error').subscribe(finish)
    );
    this.archiveTimer = setTimeout(finish, END_SESSION_CLEAR_TIMEOUT_MS);
    // If the clear cannot be sent, delete as today.
    if (!this.ws.send('board:clear', {})) finish();
  }

  private clearArchiveWait(): void {
    for (const sub of this.archiveSubs) sub.unsubscribe();
    this.archiveSubs = [];
    if (this.archiveTimer !== null) {
      clearTimeout(this.archiveTimer);
      this.archiveTimer = null;
    }
  }
}
