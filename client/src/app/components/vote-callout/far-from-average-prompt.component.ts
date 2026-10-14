import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  CALLOUT_NOTE_SUBMIT,
  CalloutNoteAddedPayload,
  CalloutNoteRejectedPayload,
  CalloutNoteRejection,
  CalloutNoteSubmitPayload,
  NOTE_MAX_LENGTH,
} from '@shared/types';
import { CalloutCopyStoreService } from '../../services/callout-copy-store.service';
import { CalloutPersistenceService } from '../../services/callout-persistence.service';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import {
  ENTRANCE_MS,
  ExitCause,
  INITIAL_LIFECYCLE_STATE,
  LifecycleEffect,
  LifecycleEvent,
  LifecycleState,
  reduceCalloutLifecycle,
} from './callout-animation';
import type { FarPromptModel } from './callout-visibility';

/**
 * Every piece of copy the prompt renders apart from the Callout_Phrase and the acknowledgement,
 * which come from the Callout_Copy_Catalog. Held as data so the template carries no literals
 * (R4.1) and the labels can be reviewed in one place.
 *
 * The dismiss label states declining as a complete, consequence-free choice (R3.8) and avoids the
 * words "cancel", "skip", "ignore" and "later".
 */
export const FAR_PROMPT_COPY = {
  groupLabel: 'Invitation to add a note',
  textareaLabel: 'Add a note about your estimate',
  submitLabel: 'Share this',
  submitAriaLabel: 'Share your note on this round',
  dismissLabel: 'No thanks, all good',
  dismissAriaLabel: 'Decline to add a note about your estimate',
  /** Shown for any rejection the table below does not cover (R3.12). */
  errorFallback: 'Your note was not saved. Please try again.',
} as const;

/** Inline error per rejection code; each states that the note was not saved (R3.12, R10.6 to R10.8). */
export const FAR_PROMPT_REJECTION_MESSAGES: Readonly<Record<CalloutNoteRejection, string>> = {
  NOTE_SESSION_MISMATCH: 'Your note was not saved. It was meant for a different session.',
  NOTE_INVALID: 'Your note was not saved. It could not be read, so please try again.',
  NOTE_EMPTY: 'Your note was not saved. Some text is needed first.',
  NOTE_TOO_LONG: 'Your note was not saved. Notes can be up to 280 characters.',
  NOTE_ROUND_UNKNOWN: 'Your note was not saved. That round is no longer available.',
  NOTE_DUPLICATE: 'Your note was not saved. A note from you is already on this round.',
};

/** How long the acknowledgement stays readable before the exit flourish plays on acceptance. */
export const ACKNOWLEDGEMENT_HOLD_MS = 1800;

/** One run of phrase text; glyph runs are rendered `aria-hidden` (R4.10). */
export interface PhraseSegment {
  readonly text: string;
  readonly glyph: boolean;
}

const GLYPH_PATTERN =
  /(\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}]|\u200D\p{Extended_Pictographic})*)/u;

/** Splits a phrase into text runs and decorative-glyph runs, preserving order and spacing. */
export function splitPhraseGlyphs(phrase: string): readonly PhraseSegment[] {
  return phrase
    .split(GLYPH_PATTERN)
    .map((text, index): PhraseSegment => ({ text, glyph: index % 2 === 1 }))
    .filter((segment) => segment.text.length > 0);
}

