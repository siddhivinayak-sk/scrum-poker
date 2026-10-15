import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { resolveFunCallouts } from '@shared/types';
import type { CalloutSection } from '@shared/callout-copy';
import {
  CALLOUT_COPY_CATALOG_TOKEN,
  CalloutCopyStoreService,
} from '../../services/callout-copy-store.service';
import {
  CalloutPersistenceService,
  type DismissedCallout,
  type NoteDraft,
} from '../../services/callout-persistence.service';
import { SessionStateService } from '../../services/session-state.service';
import { WebSocketService } from '../../services/websocket.service';
import { AnimationBudget, computeStagger, type ExitCause } from './callout-animation';
import { stripGlyphs } from './callout-glyph';
import {
  computeLayerHeightBudget,
  resolveCalloutVisibility,
  type CalloutResolution,
  type FarPromptModel,
  type NearCalloutModel,
} from './callout-visibility';
import { FarFromAveragePromptComponent } from './far-from-average-prompt.component';
import { NearAverageCalloutComponent } from './near-average-callout.component';
import { UnsentNoteComponent } from './unsent-note.component';

/** Trailing debounce for `resize` events; well inside the 300 ms bound of R8.6. */
export const VIEWPORT_DEBOUNCE_MS = 150;

/**
 * Length of the countdown overlay's run (3 -> 2 -> 1). `SessionStateService.countdownActive`
 * latches to `true` and is never cleared, so the layer treats the countdown as running only for
 * this long after the flag turns on, mirroring the overlay (R7.5, R7.12).
 */
export const COUNTDOWN_DURATION_MS = 3000;

/** Below this width the mobile layout rules apply (R8.1, R8.2). */
const MOBILE_BREAKPOINT_PX = 768;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const EDGE_GAP_PX = 16;
/** Share of the viewport height a callout may use outside the mobile layout (R7.7). */
const WIDE_HEIGHT_RATIO = 0.4;

interface Viewport {
  readonly width: number;
  readonly height: number;
}

function sameNames(a: NearCalloutModel, b: NearCalloutModel): boolean {
  return (
    a.names.length === b.names.length &&
    a.names.every((n, i) => n.full === b.names[i].full && n.shown === b.names[i].shown)
  );
}

/** Structural equality that ignores `replayEntrance`, which is fixed at mount time. */
function sameNearModel(a: NearCalloutModel, b: NearCalloutModel): boolean {
  return (
    a.roundId === b.roundId &&
    a.variant === b.variant &&
    a.hiddenNameCount === b.hiddenNameCount &&
    sameNames(a, b)
  );
}

/**
 * The Vote_Callout_Layer: the single fixed-position stacking layer that hosts the
 * Near_Average_Callout, the Far_From_Average_Prompt and the Unsent_Note_Element.
 *
 * The layer owns every decision about WHETHER a callout shows. A pure resolver
 * (`resolveCalloutVisibility`) evaluates every suppression condition before any display
 * condition (R11.14); the layer only feeds it signals and reconciles what is mounted.
 *
 * Mount contract with the children: a callout stays mounted until its `removed` output fires, so
 * its exit flourish can play after the model that justified it has gone. The layer drives that
 * exit by setting `exitCause`, derived from existing signals (round id change, round cleared,
 * re-vote, left revealed state, suppression, `funCallouts` off) or from the dismiss control.
 * `dismissed` writes a Dismissal_Record. On destroy everything is dropped without an exit
 * flourish and every timer and listener is released (R12.6).
 *
 * Pointer behaviour follows R7.2 literally: the layer and the panel bodies take no pointer events
 * and only the controls do. There is deliberately no conditional `pointer-events: auto` on an
 * overflowing scroll container (flagged tension 8).
 */
