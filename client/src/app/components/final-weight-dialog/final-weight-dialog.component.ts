import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { Subscription } from 'rxjs';
import {
  FINAL_WEIGHT_SET,
  FINAL_WEIGHT_SUBMIT,
  type ExtendedCardValue,
  type FinalWeightRecord,
} from '@shared/types';
import type {
  FinalWeightOption,
  FinalWeightSetPayload,
  OptionReason,
} from '@shared/final-weight';
import {
  FINAL_WEIGHT_ACK_TIMEOUT_MS,
  FinalWeightGateService,
} from '../../services/final-weight-gate.service';
import { WebSocketService } from '../../services/websocket.service';

/** Target of an edit-mode dialog (header icon): the dialog sends the weight itself. */
export interface FinalWeightEditTarget {
  readonly roundId: string;
  readonly options: readonly FinalWeightOption[];
  readonly ladder: readonly ExtendedCardValue[];
  /** Weight already set on the round, preselected when present. */
  readonly current: FinalWeightRecord | null;
}

interface DialogView {
  readonly mode: 'gate' | 'edit';
  readonly roundId: string;
  readonly options: readonly FinalWeightOption[];
  readonly ladder: readonly ExtendedCardValue[];
  readonly current: FinalWeightRecord | null;
  readonly submitting: boolean;
  readonly error: string | null;
}

interface WireError {
  message?: string;
  code?: string;
}

const REASON_LABELS: Readonly<Record<OptionReason, string>> = {
  voted: 'Voted',
  'most-voted': 'Most voted',
  'nearest-average': 'Nearest average',
  between: 'In between',
};

const EDIT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  UNAUTHORIZED: 'Only a moderator can set the final weight.',
  FEATURE_DISABLED: 'The final weight setting is turned off.',
  INVALID_FINAL_WEIGHT: 'That weight is not valid for this voting system.',
  ROUND_NOT_FOUND: 'This round is no longer available for a final weight.',
};
const EDIT_TIMEOUT_MESSAGE = 'The final weight was not confirmed in time. Try again or close.';
const EDIT_NOT_SENT_MESSAGE = 'Not connected. Try again or close.';

const FOCUSABLE =
  'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), [tabindex="0"]';

/**
 * Final weight dialog.
 * - gate mode: driven by `FinalWeightGateService.dialog()`; outputs go back to the service.
 * - edit mode: when `edit` is set; sends `finalweight:submit` itself and emits `closed`.
 * Not mounted by this component; a page renders `<app-final-weight-dialog>` once.
 */
