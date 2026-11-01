import {
  DestroyRef,
  Injectable,
  Signal,
  WritableSignal,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import {
  balloonBottom,
  balloonMaxHeight,
  bottomLeftBaseOffset,
  isBalloonHidden,
  isNarrowViewport,
} from './board-overlay-layout';

/** Viewport size in CSS pixels (`innerWidth` / `innerHeight`). */
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Coordinates the bottom-left arrangement of a Board_Page (design D10, R12.4, R12.11, R12.12).
 *
 * The Vote_Callout_Layer, the Moderator_Note_Balloon stack and the chat are separate components.
 * They report measured sizes here and read the resulting positions back as signals. Every number
 * comes from the pure formulas in `board-overlay-layout.ts`.
 *
 * Measurements use `ResizeObserver`, which reports before paint, so positions follow in the same
 * frame. Without `ResizeObserver` (old browsers, some test environments) the tracked values keep
 * their defaults.
 */
@Injectable({ providedIn: 'root' })
export class BoardOverlayLayoutService {
  private readonly doc = inject(DOCUMENT);

  private readonly viewportState = signal<ViewportSize>(this.readViewport());
  private readonly headerBottomState = signal(0);
  private readonly chatDockTopState = signal<number | null>(null);
  private readonly calloutLayerHeightState = signal(0);
  /** The current tracking call for each measured signal; the latest call wins. */
  private readonly owners = new Map<WritableSignal<number>, object>();

  /** Viewport size, updated on every `resize` event without a debounce. */
  readonly viewport: Signal<ViewportSize> = this.viewportState.asReadonly();
  /** Bottom edge of the Board_Page header, from the viewport top; 0 until a header is tracked. */
  readonly headerBottomPx: Signal<number> = this.headerBottomState.asReadonly();
  /** Top of the minimized Panel_Header or the Chat_Load_Error_Notice; only used when narrow. */
  readonly chatDockTopPx: Signal<number | null> = this.chatDockTopState.asReadonly();
  /** Measured height of the Vote_Callout_Layer; 0 when no callout is visible. */
  readonly calloutLayerHeightPx: Signal<number> = this.calloutLayerHeightState.asReadonly();

  /** Bottom_Left_Base_Offset, from the viewport bottom (R12.12). */
  readonly baseOffsetPx: Signal<number> = computed(() => {
    const { width, height } = this.viewport();
    return bottomLeftBaseOffset(isNarrowViewport(width), height, this.chatDockTopPx());
  });

  /** Bottom of the balloon stack, from the viewport bottom (R12.4). */
  readonly balloonBottomPx: Signal<number> = computed(() =>
    balloonBottom(this.baseOffsetPx(), this.calloutLayerHeightPx())
  );

  /** Maximum height of the balloon stack (R12.4). */
  readonly balloonMaxHeightPx: Signal<number> = computed(() =>
    balloonMaxHeight(this.viewport().height, this.balloonBottomPx(), this.headerBottomPx())
  );

  /** True while less than 64 px is left for the balloon stack (R12.11). */
  readonly balloonHidden: Signal<boolean> = computed(() =>
    isBalloonHidden(this.balloonMaxHeightPx())
  );

  constructor() {
    const view = this.doc.defaultView;
    if (view === null) return;
    const onResize = (): void => {
      const next = this.readViewport();
      const current = this.viewportState();
      if (next.width !== current.width || next.height !== current.height) {
        this.viewportState.set(next);
      }
    };
    view.addEventListener('resize', onResize);
    inject(DestroyRef).onDestroy(() => view.removeEventListener('resize', onResize));
  }

  /** Measures the bottom edge of a Board_Page header while `destroyRef` is alive. */
  trackHeader(el: Element, destroyRef: DestroyRef): void {
    this.track(el, destroyRef, this.headerBottomState, 0, target =>
      target.getBoundingClientRect().bottom
    );
  }

  /** Measures the height of the Vote_Callout_Layer while `destroyRef` is alive. */
  trackCalloutLayer(el: Element, destroyRef: DestroyRef): void {
    this.track(el, destroyRef, this.calloutLayerHeightState, 0, target =>
      target.getBoundingClientRect().height
    );
  }

  /** Reports the top edge of the minimized Panel_Header or the notice; `null` when neither shows. */
  setChatDockTop(px: number | null): void {
    this.chatDockTopState.set(px);
  }

  private readViewport(): ViewportSize {
    const view = this.doc.defaultView;
    return view === null
      ? { width: 0, height: 0 }
      : { width: view.innerWidth, height: view.innerHeight };
  }

  /**
   * Observes `el` and writes `measure(el)` to `target` on every size change. The latest call for
   * a given target wins; when its `destroyRef` fires, the observer disconnects and the target
   * returns to `fallback`.
   */
  private track(
    el: Element,
    destroyRef: DestroyRef,
    target: WritableSignal<number>,
    fallback: number,
    measure: (el: Element) => number
  ): void {
    if (typeof ResizeObserver === 'undefined') return;

    const token = {};
    this.owners.set(target, token);
    const observer = new ResizeObserver(() => {
      if (this.owners.get(target) === token) target.set(measure(el));
    });
    observer.observe(el);

    destroyRef.onDestroy(() => {
      observer.disconnect();
      if (this.owners.get(target) === token) {
        this.owners.delete(target);
        target.set(fallback);
      }
    });
  }
}