@Component({
  selector: 'app-vote-callout-layer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NearAverageCalloutComponent, FarFromAveragePromptComponent, UnsentNoteComponent],
  template: `
    <!-- One announcement channel per callout, siblings of the animated subtree (R9.2, R9.3, R9.11).
         Always present, so the node is never inserted mid-announcement. -->
    <p class="vote-callout-layer__sr" role="status" aria-live="polite" aria-atomic="true">
      {{ nearAnnouncement() }}
    </p>
    <p class="vote-callout-layer__sr" role="status" aria-live="polite" aria-atomic="true">
      {{ farAnnouncement() }}
    </p>

    <div
      class="vote-callout-layer"
      [class.vote-callout-layer--still]="reducedMotion()"
      [style.max-height.px]="maxHeightPx()"
      [style.bottom.px]="bottomPx()"
    >
      @if (nearShown(); as near) {
        @if (nearPhrase(); as phrase) {
          <app-near-average-callout
            [model]="near"
            [phrase]="phrase"
            [reducedMotion]="reducedMotion()"
            [stagger]="staggerMs()"
            [animatedNameCount]="animatedNameCount()"
            [exitCause]="nearExit()"
            (dismissed)="onDismiss('near')"
            (removed)="onRemoved('near')"
          />
        }
      }
      @if (farShown(); as far) {
        @if (farPhrase(); as phrase) {
          <app-far-from-average-prompt
            [model]="far"
            [phrase]="phrase"
            [sessionId]="sessionId()"
            [reducedMotion]="reducedMotion()"
            [exitCause]="farExit()"
            (dismissed)="onDismiss('far')"
            (removed)="onRemoved('far')"
          />
        }
      }
      @if (unsentDraft(); as draft) {
        <app-unsent-note [draft]="draft" />
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: contents;
      }

      /* Visually hidden, but still exposed to assistive technology. */
      .vote-callout-layer__sr {
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

      .vote-callout-layer {
        position: fixed;
        z-index: 900; /* above content sections, below history backdrop 999, dialogs 1000, countdown 9999, toast 10000 */
        isolation: isolate; /* one stacking context; no descendant declares a z-index */
        right: 16px;
        bottom: 16px;
        display: flex;
        flex-direction: column-reverse; /* near callout nearest the anchored edge (R7.6) */
        align-items: flex-end;
        gap: 8px; /* R7.6 */
        max-width: min(360px, calc(100vw - 16px)); /* R7.7 */
        max-height: 40vh; /* R7.7 */
        overscroll-behavior: contain;
        pointer-events: none; /* R7.2: only the controls inside the callouts take pointer events */
      }

      @media (max-width: 767.98px) {
        .vote-callout-layer {
          left: 16px;
          right: 16px;
          max-width: calc(100vw - 32px); /* R8.1 */
          max-height: 45vh; /* R8.2 */
          overflow-y: auto; /* R8.2: scroll rather than grow */
        }
      }
    `,
  ],
})
export class VoteCalloutLayerComponent {
  private readonly sessionState = inject(SessionStateService);
  private readonly persistence = inject(CalloutPersistenceService);
  private readonly copyStore = inject(CalloutCopyStoreService);
  private readonly catalog = inject(CALLOUT_COPY_CATALOG_TOKEN);
  private readonly ws = inject(WebSocketService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly doc = inject(DOCUMENT);

  /** The routed Poker_Session. Page wiring supplies it (task 14.1). */
  readonly sessionId = input.required<string>();

  // ---- Environment signals ------------------------------------------------------------------

  private readonly viewport = signal<Viewport>({ width: 1024, height: 768 });
  private readonly keyboardInset = signal<number>(0);
  private readonly osReduce = signal<boolean>(false);
  private readonly countdownElapsed = signal<boolean>(false);

  private viewportTimer: ReturnType<typeof setTimeout> | null = null;
  private countdownTimer: ReturnType<typeof setTimeout> | null = null;

  /** Reduced_Motion_Mode: the OS preference or `funCallouts` off (R6.1, R6.12). */
  readonly reducedMotion = computed(
    () => this.osReduce() || !resolveFunCallouts(this.sessionState.sessionConfig()?.funCallouts)
  );

  private readonly countdownBlocking = computed(
    () => this.sessionState.countdownActive() && !this.countdownElapsed()
  );

  // ---- Mounted callouts ---------------------------------------------------------------------

  /** Model retained for as long as the callout is mounted, including while it exits. */
  protected readonly nearShown = signal<NearCalloutModel | null>(null);
  protected readonly farShown = signal<FarPromptModel | null>(null);
  protected readonly nearExit = signal<ExitCause | null>(null);
  protected readonly farExit = signal<ExitCause | null>(null);

  private readonly nearAnimated = signal<number>(0);
  private readonly budget = new AnimationBudget();
  private nearHeld = 0;
  private farHeld = 0;
  private nearStory = '';
  private farStory = '';
  private previousSessionId = '';

  /** Output only changes when a callout mounts or unmounts, so it never feeds back into itself. */
  private readonly alreadyVisible = computed(
    () => ({ near: this.nearShown() !== null, far: this.farShown() !== null }),
    { equal: (a, b) => a.near === b.near && a.far === b.far }
  );

  private readonly sectionSizes = computed<Readonly<Record<CalloutSection, number>>>(() => ({
    nearAverage: this.catalog.nearAverage?.length ?? 0,
    farFromAverage: this.catalog.farFromAverage?.length ?? 0,
    fullAgreement: this.catalog.fullAgreement?.length ?? 0,
    wideSpread: this.catalog.wideSpread?.length ?? 0,
    acknowledgement: this.catalog.acknowledgement?.length ?? 0,
  }));

  // ---- Resolution ---------------------------------------------------------------------------

  protected readonly resolution = computed<CalloutResolution>(() => {
    const state = this.sessionState;
    const config = state.sessionConfig();
    const round = state.currentRound();
    const routed = this.sessionId();

    const displayNames = new Map<string, string>();
    for (const participant of state.participants()) {
      displayNames.set(participant.id, participant.displayName);
    }

    return resolveCalloutVisibility({
      routedSessionId: routed.length > 0 ? routed : null,
      stateSessionId: state.stateSessionId(),
      // The layer is only rendered in the session-found branch of the page (R11.11).
      sessionNotFound: false,
      countdownActive: this.countdownBlocking(),
      connectionBlocked: this.ws.connectionState() !== 'connected',
      funCallouts: config?.funCallouts,
      votingSystem: config?.votingSystem ?? '',
      round: round === null ? null : { id: round.id, status: round.status },
      metrics: state.metrics(),
      selections: state.selections(),
      displayNames,
      viewerId: state.currentUser()?.id ?? null,
      hasRevealPermission: state.hasRevealPermission(),
      dismissals: this.persistence.dismissals(),
      alreadyVisible: this.alreadyVisible(),
      viewport: this.viewport(),
      sectionSizes: this.sectionSizes(),
    });
  });

  protected readonly nearModel = computed<NearCalloutModel | null>(() => {
    const resolution = this.resolution();
    return resolution.kind === 'visible' ? resolution.near : null;
  });

  protected readonly farModel = computed<FarPromptModel | null>(() => {
    const resolution = this.resolution();
    return resolution.kind === 'visible' ? resolution.far : null;
  });

  // ---- Presentation -------------------------------------------------------------------------

  protected readonly nearPhrase = computed<string | null>(() => {
    const shown = this.nearShown();
    return shown === null ? null : this.copyStore.phraseFor(shown.variant, shown.roundId);
  });

  protected readonly farPhrase = computed<string | null>(() => {
    const shown = this.farShown();
    return shown === null ? null : this.copyStore.phraseFor('farFromAverage', shown.roundId);
  });

  protected readonly staggerMs = computed(() => computeStagger(this.nearShown()?.names.length ?? 0));
  protected readonly animatedNameCount = this.nearAnimated.asReadonly();

  /** Phrase, then names, then the "and N more" summary; glyph-free. Empty when hidden (R9.2, R9.11). */
  protected readonly nearAnnouncement = computed(() => {
    const shown = this.nearShown();
    const phrase = this.nearPhrase();
    if (shown === null || phrase === null) return '';
    const parts = [stripGlyphs(phrase)];
    if (shown.names.length > 0) parts.push(shown.names.map((n) => n.full).join(', '));
    if (shown.hiddenNameCount > 0) parts.push(`and ${shown.hiddenNameCount} more`);
    return parts.join('. ');
  });

  protected readonly farAnnouncement = computed(() => {
    const phrase = this.farPhrase();
    return this.farShown() === null || phrase === null ? '' : stripGlyphs(phrase);
  });

  /**
   * A retained draft appears exactly when it belongs to the routed session and was written for a
   * round other than the current one (R10.13, R10.14, R12.10).
   */
  protected readonly unsentDraft = computed<NoteDraft | null>(() => {
    const draft = this.persistence.draft();
    if (draft === null) return null;
    if (draft.sessionId !== this.sessionId()) return null;
    return draft.roundId !== this.sessionState.currentRound()?.id ? draft : null;
  });

  /** Reduces the layer below its usual cap while an on-screen keyboard covers the page (R8.7, R8.8). */
  protected readonly maxHeightPx = computed<number | null>(() => {
    const inset = this.keyboardInset();
    if (inset <= 0) return null;
    const { width, height } = this.viewport();
    const budget = computeLayerHeightBudget(height, inset);
    return width < MOBILE_BREAKPOINT_PX
      ? budget
      : Math.min(budget, Math.floor(height * WIDE_HEIGHT_RATIO));
  });

  /** Lifts the layer above the keyboard when the layout viewport does not shrink for it. */
  protected readonly bottomPx = computed<number | null>(() => {
    const inset = this.keyboardInset();
    return inset > 0 ? inset + EDGE_GAP_PX : null;
  });

  constructor() {
    this.setUpEnvironment();

    // A different routed session discards everything derived from the previous one, with no
    // exit flourish (R12.5).
    effect(() => {
      const id = this.sessionId();
      untracked(() => {
        if (this.previousSessionId !== '' && this.previousSessionId !== id) this.discardAll();
        this.previousSessionId = id;
      });
    });

    // Mirror the (never cleared) countdown flag as a bounded run (R7.5, R7.12).
    effect(() => {
      const active = this.sessionState.countdownActive();
      untracked(() => {
        this.clearCountdownTimer();
        this.countdownElapsed.set(false);
        if (!active) return;
        this.countdownTimer = setTimeout(() => {
          this.countdownTimer = null;
          this.countdownElapsed.set(true);
        }, COUNTDOWN_DURATION_MS);
      });
    });

    // Reconcile what is mounted with what the resolver now allows.
    effect(() => {
      const near = this.nearModel();
      const far = this.farModel();
      untracked(() => {
        this.reconcileNear(near);
        this.reconcileFar(far);
      });
    });

    this.destroyRef.onDestroy(() => {
      // Navigating away: callouts disappear with the layer, without an exit flourish (R12.6).
      this.clearCountdownTimer();
      if (this.viewportTimer !== null) clearTimeout(this.viewportTimer);
      this.viewportTimer = null;
    });
  }

  // ---- Events from the callouts -------------------------------------------------------------

  /** A dismissal is remembered for this session and round, and the callout exits (R2.11, R3.9). */
  protected onDismiss(kind: DismissedCallout): void {
    const shown = kind === 'near' ? this.nearShown() : this.farShown();
    if (shown === null) return;
    this.persistence.recordDismissal({
      sessionId: this.sessionId(),
      roundId: shown.roundId,
      callout: kind,
      at: Date.now(),
    });
    const exit = kind === 'near' ? this.nearExit : this.farExit;
    if (exit() === null) exit.set('dismissed');
  }

  /** The callout left the document: release its budget share and mount again if still warranted. */
  protected onRemoved(kind: DismissedCallout): void {
    if (kind === 'near') {
      this.budget.release(this.nearHeld);
      this.nearHeld = 0;
      this.nearShown.set(null);
      this.nearExit.set(null);
      this.nearAnimated.set(0);
      this.reconcileNear(this.nearModel());
    } else {
      this.budget.release(this.farHeld);
      this.farHeld = 0;
      this.farShown.set(null);
      this.farExit.set(null);
      this.reconcileFar(this.farModel());
    }
  }

  // ---- Reconciliation -----------------------------------------------------------------------

  private reconcileNear(model: NearCalloutModel | null): void {
    const shown = this.nearShown();
    if (shown === null) {
      if (model === null) return;
      // An absent or empty section withholds the callout entirely (R4.12).
      if (this.copyStore.phraseFor(model.variant, model.roundId) === null) return;
      this.nearHeld = this.budget.acquire(1 + model.names.length);
      this.nearAnimated.set(Math.max(0, this.nearHeld - 1));
      this.nearStory = this.sessionState.currentRound()?.storyDescription ?? '';
      this.nearExit.set(null);
      this.nearShown.set(model);
      return;
    }
    if (this.nearExit() !== null) return; // exiting: wait for `removed`

    if (model === null) {
      this.nearExit.set(this.causeFor(shown.roundId, this.nearStory));
    } else if (model.roundId !== shown.roundId) {
      this.nearExit.set(this.causeFor(shown.roundId, this.nearStory));
    } else if (!sameNearModel(shown, model)) {
      // Live update (R11.9, R11.10). The entrance replay decision made at mount is kept.
      this.nearShown.set({ ...model, replayEntrance: shown.replayEntrance });
    }
  }

  private reconcileFar(model: FarPromptModel | null): void {
    const shown = this.farShown();
    if (shown === null) {
      if (model === null) return;
      if (this.copyStore.phraseFor('farFromAverage', model.roundId) === null) return;
      this.farHeld = this.budget.acquire(1);
      this.farStory = this.sessionState.currentRound()?.storyDescription ?? '';
      this.farExit.set(null);
      this.farShown.set(model);
      return;
    }
    if (this.farExit() !== null) return;

    if (model === null || model.roundId !== shown.roundId) {
      this.farExit.set(this.causeFor(shown.roundId, this.farStory));
    }
  }

  /** Names the reason a mounted callout has to leave, from signals that already exist (R5.6, R5.9). */
  private causeFor(shownRoundId: string, shownStory: string): ExitCause {
    const state = this.sessionState;
    if (!resolveFunCallouts(state.sessionConfig()?.funCallouts)) return 'fun-callouts-off';
    const round = state.currentRound();
    if (round === null) return 'board-cleared';
    if (round.id !== shownRoundId) {
      return round.storyDescription === shownStory ? 'revote' : 'round-started';
    }
    if (round.status !== 'revealed' || !state.isRevealed() || state.metrics() === null) {
      return 'left-revealed';
    }
    return 'suppressed';
  }

  /** Drops every mounted callout immediately, with no exit flourish. */
  private discardAll(): void {
    this.budget.release(this.nearHeld + this.farHeld);
    this.nearHeld = 0;
    this.farHeld = 0;
    this.nearShown.set(null);
    this.farShown.set(null);
    this.nearExit.set(null);
    this.farExit.set(null);
    this.nearAnimated.set(0);
  }

  // ---- Environment --------------------------------------------------------------------------

  private setUpEnvironment(): void {
    const view = this.doc.defaultView;
    if (view === null) return;

    this.readViewport();

    const onResize = (): void => this.scheduleViewportRead();
    view.addEventListener('resize', onResize);
    const visual = view.visualViewport;
    visual?.addEventListener('resize', onResize);

    let media: MediaQueryList | null = null;
    let onMediaChange: ((event: MediaQueryListEvent) => void) | null = null;
    if (typeof view.matchMedia === 'function') {
      media = view.matchMedia(REDUCED_MOTION_QUERY);
      this.osReduce.set(media.matches);
      // The live preference change applies without a reload (R6.12).
      onMediaChange = (event: MediaQueryListEvent): void => this.osReduce.set(event.matches);
      media.addEventListener('change', onMediaChange);
    }

    this.destroyRef.onDestroy(() => {
      view.removeEventListener('resize', onResize);
      visual?.removeEventListener('resize', onResize);
      if (media !== null && onMediaChange !== null) {
        media.removeEventListener('change', onMediaChange);
      }
    });
  }

  private scheduleViewportRead(): void {
    if (this.viewportTimer !== null) clearTimeout(this.viewportTimer);
    this.viewportTimer = setTimeout(() => {
      this.viewportTimer = null;
      this.readViewport();
    }, VIEWPORT_DEBOUNCE_MS);
  }

  private readViewport(): void {
    const view = this.doc.defaultView;
    if (view === null) return;

    const current = this.viewport();
    if (current.width !== view.innerWidth || current.height !== view.innerHeight) {
      this.viewport.set({ width: view.innerWidth, height: view.innerHeight });
    }

    // Area covered at the bottom by an on-screen keyboard. Pinch-zoom shrinks the visual
    // viewport too, so a zoomed page is not mistaken for an open keyboard.
    const visual = view.visualViewport;
    const covered =
      visual == null || visual.scale > 1
        ? 0
        : Math.max(0, Math.round(view.innerHeight - visual.height - visual.offsetTop));
    if (covered !== this.keyboardInset()) this.keyboardInset.set(covered);
  }

  private clearCountdownTimer(): void {
    if (this.countdownTimer !== null) clearTimeout(this.countdownTimer);
    this.countdownTimer = null;
  }
}
