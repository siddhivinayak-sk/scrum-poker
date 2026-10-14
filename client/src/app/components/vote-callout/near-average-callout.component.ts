import {
  ChangeDetectionStrategy,
  Component,
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
} from '@angular/core';
import {
  ENTRANCE_MS,
  INITIAL_LIFECYCLE_STATE,
  reduceCalloutLifecycle,
  type ExitCause,
  type LifecycleEffect,
  type LifecycleEvent,
  type LifecycleState,
} from './callout-animation';
import { splitPhraseGlyphs } from './callout-glyph';
import type { NearCalloutModel } from './callout-visibility';

/** Grace added to the entrance duration before the `animationend` fallback fires (design §7.5). */
const ENTRANCE_FALLBACK_SLACK_MS = 80;

/** Keyframe names whose end marks the entrance as complete (full motion and reduced motion). */
const ENTRANCE_ANIMATIONS: ReadonlySet<string> = new Set(['callout-pop-in', 'callout-fade-in']);
/** Keyframe names whose end marks the exit as complete (full motion and reduced motion). */
const EXIT_ANIMATIONS: ReadonlySet<string> = new Set(['callout-pop-out', 'callout-fade-out']);

/** Id of the session page's main board region, which receives focus when a focused panel leaves. */
const MAIN_REGION_ID = 'main-content';

/**
 * The Near_Average_Callout (R2): a floating, animated panel that celebrates, by name, the
 * participants whose votes landed closest to the average.
 *
 * Presentation only. Visibility, gating, copy selection and the animation budget are decided by
 * the host layer; this component renders what it is given and runs the animation lifecycle
 * through `reduceCalloutLifecycle`.
 *
 * Contract with the host layer:
 *  - `dismissed` fires once, as soon as the viewer activates the dismiss control or presses
 *    Escape. The panel then plays its own Exit_Flourish.
 *  - `removed` fires exactly once, when the exit completes (or the 700 ms deadline passes) and
 *    the panel has taken itself out of the document. The layer releases its animation budget
 *    share on this event, and should keep the callout mounted until it arrives.
 *  - `exitCause` lets the layer start the same exit for any other trigger (new round, board
 *    cleared, suppression, `funCallouts` off, ...).
 *
 * Nothing here renders a distance, rank, ordinal or count of anyone outside the celebrated group
 * (R2.5, R2.6). The decorative glyph of the phrase is `aria-hidden` (R4.10). Text is always
 * interpolated, never bound as HTML. The component never calls `focus()` when it appears (R9.1).
 */