/** The phrase with every decorative glyph removed and spacing tidied (used for announcements). */
export function stripPhraseGlyphs(phrase: string): string {
  return splitPhraseGlyphs(phrase)
    .filter((segment) => !segment.glyph)
    .map((segment) => segment.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

const ENTRANCE_ANIMATIONS: ReadonlySet<string> = new Set([
  'callout-pop-in',
  'callout-slide-in',
  'callout-fade-in',
]);
const EXIT_ANIMATIONS: ReadonlySet<string> = new Set(['callout-pop-out', 'callout-fade-out']);

/**
 * The Far_From_Average_Prompt (R3).
 *
 * Shown privately to a Participant in the Far_Set. It displays one Callout_Phrase and an optional
 * note field; it shows no distance, no card, no average, no counts and no other participant (R3.6).
 *
 * Lifecycle: driven by `reduceCalloutLifecycle`. The component owns the timers and the DOM and
 * interprets the reducer's effects. The host layer may force an exit through `exitCause`, and is
 * expected to keep this component mounted until `removed` fires so the exit flourish can play.
 *
 * Outputs:
 *  - `dismissed` fires when the participant declines (button or Escape) and once the acknowledgement
 *    has been shown after an accepted note, so the host can write the Dismissal_Record (R3.9, R3.11).
 *  - `removed` fires exactly once, when the element leaves the document (R5.8, R5.10).
 *
 * Nothing here transmits anything on appear, type or dismiss (R3.3, R3.9). The only message sent is
 * `callout:note:submit`, and only from the submit control.
 */
@Component({
  selector: 'app-far-from-average-prompt',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (phase() !== 'removed') {
      <div
        #panel
        class="callout callout--far"
        [class.callout--idle]="idleOn() && phase() === 'idle'"
        [class.callout--exiting]="phase() === 'exiting'"
        [class.callout--at-rest]="!model().replayEntrance"
        role="group"
        [attr.aria-label]="copy.groupLabel"
        (animationend)="onAnimationEnd($event)"
        (keydown.escape)="onEscape($event)"
      >
        <p class="callout__sr" role="status" aria-live="polite" aria-atomic="true">
          {{ announcement() }}
        </p>

        @if (accepted()) {
          <p class="callout__phrase callout__phrase--ack">
            @for (segment of acknowledgementSegments(); track $index) {
              <span [attr.aria-hidden]="segment.glyph ? 'true' : null">{{ segment.text }}</span>
            }
          </p>
        } @else {
          <p class="callout__phrase">
            @for (segment of phraseSegments(); track $index) {
              <span [attr.aria-hidden]="segment.glyph ? 'true' : null">{{ segment.text }}</span>
            }
          </p>

          <textarea
            #noteInput
            class="callout__input"
            rows="3"
            [attr.maxlength]="maxLength"
            [attr.aria-label]="copy.textareaLabel"
            [value]="draft()"
            (input)="onInput(noteInput.value)"
          ></textarea>

          @if (errorMessage(); as message) {
            <p class="callout__error" role="alert">{{ message }}</p>
          }

          <div class="callout__actions">
            <button
              type="button"
              class="callout__action callout__action--submit"
              [attr.aria-label]="copy.submitAriaLabel"
              [disabled]="!canSubmit()"
              (click)="submit()"
            >
              {{ copy.submitLabel }}
            </button>
            <button
              type="button"
              class="callout__action callout__action--dismiss"
              [attr.aria-label]="copy.dismissAriaLabel"
              (click)="dismiss()"
            >
              {{ copy.dismissLabel }}
            </button>
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        pointer-events: none;
      }

      .callout {
        box-sizing: border-box;
        width: 100%;
        max-height: 40vh;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 12px 16px;
        border-radius: 12px;
        background: #ffffff;
        color: #1a1a2e;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
        pointer-events: none;
      }

      /* Mounted already resting (R11.12): no entrance replay, but the exit still plays. */
      .callout--at-rest:not(.callout--exiting):not(.callout--idle) {
        animation: none;
      }

      .callout__phrase {
        margin: 0 0 8px;
        font-size: 1rem;
        line-height: 1.4;
        overflow-wrap: anywhere;
      }

      .callout__input {
        box-sizing: border-box;
        display: block;
        width: 100%;
        min-height: 44px;
        padding: 8px;
        border: 1px solid #4a5568;
        border-radius: 6px;
        background: #ffffff;
        color: #1a1a2e;
        font: inherit;
        font-size: 0.9375rem;
        resize: vertical;
        pointer-events: auto;
      }

      .callout__input:focus-visible,
      .callout__action:focus-visible {
        outline: 2px solid #1b3fa8;
        outline-offset: 2px;
      }

      .callout__error {
        margin: 8px 0 0;
        font-size: 0.875rem;
        color: #1a1a2e;
      }

      .callout__actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 8px;
      }

      /* One class for both controls: identical text size and box size by construction (R3.8). */
      .callout__action {
        box-sizing: border-box;
        min-width: 44px;
        min-height: 44px;
        padding: 6px 14px;
        border: 1px solid #1b3fa8;
        border-radius: 6px;
        background: #ffffff;
        color: #1b3fa8;
        font: inherit;
        font-size: 0.9375rem;
        line-height: 1.2;
        cursor: pointer;
        pointer-events: auto;
      }

      .callout__action--submit {
        background: #1b3fa8;
        color: #ffffff;
      }

      .callout__action:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .callout__sr {
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
    `,
  ],
})
export class FarFromAveragePromptComponent implements OnInit, OnDestroy {
  private readonly ws = inject(WebSocketService);
  private readonly sessionState = inject(SessionStateService);
  private readonly persistence = inject(CalloutPersistenceService);
  private readonly copyStore = inject(CalloutCopyStoreService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly doc = inject(DOCUMENT);

  /** Round and entrance-replay data from the visibility resolver. */
  readonly model = input.required<FarPromptModel>();
  /** The Callout_Phrase chosen by the host from the far-from-average section (R3.5). */
  readonly phrase = input.required<string>();
  /** The routed Poker_Session; the note is addressed to it (R13.13). */
  readonly sessionId = input.required<string>();
  readonly reducedMotion = input<boolean>(false);
  /** Set by the host to force the Exit_Flourish for a layer-level trigger (R5.6, R5.9, R6.9). */
  readonly exitCause = input<ExitCause | null>(null);

  readonly dismissed = output<void>();
  readonly removed = output<void>();

  protected readonly copy = FAR_PROMPT_COPY;
  protected readonly maxLength = NOTE_MAX_LENGTH;

  /** Empty on each appearance (R3.7). */
  readonly draft = signal<string>('');
  /** True from the submit activation until the server answers (R3.13). */
  readonly pending = signal<boolean>(false);
  readonly errorMessage = signal<string | null>(null);
  readonly accepted = signal<boolean>(false);
  readonly canSubmit = computed(() => !this.pending() && this.draft().trim().length > 0);

  private readonly lifecycle = signal<LifecycleState>(INITIAL_LIFECYCLE_STATE);
  protected readonly phase = computed(() => this.lifecycle().phase);
  protected readonly idleOn = signal<boolean>(false);

  private readonly acknowledgementPhrase = signal<string>('');
  protected readonly phraseSegments = computed(() => splitPhraseGlyphs(this.phrase()));
  protected readonly acknowledgementSegments = computed(() =>
    splitPhraseGlyphs(this.acknowledgementPhrase())
  );
  /** Written once, when the acknowledgement replaces the content; empty otherwise (R9.11). */
  protected readonly announcement = signal<string>('');

  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor() {
    this.sessionState.calloutNoteAdded$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload) => this.onAdded(payload));

    this.sessionState.calloutNoteRejected$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((payload) => this.onRejected(payload));

    // Layer-driven exits (new round, board cleared, suppression, funCallouts off).
    effect(() => {
      const cause = this.exitCause();
      if (cause === null) return;
      untracked(() => this.dispatch({ kind: 'exit-trigger', cause }));
    });
  }

  ngOnInit(): void {
    // No `.focus()` here: appearing never takes focus (R9.1).
    this.dispatch({ kind: 'show', reducedMotion: this.reducedMotion() });
    if (this.model().replayEntrance) {
      this.schedule(() => this.dispatch({ kind: 'entrance-end' }), ENTRANCE_MS + 80);
    } else {
      this.dispatch({ kind: 'entrance-end' });
    }
  }

  ngOnDestroy(): void {
    this.clearTimers();
  }

  onInput(value: string): void {
    const text = value.slice(0, NOTE_MAX_LENGTH);
    this.draft.set(text);
    // Persist against the round the text is written for, so it survives a round change as an
    // unsent note (R10.13, R10.14). Whitespace-only text clears it.
    this.persistence.dispatchDraft({
      kind: 'typed',
      sessionId: this.sessionId(),
      roundId: this.model().roundId,
      text,
    });
  }

  /** Disables itself immediately and sends exactly one `callout:note:submit` (R3.13, R10.2). */
  submit(): void {
    if (!this.canSubmit() || this.phase() === 'exiting' || this.phase() === 'removed') return;

    this.pending.set(true);
    this.errorMessage.set(null);
    this.persistence.dispatchDraft({ kind: 'submitted' });

    const payload: CalloutNoteSubmitPayload = {
      sessionId: this.sessionId(),
      roundId: this.model().roundId,
      text: this.draft().trim(),
    };
    this.ws.send(CALLOUT_NOTE_SUBMIT, payload);
  }

  /** Declining is complete and consequence-free: unsent text is discarded and nothing is sent (R3.9). */
  dismiss(): void {
    const phase = this.phase();
    if (phase === 'exiting' || phase === 'removed') return;
    this.discardOwnDraft();
    this.dismissed.emit();
    this.dispatch({ kind: 'exit-trigger', cause: 'dismissed' });
  }

  onEscape(event: Event): void {
    event.stopPropagation();
    this.dismiss();
  }

  onAnimationEnd(event: AnimationEvent): void {
    // Ignore animations that bubbled up from descendants.
    if (event.target !== event.currentTarget) return;
    if (ENTRANCE_ANIMATIONS.has(event.animationName)) {
      this.dispatch({ kind: 'entrance-end' });
    } else if (EXIT_ANIMATIONS.has(event.animationName)) {
      this.dispatch({ kind: 'exit-end' });
    }
  }

  // ---- Server resolution --------------------------------------------------------------------

  private onAdded(payload: CalloutNoteAddedPayload): void {
    if (!this.pending()) return;
    const userId = this.sessionState.currentUser()?.id;
    const roundId = this.model().roundId;
    if (!userId || payload.roundId !== roundId || payload.note.authorId !== userId) return;

    this.pending.set(false);
    this.errorMessage.set(null);
    this.clearOwnDraftAfterAcceptance();

    const phrase = this.copyStore.phraseFor('acknowledgement', roundId) ?? '';
    this.acknowledgementPhrase.set(phrase);
    this.announcement.set(stripPhraseGlyphs(phrase));
    // Focus was on the submit control that is about to disappear; keep it inside the page flow.
    this.moveFocusOutIfInside();
    this.accepted.set(true);

    // Let the acknowledgement be read, then play the exit and report the dismissal (R3.11, R10.12).
    this.schedule(() => {
      this.dismissed.emit();
      this.dispatch({ kind: 'exit-trigger', cause: 'dismissed' });
    }, ACKNOWLEDGEMENT_HOLD_MS);
  }

  private onRejected(payload: CalloutNoteRejectedPayload): void {
    if (!this.pending()) return;
    if (payload.roundId !== this.model().roundId) return;

    // Stay visible, keep the text, re-enable submit, show the inline error (R3.12).
    this.pending.set(false);
    this.errorMessage.set(
      FAR_PROMPT_REJECTION_MESSAGES[payload.code] ?? FAR_PROMPT_COPY.errorFallback
    );
    this.persistence.dispatchDraft({ kind: 'rejected' });
  }

  // ---- Draft helpers ------------------------------------------------------------------------

  /** Discards the persisted draft only when it belongs to this prompt's round. */
  private discardOwnDraft(): void {
    if (this.persistence.draft()?.roundId === this.model().roundId) {
      this.persistence.dispatchDraft({ kind: 'discarded' });
    }
  }

  private clearOwnDraftAfterAcceptance(): void {
    if (this.persistence.draft()?.roundId === this.model().roundId) {
      this.persistence.dispatchDraft({ kind: 'accepted' });
    }
  }

  // ---- Lifecycle plumbing -------------------------------------------------------------------

  private dispatch(event: LifecycleEvent): void {
    const result = reduceCalloutLifecycle(this.lifecycle(), event);
    this.lifecycle.set(result.state);
    for (const effect of result.effects) this.runEffect(effect);
  }

  private runEffect(effect: LifecycleEffect): void {
    switch (effect.kind) {
      case 'start-idle':
        // A prompt mounted at rest (R11.12) stays still instead of starting the idle loop.
        if (this.model().replayEntrance) this.idleOn.set(true);
        break;
      case 'capture-transform':
        this.captureTransform();
        break;
      case 'arm-exit-deadline':
        this.schedule(() => this.dispatch({ kind: 'exit-deadline' }), effect.ms);
        break;
      case 'remove':
        this.idleOn.set(false);
        this.moveFocusOutIfInside();
        this.clearTimers();
        this.removed.emit();
        break;
      case 'release-budget':
        // The host layer owns the animation budget and releases it on `removed`.
        break;
    }
  }

  /** Lets an exit during the entrance continue from the live transform and opacity (R5.16). */
  private captureTransform(): void {
    const element = this.panel()?.nativeElement;
    if (!element) return;
    const view = this.doc.defaultView;
    if (!view) return;
    const style = view.getComputedStyle(element);
    if (style.transform && style.transform !== 'none') {
      element.style.setProperty('--callout-exit-from', style.transform);
    }
    if (style.opacity) {
      element.style.setProperty('--callout-exit-opacity', style.opacity);
    }
  }

  /** Moves focus to the main board region when it sits inside the panel; otherwise touches nothing (R9.8, R9.12). */
  private moveFocusOutIfInside(): void {
    const element = this.panel()?.nativeElement;
    const active = this.doc.activeElement;
    if (!element || !active || !element.contains(active)) return;
    const main = this.doc.getElementById('main-content');
    if (!main) return;
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    main.focus({ preventScroll: true });
  }

  private schedule(callback: () => void, ms: number): void {
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      callback();
    }, ms);
    this.timers.add(handle);
  }

  private clearTimers(): void {
    for (const handle of this.timers) clearTimeout(handle);
    this.timers.clear();
  }
}
