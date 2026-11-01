import { describe, it, expect } from 'vitest';
import {
  BALLOON_WIDE_WIDTH_INSET_PX,
  BOTTOM_LEFT_MAX_WIDTH_WIDE_PX,
  BOTTOM_LEFT_NARROW_WIDTH_INSET_PX,
  CALLOUT_LAYER_WIDE_WIDTH_INSET_PX,
  EDGE_GAP_PX,
  NARROW_BREAKPOINT_PX,
  STACK_GAP_PX,
  balloonBottom,
  balloonMaxHeight,
  bottomLeftBaseOffset,
  calloutLayerMaxHeight,
  computeOverlayLayout,
  isBalloonHidden,
  isNarrowViewport,
  rectsIntersect,
  type OverlayLayoutInput,
  type PanelState,
  type Rect,
} from './board-overlay-layout';
import { rulesOf, stylesFor, toPx } from '../testing/declared-css';
import { VoteCalloutLayerComponent } from '../components/vote-callout/vote-callout-layer.component';
import { NearAverageCalloutComponent } from '../components/vote-callout/near-average-callout.component';
import { ModeratorNoteBalloonComponent } from '../components/moderator-notes/moderator-note-balloon.component';

function input(overrides: Partial<OverlayLayoutInput>): OverlayLayoutInput {
  return {
    viewportWidth: 1024,
    viewportHeight: 768,
    narrow: false,
    panelState: 'closed',
    noticeShown: false,
    headerBottomPx: 64,
    calloutLayerHeightPx: 0,
    minimizedHeaderHeightPx: 48,
    noticeHeightPx: 96,
    ...overrides,
  };
}