@Component({
  selector: 'app-final-weight-dialog',
  standalone: true,
  template: `
    @if (view(); as v) {
      <div class="fw-dialog__backdrop" aria-hidden="true"></div>
      <div
        class="fw-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fw-dialog-title"
        aria-describedby="fw-dialog-desc"
        tabindex="-1"
        (keydown)="onDialogKeydown($event)"
      >
        <h2 id="fw-dialog-title" class="fw-dialog__title">
          {{ v.mode === 'edit' ? 'Change final weight' : 'Set the final weight' }}
        </h2>
        <p id="fw-dialog-desc" class="fw-dialog__desc">
          @if (hasScorable()) {
            Pick the weight the team agreed on. The suggested card is only a hint.
          } @else {
            There are no scorable votes, so no accuracy result can be produced. You can still pick a weight.
          }
        </p>

        <div
          class="fw-dialog__cards"
          role="radiogroup"
          aria-labelledby="fw-dialog-title"
        >
          @for (card of cards(); track card.value; let i = $index) {
            <button
              type="button"
              role="radio"
              class="fw-card"
              [class.fw-card--selected]="isSelected(card.value)"
              [class.fw-card--suggested]="card.suggested"
              [attr.aria-checked]="isSelected(card.value)"
              [attr.aria-label]="cardLabel(card)"
              [attr.tabindex]="tabIndexFor(i)"
              [disabled]="v.submitting"
              (click)="select(card.value)"
              (keydown)="onRadioKeydown($event, i)"
            >
              <span class="fw-card__value">{{ card.value }}</span>
              @if (card.suggested) {
                <span class="fw-card__badge fw-card__badge--suggested">Suggested</span>
              }
              @for (reason of card.reasons; track reason) {
                <span class="fw-card__badge">{{ reasonLabel(reason) }}</span>
              }
            </button>
          }
        </div>

        @if (canToggleAll()) {
          <button
            type="button"
            class="fw-dialog__link"
            [attr.aria-pressed]="showAll()"
            [disabled]="v.submitting"
            (click)="toggleShowAll()"
          >
            {{ showAll() ? 'Show suggestions only' : 'Show all cards' }}
          </button>
        }

        <label class="fw-dialog__check">
          <input
            type="checkbox"
            [checked]="showFunniest()"
            [disabled]="v.submitting"
            (change)="onFunniestChange($event)"
          />
          Show the funniest guess
        </label>

        @if (v.error; as message) {
          <div class="fw-dialog__error" role="alert">
            <span>{{ message }}</span>
            <button type="button" class="fw-btn fw-btn--small" (click)="retry()">Retry</button>
          </div>
        }

        <div class="fw-dialog__footer">
          <button type="button" class="fw-btn" (click)="cancel()">
            {{ v.mode === 'edit' ? 'Close' : 'Cancel' }}
          </button>
          @if (v.mode === 'gate') {
            <button type="button" class="fw-btn" [disabled]="v.submitting" (click)="skip()">Skip</button>
          }
          <button
            type="button"
            class="fw-btn fw-btn--primary"
            [disabled]="selected() === null || v.submitting"
            [attr.aria-busy]="v.submitting"
            (click)="confirm()"
          >
            {{ v.submitting ? 'Saving…' : 'Confirm' }}
          </button>
        </div>
      </div>
    }
  `,
  styles: [`
    .fw-dialog__backdrop {
      position: fixed;
      inset: 0;
      background: var(--scrim-dialog);
      z-index: 1000;
    }

    .fw-dialog {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: min(520px, calc(100vw - 2rem));
      max-height: calc(100vh - 2rem);
      overflow-y: auto;
      box-sizing: border-box;
      padding: 1.5rem;
      background: #fff;
      color: var(--text-primary);
      border-radius: 12px;
      box-shadow: var(--shadow-lg);
      z-index: 1001;
    }

    .fw-dialog:focus { outline: none; }

    .fw-dialog__title { margin: 0 0 0.25rem; font-size: 1.1rem; font-weight: 600; }
    .fw-dialog__desc { margin: 0 0 1rem; font-size: 0.85rem; color: var(--text-secondary); }

    .fw-dialog__cards { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.75rem; }

    .fw-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.25rem;
      min-width: 72px;
      min-height: 44px;
      padding: 0.5rem 0.6rem;
      border: 2px solid var(--wash-neutral-strong);
      border-radius: 8px;
      background: #fff;
      color: var(--text-primary);
      cursor: pointer;
    }
    .fw-card:hover:not(:disabled) { background: var(--wash-neutral-weak); }
    .fw-card--suggested { border-color: var(--color-primary-light); }
    .fw-card--selected {
      border-color: var(--color-primary);
      background: var(--surface-card-selected);
    }
    .fw-card:disabled { opacity: 0.6; cursor: not-allowed; }
    .fw-card__value { font-size: 1.25rem; font-weight: 700; }
    .fw-card__badge {
      font-size: 0.7rem;
      line-height: 1.2;
      padding: 0.05rem 0.35rem;
      border-radius: 999px;
      background: var(--wash-neutral-weak);
      color: var(--text-primary);
    }
    .fw-card__badge--suggested { background: var(--color-primary-dark); color: var(--text-on-primary); }

    .fw-dialog__link {
      margin: 0 0 0.75rem;
      padding: 0.25rem 0;
      border: none;
      background: transparent;
      color: var(--color-primary-dark);
      font-size: 0.85rem;
      text-decoration: underline;
      cursor: pointer;
    }

    .fw-dialog__check {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 1rem;
      font-size: 0.9rem;
      min-height: 32px;
    }

    .fw-dialog__error {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      margin-bottom: 1rem;
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      background: var(--wash-error-on-card);
      color: var(--text-primary);
      border: 1px solid var(--toast-error);
      font-size: 0.85rem;
    }

    .fw-dialog__footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.5rem; }

    .fw-btn {
      min-height: 36px;
      padding: 0.5rem 1rem;
      border: 1px solid var(--wash-neutral-strong);
      border-radius: 6px;
      background: #fff;
      color: var(--text-primary);
      font-size: 0.85rem;
      font-weight: 500;
      cursor: pointer;
    }
    .fw-btn:hover:not(:disabled) { background: var(--wash-neutral-weak); }
    .fw-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .fw-btn--small { min-height: 28px; padding: 0.2rem 0.6rem; }
    .fw-btn--primary {
      background: var(--color-primary-dark);
      border-color: var(--color-primary-dark);
      color: var(--text-on-primary);
    }
    .fw-btn--primary:hover:not(:disabled) { background: var(--primary-ink-hover); }

    .fw-card:focus-visible,
    .fw-btn:focus-visible,
    .fw-dialog__link:focus-visible,
    .fw-dialog__check input:focus-visible {
      outline: 2px solid var(--color-primary);
      outline-offset: 2px;
    }

    @media (max-width: 480px) {
      .fw-dialog { padding: 1rem; }
      .fw-card { flex: 1 1 calc(33% - 0.5rem); }
      .fw-dialog__footer .fw-btn { flex: 1 1 auto; }
    }
  `],
})
export class FinalWeightDialogComponent {
  private readonly gate = inject(FinalWeightGateService);
  private readonly ws = inject(WebSocketService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** When set, the dialog is shown in edit mode for this target. */
  readonly edit = input<FinalWeightEditTarget | null>(null);
  /** Edit mode only: emitted after `finalweight:set` for the round, or on Close / Escape. */
  readonly closed = output<void>();

  readonly selected = signal<ExtendedCardValue | null>(null);
  readonly showAll = signal(false);
  readonly showFunniest = signal(false);

  private readonly editSubmitting = signal(false);
  private readonly editError = signal<string | null>(null);
  private editSubs: Subscription[] = [];
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private lastKey: string | null = null;
  private returnFocusTo: HTMLElement | null = null;

  /** Unified view over the two modes; null when nothing should be shown. */
  readonly view = computed<DialogView | null>(() => {
    const target = this.edit();
    if (target) {
      return {
        mode: 'edit',
        roundId: target.roundId,
        options: target.options,
        ladder: target.ladder,
        current: target.current,
        submitting: this.editSubmitting(),
        error: this.editError(),
      };
    }
    const dialog = this.gate.dialog();
    return dialog ? { ...dialog } : null;
  });

  readonly hasScorable = computed(() => (this.view()?.options.length ?? 0) > 0);

  /** The toggle is only useful when suggestions exist and the ladder offers more. */
  readonly canToggleAll = computed(() => {
    const v = this.view();
    return !!v && v.options.length > 0 && v.ladder.length > v.options.length;
  });

  /** Cards shown: suggestions, or the full ladder (no scorable votes or "Show all cards"). */
  readonly cards = computed<readonly FinalWeightOption[]>(() => {
    const v = this.view();
    if (!v) return [];
    if (v.options.length > 0 && !this.showAll()) return v.options;
    return v.ladder.map(
      (value) =>
        v.options.find((o) => o.value === value) ?? { value, reasons: [], suggested: false }
    );
  });

  constructor() {
    // Reset the form when a different dialog opens; focus in on open, back to the trigger on close.
    effect(() => {
      const v = this.view();
      const key = v ? `${v.mode}:${v.roundId}` : null;
      untracked(() => this.onViewKey(key, v));
    });
    inject(DestroyRef).onDestroy(() => this.clearEditWait());
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.view()) this.cancel();
  }

