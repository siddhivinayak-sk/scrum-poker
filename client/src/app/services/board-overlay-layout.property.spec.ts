// Feature: session-chat, Property 31: Overlays never overlap
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  BALLOON_MAX_HEIGHT_RATIO,
  BALLOON_MIN_VISIBLE_HEIGHT_PX,
  EDGE_GAP_PX,
  LAUNCHER_SIZE_NARROW_PX,
  STACK_GAP_PX,
  computeOverlayLayout,
  isNarrowViewport,
  rectsIntersect,
  type OverlayLayoutInput,
  type PanelState,
  type Rect,
} from './board-overlay-layout';

/**
 * Viewports from 320 × 400 upward with the narrow flag derived from the width, every Panel_State
 * except narrow `open` (the full-screen panel covers both layers by design, R12.9), the notice on
 * or off, and realistic measured sizes: a header bottom of 0 (no `ResizeObserver`) to 200 px, a
 * minimized Panel_Header of 40–72 px, a notice of 56–200 px (wrapping on a 320 px phone) and a
 * callout layer that is either empty or up to 800 px tall before the 40vh / 45vh clamp.
 */
const layoutInputArb: fc.Arbitrary<OverlayLayoutInput> = fc
  .record({
    viewportWidth: fc.integer({ min: 320, max: 1920 }),
    viewportHeight: fc.integer({ min: 400, max: 1200 }),
  })
  .chain(({ viewportWidth, viewportHeight }) => {
    const narrow = isNarrowViewport(viewportWidth);
    const states: PanelState[] = narrow ? ['closed', 'minimized'] : ['closed', 'open', 'minimized'];
    return fc.record({
      viewportWidth: fc.constant(viewportWidth),
      viewportHeight: fc.constant(viewportHeight),
      narrow: fc.constant(narrow),
      panelState: fc.constantFrom(...states),
      noticeShown: fc.boolean(),
      headerBottomPx: fc.integer({ min: 0, max: 200 }),
      calloutLayerHeightPx: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 800 })),
      minimizedHeaderHeightPx: fc.integer({ min: 40, max: 72 }),
      noticeHeightPx: fc.integer({ min: 56, max: 200 }),
    });
  });

/** Bottom_Left_Base_Offset from first principles (R12.12): 16 px, or 8 px above a narrow dock. */
function expectedBaseOffset(input: OverlayLayoutInput): number {
  if (!input.narrow) return EDGE_GAP_PX;
  const dockHeights: number[] = [];
  if (input.panelState === 'minimized') dockHeights.push(input.minimizedHeaderHeightPx);
  if (input.noticeShown) dockHeights.push(input.noticeHeightPx);
  if (dockHeights.length === 0) return EDGE_GAP_PX;
  // Launcher at bottom 16, 48 px tall; dock bottom 8 px above it; base offset 8 px above the dock.
  return EDGE_GAP_PX + LAUNCHER_SIZE_NARROW_PX + STACK_GAP_PX + Math.max(...dockHeights) + STACK_GAP_PX;
}

describe('Property 31: Overlays never overlap', () => {
  it('keeps chat elements, the callout layer and the balloon stack apart', () => {
    // **Validates: Requirements 4.2, 12.4, 12.9, 12.11, 12.12, 20.14**
    fc.assert(
      fc.property(layoutInputArb, (input) => {
        const layout = computeOverlayLayout(input);
        const h = input.viewportHeight;

        const chatRects: Array<[string, Rect | null]> = [
          ['launcher', layout.launcher],
          ['openPanel', layout.openPanel],
          ['minimizedHeader', layout.minimizedHeader],
          ['loadErrorNotice', layout.loadErrorNotice],
        ];
        const bottomLeftRects: Array<[string, Rect | null]> = [
          ['calloutLayer', layout.calloutLayer],
          ['balloonStack', layout.balloonStack],
        ];

        // Chat elements never intersect the bottom-left arrangement (R12.9, R20.14).
        for (const [chatName, chatRect] of chatRects) {
          for (const [leftName, leftRect] of bottomLeftRects) {
            if (chatRect && leftRect) {
              expect(rectsIntersect(chatRect, leftRect), `${chatName} ∩ ${leftName}`).toBe(false);
            }
          }
        }

        // The layer and the stack never intersect each other (R12.9, R12.11).
        if (layout.calloutLayer && layout.balloonStack) {
          expect(rectsIntersect(layout.calloutLayer, layout.balloonStack)).toBe(false);
        }

        // The wide open panel's top stays at least 8 px below the header (R4.2).
        if (layout.openPanel) {
          expect(layout.openPanel.top).toBeGreaterThanOrEqual(input.headerBottomPx + STACK_GAP_PX);
        }

        // Bottom_Left_Base_Offset follows the narrow dock (R12.12).
        expect(layout.baseOffsetPx).toBe(expectedBaseOffset(input));

        // Stack bottom: 8 px above a visible layer's top, else at the base offset (R12.4).
        if (layout.calloutLayer) {
          expect(layout.calloutLayer.bottom).toBeCloseTo(h - layout.baseOffsetPx, 6);
          expect(h - layout.balloonBottomPx).toBeCloseTo(layout.calloutLayer.top - STACK_GAP_PX, 6);
        } else {
          expect(input.calloutLayerHeightPx).toBe(0);
          expect(layout.balloonBottomPx).toBe(layout.baseOffsetPx);
        }

        // Stack max height = min(50vh, space to header + 8) (R12.4).
        const space = h - layout.balloonBottomPx - (input.headerBottomPx + STACK_GAP_PX);
        expect(layout.balloonMaxHeightPx).toBeCloseTo(
          Math.min(BALLOON_MAX_HEIGHT_RATIO * h, space),
          6
        );

        // Hidden exactly when that space is under 64 px (R12.11); either outcome is accepted when
        // float rounding puts the space within 1e-6 of the threshold.
        if (Math.abs(space - BALLOON_MIN_VISIBLE_HEIGHT_PX) >= 1e-6) {
          expect(layout.balloonHidden).toBe(space < BALLOON_MIN_VISIBLE_HEIGHT_PX);
        }
        expect(layout.balloonStack === null).toBe(layout.balloonHidden);

        // A shown stack stays at least 8 px below the header and sits at its computed bottom.
        if (layout.balloonStack) {
          expect(layout.balloonStack.top).toBeGreaterThanOrEqual(
            input.headerBottomPx + STACK_GAP_PX
          );
          expect(layout.balloonStack.bottom).toBeCloseTo(h - layout.balloonBottomPx, 6);
        }
      }),
      { numRuns: 200 }
    );
  });
});