describe('board-overlay-layout formulas', () => {
  it('uses the 768 px breakpoint', () => {
    expect(isNarrowViewport(767)).toBe(true);
    expect(isNarrowViewport(768)).toBe(false);
  });

  it('base offset is 16 except for a narrow dock', () => {
    expect(bottomLeftBaseOffset(false, 800, 600)).toBe(16);
    expect(bottomLeftBaseOffset(true, 800, null)).toBe(16);
    expect(bottomLeftBaseOffset(true, 800, 680)).toBe(128);
  });

  it('balloon bottom sits 8 px above a visible layer', () => {
    expect(balloonBottom(16, 0)).toBe(16);
    expect(balloonBottom(16, 100)).toBe(124);
  });

  it('balloon max height is min(50vh, space to header + 8) and hides below 64 px', () => {
    expect(balloonMaxHeight(1000, 16, 64)).toBe(500);
    expect(balloonMaxHeight(400, 300, 30)).toBe(62);
    expect(isBalloonHidden(63.9)).toBe(true);
    expect(isBalloonHidden(64)).toBe(false);
  });

  it('touching rectangles do not intersect', () => {
    const a = { left: 0, top: 0, right: 10, bottom: 10 };
    expect(rectsIntersect(a, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false);
    expect(rectsIntersect(a, { left: 9, top: 9, right: 20, bottom: 20 })).toBe(true);
  });
});

describe('computeOverlayLayout', () => {
  it('matches the narrow edge values of the design table', () => {
    const w = 320;
    const layout = computeOverlayLayout(
      input({ viewportWidth: w, viewportHeight: 640, narrow: true, calloutLayerHeightPx: 80 })
    );
    expect(layout.launcher).toEqual({ left: w - 71, top: 640 - 71, right: w - 9, bottom: 640 - 9 });
    expect(layout.calloutLayer?.left).toBe(16);
    expect(layout.calloutLayer?.right).toBe(w - 72);
    expect(layout.balloonStack?.right).toBe(w - 72);
  });

  it('matches the wide 768 px edge values of the design table', () => {
    const layout = computeOverlayLayout(
      input({ viewportWidth: 768, panelState: 'open', calloutLayerHeightPx: 120 })
    );
    expect(layout.calloutLayer?.right).toBe(376);
    expect(layout.openPanel?.left).toBe(392);
    expect(layout.openPanel?.right).toBe(752);
    expect(layout.openPanel?.bottom).toBe(768 - 80);
  });

  it('stacks the layer and balloons above a narrow minimized header', () => {
    const layout = computeOverlayLayout(
      input({
        viewportWidth: 375,
        viewportHeight: 700,
        narrow: true,
        panelState: 'minimized',
        calloutLayerHeightPx: 100,
      })
    );
    const header = layout.minimizedHeader!;
    expect(header).toEqual({ left: 16, top: 700 - 72 - 48, right: 359, bottom: 700 - 72 });
    expect(layout.baseOffsetPx).toBe(700 - header.top + 8);
    expect(layout.calloutLayer!.bottom).toBe(header.top - 8);
    expect(layout.balloonStack!.bottom).toBe(layout.calloutLayer!.top - 8);
    expect(layout.balloonStack!.top).toBeGreaterThanOrEqual(64 + 8);
  });

  it('places the notice where the minimized header would be and offsets the arrangement', () => {
    const layout = computeOverlayLayout(
      input({ viewportWidth: 400, viewportHeight: 800, narrow: true, noticeShown: true })
    );
    expect(layout.loadErrorNotice).toEqual({ left: 16, top: 800 - 72 - 96, right: 384, bottom: 728 });
    expect(layout.baseOffsetPx).toBe(72 + 96 + 8);
  });

  it('keeps the wide panel top 8 px below the header and hides the launcher only when narrow open', () => {
    const wide = computeOverlayLayout(
      input({ viewportHeight: 500, panelState: 'open', headerBottomPx: 200 })
    );
    expect(wide.openPanel!.top).toBe(208);
    expect(wide.launcher).not.toBeNull();

    const narrow = computeOverlayLayout(input({ viewportWidth: 500, narrow: true, panelState: 'open' }));
    expect(narrow.launcher).toBeNull();
    expect(narrow.openPanel).toEqual({ left: 0, top: 0, right: 500, bottom: 768 });
  });

  it('hides the balloon stack when the header leaves less than 64 px', () => {
    const layout = computeOverlayLayout(
      input({ viewportHeight: 400, headerBottomPx: 200, calloutLayerHeightPx: 120 })
    );
    expect(layout.balloonHidden).toBe(true);
    expect(layout.balloonStack).toBeNull();
  });
});

// ---- Stylesheet scans (R22.15: the R12.3 and R12.4 declarations) -------------------------------

/** The components' narrow rule: `@media (max-width: 767.98px)`, just below the 768 px breakpoint. */
const NARROW_MEDIA = 'max-width: 767.98px';

/** True when the component has a narrow media rule for `selector` (so a narrow value is not inherited). */
function hasNarrowRule(component: unknown, selector: string): boolean {
  return rulesOf(component).some(
    (rule) => rule.media?.includes(NARROW_MEDIA) === true && rule.selectors.includes(selector)
  );
}

const NARROW_MAX_WIDTH = `calc(100vw - ${BOTTOM_LEFT_NARROW_WIDTH_INSET_PX}px)`;

/**
 * The style compiler drops a `calc()` nested in another math function (`min(360px, calc(100vw -
 * 16px))` ships as `min(360px, 100vw - 16px)`), which computes the same value. Compare both forms
 * with the nested `calc()` unwrapped.
 */
function unwrapNestedCalc(value: string | undefined): string | undefined {
  return value?.replace(/(min\([^,()]*,\s*)calc\(([^()]*)\)/g, '$1$2');
}

function wideMaxWidth(insetPx: number): string | undefined {
  return unwrapNestedCalc(`min(${BOTTOM_LEFT_MAX_WIDTH_WIDE_PX}px, calc(100vw - ${insetPx}px))`);
}

describe('bottom-left arrangement declarations (R12.3, R12.4)', () => {
  it('the narrow media rule sits just below the 768 px breakpoint', () => {
    expect(767.98).toBeLessThan(NARROW_BREAKPOINT_PX);
    expect(767.98).toBeGreaterThan(NARROW_BREAKPOINT_PX - 1);
  });

  describe('Vote_Callout_Layer (R12.3)', () => {
    const SELECTOR = '.vote-callout-layer';
    const wide = stylesFor(VoteCalloutLayerComponent, SELECTOR);
    const narrow = stylesFor(VoteCalloutLayerComponent, SELECTOR, NARROW_MEDIA);

    it('is anchored 16 px from the left and bottom edges with no right offset', () => {
      expect(wide.get('position')).toBe('fixed');
      expect(toPx(wide.get('left') ?? '')).toBe(EDGE_GAP_PX);
      expect(toPx(wide.get('bottom') ?? '')).toBe(EDGE_GAP_PX);
      for (const styles of [wide, narrow]) {
        expect(styles.has('right')).toBe(false);
        expect(styles.has('inset')).toBe(false);
        expect(styles.get('left')).toBe('16px');
      }
    });

    it('stacks callouts upward from the bottom, left-aligned, 8 px apart', () => {
      expect(wide.get('display')).toBe('flex');
      expect(wide.get('flex-direction')).toBe('column-reverse');
      expect(wide.get('align-items')).toBe('flex-start');
      expect(toPx(wide.get('gap') ?? '')).toBe(STACK_GAP_PX);
    });

    it('keeps the wide size caps', () => {
      expect(unwrapNestedCalc(wide.get('max-width'))).toBe(
        wideMaxWidth(CALLOUT_LAYER_WIDE_WIDTH_INSET_PX)
      );
      expect(wide.get('max-height')).toBe('40vh');
    });

    it('narrows to calc(100vw - 88px) with a 45vh scrolling cap', () => {
      expect(hasNarrowRule(VoteCalloutLayerComponent, SELECTOR)).toBe(true);
      expect(narrow.get('max-width')).toBe(NARROW_MAX_WIDTH);
      expect(narrow.get('max-height')).toBe('45vh');
      expect(narrow.get('overflow-y')).toBe('auto');
    });
  });

  describe('Near_Average_Callout panel (R12.3)', () => {
    it('narrows each callout panel to calc(100vw - 88px)', () => {
      expect(hasNarrowRule(NearAverageCalloutComponent, '.callout')).toBe(true);
      expect(stylesFor(NearAverageCalloutComponent, '.callout', NARROW_MEDIA).get('max-width')).toBe(
        NARROW_MAX_WIDTH
      );
    });
  });

  describe('Moderator_Note_Balloon stack (R12.4)', () => {
    const SELECTOR = '.note-balloons';
    const wide = stylesFor(ModeratorNoteBalloonComponent, SELECTOR);
    const narrow = stylesFor(ModeratorNoteBalloonComponent, SELECTOR, NARROW_MEDIA);

    it('is anchored 16 px from the left edge at z-index 905, with no right offset', () => {
      expect(wide.get('position')).toBe('fixed');
      expect(toPx(wide.get('left') ?? '')).toBe(EDGE_GAP_PX);
      expect(wide.get('z-index')).toBe('905');
      for (const styles of [wide, narrow]) {
        expect(styles.has('right')).toBe(false);
        expect(styles.has('inset')).toBe(false);
      }
    });

    it('leaves bottom and max-height to the layout service bindings', () => {
      for (const styles of [wide, narrow]) {
        expect(styles.has('bottom')).toBe(false);
        expect(styles.has('max-height')).toBe(false);
      }
    });

    it('scrolls vertically inside the stack', () => {
      expect(wide.get('overflow-y')).toBe('auto');
    });

    it('caps the width at min(360px, calc(100vw - 32px)) wide and calc(100vw - 88px) narrow', () => {
      expect(unwrapNestedCalc(wide.get('max-width'))).toBe(
        wideMaxWidth(BALLOON_WIDE_WIDTH_INSET_PX)
      );
      expect(hasNarrowRule(ModeratorNoteBalloonComponent, SELECTOR)).toBe(true);
      expect(narrow.get('max-width')).toBe(NARROW_MAX_WIDTH);
    });
  });
});

// ---- Geometry (R22.15: the zero-intersection conditions of R12.9) ------------------------------

const WIDTHS = [320, 767, 768, 1280] as const;
const HEIGHTS = [400, 900] as const;
const PANEL_STATES: readonly PanelState[] = ['closed', 'open', 'minimized'];

interface GeometryCase {
  readonly w: number;
  readonly h: number;
  readonly panelState: PanelState;
  readonly noticeShown: boolean;
}

const GEOMETRY_CASES: GeometryCase[] = WIDTHS.flatMap((w) =>
  HEIGHTS.flatMap((h) =>
    PANEL_STATES.flatMap((panelState) =>
      [false, true].map((noticeShown) => ({ w, h, panelState, noticeShown }))
    )
  )
);

/** Realistic measured sizes; the callout layer is asked for more than its cap, so it sits at max height. */
function geometryInput({ w, h, panelState, noticeShown }: GeometryCase): OverlayLayoutInput {
  return {
    viewportWidth: w,
    viewportHeight: h,
    narrow: isNarrowViewport(w),
    panelState,
    noticeShown,
    headerBottomPx: 64,
    calloutLayerHeightPx: h,
    minimizedHeaderHeightPx: 48,
    noticeHeightPx: 96,
  };
}

function present(...rects: (Rect | null)[]): Rect[] {
  return rects.filter((rect): rect is Rect => rect !== null);
}

describe('bottom-left arrangement geometry (R12.9)', () => {
  it('covers 4 widths x 2 heights x 3 panel states x notice on/off', () => {
    expect(GEOMETRY_CASES).toHaveLength(48);
  });

  it.each(GEOMETRY_CASES)(
    'w=$w h=$h $panelState notice=$noticeShown keeps the overlays apart',
    (testCase) => {
      const { w, h, panelState } = testCase;
      const narrow = isNarrowViewport(w);
      const layout = computeOverlayLayout(geometryInput(testCase));
      const layer = layout.calloutLayer!;
      expect(layer).not.toBeNull();

      // The layer sits at its maximum height with its bottom at the base offset.
      expect(layer.bottom - layer.top).toBeCloseTo(calloutLayerMaxHeight(h, narrow), 6);
      expect(h - layer.bottom).toBeCloseTo(layout.baseOffsetPx, 6);
      expect(layer.left).toBe(EDGE_GAP_PX);

      // The balloon stack, when shown, sits 8 px above the layer and never overlaps it.
      const stack = layout.balloonStack;
      if (stack !== null) {
        expect(stack.left).toBe(EDGE_GAP_PX);
        expect(layer.top - stack.bottom).toBeCloseTo(STACK_GAP_PX, 6);
        expect(stack.top).toBeGreaterThanOrEqual(64 + STACK_GAP_PX - 1e-6);
        expect(rectsIntersect(layer, stack)).toBe(false);
      }

      if (narrow && panelState === 'open') {
        // Full-screen panel covers both layers by design (R4.3, R12.2); the arrangement underneath
        // stays where it is while closed.
        expect(layout.launcher).toBeNull();
        expect(layout.openPanel).toEqual({ left: 0, top: 0, right: w, bottom: h });
        const closed = computeOverlayLayout(geometryInput({ ...testCase, panelState: 'closed' }));
        expect(layout.calloutLayer).toEqual(closed.calloutLayer);
        expect(layout.balloonStack).toEqual(closed.balloonStack);
        return;
      }

      const chatRects = present(
        layout.launcher,
        layout.openPanel,
        layout.minimizedHeader,
        layout.loadErrorNotice
      );
      expect(layout.launcher).not.toBeNull();
      for (const chat of chatRects) {
        for (const leftSide of present(layer, stack)) {
          expect(rectsIntersect(chat, leftSide)).toBe(false);
        }
      }

      if (narrow) {
        // The 1 px gap between the arrangement (100vw - 72px) and the ring (100vw - 71px).
        const launcher = layout.launcher!;
        expect(layer.right).toBe(w - 72);
        if (stack !== null) expect(stack.right).toBe(w - 72);
        expect(launcher.left).toBe(w - 71);
        expect(launcher.right).toBe(w - 9);
        expect(launcher.left - layer.right).toBe(1);
      } else {
        expect(layer.right).toBeLessThanOrEqual(EDGE_GAP_PX + BOTTOM_LEFT_MAX_WIDTH_WIDE_PX);
        for (const docked of present(layout.openPanel, layout.minimizedHeader, layout.loadErrorNotice)) {
          expect(docked.left).toBe(w - 16 - 360);
          expect(docked.right).toBe(w - 16);
        }
        if (w === 768) {
          expect(layer.right).toBe(376);
          if (stack !== null) expect(stack.right).toBe(376);
          for (const docked of present(layout.openPanel, layout.minimizedHeader, layout.loadErrorNotice)) {
            expect(docked.left).toBe(392);
          }
        }
      }
    }
  );

  it('shows the balloon stack in at least one case at each height, so the stack checks run', () => {
    for (const h of HEIGHTS) {
      const shown = GEOMETRY_CASES.filter((c) => c.h === h).some(
        (c) => computeOverlayLayout(geometryInput(c)).balloonStack !== null
      );
      expect(shown).toBe(true);
    }
  });
});