  isSelected(value: ExtendedCardValue): boolean {
    return this.selected() === value;
  }

  select(value: ExtendedCardValue): void {
    this.selected.set(value);
  }

  reasonLabel(reason: OptionReason): string {
    return REASON_LABELS[reason];
  }

  cardLabel(card: FinalWeightOption): string {
    const parts = [`Weight ${card.value}`];
    if (card.suggested) parts.push('suggested');
    for (const reason of card.reasons) parts.push(REASON_LABELS[reason].toLowerCase());
    return parts.join(', ');
  }

  /** Roving tabindex: the selected card, or the first when nothing is selected. */
  tabIndexFor(index: number): number {
    const list = this.cards();
    const selectedIdx = list.findIndex((c) => c.value === this.selected());
    return index === (selectedIdx === -1 ? 0 : selectedIdx) ? 0 : -1;
  }

  toggleShowAll(): void {
    this.showAll.update((v) => !v);
  }

  onFunniestChange(event: Event): void {
    this.showFunniest.set((event.target as HTMLInputElement).checked);
  }

  confirm(): void {
    const value = this.selected();
    const v = this.view();
    if (value === null || !v || v.submitting) return;
    if (v.mode === 'edit') {
      this.submitEdit(v.roundId, value);
    } else {
      this.gate.confirm({ value, showFunniest: this.showFunniest() });
    }
  }