@Component({
  selector: 'app-near-average-callout',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (phase() !== 'removed') {
      <section
        class="callout callout--near"
        [class.callout--idle]="idleActive()"
        [class.callout--exiting]="phase() === 'exiting'"
        [style.animation]="restingStyle()"
        [style.--callout-stagger]="staggerValue()"
        animate.enter="callout--entering"
        animate.leave="callout--exiting"
        (animationend)="onAnimationEnd($event)"
        (keydown.escape)="onEscape($event)"
      >
        <p class="callout__phrase">
          {{ phraseParts().text }}
          @if (phraseParts().glyph.length > 0) {
            <span class="callout__glyph" aria-hidden="true">{{ phraseParts().glyph }}</span>
          }
        </p>

        @if (model().names.length > 0) {
          <ul class="callout__names">
            @for (name of model().names; track $index) {
              <li
                class="callout__name"
                [class.callout__name--at-rest]="atRestMount() || $index >= animatedNameCount()"
                [style.--name-index]="$index"
                [attr.title]="name.full"
                [attr.aria-label]="name.full"
              >
                {{ name.shown }}
              </li>
            }
          </ul>
        }

        @if (summaryText(); as summary) {
          <p class="callout__summary">{{ summary }}</p>
        }

        <button
          class="callout__dismiss callout__action"
          type="button"
          [attr.aria-label]="dismissAriaLabel"
          (click)="dismiss()"
        >
          {{ dismissLabel }}
        </button>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: contents;
      }

      .callout {
        box-sizing: border-box;
        width: 100%;
        max-width: min(360px, calc(100vw - 16px));
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

      .callout__phrase {
        margin: 0 0 8px;
        font-size: 1rem;
        line-height: 1.4;
        font-weight: 600;
        overflow-wrap: anywhere;
      }

      .callout__glyph {
        margin-left: 4px;
      }

      .callout__names {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 0 0 8px;
        padding: 0;
        list-style: none;
      }

      .callout__name {
        box-sizing: border-box;
        max-width: 100%;
        padding: 2px 10px;
        border-radius: 999px;
        background: #e8edfb;
        color: #1a1a2e;
        font-size: 0.875rem;
        line-height: 1.5;
        overflow-wrap: anywhere;
      }

      .callout__summary {
        margin: 0 0 8px;
        font-size: 0.8125rem;
        color: #4a5568;
      }

      .callout__action {
        min-width: 32px;
        min-height: 32px;
        padding: 4px 14px;
        border: 1px solid #1b3fa8;
        border-radius: 6px;
        background: #1b3fa8;
        color: #ffffff;
        font: inherit;
        font-size: 0.875rem;
        cursor: pointer;
        pointer-events: auto;
      }

      .callout__action:focus-visible {
        outline: 2px solid #1b3fa8;
        outline-offset: 2px;
      }

      @media (max-width: 767.98px) {
        .callout {
          max-width: calc(100vw - 32px);
        }
      }
    `,
  ],
})
export class NearAverageCalloutComponent implements OnInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Names, truncation and variant, already resolved by the pure visibility resolver. */
  readonly model = input.required<NearCalloutModel>();
  /** The Callout_Phrase for this appearance, chosen by the layer from the copy catalog (R2.4). */
  readonly phrase = input.required<string>();
  readonly reducedMotion = input<boolean>(false);
  /** Per-name stagger step in ms, from `computeStagger` (R5.3). */
  readonly stagger = input<number>(70);
  /** How many names may play the entrance; the rest render at rest (R5.13). */
  readonly animatedNameCount = input<number>(24);
  /** Set by the layer to start the Exit_Flourish for a trigger other than the dismiss control. */
  readonly exitCause = input<ExitCause | null>(null);

  readonly dismissed = output<void>();
  readonly removed = output<void>();

  readonly dismissLabel = 'Got it';
  readonly dismissAriaLabel = 'Dismiss the vote agreement callout';

  private readonly lifecycle = signal<LifecycleState>(INITIAL_LIFECYCLE_STATE);
  /** True when the panel mounted while already revealed, so it appears at rest (R11.12). */
  readonly atRestMount = signal<boolean>(false);

  readonly phase = computed(() => this.lifecycle().phase);
  readonly idleActive = computed(
    () => this.lifecycle().phase === 'idle' && this.lifecycle().idleStarted && !this.reducedMotion()
  );
  readonly phraseParts = computed(() => splitPhraseGlyphs(this.phrase()));
  readonly staggerValue = computed(() => `${this.stagger()}ms`);
  readonly summaryText = computed(() => {
    const hidden = this.model().hiddenNameCount;
    return hidden > 0 ? `and ${hidden} more` : '';
  });
  /** Suppresses the base entrance keyframes for a panel that mounts at rest (R11.12). */
  readonly restingStyle = computed(() =>
    this.atRestMount() && this.lifecycle().phase !== 'exiting' ? 'none' : null
  );

  /** Every timer this component creates; all are cleared in `ngOnDestroy` (R12.6). */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor() {
    effect(() => {
      const cause = this.exitCause();
      if (cause === null) return;
      untracked(() => this.dispatch({ kind: 'exit-trigger', cause }));
    });
  }

  ngOnInit(): void {
    const atRest = !this.model().replayEntrance;
    this.atRestMount.set(atRest);
    // A panel that mounts at rest has no entrance to wait for and starts no idle loop.
    this.dispatch({ kind: 'show', reducedMotion: this.reducedMotion() || atRest });
    if (atRest) {
      this.dispatch({ kind: 'entrance-end' });
      return;
    }
    // Fallback for environments that never fire `animationend` (jsdom, a backgrounded tab).
    // Dispatches the same idempotent event as the real one.
    this.schedule(ENTRANCE_MS + ENTRANCE_FALLBACK_SLACK_MS, () =>
      this.dispatch({ kind: 'entrance-end' })
    );
  }

  ngOnDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  dismiss(): void {
    const phase = this.lifecycle().phase;
    if (phase !== 'entering' && phase !== 'idle') return;
    this.dispatch({ kind: 'exit-trigger', cause: 'dismissed' });
    this.dismissed.emit();
  }

  onEscape(event: Event): void {
    event.stopPropagation();
    this.dismiss();
  }

  onAnimationEnd(event: AnimationEvent): void {
    // Name chips animate too and their events bubble; only the panel's own animation counts.
    if (event.target !== event.currentTarget) return;
    if (ENTRANCE_ANIMATIONS.has(event.animationName)) {
      this.dispatch({ kind: 'entrance-end' });
    } else if (EXIT_ANIMATIONS.has(event.animationName)) {
      this.dispatch({ kind: 'exit-end' });
    }
  }

  private dispatch(event: LifecycleEvent): void {
    const result = reduceCalloutLifecycle(this.lifecycle(), event);
    if (result.state !== this.lifecycle()) this.lifecycle.set(result.state);
    for (const planned of result.effects) this.run(planned);
  }

  private run(planned: LifecycleEffect): void {
    switch (planned.kind) {
      case 'start-idle':
        // The idle class is derived from the lifecycle state; nothing to do imperatively.
        return;
      case 'capture-transform':
        this.captureTransform();
        return;
      case 'arm-exit-deadline':
        this.schedule(planned.ms, () => this.dispatch({ kind: 'exit-deadline' }));
        return;
      case 'remove':
        this.moveFocusOutIfInside();
        this.removed.emit();
        return;
      case 'release-budget':
        // The layer owns the budget and releases its share when `removed` fires.
        return;
    }
  }

  /**
   * Freezes the transform and opacity the panel holds right now into CSS variables, so an exit
   * that interrupts the entrance starts from exactly where the entrance was (R5.16). Runs
   * synchronously, before the exiting class is rendered.
   */
  private captureTransform(): void {
    const panel = this.panel();
    if (panel === null) return;
    const held = getComputedStyle(panel);
    panel.style.setProperty('--callout-exit-from', held.transform);
    panel.style.setProperty('--callout-exit-opacity', held.opacity);
  }

  /** Moves focus to the main board region only if focus is inside this panel (R9.8, R9.12). */
  private moveFocusOutIfInside(): void {
    const active = document.activeElement;
    if (active === null || !this.host.nativeElement.contains(active)) return;
    const main = document.getElementById(MAIN_REGION_ID);
    if (main === null) return;
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    main.focus({ preventScroll: true });
  }

  private panel(): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>('.callout');
  }

  private schedule(ms: number, action: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      action();
    }, ms);
    this.timers.add(timer);
  }
}