  retry(): void {
    const v = this.view();
    if (!v || v.submitting) return;
    if (v.mode === 'edit') {
      this.confirm();
    } else {
      this.gate.retry();
    }
  }

  skip(): void {
    if (this.view()?.mode === 'gate') this.gate.skip();
  }

  cancel(): void {
    const v = this.view();
    if (!v) return;
    if (v.mode === 'edit') {
      this.clearEditWait();
      this.closed.emit();
    } else {
      this.gate.cancel();
    }
  }

  onRadioKeydown(event: KeyboardEvent, index: number): void {
    const list = this.cards();
    if (list.length === 0) return;
    let next = index;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % list.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + list.length) % list.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = list.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.selected.set(list[next].value);
    const radios = this.host.nativeElement.querySelectorAll<HTMLElement>('[role="radio"]');
    radios[next]?.focus();
  }

  /** Keeps Tab / Shift+Tab inside the dialog. */
  onDialogKeydown(event: KeyboardEvent): void {
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

  // ---------------------------------------------------------------------------

  private onViewKey(key: string | null, v: DialogView | null): void {
    if (key === this.lastKey) return;
    const wasOpen = this.lastKey !== null;
    this.lastKey = key;
    this.clearEditWait();
    this.editSubmitting.set(false);
    this.editError.set(null);

    if (!v) {
      this.selected.set(null);
      this.showAll.set(false);
      this.showFunniest.set(false);
      if (wasOpen) this.restoreFocus();
      return;
    }

    // Preselect only an already-set weight; the suggested card is marked, not chosen.
    const current = v.current;
    this.selected.set(current ? current.value : null);
    this.showFunniest.set(current ? current.showFunniest : false);
    this.showAll.set(
      v.options.length === 0 ||
        (current !== null && !v.options.some((o) => o.value === current.value))
    );

    if (!wasOpen) {
      const active = document.activeElement;
      this.returnFocusTo = active instanceof HTMLElement ? active : null;
    }
    afterNextRender(() => this.focusInitial(), { injector: this.injector });
  }

  private focusInitial(): void {
    const root = this.host.nativeElement;
    const target =
      root.querySelector<HTMLElement>('[role="radio"][tabindex="0"]') ??
      root.querySelector<HTMLElement>('.fw-dialog');
    target?.focus();
  }

  private restoreFocus(): void {
    const el = this.returnFocusTo;
    this.returnFocusTo = null;
    if (el && el.isConnected) el.focus();
  }

  private submitEdit(roundId: string, value: ExtendedCardValue): void {
    this.clearEditWait();
    this.editSubmitting.set(true);
    this.editError.set(null);

    this.editSubs.push(
      this.ws.on<FinalWeightSetPayload>(FINAL_WEIGHT_SET).subscribe((payload) => {
        if (payload?.roundId !== roundId) return;
        this.clearEditWait();
        this.editSubmitting.set(false);
        this.closed.emit();
      }),
      this.ws.on<WireError>('error').subscribe((err) => {
        const code = err?.code;
        if (code !== undefined && code in EDIT_ERROR_MESSAGES) {
          this.failEdit(EDIT_ERROR_MESSAGES[code]);
        }
      })
    );
    this.editTimer = setTimeout(
      () => this.failEdit(EDIT_TIMEOUT_MESSAGE),
      FINAL_WEIGHT_ACK_TIMEOUT_MS
    );

    const sent = this.ws.send(FINAL_WEIGHT_SUBMIT, {
      roundId,
      value,
      showFunniest: this.showFunniest(),
    });
    if (!sent) this.failEdit(EDIT_NOT_SENT_MESSAGE);
  }

  private failEdit(message: string): void {
    this.clearEditWait();
    this.editSubmitting.set(false);
    this.editError.set(message);
  }

  private clearEditWait(): void {
    for (const sub of this.editSubs) sub.unsubscribe();
    this.editSubs = [];
    if (this.editTimer !== null) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
  }
}
